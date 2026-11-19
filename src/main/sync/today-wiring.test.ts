// What the Mac does with the contract of the shared Today tabs (docs/synchronisation.md §27, card 508): the admission read from the state and the book of marks, the view and
// the snapshot, the door, the patch, the marks that follow the state, and the categories. The contract itself (the functions of src/shared/sync-today.ts) is held by
// ios/Contracts/sync-today-vectors.json and its test; these tests are about the calls.
import { describe, expect, it, vi } from 'vitest'
import type { SyncCategory } from '@shared/sync-ipc'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { roundActiveAt, TODAY_TAB_CAP } from '@shared/sync-today'
import { buildPatch } from './patch'
import { cleanSnapshot, filterEntity } from './inbound-filter'
import { MarkBook, listKindOf } from './marks'
import { NOW, stateOf } from './session-rig.test-support'
import { announcedCategories, commonCategories, shownTabsClosed } from './session'
import { admittedTodayTabs, baseOf, follows, kindIsExchanged, onlyExchanged, snapshotOf, trackedViewOf } from './state-view'
import { MarkTracker } from './sync-tracker'

const OLD = NOW - 120_000
const tab = (id: string, extra: Record<string, unknown> = {}): { id: string; spaceId: string; pinned: false; createdAt: number; lastActiveAt: number } & Record<string, unknown> => ({ id, spaceId: 's1', pinned: false, createdAt: OLD, lastActiveAt: OLD, ...extra })
const stamp = (n = 1): string => `${String(NOW + n).padStart(13, '0')}-0000-mac`
const ent = (fields: Record<string, unknown>) => ({ fields: fields as never, stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, stamp()])) })
const snap = (over: Partial<SyncSnapshot> = {}): SyncSnapshot => ({ entities: {}, tombstones: {}, order: {}, orderStamps: {}, ...over })

/** A book that holds the Today tabs named: they are admitted already (§27.3). */
function bookOf(admitted: string[]): MarkBook {
  const book = new MarkBook('mac')
  const view = { entities: { todayTab: Object.fromEntries(admitted.map((id) => [id, { spaceId: 's1', activeAt: 1 }])) }, order: {} }
  book.update(view, NOW)
  return book
}

describe('admittedTodayTabs: the admission read from the state and the book (§27.3, §27.4)', () => {
  const inputs = (admitted: string[], over: { admitNew?: boolean; locked?: string[]; now?: number } = {}) => ({ book: bookOf(admitted), now: over.now ?? NOW, admitNew: over.admitNew ?? true, isSpaceLocked: (id: string) => (over.locked ?? []).includes(id) })

  it('lets in a tab that has been open for twenty seconds, in a space that is not locked, on a web page', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [tab('ok'), tab('young', { createdAt: NOW - 5000 }), tab('internal', { url: 'lucium-ui://extensions/' }), tab('file', { url: 'file:///etc/hosts' })] })
    expect([...admittedTodayTabs(state, inputs([]))]).toEqual(['ok'])
  })

  it('leaves out a pinned tab, a private tab, the page of a favourite and a tab of a container', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [tab('ok'), tab('pinned', { pinned: true }), tab('private', { private: true }), tab('fav', { favoriteId: 'f1' }), tab('boxed', { container: 'work' })] })
    // `normalize` forgets a favourite that does not exist and a container that is not set: the state is made the way the reducer cannot, to reach what the function says.
    const raw = { ...state, tabs: [tab('ok'), tab('pinned', { pinned: true }), tab('private', { private: true }), tab('fav', { favoriteId: 'f1' }), tab('boxed', { container: 'work' })].map((t) => ({ url: `https://${t.id}.example/`, title: t.id, ...t })) } as never
    expect([...admittedTodayTabs(raw, inputs([]))]).toEqual(['ok'])
  })

  it('does not let in a tab of a locked space', () => {
    const state = stateOf({ spaces: [{ id: 's1' }, { id: 's2' }], tabs: [tab('ok'), tab('locked', { spaceId: 's2' })] })
    expect([...admittedTodayTabs(state, inputs([], { locked: ['s2'] }))]).toEqual(['ok'])
  })

  it('lets in at most the cap, the most recently used first (the rest stays local)', () => {
    const tabs = Array.from({ length: TODAY_TAB_CAP + 5 }, (_, n) => tab(`t${String(n).padStart(3, '0')}`, { lastActiveAt: OLD + n }))
    const admitted = admittedTodayTabs(stateOf({ spaces: [{ id: 's1' }], tabs }), inputs([]))
    expect(admitted.size).toBe(TODAY_TAB_CAP)
    expect(admitted.has('t204')).toBe(true)
    expect(admitted.has('t000')).toBe(false)
  })

  it('keeps a tab the book holds whatever page it is on, a locked space, a young age or a full set: the admission is sticky', () => {
    const tabs = [tab('old', { url: 'lucium-ui://extensions/' }), tab('younger', { createdAt: NOW - 1000, spaceId: 's2' })]
    const state = stateOf({ spaces: [{ id: 's1' }, { id: 's2' }], tabs })
    expect([...admittedTodayTabs(state, inputs(['old', 'younger'], { locked: ['s2'] }))].sort()).toEqual(['old', 'younger'])
  })

  it('takes a tab the book holds out when it becomes private', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [tab('a', { private: true }), tab('b')] })
    expect([...admittedTodayTabs(state, inputs(['a', 'b']))]).toEqual(['b'])
  })

  it('lets nobody new in when the session does not say so (the category is not common), and keeps the ones the book holds', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [tab('new'), tab('held')] })
    expect([...admittedTodayTabs(state, inputs(['held'], { admitNew: false }))]).toEqual(['held'])
  })
})

