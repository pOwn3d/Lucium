// A deleted profile ("Supprimer le profil et ses données", Réglages › Profils). Its data is erased at once, but Electron keeps the session of a
// partition open until the application quits, and Chromium keeps in its folder what no erasure reaches (preferences, the storage of the extensions
// of the folders loaded by hand…). So the id of the profile is *retired*: no new profile is given it while its folder may be on disk, so that a
// profile made again under the same name starts empty, in a folder of its own; at the next launch, before any page, the folders of the retired
// profiles are removed and their ids are free again.

import type { Settings, SidebarState } from './model'
import { isProfileId, knownProfiles } from './profiles'

/** Retired ids kept: far more than anyone deletes between two launches, and a bound for a hand-edited file. */
export const RETIRED_PROFILES_MAX = 256

/** What a saved list may hold: valid profile ids, each once, never the default profile (it cannot be deleted). */
export function cleanRetiredProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== 'default' && isProfileId(id)))].slice(0, RETIRED_PROFILES_MAX)
}

/** Why a profile cannot be deleted, or null: the default profile, a profile a space uses (even a space put aside), an id that is not one. */
export function profileDeletionRefusal(state: SidebarState, profileId: string): 'invalid' | 'default' | 'in-use' | null {
  if (!isProfileId(profileId)) return 'invalid'
  if (profileId === 'default') return 'default'
  const inUse = state.spaces.some((space) => space.profileId === profileId) || state.sessions.some((session) => session.space?.space.profileId === profileId)
  return inUse ? 'in-use' : null
}

type RetiredKeys = Pick<Settings, 'profileNames' | 'profiles' | 'usedProfiles' | 'retiredProfileIds'>

/**
 * The settings once a profile is deleted: its name, its own settings and its mark of use go (a profile made later under its id must not be taken for a
 * missing one), and its id is retired.
 */
export function retiredSettings(settings: RetiredKeys, profileId: string): RetiredKeys {
  const { [profileId]: _name, ...profileNames } = settings.profileNames
  const { [profileId]: _own, ...profiles } = settings.profiles
  const retired = settings.retiredProfileIds.includes(profileId) ? settings.retiredProfileIds : [...settings.retiredProfileIds, profileId]
  return { profileNames, profiles, usedProfiles: settings.usedProfiles.filter((id) => id !== profileId), retiredProfileIds: retired.slice(-RETIRED_PROFILES_MAX) }
}

/**
 * The retired profiles whose folders may be removed at this launch: none when the state was not read (or a set-aside copy of it is kept, see
 * `stateTrusted` in index.ts), and never one that exists again (a restored file can name it).
 */
export function retiredToSweep(state: SidebarState, stateTrusted: boolean): string[] {
  if (!stateTrusted) return []
  const known = new Set(knownProfiles(state))
  return state.settings.retiredProfileIds.filter((id) => !known.has(id))
}
