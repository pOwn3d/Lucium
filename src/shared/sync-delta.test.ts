// The difference between a snapshot and the base (docs/synchronisation.md §31): what is sent, and how the other rebuilds on its own copy of the base. The expected
// differences of the cases below are written by hand; the corpus that LuciumKit plays too (ios/Contracts/sync-delta-vectors.json) is the same functions on those cases,
// on 60 draws of two devices, and on the failures of a rebuild, kept as a file snapshot.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './sync-canonical'
import { applyDelta, diffSnapshots, type SnapshotDelta } from './sync-delta'
import { mergeSnapshots } from './sync-merge'
import { draws } from './sync-merge-draws.test-support'
import { emptySnapshot, parseSnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

const M = '1790000000001-0000-mac'
const L = '1790000000002-0000-mac'
const ent = (fields: Record<string, unknown>, mark = M): SyncEntity => ({ fields: fields as SyncEntity['fields'], stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, mark])) })
const snap = (partial: Partial<SyncSnapshot>): SyncSnapshot => ({ ...emptySnapshot(), ...partial })
const delta = (partial: Partial<Omit<SnapshotDelta, 'snapshot'>> & { snapshot?: Partial<SyncSnapshot> }): SnapshotDelta => ({ removedEntities: [], removedTombstones: [], removedLists: [], ...partial, snapshot: snap(partial.snapshot ?? {}) })
const digestOf = (snapshot: SyncSnapshot): string => createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex')

const BASE = snap({
  entities: { space: { s1: ent({ name: 'One' }), s2: ent({ name: 'Two' }) }, tab: { t1: ent({ spaceId: 's1', pinned: true }), t2: ent({ spaceId: 's1', pinned: true }) }, gadget: { g1: ent({ size: 3 }) } },
  tombstones: { tab: { t0: M } },
  order: { spaces: ['s1', 's2'], 'tabs:s1:-': ['t1', 't2'] },
  orderStamps: { spaces: M, 'tabs:s1:-': M }
})

/** The cases written by hand: a snapshot, and the difference with BASE that it must give. */
const CASES: Array<{ name: string; snapshot: SyncSnapshot; expected: SnapshotDelta }> = [
  { name: 'nothing changed: an empty difference', snapshot: BASE, expected: delta({}) },
  {
    name: 'an entity whose field changed goes whole, with its marks',
    snapshot: snap({ ...BASE, entities: { ...BASE.entities, space: { ...BASE.entities['space'], s1: { fields: { name: 'Uno' }, stamps: { name: L } } } } }),
    expected: delta({ snapshot: { entities: { space: { s1: { fields: { name: 'Uno' }, stamps: { name: L } } } } } })
  },
  {
    name: 'a field that only changed its mark is a change',
    snapshot: snap({ ...BASE, entities: { ...BASE.entities, space: { ...BASE.entities['space'], s2: { fields: { name: 'Two' }, stamps: { name: L } } } } }),
    expected: delta({ snapshot: { entities: { space: { s2: { fields: { name: 'Two' }, stamps: { name: L } } } } } })
  },
  {
    name: 'an entity added, and one removed',
    snapshot: snap({ ...BASE, entities: { ...BASE.entities, space: { s1: BASE.entities['space']!['s1']!, s3: ent({ name: 'Three' }, L) } } }),
    expected: delta({ snapshot: { entities: { space: { s3: ent({ name: 'Three' }, L) } } }, removedEntities: [{ kind: 'space', id: 's2' }] })
  },
  {
    name: 'the last entity of a kind removed, and a kind added',
    snapshot: snap({ ...BASE, entities: { space: BASE.entities['space']!, tab: BASE.entities['tab']!, folder: { f1: ent({ spaceId: 's1', name: 'F' }, L) } } }),
    expected: delta({ snapshot: { entities: { folder: { f1: ent({ spaceId: 's1', name: 'F' }, L) } } }, removedEntities: [{ kind: 'gadget', id: 'g1' }] })
  },
  {
    name: 'a tombstone added, one changed, one purged',
    snapshot: snap({ ...BASE, tombstones: { tab: { t9: L }, space: { s7: L } } }),
    expected: delta({ snapshot: { tombstones: { tab: { t9: L }, space: { s7: L } } }, removedTombstones: [{ kind: 'tab', id: 't0' }] })
  },
  {
    name: 'a list reordered goes whole with its mark; a list with the same ids and a new mark goes too',
    snapshot: snap({ ...BASE, order: { spaces: ['s2', 's1'], 'tabs:s1:-': ['t1', 't2'] }, orderStamps: { spaces: L, 'tabs:s1:-': L } }),
    expected: delta({ snapshot: { order: { spaces: ['s2', 's1'], 'tabs:s1:-': ['t1', 't2'] }, orderStamps: { spaces: L, 'tabs:s1:-': L } } })
  },
  {
    name: 'a list that is gone is removed with its mark, a new one is written',
    snapshot: snap({ ...BASE, order: { spaces: ['s1', 's2'], 'folders:s1:-': ['f1'] }, orderStamps: { spaces: M, 'folders:s1:-': L } }),
    expected: delta({ snapshot: { order: { 'folders:s1:-': ['f1'] }, orderStamps: { 'folders:s1:-': L } }, removedLists: ['tabs:s1:-'] })
  },
  {
    name: 'a kind or a list this version does not know is carried like the others: unchanged, it is not in the difference',
    snapshot: snap({ ...BASE, entities: { ...BASE.entities, gadget: { g1: ent({ size: 3 }), g2: ent({ size: 4 }, L) } } }),
    expected: delta({ snapshot: { entities: { gadget: { g2: ent({ size: 4 }, L) } } } })
  },
  {
    name: 'the removals are sorted by UTF-16 order (a character outside the basic plane is before a letter above it)',
    snapshot: emptySnapshot(),
    expected: delta({
      removedEntities: [{ kind: 'gadget', id: 'g1' }, { kind: 'space', id: 's1' }, { kind: 'space', id: 's2' }, { kind: 'tab', id: 't1' }, { kind: 'tab', id: 't2' }],
      removedTombstones: [{ kind: 'tab', id: 't0' }],
      removedLists: ['spaces', 'tabs:s1:-']
    })
  }
]

