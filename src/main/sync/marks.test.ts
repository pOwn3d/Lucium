// The marks (docs/synchronisation.md §9.2, §11.5): the hybrid clock, and the book that gives a mark to what changes.
import { describe, expect, it } from 'vitest'
import { compareStamps } from '@shared/sync-snapshot'
import { STAMP_FUTURE_REFUSE_MS } from './limits'
import { Hlc, MarkBook, listKindOf, type TrackedView } from './marks'
import { messageVectors } from './sync-vectors.test-support'

const NOW = 1_790_000_000_000
const view = (entities: TrackedView['entities'], order: TrackedView['order'] = {}): TrackedView => ({ entities, order })

describe('Hlc', () => {
  it('writes a mark of thirteen digits, four hexadecimal digits and the device, that the vectors read', () => {
    const mark = new Hlc('mac-1').next(NOW)
    expect(mark).toBe('1790000000000-0000-mac-1')
    for (const v of messageVectors.stamps) expect(compareStamps(v.a, v.b)).toBe(v.expect)
  })

  it('counts the marks of one millisecond, and starts over when the time moves on', () => {
    const clock = new Hlc('d')
    expect([clock.next(NOW), clock.next(NOW), clock.next(NOW)]).toEqual(['1790000000000-0000-d', '1790000000000-0001-d', '1790000000000-0002-d'])
    expect(clock.next(NOW + 5)).toBe('1790000000005-0000-d')
  })

  it('never goes back when the time of day does (a clock put back): it counts on from the last mark', () => {
    const clock = new Hlc('d')
    clock.next(NOW)
    expect(clock.next(NOW - 60_000)).toBe('1790000000000-0001-d')
  })

  it('moves to the next millisecond when the counter is full', () => {
    const clock = new Hlc('d', { ms: NOW, counter: 0xffff })
    expect(clock.next(NOW)).toBe('1790000000001-0000-d')
  })

  it('is never behind a mark it has seen: what the person does next is later than what the other device did before', () => {
    const clock = new Hlc('mac')
    clock.observe('1790000500000-0003-phone')
    expect(compareStamps(clock.next(NOW), '1790000500000-0003-phone')).toBeGreaterThan(0)
    // A mark of the past or a text that is not a mark changes nothing.
    clock.observe('1700000000000-0000-phone')
    clock.observe('garbage')
    clock.observe('0')
    expect(clock.state()).toEqual({ ms: 1790000500000, counter: 4 })
  })
})

describe('Hlc: a clock that was wrong comes back (review n° 18)', () => {
  const YEAR = 365 * 86_400_000

  it('does not stay ahead for ever after the time of day was wrong: more than a week ahead of it, the next mark is of now', () => {
    const clock = new Hlc('d')
    clock.next(NOW + 3 * YEAR)
    // The time of day was put right: the marks follow it, they are not three years ahead for good (every other device refuses them, §9.3).
    expect(clock.next(NOW)).toBe('1790000000000-0000-d')
    expect(clock.next(NOW)).toBe('1790000000000-0001-d')
  })

  it('still counts on from a clock that is only a little ahead (a few minutes: the usual skew), as a clock put back does', () => {
    const clock = new Hlc('d')
    clock.next(NOW + 60_000)
    expect(clock.next(NOW)).toBe('1790000060000-0001-d')
    const edge = new Hlc('e')
    edge.next(NOW + STAMP_FUTURE_REFUSE_MS)
    expect(edge.next(NOW)).toBe(`${String(NOW + STAMP_FUTURE_REFUSE_MS).padStart(13, '0')}-0001-e`)
  })

  it('never writes a mark of more than thirteen digits: a clock at the end of what thirteen digits hold starts over from the time of day', () => {
    const full = new Hlc('d', { ms: 9_999_999_999_999, counter: 0xffff })
    expect(full.next(NOW)).toBe('1790000000000-0000-d')
    const poisoned = new Hlc('d', { ms: 99_999_999_999_999, counter: 3 })
    expect(poisoned.next(NOW)).toMatch(/^[0-9]{13}-[0-9a-f]{4}-d$/)
  })
})

