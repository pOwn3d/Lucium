import { describe, expect, it } from 'vitest'
import type { Boost, BoostInput, Folder, SidebarState, TabItem } from './model'
import { BOOST_JS_MAX, SIDEBAR_WIDTH_LEGACY, STATE_REVISION, tabName } from './model'
import { activeTab, createInitialState, normalize, reduce, sidebarOrder, stepSpace, stepTab, visibleTabOrder, type Action, type Ctx } from './sidebar'
import { FOLDER_MAX_DEPTH, folderDepth } from './folders'
import { PERMISSIONS_PER_SITE_MAX, SITE_PERMISSIONS_MAX, cleanSitePermissions } from './state-clean'
import { defaultTheme, hexToHsl, themeHue } from './theme'

const HOUR = 3_600_000

function makeCtx(now = 1_000_000): Ctx & { advance(ms: number): void } {
  let n = 0
  const ctx = {
    now,
    newId: () => `id${++n}`,
    advance(ms: number) {
      ctx.now += ms
    }
  }
  return ctx
}

function run(ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState {
  return actions.reduce((s, a) => reduce(s, a, ctx), state)
}

const titles = (s: SidebarState, pinned: boolean) => s.tabs.filter((t) => t.pinned === pinned).map((t) => t.url.split('/')[2])

describe('tabs', () => {
  it('opens a tab in Today and selects it', () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    expect(activeTab(s)?.url).toBe('https://a.fr/')
    expect(activeTab(s)?.pinned).toBe(false)
  })

  it('refuses to open non-web URLs', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(run(ctx, base, { type: 'tab/open', url: 'javascript:alert(1)' }).tabs).toHaveLength(0)
  })

  it('opens a page of an extension only when an extension asked for it', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const page = `chrome-extension://${'a'.repeat(32)}/options.html`
    expect(run(ctx, base, { type: 'tab/open', url: page }).tabs).toHaveLength(0)
    expect(activeTab(run(ctx, base, { type: 'tab/open', url: page, allowExtensionPages: true }))?.url).toBe(page)
    // The flag opens extension pages and nothing else.
    expect(run(ctx, base, { type: 'tab/open', url: 'javascript:alert(1)', allowExtensionPages: true }).tabs).toHaveLength(0)
    expect(run(ctx, base, { type: 'tab/open', url: 'chrome-extension://short/x.html', allowExtensionPages: true }).tabs).toHaveLength(0)
  })

  it('ignores unknown actions instead of corrupting the state', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(reduce(base, { type: 'nope' } as unknown as Action, ctx)).toBe(base)
  })

  it('does not make a new state for a late update of a tab that is gone', () => {
    const ctx = makeCtx()
    const base = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = base.tabs[0]!.id
    const closed = run(ctx, base, { type: 'tab/close', id })
    expect(reduce(closed, { type: 'tab/update', id, patch: { title: 'Trop tard', url: 'https://a.fr/late' } }, ctx)).toBe(closed)
    expect(reduce(base, { type: 'tab/update', id: 'never-there', patch: { title: 'x' } }, ctx)).toBe(base)
    // A tab that is there still takes its update.
    expect(reduce(base, { type: 'tab/update', id, patch: { title: 'Titre' } }, ctx).tabs[0]?.title).toBe('Titre')
  })

  it('selects the next Today tab when the active one is closed', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'tab/select', id: b!.id }, { type: 'tab/close', id: b!.id })
    expect(activeTab(s)?.id).toBe(c!.id)
    s = run(ctx, s, { type: 'tab/close', id: c!.id })
    expect(activeTab(s)?.id).toBe(a!.id)
    s = run(ctx, s, { type: 'tab/close', id: a!.id })
    expect(activeTab(s)).toBeUndefined()
  })

  it('pins at the end of the pinned list and unpins to the top of Today', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: c!.id }, { type: 'tab/pin', id: a!.id })
    expect(titles(s, true)).toEqual(['c.fr', 'a.fr'])
    expect(titles(s, false)).toEqual(['b.fr'])
    s = run(ctx, s, { type: 'tab/unpin', id: c!.id })
    expect(titles(s, false)).toEqual(['c.fr', 'b.fr'])
    expect(s.tabs.find((t) => t.id === c!.id)?.anchorUrl).toBeUndefined()
    void b
  })

  it('a partial update never erases the fields it leaves out', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/update', id, patch: { title: 'Nouveau titre', url: undefined, faviconUrl: undefined } })
    expect(s.tabs[0]).toMatchObject({ url: 'https://a.fr/', title: 'Nouveau titre' })
  })

  it('a page that repeats its title and address makes no new state (nothing to save, nothing to draw again)', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/update', id, patch: { title: 'Titre', faviconUrl: 'https://a.fr/icon.png' } })
    expect(reduce(s, { type: 'tab/update', id, patch: { title: 'Titre', url: 'https://a.fr/', faviconUrl: 'https://a.fr/icon.png' } }, ctx)).toBe(s)
    expect(reduce(s, { type: 'tab/update', id, patch: { title: undefined } }, ctx)).toBe(s)
    expect(reduce(s, { type: 'tab/update', id: 'gone', patch: { title: 'Autre' } }, ctx)).toBe(s)
    const retitled = reduce(s, { type: 'tab/update', id, patch: { title: 'Autre titre' } }, ctx)
    expect(retitled).not.toBe(s)
    expect(retitled.tabs[0]!.title).toBe('Autre titre')
  })

  it('a pinned tab whose page repeats its title keeps the tidy one and makes no new state', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { title: 'Pull requests · org/repo · GitHub' } })
    expect(reduce(s, { type: 'tab/update', id, patch: { title: 'Pull requests · org/repo · GitHub' } }, ctx)).toBe(s)
  })

  it('closing a pinned tab keeps it and returns it to its anchor URL', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://a.fr/deep/page' } }, { type: 'tab/close', id })
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0]?.url).toBe('https://a.fr/')
  })

  it('moves a tab to a precise index, across pinned and Today', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, , c] = s.tabs
    s = run(ctx, s, { type: 'tab/move', id: c!.id, toIndex: 0, pinned: false })
    expect(titles(s, false)).toEqual(['c.fr', 'a.fr', 'b.fr'])
    s = run(ctx, s, { type: 'tab/move', id: a!.id, toIndex: 99, pinned: true })
    expect(titles(s, true)).toEqual(['a.fr'])
    expect(s.tabs.find((t) => t.id === a!.id)?.anchorUrl).toBe('https://a.fr/')
  })
})

describe('spaces', () => {
  it('never deletes the last space', () => {
    const ctx = makeCtx()
    const base = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    // The very same state, its tabs included: a state always has a space, so a count of one would also pass for a fresh space put in its place.
    expect(run(ctx, base, { type: 'space/delete', id: base.activeSpaceId })).toBe(base)
  })

  it('deleting a space removes its tabs and moves the selection', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    const first = s.activeSpaceId
    s = run(ctx, s, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10 })
    const second = s.activeSpaceId
    s = run(ctx, s, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'space/delete', id: second })
    expect(s.activeSpaceId).toBe(first)
    expect(s.tabs.map((t) => t.url)).toEqual(['https://a.fr/'])
    expect(s.activeTabBySpace[second]).toBeUndefined()
  })
})

describe('Today housekeeping', () => {
  it('clear removes unpinned tabs but keeps pinned and the selected one', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: a!.id }, { type: 'tab/select', id: b!.id }, { type: 'today/clear' })
    expect(s.tabs.map((t) => t.id)).toEqual([a!.id, b!.id])
    void c
  })

  it('auto-archive only takes idle, unselected, unpinned tabs, and restore brings them back', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://old.fr/' }, { type: 'tab/open', url: 'https://pinned.fr/' }, { type: 'tab/open', url: 'https://current.fr/' })
    const [old, pinned] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: pinned!.id })
    ctx.advance(13 * HOUR)
    s = run(ctx, s, { type: 'tab/select', id: s.tabs.find((t) => t.url === 'https://current.fr/')!.id }, { type: 'archive/sweep' })
    expect(s.archive.map((a) => a.url)).toEqual(['https://old.fr/'])
    expect(s.tabs.map((t) => t.url).sort()).toEqual(['https://current.fr/', 'https://pinned.fr/'])
    s = run(ctx, s, { type: 'archive/restore', id: old!.id })
    expect(s.archive).toHaveLength(0)
    expect(activeTab(s)?.url).toBe('https://old.fr/')
  })

  it('auto-archive is off when the delay is 0', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { autoArchiveHours: 0 } }, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' })
    ctx.advance(100 * HOUR)
    s = run(ctx, s, { type: 'archive/sweep' })
    expect(s.archive).toHaveLength(0)
  })
})

describe('normalize', () => {
  it('drops tabs of unknown spaces and dangling folder or active references', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const broken: SidebarState = {
      ...base,
      activeSpaceId: 'ghost',
      tabs: [
        { id: 't1', spaceId: base.activeSpaceId, url: 'https://a.fr/', title: 'a', pinned: true, folderId: 'gone', createdAt: 0, lastActiveAt: 0 },
        { id: 't2', spaceId: 'ghost', url: 'https://b.fr/', title: 'b', pinned: false, createdAt: 0, lastActiveAt: 0 }
      ],
      activeTabBySpace: { [base.activeSpaceId]: 't2' }
    }
    const fixed = normalize(broken)
    expect(fixed.activeSpaceId).toBe(base.activeSpaceId)
    expect(fixed.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(fixed.tabs[0]?.folderId).toBeUndefined()
    expect(fixed.activeTabBySpace[base.activeSpaceId]).toBeNull()
  })
})

describe('space editing', () => {
  it('renames and re-icons a space; an empty name is ignored', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const id = base.activeSpaceId
    let s = run(ctx, base, { type: 'space/update', id, patch: { name: '  Boulot  ', emoji: '💼' } })
    expect(s.spaces[0]).toMatchObject({ name: '  Boulot  ', emoji: '💼' })
    s = run(ctx, s, { type: 'space/update', id, patch: { name: '   ' } })
    expect(s.spaces[0]?.name).toBe('  Boulot  ')
  })

  it('merges a partial theme and repairs it: unknown values never reach the saved theme', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const id = base.activeSpaceId
    const s = run(ctx, base, { type: 'space/update', id, patch: { theme: { intensity: 0.4, overlay: 'coarse', angle: 999, baseColors: ['#112233', 'zzz'] as never, harmony: 'custom' } } })
    expect(s.spaces[0]!.theme).toMatchObject({ intensity: 0.4, overlay: 'coarse', angle: 360, harmony: 'custom', baseColors: ['#112233'] })
    // Fields the patch left out stay as they were.
    expect(s.spaces[0]!.theme.vibrant).toBe(base.spaces[0]!.theme.vibrant)
  })

  it('reorders spaces', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'B', emoji: 'b', hue: 1 }, { type: 'space/create', name: 'C', emoji: 'c', hue: 2 })
    s = run(ctx, s, { type: 'space/move', id: s.spaces[2]!.id, toIndex: 0 })
    expect(s.spaces.map((sp) => sp.name)).toEqual(['C', 'Perso', 'B'])
  })

  it('moving a tab to another space unpins it and hands the selection to a neighbour', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    const first = s.activeSpaceId
    s = run(ctx, s, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 0 })
    const other = s.activeSpaceId
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: b!.id }, { type: 'tab/select', id: b!.id }, { type: 'tab/move-to-space', id: b!.id, spaceId: other })
    const moved = s.tabs.find((t) => t.id === b!.id)!
    expect(moved).toMatchObject({ spaceId: other, pinned: false, anchorUrl: undefined })
    expect(s.activeTabBySpace[first]).toBe(a!.id)
  })

  it('refuses to move a tab to a space that does not exist', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const before = s
    s = run(ctx, s, { type: 'tab/move-to-space', id: s.tabs[0]!.id, spaceId: 'ghost' })
    expect(s).toBe(before)
  })
})

describe('tab helpers', () => {
  it('duplicates a tab into the same space and selects the copy', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    s = run(ctx, s, { type: 'tab/duplicate', id: s.tabs[0]!.id })
    expect(s.tabs.map((t) => t.url)).toEqual(['https://a.fr/', 'https://a.fr/'])
    expect(activeTab(s)?.id).toBe(s.tabs[1]!.id)
  })

  it('close-others keeps pinned tabs and the chosen one', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: a!.id }, { type: 'tab/close-others', id: b!.id })
    expect(s.tabs.map((t) => t.id)).toEqual([a!.id, b!.id])
    expect(activeTab(s)?.id).toBe(b!.id)
  })

  it('renames a folder but ignores a blank name', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Docs' })
    const id = s.folders[0]!.id
    s = run(ctx, s, { type: 'folder/rename', id, name: ' Références ' }, { type: 'folder/rename', id, name: '  ' })
    expect(s.folders[0]?.name).toBe('Références')
  })
})

