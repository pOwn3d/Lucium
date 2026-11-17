// The tab tree (Réglages › Fonctions › Arbre d’onglets). A tab opened from a link hangs under the tab it came from: indented in the sidebar,
// folded away with its branch. Pure rules, no Electron: the reducer (sidebar.ts) applies them after every action, the sidebar draws them.
//
// The data is `TabItem.parentId` (and `treeCollapsed` on a parent). One invariant makes everything else work unchanged: in `SidebarState.tabs`,
// the Today tabs of a space come in the order of the tree (a tab, then its whole branch). The array order is what the sidebar, the arrow
// shortcuts, a ⇧-click range and every move by position already use, so none of them knows about the tree. `settleTree` restores the
// invariant after any action, so that an action never has to.

import { isListedTab, type SidebarState, type TabItem } from './model'

/** A branch is indented as a folder's content is in the sidebar: 16 px a level. */
export const TREE_INDENT = 16
/** Levels that are drawn deeper: a chain of links opened from links goes on for ever, the sidebar is 323 px wide. */
export const TREE_DRAWN_DEPTH = 6

type Tabs = readonly TabItem[]

/** A tab can hang under another one of its own space; a pinned tab is a place of its own and is neither a parent nor a child. */
const mayHang = (child: TabItem, parent: TabItem): boolean => child.id !== parent.id && child.spaceId === parent.spaceId && !child.pinned && !parent.pinned

const hasMarks = (tabs: Tabs): boolean => tabs.some((t) => t.parentId !== undefined || t.treeCollapsed !== undefined)

function withoutTree(tab: TabItem): TabItem {
  if (tab.parentId === undefined && tab.treeCollapsed === undefined) return tab
  const { parentId: _parent, treeCollapsed: _folded, ...rest } = tab
  return rest
}

/**
 * The parent each tab really has: its own `parentId` when that tab exists and may be one, else the nearest ancestor (as `prev` had them)
 * that still can be. A parent that leaves (closed, archived, pinned, sent to another space) therefore hands its children to its own parent
 * rather than dropping them to the root. A tab with none is not in the map.
 */
