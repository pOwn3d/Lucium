// « Sur l'iPhone » (docs/synchronisation.md §10.4): what an iPhone announced at its last session, turned into the lines the command bar shows and into the space a click
// opens the page in. The twin of ios/LuciumKit/.../Sync/SyncResume.swift: the two read the same vectors (ios/Contracts/sync-resume-vectors.json). Pure: no Electron, no Node,
// nothing read or written in the state; the list itself lives in the memory of the main process and is forgotten with the lock, the quit, the category and the device (not with the window).

import { fold, foldedQuery, scoreFolded } from './command-bar-match'
import { hostOf } from './url'

/** At most this many tabs are announced, and none whose address is longer (the limits of the protocol, `src/main/sync/limits.ts` and `SyncLimits` on the iPhone). */
export const RESUME_MAX_TABS = 200
export const RESUME_MAX_URL_BYTES = 4096

/** A tab as the iPhone announced it. */
export interface ResumeTab {
  id: string
  spaceId: string
  url: string
  title: string
  lastActiveAt: number
}

/** One line of the list. `url` and `spaceId` stay in the main process: the page is given `ResumeLine` only. */
export interface ResumeRow {
  id: string
  url: string
  /** The title the iPhone announced, or the host when it had none. */
  title: string
  host: string
  spaceId: string
  lastActiveAt: number
}

/** What the command bar is given of a row: no address, no space; a click names the row by its `id` and the main process looks the rest up. */
export interface ResumeLine {
  id: string
  title: string
  host: string
  lastActiveAt: number
}

/** Why the list is or is not there, in the order the reasons are tested. */
export type ResumeAvailability =
  /** No iPhone is paired, or the synchronisation is off. */
  | 'not-paired'
  /** « Onglets ouverts » is not ticked on this Mac. */
  | 'disabled-here'
  /** Ticked here, but no session has gone through since the list was forgotten: it comes with the next session. */
  | 'waiting'
  /** Ticked here, a session went through and the iPhone sent nothing: it has not ticked the category. */
  | 'disabled-on-iphone'
  /** A list came, with nothing in it that a Mac can open. */
  | 'empty'
  | 'list'

/** The key of the sentence that says how to get the list, per reason it is absent; null when it is there. The sentences are in both catalogues (`cmd.iphone-hint-*`). */
export function resumeHintKey(availability: ResumeAvailability): 'cmd.iphone-hint-not-paired' | 'cmd.iphone-hint-disabled-here' | 'cmd.iphone-hint-waiting' | 'cmd.iphone-hint-disabled-on-iphone' | 'cmd.iphone-hint-empty' | null {
  switch (availability) {
    case 'not-paired':
      return 'cmd.iphone-hint-not-paired'
    case 'disabled-here':
      return 'cmd.iphone-hint-disabled-here'
    case 'waiting':
      return 'cmd.iphone-hint-waiting'
    case 'disabled-on-iphone':
      return 'cmd.iphone-hint-disabled-on-iphone'
    case 'empty':
      return 'cmd.iphone-hint-empty'
    case 'list':
      return null
  }
}

/** `http` and `https` with a host, short enough, and nothing a script, a local file or a data address could be (the check of §10.4, made on the way out too). */
export function isWebAddress(address: string): boolean {
  if (new TextEncoder().encode(address).length > RESUME_MAX_URL_BYTES || !URL.canParse(address)) return false
  const url = new URL(address)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
}

/**
 * The rows of a list: web pages only (checked again here, whatever the receiver kept), the most recently read first, one per address and no more than the protocol
 * allows. A page that has no host is not a page a person could be sent to.
 */
export function resumeRows(tabs: readonly ResumeTab[]): ResumeRow[] {
  const seen = new Set<string>()
  const rows: ResumeRow[] = []
  // Most recent first; the identifier breaks a tie, the smaller first (the order of SyncResume.swift, so that both devices keep the same address of two that are equal).
  const sorted = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const tab of sorted) {
    if (!isWebAddress(tab.url) || seen.has(tab.url)) continue
    const host = hostOf(tab.url)
    if (host === '') continue
    seen.add(tab.url)
    const title = tab.title.trim()
    rows.push({ id: tab.id, url: tab.url, title: title === '' ? host : title, host, spaceId: tab.spaceId, lastActiveAt: tab.lastActiveAt })
    if (rows.length === RESUME_MAX_TABS) break
  }
  return rows
}

