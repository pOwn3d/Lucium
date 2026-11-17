// A root folder can stand at the start of Today (`Folder.atTodayStart`): under the Today header and its "New tab" row, before the Today tabs. Until then a folder had
// two places only, above the Today header (with the loose pinned tabs) or under the Today tabs (`atBottom`), so a folder under the tabs could not be taken up to
// the start of the list it sits in. What is held here: the reducer's actions on that side, how it is saved and repaired, the order the sidebar lists the tabs in,
// and what it leaves alone (the Today tabs, the archiving of Today, the folders that never were put there).

import { describe, expect, it } from 'vitest'
import { folderRows, isFolderSide, normalizeFolders, sideOfFolder, withSide } from './folders'
import type { Folder, SidebarState } from './model'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, sidebarOrder, visibleTabOrder, type Action } from './sidebar'
import { sidebarRows, tabOfItem } from './sidebar-items'

let n = 0
const ctx = { now: 1_700_000_000_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const roundTrip = (state: SidebarState): SidebarState => parseSavedState(JSON.stringify(persistableState(state)))

/**
 * Root folders A, B, C (in that order) and D inside A. Tabs: a1 in A · b1 in B · c1 in C · d1 in D · p1 pinned at the root · Today: t1, t2, t3.
 * `sides` writes each root folder with its side: ↓ under the Today tabs, ⇡ at the start of Today, nothing above the Today header.
 */
function setup() {
  let s = createInitialState(ctx)
  for (const name of ['A', 'B', 'C']) s = run(s, { type: 'folder/create', name })
  const [a, b, c] = s.folders.map((f) => f.id) as [string, string, string]
  s = run(s, { type: 'folder/create', name: 'D', parentId: a })
  const d = s.folders.find((f) => f.name === 'D')!.id
  for (const name of ['a1', 'b1', 'c1', 'd1', 'p1', 't1', 't2', 't3']) s = run(s, { type: 'tab/open', url: `https://${name}.example/`, background: true })
  const id = (name: string) => s.tabs.find((t) => t.url === `https://${name}.example/`)!.id
  const put = (name: string, folderId: string | undefined) => (s = run(s, { type: 'tab/move', id: id(name), toIndex: 99, pinned: true, ...(folderId ? { folderId } : {}) }))
  put('a1', a)
  put('b1', b)
  put('c1', c)
  put('d1', d)
  put('p1', undefined)
  const names = (state: SidebarState, list = sidebarOrder(state, state.activeSpaceId)) => list.map((t) => t.url.slice(8).replace('.example/', ''))
  const sides = (state: SidebarState) => state.folders.filter((f) => f.parentId === undefined).map((f) => `${f.name}${f.atBottom ? '↓' : f.atTodayStart ? '⇡' : ''}`)
  const toStart = (state: SidebarState, folderId: string, toIndex = 0) => run(state, { type: 'folder/move', id: folderId, parentId: null, toIndex, side: 'today-start' })
  return { s, a, b, c, d, id, names, sides, toStart }
}

describe('the sides of a root folder', () => {
  it('are three, and a folder is on one: the bottom wins when a file says both', () => {
    expect(['top', 'today-start', 'bottom'].every(isFolderSide)).toBe(true)
    for (const value of ['', 'up', 'Top', 1, null, undefined, {}]) expect(isFolderSide(value), String(value)).toBe(false)
    expect(sideOfFolder({})).toBe('top')
    expect(sideOfFolder({ atTodayStart: true })).toBe('today-start')
    expect(sideOfFolder({ atBottom: true })).toBe('bottom')
    expect(sideOfFolder({ atBottom: true, atTodayStart: true })).toBe('bottom')
  })

  it('writes the flag of one side and no other', () => {
    const folder: Folder = { id: 'f', spaceId: 's', name: 'F', collapsed: false, atBottom: true }
    expect(withSide(folder, 'today-start')).toEqual({ id: 'f', spaceId: 's', name: 'F', collapsed: false, atTodayStart: true })
    expect(withSide({ ...folder, atTodayStart: true }, 'bottom')).toEqual(folder)
    expect(withSide(folder, 'top')).toEqual({ id: 'f', spaceId: 's', name: 'F', collapsed: false })
  })
})

describe('putting a folder at the start of Today', () => {
  it('flags it, takes the flag of the bottom off it, and keeps what is in it', () => {
    const { s, a, d, sides, toStart } = setup()
    const down = run(s, { type: 'folder/bottom', id: a, bottom: true })
    expect(sides(down)).toEqual(['B', 'C', 'A↓'])
    const start = toStart(down, a)
    expect(sides(start)).toEqual(['A⇡', 'B', 'C'])
    expect(start.folders.find((f) => f.id === a)).not.toHaveProperty('atBottom')
    expect(start.tabs.filter((t) => t.folderId === a)).toHaveLength(1)
    expect(start.folders.find((f) => f.id === d)).toMatchObject({ parentId: a })
    expect(start.folders.find((f) => f.id === d)).not.toHaveProperty('atTodayStart')
    expect(folderRows(start.folders, start.activeSpaceId, 'today-start').map((r) => r.folder.name)).toEqual(['A', 'D'])
    expect(folderRows(start.folders, start.activeSpaceId, 'top').map((r) => r.folder.name)).toEqual(['B', 'C'])
    expect(folderRows(start.folders, start.activeSpaceId, 'bottom')).toEqual([])
  })

  it('takes it from the folders above the Today header too, and the place among the root folders is the one said', () => {
    const { s, c, sides, toStart } = setup()
    expect(sides(toStart(s, c, 0))).toEqual(['C⇡', 'A', 'B'])
    expect(sides(toStart(s, c, 1))).toEqual(['A', 'C⇡', 'B'])
  })

  it('is first of the folders at the start of Today when it is put in front of them, and last when it is put behind', () => {
    const { s, a, b, sides, toStart } = setup()
    const one = toStart(s, a)
    expect(folderRows(toStart(one, b, 0).folders, s.activeSpaceId, 'today-start').map((r) => r.folder.name)).toEqual(['B', 'A', 'D'])
    expect(folderRows(toStart(one, b, 5).folders, s.activeSpaceId, 'today-start').map((r) => r.folder.name)).toEqual(['A', 'D', 'B'])
    expect(sides(toStart(one, b, 0))).toEqual(['B⇡', 'A⇡', 'C'])
  })

  it('changes nothing for a folder that is where it is asked to be, or a folder that does not exist', () => {
    const { s, a, toStart } = setup()
    const start = toStart(s, a)
    expect(toStart(start, a)).toBe(start)
    expect(toStart(start, 'nope')).toBe(start)
  })

  it('reads a side that is one: anything else leaves the folder on the side it had', () => {
    const { s, a, b, sides, toStart } = setup()
    const start = toStart(s, a)
    for (const side of ['sideways', '', 1, null, {}, 'Top']) {
      const moved = run(start, { type: 'folder/move', id: a, parentId: null, toIndex: 2, side: side as never })
      expect(sides(moved), String(side)).toEqual(['B', 'C', 'A⇡'])
    }
    expect(sides(run(toStart(s, b), { type: 'folder/move', id: b, parentId: null, toIndex: 0, side: 'top' }))).toEqual(['B', 'A', 'C'])
  })

  it('gives a folder put inside another none: it is placed with its parent, and does not get its side back when it comes out', () => {
    const { s, a, b, sides, toStart } = setup()
    const start = toStart(s, b)
    const inside = run(start, { type: 'folder/move', id: b, parentId: a, toIndex: 0 })
    expect(inside.folders.find((f) => f.id === b)).not.toHaveProperty('atTodayStart')
    expect(run(inside, { type: 'folder/move', id: b, parentId: null, toIndex: 0 }).folders.find((f) => f.id === b)).not.toHaveProperty('atTodayStart')
    // The side said for a folder that goes inside another is not kept either.
    expect(run(s, { type: 'folder/move', id: b, parentId: a, toIndex: 0, side: 'today-start' }).folders.find((f) => f.id === b)).not.toHaveProperty('atTodayStart')
    expect(sides(inside)).toEqual(['A', 'C'])
  })

  it('does not touch the folders of another space', () => {
    let { s, a, toStart } = setup()
    s = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'folder/create', name: 'Z' })
    const other = s.folders.find((f) => f.name === 'Z')!
    expect(toStart(s, a).folders.find((f) => f.id === other.id)).toBe(other)
  })
})

