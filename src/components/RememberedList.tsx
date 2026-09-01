import { useState } from 'react'
import { useApp } from '../store/store'
import { FSA_SUPPORTED } from '../lib/files'
import { Caret, Close, Spinner } from './icons'

/**
 * "Recently opened" — every mailbox this browser remembers a re-grantable
 * file handle for. Rendered both inside `DropZone` (the empty-state screen,
 * shown when no mailbox is open) and inside `NavPane` (shown once at least
 * one is), so it stays reachable regardless of what's currently open: a
 * first-draft gap left it reachable only while `sources.length === 0`, which
 * meant the moment one mailbox auto-reconnected there was no surviving UI to
 * reconnect or delete any *other* remembered mailbox.
 */
export function RememberedList() {
  const remembered = useApp((s) => s.remembered)
  const sources = useApp((s) => s.sources)
  const reconnecting = useApp((s) => s.reconnecting)
  const reconnectError = useApp((s) => s.reconnectError)
  const grantAndReconnect = useApp((s) => s.grantAndReconnect)
  const forgetRemembered = useApp((s) => s.forgetRemembered)
  const clearAllPersisted = useApp((s) => s.clearAllPersisted)
  const [open, setOpen] = useState(true)

  if (!FSA_SUPPORTED || remembered.length === 0) return null

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-200"
        >
          <Caret className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          Recently opened
        </button>
        <button
          onClick={() => {
            if (confirm('Erase every locally remembered mailbox and its cached search index?')) {
              clearAllPersisted()
            }
          }}
          className="shrink-0 text-[10px] font-medium text-slate-500 transition hover:text-rose-400"
          data-tip="Delete every remembered mailbox handle and cached search index in this browser"
        >
          Clear all local data
        </button>
      </div>

      {open && (
        <>
          <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-slate-500">
            Indexed text is cached in this browser so mailboxes reopen instantly. Remove a
            mailbox, or Clear all local data, to erase it.
          </p>
          <ul className="space-y-0.5 px-1.5 pb-1.5">
            {remembered.map((r) => {
              const isOpen = sources.some((s) => s.id === r.id)
              const state = reconnecting[r.id] ?? 'idle'
              return (
                <li
                  key={r.id}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-slate-300"
                >
                  <span className="min-w-0 flex-1 truncate" data-tip={r.fileName}>
                    {r.label}
                  </span>
                  {isOpen ? (
                    <span className="shrink-0 text-[10px] font-medium text-emerald-400">Open</span>
                  ) : state === 'checking' || state === 'opening' ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                  ) : state === 'needs-permission' ? (
                    <button
                      onClick={() => grantAndReconnect(r.id)}
                      className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/30"
                    >
                      Reconnect
                    </button>
                  ) : state === 'error' ? (
                    <span
                      className="shrink-0 truncate text-[10px] text-rose-400"
                      data-tip={reconnectError[r.id] ?? 'Could not reconnect.'}
                    >
                      Error
                    </span>
                  ) : null}
                  <button
                    onClick={() => forgetRemembered(r.id)}
                    className="shrink-0 text-slate-500 transition hover:text-rose-400"
                    data-tip="Forget this mailbox (deletes its cached search index too)"
                  >
                    <Close className="h-3 w-3" />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
