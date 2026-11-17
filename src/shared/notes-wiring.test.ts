// The ways into the quick notes, each following the switch of the function and never in a private window: the command bar, the shortcuts (⇧⌘E for the
// panel, ⌥⌘E for a new note, both free), "note <text>" in the bar, the menu (built again when the switch moves), the panels a private window may open,
// and the registry of the functions.

import { describe, expect, it } from 'vitest'
import { actionShortcut, actionToDispatch, groupCandidates, inScope, rankCandidates, splitScope, type Candidate } from './command-bar'
import { DEVTOOLS_EXTRA_ACCELERATOR } from './devtools-request'
import { featureById, featureDefault, featurePatch } from './features'
import { COMMANDS, canonicalAccelerator, effectiveAccelerator, findConflicts, formatAccelerator, sameAccelerator } from './keybindings'
import { PAGE_SHORTCUT, PAGE_TOGGLE_SHORTCUT } from './page-annotate'
import { PASS_SHORTCUT } from './window-share-pass'
import { canOpenWhileLocked } from './lock'
import { menuKey } from './menu-state'
import type { Settings, SidebarState } from './model'
import { canOpenInPrivate } from './private-window'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { frenchSpaces } from './french-typography'

let n = 0
const ctx = (): Ctx => ({ now: 1, newId: () => `id${++n}` })
function state(settings: Partial<Settings> = {}): SidebarState {
  const s = createInitialState(ctx())
  return reduce({ ...s, settings: { ...s.settings, ...settings } }, { type: 'tab/open', url: 'https://example.org/' }, ctx())
}
const offered = (list: Candidate[], action = 'notes') => list.filter((c) => c.kind === 'action' && c.action === action)

describe('the command bar and the quick notes', () => {
  it('offers "Ouvrir les notes" when typed, while the function is on, with its shortcut', () => {
    const found = offered(rankCandidates('notes', state()))
    expect(found).toEqual([{ kind: 'action', id: 'action:notes', label: 'Ouvrir les notes', detail: 'Action', action: 'notes' }])
    expect(actionShortcut('notes', state(), 'darwin')).toBe('⇧⌘E')
    // It opens a panel: nothing is dispatched to the sidebar.
    expect(actionToDispatch('notes', state())).toBeNull()
  })

  it('offers nothing while the function is off, nor in a private window', () => {
    expect(offered(rankCandidates('notes', state({ notes: false })))).toEqual([])
    expect(offered(rankCandidates('ouvrir les notes', state(), [], [], [], { private: true }))).toEqual([])
  })
})

describe('the command bar and a new note', () => {
  it('offers "Nouvelle note" when typed, while the function is on, with its shortcut, and dispatches nothing (the main process opens the panel)', () => {
    expect(offered(rankCandidates('nouvelle note', state()), 'new-note')).toEqual([{ kind: 'action', id: 'action:new-note', label: 'Nouvelle note', detail: 'Action', action: 'new-note' }])
    expect(actionShortcut('new-note', state(), 'darwin')).toBe('⌥⌘E')
    expect(actionShortcut('new-note', state({ keyBindings: { newNote: '' } }), 'darwin')).toBeNull()
    expect(actionToDispatch('new-note', state())).toBeNull()
  })

  it('offers nothing while the function is off, nor in a private window', () => {
    expect(offered(rankCandidates('nouvelle note', state({ notes: false })), 'new-note')).toEqual([])
    expect(offered(rankCandidates('nouvelle note', state(), [], [], [], { private: true }), 'new-note')).toEqual([])
  })
})

describe('"note" and a text typed in the command bar', () => {
  const jot = (list: Candidate[]) => offered(list, 'jot-note')

  it('offers to make that note at once, tied to the page on screen, on the line after what Enter opens', () => {
    const list = rankCandidates('note relire la fin', state())
    expect(list[0]).toMatchObject({ kind: 'open', search: true, label: 'note relire la fin' })
    expect(list[1]).toEqual({ kind: 'action', id: 'action:jot-note', label: frenchSpaces('Nouvelle note : « relire la fin »'), detail: frenchSpaces('Page : example.org'), action: 'jot-note', text: 'relire la fin' })
    // Grouped by genre, the search still leads: "note de frais" is searched for with Enter, the note is the first command.
    const grouped = groupCandidates(list)
    expect(grouped[0]).toMatchObject({ kind: 'open', search: true })
    expect(grouped.find((c) => c.kind === 'action')).toMatchObject({ action: 'jot-note' })
    expect(actionToDispatch('jot-note', state())).toBeNull()
  })

  it('is the line Enter runs among the commands (">")', () => {
    const typed = splitScope('> note relire la fin')
    expect(inScope(rankCandidates(typed.text, state()), typed.scope)[0]).toMatchObject({ action: 'jot-note', text: 'relire la fin' })
  })

  it('reads the keyword whatever its case, and the text without the blanks around it', () => {
    expect(jot(rankCandidates('Note   appeler le garage ', state()))[0]).toMatchObject({ text: 'appeler le garage', label: frenchSpaces('Nouvelle note : « appeler le garage »') })
  })

  it('says the note goes to the space when the tab on screen is no web page', () => {
    const s = createInitialState(ctx())
    expect(jot(rankCandidates('note ordre du jour', s))[0]).toMatchObject({ detail: frenchSpaces('Espace : Perso'), text: 'ordre du jour' })
  })

  it('offers nothing without a text, while the function is off, in a private window, or when a site search of the user answers "note"', () => {
    expect(jot(rankCandidates('note', state()))).toEqual([])
    expect(jot(rankCandidates('note   ', state()))).toEqual([])
    expect(jot(rankCandidates('notes relire', state()))).toEqual([])
    expect(jot(rankCandidates('note relire', state({ notes: false })))).toEqual([])
    expect(jot(rankCandidates('note relire', state(), [], [], [], { private: true }))).toEqual([])
    const mine = state({ siteSearches: [{ keyword: 'note', name: 'Carnet', url: 'https://carnet.example/?q=%s' }] })
    expect(jot(rankCandidates('note relire', mine))).toEqual([])
    expect(rankCandidates('note relire', mine)[0]).toMatchObject({ kind: 'open', id: 'open:site' })
  })
})

