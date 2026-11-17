import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { SidebarState, TabItem } from './model'
import { knownProfiles, profilesInUse } from './profiles'
import { routeFor } from './routing'
import { ASIDE_TABS_MAX, SESSIONS_MAX, asideRefusal, asideSessions, cleanAside, cleanSessions, routeTargetLabel } from './sessions'
import { createInitialState, normalize, parseSavedState, reduce, sidebarOrder, type Action, type Ctx } from './sidebar'
import { frenchSpaces } from './french-typography'

function makeCtx(now = 1_700_000_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/**
 * Three spaces. "Travail" (second, on a profile of its own, with a link rule) holds: a pinned tab in a folder that has a sub-folder,
 * a loose pinned tab, two Today tabs (one renamed, with an icon, kept awake and reloading) in a split view, an extension page, an
 * archived page, and its selected tab is the second Today one.
 */
function world() {
  const ctx = makeCtx()
  let s = createInitialState(ctx)
  const home = s.activeSpaceId
  s = run(ctx, s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileName: 'Clients' })
  const work = s.activeSpaceId
  s = run(ctx, s, { type: 'space/create', name: 'Loisirs', emoji: '🎮', hue: 20 })
  const fun = s.activeSpaceId
  const open = (url: string, spaceId: string) => {
    s = run(ctx, s, { type: 'tab/open', url, spaceId, background: true })
    return s.tabs.at(-1)!
  }
  const pinLoose = open('https://loose.example/', work)
  const pinFiled = open('https://filed.example/', work)
  const today1 = open('https://one.example/', work)
  const today2 = open('https://two.example/', work)
  const archivedSource = open('https://old.example/', work)
  open('https://home.example/', home)
  open('https://fun.example/', fun)
  s = run(ctx, s, { type: 'tab/pin', id: pinLoose.id }, { type: 'tab/pin', id: pinFiled.id })
  s = run(ctx, s, { type: 'folder/create-with', tabIds: [pinFiled.id], name: 'Docs' })
  const docs = s.folders.find((f) => f.name === 'Docs')!
  s = run(ctx, s, { type: 'folder/create', name: 'Sous-dossier', spaceId: work, parentId: docs.id })
  if (!s.folders.find((f) => f.id === docs.id)!.collapsed) s = run(ctx, s, { type: 'folder/toggle', id: docs.id })
  s = run(ctx, s, { type: 'tab/rename', id: today1.id, title: 'Mon onglet' }, { type: 'tab/icon', id: today1.id, icon: '🚀' }, { type: 'tab/auto-reload', id: today1.id, seconds: 60 })
  s = run(ctx, s, { type: 'tab/archive', id: archivedSource.id })
  s = run(ctx, s, { type: 'split/create', tabId: today1.id, withTabId: today2.id })
  s = { ...s, tabs: [...s.tabs, { id: 'ext', spaceId: work, url: `chrome-extension://${'a'.repeat(32)}/options.html`, title: 'Options', pinned: false, createdAt: 1, lastActiveAt: 1 }] }
  s = run(ctx, s, { type: 'tab/select', id: today2.id }, { type: 'settings/update', patch: { linkRoutes: [{ host: 'client.example', spaceId: work }] } }, { type: 'space/select', id: home })
  return { ctx, state: s, home, work, fun, today1, today2, pinLoose, pinFiled }
}

