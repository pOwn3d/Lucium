// A shortcut that is not a command's to take: the fixed entries of the menus (⌘Q, ⌘C, ⌥⌘M…) and the shortcuts of the extensions. A command
// given one of them would share it with an entry that cannot let go of it; the Settings refuse it and say whose it is.

import { afterEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from './french-typography'
import { COMMANDS, FIXED_SHORTCUTS, effectiveAccelerator, extensionMenuCommands, keyOffLayout, otherUseOf, samePress, takenBy } from './keybindings'
import { PAGE_SHORTCUT, PAGE_TOGGLE_SHORTCUT } from './page-annotate'
import { PASS_SHORTCUT } from './window-share-pass'
import { setLanguage } from './i18n'
import { assignShortcut, commandLabel, recordingStep, takenNote, otherUseNotes } from './shortcut-view'

afterEach(() => setLanguage('fr'))

const press = (code: string, key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('the same press under two spellings', () => {
  it('ignores the order and the spelling of the modifiers', () => {
    expect(samePress('Alt+CmdOrCtrl+M', 'CmdOrCtrl+Alt+M')).toBe(true)
    expect(samePress('Cmd+Shift+Y', 'CmdOrCtrl+Shift+Y')).toBe(true)
    expect(samePress('Command+Shift+Y', 'Shift+CmdOrCtrl+y')).toBe(true)
    expect(samePress('Ctrl+Shift+Y', 'CmdOrCtrl+Shift+Y')).toBe(false)
    expect(samePress('CmdOrCtrl+Q', 'CmdOrCtrl+Shift+Q')).toBe(false)
  })

  it('reads CmdOrCtrl as Ctrl where the Command key does not exist', () => {
    expect(samePress('Ctrl+Shift+Y', 'CmdOrCtrl+Shift+Y', 'win32')).toBe(true)
    expect(samePress('Cmd+Shift+Y', 'CmdOrCtrl+Shift+Y', 'win32')).toBe(false)
  })
})

describe('the fixed shortcuts of the menus', () => {
  it('are held by no command by default', () => {
    for (const command of COMMANDS) expect(takenBy(effectiveAccelerator(command.id, {}), FIXED_SHORTCUTS), command.id).toBeUndefined()
  })

  it('carry the two keys of the annotation, one of which the annotated share has too', () => {
    expect(takenBy(PAGE_TOGGLE_SHORTCUT, FIXED_SHORTCUTS)?.label).toBe('Annoter cette page')
    expect(takenBy(PAGE_SHORTCUT, FIXED_SHORTCUTS)).toBeDefined()
    expect(PASS_SHORTCUT).toBe(PAGE_SHORTCUT)
  })

  it('each have a name in both languages', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const fixed of FIXED_SHORTCUTS) expect(fixed.label.trim(), fixed.accelerator).not.toBe('')
    }
  })
})

