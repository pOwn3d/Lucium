// "Clear this site's data": erase what one site stored, and nothing else. Pure rules (which hosts are valid, which origins and
// cookies belong to a site, what a saved selection means); the main process applies them (shell/site-data.ts, engine).
// Nothing here imports from the rest of the app, so settings (model.ts) and the IPC types (ipc.ts) can depend on it.

/** What can be erased for a site. The first six live in the browser profile; the last two are tab and history state. */
import { t, tp, type PluralBase } from './i18n'

export const SITE_DATA_TYPES = ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage', 'sessionStorage', 'history'] as const
export type SiteDataType = (typeof SITE_DATA_TYPES)[number]

/** The types the engine erases in the profile's session (sessionStorage lives in the pages, history in our own store). */
export const ENGINE_SITE_DATA_TYPES = ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] as const satisfies readonly SiteDataType[]
export type EngineSiteDataType = (typeof ENGINE_SITE_DATA_TYPES)[number]

export const isSiteDataType = (value: unknown): value is SiteDataType => (SITE_DATA_TYPES as readonly unknown[]).includes(value)
export const isEngineSiteDataType = (type: SiteDataType): type is EngineSiteDataType => (ENGINE_SITE_DATA_TYPES as readonly SiteDataType[]).includes(type)

/**
 * The licences of protected video (DRM) a site left in the profile. Not a type to tick: the engine has no call that erases them alone, for a site.
 * They go with everything else the site stored, so the erasure reaches them only when every type of `MEDIA_LICENSE_TYPES` is asked, and answers
 * a line of its own for them.
 */
export const MEDIA_LICENSES = 'mediaLicenses'

/**
 * The subdomains of the site that hold storage in the profile, found by reading what the engine keeps on disk. Not a type to tick either: a line
 * of the results when « Sous-domaines » is asked, which says how many were found, or that the list could not be read.
 */
export const SUBDOMAINS = 'subdomains'
export type SiteDataResultType = SiteDataType | typeof MEDIA_LICENSES | typeof SUBDOMAINS

/** What the engine's erasure of "all the storage of an origin" takes with the licences: asked all together, nothing is erased that was not asked. */
export const MEDIA_LICENSE_TYPES = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] as const satisfies readonly EngineSiteDataType[]

/** Whether an erasure of these types also takes the site's licences of protected video. */
export const erasesMediaLicenses = (types: readonly SiteDataType[]): boolean => MEDIA_LICENSE_TYPES.every((type) => types.includes(type))

/** What the panel shows for each type. */
export const SITE_DATA_LABELS: Record<SiteDataType, { label: string; hint: string }> = {
  cache: { get label() { return t('site-data.cache-du-reseau') }, get hint() { return t('site-data.fichiers-et-pages-gardes-pour-aller-plus-vite') } },
  cookies: { get label() { return t('site-data.cookies') }, get hint() { return t('site-data.connexions-et-preferences-du-site') } },
  localStorage: { get label() { return t('site-data.stockage-local') }, hint: 'localStorage' },
  indexedDB: { get label() { return t('site-data.bases-indexeddb') }, get hint() { return t('site-data.donnees-des-applications-web') } },
  serviceWorkers: { get label() { return t('site-data.service-workers') }, get hint() { return t('site-data.scripts-qui-gardent-le-site-en-tache-de-fond') } },
  cacheStorage: { get label() { return t('site-data.cache-storage') }, get hint() { return t('site-data.fichiers-hors-connexion-des-applications-web') } },
  sessionStorage: { label: 'sessionStorage', get hint() { return t('site-data.onglets-ouverts-sur-ce-site') } },
  history: { get label() { return t('site-data.historique-du-site') }, get hint() { return t('site-data.pages-de-ce-site-dans-l-historique') } }
}

/** The name of a line of the results: a type of the panel, or the licences of protected video. */
export const siteDataResultLabel = (type: SiteDataResultType): string =>
  type === MEDIA_LICENSES ? t('site-data.licences-de-video-protegee') : type === SUBDOMAINS ? t('site-data.sous-domaines') : SITE_DATA_LABELS[type].label

