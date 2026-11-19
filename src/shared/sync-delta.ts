// The difference between a snapshot and the base two devices share (docs/synchronisation.md §31): what a device sends instead of its whole snapshot when the other holds
// the same base, and what the other does to rebuild the snapshot from its own copy of the base. Pure and without Electron: LuciumKit has the same functions
// (`SyncDelta.swift`) and both are played against ios/Contracts/sync-delta-vectors.json.
//
// A difference names nothing by its kind: an entity of a kind this version does not know is compared like any other, so that it is never « removed » by a device that does
// not understand it (§11.6): the snapshot that is compared already carries such entities as the base holds them.
import { canonicalJson, compareUtf16 } from './sync-canonical'
import { emptySnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

/** An entity or a tombstone that the difference takes out of the base. */
export interface Removal {
  kind: string
  id: string
}

export interface SnapshotDelta {
  /** What is new or changed, in the form of a snapshot: the entities and the tombstones whole, the lists whole with their mark. */
  snapshot: SyncSnapshot
  removedEntities: Removal[]
  removedTombstones: Removal[]
  removedLists: string[]
}

const byRemoval = (a: Removal, b: Removal): number => compareUtf16(a.kind, b.kind) || compareUtf16(a.id, b.id)

const entityText = (entity: SyncEntity): string => canonicalJson(entity)

/** What `snapshot` has that `base` does not, and what `base` has that `snapshot` does not (docs/synchronisation.md §31.2). The removals are sorted by UTF-16 order. */
export function diffSnapshots(base: SyncSnapshot, snapshot: SyncSnapshot): SnapshotDelta {
  const delta: SnapshotDelta = { snapshot: emptySnapshot(), removedEntities: [], removedTombstones: [], removedLists: [] }
  for (const [kind, byId] of Object.entries(snapshot.entities)) {
    for (const [id, entity] of Object.entries(byId)) {
      const before = base.entities[kind]?.[id]
      if (before !== undefined && entityText(before) === entityText(entity)) continue
      ;(delta.snapshot.entities[kind] ??= {})[id] = entity
    }
  }
  for (const [kind, byId] of Object.entries(base.entities)) for (const id of Object.keys(byId)) if (snapshot.entities[kind]?.[id] === undefined) delta.removedEntities.push({ kind, id })
  for (const [kind, byId] of Object.entries(snapshot.tombstones)) {
    for (const [id, stamp] of Object.entries(byId)) if (base.tombstones[kind]?.[id] !== stamp) (delta.snapshot.tombstones[kind] ??= {})[id] = stamp
  }
  for (const [kind, byId] of Object.entries(base.tombstones)) for (const id of Object.keys(byId)) if (snapshot.tombstones[kind]?.[id] === undefined) delta.removedTombstones.push({ kind, id })
  // A list is its ids and its mark of order; a mark may stand without a list (the draws of the tests have them, a merge does not write them), and is compared on its own.
  for (const [key, ids] of Object.entries(snapshot.order)) {
    const before = base.order[key]
    const stamp = snapshot.orderStamps[key]
    if (before !== undefined && canonicalJson(before) === canonicalJson(ids) && base.orderStamps[key] === stamp) continue
    delta.snapshot.order[key] = ids
    if (stamp !== undefined) delta.snapshot.orderStamps[key] = stamp
  }
  for (const [key, stamp] of Object.entries(snapshot.orderStamps)) {
    if (snapshot.order[key] === undefined && (base.order[key] !== undefined || base.orderStamps[key] !== stamp)) delta.snapshot.orderStamps[key] = stamp
  }
  for (const key of new Set([...Object.keys(base.order), ...Object.keys(base.orderStamps)])) if (snapshot.order[key] === undefined && (base.order[key] !== undefined || snapshot.orderStamps[key] === undefined)) delta.removedLists.push(key)
  delta.removedEntities.sort(byRemoval)
  delta.removedTombstones.sort(byRemoval)
  delta.removedLists.sort(compareUtf16)
  return delta
}

/**
 * The snapshot a difference makes of a base (docs/synchronisation.md §31.3), or the reason it does not: a removal that names something the base does not hold, or a
 * `(kind, id)` that is both written and removed. The base is not changed. That the result is the snapshot the sender meant is the caller's to check (the count and the
 * digest of `snapshot.end`).
 */
export function applyDelta(base: SyncSnapshot, delta: SnapshotDelta): { snapshot: SyncSnapshot } | { problem: string } {
  const snapshot = structuredClone(base)
  for (const { kind, id } of delta.removedEntities) {
    if (snapshot.entities[kind]?.[id] === undefined) return { problem: 'a removed entity that the base does not hold' }
    if (delta.snapshot.entities[kind]?.[id] !== undefined) return { problem: 'an entity both written and removed' }
    delete snapshot.entities[kind]![id]
    if (Object.keys(snapshot.entities[kind]!).length === 0) delete snapshot.entities[kind]
  }
  for (const { kind, id } of delta.removedTombstones) {
    if (snapshot.tombstones[kind]?.[id] === undefined) return { problem: 'a removed tombstone that the base does not hold' }
    if (delta.snapshot.tombstones[kind]?.[id] !== undefined) return { problem: 'a tombstone both written and removed' }
    delete snapshot.tombstones[kind]![id]
    if (Object.keys(snapshot.tombstones[kind]!).length === 0) delete snapshot.tombstones[kind]
  }
  for (const key of delta.removedLists) {
    if (snapshot.order[key] === undefined && snapshot.orderStamps[key] === undefined) return { problem: 'a removed list that the base does not hold' }
    if (delta.snapshot.order[key] !== undefined) return { problem: 'a list both written and removed' }
    delete snapshot.order[key]
    delete snapshot.orderStamps[key]
  }
  for (const [kind, byId] of Object.entries(delta.snapshot.entities)) for (const [id, entity] of Object.entries(byId)) (snapshot.entities[kind] ??= {})[id] = structuredClone(entity)
  for (const [kind, byId] of Object.entries(delta.snapshot.tombstones)) for (const [id, stamp] of Object.entries(byId)) (snapshot.tombstones[kind] ??= {})[id] = stamp
  for (const [key, ids] of Object.entries(delta.snapshot.order)) {
    snapshot.order[key] = [...ids]
    if (delta.snapshot.orderStamps[key] === undefined) delete snapshot.orderStamps[key]
  }
  for (const [key, stamp] of Object.entries(delta.snapshot.orderStamps)) snapshot.orderStamps[key] = stamp
  return { snapshot }
}
