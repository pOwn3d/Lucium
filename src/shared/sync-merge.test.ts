// The three-way merge (sync-merge.ts) tried on states nobody wrote: the properties docs/synchronisation.md §11.9 promises, on a few hundred draws of two devices
// that edit a common ancestor the way people do (sync-merge-draws.test-support.ts). The vectors of ios/Contracts/sync-merge-vectors.json are played in
// ios-sync-merge-contract.test.ts; the corpus of draws that LuciumKit plays too is written here, as a file snapshot of the merge of the Mac's side.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './sync-canonical'
import { compareConflicts, mergeSnapshots, otherSide, type SyncConflict } from './sync-merge'
import { draws, type Draw } from './sync-merge-draws.test-support'
import { emptySnapshot, parseSnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

const DRAWS = draws(20261118, 600)

const swapped = (conflicts: SyncConflict[]): SyncConflict[] => conflicts.map((c) => ({ ...c, winner: otherSide(c.winner) })).sort(compareConflicts)
const text = (snapshot: SyncSnapshot): string => canonicalJson(snapshot)

/** A snapshot nobody can change: a merge that writes into what it was given throws (modules are strict). */
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) frozen(member)
    Object.freeze(value)
  }
  return value
}

const all = (snapshot: SyncSnapshot): [string, string, SyncEntity][] => Object.entries(snapshot.entities).flatMap(([kind, byId]) => Object.entries(byId).map(([id, entity]) => [kind, id, entity] as [string, string, SyncEntity]))
const has = (snapshot: SyncSnapshot, kind: string, id: string): boolean => snapshot.entities[kind]?.[id] !== undefined

describe('sync merge: the draws are worth drawing', () => {
  const results = DRAWS.map((d) => mergeSnapshots(d.base, d.local, d.remote, d.withheld))

  it('draw every case the merge has a rule for (a generator that draws nothing proves nothing)', () => {
    const reasons = new Set<string>(results.flatMap((r) => r.conflicts.map((c) => c.reason)))
    for (const reason of ['newer', 'device-id', 'value', 'modification-over-deletion', 'order']) expect(reasons.has(reason), reason).toBe(true)
    expect(results.some((r) => Object.keys(r.snapshot.tombstones).length > 0)).toBe(true)
    expect(DRAWS.some((d) => d.base === null)).toBe(true)
    expect(DRAWS.some((d) => d.withheld.length > 0)).toBe(true)
    expect(DRAWS.filter((d) => d.base !== null && text(d.local) === text(d.remote)).length).toBeLessThan(DRAWS.length / 4)
    // Unknown fields and an unknown kind are in the draws, so the property that they go through is not empty.
    expect(DRAWS.some((d) => d.local.entities['widget'] !== undefined)).toBe(true)
    expect(DRAWS.some((d) => all(d.local).some(([, , e]) => 'future' in e.fields))).toBe(true)
  })
})

describe('sync merge: convergence (§11.9.1)', () => {
  it('gives the same snapshot and the same conflicts, sides exchanged, whatever the draw', () => {
    for (const [i, d] of DRAWS.entries()) {
      const there = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      const back = mergeSnapshots(d.base, d.remote, d.local, d.withheld)
      expect(text(back.snapshot), `draw ${i}`).toBe(text(there.snapshot))
      expect(back.conflicts, `draw ${i}`).toEqual(swapped(there.conflicts))
    }
  })

  it('does not depend on the order the keys of the inputs were written in', () => {
    // The digest both devices compare is the canonical text: two devices that built the same snapshot in another key order must not diverge.
    for (const [i, d] of DRAWS.slice(0, 150).entries()) {
      const reversed = (snapshot: SyncSnapshot): SyncSnapshot => {
        const flip = <V>(record: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(record).reverse())
        return {
          entities: flip(Object.fromEntries(Object.entries(snapshot.entities).map(([kind, byId]) => [kind, flip(Object.fromEntries(Object.entries(byId).map(([id, e]) => [id, { fields: flip(e.fields), stamps: flip(e.stamps) }])))]))),
          tombstones: flip(Object.fromEntries(Object.entries(snapshot.tombstones).map(([kind, byId]) => [kind, flip(byId)]))),
          order: flip(snapshot.order),
          orderStamps: flip(snapshot.orderStamps),
        }
      }
      const a = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      const b = mergeSnapshots(d.base === null ? null : reversed(d.base), reversed(d.local), reversed(d.remote), [...d.withheld].reverse())
      expect(text(b.snapshot), `draw ${i}`).toBe(text(a.snapshot))
      expect(b.conflicts, `draw ${i}`).toEqual(a.conflicts)
    }
  })
})

