// The messages of the synchronisation (docs/synchronisation.md §7.3): what a frame may hold, checked as hostile text. `parseMessage` reads one frame's content and
// answers either a typed message that has only the fields its type knows, or the code of why it is refused. Nothing here acts on a message: the pairing and the
// session do, with what this module lets through.
//
// What a hostile message may not be, wherever it is (§7.1): not an object (a list, a number); nested deeper than 32 levels; a key `__proto__` at any depth (a copy
// `object[key] = value` would take it for the prototype); a number that is not finite, of 1e21 or more, or below 1e-6 (zero apart; `-0` is read as `0`, so that
// Swift and JavaScript write the same digits); a text of more than 64 KiB (bytes, not characters); a key written twice in one object (the first wins in Swift and the
// last in JavaScript: two devices would read two messages); a text or a key with a lone surrogate (Swift cannot read it). The walk is iterative: a frame of a million
// nested brackets must not exhaust the stack.
//
// The same vectors (ios/Contracts/sync-message-vectors.json: `messages`, `sequences`, `transitions`) are played on the iPhone side by LuciumKit.

import { ALPN, MAX_CATEGORIES, MAX_DEVICE_ID_CHARS, MAX_DEVICE_NAME_CHARS, MAX_ENTITIES_PER_PART, MAX_HOSTS, MAX_FRAME_VALUES, MAX_JSON_DEPTH, MAX_OPEN_TAB_TITLE_BYTES, MAX_OPEN_TAB_URL_BYTES, MAX_OPEN_TABS, MAX_PARTS, MAX_STRING_BYTES, PROTOCOL_VERSION } from './limits'
import { isErrorCode, type ErrorCode, type Verdict } from './error-codes'
import { isInheritedName } from '@shared/sync-snapshot'

export { ALPN }

// ---------- the shapes ----------

export interface DeviceInfo {
  id: string
  name: string
  platform: 'mac' | 'ios'
}

/** One thing of the state on the wire: a kind, an id, the synchronised fields (and every unknown one: they cross, §11.6) and one mark per field. */
export interface WireEntity {
  kind: string
  id: string
  fields: Record<string, unknown>
  stamps: Record<string, string>
}

export interface WireTombstone {
  kind: string
  id: string
  stamp: string
}

export interface OpenTab {
  id: string
  spaceId: string
  url: string
  title: string
  lastActiveAt: number
}

interface Envelope {
  v: number
  n: number
}

export type Hello = Envelope & { t: 'hello'; device: DeviceInfo; nonce: string; categories: string[]; baseHash: string | null; stateVersion: number; appVersion: string; now: number; hosts?: string[]; port?: number }
export type PairChallenge = Envelope & { t: 'pair.challenge'; nonce: string }
export type PairRequest = Envelope & { t: 'pair.request'; device: DeviceInfo; nonce: string; proof: string; commit: string }
/** The Mac's code nonce, sent after the commitment of the iPhone and a right proof (§4.7). */
export type PairNonce = Envelope & { t: 'pair.nonce'; nonce: string }
/** The iPhone's code nonce, which must open its commitment (§4.7). */
export type PairReveal = Envelope & { t: 'pair.reveal'; nonce: string }
/** `port` is the port this Mac listens on NOW (review n° 38): the one of the QR may have been replaced since (a port taken or refused falls back to another one). */
export type PairAccept = Envelope & { t: 'pair.accept'; device: DeviceInfo; proof: string; hosts: string[]; port: number }
export type SnapshotPart = Envelope & {
  t: 'snapshot.part'
  part: number
  parts: number
  entities: WireEntity[]
  tombstones?: WireTombstone[]
  order?: Record<string, string[]>
  orderStamps?: Record<string, string>
  withheld?: string[]
}
export type SnapshotEnd = Envelope & { t: 'snapshot.end'; entityCount: number; digest: string }
export type OpenTabs = Envelope & { t: 'open-tabs'; items: OpenTab[] }
export type ResultMessage = Envelope & { t: 'result'; digest: string }
export type Commit = Envelope & { t: 'commit'; digest: string }
export type Unpair = Envelope & { t: 'unpair' }
export type ErrorMessage = Envelope & { t: 'error'; code: ErrorCode; fatal: boolean; supported?: number[]; detail?: string }
export type Bye = Envelope & { t: 'bye' }