describe('permissions and settings', () => {
  it('remembers and forgets a permission decision per origin', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'permission/set', origin: 'https://a.fr', permission: 'geolocation', decision: 'deny' })
    expect(s.sitePermissions['https://a.fr']).toEqual({ geolocation: 'deny' })
    s = run(ctx, s, { type: 'permission/set', origin: 'https://a.fr', permission: 'geolocation', decision: null })
    // An origin with no answer left is no entry (a file would not hold an empty one, and the record would only grow).
    expect(s.sitePermissions['https://a.fr']).toBeUndefined()
  })

  it('keeps the remembered answers within their ceilings: the longest unused go first', () => {
    const ctx = makeCtx()
    // The record starts five sites short of its ceiling, as the reducer would have left it: each answer copies the whole record, and two thousand
    // of them one by one are three seconds of processor that say nothing more. The reducer takes it to the ceiling and five sites past it.
    const start = SITE_PERMISSIONS_MAX - 5
    let s: SidebarState = { ...createInitialState(ctx), sitePermissions: Object.fromEntries(Array.from({ length: start }, (_, i) => [`https://site${i}.example`, { camera: 'allow' as const }])) }
    s = reduce(s, { type: 'permission/set', origin: `https://site${start}.example`, permission: 'camera', decision: 'allow' }, ctx)
    // What the reducer writes is what the record was filled with, in the same order.
    expect(Object.entries(s.sitePermissions).slice(-2)).toEqual([[`https://site${start - 1}.example`, { camera: 'allow' }], [`https://site${start}.example`, { camera: 'allow' }]])
    expect(Object.keys(s.sitePermissions)).toHaveLength(start + 1)
    for (let i = start + 1; i < SITE_PERMISSIONS_MAX + 5; i++) s = reduce(s, { type: 'permission/set', origin: `https://site${i}.example`, permission: 'camera', decision: 'allow' }, ctx)
    expect(Object.keys(s.sitePermissions)).toHaveLength(SITE_PERMISSIONS_MAX)
    expect(Object.keys(s.sitePermissions)[0]).toBe('https://site5.example')
    expect(s.sitePermissions['https://site0.example']).toBeUndefined()
    expect(s.sitePermissions[`https://site${SITE_PERMISSIONS_MAX + 4}.example`]).toEqual({ camera: 'allow' })
    // An answer that is used again is the newest, and stays when the next site arrives.
    s = reduce(s, { type: 'permission/set', origin: 'https://site5.example', permission: 'camera', decision: 'deny' }, ctx)
    s = reduce(s, { type: 'permission/set', origin: 'https://another.example', permission: 'camera', decision: 'allow' }, ctx)
    expect(s.sitePermissions['https://site5.example']).toEqual({ camera: 'deny' })
    expect(s.sitePermissions['https://site6.example']).toBeUndefined()
    for (let i = 0; i < PERMISSIONS_PER_SITE_MAX + 3; i++) s = reduce(s, { type: 'permission/set', origin: 'https://many.example', permission: `perm-${i}`, decision: 'deny' }, ctx)
    expect(Object.keys(s.sitePermissions['https://many.example']!)).toHaveLength(PERMISSIONS_PER_SITE_MAX)
    expect(s.sitePermissions['https://many.example']!['perm-0']).toBeUndefined()
  })

  it('keeps the last remembered answers of a file that holds more than the ceilings', () => {
    const sites = Object.fromEntries(Array.from({ length: SITE_PERMISSIONS_MAX + 10 }, (_, i) => [`https://s${i}.example`, { camera: 'allow' }]))
    const kept = cleanSitePermissions(sites)
    expect(Object.keys(kept)).toHaveLength(SITE_PERMISSIONS_MAX)
    expect(kept['https://s9.example']).toBeUndefined()
    expect(kept['https://s10.example']).toEqual({ camera: 'allow' })
    const answers = Object.fromEntries(Array.from({ length: PERMISSIONS_PER_SITE_MAX + 10 }, (_, i) => [`p${i}`, 'deny']))
    expect(Object.keys(cleanSitePermissions({ 'https://a.example': answers })['https://a.example']!)).toHaveLength(PERMISSIONS_PER_SITE_MAX)
  })

  it('starts the host of Chrome only for an explicit yes: anything but true stays off', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(base.settings.chromeNativeHosts).toBe(false)
    expect(run(ctx, base, { type: 'settings/update', patch: { chromeNativeHosts: true } }).settings.chromeNativeHosts).toBe(true)
    for (const odd of ['yes', 1, null]) expect(run(ctx, base, { type: 'settings/update', patch: { chromeNativeHosts: odd as never } }).settings.chromeNativeHosts).toBe(false)
  })

  it('keeps the sidebar width inside its bounds', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(run(ctx, base, { type: 'settings/update', patch: { sidebarWidth: 50 } }).settings.sidebarWidth).toBe(200)
    expect(run(ctx, base, { type: 'settings/update', patch: { sidebarWidth: 9999 } }).settings.sidebarWidth).toBe(420)
  })

  it('gives the 323 px width to a file that still holds the old default width, and keeps any other width the user chose', () => {
    const ctx = makeCtx()
    const { revision: _revision, ...base } = createInitialState(ctx)
    expect(base.settings.sidebarWidth).toBe(323)
    // A file written before the revisions of the format: the width it holds is the old default.
    expect(normalize({ ...base, settings: { ...base.settings, sidebarWidth: 264 } }).settings.sidebarWidth).toBe(323)
    expect(normalize({ ...base, settings: { ...base.settings, sidebarWidth: 300 } }).settings.sidebarWidth).toBe(300)
  })

  it('keeps a width of 264 px the user chose: the migration is marked done, not guessed from the value', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(base.revision).toBe(STATE_REVISION)
    // Set by hand, saved, read back at every launch: 264 stays.
    const chosen = run(ctx, base, { type: 'settings/update', patch: { sidebarWidth: SIDEBAR_WIDTH_LEGACY } })
    expect(chosen.settings.sidebarWidth).toBe(SIDEBAR_WIDTH_LEGACY)
    const once = normalize(JSON.parse(JSON.stringify(chosen)))
    expect(once.settings.sidebarWidth).toBe(SIDEBAR_WIDTH_LEGACY)
    expect(normalize(JSON.parse(JSON.stringify(once))).settings.sidebarWidth).toBe(SIDEBAR_WIDTH_LEGACY)
    // An old file is migrated once, and marked: the next load leaves the width alone.
    const { revision: _r, ...old } = { ...base, settings: { ...base.settings, sidebarWidth: SIDEBAR_WIDTH_LEGACY } }
    const migrated = normalize(old as typeof base)
    expect([migrated.settings.sidebarWidth, migrated.revision]).toEqual([323, STATE_REVISION])
    // A revision this build does not know yet is kept: that file went through migrations a later build made, and must not go through them again there.
    expect(normalize({ ...base, revision: STATE_REVISION + 4 }).revision).toBe(STATE_REVISION + 4)
    for (const junk of [0, -1, 1.5, '1', null, Number.NaN]) expect(normalize({ ...old, revision: junk } as unknown as typeof base).settings.sidebarWidth, String(junk)).toBe(323)
  })

  it('fills settings and permissions missing from a state saved by an older build', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const { sitePermissions: _p, ...rest } = base
    const old = { ...rest, settings: { searchUrlTemplate: 'https://x/?q=%s', sidebarVisible: true, autoArchiveHours: 1, sleepAfterMinutes: 5, extensionPaths: [] } }
    const fixed = normalize(old as unknown as SidebarState)
    expect(fixed.sitePermissions).toEqual({})
    expect(fixed.settings.sidebarWidth).toBe(323)
    expect(fixed.settings.siteSearches.length).toBeGreaterThan(0)
    expect(fixed.settings.searchUrlTemplate).toBe('https://x/?q=%s')
  })
})

describe('split view', () => {
  const open = (ctx: Ctx, s: SidebarState, ...urls: string[]) => run(ctx, s, ...urls.map((url): Action => ({ type: 'tab/open', url })))

  it('splits two tabs of a space and focuses the first', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/')
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id })
    expect(s.splits).toHaveLength(1)
    expect(s.splits[0]).toMatchObject({ tabIds: [a!.id, b!.id], orientation: 'horizontal', ratios: [0.5, 0.5] })
    expect(activeTab(s)?.id).toBe(a!.id)
  })

  it('grows an existing split up to four panes, then refuses', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/', 'https://c.fr/', 'https://d.fr/', 'https://e.fr/')
    const [a, b, c, d, e] = s.tabs
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id }, { type: 'split/create', tabId: a!.id, withTabId: c!.id }, { type: 'split/create', tabId: d!.id, withTabId: a!.id })
    expect(s.splits[0]?.tabIds).toEqual([a!.id, b!.id, c!.id, d!.id])
    expect(s.splits[0]?.ratios.every((r) => Math.abs(r - 0.25) < 1e-9)).toBe(true)
    const full = s
    expect(run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: e!.id })).toBe(full)
  })

  it('refuses to split a tab with itself, across spaces, or to merge two splits', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/', 'https://c.fr/', 'https://d.fr/')
    const [a, b, c, d] = s.tabs
    expect(run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: a!.id })).toBe(s)
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id }, { type: 'split/create', tabId: c!.id, withTabId: d!.id })
    const two = s
    expect(run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: c!.id })).toBe(two)
    s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://x.fr/' }, { type: 'space/create', name: 'B', emoji: 'b', hue: 1 }, { type: 'tab/open', url: 'https://y.fr/' })
    expect(run(ctx, s, { type: 'split/create', tabId: s.tabs[0]!.id, withTabId: s.tabs[1]!.id }).splits).toHaveLength(0)
  })

  it('dissolves when a tab closes and leaves fewer than two panes', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/', 'https://c.fr/')
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id }, { type: 'split/create', tabId: a!.id, withTabId: c!.id })
    s = run(ctx, s, { type: 'tab/close', id: c!.id })
    expect(s.splits[0]?.tabIds).toEqual([a!.id, b!.id])
    expect(s.splits[0]?.ratios).toEqual([0.5, 0.5])
    s = run(ctx, s, { type: 'tab/close', id: b!.id })
    expect(s.splits).toHaveLength(0)
  })

  it('removing a tab from a two-pane split dissolves it; moving a tab to another space too', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/')
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id }, { type: 'split/remove', tabId: b!.id })
    expect(s.splits).toHaveLength(0)
    s = run(ctx, s, { type: 'split/create', tabId: a!.id, withTabId: b!.id }, { type: 'space/create', name: 'B', emoji: 'b', hue: 1 })
    const other = s.activeSpaceId
    s = run(ctx, s, { type: 'tab/move-to-space', id: b!.id, spaceId: other })
    expect(s.splits).toHaveLength(0)
  })

  it('accepts valid ratios, normalizes them, and rejects ones that crush a pane', () => {
    const ctx = makeCtx()
    let s = open(ctx, createInitialState(ctx), 'https://a.fr/', 'https://b.fr/')
    s = run(ctx, s, { type: 'split/create', tabId: s.tabs[0]!.id, withTabId: s.tabs[1]!.id })
    const id = s.splits[0]!.id
    expect(run(ctx, s, { type: 'split/ratios', id, ratios: [3, 1] }).splits[0]?.ratios).toEqual([0.75, 0.25])
    expect(run(ctx, s, { type: 'split/ratios', id, ratios: [0.99, 0.01] })).toBe(s)
    expect(run(ctx, s, { type: 'split/ratios', id, ratios: [0.5] })).toBe(s)
    expect(run(ctx, s, { type: 'split/orientation', id, orientation: 'vertical' }).splits[0]?.orientation).toBe('vertical')
  })
})

