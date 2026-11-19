// One synchronisation session with a paired device (docs/synchronisation.md §8). The flow is the same on both devices (the one that connects and the one that listens
// run the same function, with their own state), so that the test plays it between two devices of this code:
//
//   hello      each side says who it is, which categories it ticked, the hash of the base it holds for the other, and the time of its clock;
//   freeze     the state is brought up to the marks and a snapshot is frozen (the categories both ticked; the spaces set aside left out);
//   snapshot   the snapshot goes in parts (500 entities, about 600 KB, at most), then `snapshot.end` with its count and its digest; when both devices hold the same
//              base, only what differs from it goes (§31), and the other rebuilds the snapshot and says so with `snapshot.check` (a whole one is sent if it could not);
//   check      what comes in is checked for its form (`parseSnapshot`), its count and its digest (`truncated`), then entity by entity (inbound-filter.ts);
//   merge      `mergeSnapshots(base, local, remote, withheld)`: the same function with the same inputs on both sides;
//   result     the digests of the merged snapshots are compared; different: `divergence`, NOTHING is written on either side;
//   apply      the patch between the frozen snapshot and the merged one is written by `sync/apply`; the marks and the base follow; `commit`, `bye`.
//
// Nothing is written before the digests agree; a connection that drops before then leaves the state and the base as they were. A message out of its phase, a bad number, a
// frame that is too big end the conversation (channel.ts) with the code that says why.

