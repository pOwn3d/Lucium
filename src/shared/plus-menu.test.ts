import { describe, expect, it } from 'vitest'
import {
  initialPlusSelection,
  isPlusAnchor,
  PLUS_GROUPS,
  PLUS_MENU,
  plusEntryEnabled,
  plusEntryRefusal,
  plusGroups,
  plusMenuHeight,
  plusMenuPlacement,
  plusShortcut,
  stepPlusSelection
} from './plus-menu'
import { t } from './i18n'

describe('the rows', () => {
  it('are space, folder, —, Tweak, —, split, with no Easel and no tab (the list and ⌘T make the tab)', () => {
    expect(PLUS_GROUPS.map((group) => group.map((entry) => entry.id))).toEqual([['space', 'folder'], ['boost'], ['split']])
    expect(PLUS_GROUPS.flat().map((entry) => entry.label)).toEqual(['Nouvel espace', 'Nouveau dossier', 'Nouvelle Retouche', 'Nouvelle vue scindée'])
    expect(PLUS_GROUPS.flat().some((entry) => entry.command === 'newTab')).toBe(false)
  })
})

describe('the row of the work views', () => {
  it('comes just before « Nouvelle vue scindée », which stays the last row, only while the work views are on', () => {
    expect(plusGroups({ workViews: true }).map((group) => group.map((entry) => entry.id))).toEqual([['space', 'folder'], ['boost'], ['workview', 'split']])
    expect(plusGroups({ workViews: true }).flat().find((entry) => entry.id === 'workview')?.label).toBe('Nouvelle vue de travail…')
    expect(plusGroups({ workViews: false })).toBe(PLUS_GROUPS)
    expect(plusGroups({})).toBe(PLUS_GROUPS)
    // A view is made from nothing: no tab is needed.
    expect(plusEntryEnabled('workview', { tabUrl: null })).toBe(true)
  })
})

describe('plusMenuHeight', () => {
  it('is 8 + 40 per row + 17 per separator + 8: six rows and two separators make 290', () => {
    expect(plusMenuHeight([[1, 2], [3, 4], [5, 6]])).toBe(290)
    expect(plusMenuHeight()).toBe(PLUS_MENU.padding * 2 + 4 * PLUS_MENU.rowHeight + 2 * PLUS_MENU.separator)
    expect(plusMenuHeight([])).toBe(16)
  })
})

describe('plusEntryEnabled', () => {
  it('lets a Tweak start only on a web page with a host, and a split only with a tab on screen', () => {
    expect(plusEntryEnabled('boost', { tabUrl: 'https://example.com/page' })).toBe(true)
    expect(plusEntryEnabled('boost', { tabUrl: null })).toBe(false)
    expect(plusEntryEnabled('boost', { tabUrl: 'about:blank' })).toBe(false)
    expect(plusEntryEnabled('boost', { tabUrl: 'file:///tmp/a.html' })).toBe(false)
    expect(plusEntryEnabled('split', { tabUrl: 'about:blank' })).toBe(true)
    expect(plusEntryEnabled('split', { tabUrl: null })).toBe(false)
  })

  it('never greys out the rows that need nothing', () => {
    for (const id of ['space', 'folder'] as const) expect(plusEntryEnabled(id, { tabUrl: null })).toBe(true)
  })

  it('greys out « Nouveau dossier » while the space on screen is locked, and says why: the folder would land in it', () => {
    expect(plusEntryEnabled('folder', { tabUrl: null, spaceLocked: true })).toBe(false)
    expect(plusEntryRefusal('folder', { tabUrl: null, spaceLocked: true })).toBe(t('lock.deverrouillez-l-espace-d-abord'))
    expect(plusEntryRefusal('folder', { tabUrl: null, spaceLocked: false })).toBeNull()
    // A new space lands in no space: the lock of the one on screen leaves it alone.
    expect(plusEntryEnabled('space', { tabUrl: null, spaceLocked: true })).toBe(true)
    expect(plusEntryRefusal('space', { tabUrl: null, spaceLocked: true })).toBeNull()
  })
})

