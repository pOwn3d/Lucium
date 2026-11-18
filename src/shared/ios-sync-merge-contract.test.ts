// The three-way merge of docs/synchronisation.md §11, written twice later (TypeScript in src/shared/, Swift in LuciumKit) and held together by
// ios/Contracts/sync-merge-vectors.json. Neither exists yet. This suite plays the vectors against a *reference merge* written in this file from the rules
// of the specification, so that a vector that contradicts the text fails here, and so that the rules themselves are tried for what the specification
// promises (§11.9): the same result when local and remote are exchanged (convergence), and no change when a result is merged again (idempotence).
// The card of the merge (446) writes the real code and plays the same vectors against it; this reference is then removed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Fields = Record<string, unknown>
interface Ent { fields: Fields; stamps: Record<string, string> }
interface Snap { entities: Record<string, Record<string, Ent>>; tombstones: Record<string, Record<string, string>>; order: Record<string, string[]>; orderStamps: Record<string, string> }
interface Conflict { kind: string; id: string; field: string | null; winner: 'local' | 'remote'; reason: string }
interface Merged extends Snap { conflicts: Conflict[] }
interface MergeCase {
  name: string
  base: Snap | null
  local: Snap
  remote: Snap
  withheld: string[]
  expect: { entities: Snap['entities']; tombstones: Snap['tombstones']; conflicts: Conflict[]; order?: Snap['order'] }
  swap: boolean
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-merge-vectors.json'), 'utf8')) as { devices: Record<string, string>; cases: MergeCase[] }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The reference merge
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ZERO = '0'
const canonical = (value: unknown): string => {
  if (value === undefined) return ''
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
const maxStamp = (...stamps: string[]): string => stamps.reduce((a, b) => (a >= b ? a : b), ZERO)
const minStamp = (stamps: string[]): string => (stamps.length === 0 ? ZERO : stamps.reduce((a, b) => (a <= b ? a : b)))
/** Why one mark beat the other: the time or the counter differs (`newer`), only the device id differs, or the marks are the same. */
const reasonOf = (a: string, b: string): string => (a === b ? 'value' : a.split('-').slice(0, 2).join('-') !== b.split('-').slice(0, 2).join('-') ? 'newer' : 'device-id')

const SPACE_DEPENDENTS: [string, string][] = [['folder', 'spaceId'], ['tab', 'spaceId'], ['archived', 'spaceId']]
const FOLDER_DEPENDENTS: [string, string][] = [['folder', 'parentId'], ['tab', 'folderId'], ['archived', 'folderId']]
const DEPENDENTS: Record<string, [string, string][]> = { space: SPACE_DEPENDENTS, folder: FOLDER_DEPENDENTS }

const empty = (): Snap => ({ entities: {}, tombstones: {}, order: {}, orderStamps: {} })

/** §10.4/§18: what belongs to a space set aside is taken out of the three snapshots, on both devices. */
function withoutSpaces(snap: Snap, spaces: Set<string>): Snap {
  if (spaces.size === 0) return snap
  const dropped = new Set<string>()
  const entities: Snap['entities'] = {}
  for (const [kind, byId] of Object.entries(snap.entities)) {
    entities[kind] = {}
    for (const [id, ent] of Object.entries(byId)) {
      const belongs = (kind === 'space' && spaces.has(id)) || (['folder', 'tab', 'archived'].includes(kind) && spaces.has(String(ent.fields['spaceId'])))
      if (belongs) dropped.add(id)
      else (entities[kind] as Record<string, Ent>)[id] = ent
    }
  }
  const order = Object.fromEntries(Object.entries(snap.order).map(([key, ids]) => [key, ids.filter((id) => !dropped.has(id))]))
  return { ...snap, entities, order }
}

/** Did the side `side` add a dependent of (kind, id), or move one into it, since the base? Without a base there is no "since": only the marks count. */
function enteredBy(kind: string, id: string, side: Snap, base: Snap | null): boolean {
  if (base === null) return false
  for (const [childKind, field] of DEPENDENTS[kind] ?? []) {
    for (const [childId, child] of Object.entries(side.entities[childKind] ?? {})) {
      if (child.fields[field] !== id) continue
      const before = base.entities[childKind]?.[childId]
      if (before === undefined || before.fields[field] !== id) return true
    }
  }
  return false
}

function mergeEntity(kind: string, id: string, base: Ent | undefined, local: Ent, remote: Ent, conflicts: Conflict[]): Ent {
  const names = new Set([...Object.keys(base?.fields ?? {}), ...Object.keys(local.fields), ...Object.keys(remote.fields), ...Object.keys(local.stamps), ...Object.keys(remote.stamps)])
  const fields: Fields = {}
  const stamps: Record<string, string> = {}
  for (const name of [...names].sort()) {
    const b = base?.fields[name]
    const l = local.fields[name]
    const r = remote.fields[name]
    const sl = local.stamps[name] ?? ZERO
    const sr = remote.stamps[name] ?? ZERO
    const changedLocal = !same(l, b)
    const changedRemote = !same(r, b)
    let value: unknown
    let stamp: string
    if (!changedLocal && !changedRemote) { value = b; stamp = maxStamp(sl, sr) }
    else if (changedLocal && !changedRemote) { value = l; stamp = sl }
    else if (!changedLocal && changedRemote) { value = r; stamp = sr }
    else if (same(l, r)) { value = l; stamp = maxStamp(sl, sr) }
    else {
      // Both changed it, differently: the greater mark wins; equal marks (a field never stamped): the greater canonical text.
      const remoteWins = sl === sr ? canonical(r) > canonical(l) : sr > sl
      value = remoteWins ? r : l
      stamp = remoteWins ? sr : sl
      conflicts.push({ kind, id, field: name, winner: remoteWins ? 'remote' : 'local', reason: reasonOf(sl, sr) })
    }
    if (value !== undefined) fields[name] = value
    if (value !== undefined || stamp !== ZERO) stamps[name] = stamp
  }
  return { fields, stamps }
}

const listKeyOf = (kind: string, fields: Fields): string | null => {
  switch (kind) {
    case 'space': return 'spaces'
    case 'folder': return `folders:${String(fields['spaceId'])}:${typeof fields['parentId'] === 'string' ? fields['parentId'] : '-'}`
    case 'tab': return `tabs:${String(fields['spaceId'])}:${typeof fields['folderId'] === 'string' ? fields['folderId'] : '-'}`
    case 'favorite': return `favorites:${typeof fields['profileId'] === 'string' ? fields['profileId'] : '-'}`
    default: return null
  }
}

function merge(baseIn: Snap | null, localIn: Snap, remoteIn: Snap, withheld: string[] = []): Merged {
  const spaces = new Set(withheld)
  const base = baseIn === null ? null : withoutSpaces(baseIn, spaces)
  const local = withoutSpaces(localIn, spaces)
  const remote = withoutSpaces(remoteIn, spaces)
  const conflicts: Conflict[] = []
  const entities: Snap['entities'] = {}
  const tombstones: Snap['tombstones'] = {}
  // A merge is pure: what it keeps is a copy, so that the repairs below never change what it was given.
  const put = (kind: string, id: string, ent: Ent): void => { (entities[kind] ??= {})[id] = { fields: JSON.parse(JSON.stringify(ent.fields)) as Fields, stamps: { ...ent.stamps } } }

  const kinds = new Set([...Object.keys(base?.entities ?? {}), ...Object.keys(local.entities), ...Object.keys(remote.entities), ...Object.keys(local.tombstones), ...Object.keys(remote.tombstones)])
  for (const kind of [...kinds].sort()) {
    const ids = new Set([...Object.keys(base?.entities[kind] ?? {}), ...Object.keys(local.entities[kind] ?? {}), ...Object.keys(remote.entities[kind] ?? {}), ...Object.keys(local.tombstones[kind] ?? {}), ...Object.keys(remote.tombstones[kind] ?? {})])
    for (const id of [...ids].sort()) {
      const b = base?.entities[kind]?.[id]
      const l = local.entities[kind]?.[id]
      const r = remote.entities[kind]?.[id]
      const tombLocal = local.tombstones[kind]?.[id]
      const tombRemote = remote.tombstones[kind]?.[id]
      if (l !== undefined && r !== undefined) { put(kind, id, mergeEntity(kind, id, b, l, r, conflicts)); continue }
      if (l === undefined && r === undefined) {
        if (b !== undefined || tombLocal !== undefined || tombRemote !== undefined) (tombstones[kind] ??= {})[id] = maxStamp(tombLocal ?? ZERO, tombRemote ?? ZERO)
        continue
      }
      const keptSide = l !== undefined ? 'local' : 'remote'
      const kept = (l ?? r) as Ent
      const otherTomb = l !== undefined ? tombRemote : tombLocal
      if (b === undefined && otherTomb === undefined) { put(kind, id, kept); continue } // an addition
      const modified = b !== undefined ? !same(kept.fields, b.fields) || enteredBy(kind, id, keptSide === 'local' ? local : remote, base) : maxStamp(...Object.values(kept.stamps)) > (otherTomb as string)
      if (modified) {
        put(kind, id, kept)
        conflicts.push({ kind, id, field: null, winner: keptSide, reason: 'modification-over-deletion' })
      } else (tombstones[kind] ??= {})[id] = otherTomb ?? ZERO
    }
  }

  // §11.7: references that point at nothing, then cycles of folders.
  const forget = (): void => { for (const kind of Object.keys(entities)) if (Object.keys(entities[kind] ?? {}).length === 0) delete entities[kind] }
  const spaceIds = new Set(Object.keys(entities['space'] ?? {}))
  for (const kind of ['folder', 'tab', 'archived']) {
    for (const [id, ent] of Object.entries(entities[kind] ?? {})) {
      if (spaceIds.has(String(ent.fields['spaceId']))) continue
      // What is removed leaves a tombstone, marked with its own latest change: a later change elsewhere brings it back, and it is removed again.
      delete (entities[kind] as Record<string, Ent>)[id]
      ;(tombstones[kind] ??= {})[id] = maxStamp(...Object.values(ent.stamps))
    }
  }
  const folderIds = new Set(Object.keys(entities['folder'] ?? {}))
  for (const [kind, field] of [['tab', 'folderId'], ['archived', 'folderId'], ['folder', 'parentId']] as const) {
    for (const ent of Object.values(entities[kind] ?? {})) {
      const target = ent.fields[field]
      if (typeof target !== 'string' || folderIds.has(target)) continue
      delete ent.fields[field]
      // A mark of zero on an absent field says nothing: it is not written.
      if (ent.stamps[field] === ZERO) delete ent.stamps[field]
    }
  }
  for (;;) {
    const folders = entities['folder'] ?? {}
    let cycle: string[] | null = null
    for (const start of Object.keys(folders)) {
      const seen: string[] = []
      let at: unknown = start
      while (typeof at === 'string' && folders[at] !== undefined && !seen.includes(at)) { seen.push(at); at = folders[at]?.fields['parentId'] }
      if (typeof at === 'string' && seen.includes(at)) { cycle = seen.slice(seen.indexOf(at)); break }
    }
    if (cycle === null) break
    const smallest = [...cycle].sort()[0] as string
    const broken = folders[smallest] as Ent
    delete broken.fields['parentId']
    if (broken.stamps['parentId'] === ZERO) delete broken.stamps['parentId']
  }

  forget()

  // §11.4: the order of each list.
  const members = new Map<string, { id: string; ent: Ent }[]>()
  for (const [kind, byId] of Object.entries(entities)) for (const [id, ent] of Object.entries(byId)) {
    const key = listKeyOf(kind, ent.fields)
    if (key !== null) members.set(key, [...(members.get(key) ?? []), { id, ent }])
  }
  const order: Snap['order'] = {}
  const orderStamps: Snap['orderStamps'] = {}
  const keys = new Set([...Object.keys(base?.order ?? {}), ...Object.keys(local.order), ...Object.keys(remote.order), ...members.keys()])
  for (const key of [...keys].sort()) {
    const present = new Map((members.get(key) ?? []).map((m) => [m.id, m.ent]))
    const ob = base?.order[key] ?? []
    const ol = local.order[key] ?? []
    const or = remote.order[key] ?? []
    const relative = (a: string[], b: string[]): string[] => a.filter((id) => b.includes(id))
    const reordered = (side: string[]): boolean => !same(relative(side, ob), relative(ob, side))
    const sl = local.orderStamps[key] ?? ZERO
    const sr = remote.orderStamps[key] ?? ZERO
    let chosen = ob
    if (reordered(ol) && reordered(or) && same(ol, or)) chosen = ol // the same reorder on both sides is not a conflict
    else if (reordered(ol) && reordered(or)) {
      const remoteWins = sl === sr ? canonical(or) > canonical(ol) : sr > sl
      chosen = remoteWins ? or : ol
      conflicts.push({ kind: 'order', id: key, field: null, winner: remoteWins ? 'remote' : 'local', reason: 'order' })
    } else if (reordered(ol)) chosen = ol
    else if (reordered(or)) chosen = or
    const kept = [...new Set(chosen.filter((id) => present.has(id)))]
    const birth = (id: string): string => minStamp(Object.values(present.get(id)?.stamps ?? {}))
    const added = [...present.keys()].filter((id) => !kept.includes(id)).sort((a, b) => (birth(a) < birth(b) ? -1 : birth(a) > birth(b) ? 1 : a < b ? -1 : a > b ? 1 : 0))
    const final = [...kept, ...added]
    if (final.length > 0) order[key] = final
    const stamp = maxStamp(sl, sr)
    if (stamp !== ZERO) orderStamps[key] = stamp
  }

  conflicts.sort((a, b) => (a.kind + '\0' + a.id + '\0' + (a.field ?? '')).localeCompare(b.kind + '\0' + b.id + '\0' + (b.field ?? ''), 'en'))
  return { entities, tombstones, order, orderStamps, conflicts }
}

const swapWinner = (c: Conflict): Conflict => ({ ...c, winner: c.winner === 'local' ? 'remote' : 'local' })
const asSnap = (m: Merged): Snap => ({ entities: m.entities, tombstones: m.tombstones, order: m.order, orderStamps: m.orderStamps })
const stripUndefined = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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
        for (const byId of Object.values(snap.entities)) for (const ent of Object.values(byId)) marks.push(...Object.values((ent as Ent).stamps))
        for (const byId of Object.values(snap.tombstones)) marks.push(...Object.values(byId))
        if ('orderStamps' in snap) marks.push(...Object.values((snap as Snap).orderStamps))
      }
    }
    expect(marks.length).toBeGreaterThan(100)
    for (const mark of marks) expect(mark).toMatch(STAMP)
    // The two devices of the vectors are the ones whose ids tell which mark is the greater at equal time.
    expect(vectors.devices).toEqual({ mac: 'mac', phone: 'phone' })
  })

  it('covers each rule of §11 at least once, so that a rule that is removed has a vector to fail', () => {
    const reasons = new Set(vectors.cases.flatMap((c) => c.expect.conflicts.map((k) => k.reason)))
    for (const reason of ['newer', 'device-id', 'value', 'modification-over-deletion', 'order']) expect(reasons.has(reason), reason).toBe(true)
    expect(vectors.cases.some((c) => c.base === null)).toBe(true)
    expect(vectors.cases.some((c) => c.withheld.length > 0)).toBe(true)
    expect(vectors.cases.some((c) => c.expect.order !== undefined)).toBe(true)
    expect(vectors.cases.some((c) => Object.keys(c.expect.tombstones).length > 0)).toBe(true)
  })
})

