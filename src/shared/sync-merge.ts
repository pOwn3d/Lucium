// The three-way merge of docs/synchronisation.md §11: `mergeSnapshots(base, local, remote, withheld)`.
//
// Both devices call it with the same four inputs (each one's own snapshot being "local" to itself) and must get the same snapshot back: the digest of that
// snapshot is what they compare before either writes anything (§8.5). It is therefore a pure function of its inputs: no clock, no disk, no random number, no
// locale, and it changes nothing it was given. It is written twice, here and in LuciumKit (`SyncMerge.swift`), and ios/Contracts/sync-merge-vectors.json is
// played against both.
//
// The rules, in the order of the specification:
//   §11.2  an entity: added, deleted (when nobody touched it), kept (a modification beats a deletion), or merged field by field;
//   §11.3  a field: a change on one side is taken; the same change on both sides is no conflict; two different changes are settled by the greater mark;
//   §11.4  an order: a register per list;
//   §11.5  a deletion is a tombstone, and with no base the tombstone is what says "deleted";
//   §11.6  a field or a kind this version does not know goes through, as any other;
//   §11.7  references that point at nothing are repaired, folders that loop are cut, every conflict is listed.
import { canonicalJson, compareUtf16, sameJson, type JsonValue } from './sync-canonical'
import { cloneJson, maxStamp, minStamp, ZERO_STAMP, emptySnapshot, type SyncEntity, type SyncFields, type SyncSnapshot } from './sync-snapshot'

/** Which side won, from the point of view of the device that merges (the other device sees the same conflict with the sides exchanged). */
export type ConflictSide = 'local' | 'remote'

/**
 * Why. `newer`: the marks differ in their time or their counter; `device-id`: the same time and counter, the greater device id wins; `value`: the same mark on
 * both sides (a field never stamped), the greater canonical text wins; `modification-over-deletion`: an entity deleted on one side and changed on the other;
 * `order`: two different reorders of one list.
 */
export type ConflictReason = 'newer' | 'device-id' | 'value' | 'modification-over-deletion' | 'order'

export interface SyncConflict {
  kind: string
  id: string
  /** The field, or null for a whole entity (a deletion that lost) and for a list (kind `order`, id the list key). */
  field: string | null
  winner: ConflictSide
  reason: ConflictReason
}

export interface MergeResult {
  snapshot: SyncSnapshot
  /** Sorted by (kind, id, field), each compared by UTF-16 code unit, a missing field first. */
  conflicts: SyncConflict[]
}

/** The order the conflicts are listed in: the same on both devices, and in both languages. */
export function compareConflicts(a: Pick<SyncConflict, 'kind' | 'id' | 'field'>, b: Pick<SyncConflict, 'kind' | 'id' | 'field'>): number {
  return compareUtf16(a.kind, b.kind) || compareUtf16(a.id, b.id) || (a.field === null ? (b.field === null ? 0 : -1) : b.field === null ? 1 : compareUtf16(a.field, b.field))
}

/** The same conflict seen from the other device. */
export const otherSide = (side: ConflictSide): ConflictSide => (side === 'local' ? 'remote' : 'local')

/** What a mark says about the difference between two: the time or the counter (`newer`), only the device id (`device-id`), nothing (`value`). */
function reasonOf(a: string, b: string): ConflictReason {
  if (a === b) return 'value'
  const time = (mark: string): string => mark.split('-').slice(0, 2).join('-')
  return time(a) !== time(b) ? 'newer' : 'device-id'
}

// What belongs to what: the dependents of a space, and of a folder.
const SPACE_DEPENDENTS: readonly (readonly [string, string])[] = [['folder', 'spaceId'], ['tab', 'spaceId'], ['archived', 'spaceId']]
const FOLDER_DEPENDENTS: readonly (readonly [string, string])[] = [['folder', 'parentId'], ['tab', 'folderId'], ['archived', 'folderId']]

const ref = (fields: SyncFields, name: string): string | null => {
  const value = fields[name]
  return typeof value === 'string' ? value : null
}

