// The tab tree (Réglages › Fonctions › Arbre d’onglets): the rules of tab-tree.ts and what the reducer does with them. Tabs are named by their
// host (a.fr, b.fr…) so that the expected orders read easily; "a>b" in a comment means b hangs under a.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { NO_DROP, planDrop, locateRow, type DropPlan, type DropTarget, type RowBox } from './dnd'
import { privateAction } from './private-window'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, sidebarOrder, visibleTabOrder, type Action, type Ctx } from './sidebar'
import { TREE_DRAWN_DEPTH, afterBranch, branchIds, branchOf, childrenOf, foldedAncestors, foldedAway, settleTree, treeDepth, treeDropSlot, treeOutdentSlot, treeRows } from './tab-tree'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}
const ctx = makeCtx()
const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)
const apply = (state: SidebarState, plan: DropPlan) => run(state, ...plan.actions)

/** A state with the tree on and the given Today tabs of the first space, in that order, none selected; `parents` maps a name to the name of its parent. */
function tree(names: string[], parents: Record<string, string> = {}, over: Partial<SidebarState['settings']> = {}) {
  let s = createInitialState(ctx)
  s = run(s, { type: 'settings/update', patch: { tabTree: true, ...over } })
  for (const n of names) s = run(s, { type: 'tab/open', url: `https://${n}.fr/`, background: true })
  const id = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  s = { ...s, tabs: s.tabs.map((t) => (parents[hostName(t)] ? { ...t, parentId: id(parents[hostName(t)]!) } : t)) }
  s = normalize(s)
  return { s, id, home: s.activeSpaceId }
}
const hostName = (t: TabItem) => t.url.split('/')[2]!.replace('.fr', '')
const names = (state: SidebarState, spaceId = state.activeSpaceId) => sidebarOrder(state, spaceId).map(hostName)
/** "a>b" pairs for every tab that has a parent. */
const links = (state: SidebarState) =>
  state.tabs
    .filter((t) => t.parentId !== undefined)
    .map((t) => `${hostName(state.tabs.find((p) => p.id === t.parentId)!)}>${hostName(t)}`)
    .sort()

describe('opening a tab from another tab', () => {
  it('hangs the new tab under its opener, after the rest of that branch', () => {
    const { s, id } = tree(['a', 'b', 'c'])
    const opened = run(s, { type: 'tab/open', url: 'https://x.fr/', parentId: id('a'), background: true }, { type: 'tab/open', url: 'https://y.fr/', parentId: id('a'), background: true })
    expect(names(opened)).toEqual(['a', 'x', 'y', 'b', 'c'])
    expect(links(opened)).toEqual(['a>x', 'a>y'])
    // A tab opened from a child hangs under that child, inside the branch of the parent.
    const deep = run(opened, { type: 'tab/open', url: 'https://z.fr/', parentId: opened.tabs.find((t) => hostName(t) === 'x')!.id, background: true })
    expect(names(deep)).toEqual(['a', 'x', 'z', 'y', 'b', 'c'])
    expect(links(deep)).toEqual(['a>x', 'a>y', 'x>z'])
  })

  it('makes an ordinary tab when the setting is off, whatever the opener says', () => {
    const { s, id } = tree(['a', 'b'], {}, { tabTree: false })
    const opened = run(s, { type: 'tab/open', url: 'https://x.fr/', parentId: id('a'), background: true })
    expect(names(opened)).toEqual(['a', 'b', 'x'])
    expect(links(opened)).toEqual([])
  })

  it('makes an ordinary tab for an opener that is not a tab, is pinned, or is in another space', () => {
    const { s, id, home } = tree(['a', 'b'])
    const pinned = run(s, { type: 'tab/pin', id: id('a') })
    const underPinned = run(pinned, { type: 'tab/open', url: 'https://x.fr/', parentId: id('a'), background: true })
    expect(links(underPinned)).toEqual([])
    // It goes where any new tab goes, at the end of Today, not behind the tab it came from.
    expect(names(underPinned)).toEqual(['a', 'b', 'x'])
    const unknown = run(s, { type: 'tab/open', url: 'https://x.fr/', parentId: 'nothing', background: true })
    expect(links(unknown)).toEqual([])
    expect(names(unknown)).toEqual(['a', 'b', 'x'])
    const elsewhere = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const other = elsewhere.activeSpaceId
    expect(other).not.toBe(home)
    const there = run(elsewhere, { type: 'tab/open', url: 'https://z.fr/', background: true }, { type: 'tab/open', url: 'https://x.fr/', parentId: id('a'), spaceId: other, background: true })
    expect(links(there)).toEqual([])
    expect(names(there, other)).toEqual(['z', 'x'])
    expect(names(there, home)).toEqual(['a', 'b'])
  })

  it('shows a tab opened in the foreground even under a folded parent', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    expect(foldedAway(folded.tabs).size).toBe(1)
    const opened = run(folded, { type: 'tab/open', url: 'https://x.fr/', parentId: id('a') })
    expect(opened.tabs.find((t) => t.id === id('a'))).not.toHaveProperty('treeCollapsed')
    expect(foldedAway(opened.tabs).size).toBe(0)
  })
})

