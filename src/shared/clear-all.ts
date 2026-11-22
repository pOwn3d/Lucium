// « Tout effacer » (the Fire Button) and « Nouvelle identité »: one gesture that erases the browsing data of the current profile (or, when the user
// chooses it in the confirmation, of every profile a space uses), sparing the sites on the list of exclusions. Pure rules; the engine runs the erasure
// (engine/clear-profile.ts) and the shell asks the question (menu, command bar). The cookies of the spared sites go through the rule of « Cookies par site »
// (shared/cookies.ts), so a spared site keeps its subdomains' and its parent domain's cookies too.

import type { CookieEntry } from './cookies'
import { COOKIE_KEEP_HOSTS_MAX, cleanKeepHosts, cookiesToClean, withKeptSite } from './cookies'
import { t, tp } from './i18n'
import type { SidebarState } from './model'
import { knownProfiles, profileLabel, profilesInUse } from './profiles'
import type { Action } from './sidebar-actions'

/** Sites on the list of exclusions: the bound of the list of cookies to keep, which it is edited like. */
export const CLEAR_ALL_KEEP_MAX = COOKIE_KEEP_HOSTS_MAX

/** A saved or imported list: valid hosts, spelled as the blocker's exceptions are (no « www. »), each once, bounded. */
export const cleanClearAllKeep = cleanKeepHosts

/** The list with a site added or taken out (taking out removes the exact entry). */
export const withClearAllKept = withKeptSite

/** The origins whose storage survives: each spared host over both schemes, with and without « www. » (an origin is exact, a subdomain is another one). */
export function keptOrigins(hosts: readonly string[]): string[] {
  return hosts.flatMap((host) => [`https://${host}`, `http://${host}`, `https://www.${host}`, `http://www.${host}`])
}

/**
 * What the engine wipes by origin when a list spares some sites: everything the session holds but the cookies, which are removed one by one by the
 * rule of the cookie manager (the engine's origin filter does not follow the domain of a cookie).
 */
export const CLEAR_ALL_STORAGE_TYPES = ['backgroundFetch', 'cache', 'downloads', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'] as const

/** The cookies the erasure removes: the whole jar but the cookies of the spared sites. */
export function spareKept(cookies: readonly CookieEntry[], keepHosts: readonly string[]): CookieEntry[] {
  return cookiesToClean(cookies, keepHosts)
}

export type ClearAllScope = 'profile' | 'all'

/** The profiles an erasure reaches: the one of the space in front, or every profile a space uses. */
export function profilesToClear(state: SidebarState, currentProfile: string, scope: ClearAllScope): string[] {
  return scope === 'all' ? profilesInUse(state) : [currentProfile]
}

/** One button of the confirmation: the scope it answers (null for « Annuler »). */
export interface ClearAllChoice {
  scope: ClearAllScope | null
  label: string
}

/** The buttons of the confirmation: the current profile first, every profile when there are several, and « Annuler » last (the default button). */
export function clearAllChoices(state: SidebarState): ClearAllChoice[] {
  return [
    { scope: 'profile', label: t('clear-all.tout-effacer') },
    ...(profilesInUse(state).length > 1 ? [{ scope: 'all' as const, label: t('clear-all.effacer-tous-les-profils') }] : []),
    { scope: null, label: t('confirm-box.annuler') }
  ]
}

export type ClearAllKind = 'everything' | 'identity'

/** The confirmation of « Tout effacer » and of « Nouvelle identité »: what goes, what is spared, and what the second one does more. */
export function clearAllPrompt(state: SidebarState, profileId: string, kind: ClearAllKind): { message: string; detail: string } {
  const spared = state.settings.clearAllKeepHosts.length
  const several = knownProfiles(state).length > 1
  const name = profileLabel(state.settings, profileId)
  const message =
    kind === 'identity'
      ? several ? t('clear-all.nouvelle-identite-dans-le-profil-name', { name }) : t('clear-all.nouvelle-identite')
      : several ? t('clear-all.tout-effacer-dans-le-profil-name', { name }) : t('clear-all.tout-effacer-titre')
  const erased = spared === 0 ? t('clear-all.cookies-connexions-stockage-cache-et-historique-effaces') : tp('clear-all.cookies-connexions-stockage-cache-et-historique-effaces-sauf', spared)
  const parts = [erased]
  if (kind === 'identity') parts.push(t('clear-all.les-onglets-de-ce-profil-se-ferment-et-une-nouvelle'))
  else parts.push(t('clear-all.les-onglets-ouverts-se-rechargent'))
  parts.push(t('clear-all.les-conteneurs-ne-sont-pas-effaces'))
  if (several) parts.push(t('clear-all.effacer-tous-les-profils-etend-l-effacement'))
  return { message, detail: parts.join('\n\n') }
}

/**
 * « Nouvelle identité »: after the erasure, the tabs of the erased profiles' spaces are closed (a pinned tab only goes back to its anchor address, as
 * closing it always does) and the archive loses what those spaces held, so that « Rouvrir le dernier onglet fermé » brings nothing of the old identity back.
 */
export function identityActions(state: SidebarState, profileIds: readonly string[]): Action[] {
  const spaces = new Set(state.spaces.filter((space) => profileIds.includes(space.profileId)).map((space) => space.id))
  const spared = state.spaces.map((space) => space.id).filter((id) => !spaces.has(id))
  return [...state.tabs.filter((tab) => spaces.has(tab.spaceId) && tab.private !== true).map((tab): Action => ({ type: 'tab/close', id: tab.id })), { type: 'archive/clear', keepSpaces: spared }]
}