export type Message = Hello | PairChallenge | PairRequest | PairNonce | PairReveal | PairAccept | SnapshotPart | SnapshotEnd | OpenTabs | ResultMessage | Commit | Unpair | ErrorMessage | Bye
export type MessageType = Message['t']

// ---------- the walk over hostile JSON ----------

/** A UTF-16 surrogate that has no partner: not text. A pair (an emoji) is two units that are fine together. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Whether a text holds a lone surrogate (`\ud83d` on its own). */
export const hasLoneSurrogate = (text: string): boolean => LONE_SURROGATE.test(text)

/**
 * Whether an object of this JSON text names a key twice, however each is written (`"n"` and `"\u006e"` are one key). JSON.parse keeps the last, Swift's reader the first: the
 * same message would read two ways, and the digests that say whether the two devices agree would not catch it, because each hashes what it read. The text is valid JSON (it
 * was parsed), so a scan that tracks strings and brackets is enough; it keeps a set of keys for each object that is open, and never recurses.
 */
export function hasDuplicateKey(text: string): boolean {
  const open: Array<Set<string> | null> = []
  let expectKey = false
  for (let at = 0; at < text.length; at++) {
    const char = text.charCodeAt(at)
    if (char === 0x22) {
      // A string: up to its closing quote, the escapes skipped.
      let end = at + 1
      let escaped = false
      while (end < text.length) {
        const unit = text.charCodeAt(end)
        if (unit === 0x5c) {
          escaped = true
          end += 2
          continue
        }
        if (unit === 0x22) break
        end++
      }
      const keys = open[open.length - 1]
      if (keys !== null && keys !== undefined && expectKey) {
        const key = escaped ? (JSON.parse(text.slice(at, end + 1)) as string) : text.slice(at + 1, end)
        if (keys.has(key)) return true
        keys.add(key)
        expectKey = false
      }
      at = end
    } else if (char === 0x7b) {
      open.push(new Set())
      expectKey = true
    } else if (char === 0x5b) {
      open.push(null)
      expectKey = false
    } else if (char === 0x7d || char === 0x5d) {
      open.pop()
      expectKey = false
    } else if (char === 0x2c) expectKey = open[open.length - 1] instanceof Set
  }
  return false
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Walks a parsed value: how many values it holds (each one counted once), or null when it breaks a rule that holds wherever it is (see the head of the file). A `-0` met on
 * the way is written back as `0`. Iterative, with the depth of each node: the top object is at depth 1, and 32 levels are allowed.
 */
function walk(root: unknown): number | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }]
  let values = 0
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number }
    values++
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES || hasLoneSurrogate(value)) return null
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) >= 1e21 || (value !== 0 && Math.abs(value) < 1e-6)) return null
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    if (depth > MAX_JSON_DEPTH) return null
    // The count stops the walk as soon as it is over the bound of a frame: nothing past it is looked at.
    if (values > MAX_FRAME_VALUES) return values
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index] as unknown
        if (Object.is(item, -0)) {
          value[index] = 0
          values++
        } else stack.push({ value: item, depth: depth + 1 })
      }
      continue
    }
    if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return null
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (Buffer.byteLength(key, 'utf8') > MAX_STRING_BYTES || hasLoneSurrogate(key)) return null
      const item = record[key]
      if (Object.is(item, -0)) {
        record[key] = 0
        values++
      } else stack.push({ value: item, depth: depth + 1 })
    }
  }
  return values
}

/** What a connection may still hold in values (`MAX_SESSION_VALUES`): each message read spends its own. */
export interface ValueBudget {
  left: number
}

// ---------- the checks of the fields ----------

const isInt = (value: unknown, min = 0): value is number => Number.isInteger(value) && (value as number) >= min
/** A TCP port: a whole number from 1 to 65535. */
const isPort = (value: unknown): value is number => isInt(value, 1) && value <= 65535
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{22}$/
const PROOF = /^[A-Za-z0-9_-]{43}$/
const HEX_32 = /^[0-9a-f]{64}$/
/** A mark (§9.2): thirteen digits of milliseconds, four hexadecimal digits of counter, the device identifier; or `0`, the mark of a field never marked. */
export const STAMP = /^(0|[0-9]{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64})$/