/** The kind of the entities a list holds, by its key, so that a space set aside takes its own lists out and no other. */
function listKind(key: string): string | null {
  if (key === 'spaces') return 'space'
  if (key.startsWith('folders:')) return 'folder'
  if (key.startsWith('tabs:')) return 'tab'
  return null
}

/** The key of the list an entity is in, or null for a kind that has no order (`archived`, `setting`, a kind this version does not know). */
function listKeyOf(kind: string, fields: SyncFields): string | null {
  switch (kind) {
    case 'space':
      return 'spaces'
    case 'folder':
      return `folders:${ref(fields, 'spaceId') ?? '-'}:${ref(fields, 'parentId') ?? '-'}`
    case 'tab':
      return `tabs:${ref(fields, 'spaceId') ?? '-'}:${ref(fields, 'folderId') ?? '-'}`
    case 'favorite':
      return `favorites:${ref(fields, 'profileId') ?? '-'}`
    default:
      return null
  }
}

/**
 * §10.4 and §18: what belongs to a space set aside (the space, its folders, its tabs, its archive) is taken out of the three snapshots before anything is
 * compared, on both devices, so that nothing is added, changed or deleted for it and the result holds none of it. Tombstones stay: they protect
 * a deletion from being undone by an old copy when the space comes back.
 */
function withoutSpaces(snapshot: SyncSnapshot, spaces: ReadonlySet<string>): SyncSnapshot {
  if (spaces.size === 0) return snapshot
  const dropped: Record<string, Set<string>> = {}
  const entities: SyncSnapshot['entities'] = {}
  for (const [kind, byId] of Object.entries(snapshot.entities)) {
    const kept: Record<string, SyncEntity> = {}
    for (const [id, entity] of Object.entries(byId)) {
      const space = ref(entity.fields, 'spaceId')
      const belongs = (kind === 'space' && spaces.has(id)) || ((kind === 'folder' || kind === 'tab' || kind === 'archived') && space !== null && spaces.has(space))
      if (belongs) (dropped[kind] ??= new Set()).add(id)
      else kept[id] = entity
    }
    entities[kind] = kept
  }
  const order: SyncSnapshot['order'] = {}
  for (const [key, ids] of Object.entries(snapshot.order)) {
    const kind = listKind(key)
    const out = kind === null ? undefined : dropped[kind]
    order[key] = out === undefined ? ids : ids.filter((id) => !out.has(id))
  }
  return { ...snapshot, entities, order }
}

/**
 * The targets an entity was moved into, or created in, on one side since the base (§11.2: that counts as a modification of the target). Without a base there
 * is no "since the base": only the marks of the entity count (§11.5), so nothing has entered.
 */
function enteredTargets(side: SyncSnapshot, base: SyncSnapshot | null): Set<string> {
  const entered = new Set<string>()
  if (base === null) return entered
  const scan = (targetKind: string, dependents: readonly (readonly [string, string])[]): void => {
    for (const [childKind, field] of dependents) {
      for (const [childId, child] of Object.entries(side.entities[childKind] ?? {})) {
        const target = ref(child.fields, field)
        if (target === null) continue
        const before = base.entities[childKind]?.[childId]
        if (before === undefined || ref(before.fields, field) !== target) entered.add(`${targetKind}\u0000${target}`)
      }
    }
  }
  scan('space', SPACE_DEPENDENTS)
  scan('folder', FOLDER_DEPENDENTS)
  return entered
}

const canonicalOf = (value: unknown): string => (value === undefined ? '' : canonicalJson(value))

