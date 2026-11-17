// Two rules of the tab tree run often: `settleTree` after every action of the reducer (so at each title or icon a page changes), and `treeRows`
// at each snapshot the sidebar draws. `settleTree` found the places of each space's Today tabs with one pass over all the tabs per space (fifty
// spaces and two thousand tabs: a hundred thousand steps per action); it now finds them in one pass. `treeRows` made a set for every tab and
// sorted the tabs by depth; it now marks the walks in one map and takes the tabs level by level. This file keeps the earlier computations as they
// were and checks, on random states (loops, parents that are gone, pinned or in another space, folded marks, a selection that changes, ids
// repeated), that the new ones give the same result, and for `settleTree` the very same object when nothing changes.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { createInitialState } from './sidebar'
import { TREE_DRAWN_DEPTH, settleTree, treeRows, type TreeRow } from './tab-tree'

// ---------- the computation as it was before the one-pass version (reference) ----------

type Tabs = readonly TabItem[]
const mayHang = (child: TabItem, parent: TabItem): boolean => child.id !== parent.id && child.spaceId === parent.spaceId && !child.pinned && !parent.pinned
const hasMarks = (tabs: Tabs): boolean => tabs.some((t) => t.parentId !== undefined || t.treeCollapsed !== undefined)
function withoutTree(tab: TabItem): TabItem {
  if (tab.parentId === undefined && tab.treeCollapsed === undefined) return tab
  const { parentId: _parent, treeCollapsed: _folded, ...rest } = tab
  return rest
}
function resolveParents(prev: Tabs, next: Tabs): Map<string, string> {
  const live = new Map(next.map((t) => [t.id, t]))
  const before = new Map(prev.map((t) => [t.id, t.parentId]))
  const out = new Map<string, string>()
  for (const tab of next) {
    const seen = new Set<string>()
    for (let candidate = tab.parentId; candidate !== undefined && !seen.has(candidate); candidate = before.get(candidate)) {
      seen.add(candidate)
      const parent = live.get(candidate)
      if (parent && mayHang(tab, parent)) {
        out.set(tab.id, candidate)
        break
      }
    }
  }
  return out
}
function treeSequence(list: Tabs, parents: ReadonlyMap<string, string>, cut: Set<string>): TabItem[] {
  const children = new Map<string, TabItem[]>()
  for (const tab of list) {
    const parent = parents.get(tab.id)
    if (parent === undefined) continue
    const siblings = children.get(parent)
    if (siblings) siblings.push(tab)
    else children.set(parent, [tab])
  }
  const seen = new Set<string>()
  const out: TabItem[] = []
  const walk = (root: TabItem) => {
    const stack = [root]
    for (let tab = stack.pop(); tab !== undefined; tab = stack.pop()) {
      if (seen.has(tab.id)) continue
      seen.add(tab.id)
      out.push(tab)
      const below = children.get(tab.id)
      if (below) for (let i = below.length - 1; i >= 0; i--) stack.push(below[i]!)
    }
  }
  for (const tab of list) if (!parents.has(tab.id)) walk(tab)
  for (const tab of list) {
    if (seen.has(tab.id)) continue
    cut.add(tab.id)
    walk(tab)
  }
  return out
}
function referenceSettleTree(prev: SidebarState, next: SidebarState): SidebarState {
  const marked = hasMarks(next.tabs)
  if (!next.settings.tabTree) return marked ? { ...next, tabs: next.tabs.map(withoutTree) } : next
  if (!marked) return next
  const parents = resolveParents(prev.tabs, next.tabs)
  const tabs = [...next.tabs]
  const cut = new Set<string>()
  for (const spaceId of new Set(next.tabs.filter((t) => parents.has(t.id)).map((t) => t.spaceId))) {
    const slots = tabs.flatMap((t, i) => (t.spaceId === spaceId && !t.pinned ? [i] : []))
    const sequence = treeSequence(slots.map((i) => tabs[i]!), parents, cut)
    slots.forEach((slot, k) => (tabs[slot] = sequence[k]!))
  }
  for (const id of cut) parents.delete(id)
  const folded = new Set(tabs.filter((t) => t.treeCollapsed === true).map((t) => t.id))
  if (prev !== next) {
    for (const [spaceId, shown] of Object.entries(next.activeTabBySpace)) {
      if (shown === null || prev.activeTabBySpace[spaceId] === shown) continue
      for (let up = parents.get(shown); up !== undefined; up = parents.get(up)) folded.delete(up)
    }
  }
  const parentsWithChildren = new Set(parents.values())
  let changed = false
  const settled = tabs.map((tab, i) => {
    const parentId = parents.get(tab.id)
    const fold = folded.has(tab.id) && parentsWithChildren.has(tab.id)
    if (tab.parentId === parentId && (tab.treeCollapsed === true) === fold) {
      if (tab !== next.tabs[i]) changed = true
      return tab
    }
    changed = true
    return { ...withoutTree(tab), ...(parentId !== undefined ? { parentId } : {}), ...(fold ? { treeCollapsed: true as const } : {}) }
  })
  return changed ? { ...next, tabs: settled } : next
}

