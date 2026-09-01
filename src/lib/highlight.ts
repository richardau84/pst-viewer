/** A query split into quoted phrases and loose words.
 *
 *  A phrase must appear intact — `"annual report"` matches only mail actually
 *  containing that text, never mail that happens to mention both words apart.
 *  An unterminated quote is treated as ordinary text, so a half-typed
 *  `"annual rep` keeps searching normally while it is being typed. */
export interface ParsedQuery {
  phrases: string[]
  words: string[]
}

/** Split free text into the distinct words we match / highlight on. Phrase
 *  words are kept down to a single character (`minLength` 1); loose words
 *  shorter than two characters are noise. */
export function queryWords(text: string, minLength = 2): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= minLength),
    ),
  )
}

export function parseQuery(query: string): ParsedQuery {
  const phrases: string[] = []
  let loose = ''
  let last = 0
  for (const m of query.matchAll(/"([^"]*)"/g)) {
    loose += `${query.slice(last, m.index)} `
    const phrase = m[1].trim().replace(/\s+/g, ' ').toLowerCase()
    if (phrase) phrases.push(phrase)
    last = m.index + m[0].length
  }
  loose += query.slice(last)
  return { phrases: Array.from(new Set(phrases)), words: queryWords(loose) }
}

/** One thing to highlight: `exact` terms came from quotes and match whole
 *  words only, the way the search itself matched them; a loose word highlights
 *  wherever it appears, since the search matched it by prefix and fuzzily. */
export interface QueryTerm {
  text: string
  exact: boolean
}

/** Split a search query into the distinct terms we highlight / match on. A
 *  quoted phrase stays one term, so it highlights as the whole phrase. */
export function queryTerms(query: string): QueryTerm[] {
  const { phrases, words } = parseQuery(query)
  // Phrases first: regex alternation takes the first branch that matches, so a
  // phrase wins over one of its own words appearing loose in the same query.
  return [
    ...phrases.map((text) => ({ text, exact: true })),
    ...words.filter((w) => !phrases.includes(w)).map((text) => ({ text, exact: false })),
  ]
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const WORD = '\\p{L}\\p{N}'

/** Regex source matching a term literally, with any run of whitespace allowed
 *  between its words (bodies wrap lines wherever they like). An exact term is
 *  fenced off at either end so `"annual report"` doesn't match inside
 *  "semiannual reporting" — the term index matches quoted words whole, and the
 *  text check has to agree with it. The fence is only added where the term's
 *  own edge is a word character, so a phrase of pure punctuation still matches. */
function termPattern(term: string, exact: boolean): string {
  const body = term.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
  if (!exact) return body
  const open = new RegExp(`^[${WORD}]`, 'u').test(term) ? `(?<![${WORD}])` : ''
  const close = new RegExp(`[${WORD}]$`, 'u').test(term) ? `(?![${WORD}])` : ''
  return `${open}${body}${close}`
}

/** Case-insensitive test for one phrase appearing intact in a text. */
export function phraseRegExp(phrase: string): RegExp {
  return new RegExp(termPattern(phrase, true), 'iu')
}

/** A case-insensitive regex matching any of the given terms. */
export function termsRegExp(terms: QueryTerm[]): RegExp | null {
  if (!terms.length) return null
  return new RegExp(`(${terms.map((t) => termPattern(t.text, t.exact)).join('|')})`, 'giu')
}
