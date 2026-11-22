// The privacy options: HTTPS first, Global Privacy Control, and removing the parameters that follow a visitor from link to link. All three are on
// for a new profile (the protection « Renforcée », settings-presets.ts); a saved file keeps its own. Pure rules: the engine applies them to the
// requests it sees (engine/electron-engine.ts, engine/https-upgrade.ts) and the settings window lets the user choose.

import type { Settings } from './model'
import { t } from './i18n'
import { cleanBlockExceptions } from './blocker'
import { hasLocalOnlySuffix } from './url'
import { bypassNavigation } from './redirect-bypass'

export interface PrivacyOptions {
  /** A main-frame navigation to `http://` goes to `https://` first, and falls back to `http://` when the site does not answer. */
  httpsUpgrade: boolean
  /** Every request carries `Sec-GPC: 1`: the user does not consent to the sale or sharing of their data. */
  globalPrivacyControl: boolean
  /** The known tracking parameters (`utm_*`, `fbclid`, `gclid`…) are removed from the address a main-frame navigation goes to. */
  stripTrackingParams: boolean
  /** The cookies of a request to another site than the tab's are not sent, and those of its answer are not kept (third-party-cookies.ts). */
  blockThirdPartyCookies: boolean
  /** The sites (and their subdomains) where third-party cookies are let through. */
  thirdPartyCookieExceptions: readonly string[]
  /** A link through a tracking redirector or an AMP viewer opens the address it leads to (redirect-bypass.ts). */
  unwrapRedirects: boolean
  /** The sites (and their subdomains) whose links are left as they are, at either end of the link. */
  unwrapExceptions: readonly string[]
  /** A request to another site carries the origin of the page as `Referer`, never its path or its query (referer-trim.ts). */
  trimReferer: boolean
  /** « HTTPS seul »: an `http://` page opens only on a click on « Continuer en HTTP », and a site with no HTTPS is never fallen back to by itself (https-upgrade.ts). */
  httpsOnly: boolean
  /** The sites (and their subdomains) that open over `http://` with no warning in « HTTPS seul ». */
  httpsOnlyExceptions: readonly string[]
}

export const NO_PRIVACY: PrivacyOptions = { httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [], unwrapRedirects: false, unwrapExceptions: [], trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] }

/** `blockPings` is not an option of the engine's hooks (the shell's request filter reads it, ping-block.ts), but it is cleaned with the others. */
export type PrivacySettings = Pick<Settings, 'httpsUpgrade' | 'sendGpc' | 'stripTrackingParams' | 'stripCopiedLinks' | 'blockThirdPartyCookies' | 'thirdPartyCookieExceptions' | 'unwrapRedirects' | 'unwrapExceptions' | 'blockPings' | 'trimReferer' | 'httpsOnly' | 'httpsOnlyExceptions'>

/** Sites in the list of exceptions: more than anyone writes by hand, and a bound for a hand-edited file. */
export const THIRD_PARTY_COOKIE_EXCEPTIONS_MAX = 200

/** The sites of the list as a saved file or a message may carry them: valid hosts, each once, at most `THIRD_PARTY_COOKIE_EXCEPTIONS_MAX`. */
export const cleanThirdPartyCookieExceptions = (raw: unknown): string[] => cleanBlockExceptions(raw).slice(0, THIRD_PARTY_COOKIE_EXCEPTIONS_MAX)

/** Sites in the list of exceptions of « HTTPS seul »: the same bound. */
export const HTTPS_ONLY_EXCEPTIONS_MAX = 200

/** The sites of the list as a saved file or a message may carry them: valid hosts, each once, at most `HTTPS_ONLY_EXCEPTIONS_MAX`. */
export const cleanHttpsOnlyExceptions = (raw: unknown): string[] => cleanBlockExceptions(raw).slice(0, HTTPS_ONLY_EXCEPTIONS_MAX)

export function privacyOptionsOf(settings: Partial<PrivacySettings>): PrivacyOptions {
  return {
    httpsUpgrade: settings.httpsUpgrade === true,
    globalPrivacyControl: settings.sendGpc === true,
    stripTrackingParams: settings.stripTrackingParams === true,
    blockThirdPartyCookies: settings.blockThirdPartyCookies === true,
    thirdPartyCookieExceptions: cleanThirdPartyCookieExceptions(settings.thirdPartyCookieExceptions),
    unwrapRedirects: settings.unwrapRedirects === true,
    unwrapExceptions: cleanBlockExceptions(settings.unwrapExceptions),
    trimReferer: settings.trimReferer === true,
    httpsOnly: settings.httpsOnly === true,
    httpsOnlyExceptions: cleanHttpsOnlyExceptions(settings.httpsOnlyExceptions)
  }
}

export function anyPrivacy(options: PrivacyOptions): boolean {
  return options.httpsUpgrade || options.globalPrivacyControl || options.stripTrackingParams || options.blockThirdPartyCookies || options.unwrapRedirects || options.trimReferer || options.httpsOnly
}

/** The privacy settings of a saved file: anything but `true` is off, so a damaged file never switches a rewrite on. */
export function cleanPrivacySettings(settings: Partial<PrivacySettings>): PrivacySettings {
  return { httpsUpgrade: settings.httpsUpgrade === true, sendGpc: settings.sendGpc === true, stripTrackingParams: settings.stripTrackingParams === true, stripCopiedLinks: settings.stripCopiedLinks === true, blockThirdPartyCookies: settings.blockThirdPartyCookies === true, thirdPartyCookieExceptions: cleanThirdPartyCookieExceptions(settings.thirdPartyCookieExceptions), unwrapRedirects: settings.unwrapRedirects === true, unwrapExceptions: cleanBlockExceptions(settings.unwrapExceptions), blockPings: settings.blockPings === true, trimReferer: settings.trimReferer === true, httpsOnly: settings.httpsOnly === true, httpsOnlyExceptions: cleanHttpsOnlyExceptions(settings.httpsOnlyExceptions) }
}

