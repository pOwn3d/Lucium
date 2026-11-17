// A click on a favourite shows its page without adding a row to the list ("cela ouvre un onglet en bas", the user's report): the page is a tab of the space that no list
// shows, the tile stands for it, and a second click shows the same page again.

import { describe, expect, it } from 'vitest'
import { isListedTab, type SidebarState } from './model'
import { createInitialState, normalize, reduce, sidebarOrder, stepTab, visibleTabOrder, type Action } from './sidebar'

let counter = 0
const ctx = { now: 1_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A state with one favourite and a few ordinary tabs. */
function start(): { state: SidebarState; favoriteId: string } {
  let state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://one.example/' }, { type: 'tab/open', url: 'https://two.example/' }, { type: 'favorite/add', url: 'https://mail.example/', title: 'Mail' })
  return { state, favoriteId: state.favorites[0]!.id }
}

const listed = (state: SidebarState, spaceId: string) => state.tabs.filter((t) => t.spaceId === spaceId && isListedTab(t))

describe('favorite/open', () => {
  it('shows the page of the favourite and adds no row to the list', () => {
    const { state, favoriteId } = start()
    const space = state.activeSpaceId
    const rows = listed(state, space).map((t) => t.id)
    const after = run(state, { type: 'favorite/open', id: favoriteId })
    const page = after.tabs.find((t) => t.favoriteId === favoriteId)!
    expect(page).toMatchObject({ url: 'https://mail.example/', spaceId: space, pinned: false })
    expect(after.activeTabBySpace[space]).toBe(page.id)
    expect(listed(after, space).map((t) => t.id)).toEqual(rows)
    expect(isListedTab(page)).toBe(false)
  })

  it('shows the same page again at the second click, instead of making another', () => {
    const { state, favoriteId } = start()
    const once = run(state, { type: 'favorite/open', id: favoriteId })
    const page = once.tabs.find((t) => t.favoriteId === favoriteId)!
    const elsewhere = run(once, { type: 'tab/select', id: listed(once, once.activeSpaceId)[0]!.id })
    expect(elsewhere.activeTabBySpace[elsewhere.activeSpaceId]).not.toBe(page.id)
    const twice = run(elsewhere, { type: 'favorite/open', id: favoriteId })
    expect(twice.tabs.filter((t) => t.favoriteId === favoriteId)).toHaveLength(1)
    expect(twice.activeTabBySpace[twice.activeSpaceId]).toBe(page.id)
  })

  it('keeps one page per space: two spaces of one profile each have their own page of the favourite', () => {
    const { state, favoriteId } = start()
    const withSpace = run(state, { type: 'space/create', name: 'Perso 2', emoji: '🏡', hue: 100, profileId: state.spaces[0]!.profileId })
    const second = withSpace.spaces.find((s) => s.id !== state.activeSpaceId)!
    const first = run(withSpace, { type: 'favorite/open', id: favoriteId, spaceId: state.activeSpaceId })
    const both = run(first, { type: 'favorite/open', id: favoriteId, spaceId: second.id })
    const pages = both.tabs.filter((t) => t.favoriteId === favoriteId)
    expect(pages.map((t) => t.spaceId).sort()).toEqual([state.activeSpaceId, second.id].sort())
  })

  it('does not open a favourite of one profile in a space of another: its page would have the cookies of that other profile', () => {
    const { state, favoriteId } = start()
    const withWork = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    const work = withWork.spaces.find((s) => s.profileId === 'work')!
    // Asked for the space explicitly, and as the space the user is in (the new space is the active one).
    expect(run(withWork, { type: 'favorite/open', id: favoriteId, spaceId: work.id })).toBe(withWork)
    expect(withWork.activeSpaceId).toBe(work.id)
    expect(run(withWork, { type: 'favorite/open', id: favoriteId })).toBe(withWork)
  })

  it('does nothing for a favourite that is not there, or a space that is not', () => {
    const { state, favoriteId } = start()
    expect(run(state, { type: 'favorite/open', id: 'nobody' })).toBe(state)
    expect(run(state, { type: 'favorite/open', id: favoriteId, spaceId: 'no-space' })).toBe(state)
  })

  it('opens the page of a favourite whose address the tabs refuse as nothing at all, rather than as a half-made tab', () => {
    const { state, favoriteId } = start()
    const odd = { ...state, favorites: state.favorites.map((f) => ({ ...f, url: 'javascript:alert(1)' })) }
    const after = run(odd, { type: 'favorite/open', id: favoriteId })
    expect(after.tabs.some((t) => t.favoriteId !== undefined)).toBe(false)
    expect(after.tabs).toHaveLength(odd.tabs.length)
  })
})

describe('the page of a favourite among the other tabs', () => {
  const opened = () => {
    const { state, favoriteId } = start()
    const after = run(state, { type: 'favorite/open', id: favoriteId })
    return { state: after, favoriteId, page: after.tabs.find((t) => t.favoriteId === favoriteId)! }
  }

  it('is closed with its tab, and closing it does not go to the archive: the tile opens it again', () => {
    const { state, page } = opened()
    const after = run(state, { type: 'tab/close', id: page.id })
    expect(after.tabs.some((t) => t.id === page.id)).toBe(false)
    expect(after.archive).toEqual(state.archive)
    // Back to a row of the list, not to a page nobody sees.
    expect(listed(after, page.spaceId).map((t) => t.id)).toContain(after.activeTabBySpace[page.spaceId])
  })

  it('is not archived by the sweep of old tabs, though it is as old as the others', () => {
    const { state, page } = opened()
    const hour = 3_600_000
    const sweeping = { ...state, settings: { ...state.settings, autoArchiveHours: 12 }, tabs: state.tabs.map((t) => ({ ...t, lastActiveAt: 0 })) }
    // Another tab is on screen: the page of the favourite is not the one the sweep leaves because it is selected.
    const aside = { ...sweeping, activeTabBySpace: { ...sweeping.activeTabBySpace, [page.spaceId]: listed(sweeping, page.spaceId)[0]!.id } }
    const swept = reduce(aside, { type: 'archive/sweep' }, { now: 100 * hour, newId: ctx.newId })
    expect(swept.archive.length).toBeGreaterThan(0)
    expect(swept.tabs.some((t) => t.id === page.id)).toBe(true)
  })

  it('is not emptied with Today', () => {
    const { state, page } = opened()
    const aside = run(state, { type: 'tab/select', id: listed(state, page.spaceId)[0]!.id })
    const cleared = run(aside, { type: 'today/clear' })
    expect(cleared.tabs.some((t) => t.id === page.id)).toBe(true)
    expect(listed(cleared, page.spaceId)).toHaveLength(1)
  })

  it('is not counted when a tab is dropped in the list: the place is the one among the rows on screen', () => {
    // The page comes first in the state, before the two rows (a favourite opened first).
    const { state: base, favoriteId } = start()
    const fresh = { ...base, tabs: [] as SidebarState['tabs'], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: null } }
    const first = run(fresh, { type: 'favorite/open', id: favoriteId }, { type: 'tab/open', url: 'https://one.example/' }, { type: 'tab/open', url: 'https://two.example/' })
    const rows = listed(first, first.activeSpaceId)
    expect(first.tabs[0]!.favoriteId).toBe(favoriteId)
    // The first row dropped after the second: with two rows on screen, the end of the list is index 1 once it has left.
    const moved = run(first, { type: 'tab/move', id: rows[0]!.id, toIndex: 1, pinned: false })
    expect(listed(moved, moved.activeSpaceId).map((t) => t.id)).toEqual([rows[1]!.id, rows[0]!.id])
  })

  it('is not one of the rows a shortcut counts or a ⇧-click ranges over, and the next tab from it is the first row', () => {
    const { state: base, favoriteId } = start()
    const fresh = { ...base, tabs: [] as SidebarState['tabs'], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: null } }
    const built = run(fresh, { type: 'tab/open', url: 'https://one.example/' }, { type: 'tab/open', url: 'https://two.example/' }, { type: 'favorite/open', id: favoriteId })
    const [one, two, page] = built.tabs
    expect(sidebarOrder(built, built.activeSpaceId).map((t) => t.id)).toEqual([one!.id, two!.id])
    expect(visibleTabOrder(built, built.activeSpaceId).map((t) => t.id)).toEqual([one!.id, two!.id])
    expect(built.activeTabBySpace[built.activeSpaceId]).toBe(page!.id)
    expect(stepTab(built, 1)).toBe(one!.id)
    expect(stepTab(built, -1)).toBe(two!.id)
  })

  it('is not archived with "Close the other tabs" of a row', () => {
    const { state: base, favoriteId } = start()
    const fresh = { ...base, tabs: [] as SidebarState['tabs'], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: null } }
    const built = run(fresh, { type: 'tab/open', url: 'https://one.example/' }, { type: 'favorite/open', id: favoriteId }, { type: 'tab/open', url: 'https://two.example/' })
    const [one, page, two] = built.tabs
    const after = run(built, { type: 'tab/archive-group', id: one!.id, scope: 'others' })
    expect(after.tabs.map((t) => t.id)).toEqual([one!.id, page!.id])
    expect(after.archive.map((a) => a.id)).toEqual([two!.id])
  })

  it('does not take the focus when the tab next to it closes: the next row does', () => {
    const { state: base, favoriteId } = start()
    const fresh = { ...base, tabs: [] as SidebarState['tabs'], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: null } }
    const built = run(fresh, { type: 'tab/open', url: 'https://one.example/' }, { type: 'favorite/open', id: favoriteId }, { type: 'tab/open', url: 'https://two.example/' })
    const [one, , two] = built.tabs
    expect(built.tabs[1]!.favoriteId).toBe(favoriteId)
    const after = run(built, { type: 'tab/select', id: one!.id }, { type: 'tab/close', id: one!.id })
    expect(after.activeTabBySpace[after.activeSpaceId]).toBe(two!.id)
  })

  it('becomes a row of the list when it is pinned, and an ordinary tab when its favourite is removed', () => {
    const { state, page, favoriteId } = opened()
    const pinned = run(state, { type: 'tab/pin', id: page.id })
    expect(pinned.tabs.find((t) => t.id === page.id)).toMatchObject({ pinned: true })
    expect(pinned.tabs.find((t) => t.id === page.id)!.favoriteId).toBeUndefined()
    const removed = run(state, { type: 'favorite/remove', id: favoriteId })
    expect(removed.tabs.find((t) => t.id === page.id)!.favoriteId).toBeUndefined()
    expect(listed(removed, page.spaceId).map((t) => t.id)).toContain(page.id)
  })

  it('survives a save and a read of the state, and is an ordinary tab if the file no longer has its favourite', () => {
    const { state, page } = opened()
    const again = normalize(JSON.parse(JSON.stringify(state)))
    expect(again.tabs.find((t) => t.id === page.id)!.favoriteId).toBe(page.favoriteId)
    const lost = normalize({ ...JSON.parse(JSON.stringify(state)), favorites: [] })
    expect(lost.tabs.find((t) => t.id === page.id)!.favoriteId).toBeUndefined()
  })
})