describe('boosts', () => {
  const save = (ctx: Ctx, s: SidebarState, boost: BoostInput) => run(ctx, s, { type: 'boost/save', boost })

  it('creates a boost with an id and a default name, normalizing the host', () => {
    const ctx = makeCtx()
    const s = save(ctx, createInitialState(ctx), { host: ' WWW.Example.com ', css: 'a{color:red}' })
    expect(s.boosts).toHaveLength(1)
    expect(s.boosts[0]).toMatchObject({ host: 'example.com', name: 'example.com', enabled: true, css: 'a{color:red}', js: '', zoom: 1, zap: [] })
    expect(s.boosts[0]!.id).toMatch(/^id\d+$/)
  })

  it('allows several boosts on one host and updates one by id', () => {
    const ctx = makeCtx()
    let s = save(ctx, createInitialState(ctx), { host: 'a.fr', name: 'Sombre', id: 'dark' })
    s = save(ctx, s, { host: 'a.fr', name: 'Lisible', id: 'read' })
    expect(s.boosts.map((b) => b.id)).toEqual(['dark', 'read'])
    s = save(ctx, s, { host: 'a.fr', name: 'Sombre v2', id: 'dark', enabled: false })
    expect(s.boosts).toHaveLength(2)
    expect(s.boosts.find((b) => b.id === 'dark')).toMatchObject({ name: 'Sombre v2', enabled: false })
  })

  it('refuses an empty host and ignores an unsafe id by generating a fresh one', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(save(ctx, base, { host: '  ' })).toBe(base)
    const s = save(ctx, base, { host: 'a.fr', id: 'bad id/../x' })
    expect(s.boosts[0]!.id).toMatch(/^id\d+$/)
  })

  it('deletes only the boost with that id', () => {
    const ctx = makeCtx()
    let s = save(ctx, createInitialState(ctx), { host: 'a.fr', id: 'one' })
    s = save(ctx, s, { host: 'a.fr', id: 'two' })
    expect(run(ctx, s, { type: 'boost/delete', id: 'one' }).boosts.map((b) => b.id)).toEqual(['two'])
  })

  it('clamps the colour filter and keeps the neutral values for nonsense', () => {
    const ctx = makeCtx()
    const t = save(ctx, createInitialState(ctx), { host: 'a.fr', tint: { hue: 900, saturation: -3, brightness: Number.NaN, contrast: 9 } }).boosts[0]!.tint
    expect(t).toEqual({ hue: 180, saturation: 0, brightness: 1, contrast: 1.5 })
  })

  it('gives a boost saved by an older build a stable id, a name and neutral colours', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const old = { ...base, boosts: [{ host: 'old.fr', enabled: true, css: 'a{}', js: '' }] }
    const fixed = normalize(old as unknown as SidebarState)
    expect(fixed.boosts[0]).toMatchObject({ id: 'legacy-old.fr', name: 'old.fr', zoom: 1, zap: [], tint: { hue: 0, saturation: 1, brightness: 1, contrast: 1 } })
  })
})

describe('boost zoom and zap', () => {
  const one = (ctx: Ctx, boost: BoostInput) => run(ctx, createInitialState(ctx), { type: 'boost/save', boost }).boosts[0]!

  it('keeps the stored Eraser list when a save says nothing of it, and replaces it when the save carries one', () => {
    const ctx = makeCtx()
    const stored = run(ctx, createInitialState(ctx), { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', zap: ['#ad', '.banner'] } })
    const silent = run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', css: 'p{}' }, draft: true })
    expect(silent.boosts[0]).toMatchObject({ css: 'p{}', zap: ['#ad', '.banner'] })
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', zap: ['#ad'] } }).boosts[0]!.zap).toEqual(['#ad'])
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', zap: [] } }).boosts[0]!.zap).toEqual([])
  })

  it('keeps the script being typed apart from the script the pages run, and loses neither', () => {
    const ctx = makeCtx()
    const typing = run(ctx, createInitialState(ctx), { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: 'half(' }, draft: true })
    expect(typing.boosts[0]).toMatchObject({ js: 'saved()', jsDraft: 'half(' })
    // A save that says nothing of the draft (a rename from a panel, the Eraser) leaves it where it is.
    expect(run(ctx, typing, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', name: 'Autre' } }).boosts[0]).toMatchObject({ name: 'Autre', js: 'saved()', jsDraft: 'half(' })
    // An emptied field is a draft too: the saved script is still there.
    expect(run(ctx, typing, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: '' } }).boosts[0]).toMatchObject({ js: 'saved()', jsDraft: '' })
    // Saved by the person: the draft is the script, and there is no draft any more.
    const saved = run(ctx, typing, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'done()', jsDraft: 'done()' } }).boosts[0]!
    expect(saved.js).toBe('done()')
    expect(saved).not.toHaveProperty('jsDraft')
  })

  it('refuses a draft past the bound of a script, and one that is not a text', () => {
    const ctx = makeCtx()
    const stored = run(ctx, createInitialState(ctx), { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: 'typed(' } })
    // Refused as a whole: cutting it would keep a text that was never typed, and dropping it would lose the draft that was.
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: 'x'.repeat(BOOST_JS_MAX + 1) } }).boosts[0]).toMatchObject({ js: 'saved()', jsDraft: 'typed(' })
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: 'x'.repeat(BOOST_JS_MAX) } }).boosts[0]!.jsDraft).toHaveLength(BOOST_JS_MAX)
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: 5 as never } }).boosts[0]).not.toHaveProperty('jsDraft')
  })

  it('refuses as the script of a Tweak one that does not show what it runs; as a draft it is kept, and runs nowhere', () => {
    const ctx = makeCtx()
    const stored = run(ctx, createInitialState(ctx), { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()' } })
    for (const hidden of ['\u202E', '\u2067', '\u2028', '\u2029']) {
      expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: `a() // x${hidden}b()` } }), hidden.codePointAt(0)!.toString(16)).toBe(stored)
      expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'saved()', jsDraft: `a(${hidden})` } }).boosts[0]).toMatchObject({ js: 'saved()', jsDraft: `a(${hidden})` })
    }
    // Another invisible character hides nothing: the script is taken.
    expect(run(ctx, stored, { type: 'boost/save', boost: { id: 'b1', host: 'a.fr', js: 'a("x\u200By")' } }).boosts[0]!.js).toBe('a("x\u200By")')
    // A Tweak stored that way by an earlier version can still be renamed or switched off: its script is not what the save changes.
    const old = { ...stored, boosts: [{ ...stored.boosts[0]!, js: 'a(\u202E)' }] }
    expect(run(ctx, old, { type: 'boost/save', boost: { ...old.boosts[0]!, name: 'Ancienne', enabled: false } }).boosts[0]).toMatchObject({ name: 'Ancienne', enabled: false, js: 'a(\u202E)' })
  })

  it('clamps the zoom and falls back to 100 % on nonsense', () => {
    const ctx = makeCtx()
    expect(one(ctx, { host: 'a.fr', zoom: 9 }).zoom).toBe(3)
    expect(one(ctx, { host: 'a.fr', zoom: 0.1 }).zoom).toBe(0.5)
    expect(one(ctx, { host: 'a.fr', zoom: 1.25 }).zoom).toBe(1.25)
    expect(one(ctx, { host: 'a.fr', zoom: Number.NaN }).zoom).toBe(1)
  })

  it('refuses zap selectors that could break out of the generated CSS rule', () => {
    const ctx = makeCtx()
    const zap = ['#ad', 'div > p.promo:nth-of-type(2)', 'a { } body', 'x;y', '', 'z}']
    expect(one(ctx, { host: 'a.fr', zap }).zap).toEqual(['#ad', 'div > p.promo:nth-of-type(2)'])
  })
})

describe('command bar usage', () => {
  it('counts picks per key and keeps only the most used ones past the limit', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    s = run(ctx, s, { type: 'commandbar/used', key: 'url:https://a.fr/' }, { type: 'commandbar/used', key: 'url:https://a.fr/' })
    expect(s.commandBarUsage['default']!['url:https://a.fr/']).toBe(2)
    for (let i = 0; i < 320; i++) s = run(ctx, s, { type: 'commandbar/used', key: `url:https://k${i}.fr/` })
    expect(Object.keys(s.commandBarUsage['default']!).length).toBe(300)
    expect(s.commandBarUsage['default']!['url:https://a.fr/']).toBe(2)
  })

  it('ignores empty or absurdly long keys', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    expect(run(ctx, base, { type: 'commandbar/used', key: '' })).toBe(base)
    expect(run(ctx, base, { type: 'commandbar/used', key: 'x'.repeat(401) })).toBe(base)
  })
})

describe('archive actions', () => {
  const three = (ctx: Ctx) => {
    const s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    return { s, ids: s.tabs.map((t) => t.id) as [string, string, string] }
  }

  it('archives one Today tab by hand and tags it', () => {
    const ctx = makeCtx()
    const { s, ids } = three(ctx)
    const next = run(ctx, s, { type: 'tab/archive', id: ids[1] })
    expect(next.tabs.map((t) => t.id)).toEqual([ids[0], ids[2]])
    expect(next.archive[0]).toMatchObject({ url: 'https://b.fr/', source: 'manual' })
  })

  it('never archives a pinned tab', () => {
    const ctx = makeCtx()
    const { s, ids } = three(ctx)
    const pinned = run(ctx, s, { type: 'tab/pin', id: ids[0] })
    expect(run(ctx, pinned, { type: 'tab/archive', id: ids[0] })).toBe(pinned)
  })

  it('archives the tabs above, below or all the others, leaving pinned ones alone', () => {
    const ctx = makeCtx()
    const { s, ids } = three(ctx)
    const pinned = run(ctx, s, { type: 'tab/pin', id: ids[0] })
    expect(run(ctx, pinned, { type: 'tab/archive-group', id: ids[2], scope: 'above' }).tabs.map((t) => t.id)).toEqual([ids[0], ids[2]])
    expect(run(ctx, s, { type: 'tab/archive-group', id: ids[0], scope: 'below' }).tabs.map((t) => t.id)).toEqual([ids[0]])
    expect(run(ctx, pinned, { type: 'tab/archive-group', id: ids[1], scope: 'others' }).tabs.map((t) => t.id)).toEqual([ids[0], ids[1]])
  })

  it('hands the selection to a neighbour when the active tab is archived', () => {
    const ctx = makeCtx()
    const { s, ids } = three(ctx)
    const next = run(ctx, s, { type: 'tab/archive', id: ids[2] })
    expect(activeTab(next)?.id).toBe(ids[1])
    const all = run(ctx, s, { type: 'tab/archive-group', id: ids[2], scope: 'above' })
    expect(activeTab(all)?.id).toBe(ids[2])
  })

  it('applies a per-profile threshold over the global one', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 1, profileId: 'work' }, { type: 'tab/open', url: 'https://old.fr/' }, { type: 'tab/open', url: 'https://current.fr/' })
    s = run(ctx, s, { type: 'settings/update', patch: { autoArchiveHours: 24, profiles: { work: { autoArchiveHours: 6 } } } })
    ctx.advance(7 * HOUR)
    expect(run(ctx, s, { type: 'archive/sweep' }).archive.map((a) => a.url)).toEqual(['https://old.fr/'])
    const off = run(ctx, s, { type: 'settings/update', patch: { profiles: { work: { autoArchiveHours: 0 } } } })
    expect(run(ctx, off, { type: 'archive/sweep' }).archive).toHaveLength(0)
  })
})

describe('separate from the pinned tab', () => {
  it('turns the visited page into a Today tab and restores the pin to its anchor', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://home.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://home.fr/deep', title: 'Deep page' } }, { type: 'tab/separate', id })
    expect(s.tabs.find((t) => t.id === id)).toMatchObject({ pinned: true, url: 'https://home.fr/' })
    const copy = s.tabs.find((t) => !t.pinned)!
    expect(copy).toMatchObject({ url: 'https://home.fr/deep', title: 'Deep page' })
    expect(activeTab(s)?.id).toBe(copy.id)
  })

  it('does nothing when the pinned tab is still on its anchor or is not pinned', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://home.fr/' })
    const id = s.tabs[0]!.id
    expect(run(ctx, s, { type: 'tab/separate', id })).toBe(s)
    s = run(ctx, s, { type: 'tab/pin', id })
    expect(run(ctx, s, { type: 'tab/separate', id })).toBe(s)
  })
})

describe('archive/add', () => {
  it('records a closed mini window page, refusing non-web URLs and falling back to the current space', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const s = run(ctx, base, { type: 'archive/add', url: 'https://a.fr/x', title: '', spaceId: 'ghost', source: 'little' })
    expect(s.archive[0]).toMatchObject({ url: 'https://a.fr/x', title: 'a.fr', spaceId: base.activeSpaceId, source: 'little' })
    expect(run(ctx, base, { type: 'archive/add', url: 'javascript:alert(1)', title: 'x', source: 'little' })).toBe(base)
  })
})

describe('keyboard shortcut settings', () => {
  it('keeps valid overrides and explicit disables, and drops the rest on every settings update', () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), {
      type: 'settings/update',
      patch: { keyBindings: { newTab: 'CmdOrCtrl+Alt+N', find: '', ghost: 'CmdOrCtrl+Q', reload: 'R' } }
    })
    expect(s.settings.keyBindings).toEqual({ newTab: 'CmdOrCtrl+Alt+N', find: '' })
  })
})

