// What the reducer of the sidebar holds to when the interface says so: the ranking of the command bar is history (not kept while the history is off,
// gone when it is erased), a page separated from its pinned tab stays in its container, « Fermer les autres onglets » spares what « Vider Aujourd’hui »
// spares, a private page never becomes a web panel, a copied live folder is live only within the limit, a few payloads are read as strictly as the
// others, and a restored file does not decide what the browser does on its own.

import { describe, expect, it } from 'vitest'
import type { Folder, SidebarState } from './model'
import { LIVE_FOLDERS_MAX } from './live-folders'
import { TAB_URL_MAX } from './state-clean'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(now = 1_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

function run(ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState {
  return actions.reduce((s, a) => reduce(s, a, ctx), state)
}

const key = (url: string): string => `url:${url}`

describe('the ranking of the command bar is history', () => {
  it('counts nothing while the history is not recorded', () => {
    const ctx = makeCtx()
    const off = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { historyOff: true } })
    expect(run(ctx, off, { type: 'commandbar/used', key: key('https://a.example/page?q=1') })).toBe(off)
    // The same pick is counted once the history is recorded again.
    const on = run(ctx, off, { type: 'settings/update', patch: { historyOff: false } })
    expect(run(ctx, on, { type: 'commandbar/used', key: key('https://a.example/page?q=1') }).commandBarUsage).toEqual({ default: { [key('https://a.example/page?q=1')]: 1 } })
  })

  it('follows the profile of the space on screen: a profile that records its history counts, one that does not counts nothing', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const profileId = base.spaces[0]!.profileId
    const recording = run(ctx, base, { type: 'settings/update', patch: { historyOff: true, profiles: { [profileId]: { historyOff: false } } } })
    expect(Object.keys(run(ctx, recording, { type: 'commandbar/used', key: key('https://a.example/') }).commandBarUsage[profileId]!)).toHaveLength(1)
    const silent = run(ctx, base, { type: 'settings/update', patch: { historyOff: false, profiles: { [profileId]: { historyOff: true } } } })
    expect(run(ctx, silent, { type: 'commandbar/used', key: key('https://a.example/') })).toBe(silent)
  })

  it('is emptied when the history is erased', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const used = run(ctx, base, { type: 'commandbar/used', key: key('https://a.example/x') }, { type: 'commandbar/used', key: key('https://b.example/y') })
    expect(Object.keys(used.commandBarUsage['default']!)).toHaveLength(2)
    const erased = run(ctx, used, { type: 'archive/forget-pages', profileId: base.spaces[0]!.profileId })
    expect(erased.commandBarUsage).toEqual({})
    // Nothing to forget is no new state.
    expect(run(ctx, erased, { type: 'archive/forget-pages', profileId: base.spaces[0]!.profileId })).toBe(erased)
  })

  it('loses the addresses of a site, and only those, when the history of that site is erased', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const used = run(
      ctx,
      base,
      { type: 'commandbar/used', key: key('https://a.example/x') },
      { type: 'commandbar/used', key: key('https://sub.a.example/y') },
      { type: 'commandbar/used', key: key('https://b.example/z') }
    )
    const profileId = base.spaces[0]!.profileId
    const exact = run(ctx, used, { type: 'archive/forget-pages', profileId, site: { host: 'a.example', subdomains: false } })
    expect(Object.keys(exact.commandBarUsage[profileId]!).sort()).toEqual([key('https://b.example/z'), key('https://sub.a.example/y')])
    const withSubdomains = run(ctx, used, { type: 'archive/forget-pages', profileId, site: { host: 'a.example', subdomains: true } })
    expect(Object.keys(withSubdomains.commandBarUsage[profileId]!)).toEqual([key('https://b.example/z')])
    // A site that is not a host forgets nothing.
    expect(run(ctx, used, { type: 'archive/forget-pages', profileId, site: { host: 'not a host', subdomains: true } })).toBe(used)
  })
})

describe('a page separated from its pinned tab', () => {
  const pinnedAway = (ctx: Ctx) => {
    let s = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { tabContainers: true } }, { type: 'container/create', name: 'Travail' })
    const container = s.settings.containers[0]!.id
    s = run(ctx, s, { type: 'tab/open', url: 'https://home.example/', container })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://home.example/deep' } })
    return { state: s, id, container }
  }

  it('stays in the container of the pinned tab', () => {
    const ctx = makeCtx()
    const { state, id, container } = pinnedAway(ctx)
    const separated = run(ctx, state, { type: 'tab/separate', id })
    const copy = separated.tabs.find((t) => t.id !== id)!
    expect(copy).toMatchObject({ url: 'https://home.example/deep', pinned: false, container })
    expect(separated.tabs.find((t) => t.id === id)).toMatchObject({ url: 'https://home.example/', container })
  })

  it('carries no container when the pinned tab has none', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://home.example/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://home.example/deep' } }, { type: 'tab/separate', id })
    expect(s.tabs.find((t) => t.id !== id)).not.toHaveProperty('container')
  })
})

