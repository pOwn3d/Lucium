// The ranking of the command bar: how often each page was picked there, a bonus when the bar sorts its lines. It is history (whole addresses, kept in
// the state file), so it is kept as the history is: one ranking per profile. A space reads and teaches the ranking of its own profile only, erasing the
// history of a profile empties its ranking and no other, and nothing is ever copied from one profile to another. Pure rules, shared by the reducer
// (sidebar-settings.ts, sidebar-library.ts), the cleaning of a file (sidebar-state.ts) and the bar (command-bar.ts).

import type { SidebarState } from './model'
import { isProfileId, knownProfiles, profileOfSpace } from './profiles'
import { hostBelongsToSite } from './site-data'
import { USAGE_KEY_PREFIX } from './sidebar-helpers'

/** How many pages the ranking of one profile keeps: past it, the least picked go. */
export const USAGE_LIMIT = 300
/** The longest key a ranking keeps (the prefix and an address). */
export const USAGE_KEY_MAX = 400

export type ProfileUsage = Record<string, number>
export type CommandBarUsage = Record<string, ProfileUsage>

const NONE: ProfileUsage = Object.freeze({}) as ProfileUsage

/** The ranking of one profile (empty when it has none). */
export const usageOfProfile = (state: Pick<SidebarState, 'commandBarUsage'>, profileId: string): ProfileUsage =>
  Object.hasOwn(state.commandBarUsage, profileId) ? state.commandBarUsage[profileId]! : NONE

/** The ranking the bar reads: the one of the profile of the space on screen. */
export const usageOnScreen = (state: SidebarState): ProfileUsage => usageOfProfile(state, profileOfSpace(state, state.activeSpaceId))

/** The rankings with `usage` as the one of `profileId`; a profile whose ranking is empty has no entry. */
function withProfileUsage(all: CommandBarUsage, profileId: string, usage: ProfileUsage): CommandBarUsage {
  const { [profileId]: _before, ...others } = all
  return Object.keys(usage).length === 0 ? others : { ...others, [profileId]: usage }
}

/** The rankings after `key` was picked in a space of `profileId`: one more for it there, bounded to the most picked; the other profiles' are untouched. */
export function usageAfterPick(all: CommandBarUsage, profileId: string, key: string): CommandBarUsage {
  // A ranking is listed under the id of a profile, which is a key of this record: nothing else is one.
  if (!isProfileId(profileId)) return all
  const before = Object.hasOwn(all, profileId) ? all[profileId]! : NONE
  const usage = { ...before, [key]: (before[key] ?? 0) + 1 }
  const keys = Object.keys(usage)
  if (keys.length <= USAGE_LIMIT) return { ...all, [profileId]: usage }
  const kept = keys.sort((a, b) => usage[b]! - usage[a]!).slice(0, USAGE_LIMIT)
  return { ...all, [profileId]: Object.fromEntries(kept.map((k) => [k, usage[k]!])) }
}

/**
 * The rankings once the history of `profileId` is forgotten: that profile's is emptied, or loses the addresses of `site` when only a site is
 * forgotten. The rankings of the other profiles stay as they are. The same object when nothing leaves.
 */
export function usageAfterForgetting(all: CommandBarUsage, profileId: string, site: { host: string; subdomains: boolean } | undefined): CommandBarUsage {
  if (!Object.hasOwn(all, profileId)) return all
  const usage = all[profileId]!
  if (site === undefined) return withProfileUsage(all, profileId, NONE)
  const keys = Object.keys(usage)
  const kept = keys.filter((key) => {
    const url = key.startsWith(USAGE_KEY_PREFIX) ? key.slice(USAGE_KEY_PREFIX.length) : key
    return !(URL.canParse(url) && hostBelongsToSite(new URL(url).host, site.host, site.subdomains))
  })
  return kept.length === keys.length ? all : withProfileUsage(all, profileId, Object.fromEntries(kept.map((key) => [key, usage[key]!])))
}

/** The most pages one forgetting names: a whole day of the history panel fits, and a list from the interface is never walked without an end. */
export const USAGE_FORGET_MAX = 20_000
/** The highest count a page comes back with: far above what a person picks, and a number that stays exact. */
export const USAGE_COUNT_MAX = 1_000_000

const keyOfPage = (url: string): string => `${USAGE_KEY_PREFIX}${url}`

/** How often the page at `url` was picked in the profile (0 when it is not ranked). */
export function usageCountOf(all: CommandBarUsage, profileId: string, url: string): number {
  if (!Object.hasOwn(all, profileId)) return 0
  return all[profileId]![keyOfPage(url)] ?? 0
}

/**
 * The rankings once pages are forgotten in the history of `profileId`: a page that leaves the history leaves the ranking too, or its whole address
 * would stay in the state file and keep coming first in the bar. The other profiles keep theirs. The same object when nothing leaves.
 */
export function usageWithoutPages(all: CommandBarUsage, profileId: string, urls: readonly string[]): CommandBarUsage {
  if (!Object.hasOwn(all, profileId)) return all
  const usage = all[profileId]!
  const gone = new Set(urls.slice(0, USAGE_FORGET_MAX).map(keyOfPage))
  const keys = Object.keys(usage)
  const kept = keys.filter((key) => !gone.has(key))
  return kept.length === keys.length ? all : withProfileUsage(all, profileId, Object.fromEntries(kept.map((key) => [key, usage[key]!])))
}

/**
 * The rankings once a forgotten page is put back in the history of `profileId`, with the `count` it had: added to what it was picked since, as the
 * visits of the page are. Bounded as a pick is. The same object for a count that is not one.
 */
export function usageWithPageBack(all: CommandBarUsage, profileId: string, url: string, count: number): CommandBarUsage {
  const key = keyOfPage(url)
  if (!isProfileId(profileId) || !Number.isSafeInteger(count) || count < 1 || key.length > USAGE_KEY_MAX) return all
  const before = Object.hasOwn(all, profileId) ? all[profileId]! : NONE
  const usage = { ...before, [key]: Math.min(USAGE_COUNT_MAX, (before[key] ?? 0) + count) }
  const keys = Object.keys(usage)
  if (keys.length <= USAGE_LIMIT) return { ...all, [profileId]: usage }
  const kept = keys.sort((a, b) => usage[b]! - usage[a]!).slice(0, USAGE_LIMIT)
  return { ...all, [profileId]: Object.fromEntries(kept.map((k) => [k, usage[k]!])) }
}

/**
 * The ranking of a profile that no longer exists is gone with it: nothing could read it or empty it, and it would come back under a new profile
 * that takes the same id. Same object when nothing goes.
 */
export function pruneUsageProfiles(state: SidebarState): SidebarState {
  const ids = Object.keys(state.commandBarUsage)
  if (ids.length === 0) return state
  const known = new Set(knownProfiles(state))
  const kept = ids.filter((id) => isProfileId(id) && known.has(id))
  return kept.length === ids.length ? state : { ...state, commandBarUsage: Object.fromEntries(kept.map((id) => [id, state.commandBarUsage[id]!])) }
}