function referenceTreeRows(tabs: Tabs): Map<string, TreeRow> {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const depths = new Map<string, number>()
  for (const tab of tabs) {
    const path: TabItem[] = []
    const walking = new Set<string>()
    let at: TabItem | undefined = tab
    while (at !== undefined && !depths.has(at.id) && !walking.has(at.id)) {
      path.push(at)
      walking.add(at.id)
      at = at.parentId === undefined ? undefined : byId.get(at.parentId)
    }
    let depth = at !== undefined && depths.has(at.id) ? depths.get(at.id)! + 1 : 0
    for (let i = path.length - 1; i >= 0; i--) depths.set(path[i]!.id, depth++)
  }
  const below = new Map<string, number>()
  for (const tab of [...tabs].sort((a, b) => depths.get(b.id)! - depths.get(a.id)!)) {
    const parent = tab.parentId === undefined ? undefined : byId.get(tab.parentId)
    if (parent !== undefined && depths.get(parent.id) === depths.get(tab.id)! - 1) below.set(parent.id, (below.get(parent.id) ?? 0) + (below.get(tab.id) ?? 0) + 1)
  }
  const rows = new Map<string, TreeRow>()
  for (const tab of tabs) {
    const under = below.get(tab.id) ?? 0
    if (under === 0 && tab.parentId === undefined) continue
    rows.set(tab.id, { depth: Math.min(depths.get(tab.id)!, TREE_DRAWN_DEPTH), below: under, folded: tab.treeCollapsed === true && under > 0 })
  }
  return rows
}

// ---------- random states ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomState(rand: () => number): SidebarState {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const base = createInitialState({ now: 1, newId: () => 'space-0' })
  const spaceIds = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => `space-${i}`)
  const count = Math.floor(rand() * 60)
  const ids = Array.from({ length: count }, (_, i) => `tab-${i}`)
  const tabs: TabItem[] = ids.map((id) => {
    const roll = rand()
    // Parents of every kind: none, another tab (often of the same space), itself, a tab that does not exist.
    const parentId = roll < 0.45 ? undefined : roll < 0.88 ? pick(ids) : roll < 0.92 ? id : roll < 0.96 ? 'closed-tab' : `gone-${Math.floor(rand() * 5)}`
    return {
      id,
      spaceId: pick(spaceIds),
      url: `https://${id}.example/`,
      title: id,
      pinned: rand() < 0.2,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(rand() < 0.2 ? { treeCollapsed: true as const } : {}),
      createdAt: 1,
      lastActiveAt: 1
    }
  })
  return {
    ...base,
    spaces: spaceIds.map((id) => ({ ...base.spaces[0]!, id })),
    tabs,
    settings: { ...base.settings, tabTree: rand() < 0.85 },
    activeSpaceId: spaceIds[0]!,
    activeTabBySpace: Object.fromEntries(spaceIds.map((id) => [id, ids.length > 0 && rand() < 0.8 ? pick(ids) : null]))
  }
}

