// The filter lists the blocker can use: which ones, where they come from, what a downloaded copy must look like, and
// what the settings show about each. Pure: the download and the engine live in src/main/blocking/.

import type { CustomFilterList, ReviewSummary } from './custom-filter-lists'
import { getLanguage, t, tp } from './i18n'
import { regexHazard, regexTextLimit } from './regex-guard'

/** `ads` follows "Bloquer les publicités et les traqueurs"; `cookies` follows "Bloquer les bannières de cookies". */
export type FilterListCategory = 'ads' | 'cookies'

export interface FilterListSpec {
  /** Stable key: the file name on disk, the switch in the settings. */
  id: string
  title: string
  /** One short sentence, shown under the title in the settings. */
  description: string
  category: FilterListCategory
  /** Official address of the raw list. Always https: a list fetched in clear could be rewritten on the way. */
  url: string
  homepage: string
  /** SPDX-style name, as declared by the list itself (see docs/licences-tierces.md). */
  license: string
  licenseUrl: string
  /** Who must be credited. */
  author: string
  /** A copy with fewer rules than this is not the list (an error page, a captive portal), whatever its look. */
  minRules?: number
}

const EASYLIST_LICENCE = 'https://easylist.to/pages/licence.html'
const UASSETS_LICENCE = 'https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE'
const ADGUARD_LICENCE = 'https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE'

/** The lists offered by default. Every one of them is downloaded on demand, never shipped. */
export const FILTER_LISTS: readonly FilterListSpec[] = [
  {
    id: 'easylist',
    title: 'EasyList',
    get description() { return t('filter-lists.publicites-et-elements-publicitaires-des-sites') },
    category: 'ads',
    url: 'https://easylist.to/easylist/easylist.txt',
    homepage: 'https://easylist.to/',
    get license() { return t('filter-lists.gpl-3-0-or-later-ou-cc-by-sa-3-0') },
    licenseUrl: EASYLIST_LICENCE,
    get author() { return t('filter-lists.les-auteurs-d-easylist') },
    minRules: 10000
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    get description() { return t('filter-lists.traqueurs-mesures-d-audience-et-empreintes') },
    category: 'ads',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    homepage: 'https://easylist.to/',
    get license() { return t('filter-lists.gpl-3-0-or-later-ou-cc-by-sa-3-0') },
    licenseUrl: EASYLIST_LICENCE,
    get author() { return t('filter-lists.les-auteurs-d-easylist') },
    minRules: 10000
  },
  {
    id: 'ublock-filters',
    title: 'uBlock filters',
    get description() { return t('filter-lists.complements-d-easylist-ecrits-pour-ublock-origin') },
    category: 'ads',
    // The root file (filters.txt) only holds a quarter of the rules and points to the others with "!#include": the engine does not follow
    // those, so the list would load silently truncated. filters.min.txt is the same list with its includes resolved, as uBlock Origin itself reads it.
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.min.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 15000
  },
  {
    id: 'ublock-badware',
    title: 'uBlock filters – Badware',
    get description() { return t('filter-lists.sites-connus-pour-installer-des-logiciels') },
    category: 'ads',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 500
  },
  {
    id: 'ublock-privacy',
    get title() { return t('filter-lists.ublock-filters-confidentialite') },
    get description() { return t('filter-lists.traqueurs-que-les-autres-listes-laissent-passer') },
    category: 'ads',
    // Same reason as above: privacy.txt includes resource-abuse.txt.
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.min.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 200
  },
  {
    id: 'ublock-unbreak',
    get title() { return t('filter-lists.ublock-filters-depannage') },
    get description() { return t('filter-lists.exceptions-qui-reparent-les-sites-casses-par') },
    category: 'ads',
    url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 200
  },
  {
    id: 'ublock-quick-fixes',
    get title() { return t('filter-lists.ublock-filters-correctifs-rapides') },
    get description() { return t('filter-lists.corrections-recentes-publiees-avant-d-entrer') },
    category: 'ads',
    url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 200
  },
  {
    id: 'adguard-fr',
    get title() { return t('filter-lists.adguard-francais-liste-fr') },
    get description() { return t('filter-lists.publicites-et-traqueurs-des-sites-francophones') },
    category: 'ads',
    url: 'https://filters.adtidy.org/extension/ublock/filters/16.txt',
    homepage: 'https://github.com/AdguardTeam/AdguardFilters',
    get license() { return t('filter-lists.gpl-3-0-la-liste-fr-qu-elle-reprend-cc-by-sa') },
    licenseUrl: ADGUARD_LICENCE,
    get author() { return t('filter-lists.adguard-et-les-auteurs-de-la-liste-fr') },
    minRules: 5000
  },
  {
    id: 'easylist-cookie',
    get title() { return t('filter-lists.easylist-cookie-list') },
    get description() { return t('filter-lists.bannieres-de-consentement-aux-cookies') },
    category: 'cookies',
    // fanboy-cookiemonster.txt ends with "!#include easylist_cookie_specific_uBO.txt" (about 2,800 rules the engine would never see):
    // this is the same list with the include resolved, which uBlock Origin reads by default.
    url: 'https://ublockorigin.github.io/uAssets/thirdparties/easylist-cookies.txt',
    homepage: 'https://easylist.to/',
    get license() { return t('filter-lists.cc-by-3-0-indiquee-par-la-liste-depot-easylist') },
    licenseUrl: EASYLIST_LICENCE,
    get author() { return t('filter-lists.les-auteurs-d-easylist') },
    minRules: 20000
  },
  {
    id: 'ublock-cookies',
    get title() { return t('filter-lists.ublock-filters-avis-de-cookies') },
    get description() { return t('filter-lists.complete-la-liste-precedente-pour-les-avis-de') },
    category: 'cookies',
    url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0',
    licenseUrl: UASSETS_LICENCE,
    get author() { return t('filter-lists.raymond-hill-et-les-contributeurs-d-uassets') },
    minRules: 500
  }
]

