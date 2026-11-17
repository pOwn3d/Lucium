// Erasing one site's data from an engine session. Kept apart from electron-engine.ts and typed against the few session
// methods it needs, so the rules (never erase without an origin filter, which cookies belong to the site) are testable
// without Electron. The rule that matters most: every erasure is restricted to the site's origins. `clearStorageData()` or
// `clearData()` without a filter also wipe the service workers of the extensions loaded in the profile.

import { MEDIA_LICENSES, SUBDOMAINS, cookieBelongsToSite, erasesMediaLicenses, parseSiteHost, siteOrigins, type EngineSiteDataType, type SiteDataResult } from '@shared/site-data'
import { t } from '@shared/i18n'
import { listStorageHosts, type StorageHosts } from './storage-hosts'
import type { SiteDataEngineRequest } from './types'

/** The part of an Electron `Session` this module uses. */
export interface SessionLike {
  clearData(options: { origins: string[]; dataTypes: Array<'cache' | 'localStorage' | 'indexedDB' | 'serviceWorkers' | 'fileSystems' | 'backgroundFetch'> }): Promise<void>
  /** Without `storages`, every kind of storage of the origin: the only form that reaches what has no name in the list (the licences of protected video). */
  clearStorageData(options: { origin: string; storages?: Array<'cachestorage'> }): Promise<void>
  /** The HTTP authentication cache of the whole session: Chromium keeps no per-site entry to remove. */
  clearAuthCache(): Promise<void>
  /** The folder the session keeps its data in, null for a session in memory (a private window). */
  getStoragePath(): string | null
  cookies: {
    get(filter: Record<string, never>): Promise<Array<{ name: string; domain?: string; hostOnly?: boolean; path?: string; secure?: boolean }>>
    remove(url: string, name: string): Promise<void>
    flushStore(): Promise<void>
  }
}

/**
 * The origins of the extensions loaded in one profile, to keep out of a whole-profile erasure. The engine keys its loaded
 * extensions as `<profile>:<extension id>`: that key is not an origin, and a wrong exclusion protects nothing.
 */
export function profileExtensionOrigins(loaded: ReadonlyMap<string, { id: string }>, profileId: string): string[] {
  return [...loaded].filter(([key]) => key.startsWith(`${profileId}:`)).map(([, info]) => `chrome-extension://${info.id}`)
}

