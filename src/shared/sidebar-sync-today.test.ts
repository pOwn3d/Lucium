// `sync/apply` and the shared Today tabs (docs/synchronisation.md §27, card 508): how a patch makes, changes, orders, moves and closes a Today tab in the state. The patches here
// are the ones `buildPatch` writes (src/main/sync/patch.ts); the sessions that carry them are played in src/main/sync/session-today.test.ts.
import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'
import { applySyncPatch, type PatchRemoval, type PatchUpsert, type SyncPatch } from './sidebar-sync'
import { defaultTheme } from './theme'

const NOW = 1_790_000_000_000
const ctx: Ctx = { now: NOW, newId: () => 'made' }
const OLD = NOW - 3_600_000

const tabOf = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 's1', url: `https://${id}.example/`, title: id, pinned: false, createdAt: OLD, lastActiveAt: OLD, ...extra })
function stateWith(tabs: TabItem[], extra: Partial<SidebarState> = {}): SidebarState {
  const base = createInitialState({ now: NOW, newId: () => 'x' })
  const spaces = [{ id: 's1', name: 'One', emoji: '🏠', theme: defaultTheme(), profileId: 'default' }, { id: 's2', name: 'Two', emoji: '🏠', theme: defaultTheme(), profileId: 'default' }]
  return normalize({ ...base, spaces, activeSpaceId: 's1', tabs, activeTabBySpace: {}, ...extra } as SidebarState)
}

const patchOf = (over: Partial<SyncPatch>): SyncPatch => ({ upserts: [], removals: [], order: {}, settings: {}, ...over })
const create = (id: string, fields: Record<string, unknown>, kind: PatchUpsert['kind'] = 'todayTab'): PatchUpsert => ({ kind, id, create: true, fields, remove: [], expect: {} })
const change = (id: string, fields: Record<string, unknown>, expect: Record<string, unknown>): PatchUpsert => ({ kind: 'todayTab', id, create: false, fields, remove: [], expect })
const close = (id: string, expect: Record<string, unknown>, kind: PatchRemoval['kind'] = 'todayTab'): PatchRemoval => ({ kind, id, expect })
const ids = (state: SidebarState): string[] => state.tabs.map((t) => t.id)
const activeAt = (ms: number): number => Math.floor(ms / 600_000) * 600_000