/** §11.3: one entity present on both sides, field by field. */
function mergeEntity(kind: string, id: string, base: SyncEntity | undefined, local: SyncEntity, remote: SyncEntity, conflicts: SyncConflict[]): SyncEntity {
  const names = new Set([...Object.keys(base?.fields ?? {}), ...Object.keys(local.fields), ...Object.keys(remote.fields), ...Object.keys(local.stamps), ...Object.keys(remote.stamps)])
  const fields: SyncFields = {}
  const stamps: Record<string, string> = {}
  for (const name of names) {
    const b = base?.fields[name]
    const l = local.fields[name]
    const r = remote.fields[name]
    const sl = local.stamps[name] ?? ZERO_STAMP
    const sr = remote.stamps[name] ?? ZERO_STAMP
    const changedLocal = !sameJson(l, b)
    const changedRemote = !sameJson(r, b)
    let value: JsonValue | undefined
    let stamp: string
    if (!changedLocal && !changedRemote) {
      value = b
      stamp = maxStamp(sl, sr)
    } else if (changedLocal && !changedRemote) {
      value = l
      stamp = sl
    } else if (!changedLocal && changedRemote) {
      value = r
      stamp = sr
    } else if (sameJson(l, r)) {
      value = l
      stamp = maxStamp(sl, sr)
    } else {
      // Both changed it, differently: the greater mark wins (the greater device id at the same time and counter); equal marks (a field never stamped on
      // either side): the greater canonical text, which is arbitrary but is the same on both devices.
      const remoteWins = sl === sr ? compareUtf16(canonicalOf(r), canonicalOf(l)) > 0 : compareUtf16(sr, sl) > 0
      value = remoteWins ? r : l
      stamp = remoteWins ? sr : sl
      conflicts.push({ kind, id, field: name, winner: remoteWins ? 'remote' : 'local', reason: reasonOf(sl, sr) })
    }
    if (value !== undefined) fields[name] = value
    // The mark of a field that is absent and was never stamped says nothing, and two devices would not write it alike (§8.3): it is not kept.
    if (value !== undefined || stamp !== ZERO_STAMP) stamps[name] = stamp
  }
  return { fields, stamps }
}

/**
 * `fusion(base, local, distant, withheld)` of §11.1. `base` is null when there is none (a first session, a base that does not match the other device's,
 * a last session more than 30 days ago: §11.8): the merge then takes every entity of one side only for an addition. `withheld` is the union of the ids of
 * the spaces each device set aside (§18).
 *
 * The inputs are snapshots that went through `parseSnapshot` (or came out of this function); they are not changed.
 */
