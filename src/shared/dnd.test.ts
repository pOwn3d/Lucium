import { describe, expect, it } from 'vitest'
import type { Folder, SidebarState } from './model'
import { folderRows } from './folders'
import { NO_DROP, canDrop, draggedIds, locateFavorite, locateFolderRow, locateRow, movesAcrossProfiles, parseDropTarget, placeFromWindow, planDrop, type DragSource, type DropPlan, type DropTarget, type FavoriteBox, type RowBox } from './dnd'
import { createInitialState, reduce, sidebarOrder, type Action, type Ctx } from './sidebar'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}
const ctx = makeCtx()
const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)
const apply = (state: SidebarState, plan: DropPlan) => run(state, ...plan.actions)

/**
 * Pinned, in Docs: n1, n2 · pinned at the root: p1, p2 · Today: a, b, c, d · a second space "Autre" · favourites: x, y.
 * Tabs are named by their host so the expected orders read easily.
 */
function setup() {
  let s = createInitialState(ctx)
  const home = s.activeSpaceId
  s = run(s, { type: 'folder/create', name: 'Docs' }, { type: 'folder/create', name: 'Vide' })
  const docs = s.folders[0]!.id
  const empty = s.folders[1]!.id
  for (const n of ['n1', 'n2', 'p1', 'p2', 'a', 'b', 'c', 'd']) s = run(s, { type: 'tab/open', url: `https://${n}.fr/`, background: true })
  const id = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  s = run(s, { type: 'tab/move', id: id('n1'), toIndex: 99, pinned: true, folderId: docs }, { type: 'tab/move', id: id('n2'), toIndex: 99, pinned: true, folderId: docs })
  s = run(s, { type: 'tab/move', id: id('p1'), toIndex: 99, pinned: true }, { type: 'tab/move', id: id('p2'), toIndex: 99, pinned: true })
  s = run(s, { type: 'favorite/add', url: 'https://x.fr/', title: 'X' }, { type: 'favorite/add', url: 'https://y.fr/', title: 'Y' })
  s = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'space/select', id: home })
  const other = s.spaces[1]!.id
  const fav = (n: string) => s.favorites.find((f) => f.title === n.toUpperCase())!.id
  /** Tab names in the order the sidebar shows them. */
  const order = (state: SidebarState) => sidebarOrder(state, home).map((t) => t.url.split('/')[2]!.replace('.fr', ''))
  return { s, home, other, docs, empty, id, fav, order }
}

const tabs = (...ids: string[]): DragSource => ({ kind: 'tabs', ids })

