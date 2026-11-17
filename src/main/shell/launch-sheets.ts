// The sheets a launch may open on its own, once the window is up: the first-launch guide of a new profile, else the welcome (N1), and the news of an update (N9). Never both
// (a first launch has no "before"), never over a state that existed (`newProfile`: no state file at the launch), and nothing here reaches the network: the news are the
// changelog that the build put in the application.

import { getLanguage, type Language } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { whatsNewDecision, whatsNewSheetOf } from '@shared/whats-new'
import changelog from '../../../CHANGELOG.md?raw'
import changelogFr from '../../../CHANGELOG.fr.md?raw'

/**
 * The sheet of the news for a version, as the overlay is asked for it (Aide › Nouveautés passes `fromUpdate` false), in the language of the
 * interface: the French changelog for French, else the English one, which is also the fallback when the French one lacks the version.
 */
export function whatsNewRequest(version: string, fromUpdate: boolean, language: Language = getLanguage()): OverlayRequest {
  const french = language === 'fr' ? whatsNewSheetOf(changelogFr, version, fromUpdate) : null
  return { panel: 'whatsnew', sheet: french && french.points.length > 0 ? french : whatsNewSheetOf(changelog, version, fromUpdate) }
}

export interface LaunchHost {
  /**
   * No state file existed when this launch started (store.ts `readState`, `fresh`): a new profile. What the file says cannot tell it, since an older
   * file has none of the newer flags: a profile with tabs is never taken for a new one.
   */
  newProfile: boolean
  settings(): Pick<Settings, 'welcomeDone' | 'whatsNewSheet' | 'lastSeenVersion' | 'firstLaunchDone'>
  update(patch: Partial<Pick<Settings, 'welcomeDone' | 'lastSeenVersion' | 'firstLaunchDone'>>): void
  open(request: OverlayRequest): void
}

/**
 * Opens the sheet this launch calls for, if any, and notes in the state that it was seen.
 *
 * The first-launch guide (FirstLaunchSheet) opens by itself on a new profile, once (decision of 3 November 2026): `firstLaunchDone` is written
 * at once, with the welcome and the version as seen, so that neither the welcome nor the news follows it at the next launch. There is no setting for it: a
 * new profile has only the defaults, so a switch could never be turned off before the one launch it would decide. The welcome sheet stays for a new
 * profile whose guide is already noted as shown. An existing profile sees neither by itself (Aide › Premier lancement opens the guide), whatever its file says: a file written
 * before the flags existed has `welcomeDone` false (the default) and no `lastSeenVersion`, and it is still a profile that was used (decision of 3 November 2026).
 */
export function showLaunchSheet(host: LaunchHost, version: string): 'welcome' | 'firstlaunch' | 'whatsnew' | null {
  const settings = host.settings()
  const fresh = settings.lastSeenVersion === ''

  if (host.newProfile && !settings.firstLaunchDone) {
    host.update({ firstLaunchDone: true, welcomeDone: true, lastSeenVersion: version })
    host.open({ panel: 'firstlaunch' })
    return 'firstlaunch'
  }

  if (host.newProfile && !settings.welcomeDone && fresh) {
    // The first launch ever: the version is noted without news, there is nothing it changed.
    host.update({ welcomeDone: true, lastSeenVersion: version })
    host.open({ panel: 'welcome' })
    return 'welcome'
  }
  const decision = whatsNewDecision({ enabled: settings.whatsNewSheet, last: settings.lastSeenVersion, current: version })
  if (decision === 'none') return null
  host.update({ lastSeenVersion: version })
  if (decision === 'record') return null
  host.open(whatsNewRequest(version, true))
  return 'whatsnew'
}

/** The sheet waits this long after the layer of the panels has drawn its first page: a request sent before that is lost. */
export const LAUNCH_SHEET_DELAY_MS = 600

/** What the timer of the launch sheet reads of the window and of the layer of its panels. */
export interface LaunchSheetTarget {
  /** The window is gone (closed by the user, or by a quit, before the timer ran). */
  windowGone(): boolean
  /** The layer of the panels has not drawn its first page yet. */
  layerLoading(): boolean
  /** Calls back once the layer has drawn its first page. */
  onceLayerLoaded(listener: () => void): void
}

/**
 * Shows the launch sheet a moment after the layer of the panels is ready. A window closed meanwhile (a quit within the first seconds, a private or a
 * guest window closed at once) gets nothing: opening a panel on it reads the bounds of a destroyed window, which throws "Object has been destroyed"
 * out of the timer, where nothing catches it.
 */
export function scheduleLaunchSheet(target: LaunchSheetTarget, show: () => void, delayMs = LAUNCH_SHEET_DELAY_MS): void {
  const later = (): void => {
    setTimeout(() => {
      if (target.windowGone()) return
      show()
    }, delayMs)
  }
  if (target.layerLoading()) target.onceLayerLoaded(later)
  else later()
}
