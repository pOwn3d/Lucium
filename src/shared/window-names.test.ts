import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { WINDOW_NAME_MAX, cleanWindowName, namedWindows, pageWindowTitle, tabWindowTitle, windowEntryLabel, windowNamesKey, type WindowEntry } from './window-names'

describe('cleanWindowName', () => {
  it('keeps a plain name and trims it', () => {
    expect(cleanWindowName('Travail')).toBe('Travail')
    expect(cleanWindowName('  Mon  projet \t perso ')).toBe('Mon projet perso')
  })

  it('has no name for what is not text or is empty once cleaned', () => {
    for (const bad of [undefined, null, 3, {}, [], '', '   ', '\n\t', '​‮']) expect(cleanWindowName(bad), String(bad)).toBeUndefined()
  })

  it('removes the marks that make a name read otherwise than it is, and turns line breaks into spaces', () => {
    expect(cleanWindowName('a‮b​c')).toBe('abc')
    expect(cleanWindowName('ligne 1\nligne 2\u0000')).toBe('ligne 1 ligne 2')
  })

  it('stops at the length limit without cutting a character in two', () => {
    expect(cleanWindowName('x'.repeat(500))).toBe('x'.repeat(WINDOW_NAME_MAX))
    const cut = cleanWindowName('😀'.repeat(100))!
    expect([...cut]).toHaveLength(WINDOW_NAME_MAX)
    expect(cut.endsWith('\uD83D')).toBe(false)
  })
})

describe('what the menu and the command bar list', () => {
  const entries: WindowEntry[] = [
    { id: 'main', kind: 'main', position: 1, focused: true, name: 'Principale' },
    { id: 'window-1', kind: 'window', position: 2, focused: false, name: 'Travail' },
    { id: 'window-2', kind: 'window', position: 3, focused: false },
    { id: 'private-1', kind: 'private', position: 4, focused: false }
  ]

  it('labels a window by its name, else by its place, a private one by what it is', () => {
    expect(entries.map(windowEntryLabel)).toEqual(['Principale', 'Travail', 'Fenêtre 3', 'Fenêtre privée'])
  })

  it('offers to go to the named windows other than the one the bar is in', () => {
    expect(namedWindows(entries, 'main')).toEqual([{ id: 'window-1', name: 'Travail' }])
    expect(namedWindows(entries, 'window-2')).toEqual([{ id: 'main', name: 'Principale' }, { id: 'window-1', name: 'Travail' }])
    expect(namedWindows([], 'main')).toEqual([])
  })

  it('changes the key of the menu when a name, a window or the focus changes', () => {
    const keys = new Set([windowNamesKey(entries), windowNamesKey(entries.slice(1)), windowNamesKey([{ ...entries[0]!, name: 'Autre' }, ...entries.slice(1)]), windowNamesKey([{ ...entries[0]!, focused: false }, ...entries.slice(1)])])
    expect(keys.size).toBe(4)
  })
})

describe('the setting', () => {
  it('is off by default, and the Window menu stays the system’s own', () => {
    expect(defaultSettings().nameWindows).toBe(false)
  })
})

describe('pageWindowTitle', () => {
  it('is the title of the page, cleaned and bounded like a name', () => {
    expect(pageWindowTitle('  Porte Entrée\n - Direct - Frigate ', 'Lucium')).toBe('Porte Entrée - Direct - Frigate')
    expect(pageWindowTitle('a\u202Eb', 'Lucium')).toBe('ab')
    expect([...pageWindowTitle('x'.repeat(500), 'Lucium')]).toHaveLength(WINDOW_NAME_MAX)
  })

  it('is the fallback for a page with no title', () => {
    expect(pageWindowTitle(undefined, 'Lucium')).toBe('Lucium')
    expect(pageWindowTitle('   ', 'Lucium')).toBe('Lucium')
    expect(pageWindowTitle('\u200B', 'Lucium')).toBe('Lucium')
  })
})

describe('tabWindowTitle', () => {
  it('is the title of the page of an ordinary tab', () => {
    expect(tabWindowTitle({ title: 'Compte rendu' }, 'Lucium')).toBe('Compte rendu')
    expect(tabWindowTitle(undefined, 'Lucium')).toBe('Lucium')
  })

  it('tells the system nothing of a private tab: the window carries the usual title', () => {
    expect(tabWindowTitle({ title: 'Résultats d’analyses', private: true }, 'Lucium')).toBe('Lucium')
  })
})