describe('the difference of a snapshot with its base', () => {
  for (const one of CASES) {
    it(`gives, and rebuilds: ${one.name}`, () => {
      const computed = diffSnapshots(BASE, one.snapshot)
      expect(computed).toEqual(one.expected)
      const rebuilt = applyDelta(BASE, one.expected)
      expect(rebuilt).toEqual({ snapshot: one.snapshot })
      expect(digestOf('snapshot' in rebuilt ? rebuilt.snapshot : emptySnapshot())).toBe(digestOf(one.snapshot))
    })
  }

  it('sorts a removal by UTF-16 order, not by code point', () => {
    const base = snap({ entities: { space: { '～': ent({ a: 1 }), '\u{1F600}': ent({ a: 1 }), z: ent({ a: 1 }) } } })
    expect(diffSnapshots(base, emptySnapshot()).removedEntities.map((one) => one.id)).toEqual(['z', '\u{1F600}', '～'])
  })

  it('does not change the base it rebuilds on, nor share anything with it', () => {
    const before = canonicalJson(BASE)
    const rebuilt = applyDelta(BASE, delta({ snapshot: { entities: { space: { s1: ent({ name: 'Uno' }, L) } } }, removedEntities: [{ kind: 'space', id: 's2' }] }))
    expect(canonicalJson(BASE)).toBe(before)
    if ('problem' in rebuilt) throw new Error(rebuilt.problem)
    rebuilt.snapshot.entities['tab']!['t1']!.fields['pinned'] = false
    expect(canonicalJson(BASE)).toBe(before)
  })

  it('refuses a difference that does not fit the base: a removal of what it does not hold, or a thing both written and removed', () => {
    const failures: Array<[string, SnapshotDelta]> = [
      ['a removed entity that the base does not hold', delta({ removedEntities: [{ kind: 'space', id: 'nowhere' }] })],
      ['a removed entity that the base does not hold', delta({ removedEntities: [{ kind: 'nothing', id: 's1' }] })],
      ['an entity both written and removed', delta({ snapshot: { entities: { space: { s1: ent({ name: 'x' }) } } }, removedEntities: [{ kind: 'space', id: 's1' }] })],
      ['a removed tombstone that the base does not hold', delta({ removedTombstones: [{ kind: 'tab', id: 'nowhere' }] })],
      ['a tombstone both written and removed', delta({ snapshot: { tombstones: { tab: { t0: L } } }, removedTombstones: [{ kind: 'tab', id: 't0' }] })],
      ['a removed list that the base does not hold', delta({ removedLists: ['nowhere'] })],
      ['a list both written and removed', delta({ snapshot: { order: { spaces: ['s1'] }, orderStamps: { spaces: L } }, removedLists: ['spaces'] })]
    ]
    for (const [problem, one] of failures) expect(applyDelta(BASE, one)).toEqual({ problem })
  })

  it('rebuilds the snapshot of every draw of two devices, and of what their merge gives, from the base', () => {
    let used = 0
    for (const d of draws(20261120, 300)) {
      if (d.base === null) continue
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      for (const snapshot of [d.local, d.remote, merged]) {
        const rebuilt = applyDelta(d.base, diffSnapshots(d.base, snapshot))
        if ('problem' in rebuilt) throw new Error(rebuilt.problem)
        expect(digestOf(rebuilt.snapshot)).toBe(digestOf(snapshot))
        used++
      }
    }
    expect(used).toBeGreaterThan(300)
  })

  it('is smaller than the snapshot when little changed, and reaches the same snapshot from an empty base (a whole snapshot is a difference with nothing)', () => {
    const big = snap({ entities: { tab: Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`t${n}`, ent({ spaceId: 's1', pinned: true, anchorUrl: `https://t${n}.example/` })])) } })
    const touched = snap({ entities: { tab: { ...big.entities['tab'], t7: ent({ spaceId: 's2' }, L) } } })
    expect(canonicalJson(diffSnapshots(big, touched)).length).toBeLessThan(canonicalJson(touched).length / 50)
    const fromNothing = applyDelta(emptySnapshot(), diffSnapshots(emptySnapshot(), touched))
    expect('snapshot' in fromNothing && digestOf(fromNothing.snapshot)).toBe(digestOf(touched))
  })
})