describe('trackedViewOf and snapshotOf: the shared Today tabs', () => {
  const state = stateOf({ spaces: [{ id: 's1' }], tabs: [tab('a', { customTitle: 'Mon A', icon: '🦊', url: 'https://a.example/x', title: 'A', faviconUrl: 'https://a.example/i.png', lastActiveAt: OLD + 123_456 }), tab('b'), tab('pin', { pinned: true })] })
  const admitted = new Set(['a', 'b'])

  it('follows the synchronised fields and the projection `activeAt` of an admitted tab, never a seed or a local field', () => {
    const view = trackedViewOf(state, admitted)
    expect(view.entities['todayTab']?.['a']).toEqual({ spaceId: 's1', customTitle: 'Mon A', icon: '🦊', activeAt: roundActiveAt(OLD + 123_456) })
    expect(Object.keys(view.entities['todayTab'] ?? {}).sort()).toEqual(['a', 'b'])
    expect(view.order['today:s1']).toEqual(['a', 'b'])
  })

  it('follows no Today tab when none is admitted, and does not mix them with the pinned tabs', () => {
    const view = trackedViewOf(state, new Set())
    expect(view.entities['todayTab']).toEqual({})
    expect(Object.keys(view.entities['tab'] ?? {})).toEqual(['pin'])
    expect(view.order['today:s1']).toBeUndefined()
  })

  const marks = (): MarkBook => {
    const book = new MarkBook('mac')
    book.update(trackedViewOf(state, admitted), NOW)
    return book
  }
  const take = (categories: SyncCategory[], base: SyncSnapshot | null = null): SyncSnapshot => snapshotOf(state, marks(), { categories: new Set(categories), admittedToday: admitted, withheld: new Set(), base })

  it('sends the Today tabs, with the page they are on as seeds, when the category is common, and their list', () => {
    const sent = take(['structure', 'todayTabs'])
    expect(Object.keys(sent.entities['todayTab'] ?? {}).sort()).toEqual(['a', 'b'])
    expect(sent.entities['todayTab']?.['a']?.fields).toMatchObject({ spaceId: 's1', url: 'https://a.example/x', title: 'A', activeAt: roundActiveAt(OLD + 123_456) })
    expect(sent.entities['todayTab']?.['a']?.fields).not.toHaveProperty('faviconUrl')
    expect(sent.order['today:s1']).toEqual(['a', 'b'])
  })

  it('sends no Today tab and no list when the category is not common', () => {
    const sent = take(['structure'])
    expect(sent.entities['todayTab']).toBeUndefined()
    expect(sent.order['today:s1']).toBeUndefined()
  })

  it('sends the page of a tab the other device does not have yet, and not the one it has (the base holds none of the seeds)', () => {
    const merged = take(['structure', 'todayTabs'])
    const base = baseOf(merged)
    expect(base.entities['todayTab']?.['a']?.fields).not.toHaveProperty('url')
    expect(base.entities['todayTab']?.['a']?.fields).not.toHaveProperty('title')
    const again = take(['structure', 'todayTabs'], base)
    expect(again.entities['todayTab']?.['a']?.fields).not.toHaveProperty('url')
    expect(again.entities['todayTab']?.['a']?.fields).toHaveProperty('activeAt')
  })

  it('sends nothing of a space set aside, the list of its Today tabs included', () => {
    const sent = snapshotOf(state, marks(), { categories: new Set<SyncCategory>(['structure', 'todayTabs']), admittedToday: admitted, withheld: new Set(['s1']), base: null })
    expect(sent.entities['todayTab']).toBeUndefined()
    expect(sent.order['today:s1']).toBeUndefined()
  })

  it('follows the fields of the class « synced » of a Today tab and not its seeds', () => {
    expect(follows('todayTab', 'activeAt')).toBe(true)
    expect(follows('todayTab', 'customTitle')).toBe(true)
    expect(follows('todayTab', 'url')).toBe(false)
    expect(follows('todayTab', 'title')).toBe(false)
    expect(follows('todayTab', 'lastActiveAt')).toBe(false)
  })
})

