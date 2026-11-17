// The mini window in its first state: a window that holds the command bar and nothing else (490 x 329), then
// the keys that drive a mini window while its page has the focus (⌘O, ⇧⌘C, ⌘R, ⌘[ and ⌘]).

import { effectiveAccelerator, type KeyBindings } from './keybindings'
import type { LittleCommand } from './ipc'
import { centeredBounds } from './little-window'
import type { Rect } from './peek'

/** The window of the first state: the card of the command bar, 490 x 329. */
export const LITTLE_BAR = { width: 490, height: 329 } as const

/** Where the window of the first state opens: in the middle of the work area, like the window of a page. */
export function littleBarBounds(workArea: Rect): Rect {
  return centeredBounds(LITTLE_BAR, workArea)
}

/**
 * The window once a page is chosen: it grows around its centre, so a window that opened in the middle of the screen stays in the middle, and one the
 * user moved stays where they put it. Kept inside the work area, so a window that was dragged to a corner still fits.
 */
export function littleExpandedBounds(current: Rect, size: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const x = Math.max(workArea.x, Math.min(Math.round(current.x + (current.width - width) / 2), workArea.x + workArea.width - width))
  const y = Math.max(workArea.y, Math.min(Math.round(current.y + (current.height - height) / 2), workArea.y + workArea.height - height))
  return { x, y, width, height }
}

export interface KeyInput {
  /** The character of the key, as Electron's `before-input-event` gives it ("r", "[", "O"). With ⌥ held macOS composes another one: `code` names the key itself. */
  key: string
  /** The physical key (`KeyI`), when the page that gave this input has it. */
  code?: string
  meta: boolean
  shift: boolean
  alt: boolean
  control: boolean
}

/** ⌘O: open the page in the space the window was opened from. It has no menu entry, so it cannot be rebound. */
const OPEN_IN_SPACE = 'CmdOrCtrl+O'

/** The accelerator a key press spells ("CmdOrCtrl+Shift+C"), or null when it carries no command modifier. */
export function acceleratorOf(input: KeyInput): string | null {
  if (!input.meta && !input.control) return null
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key
  // ⌘ or ⌃ is the command key of the shortcut; the other of the two is not part of any default one.
  return [input.meta ? 'CmdOrCtrl' : 'Ctrl', input.control && input.meta ? 'Ctrl' : '', input.alt ? 'Alt' : '', input.shift ? 'Shift' : '', key].filter(Boolean).join('+')
}

/**
 * What a key press does to a mini window whose page has the focus: the same keys as the menu bar (taken from the user's
 * bindings, so a shortcut they changed follows them) plus ⌘O. `copy-url` is the shortcut that copies the address.
 */
export function littleKeyCommand(input: KeyInput, bindings: KeyBindings | undefined): LittleCommand | null {
  const pressed = acceleratorOf(input)
  if (!pressed) return null
  if (pressed === OPEN_IN_SPACE) return 'open-in-main'
  const is = (command: string) => effectiveAccelerator(command, bindings) === pressed
  if (is('copyUrl')) return 'copy-url'
  if (is('reload')) return 'reload'
  if (is('back')) return 'back'
  if (is('forward')) return 'forward'
  return null
}