describe('Hlc: a clock that goes back is not a clock that was wrong (review n° 35)', () => {
  const DAY = 86_400_000
  const peerMark = (ms: number): string => `${String(ms).padStart(13, '0')}-0000-iphone-1`

  it('does not take the marks back with a time of day that went back by more than a week, once the other device has shown the time it is at', () => {
    const clock = new Hlc('mac')
    clock.next(NOW)
    clock.observe(peerMark(NOW))
    // The time of day is put back by thirty days: the marks of this device stay where they were, and go on after them. Before, they restarted from the time of day and lost
    // every conflict against what the iPhone had changed in between.
    const next = clock.next(NOW - 30 * DAY)
    expect(compareStamps(next, '1790000000000-0000-mac')).toBeGreaterThan(0)
    expect(next.slice(0, 13)).toBe(String(NOW))
  })

  it('still starts over from the time of day when the marks are ahead of the time of day AND of the other device: a clock that was wrong (review n° 18)', () => {
    const clock = new Hlc('mac')
    clock.observe(peerMark(NOW))
    clock.next(NOW + 3 * 365 * DAY)
    expect(clock.next(NOW)).toBe('1790000000000-0000-mac')
  })

  it('does not count a mark of its own as a mark of the other device, and a mark that is not one at all counts for nothing', () => {
    const clock = new Hlc('mac')
    clock.observe('1790000000000-0003-mac')
    clock.observe('not a mark')
    expect(clock.peerSeen()).toBe(0)
    clock.observe(peerMark(NOW - 5))
    expect(clock.peerSeen()).toBe(NOW - 5)
    clock.observe(peerMark(NOW - 10))
    expect(clock.peerSeen()).toBe(NOW - 5)
  })

  it('does not redo the marks of a book either: its fields keep the marks they had when the time of day goes back, and are still redone when it was the marks that were wrong', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' } } }), NOW)
    const before = book.stampsOf('space', 's1')['name']
    book.clock.observe(peerMark(NOW))
    book.update(view({ space: { s1: { name: 'A' } } }), NOW - 30 * DAY)
    expect(book.stampsOf('space', 's1')['name']).toBe(before)
    // The same book without the other device's word: the marks look like a clock that was wrong, and are made again (review n° 18).
    const alone = new MarkBook('mac')
    alone.update(view({ space: { s1: { name: 'A' } } }), NOW)
    alone.update(view({ space: { s1: { name: 'A' } } }), NOW - 30 * DAY)
    expect(alone.stampsOf('space', 's1')['name']).not.toBe(before)
    expect(alone.stampsOf('space', 's1')['name']?.slice(0, 13)).toBe(String(NOW - 30 * DAY))
  })

  it('is kept with the clock in the file, and a file without it is read as having none', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' } } }), NOW)
    expect(book.toJSON().clock).not.toHaveProperty('peer')
    book.clock.observe(peerMark(NOW - 1_000))
    const again = new MarkBook('mac', JSON.parse(JSON.stringify(book)) as never)
    expect(again.clock.peerSeen()).toBe(NOW - 1_000)
    expect(again.toJSON()).toEqual(book.toJSON())
    const spoilt = JSON.parse(JSON.stringify(book)) as { clock: { peer: unknown } }
    spoilt.clock.peer = 'later'
    expect(new MarkBook('mac', spoilt as never).clock.peerSeen()).toBe(0)
    spoilt.clock.peer = -5
    expect(new MarkBook('mac', spoilt as never).clock.peerSeen()).toBe(0)
  })
})