describe('space theme', () => {
  it('upgrades a space saved with a hue, saturation and grain to a theme with the same look', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const id = base.activeSpaceId
    const old = { ...base, spaces: [{ id, name: 'Perso', emoji: '🏠', hue: 120, saturation: 60, grain: 50, profileId: 'default' }] }
    const upgraded = normalize(old as unknown as SidebarState).spaces[0] as unknown as Record<string, unknown>
    expect(upgraded).not.toHaveProperty('hue')
    expect(upgraded).not.toHaveProperty('grain')
    expect((upgraded.theme as { noise: number; baseColors: string[] }).noise).toBe(0.5)
    expect(Math.round(hexToHsl((upgraded.theme as { baseColors: string[] }).baseColors[0]!).h)).toBe(120)
  })

  it('gives a space with no theme at all the default one', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const bare = { ...base, spaces: [{ id: base.activeSpaceId, name: 'x', emoji: 'x', profileId: 'default' }] }
    expect(normalize(bare as unknown as SidebarState).spaces[0]!.theme).toEqual(defaultTheme())
  })

  it('creates a space themed from the requested hue', () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'Vert', emoji: '🌱', hue: 130 })
    expect(themeHue(s.spaces[1]!.theme)).toBe(130)
  })
})

describe('tidy pinned titles', () => {
  const open = (tidy: boolean) => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { tidyPinnedTitles: tidy } }, { type: 'tab/open', url: 'https://github.com/org/repo' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/update', id, patch: { title: 'Pull requests · org/repo · GitHub' } })
    return { ctx, s, id }
  }

  it('shortens the title when a tab is pinned, and keeps it short when the page renames itself', () => {
    const { ctx, s, id } = open(true)
    const pinned = run(ctx, s, { type: 'tab/pin', id })
    expect(pinned.tabs.find((t) => t.id === id)?.title).toBe('GitHub')
    const renamed = run(ctx, pinned, { type: 'tab/update', id, patch: { title: 'Issues · org/repo · GitHub' } })
    expect(renamed.tabs.find((t) => t.id === id)?.title).toBe('GitHub')
  })

  it('leaves titles alone when the setting is off, and never touches an unpinned tab', () => {
    const off = open(false)
    expect(run(off.ctx, off.s, { type: 'tab/pin', id: off.id }).tabs.find((t) => t.id === off.id)?.title).toBe('Pull requests · org/repo · GitHub')
    const on = open(true)
    expect(on.s.tabs.find((t) => t.id === on.id)?.title).toBe('Pull requests · org/repo · GitHub')
  })
})

describe('profile names', () => {
  it('keeps trimmed display names for safe profile ids and drops the rest', () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), {
      type: 'settings/update',
      patch: { profileNames: { work: '  Travail  ', 'bad id!': 'x', empty: '   ', long: 'x'.repeat(100), num: 3 as unknown as string } }
    })
    expect(s.settings.profileNames).toEqual({ work: 'Travail', long: 'x'.repeat(40) })
  })

  it('repairs a saved file whose names are not a record', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const broken = { ...base, settings: { ...base.settings, profileNames: 'oops' as unknown as Record<string, string> } }
    expect(normalize(broken).settings.profileNames).toEqual({})
  })
})

describe('app icon', () => {
  it('keeps a known icon and falls back to the default for an unknown one', () => {
    const ctx = makeCtx()
    const set = (value: unknown) => run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { appIcon: value as string } }).settings.appIcon
    expect(set('cyber')).toBe('cyber')
    // The id of an icon of a former set becomes the nearest one of the current set.
    expect(set('graphite')).toBe('cyber')
    expect(set('nuit')).toBe('cyber')
    expect(set('boreal')).toBe('boreal')
    expect(set('../../etc/passwd')).toBe('clair')
    expect(set(undefined)).toBe('clair')
  })
})

describe('website appearance', () => {
  it('keeps light, dark and auto, and falls back to auto for anything else', () => {
    const ctx = makeCtx()
    const set = (value: unknown) => run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { websiteAppearance: value as 'auto' } }).settings.websiteAppearance
    expect(set('dark')).toBe('dark')
    expect(set('light')).toBe('light')
    expect(set('sepia')).toBe('auto')
    expect(set(undefined)).toBe('auto')
  })
})

describe('the appearance of Lucium', () => {
  it('keeps light, dark and auto, and falls back to auto for anything else', () => {
    const ctx = makeCtx()
    const set = (value: unknown) => run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { interfaceAppearance: value as 'auto' } }).settings.interfaceAppearance
    expect(set('dark')).toBe('dark')
    expect(set('light')).toBe('light')
    expect(set('sepia')).toBe('auto')
    expect(set(undefined)).toBe('auto')
  })

  it('is its own setting: choosing it leaves the appearance asked of the websites as it was, and the other way round', () => {
    const ctx = makeCtx()
    const both = run(ctx, run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { websiteAppearance: 'dark' } }), { type: 'settings/update', patch: { interfaceAppearance: 'light' } })
    expect([both.settings.interfaceAppearance, both.settings.websiteAppearance]).toEqual(['light', 'dark'])
    expect(run(ctx, both, { type: 'settings/update', patch: { websiteAppearance: 'auto' } }).settings.interfaceAppearance).toBe('light')
  })

  // A file saved before the two settings had names of their own has only `websiteAppearance`: Lucium is on Automatique (the Mac's), the websites keep what was chosen.
  it('is Automatique for a file saved before it existed, and the websites keep their choice', () => {
    const ctx = makeCtx()
    const state = createInitialState(ctx)
    const { interfaceAppearance: _gone, ...older } = state.settings
    const loaded = normalize({ ...state, settings: { ...older, websiteAppearance: 'dark' } as typeof state.settings })
    expect(loaded.settings.interfaceAppearance).toBe('auto')
    expect(loaded.settings.websiteAppearance).toBe('dark')
  })
})

describe('mini window delay', () => {
  it('keeps a delay of zero or more and repairs anything else', () => {
    const ctx = makeCtx()
    const set = (value: unknown) => run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { littleArcArchiveHours: value as number } }).settings.littleArcArchiveHours
    expect(set(0)).toBe(0)
    expect(set(6)).toBe(6)
    expect(set(-3)).toBe(12)
    expect(set(Number.NaN)).toBe(12)
    expect(set('x')).toBe(12)
  })
})

describe('new settings defaults', () => {
  it('start with Tweaks and the ad and cookie-banner blockers on, the tidy options off, and fill them for older saves', () => {
    const ctx = makeCtx()
    const { settings } = createInitialState(ctx)
    expect(settings).toMatchObject({ boostsEnabled: true, tidyPinnedTitles: false, tidyDownloads: false, blockAds: true, blockTrackers: true, blockCookieBanners: true, allowThemeToSites: false })
    const older = { ...createInitialState(ctx), settings: {} as never }
    expect(normalize(older).settings.boostsEnabled).toBe(true)
  })
})

describe('menu actions on the archive, folders and pinned tabs', () => {
  it('reopens the last archived tab, newest first, and does nothing with an empty archive', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' })
    expect(run(ctx, s, { type: 'archive/restore-last' })).toBe(s)
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'tab/archive', id: a!.id }, { type: 'tab/archive', id: b!.id })
    expect(s.tabs).toHaveLength(0)
    s = run(ctx, s, { type: 'archive/restore-last' })
    expect(s.tabs.map((t) => t.url)).toEqual(['https://b.fr/'])
    expect(s.archive.map((e) => e.url)).toEqual(['https://a.fr/'])
  })

  it('clears the archive', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    s = run(ctx, s, { type: 'tab/archive', id: s.tabs[0]!.id })
    expect(s.archive).toHaveLength(1)
    expect(run(ctx, s, { type: 'archive/clear' }).archive).toEqual([])
  })

  it('clears the archive but for the spaces it is told to keep (the locked ones)', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
    const [home, work] = s.spaces
    s = run(ctx, s, { type: 'archive/add', url: 'https://a.fr/', title: 'A', spaceId: home!.id, source: 'manual' }, { type: 'archive/add', url: 'https://b.fr/', title: 'B', spaceId: work!.id, source: 'manual' })
    expect(s.archive).toHaveLength(2)
    const cleared = run(ctx, s, { type: 'archive/clear', keepSpaces: [work!.id] })
    expect(cleared.archive.map((e) => e.url)).toEqual(['https://b.fr/'])
    // Nothing to remove: the same state.
    expect(run(ctx, cleared, { type: 'archive/clear', keepSpaces: [work!.id] })).toBe(cleared)
    // A list that is none (the action crossed IPC) keeps nothing.
    expect(run(ctx, s, { type: 'archive/clear', keepSpaces: 'x' as never }).archive).toEqual([])
  })

  it('collapses the folders of one space only', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'A' }, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const other = s.spaces[1]!.id
    s = run(ctx, s, { type: 'folder/create', name: 'B', spaceId: other })
    s = run(ctx, s, { type: 'folder/collapse-all', spaceId: s.spaces[0]!.id })
    expect(s.folders.map((f) => [f.name, f.collapsed])).toEqual([['A', true], ['B', false]])
  })

  it('sends the pinned tabs of a space back to their anchors', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' })
    const [a, b] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: a!.id }, { type: 'tab/update', id: a!.id, patch: { url: 'https://a.fr/deep' } }, { type: 'tab/update', id: b!.id, patch: { url: 'https://b.fr/elsewhere' } })
    s = run(ctx, s, { type: 'tabs/reset-pinned' })
    expect(s.tabs.find((t) => t.id === a!.id)?.url).toBe('https://a.fr/')
    expect(s.tabs.find((t) => t.id === b!.id)?.url).toBe('https://b.fr/elsewhere')
  })

  it('leaves a pinned tab that has no anchor alone instead of blanking its address', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    s = { ...s, tabs: s.tabs.map((t) => ({ ...t, pinned: true, anchorUrl: undefined })) }
    expect(run(ctx, s, { type: 'tabs/reset-pinned' }).tabs[0]?.url).toBe('https://a.fr/')
  })
})

describe('stepping through tabs and spaces', () => {
  const setup = () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Docs' }, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: b!.id }, { type: 'tab/pin', id: c!.id }, { type: 'tab/move', id: c!.id, toIndex: 0, pinned: true, folderId: s.folders[0]!.id })
    return { ctx, s, ids: { a: a!.id, b: b!.id, c: c!.id } }
  }

  it('lists loose pinned tabs, then folders, then Today', () => {
    const { s, ids } = setup()
    expect(sidebarOrder(s, s.activeSpaceId).map((t) => t.id)).toEqual([ids.b, ids.c, ids.a])
  })

  it('steps down and up the sidebar and wraps around', () => {
    const { ctx, s, ids } = setup()
    const at = (id: string) => run(ctx, s, { type: 'tab/select', id })
    expect(stepTab(at(ids.b), 1)).toBe(ids.c)
    expect(stepTab(at(ids.a), 1)).toBe(ids.b)
    expect(stepTab(at(ids.b), -1)).toBe(ids.a)
  })

  it('starts from the first or last tab when none is selected, and has nowhere to go without tabs', () => {
    const { s, ids } = setup()
    const none = { ...s, activeTabBySpace: { ...s.activeTabBySpace, [s.activeSpaceId]: null } }
    expect(stepTab(none, 1)).toBe(ids.b)
    expect(stepTab(none, -1)).toBe(ids.a)
    const ctx = makeCtx()
    expect(stepTab(createInitialState(ctx), 1)).toBeNull()
  })

  it('cycles through spaces, and not at all with a single one', () => {
    const ctx = makeCtx()
    let s = createInitialState(ctx)
    expect(stepSpace(s, 1)).toBeNull()
    s = run(ctx, s, { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 }, { type: 'space/create', name: 'Trois', emoji: '3', hue: 20 })
    const [one, two, three] = s.spaces.map((sp) => sp.id)
    s = run(ctx, s, { type: 'space/select', id: one! })
    expect(stepSpace(s, 1)).toBe(two)
    expect(stepSpace(s, -1)).toBe(three)
    expect(stepSpace(run(ctx, s, { type: 'space/select', id: three! }), 1)).toBe(one)
  })
})

