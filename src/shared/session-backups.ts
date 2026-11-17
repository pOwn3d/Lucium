// Periodic copies of the session (Settings › Téléchargements et fichiers › Copies automatiques, File › Sessions…): a few dated files in the data folder hold the
// spaces and tabs as they were, and any of them can be put back. Pure rules shared by the files layer (main/backup-store.ts), the service
// that decides when to copy (main/shell/backups.ts) and the panel: what a copy holds, how a file is read back, how copies are named and
// pruned, and what replaces what when one is restored. The reducer's `backup/restore` does the replacing.

import { STATE_REVISION, STATE_VERSION, type ArchivedTab, type Folder, type SidebarState, type Space, type SplitView, type TabItem } from './model'
import { slimTab } from './sessions'
import { isRecord } from './state-clean'
import { readRestoredState } from './sidebar'
import { cleanClosedHistory, closedHistoryAfter, type ClosedPagesScope } from './closed-history'
import { getLanguage, t } from './i18n'

export const COPY_FORMAT = 'lucium-session-copy'
export const COPY_VERSION = 1
/** The biggest copy file that is read: a larger one is damaged or hostile, not a copy (500 tabs with their archive weigh a few hundred kilobytes). */
export const COPY_BYTES_MAX = 32 * 1024 * 1024

/** Why a copy was made: the timer, the quit, the user's button, or the moment before a restoration replaced the session. */
export const COPY_REASONS = ['auto', 'quit', 'manual', 'before-restore'] as const
export type CopyReason = (typeof COPY_REASONS)[number]

/** What a copy holds: the spaces with their tabs and folders, the split views, the archive and what was on screen. Not the favourites, Tweaks, sessions or settings. */
export interface SessionCopyData {
  spaces: Space[]
  tabs: TabItem[]
  folders: Folder[]
  activeSpaceId: string
  activeTabBySpace: Record<string, string | null>
  splits: SplitView[]
  archive: ArchivedTab[]
}

export interface SessionCopy {
  createdAt: number
  reason: CopyReason
  data: SessionCopyData
}

/** The part of the state a copy keeps. A tab's icon is kept only as an address: an inlined picture would make every copy heavy, and the page brings it back. */
export function copyDataOf(state: SidebarState): SessionCopyData {
  return {
    spaces: state.spaces,
    tabs: state.tabs.map(slimTab),
    folders: state.folders,
    activeSpaceId: state.activeSpaceId,
    activeTabBySpace: state.activeTabBySpace,
    splits: state.splits,
    archive: state.archive
  }
}

/** Whether there is anything worth a scheduled copy: no tab at all is a state a copy would only push a useful one out for. */
export const hasSessionContent = (state: Pick<SidebarState, 'tabs'>): boolean => state.tabs.length > 0

/**
 * Whether there is anything a restoration would replace that is worth a copy first (and a manual copy keeps): a tab, but also a folder, the
 * archive or a second space, which a session with no open tab can hold. A scheduled copy still asks for a tab (`hasSessionContent`).
 */
export const holdsRestorableContent = (state: Pick<SidebarState, 'tabs' | 'folders' | 'archive' | 'spaces'>): boolean =>
  hasSessionContent(state) || state.folders.length > 0 || state.archive.length > 0 || state.spaces.length > 1

/**
 * What changes when the session changes in a way worth a copy: the spaces and what is in them. Not the time a tab was last used, nor a
 * page title that moved: a copy for each of those would push the useful ones out. Equal fingerprints mean the same session.
 */
export function copyFingerprint(data: SessionCopyData): string {
  return JSON.stringify([
    data.spaces,
    data.tabs.map((t) => [t.id, t.spaceId, t.url, t.pinned, t.folderId, t.anchorUrl, t.customTitle, t.icon, t.container]),
    data.folders,
    data.activeSpaceId,
    data.activeTabBySpace,
    data.splits,
    data.archive.map((a) => a.id)
  ])
}

/**
 * The text of a copy. `revision` is the revision of the state format the spaces, tabs and folders were written under (`STATE_REVISION`): a
 * later version that migrates their shape knows from it which migrations this copy still needs, as it does for the state file.
 */
export function serializeCopy(copy: SessionCopy): string {
  return JSON.stringify({ format: COPY_FORMAT, version: COPY_VERSION, revision: STATE_REVISION, createdAt: copy.createdAt, reason: copy.reason, data: copy.data })
}

/**
 * A copy read back from its text. The spaces, tabs and folders are repaired like those of the state file; what cannot be (not JSON, another
 * format or version, no usable space, an entry that is not even an object) throws, and the caller ignores that copy and says so.
 */
