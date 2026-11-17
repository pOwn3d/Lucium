// What the command bar of the page annotation shows, worked out from the state the main process holds. page-annotate-command.ts puts it in the page; it is
// kept apart from that script, which runs against the page as soon as it is loaded, so that it can be tested without a window.

import { t, tp } from '@shared/i18n'
import type { NudgeDirection } from '@shared/annotate-bar'
import { AUTO_CLEAR_SECONDS, type AutoClear } from '@shared/annotate-auto-clear'
import { LASER_STYLES, type BarDrag, type LaserStyle, type PageAnnotateState, type PageMode } from '@shared/page-annotate'

/** The looks of the laser, by name (the dot in the selector shows each one). */
export const LASER_LABEL: Record<LaserStyle, () => string> = {
  net: () => t('page-annotate.laser-net'),
  discret: () => t('page-annotate.laser-discret'),
  lumiere: () => t('page-annotate.laser-lumiere')
}

/** One chip of the selector of the laser's look. */
export interface LaserChip {
  style: LaserStyle
  title: string
  label: string
  /** The classes of its preview dot, which only the page styles. */
  dotClass: string
}

/** The chips of the selector, one per look the layer draws, in the order of the list. */
export function laserChips(): LaserChip[] {
  return LASER_STYLES.map((style) => ({
    style,
    // The light look is for dark backgrounds only: its title says so.
    title: style === 'lumiere' ? t('page-annotate.laser-lumiere-titre') : LASER_LABEL[style](),
    label: LASER_LABEL[style](),
    dotClass: `page-annotate-dot page-annotate-dot-${style}`
  }))
}

/** The selector of the laser: shown only while the laser is the tool, and naming the look the main process keeps. */
export function laserSelector(state: Pick<PageAnnotateState, 'brush' | 'laser'>): { hidden: boolean; name: string } {
  return { hidden: state.brush.tool !== 'laser', name: LASER_LABEL[state.laser]() }
}

/**
 * The title of the Cursor button. In draw mode it says what the button does, and how to reach the page for a moment without it (holding Command
 * lets a click through, Control the scrolling: on a Mac a Control-click is a right click). In pass mode it says how to draw again.
 */
/** The mode after a choice in the bar: a tool picked while the page has the pointer is meant to be used, so drawing comes back; a colour changes nothing. */
export function modeAfterChoice(mode: PageMode, next: { tool?: unknown }): PageMode {
  return next.tool !== undefined && mode === 'pass' ? 'draw' : mode
}

export function modeButtonTitle(mode: PageMode): string {
  if (mode === 'pass') return `${t('page-annotate.curseur-actif')} (⌥⌘P)`
  return `${t('page-annotate.curseur-titre')} (⌥⌘P) · ${t('page-annotate.aide-maintien')}`
}

/** The stopwatch of the timer button (24 px grid, thin strokes): its dial, its hand, and the button on its top. */
export const TIMER_ICON = 'M12 5a8 8 0 1 1 0 16a8 8 0 1 1 0-16M12 9v4l2.5 2.5M10 2.5h4M12 2.5v2.5'

/** What the timer button of the automatic clearing shows. */
export interface AutoClearButton {
  /** The clearing is on: the button is drawn in the accent. */
  on: boolean
  /** The delay under or beside the icon (« 5 s »); empty while off, when the icon is alone. */
  text: string
  /** Its accessible name: what it is, and its state, in a whole sentence. */
  label: string
  /** Its tooltip: the name, and what a click does. */
  title: string
}

/** The timer button for the clearing main keeps: off (0) or a delay in seconds. */
export function autoClearButton(autoClear: AutoClear): AutoClearButton {
  const on = autoClear > 0
  const label = on ? tp('page-annotate.effacement-auto-apres', autoClear) : t('page-annotate.effacement-auto-desactive')
  return {
    on,
    text: on ? t('page-annotate.effacement-auto-duree', { seconds: autoClear }) : '',
    label,
    title: `${label} · ${t('page-annotate.effacement-auto-aide', { choices: AUTO_CLEAR_SECONDS.join(', ') })}`
  }
}

/**
 * Where the menu of the positions opens when it is asked for from a control and not with the pointer (the keyboard, the Position button): under that control,
 * in the coordinates of the window of the bar, whole and never negative (what main accepts, `isBarMenuAnchor`).
 */
export function menuAnchorUnder(box: { left: number; bottom: number }): { x: number; y: number } {
  return { x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.bottom)) }
}

