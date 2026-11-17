// Ad, tracker and cookie-banner blocking: the rules that do not depend on a filter engine. A small built-in list of
// third-party hosts (it stands in until the real filter lists are installed, see src/main/blocking/), the request types the
// engines understand, and the per-site exceptions. Never applied to the page the user opened.

import { defaultSettings, type BlockMode, type Settings } from './model'
import { STAND_IN_SCHEME, isStandInAddress } from './redirect-resources'
import { t } from './i18n'
import { cleanHostEntries, normalizeHostEntry } from './host-entry'

// ---------- the gate: which switch filters what ----------
// The blocker has two switches and each filters exactly its own lists. They are read HERE and nowhere else (a gate decided by hand at
// another place drifts: the Settings switch once showed the trackers blocked while the request filter was off).
//  - Ads and trackers: ONE switch, `blockAds`, and its alias `blockTrackers` (older state files may carry the alias alone, the switch of the
//    Settings writes both, see `adsBlockingPatch`, and so does the registry of features, features.ts: `featurePatch('block-ads', …)`). Either one on means the ad and tracker lists apply: the lists of the catalog in the `ads` category
//    (the ad lists and the tracker lists are compiled together), the built-in short list, the hosts of the extra blocking, the YouTube rules,
//    the user's own lists, and, with `blockCosmetic`, the hiding of the ads in the page.
//  - Cookie banners: `blockCookieBanners` alone: the `cookies` category of the catalog, the built-in banner hosts, the hiding of the banners.
// The blocker as a whole filters when either of the two is on (`blockerIsOn`); with both off nothing is read, compiled or counted.

/** The ads and trackers are blocked when `blockAds` or its alias `blockTrackers` is on: the blocker reads either. */
export const adsBlockingOn = (settings: Pick<Settings, 'blockAds' | 'blockTrackers'>): boolean => settings.blockAds || settings.blockTrackers === true

/** What the one switch of the Settings writes: the setting and its alias together, so that off is off whatever an older state file held. */
export const adsBlockingPatch = (on: boolean): Pick<Settings, 'blockAds' | 'blockTrackers'> => ({ blockAds: on, blockTrackers: on })

/** The blocker works when any of its ad/tracker or cookie options is on: that is what the service is configured with (nothing is read or counted otherwise). */
export const blockerIsOn = (settings: Pick<Settings, 'blockAds' | 'blockTrackers' | 'blockCookieBanners'>): boolean => adsBlockingOn(settings) || settings.blockCookieBanners

/** Advertising and tracking networks. A host matches itself and its subdomains. */
export const AD_TRACKER_HOSTS: readonly string[] = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'adservice.google.com', '2mdn.net',
  'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'scorecardresearch.com', 'quantserve.com',
  'quantcount.com', 'amazon-adsystem.com', 'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'ads-twitter.com', 'bat.bing.com', 'clarity.ms', 'hotjar.com', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'chartbeat.com',
  'adform.net', 'smartadserver.com', 'teads.tv', 'serving-sys.com', 'yieldmo.com', 'sharethrough.com', 'bidswitch.net', 'demdex.net',
  'krxd.net', 'bluekai.com', 'exelator.com', 'rlcdn.com', 'agkn.com', 'tapad.com', 'everesttech.net', 'mathtag.com', 'ml314.com',
  'adition.com', 'ioam.de', 'xiti.com', 'pixel.facebook.com'
]

/** Consent-management platforms: blocking their scripts is what removes the banner. */
export const COOKIE_BANNER_HOSTS: readonly string[] = [
  'cookiebot.com', 'cookielaw.org', 'onetrust.com', 'trustarc.com', 'consensu.org', 'usercentrics.eu', 'privacy-center.org',
  'didomi.io', 'osano.com', 'iubenda.com', 'cookiefirst.com', 'cookie-script.com', 'termly.io', 'consentmanager.net', 'sourcepoint.com',
  'sp-prod.net', 'cookiehub.net', 'axept.io', 'civiccomputing.com'
]

/**
 * What the blocker answers for one request: let it through (false), cancel it (true), or have the page fetch `redirect` instead (a stand-in
 * resource as a `data:` address, or the same address without the parameters a rule removes).
 */
export type RequestVerdict = boolean | { redirect: string }

