import { dialog, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { missingProfileDialog, missingProfiles, spacesOf } from '@shared/profile-recovery'
import type { Engine } from '../engine/types'
import type { StateStore } from '../store'

/**
 * "Missing Profile!": spaces whose profile has lost its data on this computer go back to the default profile, and the user is told
 * which. Run before any page exists: a page would create the storage again and hide the loss. Resolves to the spaces that were reverted.
 *
 * `keepCopy` copies the state file as it was read, before the spaces change profile, and answers the path of the copy. A folder of profiles that is
 * only away for a moment (a backup being put back, a disk not mounted yet) must not cost the user which space was on which profile: the dialog
 * names the copy, which Help › Restore Data takes. When the copy fails the spaces go back to the default profile all the same (a page on a profile
 * without its data would hide the loss), and the journal says why there is no copy.
 */
export async function recoverMissingProfiles(store: StateStore, engine: Pick<Engine, 'storedProfileIds'>, win: BrowserWindow, keepCopy?: () => string): Promise<string[]> {
  const state = store.get()
  const lost = missingProfiles(state, engine.storedProfileIds())
  if (lost.length === 0) return []
  const spaces = spacesOf(state, lost)
  let copy: string | undefined
  if (keepCopy) {
    try {
      copy = basename(keepCopy())
    } catch (error) {
      console.error('[profiles] the state could not be copied before its spaces go back to the default profile:', error)
    }
  }
  store.dispatch({ type: 'profile/revert-missing', ids: lost })
  await dialog.showMessageBox(win, { type: 'warning', ...missingProfileDialog(spaces, copy) })
  return spaces.map((space) => space.id)
}