describe('sync/apply: a Today tab that arrives', () => {
  it('is made with the fields of the patch and nothing else, as old and as recently used as its activeAt says', () => {
    const state = stateWith([tabOf('local')])
    const after = applySyncPatch(state, patchOf({ upserts: [create('new', { spaceId: 's1', url: 'https://new.example/p', title: 'Nouveau', customTitle: 'Mien', icon: '🦊', activeAt: activeAt(OLD) })] }), ctx)
    expect(after.tabs.find((t) => t.id === 'new')).toEqual({ id: 'new', spaceId: 's1', url: 'https://new.example/p', title: 'Nouveau', customTitle: 'Mien', icon: '🦊', pinned: false, createdAt: activeAt(OLD), lastActiveAt: activeAt(OLD) })
  })

  it('does not change the tab or the space on screen', () => {
    const state = stateWith([tabOf('local')], { activeTabBySpace: { s1: 'local' }, activeSpaceId: 's1' })
    const after = applySyncPatch(state, patchOf({ upserts: [create('new', { spaceId: 's2', url: 'https://new.example/', title: 'n', activeAt: activeAt(OLD) })] }), ctx)
    expect(after.activeSpaceId).toBe('s1')
    expect(after.activeTabBySpace['s1']).toBe('local')
    expect(after.activeTabBySpace['s2']).not.toBe('new')
  })

  it('refuses to write what is not a field of a Today tab: it cannot be pinned, put in a container, a window, or made to reload itself by a patch', () => {
    const after = applySyncPatch(stateWith([]), patchOf({ upserts: [create('new', { spaceId: 's1', url: 'https://new.example/', title: 'n', pinned: true, anchorUrl: 'https://x.example/', folderId: 'f', container: 'c', windowKey: 'window-2', autoReload: { everyMs: 1 }, private: true, keepAwake: true, favoriteId: 'f', activeAt: activeAt(OLD) })] }), ctx)
    const made = after.tabs.find((t) => t.id === 'new')
    expect(made?.pinned).toBe(false)
    for (const name of ['anchorUrl', 'folderId', 'container', 'windowKey', 'autoReload', 'private', 'keepAwake', 'favoriteId']) expect(made, name).not.toHaveProperty(name)
  })

  it('gives the page the archive kept when it comes back without one (a tab closed here and kept there), and uses the entry up', () => {
    const state = stateWith([], { archive: [{ id: 'back', spaceId: 's1', url: 'https://back.example/where', title: 'Back', archivedAt: OLD, source: 'manual' }, { id: 'other', spaceId: 's1', url: 'https://other.example/', title: 'o', archivedAt: OLD }] })
    const after = applySyncPatch(state, patchOf({ upserts: [create('back', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx)
    expect(after.tabs.find((t) => t.id === 'back')).toMatchObject({ url: 'https://back.example/where', title: 'Back' })
    expect(after.archive.map((e) => e.id)).toEqual(['other'])
  })

  it('does not make a tab that comes back without a page when the archive has none: a tab with no address is not a tab', () => {
    expect(ids(applySyncPatch(stateWith([]), patchOf({ upserts: [create('lost', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx))).toEqual([])
  })

  it('is not made over a pinned tab with the same id', () => {
    const state = stateWith([tabOf('p', { pinned: true, anchorUrl: 'https://p.example/' })])
    const after = applySyncPatch(state, patchOf({ upserts: [change('p', { customTitle: 'Autre' }, {})] }), ctx)
    expect(after.tabs[0]).toMatchObject({ id: 'p', pinned: true })
    expect(after.tabs[0]).not.toHaveProperty('customTitle')
  })
})

describe('sync/apply: a Today tab that changes', () => {
  it('takes the name and the icon, and the later of the two last uses (a tab read there is not swept here)', () => {
    const state = stateWith([tabOf('a', { lastActiveAt: OLD + 5000 })])
    const later = activeAt(NOW)
    const after = applySyncPatch(state, patchOf({ upserts: [change('a', { customTitle: 'Nom', icon: '🦊', activeAt: later }, { activeAt: activeAt(OLD + 5000) })] }), ctx)
    expect(after.tabs[0]).toMatchObject({ customTitle: 'Nom', icon: '🦊', lastActiveAt: later })
  })

  it('keeps its own last use when it is the later one, and never writes an activeAt that is not a time', () => {
    const state = stateWith([tabOf('a', { lastActiveAt: NOW })])
    const earlier = applySyncPatch(state, patchOf({ upserts: [change('a', { activeAt: activeAt(OLD) }, { activeAt: activeAt(NOW) })] }), ctx)
    expect(earlier.tabs[0]?.lastActiveAt).toBe(NOW)
    const bad = applySyncPatch(state, patchOf({ upserts: [change('a', { activeAt: 'yesterday' }, { activeAt: activeAt(NOW) })] }), ctx)
    expect(bad.tabs[0]?.lastActiveAt).toBe(NOW)
  })

  it('leaves a field the person changed since the session froze its snapshot (the next session sends it)', () => {
    const state = stateWith([tabOf('a', { customTitle: 'Le mien' })])
    const after = applySyncPatch(state, patchOf({ upserts: [change('a', { customTitle: 'Le leur' }, { customTitle: 'Avant' })] }), ctx)
    expect(after.tabs[0]?.customTitle).toBe('Le mien')
  })

  it('does not take the page away: the address and the title of a tab are not fields a patch changes', () => {
    const after = applySyncPatch(stateWith([tabOf('a')]), patchOf({ upserts: [{ ...change('a', {}, {}), remove: ['url', 'title', 'pinned', 'createdAt'] }] }), ctx)
    expect(after.tabs[0]).toMatchObject({ url: 'https://a.example/', title: 'a', pinned: false })
  })
})

describe('sync/apply: a Today tab that is closed on the other device', () => {
  it('goes to the archive with the source « sync », the id of the tab and the page it is on here', () => {
    const state = stateWith([tabOf('a', { url: 'https://moved.example/now', title: 'Now', customTitle: 'Mon nom' }), tabOf('b')])
    const after = applySyncPatch(state, patchOf({ removals: [close('a', { spaceId: 's1', customTitle: 'Mon nom', activeAt: activeAt(OLD) })] }), ctx)
    expect(ids(after)).toEqual(['b'])
    expect(after.archive).toEqual([expect.objectContaining({ id: 'a', spaceId: 's1', url: 'https://moved.example/now', title: 'Mon nom', source: 'sync', archivedAt: NOW })])
  })

  it('shows the neighbour of the selected tab when that tab is the one closed', () => {
    const state = stateWith([tabOf('a'), tabOf('b'), tabOf('c')], { activeTabBySpace: { s1: 'b' } })
    const after = applySyncPatch(state, patchOf({ removals: [close('b', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx)
    expect(ids(after)).toEqual(['a', 'c'])
    expect(['a', 'c']).toContain(after.activeTabBySpace['s1'])
  })

  it('stays when it was used since the session froze its snapshot (a use wins over a closing)', () => {
    const state = stateWith([tabOf('a', { lastActiveAt: NOW })])
    const after = applySyncPatch(state, patchOf({ removals: [close('a', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx)
    expect(ids(after)).toEqual(['a'])
    expect(after.archive).toEqual([])
  })

  it('does not close a pinned tab with the same id, and a closing of a pinned tab does not touch a Today tab', () => {
    const pinned = stateWith([tabOf('p', { pinned: true, anchorUrl: 'https://p.example/' })])
    expect(ids(applySyncPatch(pinned, patchOf({ removals: [close('p', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx))).toEqual(['p'])
    const today = stateWith([tabOf('t')])
    expect(ids(applySyncPatch(today, patchOf({ removals: [close('t', { spaceId: 's1', pinned: true }, 'tab')] }), ctx))).toEqual(['t'])
  })

  it('is left to the removal of its space when the space goes too: it is archived once, in the space the person is in', () => {
    const state = stateWith([tabOf('a'), tabOf('x', { spaceId: 's2' })])
    const after = applySyncPatch(state, patchOf({ removals: [{ kind: 'space', id: 's2', expect: { name: 'Two', emoji: '🏠', theme: defaultTheme(), profileId: 'default' } }, close('x', { spaceId: 's2', activeAt: activeAt(OLD) })] }), ctx)
    expect(ids(after)).toEqual(['a'])
    expect(after.archive.filter((e) => e.id === 'x')).toEqual([expect.objectContaining({ spaceId: 's1', source: 'sync' })])
  })

  it('is not archived when it is a private tab or the Extensions page: the archive never hears of them, the tab is only removed', () => {
    const state = stateWith([tabOf('a', { private: true }), tabOf('b', { url: 'lucium-ui://extensions/' })])
    const after = applySyncPatch(state, patchOf({ removals: [close('a', { spaceId: 's1', activeAt: activeAt(OLD) }), close('b', { spaceId: 's1', activeAt: activeAt(OLD) })] }), ctx)
    expect(ids(after)).toEqual([])
    expect(after.archive).toEqual([])
  })
})

describe('sync/apply: a tab that changes list is the same tab (§27.2)', () => {
  it('is pinned in place when `todayTab/<id>` goes and `tab/<id>` comes: it keeps its page, nothing is archived', () => {
    const state = stateWith([tabOf('a', { url: 'https://deeper.example/', title: 'Deeper' })])
    const after = applySyncPatch(
      state,
      patchOf({ upserts: [create('a', { spaceId: 's1', pinned: true, anchorUrl: 'https://anchor.example/', url: 'https://seed.example/', title: 'Seed', customTitle: 'Épinglé' }, 'tab')], removals: [close('a', { spaceId: 's1', activeAt: activeAt(OLD) })] }),
      ctx
    )
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0]).toMatchObject({ id: 'a', pinned: true, anchorUrl: 'https://anchor.example/', customTitle: 'Épinglé', url: 'https://deeper.example/', title: 'Deeper' })
    expect(after.archive).toEqual([])
  })

  it('is detached in place when `tab/<id>` goes and `todayTab/<id>` comes: the anchor and the folder go, the page stays', () => {
    const state = stateWith([tabOf('a', { pinned: true, anchorUrl: 'https://anchor.example/', url: 'https://deeper.example/' })])
    const after = applySyncPatch(
      state,
      patchOf({ upserts: [create('a', { spaceId: 's1', customTitle: 'Libre', url: 'https://seed.example/', title: 'Seed', activeAt: activeAt(NOW) })], removals: [close('a', { pinned: true, anchorUrl: 'https://anchor.example/', spaceId: 's1' }, 'tab')] }),
      ctx
    )
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0]).toMatchObject({ id: 'a', pinned: false, customTitle: 'Libre', url: 'https://deeper.example/', lastActiveAt: activeAt(NOW) })
    expect(after.tabs[0]).not.toHaveProperty('anchorUrl')
    expect(after.archive).toEqual([])
  })

  it('does nothing when the tab is not as it was when the session froze it (the person changed it meanwhile)', () => {
    const state = stateWith([tabOf('a', { customTitle: 'Changé depuis' })])
    const after = applySyncPatch(state, patchOf({ upserts: [create('a', { spaceId: 's1', pinned: true }, 'tab')], removals: [close('a', { spaceId: 's1', customTitle: 'Avant', activeAt: activeAt(OLD) })] }), ctx)
    expect(after.tabs[0]).toMatchObject({ id: 'a', pinned: false, customTitle: 'Changé depuis' })
    expect(after.archive).toEqual([])
  })
})

describe('sync/apply: the list of the Today tabs of a space', () => {
  it('puts the named tabs in order, in the places they held, and the tabs that are not named keep theirs', () => {
    const state = stateWith([tabOf('a'), tabOf('own'), tabOf('b'), tabOf('c'), tabOf('elsewhere', { spaceId: 's2' })])
    const after = applySyncPatch(state, patchOf({ order: { 'today:s1': ['c', 'a', 'b'] } }), ctx)
    expect(ids(after)).toEqual(['c', 'own', 'a', 'b', 'elsewhere'])
  })

  it('puts a tab that has just arrived in the order the list gives', () => {
    const state = stateWith([tabOf('a'), tabOf('b')])
    const after = applySyncPatch(state, patchOf({ upserts: [create('n', { spaceId: 's1', url: 'https://n.example/', title: 'n', activeAt: activeAt(OLD) })], order: { 'today:s1': ['n', 'a', 'b'] } }), ctx)
    expect(ids(after)).toEqual(['n', 'a', 'b'])
  })

  it('does not reorder the pinned tabs with a list of Today tabs, nor the Today tabs with a list of pinned ones', () => {
    const state = stateWith([tabOf('p1', { pinned: true, anchorUrl: 'https://p1.example/' }), tabOf('p2', { pinned: true, anchorUrl: 'https://p2.example/' }), tabOf('a'), tabOf('b')])
    expect(ids(applySyncPatch(state, patchOf({ order: { 'today:s1': ['b', 'a', 'p2', 'p1'] } }), ctx))).toEqual(['p1', 'p2', 'b', 'a'])
    expect(ids(applySyncPatch(state, patchOf({ order: { 'tabs:s1:-': ['p2', 'p1', 'b', 'a'] } }), ctx))).toEqual(['p2', 'p1', 'a', 'b'])
  })
})

describe('sync/apply: an action of the reducer', () => {
  it('is `sync/apply` with the Today tabs, through `reduce`', () => {
    const state = stateWith([tabOf('a')])
    const after = reduce(state, { type: 'sync/apply', patch: patchOf({ removals: [close('a', { spaceId: 's1', activeAt: activeAt(OLD) })] }) }, ctx)
    expect(after.archive[0]).toMatchObject({ id: 'a', source: 'sync' })
  })
})
