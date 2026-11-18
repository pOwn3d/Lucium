// What a session changes in the state (docs/synchronisation.md §8.5): the patch between the frozen snapshot and the merged one, and what the reducer does with it.
import { describe, expect, it } from 'vitest'
import { applySyncPatch, type SyncPatch } from '@shared/sidebar-sync'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { buildPatch, patchIsEmpty } from './patch'
import { NOW, stateOf } from './session-rig.test-support'

const stamp = (n = 1): string => `${String(1_790_000_000_000 + n).padStart(13, '0')}-0000-mac`
const snap = (over: Partial<SyncSnapshot> = {}): SyncSnapshot => ({ entities: {}, tombstones: {}, order: {}, orderStamps: {}, ...over })
const ent = (fields: Record<string, unknown>) => ({ fields: fields as never, stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, stamp()])) })

describe('buildPatch', () => {
  it('is empty when nothing differs', () => {
    const same = snap({ entities: { space: { s1: ent({ name: 'A' }) } }, order: { spaces: ['s1'] } })
    expect(patchIsEmpty(buildPatch(same, same, new Set()))).toBe(true)
  })

  it('makes an entity that arrives, with its fields, and names it a creation', () => {
    const patch = buildPatch(snap(), snap({ entities: { tab: { t1: ent({ pinned: true, spaceId: 's1', url: 'https://x.example/' }) } } }), new Set())
    expect(patch.upserts).toEqual([{ kind: 'tab', id: 't1', create: true, fields: { pinned: true, spaceId: 's1', url: 'https://x.example/' }, remove: [], expect: {} }])
  })

  it('changes a field, naming what it held when frozen, and takes a field away', () => {
    const patch = buildPatch(snap({ entities: { space: { s1: ent({ name: 'A', emoji: '🏠', hideHeader: true }) } } }), snap({ entities: { space: { s1: ent({ name: 'B', emoji: '🏠' }) } } }), new Set())
    expect(patch.upserts).toEqual([{ kind: 'space', id: 's1', create: false, fields: { name: 'B' }, remove: ['hideHeader'], expect: { name: 'A', hideHeader: true } }])
  })

  it('compares values by what they hold', () => {
    const patch = buildPatch(snap({ entities: { space: { s1: ent({ theme: { a: 1, b: 2 } }) } } }), snap({ entities: { space: { s1: ent({ theme: { b: 2, a: 1 } }) } } }), new Set())
    expect(patchIsEmpty(patch)).toBe(true)
  })

  it('removes what the merge no longer holds, naming its fields when frozen', () => {
    const patch = buildPatch(snap({ entities: { folder: { f1: ent({ name: 'A', spaceId: 's1' }) } } }), snap(), new Set())
    expect(patch.removals).toEqual([{ kind: 'folder', id: 'f1', expect: { name: 'A', spaceId: 's1' } }])
  })

  it('leaves alone everything of a space that is set aside: the merge took it out of its inputs, and not-there does not mean deleted', () => {
    const frozen = snap({ entities: { space: { locked: ent({ name: 'L' }), s1: ent({ name: 'A' }) }, tab: { tl: ent({ spaceId: 'locked' }), t1: ent({ spaceId: 's1' }) }, folder: { fl: ent({ spaceId: 'locked' }) } }, order: { 'tabs:locked:-': ['tl'], 'folders:locked:-': ['fl'], spaces: ['locked', 's1'] } })
    const merged = snap({ entities: { space: { s1: ent({ name: 'A' }) }, tab: { t1: ent({ spaceId: 's1' }) } }, order: { spaces: ['s1'] } })
    const patch = buildPatch(frozen, merged, new Set(['locked']))
    expect(patch.removals).toEqual([])
    expect(patch.upserts).toEqual([])
    expect(Object.keys(patch.order)).toEqual(['spaces'])
    const arriving = buildPatch(snap(), snap({ entities: { tab: { tl: ent({ spaceId: 'locked' }) } }, order: { 'tabs:locked:-': ['tl'] } }), new Set(['locked']))
    expect(patchIsEmpty(arriving)).toBe(true)
  })

  it('reorders a list that is not as it was frozen, and only that list', () => {
    const patch = buildPatch(snap({ order: { spaces: ['a', 'b'], 'tabs:s:-': ['x'] } }), snap({ order: { spaces: ['b', 'a'], 'tabs:s:-': ['x'] } }), new Set())
    expect(patch.order).toEqual({ spaces: ['b', 'a'] })
  })

  it('sets a setting that changed, and no other', () => {
    const patch = buildPatch(snap({ entities: { setting: { sendGpc: ent({ value: true }), httpsUpgrade: ent({ value: true }) } } }), snap({ entities: { setting: { sendGpc: ent({ value: false }), httpsUpgrade: ent({ value: true }) } } }), new Set())
    expect(patch.settings).toEqual({ sendGpc: false })
  })

  it('does not write a kind this version does not know', () => {
    const patch = buildPatch(snap(), snap({ entities: { widget: { w1: ent({ a: 1 }) } } }), new Set())
    expect(patchIsEmpty(patch)).toBe(true)
  })

  it('changes nothing it was given', () => {
    const a = snap({ entities: { space: { s1: ent({ name: 'A' }) } } })
    const b = snap({ entities: { space: { s1: ent({ name: 'B' }) } } })
    const before = JSON.stringify([a, b])
    buildPatch(a, b, new Set())
    expect(JSON.stringify([a, b])).toBe(before)
  })
})

