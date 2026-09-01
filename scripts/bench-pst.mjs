/**
 * Measure the cost of opening a PST/OST the way the app does, so reader and
 * concurrency changes can be judged instead of guessed.
 *
 * It runs the same three phases the viewer runs at open — load the b-trees,
 * walk the folder tree, list the biggest folders — and reports, per phase, the
 * wall time and the number of file fetches issued. It uses the very reader the
 * worker ships (`src/lib/chunkReader.ts`), so tuning the chunk size here tunes
 * the app.
 *
 *   node scripts/bench-pst.mjs <file.pst|file.ost>
 *   node scripts/bench-pst.mjs mail.ost --reader=direct     # pre-cache baseline
 *   node scripts/bench-pst.mjs mail.ost --latency=0.15      # emulate a browser
 *   node scripts/bench-pst.mjs mail.ost --chunk=1024 --concurrency=32
 *
 * `--latency` is the important flag: on disk a read costs microseconds, but in
 * the browser every `Blob.slice().arrayBuffer()` is a round-trip to the file
 * thread (~0.05–0.3ms). Passing a latency makes the local numbers resemble what
 * the app actually experiences, and makes the difference between the readers
 * visible. Outlook keeps a live .ost byte-range locked, so benchmark a copy or
 * close Outlook first.
 *
 * Requires a Node with TypeScript type stripping (Node 22.18+ / 23+), since it
 * imports the reader straight from src.
 */
import fs from 'node:fs'
import { createChunkReader } from '../src/lib/chunkReader.ts'
import { openPst } from '@hiraokahypertools/pst-extractor'

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

if (!path) {
  console.error('usage: node scripts/bench-pst.mjs <file.pst|file.ost> [--reader=chunked|direct]')
  console.error('       [--latency=<ms>] [--chunk=<KB>] [--budget=<MB>] [--concurrency=<n>] [--folders=<n>]')
  process.exit(1)
}

const readerKind = flag('reader', 'chunked')
const latencyMs = Number(flag('latency', '0'))
const chunkKB = Number(flag('chunk', '256'))
const budgetMB = Number(flag('budget', '128'))
const concurrency = Number(flag('concurrency', '32'))
const folderSample = Number(flag('folders', '5'))

const size = fs.statSync(path).size
const handle = await fs.promises.open(path, 'r')

const stats = { fetches: 0, bytes: 0 }
const delay = latencyMs > 0 ? () => new Promise((r) => setTimeout(r, latencyMs)) : null

/** A Blob-shaped view of the file, with the browser's per-read cost optionally
 *  simulated so local numbers resemble what the worker sees. */
const file = {
  size,
  slice(start, end) {
    return {
      async arrayBuffer() {
        const length = Math.max(0, Math.min(end, size) - start)
        const buf = Buffer.allocUnsafe(length)
        if (delay) await delay()
        await handle.read(buf, 0, length, start)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + length)
      },
    }
  },
}

const count = (start, length) => {
  stats.fetches++
  stats.bytes += length
}

const api =
  readerKind === 'direct'
    ? {
        // What the app did before: one file round-trip per parser read.
        readFile: async (buffer, offset, length, position) => {
          const bytes = new Uint8Array(await file.slice(position, position + length).arrayBuffer())
          count(position, bytes.byteLength)
          new Uint8Array(buffer).set(bytes, offset)
          return bytes.byteLength
        },
        close: async () => {},
      }
    : createChunkReader(file, {
        chunkSize: chunkKB * 1024,
        budget: budgetMB * 1024 * 1024,
        onFetch: count,
      })

const safe = (fn, fallback) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}
const safeAsync = async (fn, fallback) => {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function mapLimit(total, limit, fn) {
  const out = new Array(total)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, total) }, async () => {
      for (;;) {
        const i = next++
        if (i >= total) return
        out[i] = await fn(i)
      }
    }),
  )
  return out
}

let mark = { t: performance.now(), fetches: 0, bytes: 0 }
const phase = (label) => {
  const now = performance.now()
  const fetches = stats.fetches - mark.fetches
  const mb = (stats.bytes - mark.bytes) / 1e6
  console.log(
    `${label.padEnd(22)} ${(now - mark.t).toFixed(0).padStart(7)}ms  ` +
      `${String(fetches).padStart(8)} fetches  ${mb.toFixed(1).padStart(8)} MB`,
  )
  mark = { t: now, fetches: stats.fetches, bytes: stats.bytes }
}

console.log(
  `${path}  ${(size / 1e6).toFixed(1)} MB  reader=${readerKind}` +
    (readerKind === 'chunked' ? ` chunk=${chunkKB}KB budget=${budgetMB}MB` : '') +
    ` concurrency=${concurrency} latency=${latencyMs}ms\n`,
)

const started = performance.now()
const pst = await openPst(api)
phase('open (b-trees)')

const folders = new Map()
async function walk(folder) {
  const id = String(folder.primaryNodeId)
  folders.set(id, folder)
  const subCount = await safeAsync(() => folder.getSubFolderCount(), 0)
  const subs = (
    await mapLimit(subCount, concurrency, (i) => safeAsync(() => folder.getSubFolder(i), null))
  ).filter(Boolean)
  const children = await Promise.all(subs.map(walk))
  return {
    id,
    name: safe(() => folder.displayName, ''),
    messageCount: safe(() => folder.contentCount, 0),
    children,
  }
}
const tree = await walk(await pst.getRootFolder())
phase('folder tree')

const flat = []
const flatten = (node) => {
  flat.push(node)
  node.children.forEach(flatten)
}
flatten(tree)
const totalMessages = flat.reduce((n, f) => n + f.messageCount, 0)
console.log(`\nfolders=${flat.length} messages=${totalMessages}\n`)

const biggest = [...flat].sort((a, b) => b.messageCount - a.messageCount).slice(0, folderSample)
for (const node of biggest) {
  if (node.messageCount === 0) continue
  const folder = folders.get(node.id)
  const emailCount = await safeAsync(() => folder.getEmailCount(), 0)
  const emails = await mapLimit(emailCount, concurrency, (i) =>
    safeAsync(() => folder.getEmail(i), null),
  )
  // The same metadata the message list shows.
  for (const m of emails) {
    if (!m) continue
    safe(() => m.subject, '')
    safe(() => m.senderName, '')
    safe(() => m.senderEmailAddress, '')
    safe(() => m.displayTo, '')
    safe(() => m.messageDeliveryTime, null)
    safe(() => m.hasAttachments, false)
    safe(() => m.isRead, true)
    safe(() => m.messageClass, '')
  }
  phase(`list ${String(node.name).slice(0, 14).padEnd(14)} (${emailCount})`)
}

console.log(
  `\nTOTAL ${(performance.now() - started).toFixed(0)}ms  ` +
    `${stats.fetches} fetches  ${(stats.bytes / 1e6).toFixed(1)} MB read`,
)
await pst.close()
await handle.close()
