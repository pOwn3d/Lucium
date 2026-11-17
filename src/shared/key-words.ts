// The keys named inside a sentence of a catalogue. The catalogues spell a shortcut the way macOS does (« ⇧⌘T », « ⌘-clic », « ⌥↑ ») because the application was
// written there first; away from macOS those symbols name keys that do not exist (there is no Command key), and the person reads « Ctrl+Maj+T ».
// This file turns the spelling of one system into the other, on the text of a catalogue before its variables are put in (a name the user typed that holds
// a ⌘ is never touched). It is pure: i18n.ts calls it, once per text, for the system the process says it runs on.

import type { PlatformId } from './platform'

/** The words of the keys that are not a letter, in the language of the text: what `platform.*` says in the catalogue of that language. */
export interface KeyWords {
  shift: string
  enter: string
  backspace: string
  delete: string
  space: string
}

/** The keys a symbol of macOS names, when the key after the modifiers is not a letter or a digit. */
const KEY_SYMBOLS: Readonly<Record<string, keyof KeyWords | 'tab'>> = { '↩': 'enter', '↵': 'enter', '⌫': 'backspace', '⌦': 'delete', '␣': 'space', '⇥': 'tab' }

/**
 * A run of modifier symbols and the key it holds, if one follows at once. The key is a letter, a digit, a symbol of a key, an arrow or one of the punctuation
 * marks a shortcut uses (« ⌘; », « ⌘[ », « ⌘+ »); not a comma or a full stop (« ⌘, ⌃ ou ⌥ » lists keys), and not a hyphen that joins the modifier to a word
 * (« ⌘-clic », « ⇧-click » name a click made with the key held).
 */
const RUN = /([⌃⌥⇧⌘]+)(?:(?!-\p{L})([\p{L}\p{N}↑↓←→↩↵⌫⌦␣⇥;/[\]=+−\\'`-]))?/gu

/** Whether a text holds a symbol of a modifier key: the cheap test that comes before the substitution. */
export const hasMacKeys = (text: string): boolean => /[⌃⌥⇧⌘]/.test(text)

/**
 * The text with the keys named as the system `platform` names them. macOS keeps the text as it is; elsewhere ⌘ and ⌃ are Ctrl (the Command key does not
 * exist, and Ctrl takes its place in every default shortcut), ⌥ is Alt, ⇧ is Maj or Shift, and the keys that are a symbol are the words of the system.
 */
export function macKeysFor(text: string, platform: PlatformId, words: KeyWords): string {
  if (platform === 'darwin' || !hasMacKeys(text)) return text
  const read = text.replace(RUN, (_whole, modifiers: string, key: string | undefined) => {
    const held = [modifiers.includes('⌃') || modifiers.includes('⌘') ? 'Ctrl' : '', modifiers.includes('⌥') ? 'Alt' : '', modifiers.includes('⇧') ? words.shift : ''].filter(Boolean)
    if (key === undefined) return held.join('+')
    const symbol = KEY_SYMBOLS[key]
    const shown = symbol === undefined ? (key === '−' ? '-' : key) : symbol === 'tab' ? 'Tab' : words[symbol]
    return [...held, shown].join('+')
  })
  // « ⌘, ⌃ ou ⌥ » lists the three modifier keys of macOS: Command and Control are both Ctrl elsewhere, and the list says it once.
  return read.replace(/\bCtrl(?:, | et | ou | and | or )Ctrl\b/g, 'Ctrl')
}
