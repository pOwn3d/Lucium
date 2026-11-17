// A root folder can stand under the loose Today tabs instead of above them (`Folder.atBottom`): the reducer's actions on it, how it is saved and repaired, how
// it travels (duplicate, archive, space put aside, session, copy, import), and the order the sidebar lists the tabs in. A folder that never was put there is
// shown, saved and listed exactly as before.

import { describe, expect, it } from 'vitest'
import { canOpenInPrivate, privateAction } from './private-window'
import { folderRows, normalizeFolders } from './folders'
import type { Folder, SidebarState } from './model'
import { appendSessionTabs, cleanSessionTab, sessionTabsOf } from './sessions'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, restoredState, sidebarOrder, visibleTabOrder, type Action } from './sidebar'

let n = 0
const ctx = { now: 1_700_000_000_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const roundTrip = (state: SidebarState): SidebarState => parseSavedState(JSON.stringify(persistableState(state)))

/**
 * Folders A, B, C (roots, in that order) and D inside A. Tabs: a1, a2 in A · b1 in B · d1 in D · c1 in C · p1 pinned at the root · Today: t1, t2, t3.
 */
function setup() {
  let s = createInitialState(ctx)
  for (const name of ['A', 'B', 'C']) s = run(s, { type: 'folder/create', name })
  const [a, b, c] = s.folders.map((f) => f.id) as [string, string, string]
  s = run(s, { type: 'folder/create', name: 'D', parentId: a })
  const d = s.folders.find((f) => f.name === 'D')!.id
  for (const name of ['a1', 'a2', 'b1', 'd1', 'c1', 'p1', 't1', 't2', 't3']) s = run(s, { type: 'tab/open', url: `https://${name}.example/`, background: true })
  const id = (name: string) => s.tabs.find((t) => t.url === `https://${name}.example/`)!.id
  const put = (name: string, folderId: string | undefined) => (s = run(s, { type: 'tab/move', id: id(name), toIndex: 99, pinned: true, ...(folderId ? { folderId } : {}) }))
  put('a1', a)
  put('a2', a)
  put('b1', b)
  put('d1', d)
  put('c1', c)
  put('p1', undefined)
  const names = (state: SidebarState, list = sidebarOrder(state, state.activeSpaceId)) => list.map((t) => t.url.slice(8).replace('.example/', ''))
  const sides = (state: SidebarState) => state.folders.map((f) => `${f.name}${f.atBottom ? '↓' : ''}`)
  return { s, a, b, c, d, id, names, sides }
}

describe('putting a folder under the Today tabs', () => {
  it('flags it and takes it to the very end of the folders under the tabs (the first of the ones above them when it goes back up)', () => {
    const { s, a, b, c, sides } = setup()
    expect(sides(s)).toEqual(['A', 'B', 'C', 'D'])
    const one = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(sides(one)).toEqual(['B', 'C', 'A↓', 'D'])
    const two = run(one, { type: 'folder/bottom', id: b, bottom: true })
    expect(sides(two)).toEqual(['C', 'A↓', 'B↓', 'D'])
    // Back up: first among the folders above the tabs.
    const up = run(two, { type: 'folder/bottom', id: b, bottom: false })
    expect(sides(up)).toEqual(['B', 'C', 'A↓', 'D'])
    expect(up.folders.find((f) => f.id === b)).not.toHaveProperty('atBottom')
    expect(folderRows(up.folders, up.activeSpaceId, 'top').map((r) => r.folder.name)).toEqual(['B', 'C'])
    expect(folderRows(up.folders, up.activeSpaceId, 'bottom').map((r) => r.folder.name)).toEqual(['A', 'D'])
    expect(c).toBeTruthy()
  })

  it('changes nothing for a folder that already is on the side asked, a folder that does not exist, or a folder inside another', () => {
    const { s, a, d } = setup()
    expect(run(s, { type: 'folder/bottom', id: a, bottom: false })).toBe(s)
    expect(run(s, { type: 'folder/bottom', id: 'nope', bottom: true })).toBe(s)
    expect(run(s, { type: 'folder/bottom', id: d, bottom: true })).toBe(s)
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(run(down, { type: 'folder/bottom', id: a, bottom: true })).toBe(down)
    // Anything but `true` is "back on top".
    expect(run(down, { type: 'folder/bottom', id: a, bottom: 'yes' as never }).folders.find((f) => f.id === a)).not.toHaveProperty('atBottom')
  })

  it('does not move a folder that already is under the tabs behind the ones that are there (asking again changes nothing)', () => {
    const { s, a, b, sides } = setup()
    const two = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'folder/bottom', id: b, bottom: true })
    expect(sides(two)).toEqual(['C', 'A↓', 'B↓', 'D'])
    expect(run(two, { type: 'folder/bottom', id: a, bottom: true })).toBe(two)
  })

  it('keeps what is in the folder with it: its tabs, and the folders inside it', () => {
    const { s, a, d } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(down.tabs.filter((t) => t.folderId === a)).toHaveLength(2)
    expect(down.folders.find((f) => f.id === d)).toMatchObject({ parentId: a })
    expect(down.folders.find((f) => f.id === d)).not.toHaveProperty('atBottom')
  })

  it('does not touch the folders of another space', () => {
    let { s, a } = setup()
    s = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'folder/create', name: 'Z' })
    const other = s.folders.find((f) => f.name === 'Z')!
    const out = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(out.folders.find((f) => f.id === other.id)).toBe(other)
  })
})