describe('sync/apply: what the reducer writes', () => {
  const ctx = { now: NOW, newId: () => 'unused' }
  const patch = (over: Partial<SyncPatch> = {}): SyncPatch => ({ upserts: [], removals: [], order: {}, settings: {}, ...over })
  const base = () => stateOf({ spaces: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }], folders: [{ id: 'f1', spaceId: 's1' }], tabs: [{ id: 't1', spaceId: 's1', customTitle: 'one' }, { id: 't2', spaceId: 's1' }, { id: 'today', spaceId: 's1', pinned: false }] })

  it('gives the state back as it was for a patch that names nothing', () => {
    const state = base()
    expect(applySyncPatch(state, patch(), ctx)).toEqual(state)
  })

  it('sets a field only while the state still holds what the session froze: a change made meanwhile is kept', () => {
    const upsert = (expectName: string) => patch({ upserts: [{ kind: 'space', id: 's1', create: false, fields: { name: 'From the other device' }, remove: [], expect: { name: expectName } }] })
    expect(applySyncPatch(base(), upsert('A'), ctx).spaces[0]?.name).toBe('From the other device')
    expect(applySyncPatch(base(), upsert('Something else'), ctx).spaces[0]?.name).toBe('A')
  })

  it('takes a field away only while it is as frozen', () => {
    const withTitle = (expectTitle: string) => patch({ upserts: [{ kind: 'tab', id: 't1', create: false, fields: {}, remove: ['customTitle'], expect: { customTitle: expectTitle } }] })
    expect(applySyncPatch(base(), withTitle('one'), ctx).tabs.find((t) => t.id === 't1')?.customTitle).toBeUndefined()
    expect(applySyncPatch(base(), withTitle('other'), ctx).tabs.find((t) => t.id === 't1')?.customTitle).toBe('one')
  })

  it('makes an entity that arrives, pinned, with the fields it came with, and no other', () => {
    const next = applySyncPatch(base(), patch({ upserts: [{ kind: 'tab', id: 'new', create: true, fields: { spaceId: 's2', pinned: true, url: 'https://new.example/', title: 'New', anchorUrl: 'https://new.example/' }, remove: [], expect: {} }] }), ctx)
    expect(next.tabs.find((t) => t.id === 'new')).toMatchObject({ spaceId: 's2', pinned: true, url: 'https://new.example/', createdAt: NOW })
  })

  it('does not make an entity the patch does not call a creation', () => {
    const next = applySyncPatch(base(), patch({ upserts: [{ kind: 'space', id: 'ghost', create: false, fields: { name: 'X' }, remove: [], expect: {} }] }), ctx)
    expect(next.spaces.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('opens a pinned tab that comes back without its seed fields at the page it returns to', () => {
    const next = applySyncPatch(base(), patch({ upserts: [{ kind: 'tab', id: 'back', create: true, fields: { spaceId: 's1', pinned: true, anchorUrl: 'https://home.example/', customTitle: 'Home' }, remove: [], expect: {} }] }), ctx)
    expect(next.tabs.find((t) => t.id === 'back')).toMatchObject({ url: 'https://home.example/', title: 'Home' })
  })

  it('removes an entity only while it is as frozen, and the things that held on to it are cleaned', () => {
    const removal = (expectName: string) => patch({ removals: [{ kind: 'space', id: 's2', expect: { name: expectName } }] })
    expect(applySyncPatch(base(), removal('B'), ctx).spaces.map((s) => s.id)).toEqual(['s1'])
    expect(applySyncPatch(base(), removal('Not B'), ctx).spaces.map((s) => s.id)).toEqual(['s1', 's2'])
    const folderGone = applySyncPatch(base(), patch({ removals: [{ kind: 'folder', id: 'f1', expect: {} }] }), ctx)
    expect(folderGone.folders).toEqual([])
  })

  it('reorders the members of a list in the places they held, and leaves the others where they are', () => {
    const next = applySyncPatch(base(), patch({ order: { 'tabs:s1:-': ['t2', 't1'] } }), ctx)
    expect(next.tabs.map((t) => t.id)).toEqual(['t2', 't1', 'today'])
    const spaces = applySyncPatch(base(), patch({ order: { spaces: ['s2', 's1'] } }), ctx)
    expect(spaces.spaces.map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('puts a member the order does not name after those it names, and ignores a list it does not know', () => {
    const next = applySyncPatch(base(), patch({ order: { 'tabs:s1:-': ['t2'], 'nonsense:x': ['t1'], 'tabs:s1:nothing': ['t1'] } }), ctx)
    expect(next.tabs.map((t) => t.id)).toEqual(['t2', 't1', 'today'])
  })

  it('does not let a patch change the identifier of an entity, nor reach the prototype through an update', () => {
    const hostile = JSON.parse('{"id":"stolen","__proto__":{"polluted":true},"name":"Renamed"}') as Record<string, unknown>
    const next = applySyncPatch(base(), patch({ upserts: [{ kind: 'space', id: 's1', create: false, fields: hostile, remove: ['id'], expect: { name: 'A' } }] }), ctx)
    expect(next.spaces.map((space) => space.id)).toEqual(['s1', 's2'])
    expect(next.spaces[0]?.name).toBe('Renamed')
    expect(Object.getPrototypeOf(next.spaces[0])).toBe(Object.prototype)
  })

  it('puts the members an order does not name after those it does, in their own order', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [{ id: 't1', spaceId: 's1' }, { id: 't2', spaceId: 's1' }, { id: 't3', spaceId: 's1' }] })
    const next = applySyncPatch(state, patch({ order: { 'tabs:s1:-': ['t3'] } }), ctx)
    expect(next.tabs.map((t) => t.id)).toEqual(['t3', 't1', 't2'])
  })

  it('leaves a Today tab where it is when the pinned tabs around it are reordered', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], tabs: [{ id: 't1', spaceId: 's1' }, { id: 'today', spaceId: 's1', pinned: false }, { id: 't2', spaceId: 's1' }] })
    const next = applySyncPatch(state, patch({ order: { 'tabs:s1:-': ['t2', 't1'] } }), ctx)
    expect(next.tabs.map((t) => t.id)).toEqual(['t2', 'today', 't1'])
  })

  it('orders the folders of one folder apart from those of another, and from the root', () => {
    const state = stateOf({ spaces: [{ id: 's1' }], folders: [{ id: 'a', spaceId: 's1' }, { id: 'a1', spaceId: 's1', parentId: 'a' }, { id: 'b', spaceId: 's1' }, { id: 'a2', spaceId: 's1', parentId: 'a' }] })
    const root = applySyncPatch(state, patch({ order: { 'folders:s1:-': ['b', 'a'] } }), ctx)
    expect(root.folders.map((f) => f.id)).toEqual(['b', 'a1', 'a', 'a2'])
    const inside = applySyncPatch(state, patch({ order: { 'folders:s1:a': ['a2', 'a1'] } }), ctx)
    expect(inside.folders.map((f) => f.id)).toEqual(['a', 'a2', 'b', 'a1'])
  })

  it('gives a favourite that arrives with no profile to the default one, once, even when other profiles are in use', () => {
    const state = stateOf({ spaces: [{ id: 's1' }, { id: 's2', profileId: 'work' }] })
    const next = applySyncPatch(state, patch({ upserts: [{ kind: 'favorite', id: 'fav-new', create: true, fields: { url: 'https://new.example/', title: 'New' }, remove: [], expect: {} }] }), ctx)
    expect(next.favorites.filter((f) => f.url === 'https://new.example/').map((f) => f.profileId)).toEqual(['default'])
  })

  it('keeps a favourite that arrives with no profile on the default one when another profile already has the same page: one per profile, not one more in each', () => {
    const state = stateOf({ spaces: [{ id: 's1' }, { id: 's2', profileId: 'work' }], favorites: [{ id: 'old', url: 'https://same.example/', profileId: 'work' }] })
    const next = applySyncPatch(state, patch({ upserts: [{ kind: 'favorite', id: 'fav-new', create: true, fields: { url: 'https://same.example/', title: 'New' }, remove: [], expect: {} }] }), ctx)
    expect(next.favorites.filter((f) => f.url === 'https://same.example/').map((f) => f.profileId).sort()).toEqual(['default', 'work'])
  })

  it('sets a setting of the closed list, and never another, whatever the patch says', () => {
    const next = applySyncPatch(base(), patch({ settings: { sendGpc: false, httpsUpgrade: false, lockEnabled: true, lockApp: true, proxyEnabled: true, updateFeedUrl: 'https://evil.example/', passwordManager: true } }), ctx)
    expect(next.settings.sendGpc).toBe(false)
    expect(next.settings.httpsUpgrade).toBe(false)
    for (const key of ['lockEnabled', 'lockApp', 'proxyEnabled', 'passwordManager'] as const) expect(next.settings[key], key).toBe(base().settings[key])
    expect(next.settings.updateFeedUrl).toBe(base().settings.updateFeedUrl)
  })

  it('cleans what it writes as a file read at the start is: a bad address drops its entity, a long name is cut, a lone favourite is made once', () => {
    const next = applySyncPatch(
      base(),
      patch({
        upserts: [
          { kind: 'tab', id: 'evil', create: true, fields: { spaceId: 's1', pinned: true, url: 'javascript:alert(1)', title: 'x' }, remove: [], expect: {} },
          { kind: 'space', id: 's1', create: false, fields: { name: 'n'.repeat(5000) }, remove: [], expect: { name: 'A' } },
          { kind: 'favorite', id: 'f-a', create: true, fields: { url: 'https://same.example/', title: 'A' }, remove: [], expect: {} },
          { kind: 'favorite', id: 'f-b', create: true, fields: { url: 'https://same.example/', title: 'B' }, remove: [], expect: {} }
        ]
      }),
      ctx
    )
    expect(next.tabs.find((t) => t.id === 'evil')).toBeUndefined()
    expect(next.spaces[0]?.name.length).toBeLessThanOrEqual(200)
    expect(next.favorites.filter((f) => f.url === 'https://same.example/')).toHaveLength(1)
  })

  it('never writes a key that would reach the prototype', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","name":"ok"}') as Record<string, unknown>
    const next = applySyncPatch(base(), patch({ upserts: [{ kind: 'space', id: 'p', create: true, fields: hostile, remove: [], expect: {} }] }), ctx)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(next.spaces.find((s) => s.id === 'p')?.name).toBe('ok')
    expect(Object.getPrototypeOf(next.spaces.find((s) => s.id === 'p'))).toBe(Object.prototype)
  })

  it('changes nothing of the state it was given', () => {
    const state = base()
    const before = JSON.stringify(state)
    applySyncPatch(state, patch({ upserts: [{ kind: 'space', id: 's1', create: false, fields: { name: 'Z' }, remove: [], expect: { name: 'A' } }], removals: [{ kind: 'tab', id: 't1', expect: {} }], order: { spaces: ['s2', 's1'] } }), ctx)
    expect(JSON.stringify(state)).toBe(before)
  })
})