/** The longest address the session is sent to: the stand-in scripts are a few kilobytes once encoded. */
export const REDIRECT_MAX_CHARS = 20_000

/**
 * The address a verdict may send a request to: a web address, or exactly one of the addresses of the stand-in resources. Anything else
 * (a `file:` or `chrome-extension:` address, a `javascript:` or `data:` one, another scheme of ours, a huge one, a value that is not text) is refused, whatever asked for it.
 */
export function safeRedirectTarget(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > REDIRECT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (value.startsWith(`${STAND_IN_SCHEME}:`)) return isStandInAddress(value) ? value : null
  return /^https?:\/\//i.test(value) && URL.canParse(value) ? value : null
}

/** Response headers as Electron hands them over: a name, then the values of that header. */
export type ResponseHeaders = Record<string, string[]>

/**
 * The headers with a Content-Security-Policy added. A policy can only restrict a page, and a document may carry several: the one added
 * sits next to those the server sent. The same object when there is nothing to add.
 */
export function withContentSecurityPolicy(headers: ResponseHeaders, policy: string | null): ResponseHeaders {
  if (policy === null || policy === '') return headers
  const existing = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy')
  return existing === undefined ? { ...headers, 'Content-Security-Policy': [policy] } : { ...headers, [existing]: [...(headers[existing] ?? []), policy] }
}

export interface BlockerOptions {
  ads: boolean
  cookieBanners: boolean
}

/** True for the host itself or any subdomain of it: "ads.doubleclick.net" matches "doubleclick.net", "notdoubleclick.net" does not. */
export function hostIn(host: string, list: readonly string[]): boolean {
  const name = host.toLowerCase()
  return list.some((entry) => name === entry || name.endsWith(`.${entry}`))
}

/**
 * Whether a request must be cancelled. `pageUrl` is the page that makes it. Navigations are never blocked, and a site is
 * never blocked from loading its own resources (visiting a network's own domain must still work).
 */
export function shouldBlock(
  request: { url: string; resourceType: string },
  pageUrl: string | null,
  options: BlockerOptions,
  extraHosts: readonly string[] = []
): boolean {
  const entries = [...(options.ads ? [...AD_TRACKER_HOSTS, ...extraHosts] : []), ...(options.cookieBanners ? COOKIE_BANNER_HOSTS : [])]
  return blockedByHosts(request, pageUrl, entries)
}

/** The host check behind `shouldBlock`, for any list of hosts. */
export function blockedByHosts(request: { url: string; resourceType: string }, pageUrl: string | null, hosts: readonly string[]): boolean {
  if (request.resourceType === 'mainFrame' || !URL.canParse(request.url)) return false
  const host = new URL(request.url).hostname
  const pageHost = pageUrl && URL.canParse(pageUrl) ? new URL(pageUrl).hostname : ''
  const entry = hosts.find((e) => hostIn(host, [e]))
  // A network's own site (or one of its subdomains) loads its own resources freely.
  return entry !== undefined && !(pageHost && hostIn(pageHost, [entry]))
}

// ---------- request types ----------

/** The names of the `chrome.webRequest` resource types, which the filter engines read. */
export type RequestKind =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'other'

const KINDS: Readonly<Record<string, RequestKind>> = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
}

/** Electron's resource type (`details.resourceType`) as the filter engines name it. A type nobody knows is `other`, never a guess. */
export function toRequestKind(electronType: string): RequestKind {
  return Object.hasOwn(KINDS, electronType) ? KINDS[electronType]! : 'other'
}

// ---------- sites where nothing is blocked ----------

/** Sites in the list: more than anyone writes by hand, and a bound for a hand-edited file. */
export const BLOCK_EXCEPTIONS_MAX = 200

/** The longest text read as a site: a host name and what a person may leave around it. */
const ENTRY_MAX = 300

/**
 * The host a typed address stands for: lower case, no scheme, port, path or leading "www.". Null when it is not a host name.
 * A pasted address works, so does "*.example.com".
 */
export function normalizeBlockHost(input: unknown): string | null {
  return normalizeHostEntry(input, ENTRY_MAX)
}

/** What a saved list may hold: valid hosts only, each once, in order. Anything else is dropped. */
export function cleanBlockExceptions(value: unknown): string[] {
  return cleanHostEntries(value, normalizeBlockHost, BLOCK_EXCEPTIONS_MAX)
}

