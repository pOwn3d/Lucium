// The shared Today tabs of docs/synchronisation.md §27, as pure functions: what makes a tab of "Today" enter the shared set (admission, §27.3, §27.4), what the door
// lets through of a `todayTab` entity that comes in (§27.4, §27.7) and what a patch that removes one kind and creates the other for the same id means (§27.2).
//
// Written twice, here and in LuciumKit (`SyncToday.swift`), and held together by ios/Contracts/sync-today-vectors.json: the Mac's `cleanSnapshot` and the phone's
// `SyncInbound.clean` call the door, the view of each device calls the admission, and the apply step calls the moves. A rule that differed on one side would make the two
// merges start from other inputs, and the session would end in `divergence` (§8.5). No Electron, no clock, no disk: every input is an argument.
import { cutBytes } from './state-clean'
import { compareUtf16 } from './sync-canonical'
import type { SyncEntity } from './sync-snapshot'

/** The kind of the entity (§27.2), distinct from `tab` (the pinned tabs): the two categories are ticked apart. */
export const TODAY_TAB_KIND = 'todayTab'

/**
 * The most Today tabs one device admits **itself** at a time [Q12, A: 200 per device, the rest stays local]: one that does not fit stays local, and is admitted when a place is
 * free (§27.4). The tabs it received from the other device (`adopted`) take no place: the shared set goes up to twice this.
 */
export const TODAY_TAB_CAP = 200
/** The most `todayTab` entities the door keeps in one snapshot (§27.4): an honest device never reaches it (it admits 200). */
export const TODAY_TAB_GATE = 500
/** The longest address of a shared tab, in bytes: a longer one is left out, never cut (a cut address is another page). */
export const TODAY_URL_MAX_BYTES = 4096
/** The longest title, in bytes: a longer one is cut without splitting a pair of surrogates (`cutBytes`). */
export const TODAY_TITLE_MAX_BYTES = 300
/** How long a tab must have been open to enter: a window of authentication or a redirection is not shared (§27.3, condition 4). */
export const TODAY_MIN_AGE_MS = 20_000
/** The step `activeAt` is rounded down to: ten minutes (§27.2). */
export const ACTIVE_AT_STEP_MS = 600_000

/**
 * The classes of the fields of a `todayTab` (§27.2, §10.2). `activeAt` is a projection of `lastActiveAt`, not a field of the model. `notApplicable` are the fields of the
 * model that only a pinned tab has: a Today tab is never pinned, has no anchor and sits in no folder.
 */
export const TODAY_TAB_FIELD_CLASSES = {
  synced: ['id', 'spaceId', 'customTitle', 'icon', 'activeAt'],
  seed: ['url', 'title'],
  local: ['image', 'faviconUrl', 'deadKept', 'autoReload', 'container', 'windowKey', 'openerId', 'parentId', 'treeCollapsed', 'favoriteId', 'createdAt', 'lastActiveAt', 'private', 'keepAwake'],
  notApplicable: ['pinned', 'anchorUrl', 'folderId']
} as const

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The activity
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** `activeAt`: the moment of the last use, rounded down to ten minutes (§27.2). A value that is not a finite, positive number is 0. */
export function roundActiveAt(lastActiveAt: number): number {
  if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return 0
  return Math.floor(lastActiveAt / ACTIVE_AT_STEP_MS) * ACTIVE_AT_STEP_MS
}

/** What a device writes as `lastActiveAt` when it receives an `activeAt`: the greater of the two, so that a tab read elsewhere is not swept here (§27.5, [Q10]). */
export const lastActiveFrom = (local: number, received: number): number => Math.max(local, received)

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** An http or https address with a host, of at most `TODAY_URL_MAX_BYTES` bytes: the only pages a shared tab may be on (§27.3, condition 3; §27.7). */
export function isShareableAddress(value: unknown): boolean {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || !URL.canParse(value)) return false
  return value.length * 3 <= TODAY_URL_MAX_BYTES || Buffer.byteLength(value, 'utf8') <= TODAY_URL_MAX_BYTES
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The admission (§27.3, §27.4)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface TodayCandidate {
  id: string
  url: string
  /** How long the tab has been open, in ms. */
  ageMs: number
  /** The raw `lastActiveAt`: it ranks the tabs that compete for a place. */
  lastActiveAt: number
  /** A private tab (condition 1). */
  private?: boolean
  /** A tab of a private window (condition 1: the window, not the tab, is private). */
  privateWindow?: boolean
  /** The page of a favourite (condition 1). */
  favorite?: boolean
  /** A tab of a container: an isolation the person wanted, its address does not leave (condition 1). */
  container?: boolean
  /** The space is locked (condition 2). */
  spaceLocked?: boolean
  /** Already in the shared set (the book of marks says so): the admission is sticky. */
  admitted?: boolean
  /** In the shared set because the other device sent it (adopted), not because this one admitted it: it stays, and it takes no place of the cap (§27.4). */
  adopted?: boolean
}