describe('the kind and the lists of the Today tabs in a session', () => {
  it('belong to the category « Onglets d\'Aujourd\'hui », not to the structure', () => {
    expect(kindIsExchanged('todayTab', new Set<SyncCategory>(['todayTabs']))).toBe(true)
    expect(kindIsExchanged('todayTab', new Set<SyncCategory>(['structure']))).toBe(false)
    expect(listKindOf('today:s1')).toBe('todayTab')
  })

  it('are cut off from what comes in when the category is not common, and the list with them', () => {
    const received = snap({ entities: { todayTab: { a: ent({ spaceId: 's1', activeAt: 1 }) } }, order: { 'today:s1': ['a'] }, orderStamps: { 'today:s1': stamp() }, tombstones: { todayTab: { z: stamp() } } })
    const { snapshot, refused } = onlyExchanged(received, new Set<SyncCategory>(['structure']))
    expect(snapshot.entities['todayTab']).toBeUndefined()
    expect(snapshot.order['today:s1']).toBeUndefined()
    expect(snapshot.tombstones['todayTab']).toBeUndefined()
    expect(refused.map((one) => one.kind).sort()).toEqual(['order', 'todayTab', 'tombstone'])
  })

  it('announce the category only with the structure, and take it as common only with the structure', () => {
    expect([...announcedCategories(new Set<SyncCategory>(['todayTabs']))]).toEqual([])
    expect([...announcedCategories(new Set<SyncCategory>(['structure', 'todayTabs']))].sort()).toEqual(['structure', 'todayTabs'])
    expect([...commonCategories(new Set<SyncCategory>(['structure', 'todayTabs']), ['todayTabs'])]).toEqual([])
    expect([...commonCategories(new Set<SyncCategory>(['structure', 'todayTabs']), ['structure', 'todayTabs'])].sort()).toEqual(['structure', 'todayTabs'])
  })
})