describe('space/aside', () => {
  it('turns the space into a session named after it, and takes it out of the sidebar with its tabs, folders, split views and archive', () => {
    const { ctx, state, home, work, fun } = world()
    const next = run(ctx, state, { type: 'space/aside', id: work })
    expect(next.spaces.map((s) => s.id)).toEqual([home, fun])
    expect([next.tabs, next.folders, next.splits, next.archive].map((list) => list.filter((x) => x.spaceId === work))).toEqual([[], [], [], []])
    expect(Object.keys(next.activeTabBySpace)).toEqual([home, fun])
    expect(next.sessions).toHaveLength(1)
    const session = next.sessions[0]!
    expect(session).toMatchObject({ name: 'Travail', createdAt: ctx.now })
    expect(session.space!.space).toMatchObject({ id: work, name: 'Travail', emoji: '💼', profileId: state.spaces.find((s) => s.id === work)!.profileId })
    expect(session.space!.space.theme).toEqual(state.spaces.find((s) => s.id === work)!.theme)
    expect(asideSessions(next)).toEqual([session])
  })

  it('keeps the tabs as an ordinary session would (web pages, in the sidebar order) and the whole space beside them', () => {
    const { ctx, state, work } = world()
    const session = run(ctx, state, { type: 'space/aside', id: work }).sessions[0]!
    expect(session.tabs.map((t) => [t.url, t.pinned === true, t.folder])).toEqual([
      ['https://loose.example/', true, undefined],
      ['https://filed.example/', true, 'Docs'],
      ['https://one.example/', false, undefined],
      ['https://two.example/', false, undefined]
    ])
    // The extension page is not a page a session keeps, but it is a tab of the space: the space keeps it.
    expect(session.space!.tabs.map((t) => t.url)).toContain(`chrome-extension://${'a'.repeat(32)}/options.html`)
    expect(session.space!.tabs).toHaveLength(state.tabs.filter((t) => t.spaceId === work).length)
    expect(session.space!.archive.map((a) => a.url)).toEqual(['https://old.example/'])
    expect(session.space!.splits).toHaveLength(1)
  })

  it('leaves the other spaces, the favourites, the link rules and the settings exactly as they were', () => {
    const { ctx, state, work } = world()
    const withFavourite = run(ctx, state, { type: 'favorite/add', url: 'https://fav.example/', title: 'Favori' })
    const next = run(ctx, withFavourite, { type: 'space/aside', id: work })
    expect(next.favorites).toEqual(withFavourite.favorites)
    expect(next.settings).toEqual(withFavourite.settings)
    expect(next.tabs).toEqual(withFavourite.tabs.filter((t) => t.spaceId !== work))
    expect(next.spaces).toEqual(withFavourite.spaces.filter((s) => s.id !== work))
    expect(next.activeSpaceId).toBe(withFavourite.activeSpaceId)
  })

  it('puts the neighbour on screen when the space was the one shown: the next one, else the previous', () => {
    const { ctx, state, home, work, fun } = world()
    expect(run(ctx, state, { type: 'space/select', id: work }, { type: 'space/aside', id: work }).activeSpaceId).toBe(fun)
    expect(run(ctx, state, { type: 'space/select', id: fun }, { type: 'space/aside', id: fun }).activeSpaceId).toBe(work)
    expect(run(ctx, state, { type: 'space/select', id: home }, { type: 'space/aside', id: home }).activeSpaceId).toBe(work)
  })

  it('refuses the only space: a window needs one to show', () => {
    const ctx = makeCtx()
    const alone = createInitialState(ctx)
    expect(reduce(alone, { type: 'space/aside', id: alone.activeSpaceId }, ctx)).toBe(alone)
  })

  it('refuses a space that does not exist', () => {
    const { ctx, state } = world()
    expect(reduce(state, { type: 'space/aside', id: 'nope' }, ctx)).toBe(state)
  })

  it('refuses past 100 sessions, and pushes none of them out', () => {
    const { ctx, state, work } = world()
    const full = { ...state, sessions: Array.from({ length: SESSIONS_MAX }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: i, tabs: [{ url: 'https://s.example/', title: 's' }] })) }
    expect(reduce(full, { type: 'space/aside', id: work }, ctx)).toBe(full)
  })

  it('refuses a space with more tabs than a space put aside can keep, rather than dropping some', () => {
    const { ctx, state, work } = world()
    const bulk: TabItem[] = Array.from({ length: ASIDE_TABS_MAX + 1 }, (_, i) => ({ id: `bulk${i}`, spaceId: work, url: `https://bulk.example/${i}`, title: `B${i}`, pinned: false, createdAt: 1, lastActiveAt: 1 }))
    const big = { ...state, tabs: [...state.tabs.filter((t) => t.spaceId !== work), ...bulk] }
    expect(reduce(big, { type: 'space/aside', id: work }, ctx)).toBe(big)
    // One fewer fits.
    const fits = { ...state, tabs: [...state.tabs.filter((t) => t.spaceId !== work), ...bulk.slice(1)] }
    expect(reduce(fits, { type: 'space/aside', id: work }, ctx).sessions).toHaveLength(1)
  })

  it('puts an empty space aside too: it is kept for its theme and settings', () => {
    const { ctx, state, fun } = world()
    const emptied = run(ctx, state, { type: 'today/clear', spaceId: fun })
    const withNothing = { ...emptied, tabs: emptied.tabs.filter((t) => t.spaceId !== fun), activeTabBySpace: { ...emptied.activeTabBySpace, [fun]: null } }
    const next = run(ctx, withNothing, { type: 'space/aside', id: fun })
    expect(next.sessions[0]).toMatchObject({ name: 'Loisirs', tabs: [] })
    expect(next.sessions[0]!.space!.space.id).toBe(fun)
  })

  it('does not keep an icon that is a picture rather than an address: the page brings its own back', () => {
    const { ctx, state, work, today1 } = world()
    const heavy = { ...state, tabs: state.tabs.map((t) => (t.id === today1.id ? { ...t, faviconUrl: `data:image/png;base64,${'A'.repeat(5000)}` } : t.spaceId === work ? { ...t, faviconUrl: 'https://one.example/favicon.ico' } : t)) }
    const kept = run(ctx, heavy, { type: 'space/aside', id: work }).sessions[0]!.space!.tabs
    expect(kept.find((t) => t.id === today1.id)).not.toHaveProperty('faviconUrl')
    expect(kept.find((t) => t.url === 'https://two.example/')!.faviconUrl).toBe('https://one.example/favicon.ico')
  })
})