const covers = (entry: string, host: string) => host === entry || host.endsWith(`.${entry}`)

/** Whether a page (its address) is on a listed host or one of its subdomains: nothing is blocked there. */
export function isBlockingExempt(pageUrl: string | null, hosts: readonly string[]): boolean {
  if (hosts.length === 0 || !pageUrl || !URL.canParse(pageUrl)) return false
  // `site.example.` (a fully qualified name, with its final dot) is the same site as `site.example`: `normalizeBlockHost` drops the dot, so must this.
  const host = new URL(pageUrl).hostname.replace(/^www\./, '').replace(/\.$/, '')
  return hosts.some((entry) => covers(entry, host))
}

/**
 * The list with a site added or taken out. Adding a site a listed domain already covers changes nothing. Taking a site out
 * removes every entry that covers it, itself or a parent domain: blocking is then back on there, which is what was asked.
 */
export function setBlockingExempt(hosts: readonly string[], site: string, exempt: boolean): string[] {
  const host = normalizeBlockHost(site)
  if (!host) return [...hosts]
  if (!exempt) return hosts.filter((entry) => !covers(entry, host))
  return hosts.some((entry) => covers(entry, host)) ? [...hosts] : cleanBlockExceptions([...hosts, host])
}

/** What the settings list does with a typed site: the host to add, or the sentence that says why not. */
export function checkBlockException(input: string, hosts: readonly string[]): { host: string } | { error: string } {
  const host = normalizeBlockHost(input)
  if (!host) return { error: t('site-privacy-settings.cette-adresse-de-site-n-est-pas-valide') }
  const parent = hosts.find((entry) => covers(entry, host))
  if (parent === host) return { error: t('site-privacy-settings.ce-site-est-deja-dans-la-liste') }
  if (parent) return { error: t('blocker.ce-site-est-deja-couvert-par-parent', { parent }) }
  if (hosts.length >= BLOCK_EXCEPTIONS_MAX) return { error: t('site-privacy-settings.la-liste-est-pleine') }
  return { host }
}

// ---------- reading the settings of a saved file ----------

export const FILTER_UPDATE_DAYS_MAX = 90

export const BLOCK_MODES: readonly BlockMode[] = ['standard', 'strict']

/** A saved mode that is not one of the two falls back to Standard, the default: an unknown word must not switch the stricter filtering on or off by accident. */
export function cleanBlockMode(value: unknown): BlockMode {
  return BLOCK_MODES.find((mode) => mode === value) ?? defaultSettings().blockMode
}
const LIST_ID = /^[a-z0-9-]{1,40}$/

/** The blocking settings of a saved file: a value of the wrong kind falls back to the default instead of reaching the blocker. */
export function cleanBlockingSettings(settings: Settings): Pick<Settings, 'blockCosmetic' | 'filterUpdateDays' | 'disabledFilterLists' | 'blockExceptions' | 'popupExceptions' | 'blockMode' | 'blockModeSites'> {
  const defaults = defaultSettings()
  const days = settings.filterUpdateDays
  const off = Array.isArray(settings.disabledFilterLists) ? settings.disabledFilterLists : []
  return {
    blockCosmetic: typeof settings.blockCosmetic === 'boolean' ? settings.blockCosmetic : defaults.blockCosmetic,
    filterUpdateDays: Number.isInteger(days) && days >= 1 && days <= FILTER_UPDATE_DAYS_MAX ? days : defaults.filterUpdateDays,
    disabledFilterLists: [...new Set(off.filter((id): id is string => typeof id === 'string' && LIST_ID.test(id)))].slice(0, 50),
    blockExceptions: cleanBlockExceptions(settings.blockExceptions),
    popupExceptions: cleanBlockExceptions(settings.popupExceptions),
    blockMode: cleanBlockMode(settings.blockMode),
    blockModeSites: cleanSiteBlockModes(settings.blockModeSites)
  }
}

// ---------- the mode of one site ----------

/** Sites with a mode of their own: more than anyone sets by hand, and a bound for a hand-edited file. */
export const SITE_BLOCK_MODES_MAX = 200

const isBlockMode = (value: unknown): value is BlockMode => (BLOCK_MODES as readonly unknown[]).includes(value)

