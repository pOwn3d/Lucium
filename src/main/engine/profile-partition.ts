// The name of the Electron partition of a profile. The id ends up in a folder name of the data directory: `persist:profile-x/../../y` would
// name a folder outside the profiles, and `ephemeral:1` or `container:<id>` would hand a tab the session of another browsing context. Only
// a plain id (shared/profiles.ts) makes a partition; anything else is refused, not cleaned up.

import { isProfileId } from '@shared/profiles'

/** `persist:profile-<id>`; throws (after saying what was refused, and for what) when `profileId` is not a plain profile id. */
export function profilePartition(profileId: unknown, what: string): string {
  if (!isProfileId(profileId)) {
    console.error(`[engine] refused ${what} for a profile id that is not a plain id: ${JSON.stringify(profileId)?.slice(0, 80)}`)
    throw new Error('Refused: the profile id is not a plain id')
  }
  return `persist:profile-${profileId}`
}