describe('the corpus of differences that LuciumKit plays too', () => {
  it('is written as a file snapshot, so that the Swift is held to the TypeScript on the same cases', async () => {
    const wire = (one: SnapshotDelta): Record<string, unknown> => ({ ...one.snapshot, removedEntities: one.removedEntities, removedTombstones: one.removedTombstones, removedLists: one.removedLists })
    const hand = CASES.map((one) => ({ name: one.name, base: BASE, snapshot: one.snapshot, delta: wire(diffSnapshots(BASE, one.snapshot)), digest: digestOf(one.snapshot) }))
    const corpus = draws(20261119, 60).flatMap((d, index) => {
      if (d.base === null) return []
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      const base = d.base
      return [
        { name: `draw ${index}, local`, snapshot: d.local },
        { name: `draw ${index}, remote`, snapshot: d.remote },
        { name: `draw ${index}, merged`, snapshot: merged }
      ].map((one) => ({ ...one, base, delta: wire(diffSnapshots(base, one.snapshot)), digest: digestOf(one.snapshot) }))
    })
    const failures = [
      { name: 'a removed entity that the base does not hold', base: BASE, delta: wire(delta({ removedEntities: [{ kind: 'space', id: 'nowhere' }] })) },
      { name: 'an entity both written and removed', base: BASE, delta: wire(delta({ snapshot: { entities: { space: { s1: ent({ name: 'x' }) } } }, removedEntities: [{ kind: 'space', id: 's1' }] })) },
      { name: 'a removed tombstone that the base does not hold', base: BASE, delta: wire(delta({ removedTombstones: [{ kind: 'tab', id: 'nowhere' }] })) },
      { name: 'a tombstone both written and removed', base: BASE, delta: wire(delta({ snapshot: { tombstones: { tab: { t0: L } } }, removedTombstones: [{ kind: 'tab', id: 't0' }] })) },
      { name: 'a removed list that the base does not hold', base: BASE, delta: wire(delta({ removedLists: ['nowhere'] })) },
      { name: 'a list both written and removed', base: BASE, delta: wire(delta({ snapshot: { order: { spaces: ['s1'] }, orderStamps: { spaces: L } }, removedLists: ['spaces'] })) }
    ]
    const file = {
      comment:
        'The difference between a snapshot and the base two devices share (docs/synchronisation.md §31): `cases` and `draws` give a base, a snapshot, the difference that must come out of the two (`delta`: the entities, tombstones, order and orderStamps that are new or changed, in the form of a snapshot, then `removedEntities` and `removedTombstones` as [{kind, id}] and `removedLists` as keys, all three sorted by UTF-16 order) and the SHA-256 of the canonical form of the snapshot, which the base plus the difference must rebuild; `failures` are differences a base does not take (the rebuild answers the reason in `problem`). It is a file snapshot: src/shared/sync-delta.test.ts rewrites it with `pnpm exec vitest run src/shared/sync-delta.test.ts -u` and refuses a difference otherwise, and LuciumKit (SyncDeltaTests) plays it against SyncDelta.swift: the same difference, the same rebuild, the same refusals.',
      cases: hand,
      draws: corpus,
      failures: failures.map((one) => ({ ...one, problem: (applyDelta(one.base, { snapshot: parse(one.delta), removedEntities: one.delta['removedEntities'] as never, removedTombstones: one.delta['removedTombstones'] as never, removedLists: one.delta['removedLists'] as never }) as { problem: string }).problem }))
    }
    await expect(`${JSON.stringify(file)}\n`).toMatchFileSnapshot('../../ios/Contracts/sync-delta-vectors.json')
  })

  it('is made of snapshots the door of a received snapshot lets in', () => {
    for (const d of draws(20261119, 60)) for (const s of [d.base, d.local, d.remote]) if (s !== null) expect('problem' in parseSnapshot(s)).toBe(false)
  })
})

function parse(wire: Record<string, unknown>): SyncSnapshot {
  return snap({ entities: wire['entities'] as never, tombstones: wire['tombstones'] as never, order: wire['order'] as never, orderStamps: wire['orderStamps'] as never })
}