describe('giving a shortcut to a command', () => {
  it('refuses the shortcut of a fixed entry of the menus, saves nothing and says whose it is', () => {
    for (const [accelerator, owner] of [['CmdOrCtrl+Q', 'Quitter Lucium'], ['CmdOrCtrl+C', 'Copier'], ['CmdOrCtrl+Alt+M', 'Annoter cette page'], ['CmdOrCtrl+Z', 'Annuler'], ['CmdOrCtrl+Alt+P', 'Dessin ou passage, pendant une annotation']] as const) {
      const assignment = assignShortcut('newWindow', accelerator, {}, FIXED_SHORTCUTS, 'darwin')
      expect(assignment.kind, accelerator).toBe('refused')
      if (assignment.kind === 'refused') {
        expect(assignment.text).toContain(frenchSpaces(`« ${owner} »`))
        expect(assignment.text).toContain(frenchSpaces(`« ${commandLabel('newWindow')} »`))
        expect(assignment.text).toContain('ne se change pas ici')
      }
    }
  })

  it('says it in English too', () => {
    setLanguage('en')
    const assignment = assignShortcut('newWindow', 'CmdOrCtrl+Q', {}, FIXED_SHORTCUTS, 'darwin')
    expect(assignment).toEqual({ kind: 'refused', text: `⌘Q is already the shortcut of “Quit Lucium”, which cannot be changed here. It was not given to “${commandLabel('newWindow')}”.` })
  })

  it('refuses the shortcut the menu gives a command of an extension, written as the extension has it', () => {
    const taken = extensionMenuCommands({ id: 'ext', name: 'Lecteur', commands: [{ name: 'save', description: 'Enregistrer l’article', accelerator: 'Shift+Cmd+Y' }] })
    const assignment = assignShortcut('newWindow', 'CmdOrCtrl+Shift+Y', {}, taken, 'darwin')
    expect(assignment.kind).toBe('refused')
    if (assignment.kind === 'refused') expect(assignment.text).toContain(frenchSpaces('« Enregistrer l’article (Lecteur) »'))
  })

  it('saves a free shortcut, last in the list even when the command had a saved one', () => {
    const assignment = assignShortcut('newWindow', 'CmdOrCtrl+Alt+K', { newWindow: 'CmdOrCtrl+Alt+J', print: 'CmdOrCtrl+Alt+L' }, FIXED_SHORTCUTS, 'darwin')
    expect(assignment).toEqual({ kind: 'saved', bindings: { print: 'CmdOrCtrl+Alt+L', newWindow: 'CmdOrCtrl+Alt+K' }, clash: undefined })
    if (assignment.kind === 'saved') expect(Object.keys(assignment.bindings)).toEqual(['print', 'newWindow'])
  })

  it('saves a shortcut another command has, and names the two', () => {
    const assignment = assignShortcut('newWindow', 'CmdOrCtrl+T', {}, FIXED_SHORTCUTS, 'darwin')
    expect(assignment.kind).toBe('saved')
    if (assignment.kind === 'saved') expect(assignment.clash).toContain('⌘T est utilisé par plusieurs commandes')
  })
})

describe('the commands of an extension that the menu gives a key to', () => {
  it('are the ones with a shortcut, except the ones that only open its button', () => {
    const commands = [
      { name: 'save', description: '', accelerator: 'Alt+Shift+S' },
      { name: 'none', description: 'Sans touche', accelerator: null },
      { name: '_execute_action', description: '', accelerator: 'Alt+Shift+A' }
    ]
    expect(extensionMenuCommands({ id: 'ext', name: 'Lecteur', commands })).toEqual([{ extensionId: 'ext', name: 'save', accelerator: 'Alt+Shift+S', label: 'save (Lecteur)' }])
    expect(extensionMenuCommands({ id: 'ext', name: 'Lecteur' })).toEqual([])
    // A key that is not modifiers and one key gets no entry: the words come from a manifest, and the menu of the application is built with them.
    for (const accelerator of ['Cmd+function Object() { [native code] }', 'Cmd+[object Object]', 'Cmd+', 'Cmd+Tab', 'cmd+e', 'Cmd+E+F', '']) {
      expect(extensionMenuCommands({ id: 'ext', name: 'Lecteur', commands: [{ name: 'save', description: '', accelerator }] }), accelerator).toEqual([])
    }
  })
})

describe('a saved shortcut that something else than a command holds', () => {
  it('is said under its row, with who holds it', () => {
    expect(takenNote('newWindow', { newWindow: 'CmdOrCtrl+Q' }, FIXED_SHORTCUTS)).toBe(frenchSpaces('Aussi le raccourci de « Quitter Lucium » : l’un des deux peut ne pas répondre.'))
    expect(takenNote('newWindow', {}, FIXED_SHORTCUTS)).toBeUndefined()
    expect(takenNote('newWindow', { newWindow: '' }, FIXED_SHORTCUTS)).toBeUndefined()
  })
})

