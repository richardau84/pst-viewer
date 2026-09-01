import { create } from 'zustand'
import * as Comlink from 'comlink'
import { pst } from '../worker/client'
import { scanZipForPsts } from '../lib/zip'
import { buildPrintDocument, printHtmlDocument } from '../lib/printExport'
import { buildEml, downloadBlob, emlFilename, type EmlAttachment } from '../lib/emlExport'
import { fingerprint, sourceKey } from '../lib/files'
import {
  clearAllStores,
  deleteHandleRecord,
  getAllHandleRecords,
  putHandleRecord,
  updateHandleRecord,
  type PersistedHandleRecord,
} from '../lib/idb'
import type {
  FolderNode,
  MessageContent,
  MessageMeta,
  SearchFilters,
  SearchHit,
  SearchSortField,
  SortDir,
  SortField,
  SourceIndex,
} from '../types'

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  dateFrom: null,
  dateTo: null,
  folder: null,
  from: '',
  to: '',
  hasAttachments: false,
}

export type SourceStatus = 'parsing' | 'ready' | 'error'

export interface Source {
  id: string
  fileName: string
  size: number
  label: string
  status: SourceStatus
  error?: string
  /** Raw low-level parser error behind a friendly `error`, shown on hover. */
  errorDetail?: string
  index?: SourceIndex
  indexProgress?: { done: number; total: number }
  indexed?: boolean
}

/** State of one remembered mailbox's reconnect attempt. `'idle'` means no
 *  attempt is in flight (either never tried this session, or it already
 *  finished and the mailbox is open). */
export type ReconnectState = 'idle' | 'checking' | 'needs-permission' | 'opening' | 'error'

interface Selection {
  sourceId: string | null
  folderId: string | null
  messageId: string | null
}

interface AppState {
  sources: Source[]
  selection: Selection
  messages: MessageMeta[]
  /** Count of messages in the open folder that could not be read (file damage). */
  messagesUnreadable: number
  messagesLoading: boolean
  messageContent: MessageContent | null
  contentLoading: boolean
  expanded: Record<string, boolean>

  sortBy: SortField
  sortDir: SortDir

  searchQuery: string
  searchResults: SearchHit[]
  searching: boolean
  searchFilters: SearchFilters
  searchSortBy: SearchSortField
  searchSortDir: SortDir

  /** Messages picked for PDF export, keyed `${sourceId}:${messageId}`. */
  exportSel: Record<string, { sourceId: string; messageId: string; folderId?: string }>
  exporting: boolean

  /** Persistable mailboxes remembered from a previous session (Chromium
   *  File System Access only; always empty elsewhere). Newest-opened first. */
  remembered: PersistedHandleRecord[]
  reconnecting: Record<string, ReconnectState>
  /** e.g. "File not found — it may have moved or been deleted." keyed by id. */
  reconnectError: Record<string, string>

  /** Persisted panel widths (px). */
  navWidth: number
  listWidth: number
  setNavWidth: (w: number) => void
  setListWidth: (w: number) => void
  addFiles: (files: File[], handles?: (FileSystemFileHandle | undefined)[]) => void
  removeSource: (id: string) => void
  clearSources: () => void
  renameSource: (id: string, label: string) => void
  toggleFolder: (sourceId: string, folderId: string) => void
  selectFolder: (sourceId: string, folderId: string) => void
  selectMessage: (messageId: string | null) => void
  setSort: (sortBy: SortField, sortDir: SortDir) => void

  setSearchQuery: (q: string) => void
  setSearchFilters: (filters: SearchFilters) => void
  setSearchSort: (searchSortBy: SearchSortField, searchSortDir: SortDir) => void
  runSearch: () => void
  clearSearch: () => void
  openHit: (hit: SearchHit) => void

  toggleExport: (sourceId: string, messageId: string, folderId?: string) => void
  clearExport: () => void
  exportSelected: (direction?: 'asc' | 'desc') => void
  exportSingle: (sourceId: string, messageId: string) => void
  exportEml: (sourceId: string, messageId: string) => void

