// "Cookies par site": the cookies of a profile grouped by the site that set them, the list of sites to keep, and the clean-up that spares
// that list. Pure rules; the engine reads and removes the cookies (engine/cookie-book.ts). The value of a cookie never leaves the engine:
// the view knows names and sizes only.

import { normalizeBlockHost } from './blocker'
import { cookieBelongsToSite, parseSiteHost } from './site-data'
import { getLanguage, t, tp } from './i18n'

/** What the engine reports of one cookie. `size` is the length of the name and the value together, in bytes. */
export interface CookieEntry {
  /** The domain as the cookie jar has it: a leading dot marks a cookie for the domain and its subdomains. */
  domain: string
  name: string
  path: string
  secure: boolean
  /** A session cookie: it goes when the browser is closed. */
  session: boolean
  hostOnly: boolean
  size: number
}

/** One line of the view: a site, how many cookies it set and how much room they take. */
export interface CookieSite {
  host: string
  count: number
  bytes: number
}

/** What a removal did: cookies gone, and cookies the jar refused to let go. */
export interface CookieRemoval {
  removed: number
  failed: number
}

/** What the view shows of one cookie of a site: no value. */
export interface CookieName {
  name: string
  path: string
  size: number
  secure: boolean
  session: boolean
}

/** Sites the list carries to the window, and cookies listed under one site: far more than a profile has, and a bound for a cookie jar gone wild. */
export const COOKIE_SITES_MAX = 2000
export const COOKIE_NAMES_MAX = 300
export const COOKIE_KEEP_HOSTS_MAX = 200

/** The site a cookie belongs to: its domain, in lower case, without the dot that marks a domain cookie nor the brackets of an IPv6 address. */
export const siteOfCookie = (domain: string): string => domain.toLowerCase().replace(/^\./, '').replace(/^\[|\]$/g, '')

/** The cookies grouped by site: most cookies first, then by name of site. Past `COOKIE_SITES_MAX` the smallest sites are left out. */
export function groupCookieSites(cookies: readonly CookieEntry[]): CookieSite[] {
  const sites = new Map<string, CookieSite>()
  for (const cookie of cookies) {
    const host = siteOfCookie(cookie.domain)
    if (host === '') continue
    const site = sites.get(host) ?? { host, count: 0, bytes: 0 }
    site.count++
    site.bytes += Math.max(0, cookie.size)
    sites.set(host, site)
  }
  return [...sites.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).slice(0, COOKIE_SITES_MAX)
}

/** The cookies a site (as listed: the exact domain) set, by name, without their values. */
export function cookieNamesOf(cookies: readonly CookieEntry[], host: string): CookieName[] {
  return cookies
    .filter((cookie) => siteOfCookie(cookie.domain) === host)
    .map(({ name, path, size, secure, session }) => ({ name, path, size, secure, session }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .slice(0, COOKIE_NAMES_MAX)
}

/** The list of sites to keep, as a saved file may hold it: valid hosts (written as the blocker's exceptions are), each once, bounded. */
export function cleanKeepHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const hosts = new Set<string>()
  for (const entry of raw) {
    const host = normalizeBlockHost(entry)
    if (host) hosts.add(host)
    if (hosts.size >= COOKIE_KEEP_HOSTS_MAX) break
  }
  return [...hosts]
}

/** The site written as the list keeps it (a leading "www." is dropped: the site and its subdomains are covered), or null for something that is not a site. */
export const keepHostOf = (site: unknown): string | null => normalizeBlockHost(site)

/**
 * Whether a cookie is protected by the list: it is set for a listed site, for a parent domain that site sends it to, or for one of the
 * site's subdomains (a listed site covers its subdomains, as the blocker's exceptions do). The same rule as "Effacer les données du site".
 */
export function isCookieKept(cookie: Pick<CookieEntry, 'domain' | 'hostOnly'>, keepHosts: readonly string[]): boolean {
  return keepHosts.some((host) => cookieBelongsToSite(cookie, host, true))
}

/** The cookies the clean-up removes: all of them but the protected ones. */
export function cookiesToClean(cookies: readonly CookieEntry[], keepHosts: readonly string[]): CookieEntry[] {
  return cookies.filter((cookie) => !isCookieKept(cookie, keepHosts))
}

/** Whether the site is covered by the list. */
export function isSiteKept(host: string, keepHosts: readonly string[]): boolean {
  const site = normalizeBlockHost(host)
  return site !== null && keepHosts.some((kept) => site === kept || site.endsWith(`.${kept}`))
}

/** The list with a site added or taken out. Taking out removes only the exact entry; a site covered by a parent entry stays covered. */
export function withKeptSite(keepHosts: readonly string[], site: string, keep: boolean): string[] {
  const host = normalizeBlockHost(site)
  if (host === null) return [...keepHosts]
  return keep ? cleanKeepHosts([...keepHosts, host]) : keepHosts.filter((entry) => entry !== host)
}

/** A host that came through the interface: a plain host the cookie jar could hold (no scheme, port or path). Null on any doubt. */
export function parseCookieSite(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const site = parseSiteHost(input)
  return site && site.port === null ? siteOfCookie(site.hostname) : null
}

/** "512 o", "2,0 Ko", "3,0 Mo" in French; "512 B", "2.0 KB", "3.0 MB" in English. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return t('cookies.taille-octets', { size: bytes })
  const decimal = (value: number): string => (getLanguage() === 'fr' ? value.toFixed(1).replace('.', ',') : value.toFixed(1))
  return bytes < 1024 * 1024 ? t('cookies.taille-ko', { size: decimal(bytes / 1024) }) : t('cookies.taille-mo', { size: decimal(bytes / 1024 / 1024) })
}

export function describeCookieCount(count: number): string {
  return count === 0 ? t('cookies.aucun-cookie') : tp('cookies.cookies', count)
}

/** The sentence after a removal. */
export function describeCookieRemoval(count: number, what: 'site' | 'clean'): string {
  if (count === 0) return t('cookies.aucun-cookie-a-retirer')
  return what === 'site' ? tp('cookies.cookies-retires', count) : tp('cookies.cookies-retires-sites-gardes', count)
}

/** The sentence after a removal, followed by how many could not be removed when some could not: « 1 n’a pas pu l’être. », « 3 n’ont pas pu l’être. ». */
export function describeCookieOutcome(removed: number, failed: number, what: 'site' | 'clean'): string {
  const done = describeCookieRemoval(removed, what)
  return failed > 0 ? `${done} ${tp('cookie-manager.pas-pu-l-etre', failed)}` : done
}

/**
 * « 12 cookies sur 3 sites. », under the title of the panel. Nothing when the profile has no cookie: the list says so itself, and the count would
 * start its sentence with a small letter (« aucun cookie sur 0 site. »).
 */
export function describeCookieTotals(cookies: number, sites: number): string {
  return cookies === 0 || sites === 0 ? '' : tp('cookie-manager.cookies-sur-sites', sites, { cookies: describeCookieCount(cookies) })
}