describe('the door: cleanSnapshot calls the gate of the Today tabs (§27.4, §27.7)', () => {
  const ok = { spaceId: 's1', url: 'https://a.example/', title: 'A', activeAt: 600_000 }

  it('takes the local fields off a Today tab, and the ones only a pinned tab has', () => {
    const result = filterEntity({ kind: 'todayTab', id: 'a', fields: { ...ok, lastActiveAt: 5, private: true, pinned: true, anchorUrl: 'https://x.example/', folderId: 'f' } })
    expect(result).toEqual({ accepted: true, fields: ok })
  })

  it('refuses an address that is not a web page, an address that is too long and a title that is not a text, and lists them with their reason', () => {
    const entities = { todayTab: { good: ent(ok), file: ent({ ...ok, url: 'file:///etc/hosts' }), long: ent({ ...ok, url: `https://a.example/${'x'.repeat(4100)}` }), title: ent({ ...ok, title: 7 }) } }
    const cleaned = cleanSnapshot(snap({ entities }), NOW)
    expect(Object.keys(cleaned.snapshot.entities['todayTab'] ?? {})).toEqual(['good'])
    expect(cleaned.refused.map((one) => `${one.id}:${one.reason}`).sort()).toEqual(['file:invalid-url', 'long:invalid-url', 'title:invalid-value'])
  })

  it('cuts a title to 300 bytes', () => {
    const cleaned = cleanSnapshot(snap({ entities: { todayTab: { a: ent({ ...ok, title: 'é'.repeat(400) }) } } }), NOW)
    expect(Buffer.byteLength(cleaned.snapshot.entities['todayTab']?.['a']?.fields['title'] as string, 'utf8')).toBeLessThanOrEqual(300)
  })

  it('gives back the version of the base for an address refused when the entity is in the base, so that the gap is not read as a deletion', () => {
    const before = ent({ spaceId: 's1', activeAt: 600_000 })
    const cleaned = cleanSnapshot(snap({ entities: { todayTab: { a: ent({ ...ok, url: 'javascript:alert(1)' }) } } }), NOW, snap({ entities: { todayTab: { a: before } } }))
    expect(cleaned.snapshot.entities['todayTab']?.['a']).toEqual(before)
    expect(cleaned.refused).toEqual([{ kind: 'todayTab', id: 'a', reason: 'invalid-url' }])
  })

  it('keeps the 500 best and refuses the others (too-many-today-tabs)', () => {
    const entities = Object.fromEntries(Array.from({ length: 505 }, (_, n) => [`t${String(n).padStart(3, '0')}`, ent({ ...ok, activeAt: 600_000 + n * 600_000 })]))
    const cleaned = cleanSnapshot(snap({ entities: { todayTab: entities } }), NOW)
    expect(Object.keys(cleaned.snapshot.entities['todayTab'] ?? {})).toHaveLength(500)
    expect(cleaned.refused).toHaveLength(5)
    expect(new Set(cleaned.refused.map((one) => one.reason))).toEqual(new Set(['too-many-today-tabs']))
    expect(cleaned.snapshot.entities['todayTab']?.['t000']).toBeUndefined()
  })

  it('leaves no empty kind behind when every Today tab was refused: an empty kind would not hash like an absent one', () => {
    const cleaned = cleanSnapshot(snap({ entities: { todayTab: { a: ent({ ...ok, url: 'file:///x' }) } } }), NOW)
    expect(Object.hasOwn(cleaned.snapshot.entities, 'todayTab')).toBe(false)
  })
})

describe('buildPatch: the Today tabs', () => {
  it('names the creation of a Today tab, with its seeds and its activeAt', () => {
    const patch = buildPatch(snap(), snap({ entities: { todayTab: { a: ent({ spaceId: 's1', url: 'https://a.example/', title: 'A', activeAt: 600_000 }) } } }), new Set())
    expect(patch.upserts).toEqual([{ kind: 'todayTab', id: 'a', create: true, fields: { spaceId: 's1', url: 'https://a.example/', title: 'A', activeAt: 600_000 }, remove: [], expect: {} }])
  })

  it('names a closing, with the fields the tab had when frozen', () => {
    const patch = buildPatch(snap({ entities: { todayTab: { a: ent({ spaceId: 's1', activeAt: 600_000 }) } } }), snap(), new Set())
    expect(patch.removals).toEqual([{ kind: 'todayTab', id: 'a', expect: { spaceId: 's1', activeAt: 600_000 } }])
  })

  it('leaves alone the Today tabs of a space that is set aside, and the list `today:<space>`: not there does not mean closed', () => {
    const frozen = snap({ entities: { todayTab: { a: ent({ spaceId: 'locked' }), b: ent({ spaceId: 's1' }) } }, order: { 'today:locked': ['a'], 'today:s1': ['b'] } })
    const merged = snap({ entities: { todayTab: { b: ent({ spaceId: 's1' }) } }, order: { 'today:s1': ['b'] } })
    const patch = buildPatch(frozen, merged, new Set(['locked']))
    expect(patch.removals).toEqual([])
    expect(Object.keys(patch.order)).toEqual([])
    // The merge may give a list of the locked space back all the same (a device that does not keep to it): it is not applied.
    const given = buildPatch(snap(), snap({ order: { 'today:locked': ['a', 'b'] } }), new Set(['locked']))
    expect(given.order).toEqual({})
  })

  it('carries the new order of a list of Today tabs', () => {
    const patch = buildPatch(snap({ order: { 'today:s1': ['a', 'b'] } }), snap({ order: { 'today:s1': ['b', 'a'] } }), new Set())
    expect(patch.order).toEqual({ 'today:s1': ['b', 'a'] })
  })
})