describe('dropping a tab between two rows', () => {
  it('moves it before or after the row under the mark, inside Today', () => {
    const { s, id, order } = setup()
    // The sidebar lists the loose pinned tabs, then the folders' tabs, then Today.
    expect(order(apply(s, planDrop(s, tabs(id('d')), { kind: 'tab', id: id('a'), edge: 'before' })))).toEqual(['p1', 'p2', 'n1', 'n2', 'd', 'a', 'b', 'c'])
    expect(order(apply(s, planDrop(s, tabs(id('d')), { kind: 'tab', id: id('a'), edge: 'after' })))).toEqual(['p1', 'p2', 'n1', 'n2', 'a', 'd', 'b', 'c'])
  })

  it('counts the position without the dragged tab, so dragging down lands where the mark was', () => {
    const { s, id, order } = setup()
    // a dragged under c: it goes between c and d, not after d.
    expect(order(apply(s, planDrop(s, tabs(id('a')), { kind: 'tab', id: id('c'), edge: 'after' }))).slice(-4)).toEqual(['b', 'c', 'a', 'd'])
    // and before c: between b and c.
    expect(order(apply(s, planDrop(s, tabs(id('a')), { kind: 'tab', id: id('c'), edge: 'before' }))).slice(-4)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('pins a Today tab dropped between pinned rows, and unpins a pinned tab dropped between Today rows', () => {
    const { s, id } = setup()
    const pinned = apply(s, planDrop(s, tabs(id('c')), { kind: 'tab', id: id('p2'), edge: 'before' }))
    expect(pinned.tabs.find((t) => t.id === id('c'))).toMatchObject({ pinned: true, anchorUrl: 'https://c.fr/' })
    const unpinned = apply(s, planDrop(s, tabs(id('p1')), { kind: 'tab', id: id('b'), edge: 'before' }))
    expect(unpinned.tabs.find((t) => t.id === id('p1'))).toMatchObject({ pinned: false, anchorUrl: undefined, folderId: undefined })
  })

  it('a row inside a folder puts the tab in that folder, at that place', () => {
    const { s, id, docs } = setup()
    const out = apply(s, planDrop(s, tabs(id('a')), { kind: 'tab', id: id('n2'), edge: 'before' }))
    expect(out.tabs.filter((t) => t.folderId === docs).map((t) => t.url.split('/')[2])).toEqual(['n1.fr', 'a.fr', 'n2.fr'])
  })

  it('a loose pinned row takes a tab out of its folder', () => {
    const { s, id } = setup()
    const out = apply(s, planDrop(s, tabs(id('n1')), { kind: 'tab', id: id('p1'), edge: 'after' }))
    expect(out.tabs.find((t) => t.id === id('n1'))!.folderId).toBeUndefined()
  })

  it('does nothing next to the dragged tab itself, or to a tab that is gone', () => {
    const { s, id } = setup()
    expect(planDrop(s, tabs(id('a')), { kind: 'tab', id: id('a'), edge: 'after' })).toEqual(NO_DROP)
    expect(planDrop(s, tabs(id('a')), { kind: 'tab', id: 'nope', edge: 'after' })).toEqual(NO_DROP)
    expect(planDrop(s, tabs('nope'), { kind: 'tab', id: id('a'), edge: 'after' })).toEqual(NO_DROP)
  })

  it('does nothing for a row of another space', () => {
    const { s, id, other } = setup()
    const moved = run(s, { type: 'tab/open', url: 'https://z.fr/', spaceId: other, background: true })
    expect(planDrop(moved, tabs(id('a')), { kind: 'tab', id: moved.tabs.at(-1)!.id, edge: 'after' })).toEqual(NO_DROP)
  })
})

describe('dropping several tabs', () => {
  it('moves the selection as a block in the order of the sidebar, not the order it was picked in', () => {
    const { s, id, order } = setup()
    const out = apply(s, planDrop(s, tabs(id('d'), id('b')), { kind: 'tab', id: id('a'), edge: 'before' }))
    expect(order(out).slice(-4)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('a drop beside one of the dragged rows does nothing', () => {
    const { s, id } = setup()
    expect(planDrop(s, tabs(id('b'), id('c')), { kind: 'tab', id: id('c'), edge: 'before' })).toEqual(NO_DROP)
  })

  it('can put a mixed selection in a folder', () => {
    const { s, id, docs } = setup()
    const out = apply(s, planDrop(s, tabs(id('p1'), id('c')), { kind: 'folder', id: docs }))
    expect(out.tabs.filter((t) => t.folderId === docs).map((t) => t.url.split('/')[2])).toEqual(['n1.fr', 'n2.fr', 'p1.fr', 'c.fr'])
  })
})

describe('dropping on a folder', () => {
  it('adds the tab after the ones already in it and pins it', () => {
    const { s, id, docs } = setup()
    const out = apply(s, planDrop(s, tabs(id('a')), { kind: 'folder', id: docs }))
    expect(out.tabs.filter((t) => t.folderId === docs).map((t) => t.url.split('/')[2])).toEqual(['n1.fr', 'n2.fr', 'a.fr'])
    expect(out.tabs.find((t) => t.id === id('a'))!.pinned).toBe(true)
  })

  it('works on an empty folder', () => {
    const { s, id, empty } = setup()
    const out = apply(s, planDrop(s, tabs(id('a')), { kind: 'folder', id: empty }))
    expect(out.tabs.find((t) => t.id === id('a'))).toMatchObject({ pinned: true, folderId: empty })
  })

  it('the loose pinned list (no folder) takes the tab out of its folder, after the loose ones', () => {
    const { s, id, order } = setup()
    const out = apply(s, planDrop(s, tabs(id('n1')), { kind: 'folder', id: null }))
    expect(out.tabs.find((t) => t.id === id('n1'))!.folderId).toBeUndefined()
    expect(order(out).slice(0, 3)).toEqual(['p1', 'p2', 'n1'])
  })

  it('ignores a folder that does not exist or belongs to another space', () => {
    const { s, id, other } = setup()
    expect(planDrop(s, tabs(id('a')), { kind: 'folder', id: 'nope' })).toEqual(NO_DROP)
    const foreign = run(s, { type: 'folder/create', name: 'Ailleurs', spaceId: other })
    expect(planDrop(foreign, tabs(id('a')), { kind: 'folder', id: foreign.folders.at(-1)!.id })).toEqual(NO_DROP)
  })

  it('goes into a sub-folder like into any folder', () => {
    const { s, id, docs } = setup()
    const nested = run(s, { type: 'folder/create', name: 'Sous', parentId: docs })
    const sub = nested.folders.at(-1)!.id
    const out = apply(nested, planDrop(nested, tabs(id('a')), { kind: 'folder', id: sub }))
    expect(out.tabs.find((t) => t.id === id('a'))!.folderId).toBe(sub)
  })
})

describe('dropping in Today', () => {
  it('unpins a pinned tab and puts it after the last Today tab', () => {
    const { s, id, order } = setup()
    const out = apply(s, planDrop(s, tabs(id('p1')), { kind: 'today' }))
    expect(out.tabs.find((t) => t.id === id('p1'))).toMatchObject({ pinned: false, folderId: undefined })
    expect(order(out).slice(-5)).toEqual(['a', 'b', 'c', 'd', 'p1'])
  })

  it('moves a Today tab to the end', () => {
    const { s, id, order } = setup()
    expect(order(apply(s, planDrop(s, tabs(id('a')), { kind: 'today' }))).slice(-4)).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('dropping a tab on the favourites', () => {
  it('adds it as a favourite with its icon, where the mark is, and takes the tab out of the list', () => {
    const { s, id, fav } = setup()
    const withIcon = run(s, { type: 'tab/update', id: id('a'), patch: { faviconUrl: 'https://a.fr/i.png', title: 'Page A' } })
    const out = apply(withIcon, planDrop(withIcon, tabs(id('a')), { kind: 'favorite', id: fav('y'), edge: 'before' }))
    expect(out.favorites.map((f) => f.title)).toEqual(['X', 'Page A', 'Y'])
    expect(out.favorites[1]).toMatchObject({ url: 'https://a.fr/', faviconUrl: 'https://a.fr/i.png' })
    expect(out.tabs.some((t) => t.id === id('a'))).toBe(false)
  })

  it('takes a pinned tab out of the pinned list too (closing a pinned tab would only put it to sleep)', () => {
    const { s, id, order } = setup()
    const out = apply(s, planDrop(s, tabs(id('p1'), id('n1')), { kind: 'favorite', id: null, edge: 'after' }))
    expect(out.favorites.map((f) => f.url.split('/')[2])).toEqual(['x.fr', 'y.fr', 'p1.fr', 'n1.fr'])
    expect(order(out)).not.toContain('p1')
    expect(order(out)).not.toContain('n1')
    expect(order(out)).toContain('n2')
  })

  it('leaves alone the tabs that already are favourites, and drops only the others', () => {
    const { s, id } = setup()
    const dup = run(s, { type: 'tab/open', url: 'https://x.fr/', background: true })
    const twin = dup.tabs.at(-1)!.id
    const out = apply(dup, planDrop(dup, tabs(twin, id('a')), { kind: 'favorite', id: null, edge: 'after' }))
    expect(out.tabs.some((t) => t.id === twin)).toBe(true)
    expect(out.tabs.some((t) => t.id === id('a'))).toBe(false)
    expect(out.favorites.map((f) => f.url.split('/')[2])).toEqual(['x.fr', 'y.fr', 'a.fr'])
  })

  it('appends when the mark is after the last one or the row is empty', () => {
    const { s, id, fav } = setup()
    expect(apply(s, planDrop(s, tabs(id('a')), { kind: 'favorite', id: fav('y'), edge: 'after' })).favorites.map((f) => f.url)).toEqual(['https://x.fr/', 'https://y.fr/', 'https://a.fr/'])
    const none = run(s, { type: 'favorite/remove', id: fav('x') }, { type: 'favorite/remove', id: fav('y') })
    expect(apply(none, planDrop(none, tabs(id('a')), { kind: 'favorite', id: null, edge: 'after' })).favorites).toHaveLength(1)
  })

  it('adds several tabs in order, and skips the ones that already are favourites', () => {
    const { s, id, fav } = setup()
    const out = apply(s, planDrop(s, tabs(id('b'), id('a')), { kind: 'favorite', id: fav('x'), edge: 'after' }))
    expect(out.favorites.map((f) => f.url.split('/')[2])).toEqual(['x.fr', 'a.fr', 'b.fr', 'y.fr'])
    const dup = run(s, { type: 'tab/open', url: 'https://x.fr/', background: true })
    expect(planDrop(dup, tabs(dup.tabs.at(-1)!.id), { kind: 'favorite', id: null, edge: 'after' })).toEqual(NO_DROP)
  })
})

describe('dropping on a space of the footer', () => {
  it('asks for the tabs to move, without an action: crossing profiles is the main process\'s to confirm', () => {
    const { s, id, other } = setup()
    const plan = planDrop(s, tabs(id('a'), id('c')), { kind: 'space', id: other })
    expect(plan.actions).toEqual([])
    expect(plan.moveToSpace).toEqual({ ids: [id('a'), id('c')], spaceId: other })
    expect(canDrop(plan)).toBe(true)
  })

  it('does nothing on the space the tabs are already in, or on one that does not exist', () => {
    const { s, id, home } = setup()
    expect(planDrop(s, tabs(id('a')), { kind: 'space', id: home })).toEqual(NO_DROP)
    expect(planDrop(s, tabs(id('a')), { kind: 'space', id: 'nope' })).toEqual(NO_DROP)
  })
})

describe('dragging a favourite', () => {
  it('reorders it before or after another one', () => {
    const { s, fav } = setup()
    const withThird = run(s, { type: 'favorite/add', url: 'https://z.fr/', title: 'Z' })
    const z = withThird.favorites.find((f) => f.title === 'Z')!.id
    const first = apply(withThird, planDrop(withThird, { kind: 'favorite', id: z }, { kind: 'favorite', id: fav('x'), edge: 'before' }))
    expect(first.favorites.map((f) => f.title)).toEqual(['Z', 'X', 'Y'])
    const last = apply(withThird, planDrop(withThird, { kind: 'favorite', id: fav('x') }, { kind: 'favorite', id: z, edge: 'after' }))
    expect(last.favorites.map((f) => f.title)).toEqual(['Y', 'Z', 'X'])
    const tail = apply(withThird, planDrop(withThird, { kind: 'favorite', id: fav('x') }, { kind: 'favorite', id: null, edge: 'after' }))
    expect(tail.favorites.map((f) => f.title)).toEqual(['Y', 'Z', 'X'])
  })

  it('means nothing when it would not move, or onto anything but the favourites', () => {
    const { s, fav, id } = setup()
    expect(planDrop(s, { kind: 'favorite', id: fav('x') }, { kind: 'favorite', id: fav('y'), edge: 'before' })).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'favorite', id: fav('x') }, { kind: 'favorite', id: fav('x'), edge: 'after' })).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'favorite', id: fav('x') }, { kind: 'today' })).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'favorite', id: fav('x') }, { kind: 'tab', id: id('a'), edge: 'before' })).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'favorite', id: 'nope' }, { kind: 'favorite', id: null, edge: 'after' })).toEqual(NO_DROP)
  })
})

