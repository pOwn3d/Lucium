// "Effacer à la fermeture": the data of the sites on a list is erased when the last tab of the site closes, and optionally when the
// application quits. Pure rules (which tabs closed, which sites that empties, what is asked of the engine); the main process runs
// them (shell/site-clear.ts, Browser.dispatch). The erasure itself is the one of "Effacer les données du site" (site-data.ts), so it
// is restricted to the origins of each site and never touches the service workers of the extensions.

import type { SidebarState } from './model'
import { t, tp } from './i18n'
import { profileOfSpace } from './profiles'
import { hostBelongsToSite, normalizeSiteDataPrefs, parseSiteHost, SITE_DATA_HOSTS_MAX, type SiteDataBatchRequest } from './site-data'

/** Sites on the list: a list is read and edited by hand, and one run names at most `SITE_DATA_HOSTS_MAX` of them. */
export const SITE_CLEAR_MAX = SITE_DATA_HOSTS_MAX * 5

/** A saved or imported list: valid hosts only, spelled as the URL parser prints them, each once, no more than `SITE_CLEAR_MAX`. */
export function cleanClearOnClose(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const hosts = new Set<string>()
  for (const entry of raw) {
    const site = typeof entry === 'string' ? parseSiteHost(entry) : null
    if (site) hosts.add(site.host)
    if (hosts.size >= SITE_CLEAR_MAX) break
  }
  return [...hosts]
}

/** The host of a web page's address (port included), or null for anything else: a start page, a file, the settings. */
export function clearHostOfUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null
  return parseSiteHost(new URL(url).host)?.host ?? null
}

/** Whether the site of `url` is on the list. */
export function isClearedOnClose(list: readonly string[], url: string): boolean {
  const host = clearHostOfUrl(url)
  return host !== null && list.includes(host)
}

/**
 * The list with a site added or taken out. `site` is a host or a whole address; a site that is not a web host changes nothing, and
 * neither does adding a site already on the list or taking out one that is not. A list that is full refuses one more.
 */
export function setClearedOnClose(list: readonly string[], site: unknown, on: boolean): string[] {
  const host = typeof site === 'string' ? (clearHostOfUrl(site) ?? parseSiteHost(site)?.host ?? null) : null
  if (host === null) return [...list]
  if (!on) return list.filter((entry) => entry !== host)
  return list.includes(host) || list.length >= SITE_CLEAR_MAX ? [...list] : [...list, host]
}

/**
 * What the run for one profile is asked: its sites, with the types and options the panel remembered, under both schemes (a site on the list
 * is forgotten whole, whether its pages were served over https or http). Nothing to reload, nothing to wait for.
 */
export interface ClearOnCloseJob {
  profileId: string
  request: SiteDataBatchRequest
}

/** Actions that replace the whole state or take an import back: the tabs they drop were not closed by the user, so they erase nothing. */
export const WHOLE_STATE_ACTIONS: ReadonlySet<string> = new Set(['state/restore', 'import/merge', 'import/revert'])

function requestFor(state: SidebarState, hosts: string[]): SiteDataBatchRequest {
  const prefs = normalizeSiteDataPrefs(state.settings)
  return { hosts, types: prefs.siteDataTypes, subdomains: prefs.siteDataSubdomains, http: true, reload: false, detached: true }
}

/**
 * Whether a tab of `state` in `profileId` is on the site (its subdomains too when the options ask for them). A tab in a container has its
 * own cookies and storage: it neither keeps the profile's data of the site from being erased nor is erased with it.
 */
function siteStillOpen(state: SidebarState, profileId: string, site: string, subdomains: boolean): boolean {
  return state.tabs.some((tab) => {
    const host = clearHostOfUrl(tab.url)
    // A private tab lives in a context of its own: it neither holds the profile's data of the site nor leaves any.
    return host !== null && tab.container === undefined && tab.private !== true && profileOfSpace(state, tab.spaceId) === profileId && hostBelongsToSite(host, site, subdomains)
  })
}

/**
 * The erasures a change of state calls for: for every tab that is gone (closed, archived, swept by the delay), the listed site it was
 * on, in the profile it was in, when no other tab of that profile is on the site any more. Only a tab that disappears counts: a tab
 * that navigates away keeps its place and erases nothing (a sign-in goes through other hosts and must not log the user out halfway),
 * and a tab moved to another space is still open. A private window has nothing to erase (its session is thrown away with it), nor has a
 * private tab of a normal window.
 */
export function sitesToClearOnClose(before: SidebarState, after: SidebarState, options: { private: boolean }): ClearOnCloseJob[] {
  const list = after.settings.siteDataClearOnClose
  if (options.private || !after.settings.siteDataClearOnCloseEnabled || list.length === 0 || before === after) return []
  const remaining = new Set(after.tabs.map((tab) => tab.id))
  const subdomains = normalizeSiteDataPrefs(after.settings).siteDataSubdomains
  const byProfile = new Map<string, Set<string>>()
  for (const tab of before.tabs) {
    if (remaining.has(tab.id) || tab.container !== undefined || tab.private === true) continue
    const host = clearHostOfUrl(tab.url)
    if (host === null) continue
    const profileId = profileOfSpace(before, tab.spaceId)
    for (const site of list) {
      if (!hostBelongsToSite(host, site, subdomains) || siteStillOpen(after, profileId, site, subdomains)) continue
      byProfile.set(profileId, (byProfile.get(profileId) ?? new Set()).add(site))
    }
  }
  // One run names at most SITE_DATA_HOSTS_MAX sites: more, emptied by one change (a space deleted, Today cleared), go in as many runs as needed.
  const jobs: ClearOnCloseJob[] = []
  for (const [profileId, hosts] of byProfile) {
    const sites = [...hosts]
    for (let at = 0; at < sites.length; at += SITE_DATA_HOSTS_MAX) jobs.push({ profileId, request: requestFor(after, sites.slice(at, at + SITE_DATA_HOSTS_MAX)) })
  }
  return jobs
}

/**
 * The erasures at quit: the whole list, in every profile the spaces use, when the setting asks for it. Several runs when the list is
 * longer than one run may name. Empty in a private window and when the list is empty.
 */
export function sitesToClearOnQuit(state: SidebarState, options: { private: boolean }): ClearOnCloseJob[] {
  const { siteDataClearOnCloseEnabled, siteDataClearOnClose: list, siteDataClearOnQuit } = state.settings
  if (options.private || !siteDataClearOnCloseEnabled || !siteDataClearOnQuit || list.length === 0) return []
  const profiles = [...new Set(state.spaces.map((space) => space.profileId))]
  const jobs: ClearOnCloseJob[] = []
  for (const profileId of profiles) {
    for (let at = 0; at < list.length; at += SITE_DATA_HOSTS_MAX) jobs.push({ profileId, request: requestFor(state, list.slice(at, at + SITE_DATA_HOSTS_MAX)) })
  }
  return jobs
}

/** What the notice says when a run at close or quit did not go through, naming the sites (never the profile). */
export function describeClearFailure(hosts: readonly string[]): string {
  const shown = hosts.slice(0, 3).join(', ')
  return t('site-clear.effacement-a-la-fermeture-incomplet-hosts', { hosts: hosts.length > 3 ? tp('site-data.hosts-et-count-autres', hosts.length - 3, { hosts: shown }) : shown })
}
