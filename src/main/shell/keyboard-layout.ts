// The keyboard layout in use, as a window read it (renderer/keyboard-layout.ts). The shell sees every key press before the pages, but a press
// with Option does not carry the letter of its key: the layout says which letter that key is. One keyboard for all the windows.

import { keyLayoutOf, type KeyLayout } from '@shared/keybindings'

let current: KeyLayout | undefined

/** The layout a window has just read. */
export function setKeyboardLayout(characters: Readonly<Record<string, string>>): void {
  current = keyLayoutOf(characters)
}

/** The layout read last, undefined until a window has sent one (a press with Option is then read by the place of its key). */
export function keyboardLayout(): KeyLayout | undefined {
  return current
}

/** For the tests: no layout was read. */
export function forgetKeyboardLayout(): void {
  current = undefined
}