describe('sync merge: idempotence (§11.9.2)', () => {
  it('does not change a result that is merged again with itself', () => {
    for (const [i, d] of DRAWS.entries()) {
      const first = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      const again = mergeSnapshots(first.snapshot, first.snapshot, first.snapshot, d.withheld)
      expect(text(again.snapshot), `draw ${i}`).toBe(text(first.snapshot))
      expect(again.conflicts, `draw ${i}`).toEqual([])
    }
  })

  it('does not change a result that is merged with one of its parents, on the same base', () => {
    for (const [i, d] of DRAWS.entries()) {
      const first = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      for (const [name, parent] of [['local', d.local], ['remote', d.remote]] as const) {
        expect(text(mergeSnapshots(d.base, first.snapshot, parent, d.withheld).snapshot), `draw ${i} with ${name}`).toBe(text(first.snapshot))
        expect(text(mergeSnapshots(d.base, parent, first.snapshot, d.withheld).snapshot), `draw ${i} with ${name}, sides exchanged`).toBe(text(first.snapshot))
      }
    }
  })

  it('settles in one more session: the two devices that apply the result and merge again agree on a result with no conflict', () => {
    // After a session each device's state is the result and its base is the result: the next session has nothing to settle.
    for (const [i, d] of DRAWS.entries()) {
      const first = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      const next = mergeSnapshots(first.snapshot, first.snapshot, first.snapshot, d.withheld)
      expect(next.conflicts, `draw ${i}`).toEqual([])
    }
  })
})

