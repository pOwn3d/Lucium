// The state of the Mac as the synchronisation reads it (docs/synchronisation.md §8.3, §10): what is synchronised, the lists, and the snapshot a session freezes.
import { describe, expect, it } from 'vitest'
import type { SyncCategory } from '@shared/sync-ipc'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { MarkBook } from './marks'
import { NOW, stateOf } from './session-rig.test-support'
import { baseOf, follows, openTabsOf, snapshotOf, trackedViewOf, withheldSpaces } from './state-view'

const all = new Set<SyncCategory>(['structure', 'settings', 'archive', 'openTabs'])
const snap = (state: ReturnType<typeof stateOf>, over: { categories?: Set<SyncCategory>; withheld?: string[]; base?: SyncSnapshot | null } = {}): SyncSnapshot => {
  const marks = new MarkBook('mac')
  marks.update(trackedViewOf(state), NOW)
  return snapshotOf(state, marks, { categories: over.categories ?? all, withheld: new Set(over.withheld ?? []), base: over.base ?? null })
}

describe('trackedViewOf', () => {
  const state = stateOf({
    spaces: [{ id: 's1', name: 'Travail', image: 'pic.png' }, { id: 's2', profileId: 'work' }],
    folders: [{ id: 'f1', spaceId: 's1', collapsed: true }, { id: 'f2', spaceId: 's1', parentId: 'f1' }],
    tabs: [
      { id: 't1', spaceId: 's1', folderId: 'f1', anchorUrl: 'https://a.example/', faviconUrl: 'https://a.example/i.png', lastActiveAt: 9 },
      { id: 't2', spaceId: 's1' },
      { id: 'today', spaceId: 's1', pinned: false },
      { id: 'private', spaceId: 's1', private: true }
    ],
    favorites: [{ id: 'fav1' }, { id: 'fav2', profileId: 'work' }]
  })
  const view = trackedViewOf(state)

  it('follows the synchronised fields of the five kinds, with no identifier, no seed and no local field', () => {
    expect(view.entities['space']?.['s1']).toEqual(expect.objectContaining({ name: 'Travail' }))
    expect(view.entities['space']?.['s1']).not.toHaveProperty('image')
    expect(view.entities['space']?.['s1']).not.toHaveProperty('id')
    expect(view.entities['folder']?.['f1']).not.toHaveProperty('collapsed')
    expect(view.entities['folder']?.['f2']).toMatchObject({ parentId: 'f1' })
    expect(view.entities['tab']?.['t1']).toMatchObject({ anchorUrl: 'https://a.example/', pinned: true })
    for (const local of ['faviconUrl', 'lastActiveAt', 'createdAt', 'url', 'title']) expect(view.entities['tab']?.['t1'], local).not.toHaveProperty(local)
  })

  it('leaves out the Today tabs and the private tabs', () => {
    expect(Object.keys(view.entities['tab'] ?? {}).sort()).toEqual(['t1', 't2'])
  })

  it('orders the lists the way the specification keys them', () => {
    expect(view.order['spaces']).toEqual(['s1', 's2'])
    expect(view.order['folders:s1:-']).toEqual(['f1'])
    expect(view.order['folders:s1:f1']).toEqual(['f2'])
    expect(view.order['tabs:s1:f1']).toEqual(['t1'])
    expect(view.order['tabs:s1:-']).toEqual(['t2'])
    expect(view.order['favorites:default']).toEqual(['fav1'])
    expect(view.order['favorites:work']).toEqual(['fav2'])
  })

  it('holds the eight settings of the closed list and no other', () => {
    expect(Object.keys(view.entities['setting'] ?? {}).sort()).toEqual(['autoArchiveHours', 'httpsUpgrade', 'profileNames', 'protectionBaseline', 'searchUrlTemplate', 'sendGpc', 'stripCopiedLinks', 'stripTrackingParams'].sort())
    expect(view.entities['setting']?.['httpsUpgrade']).toEqual({ value: state.settings.httpsUpgrade })
  })
})

