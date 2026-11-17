// Resuming a download after a restart (setting `downloadResume`): the rules that need no disk and no network.
//
// Electron keeps no history of downloads. To carry one on after a restart the application writes, for each file in progress, the address
// (often with a token in it) and the path of the partial file, and later asks the server for the rest. Everything read back from that file is
// hostile input: this module decides what may be recorded, what a record must look like, how old it may be, and whether a server's answer
// is the one that lets a partial file be completed. Nothing here touches the disk or Electron.

/** The file in the data folder. Its existence also tells the next launch to download in a single stream (see single-stream.ts). */
import { t } from './i18n'
import { isRecord } from './record'

export const RESUME_FILE = 'download-resume.json'
export const RESUME_VERSION = 1
/** At most this many downloads are kept: an address with a token is a secret, and a long list is a list nobody looks at. */
export const RESUME_MAX_RECORDS = 20
/** A record is dropped (with its partial file) this long after its last checkpoint: tokens expire, and so does the interest. */
export const RESUME_MAX_AGE_MS = 72 * 60 * 60 * 1000
/** A partial file smaller than this is not worth an address on disk: such a download starts again. */
export const RESUME_MIN_BYTES = 1024 * 1024
/** The least time between two writes of the file for one download. No timer: the check happens when Chromium reports progress. */
export const RESUME_CHECKPOINT_MS = 10_000
/** How much of the start of the partial file, and how much of its end (up to the recorded offset), is fingerprinted. */
export const FINGERPRINT_BYTES = 1024 * 1024
/** A file larger than this is not ours: it is removed unread. 20 records of the largest allowed size come to well under it. */
export const RESUME_FILE_MAX_BYTES = 512 * 1024
export const RESUME_URL_MAX = 4096
export const RESUME_PATH_MAX = 1024
export const RESUME_HEADER_MAX = 256
/** The clock of a computer that was set back must not keep a record alive for ever. */
const CLOCK_SKEW_MS = 60 * 60 * 1000
/** Electron's `resume()` goes on from the middle only if the server's last modification is older than the download by this much (Chromium's rule for a strong validator). */
const STRONG_LAST_MODIFIED_MS = 60 * 1000

/** What is written for one download. `url` is the address the bytes come from (the last of the redirections); it may hold a token. */
export interface ResumeRecord {
  /** `rs-` and twelve hex digits: unique across launches, unlike the `dl-N` of a session. */
  id: string
  profileId: string
  url: string
  /** Absolute path of the partial file, directly in the profile's downloads folder (or in a folder an extension named inside it). */
  path: string
  /** How many bytes of the partial file were confirmed on disk when the record was written. */
  offset: number
  /** The size the server announced. Always above `offset`. */
  length: number
  mimeType?: string
  etag: string
  lastModified: string
  /** Seconds since the UNIX epoch (what Electron's `DownloadItem.getStartTime()` gives). */
  startTime: number
  /** Milliseconds: the last time the record was written. The lifetime counts from here. */
  savedAt: number
  /** SHA-256 of the first `FINGERPRINT_BYTES` of the file: tells that the file is the one that was being downloaded. */
  head: string
  /** SHA-256 of the `FINGERPRINT_BYTES` that end at `offset`: tells that the bytes below `offset` are the ones that were confirmed. */
  tail: string
}

const HEX = (length: number) => new RegExp(`^[0-9a-f]{${length}}$`)
const ID = /^rs-[0-9a-f]{12}$/
const PROFILE = /^[A-Za-z0-9_-]{1,32}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function newRecordId(random: () => string): string {
  return `rs-${random()}`
}
export const isRecordId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)

/**
 * An address that may be asked for again: a web address, of a bounded length, with no identifier and password in it (those would be
 * written to the disk), no space and no control character.
 */
export function isResumableAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RESUME_URL_MAX || CONTROL.test(value) || /\s/.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '' && url.href === value
}

/**
 * The address as the interface may show it: where the file is (host and path), and nothing that can be a secret. The whole query and the
 * fragment go, not only the parameters that look like a token: a token has no fixed name. A string that is not a web address gives ''.
 */
export function displayAddress(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return ''
  }
}

/** A strong ETag: quoted, without the `W/` prefix, plain characters only (it goes into a header). */
export function isStrongEtag(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= RESUME_HEADER_MAX && /^"[\x21\x23-\x7e]*"$/.test(value)
}