function resolveParents(prev: Tabs, next: Tabs): Map<string, string> {
  const live = new Map(next.map((t) => [t.id, t]))
  const before = new Map(prev.map((t) => [t.id, t.parentId]))
  const out = new Map<string, string>()
  for (const tab of next) {
    // Most tabs hang under nothing: no set is made for them.
    if (tab.parentId === undefined) continue
    const seen = new Set<string>()
    for (let candidate: string | undefined = tab.parentId; candidate !== undefined && !seen.has(candidate); candidate = before.get(candidate)) {
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

/** The tabs in the order of the tree: roots as they come, each followed by its branch (children as they come). `cut` collects tabs that sit on a cycle. */
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
  // What no root reaches is a loop of parents: it is cut where it is first met, and its tabs hang under that one.
  for (const tab of list) {
    if (seen.has(tab.id)) continue
    cut.add(tab.id)
    walk(tab)
  }
  return out
}

/**
 * Makes the tree of `next` hold again after an action that took the state from `prev` to `next`; the same object when it already does.
 * - The setting off: no tab keeps a parent or a folded branch (the rows keep their order, so the list is as flat as the tree was drawn).
 * - A parent that cannot be one (gone, pinned, another space, itself) is replaced by the nearest ancestor that can; a loop is cut.
 * - The Today tabs of each space with a tree come in the order of the tree.
 * - A folded mark is kept only on a tab that has children, and a tab that has just been selected is never hidden in a folded branch.
 */
export function settleTree(prev: SidebarState, next: SidebarState): SidebarState {
  const marked = hasMarks(next.tabs)
  if (!next.settings.tabTree) return marked ? { ...next, tabs: next.tabs.map(withoutTree) } : next
  if (!marked) return next

  const parents = resolveParents(prev.tabs, next.tabs)
  const tabs = [...next.tabs]
  const cut = new Set<string>()
  // The places of the Today tabs of each space that has a branch, found in one pass over the tabs (not one pass per space: with fifty spaces and
  // thousands of tabs, that was most of the cost of every action). Each space is put in order within its own places, so the order of the spaces is free.
  const treeSpaces = new Set<string>()
  for (const tab of next.tabs) if (parents.has(tab.id)) treeSpaces.add(tab.spaceId)
  const slotsOf = new Map<string, number[]>()
  next.tabs.forEach((tab, i) => {
    if (tab.pinned || !treeSpaces.has(tab.spaceId)) return
    const slots = slotsOf.get(tab.spaceId)
    if (slots) slots.push(i)
    else slotsOf.set(tab.spaceId, [i])
  })
  for (const slots of slotsOf.values()) {
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

/** `ids` and every tab below them, as a set (the tabs may come in any order). */
export function branchIds(tabs: Tabs, ids: Iterable<string>): Set<string> {
  const children = new Map<string, string[]>()
  for (const tab of tabs) {
    if (tab.parentId === undefined) continue
    const siblings = children.get(tab.parentId)
    if (siblings) siblings.push(tab.id)
    else children.set(tab.parentId, [tab.id])
  }
  const out = new Set<string>()
  const stack = [...ids]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  return out
}

/** The tab's children (one level). */
export const childrenOf = (tabs: Tabs, id: string): TabItem[] => tabs.filter((t) => t.parentId === id)

/** The tab and everything below it, in the order of the list (which is the order of the tree). */
export function branchOf(tabs: Tabs, id: string): TabItem[] {
  const branch = branchIds(tabs, [id])
  return tabs.filter((t) => branch.has(t.id))
}

/** How many levels a tab is below the root (0 for a root). Bounded, so that a damaged list cannot loop. */
export function treeDepth(tabs: Tabs, id: string): number {
  const parentOf = new Map(tabs.map((t) => [t.id, t.parentId]))
  let depth = 0
  for (let up = parentOf.get(id); up !== undefined && depth <= tabs.length; up = parentOf.get(up)) depth++
  return depth
}

/** The tabs a folded branch hides: everything below a tab whose `treeCollapsed` is set. */
export function foldedAway(tabs: Tabs): Set<string> {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const hidden = new Set<string>()
  for (const tab of tabs) {
    if (tab.parentId === undefined) continue
    for (let up = byId.get(tab.parentId), hops = 0; up !== undefined && hops <= tabs.length; up = up.parentId === undefined ? undefined : byId.get(up.parentId), hops++) {
      if (up.treeCollapsed === true) {
        hidden.add(tab.id)
        break
      }
    }
  }
  return hidden
}

/** The ancestors of a tab whose folded branch hides it, nearest first: what "Révéler l’onglet dans la barre latérale" has to open. */
export function foldedAncestors(tabs: Tabs, id: string): string[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const out: string[] = []
  for (let up = byId.get(id)?.parentId, hops = 0; up !== undefined && hops <= tabs.length; hops++) {
    const parent = byId.get(up)
    if (!parent) break
    if (parent.treeCollapsed === true) out.push(parent.id)
    up = parent.parentId
  }
  return out
}

/** What dropping on a row of the tree means for the tab(s) dragged: the parent they get (null: none), and where they go among the Today tabs of the space once they are out of it. */
export interface TreeSlot {
  parentId: string | null
  toIndex: number
}

/** The Today tabs of `ref`'s space once `moved` are out of them: the list a position is counted in (see `moveTabs`). */
/** The Today tabs the sidebar lists, without the dragged ones: the page of an open favourite is a tab that no row shows, and `tab/move` counts the places without it. */
const todayWithout = (tabs: Tabs, ref: TabItem, moved: ReadonlySet<string>): TabItem[] => tabs.filter((t) => t.spaceId === ref.spaceId && !t.pinned && isListedTab(t) && !moved.has(t.id))

/** Just past the last tab of the branch of `ref` in `list`: where a tab that becomes its last descendant, or its next sibling, goes. */
export function afterBranch(list: Tabs, ref: TabItem): number {
  const branch = branchIds(list, [ref.id])
  let end = list.findIndex((t) => t.id === ref.id) + 1
  list.forEach((t, i) => branch.has(t.id) && (end = Math.max(end, i + 1)))
  return end
}

/**
 * Where a tab dropped on the row of `ref` goes in the tree. `moved` is the whole dragged branch (the tabs and everything below them).
 * Before a row: a sibling of it, just above. After a row: its first child when the row shows children, else a sibling just below its branch.
 * Inside a row: its last child. Null when the row is not a place for it (a pinned tab, a tab of the dragged branch).
 */
export function treeDropSlot(tabs: Tabs, moved: ReadonlySet<string>, ref: TabItem, edge: 'before' | 'after' | 'inside'): TreeSlot | null {
  const group = todayWithout(tabs, ref, moved)
  // A pinned row, a row of the dragged branch and a row of another space are not in the list: no place there.
  const at = group.findIndex((t) => t.id === ref.id)
  if (at === -1) return null
  if (edge === 'before') return { parentId: ref.parentId ?? null, toIndex: at }
  if (edge === 'inside') return { parentId: ref.id, toIndex: afterBranch(group, ref) }
  const open = ref.treeCollapsed !== true && group.some((t) => t.parentId === ref.id)
  return open ? { parentId: ref.id, toIndex: at + 1 } : { parentId: ref.parentId ?? null, toIndex: afterBranch(group, ref) }
}

/** Where a tab goes to leave its parent for good: a sibling of that parent, just below its branch. Null for a tab that has no parent. */
export function treeOutdentSlot(tabs: Tabs, tab: TabItem): TreeSlot | null {
  const parent = tab.parentId === undefined ? undefined : tabs.find((t) => t.id === tab.parentId)
  if (!parent) return null
  const moved = branchIds(tabs, [tab.id])
  return { parentId: parent.parentId ?? null, toIndex: afterBranch(todayWithout(tabs, parent, moved), parent) }
}

/** What a row of the tree draws: how deep it sits, how many tabs hang under it (children and what is below them), and whether they are folded away. */
export interface TreeRow {
  depth: number
  below: number
  folded: boolean
}

/** The rows of the tree for every tab that is in it (a root with no child is not listed: it is drawn as a flat row). The depth is capped to what is drawn. */
export function treeRows(tabs: Tabs): Map<string, TreeRow> {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  // Loops, never calls of itself: a chain of thousands of tabs (a prepared state file) must not fill the stack, and each tab is walked once.
  const depths = new Map<string, number>()
  // The tabs walked so far: one set for every walk, where a set made for each tab cost more than the rest (the sidebar works this out at each
  // snapshot). A tab of an earlier walk has its depth already, so only a tab of this very path can be met here again.
  const walked = new Set<string>()
  for (const tab of tabs) {
    const path: TabItem[] = []
    let at: TabItem | undefined = tab
    // Up to a tab whose depth is known, to a root, or back to a tab of this very path (a damaged list: the loop is cut there).
    while (at !== undefined && !depths.has(at.id) && !walked.has(at.id)) {
      path.push(at)
      walked.add(at.id)
      at = at.parentId === undefined ? undefined : byId.get(at.parentId)
    }
    let depth = at !== undefined && depths.has(at.id) ? depths.get(at.id)! + 1 : 0
    for (let i = path.length - 1; i >= 0; i--) depths.set(path[i]!.id, depth++)
  }
  // Every tab counts once for each of its ancestors: the deepest first, each hands its own count to its parent (one pass, whatever the depth).
  // The tabs are taken level by level: within a level the order does not matter (a tab only adds to the level above), so no sort is needed.
  const levels: TabItem[][] = []
  for (const tab of tabs) {
    const depth = depths.get(tab.id)!
    const level = levels[depth]
    if (level) level.push(tab)
    else levels[depth] = [tab]
  }
  const below = new Map<string, number>()
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    for (const tab of levels[depth] ?? []) {
      const parent = tab.parentId === undefined ? undefined : byId.get(tab.parentId)
      // Only a parent that sits right above counts: where a loop was cut, the tab is a root.
      if (parent !== undefined && depths.get(parent.id) === depth - 1) below.set(parent.id, (below.get(parent.id) ?? 0) + (below.get(tab.id) ?? 0) + 1)
    }
  }
  const rows = new Map<string, TreeRow>()
  for (const tab of tabs) {
    const under = below.get(tab.id) ?? 0
    if (under === 0 && tab.parentId === undefined) continue
    rows.set(tab.id, { depth: Math.min(depths.get(tab.id)!, TREE_DRAWN_DEPTH), below: under, folded: tab.treeCollapsed === true && under > 0 })
  }
  return rows
}