/** The state before an action: the same one (the case of `normalize`), or one whose tabs, parents, order or selection differ. */
function randomPrev(rand: () => number, next: SidebarState): SidebarState {
  const roll = rand()
  if (roll < 0.25) return next
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const ids = next.tabs.map((t) => t.id)
  let tabs = next.tabs.map((t) => (rand() < 0.3 && ids.length > 0 ? { ...t, parentId: pick(ids) } : t))
  // A tab the action closed: its children hang under its own parent afterwards.
  if (rand() < 0.4 && tabs.length > 0) tabs = [...tabs, { ...tabs[0]!, id: 'closed-tab', parentId: pick(ids) }]
  if (rand() < 0.3) tabs = [...tabs].reverse()
  const activeTabBySpace = Object.fromEntries(Object.keys(next.activeTabBySpace).map((id) => [id, ids.length > 0 && rand() < 0.5 ? pick(ids) : next.activeTabBySpace[id] ?? null]))
  return { ...next, tabs, activeTabBySpace }
}

describe('settleTree in one pass over the tabs', () => {
  it('gives the state the per-space passes gave, on random states', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = mulberry32(seed)
      const next = randomState(rand)
      const prev = randomPrev(rand, next)
      const expected = referenceSettleTree(prev, next)
      const actual = settleTree(prev, next)
      expect(actual, `seed ${seed}`).toEqual(expected)
      // The same object when nothing changes: the reducer tells "no new state" by it.
      expect(actual === next, `seed ${seed}: same object`).toBe(expected === next)
    }
  })

  it('settles a state of fifty spaces with a tree in each, as before', () => {
    const rand = mulberry32(42)
    const base = createInitialState({ now: 1, newId: () => 'space-0' })
    const spaceIds = Array.from({ length: 50 }, (_, i) => `space-${i}`)
    const tabs: TabItem[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `tab-${i}`,
      spaceId: spaceIds[i % 50]!,
      url: `https://t${i}.example/`,
      title: `t${i}`,
      pinned: i % 10 === 0,
      ...(i >= 50 && rand() < 0.4 ? { parentId: `tab-${i - 50 * (1 + Math.floor(rand() * 3))}` } : {}),
      createdAt: 1,
      lastActiveAt: 1
    }))
    const state: SidebarState = { ...base, spaces: spaceIds.map((id) => ({ ...base.spaces[0]!, id })), tabs, settings: { ...base.settings, tabTree: true }, activeSpaceId: spaceIds[0]!, activeTabBySpace: {} }
    const settled = settleTree(state, state)
    expect(settled).toEqual(referenceSettleTree(state, state))
    expect(settleTree(settled, settled)).toBe(settled)
  })
})

describe('treeRows level by level', () => {
  it('gives the rows the sorted pass gave, in the same order, on random lists', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = mulberry32(seed)
      const tabs = randomState(rand).tabs
      // An id twice (a damaged file) now and then.
      const list = tabs.length > 2 && rand() < 0.15 ? [...tabs, { ...tabs[1]!, parentId: tabs[0]!.id }] : tabs
      expect([...treeRows(list).entries()], `seed ${seed}`).toEqual([...referenceTreeRows(list).entries()])
    }
  })

  it('gives the rows of a long chain and of a wide tree, as before', () => {
    const tab = (i: number, parent?: number): TabItem => ({ id: `t${i}`, spaceId: 's', url: `https://t${i}.example/`, title: `t${i}`, pinned: false, ...(parent !== undefined ? { parentId: `t${parent}` } : {}), ...(i % 7 === 0 ? { treeCollapsed: true as const } : {}), createdAt: 1, lastActiveAt: 1 })
    const chain = Array.from({ length: 3000 }, (_, i) => tab(i, i === 0 ? undefined : i - 1))
    const wide = Array.from({ length: 3000 }, (_, i) => tab(i, i === 0 ? undefined : Math.floor((i - 1) / 3)))
    for (const list of [chain, [...chain].reverse(), wide, [...wide].reverse()]) expect([...treeRows(list).entries()]).toEqual([...referenceTreeRows(list).entries()])
  })
})
