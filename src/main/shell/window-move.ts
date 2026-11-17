// "Déplacer vers la fenêtre" in the menu of a tab, once the window is known (an open one, or one just opened for it): the tabs that go and the place they
// take are decided by shared/window-move.ts, the move is the drag's own (runTransfer). The browser opens, closes and brings the windows to the front.

import { splitToRestore, tabsToSend, windowMoveRefusal, windowMoveTarget } from '@shared/window-move'
import { runTransfer, type TransferLock, type TransferResult, type TransferShared, type TransferSide } from './tab-transfer'

export interface WindowSend {
  result: TransferResult
  /** The tabs the move was about: the tab and the other panes of its split view (none when it was refused before anything). */
  ids: string[]
}

/** Sends the tab `tabId` of the window `from` to the window `to`, with the other panes of its split view, to the space `to` shows. */
export function sendToWindow(shared: TransferShared, lock: TransferLock, from: TransferSide, to: TransferSide, tabId: string): WindowSend {
  if (windowMoveRefusal(from.state(), tabId, { key: from.key, private: from.isPrivate }, { key: to.key, private: to.isPrivate }) !== null) return { result: 'refused', ids: [] }
  const ids = tabsToSend(from.state(), tabId)
  const before = from.state()
  const tabs = ids.flatMap((id) => shared.get().tabs.filter((tab) => tab.id === id))
  const result = runTransfer(shared, lock, from, to, ids, windowMoveTarget(to.state(), tabs))
  // A split view that went to another space was taken apart on the way (it lives in one space): it is put back whole in the window that took it.
  const split = result === 'moved' ? splitToRestore(before, shared.get(), tabId) : null
  if (split) to.dispatch({ type: 'split/restore', split })
  return { result, ids }
}