describe('a key press while a row records its shortcut', () => {
  it('cancels on Escape and turns the shortcut off on Backspace or Delete alone', () => {
    expect(recordingStep(press('Escape', 'Escape'), 'darwin')).toEqual({ kind: 'cancel' })
    expect(recordingStep(press('Backspace', 'Backspace'), 'darwin')).toEqual({ kind: 'clear' })
    expect(recordingStep(press('Delete', 'Delete'), 'darwin')).toEqual({ kind: 'clear' })
    expect(recordingStep(press('Backspace', 'Backspace', { shiftKey: true }), 'darwin')).toEqual({ kind: 'clear' })
  })

  it('records Backspace and Delete held with ⌘, ⌃ or ⌥: they are shortcuts like another', () => {
    expect(recordingStep(press('Backspace', 'Backspace', { metaKey: true }), 'darwin')).toEqual({ kind: 'record', accelerator: 'CmdOrCtrl+Backspace' })
    expect(recordingStep(press('Delete', 'Delete', { ctrlKey: true }), 'darwin')).toEqual({ kind: 'record', accelerator: 'Ctrl+Delete' })
    expect(recordingStep(press('Backspace', 'Backspace', { altKey: true, shiftKey: true }), 'darwin')).toEqual({ kind: 'record', accelerator: 'Alt+Shift+Backspace' })
  })

  it('keeps listening on a lone modifier, and records a shortcut with the layout it is given', () => {
    expect(recordingStep(press('MetaLeft', 'Meta', { metaKey: true }), 'darwin')).toEqual({ kind: 'wait' })
    expect(recordingStep(press('KeyQ', 'æ', { metaKey: true, altKey: true }), 'darwin', (code) => (code === 'KeyQ' ? 'a' : undefined))).toEqual({ kind: 'record', accelerator: 'CmdOrCtrl+Alt+A' })
  })
})

describe('who else uses a press', () => {
  it('knows the presses of editors and sites, of macOS and of Mission Control, in any spelling', () => {
    expect(otherUseOf('CmdOrCtrl+Shift+X')).toBe('page')
    expect(otherUseOf('Shift+CmdOrCtrl+X')).toBe('page')
    expect(otherUseOf('CmdOrCtrl+S')).toBe('macos')
    expect(otherUseOf('Ctrl+D')).toBe('macos')
    expect(otherUseOf('Ctrl+5')).toBe('mission-control')
    expect(otherUseOf('CmdOrCtrl+T')).toBeUndefined()
    expect(otherUseOf('CmdOrCtrl+5')).toBeUndefined()
    expect(otherUseOf(undefined)).toBeUndefined()
  })

  it('covers the default shortcuts known to take a key of the pages or of the system', () => {
    const use = (id: string) => otherUseOf(effectiveAccelerator(id, {}))
    for (const id of ['clearSiteData', 'downloads', 'notes', 'copyUrl', 'inspectElement', 'shortcutHelp', 'back', 'forward', 'history', 'pin', 'clearToday', 'jumpToSelection', 'findNext']) expect(use(id), id).toBe('page')
    for (const id of ['toggleSidebar', 'stop', 'developerMode']) expect(use(id), id).toBe('macos')
    for (let n = 1; n <= 9; n++) expect(use(`space${n}`)).toBe('mission-control')
  })

  it('writes one note per reason, in both languages', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const notes = COMMANDS.flatMap((command) => otherUseNotes(command.id, {}, 'darwin', { littleEverywhere: true, characters: { KeyA: 'q' } }))
      expect(notes.length).toBeGreaterThan(25)
      for (const note of notes) expect(note).not.toMatch(/settings-shortcuts\.|\{[a-z]+\}/)
    }
  })
})

describe('the key of a shortcut on the keyboard in use', () => {
  const french = { BracketLeft: '^', BracketRight: '$', Comma: ';', Period: ':', Slash: '=', KeyM: ',', Equal: '-' }

  it('is named when the keyboard does not give it alone', () => {
    expect(keyOffLayout('CmdOrCtrl+[', french)).toBe('[')
    expect(keyOffLayout('CmdOrCtrl+/', french)).toBe('/')
    expect(keyOffLayout('CmdOrCtrl+;', french)).toBeUndefined()
    expect(keyOffLayout('CmdOrCtrl+-', french)).toBeUndefined()
  })

  it('says nothing of a letter, a digit or a named key, nor without a layout', () => {
    expect(keyOffLayout('CmdOrCtrl+A', french)).toBeUndefined()
    expect(keyOffLayout('CmdOrCtrl+1', french)).toBeUndefined()
    expect(keyOffLayout('CmdOrCtrl+Plus', french)).toBeUndefined()
    expect(keyOffLayout('Ctrl+Tab', french)).toBeUndefined()
    expect(keyOffLayout('CmdOrCtrl+[', undefined)).toBeUndefined()
    expect(keyOffLayout('CmdOrCtrl+[', {})).toBeUndefined()
    expect(keyOffLayout(undefined, french)).toBeUndefined()
  })
})