describe('« Fermer les autres onglets du jour »', () => {
  it('spares the page of a favourite and the other panes of the split view of the tab that stays', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    for (const host of ['a', 'b', 'c']) s = run(ctx, s, { type: 'tab/open', url: `https://${host}.example/`, background: true })
    const [a, b, c] = s.tabs.map((t) => t.id) as [string, string, string]
    s = run(ctx, s, { type: 'favorite/add', url: 'https://fav.example/', title: 'Fav' })
    s = run(ctx, s, { type: 'favorite/open', id: s.favorites[0]!.id })
    const favouritePage = s.tabs.find((t) => t.favoriteId !== undefined)!
    s = run(ctx, s, { type: 'split/create', tabId: a, withTabId: b })
    const closed = run(ctx, s, { type: 'tab/close-others', id: a })
    expect(closed.tabs.map((t) => t.id).sort()).toEqual([a, b, favouritePage.id].sort())
    expect(closed.archive.map((entry) => entry.id)).toEqual([c])
    expect(closed.splits).toHaveLength(1)
  })
})

describe('a web panel', () => {
  const withPanels = (ctx: Ctx): SidebarState => run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { webPanels: true, privateTabs: true } })

  it('is not made of the page of a private tab: the list is saved with the space', () => {
    const ctx = makeCtx()
    const s = run(ctx, withPanels(ctx), { type: 'tab/open', url: 'https://secret.example/', private: true })
    expect(s.tabs[0]!.private).toBe(true)
    expect(run(ctx, s, { type: 'space/panel-add', id: s.spaces[0]!.id, panelId: 'p1', url: 'https://secret.example/' })).toBe(s)
  })

  it('is made of that address when an ordinary tab shows it too', () => {
    const ctx = makeCtx()
    const s = run(ctx, withPanels(ctx), { type: 'tab/open', url: 'https://shared.example/', private: true }, { type: 'tab/open', url: 'https://shared.example/' })
    expect(run(ctx, s, { type: 'space/panel-add', id: s.spaces[0]!.id, panelId: 'p1', url: 'https://shared.example/' }).spaces[0]!.webPanels).toHaveLength(1)
  })
})

describe('a live folder that is duplicated', () => {
  const liveFolder = (id: string, spaceId: string): Folder => ({ id, spaceId, name: id, collapsed: false, live: { source: { kind: 'feed', url: `https://${id}.example/rss` }, items: [] } })

  it('gives a live copy while there is room, and an ordinary folder past the limit', () => {
    const ctx = makeCtx()
    const base = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { liveFolders: true } })
    const spaceId = base.spaces[0]!.id
    const room: SidebarState = { ...base, folders: Array.from({ length: LIVE_FOLDERS_MAX - 1 }, (_, i) => liveFolder(`f${i}`, spaceId)) }
    const copied = run(ctx, room, { type: 'folder/duplicate', id: 'f0' })
    expect(copied.folders.filter((f) => f.live !== undefined)).toHaveLength(LIVE_FOLDERS_MAX)

    const full: SidebarState = { ...base, folders: Array.from({ length: LIVE_FOLDERS_MAX }, (_, i) => liveFolder(`f${i}`, spaceId)) }
    const past = run(ctx, full, { type: 'folder/duplicate', id: 'f0' })
    expect(past.folders).toHaveLength(LIVE_FOLDERS_MAX + 1)
    expect(past.folders.filter((f) => f.live !== undefined)).toHaveLength(LIVE_FOLDERS_MAX)
    const copy = past.folders.find((f) => !full.folders.some((known) => known.id === f.id))!
    expect(copy).not.toHaveProperty('live')
  })
})