describe('closing a parent', () => {
  const closing: Array<[string, (id: string) => Action]> = [
    ['tab/close', (id) => ({ type: 'tab/close', id })],
    ['tab/archive', (id) => ({ type: 'tab/archive', id })]
  ]

  it.each(closing)('%s: the children stay, under the grandparent', (_name, close) => {
    // a > b > (c, d)    e
    const { s, id } = tree(['a', 'b', 'c', 'd', 'e'], { b: 'a', c: 'b', d: 'b' })
    const closed = run(s, close(id('b')))
    expect(names(closed)).toEqual(['a', 'c', 'd', 'e'])
    expect(links(closed)).toEqual(['a>c', 'a>d'])
  })

  it.each(closing)('%s: the children of a root become roots, in place', (_name, close) => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'a', d: 'c' })
    const closed = run(s, close(id('a')))
    expect(names(closed)).toEqual(['b', 'c', 'd'])
    expect(links(closed)).toEqual(['c>d'])
  })

  it('also holds for the other ways a tab leaves: Today cleared, others closed, archive by group', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { c: 'b', d: 'c' })
    const selected = run(s, { type: 'tab/select', id: id('d') })
    // "Vider": everything but the selected tab goes; d is left alone, a root.
    const cleared = run(selected, { type: 'today/clear' })
    expect(names(cleared)).toEqual(['d'])
    expect(links(cleared)).toEqual([])
    // Archiving what is above c leaves c under nothing (its parent b goes) and d under c.
    const above = run(s, { type: 'tab/archive-group', id: id('c'), scope: 'above' })
    expect(names(above)).toEqual(['c', 'd'])
    expect(links(above)).toEqual(['c>d'])
  })

  it('archives a whole branch on request without losing the structure of the rest', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const gone = run(s, { type: 'tabs/archive-many', ids: branchOf(s.tabs, id('b')).map((t) => t.id) })
    expect(names(gone)).toEqual(['a', 'd'])
    expect(links(gone)).toEqual([])
  })

  it('moves the selection to the first child when the parent was selected', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a' })
    const closed = run(s, { type: 'tab/select', id: id('a') }, { type: 'tab/close', id: id('a') })
    expect(closed.activeTabBySpace[closed.activeSpaceId]).toBe(id('b'))
  })
})

describe('pinning and moving between spaces', () => {
  it('pins a parent alone: its children stay in Today under its own parent', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b', d: 'b' })
    const pinned = run(s, { type: 'tab/pin', id: id('b') })
    expect(pinned.tabs.find((t) => t.id === id('b'))).not.toHaveProperty('parentId')
    expect(links(pinned)).toEqual(['a>c', 'a>d'])
  })

  it('unpins to a root', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    const back = run(s, { type: 'tab/pin', id: id('b') }, { type: 'tab/unpin', id: id('b') })
    expect(links(back)).toEqual([])
  })

  it('leaves the children behind when a parent goes to another space', () => {
    const { s, id, home } = tree(['a', 'b', 'c'], { b: 'a', c: 'b' })
    const withSpace = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'space/select', id: home })
    const moved = run(withSpace, { type: 'tab/move-to-space', id: id('b'), spaceId: withSpace.spaces[1]!.id })
    expect(links(moved)).toEqual(['a>c'])
    expect(moved.tabs.find((t) => t.id === id('b'))).not.toHaveProperty('parentId')
  })
})

describe('moving a tab in the tree', () => {
  it('moves a branch as a whole, children behind their parent', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'a' })
    const moved = run(s, { type: 'tab/move', id: id('a'), toIndex: 1, pinned: false, parentId: null })
    expect(names(moved)).toEqual(['d', 'a', 'b', 'c'])
    expect(links(moved)).toEqual(['a>b', 'a>c'])
  })

  it('gives the moved tab the parent it is dropped on, and its own branch comes with it', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { c: 'b' })
    const moved = run(s, { type: 'tab/move', id: id('b'), toIndex: 1, pinned: false, parentId: id('a') })
    expect(names(moved)).toEqual(['a', 'b', 'c', 'd'])
    expect(links(moved)).toEqual(['a>b', 'b>c'])
  })

  it('refuses a parent that is the tab itself, a tab of its own branch, a pinned tab or a tab of another space', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    for (const parentId of [id('a'), id('b'), id('c'), 'nothing']) {
      expect(run(s, { type: 'tab/move', id: id('a'), toIndex: 0, pinned: false, parentId }), String(parentId)).toBe(s)
    }
    const pinned = run(s, { type: 'tab/pin', id: id('d') })
    expect(run(pinned, { type: 'tab/move', id: id('a'), toIndex: 0, pinned: false, parentId: id('d') })).toBe(pinned)
  })

  it('makes a root of a tab moved without a parent', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a', c: 'a' })
    const moved = run(s, { type: 'tab/move', id: id('b'), toIndex: 2, pinned: false })
    expect(names(moved)).toEqual(['a', 'c', 'b'])
    expect(links(moved)).toEqual(['a>c'])
  })

  it('keeps the parent of a tab moved with its parent in a multiple move', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a' })
    const moved = run(s, { type: 'tabs/move', ids: [id('a'), id('b')], toIndex: 2, pinned: false, parentId: null })
    expect(names(moved)).toEqual(['c', 'd', 'a', 'b'])
    expect(links(moved)).toEqual(['a>b'])
  })

  it('ignores the parent for a move to the pinned list, and children stay behind', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a' })
    const moved = run(s, { type: 'tab/move', id: id('a'), toIndex: 0, pinned: true, parentId: id('c') })
    expect(links(moved)).toEqual([])
    expect(moved.tabs.find((t) => t.id === id('a'))!.pinned).toBe(true)
  })
})