describe('what counts as a drop', () => {
  it('is nothing without actions or a space move', () => {
    expect(canDrop(NO_DROP)).toBe(false)
    expect(canDrop({ actions: [{ type: 'today/clear' }] })).toBe(true)
  })

  it('never produces an action for a target of the wrong kind', () => {
    const { s, id } = setup()
    const targets: DropTarget[] = [{ kind: 'tab', id: 'nope', edge: 'before' }, { kind: 'folder', id: 'nope' }, { kind: 'space', id: 'nope' }]
    for (const target of targets) expect(planDrop(s, tabs(id('a')), target).actions).toEqual([])
  })
})

describe('moving between profiles', () => {
  it('warns only when a tab would change profile', () => {
    const { s, id, home, other } = setup()
    // "Autre" was created with the default profile, like the first space.
    expect(movesAcrossProfiles(s, [id('a')], other)).toBe(false)
    const separate = run(s, { type: 'space/update', id: other, patch: { profileId: 'work' } })
    expect(movesAcrossProfiles(separate, [id('a')], other)).toBe(true)
    expect(movesAcrossProfiles(separate, [id('a'), id('b')], other)).toBe(true)
    expect(movesAcrossProfiles(separate, [id('a')], home)).toBe(false)
  })

  it('ignores unknown tabs and spaces', () => {
    const { s, id, other } = setup()
    const separate = run(s, { type: 'space/update', id: other, patch: { profileId: 'work' } })
    expect(movesAcrossProfiles(separate, ['nope'], other)).toBe(false)
    expect(movesAcrossProfiles(separate, [id('a')], 'nope')).toBe(false)
  })
})

describe('finding the row under the pointer', () => {
  // Rows are 36 px high, 41 px apart (as in the sidebar).
  const rows: RowBox[] = [
    { kind: 'folder', id: 'f1', top: 0, bottom: 36, parentId: null, first: true },
    { kind: 'tab', id: 't1', top: 41, bottom: 77 },
    { kind: 'folder', id: 'f2', top: 82, bottom: 118, parentId: null, first: false },
    { kind: 'today-start', id: 'new', top: 140, bottom: 176, beforeId: 'a' },
    { kind: 'tab', id: 'a', top: 181, bottom: 217 },
    { kind: 'tab', id: 'b', top: 222, bottom: 258 }
  ]

  it('marks the top half of a row as before it and the bottom half as after it', () => {
    expect(locateRow(rows, 45)).toEqual({ target: { kind: 'tab', id: 't1', edge: 'before' }, at: 'tab:t1', edge: 'before' })
    expect(locateRow(rows, 70)).toEqual({ target: { kind: 'tab', id: 't1', edge: 'after' }, at: 'tab:t1', edge: 'after' })
  })

  it('gives the gap between two rows to the nearer one, so there is no dead zone', () => {
    // 77..82 separates t1 and f2: 78 is nearer t1 (after it), 81 nearer f2.
    expect(locateRow(rows, 78)).toMatchObject({ at: 'tab:t1', edge: 'after' })
    expect(locateRow(rows, 81)).toMatchObject({ at: 'folder:f2' })
  })

  it('means "after the last row" below the list and "before the first" above it', () => {
    expect(locateRow(rows, 600)).toMatchObject({ target: { kind: 'tab', id: 'b', edge: 'after' } })
    expect(locateRow(rows, -20)).toMatchObject({ at: 'folder:f1' })
  })

  it('the top quarter of the first folder is next to it, the rest of any folder is inside it', () => {
    expect(locateRow(rows, 3)).toEqual({ target: { kind: 'folder', id: null }, at: 'folder:f1', edge: 'before' })
    expect(locateRow(rows, 20)).toEqual({ target: { kind: 'folder', id: 'f1' }, at: 'folder:f1', edge: 'inside' })
    // A folder that is not the first of its parent has no "next to it": it would not be where the mark is drawn.
    expect(locateRow(rows, 84)).toEqual({ target: { kind: 'folder', id: 'f2' }, at: 'folder:f2', edge: 'inside' })
  })

  it('next to a sub-folder means in its parent', () => {
    const nested: RowBox[] = [{ kind: 'folder', id: 'child', top: 0, bottom: 36, parentId: 'parent', first: true }]
    expect(locateRow(nested, 2)).toMatchObject({ target: { kind: 'folder', id: 'parent' }, edge: 'before' })
  })

  it('the top quarter of the first folder under the Today tabs is the end of Today, not of the loose pinned tabs', () => {
    const under: RowBox[] = [{ kind: 'folder', id: 'low', top: 0, bottom: 36, parentId: null, first: true, side: 'bottom' }]
    expect(locateRow(under, 3)).toEqual({ target: { kind: 'today' }, at: 'folder:low', edge: 'before' })
    // The rest of it is still "in the folder", and a second folder under the tabs has no "next to it" either.
    expect(locateRow(under, 20)).toEqual({ target: { kind: 'folder', id: 'low' }, at: 'folder:low', edge: 'inside' })
    expect(locateRow([{ ...under[0]!, first: false }], 3)).toEqual({ target: { kind: 'folder', id: 'low' }, at: 'folder:low', edge: 'inside' })
  })

  it('the top quarter of the first folder at the start of Today is in the folder: above it is the "New tab" row, not the loose pinned tabs', () => {
    const start: RowBox[] = [{ kind: 'folder', id: 'high', top: 0, bottom: 36, parentId: null, first: true, side: 'today-start' }]
    expect(locateRow(start, 3)).toEqual({ target: { kind: 'folder', id: 'high' }, at: 'folder:high', edge: 'inside' })
    expect(locateRow(start, 20)).toEqual({ target: { kind: 'folder', id: 'high' }, at: 'folder:high', edge: 'inside' })
    // A folder above the Today header keeps its "next to it" top: the end of the loose pinned tabs.
    expect(locateRow([{ ...start[0]!, side: undefined }], 3)).toEqual({ target: { kind: 'folder', id: null }, at: 'folder:high', edge: 'before' })
  })

  it('the row of "new tab" means before the first Today row, or Today itself when it is empty', () => {
    expect(locateRow(rows, 150)).toEqual({ target: { kind: 'tab', id: 'a', edge: 'before' }, at: 'tab:a', edge: 'before' })
    expect(locateRow([{ kind: 'today-start', id: 'new', top: 0, bottom: 36 }], 10)).toEqual({ target: { kind: 'today' }, at: 'today-start', edge: 'inside' })
  })

  it('the empty pinned zone means the loose pinned list', () => {
    expect(locateRow([{ kind: 'pin-zone', id: 'pin', top: 0, bottom: 36 }], 10)).toEqual({ target: { kind: 'folder', id: null }, at: 'pin-zone', edge: 'inside' })
  })

  it('finds nothing without rows', () => {
    expect(locateRow([], 10)).toBeNull()
  })
})

