// The full-text index of the pages visited (« Rechercher dans le contenu des pages »): pure logic, no Electron. The index is the text of a page,
// kept on this machine only, while the setting `pageContentIndex` is on (off by default). It is bounded three ways: a page's text, a number of
// pages, and the total size; the oldest pages go first. What may never enter it is decided here (`indexableUrl`, and the page script that skips
// password pages and input fields, `PAGE_INDEX_SCRIPT`).

import { foldAccentsAndQuotes } from './fold'
import { hostBelongsToSite } from './site-data'

/** Characters of text kept per page: the start of a page says what it is about; the rest is the cost. */
export const PAGE_INDEX_TEXT_MAX = 20_000
/** Pages kept in an index (one per profile): past it, the oldest is dropped. */
export const PAGE_INDEX_PAGES_MAX = 2_000
/** Characters of text kept in an index, all pages together (about this many bytes on the disk): the oldest pages are dropped past it. */
export const PAGE_INDEX_TOTAL_MAX = 20_000_000
/** The longest address and title kept. */
export const PAGE_INDEX_URL_MAX = 2_048
export const PAGE_INDEX_TITLE_MAX = 300
/** A page with less text than this says nothing worth finding (an error screen, a blank page). */
export const PAGE_INDEX_TEXT_MIN = 40
/** How long after a page has loaded its text is read: the time its scripts take to draw it. */
export const PAGE_INDEX_SETTLE_MS = 2_000
/** How many words of a search are used, and how many results come back. */
export const PAGE_INDEX_WORDS_MAX = 8
export const PAGE_INDEX_RESULTS_MAX = 50
/** The characters of context shown around the first word found. */
export const PAGE_INDEX_SNIPPET = 160

export interface IndexedPage {
  url: string
  title: string
  /** The visible text of the page, whitespace folded, at most `PAGE_INDEX_TEXT_MAX` characters. */
  text: string
  /** When the page was read (ms). */
  at: number
}

export interface PageMatch {
  url: string
  title: string
  /** A piece of the page's text around the words found. */
  snippet: string
  at: number
}

/**
 * Only the pages of the web are indexed: no address with a login in it, none of the application's own pages, and no address that is a local
 * file. (A private tab, a container and a page with a password field are left out by the caller, which knows them.)
 */
export function indexableUrl(url: string): boolean {
  if (url.length === 0 || url.length > PAGE_INDEX_URL_MAX) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === ''
}

/** The text of a page as kept: control characters and runs of whitespace become one space, cut at the bound. */
export function cleanIndexText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // NFC: a letter and its accent written apart become one character, so that the folded text below keeps the length of the text (see `foldSameLength`).
  return raw.normalize('NFC').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, PAGE_INDEX_TEXT_MAX)
}

/**
 * The script run in the page (an isolated world, see PAGE_INDEX_WORLD): the visible text, and nothing that was typed. A page with a password
 * field answers null (a sign-in or payment page is never indexed); the fields a person fills in (input, textarea, select, editable zones) and the
 * scripts and styles are taken out of a copy of the body before its text is read.
 */
export const PAGE_INDEX_SCRIPT = `(() => {
  try {
    if (!document.body || document.querySelector('input[type="password"], input[autocomplete*="cc-"]')) return null;
    const copy = document.body.cloneNode(true);
    copy.querySelectorAll('script, style, noscript, template, input, textarea, select, option, [contenteditable], iframe, svg, canvas').forEach((node) => node.remove());
    return String(copy.textContent || '').slice(0, ${PAGE_INDEX_TEXT_MAX * 2});
  } catch (error) {
    return null;
  }
})()`

/** The world the script runs in: apart from the page's own scripts (any number the application does not use for another world). */
export const PAGE_INDEX_WORLD = 4_200_067

const characters = (pages: readonly IndexedPage[]): number => pages.reduce((sum, page) => sum + page.text.length + page.url.length + page.title.length, 0)

/**
 * The index after a page is read: the page replaces the one at the same address and comes first, and the oldest go until the bounds hold.
 * A page without enough text, or at an address that is not indexable, leaves the index as it was.
 */
export function withPage(pages: readonly IndexedPage[], page: IndexedPage): IndexedPage[] {
  const text = cleanIndexText(page.text)
  if (!indexableUrl(page.url) || text.length < PAGE_INDEX_TEXT_MIN) return [...pages]
  const next: IndexedPage[] = [{ url: page.url, title: page.title.slice(0, PAGE_INDEX_TITLE_MAX), text, at: page.at }, ...pages.filter((other) => other.url !== page.url)]
  return bounded(next)
}

