import { useEffect, useState } from 'react'
import { useApp } from '../store/store'
import { activeFilterCount } from '../lib/searchFilters'
import { SearchFiltersDialog } from './SearchFiltersDialog'
import { Close, Filter, Search, Spinner } from './icons'

export function SearchBar() {
  const query = useApp((s) => s.searchQuery)
  const setQuery = useApp((s) => s.setSearchQuery)
  const runSearch = useApp((s) => s.runSearch)
  const clearSearch = useApp((s) => s.clearSearch)
  const searching = useApp((s) => s.searching)
  const filters = useApp((s) => s.searchFilters)
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Debounce the search as the user types.
  useEffect(() => {
    const t = setTimeout(() => runSearch(), 180)
    return () => clearTimeout(t)
  }, [query, runSearch])

  const filterCount = activeFilterCount(filters)

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all mail…"
          className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
        />
        {searching ? (
          <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-400" />
        ) : (
          (query || filterCount > 0) && (
            <button
              onClick={clearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-200"
              data-tip="Clear search and filters"
            >
              <Close className="h-4 w-4" />
            </button>
          )
        )}
      </div>

      <button
        onClick={() => setFiltersOpen(true)}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
          filterCount > 0
            ? 'border-sky-500 bg-sky-500/10 text-sky-300'
            : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
        }`}
        data-tip="Advanced search filters"
      >
        <Filter className="h-4 w-4" />
        {filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
      </button>

      {filtersOpen && <SearchFiltersDialog onClose={() => setFiltersOpen(false)} />}
    </div>
  )
}