describe('finding the favourite under the pointer', () => {
  // A grid of tiles 70 x 47, nine pixels apart, four to a row.
  const tile = (id: string, col: number, row: number): FavoriteBox => ({ id, left: col * 79, right: col * 79 + 70, top: row * 55, bottom: row * 55 + 47 })
  const boxes = [tile('a', 0, 0), tile('b', 1, 0), tile('c', 2, 0), tile('d', 3, 0), tile('e', 0, 1)]

  it('marks the left half of a tile as before it, the right half as after it', () => {
    expect(locateFavorite(boxes, 90, 20)).toEqual({ target: { kind: 'favorite', id: 'b', edge: 'before' }, at: 'favorite:b', edge: 'before' })
    expect(locateFavorite(boxes, 140, 20)).toMatchObject({ target: { kind: 'favorite', id: 'b', edge: 'after' } })
  })

  it('takes the nearest tile when the pointer is in a gap or beside the last row', () => {
    expect(locateFavorite(boxes, 74, 20)).toMatchObject({ target: { id: 'a', edge: 'after' } })
    expect(locateFavorite(boxes, 300, 75)).toMatchObject({ target: { id: 'e', edge: 'after' } })
  })

  it('prefers the tile row the pointer is in over a nearer tile of another row', () => {
    expect(locateFavorite(boxes, 30, 60)).toMatchObject({ target: { id: 'e' } })
  })

  it('means "at the end" without any favourite', () => {
    expect(locateFavorite([], 10, 10)).toEqual({ target: { kind: 'favorite', id: null, edge: 'after' }, at: 'favorites', edge: 'inside' })
  })
})

