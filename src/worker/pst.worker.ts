import * as Comlink from 'comlink'
import MiniSearch from 'minisearch'
import { parseTnef, type TnefAttachment } from '../lib/tnef'
import { extractSmime } from '../lib/smime'
import { fingerprint } from '../lib/files'
import { createChunkReader } from '../lib/chunkReader'
import { hasActiveFilters } from '../lib/searchFilters'
import { parseQuery, phraseRegExp, queryWords } from '../lib/highlight'
import {
  deleteChunkedCache,
  deleteFolderTreeCache,
  readChunkedCache,
  readFolderTreeCache,
  writeChunkedCache,
  writeFolderTreeCache,
} from '../lib/idb'
import {
  createMsgFolder,
  msgAppointmentCard,
  msgContactCard,
  msgFieldsOf,
  parseMsg,
} from './msg'
import { isCfbFile, parseEml } from './eml'
import {
  Consts,
  openPst,
  PSTAppointment,
  PSTContact,
  PSTTask,
  type IPSTAppointment,
  type IPSTAttachment,
  type IPSTContact,
  type IPSTFile,
  type IPSTFolder,
  type IPSTMessage,
  type IPSTTask,
  type ReadFileApi,
} from '@hiraokahypertools/pst-extractor'
import type {
  AppointmentCard,
  AttachmentData,
  AttachmentMeta,
  ContactCard,
  DistListCard,
  EmbeddedMessageResult,
  FolderMessages,
  FolderNode,
  InlineImage,
  JournalCard,
  MessageContent,
  MessageMeta,
  RecipientInfo,
  SearchFilters,
  SearchHit,
  SourceIndex,
  TaskCard,
} from '../types'

/**
 * Off-thread PST parsing.
 *
 * Strategy: index-first, lazy bodies.
 *  - openSource() walks the folder tree only (fast) and keeps the live
 *    PST objects in a worker-side registry.
 *  - getFolderMessages() loads a single folder's message metadata on demand.
 *  - Full bodies + attachments are fetched per-message in later phases.
 */

interface SourceEntry {
  file: IPSTFile
  folders: Map<string, IPSTFolder>
  messages: Map<string, IPSTMessage>
  /** Cached attachment handles per message id, for lazy byte fetching. */
  attachments: Map<string, IPSTAttachment[]>
  /** Search-index document ids contributed by this source (for cleanup). */
  searchIds: Set<string>
  /** Attachments recovered from a winmail.dat (TNEF), keyed by message id. */
  tnef: Map<string, TnefAttachment[]>
  /** For .msg sources: files that failed to parse, counted per folder. */
  extraUnreadable?: Map<string, number>
  /** One in-flight-or-settled enumeration per folder, so revisiting a folder
   *  is free and two callers racing the same folder (the user clicking it
   *  while the indexer reaches it) share a single parse instead of doubling
   *  the reads. */
  folderLoads: Map<string, Promise<FolderMessages>>
  /** `{ size, lastModified }` off the opened File, set once in `openSource`;
   *  a mismatch on reconnect means the file changed and the cache is stale. */
  fingerprint: { size: number; lastModified: number }
  /** True only for a real single PST/OST opened with a FileSystemFileHandle.
   *  Gates every searchDocs cache read/write so a `.msg`/`.eml` batch or a
   *  zip-extracted synthetic file never gets an orphaned cache row. */
  persist: boolean
  /** Resolves once `buildFolderTree` has finished populating `folders` for
   *  every node in the tree. A cache-hit fast path can hand the UI a folder
   *  tree (and this entry) before that walk completes, so anything reading
   *  `folders` — currently just `getFolderMessages` — must await this first
   *  to avoid racing the still-in-flight real parse. */
  ready: Promise<void>
}

const sources = new Map<string, SourceEntry>()

/** Ids synchronously marked as "being forgotten" by `forgetPersisted`, closing
 *  the window where "Remove mailbox" deletes the searchDocs cache and an
 *  in-flight `indexSource` write immediately recreates it. Cleared whenever
 *  the same id is opened again (a fresh session for that identity). */
const forgottenIds = new Set<string>()

/** Bump whenever the folder walk changes shape, so trees cached by an older
 *  build are re-parsed instead of shown. Bumped to 2 for the OST mailbox-root
 *  fix (see `findIpmSubtreeId`), whose caches hold a wrong, one-folder tree,
 *  and to 4 for `reduceToMailbox` — 2 and 3 alike cache an OST's store plumbing
 *  (`Root - Mailbox`, `IPM_SUBTREE`, `Finder`, …) as visible folders — and to 5
 *  for `pickIpmSubtree`, since 4 can cache an empty tree on a multi-store OST. */
const TREE_VERSION = 5

/** Bump whenever body extraction (stripHtml/extractBodies/RTF-de-encapsulation/
 *  TNEF/S-MIME) or the MiniSearch field config changes — a cached SearchDoc's
 *  shape is a function of that code, and a fingerprint match alone can't
 *  detect "the code that produced this cache changed." */
const DOCS_VERSION = 2

// Best-effort: ask the browser not to evict this origin's storage under
// pressure (relevant now that a mailbox's search index is cached durably).
// Never block startup on it, and ignore whatever it resolves to.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {})
}

/** In-memory teardown only — no IndexedDB deletion. Shared by `closeSource`
 *  and by `openSource`/`openMsgSource` reopening an id that's already live
 *  (double reconnect, reconnect-then-redrop): with identity-derived ids a
 *  bare `sources.delete()` would leave the old entry's docs in the *shared*
 *  MiniSearch index — orphaned and unremovable, and liable to make a later
 *  `searchIndex.addAll` throw on a duplicate id (MiniSearch rejects those,
 *  and `addAll` isn't transactional, so a throw mid-call half-loads the index). */
async function evictSource(sourceId: string): Promise<void> {
  const entry = sources.get(sourceId)
  if (!entry) return
  // Remove from the registry first (synchronously) so in-flight indexing
  // sees the source as gone and stops adding to the shared index.
  sources.delete(sourceId)
  for (const id of entry.searchIds) {
    if (searchIndex.has(id)) searchIndex.discard(id)
    searchDocs.delete(id)
  }
  await safeAsync(() => entry.file.close(), undefined)
}

interface SearchDoc {
  id: string
  sourceId: string
  messageId: string
  folderId: string
  subject: string
  from: string
  to: string
  body: string
  attachments: string
  date: number | null
  hasAttachments: boolean
}

const searchIndex = new MiniSearch<SearchDoc>({
  idField: 'id',
  fields: ['subject', 'from', 'to', 'body', 'attachments'],
  storeFields: ['sourceId', 'messageId', 'folderId', 'subject', 'from', 'date', 'hasAttachments'],
  searchOptions: { boost: { subject: 3, from: 2 }, fuzzy: 0.2, prefix: true },
})

/** Every indexed doc, kept alongside the search index. Filter checks read from
 *  here rather than from an index hit's stored fields, so a filter can match on
 *  anything a doc holds (`to` recipients, say, which aren't a stored field).
 *  Written and discarded in lockstep with `searchIndex`. */
const searchDocs = new Map<string, SearchDoc>()

/** Whether every quoted phrase appears intact somewhere in an indexed message.
 *  The fields are joined with a NUL rather than whitespace so a phrase can't
 *  match by running off the end of one field into the start of the next. */
function containsPhrases(doc: SearchDoc, phraseRes: RegExp[]): boolean {
  const hay = [doc.subject, doc.from, doc.to, doc.body, doc.attachments].join('\u0000')
  return phraseRes.every((re) => re.test(hay))
}

/** Whether an indexed message satisfies the optional advanced filters. */
function matchesSearchFilters(doc: SearchDoc, f: SearchFilters): boolean {
  const date = doc.date
  if (f.dateFrom != null && (date == null || date < f.dateFrom)) return false
  if (f.dateTo != null && (date == null || date > f.dateTo)) return false
  if (f.folder && (doc.sourceId !== f.folder.sourceId || doc.folderId !== f.folder.folderId)) {
    return false
  }
  if (f.hasAttachments && !doc.hasAttachments) return false
  if (f.from.trim() && !doc.from.toLowerCase().includes(f.from.trim().toLowerCase())) return false
  if (f.to.trim() && !doc.to.toLowerCase().includes(f.to.trim().toLowerCase())) return false
  return true
}

/** A doc as a search hit. `score` is meaningless for a filter-only browse, so
 *  callers pass 0 there. */
