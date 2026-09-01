import { useEffect } from 'react'
import { Close } from './icons'

/** The "what is this / how does it work" copy, shared between the home-screen
 *  overview panel (DropZone) and the help dialog reachable once a mailbox is
 *  open (NavPane) — one place to keep the wording in sync. */
export function AboutContent() {
  return (
    <>
      <p>
        Outlook Archive Viewer reads Outlook mailbox files entirely in your browser — nothing is ever
        uploaded anywhere. It parses the folder tree, lets you browse and read messages and
        attachments, and builds a searchable index so you can find anything across the whole
        mailbox.
      </p>
      <p className="mt-2">
        Once you open a file, the folder tree usually appears within a few seconds and you can
        start browsing right away. In the background, the app keeps indexing the full contents
        for search — for a large mailbox (multiple GB, tens of thousands of messages) that can
        take a few minutes. You'll see an{' '}
        <span className="font-medium text-slate-300">"Indexing for search… "</span> progress
        indicator next to the mailbox while this runs — that's normal, not a freeze, and search
        results will simply keep filling in as it catches up.
      </p>
    </>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">About Outlook Archive File Viewer</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
            data-tip="Close (Esc)"
          >
            <Close className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs text-slate-400">
          <AboutContent />
        </div>
      </div>
    </div>
  )
}