  /** Read every remembered `handles` row. Called once at boot; also re-run
   *  after writing/renaming/forgetting a row to keep the list in sync. */
  loadRemembered: () => Promise<void>
  /** Silent path: `queryPermission` only, never prompts. Used both for the
   *  boot-time restore-set walk and safe to call speculatively otherwise. */
  reconnect: (id: string) => Promise<void>
  /** Click-only path: the click *is* the user gesture, so this calls
   *  `requestPermission` (which needs one) directly. */
  grantAndReconnect: (id: string) => Promise<void>
  /** Removes the remembered row and its cached search index, without
   *  touching a currently-open session for that id, if any. */
  forgetRemembered: (id: string) => void
  /** Wipes every row in both IndexedDB stores unconditionally — an always-
   *  available "erase everything this app has cached" escape hatch. */
  clearAllPersisted: () => void
}

let counter = 0
const uid = () => `s${++counter}-${Date.now().toString(36)}`
const stripExt = (n: string) => n.replace(/\.[^.]+$/, '')
const fkey = (sourceId: string, folderId: string) => `${sourceId}:${folderId}`
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Most remembered mailboxes anyone will realistically want back; evicting
 *  beyond this also deletes the evicted mailbox's cached search index. */
const HANDLES_CAP = 20

const PST_OPEN_FAIL_MESSAGE =
  'This file could not be opened as a mailbox. It may be corrupt, incomplete, ' +
  'or not a PST/OST. If you know it is a mailbox, repair it first with Microsoft’s ' +
  'Inbox Repair Tool (scanpst.exe) and open the repaired copy.'

const NAV_W_KEY = 'pstviewer.navWidth'
const LIST_W_KEY = 'pstviewer.listWidth'
function readNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key)
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? n : def
  } catch {
    return def
  }
}
function writeNum(key: string, n: number) {
  try {
    localStorage.setItem(key, String(Math.round(n)))
  } catch {
    /* ignore */
  }
}

/** A shallow copy of `obj` without `key`, or `obj` itself when `key` is
 *  already absent (avoids a pointless state-object churn). */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj
  const next = { ...obj }
  delete next[key]
  return next
}

function compareBy(a: MessageMeta, b: MessageMeta, field: SortField): number {
  switch (field) {
    case 'date':
      return (a.date ?? 0) - (b.date ?? 0)
    case 'subject':
      return a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' })
    case 'sender':
      return (a.fromName || a.fromEmail).localeCompare(b.fromName || b.fromEmail, undefined, {
        sensitivity: 'base',
      })
  }
}

function sortMessages(messages: MessageMeta[], field: SortField, dir: SortDir): MessageMeta[] {
  const mult = dir === 'asc' ? 1 : -1
  return [...messages].sort((a, b) => mult * compareBy(a, b, field))
}

function compareHitBy(a: SearchHit, b: SearchHit, field: SearchSortField): number {
  switch (field) {
    case 'relevance':
      return a.score - b.score
    case 'date':
      return (a.date ?? 0) - (b.date ?? 0)
    case 'subject':
      return a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' })
    case 'sender':
      return a.from.localeCompare(b.from, undefined, { sensitivity: 'base' })
  }
}

function sortHits(hits: SearchHit[], field: SearchSortField, dir: SortDir): SearchHit[] {
  const mult = dir === 'asc' ? 1 : -1
  return [...hits].sort((a, b) => mult * compareHitBy(a, b, field))
}

function firstFolderWithMessages(node: FolderNode): string | null {
  for (const child of node.children) {
    if (child.messageCount > 0) return child.id
    const deeper = firstFolderWithMessages(child)
    if (deeper) return deeper
  }
  return null
}

function dedupeLabel(label: string, fileName: string, sources: Source[], selfId: string): string {
  const taken = new Set(sources.filter((s) => s.id !== selfId).map((s) => s.label))
  if (!taken.has(label)) return label
  const withFile = `${label} (${stripExt(fileName)})`
  if (!taken.has(withFile)) return withFile
  let i = 2
  while (taken.has(`${withFile} (${i})`)) i++
  return `${withFile} (${i})`
}

/** The "no mailboxes loaded" state: resets all per-session state (but not
 *  persisted panel widths, remembered mailboxes, or worker status). */
function freshState(): Partial<AppState> {
  return {
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesUnreadable: 0,
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    searchQuery: '',
    searchResults: [],
    searching: false,
    searchFilters: EMPTY_SEARCH_FILTERS,
    exportSel: {},
    exporting: false,
  }
}