describe('dragging a folder', () => {
  /** Root folders A, B, C; A holds A1. */
  const folderSetup = () => {
    let s = createInitialState(ctx)
    s = run(s, { type: 'folder/create', name: 'A' }, { type: 'folder/create', name: 'B' }, { type: 'folder/create', name: 'C' })
    const [a, b, c] = s.folders as [Folder, Folder, Folder]
    s = run(s, { type: 'folder/create', name: 'A1', parentId: a.id })
    const a1 = s.folders.find((f) => f.name === 'A1')!
    const shape = (state: SidebarState, parentId?: string): string =>
      state.folders
        .filter((f) => f.parentId === parentId)
        .map((f) => (state.folders.some((x) => x.parentId === f.id) ? `${f.name}(${shape(state, f.id)})` : f.name))
        .join(parentId ? ',' : ' ')
    return { s, a, b, c, a1, shape }
  }
  const folder = (id: string): DragSource => ({ kind: 'folder', id })

  it('goes before or after another folder, next to it, or inside it as its last folder', () => {
    const { s, a, b, c, shape } = folderSetup()
    expect(shape(apply(s, planDrop(s, folder(c.id), { kind: 'folder-at', id: a.id, edge: 'before' })))).toBe('C A(A1) B')
    expect(shape(apply(s, planDrop(s, folder(a.id), { kind: 'folder-at', id: b.id, edge: 'after' })))).toBe('B A(A1) C')
    expect(shape(apply(s, planDrop(s, folder(c.id), { kind: 'folder-at', id: b.id, edge: 'inside' })))).toBe('A(A1) B(C)')
    expect(shape(apply(s, planDrop(s, folder(b.id), { kind: 'folder-at', id: a.id, edge: 'inside' })))).toBe('A(A1,B) C')
  })

  it('next to a sub-folder means in its parent', () => {
    const { s, a, c, a1, shape } = folderSetup()
    expect(shape(apply(s, planDrop(s, folder(c.id), { kind: 'folder-at', id: a1.id, edge: 'before' })))).toBe('A(C,A1) B')
    expect(planDrop(s, folder(c.id), { kind: 'folder-at', id: a1.id, edge: 'after' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: a.id, toIndex: 1 }])
  })

  it('has no drop where the folder already is, on itself, below itself or in another space', () => {
    const { s, a, b, c, a1 } = folderSetup()
    expect(planDrop(s, folder(b.id), { kind: 'folder-at', id: a.id, edge: 'after' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(b.id), { kind: 'folder-at', id: c.id, edge: 'before' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a1.id), { kind: 'folder-at', id: a.id, edge: 'inside' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a.id), { kind: 'folder-at', id: a.id, edge: 'before' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a.id), { kind: 'folder-at', id: a1.id, edge: 'inside' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a.id), { kind: 'folder-at', id: a1.id, edge: 'before' })).toEqual(NO_DROP)
    const away = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'folder/create', name: 'Ailleurs' }, { type: 'folder/create', name: 'Ailleurs 2' })
    expect(planDrop(away, folder(a.id), { kind: 'folder-at', id: away.folders.find((f) => f.name === 'Ailleurs')!.id, edge: 'inside' })).toEqual(NO_DROP)
    expect(planDrop(away, folder(a.id), { kind: 'folder-at', id: away.folders.find((f) => f.name === 'Ailleurs 2')!.id, edge: 'before' })).toEqual(NO_DROP)
    expect(planDrop(s, folder('nope'), { kind: 'folder-at', id: a.id, edge: 'before' })).toEqual(NO_DROP)
  })

  describe('under the Today tabs', () => {
    const sides = (state: SidebarState): string => state.folders.filter((f) => !f.parentId).map((f) => `${f.name}${f.atBottom ? '↓' : ''}`).join(' ')

    it('goes under the tabs, after the folders already there, when dropped on the zone under them', () => {
      const { s, a, b, c } = folderSetup()
      const plan = planDrop(s, folder(a.id), { kind: 'folder-bottom' })
      expect(plan.actions).toEqual([{ type: 'folder/move', id: a.id, parentId: null, toIndex: Number.MAX_SAFE_INTEGER, side: 'bottom' }])
      expect(sides(apply(s, plan))).toBe('B C A↓')
      const two = apply(apply(s, plan), planDrop(apply(s, plan), folder(b.id), { kind: 'folder-bottom' }))
      expect(sides(two)).toBe('C A↓ B↓')
      expect(c.id).toBeTruthy()
    })

    it('takes a folder out of another one to put it under the tabs, root and side at once', () => {
      const { s, a1, shape } = folderSetup()
      const out = apply(s, planDrop(s, folder(a1.id), { kind: 'folder-bottom' }))
      expect(out.folders.find((f) => f.id === a1.id)).toMatchObject({ atBottom: true })
      expect(out.folders.find((f) => f.id === a1.id)).not.toHaveProperty('parentId')
      expect(shape(out)).toBe('A B C A1')
    })

    it('has no drop on the zone for a folder that already is a root folder under the tabs, or one that does not exist', () => {
      const { s, a } = folderSetup()
      const down = run(s, { type: 'folder/bottom', id: a.id, bottom: true })
      expect(planDrop(down, folder(a.id), { kind: 'folder-bottom' })).toEqual(NO_DROP)
      expect(planDrop(s, folder('nope'), { kind: 'folder-bottom' })).toEqual(NO_DROP)
    })

    it('takes the side of the root folder it is dropped next to, and says nothing of the side when it does not change', () => {
      const { s, a, b, c } = folderSetup()
      const down = run(s, { type: 'folder/bottom', id: c.id, bottom: true })
      // B dropped before C (under the tabs) goes under the tabs, in front of C.
      const plan = planDrop(down, folder(b.id), { kind: 'folder-at', id: c.id, edge: 'before' })
      expect(plan.actions).toEqual([{ type: 'folder/move', id: b.id, parentId: null, toIndex: 1, side: 'bottom' }])
      expect(sides(apply(down, plan))).toBe('A B↓ C↓')
      // C dropped after A (above the tabs) goes back above them.
      expect(planDrop(down, folder(c.id), { kind: 'folder-at', id: a.id, edge: 'after' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: null, toIndex: 1, side: 'top' }])
      // The same side: the action is the one it always was, with no word of a side.
      expect(planDrop(s, folder(c.id), { kind: 'folder-at', id: a.id, edge: 'before' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: null, toIndex: 0 }])
    })

    it('is a drop where the place is the same but the side is not, and none where both are', () => {
      const { s, a, b, c } = folderSetup()
      const down = run(s, { type: 'folder/bottom', id: c.id, bottom: true })
      // B stands second of three, and "before C" is the second place too: only the side changes, and that is a drop.
      const plan = planDrop(down, folder(b.id), { kind: 'folder-at', id: c.id, edge: 'before' })
      expect(canDrop(plan)).toBe(true)
      expect(sides(apply(down, plan))).toBe('A B↓ C↓')
      // "After A" is the same place and the same side: no drop, no mark.
      expect(planDrop(down, folder(b.id), { kind: 'folder-at', id: a.id, edge: 'after' })).toEqual(NO_DROP)
    })

    it('puts a folder inside another without a side, and a folder next to a sub-folder in its parent without one', () => {
      const { s, a, b, c, a1 } = folderSetup()
      const down = run(s, { type: 'folder/bottom', id: c.id, bottom: true })
      const inside = planDrop(down, folder(c.id), { kind: 'folder-at', id: b.id, edge: 'inside' })
      expect(inside.actions).toEqual([{ type: 'folder/move', id: c.id, parentId: b.id, toIndex: 0 }])
      expect(apply(down, inside).folders.find((f) => f.id === c.id)).not.toHaveProperty('atBottom')
      expect(planDrop(down, folder(c.id), { kind: 'folder-at', id: a1.id, edge: 'before' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: a.id, toIndex: 0 }])
    })

    it('is a target tabs and favourites have no use for', () => {
      const { s, id } = setup()
      expect(planDrop(s, tabs(id('a')), { kind: 'folder-bottom' })).toEqual(NO_DROP)
      expect(planDrop(s, { kind: 'favorite', id: s.favorites[0]!.id }, { kind: 'folder-bottom' })).toEqual(NO_DROP)
    })

    it('puts a tab dropped at the end of Today above the folders under the tabs, not into them', () => {
      const { s, docs, id, order } = setup()
      const down = run(s, { type: 'folder/bottom', id: docs, bottom: true })
      expect(order(down)).toEqual(['p1', 'p2', 'a', 'b', 'c', 'd', 'n1', 'n2'])
      // The end of Today is a place of its own: a pinned tab dropped there is unpinned and lands after "d", above the folder under the tabs.
      const plan = planDrop(down, tabs(id('p1')), { kind: 'today' })
      expect(order(apply(down, plan))).toEqual(['p2', 'a', 'b', 'c', 'd', 'p1', 'n1', 'n2'])
    })
  })

  describe('at the start of Today', () => {
    // The folder the maintainer could not take up: alone under the Today tabs, with nothing above them to be dropped next to, and no target of a drag led to the
    // start of Today (a dragged folder only looks at folder rows).
    const marks = (state: SidebarState): string => state.folders.filter((f) => !f.parentId).map((f) => `${f.name}${f.atBottom ? '↓' : f.atTodayStart ? '⇡' : ''}`).join(' ')

    it('takes a folder from under the Today tabs to their start: its tabs come before the Today tabs, and the drop is one', () => {
      const { s, docs, order } = setup()
      const down = run(s, { type: 'folder/bottom', id: docs, bottom: true })
      expect(order(down)).toEqual(['p1', 'p2', 'a', 'b', 'c', 'd', 'n1', 'n2'])
      const plan = planDrop(down, folder(docs), { kind: 'folder-today-start' })
      expect(canDrop(plan)).toBe(true)
      expect(plan.actions).toEqual([{ type: 'folder/move', id: docs, parentId: null, toIndex: 1, side: 'today-start' }])
      const out = apply(down, plan)
      expect(out.folders.find((f) => f.id === docs)).toMatchObject({ atTodayStart: true })
      expect(out.folders.find((f) => f.id === docs)).not.toHaveProperty('atBottom')
      expect(order(out)).toEqual(['p1', 'p2', 'n1', 'n2', 'a', 'b', 'c', 'd'])
    })

    it('takes a folder from above the Today header too', () => {
      const { s, docs, order } = setup()
      const out = apply(s, planDrop(s, folder(docs), { kind: 'folder-today-start' }))
      expect(out.folders.find((f) => f.id === docs)).toMatchObject({ atTodayStart: true })
      expect(order(out)).toEqual(['p1', 'p2', 'n1', 'n2', 'a', 'b', 'c', 'd'])
    })

    const toStart = (state: SidebarState, id: string): SidebarState => apply(state, planDrop(state, folder(id), { kind: 'folder-today-start' }))
    const startOf = (state: SidebarState): string[] => folderRows(state.folders, state.activeSpaceId, 'today-start').map((r) => r.folder.name)

    it('goes first among the folders already at the start of Today', () => {
      const { s, b, c } = folderSetup()
      const two = toStart(toStart(s, b.id), c.id)
      expect(startOf(two)).toEqual(['C', 'B'])
      expect(marks(two)).toBe('A C⇡ B⇡')
    })

    it('goes first even from behind them: the folder that is second there comes up in front of the first', () => {
      const { s, b, c } = folderSetup()
      const two = toStart(toStart(s, b.id), c.id)
      expect(startOf(two)).toEqual(['C', 'B'])
      expect(startOf(toStart(two, b.id))).toEqual(['B', 'C'])
    })

    it('has no drop for the folder that already is the first one there, or one that does not exist', () => {
      const { s, a, b } = folderSetup()
      const one = toStart(s, b.id)
      expect(planDrop(one, folder(b.id), { kind: 'folder-today-start' })).toEqual(NO_DROP)
      expect(planDrop(s, folder('nope'), { kind: 'folder-today-start' })).toEqual(NO_DROP)
      expect(canDrop(planDrop(one, folder(a.id), { kind: 'folder-today-start' }))).toBe(true)
    })

    it('takes a folder out of another one to put it there, root and side at once', () => {
      const { s, a1, shape } = folderSetup()
      const out = apply(s, planDrop(s, folder(a1.id), { kind: 'folder-today-start' }))
      expect(out.folders.find((f) => f.id === a1.id)).toMatchObject({ atTodayStart: true })
      expect(out.folders.find((f) => f.id === a1.id)).not.toHaveProperty('parentId')
      expect(shape(out)).toBe('A B C A1')
    })

    it('takes the side of the root folder it is dropped next to, from any of the three places', () => {
      const { s, a, b, c } = folderSetup()
      const start = toStart(s, c.id)
      // B dropped before C (at the start of Today) goes there, in front of C; A dropped after C goes there too, behind it.
      const before = planDrop(start, folder(b.id), { kind: 'folder-at', id: c.id, edge: 'before' })
      expect(before.actions).toEqual([{ type: 'folder/move', id: b.id, parentId: null, toIndex: 1, side: 'today-start' }])
      expect(marks(apply(start, before))).toBe('A B⇡ C⇡')
      expect(planDrop(start, folder(a.id), { kind: 'folder-at', id: c.id, edge: 'after' }).actions).toEqual([{ type: 'folder/move', id: a.id, parentId: null, toIndex: 2, side: 'today-start' }])
      // C dropped after A (above the header) goes back above it; dropped next to a folder under the tabs, it goes there.
      expect(planDrop(start, folder(c.id), { kind: 'folder-at', id: a.id, edge: 'after' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: null, toIndex: 1, side: 'top' }])
      const down = run(s, { type: 'folder/bottom', id: b.id, bottom: true })
      expect(planDrop(down, folder(c.id), { kind: 'folder-at', id: b.id, edge: 'before' }).actions).toEqual([{ type: 'folder/move', id: c.id, parentId: null, toIndex: 1, side: 'bottom' }])
    })

    it('goes to the zone under the tabs from the start of Today', () => {
      const { s, a } = folderSetup()
      const start = toStart(s, a.id)
      const out = apply(start, planDrop(start, folder(a.id), { kind: 'folder-bottom' }))
      expect(out.folders.find((f) => f.id === a.id)).toMatchObject({ atBottom: true })
      expect(out.folders.find((f) => f.id === a.id)).not.toHaveProperty('atTodayStart')
    })

    it('is a target tabs and favourites have no use for', () => {
      const { s, id } = setup()
      expect(planDrop(s, tabs(id('a')), { kind: 'folder-today-start' })).toEqual(NO_DROP)
      expect(planDrop(s, { kind: 'favorite', id: s.favorites[0]!.id }, { kind: 'folder-today-start' })).toEqual(NO_DROP)
    })

    it('leaves the places of the Today tabs as they were: a tab dropped before the first of them lands after the folder at the start of Today', () => {
      const { s, docs, id, order } = setup()
      const start = toStart(s, docs)
      expect(order(start)).toEqual(['p1', 'p2', 'n1', 'n2', 'a', 'b', 'c', 'd'])
      const plan = planDrop(start, tabs(id('d')), { kind: 'tab', id: id('a'), edge: 'before' })
      expect(order(apply(start, plan))).toEqual(['p1', 'p2', 'n1', 'n2', 'd', 'a', 'b', 'c'])
    })
  })

  it('goes nowhere but to a folder row: tabs and favourites have no use for that target, and a folder none for theirs', () => {
    const { s, a } = folderSetup()
    expect(planDrop(s, folder(a.id), { kind: 'today' })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a.id), { kind: 'folder', id: null })).toEqual(NO_DROP)
    expect(planDrop(s, folder(a.id), { kind: 'space', id: s.activeSpaceId })).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'tabs', ids: ['x'] }, { kind: 'folder-at', id: a.id, edge: 'inside' })).toEqual(NO_DROP)
  })
})