describe('leaving the parent', () => {
  it('puts the tab beside its parent, below the parent’s branch, and brings its own branch', () => {
    // a > (b, c > d, e)
    const { s, id } = tree(['a', 'b', 'c', 'd', 'e', 'f'], { b: 'a', c: 'a', d: 'c', e: 'a' })
    const out = run(s, { type: 'tab/tree-detach', id: id('c') })
    expect(names(out)).toEqual(['a', 'b', 'e', 'c', 'd', 'f'])
    expect(links(out)).toEqual(['a>b', 'a>e', 'c>d'])
  })

  it('goes up one level only', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a', c: 'b' })
    const out = run(s, { type: 'tab/tree-detach', id: id('c') })
    expect(links(out)).toEqual(['a>b', 'a>c'])
  })

  it('does nothing for a tab with no parent, or without the setting', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    expect(run(s, { type: 'tab/tree-detach', id: id('a') })).toBe(s)
    const off = run(s, { type: 'settings/update', patch: { tabTree: false } })
    expect(run(off, { type: 'tab/tree-detach', id: id('b') })).toBe(off)
    const stale = { ...s, settings: { ...s.settings, tabTree: false } }
    expect(run(stale, { type: 'tab/tree-detach', id: id('b') })).toBe(stale)
  })
})

describe('folding a branch', () => {
  it('hides the tabs below, in the order of the visible rows too', () => {
    const { s, id, home } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    expect(visibleTabOrder(folded, home).map(hostName)).toEqual(['a', 'd'])
    expect(visibleTabOrder(s, home).map(hostName)).toEqual(['a', 'b', 'c', 'd'])
    expect(run(folded, { type: 'tab/tree-collapse', id: id('a'), collapsed: false }).tabs.every((t) => t.treeCollapsed === undefined)).toBe(true)
  })

  it('toggles without a value, and changes nothing when the state is already the one asked for', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    expect(folded.tabs.find((t) => t.id === id('a'))!.treeCollapsed).toBe(true)
    expect(run(folded, { type: 'tab/tree-collapse', id: id('a'), collapsed: true })).toBe(folded)
    expect(run(s, { type: 'tab/tree-collapse', id: id('a'), collapsed: false })).toBe(s)
    expect(run(folded, { type: 'tab/tree-collapse', id: id('a') }).tabs.find((t) => t.id === id('a'))).not.toHaveProperty('treeCollapsed')
  })

  it('does nothing for a tab without children, an unknown tab, or the setting off', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    expect(run(s, { type: 'tab/tree-collapse', id: id('b') })).toBe(s)
    expect(run(s, { type: 'tab/tree-collapse', id: 'nothing' })).toBe(s)
    const off = run(s, { type: 'settings/update', patch: { tabTree: false } })
    expect(run(off, { type: 'tab/tree-collapse', id: id('a') })).toBe(off)
    // The switch is read by the action itself, not only through the tree being flat: a state that still holds a branch gets no fold either.
    const stale = { ...s, settings: { ...s.settings, tabTree: false } }
    expect(run(stale, { type: 'tab/tree-collapse', id: id('a') })).toBe(stale)
  })

  it('forgets the fold when the last child leaves', () => {
    const { s, id } = tree(['a', 'b'], { b: 'a' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    const closed = run(folded, { type: 'tab/close', id: id('b') })
    expect(closed.tabs.find((t) => t.id === id('a'))).not.toHaveProperty('treeCollapsed')
  })

  it('opens the branch of a tab that gets selected (a shortcut, a click on a result, a neighbour after a close)', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    const shown = run(folded, { type: 'tab/select', id: id('c') })
    expect(foldedAway(shown.tabs).size).toBe(0)
    // Folding the branch of the tab on screen is the user's choice: nothing opens it again by itself.
    const again = run(shown, { type: 'tab/tree-collapse', id: id('a') })
    expect(foldedAway(again.tabs).has(id('c'))).toBe(true)
    expect(run(again, { type: 'tab/update', id: id('c'), patch: { title: 'nouveau' } }).tabs.find((t) => t.id === id('a'))!.treeCollapsed).toBe(true)
  })
})

