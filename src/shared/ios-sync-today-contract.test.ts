// The shared Today tabs of docs/synchronisation.md §27, written twice (TypeScript in src/shared/sync-today.ts and the merge of src/shared/sync-merge.ts, Swift in LuciumKit's
// SyncToday.swift and SyncMerge.swift) and held together by ios/Contracts/sync-today-vectors.json. This suite plays every section of the file against the Mac's side;
// `SyncTodayVectorTests` (LuciumKit, `swift test`) plays the same file against the Swift. The limits are also checked against the code, so that a figure changed on one side alone fails.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareConflicts, mergeSnapshots, otherSide, type SyncConflict } from './sync-merge'
import { parseSnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'
import {
  ACTIVE_AT_STEP_MS,
  admitTabs,
  gateTodayTabs,
  isShareableAddress,
  lastActiveFrom,
  roundActiveAt,
  TODAY_MIN_AGE_MS,
  TODAY_TAB_CAP,
  TODAY_TAB_FIELD_CLASSES,
  TODAY_TAB_GATE,
  TODAY_TITLE_MAX_BYTES,
  TODAY_URL_MAX_BYTES,
  todayMoves,
  type AdmissionRefusal,
  type TodayCandidate,
  type TodayRefusal
} from './sync-today'

interface MergeCase {
  name: string
  base: SyncSnapshot | null
  local: SyncSnapshot
  remote: SyncSnapshot
  withheld: string[]
  expect: { entities: SyncSnapshot['entities']; tombstones: SyncSnapshot['tombstones']; conflicts: SyncConflict[]; order: Record<string, string[] | null> }
  swap: boolean
}

interface Vectors {
  limits: Record<string, number>
  fieldClasses: { todayTab: { synced: string[]; seed: string[]; local: string[]; notApplicable: string[] } }
  address: { name: string; url: string; expect: boolean }[]
  activeAt: { round: { lastActiveAt: number; expect: number }[]; lastActive: { local: number; received: number; expect: number }[] }
  admission: { name: string; cap?: number; candidates: TodayCandidate[]; expect: { admitted: string[]; refused: { id: string; reason: AdmissionRefusal }[] } }[]
  gate: { name: string; limit?: number; entities: Record<string, SyncEntity>; base: Record<string, SyncEntity> | null; expect: { entities: Record<string, SyncEntity>; refused: { id: string; reason: TodayRefusal }[] } }[]
  moves: { name: string; removed: { kind: string; id: string }[]; created: { kind: string; id: string }[]; expect: { id: string; from: string; to: string }[] }[]
  merge: { devices: Record<string, string>; cases: MergeCase[] }
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-today-vectors.json'), 'utf8')) as Vectors
const model = readFileSync(join(__dirname, 'model.ts'), 'utf8')

/** The snapshot of a vector, read the way a received one is: a vector the form refuses is a vector that is wrong. */
const read = (snapshot: SyncSnapshot): SyncSnapshot => {
  const parsed = parseSnapshot(snapshot)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.snapshot
}
const readCase = (c: MergeCase): { base: SyncSnapshot | null; local: SyncSnapshot; remote: SyncSnapshot } => ({ base: c.base === null ? null : read(c.base), local: read(c.local), remote: read(c.remote) })
const swapped = (conflicts: SyncConflict[]): SyncConflict[] => conflicts.map((c) => ({ ...c, winner: otherSide(c.winner) })).sort(compareConflicts)

function membersOf(name: string): string[] {
  const start = model.indexOf(`export interface ${name} {`)
  const end = model.indexOf('\n}', start)
  return [...model.slice(start, end).matchAll(/^ {2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1] as string)
}

describe('iOS contract: shared Today tabs, the numbers and the classes (docs/synchronisation.md §27.2, §27.4)', () => {
  it('states the limits the code holds', () => {
    expect(vectors.limits).toEqual({
      todayTabCap: TODAY_TAB_CAP,
      todayTabGate: TODAY_TAB_GATE,
      urlMaxBytes: TODAY_URL_MAX_BYTES,
      titleMaxBytes: TODAY_TITLE_MAX_BYTES,
      minAgeMs: TODAY_MIN_AGE_MS,
      activeAtStepMs: ACTIVE_AT_STEP_MS
    })
    // The decisions of the project lead [Q12]: 200 at the entry, 500 at the door, 20 seconds, ten minutes.
    expect([TODAY_TAB_CAP, TODAY_TAB_GATE, TODAY_MIN_AGE_MS, ACTIVE_AT_STEP_MS]).toEqual([200, 500, 20_000, 600_000])
  })

  it('puts every field of a tab of model.ts in one class of todayTab, and only one (activeAt is a projection, not a field)', () => {
    const { synced, seed, local, notApplicable } = vectors.fieldClasses.todayTab
    const classified = [...synced.filter((f) => f !== 'activeAt'), ...seed, ...local, ...notApplicable]
    expect(new Set(classified).size, 'a field in two classes').toBe(classified.length)
    expect([...classified].sort()).toEqual([...membersOf('TabItem')].sort())
  })

  it('are the classes of the code', () => {
    expect(TODAY_TAB_FIELD_CLASSES).toEqual(vectors.fieldClasses.todayTab)
  })

  it('keeps what is private to the device local, and the page a tab is on a seed (copied once, [Q14])', () => {
    const { synced, seed, local } = vectors.fieldClasses.todayTab
    expect(local).toEqual(expect.arrayContaining(['private', 'container', 'lastActiveAt', 'windowKey', 'parentId']))
    expect(seed).toEqual(['url', 'title'])
    expect(synced).not.toContain('url')
    expect(synced).toContain('activeAt')
  })
})

describe('iOS contract: shared Today tabs, activeAt (§27.2, §27.5)', () => {
  it.each(vectors.activeAt.round.map((c) => [c.lastActiveAt, c] as const))('rounds %s down to ten minutes', (_n, c) => {
    expect(roundActiveAt(c.lastActiveAt)).toBe(c.expect)
  })
  it('does not round a value that is not a number to anything but 0', () => {
    expect(roundActiveAt(Number.NaN)).toBe(0)
    expect(roundActiveAt(Number.POSITIVE_INFINITY)).toBe(0)
  })
  it.each(vectors.activeAt.lastActive.map((c) => [`${c.local}/${c.received}`, c] as const))('writes the greater of the two as lastActiveAt: %s', (_n, c) => {
    expect(lastActiveFrom(c.local, c.received)).toBe(c.expect)
  })
})

describe('iOS contract: shared Today tabs, the address (§27.3 condition 3, §27.7)', () => {
  it.each(vectors.address.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(isShareableAddress(c.url)).toBe(c.expect)
  })
  it('refuses what is not a text', () => {
    expect(isShareableAddress(5)).toBe(false)
    expect(isShareableAddress(undefined)).toBe(false)
  })
})

describe('iOS contract: shared Today tabs, the admission (§27.3, §27.4)', () => {
  it.each(vectors.admission.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(admitTabs(c.candidates, c.cap)).toEqual(c.expect)
  })

  it('has a vector for each refusal, so that a condition that is removed has one to fail', () => {
    const reasons = new Set(vectors.admission.flatMap((c) => c.expect.refused.map((r) => r.reason)))
    for (const reason of ['private', 'private-window', 'favorite', 'container', 'space-locked', 'not-web-address', 'url-too-long', 'too-young', 'full']) expect(reasons.has(reason as AdmissionRefusal), reason).toBe(true)
    expect(vectors.admission.some((c) => c.name.startsWith('sticky'))).toBe(true)
  })

  const tab = (n: number, extra: Partial<TodayCandidate> = {}): TodayCandidate => ({ id: `t${String(n).padStart(4, '0')}`, url: 'https://a.example/', ageMs: 60_000, lastActiveAt: 1_790_000_000_000 + n, ...extra })

  it('holds 200 tabs at most [Q12, A]: the 201st, the least recently used, stays local', () => {
    const all = Array.from({ length: 201 }, (_unused, n) => tab(n))
    const { admitted, refused } = admitTabs(all)
    expect(admitted).toHaveLength(200)
    expect(refused).toEqual([{ id: 't0000', reason: 'full' }])
  })

  it('never takes out a tab that is admitted, however many there are (the merge would read the gap as a closing)', () => {
    const all = Array.from({ length: 230 }, (_unused, n) => tab(n, { admitted: true }))
    expect(admitTabs(all).admitted).toHaveLength(230)
  })
})

describe('iOS contract: shared Today tabs, the door (§27.4, §27.7)', () => {
  it.each(vectors.gate.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = gateTodayTabs(c.entities, c.base, c.limit)
    expect(result.entities).toEqual(c.expect.entities)
    expect(result.refused).toEqual(c.expect.refused)
  })

  it('does not change what it is given', () => {
    for (const c of vectors.gate) {
      const before = JSON.stringify([c.entities, c.base])
      gateTodayTabs(c.entities, c.base, c.limit)
      expect(JSON.stringify([c.entities, c.base]), c.name).toBe(before)
    }
  })

  it('has a vector for each refusal', () => {
    const reasons = new Set(vectors.gate.flatMap((c) => c.expect.refused.map((r) => r.reason)))
    for (const reason of ['invalid-url', 'invalid-value', 'too-many-today-tabs']) expect(reasons.has(reason as TodayRefusal), reason).toBe(true)
  })

  const entity = (n: number): SyncEntity => ({ fields: { spaceId: 's1', activeAt: n * ACTIVE_AT_STEP_MS }, stamps: { spaceId: '0', activeAt: '0' } })

  it('keeps 500 entities at most: 501 give 500 and the oldest is dropped (counted, never fatal)', () => {
    const all = Object.fromEntries(Array.from({ length: 501 }, (_unused, n) => [`t${String(n).padStart(4, '0')}`, entity(n + 1)]))
    const { entities, refused } = gateTodayTabs(all)
    expect(Object.keys(entities)).toHaveLength(500)
    expect(refused).toEqual([{ id: 't0000', reason: 'too-many-today-tabs' }])
  })

  it('keeps exactly 500 as they are', () => {
    const all = Object.fromEntries(Array.from({ length: 500 }, (_unused, n) => [`t${String(n).padStart(4, '0')}`, entity(n + 1)]))
    const { entities, refused } = gateTodayTabs(all)
    expect(Object.keys(entities)).toHaveLength(500)
    expect(refused).toEqual([])
  })
})

