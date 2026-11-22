// A missing profile: a space whose profile has lost its data on this computer (the folder was deleted, the state file came from
// another Mac) goes back to the default profile, and the user is told which spaces. A profile has no folder until a page uses it, so
// only a profile that was *used* can be missing: the first page of a profile marks it (`usedProfiles`).

import type { SidebarState, Space } from './model'
import { pruneUsageProfiles } from './command-bar-usage'
import { isProfileId } from './profiles'
import { t } from './i18n'

/** Profiles in the list: far more than anyone makes, and a bound for a hand-edited file. */
export const USED_PROFILES_MAX = 100

/** What a saved list may hold: valid profile ids, each once, never the default profile (it always exists). */
export function cleanUsedProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== 'default' && isProfileId(id)))].slice(0, USED_PROFILES_MAX)
}

/** The list with a profile added; the same array when it is the default profile, already there, or not a profile id. */
export function markUsed(used: readonly string[], id: string): readonly string[] {
  if (id === 'default' || !isProfileId(id) || used.includes(id) || used.length >= USED_PROFILES_MAX) return used
  return [...used, id]
}

/** The used profiles that a space still points at and whose storage is no longer on disk. */
export function missingProfiles(state: SidebarState, stored: readonly string[]): string[] {
  const inUse = new Set(state.spaces.map((space) => space.profileId))
  return state.settings.usedProfiles.filter((id) => id !== 'default' && inUse.has(id) && !stored.includes(id))
}

/** The spaces that use one of those profiles. */
export const spacesOf = (state: SidebarState, profiles: readonly string[]): Space[] => state.spaces.filter((space) => profiles.includes(space.profileId))

/** The state with those spaces back on the default profile, and the profiles no longer marked as used. */
export function revertMissing(state: SidebarState, profiles: readonly string[]): SidebarState {
  const affected = spacesOf(state, profiles)
  if (affected.length === 0) return state
  // The command bar's ranking of a profile that is no longer used goes with it, as `normalize` would drop it at the next launch (the invariants test caught the gap).
  return pruneUsageProfiles({
    ...state,
    spaces: state.spaces.map((space) => (profiles.includes(space.profileId) ? { ...space, profileId: 'default' } : space)),
    settings: { ...state.settings, usedProfiles: state.settings.usedProfiles.filter((id) => !profiles.includes(id)) }
  })
}

/**
 * The dialog that says what happened. The sentence speaks of one space or of several, and shows no number (the list follows it): two
 * sentences rather than the forms of a count, which would need one.
 */
export function missingProfileDialog(spaces: readonly Space[], copyName?: string): { message: string; detail: string } {
  const sentence = spaces.length > 1 ? t('profile-recovery.il-semble-qu-un-ou-plusieurs-profils-espaces') : t('profile-recovery.il-semble-qu-un-ou-plusieurs-profils-espace')
  // `copyName`: the file the state was copied to before the spaces changed profile, when it could be: the way back if the profile's folder returns.
  const kept = copyName ? `\n\n${t('profile-recovery.copie-gardee', { file: copyName })}` : ''
  return {
    message: t('profile-recovery.profil-manquant'),
    detail: `${sentence}\n\n${spaces.map((space) => `${space.emoji} ${space.name}`).join('\n')}${kept}`
  }
}
