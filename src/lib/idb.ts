/**
 * Dependency-free IndexedDB wrapper shared by the main thread (the `handles`
 * store) and the worker (the `searchDocs` and `folderTree` stores) —
 * `indexedDB` is a global in both contexts, so this file has no
 * worker/main-thread split of its own.
 *
 * Three object stores, one database:
 *  - `handles`: one row per persistable mailbox (main-thread-owned).
 *  - `searchDocs`: the cached full-text index for a mailbox, chunked into
 *    pages plus a manifest (worker-owned) — see the chunking helpers below.
 *  - `folderTree`: the cached folder tree for a mailbox, one small row per
 *    source (worker-owned) — lets the folder pane render instantly on
 *    reconnect instead of waiting for the PST to be re-walked.
 */

const DB_NAME = 'pstviewer-db'
const DB_VERSION = 2
const HANDLES_STORE = 'handles'
const SEARCH_DOCS_STORE = 'searchDocs'
const FOLDER_TREE_STORE = 'folderTree'

/** One remembered, re-grantable mailbox. */
export interface PersistedHandleRecord {
  id: string
  fileName: string
  size: number
  lastModified: number
  label: string
  addedAt: number
  lastOpenedAt: number
  handle: FileSystemFileHandle
}

interface ChunkManifest {
  size: number
  lastModified: number
  docsVersion: number
  chunkCount: number
  totalDocs: number
}

/** Keep any single structured-clone write well under the multi-hundred-MB
 *  range even for a 100k+ message mailbox. */
const CHUNK_SIZE = 2000
const manifestKey = (sourceId: string) => `manifest:${sourceId}`
const chunkKey = (sourceId: string, n: number) => `chunk:${sourceId}:${n}`

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLES_STORE)) {
        db.createObjectStore(HANDLES_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SEARCH_DOCS_STORE)) {
        // Out-of-line keys: manifest/chunk records are addressed by the
        // string keys built above, not by a field on the stored value.
        db.createObjectStore(SEARCH_DOCS_STORE)
      }
      // Added in DB_VERSION 2. A user upgrading from version 1 gets this
      // store created alongside their existing `handles`/`searchDocs` rows,
      // which onupgradeneeded leaves untouched — no migration needed, a
      // simple cache miss until each mailbox is opened once more.
      if (!db.objectStoreNames.contains(FOLDER_TREE_STORE)) {
        db.createObjectStore(FOLDER_TREE_STORE)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // A future schema version bump (plausible: registerType:'autoUpdate'
      // means an old and a new tab can coexist) would otherwise hang behind
      // a `blocked` event while this connection stays open. Just close it.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

// ---------------------------------------------------------------------------
// `handles` store
// ---------------------------------------------------------------------------

export async function putHandleRecord(record: PersistedHandleRecord): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(HANDLES_STORE, 'readwrite')
  tx.objectStore(HANDLES_STORE).put(record)
  await txDone(tx)
}

export async function getAllHandleRecords(): Promise<PersistedHandleRecord[]> {
  const db = await openDb()
  const tx = db.transaction(HANDLES_STORE, 'readonly')
  const result = await reqToPromise(tx.objectStore(HANDLES_STORE).getAll())
  await txDone(tx)
  return result as PersistedHandleRecord[]
}

export async function deleteHandleRecord(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(HANDLES_STORE, 'readwrite')
  tx.objectStore(HANDLES_STORE).delete(id)
  await txDone(tx)
}

/** Best-effort partial update (e.g. a rename), preserving the rest of the row. */
export async function updateHandleRecord(
  id: string,
  patch: Partial<Omit<PersistedHandleRecord, 'id'>>,
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(HANDLES_STORE, 'readwrite')
  const store = tx.objectStore(HANDLES_STORE)
  const existing = (await reqToPromise(store.get(id))) as PersistedHandleRecord | undefined
  if (existing) store.put({ ...existing, ...patch })
  await txDone(tx)
}

// ---------------------------------------------------------------------------
// `searchDocs` store (chunked, generic over the cached doc shape so this file
// stays dependency-free of the worker's `SearchDoc` type)
// ---------------------------------------------------------------------------

/** Read a cached full-text index back, or `null` on any cache miss: no
 *  manifest, a fingerprint/version mismatch, or a missing/partial chunk (a
 *  failed or in-progress write is simply invisible, never corrupting). */
export async function readChunkedCache<T>(
  sourceId: string,
  fingerprint: { size: number; lastModified: number },
  docsVersion: number,
): Promise<T[] | null> {
  const db = await openDb()
  const tx = db.transaction(SEARCH_DOCS_STORE, 'readonly')
  const store = tx.objectStore(SEARCH_DOCS_STORE)
  const manifest = (await reqToPromise(store.get(manifestKey(sourceId)))) as
    | ChunkManifest
    | undefined
  if (
    !manifest ||
    manifest.size !== fingerprint.size ||
    manifest.lastModified !== fingerprint.lastModified ||
    manifest.docsVersion !== docsVersion
  ) {
    await txDone(tx)
    return null
  }
  const chunks: T[][] = []
  for (let i = 0; i < manifest.chunkCount; i++) {
    const chunk = (await reqToPromise(store.get(chunkKey(sourceId, i)))) as T[] | undefined
    if (!chunk) {
      await txDone(tx)
      return null // a chunk went missing: treat the whole cache as absent
    }
    chunks.push(chunk)
  }
  await txDone(tx)
  return chunks.flat()
}