/** An HTTP date in the plain form servers send, readable as a date. */
export function isHttpDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && PRINTABLE_ASCII.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * Whether the server gave what lets a download go on from the middle: Electron's `resume()` restarts from the beginning unless it has both
 * `ETag` and `Last-Modified`. The ETag must be a strong one, and the file must have been last modified well before the download began
 * (a file changed in the same minute may change again without a new date).
 */
export function hasStrongValidators(etag: unknown, lastModified: unknown, startedAtMs: number): boolean {
  if (!isStrongEtag(etag) || !isHttpDate(lastModified)) return false
  return Date.parse(lastModified) <= startedAtMs - STRONG_LAST_MODIFIED_MS
}

/** The shape of an absolute path as the record may hold it. Whether it leads into the right folder is decided against the disk. */
export function isRecordablePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RESUME_PATH_MAX || !value.startsWith('/') || CONTROL.test(value)) return false
  const parts = value.slice(1).split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** The record as it should have been written, or null: every field is checked, unknown fields are dropped, nothing is repaired. */
export function cleanRecord(raw: unknown, now: number): ResumeRecord | null {
  if (!isRecord(raw)) return null
  const { id, profileId, url, path, offset, length, mimeType, etag, lastModified, startTime, savedAt, head, tail } = raw
  if (!isRecordId(id) || typeof profileId !== 'string' || !PROFILE.test(profileId) || !isResumableAddress(url) || !isRecordablePath(path)) return null
  if (!isCount(offset) || !isCount(length) || offset < RESUME_MIN_BYTES || length <= offset) return null
  if (!isStrongEtag(etag) || !isHttpDate(lastModified)) return null
  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0 || startTime > 4e9) return null
  if (!isCount(savedAt) || savedAt > now + CLOCK_SKEW_MS) return null
  if (typeof head !== 'string' || !HEX(64).test(head) || typeof tail !== 'string' || !HEX(64).test(tail)) return null
  const record: ResumeRecord = { id, profileId, url, path, offset, length, etag, lastModified, startTime, savedAt, head, tail }
  if (mimeType !== undefined) {
    if (typeof mimeType !== 'string' || mimeType.length > 100 || !PRINTABLE_ASCII.test(mimeType)) return null
    if (mimeType !== '') record.mimeType = mimeType
  }
  return record
}

/** Whether a record has outlived its time (or comes from the future: a clock set back is not a reason to keep an address). */
export function isStale(record: Pick<ResumeRecord, 'savedAt'>, now: number): boolean {
  return now - record.savedAt > RESUME_MAX_AGE_MS || record.savedAt > now + CLOCK_SKEW_MS
}

/** What a live download shows of itself, read when a checkpoint is made. */
export interface ItemView {
  url: string
  received: number
  total: number
  etag: string
  lastModified: string
  startTime: number
  mimeType: string
}

/** Whether a live download is worth a record now: a known size, enough already, an address and validators that allow a resumption. */
export function worthRecording(view: ItemView): boolean {
  return (
    Number.isSafeInteger(view.received) &&
    Number.isSafeInteger(view.total) &&
    view.received >= RESUME_MIN_BYTES &&
    view.total > view.received &&
    isResumableAddress(view.url) &&
    Number.isFinite(view.startTime) &&
    hasStrongValidators(view.etag, view.lastModified, view.startTime * 1000)
  )
}

// ---- what the server must answer before a partial file is completed ----

/** The part of an answer the verdict needs. Header names are lower-case. */
export interface ProbeAnswer {
  status: number
  headers: Readonly<Record<string, string | null | undefined>>
}

export type Refusal =
  /** The server sent the whole file (200): it ignores ranges, or the file changed since. */
  | 'not-partial'
  | 'range'
  | 'etag'
  | 'last-modified'
  | 'encoding'
  | 'redirect'
  | 'gone'
  | 'unsatisfiable'
  | 'denied'
  | 'busy'
  | 'unreachable'
  | 'status'
  /** Chromium would not recreate the download. */
  | 'failed'
  // Seen on the disk, not on the server:
  | 'stale'
  | 'profile'
  | 'place'
  | 'unsafe'
  | 'missing'
  | 'short'
  | 'changed'
  /** The file is as long as the whole download: it ended, and only its record was left behind. */
  | 'complete'

/** After these the record can never complete the file, and it goes. The others (a server that is busy or refuses for now) leave it for another try. */
const DROPS_RECORD: ReadonlySet<Refusal> = new Set<Refusal>(['not-partial', 'range', 'etag', 'last-modified', 'encoding', 'redirect', 'gone', 'unsatisfiable', 'status', 'stale', 'profile', 'place', 'unsafe', 'missing', 'short', 'changed', 'complete'])
/**
 * …and with the record goes the partial file, when it is ours (see `inspectPartial`): the file can never be completed and was written by
 * the application. Not after `place`, `unsafe`, `profile` or `missing` (the file is not where we may touch it, or not there), and not after
 * `changed` (the bytes below the offset are no longer the ones we wrote: whatever they are, they are not ours to delete), and never after
 * `complete` (the file is the finished download).
 */
