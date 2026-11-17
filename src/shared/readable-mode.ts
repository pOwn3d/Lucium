// Page contrast (« Contraste de la page », “Page Contrast”; the code, the saved state and the channels keep its first name, readable mode): the
// colours a page is shown in. Original leaves a site as it made itself, Dark turns a light page dark, Light turns a dark
// page light. The choice is made per site, with a default for every site that has none (Original: nothing happens until the user chooses).
//
// This file is the choice: the settings, how they are cleaned and migrated, and which mode a page gets. What a mode does to a page, and how a
// page is told dark from light, is in dark-sites.ts (`readablePlan`, `applyReadable`) and the engine it runs (readable-engine.ts).

import { normalizeBlockHost } from './blocker'
import type { Settings, TabItem } from './model'
import { t } from './i18n'

/** What a page can be shown as. */
export const READABLE_MODES = ['original', 'dark', 'light'] as const
export type ReadableMode = (typeof READABLE_MODES)[number]

/**
 * What the default for every site can be: a mode, or `auto`, which follows the appearance of the interface: Dark while it is dark, Original while
 * it is light (a dark site is not made light by the light appearance). A site's own choice is never `auto`.
 */
export const READABLE_DEFAULTS = [...READABLE_MODES, 'auto'] as const
export type ReadableDefault = (typeof READABLE_DEFAULTS)[number]

export const DEFAULT_READABLE: ReadableDefault = 'original'

/** Sites with a mode of their own: more than anyone sets by hand, and a bound for a hand-edited file (the old exception list was bounded at 200). */
export const SITE_READABLE_MAX = 500

export const isReadableMode = (value: unknown): value is ReadableMode => (READABLE_MODES as readonly unknown[]).includes(value)
export const isReadableDefault = (value: unknown): value is ReadableDefault => (READABLE_DEFAULTS as readonly unknown[]).includes(value)

/** What the interface says for each choice: the name in a menu, and the sentence under it (read when drawn: the texts follow the language chosen). */
export const READABLE_LABELS: Record<ReadableDefault, { name: string; hint: string }> = {
  original: { get name() { return t('readable-mode.original') }, get hint() { return t('readable-mode.les-pages-gardent-les-couleurs-de-leur-site') } },
  dark: { get name() { return t('readable-mode.sombre') }, get hint() { return t('readable-mode.les-pages-claires-sont-assombries-images-et') } },
  light: { get name() { return t('readable-mode.clair') }, get hint() { return t('readable-mode.les-pages-sombres-sont-eclaircies-images-et') } },
  auto: { get name() { return t('readable-mode.automatique') }, get hint() { return t('readable-mode.sombre-quand-l-apparence-est-sombre-suit-le') } }
}

/** A saved default: a word that is not one of the four is Original, the choice that touches no page. */
export const cleanReadableDefault = (value: unknown): ReadableDefault => (isReadableDefault(value) ? value : DEFAULT_READABLE)

/** The pairs of a list of sites and modes as a record: a site written any way the user likes is kept under its host, a mode that is not one of the three is dropped, the list is bounded. */
function collect(entries: Iterable<readonly [unknown, unknown]>): Record<string, ReadableMode> {
  const out = new Map<string, ReadableMode>()
  for (const [site, mode] of entries) {
    // A prototype key is not a host, so it never gets in (`normalizeBlockHost` refuses it).
    const host = normalizeBlockHost(site)
    if (host === null || !isReadableMode(mode)) continue
    if (!out.has(host) && out.size >= SITE_READABLE_MAX) continue
    out.set(host, mode)
  }
  return Object.fromEntries(out)
}

/** The per-site modes of a saved or imported file (shaped like `cleanSiteBlockModes`). */
export function cleanSiteReadable(raw: unknown): Record<string, ReadableMode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return collect(Object.entries(raw))
}

/**
 * The choices with `mode` set for `site`. `null` gives the site back to the default: every entry that covers the site is taken out (its own, or
 * a parent domain's), as `withSiteBlockMode` does, so that the site then follows the default, which is what was asked. A new object.
 */
