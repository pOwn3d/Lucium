// What an entity that comes in may carry before it reaches the merge and the state (docs/synchronisation.md §8.5, §10): a gate applied to every entity of a received
// snapshot, in addition to the bounds of the form (`parseSnapshot`, shared/sync-snapshot.ts). The vectors `inbound` of ios/Contracts/sync-message-vectors.json are
// played against it.
//
//   - a kind that is code or a secret is refused (`never-synced`), whatever the device says;
//   - a setting is accepted only if it is in the closed list and its value is one this version would write (`not-synced`, `invalid-value`); the search engine only if it is
//     one of those Lucium offers, which are all https: an engine of one's own stays on the device that has it, and a device cannot send the searches of another to a server of its choice;
//   - a tab is accepted only if it is pinned and not private (`not-pinned`, `private`): the Today tabs are the entities of another kind, `todayTab` (§27), whose own checks
//     (the address, the title, the bound of 500 in a snapshot) are `gateTodayTabs`, called once the general ones have passed;
//   - an address is accepted only if it is an http or https address (`invalid-url`): a page, never a script or a file;
//   - the fields of the class « local » are taken off: a device does not tell this one what its local files are;
//   - an entity of a kind this version does not know, and a field of a known kind it does not know, cross as they are (§11.6);
//   - a text with a lone surrogate anywhere in an entity's fields is refused (`invalid-value`): Swift cannot read it, so a Mac that sent one made every session fail;
//   - the profile of a space or a favourite must be an identifier of the Mac (`isProfileId`): the key of a list is made of it (`favorites:<profile>`), and it has no business being
//     long or written in two Unicode forms (`invalid-value`);
//   - the tombstones are a door too: those of a kind that is code or a secret are refused (`never-synced`), and each side keeps at most `MAX_TOMBSTONES_PER_SNAPSHOT` of the newest;
//   - a mark more than seven days ahead of this device's clock is refused wherever a mark is: an entity's, a tombstone's, the mark of a list's order (§9.3). The merge
//     keeps the greatest mark it sees and the marks book never lets its clock fall behind one it has seen, so a single such mark would win every conflict, delete
//     whatever it names and push the clock of this device out of the reach of every other one, for ever.
// A refused entity (or tombstone, or list) is dropped, counted and logged: never fatal (§8.5).

import { MAX_STRING_BYTES, MAX_TOMBSTONES_PER_SNAPSHOT, STAMP_FUTURE_REFUSE_MS } from './limits'
import { hasLoneSurrogate } from './messages'
import { isProfileId } from '@shared/profiles'
import { compareStamps } from '@shared/sync-snapshot'
import { classesOf, isKind, NEVER_KINDS, SYNCED_SETTINGS, type SyncKind } from './field-classes'
import type { WireEntity } from './messages'
import { SEARCH_ENGINES } from '@shared/model'
import { PROFILE_NAME_MAX } from '@shared/sidebar'
import type { SyncEntity, SyncSnapshot } from '@shared/sync-snapshot'
import { gateTodayTabs, TODAY_TAB_KIND, type TodayRefusal } from '@shared/sync-today'

export type Refusal = 'never-synced' | 'not-synced' | 'invalid-value' | 'not-pinned' | 'private' | 'invalid-url' | 'future-mark' | 'too-many-tombstones' | TodayRefusal
export type Filtered = { accepted: true; fields: Record<string, unknown> } | { accepted: false; reason: Refusal }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An http or https address that parses: the only kind of page worth synchronising (a script, a file or a data address is refused). */
export const isWebAddress = (value: unknown): boolean => typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value)

// The address of a `todayTab` is checked by `gateTodayTabs` (it also bounds its length).
const URL_FIELDS: Readonly<Partial<Record<SyncKind, readonly string[]>>> = { tab: ['url', 'anchorUrl'], favorite: ['url'], archived: ['url', 'anchorUrl'] }

/** The search templates Lucium offers (the engines of the Settings): the only ones that cross, all of them https (docs/synchronisation.md §10.3). */
const KNOWN_SEARCH_TEMPLATES: ReadonlySet<string> = new Set(SEARCH_ENGINES.map((engine) => engine.url))

/** Whether a template is one of the engines Lucium offers. An engine of one's own is not: it never crosses, in either direction. */
export const isKnownSearchTemplate = (value: unknown): boolean => typeof value === 'string' && KNOWN_SEARCH_TEMPLATES.has(value)

/** The ceiling of a delay of automatic archiving the Mac accepts from another device: a year of hours. */
const ARCHIVE_HOURS_MAX = 24 * 366

