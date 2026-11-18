// What an entity that comes in may carry (docs/synchronisation.md §8.5, §10): the vectors of the specification, and what they do not say.
import { describe, expect, it } from 'vitest'
import { SEARCH_ENGINES } from '@shared/model'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { cleanSnapshot, filterEntity, isKnownSearchTemplate, isWebAddress } from './inbound-filter'
import { STAMP_FUTURE_REFUSE_MS } from './limits'
import { messageVectors } from './sync-vectors.test-support'

describe('filterEntity: the vectors of the specification', () => {
  it.each(messageVectors.inbound)('$name', ({ entity, expect: expected }) => {
    const result = filterEntity(entity)
    expect(result.accepted).toBe(expected.accepted)
    if (!result.accepted) expect(result.reason).toBe(expected.reason)
    if (result.accepted && expected.fields !== undefined) expect(result.fields).toEqual(expected.fields)
  })

  it('tries each refusal reason of the vectors at least once, so that a missing guard has a vector to fail', () => {
    const reasons = new Set(messageVectors.inbound.flatMap((v) => (v.expect.accepted ? [] : [v.expect.reason])))
    for (const reason of ['never-synced', 'not-synced', 'invalid-value', 'not-pinned', 'private', 'invalid-url']) expect(reasons.has(reason as string), reason).toBe(true)
  })
})

describe('filterEntity: what the vectors do not say', () => {
  const setting = (id: string, value: unknown) => filterEntity({ kind: 'setting', id, fields: { value } })

  it('refuses every kind of code and every secret by name', () => {
    for (const kind of ['boost', 'userScript', 'extension', 'password', 'vault', 'lock', 'history', 'cookie', 'session']) expect(filterEntity({ kind, id: 'x', fields: {} })).toEqual({ accepted: false, reason: 'never-synced' })
  })

  it('refuses a setting outside the closed list, whatever its value: the lock, the network, the updates', () => {
    for (const key of ['lockEnabled', 'lockApp', 'proxyEnabled', 'proxy', 'dohCustomUrl', 'updateFeedUrl', 'customFilterLists', 'extensionPaths', 'passwordManager', 'boostsEnabled', 'userScripts', '__proto__', '']) expect(setting(key, true), key).toEqual({ accepted: false, reason: 'not-synced' })
  })

  it.each([
    ['httpsUpgrade', 'true'],
    ['sendGpc', 1],
    ['protectionBaseline', 'extreme'],
    ['autoArchiveHours', -1],
    ['autoArchiveHours', Number.POSITIVE_INFINITY],
    ['autoArchiveHours', 24 * 366 + 1],
    ['autoArchiveHours', '12'],
    ['searchUrlTemplate', 'https://example.com/search'],
    ['searchUrlTemplate', 'javascript:alert(%s)'],
    ['searchUrlTemplate', `https://example.com/?q=%s${'x'.repeat(2100)}`],
    // An engine of one's own, a known engine in clear http, a known engine with something after it: none is one Lucium offers (§10.3, n° 10 of the review).
    ['searchUrlTemplate', 'https://example.com/?q=%s'],
    ['searchUrlTemplate', 'http://duckduckgo.com/?q=%s'],
    ['searchUrlTemplate', 'https://duckduckgo.com/?q=%s&x=1'],
    ['searchUrlTemplate', ' https://duckduckgo.com/?q=%s'],
    ['profileNames', 'x'],
    ['profileNames', { work: 3 }],
    ['profileNames', { 'bad id!': 'x' }],
    ['profileNames', { work: 'x'.repeat(41) }],
    ['profileNames', Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`p${n}`, 'x']))]
  ])('refuses %s with the value %j', (key, value) => {
    expect(setting(key, value)).toEqual({ accepted: false, reason: 'invalid-value' })
  })

  it.each([
    ['httpsUpgrade', false],
    ['protectionBaseline', 'renforcee'],
    ['autoArchiveHours', 0],
    ['autoArchiveHours', 24 * 366],
    ['searchUrlTemplate', 'https://duckduckgo.com/?q=%s'],
    ['profileNames', { work: 'Travail', perso: 'Perso' }]
  ])('accepts %s with the value %j', (key, value) => {
    expect(setting(key, value)).toEqual({ accepted: true, fields: { value } })
  })

  it('accepts every engine of the list the Mac offers, and only those (the vectors list the same ones)', () => {
    expect(messageVectors.searchEngines).toEqual(SEARCH_ENGINES.map((engine) => engine.url))
    for (const engine of SEARCH_ENGINES) {
      expect(engine.url.startsWith('https://'), engine.name).toBe(true)
      expect(setting('searchUrlTemplate', engine.url), engine.name).toEqual({ accepted: true, fields: { value: engine.url } })
      expect(isKnownSearchTemplate(engine.url), engine.name).toBe(true)
    }
    expect(isKnownSearchTemplate(undefined)).toBe(false)
  })

  it('keeps only the value of a setting, and no other field it carries', () => {
    expect(filterEntity({ kind: 'setting', id: 'sendGpc', fields: { value: true, extra: 'x' } })).toEqual({ accepted: true, fields: { value: true } })
  })

  it('accepts only http and https addresses, in every field that holds one', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'about:blank', 'chrome://settings', 'ftp://x', 'https://', 'https:// bad', '//example.com', 5, null]) {
      expect(isWebAddress(bad), String(bad)).toBe(false)
      expect(filterEntity({ kind: 'favorite', id: 'f', fields: { url: bad } }), String(bad)).toEqual({ accepted: false, reason: 'invalid-url' })
      expect(filterEntity({ kind: 'tab', id: 't', fields: { pinned: true, anchorUrl: bad } }), String(bad)).toEqual({ accepted: false, reason: 'invalid-url' })
      expect(filterEntity({ kind: 'archived', id: 'a', fields: { url: bad } }), String(bad)).toEqual({ accepted: false, reason: 'invalid-url' })
    }
    expect(filterEntity({ kind: 'tab', id: 't', fields: { pinned: true, url: 'javascript:1' } })).toEqual({ accepted: false, reason: 'invalid-url' })
    for (const good of ['http://example.com', 'HTTPS://Example.com/a?b=c#d']) expect(isWebAddress(good), good).toBe(true)
  })

  it('takes off every local field of every kind, and keeps the synchronised and the unknown ones', () => {
    const spaceFields = { name: 'Perso', image: 'x.png', background: { kind: 'video' }, webPanels: [], futureField: [1] }
    expect(filterEntity({ kind: 'space', id: 's', fields: spaceFields })).toEqual({ accepted: true, fields: { name: 'Perso', futureField: [1] } })
    expect(filterEntity({ kind: 'folder', id: 'f', fields: { name: 'A', live: { url: 'https://x' }, collapsed: true } })).toEqual({ accepted: true, fields: { name: 'A', collapsed: true } })
    expect(filterEntity({ kind: 'archived', id: 'a', fields: { url: 'https://x', history: { entries: [] }, container: 'c1' } })).toEqual({ accepted: true, fields: { url: 'https://x' } })
  })

  it('lets a kind this version does not know cross as it is', () => {
    expect(filterEntity({ kind: 'widget', id: 'w', fields: { a: [1, { b: 2 }] } })).toEqual({ accepted: true, fields: { a: [1, { b: 2 }] } })
  })
})

