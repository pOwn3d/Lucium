// The keyboard layout in use: with Option held a press gives « æ » rather than the letter of its key, and only the layout says which letter
// that key is (shared/keybindings.ts, `pressedKey`). The Shortcuts pane reads it to record a shortcut; the window sends it to the shell, which
// sees the presses first and has no way to read it.

import { keyLayoutOf, type KeyLayout } from '@shared/keybindings'

/** The part of `navigator` that is read: `keyboard.getLayoutMap()` is not in the DOM types, and not in every engine. */
export interface LayoutSource {
  keyboard?: { getLayoutMap?: () => Promise<{ forEach(each: (character: string, code: string) => void): void }> }
}

/**
 * The character of each key by its `code`, or undefined when the engine does not give it or fails to: a press is then read alone, which is
 * right for every press without Option, and the failure is written in the console.
 */
export async function readKeyboardCharacters(source: LayoutSource = navigator as LayoutSource): Promise<Record<string, string> | undefined> {
  const keyboard = source.keyboard
  if (typeof keyboard?.getLayoutMap !== 'function') return undefined
  try {
    const map = await keyboard.getLayoutMap()
    const characters: Record<string, string> = {}
    map.forEach((character, code) => {
      characters[code] = character
    })
    return characters
  } catch (error) {
    console.warn('[shortcuts] the keyboard layout could not be read, a press with Option is read by the place of its key:', error instanceof Error ? error.name : typeof error)
    return undefined
  }
}

/** The layout as the recording of a shortcut asks it (see `readKeyboardCharacters` for when it is absent). */
export async function readKeyboardLayout(source: LayoutSource = navigator as LayoutSource): Promise<KeyLayout | undefined> {
  const characters = await readKeyboardCharacters(source)
  return characters ? keyLayoutOf(characters) : undefined
}

/**
 * Sends the layout to the shell each time the window gets the focus (`onFocus` tells at once, then at each change): the layout can have
 * changed while another application was in front. Nothing is sent when it cannot be read. Answers the way to stop.
 */
export function reportKeyboardLayout(
  report: (characters: Record<string, string>) => void,
  onFocus: (listener: (focused: boolean) => void) => () => void,
  source: LayoutSource = navigator as LayoutSource
): () => void {
  return onFocus((focused) => {
    if (!focused) return
    void readKeyboardCharacters(source).then((characters) => {
      if (characters && Object.keys(characters).length > 0) report(characters)
    })
  })
}