describe('finding the folder row under a dragged folder', () => {
  const rows: RowBox[] = [
    { kind: 'folder', id: 'f1', top: 0, bottom: 36, parentId: null, first: true, collapsed: true },
    { kind: 'tab', id: 't1', top: 41, bottom: 77 },
    { kind: 'folder', id: 'f2', top: 82, bottom: 118, parentId: null, first: false, collapsed: false }
  ]

  it('is before in the upper third, inside in the middle, after in the lower third of a closed folder', () => {
    expect(locateFolderRow(rows, 3)).toEqual({ target: { kind: 'folder-at', id: 'f1', edge: 'before' }, at: 'folder:f1', edge: 'before' })
    expect(locateFolderRow(rows, 18)).toMatchObject({ target: { kind: 'folder-at', id: 'f1', edge: 'inside' } })
    expect(locateFolderRow(rows, 34)).toMatchObject({ target: { kind: 'folder-at', id: 'f1', edge: 'after' }, edge: 'after' })
  })

  it('goes inside an open folder from its lower part, since what follows it is its own content', () => {
    expect(locateFolderRow(rows, 116)).toMatchObject({ target: { kind: 'folder-at', id: 'f2', edge: 'inside' } })
  })

  it('finds the zone under everything when it is the nearest row, and a folder when that is nearer', () => {
    const withZone: RowBox[] = [...rows, { kind: 'folder-bottom', id: 'folder-bottom', top: 123, bottom: 159 }]
    expect(locateFolderRow(withZone, 140)).toEqual({ target: { kind: 'folder-bottom' }, at: 'folder-bottom', edge: 'inside' })
    expect(locateFolderRow(withZone, 119)).toMatchObject({ at: 'folder:f2' })
    expect(locateFolderRow(withZone, 500)).toMatchObject({ target: { kind: 'folder-bottom' } })
    // A tab being dragged never sees it: a dragged tab looks at every row but this one.
    expect(locateRow([{ kind: 'folder-bottom', id: 'folder-bottom', top: 0, bottom: 36 }], 10)).toBeNull()
  })

  it('finds the "New tab" row of Today when it is the nearest, so that a folder can be taken to the start of Today even when it is the only one', () => {
    // The row of "New tab", two Today tabs, and the one folder, under them: the folder that is dragged is the last row.
    const alone: RowBox[] = [
      { kind: 'today-start', id: 'today', top: 0, bottom: 36, beforeId: 'a' },
      { kind: 'tab', id: 'a', top: 41, bottom: 77 },
      { kind: 'tab', id: 'b', top: 82, bottom: 118 },
      { kind: 'folder', id: 'low', top: 123, bottom: 159, parentId: null, first: true, collapsed: false, side: 'bottom' }
    ]
    expect(locateFolderRow(alone, 20)).toEqual({ target: { kind: 'folder-today-start' }, at: 'today-start', edge: 'after' })
    // Above the list it is still the nearest row; over the tabs it is the nearer of the row and the folder; on the folder, the folder.
    expect(locateFolderRow(alone, -30)).toMatchObject({ target: { kind: 'folder-today-start' } })
    expect(locateFolderRow(alone, 50)).toMatchObject({ target: { kind: 'folder-today-start' } })
    expect(locateFolderRow(alone, 110)).toMatchObject({ target: { kind: 'folder-at', id: 'low' } })
    expect(locateFolderRow(alone, 140)).toMatchObject({ target: { kind: 'folder-at', id: 'low' } })
    // Nothing to land on without any of these rows.
    expect(locateFolderRow(alone.filter((row) => row.kind === 'tab'), 20)).toBeNull()
  })

  it('ignores the rows that are not folders, and the gaps belong to the nearer folder', () => {
    expect(locateFolderRow(rows, 50)).toMatchObject({ at: 'folder:f1' })
    expect(locateFolderRow(rows, 75)).toMatchObject({ at: 'folder:f2' })
    expect(locateFolderRow([{ kind: 'tab', id: 't', top: 0, bottom: 36 }], 10)).toBeNull()
  })
})