describe('folder/move and the side of the list', () => {
  it('keeps the side of a folder moved among the root folders, and takes the side that is said', () => {
    const { s, a, b, sides } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(sides(run(down, { type: 'folder/move', id: a, parentId: null, toIndex: 0 }))).toEqual(['A↓', 'B', 'C', 'D'])
    expect(sides(run(down, { type: 'folder/move', id: b, parentId: null, toIndex: 0, side: 'bottom' }))).toEqual(['B↓', 'C', 'A↓', 'D'])
    // Only the side changes when the place is the one it has.
    const here = run(down, { type: 'folder/move', id: a, parentId: null, toIndex: 2, side: 'top' })
    expect(sides(here)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('takes the side off a folder put inside another, and does not give it back when it comes out', () => {
    const { s, a, b, sides } = setup()
    const down = run(s, { type: 'folder/bottom', id: b, bottom: true })
    const inside = run(down, { type: 'folder/move', id: b, parentId: a, toIndex: 0 })
    expect(inside.folders.find((f) => f.id === b)).toMatchObject({ parentId: a })
    expect(inside.folders.find((f) => f.id === b)).not.toHaveProperty('atBottom')
    const out = run(inside, { type: 'folder/move', id: b, parentId: null, toIndex: 0 })
    expect(sides(out)).toEqual(['B', 'A', 'C', 'D'])
    // A side said for a folder that goes inside another is not kept either.
    expect(run(s, { type: 'folder/move', id: b, parentId: a, toIndex: 0, side: 'bottom' }).folders.find((f) => f.id === b)).not.toHaveProperty('atBottom')
  })

  it('is the same state when nothing changes: the place and the side are the ones the folder has', () => {
    const { s, a } = setup()
    expect(run(s, { type: 'folder/move', id: a, parentId: null, toIndex: 0 })).toBe(s)
    expect(run(s, { type: 'folder/move', id: a, parentId: null, toIndex: 0, side: 'top' })).toBe(s)
  })
})

describe('what happens to the side when a folder is deleted, copied or turned into a space', () => {
  it('lets the folders inside a deleted folder come up on its side of the list', () => {
    const { s, a, d, sides } = setup()
    const up = run(s, { type: 'folder/delete', id: a })
    expect(up.folders.find((f) => f.id === d)).not.toHaveProperty('atBottom')
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'folder/delete', id: a })
    expect(down.folders.find((f) => f.id === d)).toMatchObject({ atBottom: true })
    expect(down.folders.find((f) => f.id === d)).not.toHaveProperty('parentId')
    expect(sides(down)).toEqual(['B', 'C', 'D↓'])
  })

  it('does not make a root folder of a folder that came up inside a folder that has a parent', () => {
    const { s, a, d, b } = setup()
    const deep = run(s, { type: 'folder/move', id: a, parentId: b, toIndex: 0 })
    const out = run(deep, { type: 'folder/delete', id: a })
    expect(out.folders.find((f) => f.id === d)).toMatchObject({ parentId: b })
    expect(out.folders.find((f) => f.id === d)).not.toHaveProperty('atBottom')
  })

  it('copies the side with a duplicated folder (the copy stands right after the original, on the same side), and gives none to the folders in the copy', () => {
    const { s, a, sides } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    const copy = run(down, { type: 'folder/duplicate', id: a })
    expect(sides(copy)).toEqual(['B', 'C', 'A↓', 'A (copie)↓', 'D', 'D'])
    expect(copy.folders.filter((f) => f.parentId !== undefined).every((f) => f.atBottom === undefined)).toBe(true)
  })

  it('turns a folder under the tabs into a space whose folders stand on top, as they do in a new space', () => {
    const { s, a } = setup()
    const out = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'folder/to-space', id: a })
    const space = out.activeSpaceId
    expect(out.folders.filter((f) => f.spaceId === space).map((f) => f.atBottom)).toEqual([undefined])
    expect(out.folders.some((f) => f.name === 'A')).toBe(false)
  })

  it('does not recreate an archived folder: its tabs come back at the root of the pinned list, with no side to give', () => {
    const { s, a, id } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    const archived = run(down, { type: 'folder/archive', id: a })
    expect(archived.folders.some((f) => f.id === a)).toBe(false)
    const back = run(archived, { type: 'archive/restore-last', count: 3 })
    const a1 = back.tabs.find((t) => t.url === 'https://a1.example/')!
    expect(a1.pinned).toBe(true)
    expect(a1.folderId).toBeUndefined()
    expect(back.folders.some((f) => f.atBottom === true)).toBe(false)
    expect(id('a1')).toBeTruthy()
  })
})