describe('asideRefusal', () => {
  it('is null for a space that can be put aside, and says in words why not otherwise', () => {
    const { state, work } = world()
    expect(asideRefusal(state, work)).toBeNull()
    expect(asideRefusal(state, 'nope')).toBe('Cet espace n’existe plus.')
    const alone = createInitialState(makeCtx())
    expect(asideRefusal(alone, alone.activeSpaceId)).toMatch(/au moins un espace/)
    const full = { ...state, sessions: Array.from({ length: SESSIONS_MAX }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: i, tabs: [{ url: 'https://s.example/', title: 's' }] })) }
    expect(asideRefusal(full, work)).toMatch(/Limite de 100 sessions/)
    const bulk: TabItem[] = Array.from({ length: ASIDE_TABS_MAX + 1 }, (_, i) => ({ id: `bulk${i}`, spaceId: work, url: `https://bulk.example/${i}`, title: `B${i}`, pinned: false, createdAt: 1, lastActiveAt: 1 }))
    expect(asideRefusal({ ...state, tabs: [...state.tabs, ...bulk] }, work)).toMatch(/plus de 1000 onglets/)
  })
})

describe('space/reopen', () => {
  it('puts the space back as it was: same id, place, theme, profile, folders, tabs, split view, selection and archive', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const back = run(ctx, aside, { type: 'space/reopen', id: aside.sessions[0]!.id })
    // Everything is back, in the same order, with the same ids; only the order of the lists of other spaces' items may differ for the appended ones.
    const mine = (s: SidebarState) => ({
      space: s.spaces.find((sp) => sp.id === work),
      place: s.spaces.findIndex((sp) => sp.id === work),
      tabs: s.tabs.filter((t) => t.spaceId === work),
      folders: s.folders.filter((f) => f.spaceId === work),
      splits: s.splits.filter((sp) => sp.spaceId === work),
      archive: s.archive.filter((a) => a.spaceId === work),
      shown: s.activeTabBySpace[work]
    })
    expect(mine(back)).toEqual(mine(state))
    expect(back.spaces.map((s) => s.id)).toEqual(state.spaces.map((s) => s.id))
    expect(back.activeSpaceId).toBe(work)
    expect(back.sessions).toEqual([])
    expect(back.settings).toEqual(state.settings)
    expect(back.favorites).toEqual(state.favorites)
    // The other spaces did not move.
    expect(back.tabs.filter((t) => t.spaceId !== work)).toEqual(state.tabs.filter((t) => t.spaceId !== work))
  })

  it('brings back what the sidebar shows of it, in the same order, with the per-tab settings', () => {
    const { ctx, state, work, today1, pinFiled } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const back = run(ctx, aside, { type: 'space/reopen', id: aside.sessions[0]!.id })
    expect(sidebarOrder(back, work).map((t) => t.id)).toEqual(sidebarOrder(state, work).map((t) => t.id))
    const one = back.tabs.find((t) => t.id === today1.id)!
    expect(one).toMatchObject({ customTitle: 'Mon onglet', icon: '🚀', autoReload: { seconds: 60 } })
    expect(back.tabs.find((t) => t.id === pinFiled.id)).toMatchObject({ pinned: true, anchorUrl: state.tabs.find((t) => t.id === pinFiled.id)!.anchorUrl })
    const docs = back.folders.find((f) => f.name === 'Docs')!
    expect(docs.collapsed).toBe(true)
    expect(back.folders.find((f) => f.name === 'Sous-dossier')!.parentId).toBe(docs.id)
  })

  it('makes the link rules that named the space work again', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    expect(routeFor('https://client.example/x', aside.settings.linkRoutes, aside.spaces)).toBeUndefined()
    const back = run(ctx, aside, { type: 'space/reopen', id: aside.sessions[0]!.id })
    expect(routeFor('https://client.example/x', back.settings.linkRoutes, back.spaces)).toBe(work)
  })

  it('survives a restart between the two: the state written and read back reopens the space', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const reloaded = parseSavedState(JSON.stringify(aside))
    expect(reloaded).toStrictEqual(aside)
    const back = run(ctx, reloaded, { type: 'space/reopen', id: aside.sessions[0]!.id })
    expect(back.spaces.map((s) => s.id)).toEqual(state.spaces.map((s) => s.id))
    expect(back.tabs.filter((t) => t.spaceId === work).map((t) => t.id)).toEqual(state.tabs.filter((t) => t.spaceId === work).map((t) => t.id))
  })

  it('takes a new id for whatever the state has taken since (a restored copy can hold the same space), and mixes nothing up', () => {
    const { ctx, state, work, today1 } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    // The same space, folders and tabs are in the state again, as a restored copy would bring them.
    const twin = { ...aside, spaces: state.spaces, tabs: state.tabs, folders: state.folders, splits: state.splits, archive: state.archive }
    const back = run(ctx, twin, { type: 'space/reopen', id: aside.sessions[0]!.id })
    const idsOf = (list: ReadonlyArray<{ id: string }>) => list.map((x) => x.id)
    for (const list of [back.spaces, back.tabs, back.folders, back.splits, back.archive] as Array<ReadonlyArray<{ id: string }>>) expect(new Set(idsOf(list)).size).toBe(list.length)
    expect(back.spaces).toHaveLength(state.spaces.length + 1)
    const reopened = back.spaces.find((sp) => sp.id !== work && sp.name === 'Travail')!
    expect(reopened.id).not.toBe(work)
    // The reopened copy has its own tabs, folders and split view, in its own space.
    const own = back.tabs.filter((t) => t.spaceId === reopened.id)
    expect(own).toHaveLength(state.tabs.filter((t) => t.spaceId === work).length)
    expect(own.every((t) => t.id !== today1.id)).toBe(true)
    expect(back.folders.filter((f) => f.spaceId === reopened.id).every((f) => f.parentId === undefined || back.folders.find((p) => p.id === f.parentId)?.spaceId === reopened.id)).toBe(true)
    expect(back.splits.filter((sp) => sp.spaceId === reopened.id).every((sp) => sp.tabIds.every((id) => back.tabs.find((t) => t.id === id)?.spaceId === reopened.id))).toBe(true)
    expect(back.activeSpaceId).toBe(reopened.id)
    expect(back.sessions).toEqual([])
  })

  it('opens at the end when its place no longer exists', () => {
    const { ctx, state, work, home, fun } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const fewer = run(ctx, aside, { type: 'space/delete', id: fun })
    const back = run(ctx, fewer, { type: 'space/reopen', id: aside.sessions[0]!.id })
    expect(back.spaces.map((s) => s.id)).toEqual([home, work])
  })

  it('ignores a session that is not a space put aside, and one that does not exist', () => {
    const { ctx, state } = world()
    const withPlain = run(ctx, state, { type: 'session/save', name: 'Ordinaire' })
    expect(reduce(withPlain, { type: 'space/reopen', id: withPlain.sessions[0]!.id }, ctx)).toBe(withPlain)
    expect(reduce(withPlain, { type: 'space/reopen', id: 'nope' }, ctx)).toBe(withPlain)
  })

  it('keeps the session list sound: only the spent session leaves', () => {
    const { ctx, state, work, fun } = world()
    const two = run(ctx, state, { type: 'session/save', name: 'Ordinaire' }, { type: 'space/aside', id: work }, { type: 'space/aside', id: fun })
    expect(two.sessions.map((s) => s.name)).toEqual(['Loisirs', 'Travail', 'Ordinaire'])
    const back = run(ctx, two, { type: 'space/reopen', id: two.sessions[1]!.id })
    expect(back.sessions.map((s) => s.name)).toEqual(['Loisirs', 'Ordinaire'])
    expect(back.spaces.map((s) => s.id)).toContain(work)
  })
})

