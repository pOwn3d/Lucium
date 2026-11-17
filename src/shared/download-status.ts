// The status of the downloads at the foot of the sidebar: a chip with a ring and a count while a file comes, a bubble when it ends or fails.
// Everything here is a function of the downloads the snapshot already carries (no listener of its own): the interface calls `observe` with each
// new list. With the switch `downloadStatusChip` off none of it is called, the footer holds the plain icon and count it always had.

import type { DownloadInfo } from './model'
import { downloadProgress, downloadStatus, formatBytes } from './downloads-view'
import { t } from './i18n'

/** The bubble of a finished download stays this long (a failure stays until the user answers it). */
export const BUBBLE_MS = 6000

export type BubbleKind = 'done' | 'fail' | 'cancel'

export interface StatusBubble {
  kind: BubbleKind
  /** The download the bubble is about. */
  id: string
  /** When a bubble that goes by itself goes (epoch ms); null for one that waits for an answer. */
  until: number | null
}

export interface StatusState {
  /** The state each download was last seen in: a bubble is for a download that changed, never for one that was already finished. */
  seen: Readonly<Record<string, DownloadInfo['state']>>
  bubble: StatusBubble | null
}

/** What `observe` needs to know besides the list. */
export interface StatusContext {
  now: number
  /** When the chip was mounted: a download that started before it was already on its way (or over) and does not announce itself. */
  mountedAt: number
  /** The downloads the user asked to cancel from the chip: their end is told ("annulé"); a cancellation made elsewhere is not. */
  cancelled: ReadonlySet<string>
}

export const noStatus = (): StatusState => ({ seen: {}, bubble: null })

/** Whether two statuses are the same one: the interface keeps the old object then, and nothing is drawn again for a list that changed nothing worth saying. */
export function sameStatus(a: StatusState, b: StatusState): boolean {
  const sameBubble = a.bubble === b.bubble || (a.bubble !== null && b.bubble !== null && a.bubble.kind === b.bubble.kind && a.bubble.id === b.bubble.id && a.bubble.until === b.bubble.until)
  const ids = Object.keys(a.seen)
  return sameBubble && ids.length === Object.keys(b.seen).length && ids.every((id) => a.seen[id] === b.seen[id])
}

/** The state to start from: what is in the list now is known and says nothing. */
export const initialStatus = (downloads: readonly DownloadInfo[]): StatusState => ({ seen: Object.fromEntries(downloads.map((d) => [d.id, d.state])), bubble: null })

/** The bubble a download that just ended calls for, or null (a file opened without being kept, a cancellation nobody asked for here). */
function bubbleFor(download: DownloadInfo, context: StatusContext): StatusBubble | null {
  if (download.temporary === true) return null
  switch (download.state) {
    case 'completed':
      return { kind: 'done', id: download.id, until: context.now + BUBBLE_MS }
    case 'interrupted':
      return { kind: 'fail', id: download.id, until: null }
    case 'cancelled':
      return context.cancelled.has(download.id) ? { kind: 'cancel', id: download.id, until: context.now + BUBBLE_MS } : null
    case 'progressing':
      return null
  }
}

/**
 * The status after a new list of downloads. A download that was running (or that started after the chip was mounted and is already over: a small
 * file between two snapshots) and has ended makes a bubble. A failure that nobody answered is not replaced by the end of another download: the
 * list of Téléchargements still has that one. Downloads that left the list are forgotten.
 */
export function observe(status: StatusState, downloads: readonly DownloadInfo[], context: StatusContext): StatusState {
  let bubble = status.bubble
  const seen: Record<string, DownloadInfo['state']> = {}
  for (const download of downloads) {
    seen[download.id] = download.state
    const before = status.seen[download.id]
    const ended = download.state !== 'progressing' && (before === 'progressing' || (before === undefined && download.startedAt >= context.mountedAt))
    if (!ended) continue
    const next = bubbleFor(download, context)
    if (next && !(bubble?.kind === 'fail' && next.kind !== 'fail')) bubble = next
  }
  // The bubble of a download that is no longer listed (cleared), or that runs again (a failure that was resumed), has nothing to speak of.
  const subject = bubble ? downloads.find((d) => d.id === bubble!.id) : undefined
  if (bubble && (subject === undefined || subject.state === 'progressing')) bubble = null
  return { seen, bubble }
}

/** A bubble that goes by itself, once its time is up. */
export function expire(status: StatusState, now: number): StatusState {
  const { bubble } = status
  return bubble && bubble.until !== null && bubble.until <= now ? { ...status, bubble: null } : status
}

/** Closes the bubble (Échap, the × or "Ignorer"). */
export const dismiss = (status: StatusState): StatusState => (status.bubble ? { ...status, bubble: null } : status)

