// Favourites belong to a profile, for someone who works in three windows on three profiles. Reproduced on a throw-away instance before
// the change: a favourite renamed or removed in a window on the profile "default" changed in a window on the profile "perso", and the list
// was the same in both.

import { describe, expect, it } from 'vitest'
import { bookmarkTree, bookmarkIndex } from './extension-data'
import { exportBookmarksHtml } from './bookmarks-html'
import { planDrop } from './dnd'
import { DEFAULT_PROFILE, favoriteProfile, favoritesOf, favoritesOfSpace, importedFavorites, scopeFavorites, withFavoriteAt, withProfileOrder } from './favorite-scope'
import type { Favorite, SidebarState, TabItem } from './model'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, type Action } from './sidebar'

let counter = 0
const ctx = { now: 1_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const titles = (list: readonly Favorite[]): string[] => list.map((f) => f.title)

/** Two spaces: "Maison" on the default profile and "Travail" on the profile "work"; the user is in the first. */
function twoProfiles(): { state: SidebarState; home: string; work: string } {
  const created = run(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
  const home = created.spaces.find((s) => s.profileId === 'default')!.id
  const work = created.spaces.find((s) => s.profileId === 'work')!.id
  return { state: run(created, { type: 'space/select', id: home }), home, work }
}

/** The same favourites in another order of the one list: interleaved, as a migrated file leaves them (each favourite next to its copy for the other profile). */
const interleave = (state: SidebarState, order: readonly string[]): SidebarState => ({ ...state, favorites: order.map((title) => state.favorites.find((f) => f.title === title)!) })

const add = (state: SidebarState, spaceId: string, title: string, url = `https://${title.toLowerCase()}.example/`, toIndex?: number): SidebarState =>
  run(state, { type: 'favorite/add', url, title, spaceId, ...(toIndex === undefined ? {} : { toIndex }) })

describe('the favourites of a profile', () => {
  it('are the ones added from a space of that profile, and no space of another profile lists them', () => {
    const { state, home, work } = twoProfiles()
    const after = add(add(state, home, 'Mail'), work, 'Courrier')
    expect(titles(favoritesOfSpace(after, home))).toEqual(['Mail'])
    expect(titles(favoritesOfSpace(after, work))).toEqual(['Courrier'])
    expect(favoritesOf(after, 'work').map((f) => f.profileId)).toEqual(['work'])
    expect(after.favorites).toHaveLength(2)
  })

  it('are added to the profile of the space the user is in when no space is named', () => {
    const { state, work } = twoProfiles()
    const inWork = run(state, { type: 'space/select', id: work }, { type: 'favorite/add', url: 'https://courrier.example/', title: 'Courrier' })
    expect(favoritesOf(inWork, 'work').map((f) => f.title)).toEqual(['Courrier'])
    expect(favoritesOf(inWork, 'default')).toEqual([])
  })

  it('may share an address with another profile, once in each', () => {
    const { state, home, work } = twoProfiles()
    const both = add(add(state, home, 'Mail', 'https://mail.example/'), work, 'Mail pro', 'https://mail.example/')
    expect(both.favorites).toHaveLength(2)
    // The same address again in a profile that has it changes nothing, whichever way it comes.
    expect(add(both, home, 'Encore', 'https://mail.example/')).toBe(both)
    expect(add(both, work, 'Encore', 'https://mail.example/')).toBe(both)
  })

  it('refuses to add to a space that does not exist', () => {
    const { state } = twoProfiles()
    expect(add(state, 'nowhere', 'Mail')).toBe(state)
  })

  it('count the place of a new one among the favourites of the profile, not among all of them', () => {
    const { state, home, work } = twoProfiles()
    let s = interleave(add(add(add(add(state, home, 'A'), work, 'W1'), home, 'B'), work, 'W2'), ['A', 'W1', 'B', 'W2'])
    expect(s.favorites.map((f) => f.title)).toEqual(['A', 'W1', 'B', 'W2'])
    // Index 1 of "home" is between A and B, whatever the work favourites around them.
    s = add(s, home, 'Milieu', undefined, 1)
    expect(titles(favoritesOfSpace(s, home))).toEqual(['A', 'Milieu', 'B'])
    expect(titles(favoritesOfSpace(s, work))).toEqual(['W1', 'W2'])
    // Past the end is the end of the profile's list.
    expect(titles(favoritesOfSpace(add(s, home, 'Fin', undefined, 99), home))).toEqual(['A', 'Milieu', 'B', 'Fin'])
    expect(titles(favoritesOfSpace(add(s, work, 'Zéro', undefined, 0), work))).toEqual(['Zéro', 'W1', 'W2'])
  })

  it('are renamed, given another address and removed in one profile without touching the other', () => {
    const { state, home, work } = twoProfiles()
    const both = add(add(state, home, 'Mail', 'https://mail.example/'), work, 'Mail', 'https://mail.example/')
    const mine = favoritesOfSpace(both, home)[0]!
    const theirs = favoritesOfSpace(both, work)[0]!
    const renamed = run(both, { type: 'favorite/edit', id: mine.id, patch: { title: 'Mail perso', url: 'https://autre.example/' } })
    expect(favoritesOfSpace(renamed, home)[0]).toMatchObject({ title: 'Mail perso', url: 'https://autre.example/' })
    expect(favoritesOfSpace(renamed, work)[0]).toEqual(theirs)
    const removed = run(renamed, { type: 'favorite/remove', id: mine.id })
    expect(favoritesOfSpace(removed, home)).toEqual([])
    expect(favoritesOfSpace(removed, work)).toEqual([theirs])
  })

  it('may take the address another profile has when edited, but not one of its own', () => {
    const { state, home, work } = twoProfiles()
    const s = add(add(add(state, home, 'A', 'https://a.example/'), home, 'B', 'https://b.example/'), work, 'W', 'https://a.example/')
    const [a, b] = favoritesOfSpace(s, home)
    const w = favoritesOfSpace(s, work)[0]!
    expect(run(s, { type: 'favorite/edit', id: b!.id, patch: { url: 'https://a.example/' } })).toBe(s)
    const taken = run(s, { type: 'favorite/edit', id: w.id, patch: { url: 'https://b.example/' } })
    expect(favoritesOfSpace(taken, work)[0]!.url).toBe('https://b.example/')
    expect(favoritesOfSpace(taken, home).map((f) => f.url)).toEqual([a!.url, b!.url])
  })

  it('are placed and moved among the favourites of their profile only', () => {
    const { state, home, work } = twoProfiles()
    // The two profiles are interleaved in the one list.
    let s = state
    for (const [space, title] of [[home, 'A'], [work, 'W1'], [home, 'B'], [work, 'W2'], [home, 'C']] as const) s = add(s, space, title)
    s = interleave(s, ['A', 'W1', 'B', 'W2', 'C'])
    expect(s.favorites.map((f) => f.title)).toEqual(['A', 'W1', 'B', 'W2', 'C'])
    const [a, b, c] = favoritesOfSpace(s, home)
    const placed = run(s, { type: 'favorite/place', id: a!.id, toIndex: 2 })
    expect(titles(favoritesOfSpace(placed, home))).toEqual(['B', 'C', 'A'])
    expect(titles(favoritesOfSpace(placed, work))).toEqual(['W1', 'W2'])
    // Already there: nothing changes.
    expect(run(s, { type: 'favorite/place', id: b!.id, toIndex: 1 })).toBe(s)
    const moved = run(s, { type: 'favorite/move', id: b!.id, direction: 1 })
    expect(titles(favoritesOfSpace(moved, home))).toEqual(['A', 'C', 'B'])
    expect(titles(favoritesOfSpace(moved, work))).toEqual(['W1', 'W2'])
    // The last favourite of a profile has no place to go further although another profile's follow it in the list.
    expect(run(s, { type: 'favorite/move', id: c!.id, direction: 1 })).toBe(s)
    expect(run(s, { type: 'favorite/move', id: a!.id, direction: -1 })).toBe(s)
  })

  it('are never opened in a space of another profile', () => {
    const { state, home, work } = twoProfiles()
    const s = add(state, home, 'Mail')
    const mail = favoritesOfSpace(s, home)[0]!
    expect(run(s, { type: 'favorite/open', id: mail.id, spaceId: work })).toBe(s)
    const opened = run(s, { type: 'favorite/open', id: mail.id, spaceId: home })
    expect(opened.tabs.filter((t) => t.favoriteId === mail.id).map((t) => t.spaceId)).toEqual([home])
  })

  it('leave the pages they had in a space that changed profile as ordinary tabs, instead of pages of favourites that space no longer shows', () => {
    const { state, home } = twoProfiles()
    const s = add(state, home, 'Mail')
    const mail = favoritesOfSpace(s, home)[0]!
    const opened = run(s, { type: 'favorite/open', id: mail.id, spaceId: home })
    const page = opened.tabs.find((t) => t.favoriteId === mail.id)!
    const moved = run(opened, { type: 'space/update', id: home, patch: { profileId: 'work' } })
    expect(moved.tabs.find((t) => t.id === page.id)).toBeDefined()
    expect(moved.tabs.find((t) => t.id === page.id)!.favoriteId).toBeUndefined()
    // The favourite itself stays where it was: it is the "default" profile's.
    expect(favoritesOf(moved, 'default').map((f) => f.id)).toEqual([mail.id])
  })

  it('keep their profile through a save and a read', () => {
    const { state, home, work } = twoProfiles()
    const s = add(add(state, home, 'Mail'), work, 'Courrier')
    const again = parseSavedState(JSON.stringify(persistableState(s)))
    expect(again.favorites.map((f) => [f.title, f.profileId])).toEqual([['Mail', 'default'], ['Courrier', 'work']])
    expect(normalize(again)).toEqual(again)
  })
})

describe('the favourites of a file from before they were kept per profile', () => {
  const file = (spaces: Array<{ id: string; profileId: string }>, tabs: unknown[] = []) => ({
    version: 1,
    spaces: spaces.map((s) => ({ ...s, name: s.id, emoji: '🏠' })),
    tabs,
    favorites: [
      { id: 'f1', url: 'https://mail.example/', title: 'Mail' },
      { id: 'f2', url: 'https://agenda.example/', title: 'Agenda' }
    ],
    activeSpaceId: spaces[0]!.id
  })

  it('are the default profile\'s, without a copy, when one profile is in use', () => {
    const state = parseSavedState(JSON.stringify(file([{ id: 's1', profileId: 'default' }, { id: 's2', profileId: 'default' }])))
    expect(state.favorites.map((f) => [f.id, f.profileId])).toEqual([['f1', 'default'], ['f2', 'default']])
  })

  it('stay where they were when the only profile in use is not the default one', () => {
    const state = parseSavedState(JSON.stringify(file([{ id: 's1', profileId: 'perso' }])))
    expect(state.favorites.map((f) => [f.id, f.profileId])).toEqual([['f1', 'perso'], ['f2', 'perso']])
  })

  it('are given to each profile in use, nothing lost and nothing hidden, then are independent', () => {
    const spaces = [{ id: 's1', profileId: 'default' }, { id: 's2', profileId: 'work' }, { id: 's3', profileId: 'perso' }, { id: 's4', profileId: 'work' }]
    const state = parseSavedState(JSON.stringify(file(spaces)))
    for (const profile of ['default', 'work', 'perso']) expect(titles(favoritesOf(state, profile)), profile).toEqual(['Mail', 'Agenda'])
    expect(state.favorites).toHaveLength(6)
    expect(new Set(state.favorites.map((f) => f.id)).size).toBe(6)
    // The first profile keeps the ids the file had.
    expect(favoritesOf(state, 'default').map((f) => f.id)).toEqual(['f1', 'f2'])
    // Independent from the first change on: removing one in "work" leaves the others.
    const work = favoritesOf(state, 'work')[0]!
    const after = run(state, { type: 'favorite/remove', id: work.id })
    expect(titles(favoritesOf(after, 'work'))).toEqual(['Agenda'])
    expect(titles(favoritesOf(after, 'perso'))).toEqual(['Mail', 'Agenda'])
    expect(titles(favoritesOf(after, 'default'))).toEqual(['Mail', 'Agenda'])
  })

  it('bring the page a favourite had in each space to the copy of that space\'s profile', () => {
    const tab = (id: string, spaceId: string) => ({ id, spaceId, url: 'https://mail.example/', title: 'Mail', pinned: false, favoriteId: 'f1', createdAt: 1, lastActiveAt: 1 })
    const spaces = [{ id: 's1', profileId: 'default' }, { id: 's2', profileId: 'work' }]
    const state = parseSavedState(JSON.stringify(file(spaces, [tab('p1', 's1'), tab('p2', 's2')])))
    const byId = new Map(state.favorites.map((f) => [f.id, f]))
    const pageOf = (id: string) => state.tabs.find((t) => t.id === id)!
    expect(byId.get(pageOf('p1').favoriteId!)).toMatchObject({ profileId: 'default', title: 'Mail' })
    expect(byId.get(pageOf('p2').favoriteId!)).toMatchObject({ profileId: 'work', title: 'Mail' })
    expect(pageOf('p1').favoriteId).toBe('f1')
    // Both pages are still pages of favourites (not dropped as strays), each of its own profile.
    expect(state.tabs.every((t) => t.favoriteId !== undefined)).toBe(true)
  })

  it('are read once: what is read again is the same', () => {
    const spaces = [{ id: 's1', profileId: 'default' }, { id: 's2', profileId: 'work' }]
    const once = parseSavedState(JSON.stringify(file(spaces)))
    const twice = parseSavedState(JSON.stringify(persistableState(once)))
    expect(twice.favorites).toEqual(once.favorites)
    expect(twice.favorites).toHaveLength(4)
  })
})

describe('scopeFavorites', () => {
  const fav = (id: string, profileId?: string): Favorite => ({ id, url: `https://${id}.example/`, title: id, ...(profileId ? { profileId } : {}) })

  it('hands back the same lists when every favourite has its profile', () => {
    const favorites = [fav('a', 'default'), fav('b', 'work')]
    const tabs: TabItem[] = []
    const out = scopeFavorites(favorites, tabs, [{ id: 's', profileId: 'default' }])
    expect(out.favorites).toBe(favorites)
    expect(out.tabs).toBe(tabs)
  })

  it('does not give a copy an id a favourite has already', () => {
    const out = scopeFavorites([fav('a'), fav('a.work')], [], [{ id: 's1', profileId: 'default' }, { id: 's2', profileId: 'work' }])
    expect(new Set(out.favorites.map((f) => f.id)).size).toBe(out.favorites.length)
  })

  it('has a profile for a state with no space at all', () => {
    expect(scopeFavorites([fav('a')], [], []).favorites).toEqual([{ ...fav('a'), profileId: DEFAULT_PROFILE }])
  })
})

describe('the helpers', () => {
  const fav = (id: string, profileId?: string): Favorite => ({ id, url: `https://${id}.example/`, title: id, ...(profileId ? { profileId } : {}) })

  it('read a favourite with no profile as the default profile\'s', () => {
    expect(favoriteProfile(fav('a'))).toBe('default')
    expect(favoriteProfile(fav('a', 'work'))).toBe('work')
  })

  it('withFavoriteAt puts a favourite at a place among those of its profile, clamped, whether it is in the list already or not', () => {
    const all = [fav('a', 'p'), fav('x', 'q'), fav('b', 'p'), fav('y', 'q')]
    // Before the favourite of its profile that it takes the place of (the other profile's one between them does not count).
    expect(withFavoriteAt(all, fav('n', 'p'), 1).map((f) => f.id)).toEqual(['a', 'x', 'n', 'b', 'y'])
    expect(withFavoriteAt(all, fav('n', 'p'), 5).map((f) => f.id)).toEqual(['a', 'x', 'b', 'n', 'y'])
    expect(withFavoriteAt(all, fav('n', 'p'), -3).map((f) => f.id)).toEqual(['n', 'a', 'x', 'b', 'y'])
    expect(withFavoriteAt(all, fav('n', 'r'), 0).map((f) => f.id)).toEqual(['a', 'x', 'b', 'y', 'n'])
    expect(withFavoriteAt(all, all[0]!, 1).map((f) => f.id)).toEqual(['x', 'b', 'a', 'y'])
  })

  it('withProfileOrder reorders one profile in its own slots', () => {
    const all = [fav('a', 'p'), fav('x', 'q'), fav('b', 'p'), fav('y', 'q')]
    expect(withProfileOrder(all, 'p', [all[2]!, all[0]!]).map((f) => f.id)).toEqual(['b', 'x', 'a', 'y'])
  })

  it('importedFavorites gives each a profile and keeps it once per address in it', () => {
    const { state, work } = twoProfiles()
    const held = add(state, work, 'Mail', 'https://mail.example/')
    const incoming: Favorite[] = [
      { id: 'i1', url: 'https://mail.example/', title: 'Mail' },
      { id: 'i2', url: 'https://mail.example/', title: 'Mail' },
      { id: 'i3', url: 'https://new.example/', title: 'New', profileId: 'work' },
      { id: 'i4', url: 'https://new.example/', title: 'New again', profileId: 'perso' },
      { id: 'i5', url: 'https://bad.example/', title: 'Bad', profileId: '../etc' }
    ]
    // The user is in "default": what names no profile goes there, not to the "work" favourite that has the same address.
    const out = importedFavorites(held, incoming, [])
    expect(out.map((f) => [f.id, f.profileId])).toEqual([['i1', 'default'], ['i3', 'work'], ['i4', 'perso'], ['i5', 'default']])
    // With a space that comes with the import, its profile is the one.
    expect(importedFavorites(held, [incoming[0]!], [{ profileId: 'work' }])).toEqual([])
    expect(importedFavorites(held, [incoming[0]!], [{ profileId: 'perso' }]).map((f) => f.profileId)).toEqual(['perso'])
  })
})

describe('an import', () => {
  it('puts its favourites in the profile it names and merges once per address in it, and takes them back by id', () => {
    const { state, work } = twoProfiles()
    const held = add(state, work, 'Mail', 'https://mail.example/')
    const incoming: Favorite[] = [
      { id: 'a1', url: 'https://mail.example/', title: 'Mail', profileId: 'default' },
      { id: 'a2', url: 'https://mail.example/', title: 'Mail encore', profileId: 'default' },
      { id: 'a3', url: 'https://mail.example/', title: 'Mail pro', profileId: 'work' }
    ]
    const merged = run(held, { type: 'import/merge', spaces: [], tabs: [], folders: [], favorites: incoming })
    expect(merged.favorites.map((f) => [f.id === 'a1' ? 'a1' : f.title, f.profileId])).toEqual([['Mail', 'work'], ['a1', 'default']])
    const back = run(merged, { type: 'import/revert', spaces: [], tabs: [], folders: [], favorites: ['a1'], splits: [], boosts: [] })
    expect(back.favorites.map((f) => f.profileId)).toEqual(['work'])
    // Importing the same thing again changes nothing.
    expect(run(merged, { type: 'import/merge', spaces: [], tabs: [], folders: [], favorites: incoming }).favorites).toEqual(merged.favorites)
  })
})

describe('what reads the favourites around the reducer', () => {
  it('the tree of bookmarks an extension sees has the favourites of its profile (see extension-data.test.ts for the rest)', () => {
    const { state, home, work } = twoProfiles()
    const s = add(add(state, home, 'Mail'), work, 'Courrier')
    const urls = (profile: string) => [...bookmarkIndex(bookmarkTree(s, profile)).values()].map((node) => node.url).filter(Boolean)
    expect(urls('default')).toEqual(['https://mail.example/'])
    expect(urls('work')).toEqual(['https://courrier.example/'])
  })

  it('the bookmarks file has the favourites once, however many profiles have them', () => {
    const { state, home, work } = twoProfiles()
    const s = add(add(add(state, home, 'Mail', 'https://mail.example/'), work, 'Mail pro', 'https://mail.example/'), work, 'Courrier')
    const { html, counts } = exportBookmarksHtml(s, { includeToday: false })
    expect(counts.favorites).toBe(2)
    expect(html.match(/https:\/\/mail\.example\//g)).toHaveLength(1)
    expect(html).toContain('Courrier')
  })

  it('dropping a tab on the favourites adds it to the profile of its space, counted among that profile\'s favourites', () => {
    const { state, home, work } = twoProfiles()
    // "work" has a favourite with the same address as the tab, and another one: neither counts for the row of "home".
    const s = interleave(add(add(add(add(state, home, 'A'), work, 'W', 'https://page.example/'), home, 'B'), work, 'W2'), ['A', 'W', 'B', 'W2'])
    const opened = run(s, { type: 'tab/open', url: 'https://page.example/', spaceId: home })
    const tab = opened.tabs.find((t) => t.spaceId === home && t.url === 'https://page.example/')!
    const [a, b] = favoritesOfSpace(opened, home)
    const plan = planDrop(opened, { kind: 'tabs', ids: [tab.id] }, { kind: 'favorite', id: b!.id, edge: 'before' })
    expect(plan.actions[0]).toMatchObject({ type: 'favorite/add', url: 'https://page.example/', toIndex: 1, spaceId: home })
    const done = plan.actions.reduce((acc, action) => reduce(acc, action, ctx), opened)
    expect(titles(favoritesOfSpace(done, home))).toEqual([a!.title, 'page.example', b!.title])
    expect(titles(favoritesOfSpace(done, work))).toEqual(['W', 'W2'])
  })

  it('moving a favourite by drag and drop counts the places among the favourites of its profile', () => {
    const { state, home, work } = twoProfiles()
    let s = state
    for (const [space, title] of [[home, 'A'], [work, 'W1'], [home, 'B'], [work, 'W2'], [home, 'C']] as const) s = add(s, space, title)
    s = interleave(s, ['A', 'W1', 'B', 'W2', 'C'])
    const [a, , c] = favoritesOfSpace(s, home)
    const plan = planDrop(s, { kind: 'favorite', id: a!.id }, { kind: 'favorite', id: c!.id, edge: 'after' })
    expect(plan.actions).toEqual([{ type: 'favorite/place', id: a!.id, toIndex: 2 }])
    const done = reduce(s, plan.actions[0]!, ctx)
    expect(titles(favoritesOfSpace(done, home))).toEqual(['B', 'C', 'A'])
    expect(titles(favoritesOfSpace(done, work))).toEqual(['W1', 'W2'])
  })
})
