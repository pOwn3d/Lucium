// Erasing what a profile holds, and cleaning the profiles no space uses. No Electron here: the session, the history and the open tabs
// come in through `ProfileEraseDeps`, so each rule is tested with stand-ins (profile-erase.test.ts).

import { t } from '@shared/i18n'
import { forgetTranslations } from './translation-traces'

export interface ProfileEraseDeps {
  /** Cookies, storage and cache of the profile's session. */
  clearEngine(profileId: string): Promise<void>
  /** The visit history of the profile and its file; answers whether nothing of it is left on disk. */
  eraseHistory(profileId: string): boolean
  /** The tabs of the profile reload, so that they do not keep showing a signed-in page. */
  reloadTabs(profileId: string): void
}

/**
 * Erases a profile's session data and its visit history. Both are tried whatever happens to the other, and the tabs reload when the
 * session was cleared; what could not be erased is thrown at the end (and logged with the profile), so that the caller never says
 * "erased" for a profile that kept something.
 */
export async function eraseProfile(deps: ProfileEraseDeps, profileId: string): Promise<void> {
  // The texts of the pages translated in this session are browsing traces too (translation-traces.ts): they go first, whatever happens next.
  forgetTranslations()
  // Why the session was not cleared, if it was not.
  let sessionKept: string | null = null
  try {
    await deps.clearEngine(profileId)
  } catch (error) {
    console.error(`[profile] cannot erase the cookies and storage of profile ${profileId}:`, error)
    sessionKept = String((error as Error)?.message ?? error)
  }
  const historyKept = !deps.eraseHistory(profileId)
  if (sessionKept === null) deps.reloadTabs(profileId)
  // One sentence for each case: what was kept is named in the order of the language, not joined from pieces.
  if (sessionKept !== null && historyKept) throw new Error(t('profile-erase.impossible-d-effacer-les-cookies-et-le-stockage-reason-et-l-historique', { reason: sessionKept }))
  if (sessionKept !== null) throw new Error(t('profile-erase.impossible-d-effacer-les-cookies-et-le-stockage-reason', { reason: sessionKept }))
  if (historyKept) throw new Error(t('profile-erase.impossible-d-effacer-l-historique-de-ce-profil'))
}

/**
 * Erases each of these profiles (the ones no space uses). One that cannot be erased does not stop the others; they are named in the
 * error thrown at the end. Answers how many were cleaned.
 */
export async function eraseProfiles(erase: (profileId: string) => Promise<void>, profileIds: readonly string[]): Promise<number> {
  const failed: string[] = []
  for (const id of profileIds) {
    try {
      await erase(id)
    } catch (error) {
      console.error(`[profile] cannot clean the unused profile ${id}:`, error)
      failed.push(id)
    }
  }
  if (failed.length > 0) {
    const ids = failed.join(', ')
    throw new Error(failed.length === 1 ? t('profile-erase.impossible-de-nettoyer-le-profil-ids', { ids }) : t('profile-erase.impossible-de-nettoyer-les-profils-ids', { ids }))
  }
  return profileIds.length
}

export interface BrowsingHistoryDeps {
  /** The visit history of the profile and its file; answers whether nothing of it is left on disk. */
  eraseHistory(profileId: string): boolean
  /** The sites of the “Récents” list of the panel “Effacer les données du site…”. */
  recentSites(): readonly string[]
  /** Empties that list in the settings. */
  forgetRecentSites(): void
  /** The sites already offered their search (`searchDiscoverySeen`): hosts of pages that were visited. */
  offeredSearchSites(): readonly string[]
  /** Empties that list in the settings: a site visited again is offered its search once more. */
  forgetOfferedSearchSites(): void
}

/**
 * “Effacer l’historique de navigation…”: the history of the profile, and with it the “Récents” list of the site-data panel, which keeps in
 * the state file the addresses of sites the user visited and wanted to forget. The list is common to every profile (it cannot tell whose site
 * a name is), so it goes whichever profile's history is erased. It goes even when the history could not be fully erased or the erasure threw:
 * the user asked to forget, and the list is a convenience that costs a few clicks to rebuild. The same goes, for the same reasons, for the sites
 * already offered their search: up to two hundred hosts of visited pages, kept in the state file with no other way to empty them. Answers what
 * `eraseHistory` answered.
 */
export function eraseBrowsingHistory(deps: BrowsingHistoryDeps, profileId: string): boolean {
  try {
    return deps.eraseHistory(profileId)
  } finally {
    if (deps.recentSites().length > 0) deps.forgetRecentSites()
    if (deps.offeredSearchSites().length > 0) deps.forgetOfferedSearchSites()
    // The texts of the pages translated in this session say what was read as the history does (translation-traces.ts).
    forgetTranslations()
  }
}