describe('dropping tabs another window is dragging', () => {
  /** The window of the space "Autre" is dropped on; the dragged tabs are not in its view (they sit in the other window's space, or belong to it alone). */
  const foreign = (spaceId: string, ...tabs: Array<{ id: string; private?: true }>): DragSource => ({ kind: 'window-tabs', tabs, spaceId })

  it('is a drop that means something on a row of the space shown, a folder or Today, and says so for the main process to carry out', () => {
    const { s, other, home, id } = setup()
    const planted = run(s, { type: 'tab/open', url: 'https://z.fr/', spaceId: other, background: true })
    const z = planted.tabs.at(-1)!.id
    const gone = foreign(other, { id: id('a') })
    const plan = planDrop(planted, gone, { kind: 'tab', id: z, edge: 'before' })
    expect(plan).toEqual({ actions: [], fromWindow: { kind: 'tab', id: z, edge: 'before' } })
    expect(canDrop(plan)).toBe(true)
    expect(planDrop(planted, gone, { kind: 'today' }).fromWindow).toEqual({ kind: 'today' })
    expect(planDrop(planted, foreign(home, { id: 'x' }), { kind: 'folder', id: planted.folders[0]!.id }).fromWindow).toEqual({ kind: 'folder', id: planted.folders[0]!.id })
  })

  it('shows no mark on the favourites, the footer, a folder being dragged, or a row of another space', () => {
    const { s, other, home, id } = setup()
    const gone = foreign(other, { id: id('a') })
    for (const target of [{ kind: 'favorite', id: null, edge: 'after' }, { kind: 'space', id: home }, { kind: 'folder-at', id: s.folders[0]!.id, edge: 'inside' }, { kind: 'tab', id: id('b'), edge: 'before' }, { kind: 'tab', id: 'nope', edge: 'before' }] satisfies DropTarget[]) {
      expect(planDrop(s, gone, target), target.kind).toEqual(NO_DROP)
    }
  })

  it('counts the places without the dragged tabs, even those that are in this window\'s own list', () => {
    const { s, home, id, order } = setup()
    // The dragged tab is Today's "d" already (the other window shows the same space): dropping it before "a" is a place, dropping it beside itself is none.
    const dragged = foreign(home, { id: id('d') })
    expect(placeFromWindow(s, dragged.kind === 'window-tabs' ? dragged.tabs : [], home, { kind: 'tab', id: id('a'), edge: 'before' })).toMatchObject({ toIndex: 0, pinned: false })
    expect(planDrop(s, dragged, { kind: 'tab', id: id('d'), edge: 'after' })).toEqual(NO_DROP)
    expect(order(s)).toContain('d')
  })

  it('refuses a private tab on the pinned list or in a folder, and a space that does not exist', () => {
    const { s, home, id, docs } = setup()
    const secret = foreign(home, { id: 'secret', private: true })
    expect(planDrop(s, secret, { kind: 'folder', id: docs })).toEqual(NO_DROP)
    expect(planDrop(s, secret, { kind: 'tab', id: id('p1'), edge: 'after' })).toEqual(NO_DROP)
    // One private tab among others is enough: the selection is refused as a whole there.
    expect(planDrop(s, foreign(home, { id: 'x' }, { id: 'secret', private: true }), { kind: 'folder', id: docs })).toEqual(NO_DROP)
    expect(planDrop(s, foreign(home, { id: 'x' }, { id: 'y' }), { kind: 'folder', id: docs }).fromWindow).toEqual({ kind: 'folder', id: docs })
    expect(planDrop(s, secret, { kind: 'today' }).fromWindow).toEqual({ kind: 'today' })
    expect(planDrop(s, foreign('nope', { id: 'x' }), { kind: 'today' })).toEqual(NO_DROP)
    expect(planDrop(s, foreign(home), { kind: 'today' })).toEqual(NO_DROP)
  })
})