describe('saving and loading', () => {
  it('writes the side of a folder and reads it back, and writes nothing for a folder that never had one', () => {
    const { s, a } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    const loaded = roundTrip(down)
    expect(loaded.folders.map((f) => [f.name, f.atBottom])).toEqual(down.folders.map((f) => [f.name, f.atBottom]))
    expect(JSON.stringify(persistableState(s))).not.toContain('atBottom')
    expect(roundTrip(s).folders).toEqual(s.folders)
  })

  it('is read as nothing unless it is `true`: any other value gives the folder back its place on top', () => {
    const { s, a } = setup()
    for (const value of [false, 'true', 1, 0, null, {}, [], 'bottom']) {
      const loaded = normalize({ ...s, folders: s.folders.map((f) => (f.id === a ? { ...f, atBottom: value as never } : f)) })
      expect(loaded.folders.find((f) => f.id === a), JSON.stringify(value)).not.toHaveProperty('atBottom')
    }
  })

  it('is taken off a folder that has a parent, and kept on a folder whose parent was missing (it is a root folder once repaired)', () => {
    const { s, a, d } = setup()
    const nested = normalize({ ...s, folders: s.folders.map((f) => (f.id === d ? { ...f, atBottom: true as const } : f)) })
    expect(nested.folders.find((f) => f.id === d)).not.toHaveProperty('atBottom')
    const orphan = normalize({ ...s, folders: s.folders.map((f) => (f.id === d ? { ...f, parentId: 'gone', atBottom: true as const } : f)) })
    expect(orphan.folders.find((f) => f.id === d)).toMatchObject({ atBottom: true })
    expect(orphan.folders.find((f) => f.id === d)).not.toHaveProperty('parentId')
    expect(a).toBeTruthy()
  })

  it('is repaired the same way by normalizeFolders on its own, and the repair is stable', () => {
    const folders: Folder[] = [
      { id: 'r', spaceId: 's', name: 'R', collapsed: false },
      { id: 'c', spaceId: 's', name: 'C', collapsed: false, parentId: 'r', atBottom: true },
      { id: 'o', spaceId: 's', name: 'O', collapsed: false, atBottom: true }
    ]
    const once = normalizeFolders(folders, new Set(['s']))
    expect(once.map((f) => [f.id, f.atBottom])).toEqual([['r', undefined], ['c', undefined], ['o', true]])
    expect(normalizeFolders(once, new Set(['s']))).toEqual(once)
    // A folder that is fine comes back as the very object it was.
    expect(once.find((f) => f.id === 'o')).toBe(folders[2])
  })

  it('goes through a restored copy and a restored state', () => {
    const { s, a } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(restoredState(JSON.parse(JSON.stringify(down)))?.folders.find((f) => f.id === a)?.atBottom).toBe(true)
    const { spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive } = down
    const restored = run(s, { type: 'backup/restore', copy: { spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive } })
    expect(restored.folders.find((f) => f.id === a)?.atBottom).toBe(true)
    expect(run(s, { type: 'state/restore', state: down }).folders.find((f) => f.id === a)?.atBottom).toBe(true)
  })

  it('goes through an import: a folder an importer hands over under the tabs stays there, a folder inside another does not', () => {
    const base = createInitialState(ctx)
    const space = base.activeSpaceId
    const out = run(base, {
      type: 'import/merge',
      spaces: [],
      tabs: [],
      folders: [
        { id: 'i1', spaceId: space, name: 'Importé', collapsed: false, atBottom: true },
        { id: 'i2', spaceId: space, name: 'Dedans', collapsed: false, parentId: 'i1', atBottom: true }
      ],
      favorites: []
    })
    expect(out.folders.map((f) => [f.name, f.atBottom])).toEqual([['Importé', true], ['Dedans', undefined]])
  })

  it('goes with a space put aside and brought back', () => {
    let { s, a } = setup()
    s = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const first = s.spaces[0]!.id
    const aside = run(s, { type: 'space/aside', id: first })
    expect(aside.folders).toHaveLength(0)
    const session = aside.sessions[0]!
    expect(session.space?.folders.find((f) => f.name === 'A')?.atBottom).toBe(true)
    const back = run(aside, { type: 'space/reopen', id: session.id })
    expect(back.folders.find((f) => f.name === 'A')?.atBottom).toBe(true)
    expect(back.folders.find((f) => f.name === 'B')).not.toHaveProperty('atBottom')
  })
})