export function withSiteReadable(choices: Readonly<Record<string, ReadableMode>>, site: unknown, mode: unknown): Record<string, ReadableMode> {
  const host = normalizeBlockHost(site)
  if (host === null) return { ...choices }
  if (mode === null) return Object.fromEntries(Object.entries(choices).filter(([entry]) => host !== entry && !host.endsWith(`.${entry}`)))
  if (!isReadableMode(mode)) return { ...choices }
  // A full list refuses a new site; a site already on it can still change.
  if (!Object.hasOwn(choices, host) && Object.keys(choices).length >= SITE_READABLE_MAX) return { ...choices }
  return { ...choices, [host]: mode }
}

/** The mode a site added by hand in the settings starts with: the opposite of the default, which is what one adds a site for (Dark where sites are left as they are, Original where they are not). */
export const newSiteMode = (readableMode: ReadableDefault): ReadableMode => (readableMode === 'original' ? 'dark' : 'original')

/** The host a page's address stands for, as the choices are keyed (no "www.", no final dot); null for an address with no host. */
function hostOfPage(pageUrl: string | null | undefined): string | null {
  if (!pageUrl || !URL.canParse(pageUrl)) return null
  const host = new URL(pageUrl).hostname.replace(/^www\./, '').replace(/\.$/, '')
  return host === '' ? null : host
}

/**
 * The mode a page's site has of its own: the one of its host, else of the nearest parent domain that has one ("m.example.com" follows
 * "example.com", and "music.example.com" wins over "example.com" when both are set). Null when no site of the page has a choice.
 */
export function siteReadableOf(choices: Readonly<Record<string, ReadableMode>> | undefined, pageUrl: string | null | undefined): ReadableMode | null {
  const host = choices ? hostOfPage(pageUrl) : null
  if (!choices || host === null) return null
  const labels = host.split('.')
  for (let at = 0; at < labels.length; at++) {
    const key = labels.slice(at).join('.')
    // Own keys only: a host called "constructor" must not read the prototype.
    if (Object.hasOwn(choices, key)) return choices[key] ?? null
  }
  return null
}

/** A web page: the only kind a mode is given to (not the interface's own pages, files, or garbage). */
export const isReadableWebPage = (pageUrl: string | null | undefined): boolean => !!pageUrl && /^https?:\/\//i.test(pageUrl) && URL.canParse(pageUrl)

// A PDF is drawn by the viewer, not by a page of ours: inverting it would only scramble its images.
const PDF_PATH = /\.pdf$/i

/** A web page that is not a PDF: the only kind of page a mode is given to, and so the only kind a control of the mode is offered for. */
export const takesReadableMode = (pageUrl: string | null | undefined): boolean => isReadableWebPage(pageUrl) && !PDF_PATH.test(new URL(pageUrl!).pathname)

type ReadableChoice = Pick<Settings, 'readableMode' | 'siteReadableMode'>

/**
 * The mode a page is shown in, before looking at the page: a web page that is not a PDF gets its site's own choice, else the default, and the
 * default `auto` is Dark while `systemDark` and Original otherwise. Everything else is Original. Whether the page really is light or dark
 * is not known here: `readablePlan` (dark-sites.ts) decides from what the page looks like.
 */
export function readableModeFor(settings: ReadableChoice, pageUrl: string | null | undefined, systemDark: boolean): ReadableMode {
  if (!takesReadableMode(pageUrl)) return 'original'
  const chosen = siteReadableOf(settings.siteReadableMode, pageUrl) ?? settings.readableMode
  return chosen === 'auto' ? (systemDark ? 'dark' : 'original') : chosen
}

/**
 * What the toolbar button « Contraste de la page » shows for the page on screen, or null where the button is not drawn: the mode the page is given (its site's
 * own choice, else the default, `auto` resolved by `systemDark`). Only for a web page that is not a PDF, with the button's setting on, and never for a
 * private tab or in a private window (their sites are not written to the settings, as the site control center says).
 */