describe('MarkBook.update: marks that are too far ahead are made again (review n° 18)', () => {
  const FAR = NOW + 3 * 365 * 86_400_000

  it('gives a fresh mark to a field, a removed field, a tombstone and a list whose mark is more than a week ahead, and leaves the others alone', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A', gone: 1 }, s2: { name: 'B' } }, tab: { t1: { pinned: true } } }, { spaces: ['s1', 's2'] }), FAR)
    book.update(view({ space: { s1: { name: 'A' }, s2: { name: 'B' } }, tab: {} }, { spaces: ['s1', 's2'] }), FAR)
    expect(compareStamps(book.stampsOf('space', 's1')['name'] as string, `${NOW + STAMP_FUTURE_REFUSE_MS}`)).toBeGreaterThan(0)
    // The clock comes back to the true time: every mark that is out of reach is made again, by the same call that notices it.
    const unchanged = view({ space: { s1: { name: 'A' }, s2: { name: 'B' } }, tab: {} }, { spaces: ['s1', 's2'] })
    book.update(unchanged, NOW)
    const limit = `${NOW + STAMP_FUTURE_REFUSE_MS}`
    for (const stamp of [...Object.values(book.stampsOf('space', 's1')), ...Object.values(book.stampsOf('space', 's2')), book.orderStampOf('spaces'), ...Object.values(book.tombstonesOf()['tab'] ?? {})]) {
      expect(compareStamps(stamp, limit), stamp).toBeLessThanOrEqual(0)
      expect(stamp.slice(0, 13).length).toBe(13)
    }
    expect(Object.keys(book.tombstonesOf()['tab'] ?? {})).toEqual(['t1'])
    expect(compareStamps(book.clock.next(NOW), limit)).toBeLessThanOrEqual(0)
  })

  it('does not touch a mark that is merely a few minutes ahead, nor change the marks of a book that is in order', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' } } }, { spaces: ['s1'] }), NOW + 120_000)
    const before = JSON.stringify(book)
    book.update(view({ space: { s1: { name: 'A' } } }, { spaces: ['s1'] }), NOW)
    expect(JSON.stringify(book)).toBe(before)
  })
})

describe('MarkBook.update', () => {
  it('gives a mark to every field of a new entity, and none again while nothing changes', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'Perso', emoji: '🏠' } } }), NOW)
    const first = book.stampsOf('space', 's1')
    expect(Object.keys(first).sort()).toEqual(['emoji', 'name'])
    book.update(view({ space: { s1: { name: 'Perso', emoji: '🏠' } } }), NOW + 10_000)
    expect(book.stampsOf('space', 's1')).toEqual(first)
  })

  it('marks only the field that changed, with a later mark', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A', emoji: '🏠' } } }), NOW)
    const before = book.stampsOf('space', 's1')
    book.update(view({ space: { s1: { name: 'B', emoji: '🏠' } } }), NOW + 5000)
    const after = book.stampsOf('space', 's1')
    expect(after['emoji']).toBe(before['emoji'])
    expect(compareStamps(after['name'] as string, before['name'] as string)).toBeGreaterThan(0)
  })

  it('compares values by what they hold, not by the object: a theme read again is not a change', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { theme: { hue: 200, noise: 0.1 } } } }), NOW)
    const before = book.stampsOf('space', 's1')
    book.update(view({ space: { s1: { theme: { noise: 0.1, hue: 200 } } } }), NOW + 9000)
    expect(book.stampsOf('space', 's1')).toEqual(before)
  })

  it('keeps a mark for a field that went (a removal is a change), and marks it once', () => {
    const book = new MarkBook('mac')
    book.update(view({ tab: { t1: { anchorUrl: 'https://a.example/', pinned: true } } }), NOW)
    book.update(view({ tab: { t1: { pinned: true } } }), NOW + 1000)
    const gone = book.stampsOf('tab', 't1')['anchorUrl'] as string
    expect(gone).toBeDefined()
    book.update(view({ tab: { t1: { pinned: true } } }), NOW + 2000)
    expect(book.stampsOf('tab', 't1')['anchorUrl']).toBe(gone)
  })

  it('leaves a tombstone for an entity that went, forgets its fields, and removes the tombstone if it comes back', () => {
    const book = new MarkBook('mac')
    book.update(view({ folder: { f1: { name: 'A' } } }), NOW)
    book.update(view({ folder: {} }), NOW + 1000)
    expect(book.tombstonesOf()).toEqual({ folder: { f1: '1790000001000-0000-mac' } })
    expect(book.stampsOf('folder', 'f1')).toEqual({})
    book.update(view({ folder: { f1: { name: 'A' } } }), NOW + 2000)
    expect(book.tombstonesOf()).toEqual({})
  })

  it('does not leave a tombstone for an entity it never saw with a field', () => {
    const book = new MarkBook('mac')
    book.update(view({ folder: { f1: {} } }), NOW)
    book.update(view({ folder: {} }), NOW + 1000)
    expect(book.tombstonesOf()).toEqual({})
  })

  it('forgets the tombstones after thirty days, and keeps them just before', () => {
    const book = new MarkBook('mac')
    book.update(view({ tab: { t1: { pinned: true } } }), NOW)
    book.update(view({ tab: {} }), NOW)
    book.purge(NOW + 30 * 86_400_000 - 1)
    expect(Object.keys(book.tombstonesOf())).toEqual(['tab'])
    book.purge(NOW + 30 * 86_400_000 + 1)
    expect(book.tombstonesOf()).toEqual({})
  })

  it('marks a list when its order changes, and only then; a list that goes is forgotten', () => {
    const book = new MarkBook('mac')
    book.update(view({}, { spaces: ['a', 'b'] }), NOW)
    const first = book.orderStampOf('spaces')
    book.update(view({}, { spaces: ['a', 'b'] }), NOW + 5000)
    expect(book.orderStampOf('spaces')).toBe(first)
    book.update(view({}, { spaces: ['b', 'a'] }), NOW + 6000)
    expect(compareStamps(book.orderStampOf('spaces'), first)).toBeGreaterThan(0)
    book.update(view({}, {}), NOW + 7000)
    expect(book.orderStampOf('spaces')).toBe('0')
  })

  it('gives the mark « zéro » to what it does not know', () => {
    expect(new MarkBook('mac').orderStampOf('nothing')).toBe('0')
    expect(new MarkBook('mac').stampsOf('space', 'nothing')).toEqual({})
  })
})

