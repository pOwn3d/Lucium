// The snapshot a device freezes at the start of a synchronisation session and the marks it carries (docs/synchronisation.md §8.3 and §9.2). This is the
// form the three-way merge (sync-merge.ts) reads and writes, and the form of what travels in `snapshot.part`. `parseSnapshot` is the door a received one goes
// through: a snapshot that did not come out of it, or out of the merge itself, is not given to the merge.
//
// The content of an entity (which fields a kind may carry, which settings may travel, which address is safe) is another gate, applied to the entities that
// come in (the `inbound` vectors of sync-message-vectors.json): this file reads the *form* only.
import { compareUtf16, type JsonValue } from './sync-canonical'

/** The mark of a field that was never stamped: smaller than every other mark. */
export const ZERO_STAMP = '0'

/** `<ms on 13 digits>-<counter on 4 lower-case hexadecimal digits>-<device id>`, or "0" (§9.2). */
const STAMP_PATTERN = /^(?:0|[0-9]{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64})$/

export const isStamp = (value: unknown): value is string => typeof value === 'string' && STAMP_PATTERN.test(value)

/**
 * Marks are compared as text, byte for byte (§9.2): they are ASCII, so the order of the UTF-16 code units is the order of the bytes, and also the order
 * LuciumKit gives them. "0" is below every other mark: another mark either starts with a greater digit or, when it starts with "0", is longer and has "0" as
 * its prefix (the vectors `stamps` fix this).
 */
export const compareStamps = compareUtf16

export const maxStamp = (...stamps: string[]): string => stamps.reduce((a, b) => (compareStamps(a, b) >= 0 ? a : b), ZERO_STAMP)

export const minStamp = (stamps: readonly string[]): string => (stamps.length === 0 ? ZERO_STAMP : stamps.reduce((a, b) => (compareStamps(a, b) <= 0 ? a : b)))

export type SyncFields = Record<string, JsonValue>

/** One entity: its fields (the synchronised ones and every field this version does not know) and one mark per field, removed fields included. */
export interface SyncEntity {
  fields: SyncFields
  stamps: Record<string, string>
}

export interface SyncSnapshot {
  /** kind → id → entity. A kind this version does not know goes through. */
  entities: Record<string, Record<string, SyncEntity>>
  /** kind → id → the mark of the deletion. */
  tombstones: Record<string, Record<string, string>>
  /** list key → the ids in display order (`spaces`, `folders:<space>:<parent or ->`, `tabs:<space>:<folder or ->`, `favorites:<profile>`). */
  order: Record<string, string[]>
  /** list key → the mark of the last reorder. */
  orderStamps: Record<string, string>
}

export const emptySnapshot = (): SyncSnapshot => ({ entities: {}, tombstones: {}, order: {}, orderStamps: {} })

/** Limits of a received snapshot: the bounds of docs/synchronisation.md §7.5 that apply to the form (the sizes of the frames are the message layer's). */
export const SNAPSHOT_LIMITS = {
  maxEntities: 100_000,
  maxIdChars: 128,
  maxKindChars: 64,
  maxFieldNameChars: 128,
  maxListKeyChars: 400,
  maxListLength: 100_000,
  maxJsonDepth: 32,
  maxStringChars: 65_536,
} as const

export type SnapshotProblem = string

/**
 * Whether a plain object already answers to this name before anyone writes to it: `__proto__`, `constructor`, `toString`, `hasOwnProperty`… Used as a kind or an id,
 * such a name makes `record[name] ??= {}` take the prototype (or a function of it) for the record and write the next key into it: the prototype of every object of the
 * process, or `Object` itself, gets a property a stranger chose. The same names read back as a function where a missing entry was expected. Refused wherever a name
 * becomes a key (the wire, the files, this reader); a name a later version of Object.prototype gains is refused too, because the test is the object itself.
 */
export const isInheritedName = (name: string): boolean => name === 'prototype' || name in Object.prototype

/** A name that is used as a key of a record must not be one a plain object already has (`isInheritedName`), nor hold a control character. */
const isKeyName = (key: string, max: number): boolean => key.length >= 1 && key.length <= max && !isInheritedName(key) && !/[\u0000-\u001f\u007f]/.test(key) && isNormalized(key)

/**
 * A key must be in normalization form C. Swift treats two keys that differ only by their normalization ("é" in one scalar and in two) as one key of a
 * dictionary, where JavaScript keeps two: a snapshot with both would give the two devices different entities. With every key in form C, two keys that
 * are told apart here are told apart there.
 */
