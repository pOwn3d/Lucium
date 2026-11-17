// What "close" does to a tab, wherever it is asked (the cross of its row in the sidebar, the task manager): a Today tab is archived
// (it can come back); a pinned tab that is open is only put back to sleep on its anchor; one already asleep has nothing left to close, so it
// leaves the pinned ones (to the archive, with the usual "Annuler"). A tab opened from a favourite only closes: the favourite stays.

import type { Action } from './sidebar-actions'

export type TabCloseAction = 'tab/archive' | 'tab/close' | 'tab/remove-pinned'

export function tabCloseAction(tab: { pinned?: boolean; favoriteId?: string }, asleep: boolean): TabCloseAction {
  if (!tab.pinned) return 'tab/archive'
  return asleep && tab.favoriteId === undefined ? 'tab/remove-pinned' : 'tab/close'
}

/**
 * What « Fermer l’onglet » does where it is written out (the menu of a tab, of several tabs, the card over a row): a Today tab goes to the archive,
 * as with ⌘W and the cross of its row, so that « Rouvrir le dernier onglet fermé » brings it back; a pinned tab is put back to sleep on its anchor.
 */
export function menuCloseAction(tab: { id: string; pinned?: boolean }): Action {
  return { type: tab.pinned ? 'tab/close' : 'tab/archive', id: tab.id }
}

/**
 * What the cross of a split view does to all its tabs at once. Today tabs of a normal window leave together: one archive, so one "Annuler" brings
 * them all back. Otherwise (pinned tabs, a private window, which keeps no archive) each tab does what the cross of its own row does.
 */
export function splitCloseActions(tabs: ReadonlyArray<{ id: string; pinned?: boolean; favoriteId?: string; private?: boolean }>, asleep: (id: string) => boolean): Action[] {
  if (tabs.length > 0 && tabs.every((tab) => !tab.pinned && !tab.private)) return [{ type: 'tabs/archive-many', ids: tabs.map((tab) => tab.id) }]
  return tabs.map((tab) => ({ type: tabCloseAction(tab, asleep(tab.id)), id: tab.id }))
}
