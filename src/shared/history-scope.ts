import type { SidebarState } from './model'
import { knownProfiles, profileLabel } from './profiles'
import { t, tp } from './i18n'
import { ipcErrorText } from './ipc-error'

// The visit history belongs to a profile (main/history.ts): what the history panel shows and what "Effacer l'historique de navigation"
// erases is the history of the profile of the space the user is in. These are the words that say so. With a single profile there is
// nothing to tell apart, and the wording stays what it always was.

/** The line under the title of the history panel, or null when there is one profile only. */
export function historyOwnerLine(state: SidebarState, profileId: string): string | null {
  return knownProfiles(state).length > 1 ? t('settings-profiles.profil-label', { label: profileLabel(state.settings, profileId) }) : null
}

/** The confirmation before the history of a profile is erased: `count` pages of `profileId`. */
export function clearHistoryPrompt(state: SidebarState, profileId: string, count: number): { message: string; detail: string } {
  if (knownProfiles(state).length <= 1) {
    return { message: t('history-scope.effacer-tout-l-historique-de-navigation'), detail: tp('history-scope.count-pages-seront-oubliees-les-onglets', count) }
  }
  return {
    message: t('history-scope.effacer-l-historique-du-profil-name', { name: profileLabel(state.settings, profileId) }),
    detail: tp('history-scope.count-pages-seront-oubliees-l-historique-des', count)
  }
}

/**
 * What the Profiles pane says when erasing a profile's data (or cleaning the unused ones) failed. The error crossed IPC, which prefixes it
 * with "Error invoking remote method '…': Error: "; the sentence the main process wrote is what the user needs.
 */
export function eraseFailureText(error: unknown): string {
  const text = ipcErrorText(error).trim()
  return text === '' ? t('history-scope.l-effacement-a-echoue') : text.length > 300 ? `${text.slice(0, 299)}…` : text
}