const REMOVES_PARTIAL: ReadonlySet<Refusal> = new Set<Refusal>(['not-partial', 'range', 'etag', 'last-modified', 'encoding', 'redirect', 'gone', 'unsatisfiable', 'status', 'stale', 'short'])

export const dropsRecord = (refusal: Refusal): boolean => DROPS_RECORD.has(refusal)
export const removesPartial = (refusal: Refusal): boolean => REMOVES_PARTIAL.has(refusal)

/** The headers of the 1-byte request that asks the server whether it still holds the file the partial one came from. */
export function probeHeaders(record: Pick<ResumeRecord, 'offset' | 'etag'>): Record<string, string> {
  return { Range: `bytes=${record.offset}-${record.offset}`, 'If-Range': record.etag, 'Accept-Encoding': 'identity' }
}

/**
 * Whether the answer to `probeHeaders` is the one that lets the download go on: a partial answer (206) for exactly the byte asked, of the
 * file of the length that was announced, with the same ETag and the same Last-Modified. Anything else is a refusal, with its reason.
 */
export function judgeProbe(record: Pick<ResumeRecord, 'offset' | 'length' | 'etag' | 'lastModified'>, answer: ProbeAnswer): { ok: true } | { ok: false; refusal: Refusal } {
  const { status, headers } = answer
  const refuse = (refusal: Refusal) => ({ ok: false as const, refusal })
  if (status >= 300 && status < 400) return refuse('redirect')
  if (status === 200) return refuse('not-partial')
  if (status === 404 || status === 410) return refuse('gone')
  if (status === 416) return refuse('unsatisfiable')
  if (status === 401 || status === 403) return refuse('denied')
  if (status === 408 || status === 429 || status >= 500) return refuse('busy')
  if (status !== 206) return refuse('status')
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] ?? '')
  if (!range || Number(range[1]) !== record.offset || Number(range[2]) !== record.offset || Number(range[3]) !== record.length) return refuse('range')
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding !== '' && encoding !== 'identity') return refuse('encoding')
  if (headers['etag'] !== record.etag) return refuse('etag')
  if (headers['last-modified'] !== record.lastModified) return refuse('last-modified')
  return { ok: true }
}

/** The sentence the user reads when a resumption is refused. It names the file, never the address. */
export function refusalMessage(filename: string, refusal: Refusal): string {
  // Bare: each sentence of the catalogue puts its own quotation marks around the name.
  const name = filename.slice(0, 80)
  switch (refusal) {
    case 'not-partial':
    case 'etag':
    case 'last-modified':
    case 'unsatisfiable':
      return t('download-resume.impossible-de-reprendre-name-le-fichier-a', { name })
    case 'range':
    case 'encoding':
      return t('download-resume.impossible-de-reprendre-name-le-serveur-ne', { name })
    case 'redirect':
    case 'gone':
      return t('download-resume.impossible-de-reprendre-name-l-adresse-n-existe', { name })
    case 'denied':
      return t('download-resume.le-serveur-a-refuse-l-adresse-de-name-elle-a', { name })
    case 'busy':
    case 'unreachable':
      return t('download-resume.le-serveur-de-name-ne-repond-pas-reessayez-plus', { name })
    case 'status':
      return t('download-resume.impossible-de-reprendre-name-reponse-inattendue', { name })
    case 'failed':
      return t('download-resume.impossible-de-reprendre-name-le-moteur-n-a-pas', { name })
    case 'stale':
      return t('download-resume.name-est-trop-ancien-pour-etre-repris-relancez', { name })
    case 'profile':
      return t('download-resume.impossible-de-reprendre-name-son-profil-n', { name })
    case 'place':
      return t('download-resume.impossible-de-reprendre-name-le-fichier-n-est', { name })
    case 'unsafe':
      return t('download-resume.impossible-de-reprendre-name-le-fichier-partiel', { name })
    case 'missing':
      return t('download-resume.impossible-de-reprendre-name-le-fichier-partiel-2', { name })
    case 'short':
    case 'changed':
      return t('download-resume.impossible-de-reprendre-name-le-fichier-partiel-3', { name })
    case 'complete':
      return t('download-resume.name-est-deja-complet', { name })
  }
}
