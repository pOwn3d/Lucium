// The marks of the synchronisation (docs/synchronisation.md §9.2, §11.5): one mark per field, made by a hybrid logical clock the moment the device sees the field change.
// A mark is `<ms on 13 digits>-<counter on 4 lower-case hexadecimal digits>-<device id>`, compared as text. The clock never goes back and never falls behind a mark it
// has seen: `observe` is told every mark that comes in, so that what the person does next is later than what the other device did before.
//
// The book keeps, for each field of each entity, the hash of the value it last saw and the mark it gave. `update` compares the state as it is with the book: a field whose
// hash changed gets a new mark, a field that went gets one too (a removed field has a mark), an entity that went leaves a tombstone, a list whose order changed gets
// a new mark. What the book holds is only hashes and marks: no address, no title, nothing the person wrote.
//
// What the book follows is the synchronised class and the unknown fields of an entity: never the seeds (the page a pinned tab is on changes with each navigation and is
// noise) and never the local fields. It follows every category, ticked or not: an entity must not look deleted because its category was unticked for a while.

import { createHash } from 'node:crypto'
import { canonicalJson } from '@shared/sync-canonical'
import { ZERO_STAMP, compareStamps, type SyncSnapshot } from '@shared/sync-snapshot'
import { STAMP_FUTURE_REFUSE_MS, TOMBSTONE_DAYS } from './limits'

const DAY_MS = 86_400_000

interface Clock {
  ms: number
  counter: number
}

/** The largest time thirteen digits hold: a mark is `<ms on 13 digits>-…`, and one with more digits is not a mark (§9.2). */
const MAX_MS = 9_999_999_999_999

/** The list keys are made of the kind they order (`spaces`, `folders:<space>:<parent>`, `tabs:<space>:<folder>`, `today:<space>`, `favorites:<profile>`): the kind, or null for a key of no kind this version knows. */
export function listKindOf(key: string): 'space' | 'folder' | 'tab' | 'todayTab' | 'favorite' | null {
  const head = key.split(':')[0]
  return head === 'spaces' ? 'space' : head === 'folders' ? 'folder' : head === 'tabs' ? 'tab' : head === 'today' ? 'todayTab' : head === 'favorites' ? 'favorite' : null
}

const pad = (ms: number, counter: number, device: string): string => `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`

function parse(stamp: string): Clock | null {
  const match = /^([0-9]{13})-([0-9a-f]{4})-/.exec(stamp)
  return match === null ? null : { ms: Number(match[1]), counter: Number.parseInt(match[2] as string, 16) }
}

/** The hybrid logical clock of one device. */
export class Hlc {
  constructor(
    private readonly device: string,
    private last: Clock = { ms: 0, counter: 0 }
  ) {}

  /**
   * The next mark: the time of day, or one tick after the last mark made or seen when the time of day is not ahead of it. A clock more than a week ahead of the time of
   * day, or at the end of what thirteen digits hold, was wrong (the time of day was put right since, or the file was spoilt): every other device refuses marks that far ahead
   * (§9.3), so staying on them would shut this device out of the synchronisation for ever. It starts over from the time of day.
   */
  next(now: number): string {
    if (this.last.ms > now + STAMP_FUTURE_REFUSE_MS || this.last.ms >= MAX_MS) this.last = { ms: 0, counter: 0 }
    if (now > this.last.ms) this.last = { ms: now, counter: 0 }
    else if (this.last.counter >= 0xffff) this.last = { ms: this.last.ms + 1, counter: 0 }
    else this.last = { ms: this.last.ms, counter: this.last.counter + 1 }
    return pad(this.last.ms, this.last.counter, this.device)
  }

  /** A mark that came in: the clock is never behind it. */
  observe(stamp: string): void {
    const seen = parse(stamp)
    if (seen !== null && (seen.ms > this.last.ms || (seen.ms === this.last.ms && seen.counter > this.last.counter))) this.last = seen
  }

  state(): Clock {
    return { ...this.last }
  }
}

/** What the state holds, as the book reads it: every synchronised entity with its synchronised fields, and the order of every list. */
export interface TrackedView {
  entities: Record<string, Record<string, Record<string, unknown>>>
  order: Record<string, string[]>
}

interface FieldMark {
  /** The hash of the value, or null when the field is gone (its mark stays: a removal is a change). */
  hash: string | null
  stamp: string
}

/**
 * The format of the file. 2 (card 508): the book also holds the Today tabs that are admitted to the shared set (§27.3, kind `todayTab`): the shape is the one of 1, but a
 * version that reads a 2 and does not know the kind would drop those marks without a word and, when the file is read again by a newer one, read every admitted tab as new.
 * It does not know the format, so it sets the file aside and starts a book of its own (the case of a base that is lost, §11.8) instead.
 */
