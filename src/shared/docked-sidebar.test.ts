// What the docked sidebar (« barre collée ») shows of a space: the pinned tabs as the full sidebar draws them (the favourites of the top of the sidebar are
// left out), or the favourites when the space has no pinned tab; the tile of the site on screen, the unread counts and dots of the rows, and the shortcut
// ⌘n of each pinned tab's row. Tabs are named by their host (a.fr, b.fr…).

import { describe, expect, it } from 'vitest'
import type { RuntimeState, SidebarState, TabRuntime } from './model'
import { createInitialState, reduce, type Action } from './sidebar'
import { dockColumn } from './docked-sidebar'

let counter = 0
const ctx = { now: 1_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const awake: TabRuntime = { loading: false, audible: false, muted: false, awake: true }
const none: Pick<RuntimeState, 'tabs'> = { tabs: {} }

/**
 * a, b, c, d, e opened in Today; d and b pinned (in that order), e in the folder F (pinned), a and c left in Today: the sidebar reads d, b, F[e], a, c.
 * Two favourites, Mail and Agenda; a second space with a pinned tab of its own.
 */
function arranged(over: Partial<SidebarState['settings']> = {}) {
  let s = run(createInitialState(ctx), { type: 'settings/update', patch: over })
  for (const n of ['a', 'b', 'c', 'd', 'e']) s = run(s, { type: 'tab/open', url: `https://${n}.fr/`, background: true })
  const id = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  s = run(s, { type: 'tab/pin', id: id('d') }, { type: 'folder/create', name: 'F' })
  s = run(s, { type: 'tab/move', id: id('e'), toIndex: 0, pinned: true, folderId: s.folders[0]!.id }, { type: 'tab/pin', id: id('b') })
  s = run(s, { type: 'favorite/add', url: 'https://mail.example/', title: 'Mail' }, { type: 'favorite/add', url: 'https://agenda.example/', title: 'Agenda' })
  const space = s.spaces[0]!.id
  s = run(s, { type: 'space/create', name: 'Autre', emoji: '🎨', hue: 40 }, { type: 'tab/open', url: 'https://other.fr/', background: true })
  s = run(s, { type: 'tab/pin', id: s.tabs.find((t) => t.url === 'https://other.fr/')!.id }, { type: 'space/select', id: space })
  return { s, id, space }
}

/** The same window with none of its tabs pinned (the folder F stays, empty): the favourites, Mail and Agenda, are the column. */
function withoutPinned() {
  const arrangement = arranged()
  const unpin = ['d', 'b', 'e'].map((n): Action => ({ type: 'tab/unpin', id: arrangement.id(n) }))
  return { ...arrangement, s: run(arrangement.s, ...unpin) }
}

const names = (tiles: Array<{ title: string; url: string }>) => tiles.map((tile) => tile.url.split('/')[2]!.replace('.fr', '').replace('.example', ''))

describe('the column of a space', () => {
  it('lists the pinned tabs in the order the sidebar draws them (a folder’s tabs included), never the favourites, the Today tabs nor another space’s', () => {
    const { s, space } = arranged()
    const column = dockColumn(s, space, none)
    expect(names(column.pinned)).toEqual(['d', 'b', 'e'])
    expect(column.pinned.map((tile) => tile.kind)).toEqual(['tab', 'tab', 'tab'])
    // The favourites of the top of the sidebar (Mail, Agenda) are not in the column of a space that has pinned tabs.
    expect(column.favorites).toEqual([])
    const other = dockColumn(s, s.spaces[1]!.id, none)
    expect(names(other.pinned)).toEqual(['other'])
    expect(other.favorites).toEqual([])
  })

  it('lists the favourites in the order the sidebar draws them when the space has no pinned tab, rather than an empty column, and still no Today tab', () => {
    const { s, space } = withoutPinned()
    const column = dockColumn(s, space, none)
    expect(names(column.favorites)).toEqual(['mail', 'agenda'])
    expect(column.favorites.map((tile) => tile.kind)).toEqual(['favorite', 'favorite'])
    expect(column.pinned).toEqual([])
    // The tabs a, b, c, d, e are in Today now, and none of them is a tile.
    expect(s.tabs.filter((t) => !t.pinned && t.favoriteId === undefined).length).toBeGreaterThanOrEqual(5)
  })

  it('gives the favourites back as soon as the last pinned tab is unpinned, and takes them away when a tab is pinned again', () => {
    const { s, id, space } = arranged()
    const [d, b, e] = ['d', 'b', 'e'].map(id) as [string, string, string]
    const last = run(s, { type: 'tab/unpin', id: d }, { type: 'tab/unpin', id: e })
    expect(names(dockColumn(last, space, none).pinned)).toEqual(['b'])
    expect(dockColumn(last, space, none).favorites).toEqual([])
    const none_ = run(last, { type: 'tab/unpin', id: b })
    expect(names(dockColumn(none_, space, none).favorites)).toEqual(['mail', 'agenda'])
    const again = run(none_, { type: 'tab/pin', id: d })
    expect(dockColumn(again, space, none).favorites).toEqual([])
    expect(names(dockColumn(again, space, none).pinned)).toEqual(['d'])
  })

  it('keeps a tab of a collapsed folder: the column has no folder to open', () => {
    const { s, space } = arranged()
    const closed = run(s, { type: 'folder/toggle', id: s.folders[0]!.id })
    expect(names(dockColumn(closed, space, none).pinned)).toEqual(['d', 'b', 'e'])
  })

  it('names a tab by the name the user gave it', () => {
    const { s, id, space } = arranged()
    const renamed = run(s, { type: 'tab/rename', id: id('d'), title: 'Discussions' })
    expect(dockColumn(renamed, space, none).pinned[0]!.title).toBe('Discussions')
  })

  it('marks the site on screen: the pinned tab selected, or the favourite whose page is selected (a space without pinned tab), and nothing for a Today tab', () => {
    const { s, id, space } = arranged()
    const pinnedOn = dockColumn(run(s, { type: 'tab/select', id: id('b') }), space, none)
    expect(pinnedOn.pinned.map((tile) => tile.active)).toEqual([false, true, false])
    const favorite = s.favorites.find((f) => f.title === 'Agenda')!
    // With pinned tabs the favourite is not a tile: its page on screen marks none.
    const favoriteHidden = dockColumn(run(s, { type: 'favorite/open', id: favorite.id, spaceId: space }), space, none)
    expect([...favoriteHidden.favorites, ...favoriteHidden.pinned].some((tile) => tile.active)).toBe(false)
    const todayOn = dockColumn(run(s, { type: 'tab/select', id: id('a') }), space, none)
    expect([...todayOn.favorites, ...todayOn.pinned].some((tile) => tile.active)).toBe(false)
    const bare = withoutPinned()
    const agenda = bare.s.favorites.find((f) => f.title === 'Agenda')!
    const favoriteOn = dockColumn(run(bare.s, { type: 'favorite/open', id: agenda.id, spaceId: bare.space }), bare.space, none)
    expect(favoriteOn.favorites.map((tile) => tile.active)).toEqual([false, true])
    const bareTodayOn = dockColumn(run(bare.s, { type: 'tab/select', id: bare.id('a') }), bare.space, none)
    expect(bareTodayOn.favorites.some((tile) => tile.active)).toBe(false)
  })

  it('carries the unread count of the page, a favourite’s (a space without pinned tab) from the page it opened', () => {
    const { s, id, space } = arranged()
    const column = dockColumn(s, space, { tabs: { [id('b')]: { ...awake, unread: 12 } } })
    expect(column.pinned.map((tile) => tile.unread)).toEqual([undefined, 12, undefined])
    const bare = withoutPinned()
    const favorite = bare.s.favorites.find((f) => f.title === 'Mail')!
    const opened = run(bare.s, { type: 'favorite/open', id: favorite.id, spaceId: bare.space })
    const page = opened.tabs.find((t) => t.favoriteId === favorite.id)!
    expect(dockColumn(opened, bare.space, { tabs: { [page.id]: { ...awake, unread: 3 } } }).favorites.map((tile) => tile.unread)).toEqual([3, undefined])
  })

  it('shows the dot of an icon that changed only with the marks of the rows on (tabStateBadges), as the full sidebar does', () => {
    const changed = (_state: SidebarState, tab: string): Pick<RuntimeState, 'tabs'> => ({ tabs: { [tab]: { ...awake, changedIcon: true } } })
    const off = arranged({ tabStateBadges: false })
    expect(dockColumn(off.s, off.space, changed(off.s, off.id('d'))).pinned[0]!.dot).toBe(false)
    const on = arranged({ tabStateBadges: true })
    expect(dockColumn(on.s, on.space, changed(on.s, on.id('d'))).pinned.map((tile) => tile.dot)).toEqual([true, false, false])
  })

  it('shows the dot of a favourite from the page it opened, with the marks of the rows on, in a space without pinned tab', () => {
    const bare = withoutPinned()
    const on = run(bare.s, { type: 'settings/update', patch: { tabStateBadges: true } })
    const favorite = on.favorites.find((f) => f.title === 'Agenda')!
    const opened = run(on, { type: 'favorite/open', id: favorite.id, spaceId: bare.space })
    const page = opened.tabs.find((t) => t.favoriteId === favorite.id)!
    expect(dockColumn(opened, bare.space, { tabs: { [page.id]: { ...awake, changedIcon: true } } }).favorites.map((tile) => tile.dot)).toEqual([false, true])
    const off = run(opened, { type: 'settings/update', patch: { tabStateBadges: false } })
    expect(dockColumn(off, bare.space, { tabs: { [page.id]: { ...awake, changedIcon: true } } }).favorites.map((tile) => tile.dot)).toEqual([false, false])
  })

  it('gives a pinned tab the shortcut of its row (⌘1 … ⌘9, as the user set them), and a favourite none', () => {
    const { s, space } = arranged()
    expect(dockColumn(s, space, none).pinned.map((tile) => tile.shortcut)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3'])
    const bare = withoutPinned()
    expect(dockColumn(bare.s, bare.space, none).favorites.map((tile) => tile.shortcut)).toEqual([undefined, undefined])
    const moved = run(s, { type: 'settings/update', patch: { keyBindings: { item2: 'CmdOrCtrl+Alt+2', item3: '' } } })
    expect(dockColumn(moved, space, none).pinned.map((tile) => tile.shortcut)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+Alt+2', undefined])
  })

  it('gives no shortcut to a tab beyond the ninth row, nor to a tab of a collapsed folder (⌘n does not reach them)', () => {
    let { s, space } = arranged()
    for (let n = 0; n < 9; n++) s = run(s, { type: 'tab/open', url: `https://p${n}.fr/`, background: true })
    for (const tab of s.tabs.filter((t) => t.url.startsWith('https://p'))) s = run(s, { type: 'tab/pin', id: tab.id })
    const shortcuts = dockColumn(s, space, none).pinned.map((tile) => tile.shortcut)
    expect(shortcuts.filter((shortcut) => shortcut !== undefined)).toHaveLength(9)
    expect(shortcuts.at(-1)).toBeUndefined()
    const closed = arranged()
    const folded = run(closed.s, { type: 'folder/toggle', id: closed.s.folders[0]!.id })
    expect(dockColumn(folded, closed.space, none).pinned.map((tile) => tile.shortcut)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', undefined])
  })

  it('gives the tiles of a space that is not on screen no shortcut (⌘n goes to the rows of the space on screen)', () => {
    const { s } = arranged()
    const other = s.spaces[1]!.id
    expect(dockColumn(s, other, none).pinned.map((tile) => [tile.title, tile.shortcut])).toEqual([[expect.any(String), undefined]])
  })
})