describe('tab names and icons', () => {
  const setup = () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    return { ctx, s, id: s.tabs[0]!.id }
  }

  it('shows the name the user gave, survives the page renaming itself, and gives the title back when cleared', () => {
    const { ctx, s, id } = setup()
    let next = run(ctx, s, { type: 'tab/update', id, patch: { title: 'Titre de la page' } }, { type: 'tab/rename', id, title: '  Mon onglet  ' })
    expect(tabName(next.tabs[0]!)).toBe('Mon onglet')
    next = run(ctx, next, { type: 'tab/update', id, patch: { title: 'Autre titre' } })
    expect(tabName(next.tabs[0]!)).toBe('Mon onglet')
    next = run(ctx, next, { type: 'tab/rename', id, title: '   ' })
    expect(tabName(next.tabs[0]!)).toBe('Autre titre')
    expect(next.tabs[0]).not.toHaveProperty('customTitle')
  })

  it('cuts a very long name', () => {
    const { ctx, s, id } = setup()
    expect(run(ctx, s, { type: 'tab/rename', id, title: 'x'.repeat(500) }).tabs[0]!.customTitle).toHaveLength(120)
  })

  it('keeps an emoji as the icon and refuses text, then clears it', () => {
    const { ctx, s, id } = setup()
    const withIcon = run(ctx, s, { type: 'tab/icon', id, icon: '🚀' })
    expect(withIcon.tabs[0]!.icon).toBe('🚀')
    expect(run(ctx, withIcon, { type: 'tab/icon', id, icon: 'abc' }).tabs[0]).not.toHaveProperty('icon')
    expect(run(ctx, withIcon, { type: 'tab/icon', id, icon: '' }).tabs[0]).not.toHaveProperty('icon')
  })

  it('keeps a stored picture as the icon in place of the emoji, refuses anything that is not the name of a stored copy, and lets an emoji or the site’s icon take it away', () => {
    const { ctx, s, id } = setup()
    const picture = '0123456789abcdef01234567.png'
    const withPicture = run(ctx, s, { type: 'tab/icon', id, icon: '🚀' }, { type: 'tab/image', id, image: picture })
    expect(withPicture.tabs[0]!.image).toBe(picture)
    expect(withPicture.tabs[0]).not.toHaveProperty('icon')
    for (const bad of ['../secret.png', '/Users/x/photo.png', 'photo.png', '']) expect(run(ctx, s, { type: 'tab/image', id, image: bad }).tabs[0], bad).not.toHaveProperty('image')
    expect(run(ctx, withPicture, { type: 'tab/image', id, image: null }).tabs[0]).not.toHaveProperty('image')
    expect(run(ctx, withPicture, { type: 'tab/icon', id, icon: '🔥' }).tabs[0]).toMatchObject({ icon: '🔥' })
    expect(run(ctx, withPicture, { type: 'tab/icon', id, icon: '🔥' }).tabs[0]).not.toHaveProperty('image')
    expect(run(ctx, withPicture, { type: 'tab/icon', id, icon: '' }).tabs[0]).not.toHaveProperty('image')
  })

  it('gives no picture to a private tab, which is written nowhere', () => {
    const { ctx, s, id } = setup()
    const privateTab = { ...s, tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, private: true } : tab)) }
    expect(run(ctx, privateTab, { type: 'tab/image', id, image: '0123456789abcdef01234567.png' }).tabs[0]).not.toHaveProperty('image')
  })

  it('archives a renamed tab under the name the user gave it', () => {
    const { ctx, s, id } = setup()
    const archived = run(ctx, s, { type: 'tab/rename', id, title: 'Mon onglet' }, { type: 'tab/archive', id })
    expect(archived.archive[0]?.title).toBe('Mon onglet')
  })
})

describe('space header and folder copies', () => {
  it('hides and shows the space header, per space', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 })
    const [one, two] = s.spaces.map((sp) => sp.id)
    s = run(ctx, s, { type: 'space/header', id: one!, visible: false })
    expect(s.spaces.find((sp) => sp.id === one)?.hideHeader).toBe(true)
    expect(s.spaces.find((sp) => sp.id === two)).not.toHaveProperty('hideHeader')
    s = run(ctx, s, { type: 'space/header', id: one!, visible: true })
    expect(s.spaces.find((sp) => sp.id === one)).not.toHaveProperty('hideHeader')
  })

  it('duplicates a folder with copies of its tabs, right after it, and leaves the original alone', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Docs' }, { type: 'folder/create', name: 'Autre' }, { type: 'tab/open', url: 'https://a.fr/' })
    const folder = s.folders[0]!
    s = run(ctx, s, { type: 'tab/pin', id: s.tabs[0]!.id }, { type: 'tab/move', id: s.tabs[0]!.id, toIndex: 0, pinned: true, folderId: folder.id })
    s = run(ctx, s, { type: 'folder/duplicate', id: folder.id })
    expect(s.folders.map((f) => f.name)).toEqual(['Docs', 'Docs (copie)', 'Autre'])
    const copy = s.folders[1]!
    const inCopy = s.tabs.filter((t) => t.folderId === copy.id)
    expect(inCopy.map((t) => t.url)).toEqual(['https://a.fr/'])
    expect(s.tabs.filter((t) => t.folderId === folder.id)).toHaveLength(1)
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(s.tabs.length)
  })

  it('ignores a folder that is gone', () => {
    const ctx = makeCtx()
    const s = createInitialState(ctx)
    expect(run(ctx, s, { type: 'folder/duplicate', id: 'nope' })).toBe(s)
  })
})

describe('moving a pane of a split view', () => {
  const setup = () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const [a, b, c] = s.tabs.map((t) => t.id)
    s = run(ctx, s, { type: 'split/create', tabId: a!, withTabId: b! }, { type: 'split/create', tabId: a!, withTabId: c! })
    s = run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.2, 0.3, 0.5] })
    return { ctx, s, a: a!, b: b!, c: c! }
  }

  it('swaps a pane with its neighbour together with its size', () => {
    const { ctx, s, a, b, c } = setup()
    expect(s.splits[0]!.tabIds).toEqual([a, b, c])
    const moved = run(ctx, s, { type: 'split/move', tabId: a, direction: 1 })
    expect(moved.splits[0]!.tabIds).toEqual([b, a, c])
    expect(moved.splits[0]!.ratios).toEqual([0.3, 0.2, 0.5])
    expect(run(ctx, moved, { type: 'split/move', tabId: a, direction: -1 }).splits[0]!.tabIds).toEqual([a, b, c])
  })

  it('does nothing at either end, for a tab outside any split, or for an unknown tab', () => {
    const { ctx, s, a, c } = setup()
    expect(run(ctx, s, { type: 'split/move', tabId: a, direction: -1 })).toBe(s)
    expect(run(ctx, s, { type: 'split/move', tabId: c, direction: 1 })).toBe(s)
    expect(run(ctx, s, { type: 'split/move', tabId: 'nope', direction: 1 })).toBe(s)
  })
})

describe('moving a favourite', () => {
  const setup = () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'favorite/add', url: 'https://a.fr/', title: 'A' }, { type: 'favorite/add', url: 'https://b.fr/', title: 'B' }, { type: 'favorite/add', url: 'https://c.fr/', title: 'C' })
    return { ctx, s, ids: s.favorites.map((f) => f.id) }
  }

  it('swaps a favourite with its neighbour', () => {
    const { ctx, s, ids } = setup()
    expect(run(ctx, s, { type: 'favorite/move', id: ids[1]!, direction: -1 }).favorites.map((f) => f.title)).toEqual(['B', 'A', 'C'])
    expect(run(ctx, s, { type: 'favorite/move', id: ids[1]!, direction: 1 }).favorites.map((f) => f.title)).toEqual(['A', 'C', 'B'])
  })

  it('does nothing at either end or for an unknown favourite', () => {
    const { ctx, s, ids } = setup()
    expect(run(ctx, s, { type: 'favorite/move', id: ids[0]!, direction: -1 })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/move', id: ids[2]!, direction: 1 })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/move', id: 'nope', direction: 1 })).toBe(s)
  })
})

describe('creating a space with its colours and profile in one action', () => {
  const base = () => {
    const ctx = makeCtx()
    return { ctx, s: createInitialState(ctx) }
  }
  const create = (extra: Partial<Extract<Action, { type: 'space/create' }>>): Action => ({ type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, ...extra })

  it('keeps the hue theme without a theme, and the default profile without a profile', () => {
    const { ctx, s } = base()
    const made = run(ctx, s, create({})).spaces[1]!
    expect(made.profileId).toBe('default')
    expect(themeHue(made.theme)).toBe(10)
  })

  it('gives the space the theme it was created with, repaired like any theme', () => {
    const { ctx, s } = base()
    const made = run(ctx, s, create({ theme: { baseColors: ['#336699'], harmony: 'custom', appearance: 'dark', intensity: 7 } })).spaces[1]!
    expect(made.theme.baseColors).toEqual(['#336699'])
    expect(made.theme.appearance).toBe('dark')
    expect(made.theme.intensity).toBe(1)
  })

  it('creates a named profile with the space, and the space becomes the active one', () => {
    const { ctx, s } = base()
    const next = run(ctx, s, create({ profileName: '  Travail & Co ' }))
    const made = next.spaces[1]!
    expect(made.profileId).toBe('travail-co')
    expect(next.settings.profileNames['travail-co']).toBe('Travail & Co')
    expect(next.activeSpaceId).toBe(made.id)
  })

  it('creates nothing for a profile name that is empty, too long or already taken', () => {
    const { ctx, s } = base()
    const named = run(ctx, s, create({ profileName: 'Travail' }))
    expect(run(ctx, s, create({ profileName: '   ' }))).toBe(s)
    expect(run(ctx, s, create({ profileName: 'x'.repeat(41) }))).toBe(s)
    expect(run(ctx, named, create({ profileName: ' travail ' }))).toBe(named)
    expect(run(ctx, s, create({ profileName: 'Profil par défaut' }))).toBe(s)
  })

  it('lets the name of the profile win over a profile id', () => {
    const { ctx, s } = base()
    expect(run(ctx, s, create({ profileId: 'other', profileName: 'Neuf' })).spaces[1]!.profileId).toBe('neuf')
  })

  it('creates nothing when the profile id is not a safe storage name', () => {
    const { ctx, s } = base()
    for (const profileId of ['../escape', 'a b', '', 'x'.repeat(33)]) expect(run(ctx, s, create({ profileId }))).toBe(s)
    expect(run(ctx, s, create({ profileId: 'work_2' })).spaces[1]!.profileId).toBe('work_2')
  })
})