export const MARKS_VERSION = 2

export interface MarksFile {
  version: typeof MARKS_VERSION
  clock: Clock
  entities: Record<string, Record<string, Record<string, FieldMark>>>
  tombstones: Record<string, Record<string, string>>
  orders: Record<string, { hash: string; stamp: string }>
}

const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)

export class MarkBook {
  readonly clock: Hlc
  private entities: MarksFile['entities']
  private tombstones: MarksFile['tombstones']
  private orders: MarksFile['orders']

  constructor(
    readonly device: string,
    file: MarksFile | null = null
  ) {
    this.clock = new Hlc(device, file?.clock)
    this.entities = file?.entities ?? {}
    this.tombstones = file?.tombstones ?? {}
    this.orders = file?.orders ?? {}
  }

  /** Brings the book up to the state: a mark for what changed since it last looked, a tombstone for what went. Cheap when nothing changed. */
  update(view: TrackedView, now: number): void {
    // A mark more than a week ahead of the time of day was made while the clock was wrong (review n° 18): no other device accepts it, so the thing it marks would never
    // leave this one. It is marked again, as a change of now.
    const limit = now + STAMP_FUTURE_REFUSE_MS
    const tooFar = (stamp: string): boolean => (parse(stamp)?.ms ?? 0) > limit
    for (const [kind, byId] of Object.entries(view.entities)) {
      const known = (this.entities[kind] ??= {})
      for (const [id, fields] of Object.entries(byId)) {
        const record = (known[id] ??= {})
        if (this.tombstones[kind]?.[id] !== undefined) delete this.tombstones[kind][id]
        for (const [name, value] of Object.entries(fields)) {
          const hash = hashOf(value)
          const mark = record[name]
          if (mark?.hash !== hash || tooFar(mark.stamp)) record[name] = { hash, stamp: this.clock.next(now) }
        }
        for (const [name, mark] of Object.entries(record)) {
          if (mark.hash !== null && !Object.hasOwn(fields, name)) record[name] = { hash: null, stamp: this.clock.next(now) }
          else if (mark.hash === null && tooFar(mark.stamp)) record[name] = { hash: null, stamp: this.clock.next(now) }
        }
      }
      for (const id of Object.keys(known)) {
        if (Object.hasOwn(byId, id)) continue
        // The entity went: a tombstone, and nothing else of it is kept.
        if (Object.values(known[id] as Record<string, FieldMark>).some((mark) => mark.hash !== null)) (this.tombstones[kind] ??= {})[id] = this.clock.next(now)
        delete known[id]
      }
    }
    for (const kind of Object.keys(this.entities)) if (!Object.hasOwn(view.entities, kind)) delete this.entities[kind]
    for (const [key, ids] of Object.entries(view.order)) {
      const hash = hashOf(ids)
      const mark = this.orders[key]
      if (mark?.hash !== hash || tooFar(mark.stamp)) this.orders[key] = { hash, stamp: this.clock.next(now) }
    }
    for (const key of Object.keys(this.orders)) if (!Object.hasOwn(view.order, key)) delete this.orders[key]
    for (const byId of Object.values(this.tombstones)) for (const [id, stamp] of Object.entries(byId)) if (tooFar(stamp)) byId[id] = this.clock.next(now)
    this.purge(now)
  }

  /** The tombstones older than thirty days are forgotten (§11.5): a device away for longer than that may see what it deleted come back. */
  purge(now: number): void {
    const limit = now - TOMBSTONE_DAYS * DAY_MS
    for (const [kind, byId] of Object.entries(this.tombstones)) {
      for (const [id, stamp] of Object.entries(byId)) if ((parse(stamp)?.ms ?? 0) < limit) delete byId[id]
      if (Object.keys(byId).length === 0) delete this.tombstones[kind]
    }
  }

  /** Whether the book holds the entity: for a Today tab, whether it is admitted to the shared set (§27.3: the admission is kept here, by device). */
  knows(kind: string, id: string): boolean {
    return this.entities[kind]?.[id] !== undefined
  }

