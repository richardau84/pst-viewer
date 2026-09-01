/**
 * A chunk-caching random-access reader, shared by the PST worker and by
 * `scripts/bench-pst.mjs` so the thing measured is the thing that ships.
 *
 * pst-extractor asks for tiny, highly clustered pieces — b-tree pages of
 * 512B/4KB while opening, then 64B–8KB blocks per message — and it asks for
 * them one `await` at a time. Serving each of those with its own
 * `Blob.slice().arrayBuffer()` costs a structured round-trip to the browser's
 * file thread (tens to hundreds of microseconds), which is the dominant cost of
 * opening a large mailbox: a multi-GB OST needs hundreds of thousands of them
 * just to load the two b-trees, before a single message is read.
 *
 * Chunking collapses that: neighbouring pages come from one already-fetched
 * slab, and re-reads (the same block reached from several folders, a message
 * opened twice) never touch the file again. Concurrent readers of the same
 * chunk share one in-flight fetch, so parallel walks don't multiply the I/O.
 */

/** The part of `File`/`Blob` this needs — narrow enough that a benchmark can
 *  stand a plain file descriptor in its place. */
export interface SliceableFile {
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** Signature of pst-extractor's `ReadFileApi`, restated so this module doesn't
 *  depend on the library (the worker still passes the result straight to it). */
export interface ChunkReader {
  readFile(buffer: ArrayBuffer, offset: number, length: number, position: number): Promise<number>
  close(): Promise<void>
}

export interface ChunkReaderOptions {
  /** Size of one cached slab. Big enough that a b-tree page walk (512B or 4KB
   *  pages, laid out contiguously) costs one fetch per few hundred pages, small
   *  enough that a random block read doesn't drag in megabytes it won't use. */
  chunkSize?: number
  /** How much of the file to keep resident. Anything under this is effectively
   *  read once; larger mailboxes keep a hot working set (the b-trees, plus
   *  whatever folder is being read) and evict the rest. */
  budget?: number
  /** Called once per actual file fetch — for benchmarks and diagnostics. */
  onFetch?: (start: number, length: number) => void
}

export const DEFAULT_CHUNK_SIZE = 256 * 1024
export const DEFAULT_BUDGET = 128 * 1024 * 1024

export function createChunkReader(
  file: SliceableFile,
  { chunkSize = DEFAULT_CHUNK_SIZE, budget = DEFAULT_BUDGET, onFetch }: ChunkReaderOptions = {},
): ChunkReader {
  // Insertion-ordered, so the first key is always the least recently used.
  const chunks = new Map<number, Uint8Array>()
  const inflight = new Map<number, Promise<Uint8Array>>()
  let resident = 0

  const loadChunk = (index: number): Promise<Uint8Array> => {
    const hit = chunks.get(index)
    if (hit) {
      chunks.delete(index) // re-insert to move it to the MRU end
      chunks.set(index, hit)
      return Promise.resolve(hit)
    }
    const pending = inflight.get(index)
    if (pending) return pending

    const start = index * chunkSize
    const length = Math.min(chunkSize, file.size - start)
    onFetch?.(start, length)
    const fetched = file
      .slice(start, start + length)
      .arrayBuffer()
      .then(
        (ab) => {
          inflight.delete(index)
          const bytes = new Uint8Array(ab)
          chunks.set(index, bytes)
          resident += bytes.byteLength
          // Evict from the LRU end, never the chunk just added (which a caller
          // is about to read) — matters only if the budget is very small.
          while (resident > budget && chunks.size > 1) {
            const oldest = chunks.keys().next()
            if (oldest.done || oldest.value === index) break
            resident -= chunks.get(oldest.value)!.byteLength
            chunks.delete(oldest.value)
          }
          return bytes
        },
        (err) => {
          inflight.delete(index)
          throw err
        },
      )
    inflight.set(index, fetched)
    return fetched
  }

  return {
    async readFile(buffer, offset, length, position) {
      const end = Math.min(position + length, file.size)
      if (end <= position) return 0
      // Reads never exceed one block (8KB), so this loop spans two chunks at
      // most; the general form just keeps it honest if that ever changes.
      const dest = new Uint8Array(buffer)
      let written = 0
      let pos = position
      while (pos < end) {
        const index = Math.floor(pos / chunkSize)
        const chunk = await loadChunk(index)
        const from = pos - index * chunkSize
        const take = Math.min(chunk.byteLength - from, end - pos)
        if (take <= 0) break // short chunk: the file was truncated under us
        dest.set(chunk.subarray(from, from + take), offset + written)
        written += take
        pos += take
      }
      return written
    },
    async close() {
      chunks.clear()
      inflight.clear()
      resident = 0
    },
  }
}