describe('nested folders', () => {
  /** Folders A > B > C, plus a loose folder D, and tabs a (in A), b (in B), c (in C) and d (in D), all pinned. */
  const setup = () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'A' })
    const a = s.folders[0]!
    s = run(ctx, s, { type: 'folder/create', name: 'B', parentId: a.id })
    const b = s.folders[1]!
    s = run(ctx, s, { type: 'folder/create', name: 'C', parentId: b.id }, { type: 'folder/create', name: 'D' })
    const [c, d] = [s.folders[2]!, s.folders[3]!]
    s = run(ctx, s, ...['a', 'b', 'c', 'd'].map((n): Action => ({ type: 'tab/open', url: `https://${n}.fr/`, background: true })))
    for (const [tab, folder] of s.tabs.map((t, i) => [t, [a, b, c, d][i]!] as const)) s = run(ctx, s, { type: 'tab/move', id: tab.id, toIndex: 99, pinned: true, folderId: folder.id })
    const tabId = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
    return { ctx, s, a, b, c, d, tabId }
  }
  const names = (s: SidebarState) => s.folders.map((f) => f.name)

  it('creates a sub-folder in its parent, in the parent\'s space', () => {
    const { s, a, b, c } = setup()
    expect(b.parentId).toBe(a.id)
    expect(c.parentId).toBe(b.id)
    expect(s.folders[3]).not.toHaveProperty('parentId')
  })

  it('opens a collapsed parent so the new sub-folder is not hidden', () => {
    const { ctx, s, a } = setup()
    const collapsed = run(ctx, s, { type: 'folder/toggle', id: a.id })
    expect(collapsed.folders[0]!.collapsed).toBe(true)
    expect(run(ctx, collapsed, { type: 'folder/create', name: 'X', parentId: a.id }).folders[0]!.collapsed).toBe(false)
  })

  it('refuses a sub-folder of a folder that does not exist', () => {
    const { ctx, s } = setup()
    expect(run(ctx, s, { type: 'folder/create', name: 'X', parentId: 'nope' })).toBe(s)
  })

  it(`refuses to go deeper than ${FOLDER_MAX_DEPTH} levels`, () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'L1' })
    for (let level = 2; level <= FOLDER_MAX_DEPTH; level++) s = run(ctx, s, { type: 'folder/create', name: `L${level}`, parentId: s.folders.at(-1)!.id })
    expect(s.folders).toHaveLength(FOLDER_MAX_DEPTH)
    expect(folderDepth(s.folders, s.folders.at(-1)!.id)).toBe(FOLDER_MAX_DEPTH)
    expect(run(ctx, s, { type: 'folder/create', name: 'too deep', parentId: s.folders.at(-1)!.id })).toBe(s)
  })

  it('lists tabs in the order of the sidebar, each folder before the ones inside it', () => {
    const { s, tabId } = setup()
    expect(sidebarOrder(s, s.activeSpaceId).map((t) => t.id)).toEqual([tabId('a'), tabId('b'), tabId('c'), tabId('d')])
  })

  it('leaves out of the visible order the tabs a collapsed folder, or one above it, hides', () => {
    const { ctx, s, a, b, tabId } = setup()
    expect(visibleTabOrder(s, s.activeSpaceId).map((t) => t.id)).toEqual([tabId('a'), tabId('b'), tabId('c'), tabId('d')])
    // B collapsed hides its own tab and those of C, which sits inside it.
    expect(visibleTabOrder(run(ctx, s, { type: 'folder/toggle', id: b.id }), s.activeSpaceId).map((t) => t.id)).toEqual([tabId('a'), tabId('d')])
    expect(visibleTabOrder(run(ctx, s, { type: 'folder/toggle', id: a.id }), s.activeSpaceId).map((t) => t.id)).toEqual([tabId('d')])
    // The order used to step through tabs still includes the hidden ones.
    expect(sidebarOrder(run(ctx, s, { type: 'folder/toggle', id: a.id }), s.activeSpaceId)).toHaveLength(4)
  })

  it('deleting a folder moves its tabs and its sub-folders up one level', () => {
    const { ctx, s, a, b, c, tabId } = setup()
    const out = run(ctx, s, { type: 'folder/delete', id: b.id })
    expect(names(out)).toEqual(['A', 'C', 'D'])
    expect(out.folders.find((f) => f.id === c.id)!.parentId).toBe(a.id)
    expect(out.tabs.find((t) => t.id === tabId('b'))!.folderId).toBe(a.id)
    expect(out.tabs.find((t) => t.id === tabId('c'))!.folderId).toBe(c.id)
  })

  it('deleting a root folder sends what it held to the root, without leaving a dangling parent', () => {
    const { ctx, s, a, b, tabId } = setup()
    const out = run(ctx, s, { type: 'folder/delete', id: a.id })
    expect(out.folders.find((f) => f.id === b.id)).not.toHaveProperty('parentId')
    expect(out.tabs.find((t) => t.id === tabId('a'))!.folderId).toBeUndefined()
    expect(normalize(out)).toEqual(out)
  })

  it('deleting a folder that is gone changes nothing', () => {
    const { ctx, s } = setup()
    expect(run(ctx, s, { type: 'folder/delete', id: 'nope' })).toBe(s)
  })

  it('duplicates a folder with the folders inside it and every tab, under new ids', () => {
    const { ctx, s, a } = setup()
    const out = run(ctx, s, { type: 'folder/duplicate', id: a.id })
    expect(names(out)).toEqual(['A', 'A (copie)', 'B', 'C', 'B', 'C', 'D'])
    const [copyA, copyB, copyC] = out.folders.slice(1, 4) as [Folder, Folder, Folder]
    expect(copyA).not.toHaveProperty('parentId')
    expect(copyB.parentId).toBe(copyA.id)
    expect(copyC.parentId).toBe(copyB.id)
    expect(out.tabs.filter((t) => [copyA.id, copyB.id, copyC.id].includes(t.folderId!)).map((t) => t.url.split('/')[2])).toEqual(['a.fr', 'b.fr', 'c.fr'])
    expect(new Set(out.folders.map((f) => f.id)).size).toBe(out.folders.length)
    expect(new Set(out.tabs.map((t) => t.id)).size).toBe(out.tabs.length)
    expect(out.tabs.filter((t) => t.folderId === a.id)).toHaveLength(1)
  })

  it('duplicating a sub-folder keeps the copy beside it, in the same parent', () => {
    const { ctx, s, a, b } = setup()
    const out = run(ctx, s, { type: 'folder/duplicate', id: b.id })
    expect(out.folders.filter((f) => f.parentId === a.id).map((f) => f.name)).toEqual(['B', 'B (copie)'])
  })

  it('archiving a folder archives the tabs of the folders inside it and removes them all', () => {
    const { ctx, s, a, d } = setup()
    const out = run(ctx, s, { type: 'folder/archive', id: a.id })
    expect(out.folders.map((f) => f.id)).toEqual([d.id])
    expect(out.tabs.map((t) => t.url)).toEqual(['https://d.fr/'])
    expect(out.archive.map((e) => e.url).sort()).toEqual(['https://a.fr/', 'https://b.fr/', 'https://c.fr/'])
    expect(out.archive.every((e) => e.source === 'manual')).toBe(true)
  })

  it('archiving an empty folder just removes it, and an unknown folder changes nothing', () => {
    const { ctx, s } = setup()
    const empty = run(ctx, s, { type: 'folder/create', name: 'Vide' })
    expect(run(ctx, empty, { type: 'folder/archive', id: empty.folders.at(-1)!.id }).folders).toHaveLength(4)
    expect(run(ctx, s, { type: 'folder/archive', id: 'nope' })).toBe(s)
  })

  it('archiving a folder picks another tab when the shown one was inside it', () => {
    const { ctx, s, a, tabId } = setup()
    const out = run(ctx, s, { type: 'tab/select', id: tabId('b') }, { type: 'folder/archive', id: a.id })
    expect(out.activeTabBySpace[out.activeSpaceId]).toBe(tabId('d'))
  })

  it('repairs a tree read from a file: missing parent, loop, depth', () => {
    const { s } = setup()
    const f = (id: string, parentId?: string): Folder => ({ id, spaceId: s.activeSpaceId, name: id, collapsed: false, ...(parentId ? { parentId } : {}) })
    const broken = { ...s, folders: [f('lost', 'ghost'), f('x', 'y'), f('y', 'x'), f('1'), f('2', '1'), f('3', '2'), f('4', '3'), f('5', '4')], tabs: [] }
    const out = normalize(broken)
    expect(out.folders).toHaveLength(8)
    expect(out.folders.find((x) => x.id === 'lost')).not.toHaveProperty('parentId')
    for (const x of out.folders) expect(folderDepth(out.folders, x.id)).toBeLessThanOrEqual(FOLDER_MAX_DEPTH)
    expect(out.folders.filter((x) => x.id === 'x' || x.id === 'y').some((x) => !x.parentId)).toBe(true)
  })

  it('keeps a file saved before sub-folders valid and unchanged', () => {
    const ctx = makeCtx()
    const base = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Docs' })
    expect(normalize(base).folders).toEqual(base.folders)
    expect(normalize(base).folders[0]).not.toHaveProperty('parentId')
  })

  it('deleting a space takes its folders and their sub-folders with it', () => {
    const { ctx, s } = setup()
    const other = run(ctx, s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const out = run(ctx, other, { type: 'space/delete', id: s.activeSpaceId })
    expect(out.folders).toEqual([])
  })
})

describe('new folder with a selection', () => {
  const setup = () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), ...['a', 'b', 'c', 'd'].map((n): Action => ({ type: 'tab/open', url: `https://${n}.fr/`, background: true })))
    return { ctx, s, ids: s.tabs.map((t) => t.id) }
  }

  it('pins the tabs into a new folder, in the order the sidebar shows them', () => {
    const { ctx, s, ids } = setup()
    const out = run(ctx, s, { type: 'folder/create-with', tabIds: [ids[2]!, ids[0]!] })
    const folder = out.folders[0]!
    expect(folder.name).toBe('Nouveau dossier')
    expect(out.tabs.filter((t) => t.folderId === folder.id).map((t) => t.url.split('/')[2])).toEqual(['a.fr', 'c.fr'])
    expect(out.tabs.filter((t) => t.folderId === folder.id).every((t) => t.pinned && t.anchorUrl === t.url)).toBe(true)
    expect(out.tabs.filter((t) => !t.pinned).map((t) => t.url.split('/')[2])).toEqual(['b.fr', 'd.fr'])
  })

  it('takes tabs that were already pinned or in another folder', () => {
    const { ctx, s, ids } = setup()
    let out = run(ctx, s, { type: 'folder/create', name: 'Vieux' }, { type: 'tab/move', id: ids[0]!, toIndex: 0, pinned: true, folderId: undefined })
    out = run(ctx, out, { type: 'tab/move', id: ids[0]!, toIndex: 0, pinned: true, folderId: out.folders[0]!.id })
    out = run(ctx, out, { type: 'folder/create-with', tabIds: [ids[0]!, ids[1]!], name: '  Mes liens ' })
    expect(out.folders[1]!.name).toBe('Mes liens')
    expect(out.tabs.filter((t) => t.folderId === out.folders[1]!.id)).toHaveLength(2)
    expect(out.tabs.filter((t) => t.folderId === out.folders[0]!.id)).toHaveLength(0)
  })

  it('keeps to the space of the first tab and ignores ids that do not exist', () => {
    const { ctx, s, ids } = setup()
    const two = run(ctx, s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'tab/open', url: 'https://z.fr/', background: true })
    const z = two.tabs.at(-1)!
    const out = run(ctx, two, { type: 'folder/create-with', tabIds: [ids[0]!, z.id, 'nope'] })
    expect(out.tabs.filter((t) => t.folderId).map((t) => t.id)).toEqual([ids[0]])
    expect(out.folders[0]!.spaceId).toBe(s.activeSpaceId)
  })

  it('does nothing without a tab', () => {
    const { ctx, s } = setup()
    expect(run(ctx, s, { type: 'folder/create-with', tabIds: ['nope'] })).toBe(s)
    expect(run(ctx, s, { type: 'folder/create-with', tabIds: [] })).toBe(s)
  })
})

describe('actions on several tabs', () => {
  const setup = () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), ...['a', 'b', 'c', 'd', 'e'].map((n): Action => ({ type: 'tab/open', url: `https://${n}.fr/`, background: true })))
    const ids = s.tabs.map((t) => t.id)
    s = run(ctx, s, { type: 'tab/select', id: ids[0]! })
    return { ctx, s, ids }
  }
  const hosts = (tabs: Array<{ url: string }>) => tabs.map((t) => t.url.split('/')[2])

  it('archives the Today tabs of a selection together and leaves pinned ones alone', () => {
    const { ctx, s, ids } = setup()
    const pinned = run(ctx, s, { type: 'tab/pin', id: ids[1]! })
    const out = run(ctx, pinned, { type: 'tabs/archive-many', ids: [ids[1]!, ids[2]!, ids[3]!, 'nope'] })
    expect(hosts(out.tabs).sort()).toEqual(['a.fr', 'b.fr', 'e.fr'])
    expect(out.archive).toHaveLength(2)
    expect(out.archive.every((e) => e.source === 'manual')).toBe(true)
  })

  it('picks a new tab to show when the shown one is archived with the others', () => {
    const { ctx, s, ids } = setup()
    const out = run(ctx, s, { type: 'tabs/archive-many', ids: [ids[0]!, ids[1]!] })
    expect([ids[2], ids[3], ids[4]]).toContain(out.activeTabBySpace[out.activeSpaceId])
  })

  it('archiving only pinned or unknown tabs changes nothing', () => {
    const { ctx, s, ids } = setup()
    const pinned = run(ctx, s, { type: 'tab/pin', id: ids[1]! })
    expect(run(ctx, pinned, { type: 'tabs/archive-many', ids: [ids[1]!] })).toBe(pinned)
    expect(run(ctx, s, { type: 'tabs/archive-many', ids: [] })).toBe(s)
  })

  it('brings back as many archived tabs as asked, in the order they had', () => {
    const { ctx, s, ids } = setup()
    const archived = run(ctx, s, { type: 'tabs/archive-many', ids: [ids[1]!, ids[2]!, ids[3]!] })
    expect(hosts(archived.tabs)).toEqual(['a.fr', 'e.fr'])
    const back = run(ctx, archived, { type: 'archive/restore-last', count: 3 })
    expect(hosts(back.tabs)).toEqual(['a.fr', 'e.fr', 'b.fr', 'c.fr', 'd.fr'])
    expect(back.archive).toHaveLength(0)
    const one = run(ctx, archived, { type: 'archive/restore-last' })
    expect(hosts(one.tabs.slice(2))).toEqual(['d.fr'])
    expect(one.archive).toHaveLength(2)
  })

  it('asking for more tabs than the archive holds restores what there is', () => {
    const { ctx, s, ids } = setup()
    const archived = run(ctx, s, { type: 'tabs/archive-many', ids: [ids[1]!] })
    expect(hosts(run(ctx, archived, { type: 'archive/restore-last', count: 50 }).tabs)).toEqual(['a.fr', 'c.fr', 'd.fr', 'e.fr', 'b.fr'])
  })

  it('moves several tabs as one block, keeping their order', () => {
    const { ctx, s, ids } = setup()
    const out = run(ctx, s, { type: 'tabs/move', ids: [ids[3]!, ids[1]!], toIndex: 1, pinned: false })
    // The index counts the group without the moved tabs: a, c, e, so index 1 is before c.
    expect(hosts(out.tabs)).toEqual(['a.fr', 'd.fr', 'b.fr', 'c.fr', 'e.fr'])
  })

  it('moves several tabs into the pinned list and into a folder in one step', () => {
    const { ctx, s, ids } = setup()
    const withFolder = run(ctx, s, { type: 'folder/create', name: 'F' })
    const out = run(ctx, withFolder, { type: 'tabs/move', ids: [ids[2]!, ids[4]!], toIndex: 0, pinned: true, folderId: withFolder.folders[0]!.id })
    expect(out.tabs.filter((t) => t.pinned).map((t) => [t.url.split('/')[2], t.folderId])).toEqual([['c.fr', withFolder.folders[0]!.id], ['e.fr', withFolder.folders[0]!.id]])
    expect(out.tabs.filter((t) => t.pinned).every((t) => t.anchorUrl === t.url)).toBe(true)
  })

  it('moving to a folder that does not exist (or is in another space) puts the tab at the root of the pinned list', () => {
    const { ctx, s, ids } = setup()
    const out = run(ctx, s, { type: 'tab/move', id: ids[1]!, toIndex: 0, pinned: true, folderId: 'ghost' })
    expect(out.tabs.find((t) => t.id === ids[1])).toMatchObject({ pinned: true, folderId: undefined })
    const other = run(ctx, s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'folder/create', name: 'Ailleurs' })
    const foreign = other.folders[0]!
    const back = run(ctx, other, { type: 'tab/move', id: ids[1]!, toIndex: 0, pinned: true, folderId: foreign.id })
    expect(back.tabs.find((t) => t.id === ids[1])!.folderId).toBeUndefined()
  })

  it('moves only the tabs of one space and ignores unknown ids', () => {
    const { ctx, s, ids } = setup()
    const two = run(ctx, s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'tab/open', url: 'https://z.fr/', background: true })
    const z = two.tabs.at(-1)!
    const out = run(ctx, two, { type: 'tabs/move', ids: [ids[0]!, z.id, 'nope'], toIndex: 0, pinned: true })
    expect(out.tabs.filter((t) => t.pinned).map((t) => t.id)).toEqual([ids[0]])
    expect(run(ctx, two, { type: 'tabs/move', ids: ['nope'], toIndex: 0, pinned: true })).toBe(two)
  })
})