describe('"Mettre en haut de la liste" and "Mettre en bas de la liste" from the start of Today', () => {
  it('takes a folder at the start of Today above the Today header, first of the folders there', () => {
    const { s, a, b, sides, toStart } = setup()
    const start = toStart(s, b)
    const up = run(start, { type: 'folder/bottom', id: b, bottom: false })
    expect(up.folders.find((f) => f.id === b)).not.toHaveProperty('atTodayStart')
    expect(sides(up)).toEqual(['B', 'A', 'C'])
    expect(a).toBeTruthy()
  })

  it('takes it under the Today tabs, with one flag only, behind the folders that are there', () => {
    const { s, a, b, sides, toStart } = setup()
    const down = run(toStart(run(s, { type: 'folder/bottom', id: a, bottom: true }), b), { type: 'folder/bottom', id: b, bottom: true })
    expect(down.folders.find((f) => f.id === b)).not.toHaveProperty('atTodayStart')
    expect(down.folders.find((f) => f.id === b)).toMatchObject({ atBottom: true })
    expect(sides(down)).toEqual(['C', 'A↓', 'B↓'])
  })

  it('is still nothing for a folder that is on the side asked, and for a folder inside another', () => {
    const { s, a, d, toStart } = setup()
    expect(run(s, { type: 'folder/bottom', id: a, bottom: false })).toBe(s)
    expect(run(s, { type: 'folder/bottom', id: d, bottom: true })).toBe(s)
    const start = toStart(s, a)
    expect(run(start, { type: 'folder/bottom', id: a, bottom: true }).folders.find((f) => f.id === a)).toMatchObject({ atBottom: true })
  })
})