function docToHit(doc: SearchDoc, score: number): SearchHit {
  return {
    sourceId: doc.sourceId,
    messageId: doc.messageId,
    folderId: doc.folderId,
    subject: doc.subject,
    from: doc.from,
    date: doc.date,
    hasAttachments: doc.hasAttachments,
    score,
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** A random-access reader over the opened File. See `src/lib/chunkReader.ts`
 *  for why this is chunked and cached rather than a slice per read. */
function makeReader(file: File): ReadFileApi {
  return createChunkReader(file)
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Map over `count` indices with at most `limit` calls in flight, keeping the
 *  results in index order. The parser is a long chain of small awaited reads,
 *  so overlapping independent items is what turns read latency into throughput
 *  — the chunk cache in `makeReader` collapses whatever overlaps. */
async function mapLimit<T>(
  count: number,
  limit: number,
  fn: (index: number) => Promise<T>,
): Promise<T[]> {
  const out = new Array<T>(count)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      const i = next++
      if (i >= count) return
      out[i] = await fn(i)
    }
  })
  await Promise.all(workers)
  return out
}

/** A counting semaphore, for bounding work that isn't a flat list of indices
 *  (the recursive folder walk) and so can't use `mapLimit`. */
function createLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** How many message/folder loads to keep in flight. High enough to hide read
 *  latency, low enough that a huge folder doesn't pin thousands of half-parsed
 *  messages at once. */
const LOAD_CONCURRENCY = 32

/** Concurrent folder walks during the tree build, and concurrent subfolder
 *  loads within one walk. Folders are far fewer than messages and each costs
 *  only a property-context read, so both stay modest — the product of the two
 *  is what is actually in flight. */
const TREE_CONCURRENCY = 8
const SUBFOLDER_CONCURRENCY = 8

/** Indexing runs behind the user's own clicks, so it takes a smaller share of
 *  the read queue than an interactive folder load. */
const INDEX_CONCURRENCY = 16

/** Enumerate a folder's subfolders in parallel.
 *
 *  `getSubFolders()` resolves them one at a time, each costing a property-context
 *  read. Priming the provider with `getSubFolderCount()` first is deliberate:
 *  the library builds it behind a non-reentrant latch, so concurrent first calls
 *  would each build the target list. Falls back to `getSubFolders()` for the
 *  synthetic `.msg` folders, which don't implement the indexed API. */
async function listSubFolders(folder: IPSTFolder): Promise<IPSTFolder[]> {
  if (typeof folder.getSubFolderCount !== 'function') {
    return safeAsync(() => folder.getSubFolders(), [] as IPSTFolder[])
  }
  const count = await safeAsync(() => folder.getSubFolderCount(), 0)
  if (count === 0) return []
  const subs = await safeAsync(
    () => mapLimit(count, SUBFOLDER_CONCURRENCY, (i) => safeAsync(() => folder.getSubFolder(i), null)),
    [] as (IPSTFolder | null)[],
  )
  return subs.filter((f): f is IPSTFolder => f !== null)
}

/** Enumerate a folder's messages in parallel; see `listSubFolders` for why the
 *  count is fetched first. Returns nulls in place of messages that failed to
 *  parse so callers can still report a salvage count. */
async function listEmails(folder: IPSTFolder): Promise<(IPSTMessage | null)[] | null> {
  if (typeof folder.getEmailCount !== 'function') {
    return safeAsync(() => folder.getEmails() as Promise<(IPSTMessage | null)[]>, null)
  }
  let count: number
  try {
    count = await folder.getEmailCount()
  } catch {
    return null // the contents table itself is unreadable
  }
  if (count === 0) return []
  return mapLimit(count, LOAD_CONCURRENCY, (i) => safeAsync(() => folder.getEmail(i), null))
}

function toMeta(m: IPSTMessage, folderId: string): MessageMeta {
  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)
  const date = (delivery ?? submit)?.getTime() ?? null
  return {
    id: String(m.primaryNodeId),
    folderId,
    subject: safe(() => m.subject, '') || '(no subject)',
    fromName: safe(() => m.senderName, '') || safe(() => m.sentRepresentingName, ''),
    fromEmail:
      safe(() => m.senderEmailAddress, '') || safe(() => m.sentRepresentingEmailAddress, ''),
    to: safe(() => m.displayTo, ''),
    date,
    hasAttachments: safe(() => m.hasAttachments, false),
    isRead: safe(() => m.isRead, true),
    messageClass: safe(() => m.messageClass, ''),
  }
}

// Outlook marks its internal/system folders (Sync Issues, Conversation Action
// Settings, etc.) with PR_ATTR_HIDDEN. Skipping hidden folders drops them from
// the tree regardless of their (possibly localized) display names.
function isHiddenFolder(folder: IPSTFolder): boolean {
  const v = safe(() => folder.getProperty(0x10f4)?.value, false)
  return v === true || v === 1
}

/**
 * Walk a folder subtree, registering every folder on `entry.folders`.
 *
 * Sibling subtrees are independent, so they're walked together — a mailbox
 * walked strictly depth-first is one long chain of single small reads, each
 * paying its own latency. `limit` is a single semaphore shared by the whole
 * walk (not a per-level cap), so a deep tree can't multiply out to
 * concurrency^depth folders in flight.
 */
async function buildFolderTree(
  folder: IPSTFolder,
  entry: SourceEntry,
  limit = createLimiter(TREE_CONCURRENCY),
): Promise<FolderNode> {
  const id = String(folder.primaryNodeId)
  entry.folders.set(id, folder)
  const subs = (await limit(() => listSubFolders(folder))).filter((sub) => !isHiddenFolder(sub))
  const children = await Promise.all(subs.map((sub) => buildFolderTree(sub, entry, limit)))
  return {
    id,
    name: safe(() => folder.displayName, '') || '(unnamed folder)',
    containerClass: safe(() => folder.containerClass, ''),
    messageCount: safe(() => folder.contentCount, 0),
    children,
  }
}

/** A folder EntryID (MS-OXCDATA 2.2.4.1) is 24 bytes: 4 flag bytes, the
 *  16-byte store GUID, then the 4-byte node id, little-endian. */
function nodeIdFromEntryId(value: unknown): number | null {
  let bytes: Uint8Array | null = null
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (!bytes || bytes.length < 24) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20, true)
}

/**
 * Find the IPM subtree — the container Outlook shows as the top of the data
 * file, holding Inbox/Sent Items/Calendar/… — and return its node id.
 *
 * It has no fixed node id. MS-PST points at it with PidTagIpmSubTreeEntryId
 * (0x35E0) on the message store, which is what we read here. pst-extractor's
 * `getTopOfOutlookDataFile()` instead hardcodes node id 0x8022 — where Outlook
 * happens to allocate the subtree in a `.pst`, but NOT in a `.ost`, where that
 * id lands on some arbitrary folder (in practice Calendar). Trusting it there
 * opened an OST showing only that one folder's subtree, hiding all the mail.
 *
 * Returns null when neither route yields an id; `reduceToMailbox` then falls
 * back to recognising the subtree by name.
 */
async function findIpmSubtreeId(pstFile: IPSTFile): Promise<string | null> {
  // The spec route, and the only one that holds for both file types. Returned
  // unvalidated on purpose: the subtree's depth under the root varies (a `.pst`
  // has it as a direct child, an `.ost` nests it under "Root - Mailbox"), so
  // there is nothing cheap to check it against here. `reduceToMailbox` accepts
  // the id only if a folder carrying it turns up in the walked tree.
  const wanted = await safeAsync(async () => {
    const store = await pstFile.getMessageStore()
    return nodeIdFromEntryId(safe(() => store.getProperty(0x35e0)?.value, undefined))
  }, null)
  if (wanted !== null) return String(wanted)

  // No entry id. The library's hardcoded lookup is the only language-independent
  // route left for a `.pst`, whose container name is localized — but take it
  // only when what it returns really is a direct child of the root folder. That
  // is what the `.pst` container always is, and what the `.ost` mis-hit (an
  // ordinary folder nested well below the root) never is.
  const root = await safeAsync(() => pstFile.getRootFolder(), null)
  const children = root
    ? await safeAsync(() => root.getSubFolders(), [] as IPSTFolder[])
    : ([] as IPSTFolder[])
  const nodeIdOf = (f: IPSTFolder) => safe(() => f.primaryNodeId, -1)
  const top = await safeAsync(() => pstFile.getTopOfOutlookDataFile(), null)
  const topId = top ? nodeIdOf(top) : -1
  if (topId !== -1 && children.some((c) => nodeIdOf(c) === topId)) return String(topId)

  // Only the name match is left, and it is English-only — so say why we got
  // here. Never on a healthy file, so a normal open stays silent.
  console.warn(
    '[pst] no IPM subtree id: PidTagIpmSubTreeEntryId (0x35E0) missing or unreadable on the',
    'message store, and getTopOfOutlookDataFile() is not a child of the root — root children:',
    children.map((c) => `${safe(() => c.displayName, '?')}#${nodeIdOf(c)}`).join(', ') || '(none)',
  )
  return null
}