describe('favourites placed by drag and drop', () => {
  const setup = () => {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'favorite/add', url: 'https://a.fr/', title: 'A' }, { type: 'favorite/add', url: 'https://b.fr/', title: 'B' }, { type: 'favorite/add', url: 'https://c.fr/', title: 'C' })
    return { ctx, s, ids: s.favorites.map((f) => f.id) }
  }

  it('adds a favourite at a given place and keeps its icon', () => {
    const { ctx, s } = setup()
    const out = run(ctx, s, { type: 'favorite/add', url: 'https://n.fr/', title: 'N', faviconUrl: 'https://n.fr/i.png', toIndex: 1 })
    expect(out.favorites.map((f) => f.title)).toEqual(['A', 'N', 'B', 'C'])
    expect(out.favorites[1]!.faviconUrl).toBe('https://n.fr/i.png')
    expect(out.favorites[0]).not.toHaveProperty('faviconUrl')
  })

  it('puts a favourite at the end when no place is given, or one that is out of range, and never twice', () => {
    const { ctx, s } = setup()
    expect(run(ctx, s, { type: 'favorite/add', url: 'https://n.fr/', title: 'N' }).favorites.at(-1)!.title).toBe('N')
    expect(run(ctx, s, { type: 'favorite/add', url: 'https://n.fr/', title: 'N', toIndex: 99 }).favorites.at(-1)!.title).toBe('N')
    expect(run(ctx, s, { type: 'favorite/add', url: 'https://n.fr/', title: 'N', toIndex: -1 }).favorites[0]!.title).toBe('N')
    expect(run(ctx, s, { type: 'favorite/add', url: 'https://a.fr/', title: 'A again', toIndex: 2 })).toBe(s)
  })

  it('places a favourite at a position counted without it', () => {
    const { ctx, s, ids } = setup()
    expect(run(ctx, s, { type: 'favorite/place', id: ids[0]!, toIndex: 2 }).favorites.map((f) => f.title)).toEqual(['B', 'C', 'A'])
    expect(run(ctx, s, { type: 'favorite/place', id: ids[2]!, toIndex: 0 }).favorites.map((f) => f.title)).toEqual(['C', 'A', 'B'])
    expect(run(ctx, s, { type: 'favorite/place', id: ids[0]!, toIndex: 99 }).favorites.map((f) => f.title)).toEqual(['B', 'C', 'A'])
    expect(run(ctx, s, { type: 'favorite/place', id: ids[2]!, toIndex: -1 }).favorites.map((f) => f.title)).toEqual(['C', 'A', 'B'])
  })

  it('does nothing when the favourite stays where it is, or is unknown', () => {
    const { ctx, s, ids } = setup()
    expect(run(ctx, s, { type: 'favorite/place', id: ids[1]!, toIndex: 1 })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/place', id: 'nope', toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/place', id: ids[1]!, toIndex: Number.NaN })).toBe(s)
  })
})

describe('hover card setting', () => {
  it('is on by default and by default in a file saved before it existed', () => {
    const ctx = makeCtx()
    expect(createInitialState(ctx).settings.hoverCards).toBe(true)
    expect(normalize({ ...createInitialState(ctx), settings: {} as never }).settings.hoverCards).toBe(true)
  })

  it('can be turned off and on again', () => {
    const ctx = makeCtx()
    const off = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { hoverCards: false } })
    expect(off.settings.hoverCards).toBe(false)
    expect(normalize(off).settings.hoverCards).toBe(false)
    expect(run(ctx, off, { type: 'settings/update', patch: { hoverCards: true } }).settings.hoverCards).toBe(true)
  })
})

describe('moving a folder', () => {
  /** Root folders A, B, C; A holds A1 and A2. `shape` writes the tree the way the sidebar lists it: "A(A1,A2) B C". */
  const setup = () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'A' }, { type: 'folder/create', name: 'B' }, { type: 'folder/create', name: 'C' })
    const [a, b, c] = s.folders as [Folder, Folder, Folder]
    s = run(ctx, s, { type: 'folder/create', name: 'A1', parentId: a.id }, { type: 'folder/create', name: 'A2', parentId: a.id })
    const named = (n: string) => s.folders.find((f) => f.name === n)!
    return { ctx, s, a, b, c, a1: named('A1'), a2: named('A2') }
  }
  const shape = (s: SidebarState, parentId?: string): string =>
    s.folders
      .filter((f) => f.parentId === parentId)
      .map((f) => {
        const inside = shape(s, f.id)
        return inside ? `${f.name}(${inside.replaceAll(' ', ',')})` : f.name
      })
      .join(' ')

  it('puts a folder before another at the root, the index counting the folders without it', () => {
    const { ctx, s, a, c } = setup()
    expect(shape(s)).toBe('A(A1,A2) B C')
    expect(shape(run(ctx, s, { type: 'folder/move', id: c.id, parentId: null, toIndex: 0 }))).toBe('C A(A1,A2) B')
    expect(shape(run(ctx, s, { type: 'folder/move', id: a.id, parentId: null, toIndex: 2 }))).toBe('B C A(A1,A2)')
    expect(shape(run(ctx, s, { type: 'folder/move', id: a.id, parentId: null, toIndex: 1 }))).toBe('B A(A1,A2) C')
  })

  it('moves a folder into another one, at a place among its folders, and opens it if it was closed', () => {
    const { ctx, s, a, b } = setup()
    const closed = run(ctx, s, { type: 'folder/toggle', id: a.id })
    const out = run(ctx, closed, { type: 'folder/move', id: b.id, parentId: a.id, toIndex: 1 })
    expect(shape(out)).toBe('A(A1,B,A2) C')
    expect(out.folders.find((f) => f.id === a.id)!.collapsed).toBe(false)
    expect(shape(run(ctx, s, { type: 'folder/move', id: b.id, parentId: a.id, toIndex: 99 }))).toBe('A(A1,A2,B) C')
  })

  it('takes the folders inside it and its tabs along, and a sub-folder can go back to the root', () => {
    const { ctx, s, a, b, a1 } = setup()
    const withTab = run(ctx, s, { type: 'tab/open', url: 'https://x.fr/', background: true })
    const tab = withTab.tabs.at(-1)!
    const filed = run(ctx, withTab, { type: 'tab/move', id: tab.id, toIndex: 0, pinned: true, folderId: a.id })
    const nested = run(ctx, filed, { type: 'folder/move', id: a.id, parentId: b.id, toIndex: 0 })
    expect(shape(nested)).toBe('B(A(A1,A2)) C')
    expect(nested.tabs.find((t) => t.id === tab.id)!.folderId).toBe(a.id)
    const out = run(ctx, nested, { type: 'folder/move', id: a1.id, parentId: null, toIndex: 1 })
    expect(shape(out)).toBe('B(A(A2)) A1 C')
    expect(out.folders.find((f) => f.id === a1.id)).not.toHaveProperty('parentId')
  })

  it('refuses a move into itself, into what is below it, past the deepest level, to another space, or with an unusable place', () => {
    const { ctx, s, a, a1, b } = setup()
    expect(run(ctx, s, { type: 'folder/move', id: a.id, parentId: a.id, toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: a.id, parentId: a1.id, toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: 'nope', parentId: null, toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: b.id, parentId: 'nope', toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: b.id, parentId: a.id, toIndex: Number.NaN })).toBe(s)
    // A > A1 > X > Y is four levels deep, so A cannot go inside Z, which sits in B (level 2).
    let deep = run(ctx, s, { type: 'folder/create', name: 'X', parentId: a1.id })
    deep = run(ctx, deep, { type: 'folder/create', name: 'Y', parentId: deep.folders.find((f) => f.name === 'X')!.id })
    deep = run(ctx, deep, { type: 'folder/create', name: 'Z', parentId: b.id })
    expect(folderDepth(deep.folders, deep.folders.find((f) => f.name === 'Y')!.id)).toBe(FOLDER_MAX_DEPTH)
    expect(run(ctx, deep, { type: 'folder/move', id: a.id, parentId: deep.folders.find((f) => f.name === 'Z')!.id, toIndex: 0 })).toBe(deep)
    // The space created here is the active one, so the new folder belongs to it.
    const away = run(ctx, s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 }, { type: 'folder/create', name: 'Ailleurs' })
    expect(run(ctx, away, { type: 'folder/move', id: a.id, parentId: away.folders.find((f) => f.name === 'Ailleurs')!.id, toIndex: 0 })).toBe(away)
  })

  it('does nothing when the folder is already there', () => {
    const { ctx, s, a, b, a2 } = setup()
    expect(run(ctx, s, { type: 'folder/move', id: a.id, parentId: null, toIndex: 0 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: b.id, parentId: null, toIndex: 1 })).toBe(s)
    expect(run(ctx, s, { type: 'folder/move', id: a2.id, parentId: a.id, toIndex: 1 })).toBe(s)
  })
})