/** Whether a value is not one this version would write for a synchronised setting. */
function settingValueProblem(key: string, value: unknown): boolean {
  switch (key) {
    case 'httpsUpgrade':
    case 'sendGpc':
    case 'stripTrackingParams':
    case 'stripCopiedLinks':
      return typeof value !== 'boolean'
    case 'protectionBaseline':
      return value !== 'standard' && value !== 'renforcee'
    case 'autoArchiveHours':
      return typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > ARCHIVE_HOURS_MAX
    case 'searchUrlTemplate':
      return !isKnownSearchTemplate(value)
    case 'profileNames':
      return !isObject(value) || Object.keys(value).length > 64 || !Object.entries(value).every(([id, name]) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof name === 'string' && name.length <= PROFILE_NAME_MAX)
    default:
      return true
  }
}

/**
 * Whether a JSON value holds, in a text or in a key, what no message can carry: a lone surrogate (Swift cannot read it) or a text of more than `MAX_STRING_BYTES` bytes (the
 * bound is in bytes, and a state bound in characters can exceed it with non-ASCII text: the message that held it was refused whole). Iterative: the value is hostile.
 */
function holdsUnsendableText(root: unknown): boolean {
  const unsendable = (text: string): boolean => hasLoneSurrogate(text) || (text.length * 3 > MAX_STRING_BYTES && Buffer.byteLength(text, 'utf8') > MAX_STRING_BYTES)
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') {
      if (unsendable(value)) return true
    } else if (Array.isArray(value)) {
      // One by one: `push(...value)` spreads the list on the call stack, which a list of about 125 000 elements overflows.
      for (const item of value) stack.push(item)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, member] of Object.entries(value)) {
        if (unsendable(key)) return true
        stack.push(member)
      }
    }
  }
  return false
}

export function filterEntity(entity: Pick<WireEntity, 'kind' | 'id' | 'fields'>): Filtered {
  if (NEVER_KINDS.includes(entity.kind)) return { accepted: false, reason: 'never-synced' }
  if (holdsUnsendableText(entity.fields)) return { accepted: false, reason: 'invalid-value' }
  // The key of a list is made of the profile (`favorites:<profile>`): an identifier of the Mac, or nothing (a long one made the base unreadable, a decomposed one two lists).
  if ((entity.kind === 'space' || entity.kind === 'favorite') && entity.fields['profileId'] !== undefined && !isProfileId(entity.fields['profileId'])) return { accepted: false, reason: 'invalid-value' }
  if (entity.kind === 'setting') {
    if (!(SYNCED_SETTINGS as readonly string[]).includes(entity.id)) return { accepted: false, reason: 'not-synced' }
    return settingValueProblem(entity.id, entity.fields['value']) ? { accepted: false, reason: 'invalid-value' } : { accepted: true, fields: { value: entity.fields['value'] } }
  }
  if (!isKind(entity.kind)) return { accepted: true, fields: entity.fields }
  if (entity.kind === 'tab') {
    if (entity.fields['private'] === true) return { accepted: false, reason: 'private' }
    if (entity.fields['pinned'] !== true) return { accepted: false, reason: 'not-pinned' }
  }
  const local = classesOf(entity.kind).local
  const fields = Object.fromEntries(Object.entries(entity.fields).filter(([name]) => !local.includes(name)))
  for (const name of URL_FIELDS[entity.kind] ?? []) if (fields[name] !== undefined && !isWebAddress(fields[name])) return { accepted: false, reason: 'invalid-url' }
  return { accepted: true, fields }
}

/** The ms of a mark (its first thirteen digits), or 0 for the mark « zéro ». */
const msOf = (stamp: string): number => (stamp === '0' ? 0 : Number(stamp.slice(0, 13)))

/** A mark more than seven days ahead of this device's clock: the device that wrote it has the wrong time, and its entity would win every conflict for ever (§9.3). */
function inTheFuture(entity: SyncEntity, now: number): boolean {
  return Object.values(entity.stamps).some((stamp) => msOf(stamp) > now + STAMP_FUTURE_REFUSE_MS)
}

export interface Cleaned {
  snapshot: SyncSnapshot
  refused: Array<{ kind: string; id: string; reason: Refusal }>
}

/** The refusals that say « this cannot be sent now » (the marks, the address, the value): the version of the base stands in. The others say « this is not for the synchronisation »: a tab that was unpinned or made private leaves the set, and is deleted over there. */
const STANDS_IN_AS_IN_THE_BASE: ReadonlySet<Refusal> = new Set(['future-mark', 'invalid-url', 'invalid-value'])

/** Whether a mark names a time more than seven days ahead of `now` (the mark « zéro » names none). */
const marksTheFuture = (stamp: string, now: number): boolean => msOf(stamp) > now + STAMP_FUTURE_REFUSE_MS

