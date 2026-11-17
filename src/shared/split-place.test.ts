// Where the tabs of a split view stand in the sidebar (split-place.ts). The case: a tab of Today split with a pinned tab of a folder (between two
// other tabs of that folder) was drawn as two rows, one in each list; the pair must be one row at the place of the pinned tab.

import { describe, expect, it } from 'vitest'
import type { Folder, SidebarState, SplitView, TabItem } from './model'
import { createInitialState, reduce, sidebarOrder, type Action, type Ctx } from './sidebar'
import { listOfTab, splitAnchor, splitJoin, splitRows, type DrawnList } from './split-place'

const SPACE = 's1'
const tab = (id: string, over: Partial<TabItem> = {}): TabItem => ({ id, spaceId: SPACE, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0, ...over })
const folder = (id: string, over: Partial<Folder> = {}): Folder => ({ id, spaceId: SPACE, name: id, collapsed: false, ...over })
const split = (id: string, tabIds: string[]): SplitView => ({ id, spaceId: SPACE, tabIds, orientation: 'horizontal', ratios: tabIds.map(() => 1 / tabIds.length) })

/** The sidebar of the report: OCT26, Docs, Notes, Slides in the folder G; a loose pinned tab P; Zoom and Meet in Today. */
function report(splits: SplitView[] = []): Pick<SidebarState, 'tabs' | 'folders' | 'splits'> {
  const inG = { pinned: true, folderId: 'G' }
  return {
    folders: [folder('G'), folder('H')],
    tabs: [tab('P', { pinned: true }), tab('oct26', inG), tab('docs', inG), tab('notes', inG), tab('slides', inG), tab('h1', { pinned: true, folderId: 'H' }), tab('zoom'), tab('meet')],
    splits
  }
}

describe('the list of a tab', () => {
  it('is Today, the loose pinned tabs, or its folder (a folder that is gone leaves it with the loose ones)', () => {
    const { folders } = report()
    expect(listOfTab(folders, tab('x'))).toBe('today')
    expect(listOfTab(folders, tab('x', { pinned: true }))).toBe('pinned')
    expect(listOfTab(folders, tab('x', { pinned: true, folderId: 'G' }))).toBe('folder:G')
    expect(listOfTab(folders, tab('x', { pinned: true, folderId: 'gone' }))).toBe('pinned')
    expect(listOfTab([folder('G', { spaceId: 'other' })], tab('x', { pinned: true, folderId: 'G' }))).toBe('pinned')
  })
})

describe('the anchor of a new split view', () => {
  it('is the tab in a folder, whichever of the two the split view is made with', () => {
    const state = report()
    expect(splitAnchor(state, 'zoom', 'notes')?.id).toBe('notes')
    expect(splitAnchor(state, 'notes', 'zoom')?.id).toBe('notes')
    // A loose pinned tab and a tab in a folder: the folder's.
    expect(splitAnchor(state, 'notes', 'P')?.id).toBe('notes')
  })

  it('is the pinned tab between a loose pinned tab and a Today tab: a split view never unpins a tab', () => {
    const state = report()
    expect(splitAnchor(state, 'zoom', 'P')?.id).toBe('P')
    expect(splitAnchor(state, 'P', 'zoom')?.id).toBe('P')
  })

  it('is the tab the split view is made with when both are in folders', () => {
    const state = report()
    expect(splitAnchor(state, 'h1', 'notes')?.id).toBe('notes')
    expect(splitAnchor(state, 'notes', 'h1')?.id).toBe('h1')
  })

  it('is the tab already in a split view: a pane added to it joins its place', () => {
    const state = report([split('sv', ['zoom', 'meet'])])
    expect(splitAnchor(state, 'notes', 'zoom')?.id).toBe('zoom')
    expect(splitAnchor(state, 'zoom', 'notes')?.id).toBe('zoom')
  })

  it('is none when nothing has to move: the same list, the page of a favourite, two spaces, a tab that is gone', () => {
    const state = report()
    expect(splitAnchor(state, 'zoom', 'meet')).toBeNull()
    expect(splitAnchor(state, 'docs', 'notes')).toBeNull()
    const withFavorite = { ...state, tabs: [...state.tabs, tab('fav', { favoriteId: 'f1' })] }
    expect(splitAnchor(withFavorite, 'fav', 'notes')).toBeNull()
    expect(splitAnchor(withFavorite, 'notes', 'fav')).toBeNull()
    const elsewhere = { ...state, tabs: [...state.tabs, tab('far', { spaceId: 's2' })] }
    expect(splitAnchor(elsewhere, 'far', 'notes')).toBeNull()
    expect(splitAnchor(state, 'gone', 'notes')).toBeNull()
  })
})