describe('iOS contract: sync three-way merge (docs/synchronisation.md §11)', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const merged = merge(c.base, c.local, c.remote, c.withheld)
    expect(stripUndefined(merged.entities)).toEqual(c.expect.entities)
    expect(stripUndefined(merged.tombstones)).toEqual(c.expect.tombstones)
    expect(merged.conflicts).toEqual(c.expect.conflicts)
    for (const [key, ids] of Object.entries(c.expect.order ?? {})) expect(merged.order[key], key).toEqual(ids)
  })

  it.each(vectors.cases.filter((c) => c.swap).map((c) => [c.name, c] as const))('converges when local and remote are exchanged: %s', (_name, c) => {
    const there = merge(c.base, c.local, c.remote, c.withheld)
    const back = merge(c.base, c.remote, c.local, c.withheld)
    expect(stripUndefined(back.entities)).toEqual(stripUndefined(there.entities))
    expect(back.tombstones).toEqual(there.tombstones)
    expect(back.order).toEqual(there.order)
    expect(back.conflicts).toEqual(there.conflicts.map(swapWinner).sort((a, b) => (a.kind + a.id + (a.field ?? '')).localeCompare(b.kind + b.id + (b.field ?? ''), 'en')))
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('is idempotent: %s', (_name, c) => {
    const first = merge(c.base, c.local, c.remote, c.withheld)
    const result = asSnap(first)
    // The result merged with itself, on itself as base.
    const again = merge(result, result, result, c.withheld)
    expect(stripUndefined(again.entities)).toEqual(stripUndefined(first.entities))
    expect(again.tombstones).toEqual(first.tombstones)
    expect(again.order).toEqual(first.order)
    expect(again.conflicts).toEqual([])
    // The result merged with either parent on the same base: nothing changes.
    for (const parent of [c.local, c.remote]) {
      const withParent = merge(c.base, result, parent, c.withheld)
      expect(stripUndefined(withParent.entities)).toEqual(stripUndefined(first.entities))
      expect(withParent.tombstones).toEqual(first.tombstones)
      expect(withParent.order).toEqual(first.order)
    }
  })

  it('keeps what it does not know (§11.6): an unknown field and an unknown kind are in the result', () => {
    const c = vectors.cases.find((v) => v.name.startsWith('unknown fields and unknown kinds'))
    expect(c).toBeDefined()
    const merged = merge((c as MergeCase).base, (c as MergeCase).local, (c as MergeCase).remote)
    expect(merged.entities['space']?.['s1']?.fields['futureField']).toEqual({ a: 1 })
    expect(merged.entities['widget']?.['w1']?.fields).toEqual({ x: 1 })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The rules tried on states nobody wrote
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** A small seeded generator (mulberry32): the same states at every run, so that a failure can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomSnap(rand: () => number, role: 'base' | 'side'): Snap {
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)] as T
  const mark = (): string => (rand() < 0.1 ? ZERO : `${String(1790000000000 + Math.floor(rand() * 6)).padStart(13, '0')}-${Math.floor(rand() * 2).toString(16).padStart(4, '0')}-${pick(['mac', 'phone'])}`)
  const snap = empty()
  const spaceIds = ['s1', 's2'].filter(() => rand() < 0.85)
  for (const id of spaceIds) (snap.entities['space'] ??= {})[id] = { fields: { name: pick(['A', 'B', 'C']) }, stamps: { name: mark() } }
  const folders = ['f1', 'f2', 'f3'].filter(() => rand() < 0.6)
  for (const id of folders) {
    const fields: Fields = { spaceId: pick(['s1', 's2']), name: pick(['x', 'y']) }
    if (rand() < 0.4) fields['parentId'] = pick(['f1', 'f2', 'f3'])
    ;(snap.entities['folder'] ??= {})[id] = { fields, stamps: Object.fromEntries(Object.keys(fields).map((k) => [k, mark()])) }
  }
  const tabs = ['t1', 't2', 't3', 't4'].filter(() => rand() < 0.6)
  for (const id of tabs) {
    const fields: Fields = { spaceId: pick(['s1', 's2']), pinned: true, anchorUrl: pick(['https://a.example/', 'https://b.example/']) }
    if (rand() < 0.4) fields['folderId'] = pick(['f1', 'f2', 'f3'])
    if (rand() < 0.3) fields['future'] = pick([1, 2, { z: 1 }])
    ;(snap.entities['tab'] ??= {})[id] = { fields, stamps: Object.fromEntries(Object.keys(fields).map((k) => [k, mark()])) }
  }
  if (role === 'side') {
    for (const [kind, id] of [['tab', 't5'], ['folder', 'f4'], ['tab', 't1']] as const) if (rand() < 0.3) (snap.tombstones[kind] ??= {})[id] = mark()
  }
  for (const key of ['tabs:s1:-', 'tabs:s2:-']) if (rand() < 0.6) {
    const ids = ['t1', 't2', 't3', 't4'].sort(() => rand() - 0.5)
    snap.order[key] = ids
    if (rand() < 0.7) snap.orderStamps[key] = mark()
  }
  return snap
}

describe('iOS contract: sync merge rules on random states (docs/synchronisation.md §11.9)', () => {
  const rand = seeded(20261118)
  const draws = Array.from({ length: 400 }, () => ({ base: rand() < 0.2 ? null : randomSnap(rand, 'base'), local: randomSnap(rand, 'side'), remote: randomSnap(rand, 'side') }))

  it('gives the same entities, tombstones and order when local and remote are exchanged', () => {
    for (const [i, d] of draws.entries()) {
      const there = merge(d.base, d.local, d.remote)
      const back = merge(d.base, d.remote, d.local)
      expect(stripUndefined(back.entities), `draw ${i}`).toEqual(stripUndefined(there.entities))
      expect(back.tombstones, `draw ${i}`).toEqual(there.tombstones)
      expect(back.order, `draw ${i}`).toEqual(there.order)
      expect(back.conflicts, `draw ${i}`).toEqual(there.conflicts.map(swapWinner).sort((a, b) => (a.kind + '\0' + a.id + '\0' + (a.field ?? '')).localeCompare(b.kind + '\0' + b.id + '\0' + (b.field ?? ''), 'en')))
    }
  })

  it('does not change a result that is merged again with itself', () => {
    for (const [i, d] of draws.entries()) {
      const first = merge(d.base, d.local, d.remote)
      const result = asSnap(first)
      const again = merge(result, result, result)
      expect(stripUndefined(again.entities), `draw ${i}`).toEqual(stripUndefined(first.entities))
      expect(again.tombstones, `draw ${i}`).toEqual(first.tombstones)
      expect(again.order, `draw ${i}`).toEqual(first.order)
    }
  })

  it('never leaves a reference that points at nothing, nor a cycle of folders', () => {
    for (const [i, d] of draws.entries()) {
      const merged = merge(d.base, d.local, d.remote)
      const spaces = new Set(Object.keys(merged.entities['space'] ?? {}))
      const folders = merged.entities['folder'] ?? {}
      for (const kind of ['folder', 'tab']) for (const ent of Object.values(merged.entities[kind] ?? {})) expect(spaces.has(String(ent.fields['spaceId'])), `draw ${i}`).toBe(true)
      for (const ent of Object.values(merged.entities['tab'] ?? {})) if (typeof ent.fields['folderId'] === 'string') expect(folders[ent.fields['folderId']], `draw ${i}`).toBeDefined()
      for (const id of Object.keys(folders)) {
        const seen = new Set<string>()
        for (let at: unknown = id; typeof at === 'string'; at = folders[at]?.fields['parentId']) {
          expect(seen.has(at), `draw ${i}: a cycle through ${at}`).toBe(false)
          seen.add(at)
          if (folders[at] === undefined) break
        }
      }
    }
  })

  it('keeps every field an entity of either side had that the specification does not make it lose', () => {
    // A field present on one side only, never in the base, is an addition on that side: it is in the result.
    for (const [i, d] of draws.entries()) {
      if (d.base !== null) continue
      const merged = merge(null, d.local, d.remote)
      for (const [id, ent] of Object.entries(d.local.entities['tab'] ?? {})) {
        const kept = merged.entities['tab']?.[id]
        if (kept === undefined) continue // dropped by a reference repair or a tombstone: covered above
        // `folderId` is left out: a reference to a folder that no longer exists is cleared on purpose (§11.7).
        for (const name of Object.keys(ent.fields).filter((n) => n !== 'folderId')) expect(name in kept.fields, `draw ${i} ${id}.${name}`).toBe(true)
      }
    }
  })

  it('actually draws conflicts, deletions and reorders (a generator that draws nothing proves nothing)', () => {
    const results = draws.map((d) => merge(d.base, d.local, d.remote))
    expect(results.some((r) => r.conflicts.some((c) => c.reason === 'newer'))).toBe(true)
    expect(results.some((r) => r.conflicts.some((c) => c.reason === 'modification-over-deletion'))).toBe(true)
    expect(results.some((r) => r.conflicts.some((c) => c.kind === 'order'))).toBe(true)
    expect(results.some((r) => Object.keys(r.tombstones).length > 0)).toBe(true)
  })
})
