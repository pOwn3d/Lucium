// The system the interface runs on, as the snapshot says it: the keys a hint draws (⌘↩ or Ctrl+Entrée) and the modifier a handler reads follow it.

import { platformOf, type PlatformId } from '@shared/platform'
import { useSnapshot } from './api'

/** The platform of the snapshot. Before the first snapshot has come it is not known, and every hint is drawn for what `platformOf` makes of an absent value. */
export function usePlatform(): PlatformId {
  return platformOf(useSnapshot()?.platform)
}