/** Origins are the only filter the storage erasures accept: refuse an empty list (it could mean "everything") and anything that is not a web origin. */
export function assertWebOrigins(origins: readonly string[]): void {
  if (origins.length === 0) throw new Error('Refusing to clear site data without an origin')
  for (const origin of origins) {
    if (!/^https?:\/\//.test(origin) || !URL.canParse(origin) || new URL(origin).origin !== origin) throw new Error(`Refusing to clear site data for ${origin}`)
  }
}

/**
 * What each type asks the engine to erase for the origins. A site's sandboxed files (`fileSystems`) are storage like IndexedDB, and its background
 * fetches belong to its service worker: they go with those types rather than stay behind with nothing in the panel to remove them.
 * Not here, on purpose: the code cache (`clearCodeCaches` takes the exact address of each script, or everything of the session when the list is empty)
 * and the GPU shader cache (`clearStorageData` cannot restrict it to an origin) cannot be limited to one site, so an erasure by type leaves them;
 * the shared dictionaries go with the HTTP cache (Electron documents that clearing the cache clears them too).
 */
const ENGINE_DATA_TYPES = {
  cache: ['cache'],
  localStorage: ['localStorage'],
  indexedDB: ['indexedDB', 'fileSystems'],
  serviceWorkers: ['serviceWorkers', 'backgroundFetch']
} as const satisfies Record<'cache' | 'localStorage' | 'indexedDB' | 'serviceWorkers', ReadonlyArray<Parameters<SessionLike['clearData']>[0]['dataTypes'][number]>>

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The cookies of a profile that belong to a site, with the URL that removes each one. */
async function siteCookies(ses: SessionLike, host: string, subdomains: boolean) {
  const all = await ses.cookies.get({})
  return all.filter((cookie) => cookieBelongsToSite(cookie, host, subdomains))
}

export async function countSiteCookies(ses: SessionLike, host: string, subdomains: boolean): Promise<number> {
  if (!parseSiteHost(host)) return 0
  return (await siteCookies(ses, host, subdomains)).length
}

async function removeSiteCookies(ses: SessionLike, host: string, subdomains: boolean): Promise<number> {
  const found = await siteCookies(ses, host, subdomains)
  for (const cookie of found) {
    const domain = (cookie.domain ?? '').replace(/^\./, '')
    // An IPv6 address needs its brackets to make a URL.
    const authority = domain.includes(':') && !domain.startsWith('[') ? `[${domain}]` : domain
    await ses.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${authority}${cookie.path ?? '/'}`, cookie.name)
  }
  if (found.length > 0) await ses.cookies.flushStore()
  return found.length
}

/**
 * Erases the requested types for a site and reports one result per type, in the order asked. A type that fails does not stop
 * the others. The only rejections are the refusals of `assertWebOrigins` and of an invalid host: nothing was erased then.
 */
/**
 * The session of the interface, whose HTTP cache holds the icons the sidebar drew (an `<img>` of the default session, see SidebarRows): the
 * site's icon goes with the site's cache, else the address of the icon, and the site with it, stays on disk after the site was erased.
 */
export interface InterfaceSessionLike {
  /** Without `origins`, the whole cache of the session. */
  clearData(options: { origins?: string[]; dataTypes: Array<'cache' | 'cookies'> }): Promise<void>
}

/**
 * Empties the cache of the interface's session, for an erasure of a whole profile (its cache, its data). It holds the icons of the tabs of every
 * profile, which Chromium cannot tell apart: they all go, and the sidebar fetches the ones it shows again. Nothing else of the interface is
 * kept in that cache (its pages are files of the application).
 */
export async function clearInterfaceIcons(interfaceSession: InterfaceSessionLike): Promise<void> {
  await interfaceSession.clearData({ dataTypes: ['cache'] })
}

/**
 * What the interface's session keeps that an erasure of a profile's data takes: its cache (the icons, as above) and its cookie jar. The requests of
 * the application ask for no cookie and the pictures of the interface set none (shared/interface-images.ts), so the jar should be empty; nothing
 * else in the Settings empties it, and a cookie that got there would outlive every profile. The list of hosts that asked for a secure
 * connection (HSTS) stays: Electron has no call that empties it.
 */
export async function clearInterfaceTraces(interfaceSession: InterfaceSessionLike): Promise<void> {
  await interfaceSession.clearData({ dataTypes: ['cache', 'cookies'] })
}

/** Reads which hosts hold storage in a profile's folder (engine/storage-hosts.ts); the tests give their own. */
export type StorageHostLister = (folder: string) => Promise<StorageHosts>

/**
 * The subdomains of `host` that hold storage in the session, and the line of the results that says what the search gave: how many were found,
 * that the list is not whole (a record could not be read: a failure, the run is not complete), or that there is nothing to read it from.
 */
async function storedSubdomains(ses: SessionLike, host: string, list: StorageHostLister): Promise<{ hosts: string[]; line: SiteDataResult }> {
  const folder = ses.getStoragePath()
  if (folder === null) return { hosts: [], line: { type: SUBDOMAINS, ok: true, seenOnly: true } }
  let listed: StorageHosts
  try {
    listed = await list(folder)
  } catch (error) {
    // Shown on the line of the subdomains: the site itself and the subdomains known otherwise still go.
    return { hosts: [], line: { type: SUBDOMAINS, ok: false, error: errorText(error) } }
  }
  // `siteOrigins` keeps the hosts that are subdomains of the site, on its port: the first origin is the site's own.
  const found = siteOrigins(host, { subdomains: true, knownHosts: listed.hosts, http: false }).slice(1)
  const line: SiteDataResult =
    listed.unread.length > 0
      ? { type: SUBDOMAINS, ok: false, error: t('site-data.la-liste-des-sous-domaines-n-a-pas-pu-etre-lue', { sources: listed.unread.join(', ') }) }
      : { type: SUBDOMAINS, ok: true, count: found.length }
  return { hosts: listed.hosts, line }
}

export async function eraseSiteData(ses: SessionLike, request: SiteDataEngineRequest, interfaceSession?: InterfaceSessionLike, list: StorageHostLister = listStorageHosts): Promise<SiteDataResult[]> {
  assertWebOrigins(request.origins)
  const site = parseSiteHost(request.host)
  if (!site) throw new Error(`Refusing to clear site data for the host ${request.host}`)

  let origins = request.origins
  const storage = request.types.some((type) => type !== 'cookies')
  let subdomains: SiteDataResult | null = null
  if (request.subdomains && storage) {
    // Storage cannot be erased by wildcard: the subdomains that hold storage in the profile, and the ones known from the cookie jar, join the
    // ones the caller found, under the schemes the caller chose for the site itself (« Inclure HTTP » off: https only).
    const stored = await storedSubdomains(ses, site.host, list)
    subdomains = stored.line
    const known = (await ses.cookies.get({})).map((cookie) => (cookie.domain ?? '').replace(/^\./, ''))
    const http = request.origins.includes(new URL(`http://${site.host}`).origin)
    origins = [...new Set([...origins, ...siteOrigins(site.host, { subdomains: true, knownHosts: [...stored.hosts, ...known], http })])]
  }

  const results: SiteDataResult[] = []
  for (const type of request.types) {
    try {
      const done = await eraseType(ses, type, origins, site.host, request.subdomains)
      if (type === 'cache') await interfaceSession?.clearData({ origins, dataTypes: ['cache'] })
      results.push({ type, ok: true, ...done })
    } catch (error) {
      // The failure is the user's to see: the panel prints it on the line of this type.
      results.push({ type, ok: false, error: errorText(error) })
    }
  }
  if (erasesMediaLicenses(request.types)) results.push(await eraseMediaLicenses(ses, origins))
  if (subdomains) results.push(subdomains)
  return results
}

/**
 * The licences of protected video (DRM) the site left in the profile. Neither `clearData` nor `clearStorageData` names them among the types they
 * erase: the only call that reaches them is `clearStorageData` without a list of storages, which erases every kind of storage of the origin
 * (cookies of the host, local storage, IndexedDB, file systems, service workers, cache storage, and what the list does not name). The caller
 * asks for it only when all of those were asked anyway (`erasesMediaLicenses`), so nothing goes that the user did not ask for; the one thing it
 * takes beyond the site is the GPU shader cache of the session, which holds nothing of the user and is rebuilt. `clearData` without types would
 * reach them too, but it removes cookies by registrable domain: the cookies of sibling subdomains would go with the site's.
 * Each call names its origin, validated by `assertWebOrigins`: without one, the whole session would be erased.
 */
async function eraseMediaLicenses(ses: SessionLike, origins: readonly string[]): Promise<SiteDataResult> {
  try {
    assertWebOrigins(origins)
    for (const origin of origins) await ses.clearStorageData({ origin })
    return { type: MEDIA_LICENSES, ok: true }
  } catch (error) {
    // Shown on a line of its own: the other types did go, the licences may not have.
    return { type: MEDIA_LICENSES, ok: false, error: errorText(error) }
  }
}

async function eraseType(ses: SessionLike, type: EngineSiteDataType, origins: string[], host: string, subdomains: boolean): Promise<{ count?: number }> {
  switch (type) {
    case 'cookies': {
      const count = await removeSiteCookies(ses, host, subdomains)
      // A login typed into an HTTP authentication box (401) lives in this cache, not in the cookie jar: forgetting the site's sign-in
      // means forgetting that too. It is the session's, so other sites asked for a login again as well; that is the price of a cache
      // Chromium cannot empty by origin. A failure is the result of this type, which the panel prints.
      await ses.clearAuthCache()
      return { count }
    }
    case 'cacheStorage':
      for (const origin of origins) await ses.clearStorageData({ origin, storages: ['cachestorage'] })
      return {}
    case 'cache':
    case 'localStorage':
    case 'indexedDB':
    case 'serviceWorkers':
      await ses.clearData({ origins, dataTypes: [...ENGINE_DATA_TYPES[type]] })
      return {}
  }
}