export function mergeSnapshots(baseIn: SyncSnapshot | null, localIn: SyncSnapshot, remoteIn: SyncSnapshot, withheld: readonly string[] = []): MergeResult {
  const aside = new Set(withheld)
  const base = baseIn === null ? null : withoutSpaces(baseIn, aside)
  const local = withoutSpaces(localIn, aside)
  const remote = withoutSpaces(remoteIn, aside)
  const conflicts: SyncConflict[] = []
  const result = emptySnapshot()
  const entities = result.entities
  const tombstones = result.tombstones
  // What it keeps is a copy, so that the repairs below never change what it was given.
  const put = (kind: string, id: string, entity: SyncEntity): void => {
    ;(entities[kind] ??= {})[id] = { fields: cloneJson(entity.fields) as SyncFields, stamps: { ...entity.stamps } }
  }
  const bury = (kind: string, id: string, mark: string): void => {
    ;(tombstones[kind] ??= {})[id] = mark
  }
  const enteredLocal = lazy(() => enteredTargets(local, base))
  const enteredRemote = lazy(() => enteredTargets(remote, base))

  // §11.2 and §11.5: each entity, then each deletion.
  const kinds = new Set([...Object.keys(base?.entities ?? {}), ...Object.keys(local.entities), ...Object.keys(remote.entities), ...Object.keys(local.tombstones), ...Object.keys(remote.tombstones)])
  for (const kind of kinds) {
    const ids = new Set([...Object.keys(base?.entities[kind] ?? {}), ...Object.keys(local.entities[kind] ?? {}), ...Object.keys(remote.entities[kind] ?? {}), ...Object.keys(local.tombstones[kind] ?? {}), ...Object.keys(remote.tombstones[kind] ?? {})])
    for (const id of ids) {
      const b = base?.entities[kind]?.[id]
      const l = local.entities[kind]?.[id]
      const r = remote.entities[kind]?.[id]
      const tombLocal = local.tombstones[kind]?.[id]
      const tombRemote = remote.tombstones[kind]?.[id]
      if (l !== undefined && r !== undefined) {
        put(kind, id, mergeEntity(kind, id, b, l, r, conflicts))
        continue
      }
      if (l === undefined && r === undefined) {
        // Gone from both sides: stays gone, and the greater of the two marks is kept.
        if (b !== undefined || tombLocal !== undefined || tombRemote !== undefined) bury(kind, id, maxStamp(tombLocal ?? ZERO_STAMP, tombRemote ?? ZERO_STAMP))
        continue
      }
      const keptSide: ConflictSide = l !== undefined ? 'local' : 'remote'
      const kept = (l ?? r) as SyncEntity
      const otherTombstone = l !== undefined ? tombRemote : tombLocal
      if (b === undefined && otherTombstone === undefined) {
        put(kind, id, kept) // an addition
        continue
      }
      // The other side deleted it. With a base, "modified" is a change of a field, or something put into it since the base (§11.2); with none, it is a mark
      // later than the tombstone (§11.5).
      const modified =
        b !== undefined
          ? !sameJson(kept.fields, b.fields) || (keptSide === 'local' ? enteredLocal() : enteredRemote()).has(`${kind}\u0000${id}`)
          : compareUtf16(maxStamp(...Object.values(kept.stamps)), otherTombstone as string) > 0
      if (modified) {
        put(kind, id, kept)
        conflicts.push({ kind, id, field: null, winner: keptSide, reason: 'modification-over-deletion' })
      } else {
        bury(kind, id, otherTombstone ?? ZERO_STAMP)
      }
    }
  }

  // §11.7.1: what belongs to a space that is not there is removed, and leaves a tombstone marked with its own latest change (a later change elsewhere brings
  // it back, and it is removed again: that is what makes the merge idempotent).
  const spaceIds = new Set(Object.keys(entities['space'] ?? {}))
  for (const kind of ['folder', 'tab', 'archived']) {
    const byId = entities[kind]
    if (byId === undefined) continue
    for (const [id, entity] of Object.entries(byId)) {
      const space = ref(entity.fields, 'spaceId')
      if (space !== null && spaceIds.has(space)) continue
      delete byId[id]
      bury(kind, id, maxStamp(...Object.values(entity.stamps)))
    }
  }
  // A folder or a parent that is not there: the entity goes back to the root, its mark kept (unless it says nothing).
  const folderIds = new Set(Object.keys(entities['folder'] ?? {}))
  for (const [kind, field] of [['tab', 'folderId'], ['archived', 'folderId'], ['folder', 'parentId']] as const) {
    for (const entity of Object.values(entities[kind] ?? {})) {
      const target = ref(entity.fields, field)
      if (target === null || folderIds.has(target)) continue
      delete entity.fields[field]
      if (entity.stamps[field] === ZERO_STAMP) delete entity.stamps[field]
    }
  }
  // §11.7.2: folders that loop. A folder has one parent, so the cycles are apart: each is cut at the folder whose id is the smallest, in one pass.
  breakCycles(entities['folder'] ?? {})
  for (const kind of Object.keys(entities)) if (Object.keys(entities[kind] as object).length === 0) delete entities[kind]

  mergeOrder(base, local, remote, entities, result, conflicts)
  conflicts.sort(compareConflicts)
  return { snapshot: result, conflicts }
}

function lazy<T>(make: () => T): () => T {
  let value: T | undefined
  return () => (value ??= make())
}

