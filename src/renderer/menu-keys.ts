// The keys of a menu drawn by the interface (`role="menu"` with `role="menuitem"` buttons): the focus is on an entry, the arrows go from one
// entry to the next and round the ends, Home and End to the first and the last. A greyed entry (`disabled`) is skipped.

import { stepSpaceMenu } from '@shared/space-menu'

/** The entries of `menu` that can be chosen, in the order they are drawn. */
export function menuEntries(menu: Pick<HTMLElement, 'querySelectorAll'>): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
}

/** Gives the focus to the first entry of `menu` that can be chosen: what a menu does when it opens. */
export function focusFirstEntry(menu: Pick<HTMLElement, 'querySelectorAll'>): HTMLElement | null {
  const first = menuEntries(menu)[0] ?? null
  first?.focus({ preventScroll: true })
  return first
}

/**
 * Moves the focus for an arrow, Home or End pressed in `menu` while `active` has the focus, and answers the entry that took it; null for any
 * other key, which the menu leaves alone.
 */
export function moveInMenu(menu: Pick<HTMLElement, 'querySelectorAll'>, active: Element | null, key: string): HTMLElement | null {
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return null
  const entries = menuEntries(menu)
  const next = entries[stepSpaceMenu(entries.map(() => true), entries.indexOf(active as HTMLElement), key)] ?? null
  next?.focus({ preventScroll: true })
  return next
}