/** What is ticked the first time, as in the extension this comes from: every type but the history, which is the user's record rather than the site's data. */
export const DEFAULT_SITE_DATA_TYPES: readonly SiteDataType[] = SITE_DATA_TYPES.filter((type) => type !== 'history')

// ---------- hosts ----------

export interface SiteHost {
  /** Canonical form: lower case, with the port when one was given ("localhost:3000"). */
  host: string
  hostname: string
  port: number | null
  /** An IP address has no subdomains. */
  kind: 'domain' | 'ip'
}

const HOSTNAME_MAX = 253
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const OCTET = '(?:0|[1-9]\\d{0,2})'
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
const SINGLE_LABEL = new RegExp(`^${LABEL}$`)
const DOTTED = new RegExp(`^(?:${LABEL}\\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$`)
const IPV6 = /^\[[0-9a-f:.]+\]$/

/**
 * A host as the extension this comes from accepts it (a domain, `localhost`, an IPv4 address, each with an optional port),
 * a bit stricter where the old pattern let nonsense through (999.1.1.1, port 99999, an IP written with leading zeros that
 * the URL parser would read as octal) and a bit wider where it refused real hosts (internationalised domains in punycode,
 * IPv6 in brackets, a single-label name like `nas` or `myapp:3000`). Null when it is none of them.
 */
export function parseSiteHost(input: unknown): SiteHost | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > HOSTNAME_MAX + 6) return null
  const match = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(input.toLowerCase())
  if (!match) return null
  const [, hostname = '', portText] = match
  if (hostname.length > HOSTNAME_MAX) return null
  const port = portText === undefined ? null : Number(portText)
  if (port !== null && (port < 1 || port > 65535)) return null

  let kind: SiteHost['kind']
  let canonical = hostname
  if (IPV4.test(hostname)) {
    if (hostname.split('.').some((octet) => Number(octet) > 255)) return null
    kind = 'ip'
  } else if (IPV6.test(hostname)) {
    // Written however the user likes, kept as the URL parser prints it, which is also how the page's origin spells it.
    if ((hostname.match(/:/g) ?? []).length < 2 || !URL.canParse(`http://${hostname}`)) return null
    canonical = new URL(`http://${hostname}`).hostname
    kind = 'ip'
  } else if (hostname.includes('.') ? DOTTED.test(hostname) : SINGLE_LABEL.test(hostname)) {
    kind = 'domain'
  } else return null

  const host = port === null ? canonical : `${canonical}:${port}`
  // The URL parser reads some spellings as numbers (127, 0x7f, 127.1): what it would visit must be what was typed.
  if (kind === 'domain' && (!URL.canParse(`http://${host}`) || new URL(`http://${host}`).hostname !== canonical)) return null
  return { host, hostname: canonical, port, kind }
}

/**
 * The host to offer for what the user typed or pasted: a whole web address gives its host, anything else is kept as typed
 * (trimmed, lower case) so a half-typed address is not wiped under the user's fingers. The result still has to pass `parseSiteHost`.
 */
