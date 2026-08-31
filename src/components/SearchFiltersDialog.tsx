import { useEffect, useState } from 'react'
import { EMPTY_SEARCH_FILTERS, useApp } from '../store/store'
import type { FolderNode, SearchFilters } from '../types'
import { sortFolders } from './NavPane'
import { Close } from './icons'

const FOLDER_SEP = '::'

const inputCls =
  'rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none'

function toDateInputValue(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDateInput(value: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
}

function startOfDayMs(value: string): number | null {
  const p = parseDateInput(value)
  return p ? new Date(p[0], p[1], p[2], 0, 0, 0, 0).getTime() : null
}

function endOfDayMs(value: string): number | null {
  const p = parseDateInput(value)
  return p ? new Date(p[0], p[1], p[2], 23, 59, 59, 999).getTime() : null
}

/** Depth-first, indented list of a mailbox's folders for a flat <select>. */
function flattenFolders(root: FolderNode): { folderId: string; label: string }[] {
  const out: { folderId: string; label: string }[] = []
  const walk = (node: FolderNode, depth: number) => {
    out.push({ folderId: node.id, label: `${'    '.repeat(depth)}${node.name}` })
    for (const child of sortFolders(node.children)) walk(child, depth + 1)
  }
  for (const child of sortFolders(root.children)) walk(child, 0)
  return out
}

/** Advanced search filters (date range, folder, sender, recipient, attachments). */
export function SearchFiltersDialog({ onClose }: { onClose: () => void }) {
  const sources = useApp((s) => s.sources)
  const filters = useApp((s) => s.searchFilters)
  const setSearchFilters = useApp((s) => s.setSearchFilters)

  const [dateFrom, setDateFrom] = useState(filters.dateFrom != null ? toDateInputValue(filters.dateFrom) : '')
  const [dateTo, setDateTo] = useState(filters.dateTo != null ? toDateInputValue(filters.dateTo) : '')
  const [folderValue, setFolderValue] = useState(
    filters.folder ? `${filters.folder.sourceId}${FOLDER_SEP}${filters.folder.folderId}` : '',
  )
  const [from, setFrom] = useState(filters.from)
  const [to, setTo] = useState(filters.to)
  const [hasAttachments, setHasAttachments] = useState(filters.hasAttachments)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = () => {
    const sepIdx = folderValue.indexOf(FOLDER_SEP)
    const folder =
      sepIdx === -1
        ? null
        : { sourceId: folderValue.slice(0, sepIdx), folderId: folderValue.slice(sepIdx + FOLDER_SEP.length) }
    const next: SearchFilters = {
      dateFrom: dateFrom ? startOfDayMs(dateFrom) : null,
      dateTo: dateTo ? endOfDayMs(dateTo) : null,
      folder,
      from,
      to,
      hasAttachments,
    }
    setSearchFilters(next)
    onClose()
  }

  const clearAll = () => {
    setSearchFilters(EMPTY_SEARCH_FILTERS)
    onClose()
  }

  const readySources = sources.filter((s) => s.status === 'ready' && s.index)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Advanced search filters</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
            data-tip="Close (Esc)"
          >
            <Close className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Date range</label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className={`${inputCls} flex-1`}
              />
              <span className="text-xs text-slate-500">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className={`${inputCls} flex-1`}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Folder</label>
            <select
              value={folderValue}
              onChange={(e) => setFolderValue(e.target.value)}
              className={`${inputCls} w-full`}
            >
              <option value="">All folders</option>
              {readySources.map((s) => (
                <optgroup key={s.id} label={s.label}>
                  {flattenFolders(s.index!.rootFolder).map((f) => (
                    <option key={f.folderId} value={`${s.id}${FOLDER_SEP}${f.folderId}`}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">From (sender contains)</label>
            <input
              type="text"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="e.g. jane@example.com"
              className={`${inputCls} w-full`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">To (recipient contains)</label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="e.g. jane@example.com"
              className={`${inputCls} w-full`}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={hasAttachments}
              onChange={(e) => setHasAttachments(e.target.checked)}
              className="h-4 w-4 accent-sky-500"
            />
            Has attachment
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
          <button onClick={clearAll} className="text-xs font-medium text-slate-400 hover:text-slate-200">
            Clear filters
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
