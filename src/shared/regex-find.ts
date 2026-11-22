// Find in page by regular expression (the ".*" button of the find bar). Electron's `findInPage` takes a plain string, so the search is
// done by us: the page's text is read by a script in an isolated world, the expression is run in a worker thread of the main process
// (a runaway expression is abandoned there, the page and the interface never wait for it), and the matches are painted back with the
// CSS Custom Highlight API. The expression is never sent to the page. See main/engine/regex-find.ts for the machinery.

import { FIND_PANEL, FIND_PANEL_WIDE, type FindOptions } from './ipc'
import type { FindState, Settings } from './model'
import { t } from './i18n'

/** Longest expression taken (characters). */
export const REGEX_PATTERN_MAX = 500
/** Matches counted and painted; the bar then says "n/2000+". */
export const REGEX_MATCH_MAX = 2000
/** Characters of page text read; a longer page is searched up to there, and the bar says "+". */
export const REGEX_TEXT_MAX = 4_000_000
/** Time given to the expression, worker start-up included. */
export const REGEX_TIME_LIMIT_MS = 800
/** Longest text the find bar sends (plain or regular expression). */
export const FIND_TEXT_MAX = 2000

export type RegexFindError = NonNullable<FindState['error']>

/** What the counter of the bar says instead of "n/m" when the expression gave nothing to show. */
export const REGEX_ERROR_LABELS: Record<RegexFindError, string> = {
  get invalid() { return t('regex-find.motif-invalide') },
  get 'too-long'() { return t('regex-find.motif-trop-long') },
  get slow() { return t('regex-find.trop-lent') },
  get failed() { return t('site-data.echec') },
  get unsupported() { return t('regex-find.non-pris-en-charge') }
}

/** More about each error, for the tooltip of the counter. */
export const REGEX_ERROR_DETAILS: Record<RegexFindError, string> = {
  get invalid() { return t('regex-find.cette-expression-reguliere-n-est-pas-valide') },
  get 'too-long'() { return t('regex-find.une-expression-reguliere-ne-depasse-pas-max-caracteres', { max: REGEX_PATTERN_MAX }) },
  get slow() { return t('regex-find.l-expression-a-ete-abandonnee-elle-met-trop-de-temps') },
  get failed() { return t('regex-find.la-recherche-n-a-pas-pu-lire-la-page') },
  get unsupported() { return t('regex-find.cette-version-du-moteur-ne-peut-pas-surligner') }
}

/** The text of the counter: "3/12", with a "+" when the count stopped at a limit, or the reason there is no count. */
export function findCounterText(find: Pick<FindState, 'matches' | 'ordinal' | 'error' | 'more'> | null | undefined): string {
  if (find?.error) return REGEX_ERROR_LABELS[find.error]
  return `${find?.ordinal ?? 0}/${find?.matches ?? 0}${find?.more ? '+' : ''}`
}

/** What the find bar sent, checked: booleans only, nothing else kept. */
export function parseFindOptions(raw: unknown): FindOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: FindOptions = {}
  for (const key of ['forward', 'next', 'matchCase', 'regex', 'wholeWord', 'accents'] as const) {
    if (Object.hasOwn(source, key) && typeof source[key] === 'boolean') out[key] = source[key]
  }
  return out
}


/**
 * What the find bar asked for, as far as the setting allows: with `findRegex` off the buttons do not exist, so a request for the regular
 * expression, the whole words or the accents is not honoured, whatever the interface sent. The case option is Chromium's own and always is.
 */
export function allowedFindOptions(options: FindOptions, settings: Pick<Settings, 'findRegex'>): FindOptions {
  if (settings.findRegex) return options
  const { regex: _regex, wholeWord: _wholeWord, accents: _accents, ...plain } = options
  return plain
}

/** Whether the search is done by our engine: Chromium's own takes a plain string and nothing else: no expression, no whole words, no say on the accents. */
export const usesOwnEngine = (options: FindOptions): boolean => options.regex === true || options.wholeWord === true || options.accents === true

/** The expression our engine runs: what was typed when it is an expression, else that text taken literally. */
export const findPattern = (text: string, options: FindOptions): string => (options.regex === true ? text : text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))

/** The find panel with its buttons (setting on) is wider than the plain one. */
export const findPanelFor = (settings: Pick<Settings, 'findRegex'>): typeof FIND_PANEL | typeof FIND_PANEL_WIDE => (settings.findRegex ? FIND_PANEL_WIDE : FIND_PANEL)

export type FindToggle = 'regex' | 'matchCase' | 'wholeWord' | 'accents'
export type FindToggles = Record<FindToggle, boolean>
export const NO_FIND_TOGGLES: FindToggles = { regex: false, matchCase: false, wholeWord: false, accents: false }

/** What the find bar sends: `more` (the step, the direction) and the buttons that are pressed, which exist only with the setting on. */
export function findRequest(toggles: FindToggles, available: boolean, more: FindOptions = {}): FindOptions {
  if (!available) return more
  const pressed = Object.fromEntries((Object.keys(toggles) as FindToggle[]).filter((key) => toggles[key]).map((key) => [key, true])) as FindOptions
  return { ...more, ...pressed }
}
