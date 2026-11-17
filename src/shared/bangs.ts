// Keywords with a "!" in front, in the command bar: "!w planète" searches Wikipédia, "planète !w" does too, "!w" alone opens the site.
// It is the Site Search mechanism (`siteSearches`, "yt lofi" + Tab) with a second way of writing it, and a short fixed list of engines
// behind it. Nothing is sent anywhere to resolve a keyword: the list is here, and the search address is opened as any other.
//
// The user's own searches come first, so one of them with the keyword of an engine of the list replaces it; the list itself is fixed
// (documented in docs/recherche.md) and the whole feature is a switch in Settings.

import { DEFAULT_SITE_SEARCHES, type SidebarState, type SiteSearch } from './model'

/** The one search of the list the application starts with that is no bang: Google Maps is already `!gm`, and `maps` is its second keyword. */
const NOT_A_BANG = 'maps'

/**
 * The engines every keyword of which works with a "!": the searches the application starts with (`DEFAULT_SITE_SEARCHES`, the one list of them),
 * so a bang never differs from the keyword. Addresses take the search in `%s`. French or English sites, no account, no tracking parameter.
 * A keyword is at most 12 characters, lower case, letters and digits.
 */
export const BUILTIN_BANGS: readonly SiteSearch[] = DEFAULT_SITE_SEARCHES.filter((site) => site.keyword !== NOT_A_BANG)

/** A bang is "!" and a keyword of letters, digits and - or _ (the characters of the keywords above and of the ones the settings accept). */
const KEYWORD = '[a-z0-9_-]{1,30}'
const PREFIX = new RegExp(`^!(${KEYWORD})(?:\\s+(.*))?$`, 'i')
const SUFFIX = new RegExp(`^(.*\\S)\\s+!(${KEYWORD})$`, 'i')
/** Longest text the bar looks at for a bang, so that a pasted page cannot cost a scan. */
const QUERY_MAX = 1000

export interface ParsedBang {
  keyword: string
  /** What follows the keyword (or comes before it), tidied. Empty when only the keyword was typed. */
  terms: string
}

/** The keyword and the terms of "!w foo" or "foo !w"; null when the text is not written that way. Says nothing about the keyword being known. */
export function parseBang(query: string): ParsedBang | null {
  const text = query.trim()
  if (text.length === 0 || text.length > QUERY_MAX) return null
  const prefix = PREFIX.exec(text)
  if (prefix) return { keyword: prefix[1]!.toLowerCase(), terms: (prefix[2] ?? '').trim() }
  const suffix = SUFFIX.exec(text)
  return suffix ? { keyword: suffix[2]!.toLowerCase(), terms: suffix[1]!.trim() } : null
}

/** The search a keyword stands for: the user's own first, then the list. */
function findSiteSearch(searches: readonly SiteSearch[], key: string): SiteSearch | undefined {
  for (let i = searches.length - 1; i >= 0; i--) {
    const site = searches[i]!
    if (site.keyword.toLowerCase() === key) return site
  }
  return undefined
}

export function bangSite(keyword: string, state: SidebarState): SiteSearch | undefined {
  const key = keyword.toLowerCase()
  return findSiteSearch(state.settings.siteSearches, key) ?? BUILTIN_BANGS.find((s) => s.keyword === key)
}

/** Every keyword a "!" can complete, the user's first. */
export function allBangs(state: SidebarState): SiteSearch[] {
  const own = state.settings.siteSearches
  const owned = new Set(own.map((s) => s.keyword.toLowerCase()))
  return [...own, ...BUILTIN_BANGS.filter((s) => !owned.has(s.keyword))]
}

export interface BangSearch {
  name: string
  /** The address to open: the search with the terms, or the site's own address when no terms were typed. */
  url: string
  keyword: string
  terms: string
}

/** The origin of the site a search address belongs to ("https://fr.wikipedia.org/"), or null when it has none. */
export function siteOriginOf(template: string): string | null {
  const probe = template.replace('%s', '')
  return URL.canParse(probe) ? `${new URL(probe).origin}/` : null
}

/**
 * What a text typed with a "!" asks for, when the setting is on and the keyword is known: the search of the site, or the site itself when
 * there is nothing to search for. Null for any other text, a keyword that nothing answers to, or a switched-off setting.
 */
export function bangSearchFor(query: string, state: SidebarState): BangSearch | null {
  if (!state.settings.searchBangs) return null
  const bang = parseBang(query)
  const site = bang && bangSite(bang.keyword, state)
  if (!bang || !site) return null
  if (bang.terms === '') {
    const origin = siteOriginOf(site.url)
    return origin ? { name: site.name, url: origin, keyword: bang.keyword, terms: '' } : null
  }
  return { name: site.name, url: site.url.replace('%s', encodeURIComponent(bang.terms)), keyword: bang.keyword, terms: bang.terms }
}