/** The oldest pages dropped until the count and the total size are within their bounds (the list is newest first). */
export function bounded(pages: IndexedPage[]): IndexedPage[] {
  const kept = pages.slice(0, PAGE_INDEX_PAGES_MAX)
  let total = characters(kept)
  while (kept.length > 1 && total > PAGE_INDEX_TOTAL_MAX) {
    const dropped = kept.pop()
    if (dropped) total -= dropped.text.length + dropped.url.length + dropped.title.length
  }
  return kept
}

/** The pages of one site (and of its subdomains when asked) taken out: what « Effacer les données du site » owes the index. */
export function withoutSite(pages: readonly IndexedPage[], host: string, subdomains: boolean): IndexedPage[] {
  return pages.filter((page) => {
    try {
      return !hostBelongsToSite(new URL(page.url).hostname, host, subdomains)
    } catch {
      return true
    }
  })
}

/** The pages as a file read them back: each one rebuilt, the invalid ones left out, the bounds applied. */
export function cleanIndex(raw: unknown): IndexedPage[] {
  if (!Array.isArray(raw)) return []
  const out: IndexedPage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { url, title, text, at } = item as Record<string, unknown>
    if (typeof url !== 'string' || !indexableUrl(url) || typeof at !== 'number' || !Number.isFinite(at)) continue
    const clean = cleanIndexText(text)
    if (clean.length < PAGE_INDEX_TEXT_MIN || out.some((other) => other.url === url)) continue
    out.push({ url, title: typeof title === 'string' ? title.slice(0, PAGE_INDEX_TITLE_MAX) : '', text: clean, at })
  }
  return bounded(out)
}

/** The words of a search, folded, each once, at most `PAGE_INDEX_WORDS_MAX`. */
export function searchWords(query: string): string[] {
  return [...new Set(foldAccentsAndQuotes(query).split(/\s+/).filter((word) => word.length > 0))].slice(0, PAGE_INDEX_WORDS_MAX)
}

/**
 * The text folded as the words of a search are (accents, case, apostrophes), character by character, so that a position in the folded text is a position
 * in the text: the snippet is cut from the text where the word was found. A character that would change length when folded stays as it is.
 */
export function foldSameLength(text: string): string {
  let out = ''
  for (const character of text) {
    const one = foldAccentsAndQuotes(character)
    out += one.length === character.length ? one : character
  }
  return out
}

/** The folded text of a page, made once per page object: a search folds 20 MB of text otherwise, at each keystroke. */
const folded = new WeakMap<IndexedPage, { title: string; text: string }>()
function foldedPage(page: IndexedPage): { title: string; text: string } {
  let known = folded.get(page)
  if (!known) folded.set(page, (known = { title: foldAccentsAndQuotes(page.title), text: foldSameLength(page.text) }))
  return known
}

function snippetAround(text: string, folded: string, word: string): string {
  const at = Math.max(folded.indexOf(word), 0)
  const start = Math.max(0, at - Math.floor(PAGE_INDEX_SNIPPET / 3))
  const piece = text.slice(start, start + PAGE_INDEX_SNIPPET).trim()
  return `${start > 0 ? '… ' : ''}${piece}${start + PAGE_INDEX_SNIPPET < text.length ? ' …' : ''}`
}

/**
 * The pages whose text (or title) holds every word of the query, accents and case ignored; a page that holds the query as one phrase comes
 * first, then the most recent. No word: nothing (an empty search lists no page).
 */
export function searchIndex(pages: readonly IndexedPage[], query: string, limit: number = PAGE_INDEX_RESULTS_MAX): PageMatch[] {
  const words = searchWords(query)
  if (words.length === 0) return []
  const phrase = words.join(' ')
  const found: Array<PageMatch & { rank: number }> = []
  for (const page of pages) {
    const { title, text } = foldedPage(page)
    const haystack = `${title} ${text}`
    if (!words.every((word) => haystack.includes(word))) continue
    const inText = words.find((word) => text.includes(word)) ?? words[0]!
    found.push({ url: page.url, title: page.title, snippet: snippetAround(page.text, text, inText), at: page.at, rank: words.length > 1 && text.includes(phrase) ? 1 : 0 })
  }
  found.sort((a, b) => b.rank - a.rank || b.at - a.at)
  return found.slice(0, Math.max(0, limit)).map(({ rank: _rank, ...match }) => match)
}
