// The door a received snapshot goes through (sync-snapshot.ts, docs/synchronisation.md §8.3 and §7.1): the form is checked, hostile shapes are refused,
// and what comes out shares nothing with what came in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './sync-canonical'
import { cloneJson, emptySnapshot, parseSnapshot, SNAPSHOT_LIMITS } from './sync-snapshot'

const mark = '1790000000001-0000-mac'
const entity = (fields: Record<string, unknown>) => ({ fields, stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, mark])) })
const valid = () => ({ entities: { space: { s1: entity({ name: 'Travail' }) } }, tombstones: { tab: { t1: mark } }, order: { spaces: ['s1'] }, orderStamps: { spaces: mark } })
const problem = (value: unknown): string => {
  const read = parseSnapshot(value)
  if (!('problem' in read)) throw new Error('the snapshot was accepted')
  return read.problem
}

describe('sync snapshot: reading what was received', () => {
  it('accepts the form of the specification, and an empty one', () => {
    const read = parseSnapshot(valid())
    expect('snapshot' in read && read.snapshot).toEqual(valid())
    expect(parseSnapshot({})).toEqual({ snapshot: emptySnapshot() })
    expect(parseSnapshot(emptySnapshot())).toEqual({ snapshot: emptySnapshot() })
  })

  it('shares nothing with the input, and reads -0 as 0', () => {
    const input = { ...valid(), entities: { space: { s1: entity({ name: 'A', list: [{ n: -0 }] }) } } }
    const read = parseSnapshot(input)
    if (!('snapshot' in read)) throw new Error('refused')
    const fields = read.snapshot.entities['space']?.['s1']?.fields as { list: { n: number }[] }
    expect(Object.is(fields.list[0]?.n, 0)).toBe(true)
    fields.list.push({ n: 1 })
    ;(input.entities.space.s1.fields.list as unknown[]).push('x')
    expect(fields.list).toHaveLength(2)
    expect(read.snapshot.order['spaces']).not.toBe(input.order.spaces)
  })

  it('leaves out a member the form does not name (a newer version may add one) and drops a kind with nothing in it', () => {
    const read = parseSnapshot({ ...valid(), future: { a: 1 }, entities: { space: {}, tab: { t1: entity({ spaceId: 's1' }) } } })
    expect('snapshot' in read && Object.keys(read.snapshot)).toEqual(['entities', 'tombstones', 'order', 'orderStamps'])
    expect('snapshot' in read && Object.keys(read.snapshot.entities)).toEqual(['tab'])
  })

  it('refuses what is not an object, at each level', () => {
    for (const bad of [null, 1, 'x', [], true]) expect(problem(bad)).toMatch(/not an object/)
    expect(problem({ entities: [] })).toMatch(/entities/)
    expect(problem({ entities: { space: [] } })).toMatch(/entities\.space/)
    expect(problem({ entities: { space: { s1: 5 } } })).toMatch(/entities\.space\.s1/)
    expect(problem({ entities: { space: { s1: { fields: [], stamps: {} } } } })).toMatch(/fields and stamps/)
    expect(problem({ entities: { space: { s1: { fields: {} } } } })).toMatch(/fields and stamps/)
    expect(problem({ tombstones: [] })).toMatch(/tombstones/)
    expect(problem({ tombstones: { tab: [] } })).toMatch(/tombstones\.tab/)
    expect(problem({ order: [] })).toMatch(/order/)
    expect(problem({ order: { spaces: 'x' } })).toMatch(/order\.spaces/)
    expect(problem({ orderStamps: [] })).toMatch(/orderStamps/)
  })

  it('refuses a mark that is not in the form of §9.2, wherever a mark is', () => {
    expect(problem({ entities: { space: { s1: { fields: { a: 1 }, stamps: { a: 'yesterday' } } } } })).toMatch(/mark/)
    expect(problem({ tombstones: { tab: { t1: 5 } } })).toMatch(/mark/)
    expect(problem({ orderStamps: { spaces: '1790000000001-0000' } })).toMatch(/mark/)
  })

  it('refuses a __proto__ key at any depth, as a kind, an id, a field, a list, or inside a value (JSON.parse makes it an own key)', () => {
    expect(problem(JSON.parse('{"entities":{"__proto__":{}}}'))).toMatch(/bad name/)
    expect(problem(JSON.parse(`{"entities":{"space":{"__proto__":${JSON.stringify(entity({ a: 1 }))}}}}`))).toMatch(/bad name/)
    expect(problem(JSON.parse(`{"entities":{"space":{"s1":{"fields":{"__proto__":1},"stamps":{}}}}}`))).toMatch(/bad name/)
    expect(problem(JSON.parse(`{"entities":{"space":{"s1":{"fields":{"a":{"b":[{"__proto__":1}]}},"stamps":{}}}}}`))).toMatch(/__proto__/)
    expect(problem(JSON.parse(`{"order":{"__proto__":[]}}`))).toMatch(/bad key/)
    expect(problem(JSON.parse(`{"tombstones":{"tab":{"__proto__":"${mark}"}}}`))).toMatch(/bad name/)
  })

  it('refuses a name a plain object already answers to, as a kind, an id, a field, a mark, a list or an id of a list (it would reach the prototype, or read back as a function)', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'prototype']) {
      expect(problem({ entities: { [name]: {} } }), name).toMatch(/bad name/)
      expect(problem({ entities: { space: { [name]: entity({ a: 1 }) } } }), name).toMatch(/bad name/)
      expect(problem({ entities: { space: { s1: { fields: { [name]: 1 }, stamps: {} } } } }), name).toMatch(/bad name/)
      expect(problem({ entities: { space: { s1: { fields: { a: 1 }, stamps: { [name]: mark } } } } }), name).toMatch(/bad name/)
      expect(problem({ tombstones: { [name]: {} } }), name).toMatch(/bad name/)
      expect(problem({ tombstones: { tab: { [name]: mark } } }), name).toMatch(/bad name/)
      expect(problem({ order: { [name]: [] } }), name).toMatch(/bad key/)
      expect(problem({ order: { spaces: [name] } }), name).toMatch(/bad name/)
      expect(problem({ orderStamps: { [name]: mark } }), name).toMatch(/bad key/)
    }
  })

  it('still reads names that merely resemble them', () => {
    expect('problem' in parseSnapshot({ entities: { constructors: { toStrings: entity({ a: 1 }) } }, order: { 'folders:sp:-': ['valueOf2'] } })).toBe(false)
  })

  it('refuses a name that is empty, too long, or made of control characters', () => {
    expect(problem({ entities: { '': {} } })).toMatch(/bad name/)
    expect(problem({ entities: { space: { [`s${'x'.repeat(SNAPSHOT_LIMITS.maxIdChars)}`]: entity({ a: 1 }) } } })).toMatch(/bad name/)
    expect(problem({ entities: { space: { 's\u0000': entity({ a: 1 }) } } })).toMatch(/bad name/)
    expect(problem({ entities: { space: { s1: entity({ 'a\nb': 1 }) } } })).toMatch(/bad name/)
    expect(problem({ order: { spaces: ['s1', ''] } })).toMatch(/bad name/)
    expect(problem({ order: { spaces: [1] } })).toMatch(/bad name/)
  })

  it('refuses a value the two languages would not write alike: too deep, not finite, with an exponent, too long a string', () => {
    let deep: unknown = 1
    for (let i = 0; i < SNAPSHOT_LIMITS.maxJsonDepth + 1; i++) deep = [deep]
    expect(problem({ entities: { space: { s1: entity({ a: deep }) } } })).toMatch(/too deep/)
    expect(problem({ entities: { space: { s1: entity({ a: Number.NaN }) } } })).toMatch(/finite/)
    expect(problem({ entities: { space: { s1: entity({ a: 1e21 }) } } })).toMatch(/range/)
    expect(problem({ entities: { space: { s1: entity({ a: 1e-7 }) } } })).toMatch(/range/)
    expect(problem({ entities: { space: { s1: entity({ a: 'x'.repeat(SNAPSHOT_LIMITS.maxStringChars + 1) }) } } })).toMatch(/too long/)
    expect(problem({ entities: { space: { s1: entity({ a: undefined }) } } })).toMatch(/not a JSON value/)
    // The bounds themselves are in.
    expect('snapshot' in parseSnapshot({ entities: { space: { s1: entity({ a: [1e20, 1e-6, 0, -5, 'x'.repeat(SNAPSHOT_LIMITS.maxStringChars)] }) } } })).toBe(true)
  })

  it('refuses more entities than the specification allows', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i <= SNAPSHOT_LIMITS.maxEntities; i++) many[`t${i}`] = { fields: {}, stamps: {} }
    expect(problem({ entities: { tab: many } })).toMatch(/too many entities/)
    const tombs: Record<string, string> = {}
    for (let i = 0; i <= SNAPSHOT_LIMITS.maxEntities; i++) tombs[`t${i}`] = mark
    expect(problem({ tombstones: { tab: tombs } })).toMatch(/too many tombstones/)
  })

  it('clones a JSON value deeply', () => {
    const value = { a: [1, { b: null }], c: 'x' }
    const copy = cloneJson(value)
    expect(copy).toEqual(value)
    expect(copy).not.toBe(value)
    expect((copy as typeof value).a).not.toBe(value.a)
  })
})