describe('MarkBook and the Today tabs it holds', () => {
  it('says which entities it holds: the admission is kept there', () => {
    const book = bookOf(['a'])
    expect(book.knows('todayTab', 'a')).toBe(true)
    expect(book.knows('todayTab', 'b')).toBe(false)
    expect(book.knows('tab', 'a')).toBe(false)
  })
})

describe('MarkTracker: the Today tabs between two sessions (§27.3)', () => {
  function rig(tabs: ReturnType<typeof tab>[]) {
    const listeners: Array<() => void> = []
    const book = bookOf(tabs.map((one) => one.id))
    let state = stateOf({ spaces: [{ id: 's1' }], tabs })
    const tracker = new MarkTracker({ state: () => state, subscribe: (l) => (listeners.push(l), () => undefined), marks: book, save: vi.fn(), now: () => NOW })
    return { tracker, book, change: (next: typeof state) => (state = next) }
  }

  it('keeps following the tabs the book holds, and admits no new one', () => {
    const r = rig([tab('a')])
    r.change(stateOf({ spaces: [{ id: 's1' }], tabs: [tab('a'), tab('new')] }))
    r.tracker.catchUp()
    expect(r.book.knows('todayTab', 'a')).toBe(true)
    expect(r.book.knows('todayTab', 'new')).toBe(false)
    expect(r.book.tombstonesOf()['todayTab']).toBeUndefined()
  })

  it('leaves a tombstone for a tab that is closed, with the mark of the gesture', () => {
    const r = rig([tab('a'), tab('b')])
    r.change(stateOf({ spaces: [{ id: 's1' }], tabs: [tab('b')] }))
    r.tracker.catchUp()
    expect(Object.keys(r.book.tombstonesOf()['todayTab'] ?? {})).toEqual(['a'])
    expect(r.book.knows('todayTab', 'a')).toBe(false)
  })
})

describe('shownTabsClosed: the tab that was on screen when the other device closed it (§27.5, [Q11])', () => {
  const before = { ...stateOf({ spaces: [{ id: 's1' }, { id: 's2' }], tabs: [tab('shown'), tab('other', { spaceId: 's2' }), tab('hidden')] }), activeSpaceId: 's1', activeTabBySpace: { s1: 'shown', s2: 'other' } }
  const patch = { upserts: [], removals: ['shown', 'other', 'hidden'].map((id) => ({ kind: 'todayTab' as const, id, expect: {} })), order: {}, settings: {} }

  it('names the selected tab of each space that is gone, and says which one was on screen', () => {
    const after = { ...before, tabs: before.tabs.filter((one) => one.id === 'hidden'), activeTabBySpace: { s1: 'hidden', s2: null } }
    expect(shownTabsClosed(before, after, patch)).toEqual([{ id: 'shown', spaceId: 's1', onScreen: true }, { id: 'other', spaceId: 's2', onScreen: false }])
  })

  it('names nothing when the patch did not close it (a closing that was not applied, a tab that was not selected)', () => {
    expect(shownTabsClosed(before, before, patch)).toEqual([])
    expect(shownTabsClosed(before, { ...before, tabs: before.tabs.filter((one) => one.id !== 'hidden') }, patch)).toEqual([])
  })

  it('does not name a tab a pinned-tab removal took away', () => {
    const after = { ...before, tabs: before.tabs.filter((one) => one.id !== 'shown') }
    expect(shownTabsClosed(before, after, { ...patch, removals: [{ kind: 'tab', id: 'shown', expect: {} }] })).toEqual([])
  })
})