describe('snapshotOf', () => {
  const state = stateOf({
    spaces: [{ id: 's1' }, { id: 'locked', name: 'Secret' }],
    folders: [{ id: 'f1', spaceId: 's1' }, { id: 'f-locked', spaceId: 'locked' }],
    tabs: [{ id: 't1', spaceId: 's1', anchorUrl: 'https://a.example/' }, { id: 't-locked', spaceId: 'locked' }],
    favorites: [{ id: 'fav1' }]
  })

  it('sends only the categories asked for', () => {
    expect(Object.keys(snap(state, { categories: new Set(['structure']) }).entities).sort()).toEqual(['favorite', 'folder', 'space', 'tab'])
    expect(Object.keys(snap(state, { categories: new Set(['settings']) }).entities)).toEqual(['setting'])
    expect(Object.keys(snap(state, { categories: new Set() }).entities)).toEqual([])
    expect(Object.keys(snap(state, { categories: new Set(['openTabs']) }).entities)).toEqual([])
  })

  it('takes nothing of a space set aside: neither it, nor what it holds, nor its lists', () => {
    const sent = snap(state, { withheld: ['locked'] })
    expect(Object.keys(sent.entities['space'] ?? {})).toEqual(['s1'])
    expect(Object.keys(sent.entities['folder'] ?? {})).toEqual(['f1'])
    expect(Object.keys(sent.entities['tab'] ?? {})).toEqual(['t1'])
    expect(JSON.stringify(sent)).not.toMatch(/locked|Secret/)
    expect(Object.keys(sent.order).every((key) => !key.includes('locked'))).toBe(true)
  })

  it('carries a mark for every field, and the mark of the list for every list', () => {
    const sent = snap(state)
    for (const byId of Object.values(sent.entities)) for (const entity of Object.values(byId)) for (const name of Object.keys(entity.fields)) expect(entity.stamps[name], name).toMatch(/^\d{13}-[0-9a-f]{4}-mac$/)
    for (const key of Object.keys(sent.order)) expect(sent.orderStamps[key], key).toMatch(/^\d{13}-/)
  })

  it('sends the seed fields with an entity the other device does not have, and not with one it has (it holds them since)', () => {
    const base: SyncSnapshot = { entities: { tab: { t1: { fields: { pinned: true }, stamps: { pinned: '1' } } } }, tombstones: {}, order: {}, orderStamps: {} }
    const fresh = snap(state, { base: null })
    expect(fresh.entities['tab']?.['t1']?.fields).toMatchObject({ url: 'https://t1.example/', title: 't1' })
    expect(fresh.entities['folder']?.['f1']?.fields).toHaveProperty('collapsed')
    const known = snap(state, { base })
    expect(known.entities['tab']?.['t1']?.fields).not.toHaveProperty('url')
    expect(known.entities['tab']?.['t-locked']?.fields).toHaveProperty('url')
  })

  it('marks a seed field with the earliest mark of its entity', () => {
    const tab = snap(state).entities['tab']?.['t1']
    const marks = Object.entries(tab?.stamps ?? {}).filter(([name]) => name !== 'url' && name !== 'title').map(([, mark]) => mark)
    expect(tab?.stamps['url']).toBe([...marks].sort()[0])
  })

  it('sends the tombstones of the kinds it sends, and those of kinds it does not know', () => {
    const marks = new MarkBook('mac')
    marks.update(trackedViewOf(state), NOW)
    marks.update(trackedViewOf(stateOf({ spaces: [{ id: 's1' }] })), NOW + 1000)
    const sent = snapshotOf(stateOf({ spaces: [{ id: 's1' }] }), marks, { categories: new Set(['structure']), withheld: new Set(), base: null })
    expect(Object.keys(sent.tombstones).sort()).toEqual(['favorite', 'folder', 'space', 'tab'])
    const none = snapshotOf(stateOf({ spaces: [{ id: 's1' }] }), marks, { categories: new Set(['settings']), withheld: new Set(), base: null })
    expect(none.tombstones).toEqual({})
  })

  it('sends the archive by the latest five hundred of each space, in the category that asks for it only', () => {
    const archive = Array.from({ length: 520 }, (_, n) => ({ id: `a${String(n).padStart(3, '0')}`, spaceId: 's1', url: `https://a${n}.example/`, title: 'x', archivedAt: n }))
    const big = { ...stateOf({ spaces: [{ id: 's1' }] }), archive }
    const sent = snap(big, { categories: new Set(['archive']) })
    expect(Object.keys(sent.entities['archived'] ?? {})).toHaveLength(500)
    expect(sent.entities['archived']?.['a519']).toBeDefined()
    expect(sent.entities['archived']?.['a019']).toBeUndefined()
    expect(sent.entities['archived']?.['a020']).toBeDefined()
    expect(Object.keys(snap(big, { categories: new Set(['structure']) }).entities)).not.toContain('archived')
  })
})