/** Names the IPM subtree goes by, for when its id could not be resolved:
 *  Outlook's localized container in a `.pst`, and the raw internal name an
 *  `.ost` carries. */
const IPM_SUBTREE_NAME = /^(top of (personal folders|outlook data file)\b|ipm_subtree\s*$)/i

/** Messages in a folder and everything beneath it. */
function countMessages(node: FolderNode): number {
  return node.children.reduce((n, c) => n + countMessages(c), node.messageCount)
}

/** Every folder id in a tree. */
function collectFolderIds(node: FolderNode, out = new Set<string>()): Set<string> {
  out.add(node.id)
  for (const child of node.children) collectFolderIds(child, out)
  return out
}

/** A folder located in a built tree, with the parent it hangs off. */
type FoundNode = { node: FolderNode; parent: FolderNode | null }

/** Every node in a built tree matching `match`, each with its parent. */
function findNodes(
  node: FolderNode,
  match: (n: FolderNode) => boolean,
  parent: FolderNode | null = null,
  out: FoundNode[] = [],
): FoundNode[] {
  if (match(node)) out.push({ node, parent })
  for (const child of node.children) findNodes(child, match, node, out)
  return out
}

/**
 * Pick the IPM subtree holding the user's mail.
 *
 * A file can contain more than one. An OST cached from Exchange carries a store
 * root per store — `Root - Mailbox` for the mailbox, `Root - Public` for public
 * folders — and each has its own `IPM_SUBTREE` child. Taking the first match in
 * walk order is a coin toss decided by the order the provider happens to
 * enumerate the root's children in: on the OSTs this was written for, the empty
 * public subtree came first, so the folder pane came up completely blank.
 *
 * So: trust the store's own PidTagIpmSubTreeEntryId when the folder it names
 * actually holds mail, and otherwise take the fullest subtree we can see. Both
 * beat walk order, and an all-empty mailbox still resolves — to the id match, or
 * to the first name match if there was no id at all.
 */
function pickIpmSubtree(root: FolderNode, subtreeId: string | null): FoundNode | null {
  const byId = subtreeId !== null ? (findNodes(root, (n) => n.id === subtreeId)[0] ?? null) : null
  if (byId && countMessages(byId.node) > 0) return byId

  const named = findNodes(root, (n) => IPM_SUBTREE_NAME.test(n.name))
  const candidates = byId ? [byId, ...named.filter((c) => c.node !== byId.node)] : named
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) =>
    countMessages(c.node) > countMessages(best.node) ? c : best,
  )
}

/**
 * Reduce a walked tree to the mailbox Outlook shows.
 *
 * The user's folders live in the IPM subtree, so its parent is the real mailbox
 * root: the subtree's children move up to the top level and its siblings — store
 * plumbing like `~MAPISP(Internal)`, `Common Views`, an OST's `Drizzle` sync
 * scratch and the `Finder`/Search Root container — are dropped.
 *
 * The subtree is found at any depth (see `pickIpmSubtree`), never assumed to be
 * a direct child of the root: a `.pst` puts it directly under the root folder,
 * but an `.ost` nests it one level further down, under `Root - Mailbox`. That
 * extra level is exactly what `NavPane` was showing along with the plumbing.
 *
 * Siblings are not dropped by name, though. Exchange keeps the Recoverable
 * Items subtree (Deletions, Purges, Versions, …) outside the IPM subtree, and
 * in a mailbox investigation that is evidence, not noise — so a sibling
 * survives whenever it holds a message anywhere beneath it. Plumbing never does.
 *
 * With no subtree to find, the tree is returned untouched: its children already
 * are the mailbox, and filtering there would drop the user's own empty folders.
 */
function reduceToMailbox(root: FolderNode, subtreeId: string | null): FolderNode {
  const hit = pickIpmSubtree(root, subtreeId)
  if (!hit) return root
  const { node: subtree, parent } = hit
  const siblings = (parent?.children ?? []).filter((c) => c !== subtree && countMessages(c) > 0)
  const children = [...subtree.children, ...siblings]
  // A reduction that empties the folder pane is never an improvement on leaving
  // it alone: show the raw tree, plumbing and all, rather than nothing.
  if (children.length === 0 && root.children.length > 0) return root
  return { ...(parent ?? subtree), children }
}

async function buildSearchDoc(
  sourceId: string,
  folderId: string,
  msgId: string,
  m: IPSTMessage,
  entry: SourceEntry,
): Promise<SearchDoc> {
  const bodies = extractBodies(m)
  const html = bodies.html
  const body = bodies.text || (html ? stripHtml(html) : '')

  let attachments = ''
  if (safe(() => m.hasAttachments, false)) {
    const list = await safeAsync(() => m.getAttachments(), [])
    entry.attachments.set(msgId, list) // warm cache for later preview
    attachments = list
      .map((a) => safe(() => a.longFilename, '') || safe(() => a.filename, ''))
      .filter(Boolean)
      .join(' ')
  }

  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)

  return {
    id: `${sourceId}:${msgId}`,
    sourceId,
    messageId: msgId,
    folderId,
    subject: safe(() => m.subject, ''),
    from: `${safe(() => m.senderName, '')} ${safe(() => m.senderEmailAddress, '')}`.trim(),
    to: `${safe(() => m.displayTo, '')} ${safe(() => m.displayCC, '')}`.trim(),
    body,
    attachments,
    date: (delivery ?? submit)?.getTime() ?? null,
    hasAttachments: safe(() => m.hasAttachments, false),
  }
}

/**
 * Enumerate one folder's messages, register the live handles on the entry, and
 * return their list metadata. Memoised per folder on the entry (see
 * `folderLoads`) — it is the single place a message handle comes into
 * existence, reached from the message list, from opening a search hit in a
 * folder that was never listed, and from the background indexer alike.
 */
function loadFolderMessages(entry: SourceEntry, folderId: string): Promise<FolderMessages> {
  const existing = entry.folderLoads.get(folderId)
  if (existing) return existing

  const folder = entry.folders.get(folderId)
  if (!folder) return Promise.resolve({ messages: [], unreadable: 0 })

  const load = (async (): Promise<FolderMessages> => {
    const emails = await listEmails(folder)
    const metas: MessageMeta[] = []
    let failed = 0
    for (const m of emails ?? []) {
      // A null slot is a message whose own parse failed; skip it rather than
      // failing the folder, so a damaged file still shows what survives.
      if (!m) {
        failed++
        continue
      }
      try {
        entry.messages.set(String(m.primaryNodeId), m)
        metas.push(toMeta(m, folderId))
      } catch {
        failed++
      }
    }
    // If the whole table was unreadable, fall back to the folder's declared
    // count so the user still learns the contents are damaged.
    const unreadable =
      emails === null
        ? Math.max(safe(() => folder.contentCount, 0), 1)
        : failed + (entry.extraUnreadable?.get(folderId) ?? 0)
    return { messages: metas, unreadable }
  })()

  // Don't memoise a rejection: a transient failure shouldn't make the folder
  // permanently empty for the rest of the session.
  entry.folderLoads.set(folderId, load)
  void load.catch(() => entry.folderLoads.delete(folderId))
  return load
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '')

// Default names Outlook gives every personal data file: not a useful mailbox
// label, so we prefer the user's filename when the store reports one of these.
function isGenericStoreName(name: string): boolean {
  const n = (name || '').trim().toLowerCase()
  return (
    n === '' ||
    /^(top of )?(personal folders|outlook data file|information store)\b/.test(n) ||
    n === 'ipm_subtree' ||
    n === 'mailbox' ||
    n === 'root' ||
    n === 'root - mailbox' ||
    n === '(unnamed folder)'
  )
}

/** A tidy label from a filename: drop the extension, underscores to spaces, title-case. */
function prettyFileName(fileName: string): string {
  const base = stripExt(fileName)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base ? base.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : 'Mailbox'
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? ''
}

function cleanCid(cid: string): string {
  return cid.replace(/^<+|>+$/g, '').trim()
}

// MAPI body property tags.
const PR_BODY = 0x1000 // plain text
const PR_HTML = 0x1013 // HTML (often stored as PT_BINARY)
const PR_INTERNET_CPID = 0x3fde // code page of the body bytes