describe('turning a folder into a space (Turn "<folder>" into Space)', () => {
  /** A space with a folder "Docs" holding two pinned tabs and a folder "Sous" with one, plus a Today tab. */
  function withFolder() {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Docs' })
    const docs = s.folders[0]!
    s = run(ctx, s, { type: 'folder/create', name: 'Sous', parentId: docs.id })
    const sous = s.folders.find((f) => f.name === 'Sous')!
    for (const url of ['https://a.fr/', 'https://b.fr/', 'https://c.fr/', 'https://today.fr/']) s = run(ctx, s, { type: 'tab/open', url })
    const [a, b, c] = s.tabs
    s = run(ctx, s, { type: 'tab/pin', id: a!.id }, { type: 'tab/move', id: a!.id, toIndex: 0, pinned: true, folderId: docs.id })
    s = run(ctx, s, { type: 'tab/pin', id: b!.id }, { type: 'tab/move', id: b!.id, toIndex: 1, pinned: true, folderId: docs.id })
    s = run(ctx, s, { type: 'tab/pin', id: c!.id }, { type: 'tab/move', id: c!.id, toIndex: 0, pinned: true, folderId: sous.id })
    return { ctx, s, docs, sous, a: a!, b: b!, c: c! }
  }

  it('makes a new space named after the folder, with its tabs pinned in it, and shows it', () => {
    const { ctx, s, docs, a, b } = withFolder()
    const source = s.spaces[0]!
    const out = run(ctx, s, { type: 'folder/to-space', id: docs.id })
    expect(out.spaces).toHaveLength(2)
    const space = out.spaces[1]!
    expect(space.name).toBe('Docs')
    expect(space.profileId).toBe(source.profileId)
    expect(out.activeSpaceId).toBe(space.id)
    for (const id of [a.id, b.id]) expect(out.tabs.find((t) => t.id === id)).toMatchObject({ spaceId: space.id, pinned: true })
    // The tabs sit at the root of the new space, no longer in a folder that is gone.
    expect(out.tabs.find((t) => t.id === a.id)?.folderId).toBeUndefined()
  })

  it('removes the folder, keeps the folders inside it as the new space\'s own and what is outside it where it was', () => {
    const { ctx, s, docs, sous, c } = withFolder()
    const out = run(ctx, s, { type: 'folder/to-space', id: docs.id })
    const space = out.spaces[1]!
    expect(out.folders.some((f) => f.id === docs.id)).toBe(false)
    const moved = out.folders.find((f) => f.id === sous.id)!
    expect(moved.spaceId).toBe(space.id)
    expect(moved.parentId).toBeUndefined()
    expect(out.tabs.find((t) => t.id === c.id)).toMatchObject({ spaceId: space.id, folderId: sous.id })
    const today = out.tabs.find((t) => t.url === 'https://today.fr/')!
    expect(today.spaceId).toBe(s.spaces[0]!.id)
  })

  it('keeps the page on screen when it was one of the folder\'s: it is shown in the new space, and the old one picks another', () => {
    const { ctx, s, docs, a } = withFolder()
    const source = s.spaces[0]!
    const shown = run(ctx, s, { type: 'tab/select', id: a.id })
    const out = run(ctx, shown, { type: 'folder/to-space', id: docs.id })
    expect(out.activeTabBySpace[out.spaces[1]!.id]).toBe(a.id)
    const left = out.activeTabBySpace[source.id]
    expect(left === null || out.tabs.find((t) => t.id === left)?.spaceId === source.id).toBe(true)
  })

  it('ignores a folder that is gone', () => {
    const ctx = makeCtx()
    const s = createInitialState(ctx)
    expect(run(ctx, s, { type: 'folder/to-space', id: 'nope' })).toBe(s)
  })
})

describe('editing a favourite (Rename…, Replace Pinned URL with Current)', () => {
  function withFavorites() {
    const ctx = makeCtx()
    const s = run(ctx, createInitialState(ctx), { type: 'favorite/add', url: 'https://a.fr/', title: 'A' }, { type: 'favorite/add', url: 'https://b.fr/', title: 'B' })
    return { ctx, s, a: s.favorites[0]!, b: s.favorites[1]! }
  }

  it('renames it, trimmed', () => {
    const { ctx, s, a } = withFavorites()
    expect(run(ctx, s, { type: 'favorite/edit', id: a.id, patch: { title: '  Mon A  ' } }).favorites[0]?.title).toBe('Mon A')
  })

  it('refuses an empty name: it would leave a tile nobody can tell apart', () => {
    const { ctx, s, a } = withFavorites()
    expect(run(ctx, s, { type: 'favorite/edit', id: a.id, patch: { title: '   ' } })).toBe(s)
  })

  it('changes its address, but only to a page that can be opened and that no other favourite has', () => {
    const { ctx, s, a, b } = withFavorites()
    expect(run(ctx, s, { type: 'favorite/edit', id: a.id, patch: { url: 'https://c.fr/x' } }).favorites[0]?.url).toBe('https://c.fr/x')
    expect(run(ctx, s, { type: 'favorite/edit', id: a.id, patch: { url: 'javascript:alert(1)' } })).toBe(s)
    expect(run(ctx, s, { type: 'favorite/edit', id: a.id, patch: { url: b.url } })).toBe(s)
  })

  it('ignores a favourite that is gone', () => {
    const { ctx, s } = withFavorites()
    expect(run(ctx, s, { type: 'favorite/edit', id: 'nope', patch: { title: 'x' } })).toBe(s)
  })
})

describe('import/merge', () => {
  const ctx = makeCtx()
  const base = () => createInitialState(ctx)
  const tab = (id: string, spaceId: string) => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: true, createdAt: 1, lastActiveAt: 1 })
  const space = (id: string) => ({ id, name: id, emoji: '🌐', theme: defaultTheme(), profileId: 'default' })
  const boost = (id: string, host: string): Boost => ({ id, name: id, host, enabled: true, css: 'a { color: red }', js: '', zoom: 1, zap: [], tint: { hue: 0, saturation: 1, brightness: 1, contrast: 1 } })
  const batch = () => ({
    type: 'import/merge' as const,
    spaces: [space('arc-s')],
    tabs: [tab('arc-a', 'arc-s'), tab('arc-b', 'arc-s')],
    folders: [],
    favorites: [],
    splits: [{ id: 'arc-sv', spaceId: 'arc-s', tabIds: ['arc-a', 'arc-b'], orientation: 'vertical' as const, ratios: [0.4, 0.6] }],
    boosts: [boost('arc-bo', 'a.example')]
  })

  it('brings in spaces, tabs, split views and Tweaks', () => {
    const merged = reduce(base(), batch(), ctx)
    expect(merged.spaces.map((s) => s.id)).toContain('arc-s')
    expect(merged.tabs.map((t) => t.id)).toEqual(['arc-a', 'arc-b'])
    expect(merged.splits).toEqual(batch().splits)
    expect(merged.boosts.map((b) => b.id)).toEqual(['arc-bo'])
  })

  it('changes nothing when the same things come a second time (a Tweak is not renamed "-2" and kept twice)', () => {
    const once = reduce(base(), batch(), ctx)
    const twice = reduce(once, batch(), ctx)
    expect(twice).toEqual(once)
    expect(twice.boosts).toHaveLength(1)
  })

  it('leaves what the user did to an imported thing alone, and the tab a space shows', () => {
    const once = reduce(base(), batch(), ctx)
    const edited = run(ctx, once, { type: 'tab/select', id: 'arc-b' }, { type: 'boost/save', boost: { ...boost('arc-bo', 'a.example'), css: 'b { color: blue }' } })
    const again = reduce(edited, batch(), ctx)
    expect(again.activeTabBySpace['arc-s']).toBe('arc-b')
    expect(again.boosts[0]?.css).toBe('b { color: blue }')
  })

  it('adds what is new next to what was already there', () => {
    const once = reduce(base(), batch(), ctx)
    const more = { ...batch(), tabs: [tab('arc-a', 'arc-s'), tab('arc-c', 'arc-s')], boosts: [boost('arc-bo', 'a.example'), boost('arc-bo2', 'b.example')] }
    const merged = reduce(once, more, ctx)
    expect(merged.tabs.map((t) => t.id)).toEqual(['arc-a', 'arc-b', 'arc-c'])
    expect(merged.boosts.map((b) => b.id)).toEqual(['arc-bo', 'arc-bo2'])
  })

  it('keeps a Tweak once when one batch holds the same id twice, and works without split views or Tweaks (the older shape)', () => {
    const twice = reduce(base(), { ...batch(), boosts: [boost('arc-bo', 'a.example'), boost('arc-bo', 'a.example')] }, ctx)
    expect(twice.boosts).toHaveLength(1)
    const { splits: _s, boosts: _b, ...old } = batch()
    expect(reduce(base(), old, ctx).tabs).toHaveLength(2)
  })

  it('refuses a split view whose panes are not tabs of its space, as a state read from a file would', () => {
    const merged = reduce(base(), { ...batch(), splits: [{ id: 'bad', spaceId: 'arc-s', tabIds: ['arc-a', 'nope'], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }] }, ctx)
    expect(merged.splits).toEqual([])
  })
})

describe('import/revert', () => {
  const ctx = makeCtx()
  const base = () => createInitialState(ctx)
  const tab = (id: string, spaceId: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: true, createdAt: 1, lastActiveAt: 1, ...extra })
  const space = (id: string) => ({ id, name: id, emoji: '🌐', theme: defaultTheme(), profileId: 'default' })
  const boost = (id: string): Boost => ({ id, name: id, host: `${id}.example`, enabled: true, css: 'a { color: red }', js: '', zoom: 1, zap: [], tint: { hue: 0, saturation: 1, brightness: 1, contrast: 1 } })
  const batch = {
    type: 'import/merge' as const,
    spaces: [space('imp-s')],
    tabs: [tab('imp-a', 'imp-s'), tab('imp-b', 'imp-s', { folderId: 'imp-f' })],
    folders: [{ id: 'imp-f', spaceId: 'imp-s', name: 'Dossier', collapsed: true }],
    favorites: [{ id: 'imp-fav', url: 'https://fav.example/', title: 'Favori' }],
    splits: [{ id: 'imp-sv', spaceId: 'imp-s', tabIds: ['imp-a', 'imp-b'], orientation: 'vertical' as const, ratios: [0.5, 0.5] }],
    boosts: [boost('imp-bo')]
  }
  const revert = (over: Partial<Extract<Action, { type: 'import/revert' }>> = {}) => ({ type: 'import/revert' as const, spaces: ['imp-s'], tabs: ['imp-a', 'imp-b'], folders: ['imp-f'], favorites: ['imp-fav'], splits: ['imp-sv'], boosts: ['imp-bo'], ...over })

  it('takes back everything an import brought: a state with the import then reverted is the state before it', () => {
    const before = run(ctx, base(), { type: 'tab/open', url: 'https://perso.example/' })
    const merged = reduce(before, batch, ctx)
    expect(merged.spaces).toHaveLength(before.spaces.length + 1)
    expect(reduce(merged, revert(), ctx)).toEqual(before)
  })

  it('removes a space with its tabs, folders and split views even when only the space is named', () => {
    const merged = reduce(base(), batch, ctx)
    const reverted = reduce(merged, revert({ tabs: [], folders: [], splits: [], favorites: [], boosts: [] }), ctx)
    expect(reverted.spaces.map((s) => s.id)).not.toContain('imp-s')
    expect(reverted.tabs.some((t) => t.spaceId === 'imp-s')).toBe(false)
    expect(reverted.folders).toEqual([])
    expect(reverted.splits).toEqual([])
  })

  it('leaves what the user added to an imported space alone when only the imported entries are named', () => {
    const merged = run(ctx, reduce(base(), batch, ctx), { type: 'tab/open', url: 'https://mien.example/', spaceId: 'imp-s' })
    const mine = merged.tabs.find((t) => t.url === 'https://mien.example/')!
    const reverted = reduce(merged, revert({ spaces: [] }), ctx)
    expect(reverted.spaces.map((s) => s.id)).toContain('imp-s')
    expect(reverted.tabs.map((t) => t.id)).toEqual([mine.id])
  })

  it('moves the shown space to another when the shown one leaves, and forgets the tab it showed', () => {
    const merged = run(ctx, reduce(base(), batch, ctx), { type: 'space/select', id: 'imp-s' }, { type: 'tab/select', id: 'imp-a' })
    expect(merged.activeSpaceId).toBe('imp-s')
    const reverted = reduce(merged, revert(), ctx)
    expect(reverted.activeSpaceId).not.toBe('imp-s')
    expect(reverted.spaces.some((s) => s.id === reverted.activeSpaceId)).toBe(true)
    expect(Object.keys(reverted.activeTabBySpace)).not.toContain('imp-s')
  })

  it('takes a split view away by its own id, and the tabs it held stay when they were not named', () => {
    const merged = reduce(base(), batch, ctx)
    const reverted = reduce(merged, revert({ spaces: [], tabs: [], folders: [], favorites: [], boosts: [] }), ctx)
    expect(reverted.splits).toEqual([])
    expect(reverted.tabs.map((t) => t.id)).toEqual(['imp-a', 'imp-b'])
  })

  it('puts nothing in the archive: a reverted import is not a list of closed tabs', () => {
    const merged = reduce(base(), batch, ctx)
    expect(reduce(merged, revert(), ctx).archive).toEqual(merged.archive)
  })

  it('is the very same state when nothing it names is there (a second undo, a stale one)', () => {
    const s = base()
    expect(reduce(s, revert(), ctx)).toBe(s)
    const merged = reduce(s, batch, ctx)
    const once = reduce(merged, revert(), ctx)
    expect(reduce(once, revert(), ctx)).toBe(once)
  })

  it('does not take the last space away: a state always has one', () => {
    const only = base()
    const reverted = reduce(only, revert({ spaces: [only.spaces[0]!.id], tabs: [], folders: [], favorites: [], splits: [], boosts: [] }), ctx)
    expect(reverted.spaces.length).toBeGreaterThanOrEqual(1)
  })
})