export function parseCopy(text: string): SessionCopy {
  if (text.length > COPY_BYTES_MAX) throw new Error('the file is too big to be a copy')
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isRecord(raw) || raw['format'] !== COPY_FORMAT) throw new Error('not a copy of the session')
  if (raw['version'] !== COPY_VERSION) throw new Error(`unsupported version ${String(raw['version'])}`)
  const createdAt = raw['createdAt']
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) throw new Error('no date')
  const data = raw['data']
  if (!isRecord(data)) throw new Error('no data')
  const read = readRestoredState({
    version: STATE_VERSION,
    // A copy written before copies said their revision reads as one from before revisions existed.
    revision: raw['revision'],
    spaces: data['spaces'],
    tabs: data['tabs'],
    folders: data['folders'],
    archive: data['archive'],
    activeSpaceId: data['activeSpaceId'],
    activeTabBySpace: data['activeTabBySpace'],
    splits: data['splits']
  })
  // A repair that failed is not a copy without spaces: the reason goes with the error, which the caller logs or shows.
  if (!read.ok && 'error' in read) throw new Error(`the copy could not be repaired (${read.error instanceof Error ? read.error.message : String(read.error)})`, { cause: read.error })
  if (!read.ok) throw new Error('no usable space or tab list')
  const state = read.state
  return { createdAt, reason: COPY_REASONS.find((r) => r === raw['reason']) ?? 'auto', data: copyDataOf(state) }
}

// ---------- forgetting the pages of closed tabs ----------

/** What editing the text of a copy came to: nothing to change, the new text, or a file that is not edited (not a copy of this version). */
export type CopyEdit = { kind: 'unchanged' } | { kind: 'changed'; text: string } | { kind: 'left'; why: string }

/**
 * A copy after `scope` forgot the pages the archived tabs of its profile went through (their Back lists, see closed-history.ts; the tabs
 * stay). The text is edited, not rebuilt: the file is read as JSON, only the `history` of the entries in scope changes, and what comes out is the
 * same copy otherwise. A text that is not a copy of this version is left as it is (`left`): editing what is not understood could damage it.
 * `currentSpaces` are the spaces of the profile today: an entry is in scope through its space in the copy, or through its space today
 * (a space can change profile, and the pages were browsed under the profile it had).
 */
export function copyAfterForgetting(text: string, scope: ClosedPagesScope, currentSpaces: ReadonlySet<string>): CopyEdit {
  if (text.length > COPY_BYTES_MAX) return { kind: 'left', why: 'too big' }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { kind: 'left', why: 'not JSON' }
  }
  if (!isRecord(raw) || raw['format'] !== COPY_FORMAT || raw['version'] !== COPY_VERSION) return { kind: 'left', why: 'not a copy of this version' }
  const data = raw['data']
  if (!isRecord(data) || !Array.isArray(data['archive'])) return { kind: 'unchanged' }
  const profileOfCopySpace = new Map<string, string>()
  if (Array.isArray(data['spaces'])) {
    for (const space of data['spaces']) if (isRecord(space) && typeof space['id'] === 'string') profileOfCopySpace.set(space['id'], typeof space['profileId'] === 'string' ? space['profileId'] : 'default')
  }
  let changed = false
  for (const entry of data['archive']) {
    if (!isRecord(entry) || !('history' in entry)) continue
    const spaceId = entry['spaceId']
    if (typeof spaceId !== 'string') continue
    if ((profileOfCopySpace.get(spaceId) ?? 'default') !== scope.profileId && !currentSpaces.has(spaceId)) continue
    // A list that is not a valid one is dropped with the rest (it would be on restoring): its pages would otherwise stay in the file.
    const url = entry['url']
    const history = typeof url === 'string' ? cleanClosedHistory(entry['history'], url) : undefined
    const after = history === undefined ? undefined : closedHistoryAfter(history, url as string, scope.site)
    if (history !== undefined && after === history) continue
    changed = true
    if (after === undefined) delete entry['history']
    else entry['history'] = after
  }
  return changed ? { kind: 'changed', text: JSON.stringify(raw) } : { kind: 'unchanged' }
}

// ---------- names and rotation ----------

const BACKUP_ID = /^copie-\d{13}(?:-\d{1,3})?$/

/** The name of a copy file without its extension: `copie-` and the time in milliseconds (13 digits, so that names sort by age), then a counter when two share a millisecond. */
export const isBackupId = (value: unknown): value is string => typeof value === 'string' && BACKUP_ID.test(value)
export const backupId = (stamp: number, counter = 0): string => `copie-${String(Math.trunc(stamp)).padStart(13, '0')}${counter > 0 ? `-${counter}` : ''}`

/** The time (ms) a copy name stands for. */
export const stampOfBackupId = (id: string): number => Number(id.slice(6, 19))

/** Names from the oldest to the newest, then newest first for a listing. */
const byAge = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
export const newestFirst = (ids: readonly string[]): string[] => [...ids].sort(byAge).reverse()

/**
 * The time a new copy is named after: now, unless the clock went back behind the newest copy, in which case the new one must still be
 * the newest (named after the old one plus a millisecond) or rotation would throw away the copy that was just made.
 */