describe('MarkBook.adopt', () => {
  const follows = (_kind: string, field: string): boolean => field !== 'url'

  it('takes the marks of the merged snapshot, so that what came from the other device is not marked again as a change of this one', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'Mine' } } }), NOW)
    const theirs = '1790000900000-0000-phone'
    book.adopt({ entities: { space: { s1: { fields: { name: 'Theirs' }, stamps: { name: theirs } } } }, tombstones: {}, order: {}, orderStamps: {} }, follows)
    expect(book.stampsOf('space', 's1')).toEqual({ name: theirs })
    book.update(view({ space: { s1: { name: 'Theirs' } } }), NOW + 60_000)
    expect(book.stampsOf('space', 's1')).toEqual({ name: theirs })
  })

  it('marks a change made after it, later than what it adopted', () => {
    const book = new MarkBook('mac')
    book.adopt({ entities: { space: { s1: { fields: { name: 'Theirs' }, stamps: { name: '1790000900000-0000-phone' } } } }, tombstones: {}, order: {}, orderStamps: {} }, follows)
    book.update(view({ space: { s1: { name: 'Mine again' } } }), NOW)
    expect(compareStamps(book.stampsOf('space', 's1')['name'] as string, '1790000900000-0000-phone')).toBeGreaterThan(0)
  })

  it('leaves out the fields it does not follow (the seeds), keeps the removed fields as removed, and adopts the tombstones and the orders', () => {
    const book = new MarkBook('mac')
    book.adopt(
      { entities: { tab: { t1: { fields: { pinned: true, url: 'https://x.example/' }, stamps: { pinned: '1790000000100-0000-phone', url: '1790000000100-0000-phone', anchorUrl: '1790000000200-0000-phone' } } } }, tombstones: { tab: { t9: '1790000000300-0000-phone' } }, order: { 'tabs:s:-': ['t1'] }, orderStamps: { 'tabs:s:-': '1790000000400-0000-phone' } },
      follows
    )
    expect(book.stampsOf('tab', 't1')).toEqual({ pinned: '1790000000100-0000-phone', anchorUrl: '1790000000200-0000-phone' })
    expect(book.tombstonesOf()).toEqual({ tab: { t9: '1790000000300-0000-phone' } })
    expect(book.orderStampOf('tabs:s:-')).toBe('1790000000400-0000-phone')
    // A removed field is not marked again.
    book.update(view({ tab: { t1: { pinned: true } } }, { 'tabs:s:-': ['t1'] }), NOW)
    expect(book.stampsOf('tab', 't1')['anchorUrl']).toBe('1790000000200-0000-phone')
  })

  it('moves the clock past every mark it adopted', () => {
    const book = new MarkBook('mac')
    book.adopt({ entities: {}, tombstones: { tab: { t9: '1790001000000-0007-phone' } }, order: {}, orderStamps: { spaces: '1790002000000-0001-phone' } }, follows)
    expect(compareStamps(book.clock.next(NOW), '1790002000000-0001-phone')).toBeGreaterThan(0)
  })
})

