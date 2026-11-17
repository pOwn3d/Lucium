// ⌘1 … ⌘9 ("Aller à l’élément n de la barre latérale") go to the nth row the sidebar shows, from the top: the loose pinned tabs, each folder's tabs
// (the folders in the order they are drawn), then Today. What the sidebar does not show has no number: a tab in a collapsed folder, the page of a favourite
// (its tile stands for it), a tab under a folded branch of the tab tree. A split view is one row, at the place of its first tab.
// Tabs are named by their host (a.fr, b.fr…) so that the expected orders read as the screen does.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { createInitialState, reduce, type Action } from './sidebar'
import { tabOfItem } from './sidebar-items'

let counter = 0
const ctx = { now: 1_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const host = (t: TabItem | undefined): string | undefined => t?.url.split('/')[2]?.replace('.fr', '')

/** A state with these Today tabs, in this order, in the first space; `over` changes the settings first. */
function withTabs(names: string[], over: Partial<SidebarState['settings']> = {}) {
  let s = run(createInitialState(ctx), { type: 'settings/update', patch: over })
  for (const n of names) s = run(s, { type: 'tab/open', url: `https://${n}.fr/`, background: true })
  const at = (state: SidebarState) => (n: string) => state.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  return { s, id: at(s) }
}

/** What ⌘1 … ⌘9 select, as hosts (undefined where nothing is selected). */
const keys = (state: SidebarState, count = 9): Array<string | undefined> => Array.from({ length: count }, (_, i) => host(tabOfItem(state, i + 1)))

/** a, b, c, d, e with d and b pinned (in that order), e in a folder F, a and c left in Today: the sidebar reads d, b, F[e], a, c. */
function arranged() {
  const { s: opened, id } = withTabs(['a', 'b', 'c', 'd', 'e'])
  let s = run(opened, { type: 'tab/pin', id: id('d') }, { type: 'folder/create', name: 'F' })
  const folder = s.folders[0]!
  s = run(s, { type: 'tab/move', id: id('e'), toIndex: 0, pinned: true, folderId: folder.id }, { type: 'tab/pin', id: id('b') })
  return { s, id, folder }
}

describe('the item a number goes to', () => {
  it('counts the tabs of Today from the top', () => {
    const { s } = withTabs(['a', 'b', 'c'])
    expect(keys(s, 4)).toEqual(['a', 'b', 'c', undefined])
  })

  it('counts the pinned tabs first, then the folders’, then Today, whatever the order the tabs were made in', () => {
    const { s } = arranged()
    // The tabs of the state read e, d, b, a, c: the sidebar draws d, b, then the folder with e, then Today.
    expect(s.tabs.map(host)).not.toEqual(['d', 'b', 'e', 'a', 'c'])
    expect(keys(s, 6)).toEqual(['d', 'b', 'e', 'a', 'c', undefined])
  })

  it('does not number a tab the sidebar hides in a collapsed folder', () => {
    const { s, folder } = arranged()
    const closed = run(s, { type: 'folder/toggle', id: folder.id })
    expect(keys(closed, 5)).toEqual(['d', 'b', 'a', 'c', undefined])
    // Opened again, the folder’s tab has its number back.
    expect(keys(run(closed, { type: 'folder/toggle', id: folder.id }), 5)).toEqual(['d', 'b', 'e', 'a', 'c'])
  })

  it('does not number a tab in a folder inside a collapsed folder either', () => {
    const { s, id, folder } = arranged()
    const inner = run(s, { type: 'folder/create', name: 'G', parentId: folder.id })
    const sub = inner.folders.find((f) => f.name === 'G')!
    const placed = run(inner, { type: 'tab/move', id: id('a'), toIndex: 0, pinned: true, folderId: sub.id })
    expect(keys(placed, 5)).toEqual(['d', 'b', 'e', 'a', 'c'])
    expect(keys(run(placed, { type: 'folder/toggle', id: folder.id }), 5)).toEqual(['d', 'b', 'c', undefined, undefined])
  })

  it('does not number the page of a favourite, wherever it sits in the state', () => {
    let { s } = withTabs([])
    s = run(s, { type: 'favorite/add', url: 'https://mail.fr/', title: 'Mail' })
    // The favourite’s page is the first tab of the state, before the rows.
    s = run(s, { type: 'favorite/open', id: s.favorites[0]!.id }, { type: 'tab/open', url: 'https://a.fr/', background: true }, { type: 'tab/open', url: 'https://b.fr/', background: true })
    expect(s.tabs.map(host)).toEqual(['mail', 'a', 'b'])
    expect(keys(s, 3)).toEqual(['a', 'b', undefined])
  })

  it('does not number the tabs a folded branch of the tab tree hides', () => {
    const { s, id } = withTabs(['a', 'b', 'c'], { tabTree: true })
    const hung = { ...s, tabs: s.tabs.map((t) => (host(t) === 'b' ? { ...t, parentId: id('a') } : t)) }
    expect(keys(hung, 4)).toEqual(['a', 'b', 'c', undefined])
    const folded = run(hung, { type: 'tab/tree-collapse', id: id('a'), collapsed: true })
    expect(keys(folded, 4)).toEqual(['a', 'c', undefined, undefined])
  })

  it('counts a split view once, at the place of its first tab', () => {
    const { s, id } = withTabs(['a', 'b', 'c', 'd'])
    const split = run(s, { type: 'split/create', tabId: id('a'), withTabId: id('c') })
    expect(split.splits).toHaveLength(1)
    // The sidebar draws one row for a and c together, then b, then d.
    expect(keys(split, 4)).toEqual(['a', 'b', 'd', undefined])
  })

  it('counts a split view whose tabs sit in different lists once, at the place the sidebar draws its row', () => {
    const { s, id } = withTabs(['a', 'b', 'c', 'd'])
    const split = run(s, { type: 'split/create', tabId: id('a'), withTabId: id('c') })
    // c is pinned while it stays in the split view with a: the sidebar draws the pair once, at c (the first of its tabs, no folder), and a has no row in Today.
    const pinned = run(split, { type: 'tab/pin', id: id('c') })
    expect(pinned.splits).toHaveLength(1)
    expect(keys(pinned, 5)).toEqual(['c', 'b', 'd', undefined, undefined])
  })

  it('counts a split view of a Today tab and a folder tab at the place of the folder tab', () => {
    const { s, folder, id } = arranged()
    // A state saved before split views put their tabs together: c stayed in Today, e is in the folder.
    const split = { ...s, splits: [{ id: 'sv', spaceId: s.activeSpaceId, tabIds: [id('c'), id('e')], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }] }
    expect(split.tabs.find((t) => t.id === id('e'))?.folderId).toBe(folder.id)
    // d, b, F[e | c], a: the row stands at e, and c has none in Today.
    expect(keys(split, 5)).toEqual(['d', 'b', 'e', 'a', undefined])
  })

  it('counts the tabs of the current space only', () => {
    const { s } = withTabs(['a', 'b'])
    const elsewhere = run(s, { type: 'space/create', name: 'Autre', emoji: '🏡', hue: 100, profileId: s.spaces[0]!.profileId }, { type: 'tab/open', url: 'https://x.fr/', background: true })
    expect(elsewhere.activeSpaceId).not.toBe(s.activeSpaceId)
    expect(keys(elsewhere, 3)).toEqual(['x', undefined, undefined])
    expect(keys(run(elsewhere, { type: 'space/select', id: s.activeSpaceId }), 3)).toEqual(['a', 'b', undefined])
  })

  it('makes ⌘9 the ninth row, not the last one as other browsers do: the menu and the catalogue say « élément 9 », and with fewer rows it does nothing', () => {
    const twelve = withTabs(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']).s
    expect(host(tabOfItem(twelve, 9))).toBe('i')
    expect(host(tabOfItem(twelve, 9))).not.toBe('l')
    const eight = withTabs(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).s
    expect(tabOfItem(eight, 9)).toBeUndefined()
  })

  it('selects nothing for a number with no row', () => {
    const { s } = withTabs(['a'])
    expect(tabOfItem(s, 0)).toBeUndefined()
    expect(tabOfItem(s, 2)).toBeUndefined()
    expect(tabOfItem(s, 1.5)).toBeUndefined()
    expect(tabOfItem(s, Number.NaN)).toBeUndefined()
  })
})