const textBytes = (value: unknown, max: number): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max
const textList = (value: unknown, max: number, maxChars: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && item.length <= maxChars)

function readDevice(value: unknown): DeviceInfo | null {
  if (!isObject(value)) return null
  const { id, name, platform } = value
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || id.length > MAX_DEVICE_ID_CHARS) return null
  if (typeof name !== 'string' || name.length === 0 || [...name].length > MAX_DEVICE_NAME_CHARS) return null
  if (platform !== 'mac' && platform !== 'ios') return null
  return { id, name, platform }
}

function readEntity(value: unknown): WireEntity | null {
  if (!isObject(value)) return null
  const { kind, id, fields, stamps } = value
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 64 || isInheritedName(kind)) return null
  if (typeof id !== 'string' || id.length === 0 || id.length > 128 || isInheritedName(id)) return null
  if (!isObject(fields) || !isObject(stamps)) return null
  if (!Object.values(stamps).every((stamp) => typeof stamp === 'string' && STAMP.test(stamp))) return null
  return { kind, id, fields, stamps: stamps as Record<string, string> }
}

function readTombstone(value: unknown): WireTombstone | null {
  if (!isObject(value)) return null
  const { kind, id, stamp } = value
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 64 || isInheritedName(kind) || typeof id !== 'string' || id.length === 0 || id.length > 128 || isInheritedName(id)) return null
  return typeof stamp === 'string' && STAMP.test(stamp) ? { kind, id, stamp } : null
}

function readOpenTab(value: unknown): OpenTab | null {
  if (!isObject(value)) return null
  const { id, spaceId, url, title, lastActiveAt } = value
  if (typeof id !== 'string' || typeof spaceId !== 'string' || !textBytes(url, MAX_OPEN_TAB_URL_BYTES) || !textBytes(title, MAX_OPEN_TAB_TITLE_BYTES) || !isInt(lastActiveAt)) return null
  return { id, spaceId, url, title, lastActiveAt }
}

/** Every item of a list read by `read`, or null when the list is too long, is not a list, or holds an item that does not read. */
function readList<T>(value: unknown, max: number, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const items: T[] = []
  for (const item of value) {
    const one = read(item)
    if (one === null) return null
    items.push(one)
  }
  return items
}

// ---------- one reader per type ----------

type Fields<M extends Message> = Omit<M, 'v' | 'n' | 't'>
type Reader<M extends Message> = (m: Record<string, unknown>) => Fields<M> | null

const readHello: Reader<Hello> = (m) => {
  const device = readDevice(m['device'])
  if (device === null || typeof m['nonce'] !== 'string' || !NONCE.test(m['nonce'])) return null
  if (!textList(m['categories'], MAX_CATEGORIES, 32)) return null
  const baseHash = m['baseHash']
  if (baseHash !== null && (typeof baseHash !== 'string' || !HEX_32.test(baseHash))) return null
  if (!isInt(m['stateVersion'], 1) || !textBytes(m['appVersion'], 32) || !isInt(m['now'])) return null
  if (m['hosts'] !== undefined && !textList(m['hosts'], MAX_HOSTS, 253)) return null
  if (m['port'] !== undefined && !isPort(m['port'])) return null
  return { device, nonce: m['nonce'], categories: m['categories'], baseHash, stateVersion: m['stateVersion'], appVersion: m['appVersion'], now: m['now'], ...(m['hosts'] !== undefined ? { hosts: m['hosts'] } : {}), ...(m['port'] !== undefined ? { port: m['port'] } : {}) }
}

const readPairRequest: Reader<PairRequest> = (m) => {
  const device = readDevice(m['device'])
  if (device === null || typeof m['nonce'] !== 'string' || !NONCE.test(m['nonce']) || typeof m['proof'] !== 'string' || !PROOF.test(m['proof'])) return null
  // The commitment is a SHA-256 (§4.7): a request without one is the form that had none, and is refused as a message that is not well formed.
  if (typeof m['commit'] !== 'string' || !PROOF.test(m['commit'])) return null
  return { device, nonce: m['nonce'], proof: m['proof'], commit: m['commit'] }
}

const readPairAccept: Reader<PairAccept> = (m) => {
  const device = readDevice(m['device'])
  if (device === null || typeof m['proof'] !== 'string' || !PROOF.test(m['proof']) || !textList(m['hosts'], MAX_HOSTS, 253) || !isPort(m['port'])) return null
  return { device, proof: m['proof'], hosts: m['hosts'], port: m['port'] }
}