const isNormalized = (key: string): boolean => key.normalize('NFC') === key

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function jsonProblem(value: unknown, depth: number, path: string): SnapshotProblem | null {
  if (depth > SNAPSHOT_LIMITS.maxJsonDepth) return `${path}: too deep`
  if (value === null || typeof value === 'boolean') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path}: a number that is not finite`
    // §7.1: no exponent in the text of a number, so that Swift and JavaScript write the same digits (the message layer enforces the same bounds on the wire).
    if (Math.abs(value) >= 1e21 || (value !== 0 && Math.abs(value) < 1e-6)) return `${path}: a number out of the range both languages write alike`
    return null
  }
  if (typeof value === 'string') return value.length > SNAPSHOT_LIMITS.maxStringChars ? `${path}: a string that is too long` : null
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = jsonProblem(item, depth + 1, `${path}[${index}]`)
      if (problem !== null) return problem
    }
    return null
  }
  if (isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      if (key === '__proto__') return `${path}: a __proto__ key`
      if (!isNormalized(key)) return `${path}: a key that is not in normalization form C`
      const problem = jsonProblem(member, depth + 1, `${path}.${key}`)
      if (problem !== null) return problem
    }
    return null
  }
  return `${path}: not a JSON value`
}

/**
 * Reads a snapshot from what was received (or read from a file): the form of §8.3 or a reason. A member the form does not name is left out (a newer
 * version may add one: §7.1). `-0` is read as `0` (§7.1). The result shares nothing with the input.
 *
 * Refused: an entity that is not `{fields, stamps}` with `fields` an object and every mark of `stamps` well formed; a name that is empty, too long, `__proto__`,
 * made of control characters or not in normalization form C, as a kind, an id, a field, a list key; a `__proto__` key at any depth; a depth over 32; a number the two languages do not write alike;
 * more than 100 000 entities; a list that is not a list of ids.
 */
export function parseSnapshot(input: unknown): { snapshot: SyncSnapshot } | { problem: SnapshotProblem } {
  if (!isPlainObject(input)) return { problem: 'the snapshot is not an object' }
  const snapshot = emptySnapshot()
  let count = 0
  let tombstoneCount = 0

  const entities = input['entities'] ?? {}
  if (!isPlainObject(entities)) return { problem: 'entities: not an object' }
  for (const [kind, byId] of Object.entries(entities)) {
    if (!isKeyName(kind, SNAPSHOT_LIMITS.maxKindChars)) return { problem: `entities: a kind with a bad name` }
    if (!isPlainObject(byId)) return { problem: `entities.${kind}: not an object` }
    const into: Record<string, SyncEntity> = {}
    for (const [id, raw] of Object.entries(byId)) {
      if (!isKeyName(id, SNAPSHOT_LIMITS.maxIdChars)) return { problem: `entities.${kind}: an id with a bad name` }
      if (++count > SNAPSHOT_LIMITS.maxEntities) return { problem: 'too many entities' }
      if (!isPlainObject(raw)) return { problem: `entities.${kind}.${id}: not an object` }
      const { fields, stamps } = raw
      if (!isPlainObject(fields) || !isPlainObject(stamps)) return { problem: `entities.${kind}.${id}: fields and stamps must be objects` }
      const entity: SyncEntity = { fields: {}, stamps: {} }
      for (const [name, value] of Object.entries(fields)) {
        if (!isKeyName(name, SNAPSHOT_LIMITS.maxFieldNameChars)) return { problem: `entities.${kind}.${id}: a field with a bad name` }
        const problem = jsonProblem(value, 1, `entities.${kind}.${id}.${name}`)
        if (problem !== null) return { problem }
        entity.fields[name] = cloneJson(value as JsonValue)
      }
      for (const [name, mark] of Object.entries(stamps)) {
        if (!isKeyName(name, SNAPSHOT_LIMITS.maxFieldNameChars)) return { problem: `entities.${kind}.${id}: a mark with a bad name` }
        if (!isStamp(mark)) return { problem: `entities.${kind}.${id}.${name}: a mark in a form that is not the specification's` }
        entity.stamps[name] = mark
      }
      into[id] = entity
    }
    if (Object.keys(into).length > 0) snapshot.entities[kind] = into
  }

  const tombstones = input['tombstones'] ?? {}
  if (!isPlainObject(tombstones)) return { problem: 'tombstones: not an object' }
  for (const [kind, byId] of Object.entries(tombstones)) {
    if (!isKeyName(kind, SNAPSHOT_LIMITS.maxKindChars)) return { problem: 'tombstones: a kind with a bad name' }
    if (!isPlainObject(byId)) return { problem: `tombstones.${kind}: not an object` }
    const into: Record<string, string> = {}
    for (const [id, mark] of Object.entries(byId)) {
      if (!isKeyName(id, SNAPSHOT_LIMITS.maxIdChars)) return { problem: `tombstones.${kind}: an id with a bad name` }
      if (!isStamp(mark)) return { problem: `tombstones.${kind}.${id}: a mark in a form that is not the specification's` }
      if (++tombstoneCount > SNAPSHOT_LIMITS.maxEntities) return { problem: 'too many tombstones' }
      into[id] = mark
    }
    if (Object.keys(into).length > 0) snapshot.tombstones[kind] = into
  }

  const order = input['order'] ?? {}
  if (!isPlainObject(order)) return { problem: 'order: not an object' }
  for (const [key, ids] of Object.entries(order)) {
    if (!isKeyName(key, SNAPSHOT_LIMITS.maxListKeyChars)) return { problem: 'order: a list with a bad key' }
    if (!Array.isArray(ids) || ids.length > SNAPSHOT_LIMITS.maxListLength) return { problem: `order.${key}: not a list, or too long` }
    for (const id of ids) if (typeof id !== 'string' || !isKeyName(id, SNAPSHOT_LIMITS.maxIdChars)) return { problem: `order.${key}: an id with a bad name` }
    snapshot.order[key] = [...(ids as string[])]
  }

  const orderStamps = input['orderStamps'] ?? {}
  if (!isPlainObject(orderStamps)) return { problem: 'orderStamps: not an object' }
  for (const [key, mark] of Object.entries(orderStamps)) {
    if (!isKeyName(key, SNAPSHOT_LIMITS.maxListKeyChars)) return { problem: 'orderStamps: a list with a bad key' }
    if (!isStamp(mark)) return { problem: `orderStamps.${key}: a mark in a form that is not the specification's` }
    snapshot.orderStamps[key] = mark
  }
  return { snapshot }
}

/** A deep copy of a JSON value, `-0` written as `0`. */
export function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return typeof value === 'number' && Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) return value.map(cloneJson)
  const copy: { [key: string]: JsonValue } = {}
  for (const key of Object.keys(value)) copy[key] = cloneJson(value[key] as JsonValue)
  return copy
}
