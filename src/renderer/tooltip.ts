// The tooltip: a navy capsule that shows after the pointer has rested on a control. The UI only says WHAT and WHERE; the shell
// draws it in a window of its own (see main/shell/tooltip.ts), because a capsule that drops below the toolbar must overlap the page.

import type { FocusEvent, MouseEvent } from 'react'
import { TOOLTIP } from '@shared/ipc'
import { MEDIA_PLAYER } from '@shared/media-player'
import { api } from './api'

let timer: ReturnType<typeof setTimeout> | null = null
let visible = false
/** The control the pointer is resting on (its text), once armed: moving inside it does not start the wait again. */
let armedFor: string | null = null

/** Watches the document while a capsule is armed, to put it away when its control leaves the document. */
let watcher: MutationObserver | null = null

/**
 * Puts the capsule away when `control` is taken out of the document. A control that disappears under the pointer (a button of the media player when
 * the sound stops, a tile whose tab closes, a button that a narrower window folds away) gets no `mouseleave` and no `blur`: nothing else would
 * hide its capsule, which the main process draws in a window of its own.
 */
function watchRemoval(control: unknown): void {
  if (typeof MutationObserver === 'undefined' || typeof Node === 'undefined' || typeof document === 'undefined' || !document.body) return
  if (!(control instanceof Node)) return
  watcher = new MutationObserver(() => {
    if (!control.isConnected) hideTooltip()
  })
  watcher.observe(document.body, { childList: true, subtree: true })
}

export function hideTooltip(): void {
  if (timer) clearTimeout(timer)
  timer = null
  armedFor = null
  watcher?.disconnect()
  watcher = null
  if (visible) {
    visible = false
    api().tooltip(null)
  }
}

/**
 * Escape puts the capsule away, or keeps the one that waits from showing, without the pointer or the focus having to move (WCAG 1.4.13). The
 * control stays armed: a move of the pointer inside it does not bring the capsule back, leaving it and coming back does. The key is not taken:
 * it still closes the panel or leaves the field it would have.
 */
export function dismissTooltipOnEscape(event: { key: string }): void {
  if (event.key !== 'Escape' || armedFor === null) return
  const kept = armedFor
  hideTooltip()
  armedFor = kept
}

/** Whether the window listens for Escape already: one listener for every control, set when the first capsule is armed. */
let listening = false
function listenForEscape(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('keydown', dismissTooltipOnEscape, true)
}

/** Wider than this, a control is a line (a row, a header, a wide tile): its capsule opens under the control, not at the pointer. */
export const TIP_WIDE_CONTROL = 140
/** The gap between the bottom edge of a wide control and the top of its capsule. */
export const TIP_UNDER_EDGE = 4

type ControlBox = Pick<DOMRect, 'left' | 'right' | 'bottom' | 'width'>

/**
 * Where the capsule of a control is asked for when the pointer rests at `pointer`. The capsule opens TOOLTIP.offsetY under the point it is given and
 * covers some 30 px from there: at the pointer, over a wide line, it hid the lower half of the line and the top of the one under it. A wide control's
 * capsule therefore opens TIP_UNDER_EDGE under its bottom edge, at the pointer's x kept inside the control. A narrow one (an icon) keeps the pointer.
 */
export function tipPoint(pointer: { x: number; y: number }, box: ControlBox | null): { x: number; y: number } {
  if (!box || !(box.width > TIP_WIDE_CONTROL)) return pointer
  return { x: Math.min(Math.max(pointer.x, box.left), box.right), y: box.bottom + TIP_UNDER_EDGE - TOOLTIP.offsetY }
}

/** The box of the control an event was handed to, or null when it has none (a test, or a control already gone). */
function boxOf(control: unknown): ControlBox | null {
  const measure = (control as { getBoundingClientRect?: () => ControlBox } | null)?.getBoundingClientRect
  return typeof measure === 'function' ? measure.call(control) : null
}

/**
 * Props to spread on a control: `text` and the keycaps of its shortcut, shown after the pointer rests on it, or after the keyboard brings the focus to
 * it (the capsule used to be the pointer's only). `look: 'media'` is the bubble of the media player (its colours, and a
 * wait of 1.5 s instead of 1 s). `side: 'left'` opens it to the left of the point (a control at the right edge of the window).
 */
export function tipProps(text: string, keys?: string[], look?: 'media', side?: 'left') {
  /** Shows the capsule at the point `place` gives once the wait is over, unless it is already armed for this control (then nothing is measured). */
  const armAt = (place: () => { x: number; y: number }, control: unknown) => {
    if (armedFor === text) return
    hideTooltip()
    listenForEscape()
    armedFor = text
    watchRemoval(control)
    const { x, y } = place()
    timer = setTimeout(() => {
      timer = null
      visible = true
      api().tooltip({ text, ...(keys ? { keys } : {}), x, y, ...(look ? { variant: look } : {}), ...(side ? { side } : {}) })
    }, look === 'media' ? MEDIA_PLAYER.tooltipDelayMs : TOOLTIP.delayMs)
  }
  // `mouseenter` is the usual start; a move inside the control arms it too, for the entry the browser did not report.
  const arm = (event: MouseEvent) => {
    const { clientX: x, clientY: y, currentTarget: control } = event
    armAt(() => tipPoint({ x, y }, boxOf(control)), control)
  }
  // A focus the keyboard gave (not the one a click gives: the pointer is there already), under the middle of the control.
  const focus = (event: FocusEvent<Element>) => {
    const control = event.currentTarget
    if (!control.matches(':focus-visible')) return
    armAt(() => {
      const box = control.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.bottom }
    }, control)
  }
  return { onMouseEnter: arm, onMouseMove: arm, onMouseLeave: hideTooltip, onMouseDown: hideTooltip, onFocus: focus, onBlur: hideTooltip }
}
