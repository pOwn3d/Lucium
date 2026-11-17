// Aide des raccourcis (⌘/): what the sheet lists, from the bindings in force, with a search; the shortcuts the user changed are marked.

import { describe, expect, it } from 'vitest'
import { COMMANDS, effectiveAccelerator, findConflicts } from './keybindings'
import { defaultSettings } from './model'
import { HELP_CONTEXTS, shortcutSheet } from './shortcut-help'

const on = { tabSearch: true, shortcutHelp: true, tabCycleRecent: true, notes: true }
const rows = (sheet: ReturnType<typeof shortcutSheet>) => sheet.groups.flatMap((g) => g.rows)
const row = (sheet: ReturnType<typeof shortcutSheet>, id: string) => rows(sheet).find((r) => r.id === id)

describe('the new shortcuts', () => {
  it('⇧⌘A searches the tabs and ⌘/ opens the sheet, and neither clashes with another command, however it is spelled', () => {
    expect(effectiveAccelerator('tabSearch', {})).toBe('CmdOrCtrl+Shift+A')
    expect(effectiveAccelerator('shortcutHelp', {})).toBe('CmdOrCtrl+/')
    expect(findConflicts({})).toEqual({})
    // The archive keeps ⌥⌘A: the two differ by one modifier.
    expect(effectiveAccelerator('archive', {})).toBe('CmdOrCtrl+Alt+A')
  })

  it('are the defaults of commands that exist once', () => {
    expect(COMMANDS.filter((c) => c.id === 'tabSearch' || c.id === 'shortcutHelp')).toHaveLength(2)
  })
})

describe('the sheet', () => {
  it('lists about thirty shortcuts in the five contexts, in their order, with the keys in force', () => {
    const sheet = shortcutSheet({}, on)
    expect(sheet.groups.map((g) => g.context)).toEqual([...HELP_CONTEXTS])
    expect(sheet.groups.map((g) => g.title)).toEqual(['Onglets', 'Espaces', 'Page', 'Fenêtre', 'Barre de commandes'])
    expect(rows(sheet).length).toBeGreaterThanOrEqual(30)
    expect(rows(sheet).length).toBeLessThanOrEqual(41)
    expect(row(sheet, 'newTab')).toMatchObject({ label: 'Nouvel onglet…', keys: ['⌘T'], custom: false, was: null, note: null })
    expect(row(sheet, 'tabSearch')).toMatchObject({ keys: ['⇧⌘A'] })
    expect(row(sheet, 'shortcutHelp')).toMatchObject({ keys: ['⌘/'] })
    expect(row(sheet, 'item1')!.keys).toEqual(['⌘1', '…', '⌘9'])
    expect(row(sheet, 'space1')!.keys).toEqual(['⌃1', '…', '⌃9'])
    expect(row(sheet, 'zoomIn')!.keys).toEqual(['⌘+', '⌘-'])
    // A note tied to the page on screen, with the page's shortcuts.
    expect(row(sheet, 'newNote')).toMatchObject({ label: 'Nouvelle note', keys: ['⌥⌘E'], note: null })
    expect(sheet.groups.find((g) => g.context === 'page')!.rows.map((r) => r.id)).toContain('newNote')
  })

  it('reads the keys from keybindings.ts: a key given to a command is the one the sheet shows', () => {
    const sheet = shortcutSheet({ newTab: 'CmdOrCtrl+Alt+T' }, on)
    expect(row(sheet, 'newTab')!.keys).toEqual(['⌥⌘T'])
  })

  it('marks a shortcut the user changed, with the key it had, and not one that only has the default spelled another way', () => {
    const sheet = shortcutSheet({ toggleSidebar: 'CmdOrCtrl+Alt+S', find: 'CmdOrCtrl+F', blankWindow: 'CmdOrCtrl+Ctrl+N' }, on)
    expect(row(sheet, 'toggleSidebar')).toMatchObject({ custom: true, was: '⌘S', keys: ['⌥⌘S'] })
    expect(row(sheet, 'find')).toMatchObject({ custom: false, was: null })
    // A change to the key a command already has is no change, whatever the order of its modifiers.
    const reordered = shortcutSheet({ newLittleArc: 'Alt+CmdOrCtrl+N' }, on)
    expect(row(reordered, 'newLittleArc')).toMatchObject({ custom: false })
  })

  it('leaves out a command the user switched off, and one bound to nothing by default', () => {
    const sheet = shortcutSheet({ closeTab: '' }, on)
    expect(row(sheet, 'closeTab')).toBeUndefined()
    expect(rows(sheet).some((r) => r.id === 'newSpace')).toBe(false)
  })

  it('says when the function behind a key is switched off', () => {
    const off = shortcutSheet({}, { tabSearch: false, shortcutHelp: true, tabCycleRecent: false, notes: false })
    expect(row(off, 'tabSearch')!.note).toMatch(/désactivée/)
    expect(row(off, 'recentTab')!.note).toMatch(/désactivée/)
    expect(row(off, 'newNote')!.note).toMatch(/désactivée/)
    expect(row(off, 'newTab')!.note).toBeNull()
    expect(row(shortcutSheet({}, on), 'tabSearch')!.note).toBeNull()
  })

  it('shows the keys typed in the field of the bar, which cannot be changed', () => {
    const sheet = shortcutSheet({}, on)
    expect(rows(sheet).filter((r) => r.id.startsWith('typed:')).map((r) => r.keys[0])).toEqual(['>', '@', '⌘↵'])
    expect(rows(sheet).filter((r) => r.id.startsWith('typed:')).every((r) => !r.custom && r.note !== null)).toBe(true)
  })
})

