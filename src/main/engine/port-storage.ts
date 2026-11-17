// The engine port (types.ts), what the sessions keep on disk: the data of a site, the cookies, the cache, the folders of the profiles and of the
// tab containers, and their erasure. Re-exported by types.ts, which the rest of Lucium imports.

import type { CookieEntry, CookieRemoval } from '@shared/cookies'
import type { EngineSiteDataType, SiteDataResult } from '@shared/site-data'

/** What the engine erases or counts of what its sessions stored. */
export interface EngineStorage {
  /**
   * Erases what one site stored in a profile (or, for a private window, in its session), and nothing else: every erasure is
   * restricted to `origins` (never the whole session, which would also kill the service workers of the extensions).
   * Rejects without erasing anything when `origins` is empty or holds something other than a web origin. One result per type.
   */
  clearSiteData(profileId: string, request: SiteDataEngineRequest): Promise<SiteDataResult[]>
  /** How many cookies a site has in a profile (the ones `clearSiteData` would remove for `cookies`). */
  siteCookieCount(profileId: string, host: string, subdomains: boolean): Promise<number>
  /** Every cookie of a profile's session (or of the private window's own), without the values. */
  listCookies(profileId: string): Promise<CookieEntry[]>
  /** Removes these cookies, one by one; a failure is counted, not thrown. */
  removeCookies(profileId: string, cookies: readonly CookieEntry[]): Promise<CookieRemoval>
  /** Empties the HTTP cache of a profile. */
  clearCache(profileId: string): Promise<void>
  /** Erases cookies, storage and cache of a profile. */
  clearProfileData(profileId: string): Promise<void>
  /** Erases all a deleted profile holds, the storage and the Chrome Web Store extensions of its extensions included (see shared/profile-retire.ts). */
  deleteProfileData(profileId: string): Promise<void>
  /** At launch, before any page: removes the folders of the retired profiles whose session is not open. Answers the ids that could not be removed. */
  removeRetiredProfiles(ids: readonly string[]): string[]
  /** Ids of the profiles that have data on disk, used or not. */
  storedProfileIds(): string[]
  /**
   * Erases everything a container stored, open or not (cookies, storage of every kind, cache, logins). Destroy its pages first. Rejects, naming
   * what was kept, when something could not be erased: nobody may say "erased" for a container that kept something. `name` is for the message.
   */
  eraseContainer(containerId: string, name: string): Promise<void>
  /** Ids of the containers that have a folder on disk, used or not. */
  storedContainerIds(): string[]
  /** How long ago (ms) something was last written in the folder of a stored container; null when it cannot be told (no folder, or one that cannot be read). */
  storedContainerIdleMs(id: string): number | null
  /** Removes the folders of containers that no longer exist, before their sessions are opened. Answers the ids it could not remove. */
  removeStoredContainers(ids: readonly string[]): string[]
}

export interface SiteDataEngineRequest {
  /** Exact origins (`scheme://host[:port]`) whose storage and cache go. */
  origins: string[]
  /** The site, as `host[:port]`: cookies are matched by domain, not by origin. */
  host: string
  /** Also the subdomains' cookies, and the storage of the subdomains that hold some in the profile or that the cookie jar knows. */
  subdomains: boolean
  types: EngineSiteDataType[]
}