describe('a link rule that names a space put aside', () => {
  it('says so instead of calling the space deleted, and says it again once the space is deleted for good', () => {
    const { ctx, state, work } = world()
    expect(routeTargetLabel(state, work)).toBe('Travail')
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    expect(routeTargetLabel(aside, work)).toBe(frenchSpaces('Travail (mis de côté : la règle reprend à sa réouverture)'))
    expect(routeTargetLabel(run(ctx, aside, { type: 'session/delete', id: aside.sessions[0]!.id }), work)).toBe('espace supprimé')
    expect(routeTargetLabel(aside, 'never-existed')).toBe('espace supprimé')
    setLanguage('en')
    try {
      expect(routeTargetLabel(aside, work)).toBe('Travail (set aside: the rule resumes when it is reopened)')
      expect(routeTargetLabel(aside, 'never-existed')).toBe('deleted Space')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the session of a space put aside', () => {
  it('is renamed with the space: it comes back under the name the list showed', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const renamed = run(ctx, aside, { type: 'session/rename', id: aside.sessions[0]!.id, name: 'Clients 2026' })
    expect(renamed.sessions[0]).toMatchObject({ name: 'Clients 2026' })
    expect(renamed.sessions[0]!.space!.space.name).toBe('Clients 2026')
    const back = run(ctx, renamed, { type: 'space/reopen', id: renamed.sessions[0]!.id })
    expect(back.spaces.find((s) => s.id === work)!.name).toBe('Clients 2026')
  })

  it('can still be restored as plain pages into the current space, like any session', () => {
    const { ctx, state, work, home } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work }, { type: 'space/select', id: home })
    const restored = run(ctx, aside, { type: 'session/restore', id: aside.sessions[0]!.id })
    expect(restored.tabs.filter((t) => t.spaceId === home).map((t) => t.url)).toEqual(expect.arrayContaining(['https://one.example/', 'https://two.example/']))
    expect(restored.sessions).toHaveLength(1)
    expect(restored.spaces).toHaveLength(2)
  })

  it('is lost for good when deleted, and that is the only way to lose the space', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const deleted = run(ctx, aside, { type: 'session/delete', id: aside.sessions[0]!.id })
    expect(deleted.sessions).toEqual([])
    expect(deleted.spaces.map((s) => s.id)).not.toContain(work)
  })

  it('keeps the profile of the space in use: its cookies stay on disk, so the clean-up of unused profiles must not take them', () => {
    const { ctx, state, work } = world()
    const profile = state.spaces.find((s) => s.id === work)!.profileId
    expect(profile).toBe('clients')
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    expect(aside.spaces.some((s) => s.profileId === profile)).toBe(false)
    expect(profilesInUse(aside)).toContain(profile)
    expect(knownProfiles(aside)).toContain(profile)
    expect(profilesInUse(run(ctx, aside, { type: 'session/delete', id: aside.sessions[0]!.id }))).not.toContain(profile)
  })
})