describe('iOS contract: shared Today tabs, pinning and detaching (§27.2)', () => {
  it.each(vectors.moves.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(todayMoves(c.removed, c.created)).toEqual(c.expect)
  })
})

describe('iOS contract: shared Today tabs, the merge (§27.9, §27.10)', () => {
  it('has the cases of the specification, so that a rule that is removed has a vector to fail', () => {
    const cases = vectors.merge.cases
    expect(cases.length).toBeGreaterThanOrEqual(18)
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
    const reasons = new Set<string>(cases.flatMap((c) => c.expect.conflicts.map((k) => k.reason)))
    for (const reason of ['newer', 'modification-over-deletion', 'order']) expect(reasons.has(reason as SyncConflict['reason']), reason).toBe(true)
    expect(cases.some((c) => c.base === null)).toBe(true)
    expect(cases.some((c) => c.withheld.length > 0)).toBe(true)
    expect(vectors.merge.devices).toEqual({ mac: 'mac', phone: 'phone' })
  })

  it.each(vectors.merge.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const merged = mergeSnapshots(base, local, remote, c.withheld)
    expect(merged.snapshot.entities).toEqual(c.expect.entities)
    expect(merged.snapshot.tombstones).toEqual(c.expect.tombstones)
    expect(merged.conflicts).toEqual(c.expect.conflicts)
    for (const [key, ids] of Object.entries(c.expect.order)) expect(merged.snapshot.order[key] ?? null, key).toEqual(ids)
  })

  it.each(vectors.merge.cases.filter((c) => c.swap).map((c) => [c.name, c] as const))('converges when local and remote are exchanged: %s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const there = mergeSnapshots(base, local, remote, c.withheld)
    const back = mergeSnapshots(base, remote, local, c.withheld)
    expect(back.snapshot).toEqual(there.snapshot)
    expect(back.conflicts).toEqual(swapped(there.conflicts))
  })

  it.each(vectors.merge.cases.map((c) => [c.name, c] as const))('is idempotent: %s', (_name, c) => {
    const { base, local, remote } = readCase(c)
    const first = mergeSnapshots(base, local, remote, c.withheld)
    const again = mergeSnapshots(first.snapshot, first.snapshot, first.snapshot, c.withheld)
    expect(again.snapshot).toEqual(first.snapshot)
    expect(again.conflicts).toEqual([])
  })
})
