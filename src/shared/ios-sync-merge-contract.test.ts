// The three-way merge of docs/synchronisation.md §11, written twice (TypeScript in src/shared/sync-merge.ts, Swift in LuciumKit's SyncMerge.swift) and held
// together by ios/Contracts/sync-merge-vectors.json. This suite checks the *form* of every vector and plays them against the merge of the Mac's side;
// `SyncMergeVectorTests` (LuciumKit, `swift test`) plays the same file against the Swift. Each vector also has to hold what the specification promises
// of any merge (§11.9): the same result when local and remote are exchanged (convergence), and no change when a result is merged again (idempotence).
// The tries on states nobody wrote are in sync-merge.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSnapshots, otherSide, compareConflicts, type SyncConflict } from './sync-merge'
import { parseSnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

interface MergeCase {
  name: string
  base: SyncSnapshot | null
  local: SyncSnapshot
  remote: SyncSnapshot
  withheld: string[]
  expect: { entities: SyncSnapshot['entities']; tombstones: SyncSnapshot['tombstones']; conflicts: SyncConflict[]; order?: SyncSnapshot['order'] }
  swap: boolean
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-merge-vectors.json'), 'utf8')) as { devices: Record<string, string>; cases: MergeCase[] }

/** The snapshot of a vector, read the way a received one is: a vector the form refuses is a vector that is wrong. */
const read = (snapshot: SyncSnapshot): SyncSnapshot => {
  const parsed = parseSnapshot(snapshot)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.snapshot
}
const readCase = (c: MergeCase): { base: SyncSnapshot | null; local: SyncSnapshot; remote: SyncSnapshot } => ({ base: c.base === null ? null : read(c.base), local: read(c.local), remote: read(c.remote) })
const swapped = (conflicts: SyncConflict[]): SyncConflict[] => conflicts.map((c) => ({ ...c, winner: otherSide(c.winner) })).sort(compareConflicts)

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The vectors
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('iOS contract: sync merge vectors, form', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30)
  })

  it('names each case once', () => {
    const names = vectors.cases.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('writes every mark in the form of the specification (§9.2) and the kinds the specification knows', () => {
    const STAMP = /^(0|[0-9]{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64})$/
    const marks: string[] = []
    for (const c of vectors.cases) {
      for (const snap of [c.base, c.local, c.remote, c.expect]) {
        if (snap === null) continue
        for (const byId of Object.values(snap.entities)) for (const ent of Object.values(byId)) marks.push(...Object.values((ent as SyncEntity).stamps))
        for (const byId of Object.values(snap.tombstones)) marks.push(...Object.values(byId))
        if ('orderStamps' in snap) marks.push(...Object.values((snap as SyncSnapshot).orderStamps))
      }
    }
    expect(marks.length).toBeGreaterThan(100)
    for (const mark of marks) expect(mark).toMatch(STAMP)
    // The two devices of the vectors are the ones whose ids tell which mark is the greater at equal time.
    expect(vectors.devices).toEqual({ mac: 'mac', phone: 'phone' })
  })

  it('covers each rule of §11 at least once, so that a rule that is removed has a vector to fail', () => {
    const reasons = new Set<string>(vectors.cases.flatMap((c) => c.expect.conflicts.map((k) => k.reason)))
    for (const reason of ['newer', 'device-id', 'value', 'modification-over-deletion', 'order']) expect(reasons.has(reason), reason).toBe(true)
    expect(vectors.cases.some((c) => c.base === null)).toBe(true)
    expect(vectors.cases.some((c) => c.withheld.length > 0)).toBe(true)
    expect(vectors.cases.some((c) => c.expect.order !== undefined)).toBe(true)
    expect(vectors.cases.some((c) => Object.keys(c.expect.tombstones).length > 0)).toBe(true)
  })
})

describe('iOS contract: sync three-way merge (docs/synchronisation.md §11)', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const merged = mergeSnapshots(base, local, remote, c.withheld)
    expect(merged.snapshot.entities).toEqual(c.expect.entities)
    expect(merged.snapshot.tombstones).toEqual(c.expect.tombstones)
    expect(merged.conflicts).toEqual(c.expect.conflicts)
    for (const [key, ids] of Object.entries(c.expect.order ?? {})) expect(merged.snapshot.order[key], key).toEqual(ids)
  })

  it.each(vectors.cases.filter((c) => c.swap).map((c) => [c.name, c] as const))('converges when local and remote are exchanged: %s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const there = mergeSnapshots(base, local, remote, c.withheld)
    const back = mergeSnapshots(base, remote, local, c.withheld)
    expect(back.snapshot).toEqual(there.snapshot)
    expect(back.conflicts).toEqual(swapped(there.conflicts))
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('is idempotent: %s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const first = mergeSnapshots(base, local, remote, c.withheld)
    // The result merged with itself, on itself as base.
    const again = mergeSnapshots(first.snapshot, first.snapshot, first.snapshot, c.withheld)
    expect(again.snapshot).toEqual(first.snapshot)
    expect(again.conflicts).toEqual([])
    // The result merged with either parent on the same base: nothing changes.
    for (const parent of [local, remote]) {
      expect(mergeSnapshots(base, first.snapshot, parent, c.withheld).snapshot).toEqual(first.snapshot)
    }
  })

  it('does not change what it is given (§11.1)', () => {
    for (const c of vectors.cases) {
      const { base, local, remote } = readCase(c)
      const before = JSON.stringify([base, local, remote])
      mergeSnapshots(base, local, remote, c.withheld)
      expect(JSON.stringify([base, local, remote]), c.name).toBe(before)
    }
  })

  it('keeps what it does not know (§11.6): an unknown field and an unknown kind are in the result', () => {
    const c = vectors.cases.find((v) => v.name.startsWith('unknown fields and unknown kinds'))
    expect(c).toBeDefined()
    const { base, local, remote } = readCase(c as MergeCase)
    const merged = mergeSnapshots(base, local, remote).snapshot
    expect(merged.entities['space']?.['s1']?.fields['futureField']).toEqual({ a: 1 })
    expect(merged.entities['widget']?.['w1']?.fields).toEqual({ x: 1 })
  })
})
