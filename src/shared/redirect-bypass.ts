// Bypass of tracking redirects and AMP wrappers: a link that goes through a redirector (l.facebook.com, google.com/url…) or through an AMP
// viewer or cache opens the address it was meant for. Pure rules, local, no service and no request: only the redirectors that write the
// destination INSIDE their own address are unwrapped. A redirector that keeps the destination on its server (t.co, bit.ly, the click
// links of e-mails) cannot be resolved without asking it, so it is left alone. The engine applies this to main-frame navigations
// (privacy.ts `rewriteNavigation`); the settings window and the site panel let the user choose.

import { isBlockingExempt, normalizeBlockHost, setBlockingExempt } from './blocker'

export type BypassKind = 'redirect' | 'amp'

export interface Bypass {
  url: string
  kind: BypassKind
}

/** What the rules need of the privacy options: the switch and the sites left alone. */
export interface BypassOptions {
  unwrapRedirects: boolean
  unwrapExceptions: readonly string[]
}

interface Redirector {
  /** Whole host name (lower case, without the leading "www."). */
  host: RegExp
  path: RegExp
  /** The query parameters that may carry the destination, in order. */
  params: readonly string[]
  /** Reads the value of the parameter into an address; the default takes it as it is. */
  decode?: (value: string) => string | null
}

/** Bing writes the destination in `u` as "a1" followed by its base64url form. Checked beforehand, so that nothing here can throw. */
function decodeBing(value: string): string | null {
  const body = value.slice(2)
  if (!value.startsWith('a1') || !/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) return null
  const binary = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

const REDIRECTORS: readonly Redirector[] = [
  { host: /^google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/url$/, params: ['q', 'url'] },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.messenger\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.instagram\.com$/, path: /^\/$/, params: ['u'] },
  { host: /^out\.reddit\.com$/, path: /^\//, params: ['url'] },
  { host: /^youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
  { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, params: ['u', 'url'] },
  { host: /^away\.vk\.com$/, path: /^\/away\.php$/, params: ['to'] },
  { host: /^linkedin\.com$/, path: /^\/safety\/go\/?$/, params: ['url'] },
  { host: /^slack-redir\.net$/, path: /^\/link$/, params: ['url'] },
  { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ['z'] },
  { host: /^exit\.sc$/, path: /^\/$/, params: ['url'] },
  { host: /^bing\.com$/, path: /^\/ck\/a$/, params: ['u'], decode: decodeBing }
]

/** Parameters an AMP cache adds to the address it forwards; they mean nothing to the publisher's page. */
const AMP_CACHE_PARAMS = ['amp_js_v', 'amp_gsa', 'amp_ct', 'usqp']

/** The longest destination taken from a link: a longer one is more likely a payload than an address. */
const BYPASS_TARGET_MAX_CHARS = 2048

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')

/** A destination as a web address a navigation may go to: http(s), no login in it, a bounded size. Null otherwise. */
function acceptableTarget(candidate: string | null | undefined): string | null {
  if (!candidate || candidate.length > BYPASS_TARGET_MAX_CHARS || !/^https?:\/\//i.test(candidate) || !URL.canParse(candidate)) return null
  const parsed = new URL(candidate)
  if (parsed.username !== '' || parsed.password !== '') return null
  return parsed.href
}

function unwrapRedirector(parsed: URL): string | null {
  const host = bareHost(parsed.hostname)
  const rule = REDIRECTORS.find((r) => r.host.test(host) && r.path.test(parsed.pathname))
  if (!rule) return null
  for (const name of rule.params) {
    const value = parsed.searchParams.get(name)
    if (value === null) continue
    const target = acceptableTarget(rule.decode ? rule.decode(value) : value)
    if (target !== null) return target
  }
  return null
}

/** `/c/s/example.com/page` or `/amp/s/example.com/page`: "s" says the publisher is on https, its absence on http. */
function forwardedAddress(path: string, parsed: URL): string | null {
  const secure = path.startsWith('s/')
  const rest = secure ? path.slice(2) : path
  const target = acceptableTarget(`${secure ? 'https' : 'http'}://${rest}`)
  if (target === null) return null
  const out = new URL(target)
  // What the cache or the viewer added to its own address goes; what the publisher's page may need stays, and comes after the page's own.
  const extra = new URLSearchParams(parsed.search)
  for (const name of AMP_CACHE_PARAMS) extra.delete(name)
  const joined = [out.search.slice(1), extra.toString()].filter(Boolean).join('&')
  out.search = joined === '' ? '' : `?${joined}`
  out.hash = out.hash || parsed.hash
  return out.href
}

function unwrapAmp(parsed: URL): string | null {
  const host = bareHost(parsed.hostname)
  const cache = /^\/(?:c|v|i)\/(.+)$/.exec(parsed.pathname)
  if (cache && host.endsWith('.cdn.ampproject.org')) return forwardedAddress(cache[1]!, parsed)
  const viewer = /^\/amp\/(.+)$/.exec(parsed.pathname)
  if (viewer && /^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return forwardedAddress(viewer[1]!, parsed)
  return null
}

/**
 * Where a link really goes, or null when it is not a wrapper this module knows. The result is always shorter than the address given (the
 * destination is a part of it), so a destination that is itself wrapped ends after a few rounds, never in a loop.
 */
export function bypassTarget(url: string): Bypass | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const redirect = unwrapRedirector(parsed)
  if (redirect !== null && redirect.length < url.length) return { url: redirect, kind: 'redirect' }
  const amp = unwrapAmp(parsed)
  if (amp !== null && amp.length < url.length) return { url: amp, kind: 'amp' }
  return null
}

/**
 * The row of the site panel for the page on screen: null when the option is off or the page is not a web page, else the site (as the list
 * writes it) and whether its links are unwrapped (`active`) or left as they are (the site is in the list).
 */
export function bypassRowOf(url: string, settings: BypassOptions): { host: string; active: boolean } | null {
  if (!settings.unwrapRedirects || !/^https?:/.test(url)) return null
  const host = normalizeBlockHost(url)
  return host === null ? null : { host, active: !isBlockingExempt(url, settings.unwrapExceptions) }
}

/**
 * What a main-frame navigation becomes under the options: the unwrapped address, or null to leave it. A site on the list of exceptions keeps
 * its links as they are, whichever end of the link it is: the site the link is on (the redirector) or the site it leads to.
 */
export function bypassNavigation(url: string, options: BypassOptions): Bypass | null {
  if (!options.unwrapRedirects) return null
  const found = bypassTarget(url)
  if (found === null) return null
  if (isBlockingExempt(url, options.unwrapExceptions) || isBlockingExempt(found.url, options.unwrapExceptions)) return null
  return found
}

/** The list of exceptions with the site of the panel switched: `exempt` true puts it in the list, false takes it (and its parent domains) out. */
export const bypassExceptionsWith = (list: readonly string[], host: string, exempt: boolean): string[] => setBlockingExempt(list, host, exempt)
