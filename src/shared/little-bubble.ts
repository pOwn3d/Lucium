// The action bubble of a mini window (Settings › Navigation › Plus de réglages): when a file its page downloaded is finished, a small card with the
// actions that make sense right then ("Ouvrir", "Afficher dans le Finder") shows above the downloads tray for a few seconds. The
// cotes are ours, in the tray's own look (see little-tray.ts). Pure rules; main/shell/little.ts
// keeps the timer and the interface (littlearc.tsx) draws it.

import type { DownloadInfo } from './model'

export const LITTLE_BUBBLE = {
  /** The card is this tall, with `gap` between it and the first row of the tray. */
  height: 44,
  gap: 6,
  /** How long it stays up when nobody points at it. */
  shownMs: 12_000,
  /** How long it stays after the pointer leaves it (it was being read or reached for). */
  leftMs: 4_000
} as const

/** The room the bubble takes on top of the tray's rows. */
export const bubbleExtra = (shown: boolean): number => (shown ? LITTLE_BUBBLE.height + LITTLE_BUBBLE.gap : 0)

/**
 * Whether this update of a download is its end and deserves a bubble: it was running (or unknown) and is now finished, and it is a file
 * the user keeps. A download opened without being kept goes straight to its application, a failed or cancelled one has nothing to open.
 */
export function bubbleAfter(previous: Pick<DownloadInfo, 'state'> | undefined, next: Pick<DownloadInfo, 'state' | 'temporary' | 'path'>): boolean {
  return previous?.state !== 'completed' && next.state === 'completed' && next.temporary !== true && next.path !== ''
}

/** The download the bubble is about, while it is still a finished file in the tray (a row taken out of the tray takes the bubble with it). */
export function bubbleDownload(downloads: readonly DownloadInfo[], bubbleId: string | undefined): DownloadInfo | undefined {
  if (bubbleId === undefined) return undefined
  const found = downloads.find((d) => d.id === bubbleId)
  return found?.state === 'completed' ? found : undefined
}