export const nextStamp = (now: number, newestStamp: number | undefined): number => (newestStamp === undefined ? now : Math.max(now, newestStamp + 1))

/** The copies to delete so that `keep` remain: the oldest. */
export const toPrune = (ids: readonly string[], keep: number): string[] => newestFirst(ids).slice(Math.max(1, keep))

/** A copy somebody asked for: the button of the panel, or the copy a restoration makes of what it replaces (what "Annuler" puts back). */
export const isAskedCopy = (reason: CopyReason | null): boolean => reason === 'manual' || reason === 'before-restore'

/** How many of the copies somebody asked for are kept, whatever the number of automatic copies the settings say: they must not pile up for ever either. */
export const ASKED_COPIES_KEPT = 10

/** How much of the start of a copy file is read to learn why it was made (`reasonOfCopyHead`): the reason is written before the session. */
export const COPY_HEAD_BYTES = 512

/**
 * Why a copy was made, read from the first characters of its file (see `serializeCopy`: the reason comes before the data), so that rotation does
 * not parse every copy at every write. Null when the start does not say: the copy then rotates with the automatic ones.
 */
export function reasonOfCopyHead(head: string): CopyReason | null {
  const found = /^﻿?\{"format":"[^"]{1,64}","version":\d{1,6},(?:"revision":\d{1,9},)?"createdAt":[\d.e+]{1,32},"reason":"([a-z-]{1,32})"/.exec(head)
  return found && (COPY_REASONS as readonly string[]).includes(found[1]!) ? (found[1] as CopyReason) : null
}

/**
 * The copies to delete, oldest last within each group. The automatic ones (the timer, the quit) rotate among themselves, down to `keep`; the ones
 * somebody asked for rotate apart, down to `ASKED_COPIES_KEPT`: a copy made by hand "to come back to later", or the one that undoes a restoration,
 * is not pushed out by a few hours of automatic copies. `heldBefore` (ms) is the time a state file was last set aside as unreadable: the automatic
 * copies older than it are those of the session that was lost, the ones the notice sends to; they rotate among themselves too, so that the copies
 * of the fresh state do not push them out.
 */
export function copiesToPrune(copies: readonly { id: string; reason: CopyReason | null }[], keep: number, heldBefore?: number): string[] {
  const asked: string[] = []
  const held: string[] = []
  const automatic: string[] = []
  for (const copy of copies) {
    if (isAskedCopy(copy.reason)) asked.push(copy.id)
    else if (heldBefore !== undefined && stampOfBackupId(copy.id) < heldBefore) held.push(copy.id)
    else automatic.push(copy.id)
  }
  return [...toPrune(automatic, keep), ...toPrune(held, keep), ...toPrune(asked, ASKED_COPIES_KEPT)]
}

// ---------- what the panel shows ----------

export interface BackupEntry {
  id: string
  createdAt: number
  reason: CopyReason
  tabs: number
  pinned: number
  spaces: number
}

export interface BackupListing {
  /** Whether the copies are on (the panel says so when they are not, and offers nothing it cannot do). */
  enabled: boolean
  /** Newest first. */
  entries: BackupEntry[]
  /** Copies that could not be read and were left out. */
  unreadable: number
}

export type BackupRestoreResult = { ok: true; tabs: number; spaces: number } | { ok: false; message: string }

export const NO_BACKUPS: BackupListing = { enabled: false, entries: [], unreadable: 0 }

export function entryOf(id: string, copy: SessionCopy): BackupEntry {
  return { id, createdAt: copy.createdAt, reason: copy.reason, tabs: copy.data.tabs.length, pinned: copy.data.tabs.filter((t) => t.pinned).length, spaces: copy.data.spaces.length }
}

const REASON_LABELS: Record<CopyReason, string> = {
  get auto() { return t('session-backups.copie-automatique') },
  get quit() { return t('session-backups.a-la-fermeture') },
  get manual() { return t('session-backups.copie-manuelle') },
  get 'before-restore'() { return t('session-backups.avant-une-restauration') }
}
export const reasonLabel = (reason: CopyReason): string => REASON_LABELS[reason]

const two = (n: number): string => String(n).padStart(2, '0')
const dayStart = (at: number): number => new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()).getTime()

/** "Aujourd’hui à 14:32", "Hier à 09:10", "24 oct. à 14:32", and the year when it is not this one (in English "24 Oct at 14:32"). */
export function copyWhen(createdAt: number, now: number): string {
  const at = new Date(createdAt)
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`
  const days = Math.round((dayStart(now) - dayStart(createdAt)) / 86_400_000)
  if (days === 0) return t('session-backups.aujourd-hui-a-time', { time })
  if (days === 1) return t('session-backups.hier-a-time', { time })
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  const date = at.toLocaleDateString(getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return t('session-backups.date-a-time', { date, time })
}
