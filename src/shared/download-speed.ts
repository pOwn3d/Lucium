// The speed of the downloads that run ("1,2 Mo/s" in the tip of the chip and under the name in the list). The engine reports how many bytes came,
// not how fast, and a download resumed after a restart keeps its first start time while its bytes include the earlier session: an average since
// the start would be wrong for it. The speed is measured here instead, between two snapshots at least `SPEED_WINDOW_MS` apart.

import type { DownloadInfo } from './model'
import { formatBytes } from './downloads-view'

/** A speed is the bytes that came between two readings this far apart (or more): a shorter span would jump with every report. */
export const SPEED_WINDOW_MS = 1000

export interface SpeedSample {
  at: number
  bytes: number
  /** Bytes per second over the last window, or null until one has gone by. */
  speed: number | null
}

export type SpeedBook = Readonly<Record<string, SpeedSample>>

/**
 * The book after a new list of downloads. Only a download that runs (and is not paused) has an entry; one that began again from fewer bytes starts a new
 * sample. The same book object comes back when nothing changed, so the interface draws nothing again for it.
 */
export function trackSpeeds(book: SpeedBook, downloads: readonly DownloadInfo[], now: number): SpeedBook {
  const next: Record<string, SpeedSample> = {}
  for (const download of downloads) {
    if (download.state !== 'progressing' || download.paused === true) continue
    const before = book[download.id]
    if (!before || download.receivedBytes < before.bytes) next[download.id] = { at: now, bytes: download.receivedBytes, speed: null }
    else if (now - before.at < SPEED_WINDOW_MS) next[download.id] = before
    else next[download.id] = { at: now, bytes: download.receivedBytes, speed: ((download.receivedBytes - before.bytes) * 1000) / (now - before.at) }
  }
  const ids = Object.keys(next)
  return ids.length === Object.keys(book).length && ids.every((id) => next[id] === book[id]) ? book : next
}

/** The speed of a download in bytes per second, or null while it is not known. */
export const speedOf = (book: SpeedBook, id: string): number | null => book[id]?.speed ?? null

/** The book after a new list, measured only while the setting of the status chip is on: off, it is emptied by a list of nothing, so no reading is kept. */
export const nextSpeedBook = (book: SpeedBook, downloads: readonly DownloadInfo[], enabled: boolean, now: number): SpeedBook => (enabled ? trackSpeeds(book, downloads, now) : trackSpeeds(book, [], 0))

/** "850 o/s", "12 Ko/s", "1,2 Mo/s" (in English "850 B/s", "12 KB/s", "1.2 MB/s"): sizes as the list writes them (see formatBytes). */
export const formatSpeed = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`

/** A line of the downloads with the speed after it, when there is one: "1,5 Mo sur 2,4 Mo · 1,2 Mo/s". */
export const withSpeed = (line: string, speed: number | null): string => (speed === null || !(speed > 0) ? line : `${line} · ${formatSpeed(speed)}`)