describe('reading a drop target from the interface', () => {
  it('accepts the places a tab from another window can take, and nothing else', () => {
    expect(parseDropTarget({ kind: 'today' })).toEqual({ kind: 'today' })
    expect(parseDropTarget({ kind: 'tab', id: 't1', edge: 'after' })).toEqual({ kind: 'tab', id: 't1', edge: 'after' })
    expect(parseDropTarget({ kind: 'tab', id: 't1', edge: 'inside' })).toEqual({ kind: 'tab', id: 't1', edge: 'inside' })
    expect(parseDropTarget({ kind: 'folder', id: null })).toEqual({ kind: 'folder', id: null })
    expect(parseDropTarget({ kind: 'folder', id: 'f1', extra: 1 })).toEqual({ kind: 'folder', id: 'f1' })
  })

  it('refuses what is malformed, too long, or a target of another kind', () => {
    for (const bad of [null, undefined, 'today', 5, [], {}, { kind: 'tab', id: 't1' }, { kind: 'tab', id: 't1', edge: 'left' }, { kind: 'tab', id: '', edge: 'after' }, { kind: 'tab', id: 'x'.repeat(257), edge: 'after' }, { kind: 'folder' }, { kind: 'folder', id: 3 }, { kind: 'favorite', id: null, edge: 'after' }, { kind: 'space', id: 's' }, { kind: 'folder-at', id: 'f', edge: 'inside' }]) {
      expect(parseDropTarget(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

// The rows of split views once could not be dragged at all (neither into a folder nor to another place of the list).
describe('dragging the row of a split view', () => {
  it('takes both tabs of the view, in its order, whatever the selection', () => {
    expect(draggedIds('b', [], ['a', 'b'])).toEqual(['a', 'b'])
    expect(draggedIds('b', ['c', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('takes the selection for a row that is in it, and the row alone otherwise', () => {
    expect(draggedIds('b', ['b', 'c'])).toEqual(['b', 'c'])
    expect(draggedIds('b', [])).toEqual(['b'])
  })

  it('ignores a view that does not hold the row (a drag never takes tabs that are not under the pointer)', () => {
    expect(draggedIds('z', [], ['a', 'b'])).toEqual(['z'])
  })

  it('does not hand out the list of the view itself: a later change to it does not change the drag', () => {
    const view = ['a', 'b']
    const ids = draggedIds('a', [], view)
    view.push('c')
    expect(ids).toEqual(['a', 'b'])
  })

  it('puts the pair in a folder with the split view still there, both tabs together and in order', () => {
    const { s, id, docs } = setup()
    const split = run(s, { type: 'split/create', tabId: id('b'), withTabId: id('c') })
    const out = apply(split, planDrop(split, tabs(...draggedIds(id('b'), [], [id('b'), id('c')])), { kind: 'folder', id: docs }))
    expect(out.tabs.filter((t) => t.folderId === docs).map((t) => t.url.split('/')[2])).toEqual(['n1.fr', 'n2.fr', 'b.fr', 'c.fr'])
    expect(out.splits.some((v) => v.tabIds.includes(id('b')) && v.tabIds.includes(id('c')))).toBe(true)
  })

  it('moves the pair elsewhere in the list as a block, with the split view still there', () => {
    const { s, id, order } = setup()
    const split = run(s, { type: 'split/create', tabId: id('b'), withTabId: id('c') })
    const out = apply(split, planDrop(split, tabs(id('b'), id('c')), { kind: 'tab', id: id('a'), edge: 'before' }))
    expect(order(out).slice(-4)).toEqual(['b', 'c', 'a', 'd'])
    expect(out.splits).toHaveLength(1)
  })
})

// With a favourite open (its page is a tab no row shows), a tab dropped above another one used to land too low: a tab went down, never up.
describe('dropping above a row while the page of an open favourite is in the list of tabs', () => {
  it('lands where the mark was: the tab that no row shows is not counted among the places', () => {
    const { s, id, order } = setup()
    // The page of a favourite: a tab of the space, hidden, at the head of the tabs (as the engine puts it when a favourite is opened).
    const hidden = { ...s.tabs.find((t) => t.url === 'https://a.fr/')!, id: 'fav-page', url: 'https://x.fr/', favoriteId: s.favorites[0]!.id }
    const withPage = { ...s, tabs: [hidden, ...s.tabs] }
    expect(order(withPage)).not.toContain('x')
    const out = apply(withPage, planDrop(withPage, tabs(id('c')), { kind: 'tab', id: id('a'), edge: 'before' }))
    expect(order(out).slice(-4)).toEqual(['c', 'a', 'b', 'd'])
    const down = apply(withPage, planDrop(withPage, tabs(id('a')), { kind: 'tab', id: id('d'), edge: 'before' }))
    expect(order(down).slice(-4)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('does the same with the tab tree on (where the places are counted by the tree)', () => {
    const { s, id, order } = setup()
    const tree = { ...s, settings: { ...s.settings, tabTree: true } }
    const hidden = { ...tree.tabs.find((t) => t.url === 'https://a.fr/')!, id: 'fav-page-1', url: 'https://x.fr/', favoriteId: tree.favorites[0]!.id }
    const hidden2 = { ...hidden, id: 'fav-page-2', url: 'https://y.fr/' }
    const withPages = { ...tree, tabs: [hidden, hidden2, ...tree.tabs] }
    const up = apply(withPages, planDrop(withPages, tabs(id('d')), { kind: 'tab', id: id('a'), edge: 'before' }))
    expect(order(up).slice(-4)).toEqual(['d', 'a', 'b', 'c'])
    const down = apply(withPages, planDrop(withPages, tabs(id('a')), { kind: 'tab', id: id('d'), edge: 'before' }))
    expect(order(down).slice(-4)).toEqual(['b', 'c', 'a', 'd'])
  })
})