describe('the order of the tabs in the sidebar', () => {
  it('is unchanged while no folder is under the tabs: loose pinned, the folders’ tabs, then Today', () => {
    const { s, names } = setup()
    expect(names(s)).toEqual(['p1', 'a1', 'a2', 'd1', 'b1', 'c1', 't1', 't2', 't3'])
  })

  it('puts the tabs of the folders under the tabs after Today, the folders in their own order, a folder’s own tabs before the ones in it', () => {
    const { s, a, c, names } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'folder/bottom', id: c, bottom: true })
    expect(names(down)).toEqual(['p1', 'b1', 't1', 't2', 't3', 'a1', 'a2', 'd1', 'c1'])
    // Listing the same tabs, none lost, none twice.
    expect([...names(down)].sort()).toEqual([...names(s)].sort())
  })

  it('leaves a collapsed folder’s tabs out of the visible order wherever the folder stands', () => {
    const { s, a, names } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'folder/toggle', id: a })
    expect(names(down, visibleTabOrder(down, down.activeSpaceId))).toEqual(['p1', 'b1', 'c1', 't1', 't2', 't3'])
  })

  it('moves the selection from tab to tab in the order shown (⌃Tab goes down the list, the folders under the tabs last)', () => {
    const { s, a, id } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true }, { type: 'tab/select', id: id('t3') })
    const after = run(down, { type: 'tab/select', id: sidebarOrder(down, down.activeSpaceId)[sidebarOrder(down, down.activeSpaceId).findIndex((t) => t.id === id('t3')) + 1]!.id })
    expect(after.tabs.find((t) => t.id === after.activeTabBySpace[after.activeSpaceId])?.url).toBe('https://a1.example/')
  })
})