describe('the place of the tab that joins', () => {
  it('is right after the anchor, in its folder', () => {
    const state = report()
    // The pinned group, without Zoom: P, oct26, docs, notes, slides, h1. Right after notes is index 4 (before slides).
    expect(splitJoin(state, 'zoom', 'notes')).toEqual({ id: 'zoom', toIndex: 4, pinned: true, folderId: 'G' })
    expect(splitJoin(state, 'notes', 'zoom')).toEqual({ id: 'zoom', toIndex: 4, pinned: true, folderId: 'G' })
  })

  it('is right after the anchor among the loose pinned tabs, outside any folder', () => {
    expect(splitJoin(report(), 'zoom', 'P')).toEqual({ id: 'zoom', toIndex: 1, pinned: true })
  })

  it('moves a tab of a folder into the folder of the anchor', () => {
    // The pinned group without notes: P, oct26, docs, slides, h1. Right after h1 is index 5.
    expect(splitJoin(report(), 'notes', 'h1')).toEqual({ id: 'notes', toIndex: 5, pinned: true, folderId: 'H' })
  })

  it('is none for a pinned tab added to a split view of Today tabs (it would be unpinned), and for a private tab next to a pinned one', () => {
    expect(splitJoin(report([split('sv', ['zoom', 'meet'])]), 'notes', 'zoom')).toBeNull()
    const state = report()
    const withPrivate = { ...state, tabs: [...state.tabs, tab('secret', { private: true })] }
    expect(splitJoin(withPrivate, 'secret', 'notes')).toBeNull()
    expect(splitJoin(state, 'zoom', 'meet')).toBeNull()
  })
})

describe('the rows of split views', () => {
  const rowsFor = (state: Pick<SidebarState, 'tabs' | 'folders' | 'splits'>) => {
    // The lists as the sidebar draws them: the loose pinned tabs, each folder, Today.
    const lists: DrawnList<TabItem>[] = [
      { tabs: state.tabs.filter((t) => listOfTab(state.folders, t) === 'pinned'), folder: false },
      ...state.folders.map((f) => ({ tabs: state.tabs.filter((t) => listOfTab(state.folders, t) === `folder:${f.id}`), folder: true })),
      { tabs: state.tabs.filter((t) => !t.pinned), folder: false }
    ]
    const plan = splitRows(lists, state.splits)
    // What each list shows: a tab, or the tabs of a split view's row joined by "|"; the tabs another row stands for are left out.
    return lists.map((list) => list.tabs.flatMap((t) => (plan.covered.has(t.id) ? [] : [plan.rows.get(t.id)?.tabs.map((m) => m.id).join('|') ?? t.id])))
  }

  it('draws a split view whose tabs sit in a folder and in Today once, at the place of the folder tab, in the order of the split view', () => {
    expect(rowsFor(report([split('sv', ['zoom', 'notes'])]))).toEqual([['P'], ['oct26', 'docs', 'zoom|notes', 'slides'], ['h1'], ['meet']])
  })

  it('draws it at the folder tab even when its other tab is drawn above: a loose pinned tab, or a Today tab above a folder put under Today', () => {
    expect(rowsFor(report([split('sv', ['P', 'notes'])]))).toEqual([[], ['oct26', 'docs', 'P|notes', 'slides'], ['h1'], ['zoom', 'meet']])
    const under = splitRows([{ tabs: [tab('zoom'), tab('meet')], folder: false }, { tabs: [tab('h1', { pinned: true, folderId: 'H' })], folder: true }], [split('sv', ['zoom', 'h1'])])
    expect([...under.rows.keys()]).toEqual(['h1'])
    expect([...under.covered]).toEqual(['zoom'])
  })

  it('draws a split view of a loose pinned tab and a Today tab at the place of the first of them', () => {
    expect(rowsFor(report([split('sv', ['zoom', 'P'])]))).toEqual([['zoom|P'], ['oct26', 'docs', 'notes', 'slides'], ['h1'], ['meet']])
  })

  it('draws a split view whose tabs share a list as it always was: at the place of the first of them', () => {
    // Zoom moved into the folder ahead of OCT26 (the first result seen): the row is at the head of the folder, Notes' place is empty.
    const state = report([split('sv', ['zoom', 'notes'])])
    const ahead = { ...state, tabs: [tab('zoom', { pinned: true, folderId: 'G' }), ...state.tabs.filter((t) => t.id !== 'zoom')] }
    expect(rowsFor(ahead)).toEqual([['P'], ['zoom|notes', 'oct26', 'docs', 'slides'], ['h1'], ['meet']])
    expect(rowsFor(report([split('sv', ['meet', 'zoom'])]))).toEqual([['P'], ['oct26', 'docs', 'notes', 'slides'], ['h1'], ['meet|zoom']])
  })

  it('counts only the tabs that are drawn, and the first folder of a split view whose tabs are in two folders', () => {
    const plan = splitRows([{ tabs: [tab('a')], folder: false }], [split('sv', ['a', 'fav'])])
    expect(plan.rows.get('a')?.tabs.map((t) => t.id)).toEqual(['a'])
    expect([...plan.covered]).toEqual([])
    expect(rowsFor(report([split('sv', ['h1', 'zoom', 'notes'])]))).toEqual([['P'], ['oct26', 'docs', 'h1|zoom|notes', 'slides'], [], ['meet']])
  })
})