import { canonicalJson } from '@shared/sync-canonical'
import { mergeSnapshots, type SyncConflict } from '@shared/sync-merge'
import { parseSnapshot, type SyncEntity, type SyncSnapshot } from '@shared/sync-snapshot'
import { NEEDS_STRUCTURE, SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
import type { SidebarState } from '@shared/model'
import type { SyncPatch } from '@shared/sidebar-sync'
import { TODAY_TAB_KIND } from '@shared/sync-today'
import { applyDelta, diffSnapshots, type SnapshotDelta } from '@shared/sync-delta'
import { Channel, ConnectionClosed, ProtocolError } from './channel'
import type { ErrorCode } from './error-codes'
import { CLOCK_SKEW_WARN_MS, DIFF_VERSION, MAX_ENTITIES, MAX_ENTITIES_PER_PART, MAX_PARTS, NONCE_BYTES } from './limits'
import type { BaseStore } from './bases'
import { hashOfSnapshot } from './bases'
import { cleanSnapshot, isKnownSearchTemplate } from './inbound-filter'
import { asideOf, type MarkBook } from './marks'
import type { SnapshotPart, WireEntity, WireRemoval, WireTombstone } from './messages'
import { buildPatch, patchIsEmpty } from './patch'
import { admittedTodayTabs, unsharedTodayTabs, baseOf, follows, kindIsExchanged, onlyExchanged, snapshotOf, trackedViewOf, withheldSpaces } from './state-view'
import { randomBytes } from 'node:crypto'

/** What a session needs of the state of the device. */
export interface SessionHost {
  state(): SidebarState
  /** Writes the patch (the action `sync/apply`), synchronously. */
  apply(patch: SyncPatch): void
  isSpaceLocked(spaceId: string): boolean
  isAppLocked(): boolean
}

export interface SessionDeps {
  device: { id: string; name: string; platform: 'mac' | 'ios' }
  host: SessionHost
  marks: MarkBook
  saveMarks: () => void
  bases: BaseStore
  /** The categories ticked on this device. */
  categories: () => ReadonlySet<SyncCategory>
  now: () => number
  appVersion: string
  stateVersion: number
  hosts: () => string[]
  /** The port this Mac listens on now (review n° 38), said in `hello` so that an iPhone paired before a fallback of the port finds the Mac again. Mac only. */
  port?: () => number
  merge?: typeof mergeSnapshots
  /** The other device said it forgets this one. */
  onUnpair?: (peerId: string) => void
  /** What was refused of what came in, for the log. */
  onRefused?: (peerId: string, refused: Array<{ kind: string; id: string; reason: string }>) => void
  /** A Today tab the other device closed was the selected one of its space here (§27.5, [Q11]): the interface says it (card of the interface), the session has already shown the neighbour. */
  onShownTabsClosed?: (peerId: string, tabs: ClosedShownTab[]) => void
  /** A session that went through. */
  onDone?: (peerId: string, at: number) => void
  /** A warning of the other device that does not end the session (the clocks differ). */
  onWarning?: (peerId: string, code: ErrorCode) => void
  /** False: this device does not announce nor read differences (§31.1), as a build from before §31. Only the tests play it. */
  differences?: boolean
  /** A difference that did not rebuild (§31.4): a whole snapshot was asked for instead. Never shown to the person; logged by default. */
  onFallback?: (peerId: string, reason: string) => void
}

/** A Today tab that the other device closed while it was the one selected in its space here (§27.5, [Q11]): it is archived and the neighbour is shown. */
export interface ClosedShownTab {
  id: string
  spaceId: string
  /** The space was the one on screen: the person was looking at the tab. */
  onScreen: boolean
}

/** The tabs of `patch` that were selected in their space before it was applied and are gone after it: what the line « Fermé sur l'iPhone » is said about. */
export function shownTabsClosed(before: SidebarState, after: SidebarState, patch: SyncPatch): ClosedShownTab[] {
  const closing = new Set(patch.removals.filter((removal) => removal.kind === TODAY_TAB_KIND).map((removal) => removal.id))
  const present = new Set(after.tabs.map((tab) => tab.id))
  return Object.entries(before.activeTabBySpace)
    .filter(([, id]) => id !== null && closing.has(id) && !present.has(id))
    .map(([spaceId, id]) => ({ id: id as string, spaceId, onScreen: spaceId === before.activeSpaceId }))
}

/** How the snapshots of a session went (§31): whole, as differences with the base, or as differences of which one had to be asked again whole. */
export type SnapshotMode = 'whole' | 'differences' | 'fallback'

export type SessionResult =
  | { ok: true; applied: boolean; conflicts: SyncConflict[]; refused: number; categories: SyncCategory[]; todayTabsReceived: number; todayTabsUnshared: number; snapshots: SnapshotMode }
  | { ok: false; code: ErrorCode | 'interrupted' | 'unpaired'; detail: string }

/**
 * The categories this device announces in its `hello`: the ones ticked, except those that hang on a space (`NEEDS_STRUCTURE`: the archive, the Today tabs) when the
 * structure is not ticked. Their entities depend on their space (§27.2) and the spaces travel with the structure: with the structure left out, the merge finds no space for any
 * of them and removes them all (`withoutSpaces`, §11.7.1), the ones of this device first.
 */
export function announcedCategories(ticked: ReadonlySet<SyncCategory>): ReadonlySet<SyncCategory> {
  const dependent = (category: SyncCategory): boolean => NEEDS_STRUCTURE.includes(category)
  if (ticked.has('structure') || ![...ticked].some(dependent)) return ticked
  return new Set([...ticked].filter((category) => !dependent(category)))
}

/**
 * The categories both devices ticked (§8.2), less those that hang on a space when the structure is not among them. A device that announces such a category without the
 * structure (it should not, see `announcedCategories`) would otherwise make both merges start from entities with no space, and both would remove them all: not followed here,
 * the two merges then start from other inputs, the session ends in `divergence` (§8.5) and nothing is written.
 */
export function commonCategories(mine: ReadonlySet<SyncCategory>, theirs: readonly string[]): Set<SyncCategory> {
  const common = new Set(SYNC_CATEGORIES.filter((category) => mine.has(category) && theirs.includes(category)))
  if (!common.has('structure')) for (const category of NEEDS_STRUCTURE) common.delete(category)
  return common
}

/** The bytes a part may weigh before the next one starts: well under a frame. */
const PART_BYTES = 600_000

/** What a snapshot sent as a difference says besides its entities, tombstones and lists (§31.2). */
export interface PartsDifference {
  base: string
  removedEntities: WireRemoval[]
  removedTombstones: WireRemoval[]
  removedLists: string[]
}

/**
 * The snapshot cut in parts that each fit a frame (§7.5): the entities first, then the tombstones, then the lists; the first part names the spaces set aside. With `difference`,
 * the snapshot is what differs from the base: the first part says which base, and the removals follow the lists (§31.2).
 */
export function partsOf(snapshot: SyncSnapshot, withheld: readonly string[], difference?: PartsDifference): Array<Omit<SnapshotPart, 'v' | 'n' | 't' | 'part' | 'parts'>> {
  const parts: Array<{ entities: WireEntity[]; tombstones: WireTombstone[]; order: Record<string, string[]>; orderStamps: Record<string, string>; removedEntities: WireRemoval[]; removedTombstones: WireRemoval[]; removedLists: string[]; weight: number; withheld?: string[]; base?: string }> = []
  const fresh = (): (typeof parts)[number] => ({ entities: [], tombstones: [], order: {}, orderStamps: {}, removedEntities: [], removedTombstones: [], removedLists: [], weight: 0 })
  let current = fresh()
  const room = (weight: number, entities = 0): void => {
    if (current.weight > 0 && (current.weight + weight > PART_BYTES || current.entities.length + entities > MAX_ENTITIES_PER_PART)) {
      parts.push(current)
      current = fresh()
    }
    current.weight += weight
  }
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  for (const [kind, byId] of Object.entries(snapshot.entities)) {
    for (const [id, entity] of Object.entries(byId)) {
      const wire: WireEntity = { kind, id, fields: entity.fields, stamps: entity.stamps }
      room(size(wire), 1)
      current.entities.push(wire)
    }
  }
  for (const [kind, byId] of Object.entries(snapshot.tombstones)) {
    for (const [id, stamp] of Object.entries(byId)) {
      const wire: WireTombstone = { kind, id, stamp }
      room(size(wire))
      current.tombstones.push(wire)
    }
  }
  for (const [key, ids] of Object.entries(snapshot.order)) {
    room(size([key, ids]) + 80)
    current.order[key] = ids
    current.orderStamps[key] = snapshot.orderStamps[key] ?? '0'
  }
  if (difference !== undefined) {
    for (const wire of difference.removedEntities) {
      room(size(wire))
      current.removedEntities.push(wire)
    }
    for (const wire of difference.removedTombstones) {
      room(size(wire))
      current.removedTombstones.push(wire)
    }
    for (const key of difference.removedLists) {
      room(size(key))
      current.removedLists.push(key)
    }
  }
  parts.push(current)
  parts[0]!.withheld = [...withheld]
  if (difference !== undefined) parts[0]!.base = difference.base
  const present = <T>(list: T[]): T[] | undefined => (list.length === 0 ? undefined : list)
  return parts.map(({ weight: _weight, ...part }) => ({
    ...part,
    ...(part.tombstones.length === 0 ? { tombstones: undefined } : {}),
    ...(Object.keys(part.order).length === 0 ? { order: undefined, orderStamps: undefined } : {}),
    removedEntities: present(part.removedEntities),
    removedTombstones: present(part.removedTombstones),
    removedLists: present(part.removedLists)
  })) as never
}

/** The difference between the snapshot of this device and the base the two share, ready to be cut in parts (§31.2). */
export function differenceOf(base: SyncSnapshot, baseHash: string, snapshot: SyncSnapshot, withheld: readonly string[]): ReturnType<typeof partsOf> {
  const delta = diffSnapshots(base, snapshot)
  return partsOf(delta.snapshot, withheld, {
    base: baseHash,
    removedEntities: delta.removedEntities,
    removedTombstones: delta.removedTombstones,
    removedLists: delta.removedLists
  })
}

/** What was assembled from the parts that came in. */
interface Assembled {
  snapshot: SyncSnapshot
  entityCount: number
  withheld: Set<string>
}

/** The base a difference is rebuilt on (§31.3): its snapshot and its hash. */
interface RebuildOn {
  base: SyncSnapshot
  hash: string
}

/** A snapshot that came in whole or that was rebuilt, or the reason a difference did not rebuild (§31.4: not an error of the session, a whole snapshot is asked for). */
type Received = { ok: true; assembled: Assembled } | { ok: false; reason: string }

const fail = (code: ErrorCode, detail: string): never => {
  throw new ProtocolError(code, detail)
}

/**
 * The next message that is not a warning: an `error` that says it is not fatal (the clocks differ, §9.3) is passed to `warn` and the wait goes on. A fatal one is the
 * other device ending the session, and is the caller's to take.
 */
async function nextMessage(channel: Channel, warn: (code: ErrorCode) => void): Promise<Awaited<ReturnType<Channel['receive']>>> {
  for (;;) {
    const message = await channel.receive()
    if (message.t === 'error' && !message.fatal) warn(message.code)
    else return message
  }
}

/**
 * Reads `snapshot.part`s up to `snapshot.end`, checking every number the other device gave. A retired `open-tabs` (§27.11) that comes between is dropped, not an error of the
 * session: `onRetired` lets the caller log it. With `rebuildOn`, a snapshot that says it is a difference with the base of that hash is rebuilt on it (§31.3) and checked against
 * the count and the digest of the whole one; one that does not rebuild is `{ ok: false }`, not an error. Without it, a difference is a bad message: none was agreed.
 */
async function receiveSnapshot(channel: Channel, onRetired: () => void, warn: (code: ErrorCode) => void, rebuildOn?: RebuildOn): Promise<Received> {
  const snapshot: SyncSnapshot = { entities: {}, tombstones: {}, order: {}, orderStamps: {} }
  const withheld = new Set<string>()
  const removed: Pick<SnapshotDelta, 'removedEntities' | 'removedTombstones' | 'removedLists'> = { removedEntities: [], removedTombstones: [], removedLists: [] }
  let parts: number | null = null
  let next = 0
  let entityCount = 0
  let difference: string | null = null
  for (;;) {
    const message = await nextMessage(channel, warn)
    switch (message.t) {
      case 'snapshot.part': {
        if (parts === null) parts = message.parts
        if (message.parts !== parts || message.part !== next) return fail('bad-message', 'the parts do not follow one another')
        if (message.base !== undefined) {
          if (rebuildOn === undefined) return fail('bad-message', 'a difference where none was agreed')
          if (message.part !== 0) return fail('bad-message', 'the base of a difference is said in the first part only')
          difference = message.base
        }
        const hasRemovals = message.removedEntities !== undefined || message.removedTombstones !== undefined || message.removedLists !== undefined
        if (hasRemovals && difference === null) return fail('bad-message', 'a removal in a whole snapshot')
        next++
        for (const wire of message.entities) {
          const byId = (snapshot.entities[wire.kind] ??= {})
          if (Object.hasOwn(byId, wire.id)) return fail('bad-message', 'an entity is twice in a snapshot')
          byId[wire.id] = { fields: wire.fields as SyncEntity['fields'], stamps: wire.stamps }
          if (++entityCount > MAX_ENTITIES) return fail('too-large', 'a snapshot of more entities than the bound')
        }
        for (const tomb of message.tombstones ?? []) {
          const byId = (snapshot.tombstones[tomb.kind] ??= {})
          if (Object.hasOwn(byId, tomb.id)) return fail('bad-message', 'a tombstone is twice in a snapshot')
          byId[tomb.id] = tomb.stamp
        }
        for (const [key, ids] of Object.entries(message.order ?? {})) {
          if (Object.hasOwn(snapshot.order, key)) return fail('bad-message', 'a list is twice in a snapshot')
          snapshot.order[key] = ids
        }
        for (const [key, stamp] of Object.entries(message.orderStamps ?? {})) snapshot.orderStamps[key] = stamp
        removed.removedEntities.push(...(message.removedEntities ?? []))
        removed.removedTombstones.push(...(message.removedTombstones ?? []))
        removed.removedLists.push(...(message.removedLists ?? []))
        for (const id of message.withheld ?? []) withheld.add(id)
        break
      }
      case 'open-tabs':
        onRetired()
        break
      case 'snapshot.end': {
        if (parts === null || next !== parts) return fail('truncated', 'the parts announced did not all come')
        if (difference === null) {
          if (message.entityCount !== entityCount) return fail('truncated', 'the count of entities is not the one announced')
          if (message.digest !== hashOfSnapshot(snapshot)) return fail('truncated', 'the digest of the snapshot is not the one announced')
          return { ok: true, assembled: { snapshot, entityCount, withheld } }
        }
        // A difference (§31.3): rebuilt on this device's own copy of the base, then held to the count and the digest of the whole snapshot.
        const on = rebuildOn as RebuildOn
        if (difference !== on.hash) return { ok: false, reason: 'the base of the difference is not the one this device holds' }
        const rebuilt = applyDelta(on.base, { snapshot, ...removed })
        if ('problem' in rebuilt) return { ok: false, reason: rebuilt.problem }
        const count = Object.values(rebuilt.snapshot.entities).reduce((sum, byId) => sum + Object.keys(byId).length, 0)
        if (count > MAX_ENTITIES) return fail('too-large', 'a snapshot of more entities than the bound')
        if (message.entityCount !== count) return { ok: false, reason: 'the count of entities of the rebuilt snapshot is not the one announced' }
        if (message.digest !== hashOfSnapshot(rebuilt.snapshot)) return { ok: false, reason: 'the digest of the rebuilt snapshot is not the one announced' }
        return { ok: true, assembled: { snapshot: rebuilt.snapshot, entityCount: count, withheld } }
      }
      case 'unpair':
        throw new ProtocolError('not-paired', 'the other device forgot this one')
      case 'error':
        throw new ProtocolError(message.code, 'the other device ended the session')
      default:
        return fail('bad-message', `a ${message.t} is not expected in a snapshot`)
    }
  }
}

/** The next message, which must be one of `type`; an `error` of the other device ends the session with its code, an `unpair` with `not-paired`. */
async function expect<T extends 'hello' | 'snapshot.check' | 'result' | 'commit'>(channel: Channel, type: T, warn: (code: ErrorCode) => void): Promise<Extract<Awaited<ReturnType<Channel['receive']>>, { t: T }>> {
  const message = await nextMessage(channel, warn)
  if (message.t === 'error') throw new ProtocolError(message.code, 'the other device ended the session')
  if (message.t === 'unpair') throw new ProtocolError('not-paired', 'the other device forgot this one')
  if (message.t !== type) return fail('bad-message', `a ${message.t} came where a ${type} was expected`)
  return message as never
}

export async function runSession(channel: Channel, peerId: string, deps: SessionDeps): Promise<SessionResult> {
  try {
    if (deps.host.isAppLocked()) return fail('locked', 'the application is locked')
    const merge = deps.merge ?? mergeSnapshots
    const stored = deps.bases.get(peerId, deps.now())
    const mine = announcedCategories(deps.categories())

    // hello
    await channel.send({
      t: 'hello',
      device: deps.device,
      nonce: randomBytes(NONCE_BYTES).toString('base64url'),
      categories: [...mine],
      baseHash: stored?.hash ?? null,
      stateVersion: deps.stateVersion,
      appVersion: deps.appVersion,
      now: deps.now(),
      ...(deps.differences === false ? {} : { diff: DIFF_VERSION }),
      ...(deps.device.platform === 'mac' ? { hosts: deps.hosts(), ...(deps.port !== undefined ? { port: deps.port() } : {}) } : {})
    })
    const warn = (code: ErrorCode): void => deps.onWarning?.(peerId, code)
    const hello = await expect(channel, 'hello', warn)
    if (hello.device.id !== peerId) return fail('fingerprint-mismatch', 'the identifier is not the one paired with this certificate')
    if (hello.stateVersion > deps.stateVersion) return fail('state-too-new', 'the other device writes a newer format of the state')
    if (Math.abs(hello.now - deps.now()) > CLOCK_SKEW_WARN_MS) await channel.send({ t: 'error', code: 'clock-skew', fatal: false, detail: 'the clocks differ by more than five minutes' })
    const common = commonCategories(mine, hello.categories)
    const base = stored !== null && hello.baseHash === stored.hash ? stored.snapshot : null
    // Differences only when both devices read them and hold the same base (§31.1): both compute the same answer from the two `hello`.
    const rebuildOn: RebuildOn | undefined = deps.differences !== false && base !== null && stored !== null && hello.diff !== undefined ? { base, hash: stored.hash } : undefined

    // freeze and send
    const state = deps.host.state()
    // The Today tabs of the shared set (§27.3): new ones come in only when the category is common, at the end of the freeze; the ones the book holds stay.
    const admission = { book: deps.marks, now: deps.now(), admitNew: common.has('todayTabs'), isSpaceLocked: (spaceId: string) => deps.host.isSpaceLocked(spaceId) }
    const admittedToday = admittedTodayTabs(state, admission)
    // The tabs that stayed on this device because the shared set was full (never any while the category is not common: only the admitted ones are candidates): « non partagés : n » (§27.4).
    const todayTabsUnshared = unsharedTodayTabs(state, admission)
    deps.marks.update(trackedViewOf(state, admittedToday), deps.now())
    const withheld = withheldSpaces(state, (spaceId) => deps.host.isSpaceLocked(spaceId))
    // What this device sends is what it would itself accept (the same gate as for what comes in, with the other device's clock for the marks of the future): the two
    // merges then start from the same inputs. An entity that does not pass stays here, untouched, and is not sent; it is counted and logged.
    const frozen = cleanSnapshot(snapshotOf(state, deps.marks, { categories: common, admittedToday, withheld: new Set(withheld), base }), hello.now, base)
    if (frozen.refused.length > 0) deps.onRefused?.(peerId, frozen.refused)
    const local = frozen.snapshot
    const entityCountOf = (snapshot: SyncSnapshot): number => Object.values(snapshot.entities).reduce((sum, byId) => sum + Object.keys(byId).length, 0)
    const sendSnapshot = async (parts: ReturnType<typeof partsOf>): Promise<void> => {
      if (parts.length > MAX_PARTS) return fail('too-large', 'the snapshot needs more parts than the bound')
      for (const [part, body] of parts.entries()) await channel.send({ t: 'snapshot.part', part, parts: parts.length, ...body })
      await channel.send({ t: 'snapshot.end', entityCount: entityCountOf(local), digest: hashOfSnapshot(local) })
    }
    await sendSnapshot(rebuildOn !== undefined ? differenceOf(rebuildOn.base, rebuildOn.hash, local, withheld) : partsOf(local, withheld))

    // receive, check
    const onRetired = (): void => console.warn(`[sync] ${peerId} sent the retired message open-tabs: ignored`)
    let received = await receiveSnapshot(channel, onRetired, warn, rebuildOn)
    let snapshots: SnapshotMode = rebuildOn !== undefined ? 'differences' : 'whole'
    if (rebuildOn !== undefined) {
      // Each side says whether it rebuilt the snapshot of the other (§31.4) before anything else is sent: a whole snapshot asked for comes in its place, in the same order on both.
      await channel.send({ t: 'snapshot.check', ok: received.ok })
      const theirCheck = await expect(channel, 'snapshot.check', warn)
      if (!theirCheck.ok) {
        snapshots = 'fallback'
        await sendSnapshot(partsOf(local, withheld))
      }
      if (!received.ok) {
        snapshots = 'fallback'
        if (deps.onFallback !== undefined) deps.onFallback(peerId, received.reason)
        else console.warn(`[sync] a difference of ${peerId} did not rebuild (${received.reason}): the whole snapshot was asked for`)
        received = await receiveSnapshot(channel, onRetired, warn)
        if (!received.ok) return fail('truncated', received.reason)
      }
    }
    if (!received.ok) return fail('truncated', received.reason)
    const assembled = received.assembled
    const form = parseSnapshot(JSON.parse(canonicalJson(assembled.snapshot)))
    if ('problem' in form) return fail('bad-message', `the snapshot is not well formed: ${form.problem}`)
    const exchanged = onlyExchanged(form.snapshot, common)
    if (exchanged.refused.length > 0) deps.onRefused?.(peerId, exchanged.refused)
    const cleaned = cleanSnapshot(exchanged.snapshot, deps.now(), base)
    if (cleaned.refused.length > 0) deps.onRefused?.(peerId, cleaned.refused)

    // merge, compare
    const aside = new Set([...withheld, ...assembled.withheld])
    const merged = merge(base, local, cleaned.snapshot, [...aside])
    const digest = hashOfSnapshot(merged.snapshot)
    await channel.send({ t: 'result', digest })
    const theirs = await expect(channel, 'result', warn)
    if (theirs.digest !== digest) return fail('divergence', 'the two devices do not reach the same merged snapshot: nothing is written')

    // apply
    if (deps.host.isAppLocked()) return fail('locked', 'the application locked before anything was written')
    const patch = buildPatch(local, merged.snapshot, aside)
    // An engine of search of one's own stays on this device (§10.3): it is not sent, and the engine the other device has does not replace it. The engine is whatever the
    // state holds now, not what it held at the freeze: the person may have typed one meanwhile.
    if (Object.hasOwn(patch.settings, 'searchUrlTemplate') && !isKnownSearchTemplate((deps.host.state().settings as unknown as Record<string, unknown>)['searchUrlTemplate'])) delete patch.settings['searchUrlTemplate']
    if (!patchIsEmpty(patch)) {
      const before = deps.host.state()
      deps.host.apply(patch)
      const closed = shownTabsClosed(before, deps.host.state(), patch)
      if (closed.length > 0) deps.onShownTabsClosed?.(peerId, closed)
    }
    deps.marks.adopt(merged.snapshot, follows, (kind) => kindIsExchanged(kind, common), asideOf(trackedViewOf(deps.host.state()), aside))
    try {
      deps.bases.save(peerId, baseOf(merged.snapshot), deps.now())
      deps.saveMarks()
    } catch (error) {
      console.error('[sync] the base or the marks could not be written after the state was:', error)
      return fail('internal', 'the base could not be written')
    }
    await channel.send({ t: 'commit', digest })
    await expect(channel, 'commit', warn)
    channel.bye()
    deps.onDone?.(peerId, deps.now())
    return { ok: true, applied: !patchIsEmpty(patch), conflicts: merged.conflicts, refused: cleaned.refused.length, categories: [...common], todayTabsReceived: patch.upserts.filter((one) => one.kind === TODAY_TAB_KIND && one.create).length, todayTabsUnshared, snapshots }
  } catch (error) {
    if (error instanceof ProtocolError) {
      if (error.code === 'not-paired') deps.onUnpair?.(peerId)
      // A fault the other device caused is already told by the channel; one of ours (a number that does not fit, a check that failed) is told here.
      if (channel.failure() === null) channel.fail(error.code, error.detail)
      return { ok: false, code: error.code === 'not-paired' ? 'unpaired' : error.code, detail: error.detail }
    }
    if (error instanceof ConnectionClosed) return { ok: false, code: 'interrupted', detail: error.message }
    console.error('[sync] a session ended on an error:', error)
    channel.fail('internal', 'the session failed')
    return { ok: false, code: 'internal', detail: 'the session failed' }
  }
}
