// The marks (docs/synchronisation.md §9.2, §11.5): the hybrid clock, and the book that gives a mark to what changes.
import { describe, expect, it } from 'vitest'
import { compareStamps } from '@shared/sync-snapshot'
import { Hlc, MarkBook, type TrackedView } from './marks'
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
