// What the downloads popover shows for each file.

import type { DownloadInfo, Settings } from './model'
import { getLanguage, t } from './i18n'

/** "850 o", "12 Ko", "3,4 Mo", "1,25 Go" in French; "850 B", "12 KB", "3.4 MB", "1.25 GB" in English: the unit and the decimal mark of the language. */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const fixed = (value: number, digits: number) => (getLanguage() === 'fr' ? value.toFixed(digits).replace('.', ',') : value.toFixed(digits))
  if (safe < 1024) return t('cookies.taille-octets', { size: Math.round(safe) })
  if (safe < 1024 ** 2) return t('cookies.taille-ko', { size: fixed(safe / 1024, 0) })
  if (safe < 1024 ** 3) return t('cookies.taille-mo', { size: fixed(safe / 1024 ** 2, 1) })
  return t('resources.go', { n: fixed(safe / 1024 ** 3, 2) })
}

/** The extension that stands on the file icon ("PDF"), or '' when the name has none worth showing. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  const extension = filename.slice(dot + 1)
  return /^[A-Za-z0-9]{1,4}$/.test(extension) ? extension.toUpperCase() : ''
}

/** How far a download is, 0..1, or null while its size is unknown (or it is not running). */
export function downloadProgress(download: Pick<DownloadInfo, 'state' | 'receivedBytes' | 'totalBytes'>): number | null {
  if (download.state !== 'progressing' || !(download.totalBytes > 0)) return null
  return Math.min(1, Math.max(0, download.receivedBytes / download.totalBytes))
}

type StatusFields = Pick<DownloadInfo, 'state' | 'receivedBytes' | 'totalBytes'> & Partial<Pick<DownloadInfo, 'paused' | 'resumable' | 'temporary' | 'reason'>>

/** The line under the file name: the size, with how much is done while it runs, and whether it waits for the user. */
export function downloadStatus(download: StatusFields): string {
  switch (download.state) {
    case 'progressing': {
      const received = formatBytes(download.receivedBytes)
      const done = download.totalBytes > 0 ? t('downloads-view.received-sur-total', { received, total: formatBytes(download.totalBytes) }) : t('downloads-view.received-recus', { received })
      return download.paused === true ? t('downloads-view.en-pause-done', { done }) : done
    }
    case 'completed': {
      const size = formatBytes(download.totalBytes > 0 ? download.totalBytes : download.receivedBytes)
      return download.temporary === true ? t('downloads-view.size-ouvert-sans-etre-garde', { size }) : size
    }
    case 'cancelled':
      return t('downloads-view.annule')
    case 'interrupted':
      if (download.reason === 'disk-full') return download.resumable === true ? t('downloads-view.interrompu-disque-plein-peut-reprendre') : t('downloads-view.interrompu-disque-plein')
      return download.resumable === true ? t('downloads-view.interrompu-peut-reprendre') : t('downloads-view.interrompu')
  }
}

/** Room left on the disk that a download is told to need at least, when its size is not known (1 Mo): below it nothing more can be written. */
export const DISK_MIN_FREE_BYTES = 1024 ** 2

/**
 * Whether a download that stopped did so because the disk is full: the free room is smaller than what is still to come (or than `DISK_MIN_FREE_BYTES` when the size is
 * not known). Electron says only that a download was interrupted, never why, so this is the one cause that can be told from the outside; a dropped connection on a disk
 * with room is not reported as anything else than "interrupted". `freeBytes` null (the disk could not be asked) says nothing.
 */
export function interruptedBecause(input: { freeBytes: number | null; receivedBytes: number; totalBytes: number }): 'disk-full' | undefined {
  const { freeBytes, receivedBytes, totalBytes } = input
  if (freeBytes === null || !Number.isFinite(freeBytes)) return undefined
  const remaining = totalBytes > receivedBytes ? totalBytes - receivedBytes : 0
  return freeBytes < Math.max(remaining, DISK_MIN_FREE_BYTES) ? 'disk-full' : undefined
}