export interface BlockingConfig {
  ads: boolean
  cookieBanners: boolean
  cosmetic: boolean
  disabledLists: readonly string[]
  updateDays: number
  /** The user's own lists. They are never downloaded: their rules were read from a file or pasted, and live in the filters folder. They follow the `ads` option. */
  customLists?: readonly CustomFilterList[]
}

/** The lists in use: those of a switched-on category that the user did not switch off one by one. */
export function activeLists(catalog: readonly FilterListSpec[], config: Pick<BlockingConfig, 'ads' | 'cookieBanners' | 'disabledLists'>): FilterListSpec[] {
  return catalog.filter((list) => (list.category === 'ads' ? config.ads : config.cookieBanners) && !config.disabledLists.includes(list.id))
}

// ---------- checking a downloaded copy ----------

/** More than any real list weighs (EasyList is about 2.5 MB): a bound against a server that streams garbage. */
export const FILTER_LIST_MAX_CHARS = 30_000_000

/** A new copy with less than this share of the rules of the one it replaces is a truncated download, not an update. */
export const SHRINK_LIMIT = 0.5

export type ListVerdict = { ok: true; rules: number; title?: string } | { ok: false; reason: string }

/**
 * Whether downloaded text is a usable filter list. Nothing is installed unless this says yes, so a failed or hijacked
 * download (an HTML error page, a captive portal, a cut connection) leaves the previous copy in place.
 */
export function validateFilterList(text: string, options: { minRules?: number; previousRules?: number | null } = {}): ListVerdict {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: t('filter-lists.la-reponse-est-vide') }
  if (text.length > FILTER_LIST_MAX_CHARS) return { ok: false, reason: t('filter-lists.la-liste-est-anormalement-volumineuse') }
  if (text.includes('\u0000')) return { ok: false, reason: t('filter-lists.le-contenu-est-binaire') }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (/^\s*<(?:!doctype|html|head|body|\?xml)/i.test(body)) return { ok: false, reason: t('filter-lists.le-serveur-a-repondu-par-une-page-web-et-non') }

  let rules = 0
  let title: string | undefined
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('!')) {
      // "!#include other.txt" is read by uBlock Origin, not by our engine: the list would work with most of its rules missing, without a word.
      if (/^!#include\s+\S/.test(line)) return { ok: false, reason: t('filter-lists.la-liste-renvoie-a-d-autres-fichiers-include') }
      const match = /^!\s*Title:\s*(.+)$/i.exec(line)
      if (match && title === undefined) title = match[1]!.trim().slice(0, 120)
      continue
    }
    // "[Adblock Plus 2.0]" and the hosts-file "# comment" are not rules.
    if (line.startsWith('[') || line.startsWith('# ')) continue
    rules++
  }
  if (rules === 0) return { ok: false, reason: t('filter-lists.la-reponse-ne-contient-aucune-regle') }
  if (options.minRules !== undefined && rules < options.minRules) return { ok: false, reason: t('filter-lists.seulement-rules-regles-ce-n-est-pas-la-liste', { rules }) }
  const previous = options.previousRules
  if (previous && rules < previous * SHRINK_LIMIT) return { ok: false, reason: t('filter-lists.la-liste-a-perdu-plus-de-la-moitie-de-ses', { rules, previous }) }
  return { ok: true, rules, ...(title ? { title } : {}) }
}