/** Why the bar shows what it shows. `announcedAt` is null until a list came; `listAnnounced` is whether a session carried one at all (an empty list is not no list). */
export function resumeAvailability(input: { paired: boolean; categoryOnHere: boolean; announcedAt: number | null; listAnnounced: boolean; rowCount: number; sessionHappened: boolean }): ResumeAvailability {
  if (!input.paired) return 'not-paired'
  if (!input.categoryOnHere) return 'disabled-here'
  if (input.announcedAt === null) return input.sessionHappened && !input.listAnnounced ? 'disabled-on-iphone' : 'waiting'
  return input.rowCount === 0 ? 'empty' : 'list'
}

/**
 * The space a clicked row opens in: the one the iPhone had it in when this Mac has a space of that identifier and it is not locked, else the space on screen when that one
 * is not locked, else nowhere (a locked space takes no page). `spaceIds` are the spaces of this Mac.
 */
export function resumeTargetSpace(row: Pick<ResumeRow, 'spaceId'>, spaceIds: ReadonlySet<string>, activeSpaceId: string, isLocked: (spaceId: string) => boolean): string | null {
  if (spaceIds.has(row.spaceId) && !isLocked(row.spaceId)) return row.spaceId
  return isLocked(activeSpaceId) ? null : activeSpaceId
}

/** How old a list is, in the unit the sentence says. */
export type ResumeAge = { unit: 'now' } | { unit: 'minutes' | 'hours' | 'days'; count: number }

/** `at` and `now` are in milliseconds. A clock that went back reads as « just now », never a negative time. */
export function resumeAge(at: number, now: number): ResumeAge {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return { unit: 'now' }
  if (seconds < 3600) return { unit: 'minutes', count: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { unit: 'hours', count: Math.floor(seconds / 3600) }
  return { unit: 'days', count: Math.floor(seconds / 86_400) }
}

/** The lines a text typed in the bar keeps: the title or the host matches, the best match first, the order of the list for equal scores. */
export function matchResume<T extends Pick<ResumeLine, 'title' | 'host'>>(lines: readonly T[], query: string, limit?: number): T[] {
  const needle = foldedQuery(query)
  const kept = needle === ''
    ? [...lines]
    : lines
        .map((line, index) => ({ line, index, score: Math.max(scoreFolded(fold(line.title), needle), scoreFolded(fold(line.host), needle)) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((m) => m.line)
  return limit === undefined ? kept : kept.slice(0, limit)
}

// ---------- the channel of the command bar ----------

/** What the bar asks: the list, or the opening of one line (named by its identifier; the address is never sent back). */
export type SyncResumeRequest = { kind: 'list' } | { kind: 'open'; id: string }

export interface SyncResumeView {
  availability: ResumeAvailability
  lines: ResumeLine[]
  /** When the list came (milliseconds), or null. */
  announcedAt: number | null
}

export type SyncResumeReply = { ok: true; view: SyncResumeView } | { ok: false }

const ROW_ID = /^[A-Za-z0-9_:.-]{1,200}$/

/** Whether a line can be named in a request of the bar: the main process leaves out of the list the tabs whose identifier is not one. */
export const isResumeId = (id: string): boolean => ROW_ID.test(id)

/** The request a message holds, or null: exactly one of the two kinds, with exactly its fields, and an identifier that looks like one. */
export function parseSyncResumeRequest(raw: unknown): SyncResumeRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const request = raw as Record<string, unknown>
  const own = (key: string): unknown => (Object.hasOwn(request, key) ? request[key] : undefined)
  const keys = Object.keys(request)
  if (own('kind') === 'list') return keys.length === 1 ? { kind: 'list' } : null
  const id = own('id')
  if (own('kind') === 'open' && keys.length === 2 && typeof id === 'string' && ROW_ID.test(id)) return { kind: 'open', id }
  return null
}

/** The view the bar is given, from what the service holds: the rows come out of `resumeRows`, and the page gets neither address nor space. */
export function resumeView(input: { paired: boolean; categoryOnHere: boolean; announcedAt: number | null; listAnnounced: boolean; sessionHappened: boolean; rows: readonly ResumeRow[] }): SyncResumeView {
  const availability = resumeAvailability({ ...input, rowCount: input.rows.length })
  const lines = availability === 'list' ? input.rows.map(({ id, title, host, lastActiveAt }) => ({ id, title, host, lastActiveAt })) : []
  return { availability, lines, announcedAt: availability === 'list' ? input.announcedAt : null }
}
