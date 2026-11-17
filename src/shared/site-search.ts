// The quick searches and shortcuts of the command bar (Settings › Navigation › "Recherche dans un site"): a keyword, a name and an address.
// An address with `%s` searches the site ("yt lofi" + Tab); an address without it is a shortcut: the keyword alone ("tw") opens it.

import { DEFAULT_SITE_SEARCHES, type SiteSearch } from './model'
import { t } from './i18n'

/** The address of a site search or shortcut: web address, no space, no control character. `%s` is optional. */
export const isSiteAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && /^https:\/\/\S+$/i.test(value) && !/\p{Cc}/u.test(value)

/** The hosts of this very machine: a site being built is served there, in plain http. */
export const LOOPBACK_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/

/**
 * The address a search is kept at: an https address (`isSiteAddress`), or plain http on this machine (a search a site being built declares, which
 * the discovery of searches offers: docs/recherche.md). Never http elsewhere, and never an address with a login in it.
 */
export function isSearchAddress(value: unknown): value is string {
  if (isSiteAddress(value)) return true
  if (typeof value !== 'string' || value.length > 2048 || !/^http:\/\/\S+$/i.test(value) || /\p{Cc}/u.test(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname) && url.username === '' && url.password === ''
}

/** Whether the address takes what is typed after the keyword. */
export const takesTerm = (url: string): boolean => url.includes('%s')

export type SiteSearchProblem = 'keyword' | 'taken' | 'name' | 'address'

/**
 * What stops a site search from being saved, in words: one message per problem, the same in the Settings and in the sheet « Créer un raccourci
 * pour ce site… », which check a draft with the same rule (`siteSearchProblem`). Read when it is shown: the language is not known earlier.
 */
export function siteSearchProblemText(problem: SiteSearchProblem): string {
  switch (problem) {
    case 'keyword':
      return t('settings-profiles.raccourci-keyword')
    case 'taken':
      return t('settings-profiles.raccourci-taken')
    case 'name':
      return t('settings-profiles.raccourci-name')
    case 'address':
      return t('settings-profiles.raccourci-address')
  }
}

/** What stops a draft from being added, in the order the form is filled in; null when it can be added. */
export function siteSearchProblem(draft: SiteSearch, existing: readonly SiteSearch[]): SiteSearchProblem | null {
  if (!/^[a-z0-9]{1,12}$/i.test(draft.keyword)) return 'keyword'
  if (existing.some((s) => s.keyword === draft.keyword.toLowerCase())) return 'taken'
  if (draft.name.trim() === '') return 'name'
  if (!isSiteAddress(draft.url)) return 'address'
  return null
}

/**
 * What « Rétablir les recherches par défaut » makes of the list (Settings › Navigation › Recherche dans un site): the user's own searches as they are and in
 * their order, then the default searches whose keyword is not in the list, in their order. A keyword the user gave to a search of their own keeps theirs.
 * `added` is how many come back: 0, and there is nothing to do (the button is grey). The list is never emptied nor reordered by it.
 */
export function restoreDefaultSiteSearches(current: readonly SiteSearch[], defaults: readonly SiteSearch[] = DEFAULT_SITE_SEARCHES): { list: SiteSearch[]; added: number } {
  const taken = new Set(current.map((search) => search.keyword.toLowerCase()))
  const missing = defaults.filter((search) => !taken.has(search.keyword.toLowerCase()))
  return { list: [...current, ...missing.map((search) => ({ ...search }))], added: missing.length }
}

/** Whether two lists of searches are the same, entry by entry (the undo of a restore is offered only while the list is still the one it made). */
export const sameSiteSearches = (a: readonly SiteSearch[], b: readonly SiteSearch[]): boolean =>
  a.length === b.length && a.every((search, i) => search.keyword === b[i]!.keyword && search.name === b[i]!.name && search.url === b[i]!.url)
