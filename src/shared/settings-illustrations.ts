// The animated cards of the Settings: a setting whose effect is seen better than it is told gets a "Voir l'effet" button that opens a small scene under
// its row. The scenes are drawn in CSS (settings-illustrations.css), with no picture, video or script; this file says which setting has one, what its
// caption says, and the shortcut its tip names.
//
// The list is the 16 settings estimated to be the most used: 13 are
// rows of the essential level, so their button shows as the window opens. The six scenes drawn before that list and left out of it stay under their
// rows, after the 16: they cost nothing while their card is closed.

import { effectiveAccelerator, formatAccelerator, type KeyBindings } from './keybindings'
import { t, type MessageKey } from './i18n'
import type { SettingKey } from './settings-catalog'

export interface Illustration {
  /** The setting it shows, and the id of its scene (`data-illu`). */
  key: SettingKey
  /** What the scene shows, in a sentence. */
  caption: MessageKey
  /** A line under the caption that names the gesture or the shortcut that goes with it. */
  tip?: { text: MessageKey; /** The command whose shortcut fills `{shortcut}`. */ command?: string }
}

/** The 16 of the list, in its order, then the six scenes kept outside it. */
export const ILLUSTRATIONS: readonly Illustration[] = [
  { key: 'interfaceAppearance', caption: 'settings-illustrations.appearance' },
  { key: 'uiScale', caption: 'settings-illustrations.ui-scale' },
  { key: 'sidebarRight', caption: 'settings-illustrations.sidebar-right' },
  { key: 'compactMode', caption: 'settings-illustrations.compact' },
  { key: 'sleepAfterMinutes', caption: 'settings-illustrations.sleep', tip: { text: 'settings-illustrations.sleep-tip' } },
  { key: 'autoArchiveHours', caption: 'settings-illustrations.archive', tip: { text: 'settings-illustrations.archive-tip', command: 'archive' } },
  { key: 'restoreWindows', caption: 'settings-illustrations.restore-windows' },
  { key: 'searchSuggestions', caption: 'settings-illustrations.search-suggestions' },
  { key: 'littleArcShortcut', caption: 'settings-illustrations.mini-window' },
  { key: 'blockAds', caption: 'settings-illustrations.block-ads' },
  { key: 'blockCookieBanners', caption: 'settings-illustrations.cookie-banners' },
  { key: 'downloadAskWhere', caption: 'settings-illustrations.ask-where' },
  { key: 'boostsEnabled', caption: 'settings-illustrations.boosts' },
  { key: 'hoverCards', caption: 'settings-illustrations.hover-cards' },
  { key: 'dragToSplit', caption: 'settings-illustrations.drag-to-split', tip: { text: 'settings-illustrations.drag-to-split-tip', command: 'closeSplitPane' } },
  { key: 'peekWithShift', caption: 'settings-illustrations.peek' },
  // Drawn before the list, kept outside it.
  { key: 'tabTree', caption: 'settings-illustrations.tab-tree' },
  { key: 'tabCycleRecent', caption: 'settings-illustrations.tab-cycle' },
  { key: 'readableMode', caption: 'settings-illustrations.readable-mode' },
  { key: 'reduceFingerprint', caption: 'settings-illustrations.fingerprint' },
  { key: 'tidyDownloads', caption: 'settings-illustrations.tidy-downloads' },
  { key: 'mouseGestures', caption: 'settings-illustrations.gestures' }
]

/** The scene of a setting, or undefined when it has none. */
export const illustrationOf = (key: string | undefined): Illustration | undefined => (key === undefined ? undefined : ILLUSTRATIONS.find((illustration) => illustration.key === key))

/**
 * The tip of a scene: its sentence, with the shortcut the user has now (their own if they changed it). Null when the scene has no tip, or when the
 * command it names has no shortcut: a tip never names a key that does nothing.
 */
export function illustrationTip(illustration: Illustration, bindings: KeyBindings): string | null {
  const tip = illustration.tip
  if (!tip) return null
  if (tip.command === undefined) return t(tip.text)
  const accelerator = effectiveAccelerator(tip.command, bindings)
  return accelerator ? t(tip.text, { shortcut: formatAccelerator(accelerator) }) : null
}