describe('plusShortcut', () => {
  const entry = (id: string) => PLUS_GROUPS.flat().find((e) => e.id === id)!

  it('prints the shortcut in force with its keys spaced, and nothing for a row without a command', () => {
    expect(plusShortcut(entry('split'), undefined)).toBe('⌃ ⇧ =')
    expect(plusShortcut(entry('boost'), { boost: 'CmdOrCtrl+Alt+B' })).toBe('')
  })

  it('follows what the user bound, and shows nothing for a shortcut they removed', () => {
    expect(plusShortcut(entry('split'), { addSplit: 'CmdOrCtrl+Alt+S' })).toBe('⌥ ⌘ S')
    expect(plusShortcut(entry('split'), { addSplit: '' })).toBe('')
    expect(plusShortcut(entry('space'), undefined)).toBe('')
    expect(plusShortcut(entry('space'), { newSpace: 'CmdOrCtrl+Shift+N' })).toBe('⇧ ⌘ N')
  })
})

describe('the selection', () => {
  it('starts on the last enabled row', () => {
    expect(initialPlusSelection([true, true, true, true, true])).toBe(4)
    expect(initialPlusSelection([true, true, false, false, false])).toBe(1)
    expect(initialPlusSelection([false, false])).toBe(-1)
  })

  it('moves over the enabled rows only, wrapping around', () => {
    const enabled = [true, true, false, true, true]
    expect(stepPlusSelection(enabled, 1, 1)).toBe(3)
    expect(stepPlusSelection(enabled, 3, -1)).toBe(1)
    expect(stepPlusSelection(enabled, 4, 1)).toBe(0)
    expect(stepPlusSelection(enabled, 0, -1)).toBe(4)
  })

  it('goes to the first row going down and to the last going up when none is selected', () => {
    expect(stepPlusSelection([false, true, true], -1, 1)).toBe(1)
    expect(stepPlusSelection([true, true, false], -1, -1)).toBe(1)
  })

  it('stays where it is when it is the only row that can be chosen, and gives up when there is none', () => {
    expect(stepPlusSelection([false, true, false], 1, 1)).toBe(1)
    expect(stepPlusSelection([false, false], 0, 1)).toBe(-1)
    expect(stepPlusSelection([], -1, 1)).toBe(-1)
  })
})

describe('plusMenuPlacement', () => {
  it('puts the card\'s right edge at x = 314 and its foot 16 px above the button (button 283, 847, 32 x 32 in a 1680 x 888 window)', () => {
    const { rightEdge, bottom } = plusMenuPlacement({ x: 283, y: 847, width: 32, height: 32 }, { height: 888 })
    expect(rightEdge).toBe(314)
    expect(888 - bottom).toBe(831)
    // Four rows and two separators now (six would make 290): the card is 210 tall, its top at 621.
    expect(831 - plusMenuHeight()).toBe(621)
  })
})

describe('isPlusAnchor', () => {
  it('accepts a rectangle of finite numbers and nothing else', () => {
    expect(isPlusAnchor({ x: 283, y: 847, width: 32, height: 32 })).toBe(true)
    expect(isPlusAnchor({ x: 283, y: 847, width: 32 })).toBe(false)
    expect(isPlusAnchor({ x: Number.NaN, y: 847, width: 32, height: 32 })).toBe(false)
    expect(isPlusAnchor({ x: 283, y: 847, width: -1, height: 32 })).toBe(false)
    expect(isPlusAnchor({ x: '283', y: 847, width: 32, height: 32 })).toBe(false)
    expect(isPlusAnchor({ x: 1e9, y: 847, width: 32, height: 32 })).toBe(false)
    expect(isPlusAnchor(null)).toBe(false)
  })
})