/** §11.7.2: the `parentId` of the folder with the smallest id of each cycle is cleared (its mark kept, unless it says nothing). */
function breakCycles(folders: Record<string, SyncEntity>): void {
  const state = new Map<string, 'walking' | 'done'>()
  for (const start of Object.keys(folders)) {
    if (state.has(start)) continue
    const path: string[] = []
    let at: string | null = start
    while (at !== null && folders[at] !== undefined && !state.has(at)) {
      state.set(at, 'walking')
      path.push(at)
      at = ref((folders[at] as SyncEntity).fields, 'parentId')
    }
    if (at !== null && state.get(at) === 'walking' && path.includes(at)) {
      const cycle = path.slice(path.indexOf(at))
      const smallest = cycle.reduce((a, b) => (compareUtf16(a, b) <= 0 ? a : b))
      const broken = folders[smallest] as SyncEntity
      delete broken.fields['parentId']
      if (broken.stamps['parentId'] === ZERO_STAMP) delete broken.stamps['parentId']
    }
    for (const id of path) state.set(id, 'done')
  }
}

/** §11.4: the order of each list is a register of its own, not a field of each entity. */
function mergeOrder(base: SyncSnapshot | null, local: SyncSnapshot, remote: SyncSnapshot, entities: SyncSnapshot['entities'], result: SyncSnapshot, conflicts: SyncConflict[]): void {
  const members = new Map<string, { id: string; entity: SyncEntity }[]>()
  for (const [kind, byId] of Object.entries(entities)) {
    for (const [id, entity] of Object.entries(byId)) {
      const key = listKeyOf(kind, entity.fields)
      if (key === null) continue
      const list = members.get(key)
      if (list === undefined) members.set(key, [{ id, entity }])
      else list.push({ id, entity })
    }
  }
  const keys = new Set([...Object.keys(base?.order ?? {}), ...Object.keys(local.order), ...Object.keys(remote.order), ...members.keys()])
  for (const key of keys) {
    const present = new Map((members.get(key) ?? []).map((member) => [member.id, member.entity] as const))
    const ob = base?.order[key] ?? []
    const ol = local.order[key] ?? []
    const or = remote.order[key] ?? []
    const sl = local.orderStamps[key] ?? ZERO_STAMP
    const sr = remote.orderStamps[key] ?? ZERO_STAMP
    // A side "reordered" when, among the ids its list shares with the base's, the relative order is not the base's.
    const reordered = (side: readonly string[]): boolean => {
      const inBase = new Set(ob)
      const inSide = new Set(side)
      const a = side.filter((id) => inBase.has(id))
      const b = ob.filter((id) => inSide.has(id))
      return a.length !== b.length || a.some((id, index) => id !== b[index])
    }
    const reorderedLocal = reordered(ol)
    const reorderedRemote = reordered(or)
    let chosen: readonly string[] = ob
    if (reorderedLocal && reorderedRemote && ol.length === or.length && ol.every((id, index) => id === or[index])) {
      chosen = ol // the same reorder on both sides is not a conflict
    } else if (reorderedLocal && reorderedRemote) {
      // Two different reorders: the list with the greater mark wins (at equal marks, the greater canonical text); what the other side added goes to the end.
      const remoteWins = sl === sr ? compareUtf16(canonicalJson(or), canonicalJson(ol)) > 0 : compareUtf16(sr, sl) > 0
      chosen = remoteWins ? or : ol
      conflicts.push({ kind: 'order', id: key, field: null, winner: remoteWins ? 'remote' : 'local', reason: 'order' })
    } else if (reorderedLocal) {
      chosen = ol
    } else if (reorderedRemote) {
      chosen = or
    }
    const kept = [...new Set(chosen.filter((id) => present.has(id)))]
    const inKept = new Set(kept)
    const birth = (id: string): string => minStamp(Object.values((present.get(id) as SyncEntity).stamps))
    // What is not in the chosen list (added, or arrived from the other side) goes to the end, the oldest birth first, then by id.
    const added = [...present.keys()].filter((id) => !inKept.has(id)).sort((a, b) => compareUtf16(birth(a), birth(b)) || compareUtf16(a, b))
    const final = [...kept, ...added]
    // A list with no member is not written, and neither is its mark: a mark with no list would be dropped by the next merge (which reads the keys of the
    // lists), and a result that changes when it is merged again is not idempotent.
    if (final.length === 0) continue
    result.order[key] = final
    const stamp = maxStamp(sl, sr)
    if (stamp !== ZERO_STAMP) result.orderStamps[key] = stamp
  }
}
