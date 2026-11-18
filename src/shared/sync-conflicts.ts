// What the person is told after two devices changed the same thing (docs/synchronisation.md §11.7.3 and §13.4, the mockup « Conflit réglé »): the journal of the
// conflicts the merge settled, kept on the device for 30 days so that « Comparer » can show both versions and « Rétablir » can put the one that lost back, and the
// description of each conflict as sentences (keys of the catalogue and the words to put in them). Pure: the files, the clock and the screens belong to the callers.
// Written twice, here and in LuciumKit (`SyncConflicts.swift`), and held together by ios/Contracts/sync-conflict-vectors.json.
//
// The journal holds titles and addresses (what the person typed), so it follows the rules of the other files of the device: it stays on the device, it is
// never sent, and it goes with the device that is forgotten (§12). It never holds a secret, a password or a lock: those are never synchronised.
import { canonicalJson, compareUtf16, type JsonValue } from './sync-canonical'
import { otherSide, type ConflictReason, type ConflictSide, type SyncConflict } from './sync-merge'
import { SNAPSHOT_LIMITS, ZERO_STAMP, maxStamp, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

export const JOURNAL_LIMITS = {
  /** §11.7.3: at most 200 lines. */
  maxEntries: 200,
  /** §11.5: a thing that was settled is kept 30 days. */
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  /** A value too large to keep is shown as « another value » and cannot be put back. */
  maxValueChars: 4096,
  maxShownChars: 80,
  maxLabelChars: 120,
  maxListIds: 500,
  /** A journal file is read only up to this size (a hostile or damaged file is bounded before it is read). */
  maxFileChars: 4 * 1024 * 1024,
} as const

export type Platform = 'mac' | 'ios'
export const otherPlatform = (platform: Platform): Platform => (platform === 'mac' ? 'ios' : 'mac')

/** A value as the person reads it. */
export type SettledValue = { t: 'text'; text: string } | { t: 'bool'; value: boolean } | { t: 'absent' } | { t: 'complex' }

/** What to do to put back the version that lost: an ordinary change of the state, which goes out at the next session like any other. */
export type SettledChange =
  | { type: 'set'; kind: string; id: string; field: string; value: JsonValue }
  | { type: 'unset'; kind: string; id: string; field: string }
  | { type: 'delete'; kind: string; id: string }
  | { type: 'order'; list: string; ids: string[] }

export interface SettledConflict {
  /** The same thing settled again replaces its line: `[kind, id, field]` written as JSON. */
  id: string
  /** When the session ended, on the clock of the device (ms). Every line of one session has the same value. */
  settledAt: number
  /** The other device. */
  peer: Platform
  kind: string
  entityId: string
  field: string | null
  reason: ConflictReason
  /** From the point of view of this device. */
  winner: ConflictSide
  /** The name of the thing at that time: what the person typed. */
  label: string | null
  kept: SettledValue
  lost: SettledValue
  /** When each side made its change (ms, from the marks), or null for a mark of zero. */
  keptAt: number | null
  lostAt: number | null
  restore: SettledChange | null
}

const entryId = (kind: string, id: string, field: string | null): string => JSON.stringify([kind, id, field])

/** The time a mark says (its first 13 digits), or null for the mark of zero. */
export function stampTime(mark: string): number | null {
  if (mark === ZERO_STAMP) return null
  const ms = Number(mark.slice(0, 13))
  return Number.isSafeInteger(ms) ? ms : null
}

/** A text cut to a number of characters (code points, not UTF-16 units: a smiley is one), with « … » when something was cut. */
export function clip(text: string, max: number): string {
  const characters = Array.from(text)
  return characters.length <= max ? text : `${characters.slice(0, max).join('')}…`
}

const str = (fields: Record<string, JsonValue>, name: string): string | null => {
  const value = fields[name]
  return typeof value === 'string' && value !== '' ? value : null
}

/** What the person calls an entity (§11.7.3): the name of a space or a folder, the title of a tab, a favourite or an archived tab, else its address. */
export function labelOf(kind: string, fields: Record<string, JsonValue>): string | null {
  const text = ((): string | null => {
    switch (kind) {
      case 'space':
      case 'folder':
        return str(fields, 'name')
      case 'tab':
        return str(fields, 'customTitle') ?? str(fields, 'title') ?? str(fields, 'anchorUrl')
      case 'favorite':
      case 'archived':
        return str(fields, 'title') ?? str(fields, 'url')
      default:
        return null
    }
  })()
  return text === null ? null : clip(text, JOURNAL_LIMITS.maxLabelChars)
}

export interface SettleInput {
  conflicts: readonly SyncConflict[]
  /** What each device froze at the start of the session, and what the merge gave. */
  local: SyncSnapshot
  remote: SyncSnapshot
  merged: SyncSnapshot
  /** The end of the session, on the clock of this device (ms). */
  now: number
  /** The other device. */
  peer: Platform
}

/**
 * The journal lines of the conflicts a merge settled: what each side had, who won, and what puts the other version back. Without a clock, a disk or a screen:
 * the same lines on both sides of the language barrier (the vectors `settle`).
 */
export function settleConflicts(input: SettleInput): SettledConflict[] {
  const { local, remote, merged } = input
  const side = (which: ConflictSide): SyncSnapshot => (which === 'local' ? local : remote)
  const entityOf = (kind: string, id: string): SyncEntity | undefined => merged.entities[kind]?.[id] ?? local.entities[kind]?.[id] ?? remote.entities[kind]?.[id]
  const nameOf = (kind: string, id: string): string | null => {
    const entity = entityOf(kind, id)
    return entity === undefined ? null : labelOf(kind, entity.fields)
  }
  const shown = (field: string, value: JsonValue | undefined): SettledValue => {
    if (value === undefined) return { t: 'absent' }
    if (typeof value === 'boolean') return { t: 'bool', value }
    if (typeof value === 'number') return { t: 'text', text: canonicalJson(value) }
    if (typeof value === 'string') {
      const target = field === 'spaceId' ? 'space' : field === 'parentId' || field === 'folderId' ? 'folder' : null
      if (target !== null) {
        const name = nameOf(target, value)
        return name === null ? { t: 'complex' } : { t: 'text', text: name }
      }
      return field === 'profileId' ? { t: 'complex' } : { t: 'text', text: clip(value, JOURNAL_LIMITS.maxShownChars) }
    }
    return { t: 'complex' }
  }
  const lines: SettledConflict[] = []
  for (const conflict of input.conflicts) {
    const { kind, id, field, winner } = conflict
    const loser = otherSide(winner)
    const common = { id: entryId(kind, id, field), settledAt: input.now, peer: input.peer, kind, entityId: id, field, reason: conflict.reason, winner }
    if (kind === 'order') {
      const ids = side(loser).order[id] ?? []
      lines.push({
        ...common,
        label: orderLabel(id, nameOf),
        kept: { t: 'complex' },
        lost: { t: 'complex' },
        keptAt: stampTime(side(winner).orderStamps[id] ?? ZERO_STAMP),
        lostAt: stampTime(side(loser).orderStamps[id] ?? ZERO_STAMP),
        restore: ids.length > 0 && ids.length <= JOURNAL_LIMITS.maxListIds ? { type: 'order', list: id, ids: [...ids] } : null,
      })
    } else if (field === null) {
      // A deletion that lost: the entity is kept on both devices, and putting the other version back means deleting it.
      const kept = entityOf(kind, id)
      const tombstone = side(loser).tombstones[kind]?.[id] ?? ZERO_STAMP
      lines.push({
        ...common,
        label: kept === undefined ? null : labelOf(kind, kept.fields),
        kept: { t: 'absent' },
        lost: { t: 'absent' },
        keptAt: stampTime(maxStamp(...Object.values(side(winner).entities[kind]?.[id]?.stamps ?? {}))),
        lostAt: stampTime(tombstone),
        restore: { type: 'delete', kind, id },
      })
    } else {
      const winning = side(winner).entities[kind]?.[id]
      const losing = side(loser).entities[kind]?.[id]
      const lostValue = losing?.fields[field]
      const tooLarge = lostValue !== undefined && canonicalJson(lostValue).length > JOURNAL_LIMITS.maxValueChars
      lines.push({
        ...common,
        label: nameOf(kind, id),
        kept: shown(field, winning?.fields[field]),
        lost: tooLarge ? { t: 'complex' } : shown(field, lostValue),
        keptAt: stampTime(winning?.stamps[field] ?? ZERO_STAMP),
        lostAt: stampTime(losing?.stamps[field] ?? ZERO_STAMP),
        restore: tooLarge ? null : lostValue === undefined ? { type: 'unset', kind, id, field } : { type: 'set', kind, id, field, value: lostValue },
      })
    }
  }
  return lines
}

/** The name of the container of a list (the space of its tabs or folders), or null: the lists of spaces and of favourites have none. */
function orderLabel(key: string, nameOf: (kind: string, id: string) => string | null): string | null {
  const parts = key.split(':')
  return (parts[0] === 'tabs' || parts[0] === 'folders') && parts[1] !== undefined && parts[1] !== '-' ? nameOf('space', parts[1]) : null
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The lines newer than 30 days, the newest first (then by id), at most 200. A line from the future (a clock that went back) is kept until its turn comes. */
export function pruneJournal(entries: readonly SettledConflict[], now: number): SettledConflict[] {
  return entries
    .filter((entry) => now - entry.settledAt <= JOURNAL_LIMITS.retentionMs)
    .sort((a, b) => b.settledAt - a.settledAt || compareUtf16(a.id, b.id))
    .slice(0, JOURNAL_LIMITS.maxEntries)
}

/** What a session settled goes in, a line that settles the same thing again replaces the older one, and the journal is pruned. */
export function addToJournal(journal: readonly SettledConflict[], settled: readonly SettledConflict[], now: number): SettledConflict[] {
  const replaced = new Set(settled.map((entry) => entry.id))
  return pruneJournal([...journal.filter((entry) => !replaced.has(entry.id)), ...settled], now)
}

/** « D'accord » on a line, or « Rétablir » done: the line goes. */
export const removeFromJournal = (journal: readonly SettledConflict[], id: string): SettledConflict[] => journal.filter((entry) => entry.id !== id)

/** The lines of the last session (those with the greatest `settledAt`): the content of the « Conflit réglé » screen. */
export function lastSession(journal: readonly SettledConflict[]): SettledConflict[] {
  const last = journal.reduce((latest, entry) => Math.max(latest, entry.settledAt), -Infinity)
  return journal.filter((entry) => entry.settledAt === last).sort((a, b) => compareUtf16(a.kind, b.kind) || compareUtf16(a.entityId, b.entityId) || compareUtf16(a.field ?? '', b.field ?? ''))
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A name used to find a line or an entity: not empty, not too long, and in normalization form C (a Swift string or dictionary does not tell two forms apart, JavaScript does). */
const isName = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.normalize('NFC') === value
const REASONS: readonly unknown[] = ['newer', 'device-id', 'value', 'modification-over-deletion', 'order']

function readValue(value: unknown): SettledValue | null {
  if (!isObject(value)) return null
  switch (value['t']) {
    case 'text':
      return typeof value['text'] === 'string' && value['text'].length <= JOURNAL_LIMITS.maxShownChars * 2 ? { t: 'text', text: value['text'] } : null
    case 'bool':
      return typeof value['value'] === 'boolean' ? { t: 'bool', value: value['value'] } : null
    case 'absent':
      return { t: 'absent' }
    case 'complex':
      return { t: 'complex' }
    default:
      return null
  }
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const jsonOk = (value: unknown, depth = 0): boolean => {
  if (depth > SNAPSHOT_LIMITS.maxJsonDepth) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => jsonOk(item, depth + 1))
  return isObject(value) && Object.keys(value).every((key) => key !== '__proto__' && key.normalize('NFC') === key && jsonOk(value[key], depth + 1))
}

function readChange(value: unknown): SettledChange | null | undefined {
  if (value === null) return null
  if (!isObject(value)) return undefined
  const { type } = value
  if (type === 'set' || type === 'unset' || type === 'delete') {
    const { kind, id, field } = value
    if (!isName(kind, SNAPSHOT_LIMITS.maxKindChars) || !isName(id, SNAPSHOT_LIMITS.maxIdChars)) return undefined
    if (type === 'delete') return { type, kind, id }
    if (!isName(field, SNAPSHOT_LIMITS.maxFieldNameChars)) return undefined
    if (type === 'unset') return { type, kind, id, field }
    return jsonOk(value['value']) && canonicalJson(value['value']).length <= JOURNAL_LIMITS.maxValueChars ? { type, kind, id, field, value: value['value'] as JsonValue } : undefined
  }
  if (type === 'order') {
    const { list, ids } = value
    if (!isName(list, SNAPSHOT_LIMITS.maxListKeyChars) || !Array.isArray(ids) || ids.length > JOURNAL_LIMITS.maxListIds || !ids.every((id) => isName(id, SNAPSHOT_LIMITS.maxIdChars))) return undefined
    return { type, list, ids: [...(ids as string[])] }
  }
  return undefined
}

/** One line read from a file: its form or null. Nothing of what a file says is trusted: every member is checked, bounded and copied. */
export function readSettledConflict(value: unknown): SettledConflict | null {
  if (!isObject(value)) return null
  const { id, settledAt, peer, kind, entityId, field, reason, winner, label, keptAt, lostAt } = value
  const kept = readValue(value['kept'])
  const lost = readValue(value['lost'])
  const restore = readChange(value['restore'])
  if (!isName(id, 1024) || !isTime(settledAt) || (peer !== 'mac' && peer !== 'ios')) return null
  if (!isName(kind, SNAPSHOT_LIMITS.maxKindChars) || !isName(entityId, SNAPSHOT_LIMITS.maxListKeyChars)) return null
  if (field !== null && !isName(field, SNAPSHOT_LIMITS.maxFieldNameChars)) return null
  if (!REASONS.includes(reason) || (winner !== 'local' && winner !== 'remote')) return null
  if (label !== null && (typeof label !== 'string' || Array.from(label).length > JOURNAL_LIMITS.maxLabelChars + 1)) return null
  if (kept === null || lost === null || restore === undefined) return null
  if ((keptAt !== null && !isTime(keptAt)) || (lostAt !== null && !isTime(lostAt))) return null
  return {
    id,
    settledAt,
    peer,
    kind,
    entityId,
    field: field as string | null,
    reason: reason as ConflictReason,
    winner,
    label: label as string | null,
    kept,
    lost,
    keptAt: keptAt as number | null,
    lostAt: lostAt as number | null,
    restore,
  }
}

/**
 * The journal read from the text of its file, `{ v: 1, entries: [...] }`: the lines that are well formed, pruned. A line that is not well formed is left out
 * and counted in `skipped`, never fatal. A file that is too large, that is not JSON or not that form, gives no line and `unreadable` (the caller says so in
 * its log and starts a new journal: the screen has nothing to compare, the session goes on); a file of a newer version gives no line and `tooNew` (the
 * caller must not overwrite it).
 */
export function parseJournal(text: string, now: number): { entries: SettledConflict[]; skipped: number; tooNew: boolean; unreadable: boolean } {
  const nothing = (unreadable: boolean, tooNew = false) => ({ entries: [], skipped: 0, tooNew, unreadable })
  if (text.length > JOURNAL_LIMITS.maxFileChars) return nothing(true)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return nothing(true)
  }
  if (!isObject(parsed) || !Array.isArray(parsed['entries'])) return nothing(true)
  if (typeof parsed['v'] === 'number' && parsed['v'] > 1) return nothing(false, true)
  if (parsed['v'] !== 1) return nothing(true)
  const read: SettledConflict[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const raw of (parsed['entries'] as unknown[]).slice(0, JOURNAL_LIMITS.maxEntries * 2)) {
    const entry = readSettledConflict(raw)
    if (entry === null || seen.has(entry.id)) skipped++
    else {
      seen.add(entry.id)
      read.push(entry)
    }
  }
  return { entries: pruneJournal(read, now), skipped, tooNew: false, unreadable: false }
}

export const serializeJournal = (journal: readonly SettledConflict[]): string => `${JSON.stringify({ v: 1, entries: journal })}\n`

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** A sentence: the key of the catalogue and what goes in it, in the order the sentence reads them (a word of the catalogue, or what the person typed). */
export interface TextRef {
  key: string
  params: (string | TextRef)[]
}

export interface ConflictRow {
  platform: Platform
  /** Whether this device's change is the one that is in force now. */
  kept: boolean
  text: TextRef
  at: number | null
}

export interface ConflictView {
  id: string
  title: TextRef
  /** What the person calls it; null when it has no name. */
  label: string | null
  rows: ConflictRow[]
  outcome: TextRef
  /** « Comparer » has two versions to show (a field or a list). A deletion that lost has no « Comparer »: it offers « Le supprimer partout ». */
  compare: boolean
  restore: SettledChange | null
}

const entries = (pairs: readonly (readonly [string, string])[]): ReadonlyMap<string, string> => new Map(pairs)

// The keys of the catalogues, written out (a key is looked up in a table, so that a field a newer version added, or one named `constructor`, is never taken for
// a key; and so that every key is written once in the code, which the test of the unused keys reads).
/** The fields the catalogues name; any other one (a field a newer version added) is shown by its own name. */
export const FIELD_KEYS: ReadonlyMap<string, string> = entries([
  ['name', 'sync-conflict.field-name'], ['emoji', 'sync-conflict.field-emoji'], ['theme', 'sync-conflict.field-theme'], ['profileId', 'sync-conflict.field-profile-id'],
  ['hideHeader', 'sync-conflict.field-hide-header'], ['iconKind', 'sync-conflict.field-icon-kind'], ['iconLetter', 'sync-conflict.field-icon-letter'],
  ['iconColor', 'sync-conflict.field-icon-color'], ['iconRound', 'sync-conflict.field-icon-round'], ['spaceId', 'sync-conflict.field-space-id'],
  ['parentId', 'sync-conflict.field-parent-id'], ['atBottom', 'sync-conflict.field-at-bottom'], ['atTodayStart', 'sync-conflict.field-at-today-start'],
  ['noWake', 'sync-conflict.field-no-wake'], ['icon', 'sync-conflict.field-icon'], ['pinned', 'sync-conflict.field-pinned'], ['anchorUrl', 'sync-conflict.field-anchor-url'],
  ['customTitle', 'sync-conflict.field-custom-title'], ['folderId', 'sync-conflict.field-folder-id'], ['keepAwake', 'sync-conflict.field-keep-awake'],
  ['url', 'sync-conflict.field-url'], ['title', 'sync-conflict.field-title'], ['archivedAt', 'sync-conflict.field-archived-at'], ['source', 'sync-conflict.field-source'],
  ['value', 'sync-conflict.field-value'],
])
/** The kinds the catalogues name (a setting is told by the name of the setting: `kind-setting-named`). */
export const KIND_KEYS: ReadonlyMap<string, string> = entries([
  ['space', 'sync-conflict.kind-space'], ['folder', 'sync-conflict.kind-folder'], ['tab', 'sync-conflict.kind-tab'], ['favorite', 'sync-conflict.kind-favorite'],
  ['archived', 'sync-conflict.kind-archived'], ['order', 'sync-conflict.kind-order'],
])
/** The settings of the closed list of §10.3. */
export const SETTING_KEYS: ReadonlyMap<string, string> = entries([
  ['httpsUpgrade', 'sync-conflict.setting-https-upgrade'], ['sendGpc', 'sync-conflict.setting-send-gpc'], ['stripTrackingParams', 'sync-conflict.setting-strip-tracking-params'],
  ['stripCopiedLinks', 'sync-conflict.setting-strip-copied-links'], ['protectionBaseline', 'sync-conflict.setting-protection-baseline'],
  ['autoArchiveHours', 'sync-conflict.setting-auto-archive-hours'], ['searchUrlTemplate', 'sync-conflict.setting-search-url-template'], ['profileNames', 'sync-conflict.setting-profile-names'],
])
const OUTCOME_KEYS = {
  kept: 'sync-conflict.outcome-kept',
  newer: { mac: 'sync-conflict.outcome-newer-mac', ios: 'sync-conflict.outcome-newer-ios' },
  tie: { mac: 'sync-conflict.outcome-tie-mac', ios: 'sync-conflict.outcome-tie-ios' },
  order: { mac: 'sync-conflict.outcome-order-mac', ios: 'sync-conflict.outcome-order-ios' },
} as const
const text = (key: string, ...params: (string | TextRef)[]): TextRef => ({ key, params })
const fieldName = (field: string): string | TextRef => {
  const key = FIELD_KEYS.get(field)
  return key === undefined ? field : text(key)
}

function valueSentence(field: string, value: SettledValue): TextRef {
  const name = fieldName(field)
  switch (value.t) {
    case 'text':
      return field === 'spaceId' || field === 'parentId' || field === 'folderId' ? text('sync-conflict.row-moved', value.text) : text('sync-conflict.row-set', name, value.text)
    case 'bool':
      return text(value.value ? 'sync-conflict.row-on' : 'sync-conflict.row-off', name)
    case 'absent':
      return text('sync-conflict.row-unset', name)
    case 'complex':
      return text('sync-conflict.row-other', name)
  }
}

/**
 * A line of the journal as the screen tells it (§13.4): the title, one row for each device (what it did and when), and the sentence that says what is in force.
 * The words are keys of the catalogue (`sync-conflict.*`) and the values the person typed; the screens put them in their own language.
 */
export function viewOf(entry: SettledConflict): ConflictView {
  const mine = otherPlatform(entry.peer)
  const platformOf = (side: ConflictSide): Platform => (side === 'local' ? mine : entry.peer)
  const winnerPlatform = platformOf(entry.winner)
  const loserPlatform = platformOf(otherSide(entry.winner))
  const isSetting = entry.kind === 'setting'
  const title = text(KIND_KEYS.get(entry.kind) ?? 'sync-conflict.kind-other')
  const label = isSetting ? null : entry.label
  let keptText: TextRef
  let lostText: TextRef
  if (entry.kind === 'order') {
    keptText = lostText = text('sync-conflict.row-reordered')
  } else if (entry.field === null) {
    keptText = text('sync-conflict.row-modified')
    lostText = text('sync-conflict.row-deleted')
  } else {
    keptText = valueSentence(entry.field, entry.kept)
    lostText = valueSentence(entry.field, entry.lost)
  }
  const rows: ConflictRow[] = [
    { platform: winnerPlatform, kept: true, text: keptText, at: entry.keptAt },
    { platform: loserPlatform, kept: false, text: lostText, at: entry.lostAt },
  ].sort((a, b) => (a.at ?? -1) - (b.at ?? -1) || compareUtf16(a.platform, b.platform))
  let outcome: TextRef
  if (entry.reason === 'modification-over-deletion') outcome = text(OUTCOME_KEYS.kept)
  else if (entry.reason === 'order') outcome = text(OUTCOME_KEYS.order[winnerPlatform])
  else if (entry.reason === 'newer') outcome = text(OUTCOME_KEYS.newer[winnerPlatform])
  else outcome = text(OUTCOME_KEYS.tie[winnerPlatform])
  const settingKey = SETTING_KEYS.get(entry.entityId)
  const settingName = !isSetting ? null : settingKey === undefined ? entry.entityId : text(settingKey)
  return {
    id: entry.id,
    title: settingName === null ? title : text('sync-conflict.kind-setting-named', settingName),
    label,
    rows,
    outcome,
    compare: entry.field !== null || entry.kind === 'order',
    restore: entry.restore,
  }
}

/**
 * A sentence in a language: the translator of the process (`t` of i18n.ts) is given the key and the words, named `p1`, `p2`… in the order the sentence reads
 * them; a word that is itself a sentence (the name of a field) is translated first. The screens of the Mac use this; the iPhone puts the same keys through
 * its own catalogue.
 */
export function renderText(ref: TextRef, translate: (key: string, vars: Record<string, string>) => string): string {
  const vars: Record<string, string> = {}
  ref.params.forEach((param, index) => {
    vars[`p${index + 1}`] = typeof param === 'string' ? param : renderText(param, translate)
  })
  return translate(ref.key, vars)
}

/**
 * When a change was made, as the screen says it: the time for today (« 9:15 AM », « 9 h 15 »), the date and the time for another day. The language is the one of
 * the interface; `now` is given so that the same line is told the same way in a test.
 */
export function formatWhen(at: number, now: number, language: string): string {
  const day = (ms: number): string => new Date(ms).toDateString()
  return day(at) === day(now)
    ? new Date(at).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })
    : new Date(at).toLocaleString(language, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}