describe('payloads the reducer reads strictly', () => {
  it('moves a pane of a split view by one place only', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    for (const host of ['a', 'b', 'c']) s = run(ctx, s, { type: 'tab/open', url: `https://${host}.example/`, background: true })
    const [a, b, c] = s.tabs.map((t) => t.id) as [string, string, string]
    s = run(ctx, s, { type: 'split/create', tabId: a, withTabId: b }, { type: 'split/create', tabId: a, withTabId: c })
    expect(s.splits[0]!.tabIds).toHaveLength(3)
    for (const direction of [2, 0, 0.5, Number.NaN, '1']) expect(run(ctx, s, { type: 'split/move', tabId: s.splits[0]!.tabIds[0]!, direction: direction as 1 }), String(direction)).toBe(s)
    const moved = run(ctx, s, { type: 'split/move', tabId: s.splits[0]!.tabIds[0]!, direction: 1 })
    expect(moved.splits[0]!.tabIds.every((id) => typeof id === 'string')).toBe(true)
    expect(moved.splits[0]!.tabIds[1]).toBe(s.splits[0]!.tabIds[0])
  })

  it('moves a favourite by one place only', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    for (const host of ['a', 'b', 'c']) s = run(ctx, s, { type: 'favorite/add', url: `https://${host}.example/`, title: host })
    const first = s.favorites[0]!.id
    for (const direction of [2, 0.5, 0, '1']) expect(run(ctx, s, { type: 'favorite/move', id: first, direction: direction as 1 }), String(direction)).toBe(s)
    expect(run(ctx, s, { type: 'favorite/move', id: first, direction: 1 }).favorites.map((f) => f.id)[1]).toBe(first)
  })

  it('keeps the icon of a favourite only when it is the address of a picture', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const add = (faviconUrl: unknown) => run(ctx, base, { type: 'favorite/add', url: 'https://a.example/', title: 'A', faviconUrl: faviconUrl as string }).favorites[0]!
    expect(add('https://a.example/icon.png').faviconUrl).toBe('https://a.example/icon.png')
    for (const icon of ['javascript:alert(1)', 'file:///etc/passwd', `https://a.example/${'x'.repeat(3_000_000)}`, 12, { toString: () => 'https://a.example/i.png' }]) expect(add(icon), String(icon).slice(0, 40)).not.toHaveProperty('faviconUrl')
  })

  it('refuses a new address of a favourite that is longer than the address of a tab, or that is not text', () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'favorite/add', url: 'https://a.example/', title: 'A' })
    const id = s.favorites[0]!.id
    const long = `https://a.example/${'x'.repeat(TAB_URL_MAX)}`
    expect(run(ctx, s, { type: 'favorite/edit', id, patch: { url: long } })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/edit', id, patch: { url: 12 as unknown as string } })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/edit', id, patch: { url: 'https://b.example/' } }).favorites[0]!.url).toBe('https://b.example/')
  })

  it('writes in an archive entry only a source the archive knows', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const added = (source: unknown) => run(ctx, base, { type: 'archive/add', url: 'https://a.example/', title: 'A', source: source as 'manual' }).archive[0]!
    expect(added('little').source).toBe('little')
    expect(added('manual').source).toBe('manual')
    for (const source of ['<b>', { a: 1 }, 7]) expect(added(source), JSON.stringify(source)).not.toHaveProperty('source')
  })
})

describe('a restored file and what the browser does on its own', () => {
  const watch = (id: string, url: string) => ({ id, url, title: url, profileId: 'default', minutes: 60 })

  it('keeps this installation’s switches for watching pages, taking addresses from other applications and looking for updates', () => {
    const ctx = makeCtx()
    const here = createInitialState(ctx)
    const file = JSON.parse(JSON.stringify({ ...here, settings: { ...here.settings, pageWatch: true, urlAutomation: true, autoUpdate: false } })) as SidebarState
    const restored = run(ctx, here, { type: 'state/restore', state: file })
    expect(restored.settings).toMatchObject({ pageWatch: false, urlAutomation: false, autoUpdate: true })
    // And the other way round: what is on here stays on.
    const on = { ...here, settings: { ...here.settings, pageWatch: true, urlAutomation: true, autoUpdate: false } }
    expect(run(ctx, on, { type: 'state/restore', state: JSON.parse(JSON.stringify(here)) as SidebarState }).settings).toMatchObject({ pageWatch: true, urlAutomation: true, autoUpdate: false })
  })

  it('takes the pages to watch from the file only while watching is off here; while it is on, the pages watched here stay', () => {
    const ctx = makeCtx()
    const here = createInitialState(ctx)
    const file = JSON.parse(JSON.stringify({ ...here, settings: { ...here.settings, pageWatch: true, pageWatches: [watch('w1', 'https://file.example/')] } })) as SidebarState
    const off = run(ctx, here, { type: 'state/restore', state: file })
    expect(off.settings.pageWatch).toBe(false)
    expect(off.settings.pageWatches.map((w) => w.url)).toEqual(['https://file.example/'])

    const mine = watch('w2', 'https://mine.example/')
    const watching: SidebarState = { ...here, settings: { ...here.settings, pageWatch: true, pageWatches: [mine] } }
    const kept = run(ctx, watching, { type: 'state/restore', state: file })
    expect(kept.settings.pageWatch).toBe(true)
    expect(kept.settings.pageWatches.map((w) => w.url)).toEqual(['https://mine.example/'])
  })
})