describe('cleanSnapshot', () => {
  const mark = (ms: number): string => `${String(ms).padStart(13, '0')}-0000-phone`
  const NOW = 1_790_000_000_000
  const entity = (fields: Record<string, unknown>, stampMs = NOW - 1000): { fields: never; stamps: Record<string, string> } => ({ fields: fields as never, stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, mark(stampMs)])) })
  const snapshot = (entities: SyncSnapshot['entities']): SyncSnapshot => ({ entities, tombstones: {}, order: {}, orderStamps: {} })

  it('drops the refused entities, lists them with their reason, and keeps the others', () => {
    const { snapshot: cleaned, refused } = cleanSnapshot(
      snapshot({ space: { s1: entity({ name: 'Perso' }) }, tab: { t1: entity({ pinned: true, url: 'javascript:1' }), t2: entity({ pinned: false }), t3: entity({ pinned: true, anchorUrl: 'https://a.example/' }) }, boost: { b1: entity({ code: 'x' }) } }),
      NOW
    )
    expect(Object.keys(cleaned.entities['tab'] ?? {})).toEqual(['t3'])
    expect(cleaned.entities['boost']).toBeUndefined()
    expect(refused).toEqual(expect.arrayContaining([{ kind: 'tab', id: 't1', reason: 'invalid-url' }, { kind: 'tab', id: 't2', reason: 'not-pinned' }, { kind: 'boost', id: 'b1', reason: 'never-synced' }]))
    expect(refused).toHaveLength(3)
  })

  it('takes the marks of the local fields off with the fields', () => {
    const { snapshot: cleaned } = cleanSnapshot(snapshot({ space: { s1: entity({ name: 'Perso', image: 'x.png' }) } }), NOW)
    expect(cleaned.entities['space']?.['s1']?.fields).toEqual({ name: 'Perso' })
    expect(Object.keys(cleaned.entities['space']?.['s1']?.stamps ?? {})).toEqual(['name'])
  })

  it('refuses an entity with a mark more than seven days ahead of this clock, and keeps one that is exactly seven days ahead', () => {
    const ahead = cleanSnapshot(snapshot({ space: { s1: entity({ name: 'A' }, NOW + STAMP_FUTURE_REFUSE_MS + 1), s2: entity({ name: 'B' }, NOW + STAMP_FUTURE_REFUSE_MS) } }), NOW)
    expect(Object.keys(ahead.snapshot.entities['space'] ?? {})).toEqual(['s2'])
    expect(ahead.refused).toEqual([{ kind: 'space', id: 's1', reason: 'future-mark' }])
  })

  it('refuses a tombstone, and a list with its mark of order, whose mark is more than seven days ahead, and keeps the ones exactly seven days ahead', () => {
    const ahead = NOW + STAMP_FUTURE_REFUSE_MS
    const input: SyncSnapshot = {
      entities: {},
      tombstones: { tab: { late: mark(ahead + 1), edge: mark(ahead) }, folder: { gone: mark(ahead + 1) } },
      order: { spaces: ['a'], 'tabs:s:-': ['t'], 'favorites:default': ['f'] },
      orderStamps: { spaces: mark(ahead + 1), 'tabs:s:-': mark(NOW), 'favorites:default': mark(ahead), 'folders:s:-': mark(ahead + 1), 'folders:s:p': mark(NOW) }
    }
    const { snapshot: cleaned, refused } = cleanSnapshot(input, NOW)
    expect(cleaned.tombstones).toEqual({ tab: { edge: mark(ahead) } })
    expect(cleaned.order).toEqual({ 'tabs:s:-': ['t'], 'favorites:default': ['f'] })
    expect(cleaned.orderStamps).toEqual({ 'tabs:s:-': mark(NOW), 'favorites:default': mark(ahead), 'folders:s:p': mark(NOW) })
    expect(refused).toEqual([
      { kind: 'tombstone', id: 'tab/late', reason: 'future-mark' },
      { kind: 'tombstone', id: 'folder/gone', reason: 'future-mark' },
      { kind: 'order', id: 'spaces', reason: 'future-mark' }
    ])
  })

  it('gives back the version of the base for an entity refused for its marks, its address or its value, and drops one refused for what it is, or one the base never held', () => {
    const ahead = NOW + STAMP_FUTURE_REFUSE_MS + 1
    const kept = entity({ name: 'Old' }, NOW - 5000)
    const base: SyncSnapshot = { entities: { space: { s1: kept, s2: kept }, tab: { t1: entity({ pinned: true, anchorUrl: 'https://a.example/' }), t2: entity({ pinned: true }), t3: entity({ pinned: true }) }, setting: { sendGpc: entity({ value: true }) } }, tombstones: {}, order: {}, orderStamps: {} }
    const input = snapshot({
      space: { s1: entity({ name: 'New' }, ahead), s2: entity({ name: 'Fine' }), s9: entity({ name: 'Never held' }, ahead) },
      tab: { t1: entity({ pinned: true, anchorUrl: 'javascript:1' }), t2: entity({ pinned: false }), t3: entity({ pinned: true, private: true }) },
      setting: { sendGpc: entity({ value: 'yes' }) }
    })
    const { snapshot: cleaned, refused } = cleanSnapshot(input, NOW, base)
    expect(cleaned.entities['space']).toEqual({ s1: kept, s2: entity({ name: 'Fine' }) })
    expect(Object.keys(cleaned.entities['tab'] ?? {})).toEqual(['t1'])
    expect(cleaned.entities['tab']?.['t1']).toBe(base.entities['tab']?.['t1'])
    expect(cleaned.entities['setting']).toEqual({ sendGpc: base.entities['setting']?.['sendGpc'] })
    expect(refused.map((one) => `${one.kind}/${one.id}:${one.reason}`)).toEqual(['space/s1:future-mark', 'space/s9:future-mark', 'tab/t1:invalid-url', 'tab/t2:not-pinned', 'tab/t3:private', 'setting/sendGpc:invalid-value'])
    expect(Object.keys(cleanSnapshot(input, NOW).snapshot.entities['space'] ?? {})).toEqual(['s2'])
  })

  it('does not look at the mark « zéro » as a time', () => {
    const zero = { fields: { name: 'A' }, stamps: { name: '0' } } as never
    expect(cleanSnapshot(snapshot({ space: { s1: zero } }), NOW).refused).toEqual([])
  })

  it('leaves the tombstones, the orders and what the entities are made of to the merge, and changes nothing it was given', () => {
    const input: SyncSnapshot = { entities: { space: { s1: entity({ name: 'A', image: 'x' }) } }, tombstones: { tab: { t9: mark(NOW) } }, order: { spaces: ['s1'] }, orderStamps: { spaces: mark(NOW) } }
    const before = JSON.stringify(input)
    const { snapshot: cleaned } = cleanSnapshot(input, NOW)
    expect(JSON.stringify(input)).toBe(before)
    expect(cleaned.tombstones).toEqual(input.tombstones)
    expect(cleaned.order).toEqual(input.order)
  })
})
