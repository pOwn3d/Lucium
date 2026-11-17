// Mode compact (Réglages › Fonctions › Mode compact). One command puts the sidebar and the toolbar away together; the sidebar comes back,
// floating, when the pointer touches the window's edge, and there the tab on screen shows the page's address in place of its title.
//
// There is no state of its own: a window is compact when the function is on and both bars are hidden by the two settings that already exist
// (View › Hide Sidebar, View › Hide Toolbar). So the existing commands keep working, the layout code of the window is untouched, and the
// settings that describe the layout stay what they have always been (per window, see private-window.ts).

import type { Settings } from './model'
import { toolbarAddress } from './toolbar'
import { t } from './i18n'

export type CompactLook = Pick<Settings, 'compactMode' | 'sidebarVisible' | 'showToolbar'>

/** Whether the window is compact now: the function is on, and neither the sidebar nor the toolbar is shown. */
export const isCompact = (look: CompactLook): boolean => look.compactMode === true && !look.sidebarVisible && !look.showToolbar

/**
 * What the one command changes: both bars away, or (when the window already is compact) both back. Null when the function is off: the
 * command does nothing then, whoever asks (a shortcut the user gave it, the command bar, a menu entry that is hidden).
 * Coming back shows both bars, as a fresh window has them; the layout the window had before is not remembered.
 */
export function compactPatch(look: CompactLook): Pick<Settings, 'sidebarVisible' | 'showToolbar'> | null {
  if (look.compactMode !== true) return null
  return isCompact(look) ? { sidebarVisible: true, showToolbar: true } : { sidebarVisible: false, showToolbar: false }
}

/** The wording of the command, which says what it will do. */
export const compactLabel = (compact: boolean): string => (compact ? t('compact.quitter-le-mode-compact') : t('compact.passer-en-mode-compact'))

/** The address the tab on screen shows in place of its title: the site's name, or the whole address when the toolbar would show it whole. */
export function compactAddress(url: string, fullUrl: boolean): string {
  const { host, rest } = toolbarAddress(url, fullUrl)
  return host === '' ? url : `${host}${rest}`
}
