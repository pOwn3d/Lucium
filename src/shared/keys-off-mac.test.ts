// What is shown, and what is read, away from macOS: the shortcuts drawn with Ctrl and Alt, the Command key read as Ctrl, a press recorded for a shortcut
// that Command does not exist for, and the sentences that speak of « ce Mac » only where the thing is a Mac's (Touch ID, the translation of macOS).

import { afterEach, describe, expect, it } from 'vitest'
import { CATALOGUES, setLanguage } from './i18n'
import { COMMANDS, acceleratorKeys, commandHeld, formatAccelerator, labelWithShortcut, shortcutSuffix, toolbarKeys } from './keybindings'
import { commandPress } from './platform'
import { isPeekOpenKey } from './peek'
import { PLUS_GROUPS, plusShortcut } from './plus-menu'
import { illustrationOf, illustrationTip } from './settings-illustrations'
import { shortcutSheet } from './shortcut-help'
import { assignShortcut, otherUseNotes, recordingStep } from './shortcut-view'
import { SPACE_MENU_ENTRIES, spaceMenuShortcut } from './space-menu'
import { isArchiveKey } from './tab-search'

afterEach(() => setLanguage('fr'))

const MAC_SYMBOLS = /[⌘⌥⌃⇧]/
const on = { tabSearch: true, shortcutHelp: true, tabCycleRecent: true, notes: true }

describe('commandPress', () => {
  it('is Command and the key on macOS, Ctrl and the word of the key elsewhere', () => {
    expect(commandPress('↵', 'darwin')).toBe('⌘↵')
    expect(commandPress('↩', 'darwin')).toBe('⌘↩')
    expect(commandPress('Z', 'darwin')).toBe('⌘Z')
    expect(commandPress('↩', 'linux')).toBe('Ctrl+Entrée')
    expect(commandPress('Z', 'win32')).toBe('Ctrl+Z')
    setLanguage('en')
    expect(commandPress('↵', 'linux')).toBe('Ctrl+Enter')
  })
})

describe('commandHeld', () => {
  it('is Command on macOS and Ctrl elsewhere, and never the other one', () => {
    expect(commandHeld({ metaKey: true, ctrlKey: false }, 'darwin')).toBe(true)
    expect(commandHeld({ metaKey: false, ctrlKey: true }, 'darwin')).toBe(false)
    expect(commandHeld({ metaKey: false, ctrlKey: true }, 'linux')).toBe(true)
    // The Windows or Super key belongs to the system there.
    expect(commandHeld({ metaKey: true, ctrlKey: false }, 'win32')).toBe(false)
  })

  it('opens the preview of a link in a tab with Ctrl+Enter where there is no Command key, and with ⌘↩ on macOS', () => {
    const key = (patch: object) => ({ key: 'Enter', meta: false, shift: false, alt: false, control: false, ...patch })
    expect(isPeekOpenKey(key({ meta: true }), 'darwin')).toBe(true)
    expect(isPeekOpenKey(key({ control: true }), 'darwin')).toBe(false)
    expect(isPeekOpenKey(key({ control: true }), 'linux')).toBe(true)
    expect(isPeekOpenKey(key({ meta: true }), 'linux')).toBe(false)
    expect(isPeekOpenKey(key({ control: true, shift: true }), 'win32')).toBe(false)
  })

  it('archives a tab from the tab search with Ctrl+Backspace where there is no Command key', () => {
    const key = (patch: object = {}) => ({ key: 'Backspace', metaKey: false, ctrlKey: false, repeat: false, ...patch })
    expect(isArchiveKey(key({ ctrlKey: true }), 'doc', 'linux')).toBe(true)
    expect(isArchiveKey(key({ metaKey: true }), 'doc', 'linux')).toBe(false)
    expect(isArchiveKey(key({ metaKey: true }), 'doc', 'darwin')).toBe(true)
    expect(isArchiveKey(key({ ctrlKey: true }), 'doc', 'darwin')).toBe(false)
  })
})

