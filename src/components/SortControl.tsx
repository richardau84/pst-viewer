import { Caret } from './icons'

/** Field + direction picker for a message/search list, e.g. Date/Subject/Sender × asc/desc. */
export function SortControl<T extends string>({
  value,
  dir,
  onChange,
  options,
}: {
  value: T
  dir: 'asc' | 'desc'
  onChange: (field: T, dir: 'asc' | 'desc') => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T, dir)}
        className="rounded-md border border-slate-700 bg-slate-800/60 py-1 pl-1.5 pr-6 text-[11px] text-slate-300 focus:border-sky-500 focus:outline-none"
        data-tip="Sort by"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={() => onChange(value, dir === 'asc' ? 'desc' : 'asc')}
        className="rounded-md border border-slate-700 bg-slate-800/60 p-1 text-slate-300 transition hover:bg-slate-700/60"
        data-tip={dir === 'asc' ? 'Ascending' : 'Descending'}
      >
        <Caret className={`h-3.5 w-3.5 transition-transform ${dir === 'asc' ? '-rotate-90' : 'rotate-90'}`} />
      </button>
    </div>
  )
}