describe('the setting', () => {
  it('flattens the tree when it is turned off, keeping the order of the rows, and gives nothing back when it is turned on again', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('b') })
    const off = run(folded, { type: 'settings/update', patch: { tabTree: false } })
    expect(names(off)).toEqual(['a', 'b', 'c', 'd'])
    expect(off.tabs.every((t) => t.parentId === undefined && t.treeCollapsed === undefined)).toBe(true)
    expect(links(run(off, { type: 'settings/update', patch: { tabTree: true } }))).toEqual([])
  })

  it('does not touch the state of a browser that never used the tree', () => {
    let s = createInitialState(ctx)
    s = run(s, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/', parentId: 'x' })
    expect(s.settings.tabTree).toBe(false)
    expect(settleTree(s, s)).toBe(s)
    expect(s.tabs.every((t) => !('parentId' in t) && !('treeCollapsed' in t))).toBe(true)
  })

  it('keeps the tree through a save and a load, and repairs a file that was edited', () => {
    const { s, id } = tree(['a', 'b', 'c'], { c: 'a' })
    const loaded = parseSavedState(JSON.stringify(persistableState(s)))
    expect(names(loaded)).toEqual(['a', 'c', 'b'])
    expect(links(loaded)).toEqual(['a>c'])
    const damaged = JSON.parse(JSON.stringify(s)) as SidebarState
    const [a, b, c] = damaged.tabs.map((t) => t.id) as [string, string, string]
    damaged.tabs = [
      { ...damaged.tabs[0]!, parentId: c },
      { ...damaged.tabs[1]!, parentId: 'ghost', treeCollapsed: true },
      { ...damaged.tabs[2]!, parentId: a }
    ]
    const repaired = normalize(damaged)
    // a and c hang under each other: one of them is the root, the other its child; b has no parent left and nothing to fold.
    expect(repaired.tabs.map((t) => t.id).sort()).toEqual([a, b, c].sort())
    expect(repaired.tabs.filter((t) => t.parentId === undefined).length).toBe(2)
    expect(repaired.tabs.find((t) => t.id === b)).not.toHaveProperty('treeCollapsed')
    expect(repaired.tabs.find((t) => t.id === b)).not.toHaveProperty('parentId')
    expect(normalize(repaired)).toEqual(repaired)
    expect(id('a')).toBe(a)
  })
})

describe('a file written by hand', () => {
  it('folds a branch only for a real true, and takes a parent only for an id', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a' })
    for (const folded of ['yes', 1, {}, [], 'true']) {
      const file = JSON.parse(JSON.stringify(s)) as SidebarState
      file.tabs = file.tabs.map((t) => (t.id === id('a') ? ({ ...t, treeCollapsed: folded } as unknown as TabItem) : t))
      expect(normalize(file).tabs.find((t) => t.id === id('a')), JSON.stringify(folded)).not.toHaveProperty('treeCollapsed')
    }
    for (const parent of [42, null, {}, ['a'], '', 'x'.repeat(5000)]) {
      const file = JSON.parse(JSON.stringify(s)) as SidebarState
      file.tabs = file.tabs.map((t) => (t.id === id('c') ? ({ ...t, parentId: parent } as unknown as TabItem) : t))
      expect(normalize(file).tabs.find((t) => t.id === id('c')), JSON.stringify(parent)).not.toHaveProperty('parentId')
    }
  })
})

describe('settleTree', () => {
  it('returns the same object when the tree holds', () => {
    const { s } = tree(['a', 'b', 'c'], { b: 'a' })
    expect(settleTree(s, s)).toBe(s)
  })

  it('gathers a branch behind its parent, tabs of other spaces and pinned tabs staying where they are', () => {
    const { s, id, home } = tree(['a', 'b', 'c', 'd'])
    const other = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const elsewhere = run(other, { type: 'tab/open', url: 'https://z.fr/', background: true })
    const back = run(elsewhere, { type: 'space/select', id: home })
    // d hangs under a, but sits at the end of the list, after another space's tab.
    const hung = { ...back, tabs: back.tabs.map((t) => (t.id === id('d') ? { ...t, parentId: id('a') } : t)) }
    const settled = settleTree(hung, hung)
    expect(names(settled, home)).toEqual(['a', 'd', 'b', 'c'])
    expect(settled.tabs.at(-1)!.url).toContain('z.fr')
  })

  it('hands the children of a parent that is gone to the nearest ancestor that is left', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a', c: 'b' })
    const without = { ...s, tabs: s.tabs.filter((t) => t.id !== id('b')) }
    expect(links(settleTree(s, without))).toEqual(['a>c'])
    // With no memory of the past (a file), the child is a root.
    expect(links(settleTree(without, without))).toEqual([])
  })

  it('does not follow a loop of parents for ever', () => {
    const { s } = tree(['a', 'b', 'c'])
    const [a, b, c] = s.tabs as [TabItem, TabItem, TabItem]
    const looped = { ...s, tabs: [{ ...a, parentId: c.id }, { ...b, parentId: a.id }, { ...c, parentId: b.id }] }
    const settled = settleTree(looped, looped)
    expect(settled.tabs.filter((t) => t.parentId === undefined)).toHaveLength(1)
    expect(treeDepth(settled.tabs, settled.tabs.at(-1)!.id)).toBeLessThanOrEqual(2)
  })

  it('never lets a tab be its own parent', () => {
    const { s } = tree(['a'])
    const selfish = { ...s, tabs: [{ ...s.tabs[0]!, parentId: s.tabs[0]!.id }] }
    expect(settleTree(selfish, selfish).tabs[0]).not.toHaveProperty('parentId')
  })
})