function codepageToLabel(cp?: number): string {
  switch (cp) {
    case 65001:
    case 20127:
      return 'utf-8'
    case 1250:
    case 1251:
    case 1252:
    case 1253:
    case 1254:
    case 1255:
    case 1256:
    case 1257:
    case 1258:
      return `windows-${cp}`
    case 932:
      return 'shift_jis'
    case 936:
      return 'gbk'
    case 949:
      return 'euc-kr'
    case 950:
      return 'big5'
    case 866:
      return 'ibm866'
    case 28591:
    case 28592:
    case 28595:
    case 28596:
    case 28597:
    case 28598:
    case 28599:
    case 28603:
    case 28605:
      return `iso-8859-${cp - 28590}`
    case 50220:
    case 50221:
    case 50222:
      return 'iso-2022-jp'
    case 51932:
      return 'euc-jp'
    default:
      return 'utf-8'
  }
}

function decodeBinary(buf: ArrayBuffer, cp?: number): string {
  const bytes = new Uint8Array(buf)
  try {
    return new TextDecoder(codepageToLabel(cp), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

function bodyCodepage(m: IPSTMessage): number | undefined {
  const cp = safe(() => m.getProperty(PR_INTERNET_CPID)?.value, undefined)
  return typeof cp === 'number' ? cp : undefined
}

function propString(m: IPSTMessage, key: number): string {
  const value = safe(() => m.getProperty(key)?.value, undefined)
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer && value.byteLength > 0) return decodeBinary(value, bodyCodepage(m))
  return ''
}

const CONTROL_WORD = /^\\([a-zA-Z]+)(-?\d+)? ?/

/**
 * De-encapsulate Outlook compressed-RTF (already decompressed via `bodyRTF`).
 * Recovers the original HTML for `\fromhtml` mail (MS-OXRTFEX), or best-effort
 * text for `\fromtext` / plain RTF.
 */
function deEncapsulateRtf(rtf: string, cp?: number): { html: string; text: string } {
  if (!rtf || rtf.indexOf('\\rtf') === -1) return { html: '', text: '' }
  const isHtml = /\\fromhtml1?\b/.test(rtf) || rtf.indexOf('\\*\\htmltag') !== -1

  interface GState {
    htmlrtf: boolean
    suppress: boolean
    htmltag: boolean
    ucSkip: number
  }
  let st: GState = { htmlrtf: false, suppress: false, htmltag: false, ucSkip: 1 }
  const stack: GState[] = []
  const out: string[] = []
  let hex: number[] = []
  let pendingStar = false
  let skipChars = 0
  const n = rtf.length
  let i = 0
  // The RTF's own \ansicpgN header names the code page of its \'xx bytes; it
  // beats the caller's hint (PR_INTERNET_CPID can be a transport-only encoding
  // like iso-2022-jp while the RTF text is really e.g. cp932).
  let hexCp = cp

  const flushHex = () => {
    if (!hex.length) return
    if (st.htmltag || (!st.htmlrtf && !st.suppress)) {
      try {
        out.push(new TextDecoder(codepageToLabel(hexCp), { fatal: false }).decode(new Uint8Array(hex)))
      } catch {
        out.push(new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(hex)))
      }
    }
    hex = []
  }
  const emit = (s: string) => {
    if (st.htmltag || (!st.htmlrtf && !st.suppress)) out.push(s)
  }

  while (i < n) {
    const c = rtf[i]
    if (skipChars > 0 && c !== '{' && c !== '}' && c !== '\\') {
      skipChars--
      i++
      continue
    }
    if (c === '{') {
      flushHex()
      stack.push(st)
      st = { ...st, htmltag: false }
      i++
      continue
    }
    if (c === '}') {
      flushHex()
      st = stack.pop() ?? st
      i++
      continue
    }
    if (c === '\\') {
      const d = rtf[i + 1]
      if (d === '\\' || d === '{' || d === '}') {
        flushHex()
        emit(d)
        i += 2
        continue
      }
      if (d === "'") {
        const b = parseInt(rtf.substr(i + 2, 2), 16)
        if (!Number.isNaN(b)) hex.push(b)
        i += 4
        continue
      }
      if (d === '*') {
        flushHex()
        pendingStar = true
        i += 2
        continue
      }
      flushHex()
      const m2 = CONTROL_WORD.exec(rtf.slice(i))
      if (!m2) {
        i++
        continue
      }
      const word = m2[1]
      const param = m2[2] !== undefined ? parseInt(m2[2], 10) : undefined
      i += m2[0].length

      if (pendingStar) {
        pendingStar = false
        if (word === 'htmltag' || word === 'mhtmltag') st = { ...st, htmltag: true }
        else st = { ...st, suppress: true }
        continue
      }

      switch (word) {
        // Destination groups whose content is not document text (the font and
        // color tables leak as literal "Arial;Times;..." text otherwise).
        case 'fonttbl':
        case 'colortbl':
        case 'stylesheet':
        case 'info':
        case 'listtable':
        case 'listoverridetable':
        case 'pict':
        case 'themedata':
        case 'colorschememapping':
        case 'generator':
          st = { ...st, suppress: true }
          break
        case 'htmlrtf':
          st = { ...st, htmlrtf: param !== 0 }
          break
        case 'ansicpg':
          if (param) hexCp = param
          break
        case 'uc':
          st = { ...st, ucSkip: param ?? 1 }
          break
        case 'u':
          if (param !== undefined) {
            emit(String.fromCharCode(param < 0 ? param + 65536 : param))
            skipChars = st.ucSkip
          }
          break
        case 'par':
        case 'line':
          if (!isHtml) emit('\n')
          break
        case 'tab':
          if (!isHtml) emit('\t')
          break
        case 'lquote': emit('‘'); break
        case 'rquote': emit('’'); break
        case 'ldblquote': emit('“'); break
        case 'rdblquote': emit('”'); break
        case 'bullet': emit('•'); break
        case 'endash': emit('–'); break
        case 'emdash': emit('—'); break
        case 'nbsp': emit(' '); break
        default:
          break
      }
      continue
    }
    if (c === '\r' || c === '\n') {
      i++
      continue
    }
    flushHex()
    emit(c)
    i++
  }
  flushHex()

  const result = out.join('')
  return isHtml ? { html: result.trim() ? result : '', text: '' } : { html: '', text: result }
}

/** Extract the best HTML + text body, covering bodyHTML, PR_HTML binary, and RTF. */
function extractBodies(m: IPSTMessage): { html: string; text: string } {
  let html = safe(() => m.bodyHTML, '') || propString(m, PR_HTML)
  let text = safe(() => m.body, '') || propString(m, PR_BODY)
  if (!html) {
    const rtf = safe(() => m.bodyRTF, '')
    if (rtf) {
      const de = deEncapsulateRtf(rtf, bodyCodepage(m))
      if (de.html) html = de.html
      else if (!text && de.text) text = de.text
    }
  }
  return { html, text }
}

function attachmentName(a: IPSTAttachment, index: number, isEmbedded: boolean): string {
  return (
    safe(() => a.longFilename, '') ||
    safe(() => a.filename, '') ||
    (isEmbedded ? safe(() => a.displayName, '') || 'Embedded message' : `attachment-${index + 1}`)
  )
}

/** Build the full, serializable content of a message (shared by top-level and embedded). */
/** Map a PST message class to the item kind we render. */
function itemKindOf(messageClass: string): MessageContent['itemKind'] {
  const c = (messageClass || '').toLowerCase()
  if (c.startsWith('ipm.distlist')) return 'distlist'
  if (c.startsWith('ipm.task')) return 'task'
  if (c.startsWith('ipm.activity')) return 'journal'
  if (c.startsWith('ipm.stickynote')) return 'note'
  if (c.startsWith('ipm.contact')) return 'contact'
  if (c.startsWith('ipm.appointment') || c.startsWith('ipm.schedule.meeting')) return 'appointment'
  return 'email'
}

// Re-wrap a message as a typed contact/appointment, reusing its internals so all
// getters (including named MAPI properties like email/address) resolve.
function asContact(m: IPSTMessage): IPSTContact {
  const x = m as unknown as Record<string, unknown>
  return new (PSTContact as unknown as new (...a: unknown[]) => IPSTContact)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}
function asAppointment(m: IPSTMessage): IPSTAppointment {
  const x = m as unknown as Record<string, unknown>
  return new (PSTAppointment as unknown as new (...a: unknown[]) => IPSTAppointment)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}

// Drop U+FFFD replacement chars (mis-decoded bytes, e.g. the empty location on a
// canceled meeting that arrives as a single "replacement character") and trim, so
// junk-only values are treated as empty and not rendered.
function cleanStr(s: string): string {
  return (s || '').replace(/�/g, '').trim()
}
const safeStr = (fn: () => string): string => cleanStr(safe(fn, ''))

function buildContactCard(m: IPSTMessage): ContactCard {
  const c = asContact(m)
  const fullName =
    safeStr(() => c.fileUnder) ||
    [safeStr(() => c.givenName), safeStr(() => c.middleName), safeStr(() => c.surname)]
      .filter(Boolean)
      .join(' ') ||
    safeStr(() => m.subject)
  const emails: ContactCard['emails'] = []
  const pushEmail = (address: string, label: string) => {
    if (address) emails.push({ label: label || 'Email', address })
  }
  pushEmail(safeStr(() => c.email1EmailAddress), safeStr(() => c.email1DisplayName))
  pushEmail(safeStr(() => c.email2EmailAddress), safeStr(() => c.email2DisplayName))
  pushEmail(safeStr(() => c.email3EmailAddress), safeStr(() => c.email3DisplayName))
  const phones: ContactCard['phones'] = []
  const pushPhone = (value: string, label: string) => {
    if (value) phones.push({ label, value })
  }
  pushPhone(safeStr(() => c.businessTelephoneNumber), 'Business')
  pushPhone(safeStr(() => c.mobileTelephoneNumber), 'Mobile')
  pushPhone(safeStr(() => c.homeTelephoneNumber), 'Home')
  pushPhone(safeStr(() => c.otherTelephoneNumber), 'Other')
  pushPhone(safeStr(() => c.companyMainPhoneNumber), 'Company')
  pushPhone(safeStr(() => c.businessFaxNumber), 'Business fax')
  const addresses: ContactCard['addresses'] = []
  const pushAddress = (value: string, label: string) => {
    if (value) addresses.push({ label, value })
  }
  pushAddress(safeStr(() => c.workAddress), 'Work')
  pushAddress(safeStr(() => c.homeAddress), 'Home')
  pushAddress(safeStr(() => c.otherAddress), 'Other')
  return {
    fullName,
    emails,
    phones,
    company: safeStr(() => c.companyName),
    jobTitle: safeStr(() => c.title),
    department: safeStr(() => c.departmentName),
    addresses,
    website: safeStr(() => c.businessHomePage) || safeStr(() => c.personalHomePage),
    im: safeStr(() => c.instantMessagingAddress),
    birthday: safe(() => c.birthday, null)?.getTime() ?? null,
  }
}

function buildAppointmentCard(m: IPSTMessage): AppointmentCard {
  const a = asAppointment(m)
  return {
    location: safeStr(() => a.location),
    start: safe(() => a.startTime, null)?.getTime() ?? null,
    end: safe(() => a.endTime, null)?.getTime() ?? null,
    allDay: safe(() => a.subType, false),
    organizer: safeStr(() => m.sentRepresentingName) || safeStr(() => m.senderName),
    requiredAttendees: safeStr(() => a.requiredAttendees) || safeStr(() => a.toAttendees),
    optionalAttendees: safeStr(() => a.ccAttendees),
    recurrence: safe(() => a.isRecurring, false) ? safeStr(() => a.recurrencePattern) : '',
  }
}

// One-off EntryID (MS-OXCDATA): 4-byte flags + 16-byte UID + 2-byte version + 2-byte
// flags, then 3 null-terminated strings (display name, address type, email). The
// 0x8000 flag marks the strings as UTF-16LE rather than 8-bit.
function parseOneOffMember(bytes: Uint8Array): { name: string; email: string } | null {
  if (bytes.length < 26) return null
  const flags = bytes[22] | (bytes[23] << 8)
  const unicode = (flags & 0x8000) !== 0
  let off = 24
  const readStr = (): string => {
    if (unicode) {
      let end = off
      while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2
      const s = new TextDecoder('utf-16le').decode(bytes.subarray(off, end))
      off = end + 2
      return s
    }
    let end = off
    while (end < bytes.length && bytes[end] !== 0) end++
    const s = new TextDecoder('utf-8').decode(bytes.subarray(off, end))
    off = end + 1
    return s
  }
  const name = cleanStr(readStr())
  readStr() // address type (e.g. SMTP)
  const email = cleanStr(readStr())
  if (!email.includes('@') && !/[a-z0-9]/i.test(name)) return null // drop garbage
  return { name, email }
}

function buildDistListCard(m: IPSTMessage): DistListCard {
  const name =
    safeStr(() => (m as unknown as { displayName: string }).displayName) || safeStr(() => m.subject)
  const members: DistListCard['members'] = []
  try {
    const x = m as unknown as {
      _rootProvider: { getNameToIdMapItem: (key: number, idx: number) => number }
      _propertyFinder: { findByKey: (key: number) => { value: unknown } | undefined }
    }
    // PidLidDistributionListOneOffMembers (0x8054) under PSETID_Address (2).
    const tag = x._rootProvider.getNameToIdMapItem(0x8054, 2)
    const value = tag !== -1 ? x._propertyFinder.findByKey(tag)?.value : undefined
    const list: unknown[] = Array.isArray(value) ? value : value != null ? [value] : []
    for (const item of list) {
      const buf =
        item instanceof ArrayBuffer
          ? new Uint8Array(item)
          : item instanceof Uint8Array
            ? item
            : null
      const parsed = buf ? parseOneOffMember(buf) : null
      if (parsed) members.push(parsed)
    }
  } catch {
    // best-effort; the name alone is still useful
  }
  return { name, members }
}

type TaskObj = IPSTTask & { taskStartDate: Date | null; taskDueDate: Date | null }
function asTask(m: IPSTMessage): TaskObj {
  const x = m as unknown as Record<string, unknown>
  return new (PSTTask as unknown as new (...a: unknown[]) => TaskObj)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}

function buildTaskCard(m: IPSTMessage): TaskCard {
  const t = asTask(m)
  const statuses = ['Not started', 'In progress', 'Completed', 'Waiting on someone else', 'Deferred']
  const pc = safe(() => t.percentComplete, 0)
  const pr = safe(() => m.priority, 0)
  return {
    status: statuses[safe(() => t.taskStatus, 0)] || '',
    percentComplete: Math.round(pc <= 1 ? pc * 100 : pc),
    startDate: safe(() => t.taskStartDate, null)?.getTime() ?? null,
    dueDate: safe(() => t.taskDueDate, null)?.getTime() ?? null,
    dateCompleted: safe(() => t.taskDateCompleted, null)?.getTime() ?? null,
    owner: safeStr(() => t.taskOwner),
    priority: pr === 1 ? 'high' : pr === -1 ? 'low' : null,
  }
}

// Read a named MAPI property value via the message internals (named id under set index).
function readNamedValue(m: IPSTMessage, namedId: number, setIdx: number): unknown {
  try {
    const x = m as unknown as {
      _rootProvider: { getNameToIdMapItem: (key: number, idx: number) => number }
      _propertyFinder: { findByKey: (key: number) => { value: unknown } | undefined }
    }
    const tag = x._rootProvider.getNameToIdMapItem(namedId, setIdx)
    return tag !== -1 ? x._propertyFinder.findByKey(tag)?.value : undefined
  } catch {
    return undefined
  }
}

function buildJournalCard(m: IPSTMessage): JournalCard {
  // PSETID_Log (6): LogTypeDesc 34578, LogType 34560, LogStart 34566, LogDuration 34567.
  const entryType = cleanStr(
    String(readNamedValue(m, 34578, 6) ?? readNamedValue(m, 34560, 6) ?? ''),
  )
  const startVal = readNamedValue(m, 34566, 6)
  const start =
    startVal instanceof Date ? startVal.getTime() : typeof startVal === 'number' ? startVal : null
  const durVal = readNamedValue(m, 34567, 6)
  return { entryType, start, durationMinutes: typeof durVal === 'number' ? durVal : 0 }
}

async function buildMessageContent(
  m: IPSTMessage,
  msgId: string,
  entry: SourceEntry,
): Promise<MessageContent> {
  const recipients = await safeAsync(() => m.getRecipients(), [])
  const to: RecipientInfo[] = []
  const cc: RecipientInfo[] = []
  const bcc: RecipientInfo[] = []
  for (const r of recipients) {
    const info: RecipientInfo = {
      name: safe(() => r.displayName, ''),
      email: safe(() => r.smtpAddress, '') || safe(() => r.emailAddress, ''),
    }
    const type = safe(() => r.recipientType, Consts.MAPI_TO)
    if (type === Consts.MAPI_CC) cc.push(info)
    else if (type === Consts.MAPI_BCC) bcc.push(info)
    else to.push(info)
  }

  const attachmentHandles = await safeAsync(() => m.getAttachments(), [])
  entry.attachments.set(msgId, attachmentHandles)
  const inlineImages: InlineImage[] = []
  const attachments: AttachmentMeta[] = []
  attachmentHandles.forEach((a, index) => {
    const method = safe(() => a.attachMethod, 0)
    const isEmbedded = method === Consts.ATTACH_EMBEDDED_MSG
    const cid = cleanCid(safe(() => a.contentId, ''))
    const isInline = !!cid || safe(() => a.isAttachmentInvisibleInHtml, false)
    const name = attachmentName(a, index, isEmbedded)
    attachments.push({
      index,
      name,
      size: safe(() => a.filesize, 0) || safe(() => a.size, 0),
      mime: safe(() => a.mimeTag, ''),
      isInline,
      cid: cid || undefined,
      isEmbeddedMessage: isEmbedded,
    })

    if (cid && method === Consts.ATTACH_BY_VALUE) {
      const data = safe(() => a.fileData, undefined)
      if (data && data.byteLength > 0) {
        inlineImages.push({
          cid,
          mime: safe(() => a.mimeTag, '') || guessMimeFromName(name) || 'application/octet-stream',
          data,
        })
      }
    }
  })

  // Unpack a winmail.dat (TNEF) into its real attachments + plain-text body.
  let tnefBody: string | null = null
  const tnefIdx = attachmentHandles.findIndex((a) => {
    const n = (safe(() => a.longFilename, '') || safe(() => a.filename, '')).toLowerCase()
    return n === 'winmail.dat' || safe(() => a.mimeTag, '').toLowerCase() === 'application/ms-tnef'
  })
  if (tnefIdx !== -1) {
    const raw = safe(() => attachmentHandles[tnefIdx].fileData, undefined)
    const parsed = raw && raw.byteLength > 0 ? parseTnef(raw) : null
    if (parsed && (parsed.attachments.length > 0 || parsed.bodyText)) {
      tnefBody = parsed.bodyText
      entry.tnef.set(msgId, parsed.attachments)
      // Replace the opaque winmail.dat chip with the recovered files.
      const at = attachments.findIndex((x) => x.index === tnefIdx)
      if (at !== -1) attachments.splice(at, 1)
      parsed.attachments.forEach((t, i) => {
        attachments.push({
          index: -1 - i,
          name: t.name || `attachment-${i + 1}`,
          size: t.data.byteLength,
          mime: t.mime,
          isInline: false,
          isEmbeddedMessage: false,
        })
      })
    }
  }

  const bodies = extractBodies(m)
  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)
  const kind = itemKindOf(safe(() => m.messageClass, ''))
  const importanceVal = safe(() => m.importance, 1)
  const sensitivityVal = safe(() => m.sensitivity, 0)
  const flagRaw = safe(() => m.getProperty(0x1090)?.value, 0)
  const flagVal = typeof flagRaw === 'number' ? flagRaw : 0

  // S/MIME: when the email body is empty, recover it from a smime.p7m (opaque
  // signed). Encrypted messages cannot be read without the recipient's key.
  let smimeBody: { html: string | null; text: string | null } | null = null
  let smimeNote: string | null = null
  if (!bodies.html && !bodies.text) {
    const p7mIdx = attachmentHandles.findIndex((a) => {
      const n = (safe(() => a.longFilename, '') || safe(() => a.filename, '')).toLowerCase()
      const mt = safe(() => a.mimeTag, '').toLowerCase()
      return n === 'smime.p7m' || mt === 'application/pkcs7-mime' || mt === 'application/x-pkcs7-mime'
    })
    if (p7mIdx !== -1) {
      const raw = safe(() => attachmentHandles[p7mIdx].fileData, undefined)
      if (raw && raw.byteLength > 0) {
        const res = await extractSmime(raw)
        if (res.kind === 'signed') {
          smimeBody = res.body
          const at = attachments.findIndex((x) => x.index === p7mIdx)
          if (at !== -1) attachments.splice(at, 1)
        } else if (res.kind === 'encrypted') {
          smimeNote =
            "This is an encrypted S/MIME message. It cannot be read without the recipient's private key."
        }
      }
    }
  }
  const finalHtml = bodies.html || smimeBody?.html || null
  const finalText = bodies.text || tnefBody || smimeBody?.text || smimeNote || null

  // Build the contact / dist-list cards up front so the view title can fall back
  // to their name (contacts often have no PR_SUBJECT), and the card body need not
  // repeat the name the header already shows. A .msg-backed message has no PST
  // named-property machinery, so its cards come straight from the parsed fields.
  const msgFields = msgFieldsOf(m)
  const contactCard =
    kind === 'contact'
      ? msgFields
        ? msgContactCard(msgFields, safe(() => m.subject, ''))
        : safe(() => buildContactCard(m), undefined)
      : undefined
  const distlistCard = kind === 'distlist' ? safe(() => buildDistListCard(m), undefined) : undefined

  return {
    itemKind: kind,
    categories: safe(() => m.colorCategories, [])
      .map((s) => cleanStr(s))
      .filter(Boolean),
    importance: importanceVal === 2 ? 'high' : importanceVal === 0 ? 'low' : null,
    sensitivity:
      sensitivityVal === 1
        ? 'personal'
        : sensitivityVal === 2
          ? 'private'
          : sensitivityVal === 3
            ? 'confidential'
            : null,
    followUp: flagVal === 2 ? 'flagged' : flagVal === 1 ? 'complete' : null,
    subject:
      safe(() => m.subject, '') || contactCard?.fullName || distlistCard?.name || '(no subject)',
    fromName: safe(() => m.senderName, '') || safe(() => m.sentRepresentingName, ''),
    fromEmail:
      safe(() => m.senderEmailAddress, '') || safe(() => m.sentRepresentingEmailAddress, ''),
    to,
    cc,
    bcc,
    date: (delivery ?? submit)?.getTime() ?? null,
    html: finalHtml,
    text: finalText,
    inlineImages,
    attachments,
    headers: safe(() => m.transportMessageHeaders, ''),
    contact: contactCard,
    appointment:
      kind === 'appointment'
        ? msgFields
          ? msgAppointmentCard(
              msgFields,
              safeStr(() => m.sentRepresentingName) || safeStr(() => m.senderName),
            )
          : safe(() => buildAppointmentCard(m), undefined)
        : undefined,
    distlist: distlistCard,
    task: kind === 'task' ? safe(() => buildTaskCard(m), undefined) : undefined,
    journal: kind === 'journal' ? safe(() => buildJournalCard(m), undefined) : undefined,
  }
}