// The cases LuciumKit plays too (SyncSnapshotVectorTests): the same reader in two languages.
const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-snapshot-vectors.json'), 'utf8')) as { cases: { name: string; json: string; expect: { accepted: boolean; canonical?: string } }[] }

describe('sync snapshot: the vectors of ios/Contracts/sync-snapshot-vectors.json', () => {
  it('are numerous enough, and named once', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30)
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.cases.length)
    expect(vectors.cases.filter((c) => !c.expect.accepted).length).toBeGreaterThan(15)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const read = parseSnapshot(JSON.parse(c.json))
    expect('snapshot' in read, 'problem' in read ? read.problem : '').toBe(c.expect.accepted)
    if ('snapshot' in read && c.expect.canonical !== undefined) expect(canonicalJson(read.snapshot)).toBe(c.expect.canonical)
  })

  it('refuses a key that is not in normalization form C, which Swift would not tell from its precomposed twin', () => {
    expect(problem({ entities: { space: { 'e\u0301': entity({}) } } })).toMatch(/bad name/)
    expect(problem({ entities: { space: { s1: entity({ 'cafe\u0301': 1 }) } } })).toMatch(/bad name/)
    expect(problem({ entities: { space: { s1: entity({ a: { 'cafe\u0301': 1 } }) } } })).toMatch(/normalization form C/)
    expect('snapshot' in parseSnapshot({ entities: { space: { s1: entity({ caf\u00e9: 1 }) } } })).toBe(true)
  })
})