describe('reading the tree', () => {
  it('lists a branch, its depth and its children', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    expect(branchOf(s.tabs, id('a')).map(hostName)).toEqual(['a', 'b', 'c'])
    expect([...branchIds(s.tabs, [id('b')])].sort()).toEqual([id('b'), id('c')].sort())
    expect(childrenOf(s.tabs, id('a')).map(hostName)).toEqual(['b'])
    expect(treeDepth(s.tabs, id('c'))).toBe(2)
    expect(treeDepth(s.tabs, id('d'))).toBe(0)
    expect(afterBranch(s.tabs, s.tabs.find((t) => t.id === id('a'))!)).toBe(3)
  })
})

describe('revealing a tab', () => {
  it('names the folded ancestors that hide it, nearest first, and none for a tab that shows', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const folded = run(run(s, { type: 'tab/tree-collapse', id: id('a') }), { type: 'tab/tree-collapse', id: id('b') })
    expect(foldedAncestors(folded.tabs, id('c'))).toEqual([id('b'), id('a')])
    expect(foldedAncestors(folded.tabs, id('b'))).toEqual([id('a')])
    expect(foldedAncestors(folded.tabs, id('a'))).toEqual([])
    expect(foldedAncestors(folded.tabs, id('d'))).toEqual([])
    expect(foldedAncestors(s.tabs, id('c'))).toEqual([])
    expect(foldedAncestors(s.tabs, 'nothing')).toEqual([])
  })
})

describe('the rows the sidebar draws', () => {
  it('lists the tabs that are in the tree, with their depth, how many hang under them and whether they are folded', () => {
    const { s, id } = tree(['a', 'b', 'c', 'd'], { b: 'a', c: 'b' })
    const folded = run(s, { type: 'tab/tree-collapse', id: id('b') })
    const rows = treeRows(folded.tabs)
    expect(rows.get(id('a'))).toEqual({ depth: 0, below: 2, folded: false })
    expect(rows.get(id('b'))).toEqual({ depth: 1, below: 1, folded: true })
    expect(rows.get(id('c'))).toEqual({ depth: 2, below: 0, folded: false })
    // A tab with no parent and no child is a flat row, as when the setting is off.
    expect(rows.has(id('d'))).toBe(false)
  })

  it('draws no deeper than the limit, however long the chain of links', () => {
    const names = Array.from({ length: TREE_DRAWN_DEPTH + 4 }, (_, i) => `t${i}`)
    const { s, id } = tree(names, Object.fromEntries(names.slice(1).map((n, i) => [n, names[i]!])))
    expect(treeRows(s.tabs).get(id(names.at(-1)!))!.depth).toBe(TREE_DRAWN_DEPTH)
  })
})