const readSnapshotPart: Reader<SnapshotPart> = (m) => {
  const { part, parts } = m
  if (!isInt(part) || !isInt(parts, 1) || parts > MAX_PARTS || part >= parts) return null
  const entities = readList(m['entities'], MAX_ENTITIES_PER_PART, readEntity)
  if (entities === null) return null
  const result: Fields<SnapshotPart> = { part, parts, entities }
  if (m['tombstones'] !== undefined) {
    // The tombstones of a part follow the same bound as its entities: a part never carries more than a frame holds, and a frame is bounded already.
    const tombstones = readList(m['tombstones'], 100_000, readTombstone)
    if (tombstones === null) return null
    result.tombstones = tombstones
  }
  if (m['order'] !== undefined) {
    const order = m['order']
    if (!isObject(order) || !Object.keys(order).every((key) => !isInheritedName(key)) || !Object.values(order).every((list) => textList(list, 100_000, 128) && list.every((id) => !isInheritedName(id)))) return null
    result.order = order as Record<string, string[]>
  }
  if (m['orderStamps'] !== undefined) {
    const stamps = m['orderStamps']
    if (!isObject(stamps) || !Object.keys(stamps).every((key) => !isInheritedName(key)) || !Object.values(stamps).every((stamp) => typeof stamp === 'string' && STAMP.test(stamp))) return null
    result.orderStamps = stamps as Record<string, string>
  }
  if (m['withheld'] !== undefined) {
    if (!textList(m['withheld'], 10_000, 128) || !m['withheld'].every((id) => !isInheritedName(id))) return null
    result.withheld = m['withheld']
  }
  return result
}

const readSnapshotEnd: Reader<SnapshotEnd> = (m) => (isInt(m['entityCount']) && typeof m['digest'] === 'string' && HEX_32.test(m['digest']) ? { entityCount: m['entityCount'], digest: m['digest'] } : null)

const readOpenTabs: Reader<OpenTabs> = (m) => {
  const items = readList(m['items'], MAX_OPEN_TABS, readOpenTab)
  return items === null ? null : { items }
}

const readDigest = (m: Record<string, unknown>): { digest: string } | null => (typeof m['digest'] === 'string' && HEX_32.test(m['digest']) ? { digest: m['digest'] } : null)

const readError: Reader<ErrorMessage> = (m) => {
  const { code, fatal, supported, detail } = m
  if (!isErrorCode(code) || typeof fatal !== 'boolean') return null
  if (supported !== undefined && (!Array.isArray(supported) || !supported.every((version) => isInt(version)))) return null
  if (detail !== undefined && !textBytes(detail, 200)) return null
  return { code, fatal, ...(supported !== undefined ? { supported: supported as number[] } : {}), ...(detail !== undefined ? { detail } : {}) }
}

const READERS: { [T in MessageType]: Reader<Extract<Message, { t: T }>> } = {
  hello: readHello,
  'pair.challenge': (m) => (typeof m['nonce'] === 'string' && NONCE.test(m['nonce']) ? { nonce: m['nonce'] } : null),
  'pair.request': readPairRequest,
  'pair.nonce': (m) => (typeof m['nonce'] === 'string' && NONCE.test(m['nonce']) ? { nonce: m['nonce'] } : null),
  'pair.reveal': (m) => (typeof m['nonce'] === 'string' && NONCE.test(m['nonce']) ? { nonce: m['nonce'] } : null),
  'pair.accept': readPairAccept,
  'snapshot.part': readSnapshotPart,
  'snapshot.end': readSnapshotEnd,
  'open-tabs': readOpenTabs,
  result: readDigest,
  commit: readDigest,
  unpair: () => ({}),
  error: readError,
  bye: () => ({})
}

export type Parsed = { ok: true; message: Message } | { ok: false; code: ErrorCode }

/**
 * The message a frame holds, or the code of why it is refused: `bad-message` for text that is not a well-formed message, `unsupported-version` for a `v` that is
 * not ours (before the type is looked at), `unknown-type` for a type this version does not speak. A field this version does not know, in a known type, is ignored
 * and does not come out: only the entities of a snapshot keep their unknown fields (§7.1, §11.6).
 */
