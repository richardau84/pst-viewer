import type { SearchFilters } from '../types'

/** Number of advanced filters currently narrowing the search. Drives the
 *  Filters button badge, and — since filters alone are a valid search — the
 *  decision to run a search at all. */
export function activeFilterCount(f: SearchFilters): number {
  let n = 0
  if (f.dateFrom != null || f.dateTo != null) n++
  if (f.folder) n++
  if (f.from.trim()) n++
  if (f.to.trim()) n++
  if (f.hasAttachments) n++
  return n
}

export function hasActiveFilters(f: SearchFilters): boolean {
  return activeFilterCount(f) > 0
}