describe('dropping on the tree', () => {
  /** a (b, c > d) e f — Today of the first space. */
  function drop() {
    const t = tree(['a', 'b', 'c', 'd', 'e', 'f'], { b: 'a', c: 'a', d: 'c' })
    const on = (dragged: string, ref: string, edge: DropTarget extends infer T ? (T extends { kind: 'tab'; edge: infer E } ? E : never) : never) => planDrop(t.s, { kind: 'tabs', ids: [t.id(dragged)] }, { kind: 'tab', id: t.id(ref), edge })
    return { ...t, on }
  }

  it('puts a tab before a row as a sibling of it', () => {
    const { s, on } = drop()
    const after = apply(s, on('f', 'c', 'before'))
    expect(names(after)).toEqual(['a', 'b', 'f', 'c', 'd', 'e'])
    expect(links(after)).toEqual(['a>b', 'a>c', 'a>f', 'c>d'])
  })

  it('puts a tab after a row that shows children as its first child, and after a row without children as its sibling', () => {
    const { s, on } = drop()
    const first = apply(s, on('f', 'a', 'after'))
    expect(names(first)).toEqual(['a', 'f', 'b', 'c', 'd', 'e'])
    expect(links(first)).toEqual(['a>b', 'a>c', 'a>f', 'c>d'])
    const sibling = apply(s, on('f', 'b', 'after'))
    expect(names(sibling)).toEqual(['a', 'b', 'f', 'c', 'd', 'e'])
    expect(links(sibling)).toContain('a>f')
  })

  it('puts a tab after a folded row as a sibling, below its branch', () => {
    const { s, id } = drop()
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    const plan = planDrop(folded, { kind: 'tabs', ids: [id('f')] }, { kind: 'tab', id: id('a'), edge: 'after' })
    const after = apply(folded, plan)
    expect(names(after)).toEqual(['a', 'b', 'c', 'd', 'f', 'e'])
    expect(after.tabs.find((t) => t.id === id('f'))).not.toHaveProperty('parentId')
  })

  it('makes a tab the last child of the row it is dropped inside, opening the branch', () => {
    const { s, id, on } = drop()
    const inside = apply(s, on('f', 'a', 'inside'))
    expect(names(inside)).toEqual(['a', 'b', 'c', 'd', 'f', 'e'])
    expect(links(inside)).toContain('a>f')
    const folded = run(s, { type: 'tab/tree-collapse', id: id('a') })
    const opened = apply(folded, planDrop(folded, { kind: 'tabs', ids: [id('f')] }, { kind: 'tab', id: id('a'), edge: 'inside' }))
    expect(opened.tabs.find((t) => t.id === id('a'))).not.toHaveProperty('treeCollapsed')
  })

  it('moves a dragged branch with its children', () => {
    const { s, on } = drop()
    const after = apply(s, on('c', 'e', 'inside'))
    expect(names(after)).toEqual(['a', 'b', 'e', 'c', 'd', 'f'])
    expect(links(after)).toEqual(['a>b', 'c>d', 'e>c'])
  })

  it('refuses to drop a tab on itself or on something of its own branch', () => {
    const { s, on, id } = drop()
    expect(on('c', 'c', 'inside')).toEqual(NO_DROP)
    expect(on('c', 'd', 'inside')).toEqual(NO_DROP)
    expect(on('c', 'd', 'before')).toEqual(NO_DROP)
    expect(on('a', 'd', 'after')).toEqual(NO_DROP)
    expect(planDrop(s, { kind: 'tabs', ids: [id('c')] }, { kind: 'tab', id: id('b'), edge: 'after' }).actions).not.toEqual([])
  })

  it('drops under the end of Today as a root', () => {
    const { s, id } = drop()
    const after = apply(s, planDrop(s, { kind: 'tabs', ids: [id('b')] }, { kind: 'today' }))
    expect(names(after)).toEqual(['a', 'c', 'd', 'e', 'f', 'b'])
    expect(links(after)).toEqual(['a>c', 'c>d'])
  })

  it('means nothing on a pinned tab, and nothing "inside" without the setting', () => {
    const { s, id } = drop()
    const pinned = run(s, { type: 'tab/pin', id: id('e') })
    expect(planDrop(pinned, { kind: 'tabs', ids: [id('f')] }, { kind: 'tab', id: id('e'), edge: 'inside' })).toEqual(NO_DROP)
    const off = run(s, { type: 'settings/update', patch: { tabTree: false } })
    expect(planDrop(off, { kind: 'tabs', ids: [id('f')] }, { kind: 'tab', id: id('a'), edge: 'inside' })).toEqual(NO_DROP)
  })

  it('keeps the actions of a flat sidebar when the setting is off (no parent in them)', () => {
    const { s, id } = drop()
    const off = run(s, { type: 'settings/update', patch: { tabTree: false } })
    const plan = planDrop(off, { kind: 'tabs', ids: [id('f')] }, { kind: 'tab', id: id('b'), edge: 'before' })
    expect(plan.actions).toHaveLength(1)
    expect(plan.actions[0]).not.toHaveProperty('parentId')
    expect(planDrop(off, { kind: 'tabs', ids: [id('f')] }, { kind: 'today' }).actions[0]).not.toHaveProperty('parentId')
  })

  it('sends the dragged tabs alone to a space, a favourite or the pinned list', () => {
    const { s, id, home } = drop()
    const withSpace = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'space/select', id: home })
    const plan = planDrop(withSpace, { kind: 'tabs', ids: [id('c')] }, { kind: 'space', id: withSpace.spaces[1]!.id })
    expect(plan.moveToSpace).toEqual({ ids: [id('c')], spaceId: withSpace.spaces[1]!.id })
    const pin = apply(s, planDrop(s, { kind: 'tabs', ids: [id('c')] }, { kind: 'folder', id: null }))
    expect(pin.tabs.find((t) => t.id === id('c'))!.pinned).toBe(true)
    expect(links(pin)).toEqual(['a>b', 'a>d'])
  })

  it('gives the slots in the list without the dragged tabs', () => {
    const { s, id } = drop()
    const moved = new Set([id('f')])
    const ref = s.tabs.find((t) => t.id === id('c'))!
    expect(treeDropSlot(s.tabs, moved, ref, 'before')).toEqual({ parentId: id('a'), toIndex: 2 })
    expect(treeDropSlot(s.tabs, moved, ref, 'inside')).toEqual({ parentId: id('c'), toIndex: 4 })
    expect(treeDropSlot(s.tabs, moved, ref, 'after')).toEqual({ parentId: id('c'), toIndex: 3 })
    expect(treeDropSlot(s.tabs, new Set([id('c')]), ref, 'before')).toBeNull()
    expect(treeDropSlot(s.tabs, new Set([id('c'), id('d')]), s.tabs.find((t) => t.id === id('d'))!, 'inside')).toBeNull()
    const pinned = run(s, { type: 'tab/pin', id: id('e') })
    expect(treeDropSlot(pinned.tabs, moved, pinned.tabs.find((t) => t.id === id('e'))!, 'after')).toBeNull()
    // d leaves c: it goes to a's children, just below c (the list without d is a, b, c, e, f).
    expect(treeOutdentSlot(s.tabs, s.tabs.find((t) => t.id === id('d'))!)).toEqual({ parentId: id('a'), toIndex: 3 })
    expect(treeOutdentSlot(s.tabs, s.tabs.find((t) => t.id === id('a'))!)).toBeNull()
  })
})