// ---------- what matching a rule may cost ----------

// The filter engine turns each `*` of a rule into `.*` and runs the result, like the expressions the lists write themselves, on every
// request, in the main process. Two wildcards one after the other are tried in every pair of places, three in every triple: on an address
// made of the parts of the rule the time grows as a power of its length, and a page chooses the addresses it asks for. Two bounds keep one
// request from holding the browser: the engine is never given more than `FILTER_ADDRESS_MAX` characters of an address, and a rule that
// could cost more than `FILTER_STEP_BUDGET` on a text of that length is left out when the lists are compiled.

/** The characters of an address the filter engine is given. The host and the start of the path, which most rules name, are always in them. */
export const FILTER_ADDRESS_MAX = 2048
/**
 * The places one rule may make the engine try on one address: about a dozen milliseconds at the very worst (measured: 1.5 ns a place).
 * At `FILTER_ADDRESS_MAX` characters it lets through a rule with one wildcard anywhere, or two after a host; of the 130 000 network rules
 * of the lists of the catalog, fewer than 200 are over it.
 */
export const FILTER_STEP_BUDGET = 8_000_000

/** The start of an address that is given to the filter engine: all of it, unless it is longer than `FILTER_ADDRESS_MAX`. */
export function addressForFilters(url: string): string {
  return url.length > FILTER_ADDRESS_MAX ? url.slice(0, FILTER_ADDRESS_MAX) : url
}

/**
 * Why the regular expression a rule compiles to must not be run on an address a page chooses, in a few words for the journal, or null:
 * it can take a time that doubles with each character, or more than the budget on the longest address the engine is given.
 */
export function filterRuleHazard(regexSource: string): string | null {
  const hazard = regexHazard(regexSource)
  if (hazard !== null) return hazard
  return regexTextLimit(regexSource, FILTER_ADDRESS_MAX, FILTER_STEP_BUDGET) < FILTER_ADDRESS_MAX ? 'too many repetitions for a long address' : null
}

// ---------- what the settings show ----------

export interface FilterListState {
  id: string
  /** A copy of the list is installed on this machine. */
  installed: boolean
  /** When the copy was last fetched, or confirmed up to date by the server (ms since the epoch). */
  updatedAt: number | null
  rules: number | null
  /** The last attempt failed. The installed copy, if any, is still the one in use. */
  error: { message: string; at: number } | null
  updating: boolean
  /** A list of the user's (a file or pasted rules), not one of the catalog. */
  custom?: boolean
  /** For a list of the user's: the rules that were left out when it was read, and why (a few examples). */
  review?: ReviewSummary
}

export interface BlockingStatus {
  lists: FilterListState[]
  /** The compiled lists answer requests. Until then the short built-in list stands in. */
  engineReady: boolean
  updating: boolean
}

/** The numbers and dates the settings print follow the language of the interface. */
const locale = (): string => (getLanguage() === 'fr' ? 'fr-FR' : 'en-GB')
const formatDate = (at: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at)

/** How the counter reads under the site switch. */
export function blockedLabel(count: number): string {
  if (count === 0) return t('filter-lists.aucune-requete-bloquee')
  return tp('filter-lists.requetes-bloquees', count, { count: count.toLocaleString(locale()) })
}

/** What the line under a list in the settings says: the date of the last update, the failure that followed, or why there is no copy. */
export function listStatusLine(state: FilterListState | undefined, categoryOn: boolean, enabled: boolean): { text: string; error?: string } {
  if (!categoryOn) return { text: t('filter-lists.l-option-correspondante-est-desactivee') }
  if (!enabled) return { text: t('filter-lists.desactivee') }
  if (!state) return { text: t('filter-lists.pas-encore-telechargee') }
  const error = state.error
    ? `${t('filter-lists.echec-de-la-derniere-mise-a-jour-date-message', { date: formatDate(state.error.at), message: state.error.message })}${state.installed ? ` ${t('filter-lists.la-copie-precedente-reste-utilisee')}` : ''}`
    : undefined
  const failure = error ? { error } : {}
  if (state.updating) return { text: t('filter-lists.telechargement-en-cours'), ...failure }
  if (state.installed && state.updatedAt !== null) {
    return { text: `${t('filter-lists.verifiee-le-date', { date: formatDate(state.updatedAt) })}${state.rules !== null ? ` · ${tp('filter-lists.regles', state.rules, { count: state.rules.toLocaleString(locale()) })}` : ''}`, ...failure }
  }
  return { text: t('filter-lists.pas-encore-telechargee'), ...failure }
}