describe('the shortcuts the functions of the keybindings draw', () => {
  it('are Ctrl and Alt and words away from macOS, symbols on macOS, with no system assumed', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    expect(formatAccelerator('CmdOrCtrl+Shift+J', 'linux')).toBe('Ctrl+Maj+J')
    expect(formatAccelerator('CmdOrCtrl+Alt+Return', 'win32')).toBe('Ctrl+Alt+Entrée')
    expect(shortcutSuffix('newTab', undefined, 'linux')).toBe(' (Ctrl+T)')
    expect(labelWithShortcut('Recharger', 'reload', undefined, 'linux')).toBe('Recharger (Ctrl+R)')
    expect(acceleratorKeys('CmdOrCtrl+Alt+E', 'darwin')).toEqual(['⌥', '⌘', 'E'])
    expect(toolbarKeys(undefined, 'darwin').reload).toEqual(['⌘', 'R'])
    // A capsule of a tooltip holds three characters at most (shared/tooltip.ts): away from macOS the words do not fit, and the tooltip says its text alone, never a symbol of macOS.
    for (const platform of ['linux', 'win32'] as const) expect(Object.values(toolbarKeys(undefined, platform)).flat().filter((key) => MAC_SYMBOLS.test(key))).toEqual([])
  })

  it('give the default of the system for a command whose key is not the same everywhere, and none for a command that has none there', () => {
    // On macOS ⌘D is « Épingler », on the other systems the pin keeps Ctrl+D too, but the dock of the sidebar and others have their own (shared/platform.ts).
    expect(shortcutSuffix('blankWindow', undefined, 'darwin')).toBe(' (⌃⌘N)')
    expect(shortcutSuffix('blankWindow', undefined, 'linux')).toBe('')
  })
})

describe('the menus and the sheets that print a shortcut', () => {
  const entry = (id: string) => PLUS_GROUPS.flat().find((e) => e.id === id)!

  it('draw it as words joined by « + » away from macOS, one key at a time on macOS', () => {
    expect(plusShortcut(entry('space'), { newSpace: 'CmdOrCtrl+Shift+N' }, 'darwin')).toBe('⇧ ⌘ N')
    expect(plusShortcut(entry('space'), { newSpace: 'CmdOrCtrl+Shift+N' }, 'linux')).toBe('Ctrl+Maj+N')
    const clear = SPACE_MENU_ENTRIES().find((e) => e.id === 'clear')!
    expect(spaceMenuShortcut(clear, { clearToday: 'CmdOrCtrl+Alt+K' }, 'win32')).toBe('Ctrl+Alt+K')
  })

  it('give the sheet of the shortcuts no symbol of macOS away from macOS, and the key that opens a line in a new tab with it', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const sheet = shortcutSheet({}, on, platform)
      const drawn = sheet.groups.flatMap((group) => group.rows.flatMap((row) => [...row.keys, ...row.also, row.was ?? '']))
      expect(drawn.filter((keys) => MAC_SYMBOLS.test(keys)), platform).toEqual([])
      expect(drawn).toContain('Ctrl+Entrée')
    }
    expect(shortcutSheet({}, on, 'darwin').groups.flatMap((group) => group.rows.flatMap((row) => row.keys))).toContain('⌘↵')
  })

  it('show the default a custom shortcut replaces as the system has it', () => {
    const sheet = shortcutSheet({ reload: 'CmdOrCtrl+Alt+R' }, on, 'linux')
    const row = sheet.groups.flatMap((group) => group.rows).find((r) => r.id === 'reload')
    expect(row).toMatchObject({ keys: ['Ctrl+Alt+R'], custom: true, was: 'Ctrl+R' })
  })

  it('draw the tip of a setting with the keys of the system, and no tip when the system is not known', () => {
    const archive = illustrationOf('autoArchiveHours')!
    expect(illustrationTip(archive, {}, 'linux')).toContain('Ctrl+')
    expect(illustrationTip(archive, {}, 'linux')).not.toMatch(MAC_SYMBOLS)
    expect(illustrationTip(archive, {}, undefined)).toBeNull()
    expect(illustrationTip(illustrationOf('sleepAfterMinutes')!, {}, undefined)).toBe('Un clic sur l’onglet le recharge.')
  })
})