export function siteHostOf(input: string): string {
  const text = input.trim()
  return /^https?:\/\/[^/?#\s]/i.test(text) && URL.canParse(text) ? new URL(text).host : text.toLowerCase()
}

/** True when `candidate` is a strict subdomain of `base` on the same port ("a.example.com" under "example.com"). An IP address has none: no valid host ends with ".127.0.0.1". */
function isSubdomain(candidate: SiteHost, base: SiteHost): boolean {
  return candidate.port === base.port && candidate.hostname.endsWith(`.${base.hostname}`)
}

/**
 * The origins whose storage belongs to a site: its https form, and its http form unless `http` is false (the panel's « Inclure HTTP »).
 * With `subdomains`, also the origins of the subdomains in `knownHosts` (hosts seen in tabs, history or cookies, and the ones the
 * engine found storage for in the profile), under the same schemes: an origin cannot be matched by a wildcard. Empty for an invalid host.
 */
export function siteOrigins(host: string, options: { subdomains?: boolean; knownHosts?: readonly string[]; http?: boolean } = {}): string[] {
  const site = parseSiteHost(host)
  if (!site) return []
  const hosts = [site.host]
  if (options.subdomains) {
    const subs = new Set<string>()
    for (const known of options.knownHosts ?? []) {
      const sub = parseSiteHost(known)
      if (sub && isSubdomain(sub, site)) subs.add(sub.host)
    }
    hosts.push(...[...subs].sort())
  }
  const schemes = options.http === false ? ['https'] : ['https', 'http']
  return [...new Set(hosts.flatMap((h) => schemes.map((scheme) => new URL(`${scheme}://${h}`).origin)))]
}

/** Whether a page host (as `URL.host` prints it, port included) is the site, or one of its subdomains when asked. */
export function hostBelongsToSite(pageHost: string, site: string, subdomains: boolean): boolean {
  const page = parseSiteHost(pageHost)
  const base = parseSiteHost(site)
  if (!page || !base) return false
  return page.host === base.host || (subdomains && isSubdomain(page, base))
}

/** The part of a cookie that says where it applies, as the engine reports it. */
export interface CookieScope {
  /** A leading dot marks a cookie for the domain and its subdomains; without it the cookie is for that host only. */
  domain?: string
  hostOnly?: boolean
}

/**
 * Whether a cookie is part of a site. A cookie goes when the site would send it: set for its own host, or for a parent
 * domain (".example.com" is sent to "www.example.com", and clearing the site must log it out). Cookies of its
 * subdomains only go when asked. Cookies ignore ports, so "localhost:3000" and "localhost:4000" share theirs.
 */
export function cookieBelongsToSite(cookie: CookieScope, site: string, subdomains: boolean): boolean {
  const base = parseSiteHost(site)
  if (!base || !cookie.domain) return false
  const raw = cookie.domain.toLowerCase()
  const forSubdomains = raw.startsWith('.') && cookie.hostOnly !== true
  const domain = raw.replace(/^\./, '').replace(/^\[|\]$/g, '')
  const host = base.hostname.replace(/^\[|\]$/g, '')
  if (domain === host) return true
  if (base.kind === 'ip') return false
  if (forSubdomains && host.endsWith(`.${domain}`)) return true
  return subdomains && domain.endsWith(`.${host}`)
}

// ---------- requests ----------

/** What the panel asks for. */
export interface SiteDataRequest {
  host: string
  types: SiteDataType[]
  subdomains: boolean
  /** Also the http origins of the site (« Inclure HTTP »), not only the https ones. Cookies are matched by domain and go either way. */
  http: boolean
  /** Reload the tab on the site, from the root of the site rather than the page it was on. */
  reload: boolean
}

/** The outcome for one type. `count` is what was removed when the engine can tell (cookies, history entries, tabs). */
export interface SiteDataResult {
  type: SiteDataResultType
  ok: boolean
  error?: string
  count?: number
  /**
   * On the line of the subdomains: the profile has nothing on disk to list them from (a private window). The subdomains seen in a tab, in the
   * history or in the cookie jar were erased; whether another one holds storage is not known, and the line must not say « Effacé ».
   */
  seenOnly?: boolean
}

/** The types of a request that crossed a process boundary: known ones, at least one, each once, in the panel's order. Null on any doubt. */
function parseSiteDataTypes(types: unknown): SiteDataType[] | null {
  if (!Array.isArray(types) || types.length === 0 || types.length > SITE_DATA_TYPES.length || !types.every(isSiteDataType)) return null
  return SITE_DATA_TYPES.filter((t) => types.includes(t))
}

/** One line of the result list: what happened to a type. */
export function describeSiteDataResult(result: SiteDataResult): string {
  if (!result.ok) return result.error ? t('site-data.echec-error', { error: result.error }) : t('site-data.echec')
  if (result.seenOnly) return t('site-data.une-fenetre-privee-ne-garde-pas-la-liste-des-sites')
  if (result.count === undefined) return t('site-data.efface')
  const counted: Partial<Record<SiteDataResultType, PluralBase>> = {
    cookies: 'site-data.count-cookies',
    history: 'site-data.count-pages-oubliees',
    sessionStorage: 'site-data.count-entrees',
    [SUBDOMAINS]: 'site-data.count-sous-domaines-avec-des-donnees'
  }
  const key = counted[result.type]
  if (!key) return t('site-data.efface')
  return result.count === 0 ? t('site-data.rien-a-effacer') : tp(key, result.count)
}

// ---------- reload ----------

export type ReloadTarget = { kind: 'reload' } | { kind: 'load'; url: string }

/**
 * Where a tab goes after its site was cleared. Reloading the page it is on can keep the user stuck there (a login page that
 * redirects, a redirect loop), so a tab deep in a site goes back to the site's root; a tab already there is just reloaded.
 */
export function reloadTarget(tabUrl: string): ReloadTarget {
  if (!URL.canParse(tabUrl)) return { kind: 'reload' }
  const url = new URL(tabUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'reload' }
  const atRoot = url.pathname === '/' && !url.search && !url.hash
  return atRoot ? { kind: 'reload' } : { kind: 'load', url: `${url.protocol}//${url.host}/` }
}

/**
 * The script that empties sessionStorage in a page, only when the page is on one of the origins (a tab may have moved to
 * another site since the list was made). It answers how many entries it removed; a page that refuses access to its
 * sessionStorage throws, and the caller reports that failure.
 */
export function sessionStorageScript(origins: readonly string[]): string {
  return `(() => { if (!${JSON.stringify(origins)}.includes(location.origin)) return 0; const n = sessionStorage.length; sessionStorage.clear(); return n })()`
}

// ---------- saved selection ----------

/** The settings the panel remembers for its next run, and the shortcut uses. */
export interface SiteDataPrefs {
  siteDataTypes: SiteDataType[]
  siteDataSubdomains: boolean
  siteDataReload: boolean
  /** « Inclure HTTP » ticked by hand: the http origins too, whatever the page. A page served over http includes them anyway. */
  siteDataHttp: boolean
}

/** A saved list of types: known ones only, each once, in the panel's order. Nothing usable gives the default (all of them but the history). */
export function cleanSiteDataTypes(input: unknown): SiteDataType[] {
  if (!Array.isArray(input)) return [...DEFAULT_SITE_DATA_TYPES]
  const kept = SITE_DATA_TYPES.filter((type) => input.includes(type))
  return kept.length > 0 ? kept : [...DEFAULT_SITE_DATA_TYPES]
}

/** Repairs the settings of a saved or imported file (they are optional there). Subdomains and http are off and the reload is on by default. */
export function normalizeSiteDataPrefs(input: { siteDataTypes?: unknown; siteDataSubdomains?: unknown; siteDataReload?: unknown; siteDataHttp?: unknown }): SiteDataPrefs {
  return { siteDataTypes: cleanSiteDataTypes(input.siteDataTypes), siteDataSubdomains: input.siteDataSubdomains === true, siteDataReload: input.siteDataReload !== false, siteDataHttp: input.siteDataHttp === true }
}

// ---------- several sites at once, and the sites used before ----------

/** Sites one run may name (the extension's domain tags): enough for the environments of a project, few enough to stay readable. */
export const SITE_DATA_HOSTS_MAX = 20

/** Sites kept for one-click reuse, newest first. */
export const SITE_DATA_RECENTS_MAX = 10

/** What the panel asks for when it names several sites: one choice of types and options, applied to each of them. */
export interface SiteDataBatchRequest {
  hosts: string[]
  types: SiteDataType[]
  subdomains: boolean
  /** Also the http origins of each site (« Inclure HTTP »). */
  http: boolean
  /** Reload the tab on one of the sites, from the root of the site, once every site was cleared without a failure. */
  reload: boolean
  /** The panel closes at once and the run ends in the background (a system notice tells how it went, when notices are on). */
  detached: boolean
}

/** What happened to one site of a run: one result per type, in the order asked. */
export interface SiteDataSiteResult {
  host: string
  results: SiteDataResult[]
}

/**
 * Revalidates a run that crossed a process boundary. Null when there is no site, too many, or one that is not valid, and when the
 * types are empty or unknown: nothing is erased on a doubt, not even for the sites that were fine. Hosts are canonical and listed once.
 */
export function parseSiteDataBatchRequest(input: unknown): SiteDataBatchRequest | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  const hosts = raw['hosts']
  const types = parseSiteDataTypes(raw['types'])
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > SITE_DATA_HOSTS_MAX || !types) return null
  const sites = hosts.map(parseSiteHost)
  if (sites.some((site) => site === null)) return null
  return {
    hosts: [...new Set(sites.map((site) => site!.host))],
    types,
    subdomains: raw['subdomains'] === true,
    http: raw['http'] === true,
    reload: raw['reload'] === true,
    detached: raw['detached'] === true
  }
}

