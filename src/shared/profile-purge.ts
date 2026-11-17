// "Supprimer les profils inutilisés" (Settings › Profils › Nettoyer): which profiles it erases, what the user is shown before it does, and what the
// pane says after. Erasing a profile's data cannot be undone, so the first click erases nothing: it lists the profiles, and only the box's
// confirmation erases (and then only those that were listed). No Electron and no DOM here: the pane and the main process hand in what they have.

import { eraseFailureText } from './history-scope'
import { t, tp } from './i18n'
import { isProfileId } from './profiles'

/** How many profiles the confirmation names before it sums up the rest. */
export const PURGE_LIST_MAX = 6

/** The most profiles one cleaning may be asked to erase (the main process refuses a longer list). */
export const PURGE_REQUEST_MAX = 500

/** The profiles a request to erase names, or null for anything but a plain list of profile names (a request like that erases nothing). */
export function parsePurgeRequest(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > PURGE_REQUEST_MAX || !raw.every(isProfileId)) return null
  return raw
}

export interface PurgeFacts {
  /** Profiles that have a session on disk (cookies, storage). */
  stored: readonly string[]
  /** Profiles that have a visit history. A profile can have one without the other, so both are looked at. */
  withHistory: readonly string[]
  /** Profiles a space uses, a space put aside included (it is waiting for its cookies and logins). */
  used: readonly string[]
}

/** The profiles nobody uses and that still hold data: what "Nettoyer" would erase. Ids that are not a plain profile name are never touched. */
export function unusedProfileIds(facts: PurgeFacts): string[] {
  const used = new Set(facts.used)
  return [...new Set([...facts.stored, ...facts.withHistory])].filter((id) => !used.has(id) && isProfileId(id))
}

/**
 * What is erased once the user confirmed: the profiles of the list they saw that are still unused. A profile that a space started to use in the
 * meantime (another window) is kept, and one that became unused after the list was shown is not erased, since nobody agreed to it.
 */
export function confirmedPurge(confirmed: readonly string[], unusedNow: readonly string[]): string[] {
  const unused = new Set(unusedNow)
  return [...new Set(confirmed)].filter((id) => unused.has(id))
}

export interface PurgePrompt {
  title: string
  message: string
  /** The profiles, by name (the first few, then how many more). */
  items: string[]
  confirm: string
}

/** The box asked before the unused profiles are erased: it names them, since the data goes with them. */
export function purgePrompt(names: readonly string[]): PurgePrompt {
  const shown = names.slice(0, PURGE_LIST_MAX)
  const more = names.length - shown.length
  return {
    title: t('settings-profiles.effacer-les-donnees-des-profils-inutilises-question'),
    message: tp('settings-profiles.les-donnees-de-count-profils-seront-effacees', names.length),
    items: more > 0 ? [...shown, tp('settings-profiles.et-count-autres-profils', more)] : shown,
    confirm: t('settings-profiles.effacer-les-donnees')
  }
}

/** What the Profiles pane calls on the main process. */
export interface PurgeApi {
  unusedProfiles(): Promise<string[]>
  purgeProfiles(profileIds: string[]): Promise<number>
}

/**
 * The click on "Nettoyer": nothing is erased. The profiles that would be go to `ask` (the confirmation box), or the pane says there are none, or
 * why the list could not be read.
 */
export async function startPurge(api: Pick<PurgeApi, 'unusedProfiles'>, ui: { ask(profileIds: string[]): void; say(text: string): void }): Promise<void> {
  try {
    const ids = await api.unusedProfiles()
    if (ids.length === 0) ui.say(t('settings-profiles.aucun-profil-inutilise'))
    else ui.ask(ids)
  } catch (error) {
    ui.say(eraseFailureText(error))
  }
}

/** The confirmation of the box: the profiles that were listed are erased, and the pane says how many were, or what stayed. */
export async function finishPurge(api: Pick<PurgeApi, 'purgeProfiles'>, profileIds: string[], ui: { say(text: string): void }): Promise<void> {
  try {
    const cleaned = await api.purgeProfiles(profileIds)
    ui.say(cleaned === 0 ? t('settings-profiles.aucun-profil-inutilise') : tp('settings-profiles.donnees-de-count-profils-inutilises-effacees', cleaned))
  } catch (error) {
    ui.say(eraseFailureText(error))
  }
}