describe('MarkBook.adopt: only what was exchanged (review n° 17)', () => {
  const follows = (): boolean => true
  const exchanged = (kind: string): boolean => kind === 'space' || kind === 'folder' || kind === 'tab' || kind === 'favorite'
  const MARK = '1790000000500-0000-phone'

  it('keeps the marks, the tombstones and the orders of the kinds that were not exchanged: a session without « réglages » or « archive » must not forget them', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' } }, setting: { sendGpc: { value: true } }, archived: { a1: { url: 'https://x.example/' } } }, { spaces: ['s1'] }), NOW)
    book.update(view({ space: { s1: { name: 'A' } }, setting: { sendGpc: { value: true } }, archived: {} }, { spaces: ['s1'] }), NOW + 1000)
    const setting = book.stampsOf('setting', 'sendGpc')
    const tombstone = book.tombstonesOf()['archived']
    expect(tombstone).toBeDefined()
    // A session of the structure only: the merged snapshot has no settings and no archive in it.
    book.adopt({ entities: { space: { s1: { fields: { name: 'B' }, stamps: { name: MARK } } } }, tombstones: {}, order: { spaces: ['s1'] }, orderStamps: { spaces: MARK } }, follows, exchanged)
    expect(book.stampsOf('setting', 'sendGpc')).toEqual(setting)
    expect(book.tombstonesOf()['archived']).toEqual(tombstone)
    expect(book.stampsOf('space', 's1')).toEqual({ name: MARK })
    expect(book.orderStampOf('spaces')).toBe(MARK)
  })

  it('still replaces what was exchanged, tombstones and lists included, and takes a kind it does not know as exchanged', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' }, s2: { name: 'B' } }, tab: { t1: { pinned: true } } }, { spaces: ['s1', 's2'], 'tabs:s1:-': ['t1'] }), NOW)
    book.update(view({ space: { s1: { name: 'A' }, s2: { name: 'B' } }, tab: {} }, { spaces: ['s1', 's2'] }), NOW + 1000)
    book.adopt({ entities: { space: { s1: { fields: { name: 'A' }, stamps: { name: MARK } } }, widget: { w1: { fields: { x: 1 }, stamps: { x: MARK } } } }, tombstones: { widget: { w2: MARK } }, order: { spaces: ['s1'] }, orderStamps: { spaces: MARK } }, follows, exchanged)
    expect(Object.keys(book.stampsOf('space', 's2'))).toEqual([])
    expect(book.tombstonesOf()['tab']).toBeUndefined()
    expect(book.stampsOf('widget', 'w1')).toEqual({ x: MARK })
    expect(book.tombstonesOf()['widget']).toEqual({ w2: MARK })
    expect(book.orderStampOf('tabs:s1:-')).toBe('0')
  })

  it('knows which kind a list orders', () => {
    expect(['spaces', 'folders:s:-', 'tabs:s:f', 'favorites:work', 'archived', 'elsewhere'].map(listKindOf)).toEqual(['space', 'folder', 'tab', 'favorite', null, null])
  })
})