describe('what happens to the side when a folder is deleted or copied', () => {
  it('lets the folders inside a deleted folder come up on its side of the list', () => {
    const { s, a, d, sides, toStart } = setup()
    const out = run(toStart(s, a), { type: 'folder/delete', id: a })
    expect(out.folders.find((f) => f.id === d)).toMatchObject({ atTodayStart: true })
    expect(out.folders.find((f) => f.id === d)).not.toHaveProperty('parentId')
    expect(sides(out)).toEqual(['B', 'C', 'D⇡'])
  })

  it('copies the side with a duplicated folder, and gives none to the folders in the copy', () => {
    const { s, a, sides, toStart } = setup()
    const out = run(toStart(s, a), { type: 'folder/duplicate', id: a })
    expect(sides(out)).toEqual(['A⇡', 'A (copie)⇡', 'B', 'C'])
    expect(out.folders.filter((f) => f.parentId !== undefined).every((f) => f.atTodayStart === undefined)).toBe(true)
  })
})

describe('saving and loading', () => {
  it('writes the side of a folder and reads it back, in the order the folders were, and writes nothing for a folder that never had one', () => {
    const { s, a, c, sides, toStart } = setup()
    const start = toStart(toStart(s, c), a)
    expect(sides(start)).toEqual(['A⇡', 'C⇡', 'B'])
    const loaded = roundTrip(start)
    expect(sides(loaded)).toEqual(sides(start))
    expect(loaded.folders).toEqual(start.folders)
    expect(JSON.stringify(persistableState(s))).not.toContain('atTodayStart')
    expect(roundTrip(s).folders).toEqual(s.folders)
  })

  it('keeps the order of the tabs in the sidebar across a save', () => {
    const { s, a, names, toStart } = setup()
    const start = toStart(s, a)
    expect(names(roundTrip(start))).toEqual(names(start))
  })

  it('is read as nothing unless it is `true`: any other value gives the folder back its place on top', () => {
    const { s, a } = setup()
    for (const value of [false, 'true', 1, 0, null, {}, [], 'today-start']) {
      const loaded = normalize({ ...s, folders: s.folders.map((f) => (f.id === a ? { ...f, atTodayStart: value as never } : f)) })
      expect(loaded.folders.find((f) => f.id === a), JSON.stringify(value)).not.toHaveProperty('atTodayStart')
    }
  })

  it('has one side per folder: a file that says both keeps the bottom', () => {
    const { s, a } = setup()
    const loaded = parseSavedState(JSON.stringify({ ...persistableState(s), folders: s.folders.map((f) => (f.id === a ? { ...f, atBottom: true, atTodayStart: true } : f)) }))
    expect(loaded.folders.find((f) => f.id === a)).toMatchObject({ atBottom: true })
    expect(loaded.folders.find((f) => f.id === a)).not.toHaveProperty('atTodayStart')
  })

  it('is taken off a folder that has a parent, and kept on a folder whose parent was missing (it is a root folder once repaired)', () => {
    const { s, d } = setup()
    const nested = normalize({ ...s, folders: s.folders.map((f) => (f.id === d ? { ...f, atTodayStart: true as const } : f)) })
    expect(nested.folders.find((f) => f.id === d)).not.toHaveProperty('atTodayStart')
    const orphan = normalize({ ...s, folders: s.folders.map((f) => (f.id === d ? { ...f, parentId: 'gone', atTodayStart: true as const } : f)) })
    expect(orphan.folders.find((f) => f.id === d)).toMatchObject({ atTodayStart: true })
    expect(orphan.folders.find((f) => f.id === d)).not.toHaveProperty('parentId')
  })

  it('is repaired the same way by normalizeFolders on its own, and the repair is stable', () => {
    const folders: Folder[] = [
      { id: 'r', spaceId: 's', name: 'R', collapsed: false },
      { id: 'c', spaceId: 's', name: 'C', collapsed: false, parentId: 'r', atTodayStart: true },
      { id: 'o', spaceId: 's', name: 'O', collapsed: false, atTodayStart: true }
    ]
    const once = normalizeFolders(folders, new Set(['s']))
    expect(once.map((f) => [f.id, f.atTodayStart])).toEqual([['r', undefined], ['c', undefined], ['o', true]])
    expect(normalizeFolders(once, new Set(['s']))).toEqual(once)
    expect(once.find((f) => f.id === 'o')).toBe(folders[2])
  })

  it('goes with a space put aside and brought back', () => {
    let { s, a, toStart } = setup()
    s = run(toStart(s, a), { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const aside = run(s, { type: 'space/aside', id: s.spaces[0]!.id })
    expect(aside.sessions[0]!.space?.folders.find((f) => f.name === 'A')?.atTodayStart).toBe(true)
    const back = run(aside, { type: 'space/reopen', id: aside.sessions[0]!.id })
    expect(back.folders.find((f) => f.name === 'A')?.atTodayStart).toBe(true)
    expect(back.folders.find((f) => f.name === 'B')).not.toHaveProperty('atTodayStart')
  })
})

describe('the order of the tabs in the sidebar', () => {
  it('is unchanged while no folder is at the start of Today: loose pinned, the folders’ tabs, then Today', () => {
    const { s, names } = setup()
    expect(names(s)).toEqual(['p1', 'a1', 'd1', 'b1', 'c1', 't1', 't2', 't3'])
  })

  it('puts the tabs of the folders at the start of Today after those of the folders above the header, and before the Today tabs', () => {
    const { s, a, names, toStart } = setup()
    expect(names(toStart(s, a))).toEqual(['p1', 'b1', 'c1', 'a1', 'd1', 't1', 't2', 't3'])
  })

  it('puts the three places in order: above the header, at the start of Today, then Today, then under it', () => {
    const { s, a, b, c, names, toStart } = setup()
    const three = run(toStart(s, b), { type: 'folder/bottom', id: c, bottom: true })
    expect(names(three)).toEqual(['p1', 'a1', 'd1', 'b1', 't1', 't2', 't3', 'c1'])
    // A put behind B at the start of Today leaves nothing above the header but the loose pinned tab.
    expect(names(toStart(three, a, 99))).toEqual(['p1', 'b1', 'a1', 'd1', 't1', 't2', 't3', 'c1'])
  })

  it('keeps the tabs of a closed folder out of the rows to click, and numbers the rows as they are drawn (⌘1 … ⌘9)', () => {
    const { s, a, b, id, names, toStart } = setup()
    // B then A at the start of Today, C above the header; B is closed: its tab is no row.
    const start = run(toStart(toStart(s, a), b), { type: 'folder/toggle', id: b })
    expect(names(start)).toEqual(['p1', 'c1', 'b1', 'a1', 'd1', 't1', 't2', 't3'])
    expect(names(start, visibleTabOrder(start, start.activeSpaceId))).toEqual(['p1', 'c1', 'a1', 'd1', 't1', 't2', 't3'])
    expect(names(start, sidebarRows(start, start.activeSpaceId))).toEqual(names(start, visibleTabOrder(start, start.activeSpaceId)))
    // The row after the tabs of the folder at the start of Today is the first Today tab.
    const rows = sidebarRows(start, start.activeSpaceId)
    expect(rows.indexOf(rows.find((t) => t.id === id('t1'))!)).toBe(rows.findIndex((t) => t.id === id('d1')) + 1)
    expect(tabOfItem(start, 1)?.id).toBe(id('p1'))
  })
})

describe('what it leaves alone', () => {
  it('does not archive the folder or its tabs with the Today tabs: they are pinned, only the Today tabs go', () => {
    const { s, a, id, names, toStart } = setup()
    const start = toStart(s, a)
    const cleared = run(start, { type: 'today/clear' })
    expect(cleared.folders.find((f) => f.id === a)).toMatchObject({ atTodayStart: true })
    expect(cleared.tabs.some((t) => t.id === id('a1'))).toBe(true)
    expect(names(cleared)).toEqual(['p1', 'b1', 'c1', 'a1', 'd1'])
  })

  it('opens a new tab where it always was: after the Today tabs, and the folder stays at the start of Today', () => {
    const { s, a, names, toStart } = setup()
    const opened = run(toStart(s, a), { type: 'tab/open', url: 'https://nouveau.example/', background: true })
    expect(names(opened)).toEqual(['p1', 'b1', 'c1', 'a1', 'd1', 't1', 't2', 't3', 'nouveau'])
    expect(opened.folders.find((f) => f.id === a)).toMatchObject({ atTodayStart: true })
  })

  it('moves a tab among the Today tabs as before: the folder is not one of the places', () => {
    const { s, a, id, names, toStart } = setup()
    const out = run(toStart(s, a), { type: 'tab/move', id: id('t3'), toIndex: 0, pinned: false })
    expect(names(out)).toEqual(['p1', 'b1', 'c1', 'a1', 'd1', 't3', 't1', 't2'])
  })

  it('puts a tab dropped into the folder at the start of Today in the folder, not in Today', () => {
    const { s, a, id, names, toStart } = setup()
    const out = run(toStart(s, a), { type: 'tab/move', id: id('t1'), toIndex: 99, pinned: true, folderId: a })
    expect(out.tabs.find((t) => t.id === id('t1'))).toMatchObject({ pinned: true, folderId: a })
    expect(names(out)).toEqual(['p1', 'b1', 'c1', 'a1', 't1', 'd1', 't2', 't3'])
  })
})