describe('a shortcut recorded for a command, away from macOS', () => {
  const press = (code: string, key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

  it('reads Ctrl as the command key, as the defaults are written, and the Windows or Super key as no shortcut', () => {
    expect(recordingStep(press('KeyK', 'k', { ctrlKey: true, shiftKey: true }), 'linux')).toEqual({ kind: 'record', accelerator: 'CmdOrCtrl+Shift+K' })
    expect(recordingStep(press('KeyK', 'k', { metaKey: true }), 'linux')).toEqual({ kind: 'wait' })
    // On macOS the same Ctrl is Control, a modifier of its own.
    expect(recordingStep(press('KeyK', 'k', { ctrlKey: true, metaKey: true }), 'darwin')).toEqual({ kind: 'record', accelerator: 'CmdOrCtrl+Ctrl+K' })
  })

  it('is said back with the keys of the system, in the notices of a refusal and of a clash', () => {
    const refused = assignShortcut('newWindow', 'CmdOrCtrl+Q', {}, [{ accelerator: 'CmdOrCtrl+Q', label: 'Quitter Lucium' }], 'linux')
    expect(refused).toMatchObject({ kind: 'refused' })
    expect((refused as { text: string }).text).toContain('Ctrl+Q')
    expect((refused as { text: string }).text).not.toMatch(MAC_SYMBOLS)
    const clash = assignShortcut('newWindow', 'CmdOrCtrl+T', {}, [], 'win32')
    expect(clash).toMatchObject({ kind: 'saved' })
    expect((clash as { clash?: string }).clash).toContain('Ctrl+T')
  })

  it('draws no note about macOS away from macOS, and the one about the pages of sites on every system', () => {
    // Ctrl+1 is held by Mission Control on macOS, ⌘S and ⌃D by macOS itself; ⇧⌘X is a press that sites use too.
    expect(otherUseNotes('space1', {}, 'darwin').join(' ')).toContain('macOS')
    expect(otherUseNotes('toggleSidebar', {}, 'darwin').join(' ')).toContain('macOS')
    expect(otherUseNotes('space1', {}, 'linux')).toEqual([])
    expect(otherUseNotes('toggleSidebar', {}, 'win32')).toEqual([])
    expect(otherUseNotes('clearSiteData', {}, 'linux').join(' ')).toContain('sites')
  })

  it('has no second press away from macOS (they were chosen against the defaults of macOS)', () => {
    const notes = (platform: 'darwin' | 'linux') => COMMANDS.flatMap((command) => otherUseNotes(command.id, {}, platform))
    expect(notes('linux').filter((note) => MAC_SYMBOLS.test(note))).toEqual([])
  })
})

describe('the sentences that speak of « ce Mac »', () => {
  // Touch ID and the translation of macOS are things of a Mac: their sentences say so. Everything else is a function of every system, and says « cet ordinateur ».
  const MAC_ONLY = new Set([
    'lock-settings.touch-id-n-est-pas-disponible-sur-ce-mac',
    'pwd-touch.indisponible',
    'pwd-touch.indisponible-court',
    'pwd-touch.empreintes-changees',
    'pwd-touch.active',
    'pwd-touch.explication-active',
    'translate.settings-system-hint',
    'translate.traduit-sur-ce-mac-avec-macos-quand-la',
    'translate.system-usage-note',
    'translate.models-other-engine',
    'translate.system-notice',
    'guide.traduction-macos-effet'
  ])

  it('are, in French and in English, the sentences of Touch ID and of the translation of macOS and no other', () => {
    for (const [language, pattern] of [['fr', /\bce Mac\b/], ['en', /\bthis Mac\b/]] as const) {
      const found = Object.entries(CATALOGUES[language]!).filter(([, text]) => pattern.test(text ?? '')).map(([key]) => key)
      expect(found.filter((key) => !MAC_ONLY.has(key)), language).toEqual([])
    }
  })

  it('name the computer in both languages for what is not a Mac’s', () => {
    expect(CATALOGUES['fr']!['welcome.trouves-sur-ce-mac-names']).toBe('Trouvés sur cet ordinateur : {names}.')
    expect(CATALOGUES['en']!['welcome.trouves-sur-ce-mac-names']).toBe('Found on this computer: {names}.')
  })
})