const api = {
  async ping(): Promise<'pong'> {
    return 'pong'
  },

  /** Open a PST/OST File, walk its folder tree, and return a serializable
   *  index. `persist` is true only when this is a real single PST/OST opened
   *  via a path that yielded a FileSystemFileHandle (see `src/lib/files.ts`'s
   *  `sourceKey`/`isPersistableName`) — it gates the searchDocs cache and the
   *  folderTree cache alike.
   *
   *  On a persistable source, a fingerprint-matching folder tree cached by a
   *  prior session (see the `folderTree` store in `src/lib/idb.ts`) is handed
   *  to `onCachedIndex` as soon as it's read, well before the real walk below
   *  finishes — the caller can render it immediately instead of showing a
   *  blank folder pane. This never skips the real walk: the live folder
   *  handles it populates on `entry.folders` are still required for every
   *  other call, so the resolved return value is always the fresh result,
   *  and a miss (first-ever open, or a cache written before this feature
   *  existed) just means no early callback. */
  async openSource(
    sourceId: string,
    file: File,
    persist: boolean,
    onCachedIndex?: (index: SourceIndex) => void,
  ): Promise<SourceIndex> {
    await evictSource(sourceId)
    forgottenIds.delete(sourceId)

    const fp = fingerprint(file)
    if (persist) {
      void readFolderTreeCache<SourceIndex>(sourceId, fp, TREE_VERSION)
        .then((cached) => {
          if (cached) onCachedIndex?.(cached)
        })
        .catch(() => {})
    }

    const pstFile = await openPst(makeReader(file))
    let markReady!: () => void
    const readyPromise = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const entry: SourceEntry = {
      file: pstFile,
      folders: new Map(),
      messages: new Map(),
      attachments: new Map(),
      searchIds: new Set(),
      tnef: new Map(),
      folderLoads: new Map(),
      fingerprint: fp,
      persist,
      ready: readyPromise,
    }
    sources.set(sourceId, entry)

    // Walk the true root, then reduce it to the mailbox Outlook shows. Walking
    // from the root rather than straight from the IPM subtree costs a handful of
    // extra property reads for the plumbing subtrees, and buys the one thing
    // starting at the subtree cannot: the chance to keep a non-IPM sibling that
    // holds mail (see `reduceToMailbox`).
    const subtreeId = await findIpmSubtreeId(pstFile)
    const rawTree = await buildFolderTree(await pstFile.getRootFolder(), entry)
    const rootNode = reduceToMailbox(rawTree, subtreeId)
    if (import.meta.env.DEV) {
      // Which store root won, and what it was picked out of — the two OST bugs
      // here (an extra root level, and a rival empty public-folder subtree) were
      // both invisible from the folder pane alone.
      console.info(
        `[pst] ${file.name}: 0x35E0 subtree id ${subtreeId ?? '(none)'};`,
        `walked "${rawTree.name}" [${rawTree.children.map((c) => c.name).join(', ')}];`,
        `showing "${rootNode.name}" with ${rootNode.children.length} top-level folders,`,
        `${countMessages(rootNode)} messages`,
      )
    }
    // The walk registers a handle for every folder it touched, plumbing included,
    // and `indexSource` enumerates that map rather than the tree — so leaving the
    // dropped folders behind would index folders the user cannot see and let a
    // search hit report a folder id absent from the tree.
    const displayed = collectFolderIds(rootNode)
    for (const id of [...entry.folders.keys()]) {
      if (!displayed.has(id)) entry.folders.delete(id)
    }
    markReady()

    const totalMessages = countMessages(rootNode)

    // Prefer the mailbox's own name when it is meaningful, but Outlook gives
    // every personal data file a generic name ("Personal Folders" etc.); in that
    // case the filename the user chose is the better label.
    const storeName = await safeAsync(
      async () => (await pstFile.getMessageStore()).displayName,
      '',
    )
    // Name of the root we actually walked — never getTopOfOutlookDataFile()'s,
    // which on an OST is an unrelated folder (see `findIpmSubtreeId`).
    const topName = rootNode.name
    const ownerName = [storeName, topName].find((n) => n && !isGenericStoreName(n)) ?? ''

    const result: SourceIndex = {
      rootFolder: rootNode,
      totalMessages,
      suggestedLabel: ownerName || prettyFileName(file.name),
    }

    if (persist) {
      void safeAsync(() => writeFolderTreeCache(sourceId, fp, TREE_VERSION, result), undefined)
    }

    return result
  },

  /**
   * Open one or more standalone message files (.msg or .eml, told apart by the
   * CFB magic rather than the extension) as a single synthetic mailbox with
   * one "Messages" folder. Unparseable files are skipped and surfaced through
   * the folder's unreadable count; throws only when nothing could be read.
   */
  async openMsgSource(sourceId: string, files: File[]): Promise<SourceIndex> {
    await evictSource(sourceId)
    forgottenIds.delete(sourceId)

    const messages: IPSTMessage[] = []
    let failed = 0
    for (let i = 0; i < files.length; i++) {
      try {
        const data = await files[i].arrayBuffer()
        messages.push(isCfbFile(data) ? parseMsg(data, `msg${i}`) : await parseEml(data, `msg${i}`))
      } catch {
        failed++
      }
    }
    if (messages.length === 0) {
      throw new Error(
        files.length === 1
          ? 'The file could not be parsed as an email message.'
          : 'None of the files could be parsed as email messages.',
      )
    }

    const entry: SourceEntry = {
      file: { close: async () => {} } as unknown as IPSTFile,
      folders: new Map(),
      messages: new Map(),
      attachments: new Map(),
      searchIds: new Set(),
      tnef: new Map(),
      folderLoads: new Map(),
      // .msg/.eml batches never persist: no single stable file identity to
      // key a searchDocs cache row by, so the fingerprint is never consulted.
      fingerprint: { size: 0, lastModified: 0 },
      persist: false,
      // Folders are built synchronously below, not via `buildFolderTree`.
      ready: Promise.resolve(),
    }

    // Standalone files carry no folder tree, so bucket items into Outlook-like
    // folders by item type (a saved contact lands under Contacts, and so on).
    const BUCKETS: Record<ReturnType<typeof itemKindOf>, { id: string; name: string; cls: string }> = {
      email: { id: 'msgfolder', name: 'Messages', cls: 'IPF.Note' },
      contact: { id: 'msgcontacts', name: 'Contacts', cls: 'IPF.Contact' },
      distlist: { id: 'msgcontacts', name: 'Contacts', cls: 'IPF.Contact' },
      appointment: { id: 'msgcalendar', name: 'Calendar', cls: 'IPF.Appointment' },
      task: { id: 'msgtasks', name: 'Tasks', cls: 'IPF.Task' },
      note: { id: 'msgnotes', name: 'Notes', cls: 'IPF.StickyNote' },
      journal: { id: 'msgjournal', name: 'Journal', cls: 'IPF.Journal' },
    }
    const grouped = new Map<string, { name: string; cls: string; items: IPSTMessage[] }>()
    for (const m of messages) {
      const b = BUCKETS[itemKindOf(safe(() => m.messageClass, ''))]
      const g = grouped.get(b.id) ?? { name: b.name, cls: b.cls, items: [] }
      g.items.push(m)
      grouped.set(b.id, g)
    }

    const children: FolderNode[] = []
    for (const id of ['msgfolder', 'msgcalendar', 'msgcontacts', 'msgtasks', 'msgnotes', 'msgjournal']) {
      const g = grouped.get(id)
      if (!g) continue
      entry.folders.set(id, createMsgFolder(id, g.name, g.items))
      children.push({
        id,
        name: g.name,
        containerClass: g.cls,
        messageCount: g.items.length,
        children: [],
      })
    }
    if (failed && children.length) entry.extraUnreadable = new Map([[children[0].id, failed]])
    sources.set(sourceId, entry)

    const label =
      files.length === 1 ? prettyFileName(files[0].name) : `Messages (${files.length})`
    return {
      rootFolder: {
        id: 'msgstore',
        name: label,
        containerClass: '',
        messageCount: 0,
        children,
      },
      totalMessages: messages.length,
      suggestedLabel: label,
    }
  },

  /** Load metadata for every message in one folder, reporting any that could
   *  not be read (so a damaged file shows what survives, plus a salvage count). */
  async getFolderMessages(sourceId: string, folderId: string): Promise<FolderMessages> {
    const entry = sources.get(sourceId)
    if (!entry) return { messages: [], unreadable: 0 }
    await entry.ready
    return loadFolderMessages(entry, folderId)
  },

  /** Fetch full body + headers + inline images + attachment list for one message.
   *
   *  `folderId` is optional but worth passing: message handles only exist once
   *  their folder has been enumerated, and with a warm search-index cache no
   *  folder is enumerated up front. Given the folder, an id that isn't resident
   *  yet (a search hit in a folder the user never opened) loads that folder
   *  first instead of coming back empty. */
  async getMessageContent(
    sourceId: string,
    messageId: string,
    folderId?: string,
  ): Promise<MessageContent | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    let m = entry.messages.get(messageId)
    if (!m && folderId) {
      await entry.ready
      await loadFolderMessages(entry, folderId)
      m = entry.messages.get(messageId)
    }
    if (!m) return null
    return buildMessageContent(m, messageId, entry)
  },

  /** Fetch raw bytes for one attachment (transferred, zero-copy). */
  async getAttachmentData(
    sourceId: string,
    messageId: string,
    index: number,
  ): Promise<AttachmentData | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    // Negative index = an attachment recovered from a winmail.dat (TNEF).
    if (index < 0) {
      const t = entry.tnef.get(messageId)?.[-1 - index]
      if (!t) return null
      const tCopy = t.data.slice(0)
      return Comlink.transfer({ name: t.name, mime: t.mime, data: tCopy }, [tCopy])
    }
    const list = entry.attachments.get(messageId)
    const a = list?.[index]
    if (!a) return null
    const data = safe(() => a.fileData, undefined)
    if (!data || data.byteLength === 0) return null
    // Copy so transferring (detaching) doesn't break the library's cached buffer.
    const copy = data.slice(0)
    const result: AttachmentData = {
      name: attachmentName(a, index, false),
      mime: safe(() => a.mimeTag, ''),
      data: copy,
    }
    return Comlink.transfer(result, [copy])
  },

  /** Open an embedded (nested) email attachment and return its content. */
  async getEmbeddedMessageContent(
    sourceId: string,
    parentMessageId: string,
    index: number,
  ): Promise<EmbeddedMessageResult | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    const list = entry.attachments.get(parentMessageId)
    const a = list?.[index]
    if (!a) return null
    const embedded = await safeAsync(() => a.getEmbeddedPSTMessage(), null)
    if (!embedded) return null
    const embId = `${parentMessageId}/emb${index}`
    entry.messages.set(embId, embedded)
    const content = await buildMessageContent(embedded, embId, entry)
    return { id: embId, content }
  },

  /** Parse a .msg or .eml file attached as a regular file (not embedded) and
   *  return its content, registered like an embedded message so its own
   *  attachments and nested messages resolve. The format is told apart by the
   *  CFB magic. Negative index = a TNEF-recovered attachment. */
  async openAttachedEmail(
    sourceId: string,
    parentMessageId: string,
    index: number,
  ): Promise<EmbeddedMessageResult | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    let raw: ArrayBuffer | undefined
    if (index < 0) {
      raw = entry.tnef.get(parentMessageId)?.[-1 - index]?.data
    } else {
      const a = entry.attachments.get(parentMessageId)?.[index]
      raw = a ? safe(() => a.fileData, undefined) : undefined
    }
    if (!raw || raw.byteLength === 0) return null
    const embId = `${parentMessageId}/msg${index}`
    let msg: IPSTMessage
    try {
      msg = isCfbFile(raw) ? parseMsg(raw, embId) : await parseEml(raw, embId)
    } catch {
      return null
    }
    entry.messages.set(embId, msg)
    const content = await buildMessageContent(msg, embId, entry)
    return { id: embId, content }
  },

  /**
   * Build the full-text search index for a source in the background.
   * Walks every folder, indexing subject/from/to/body/attachment-names, and
   * warms the message + attachment caches as a side effect.
   *
   * For a persistable source, first tries a cached index written by a prior
   * session (see the `searchDocs` store in `src/lib/idb.ts`). A hit skips the
   * walk entirely — no folder is enumerated, so reopening a remembered mailbox
   * costs only the b-tree load and the tree walk. Message handles are then
   * minted lazily by `loadFolderMessages`, which `getMessageContent` calls for
   * itself when a search hit lands in a folder the user never opened.
   */
  async indexSource(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const entry = sources.get(sourceId)
    if (!entry) return

    let total = 0
    for (const folder of entry.folders.values()) total += safe(() => folder.contentCount, 0)
    let done = 0

    if (entry.persist) {
      const cached = await safeAsync(
        () => readChunkedCache<SearchDoc>(sourceId, entry.fingerprint, DOCS_VERSION),
        null,
      )
      if (cached) {
        if (!sources.has(sourceId)) return // source removed mid-restore
        // Defensive de-dupe even after the evict-before-reopen fix above:
        // MiniSearch rejects re-adding an id already present.
        const fresh = cached.filter((d) => !searchIndex.has(d.id))
        if (fresh.length) searchIndex.addAll(fresh)
        for (const d of cached) {
          searchDocs.set(d.id, d)
          entry.searchIds.add(d.id)
        }
        onProgress?.(total, total)
        return
      }
    }

    // Miss (no cache, not persistable, or a fingerprint/version mismatch):
    // walk every folder, accumulating every doc for the cache write.
    const allDocs: SearchDoc[] = []
    for (const folderId of [...entry.folders.keys()]) {
      if (!sources.has(sourceId)) return // source removed mid-index
      // Share the memoised enumeration, so a folder the user has already
      // opened — or opens next — is never parsed a second time.
      const { messages: metas } = await loadFolderMessages(entry, folderId)
      const items = metas
        .map((meta) => ({ msgId: meta.id, m: entry.messages.get(meta.id) }))
        .filter((it): it is { msgId: string; m: IPSTMessage } => it.m !== undefined)
      // Bodies are the expensive part; overlapping them is what keeps the
      // indexer from being a long serial chain of one-block reads.
      const docs = (
        await mapLimit(items.length, INDEX_CONCURRENCY, async (i) => {
          const { msgId, m } = items[i]
          const id = `${sourceId}:${msgId}`
          done++
          if (searchIndex.has(id)) return null
          return safeAsync(() => buildSearchDoc(sourceId, folderId, msgId, m, entry), null)
        })
      ).filter((d): d is SearchDoc => d !== null)
      for (const doc of docs) {
        searchDocs.set(doc.id, doc)
        entry.searchIds.add(doc.id)
      }
      // If the source was closed while reading this folder, drop what we staged
      // instead of leaving orphaned docs in the shared search index.
      if (!sources.has(sourceId)) {
        for (const d of docs) searchDocs.delete(d.id)
        return
      }
      if (docs.length) searchIndex.addAll(docs)
      allDocs.push(...docs)
      onProgress?.(done, total)
    }
    onProgress?.(done, total)

    if (entry.persist) {
      // Re-check right before the write, not just at the top of this method:
      // "Remove mailbox" (forgetPersisted) may have evicted this source and
      // marked it forgotten while the walk above was running. Skipping the
      // write here is what keeps a fast in-flight index from resurrecting a
      // cache the user just asked to delete.
      if (sources.has(sourceId) && !forgottenIds.has(sourceId)) {
        await safeAsync(
          () => writeChunkedCache(sourceId, allDocs, entry.fingerprint, DOCS_VERSION),
          undefined,
        )
      }
    }
  },

  /** Fuzzy full-text search across all indexed sources.
   *
   *  Text in double quotes is a phrase: it must appear intact in the message,
   *  never merely as its words scattered about. The index only knows single
   *  words, so it narrows to mail holding all of them and `containsPhrases`
   *  then checks the doc text itself.
   *
   *  With no query text but at least one active filter, browses by filter alone
   *  ("every mail in this folder with an attachment") — scanning the docs
   *  instead of the term index, newest first, since there's nothing to rank by.
   */
  async search(query: string, limit = 100, filters?: SearchFilters): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) {
      if (!filters || !hasActiveFilters(filters)) return []
      const hits: SearchHit[] = []
      for (const doc of searchDocs.values()) {
        if (matchesSearchFilters(doc, filters)) hits.push(docToHit(doc, 0))
      }
      hits.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
      return hits.slice(0, limit)
    }
    const { phrases, words } = parseQuery(q)
    // Typed text that is all punctuation, or an empty pair of quotes, asks for
    // nothing findable — don't let it fall through to the doc scan below and
    // return the whole mailbox.
    if (!phrases.length && !words.length) return []
    const phraseRes = phrases.map(phraseRegExp)
    const passes = (id: string): boolean => {
      const doc = searchDocs.get(id)
      if (!doc) return !phraseRes.length && !(filters && hasActiveFilters(filters))
      if (phraseRes.length && !containsPhrases(doc, phraseRes)) return false
      return !filters || !hasActiveFilters(filters) || matchesSearchFilters(doc, filters)
    }
    // Words spelled out inside quotes are meant literally, so no fuzziness and
    // no prefix expansion for them. Terms with a digit (numbers, ids, reference
    // codes) are specific too, so match them exactly. Fuzzy matching on an id
    // finds near-misses that are rarely wanted and, worse, do not contain the
    // typed text so nothing highlights. Plain words stay fuzzy for typo
    // tolerance.
    const exact = new Set(phrases.flatMap((p) => queryWords(p, 1)))
    const indexQuery = [...phrases, ...words].join(' ')
    // A query of nothing but punctuation in quotes (`"++"`) leaves the index
    // with no term to look up; scan the docs so the phrase can still be found.
    if (!exact.size && !words.length) {
      const hits: SearchHit[] = []
      for (const [id, doc] of searchDocs) {
        if (passes(id)) hits.push(docToHit(doc, 0))
      }
      hits.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
      return hits.slice(0, limit)
    }
    const results = searchIndex.search(indexQuery, {
      combineWith: 'AND',
      fuzzy: (term) => (exact.has(term) || /\d/.test(term) ? false : 0.2),
      prefix: (term) => !exact.has(term),
    })
    // Filter before slicing to the limit, so a narrow filter doesn't get starved
    // by unrelated matches that happened to score higher.
    const matched = results.filter((r) => passes(r.id as string))
    return matched.slice(0, limit).map((r) => ({
      sourceId: r.sourceId as string,
      messageId: r.messageId as string,
      folderId: r.folderId as string,
      subject: r.subject as string,
      from: r.from as string,
      date: (r.date as number | null) ?? null,
      hasAttachments: Boolean(r.hasAttachments),
      score: r.score,
    }))
  },

  /** Release a source, its PST handle, and its search-index entries. Never
   *  touches the on-disk searchDocs cache — closing a mailbox (e.g. tab
   *  close) must not imply deleting it; only explicit removal does. */
  async closeSource(sourceId: string): Promise<void> {
    await evictSource(sourceId)
  },

  /** Explicit "forget": deletes the persisted searchDocs cache for a source
   *  ("Remove mailbox" / "Forget" in the UI), distinct from `closeSource`.
   *  Synchronously marks the id forgotten before anything async, so a
   *  write already in flight from `indexSource` can't recreate the cache
   *  right after this deletes it. */
  async forgetPersisted(sourceId: string): Promise<void> {
    forgottenIds.add(sourceId)
    await Promise.all([
      safeAsync(() => deleteChunkedCache(sourceId), undefined),
      safeAsync(() => deleteFolderTreeCache(sourceId), undefined),
    ])
  },
}

export type PstWorkerApi = typeof api

Comlink.expose(api)