export type AdmissionRefusal = 'private' | 'private-window' | 'favorite' | 'container' | 'space-locked' | 'not-web-address' | 'url-too-long' | 'too-young' | 'full'

/** Condition 1 is looked at every time; the sticky admission skips only 2 to 5. */
function refusalOfKind(c: TodayCandidate): AdmissionRefusal | null {
  if (c.private === true) return 'private'
  if (c.privateWindow === true) return 'private-window'
  if (c.favorite === true) return 'favorite'
  if (c.container === true) return 'container'
  return null
}

/** Conditions 2 to 4 of a tab that is not yet admitted (condition 5, the place, is for `admitTabs`, which sees them all). */
function refusalOfEntry(c: TodayCandidate): AdmissionRefusal | null {
  if (c.spaceLocked === true) return 'space-locked'
  if (!/^https?:\/\//i.test(c.url) || !URL.canParse(c.url)) return 'not-web-address'
  if (!isShareableAddress(c.url)) return 'url-too-long'
  if (c.ageMs < TODAY_MIN_AGE_MS) return 'too-young'
  return null
}

export interface Admission {
  /** The ids of the shared set, sorted by UTF-16 code unit. */
  admitted: string[]
  /** The ids left out, sorted, with why. */
  refused: { id: string; reason: AdmissionRefusal }[]
}

/**
 * The shared set at the end of the freeze of a session (§27.3). A tab already admitted stays whatever page it is on, and whatever the cap: neither a navigation, nor a
 * full set, nor a lock set later takes it out of the snapshot, since the merge reads "absent from one side, in the base" as a closing (§11.2). A new tab enters when it holds
 * conditions 1 to 4, and while there is a place: `cap` less the tabs this device admitted itself (the adopted ones, received from the other device, take no place), the most
 * recently used first, then the id (§27.4).
 */
export function admitTabs(candidates: readonly TodayCandidate[], cap: number = TODAY_TAB_CAP): Admission {
  const admitted: string[] = []
  let admittedHere = 0
  const refused: Admission['refused'] = []
  const waiting: TodayCandidate[] = []
  for (const c of candidates) {
    const kind = refusalOfKind(c)
    if (kind !== null) refused.push({ id: c.id, reason: kind })
    else if (c.admitted === true) {
      admitted.push(c.id)
      if (c.adopted !== true) admittedHere += 1
    } else {
      const entry = refusalOfEntry(c)
      if (entry !== null) refused.push({ id: c.id, reason: entry })
      else waiting.push(c)
    }
  }
  let room = Math.max(0, cap - admittedHere)
  waiting.sort((a, b) => b.lastActiveAt - a.lastActiveAt || compareUtf16(a.id, b.id))
  for (const c of waiting) {
    if (room > 0) {
      admitted.push(c.id)
      room -= 1
    } else refused.push({ id: c.id, reason: 'full' })
  }
  return { admitted: admitted.sort(compareUtf16), refused: refused.sort((a, b) => compareUtf16(a.id, b.id)) }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The door (§27.4, §27.7)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type TodayRefusal = 'invalid-url' | 'invalid-value' | 'too-many-today-tabs'

export interface TodayGate {
  /** What passes, by id: the local fields are taken off (with their marks), the title is cut, and an entity refused for what cannot travel now is the one the base holds. */
  entities: Record<string, SyncEntity>
  /** Sorted by id. */
  refused: { id: string; reason: TodayRefusal }[]
}

const LOCAL: readonly string[] = TODAY_TAB_FIELD_CLASSES.local

/** A mark of a field of the class "local" has no business in a snapshot: a device does not tell this one what its local files are (§10.2). */
function withoutLocal(entity: SyncEntity): SyncEntity {
  return {
    fields: Object.fromEntries(Object.entries(entity.fields).filter(([name]) => !LOCAL.includes(name))) as SyncEntity['fields'],
    stamps: Object.fromEntries(Object.entries(entity.stamps).filter(([name]) => !LOCAL.includes(name)))
  }
}

/** Why one `todayTab` entity cannot be taken as it is: an address that is not a web page (or is too long), an `activeAt` that is not a number. A title is cut, not refused. */
function problemOf(entity: SyncEntity): TodayRefusal | null {
  const { url, title, activeAt } = entity.fields
  if (url !== undefined && !isShareableAddress(url)) return 'invalid-url'
  if (title !== undefined && typeof title !== 'string') return 'invalid-value'
  if (activeAt !== undefined && (typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt < 0)) return 'invalid-value'
  return null
}

const activeAtOf = (entity: SyncEntity): number => {
  const value = entity.fields['activeAt']
  return typeof value === 'number' ? value : 0
}

/**
 * The `todayTab` entities of a snapshot that comes in, or that this device is about to send (both devices must start from the same inputs, §22). An entity refused for its
 * address or a value, and the ones beyond the 500 best ranked (`activeAt`, newest first, then the id), are dropped and listed; one that is in `base` is given back as the
 * base holds it, so that the gap is not read as a deletion by the other device (the rule of §22, "an entity refused that is in the base"). Never fatal.
 *
 * The generic checks of the door (a mark in the future, a lone surrogate, a kind that is never synchronised) are those of `cleanSnapshot` and `SyncInbound.clean`, which
 * call this for the kind: what is here is what only a Today tab needs.
 */
export function gateTodayTabs(entities: Readonly<Record<string, SyncEntity>>, base: Readonly<Record<string, SyncEntity>> | null = null, limit: number = TODAY_TAB_GATE): TodayGate {
  const passed: Record<string, SyncEntity> = {}
  const refused: TodayGate['refused'] = []
  const standIn = (id: string): void => {
    const before = base !== null && Object.hasOwn(base, id) ? base[id] : undefined
    if (before !== undefined) passed[id] = before
  }
  const ranked: string[] = []
  for (const [id, entity] of Object.entries(entities)) {
    const problem = problemOf(entity)
    if (problem !== null) {
      refused.push({ id, reason: problem })
      standIn(id)
      continue
    }
    const clean = withoutLocal(entity)
    if (typeof clean.fields['title'] === 'string') clean.fields['title'] = cutBytes(clean.fields['title'], TODAY_TITLE_MAX_BYTES)
    passed[id] = clean
    ranked.push(id)
  }
  if (ranked.length > limit) {
    ranked.sort((a, b) => activeAtOf(passed[b] as SyncEntity) - activeAtOf(passed[a] as SyncEntity) || compareUtf16(a, b))
    for (const id of ranked.slice(limit)) {
      refused.push({ id, reason: 'too-many-today-tabs' })
      delete passed[id]
      standIn(id)
    }
  }
  return { entities: passed, refused: refused.sort((a, b) => compareUtf16(a.id, b.id)) }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Pinning and unpinning (§27.2)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface TodayMove {
  id: string
  /** `todayTab` → `tab` is a pinning; `tab` → `todayTab` is a detaching. */
  from: 'todayTab' | 'tab'
  to: 'tab' | 'todayTab'
}

/**
 * Which of the patch's creations and removals are one tab changing list. A removal of `todayTab/<id>` with a creation of `tab/<id>` in the same patch (or the other way
 * round) is a move: the tab stays, changes list and keeps its page. Without this a removal and a creation would cross on one tab. A removal alone is a closing, a creation
 * alone is an opening (so is a pinning when `structure` is not common: the other device never sees `tab/<id>`, §27.2). Sorted by id.
 */
export function todayMoves(removed: readonly { kind: string; id: string }[], created: readonly { kind: string; id: string }[]): TodayMove[] {
  const removedToday = new Set(removed.filter((r) => r.kind === TODAY_TAB_KIND).map((r) => r.id))
  const removedPinned = new Set(removed.filter((r) => r.kind === 'tab').map((r) => r.id))
  const moves: TodayMove[] = []
  for (const c of created) {
    if (c.kind === 'tab' && removedToday.has(c.id)) moves.push({ id: c.id, from: 'todayTab', to: 'tab' })
    else if (c.kind === TODAY_TAB_KIND && removedPinned.has(c.id)) moves.push({ id: c.id, from: 'tab', to: 'todayTab' })
  }
  return moves.sort((a, b) => compareUtf16(a.id, b.id))
}