describe('a saved session', () => {
  it('remembers that a folder stood under the tabs, only for a root folder, and only with a folder to name', () => {
    const { s, a, d } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    const saved = sessionTabsOf(sidebarOrder(down, down.activeSpaceId), down.folders)
    expect(saved.filter((t) => t.folder === 'A').map((t) => t.folderBottom)).toEqual([true, true])
    // The folder inside it has no side of its own (it is placed with its parent), and the other folders did not move.
    expect(saved.find((t) => t.folder === 'D')).not.toHaveProperty('folderBottom')
    expect(saved.find((t) => t.folder === 'B')).not.toHaveProperty('folderBottom')
    expect(saved.find((t) => t.folder === undefined)).not.toHaveProperty('folderBottom')
    expect(sessionTabsOf(sidebarOrder(s, s.activeSpaceId), s.folders).some((t) => 'folderBottom' in t)).toBe(false)
    expect(d).toBeTruthy()
  })

  it('reads the mark only as `true` and only on a pinned page that has a folder', () => {
    const page = { url: 'https://a.example/', title: 'A' }
    expect(cleanSessionTab({ ...page, pinned: true, folder: 'Docs', folderBottom: true })).toMatchObject({ folderBottom: true })
    for (const value of [false, 1, 'true', null]) expect(cleanSessionTab({ ...page, pinned: true, folder: 'Docs', folderBottom: value })).not.toHaveProperty('folderBottom')
    expect(cleanSessionTab({ ...page, pinned: true, folderBottom: true })).not.toHaveProperty('folderBottom')
    expect(cleanSessionTab({ ...page, folder: 'Docs', folderBottom: true })).not.toHaveProperty('folderBottom')
  })

  it('makes the folder it has to make under the tabs again, and leaves a folder that exists where it is', () => {
    const base = createInitialState(ctx)
    const pages = [
      { url: 'https://a.example/', title: 'A', pinned: true, folder: 'Neuf', folderBottom: true as const },
      { url: 'https://b.example/', title: 'B', pinned: true, folder: 'Neuf', folderBottom: true as const },
      { url: 'https://c.example/', title: 'C', pinned: true, folder: 'Haut' }
    ]
    const { state } = appendSessionTabs(base, base.activeSpaceId, pages, ctx)
    expect(state.folders.map((f) => [f.name, f.atBottom])).toEqual([['Neuf', true], ['Haut', undefined]])
    const withExisting = run(base, { type: 'folder/create', name: 'Neuf' })
    expect(appendSessionTabs(withExisting, withExisting.activeSpaceId, pages, ctx).state.folders.find((f) => f.name === 'Neuf')).not.toHaveProperty('atBottom')
  })
})

describe('the settings that go with it', () => {
  it('has "en haut" for the place of the folders "Ranger" makes, and reads nothing but "bottom" as the other', () => {
    const base = createInitialState(ctx)
    expect(base.settings.tidyFoldersPosition).toBe('top')
    for (const value of ['bottom', 'top']) expect(normalize({ ...base, settings: { ...base.settings, tidyFoldersPosition: value as never } }).settings.tidyFoldersPosition).toBe(value)
    for (const value of ['Bottom', 'down', '', 1, null, true, {}]) expect(normalize({ ...base, settings: { ...base.settings, tidyFoldersPosition: value as never } }).settings.tidyFoldersPosition, JSON.stringify(value)).toBe('top')
  })
})

describe('a private window', () => {
  it('has no pinned list and no folder: the actions of this feature are refused there, and so is its panel', () => {
    for (const action of [{ type: 'tabs/tidy', groups: [] }, { type: 'tabs/untidy', tabs: [], folderIds: [] }, { type: 'folder/bottom', id: 'x', bottom: true }] as Action[]) expect(privateAction(action), action.type).toBeNull()
    expect(canOpenInPrivate('tidy')).toBe(false)
  })
})