// ---------- Tracking parameters ----------

/** Parameters that identify a click, a campaign or a recipient and mean nothing to the page itself. Matched on the whole name, any case. */
const TRACKING_NAMES = new Set([
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', '_gl',
  'msclkid', 'yclid', '_openstat', 'twclid', 'ttclid', 'li_fat_id',
  'igshid', 'igsh',
  'mc_eid', 'mc_cid',
  '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking',
  'mkt_tok',
  'vero_id', 'vero_conv', 'oly_enc_id', 'oly_anon_id', 'wickedid', 'rb_clickid', '_bta_c', '_bta_tid',
  'trk_contact', 'trk_msg', 'trk_module', 'trk_sid'
])

/** Families of parameters: every name that starts with one of these (`utm_source`, `utm_medium`…). Only the `utm_` family is open-ended. */
const TRACKING_PREFIXES = ['utm_']

/** Matomo's campaign parameters, spelled out one by one: a bare `pk_` prefix would also catch an unrelated `pk_live` key that a page needs. */
const MATOMO_NAMES = ['pk_campaign', 'pk_kwd', 'pk_keyword', 'pk_source', 'pk_medium', 'pk_content', 'pk_cid', 'pk_vid']
for (const name of MATOMO_NAMES) TRACKING_NAMES.add(name)

export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase()
  return TRACKING_NAMES.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * The fixed list, for the documentation and the settings text: the exact names, then the families (`utm_*`). Nothing outside it is ever
 * removed from an address, copied or opened: a parameter that picks the page, the language or the item shown is not on it.
 */
export function trackingParamList(): string[] {
  return [...[...TRACKING_NAMES].sort(), ...TRACKING_PREFIXES.map((prefix) => `${prefix}*`)]
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return raw
  }
}

/**
 * The address without its tracking parameters, or null when there is nothing to remove (or it is not a web address). The other
 * parameters keep their order and their exact spelling: only whole `name=value` pieces leave the query string.
 */
export function stripTrackingParams(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search.length <= 1) return null
  const pieces = parsed.search.slice(1).split('&')
  const kept = pieces.filter((piece) => !isTrackingParam(decodeName(piece.split('=')[0] ?? '')))
  if (kept.length === pieces.length) return null
  parsed.search = kept.length > 0 ? `?${kept.join('&')}` : ''
  return parsed.href
}

// ---------- HTTPS first ----------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Addresses that only mean something on this machine or this network: loopback, private, link-local, shared (CGNAT), unspecified. */
function isPrivateIp(hostname: string): boolean {
  const v4 = IPV4.exec(hostname)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (hostname.startsWith('[')) {
    const v6 = hostname.slice(1, -1).toLowerCase()
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:')
  }
  return false
}

/** Whether a host may be tried over HTTPS: a public name (with a dot) or a public IP address. */
export function isUpgradableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return false
  if (IPV4.test(host) || host.startsWith('[')) return !isPrivateIp(host)
  if (!host.includes('.')) return false
  return !hasLocalOnlySuffix(host)
}

/**
 * The `https://` address to try for an `http://` one, or null when it should stay as it is: another scheme, a local or private host,
 * a port other than 80 (a server on 8080 rarely speaks TLS on 8080), or a login in the address.
 */
export function httpsUpgradeOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !isUpgradableHost(parsed.hostname) || (parsed.port !== '' && parsed.port !== '80')) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  parsed.protocol = 'https:'
  return parsed.href
}

/** "ce site ne répond pas en HTTPS": the notice when the upgrade failed and the page opened over HTTP. */
export function httpsFallbackNotice(host: string): string {
  return t('privacy.host-ne-repond-pas-en-https-la-page-s-ouvre-en', { host })
}

/** Seconds a site gets to start answering over HTTPS before the page opens over HTTP instead. */
export const HTTPS_UPGRADE_TIMEOUT_MS = 5000

// ---------- One request ----------

/** What `rewriteNavigation` needs to know of a request. */
export interface NavigationRequest {
  url: string
  method: string
  /** True for the document of a tab (not an image, a script or a frame). */
  isMainFrame: boolean
}

/**
 * Where a main-frame GET should go instead, per the options, or null to leave it. The wrapper of a tracking redirect or of an AMP viewer comes off first, then the tracking parameters, then the
 * result is upgraded: one rewrite per request, and each round only ever removes parameters or moves from http to https, so a
 * chain of redirects ends. `upgrade` is how the caller decides whether this http address may be upgraded now (it remembers the
 * addresses it already tried, which is what stops a site that sends https visitors back to http from looping).
 */
export function rewriteNavigation(request: NavigationRequest, options: PrivacyOptions, upgrade: (httpUrl: string) => string | null): string | null {
  if (!request.isMainFrame || request.method !== 'GET') return null
  let url = request.url
  let changed = false
  // First the wrapper comes off (the destination is what the next steps judge), then the parameters, then http to https.
  const bypassed = bypassNavigation(url, options)
  if (bypassed) {
    url = bypassed.url
    changed = true
  }
  if (options.stripTrackingParams) {
    const stripped = stripTrackingParams(url)
    if (stripped) {
      url = stripped
      changed = true
    }
  }
  // « HTTPS seul » upgrades the same way; what differs is what happens when the site does not answer (https-upgrade.ts): there is no fall back.
  if (options.httpsUpgrade || options.httpsOnly) {
    const upgraded = upgrade(url)
    if (upgraded && upgraded !== url) return upgraded
  }
  return changed ? url : null
}