describe('where the pointer is on a row of the tree', () => {
  const rows: RowBox[] = [
    { kind: 'tab', id: 'a', top: 0, bottom: 36 },
    { kind: 'tab', id: 'p', top: 36, bottom: 72, pinned: true }
  ]

  it('reads the middle of a Today row as "under it" and its quarters as the places next to it', () => {
    expect(locateRow(rows, 3, true)?.target).toEqual({ kind: 'tab', id: 'a', edge: 'before' })
    expect(locateRow(rows, 18, true)?.target).toEqual({ kind: 'tab', id: 'a', edge: 'inside' })
    expect(locateRow(rows, 34, true)?.target).toEqual({ kind: 'tab', id: 'a', edge: 'after' })
  })

  it('keeps two halves for a pinned row, and for every row without the setting', () => {
    expect(locateRow(rows, 40, true)?.target).toEqual({ kind: 'tab', id: 'p', edge: 'before' })
    expect(locateRow(rows, 53, true)?.target).toEqual({ kind: 'tab', id: 'p', edge: 'before' })
    expect(locateRow(rows, 55, true)?.target).toEqual({ kind: 'tab', id: 'p', edge: 'after' })
    expect(locateRow(rows, 70, true)?.target).toEqual({ kind: 'tab', id: 'p', edge: 'after' })
    expect(locateRow(rows, 18)?.target).toEqual({ kind: 'tab', id: 'a', edge: 'after' })
    expect(locateRow(rows, 17)?.target).toEqual({ kind: 'tab', id: 'a', edge: 'before' })
  })
})

describe('in a private window', () => {
  it('accepts the actions of the tree, and a move with a parent (a private window has no pinned list)', () => {
    for (const action of [
      { type: 'tab/open', url: 'https://a.fr/', parentId: 'x' },
      { type: 'tab/tree-collapse', id: 'x' },
      { type: 'tab/tree-detach', id: 'x' },
      { type: 'tab/move', id: 'x', toIndex: 0, pinned: false, parentId: 'y' }
    ] satisfies Action[]) {
      expect(privateAction(action)).toEqual(action)
    }
    expect(privateAction({ type: 'tab/move', id: 'x', toIndex: 0, pinned: true, parentId: 'y' })).toBeNull()
  })

  it('keeps no tree in a file: a private tab is never saved, and its children go with it', () => {
    const { s, id } = tree(['a', 'b', 'c'], { b: 'a' })
    const secret = { ...s, tabs: s.tabs.map((t) => (t.id === id('a') ? { ...t, private: true as const } : t)) }
    const saved = persistableState(secret)
    expect(names(saved)).toEqual(['b', 'c'])
    expect(links(saved)).toEqual([])
  })
})

// ---- the invariants, after any sequence of actions ----

/** What must hold of the tree whatever was done: every parent is a Today tab of the same space, a branch is right behind its parent, a fold has children. */
function treeProblems(state: SidebarState): string[] {
  const out: string[] = []
  const byId = new Map(state.tabs.map((t) => [t.id, t]))
  for (const t of state.tabs) {
    const parent = t.parentId === undefined ? undefined : byId.get(t.parentId)
    if (t.parentId !== undefined && (!state.settings.tabTree || !parent || parent.id === t.id || parent.spaceId !== t.spaceId || parent.pinned || t.pinned)) out.push(`parent of ${t.id}`)
    if (t.treeCollapsed !== undefined && (!state.settings.tabTree || !state.tabs.some((c) => c.parentId === t.id))) out.push(`fold of ${t.id}`)
  }
  for (const space of state.spaces) {
    const open: string[] = []
    for (const t of state.tabs.filter((x) => x.spaceId === space.id && !x.pinned)) {
      while (open.length > 0 && open[open.length - 1] !== t.parentId) open.pop()
      if (t.parentId !== undefined && open.length === 0) out.push(`${t.id} is not behind its parent`)
      open.push(t.id)
    }
  }
  return out
}