/** What was typed or pasted in the site field, as one entry per site: a list separated by spaces, commas or semicolons, each part reduced to its host. */
export function splitSiteHosts(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map(siteHostOf)
    .filter((part) => part !== '')
}

/** The sites to remember after a run, in front of the ones remembered: valid ones only, each once (as the URL parser prints them), the newest first, at most `SITE_DATA_RECENTS_MAX`. */
export function rememberSiteHosts(recents: readonly string[], used: readonly string[]): string[] {
  const hosts = [...used, ...recents].map((host) => parseSiteHost(host)?.host).filter((host): host is string => host !== undefined)
  return [...new Set(hosts)].slice(0, SITE_DATA_RECENTS_MAX)
}

/** Whether every operation of every site went through (an empty run did not succeed at anything). */
export const allSitesCleared = (sites: readonly SiteDataSiteResult[]): boolean => sites.length > 0 && sites.every((site) => site.results.length > 0 && site.results.every((r) => r.ok))

/**
 * The run the shortcut and the menus start for a page: its site, with the choices the panel remembered. Null when the page has no
 * site (a start page, the settings, a file) or when nothing is left to erase: a private window keeps no history, so that type is
 * not run there. A page served over http stores its data under its http origin: that origin goes too, as the panel ticks
 * « Inclure HTTP » for it.
 */