describe('the shortcut of a new note', () => {
  it('is ⌥⌘E: the letter of the notes, one modifier apart from ⇧⌘E, which keeps opening the panel', () => {
    expect(COMMANDS.filter((c) => c.id === 'newNote')).toHaveLength(1)
    expect(COMMANDS.find((c) => c.id === 'newNote')).toMatchObject({ label: 'Nouvelle note', group: 'Fichier' })
    expect(formatAccelerator(effectiveAccelerator('newNote', {})!, 'darwin')).toBe('⌥⌘E')
    expect(formatAccelerator(effectiveAccelerator('notes', {})!, 'darwin')).toBe('⇧⌘E')
  })

  it('takes a key that is free: no other command, no key the application holds outside the list, however the modifiers are written', () => {
    const key = canonicalAccelerator('CmdOrCtrl+Alt+E')
    expect(COMMANDS.filter((c) => c.accelerator !== '' && canonicalAccelerator(c.accelerator) === key).map((c) => c.id)).toEqual(['newNote'])
    expect(findConflicts({})).toEqual({})
    // The annotation (⌥⌘M, ⌥⌘P, held system-wide when asked), the window share (⌥⌘P), the developer tools (F12) and Undo (⌘Z, fixed in the menu).
    for (const held of [PAGE_TOGGLE_SHORTCUT, PAGE_SHORTCUT, PASS_SHORTCUT, DEVTOOLS_EXTRA_ACCELERATOR, 'CmdOrCtrl+Z']) expect(sameAccelerator(held, 'CmdOrCtrl+Alt+E'), held).toBe(false)
    // Every ⌘N is a window: none was free for it.
    expect(['newWindow', 'privateWindow', 'newLittleArc', 'blankWindow'].map((id) => formatAccelerator(effectiveAccelerator(id, {})!, 'darwin'))).toEqual(['⌘N', '⇧⌘N', '⌥⌘N', '⌃⌘N'])
  })

  it('can be changed or taken away in Réglages › Raccourcis, and clashes with a command given the same key', () => {
    expect(effectiveAccelerator('newNote', { newNote: '' })).toBeUndefined()
    expect(effectiveAccelerator('newNote', { newNote: 'CmdOrCtrl+Alt+Shift+N' })).toBe('CmdOrCtrl+Alt+Shift+N')
    expect(findConflicts({ newNote: 'CmdOrCtrl+Shift+E' })).toEqual({ 'CmdOrCtrl+Shift+E': ['notes', 'newNote'] })
  })

  it('has no default where ⌥⌘E reads Ctrl+Alt+E, the AltGr key that types €', () => {
    expect(effectiveAccelerator('newNote', {}, 'win32')).toBeUndefined()
    expect(effectiveAccelerator('newNote', {}, 'linux')).toBeUndefined()
    expect(effectiveAccelerator('newNote', {}, 'darwin')).toBe('CmdOrCtrl+Alt+E')
  })
})

describe('the shortcut of the notes', () => {
  it('is ⇧⌘E, given to no other command, and can be changed or taken away', () => {
    expect(COMMANDS.filter((c) => c.id === 'notes')).toHaveLength(1)
    expect(effectiveAccelerator('notes', {})).toBe('CmdOrCtrl+Shift+E')
    expect(formatAccelerator('CmdOrCtrl+Shift+E', 'darwin')).toBe('⇧⌘E')
    expect(COMMANDS.filter((c) => c.accelerator === 'CmdOrCtrl+Shift+E').map((c) => c.id)).toEqual(['notes'])
    expect(findConflicts({})).toEqual({})
    expect(effectiveAccelerator('notes', { notes: '' })).toBeUndefined()
    expect(effectiveAccelerator('notes', { notes: 'CmdOrCtrl+Alt+E' })).toBe('CmdOrCtrl+Alt+E')
  })
})

describe('the menu and the panels', () => {
  it('builds the menu again when the function is switched on or off, and the key of a browser that never switched it is unchanged', () => {
    const s = state()
    const on = menuKey(s, [])
    expect(menuKey({ ...s, settings: { ...s.settings, notes: false } }, [])).not.toBe(on)
    expect(on).not.toContain('noNotes')
  })

  it('never opens the panel in a private window, nor over a locked application', () => {
    expect(canOpenInPrivate('notes')).toBe(false)
    expect(canOpenWhileLocked('notes', true)).toBe(false)
    expect(canOpenWhileLocked('notes', false)).toBe(true)
  })
})

describe('the registry of the functions', () => {
  it('has the notes on by default, in "Données et sauvegardes", switched by their own setting, costing a file on the disk only', () => {
    const feature = featureById('notes')
    expect(feature).toMatchObject({ key: 'notes', group: 'data', cost: ['disk'] })
    expect(featureDefault('notes')).toBe(true)
    expect(featurePatch('notes', false)).toEqual({ notes: false })
  })
})