/**
 * A received snapshot with what passes: refused entities are dropped (and listed so that the session counts and logs them; one that is in `base` and was refused for its marks, its
 * address or its value is given back as the base holds it, not dropped), and the local fields of the others are taken off, with their marks. A tombstone, or a list with its mark of order, whose mark is in the future is dropped and listed the same way (`kind` `tombstone` or `order`);
 * what the others are made of is left to the merge, which treats an id it does not know as nothing.
 */
export function cleanSnapshot(remote: SyncSnapshot, now: number, base: SyncSnapshot | null = null): Cleaned {
  const refused: Cleaned['refused'] = []
  const entities: SyncSnapshot['entities'] = {}
  for (const [kind, byId] of Object.entries(remote.entities)) {
    for (const [id, entity] of Object.entries(byId)) {
      const verdict = inTheFuture(entity, now) ? ({ accepted: false, reason: 'future-mark' } as const) : filterEntity({ kind, id, fields: entity.fields })
      if (!verdict.accepted) {
        refused.push({ kind, id, reason: verdict.reason })
        // What cannot travel as it is now is not what was taken out of the synchronised set: the merge would read an entity that is in the base and not in this snapshot as
        // deleted, and the other device would lose it (a clock a week ahead, an address that stopped being a web page). The version of the base stands in: unchanged.
        const before = base !== null && Object.hasOwn(base.entities, kind) && Object.hasOwn(base.entities[kind] as object, id) ? base.entities[kind]?.[id] : undefined
        if (before !== undefined && STANDS_IN_AS_IN_THE_BASE.has(verdict.reason)) (entities[kind] ??= {})[id] = before
        continue
      }
      const stamps = Object.fromEntries(Object.entries(entity.stamps).filter(([name]) => !(isKind(kind) && classesOf(kind).local.includes(name))))
      ;(entities[kind] ??= {})[id] = { fields: verdict.fields as SyncEntity['fields'], stamps }
    }
  }
  // What only a Today tab needs (§27.4, §27.7): the same function as the phone's door, so that both sides keep the same entities.
  const today = entities[TODAY_TAB_KIND]
  if (today !== undefined) {
    const gate = gateTodayTabs(today, base?.entities[TODAY_TAB_KIND] ?? null)
    for (const one of gate.refused) refused.push({ kind: TODAY_TAB_KIND, id: one.id, reason: one.reason })
    // A kind with no entity left is not in the snapshot, as for every other kind: an empty one would not hash like an absent one.
    if (Object.keys(gate.entities).length > 0) entities[TODAY_TAB_KIND] = gate.entities
    else delete entities[TODAY_TAB_KIND]
  }
  const tombstones: SyncSnapshot['tombstones'] = {}
  const standing: Array<{ kind: string; id: string; stamp: string }> = []
  for (const [kind, byId] of Object.entries(remote.tombstones)) {
    for (const [id, stamp] of Object.entries(byId)) {
      if (NEVER_KINDS.includes(kind)) {
        refused.push({ kind: 'tombstone', id: `${kind}/${id}`, reason: 'never-synced' })
        continue
      }
      if (marksTheFuture(stamp, now)) {
        refused.push({ kind: 'tombstone', id: `${kind}/${id}`, reason: 'future-mark' })
        continue
      }
      standing.push({ kind, id, stamp })
    }
  }
  // At most `MAX_TOMBSTONES_PER_SNAPSHOT` of them, the newest (a tie goes to the smaller kind and id, so that both devices keep the same ones): the merge keeps the tombstones
  // of both sides, and a base that holds twice what a snapshot may is a base nobody can read.
  if (standing.length > MAX_TOMBSTONES_PER_SNAPSHOT) {
    standing.sort((a, b) => compareStamps(b.stamp, a.stamp) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    standing.length = MAX_TOMBSTONES_PER_SNAPSHOT
    refused.push({ kind: 'tombstone', id: '*', reason: 'too-many-tombstones' })
  }
  for (const { kind, id, stamp } of standing) (tombstones[kind] ??= {})[id] = stamp
  const order: SyncSnapshot['order'] = {}
  const orderStamps: SyncSnapshot['orderStamps'] = {}
  for (const [key, ids] of Object.entries(remote.order)) {
    const stamp = remote.orderStamps[key]
    if (stamp !== undefined && marksTheFuture(stamp, now)) {
      refused.push({ kind: 'order', id: key, reason: 'future-mark' })
      continue
    }
    order[key] = ids
    if (stamp !== undefined) orderStamps[key] = stamp
  }
  // A mark of order with no list (a list that went empty keeps none, §11.4) is checked and kept the same way.
  for (const [key, stamp] of Object.entries(remote.orderStamps)) if (!Object.hasOwn(remote.order, key) && !marksTheFuture(stamp, now)) orderStamps[key] = stamp
  return { snapshot: { entities, tombstones, order, orderStamps }, refused }
}