/** The bubble holds still while the pointer is on it: its time starts again when the pointer leaves (a failure has none). */
export const holdBubble = (status: StatusState): StatusState => (status.bubble && status.bubble.until !== null ? { ...status, bubble: { ...status.bubble, until: null } } : status)
export const releaseBubble = (status: StatusState, now: number): StatusState => (status.bubble && status.bubble.kind !== 'fail' && status.bubble.until === null ? { ...status, bubble: { ...status.bubble, until: now + BUBBLE_MS } } : status)

/** In how many ms the bubble must be taken down, or null when no timer is wanted (no bubble, or one that waits for an answer). */
export function bubbleDelay(status: StatusState, now: number): number | null {
  const until = status.bubble?.until ?? null
  return until === null ? null : Math.max(0, until - now)
}

export type ChipState = 'none' | 'progress' | 'done' | 'fail'

export interface ChipView {
  state: ChipState
  /** How many files are coming. */
  count: number
  /** The file the chip speaks of: the newest one that runs (while one does), else the one of the bubble. */
  subject: DownloadInfo | null
  /** How far the subject is, 0..100, or null when its size is not known (the ring turns). */
  percent: number | null
}

/** What the chip shows: the running downloads first, then the colour of the bubble that is up, else the plain icon. */
export function chipView(downloads: readonly DownloadInfo[], status: StatusState): ChipView {
  const running = downloads.filter((d) => d.state === 'progressing')
  if (running.length > 0) {
    const subject = running.reduce((newest, d) => (d.startedAt > newest.startedAt ? d : newest))
    const progress = downloadProgress(subject)
    return { state: 'progress', count: running.length, subject, percent: progress === null ? null : Math.round(progress * 100) }
  }
  const subject = status.bubble ? (downloads.find((d) => d.id === status.bubble!.id) ?? null) : null
  if (status.bubble?.kind === 'done') return { state: 'done', count: 0, subject, percent: 100 }
  if (status.bubble?.kind === 'fail') return { state: 'fail', count: 0, subject, percent: null }
  return { state: 'none', count: 0, subject: null, percent: null }
}

/**
 * The tooltip and the name of the chip for a screen reader: the file and how far it is, or the name of the panel (`panelLabel`: with the
 * shortcut that opens it as it is set now, when the caller knows it).
 */
export function chipLabel(view: ChipView, panelLabel?: string): string {
  const name = view.subject?.filename
  switch (view.state) {
    case 'none':
      return panelLabel ?? t('sidebar.telechargements')
    case 'progress':
      return view.percent === null ? t('download-status.nom-en-cours', { name: name ?? '' }) : t('download-status.nom-pourcentage', { name: name ?? '', percent: view.percent })
    case 'done':
      return t('download-status.nom-termine', { name: name ?? '' })
    case 'fail':
      return t('download-status.nom-echec', { name: name ?? '' })
  }
}

/**
 * What the live region of the chip says: not every percent (it would talk all through a download) but the start, then each quarter, then the end.
 * The same text for two readings of the same quarter, so a screen reader hears it once.
 */
export function chipAnnouncement(view: ChipView): string {
  const name = view.subject?.filename ?? ''
  switch (view.state) {
    case 'none':
      return ''
    case 'progress':
      return view.percent === null ? t('download-status.nom-en-cours', { name }) : t('download-status.nom-pourcentage', { name, percent: Math.min(75, Math.floor(view.percent / 25) * 25) })
    case 'done':
      return t('download-status.nom-termine', { name })
    case 'fail':
      return t('download-status.nom-echec', { name })
  }
}

export interface BubbleView {
  kind: BubbleKind
  id: string
  title: string
  detail: string
  /** The bubble goes by itself, whatever the pointer does to its time (a failure stays). */
  timed: boolean
  /** When it goes (null while the pointer holds it, and for a failure): the bar of its time starts again when this changes. */
  until: number | null
}

/** The words of a bubble: the file, and what became of it. */
export function bubbleView(bubble: StatusBubble, download: DownloadInfo): BubbleView {
  const size = formatBytes(download.totalBytes > 0 ? download.totalBytes : download.receivedBytes)
  const timed = bubble.kind !== 'fail'
  switch (bubble.kind) {
    case 'done':
      return { kind: 'done', id: bubble.id, title: download.filename, detail: t('download-status.termine-size', { size }), timed, until: bubble.until }
    case 'fail':
      return { kind: 'fail', id: bubble.id, title: download.filename, detail: t('download-status.echec-detail', { status: downloadStatus(download) }), timed, until: bubble.until }
    case 'cancel':
      return { kind: 'cancel', id: bubble.id, title: download.filename, detail: t('download-status.telechargement-annule'), timed, until: bubble.until }
  }
}
