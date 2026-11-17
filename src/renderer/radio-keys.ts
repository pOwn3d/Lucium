// The arrows in the composite controls drawn as buttons: a group of radios, a row of tabs, a toolbar. A screen reader says « bouton radio,
// 2 sur 5 », « onglet, 1 sur 2 » or « barre d'outils » and its user then presses an arrow, as in any such control; a row of plain buttons
// answers Tab alone.

interface RadioKey {
  key: string
  target: unknown
  currentTarget: Pick<HTMLElement, 'querySelectorAll'>
  preventDefault: () => void
}

type Step = (at: number, count: number) => number

const NEXT: Step = (at, count) => (at + 1) % count
const PREVIOUS: Step = (at, count) => (at - 1 + count) % count
const ENDS: Readonly<Record<string, Step>> = { Home: () => 0, End: (_at, count) => count - 1 }

/** A radio group goes either way with the four arrows, as the native one does. */
const EVERY_ARROW: Readonly<Record<string, Step>> = { ArrowRight: NEXT, ArrowDown: NEXT, ArrowLeft: PREVIOUS, ArrowUp: PREVIOUS, ...ENDS }
/** A row of tabs and a toolbar are horizontal: ↑ and ↓ are left to what holds them (a list, a panel that scrolls). */
const ROW_ARROWS: Readonly<Record<string, Step>> = { ArrowRight: NEXT, ArrowLeft: PREVIOUS, ...ENDS }

/**
 * The control `selector` finds in `event.currentTarget` next to the focused one for the key pressed, round the ends; Home and End go to the
 * first and the last. The control reached takes the focus and, when `choose`, is chosen by its own click. Any other key, or a key pressed
 * outside these controls (a field, a slider), is left alone.
 */
function arrowKeys(event: RadioKey, steps: Readonly<Record<string, Step>>, selector: string, choose: boolean): HTMLElement | null {
  const step = steps[event.key]
  if (!step) return null
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)]
  const at = controls.indexOf(event.target as HTMLElement)
  if (at < 0) return null
  event.preventDefault()
  const next = controls[step(at, controls.length)] ?? null
  if (next && next !== event.target) {
    next.focus()
    if (choose) next.click()
  }
  return next
}

/**
 * `onKeyDown` of a `role="radiogroup"`: an arrow moves to the next or the previous radio that can be chosen, round the ends, Home and End go
 * to the first and the last; the radio reached takes the focus and is chosen (its own click), as a native radio is. Any other key, or a key
 * pressed outside a radio, is left alone. Answers the radio reached, or null.
 */
export function radioGroupKeys(event: RadioKey): HTMLElement | null {
  return arrowKeys(event, EVERY_ARROW, '[role="radio"]:not(:disabled)', true)
}

/**
 * `onKeyDown` of a `role="tablist"`: ← and → go to the neighbour tab and show it (its own click), Home and End to the first and the last.
 * The tab shown is the one stop of Tab in the row (`tabIndex` 0, the others -1), so Tab leaves the row for what the tab shows.
 */
export function tabListKeys(event: RadioKey): HTMLElement | null {
  return arrowKeys(event, ROW_ARROWS, '[role="tab"]:not(:disabled)', true)
}

/**
 * `onKeyDown` of a `role="toolbar"`: ← and → move the focus to the neighbour button that can be pressed, Home and End to the first and the
 * last. Nothing is pressed: Space or Return does that. A key pressed in a field of the bar is the field's.
 */
export function toolbarKeys(event: RadioKey): HTMLElement | null {
  return arrowKeys(event, ROW_ARROWS, 'button:not(:disabled)', false)
}