export function readableButtonMode(settings: ReadableChoice & Pick<Settings, 'readableToolbarButton'>, tab: Pick<TabItem, 'url' | 'private'> | undefined, privateWindow: boolean, systemDark: boolean): ReadableMode | null {
  if (!settings.readableToolbarButton || privateWindow || !tab || tab.private === true || !takesReadableMode(tab.url)) return null
  return readableModeFor(settings, tab.url, systemDark)
}

/** The mode a click on the toolbar button « Contraste de la page » moves a page to: Original, then Dark, then Light, then Original again. */
export const READABLE_NEXT: Readonly<Record<ReadableMode, ReadableMode>> = { original: 'dark', dark: 'light', light: 'original' }

/**
 * What a click on the toolbar button « Contraste de la page » sets for the page's site, or null where the button does nothing (a page that takes no mode): the
 * mode after the one the page has (`READABLE_NEXT`). `mode` is what `readable/site` is given: null takes the site's entry out, so that the site follows the
 * default, and is chosen when the default already gives the next mode and the entry is the site's own alone (the list stays clean). An entry of a parent
 * domain also covers other sites, so a click on a subdomain never takes it out: the subdomain gets an entry of its own instead.
 */
export function readableToggle(settings: ReadableChoice, pageUrl: string | null | undefined, systemDark: boolean): { mode: ReadableMode | null } | null {
  const host = hostOfPage(pageUrl)
  if (host === null || !takesReadableMode(pageUrl)) return null
  const target = READABLE_NEXT[readableModeFor(settings, pageUrl, systemDark)]
  const byDefault = readableModeFor({ readableMode: settings.readableMode, siteReadableMode: {} }, pageUrl, systemDark)
  const covering = Object.keys(settings.siteReadableMode).filter((key) => host === key || host.endsWith(`.${key}`))
  const ownEntryAlone = covering.length === 1 && covering[0] === host
  return { mode: byDefault === target && ownEntryAlone ? null : target }
}

/** Whether any page can be given a mode other than Original: the common case (nothing chosen) is told without looking at a page. */
export function readableInUse(settings: ReadableChoice): boolean {
  return settings.readableMode !== 'original' || Object.values(settings.siteReadableMode).some((mode) => mode !== 'original')
}

/** Whether the mode of some page depends on the appearance of the interface (only the default `auto` does), so that a change of appearance must look at the pages again. */
export const readableFollowsSystem = (settings: Pick<Settings, 'readableMode'>): boolean => settings.readableMode === 'auto'

export type ReadableSettings = ReadableChoice

/** The settings of a saved file: a default that is not one of the four is Original, a list of the wrong kind is empty. */
export function cleanReadableSettings(settings: Partial<ReadableChoice>): ReadableSettings {
  return { readableMode: cleanReadableDefault(settings.readableMode), siteReadableMode: cleanSiteReadable(settings.siteReadableMode) }
}

/** The three settings of the forced dark mode, as an older file holds them (they no longer exist: `readableFromForcedDark` reads them once). */
export interface ForcedDarkSettings {
  forceDarkSites?: unknown
  forceDarkOnlyWhenSystemDark?: unknown
  forceDarkExceptions?: unknown
}

/**
 * The readable mode an older file's forced dark mode becomes, with the same effect: the switch on is the default Dark (the option "only while the
 * interface is dark" makes it `auto`, which is Dark in a dark interface and nothing in a light one), the switch off is Original, and each excepted
 * site keeps its colours with its own Original. The option of a switch that is off was never read, and is not kept.
 */
export function readableFromForcedDark(old: ForcedDarkSettings): ReadableSettings {
  const hosts = Array.isArray(old.forceDarkExceptions) ? old.forceDarkExceptions : []
  return {
    readableMode: old.forceDarkSites === true ? (old.forceDarkOnlyWhenSystemDark === true ? 'auto' : 'dark') : 'original',
    siteReadableMode: collect(hosts.map((host): [unknown, unknown] => [host, 'original']))
  }
}