describe('split/create puts the two tabs together', () => {
  function makeCtx(): Ctx {
    let n = 0
    return { now: 1_000_000, newId: () => `id${++n}` }
  }
  const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

  /** The report's space through the reducer: the folder Google with OCT26, Docs, Notes, Slides; Zoom and Meet in Today. */
  function reported() {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Google' })
    const google = s.folders[0]!.id
    for (const name of ['oct26', 'docs', 'notes', 'slides', 'zoom', 'meet']) s = run(ctx, s, { type: 'tab/open', url: `https://${name}.example/`, background: true })
    const id = (name: string) => s.tabs.find((t) => t.url === `https://${name}.example/`)!.id
    for (const name of ['oct26', 'docs', 'notes', 'slides']) s = run(ctx, s, { type: 'tab/move', id: id(name), toIndex: Number.MAX_SAFE_INTEGER, pinned: true, folderId: google })
    const names = (state: SidebarState) => sidebarOrder(state, state.activeSpaceId).map((t) => `${t.url.split('/')[2]!.replace('.example', '')}${t.folderId === google ? '@G' : ''}`)
    return { ctx, s, id, google, names }
  }

  it('moves the Today tab into the folder right after the tab in the folder, whichever of the two it is made with', () => {
    const { ctx, s, id, names } = reported()
    expect(names(s)).toEqual(['oct26@G', 'docs@G', 'notes@G', 'slides@G', 'zoom', 'meet'])
    for (const action of [{ type: 'split/create', tabId: id('zoom'), withTabId: id('notes') }, { type: 'split/create', tabId: id('notes'), withTabId: id('zoom') }] as const) {
      const out = run(ctx, s, action)
      expect(names(out)).toEqual(['oct26@G', 'docs@G', 'notes@G', 'zoom@G', 'slides@G', 'meet'])
      expect(out.splits).toHaveLength(1)
      expect(out.splits[0]!.tabIds).toEqual([action.tabId, action.withTabId])
      // It is pinned as a drop in the folder pins it: its address is its anchor.
      expect(out.tabs.find((t) => t.id === id('zoom'))).toMatchObject({ pinned: true, anchorUrl: 'https://zoom.example/' })
    }
  })

  it('leaves the tabs where they are when they share a list', () => {
    const { ctx, s, id, names } = reported()
    expect(names(run(ctx, s, { type: 'split/create', tabId: id('meet'), withTabId: id('zoom') }))).toEqual(names(s))
    expect(names(run(ctx, s, { type: 'split/create', tabId: id('slides'), withTabId: id('docs') }))).toEqual(names(s))
  })

  it('puts a pane added to a split view of the folder right after the tab it is added to', () => {
    const { ctx, s, id, names } = reported()
    const pair = run(ctx, s, { type: 'split/create', tabId: id('docs'), withTabId: id('notes') })
    expect(names(run(ctx, pair, { type: 'split/create', tabId: id('meet'), withTabId: id('docs') }))).toEqual(['oct26@G', 'docs@G', 'meet@G', 'notes@G', 'slides@G', 'zoom'])
  })
})
