// Where the focus goes in a panel that holds it (Escape, a focus trap, the focus given back): into the panel when it opens,
// round its parts with Tab when it is a dialog, and back to what had it when the panel goes away.

import { useEffect, type RefObject } from 'react'
import { tabIndexInPanel } from '@shared/panel-keys'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** The parts of `root` that Tab reaches, in the order of the document. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

/**
 * Whether a part of the panel already has the focus, so that the panel leaves it there on opening. The panel itself does not count: the host of the
 * panels gives it the focus when it finds no focused element (OverlayHost.tsx), and a panel that draws nothing until the first snapshot is drawn a moment
 * later, after that; its own field (`[data-autofocus]`) must still take the focus then, or the keys typed at once reach no field.
 */
export function partHasFocus(root: Pick<Node, 'contains'>, active: Element | null): boolean {
  return active !== null && active !== root && root.contains(active)
}

/**
 * Moves the focus to the part of `root` that Tab (Shift+Tab when `backwards`) reaches from `active`, round the ends; from outside `root`, to its
 * first part (its last, backwards). Answers the part that took the focus, or null when `root` has none.
 */
export function focusNextIn(root: HTMLElement, active: Element | null, backwards: boolean): HTMLElement | null {
  const parts = focusableIn(root)
  const next = parts[tabIndexInPanel(parts.indexOf(active as HTMLElement), parts.length, backwards)] ?? null
  next?.focus()
  return next
}

export interface FocusScopeOptions {
  /** Tab and Shift+Tab go round the panel instead of leaving it. */
  trap?: boolean
  /** The part that takes the focus on opening, when nothing inside has it already: `[data-autofocus]` by default, then the first part. */
  initial?: string
  /** The focus goes back to what had it before the panel opened. */
  restore?: boolean
}

export function useFocusScope(ref: RefObject<HTMLElement | null>, { trap = false, initial = '[data-autofocus]', restore = true }: FocusScopeOptions = {}): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!partHasFocus(root, document.activeElement)) {
      const target = root.querySelector<HTMLElement>(initial) ?? focusableIn(root)[0] ?? root
      if (target === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
      target.focus({ preventScroll: true })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!trap || event.key !== 'Tab' || event.defaultPrevented) return
      event.preventDefault()
      focusNextIn(root, document.activeElement, event.shiftKey)
    }
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      if (restore && before && before.isConnected && before !== document.body) before.focus({ preventScroll: true })
    }
  }, [ref, trap, initial, restore])
}