export function quickClearRequest(pageUrl: string, prefs: SiteDataPrefs, options: { private: boolean }): SiteDataBatchRequest | null {
  if (!/^https?:\/\//i.test(pageUrl) || !URL.canParse(pageUrl)) return null
  const url = new URL(pageUrl)
  const site = parseSiteHost(url.host)
  const types = prefs.siteDataTypes.filter((type) => !(options.private && type === 'history'))
  if (!site || types.length === 0) return null
  return { hosts: [site.host], types, subdomains: prefs.siteDataSubdomains && site.kind === 'domain', http: prefs.siteDataHttp || url.protocol === 'http:', reload: prefs.siteDataReload, detached: false }
}

/** The sites a run did not fully clear: one operation failed, or none was reported at all. */
export const failedSites = (sites: readonly SiteDataSiteResult[]): SiteDataSiteResult[] => sites.filter((site) => site.results.length === 0 || site.results.some((r) => !r.ok))

const NOTICE_HOSTS_SHOWN = 3

/** The hosts a notice names: the first few, then how many are left. */
const hostList = (hosts: readonly string[]): string =>
  hosts.length <= NOTICE_HOSTS_SHOWN ? hosts.join(', ') : tp('site-data.hosts-et-count-autres', hosts.length - NOTICE_HOSTS_SHOWN, { hosts: hosts.slice(0, NOTICE_HOSTS_SHOWN).join(', ') })

/**
 * The system notice after a run nobody watched (shortcut, menu, panel closed at once). A private window never names its sites:
 * notices stay in the system's notification centre, which is not private.
 */
export function describeSiteDataNotice(sites: readonly SiteDataSiteResult[], options: { private: boolean }): { title: string; body: string } {
  const failed = failedSites(sites)
  const title = failed.length === 0 ? t('site-data.donnees-effacees') : t('site-data.effacement-incomplet')
  if (options.private) return { title, body: t('menu.private-window-name') }
  if (failed.length === 0) return { title, body: sites.length === 1 ? sites[0]!.host : tp('site-data.count-sites-hosts', sites.length, { hosts: hostList(sites.map((s) => s.host)) }) }
  return { title, body: t('site-data.echec-pour-hosts', { hosts: hostList(failed.map((s) => s.host)) }) }
}