/** What is said when a finished download is asked for (opened, shown in the Finder) and its file is not where it was put (moved, renamed, deleted). */
export const missingFileNotice = (filename: string): string => t('downloads-view.filename-n-est-plus-dans-son-dossier', { filename })

/** What is said when the partial file of a download removed from the list could not be deleted: it stays on disk, under the name of the file. */
export const partialRemovalNotice = (filename: string, reason: string): string => t('downloads-view.le-fichier-incomplet-filename-n-a-pas-pu-etre-supprime', { filename, reason })

/** What is said to the user when a finished file could not be marked as downloaded from the Internet (macOS). */
export const unmarkedNotice = (filename: string): string => t('downloads-view.fichier-non-marque-comme-telecharge', { filename })

/** The download can be paused: it is running, not already paused. */
export const canPauseDownload = (download: Pick<DownloadInfo, 'state'> & Partial<Pick<DownloadInfo, 'paused'>>): boolean => download.state === 'progressing' && download.paused !== true

/** The download can be resumed: it was paused, or it was interrupted and the engine can carry on from where it stopped. */
export const canResumeDownload = (download: Pick<DownloadInfo, 'state'> & Partial<Pick<DownloadInfo, 'paused' | 'resumable'>>): boolean =>
  (download.state === 'progressing' && download.paused === true) || (download.state === 'interrupted' && download.resumable === true)

/**
 * The list of rows once `download` was reported: it takes its row's place, in front. A row the user removed (`dismissed`) stays removed: a download that was still
 * alive when it was removed (an interrupted one that is cancelled for it) reports its last word, "cancelled", and that must not bring the row back.
 */
export function withDownload(rows: readonly DownloadInfo[], download: DownloadInfo, dismissed: ReadonlySet<string>, max: number): DownloadInfo[] {
  const others = rows.filter((d) => d.id !== download.id)
  return dismissed.has(download.id) ? others : [download, ...others].slice(0, max)
}

/** Newest first by start time: an update to a running download must not make its row jump to the top. */
export const sortDownloads = (downloads: readonly DownloadInfo[]): DownloadInfo[] => [...downloads].sort((a, b) => b.startedAt - a.startedAt)

/**
 * The downloads the popover's "clear" button may remove: everything that is not still running, except a download that a record on disk
 * can still carry on (removing its row removes its partial file: that takes the row's own button, not a click meant for finished files).
 */
export const finishedDownloads = (downloads: readonly DownloadInfo[]): DownloadInfo[] => downloads.filter((d) => d.state !== 'progressing' && !(d.state === 'interrupted' && d.recorded === true && d.resumable === true))

/** Which optional buttons the popover offers: the settings `downloadPause` and `downloadResume`. */
export interface DownloadButtons {
  pause: boolean
  /** A row that stands for a record on disk can be resumed (the setting keeps the records). */
  resumeRecorded: boolean
}

/**
 * The row as the popover shows it. Without the settings the popover is the plain one (a download is running or it is not): a pause that outlived the
 * setting is lifted by the main process, and "can resume" is not shown. A row built from a record keeps it when the setting that keeps records is on.
 */
export function shownDownload(raw: DownloadInfo, buttons: DownloadButtons): DownloadInfo {
  if (buttons.pause) return raw
  if (buttons.resumeRecorded && raw.recorded === true) return { ...raw, paused: false }
  return { ...raw, paused: false, resumable: false }
}

/** The resume button: the pause setting offers it for any download that can go on, the record setting for a row that stands for a record. */
export const offersResume = (download: DownloadInfo, buttons: DownloadButtons): boolean => canResumeDownload(download) && (buttons.pause || (buttons.resumeRecorded && download.recorded === true))

/**
 * Whether a request to resume `download` is carried out. A running or paused download, or one Chromium can carry on, needs the pause
 * setting. A row that stands for a record on disk needs the setting that keeps the records, and a private window has no such row to resume.
 */
export function resumeAllowed(settings: Pick<Settings, 'downloadPause' | 'downloadResume'>, download: Pick<DownloadInfo, 'recorded'> | undefined, isPrivate: boolean): boolean {
  return settings.downloadPause || (settings.downloadResume && !isPrivate && download?.recorded === true)
}