describe('the search of the sheet', () => {
  it('finds a shortcut by its name, accents and case ignored, and drops the contexts that have none left', () => {
    const found = shortcutSheet({}, on, 'EPINGLER')
    expect(rows(found).map((r) => r.id)).toEqual(['pin'])
    expect(found.groups.map((g) => g.context)).toEqual(['tabs'])
    expect(found.shown).toBe(1)
  })

  it('finds a shortcut by its key, written as the keyboard shows it or in words', () => {
    for (const query of ['⌘T', 'cmd t', 'commande t']) expect(rows(shortcutSheet({}, on, query)).map((r) => r.id), query).toContain('newTab')
    expect(rows(shortcutSheet({}, on, '⇧⌘A')).map((r) => r.id)).toContain('tabSearch')
  })

  it('finds the keys typed in the field of the bar by the key itself', () => {
    expect(rows(shortcutSheet({}, on, '@')).map((r) => r.id)).toEqual(['typed:@'])
    expect(rows(shortcutSheet({}, on, '>')).map((r) => r.id)).toEqual(['typed:>'])
    expect(rows(shortcutSheet({}, on, '⌘↵')).map((r) => r.id)).toEqual(['typed:⌘↵'])
  })

  it('finds a whole context by its name', () => {
    expect(shortcutSheet({}, on, 'espaces').groups.map((g) => g.context)).toContain('spaces')
  })

  it('finds the key the user gave, not the one it had', () => {
    const sheet = shortcutSheet({ toggleSidebar: 'CmdOrCtrl+Alt+S' }, on, 'option commande s')
    expect(rows(sheet).map((r) => r.id)).toContain('toggleSidebar')
  })

  it('says how many shortcuts Réglages › Raccourcis holds when nothing answers', () => {
    const none = shortcutSheet({}, on, 'xyzxyz')
    expect(none.groups).toEqual([])
    expect(none.shown).toBe(0)
    expect(none.total).toBe(COMMANDS.length)
  })

  it('does not depend on the other settings of the profile', () => {
    expect(defaultSettings().tabSearch).toBe(true)
    expect(defaultSettings().shortcutHelp).toBe(true)
  })
})

describe('the second shortcut of a command, in the sheet', () => {
  it('is drawn after the first, for a command and for both ends of a family, and nowhere else', () => {
    const sheet = shortcutSheet({}, on)
    expect(row(sheet, 'back')).toMatchObject({ keys: ['⌘['], also: ['⌃⌘←'] })
    expect(row(sheet, 'forward')).toMatchObject({ keys: ['⌘]'], also: ['⌃⌘→'] })
    expect(row(sheet, 'shortcutHelp')).toMatchObject({ keys: ['⌘/'], also: ['⌥⌘K'] })
    expect(row(sheet, 'clearSiteData')).toMatchObject({ keys: ['⇧⌘X'], also: ['⌃⌘X'] })
    expect(row(sheet, 'space1')).toMatchObject({ keys: ['⌃1', '…', '⌃9'], also: ['⌃⌘1', '…', '⌃⌘9'] })
    expect(rows(sheet).filter((r) => r.also.length > 0).map((r) => r.id).sort()).toEqual(['back', 'clearSiteData', 'forward', 'shortcutHelp', 'space1'])
    expect(row(sheet, 'item1')!.also).toEqual([])
  })

  it('follows the bindings: it stays beside a changed first key, and is gone when another command took the press', () => {
    expect(row(shortcutSheet({ back: 'CmdOrCtrl+Alt+Shift+K' }, on), 'back')).toMatchObject({ keys: ['⌥⇧⌘K'], also: ['⌃⌘←'], custom: true })
    expect(row(shortcutSheet({ history: 'Ctrl+CmdOrCtrl+Left' }, on), 'back')).toMatchObject({ keys: ['⌘['], also: [] })
    // A family whose one end lost its second press shows none: « ⌃⌘1 … ⌃⌘9 » would promise nine keys.
    expect(row(shortcutSheet({ history: 'Ctrl+CmdOrCtrl+9' }, on), 'space1')!.also).toEqual([])
  })

  it('is found by the search, typed as keys or as words', () => {
    for (const query of ['⌃⌘←', 'ctrl cmd left', '⌥⌘K']) {
      const found = rows(shortcutSheet({}, on, query)).map((r) => r.id)
      expect(found, query).toContain(query === '⌥⌘K' ? 'shortcutHelp' : 'back')
    }
  })
})