describe('what a file can say about a space put aside', () => {
  const good = () => {
    const { ctx, state, work } = world()
    return JSON.parse(JSON.stringify(run(ctx, state, { type: 'space/aside', id: work }).sessions[0]!.space)) as Record<string, any>
  }

  it('keeps a good one unchanged', () => {
    const aside = cleanAside(good())!
    expect(cleanAside(JSON.parse(JSON.stringify(aside)))).toStrictEqual(aside)
  })

  it('is nothing without a usable space', () => {
    for (const bad of [null, 'x', 3, [], {}, { space: null }, { space: { id: '' } }, { space: { id: '__proto__' } }]) expect(cleanAside(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('drops the tabs of another space, the addresses the engine cannot load and a duplicate id, one by one', () => {
    const raw = good()
    raw['tabs'] = [...raw['tabs'], { ...raw['tabs'][0], id: 'other', spaceId: 'elsewhere' }, { ...raw['tabs'][0], id: 'script', url: 'javascript:alert(1)' }, { ...raw['tabs'][0] }]
    const cleaned = cleanAside(raw)!
    expect(cleaned.tabs).toHaveLength(good()['tabs'].length)
    expect(cleaned.tabs.every((t) => t.spaceId === raw['space'].id)).toBe(true)
  })

  it('cuts a selection, a folder and a split view that point at nothing', () => {
    const raw = good()
    raw['selected'] = 'gone'
    raw['tabs'] = raw['tabs'].map((t: Record<string, unknown>) => ({ ...t, folderId: 'no-such-folder' }))
    raw['splits'] = [{ id: 's', spaceId: raw['space'].id, tabIds: ['gone', raw['tabs'][0].id], orientation: 'horizontal', ratios: [0.5, 0.5] }]
    const cleaned = cleanAside(raw)!
    expect(cleaned.selected).toBeNull()
    // The tabs stay, outside any folder: only what points at nothing is cut.
    expect(cleaned.tabs.map((t) => t.id)).toEqual(raw['tabs'].map((t: Record<string, unknown>) => t['id']))
    expect(cleaned.tabs.every((t) => t.folderId === undefined)).toBe(true)
    expect(cleaned.splits).toEqual([])
  })

  it('keeps no more than a space put aside can hold, and no archive of another space', () => {
    const raw = good()
    const bulk = Array.from({ length: ASIDE_TABS_MAX + 50 }, (_, i) => ({ id: `b${i}`, spaceId: raw['space'].id, url: `https://b.example/${i}`, title: 'b', pinned: false, createdAt: 1, lastActiveAt: 1 }))
    raw['tabs'] = bulk
    raw['archive'] = [...raw['archive'], { id: 'x', spaceId: 'elsewhere', url: 'https://x.example/', title: 'x', archivedAt: 1 }]
    const cleaned = cleanAside(raw)!
    expect(cleaned.tabs).toHaveLength(ASIDE_TABS_MAX)
    // The archive of the space itself is kept (the page closed in it before it was put aside); only the entry of another space goes.
    expect(cleaned.archive.map((a) => a.url)).toEqual(['https://old.example/'])
  })

  it('brings the place back to a whole number at least zero', () => {
    for (const [given, wanted] of [[-3, 0], [1.9, 1], ['2', 0], [null, 0], [Number.NaN, 0], [Infinity, 0]] as const) expect(cleanAside({ ...good(), index: given })!.index, String(given)).toBe(wanted)
  })

  it('makes a session of it only with pages or a space: a plain session with no page is still dropped', () => {
    const aside = good()
    const sessions = cleanSessions([
      { id: 'a', name: 'Vide mais espace', createdAt: 1, tabs: [], space: aside },
      { id: 'b', name: 'Vide', createdAt: 2, tabs: [] },
      { id: 'c', name: 'Espace cassé', createdAt: 3, tabs: [], space: { space: null } },
      { id: 'd', name: 'Pages et espace cassé', createdAt: 4, tabs: [{ url: 'https://p.example/', title: 'p' }], space: 'x' }
    ])
    expect(sessions.map((s) => s.id)).toEqual(['a', 'd'])
    expect(sessions[1]).not.toHaveProperty('space')
  })

  it('loads through the whole state without disturbing the live spaces', () => {
    const { ctx, state, work } = world()
    const aside = run(ctx, state, { type: 'space/aside', id: work })
    const damaged = JSON.parse(JSON.stringify(aside)) as Record<string, any>
    damaged['sessions'][0]['space']['tabs'] = 'not a list'
    const loaded = normalize(damaged as unknown as SidebarState)
    expect(loaded.spaces.map((s) => s.id)).toEqual(aside.spaces.map((s) => s.id))
    expect(loaded.sessions[0]!.space!.tabs).toEqual([])
  })
})
