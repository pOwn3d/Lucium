// The keys named inside a sentence of a catalogue are those of the system the process runs on: the catalogues spell macOS (« ⇧⌘T »), and elsewhere the same
// sentence reads « Ctrl+Maj+T ». Nothing of macOS stays in a text drawn away from macOS, whichever key of the catalogues it is.

import { afterEach, describe, expect, it } from 'vitest'
import { CATALOGUES, getKeyPlatform, setKeyPlatform, setLanguage, t, tIn } from './i18n'
import { hasMacKeys, macKeysFor, type KeyWords } from './key-words'

const FRENCH: KeyWords = { shift: 'Maj', enter: 'Entrée', backspace: 'Retour arrière', delete: 'Suppr', space: 'Espace' }
const ENGLISH: KeyWords = { shift: 'Shift', enter: 'Enter', backspace: 'Backspace', delete: 'Del', space: 'Space' }

afterEach(() => {
  setKeyPlatform(undefined)
  setLanguage('fr')
})

describe('macKeysFor', () => {
  it('leaves a text as it is on macOS', () => {
    for (const text of ['Nouvel onglet ⌘T', '⇧⌘T rouvre un onglet', '⌥⌘-clic', 'Rien à changer']) expect(macKeysFor(text, 'darwin', FRENCH)).toBe(text)
  })

  it('reads the modifiers as Ctrl, Alt and Maj: the Command key does not exist elsewhere, Ctrl takes its place', () => {
    expect(macKeysFor('⇧⌘T rouvre un onglet', 'linux', FRENCH)).toBe('Ctrl+Maj+T rouvre un onglet')
    expect(macKeysFor('⌥⌘A', 'win32', FRENCH)).toBe('Ctrl+Alt+A')
    expect(macKeysFor('⌃D', 'linux', FRENCH)).toBe('Ctrl+D')
    // Ctrl and Command together are one Ctrl, not « Ctrl+Ctrl ».
    expect(macKeysFor('⌃⌘N', 'linux', FRENCH)).toBe('Ctrl+N')
    expect(macKeysFor('⌥⇧⌘C', 'linux', ENGLISH)).toBe('Ctrl+Alt+Shift+C')
  })

  it('reads a key that is a symbol as the word of the system, in the language of the text', () => {
    expect(macKeysFor('⌘↩', 'linux', FRENCH)).toBe('Ctrl+Entrée')
    expect(macKeysFor('⌘↵', 'linux', ENGLISH)).toBe('Ctrl+Enter')
    expect(macKeysFor('⇧⌘⌫ efface tout', 'linux', FRENCH)).toBe('Ctrl+Maj+Retour arrière efface tout')
    expect(macKeysFor('⌦', 'linux', FRENCH)).toBe('⌦')
    expect(macKeysFor('⌘⌦', 'linux', ENGLISH)).toBe('Ctrl+Del')
    expect(macKeysFor('⌘⇥', 'linux', ENGLISH)).toBe('Ctrl+Tab')
    expect(macKeysFor('⌥␣', 'linux', FRENCH)).toBe('Alt+Espace')
    expect(macKeysFor('Monter (⌥↑), descendre (⌥↓)', 'linux', FRENCH)).toBe('Monter (Alt+↑), descendre (Alt+↓)')
  })

  it('keeps the punctuation a shortcut uses as its key, and the one that only separates keys', () => {
    expect(macKeysFor('(⌘[ ou le bouton)', 'linux', FRENCH)).toBe('(Ctrl+[ ou le bouton)')
    expect(macKeysFor('⌘; arrête', 'linux', FRENCH)).toBe('Ctrl+; arrête')
    expect(macKeysFor('⌘F ou /', 'linux', FRENCH)).toBe('Ctrl+F ou /')
    expect(macKeysFor('⌘+ et ⌘−', 'linux', FRENCH)).toBe('Ctrl++ et Ctrl+-')
    // « ⌘, ⌃ ou ⌥, » is a list of keys: the commas are the sentence's.
    expect(macKeysFor('avec ⌘, ⌃ ou ⌥, et dans', 'linux', FRENCH)).toBe('avec Ctrl ou Alt, et dans')
    expect(macKeysFor('with ⌘, ⌃ or ⌥.', 'linux', ENGLISH)).toBe('with Ctrl or Alt.')
  })

  it('names a click made with a key held, not a key that is a hyphen', () => {
    expect(macKeysFor('⌘-clic pour ouvrir', 'linux', FRENCH)).toBe('Ctrl-clic pour ouvrir')
    expect(macKeysFor('⌥⌘-clic', 'win32', FRENCH)).toBe('Ctrl+Alt-clic')
    expect(macKeysFor('⇧-click on a link', 'linux', ENGLISH)).toBe('Shift-click on a link')
    expect(macKeysFor('Maintenir ⌘ : la page reçoit un clic', 'linux', FRENCH)).toBe('Maintenir Ctrl : la page reçoit un clic')
  })

  it('keeps the letters of a word a key is the start of: ⌃Tab is Ctrl+Tab', () => {
    expect(macKeysFor('⌃Tab suit l’ordre', 'linux', FRENCH)).toBe('Ctrl+Tab suit l’ordre')
    expect(macKeysFor('⌃⇧Tab', 'linux', FRENCH)).toBe('Ctrl+Maj+Tab')
  })

  it('knows a text that holds no key at a glance', () => {
    expect(hasMacKeys('Nouvel onglet')).toBe(false)
    expect(hasMacKeys('Nouvel onglet ⌘T')).toBe(true)
  })
})

describe('the sentences of the catalogues', () => {
  it('are read as typed until a process says which system it runs on', () => {
    expect(getKeyPlatform()).toBeUndefined()
    expect(t('features.demande-une-confirmation-avant-q')).toBe('Demande une confirmation avant ⌘Q.')
  })

  it('name the keys of the system once it is said, in both languages', () => {
    setKeyPlatform('linux')
    expect(t('features.demande-une-confirmation-avant-q')).toBe('Demande une confirmation avant Ctrl+Q.')
    expect(t('floating-video.fermer-w')).toBe('Fermer · Ctrl+W')
    setLanguage('en')
    expect(t('floating-video.fermer-w')).toBe('Close · Ctrl+W')
    expect(tIn('fr', 'notes.lien')).toBe('Lien (Ctrl+K)')
    setKeyPlatform('darwin')
    expect(t('floating-video.fermer-w')).toBe('Close · ⌘W')
  })

  it('leave what the user typed alone: a name with a ⌘ in it is not a shortcut', () => {
    setKeyPlatform('linux')
    expect(t('notes.cmd-clic-pour-ouvrir-url', { url: '⌘ docs' })).toBe('Ctrl-clic pour ouvrir ⌘ docs dans un onglet')
  })

  it('hold no symbol of macOS away from macOS, whatever the key, in either language (what the line above does for two keys, for all of them)', () => {
    for (const platform of ['linux', 'win32'] as const) {
      setKeyPlatform(platform)
      for (const language of ['fr', 'en'] as const) {
        setLanguage(language)
        const left = Object.keys(CATALOGUES[language]!).filter((key) => hasMacKeys(tIn(language, key as never)))
        expect(left, `${platform} ${language}`).toEqual([])
      }
    }
  })
})