/**
 * The per-site modes of a saved file: a site written any way the user likes is kept under its host (`normalizeBlockHost`), a mode that is
 * not one of the two is dropped, and the list is bounded. Shaped like `cleanSiteAutoplay`: a prototype key is not a host, so it never gets in.
 */
export function cleanSiteBlockModes(raw: unknown): Record<string, BlockMode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out = new Map<string, BlockMode>()
  for (const [site, mode] of Object.entries(raw)) {
    const host = normalizeBlockHost(site)
    if (host === null || !isBlockMode(mode)) continue
    if (!out.has(host) && out.size >= SITE_BLOCK_MODES_MAX) continue
    out.set(host, mode)
  }
  return Object.fromEntries(out)
}

/**
 * The choices with `mode` set for `site`. `null` gives the site back to the general mode: every entry that covers the site is taken out
 * (its own, or a parent domain's), as `setBlockingExempt` does for the exceptions. Returns a new object.
 */
export function withSiteBlockMode(choices: Readonly<Record<string, BlockMode>>, site: unknown, mode: unknown): Record<string, BlockMode> {
  const host = normalizeBlockHost(site)
  if (host === null) return { ...choices }
  if (mode === null) return Object.fromEntries(Object.entries(choices).filter(([entry]) => !covers(entry, host)))
  if (!isBlockMode(mode)) return { ...choices }
  // A full list refuses a new site; a site already on it can still change.
  if (!Object.hasOwn(choices, host) && Object.keys(choices).length >= SITE_BLOCK_MODES_MAX) return { ...choices }
  return { ...choices, [host]: mode }
}

/**
 * The mode a page's site has of its own: the one of its host, else of the nearest parent domain that has one ("m.example.com" follows
 * "example.com", and "music.example.com" wins over "example.com" when both are set). Null when no site of the page has a choice.
 */
export function siteBlockModeOf(choices: Readonly<Record<string, BlockMode>> | undefined, pageUrl: string | null): BlockMode | null {
  if (!choices || !pageUrl || !URL.canParse(pageUrl)) return null
  const host = new URL(pageUrl).hostname.replace(/^www\./, '').replace(/\.$/, '')
  const labels = host.split('.')
  for (let at = 0; at < labels.length; at++) {
    const key = labels.slice(at).join('.')
    // Own keys only: a host called "constructor" must not read the prototype.
    if (Object.hasOwn(choices, key)) return choices[key] ?? null
  }
  return null
}

/** The mode the blocker judges a page's requests with: the site's own mode when it has one, else the general `blockMode`. */
export function blockModeFor(settings: Pick<Settings, 'blockMode'> & Partial<Pick<Settings, 'blockModeSites'>>, pageUrl: string | null): BlockMode {
  return siteBlockModeOf(settings.blockModeSites, pageUrl) ?? settings.blockMode
}

const BANNER_SELECTORS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '.qc-cmp2-container',
  '#didomi-host', '#usercentrics-root', '.cc-window', '.cc-banner', '#cookie-law-info-bar', '#cookieChoiceInfo', '.osano-cm-window',
  '#truste-consent-track', '[id^="sp_message_container"]', '#cmpbox', '#cmpwrapper'
]

/** Classes that Sourcepoint and Didomi put on the page while their consent wall is open, and which lock the scrolling (observed on theguardian.com). */
const SCROLL_LOCK_CLASSES = ['sp-message-open', 'didomi-popup-open']

/**
 * Hides the known consent containers and undoes the scroll lock of the platforms above. Static: it needs no look at the page's markup,
 * and it stays on when the cookie lists are installed, because those answer many walls with scriptlets (a click on "Accept all")
 * that this application does not run: without it a wall such as the Guardian's stays on screen and the page cannot be scrolled.
 */
export function consentWallCss(): string {
  const unlock = SCROLL_LOCK_CLASSES.flatMap((name) => [`html.${name}`, `html.${name} body`, `body.${name}`])
  return `${BANNER_SELECTORS.join(',\n')} { display: none !important; }\n${unlock.join(',\n')} { overflow: auto !important; position: static !important; }`
}

/** The stand-in until the cookie lists are compiled: the consent containers, and the scrolling given back to every page. */
export function cookieBannerCss(): string {
  return `${consentWallCss()}\nhtml, body { overflow: auto !important; }`
}