  /** The marks of an entity, one per field it has or has lost. */
  stampsOf(kind: string, id: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.entities[kind]?.[id] ?? {}).map(([name, mark]) => [name, mark.stamp]))
  }

  tombstonesOf(): Record<string, Record<string, string>> {
    return JSON.parse(JSON.stringify(this.tombstones)) as Record<string, Record<string, string>>
  }

  orderStampOf(key: string): string {
    return this.orders[key]?.stamp ?? ZERO_STAMP
  }

  /**
   * The state now holds what the merge decided: the book takes the marks of the merged snapshot, so that the next `update` sees nothing new in what came from the other
   * device (it would otherwise mark it as this device's change, and send it back). Fields the book does not follow (seeds, local) are left out.
   */
  adopt(merged: SyncSnapshot, follows: (kind: string, field: string) => boolean, exchanged: (kind: string) => boolean = () => true, aside: Aside = NOTHING_ASIDE): void {
    // What the session did not exchange (a category that was not ticked on both devices) is not in the merged snapshot, and is not forgotten with it: its marks and its
    // tombstones stay as they were, or its fields would take a mark of the moment at the next look and its deletions could come back (review n° 17).
    const entities: MarksFile['entities'] = {}
    for (const [kind, byKind] of Object.entries(this.entities)) if (!exchanged(kind)) entities[kind] = byKind
    // What the session set aside (the spaces that are locked: nothing of them was sent or taken) is not in the merged snapshot either: its marks stay too, or the changes the
    // other device made meanwhile would win over the ones made here once the space opens, or the reverse (second pass of the review).
    for (const [kind, byId] of Object.entries(this.entities)) {
      if (!exchanged(kind)) continue
      for (const [id, record] of Object.entries(byId)) if (aside.entity(kind, id) && merged.entities[kind]?.[id] === undefined) (entities[kind] ??= {})[id] = record
    }
    for (const [kind, byId] of Object.entries(merged.entities)) {
      for (const [id, entity] of Object.entries(byId)) {
        const record: Record<string, FieldMark> = {}
        for (const [name, stamp] of Object.entries(entity.stamps)) {
          if (!follows(kind, name)) continue
          this.clock.observe(stamp)
          record[name] = { hash: Object.hasOwn(entity.fields, name) ? hashOf(entity.fields[name]) : null, stamp }
        }
        for (const [name, value] of Object.entries(entity.fields)) if (follows(kind, name) && record[name] === undefined) record[name] = { hash: hashOf(value), stamp: ZERO_STAMP }
        ;(entities[kind] ??= {})[id] = record
      }
    }
    this.entities = entities
    const tombstones = JSON.parse(JSON.stringify(merged.tombstones)) as MarksFile['tombstones']
    for (const [kind, byId] of Object.entries(this.tombstones)) if (!exchanged(kind)) tombstones[kind] = byId
    this.tombstones = tombstones
    for (const byId of Object.values(merged.tombstones)) for (const stamp of Object.values(byId)) this.clock.observe(stamp)
    const orders: MarksFile['orders'] = {}
    for (const [key, order] of Object.entries(this.orders)) {
      const kind = listKindOf(key)
      if (kind !== null && !exchanged(kind)) orders[key] = order
      else if (aside.list(key) && merged.order[key] === undefined) orders[key] = order
    }
    for (const [key, ids] of Object.entries(merged.order)) orders[key] = { hash: hashOf(ids), stamp: merged.orderStamps[key] ?? ZERO_STAMP }
    this.orders = orders
    for (const stamp of Object.values(merged.orderStamps)) this.clock.observe(stamp)
  }

  toJSON(): MarksFile {
    return { version: MARKS_VERSION, clock: this.clock.state(), entities: this.entities, tombstones: this.tombstones, orders: this.orders }
  }
}

/** What a session set aside, as `adopt` is told: whether an entity, or a list, belongs to a space that was not exchanged. */
export interface Aside {
  entity: (kind: string, id: string) => boolean
  list: (key: string) => boolean
}

const NOTHING_ASIDE: Aside = { entity: () => false, list: () => false }

/** The marks that a session keeps for the spaces it set aside: an entity of such a space (or the space itself), and the lists that order what is in one. */
export function asideOf(view: TrackedView, spaces: ReadonlySet<string>): Aside {
  if (spaces.size === 0) return NOTHING_ASIDE
  return {
    entity: (kind, id) => {
      if (kind === 'space') return spaces.has(id)
      const spaceId = view.entities[kind]?.[id]?.['spaceId']
      return typeof spaceId === 'string' && spaces.has(spaceId)
    },
    // `folders:<space>:<parent>` and `tabs:<space>:<folder>`: the space is the second part of the key.
    list: (key) => {
      const [head, space] = key.split(':')
      return (head === 'folders' || head === 'tabs') && space !== undefined && spaces.has(space)
    }
  }
}

/** The smaller of two marks. */
export const earlier = (a: string, b: string): string => (compareStamps(a, b) <= 0 ? a : b)
