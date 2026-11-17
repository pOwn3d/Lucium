// The keys the panel templates share (src/renderer/templates): which row the arrows move to, where Tab goes inside a panel that holds the focus,
// and what counts as "undo". Pure, so that the behaviour is written once and measured without a window.

/** The row the focus goes to for a key, among `count` rows, from the row `current` (-1: none has the focus yet). Stops at the ends: a list is not a ring. */
export function nextRowIndex(current: number, count: number, key: string): number {
  if (count <= 0) return -1
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1)
    case 'ArrowUp':
      return current < 0 ? 0 : Math.max(0, current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return current
  }
}

/** Where Tab (or Shift+Tab) goes among `count` focusable parts of a panel that keeps the focus inside: round the ends. */
export function tabIndexInPanel(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return (current + (backwards ? -1 : 1) + count) % count
}

/** ⌘Z on a Mac (Ctrl+Z elsewhere), without Shift (that is redo) and not in a field, where it undoes the typing. */
export function isUndoKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, inField: boolean): boolean {
  return !inField && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z'
}

// ---------- what a key does in each template ----------

export interface KeyInfo {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented?: boolean
}

export type ListKeyAction = { type: 'close' } | { type: 'undo' } | { type: 'move'; key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' } | null

/**
 * What a key does in a panel of a list: Escape closes it, ⌘Z takes the last deletion back (when there is one, and outside a field), the arrows go
 * from row to row. In a field the arrows and Home/End move the caret; the one exception is ArrowDown in the search, which goes down into the results.
 */
export function listPanelKey(event: KeyInfo, inField: boolean, canUndo: boolean): ListKeyAction {
  if (event.defaultPrevented) return null
  if (event.key === 'Escape') return { type: 'close' }
  if (canUndo && isUndoKey(event, inField)) return { type: 'undo' }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return null
  if (inField && event.key !== 'ArrowDown') return null
  return { type: 'move', key: event.key }
}

/** Escape leaves a small editor or an invite, unless something inside already took it (a menu, a field that was closing). */
export const isLeaveKey = (event: Pick<KeyInfo, 'key' | 'defaultPrevented'>): boolean => event.key === 'Escape' && !event.defaultPrevented

/** Return answers a form from a field; on a button it presses that button, and a key something else took stays taken. */
export const isAnswerKey = (event: Pick<KeyInfo, 'key' | 'defaultPrevented'>, targetTag: string): boolean => event.key === 'Enter' && targetTag.toUpperCase() !== 'BUTTON' && !event.defaultPrevented