describe('sync merge: what it must not do (§11.9.3 and §11.9.4)', () => {
  it('keeps the fields it does not know, the kinds it does not know, and the marks that go with them', () => {
    let checked = 0
    for (const [i, d] of DRAWS.entries()) {
      if (d.withheld.length > 0) continue
      const merged = mergeSnapshots(d.base, d.local, d.remote).snapshot
      for (const side of [d.local, d.remote]) {
        for (const [kind, id, entity] of all(side)) {
          const kept = merged.entities[kind]?.[id]
          const base = d.base?.entities[kind]?.[id]
          if (kept === undefined) continue
          // A field only this side has, that was never in the base, is an addition on this side: it is in the result, with the same mark.
          for (const name of Object.keys(entity.fields)) {
            if (base !== undefined && name in base.fields) continue
            const other = (side === d.local ? d.remote : d.local).entities[kind]?.[id]
            if (other !== undefined && name in other.fields) continue
            if (['folderId', 'parentId'].includes(name)) continue // a reference to a folder that is gone is cleared on purpose (§11.7.1)
            checked++
            expect(kept.fields[name], `draw ${i} ${kind}.${id}.${name}`).toEqual(entity.fields[name])
            expect(kept.stamps[name], `draw ${i} ${kind}.${id}.${name}`).toBe(entity.stamps[name])
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('has no entity the inputs did not have, and no tombstone that comes from nowhere', () => {
    for (const [i, d] of DRAWS.entries()) {
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      for (const [kind, id] of all(merged).map(([k, id]) => [k, id] as const)) {
        const known = [d.base, d.local, d.remote].some((s) => s !== null && has(s, kind, id))
        expect(known, `draw ${i}: ${kind} ${id}`).toBe(true)
      }
      for (const [kind, byId] of Object.entries(merged.tombstones)) {
        for (const id of Object.keys(byId)) {
          // A tombstone is one the inputs wrote, or one the merge wrote for something it deleted or removed: that thing was in an input.
          const known = [d.base, d.local, d.remote].some((s) => s !== null && (has(s, kind, id) || s.tombstones[kind]?.[id] !== undefined))
          expect(known, `draw ${i}: tombstone ${kind} ${id}`).toBe(true)
        }
      }
    }
  })

  it('does not lose an entity one side modified because the other deleted it, unless what it belongs to is gone', () => {
    let checked = 0
    for (const [i, d] of DRAWS.entries()) {
      if (d.base === null || d.withheld.length > 0) continue
      const merged = mergeSnapshots(d.base, d.local, d.remote).snapshot
      for (const [mine, theirs] of [[d.local, d.remote], [d.remote, d.local]] as const) {
        for (const [kind, id, entity] of all(mine)) {
          const base = d.base.entities[kind]?.[id]
          if (base === undefined || has(theirs, kind, id) || canonicalJson(entity.fields) === canonicalJson(base.fields)) continue
          const space = entity.fields['spaceId']
          if (typeof space === 'string' && !has(merged, 'space', space)) continue // its space was deleted: the repair of §11.7.1 removes it
          checked++
          expect(has(merged, kind, id), `draw ${i}: ${kind} ${id}`).toBe(true)
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('does not change what it is given', () => {
    for (const [i, d] of DRAWS.entries()) {
      const before = canonicalJson([d.base, d.local, d.remote])
      // Frozen copies: a write into an input throws, in addition to the comparison below.
      const copy = JSON.parse(before) as [SyncSnapshot | null, SyncSnapshot, SyncSnapshot]
      mergeSnapshots(frozen(copy[0]), frozen(copy[1]), frozen(copy[2]), d.withheld)
      expect(canonicalJson(copy), `draw ${i}`).toBe(before)
    }
  })

  it('leaves no reference that points at nothing and no loop of folders', () => {
    for (const [i, d] of DRAWS.entries()) {
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      const spaces = merged.entities['space'] ?? {}
      const folders = merged.entities['folder'] ?? {}
      for (const kind of ['folder', 'tab', 'archived']) {
        for (const [id, e] of Object.entries(merged.entities[kind] ?? {})) {
          expect(spaces[e.fields['spaceId'] as string], `draw ${i}: ${kind} ${id} in a space that is not there`).toBeDefined()
          for (const field of kind === 'folder' ? ['parentId'] : ['folderId']) {
            const target = e.fields[field]
            if (target !== undefined) expect(folders[target as string], `draw ${i}: ${kind} ${id}.${field}`).toBeDefined()
          }
        }
      }
      for (const start of Object.keys(folders)) {
        const seen = new Set<string>()
        for (let at: unknown = start; typeof at === 'string'; at = folders[at]?.fields['parentId']) {
          expect(seen.has(at), `draw ${i}: a loop through ${at}`).toBe(false)
          seen.add(at)
        }
      }
    }
  })

  it('lists each member of a list once, and only members that are there, in the list their fields name', () => {
    for (const [i, d] of DRAWS.entries()) {
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      const expected = new Map<string, Set<string>>()
      for (const [kind, id, e] of all(merged)) {
        const f = e.fields
        const str = (name: string): string => (typeof f[name] === 'string' ? (f[name] as string) : '-')
        const key = kind === 'space' ? 'spaces' : kind === 'folder' ? `folders:${str('spaceId')}:${str('parentId')}` : kind === 'tab' ? `tabs:${str('spaceId')}:${str('folderId')}` : kind === 'favorite' ? `favorites:${str('profileId')}` : null
        if (key !== null) expected.set(key, (expected.get(key) ?? new Set()).add(id))
      }
      for (const [key, ids] of Object.entries(merged.order)) {
        expect(new Set(ids).size, `draw ${i}: ${key} repeats an id`).toBe(ids.length)
        expect([...ids].sort(), `draw ${i}: ${key}`).toEqual([...(expected.get(key) ?? [])].sort())
      }
      expect(Object.keys(merged.order).sort(), `draw ${i}`).toEqual([...expected.keys()].sort())
    }
  })
})

describe('sync merge: a space set aside (§10.4, §18)', () => {
  it('takes nothing of it, and what the inputs say of it changes nothing', () => {
    let checked = 0
    for (const [i, d] of DRAWS.entries()) {
      if (d.withheld.length === 0) continue
      const aside = new Set(d.withheld)
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld).snapshot
      for (const [kind, id, e] of all(merged)) {
        expect(kind === 'space' && aside.has(id), `draw ${i}: the space ${id}`).toBe(false)
        expect(aside.has(String(e.fields['spaceId'])), `draw ${i}: ${kind} ${id} of a space set aside`).toBe(false)
      }
      // Take it out of the inputs by hand: the result is the same.
      const strip = (s: SyncSnapshot): SyncSnapshot => {
        const gone = new Set<string>()
        const entities = Object.fromEntries(
          Object.entries(s.entities).map(([kind, byId]) => [
            kind,
            Object.fromEntries(
              Object.entries(byId).filter(([id, e]) => {
                const out = (kind === 'space' && aside.has(id)) || (['folder', 'tab', 'archived'].includes(kind) && aside.has(String(e.fields['spaceId'])))
                if (out) gone.add(id)
                return !out
              }),
            ),
          ]),
        )
        return { ...s, entities, order: Object.fromEntries(Object.entries(s.order).map(([key, ids]) => [key, ids.filter((id) => !gone.has(id))])) }
      }
      const stripped = mergeSnapshots(d.base === null ? null : strip(d.base), strip(d.local), strip(d.remote), d.withheld)
      expect(text(stripped.snapshot), `draw ${i}`).toBe(text(merged))
      checked++
    }
    expect(checked).toBeGreaterThan(30)
  })

  it('sets aside a space on one device only: the other device\'s copy of it does not travel either', () => {
    const base = parse({ entities: { space: { s1: ent({ name: 'Travail' }) } } })
    const remote = parse({ entities: { space: { s1: ent({ name: 'Renommé' }) } } })
    const merged = mergeSnapshots(base, base, remote, ['s1']).snapshot
    expect(merged.entities['space']).toBeUndefined()
    expect(mergeSnapshots(base, base, remote, []).snapshot.entities['space']?.['s1']?.fields['name']).toBe('Renommé')
  })
})

describe('sync merge: the first exchange (§11.8, [Q3])', () => {
  const mac = parse({
    entities: {
      space: { s1: ent({ name: 'Travail' }), s2: ent({ name: 'Maison' }) },
      tab: { t1: ent({ spaceId: 's1', pinned: true, anchorUrl: 'https://a.example/' }) },
    },
    order: { spaces: ['s1', 's2'], 'tabs:s1:-': ['t1'] },
  })
  const phone = parse({ entities: { space: { p1: ent({ name: 'Espace 1' }, '1790000000009-0000-phone') } }, order: { spaces: ['p1'] } })

  it('is the union of both states when there is no base, the same from both devices, and no conflict', () => {
    const there = mergeSnapshots(null, mac, phone)
    const back = mergeSnapshots(null, phone, mac)
    expect(text(back.snapshot)).toBe(text(there.snapshot))
    expect(Object.keys(there.snapshot.entities['space'] ?? {}).sort()).toEqual(['p1', 's1', 's2'])
    expect(has(there.snapshot, 'tab', 't1')).toBe(true)
    expect(there.conflicts).toEqual([])
  })

  it('has a device that was never modified send an empty snapshot and adopt the other\'s state: both devices land on the same result', () => {
    // The pristine iPhone has nothing the person made: it says nothing (an empty snapshot) and merges as if it had nothing, and so does the Mac.
    const onMac = mergeSnapshots(null, mac, emptySnapshot())
    const onPhone = mergeSnapshots(null, emptySnapshot(), mac)
    expect(text(onPhone.snapshot)).toBe(text(onMac.snapshot))
    expect(text(onMac.snapshot)).toBe(text(mac))
    expect(onMac.conflicts).toEqual([])
  })

  it('settles a field both devices wrote before they ever met by the marks, not by who asks', () => {
    const a = parse({ entities: { space: { s1: ent({ name: 'Mac' }, '1790000000003-0000-mac') } } })
    const b = parse({ entities: { space: { s1: ent({ name: 'iPhone' }, '1790000000004-0000-phone') } } })
    const merged = mergeSnapshots(null, a, b)
    expect(merged.snapshot.entities['space']?.['s1']?.fields['name']).toBe('iPhone')
    expect(merged.conflicts).toEqual([{ kind: 'space', id: 's1', field: 'name', winner: 'remote', reason: 'newer' }])
    expect(mergeSnapshots(null, b, a).conflicts).toEqual([{ kind: 'space', id: 's1', field: 'name', winner: 'local', reason: 'newer' }])
  })
})

describe('sync merge: cases the draws are unlikely to reach', () => {
  it('cuts a loop of one folder (a folder that is its own parent)', () => {
    const s = parse({ entities: { space: { s1: ent({ name: 'S' }) }, folder: { f1: ent({ spaceId: 's1', name: 'F', parentId: 'f1' }) } } })
    const merged = mergeSnapshots(null, s, emptySnapshot()).snapshot
    expect(merged.entities['folder']?.['f1']?.fields['parentId']).toBeUndefined()
  })

  it('cuts each of two loops at its own smallest id, and leaves the folders that lead into a loop alone', () => {
    const f = (parentId: string): SyncEntity => ent({ spaceId: 's1', name: 'F', parentId })
    const s = parse({ entities: { space: { s1: ent({ name: 'S' }) }, folder: { a: f('b'), b: f('a'), c: f('d'), d: f('c'), e: f('a') } } })
    const folders = mergeSnapshots(null, s, emptySnapshot()).snapshot.entities['folder'] as Record<string, SyncEntity>
    expect(folders['a']?.fields['parentId']).toBeUndefined()
    expect(folders['b']?.fields['parentId']).toBe('a')
    expect(folders['c']?.fields['parentId']).toBeUndefined()
    expect(folders['d']?.fields['parentId']).toBe('c')
    expect(folders['e']?.fields['parentId']).toBe('a')
  })

  it('cuts a chain of 20 000 folders without taking a quadratic time (a hostile peer may send one)', () => {
    const folders: Record<string, SyncEntity> = {}
    for (let i = 0; i < 20_000; i++) folders[`f${i}`] = ent({ spaceId: 's1', name: 'F', parentId: `f${(i + 1) % 20_000}` })
    const s = parse({ entities: { space: { s1: ent({ name: 'S' }) }, folder: folders } })
    const started = Date.now()
    const merged = mergeSnapshots(null, s, emptySnapshot()).snapshot.entities['folder'] as Record<string, SyncEntity>
    expect(Date.now() - started).toBeLessThan(5000)
    expect(Object.values(merged).filter((e) => e.fields['parentId'] === undefined)).toHaveLength(1)
  })

  it('repairs a copy: a tab that points at a folder that is gone is cleared in the result and never in the input', () => {
    const tab = ent({ spaceId: 's1', pinned: true, anchorUrl: 'https://a.example/', folderId: 'f9' })
    const mine = frozen(parse({ entities: { space: { s1: ent({ name: 'S' }) }, tab: { t1: tab } } }))
    const theirs = frozen(emptySnapshot())
    const merged = mergeSnapshots(null, mine, theirs).snapshot
    expect(merged.entities['tab']?.['t1']?.fields['folderId']).toBeUndefined()
    expect(mine.entities['tab']?.['t1']?.fields['folderId']).toBe('f9')
    expect(merged.entities['tab']?.['t1']).not.toBe(mine.entities['tab']?.['t1'])
  })

  it('writes no mark for a field that is absent and whose mark is zero (§8.3): it says nothing, and two devices would not write it alike', () => {
    const side = (): SyncSnapshot => parse({ entities: { space: { s1: { fields: { name: 'A' }, stamps: { name: '1790000000001-0000-mac', ghost: '0' } } } } })
    expect(mergeSnapshots(null, side(), side()).snapshot.entities['space']?.['s1']?.stamps).toEqual({ name: '1790000000001-0000-mac' })
    // A removed field keeps the mark of its removal, which says when.
    const removed = parse({ entities: { space: { s1: { fields: { name: 'A' }, stamps: { name: '1790000000001-0000-mac', gone: '1790000000005-0000-mac' } } } } })
    expect(mergeSnapshots(null, removed, removed).snapshot.entities['space']?.['s1']?.stamps['gone']).toBe('1790000000005-0000-mac')
  })

  it('compares two values of one field that no mark can tell apart by UTF-16 code unit, as LuciumKit does', () => {
    // "😀" is D83D DE00 in UTF-16 and F0 9F 98 80 in UTF-8; "～" is FF5E and EF BD 9E: the two orders disagree.
    const a = parse({ entities: { space: { s1: { fields: { name: '😀' }, stamps: {} } } } })
    const b = parse({ entities: { space: { s1: { fields: { name: '～' }, stamps: {} } } } })
    const merged = mergeSnapshots(null, a, b)
    expect(merged.snapshot.entities['space']?.['s1']?.fields['name']).toBe('～')
    expect(merged.conflicts).toEqual([{ kind: 'space', id: 's1', field: 'name', winner: 'remote', reason: 'value' }])
  })

  it('lists the conflicts by kind, id and field, each by UTF-16 code unit, a whole entity before its fields', () => {
    const list = [
      { kind: 'tab', id: 't1', field: 'b' },
      { kind: 'tab', id: 't1', field: null },
      { kind: 'tab', id: 'T1', field: 'a' },
      { kind: 'order', id: 'spaces', field: null },
      { kind: 'tab', id: 't1', field: 'a' },
    ]
    expect([...list].sort(compareConflicts).map((c) => `${c.kind}/${c.id}/${c.field}`)).toEqual(['order/spaces/null', 'tab/T1/a', 'tab/t1/null', 'tab/t1/a', 'tab/t1/b'])
  })
})

describe('sync merge: the corpus of draws that LuciumKit plays too', () => {
  it('is written as a file snapshot of the merge, so that the Swift is held to the TypeScript on states nobody wrote', async () => {
    const corpus = draws(20261119, 60).map((d: Draw, index) => {
      const merged = mergeSnapshots(d.base, d.local, d.remote, d.withheld)
      return { name: `draw ${index}`, base: d.base, local: d.local, remote: d.remote, withheld: d.withheld, expect: { snapshot: merged.snapshot, conflicts: merged.conflicts, digest: createHash('sha256').update(canonicalJson(merged.snapshot), 'utf8').digest('hex') } }
    })
    const file = {
      comment:
        'The corpus of the three-way merge on states nobody wrote (docs/synchronisation.md §11): 60 draws of two devices that edit a common ancestor (src/shared/sync-merge-draws.test-support.ts, seed 20261119), and what the merge of the Mac (src/shared/sync-merge.ts) gives. It is a file snapshot: src/shared/sync-merge.test.ts rewrites it with `pnpm exec vitest run src/shared/sync-merge.test.ts -u` and refuses a difference otherwise, and LuciumKit (SyncMergeVectorTests) plays it against the Swift merge. A snapshot is {entities, tombstones, order, orderStamps}; `base: null` is the empty base; `conflicts` are in the order of (kind, id, field); `digest` is the SHA-256 of the canonical form (RFC 8785) of the merged snapshot, the text the two devices compare.',
      cases: corpus,
    }
    await expect(`${JSON.stringify(file)}\n`).toMatchFileSnapshot('../../ios/Contracts/sync-merge-draws.json')
  })

  it('reads back through the form of a received snapshot (the corpus is made of snapshots the door lets in)', () => {
    for (const d of draws(20261119, 60)) for (const s of [d.base, d.local, d.remote]) if (s !== null) expect('problem' in parseSnapshot(s)).toBe(false)
  })
})

// Small helpers for the cases written by hand.
function ent(fields: Record<string, never> | Record<string, unknown>, mark = '1790000000001-0000-mac'): SyncEntity {
  return { fields: fields as SyncEntity['fields'], stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, mark])) }
}
function parse(partial: Partial<SyncSnapshot>): SyncSnapshot {
  const read = parseSnapshot({ ...emptySnapshot(), ...partial })
  if ('problem' in read) throw new Error(read.problem)
  return read.snapshot
}
