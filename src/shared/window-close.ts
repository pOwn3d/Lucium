// "Avertir avant de fermer une fenêtre de plusieurs onglets" (Settings › Général). Pure rules: whether closing a window is worth a
// question, and what the question says. The main process asks it (shell/close-guard.ts); nothing here touches Electron.

import type { SidebarState } from './model'
import { t } from './i18n'

/** What the rule needs to know about the window being closed and about the others. */
export interface WindowCloseFacts {
  kind: 'main' | 'window' | 'private'
  /** A guest window: private underneath, and told so in its own words. */
  guest?: true
  /** How many browser windows are open, this one included (a Settings or a mini window is not one). */
  windows: number
  /** The application is quitting: the window goes with everything else, and the question about quitting was already asked. */
  quitting: boolean
  /** The tabs the window shows: all of a private window's, the ones of the space on screen for a normal window. */
  tabs: number
  /** The name of the space on screen (a normal window), told in the question. */
  space?: string
}

export interface WindowCloseWarning {
  message: string
  detail: string
}

/** A window shows several tabs from this many on. */
export const SEVERAL_TABS = 2

/** The tabs a window shows: every tab of a private window (they go with it), the tabs of the space on screen otherwise. */
export function windowTabCount(state: SidebarState, kind: WindowCloseFacts['kind']): number {
  return kind === 'private' ? state.tabs.length : state.tabs.filter((t) => t.spaceId === state.activeSpaceId).length
}

/**
 * The question to ask before closing a window, or null to close it without one. Never for the last window (closing it already is
 * quitting, and "Avertir avant de quitter" is the setting for that), never while the application quits, never for a window with one
 * tab or none. The switch itself (`enabled`) is the caller's: when it is off nothing here is even reached.
 */
export function closeWarning(facts: WindowCloseFacts): WindowCloseWarning | null {
  if (facts.quitting || facts.windows <= 1 || facts.tabs < SEVERAL_TABS) return null
  if (facts.kind === 'private' && facts.guest === true) {
    return { message: t('window-close.fermer-cette-fenetre-invite'), detail: t('window-close.ses-tabs-onglets-seront-perdus-une-fenetre', { tabs: facts.tabs }) }
  }
  if (facts.kind === 'private') {
    return { message: t('window-close.fermer-cette-fenetre-privee'), detail: t('window-close.ses-tabs-onglets-seront-perdus-une-fenetre-2', { tabs: facts.tabs }) }
  }
  const others = facts.windows - 1
  if (facts.kind === 'main') {
    const closing = others === 1 ? t('window-close.l-autre-fenetre-se-fermera-avec-elle') : t('window-close.les-others-autres-fenetres-se-fermeront-avec', { others })
    return { message: t('window-close.fermer-la-fenetre-principale'), detail: t('window-close.closing-les-onglets-de-vos-espaces-reviendront', { closing }) }
  }
  const where = facts.space ? t('window-close.de-l-espace-space', { space: facts.space }) : ''
  return { message: t('window-close.fermer-cette-fenetre'), detail: t('window-close.ses-tabs-onglets-where-restent-dans-la-barre', { tabs: facts.tabs, where }) }
}