describe('whatever is done', () => {
  /** A small deterministic random generator (mulberry32): the same sequences on every run. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('keeps the tree well formed, stable under settling and under a save and a load', () => {
    let deepest = 0
    let folds = 0
    let moves = 0
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed)
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!
      const tester = makeCtx()
      let s = createInitialState(tester)
      s = reduce(s, { type: 'settings/update', patch: { tabTree: true } }, tester)
      s = reduce(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, tester)
      const spaces = s.spaces.map((sp) => sp.id)
      const history: string[] = []
      for (let step = 0; step < 90; step++) {
        const tabs = s.tabs
        const some = () => (tabs.length > 0 ? pick(tabs).id : 'none')
        // Tabs are opened under tabs far more often than anything is closed, so that the trees get deep before they are taken apart.
        const openUnder = (): Action => ({ type: 'tab/open', url: `https://t${step}.fr/`, spaceId: pick(spaces), background: next() < 0.6, ...(tabs.length > 0 && next() < 0.9 ? { parentId: some() } : {}) })
        const action = pick<() => Action>([
          openUnder,
          openUnder,
          openUnder,
          openUnder,
          openUnder,
          () => ({ type: 'tab/open', url: `https://u${step}.fr/`, spaceId: pick(spaces) }),
          () => ({ type: 'tab/close', id: some() }),
          () => ({ type: 'tab/archive', id: some() }),
          () => ({ type: 'tab/pin', id: some() }),
          () => ({ type: 'tab/unpin', id: some() }),
          () => ({ type: 'tab/select', id: some() }),
          () => ({ type: 'tab/tree-collapse', id: some() }),
          () => ({ type: 'tab/tree-collapse', id: some() }),
          () => ({ type: 'tab/tree-detach', id: some() }),
          () => ({ type: 'tab/move', id: some(), toIndex: Math.floor(next() * 8), pinned: next() < 0.2, parentId: next() < 0.5 ? some() : null }),
          () => ({ type: 'tab/move', id: some(), toIndex: Math.floor(next() * 8), pinned: false, parentId: some() }),
          () => ({ type: 'tabs/move', ids: [some(), some(), some()], toIndex: Math.floor(next() * 8), pinned: false, parentId: next() < 0.5 ? some() : null }),
          () => ({ type: 'tab/move-to-space', id: some(), spaceId: pick(spaces) }),
          () => ({ type: 'tab/duplicate', id: some() }),
          () => ({ type: 'tab/archive-group', id: some(), scope: pick(['above', 'below', 'others'] as const) }),
          () => ({ type: 'tabs/archive-many', ids: [some(), some()] }),
          () => (next() < 0.15 ? { type: 'today/clear' } : { type: 'tab/select', id: some() }),
          () => ({ type: 'archive/restore-last' }),
          () => ({ type: 'space/select', id: pick(spaces) }),
          () => ({ type: 'settings/update', patch: { tabTree: next() < 0.95 } })
        ])()
        history.push(action.type)
        const before = s
        s = reduce(s, action, tester)
        if (action.type === 'tab/move' || action.type === 'tabs/move') moves += s === before ? 0 : 1
        deepest = Math.max(deepest, ...s.tabs.map((t) => treeDepth(s.tabs, t.id)))
        folds += s.tabs.filter((t) => t.treeCollapsed === true).length
        const problems = treeProblems(s)
        expect(problems, `seed ${seed}, step ${step} (${history.slice(-4).join(' > ')})`).toEqual([])
        expect(settleTree(s, s), `seed ${seed}, step ${step}: settling again`).toBe(s)
      }
      expect(normalize(JSON.parse(JSON.stringify(persistableState(s))) as SidebarState), `seed ${seed}: a save and a load`).toEqual(persistableState(s))
    }
    // The sequences must really build trees, fold them and move tabs in them, or the checks above prove nothing.
    expect(deepest).toBeGreaterThanOrEqual(3)
    expect(folds).toBeGreaterThan(50)
    expect(moves).toBeGreaterThan(100)
  })
})

describe('treeRows on a very long branch', () => {
  const chain = (length: number): TabItem[] =>
    Array.from({ length }, (_, i): TabItem => ({ id: `t${i}`, spaceId: 'sp', url: `https://t${i}.example/`, title: `t${i}`, pinned: false, createdAt: 1, lastActiveAt: 1, ...(i > 0 ? { parentId: `t${i - 1}` } : {}) }))

  it('draws a chain of 20 000 tabs without filling the stack, and counts what hangs under each', () => {
    const tabs = chain(20_000)
    const started = Date.now()
    const rows = treeRows(tabs)
    expect(rows.get('t0')).toMatchObject({ depth: 0, below: 19_999 })
    expect(rows.get('t19998')!.below).toBe(1)
    expect(rows.get('t19999')!.below).toBe(0)
    // One pass over the tabs: a count made tab by tab up to the root would take minutes here.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('still ends on a loop of parents (a damaged list), and gives each tab of it a row', () => {
    const loop = chain(4).map((tab) => (tab.id === 't0' ? { ...tab, parentId: 't3' } : tab))
    const rows = treeRows(loop)
    expect([...rows.keys()].sort()).toEqual(['t0', 't1', 't2', 't3'])
    for (const row of rows.values()) expect(Number.isFinite(row.depth) && Number.isFinite(row.below)).toBe(true)
  })
})