/** Whether a key press dismisses the first-use hint: Escape alone (with Command, Control, Alt or Shift it is another shortcut's). */
export function dismissesHint(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return event.key === 'Escape' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
}

/** What a key pressed on the grip asks for: the menu of the positions, or a step of a floating bar. */
export type GripKeyAction = { kind: 'menu' } | { kind: 'nudge'; direction: NudgeDirection; large: boolean }

const ARROWS: Readonly<Record<string, NudgeDirection>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * The keys of the grip. The menu key, or Shift + F10 (the keys that open the menu of a control), and Return or Space (a Mac keyboard has no menu key) open the
 * menu « Position de la barre »; an arrow moves a floating bar a step, with Shift a larger one. A key with Command, Control or Alt is not the grip's.
 */
export function gripKeyAction(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): GripKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey) || event.key === 'Enter' || event.key === ' ') return { kind: 'menu' }
  const direction = Object.hasOwn(ARROWS, event.key) ? ARROWS[event.key] : undefined
  return direction ? { kind: 'nudge', direction, large: event.shiftKey } : null
}

/** What the grip reads of a pointer event. */
export interface GripPointer {
  button: number
  ctrlKey: boolean
  screenX: number
  screenY: number
}

/**
 * The drag of the grip, as what it tells main: the phase and where the pointer is on the screen (the bar is a window of its own, which only main can move).
 * `down` says whether a drag began, and the page then keeps the pointer; `up` and `cancel` say whether one ended. The primary button only starts a drag, and not
 * with Control held (a right click on a Mac, which opens the menu), nor while the annotation is off. The pointer events go through this object, so that the
 * rules are tested without a page.
 */
export function gripDrag(send: (drag: BarDrag) => void, enabled: () => boolean): { down(event: GripPointer): boolean; move(event: GripPointer): void; up(event: GripPointer): boolean; cancel(event: GripPointer): boolean } {
  let dragging = false
  const at = (phase: BarDrag['phase'], event: GripPointer): void => send({ phase, x: event.screenX, y: event.screenY })
  const finish = (phase: 'end' | 'cancel', event: GripPointer): boolean => {
    if (!dragging) return false
    dragging = false
    at(phase, event)
    return true
  }
  return {
    down: (event) => {
      if (event.button !== 0 || event.ctrlKey || !enabled()) return false
      dragging = true
      at('start', event)
      return true
    },
    move: (event) => {
      if (dragging) at('move', event)
    },
    up: (event) => finish('end', event),
    cancel: (event) => finish('cancel', event)
  }
}

// ---------- The elements of the buttons ----------

/** The part of `document` the buttons of the bar are built with. */
export interface ElementMaker {
  createElement(name: 'span'): HTMLElement
  createElementNS(namespace: 'http://www.w3.org/2000/svg', name: 'svg' | 'path'): Element
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * A stroked icon of the bar, as elements. Nothing of a button is written as markup: a label that comes from the catalogue of texts is text
 * whatever it holds, and the bar is built the way the bar of a share is (window-share-command.ts).
 */
export function strokedIcon(maker: ElementMaker, d: string): Element {
  const svg = maker.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('aria-hidden', 'true')
  const path = maker.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

/**
 * The title of a tool's button and the letter chip it shows. The letter is the key of the tool: named only while the keys of one letter act (the setting
 * `annotateLetterKeys`), so that the bar never advertises a key that does nothing. A tool without a letter (the eraser) has none either way.
 */
export function toolButtonText(label: string, letter: string | undefined, letterKeys: boolean): { title: string; letter: string | null } {
  return letter && letterKeys ? { title: `${label} (${letter})`, letter } : { title: label, letter: null }
}

/** The titles of the two buttons that clear: their keys with ⌘ and ⌥, and E or X as well while the keys of one letter act. */
export function clearTitles(letterKeys: boolean): { page: string; all: string } {
  return {
    page: `${t('page-annotate.effacer-page-titre')} (${letterKeys ? '⌥⌘⌫, E' : '⌥⌘⌫'})`,
    all: `${t('page-annotate.effacer-tout-titre')} (${letterKeys ? '⇧⌥⌘⌫, X' : '⇧⌥⌘⌫'})`
  }
}

/** A span the screen reader skips (the button's own label names it): the letter of a tool, the dot of a look of the laser. */
export function hiddenSpan(maker: ElementMaker, className: string, text = ''): HTMLElement {
  const span = maker.createElement('span')
  span.className = className
  span.setAttribute('aria-hidden', 'true')
  if (text !== '') span.textContent = text
  return span
}