export const useApp = create<AppState>((set, get) => {
  /** The most recent folder listing, settled or not. Background indexing waits
   *  on it so the mailbox the user is staring at wins the read queue: both run
   *  in the same worker over the same file, and a full-text walk started at
   *  open time otherwise competes with the first folder the user sees. */
  let pendingFolderLoad: Promise<unknown> = Promise.resolve()

  /** Register a source and run the shared open -> index flow. This is the
   *  single real entry point for turning an id into a live `Source`, reached
   *  from a fresh drop, a boot-time silent restore, and a manual Reconnect
   *  click alike — so the duplicate-open guard below has to live here, not
   *  in any one caller, to actually bound all three at once. */
  const registerAndOpen = (
    id: string,
    seed: { fileName: string; size: number; label: string },
    open: (id: string, onCached: (index: SourceIndex) => void) => Promise<SourceIndex>,
    failMessage: string,
    persist?: { file: File; handle: FileSystemFileHandle },
  ): Promise<void> => {
    // Ids are stable (identity-derived) once persistable, so the same id is
    // reachable from two entry points at once (boot auto-reconnect racing a
    // manual re-drop/click) — without this guard that mints two `Source`s.
    if (get().sources.some((src) => src.id === id)) return Promise.resolve()

    const source: Source = { id, ...seed, status: 'parsing' }
    set((s) => ({ sources: [...s.sources, source] }))

    // Fires early with a cached folder tree (see `pst.openSource`), well
    // before `open()` below resolves with the authoritative one — lets the
    // folder pane render immediately instead of sitting blank through the
    // real re-parse. Only applies while still parsing and nothing has
    // landed yet, so it can never clobber the real result with stale data.
    const onCached = (index: SourceIndex) => {
      set((s) => ({
        sources: s.sources.map((src) =>
          src.id === id && src.status === 'parsing' && !src.index
            ? {
                ...src,
                index,
                label: dedupeLabel(index.suggestedLabel || src.label, seed.fileName, s.sources, id),
              }
            : src,
        ),
      }))
    }

    return open(id, onCached)
      .then((index) => {
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id
              ? {
                  ...src,
                  status: 'ready' as const,
                  index,
                  label: dedupeLabel(index.suggestedLabel || src.label, seed.fileName, s.sources, id),
                }
              : src,
          ),
          expanded: { ...s.expanded, [fkey(id, index.rootFolder.id)]: true },
        }))

        if (!get().selection.folderId) {
          const target = firstFolderWithMessages(index.rootFolder)
          if (target) get().selectFolder(id, target)
        }

        if (persist) {
          const now = Date.now()
          const existing = get().remembered.find((r) => r.id === id)
          const label = get().sources.find((s) => s.id === id)?.label ?? seed.label
          void putHandleRecord({
            id,
            fileName: persist.file.name,
            ...fingerprint(persist.file),
            label,
            addedAt: existing?.addedAt ?? now,
            lastOpenedAt: now,
            handle: persist.handle,
          })
            .then(() => get().loadRemembered())
            .then(() => enforceHandleCap())
            .catch(() => {
              /* best-effort: the mailbox is fully usable this session either way */
            })
        }

        // Background full-text indexing with progress. Deliberately not
        // awaited: callers only need to wait for the folder tree, not for
        // indexing (which can run concurrently once initiated). Held until the
        // first folder listing has landed, so opening a mailbox renders its
        // messages before the indexer starts reading the whole file.
        void pendingFolderLoad
          .catch(() => {})
          .then(() =>
            pst
              .indexSource(
                id,
                Comlink.proxy((done: number, total: number) => {
                  set((s) => ({
                    sources: s.sources.map((src) =>
                      src.id === id ? { ...src, indexProgress: { done, total } } : src,
                    ),
                  }))
                }),
              )
              .then(() => {
                set((s) => ({
                  sources: s.sources.map((src) =>
                    src.id === id ? { ...src, indexed: true } : src,
                  ),
                }))
              }),
          )
      })
      .catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err)
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id ? { ...src, status: 'error', error: failMessage, errorDetail: raw } : src,
          ),
        }))
      })
  }

  /** Deletes a remembered row's handle + cached search index, and drops any
   *  in-flight reconnect state for it. Does not touch a currently-open
   *  in-memory session for that id (closing and forgetting are separate). */
  const forgetRememberedImpl = async (id: string): Promise<void> => {
    set((s) => ({
      remembered: s.remembered.filter((r) => r.id !== id),
      reconnecting: omitKey(s.reconnecting, id),
      reconnectError: omitKey(s.reconnectError, id),
    }))
    await Promise.allSettled([deleteHandleRecord(id), pst.forgetPersisted(id)])
  }

  /** Cap the `handles` store size by evicting the least-recently-opened rows
   *  beyond `HANDLES_CAP`, deleting their cached search index too. */
  const enforceHandleCap = async (): Promise<void> => {
    const records = [...get().remembered].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    const overflow = records.slice(HANDLES_CAP)
    for (const rec of overflow) await forgetRememberedImpl(rec.id)
  }

  /** Shared by the silent boot-restore path (`reconnect`) and the click-only
   *  path (`grantAndReconnect`); `gesture` picks which permission call is
   *  legal to make (`requestPermission` needs a real user gesture behind it,
   *  `queryPermission` doesn't). Never rejects: every failure resolves into
   *  `reconnecting`/`reconnectError` state instead, so a caller doing a
   *  sequential `await` over several ids never gets thrown out of the loop. */
  const reconnectInternal = (id: string, gesture: boolean): Promise<void> => {
    if (get().sources.some((s) => s.id === id)) return Promise.resolve() // already open
    const record = get().remembered.find((r) => r.id === id)
    if (!record) return Promise.resolve()

    set((s) => ({
      reconnecting: { ...s.reconnecting, [id]: 'checking' },
      reconnectError: omitKey(s.reconnectError, id),
    }))

    const askPermission = () =>
      gesture
        ? record.handle.requestPermission({ mode: 'read' })
        : record.handle.queryPermission({ mode: 'read' })

    return askPermission()
      .then(async (state) => {
        if (state !== 'granted') {
          set((s) => ({ reconnecting: { ...s.reconnecting, [id]: 'needs-permission' } }))
          return
        }
        set((s) => ({ reconnecting: { ...s.reconnecting, [id]: 'opening' } }))
        const file = await record.handle.getFile()
        await registerAndOpen(
          id,
          { fileName: file.name, size: file.size, label: record.label },
          (openId, onCached) => pst.openSource(openId, file, true, Comlink.proxy(onCached)),
          PST_OPEN_FAIL_MESSAGE,
          { file, handle: record.handle },
        )
        set((s) => ({ reconnecting: { ...s.reconnecting, [id]: 'idle' } }))
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error && err.name === 'NotFoundError'
            ? 'File not found — it may have moved or been deleted.'
            : 'Could not reconnect to this file. It may be blocked or unavailable.'
        set((s) => ({
          reconnecting: { ...s.reconnecting, [id]: 'error' },
          reconnectError: { ...s.reconnectError, [id]: message },
        }))
      })
  }

  /** Open one PST/OST File, optionally with a captured file handle for
   *  cross-refresh persistence: the id is then derived from file identity
   *  (`sourceKey`) instead of a random per-session counter, so re-dropping
   *  the same file always lands on the same id and its existing cache,
   *  rather than minting a duplicate. */
  const startSource = (file: File, handle?: FileSystemFileHandle) => {
    const seed = { fileName: file.name, size: file.size, label: stripExt(file.name) }
    if (handle) {
      void sourceKey(file)
        .then((id) =>
          registerAndOpen(
            id,
            seed,
            (openId, onCached) => pst.openSource(openId, file, true, Comlink.proxy(onCached)),
            PST_OPEN_FAIL_MESSAGE,
            { file, handle },
          ),
        )
        .catch(() =>
          registerAndOpen(uid(), seed, (openId) => pst.openSource(openId, file, false), PST_OPEN_FAIL_MESSAGE),
        )
    } else {
      void registerAndOpen(
        uid(),
        seed,
        (openId) => pst.openSource(openId, file, false),
        PST_OPEN_FAIL_MESSAGE,
      )
    }
  }

  /** Open a batch of standalone .msg/.eml files as one synthetic mailbox.
   *  Never persistable: a batch has no single stable file identity. */
  const startMsgSource = (files: File[]) => {
    if (!files.length) return
    const exts = new Set(files.map((f) => (/\.eml$/i.test(f.name) ? '.eml' : '.msg')))
    const batchName = exts.size === 1 ? `${files.length} ${[...exts][0]} files` : `${files.length} message files`
    const seed =
      files.length === 1
        ? { fileName: files[0].name, size: files[0].size, label: stripExt(files[0].name) }
        : {
            fileName: batchName,
            size: files.reduce((n, f) => n + f.size, 0),
            label: 'Messages',
          }
    void registerAndOpen(
      uid(),
      seed,
      (id) => pst.openMsgSource(id, files),
      (files.length === 1
        ? 'This file could not be opened as an email message.'
        : 'None of these files could be opened as email messages.') +
        ' It may be corrupt, or not really an Outlook .msg / RFC822 .eml file.',
    )
  }

  /** Scan a zip for PST/OST files and open each one found. Zip-extracted
   *  files are synthetic in-memory Files (fflate), so never persistable. */
  const handleZip = (file: File) => {
    const scanId = uid()
    set((s) => ({
      sources: [
        ...s.sources,
        {
          id: scanId,
          fileName: file.name,
          size: file.size,
          label: `Scanning ${stripExt(file.name)}…`,
          status: 'parsing',
        },
      ],
    }))

    scanZipForPsts(file)
      .then(({ psts, msgs, otherFiles }) => {
        set((s) => ({ sources: s.sources.filter((x) => x.id !== scanId) }))
        if (psts.length === 0 && msgs.length === 0) {
          const sample = otherFiles.slice(0, 5).join(', ')
          const detail = otherFiles.length
            ? ` It contains ${otherFiles.length} other file${otherFiles.length === 1 ? '' : 's'}` +
              `${sample ? ` (${sample}${otherFiles.length > 5 ? ', …' : ''})` : ''}. Did you pick the right zip?`
            : ' The zip is empty.'
          set((s) => ({
            sources: [
              ...s.sources,
              {
                id: uid(),
                fileName: file.name,
                size: file.size,
                label: stripExt(file.name),
                status: 'error',
                error: `No PST, OST, MSG, or EML files found in this zip.${detail}`,
              },
            ],
          }))
          return
        }
        for (const entry of psts) startSource(entry.file)
        startMsgSource(msgs.map((entry) => entry.file))
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        set((s) => ({
          sources: s.sources.map((x) =>
            x.id === scanId ? { ...x, status: 'error', error: `Could not read zip: ${message}` } : x,
          ),
        }))
      })
  }

  return {
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesUnreadable: 0,
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    sortBy: 'date',
    sortDir: 'desc',
    searchQuery: '',
    searchResults: [],
    searching: false,
    searchFilters: EMPTY_SEARCH_FILTERS,
    searchSortBy: 'relevance',
    searchSortDir: 'desc',
    exportSel: {},
    exporting: false,
    remembered: [],
    reconnecting: {},
    reconnectError: {},
    navWidth: readNum(NAV_W_KEY, 272),
    listWidth: readNum(LIST_W_KEY, 380),

    setNavWidth: (w) => {
      const v = clamp(w, 200, 520)
      writeNum(NAV_W_KEY, v)
      set({ navWidth: v })
    },
    setListWidth: (w) => {
      const v = clamp(w, 280, 680)
      writeNum(LIST_W_KEY, v)
      set({ listWidth: v })
    },

    addFiles: (files, handles) => {
      // Group .msg/.eml files dropped together into one "Messages" mailbox
      // instead of creating a source per file.
      const msgs: File[] = []
      files.forEach((file, i) => {
        const handle = handles?.[i]
        if (/\.zip$/i.test(file.name)) handleZip(file)
        else if (/\.(msg|eml)$/i.test(file.name)) msgs.push(file)
        else startSource(file, handle)
      })
      startMsgSource(msgs)
    },

    removeSource: (id) => {
      void pst.closeSource(id)
      void pst.forgetPersisted(id).catch(() => {})
      void deleteHandleRecord(id).catch(() => {})
      set((s) => {
        const sources = s.sources.filter((src) => src.id !== id)
        const remembered = s.remembered.filter((r) => r.id !== id)
        const reconnecting = omitKey(s.reconnecting, id)
        const reconnectError = omitKey(s.reconnectError, id)
        // Removing the last mailbox returns to a clean slate, but the
        // remembered/reconnect state is history, not session state — it must
        // survive so the just-removed mailbox doesn't reappear the moment
        // the source list empties and DropZone/the remembered list remounts.
        if (sources.length === 0) {
          return { ...freshState(), remembered, reconnecting, reconnectError }
        }

        const wasSelected = s.selection.sourceId === id
        // Drop anything tied to the removed source.
        const exportSel = Object.fromEntries(
          Object.entries(s.exportSel).filter(([, v]) => v.sourceId !== id),
        )
        return {
          sources,
          remembered,
          reconnecting,
          reconnectError,
          selection: wasSelected
            ? { sourceId: null, folderId: null, messageId: null }
            : s.selection,
          messages: wasSelected ? [] : s.messages,
          messageContent: wasSelected ? null : s.messageContent,
          searchResults: s.searchResults.filter((h) => h.sourceId !== id),
          exportSel,
        }
      })
    },

    clearSources: () => {
      const ids = get().sources.map((src) => src.id)
      for (const id of ids) {
        void pst.closeSource(id)
        void pst.forgetPersisted(id).catch(() => {})
        void deleteHandleRecord(id).catch(() => {})
      }
      set((s) => ({
        ...freshState(),
        remembered: s.remembered.filter((r) => !ids.includes(r.id)),
        reconnecting: {},
        reconnectError: {},
      }))
    },

    renameSource: (id, label) => {
      set((s) => ({
        sources: s.sources.map((src) => (src.id === id ? { ...src, label } : src)),
      }))
      // Best-effort: don't leave "Recently opened" showing a stale filename
      // after a rename, for a mailbox that happens to be persisted.
      if (get().remembered.some((r) => r.id === id)) {
        void updateHandleRecord(id, { label })
          .then(() => get().loadRemembered())
          .catch(() => {})
      }
    },

    toggleFolder: (sourceId, folderId) =>
      set((s) => {
        const key = fkey(sourceId, folderId)
        return { expanded: { ...s.expanded, [key]: !s.expanded[key] } }
      }),

    selectFolder: (sourceId, folderId) => {
      set({
        selection: { sourceId, folderId, messageId: null },
        messages: [],
        messagesUnreadable: 0,
        messagesLoading: true,
        messageContent: null,
        contentLoading: false,
      })
      pendingFolderLoad = pst
        .getFolderMessages(sourceId, folderId)
        .then(({ messages, unreadable }) => {
          const sel = get().selection
          if (sel.sourceId !== sourceId || sel.folderId !== folderId) return
          const { sortBy, sortDir } = get()
          set({
            messages: sortMessages(messages, sortBy, sortDir),
            messagesUnreadable: unreadable,
            messagesLoading: false,
          })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.sourceId === sourceId && sel.folderId === folderId) {
            set({ messages: [], messagesUnreadable: 0, messagesLoading: false })
          }
        })
    },

    setSort: (sortBy, sortDir) => {
      set((s) => ({ sortBy, sortDir, messages: sortMessages(s.messages, sortBy, sortDir) }))
    },

    selectMessage: (messageId) => {
      const { sourceId, folderId } = get().selection
      set((s) => ({
        selection: { ...s.selection, messageId },
        messageContent: null,
        contentLoading: messageId != null,
      }))
      if (!messageId || !sourceId) return
      pst
        .getMessageContent(sourceId, messageId, folderId ?? undefined)
        .then((content) => {
          const sel = get().selection
          if (sel.messageId !== messageId || sel.sourceId !== sourceId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.messageId === messageId && sel.sourceId === sourceId) {
            set({ messageContent: null, contentLoading: false })
          }
        })
    },

    setSearchQuery: (searchQuery) => set({ searchQuery }),

    setSearchFilters: (searchFilters) => {
      set({ searchFilters })
      get().runSearch()
    },

    setSearchSort: (searchSortBy, searchSortDir) => {
      set((s) => ({
        searchSortBy,
        searchSortDir,
        searchResults: sortHits(s.searchResults, searchSortBy, searchSortDir),
      }))
    },

    runSearch: () => {
      const query = get().searchQuery.trim()
      if (!query) {
        set({ searchResults: [], searching: false })
        return
      }
      set({ searching: true })
      pst
        .search(query, 200, get().searchFilters)
        .then((searchResults) => {
          if (get().searchQuery.trim() !== query) return // stale
          const { searchSortBy, searchSortDir } = get()
          set({ searchResults: sortHits(searchResults, searchSortBy, searchSortDir), searching: false })
        })
        .catch(() => {
          if (get().searchQuery.trim() === query) set({ searchResults: [], searching: false })
        })
    },

    clearSearch: () => set({ searchQuery: '', searchResults: [], searching: false }),

    openHit: (hit) => {
      set((s) => ({
        selection: { sourceId: hit.sourceId, folderId: hit.folderId, messageId: hit.messageId },
        expanded: { ...s.expanded, [fkey(hit.sourceId, hit.folderId)]: true },
        messageContent: null,
        contentLoading: true,
      }))
      pst
        // The hit's folder may never have been listed this session (a warm
        // search-index cache skips the folder walk), so name it: the worker
        // loads that folder on demand rather than coming back empty.
        .getMessageContent(hit.sourceId, hit.messageId, hit.folderId)
        .then((content) => {
          const sel = get().selection
          if (sel.messageId !== hit.messageId || sel.sourceId !== hit.sourceId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.messageId === hit.messageId && sel.sourceId === hit.sourceId) {
            set({ messageContent: null, contentLoading: false })
          }
        })
    },

    toggleExport: (sourceId, messageId, folderId) =>
      set((s) => {
        const key = `${sourceId}:${messageId}`
        const next = { ...s.exportSel }
        if (next[key]) delete next[key]
        // Remember the folder: a message picked from search results may live in
        // a folder that was never listed, and the worker needs it to resolve.
        else next[key] = { sourceId, messageId, folderId }
        return { exportSel: next }
      }),

    clearExport: () => set({ exportSel: {} }),

    exportSelected: (direction = 'asc') => {
      const picks = Object.values(get().exportSel)
      if (!picks.length || get().exporting) return
      set({ exporting: true })
      // Never let the buttons stay disabled if a fetch stalls; the user can
      // always retry.
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      // allSettled, not all: one unloadable message must not sink the whole merge.
      Promise.allSettled(picks.map((p) => pst.getMessageContent(p.sourceId, p.messageId, p.folderId)))
        .then((results) => {
          const valid = results
            .filter((r): r is PromiseFulfilledResult<MessageContent | null> => r.status === 'fulfilled')
            .map((r) => r.value)
            .filter((c): c is MessageContent => c != null)
          const dir = direction === 'desc' ? -1 : 1
          valid.sort((a, b) => dir * ((a.date ?? 0) - (b.date ?? 0)))
          if (valid.length) printHtmlDocument(buildPrintDocument(valid))
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },

    exportSingle: (sourceId, messageId) => {
      if (get().exporting) return
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      pst
        .getMessageContent(sourceId, messageId, get().selection.folderId ?? undefined)
        .then((content) => {
          if (content) printHtmlDocument(buildPrintDocument([content]))
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },

    exportEml: (sourceId, messageId) => {
      if (get().exporting) return
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      pst
        .getMessageContent(sourceId, messageId, get().selection.folderId ?? undefined)
        .then(async (content) => {
          if (!content) return
          const files: EmlAttachment[] = []
          for (const a of content.attachments) {
            if (a.isInline || a.isEmbeddedMessage) continue
            const d = await pst.getAttachmentData(sourceId, messageId, a.index)
            if (d) files.push({ name: a.name || d.name, mime: a.mime || d.mime, data: d.data })
          }
          downloadBlob(
            new Blob([buildEml(content, files)], { type: 'message/rfc822' }),
            emlFilename(content),
          )
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },

    loadRemembered: () =>
      getAllHandleRecords()
        .then((records) => {
          set({ remembered: [...records].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt) })
        })
        .catch(() => {
          /* best-effort: an unusable IndexedDB just means an empty remembered list */
        }),

    reconnect: (id) => reconnectInternal(id, false),
    grantAndReconnect: (id) => reconnectInternal(id, true),

    forgetRemembered: (id) => {
      void forgetRememberedImpl(id)
    },

    clearAllPersisted: () => {
      void clearAllStores()
        .then(() => {
          set({ remembered: [], reconnecting: {}, reconnectError: {} })
        })
        .catch(() => {
          /* best-effort */
        })
    },
  }
})