describe('what the book follows, and the base', () => {
  it('follows the synchronised and the unknown fields, never the seeds, the local fields or the identifier', () => {
    expect(follows('tab', 'anchorUrl')).toBe(true)
    expect(follows('tab', 'aFieldOfALaterVersion')).toBe(true)
    for (const name of ['url', 'title', 'faviconUrl', 'lastActiveAt', 'id']) expect(follows('tab', name), name).toBe(false)
    expect(follows('space', 'image')).toBe(false)
    expect(follows('setting', 'value')).toBe(true)
    expect(follows('setting', 'other')).toBe(false)
    expect(follows('widget', 'anything')).toBe(true)
  })

  it('strips the seed fields from a base, with their marks, and changes nothing it was given', () => {
    const merged: SyncSnapshot = { entities: { tab: { t1: { fields: { pinned: true, url: 'https://x.example/', title: 'X' }, stamps: { pinned: '1', url: '1', title: '1' } } } }, tombstones: { tab: { t9: '2' } }, order: { 'tabs:s:-': ['t1'] }, orderStamps: { 'tabs:s:-': '3' } }
    const before = JSON.stringify(merged)
    const base = baseOf(merged)
    expect(base.entities['tab']?.['t1']).toEqual({ fields: { pinned: true }, stamps: { pinned: '1' } })
    expect(base.tombstones).toEqual(merged.tombstones)
    expect(base.order).toEqual(merged.order)
    expect(JSON.stringify(merged)).toBe(before)
  })

  it('names the spaces a session sets aside: the locked ones', () => {
    const state = stateOf({ spaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    expect(withheldSpaces(state, (id) => id !== 'a')).toEqual(['b', 'c'])
    expect(withheldSpaces(state, () => false)).toEqual([])
  })
})

describe('openTabsOf (§10.4)', () => {
  const state = stateOf({
    spaces: [{ id: 's1' }, { id: 'locked' }],
    tabs: [
      { id: 'a', spaceId: 's1', pinned: false, url: 'https://a.example/', title: 'A', lastActiveAt: 5 },
      { id: 'b', spaceId: 's1', pinned: false, url: 'https://b.example/', title: 'B', lastActiveAt: 9 },
      { id: 'private', spaceId: 's1', private: true, url: 'https://p.example/' },
      { id: 'file', spaceId: 's1', pinned: false, url: 'file:///etc/passwd' },
      { id: 'hidden', spaceId: 'locked', pinned: false, url: 'https://h.example/' }
    ]
  })

  it('lists web pages only, the latest first, never a private tab nor a tab of a locked space', () => {
    expect(openTabsOf(state, (id) => id === 'locked').map((tab) => tab.id)).toEqual(['b', 'a'])
  })

  it('writes what the message allows: the address up to 4096 bytes, the title up to 300 characters, the time as a whole number', () => {
    const long = { ...state, tabs: [{ ...state.tabs[0]!, url: `https://x.example/${'a'.repeat(5000)}`, title: 'T'.repeat(400), lastActiveAt: 7.9 }] }
    const [tab] = openTabsOf(long, () => false)
    expect(tab?.url.length).toBe(4096)
    expect(tab?.title.length).toBe(300)
    expect(tab?.lastActiveAt).toBe(7)
  })

  it('announces at most two hundred', () => {
    const many = { ...state, tabs: Array.from({ length: 300 }, (_, n) => ({ ...state.tabs[0]!, id: `t${n}`, lastActiveAt: n })) }
    expect(openTabsOf(many, () => false)).toHaveLength(200)
  })
})
