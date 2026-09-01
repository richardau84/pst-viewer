import { useEffect, useState } from 'react'
import type { RecipientInfo } from '../types'
import { formatRecipient } from '../lib/format'
import { Close } from './icons'

/** Modal listing every recipient in a To/Cc/Bcc field, with copy-to-clipboard. */
export function RecipientsDialog({
  label,
  list,
  onClose,
}: {
  label: string
  list: RecipientInfo[]
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const text = list.map(formatRecipient).join('; ')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; the text is still selectable */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {label} <span className="font-normal text-slate-400">({list.length})</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
            >
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
              data-tip="Close (Esc)"
            >
              <Close className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="scroll-clear m-0 min-h-0 flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed text-slate-300">
          {list.map((r, i) => (
            <div key={`${r.email}-${i}`} className="py-0.5">
              {formatRecipient(r)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