export function parseMessage(text: string, budget?: ValueBudget): Parsed {
  const bad: Parsed = { ok: false, code: 'bad-message' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return bad
  }
  if (!isObject(value)) return bad
  if (hasDuplicateKey(text)) return bad
  const values = walk(value)
  if (values === null) return bad
  // Too many values for one frame, or for what the connection has left: refused as too large, before the fields are read (a field of a million lists is not read).
  if (values > MAX_FRAME_VALUES) return { ok: false, code: 'too-large' }
  if (budget !== undefined) {
    budget.left -= values
    if (budget.left < 0) return { ok: false, code: 'too-large' }
  }
  const { v, t, n } = value
  if (!isInt(n, 1) || typeof t !== 'string' || !Number.isInteger(v)) return bad
  if (v !== PROTOCOL_VERSION) return { ok: false, code: 'unsupported-version' }
  if (!Object.hasOwn(READERS, t)) return { ok: false, code: 'unknown-type' }
  const read = READERS[t as MessageType] as Reader<Message>
  const fields = read(value)
  return fields === null ? bad : { ok: true, message: { v: PROTOCOL_VERSION, n, t, ...fields } as Message }
}

/** A frame's content as text: UTF-8 that is not valid is a bad message, not a message with replacement characters. */
export function messageText(content: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }
}

// ---------- the numbers and the order ----------

/**
 * The numbering of one direction (§7.1): from 1, one more at every message (an `error` counts). Another value is `bad-sequence`, and the connection ends: TCP and
 * TLS already deliver in order, so a gap is a bug or an attack. One instance numbers what is received; another, what is sent (`next`).
 */
export class Numbering {
  private expected = 1

  /** Checks the number of a message received. */
  accept(n: number): Verdict {
    if (n !== this.expected) return { ok: false, code: 'bad-sequence' }
    this.expected++
    return { ok: true }
  }

  /** The number of the next message to send. */
  next(): number {
    return this.expected++
  }
}

export type Phase = 'pairing' | 'session'
export type Role = 'mac' | 'ios'

/**
 * Which type may come after the ones already received (§7.4), for the one who receives. A message out of its phase is a bad message and the connection ends.
 * `error` and `bye` are always welcome. The pairing is `pair.challenge` → `pair.request` → `pair.nonce` → `pair.reveal` → `pair.accept` (the Mac reads `pair.request`
 * then `pair.reveal`, the iPhone `pair.challenge`, `pair.nonce`, `pair.accept`: §4.7); a session is `hello` on both sides, then the snapshot
 * parts and the end, `result`, `commit`.
 */
export class PhaseTracker {
  private readonly seen = new Set<MessageType>()

  constructor(private readonly receiver: Role, private readonly phase: Phase) {}

  accept(type: MessageType): Verdict {
    const bad: Verdict = { ok: false, code: 'bad-message' }
    if (type === 'error' || type === 'bye') return { ok: true }
    const allowed = this.allows(type)
    if (!allowed) return bad
    this.seen.add(type)
    return { ok: true }
  }

  /** The types received so far, for a caller that must know where the exchange stands. */
  has(type: MessageType): boolean {
    return this.seen.has(type)
  }

  private allows(type: MessageType): boolean {
    const seen = (one: MessageType): boolean => this.seen.has(one)
    if (this.phase === 'pairing') {
      if (this.receiver === 'mac') return (type === 'pair.request' && !seen('pair.request')) || (type === 'pair.reveal' && seen('pair.request') && !seen('pair.reveal'))
      if (this.seen.size === 0) return type === 'pair.challenge'
      if (this.seen.size === 1) return seen('pair.challenge') && type === 'pair.nonce'
      return this.seen.size === 2 && seen('pair.nonce') && type === 'pair.accept'
    }
    switch (type) {
      case 'hello':
        return !seen('hello')
      case 'snapshot.part':
      case 'open-tabs':
        return seen('hello') && !seen('snapshot.end')
      case 'snapshot.end':
        return seen('snapshot.part') && !seen('snapshot.end')
      case 'result':
        return seen('snapshot.end') && !seen('result')
      case 'commit':
        return seen('result') && !seen('commit')
      case 'unpair':
        return seen('hello')
      default:
        return false
    }
  }
}