/**
 * Chunk `docs` and write them, writing the manifest **only after** every
 * chunk has written successfully — a reader that sees the manifest can trust
 * every chunk it names is present. Any failure aborts the remaining chunk
 * writes and skips the manifest, falling back silently to "no cache, will
 * reindex next time": this is a pure performance optimization, never
 * correctness-critical.
 */
export async function writeChunkedCache<T>(
  sourceId: string,
  docs: T[],
  fingerprint: { size: number; lastModified: number },
  docsVersion: number,
): Promise<void> {
  const db = await openDb()
  // Clear any previous chunks/manifest first, so a shorter rewrite can't
  // leave stale trailing chunks a later read would never overwrite.
  await deleteChunkedCache(sourceId)
  const chunkCount = Math.ceil(docs.length / CHUNK_SIZE)
  try {
    for (let i = 0; i < chunkCount; i++) {
      const chunk = docs.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      const tx = db.transaction(SEARCH_DOCS_STORE, 'readwrite')
      tx.objectStore(SEARCH_DOCS_STORE).put(chunk, chunkKey(sourceId, i))
      await txDone(tx)
    }
    const manifest: ChunkManifest = { ...fingerprint, docsVersion, chunkCount, totalDocs: docs.length }
    const tx = db.transaction(SEARCH_DOCS_STORE, 'readwrite')
    tx.objectStore(SEARCH_DOCS_STORE).put(manifest, manifestKey(sourceId))
    await txDone(tx)
  } catch {
    // Best-effort cache only: leave nothing half-written behind.
    await deleteChunkedCache(sourceId).catch(() => {})
  }
}

/** Delete every chunk + the manifest for one source (used by both "Remove
 *  mailbox" / "Forget" and by an overwriting `writeChunkedCache`). */
export async function deleteChunkedCache(sourceId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(SEARCH_DOCS_STORE, 'readwrite')
  const store = tx.objectStore(SEARCH_DOCS_STORE)
  store.delete(manifestKey(sourceId))
  const range = IDBKeyRange.bound(`chunk:${sourceId}:`, `chunk:${sourceId}:￿`)
  await new Promise<void>((resolve, reject) => {
    const cursorReq = store.openCursor(range)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else resolve()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
  await txDone(tx)
}

// ---------------------------------------------------------------------------
// `folderTree` store (one small row per source: the last-parsed folder tree,
// generic over the cached shape so this file stays dependency-free of the
// worker's `SourceIndex` type)
// ---------------------------------------------------------------------------

interface FolderTreeRecord<T> {
  size: number
  lastModified: number
  treeVersion?: number
  index: T
}

/** Read a cached folder tree back, or `null` on a cache miss: no row for this
 *  source (including a pre-DB_VERSION-2 install that has never written one
 *  yet), a fingerprint mismatch (the file changed since it was cached), or a
 *  `treeVersion` mismatch (the walk that produced it has since changed, so
 *  the cached shape can no longer be trusted — rows written before this field
 *  existed carry no version and always miss). */
export async function readFolderTreeCache<T>(
  sourceId: string,
  fingerprint: { size: number; lastModified: number },
  treeVersion: number,
): Promise<T | null> {
  const db = await openDb()
  const tx = db.transaction(FOLDER_TREE_STORE, 'readonly')
  const record = (await reqToPromise(tx.objectStore(FOLDER_TREE_STORE).get(sourceId))) as
    | FolderTreeRecord<T>
    | undefined
  await txDone(tx)
  if (
    !record ||
    record.size !== fingerprint.size ||
    record.lastModified !== fingerprint.lastModified ||
    record.treeVersion !== treeVersion
  ) {
    return null
  }
  return record.index
}

/** Overwrite the cached folder tree for one source. Best-effort: a write
 *  failure just means the next reconnect falls back to a full re-parse,
 *  never a correctness problem. */
export async function writeFolderTreeCache<T>(
  sourceId: string,
  fingerprint: { size: number; lastModified: number },
  treeVersion: number,
  index: T,
): Promise<void> {
  const db = await openDb()
  const record: FolderTreeRecord<T> = { ...fingerprint, treeVersion, index }
  const tx = db.transaction(FOLDER_TREE_STORE, 'readwrite')
  tx.objectStore(FOLDER_TREE_STORE).put(record, sourceId)
  await txDone(tx).catch(() => {})
}

/** Delete the cached folder tree for one source (used by "Remove mailbox" /
 *  "Forget", alongside `deleteChunkedCache`). */
export async function deleteFolderTreeCache(sourceId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(FOLDER_TREE_STORE, 'readwrite')
  tx.objectStore(FOLDER_TREE_STORE).delete(sourceId)
  await txDone(tx)
}

/** Wipe every row in all stores unconditionally — the "Clear all local
 *  data" escape hatch, independent of what's currently open or remembered. */
export async function clearAllStores(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([HANDLES_STORE, SEARCH_DOCS_STORE, FOLDER_TREE_STORE], 'readwrite')
  tx.objectStore(HANDLES_STORE).clear()
  tx.objectStore(SEARCH_DOCS_STORE).clear()
  tx.objectStore(FOLDER_TREE_STORE).clear()
  await txDone(tx)
}