describe('MarkBook.toJSON', () => {
  it('is read back as the same book, with its clock', () => {
    const book = new MarkBook('mac')
    book.update(view({ space: { s1: { name: 'A' } } }, { spaces: ['s1'] }), NOW)
    book.update(view({ space: {} }, {}), NOW + 1000)
    const again = new MarkBook('mac', JSON.parse(JSON.stringify(book)) as never)
    expect(again.toJSON()).toEqual(book.toJSON())
    expect(compareStamps(again.clock.next(NOW), book.tombstonesOf()['space']?.['s1'] as string)).toBeGreaterThan(0)
  })

  it('holds hashes and marks, not what the person wrote', () => {
    const book = new MarkBook('mac')
    book.update(view({ tab: { t1: { customTitle: 'My bank statement', anchorUrl: 'https://bank.example/secret' } } }), NOW)
    expect(JSON.stringify(book)).not.toMatch(/bank|statement|secret/)
  })
})

describe('MarkBook: the Today tabs received from the other device (card 652, §27.4)', () => {
  const follows = (): boolean => true
  const MARK = '1790000000500-0000-phone'
  const today = (...ids: string[]): TrackedView['entities'] => ({ todayTab: Object.fromEntries(ids.map((id) => [id, { spaceId: 's1', activeAt: 1 }])) })
  const merged = (...ids: string[]): Parameters<MarkBook['adopt']>[0] => ({
    entities: { todayTab: Object.fromEntries(ids.map((id) => [id, { fields: { spaceId: 's1', activeAt: 1 }, stamps: { spaceId: MARK, activeAt: MARK } }])) },
    tombstones: {},
    order: {},
    orderStamps: {}
  })

  it('tells a tab it admitted itself from one that the merge brought in', () => {
    const book = new MarkBook('mac')
    book.update(view(today('mine')), NOW)
    book.adopt(merged('mine', 'theirs'), follows)
    expect(book.knows('todayTab', 'mine') && book.knows('todayTab', 'theirs')).toBe(true)
    expect(book.isAdopted('mine')).toBe(false)
    expect(book.isAdopted('theirs')).toBe(true)
  })

  it('keeps a tab adopted from one session to the next, and forgets it when the tab leaves the shared set', () => {
    const book = new MarkBook('mac')
    book.adopt(merged('theirs'), follows)
    book.adopt(merged('theirs'), follows)
    expect(book.isAdopted('theirs')).toBe(true)
    book.update(view(today()), NOW)
    expect(book.isAdopted('theirs')).toBe(false)
    // Back in the set by this device's own admission, it is not adopted any more.
    book.update(view(today('theirs')), NOW + 1000)
    expect(book.isAdopted('theirs')).toBe(false)
  })

  it('does not call adopted the tabs of a session that did not exchange the Today tabs', () => {
    const book = new MarkBook('mac')
    book.adopt(merged('theirs'), follows, (kind) => kind !== 'todayTab')
    expect(book.isAdopted('theirs')).toBe(false)
  })

  it('writes the adopted tabs next to the format 2, which an older reader ignores, and reads a book without them as one that admitted everything here', () => {
    const book = new MarkBook('mac')
    book.update(view(today('mine')), NOW)
    book.adopt(merged('mine', 'theirs'), follows)
    const file = book.toJSON()
    expect(file.version).toBe(2)
    expect(file.adopted).toEqual(['theirs'])
    expect(new MarkBook('mac', JSON.parse(JSON.stringify(file))).isAdopted('theirs')).toBe(true)
    const { adopted: _adopted, ...old } = file
    const read = new MarkBook('mac', JSON.parse(JSON.stringify(old)))
    expect(read.isAdopted('theirs')).toBe(false)
    expect(read.knows('todayTab', 'theirs')).toBe(true)
    expect(new MarkBook('mac').toJSON()).not.toHaveProperty('adopted')
  })

  it('does not keep an adopted id that the entities do not hold (a file edited by hand)', () => {
    const file = new MarkBook('mac').toJSON()
    expect(new MarkBook('mac', { ...file, adopted: ['ghost'] }).isAdopted('ghost')).toBe(false)
  })
})
