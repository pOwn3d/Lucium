// Resuming a download after a restart (setting `downloadResume`): the records on disk, the checks made before a partial file is touched,
// and the order of a resumption. Nothing here imports Electron: the engine gives this module the few things it needs (the downloads folder
// of a profile, a request to the server, `session.createInterruptedDownload`) as ports, and the tests put stand-ins.
//
// What is written, where and why (docs/telechargements-reprise.md has the whole analysis):
// - `download-resume.json` in the data folder, owner-only (0600), written whole and renamed into place, never part of the state, of an export
//   or of a copy of the session. It holds, for each download in progress, the address (which may hold a token) and the path of the partial file.
// - Nothing is read or written until the setting is on. Off again, the file and the partial files it names are removed.
// - A path read back from the file is only ever followed after it was judged again: inside the profile's downloads folder, no `..`, no link,
//   an ordinary file with one name, and the first and last megabytes of it are the ones that were written. A file that does not pass is left
//   alone (only a file that is certainly ours is removed, and only when the record is dropped).
// - The server is asked, with a one-byte `Range` request, whether it still holds the same file (same ETag, same Last-Modified, same length).
//   Only then is the partial file cut to the recorded offset and Chromium asked to go on from there.
// - An address is never logged or shown whole: messages name the file, the interface shows host and path (`displayAddress`).

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, type Stats } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  FINGERPRINT_BYTES,
  RESUME_FILE_MAX_BYTES,
  RESUME_MAX_RECORDS,
  RESUME_CHECKPOINT_MS,
  RESUME_VERSION,
  cleanRecord,
  displayAddress,
  dropsRecord,
  isRecordablePath,
  isStale,
  judgeProbe,
  newRecordId,
  probeHeaders,
  refusalMessage,
  removesPartial,
  worthRecording,
  type ItemView,
  type ProbeAnswer,
  type Refusal,
  type ResumeRecord
} from '@shared/download-resume'
import { suggestedFileName } from '@shared/file-names'
import type { PlatformId } from '@shared/platform'
import { currentPlatform } from '../platform'
import type { DownloadInfo } from '@shared/model'
import { refuseLinkSync, replaceFileDurably } from '../durable-write'
import { isInside } from './download-names'
import { t } from '@shared/i18n'

/** What the checks need to know of a file or folder. */
export interface FileFacts {
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
  nlink: number
  dev: number
  ino: number
}

/** The file system calls this module makes, a seam for the tests that force a damaged folder or an error. */
export interface ResumeFs {
  /** Without following a link; null when nothing is there. */
  lstat(path: string): FileFacts | null
  /** Following links (the downloads folder of a profile may be a link the user made); null when nothing is there. */
  stat(path: string): FileFacts | null
  /** The text of a file, null when there is none. Throws `RangeError` for a file larger than `maxBytes`, unread. */
  readText(path: string, maxBytes: number): string | null
  /** Replaces the file whole, owner-only, by writing a neighbour and renaming it. */
  writeText(path: string, text: string): void
  /** Removes a file; nothing to remove is not an error. */
  remove(path: string): void
  /** Opens without following a link in the last name. */
  open(path: string, write: boolean): number
  fstat(fd: number): FileFacts
  read(fd: number, position: number, length: number): Buffer
  truncate(fd: number, length: number): void
  close(fd: number): void
}

const facts = (stat: Stats): FileFacts => ({
  isFile: stat.isFile(),
  isDirectory: stat.isDirectory(),
  isSymlink: stat.isSymbolicLink(),
  size: stat.size,
  nlink: stat.nlink,
  dev: stat.dev,
  ino: stat.ino
})

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

export const realResumeFs: ResumeFs = {
  lstat: (path) => {
    try {
      return facts(lstatSync(path))
    } catch (error) {
      if (absent(error)) return null
      throw error
    }
  },
  stat: (path) => {
    try {
      return facts(statSync(path))
    } catch (error) {
      if (absent(error)) return null
      throw error
    }
  },
  readText: (path, maxBytes) => {
    try {
      if (statSync(path).size > maxBytes) throw new RangeError('The file is larger than allowed')
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (absent(error)) return null
      throw error
    }
  },
  // Complete or not renamed: a record file that stops short would lose every download in progress. A write that fails leaves no neighbour
  // behind: it would be a copy of the addresses (tokens included) that nothing removes when the setting goes off.
  writeText: (path, text) => replaceFileDurably(path, text),
  remove: (path) => {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!absent(error)) throw error
    }
  },
  // O_NOFOLLOW does not exist on Windows: the look for a link (refuseLinkSync) is what refuses one there.
  open: (path, write) => {
    refuseLinkSync(path)
    return openSync(path, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
  },
  fstat: (fd) => facts(fstatSync(fd)),
  read: (fd, position, length) => {
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, position + filled)
      if (count === 0) break
      filled += count
    }
    return buffer.subarray(0, filled)
  },
  truncate: (fd, length) => ftruncateSync(fd, length),
  close: (fd) => closeSync(fd)
}

const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------------------------------------------------------------------------------
// Where a recorded path leads
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * Whether `path` is a place this application could have written a download to: below the folder (never the folder itself), written in its
 * plain form (no `..`, no `.`, no doubled slash), and made of names that `suggestedFileName` would leave as they are. No disk access.
 */
export function lexicalPlace(path: string, folder: string, platform: PlatformId = currentPlatform().id): boolean {
  if (!isRecordablePath(path)) return false
  const root = resolve(folder)
  if (resolve(path) !== path || path === root || !isInside(root, path)) return false
  return relative(root, path)
    .split(sep)
    .every((part) => part === suggestedFileName(part, { platform }))
}

type Place = 'ok' | 'place' | 'unsafe' | 'missing'

/** The place judged against the disk too: the folders on the way are folders (not links), the file is an ordinary file with one name. */
export function checkPlace(path: string, folder: string, fs: ResumeFs): { place: 'ok'; file: FileFacts } | { place: Exclude<Place, 'ok'> } {
  if (!lexicalPlace(path, folder)) return { place: 'place' }
  const root = resolve(folder)
  // The folder itself is the user's choice (or the system's), and may be a link; what is below it is not.
  const top = fs.stat(root)
  if (top === null || !top.isDirectory) return { place: 'place' }
  const names = relative(root, path).split(sep)
  let current = root
  for (const name of names.slice(0, -1)) {
    current = join(current, name)
    const folderFacts = fs.lstat(current)
    if (folderFacts === null) return { place: 'missing' }
    if (!folderFacts.isDirectory || folderFacts.isSymlink) return { place: 'unsafe' }
  }
  const file = fs.lstat(path)
  if (file === null) return { place: 'missing' }
  if (file.isSymlink || !file.isFile || file.nlink !== 1) return { place: 'unsafe' }
  return { place: 'ok', file }
}

export type Inspection = { place: Exclude<Place, 'ok'> } | { place: 'ok'; size: number; ours: boolean; intact: boolean; complete: boolean }

/**
 * Looks at the partial file of a record. `ours`: its first megabyte is the one that was fingerprinted, so it is the file that was being
 * downloaded. `intact`: it also holds, up to the recorded offset, the bytes that were confirmed. `complete`: it is as long as the whole
 * download, so the download ended and only its record outlived it (the application was closing, or the file of records could not be
 * written): such a file is the user's, never cut and never removed. With `truncate`, an intact file longer than the offset is cut to it
 * (what follows was never confirmed); a file that is not intact is never touched.
 */
export function inspectPartial(record: ResumeRecord, folder: string, fs: ResumeFs, options: { truncate?: boolean } = {}): Inspection {
  const found = checkPlace(record.path, folder, fs)
  if (found.place !== 'ok') return { place: found.place }
  let fd: number
  try {
    fd = fs.open(record.path, options.truncate === true)
  } catch (error) {
    // A link put there since the look above makes the open fail (ELOOP); a file taken away makes it ENOENT.
    return { place: absent(error) ? 'missing' : 'unsafe' }
  }
  try {
    const now = fs.fstat(fd)
    // The file opened is the file that was judged: not one swapped in between.
    if (!now.isFile || now.nlink !== 1 || now.dev !== found.file.dev || now.ino !== found.file.ino) return { place: 'unsafe' }
    const ours = now.size >= FINGERPRINT_BYTES && digest(fs.read(fd, 0, FINGERPRINT_BYTES)) === record.head
    const intact = ours && now.size >= record.offset && digest(fs.read(fd, record.offset - FINGERPRINT_BYTES, FINGERPRINT_BYTES)) === record.tail
    const complete = now.size >= record.length
    if (intact && !complete && options.truncate === true && now.size > record.offset) fs.truncate(fd, record.offset)
    return { place: 'ok', size: now.size, ours, intact, complete }
  } finally {
    fs.close(fd)
  }
}

/** The fingerprints of a partial file being written, with the offset they stand for (what is on disk, if less than what Chromium counted). */
export function fingerprintFile(path: string, folder: string, received: number, fs: ResumeFs): { head: string; tail: string; offset: number } | null {
  if (checkPlace(path, folder, fs).place !== 'ok') return null
  const fd = fs.open(path, false)
  try {
    const now = fs.fstat(fd)
    if (!now.isFile || now.nlink !== 1) return null
    const offset = Math.min(received, now.size)
    if (offset < FINGERPRINT_BYTES) return null
    return { head: digest(fs.read(fd, 0, FINGERPRINT_BYTES)), tail: digest(fs.read(fd, offset - FINGERPRINT_BYTES, FINGERPRINT_BYTES)), offset }
  } finally {
    fs.close(fd)
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The file of the records
// ---------------------------------------------------------------------------------------------------------------------------------------

export type Log = (level: 'error' | 'warn', message: string, detail?: unknown) => void

/**
 * The reason of an error for a log line: its name and its code (`ENOENT`, `net::ERR_NAME_NOT_RESOLVED`), never its text, which may repeat
 * the address that failed. The code is read where it is, not guessed from the text.
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error'
  const own = (error as { code?: unknown } | null)?.code
  const fromText = error instanceof Error ? /\bnet::ERR_[A-Z_]+/.exec(error.message)?.[0] : undefined
  const code = typeof own === 'string' && /^[A-Z_]{3,30}$/.test(own) ? own : fromText
  return code ? `${name} (${code})` : name
}

export class ResumeStore {
  private readonly records = new Map<string, ResumeRecord>()

  constructor(
    readonly path: string,
    private readonly fs: ResumeFs,
    private readonly now: () => number,
    private readonly log: Log,
    /** The largest file written or read (the tests make it small). */
    private readonly maxBytes: number = RESUME_FILE_MAX_BYTES
  ) {}

  all(): ResumeRecord[] {
    return [...this.records.values()]
  }

  get(id: string): ResumeRecord | undefined {
    return this.records.get(id)
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  /** Makes the (empty) file when there is none: its existence tells the next launch to download in a single stream. */
  ensure(): void {
    if (this.fs.lstat(this.path) === null) this.write()
  }

  /**
   * Reads the file once. What is not a file of this version, too large or not an ordinary file is removed without being followed;
   * a record that is not valid is dropped. Returns how many records were dropped.
   */
  load(): number {
    this.records.clear()
    let dropped = 0
    let text: string | null
    try {
      const here = this.fs.lstat(this.path)
      if (here === null) return 0
      if (here.isSymlink || !here.isFile) throw new Error('not an ordinary file')
      text = this.fs.readText(this.path, this.maxBytes)
    } catch (error) {
      this.log('error', `[downloads] ${this.path} cannot be read (${describeError(error)}): it is removed and no download will resume from it`)
      this.removeFile()
      return 0
    }
    if (text === null) return 0
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.log('error', `[downloads] ${this.path} is not valid JSON (${describeError(error)}): it is removed and no download will resume from it`)
      this.removeFile()
      return 0
    }
    const list = typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === RESUME_VERSION ? (parsed as { records?: unknown }).records : undefined
    if (!Array.isArray(list)) {
      this.log('error', `[downloads] ${this.path} is not a resume file of this version: it is removed and no download will resume from it`)
      this.removeFile()
      return 0
    }
    const now = this.now()
    for (const raw of list.slice(0, RESUME_MAX_RECORDS * 2)) {
      const record = cleanRecord(raw, now)
      if (record === null || this.records.has(record.id) || this.records.size >= RESUME_MAX_RECORDS) dropped++
      else this.records.set(record.id, record)
    }
    dropped += Math.max(0, list.length - RESUME_MAX_RECORDS * 2)
    if (dropped > 0) this.log('warn', `[downloads] ${dropped} record(s) of ${this.path} were not valid and are dropped`)
    return dropped
  }

  /**
   * Adds or replaces a record and writes the file. When the list is full the oldest record that no download in progress owns makes room;
   * when there is none the record is not kept (false).
   */
  put(record: ResumeRecord, owned: ReadonlySet<string>): boolean {
    if (!this.records.has(record.id) && this.records.size >= RESUME_MAX_RECORDS) {
      const oldest = this.all()
        .filter((r) => !owned.has(r.id))
        .sort((a, b) => a.savedAt - b.savedAt)[0]
      if (!oldest) return false
      this.records.delete(oldest.id)
    }
    const before = this.records.get(record.id)
    this.records.set(record.id, record)
    try {
      this.write()
    } catch (error) {
      // What the list says must be what the file says: a record that could not be written is not a record that survives a restart.
      if (before) this.records.set(record.id, before)
      else this.records.delete(record.id)
      throw error
    }
    return true
  }

  remove(id: string): void {
    const before = this.records.get(id)
    if (before === undefined) return
    this.records.delete(id)
    try {
      this.write()
    } catch (error) {
      // As in `put`: the file still holds the record, so the list holds it too. Forgotten here only, it would come back at the next launch
      // as a download to resume, with nothing left in this run to remove it.
      this.records.set(id, before)
      throw error
    }
  }

  /** Forgets everything and removes the file (the setting went off). */
  destroy(): void {
    this.records.clear()
    this.removeFile()
  }

  private write(): void {
    const text = `${JSON.stringify({ version: RESUME_VERSION, records: this.all() })}\n`
    if (text.length > this.maxBytes) throw new RangeError('The resume file would be larger than allowed')
    this.fs.writeText(this.path, text)
  }

  /** The file and the neighbour a write is made in: what an interrupted write left there holds the same addresses under another name. */
  private removeFile(): void {
    for (const path of [this.path, `${this.path}.tmp`]) {
      try {
        this.fs.remove(path)
      } catch (error) {
        this.log('error', `[downloads] cannot remove ${path} (${describeError(error)})`)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------------------------

/** How long Chromium has to announce the download that `createInterruptedDownload` made. */
const EXPECT_MS = 15_000

export interface ProbeRequest {
  url: string
  headers: Record<string, string>
}

export interface CreateInterruptedOptions {
  path: string
  urlChain: string[]
  mimeType?: string
  offset: number
  length: number
  lastModified: string
  eTag: string
  startTime: number
}

export interface ResumePorts {
  fs: ResumeFs
  /** The file of the records. */
  file: string
  now(): number
  random(): string
  /** The downloads folder of a profile, as the engine uses it for a new download. */
  folderOf(profileId: string): string
  /** Whether a profile still has a space. */
  profileLive(profileId: string): boolean
  /** One request to the server of the file, with the session of the profile. Rejects when the server cannot be reached. */
  probe(profileId: string, request: ProbeRequest): Promise<ProbeAnswer>
  createInterrupted(profileId: string, options: CreateInterruptedOptions): void
  /** A row of the downloads popover changed. */
  emit(info: DownloadInfo, profileId: string): void
  /** A sentence for the user. */
  notify(message: string): void
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log: Log
}

export const defaultRandom = (): string => randomBytes(6).toString('hex')

/** What the engine gives for each download that may be recorded. */
export interface TrackRequest {
  profileId: string
  /** The file chosen for the download. */
  path: string
  /** The downloads folder of the profile the path was made in. */
  folder: string
  /** A private window or tab: nothing about its downloads is ever written. */
  privateScope: boolean
  /** Reads the live download. May throw once it is over: the last answer is kept. */
  view: () => ItemView
  /** Set for a download that continues a record. */
  recordId?: string
}

export interface Tracker {
  readonly recordId: string
  /** Chromium reported progress. */
  progress(): void
  /** The download was interrupted: a checkpoint now. */
  interrupted(): void
  /** The download ended. `canResume` is Chromium's word for an interrupted one. Returns whether a record is kept (the row can be resumed after a restart). */
  finish(state: 'completed' | 'cancelled' | 'interrupted', canResume: boolean | undefined): boolean
  /** Whether a record is kept for this download now. */
  recorded(): boolean
}

export class DownloadResume {
  private readonly store: ResumeStore
  private readonly live = new Map<string, LiveTracker>()
  private readonly resuming = new Set<string>()
  private expected: Array<{ profileId: string; url: string; record: ResumeRecord; timer: unknown }> = []
  private started = false
  private recording = false
  private failedOnce = false

  constructor(private readonly ports: ResumePorts) {
    this.store = new ResumeStore(ports.file, ports.fs, ports.now, ports.log)
  }

  get isStarted(): boolean {
    return this.started
  }

  /** Whether new downloads are recorded (false when the launch did not download in a single stream: see single-stream.ts). */
  get isRecording(): boolean {
    return this.recording
  }

  recordCount(): number {
    return this.store.all().length
  }

  /**
   * Turns the service on. `record` false: only the file is made (so that the next launch downloads in a single stream), and nothing is read,
   * recorded or resumed. Otherwise the file is read and every record is judged again; those that cannot go on are dropped (and their partial
   * file removed when it is certainly ours), and the others come back as rows of the downloads popover.
   */
  start(record: boolean): DownloadInfo[] {
    if (this.started) return []
    // A file that cannot be made leaves the service off: the error goes up to the gate, which says so and keeps the feature off.
    this.store.ensure()
    this.started = true
    this.recording = record
    if (!record) return []
    let removed = this.store.load()
    const rows: DownloadInfo[] = []
    for (const rec of this.store.all()) {
      const refusal = this.assess(rec, false)
      if (refusal === null) rows.push(this.rowOf(rec, true))
      else {
        this.settle(rec, refusal)
        // A download that ended is not one that "can no longer be resumed": its record goes without a word.
        if (refusal !== 'complete') removed++
      }
    }
    if (removed > 0) this.ports.notify(removed === 1 ? t('download-resume.un-telechargement-interrompu-ne-peut-plus-etre') : t('download-resume.removed-telechargements-interrompus-ne-peuvent', { removed }))
    return rows
  }

  /**
   * Turns the service off. `purge`: the setting went off, so the records, the file and the partial files that are ours go (those of
   * downloads still in progress stay, they are being written). Otherwise (the application closes) the file is left for the next launch.
   */
  stop(purge: boolean): void {
    if (!this.started) return
    this.started = false
    this.recording = false
    const owned = new Set(this.live.keys())
    for (const tracker of this.live.values()) tracker.detach()
    this.live.clear()
    for (const entry of this.expected) this.ports.clearTimer(entry.timer)
    this.expected = []
    if (!purge) return
    for (const rec of this.store.all()) if (!owned.has(rec.id)) this.removePartial(rec)
    this.store.destroy()
  }

  /** Starts recording a download. Null when it must not be recorded: a private window, a place outside the downloads folder, or no room. */
  track(request: TrackRequest): Tracker | null {
    if (!this.started || !this.recording || request.privateScope || this.live.size >= RESUME_MAX_RECORDS) return null
    if (!lexicalPlace(request.path, request.folder)) return null
    const id = request.recordId ?? newRecordId(this.ports.random)
    const tracker = new LiveTracker(this, id, request)
    this.live.set(id, tracker)
    return tracker
  }

  /** The records are brought up to date now (the application is about to quit). */
  flush(): void {
    for (const tracker of this.live.values()) tracker.interrupted()
  }

  isRecorded(id: string): boolean {
    return this.store.has(id)
  }

  /** The user removed the row of a download that is not running: its record goes, and its partial file when it is ours. */
  forget(id: string): void {
    if (!this.started || this.live.has(id)) return
    const record = this.store.get(id)
    if (!record) return
    this.removePartial(record)
    this.guarded(() => this.store.remove(id))
  }

  /** The data of a profile was erased: the addresses recorded for it go (they hold its sign-ins' tokens), with the partial files that are ours. */
  forgetProfile(profileId: string): void {
    if (!this.started) return
    for (const record of this.store.all()) if (record.profileId === profileId && !this.live.has(record.id)) this.forget(record.id)
  }

  /**
   * Carries on a download after a restart. The order matters: the record and the file are judged again, then the server is asked (one byte)
   * whether it holds the same file, then the file is judged once more and cut to the offset, and only then is Chromium asked to go on.
   * Every refusal tells the user why; the ones that cannot change drop the record.
   */
  async resume(id: string): Promise<void> {
    const record = this.store.get(id)
    if (!record || !this.started || !this.recording || this.live.has(id) || this.resuming.has(id)) return
    this.resuming.add(id)
    try {
      await this.resumeRecord(record)
    } catch (error) {
      // A bug or a failure no check foresaw: the user is told, the record stays (nothing was decided about it).
      this.ports.log('error', `[downloads] the resumption of ${record.id} failed (${describeError(error)})`)
      this.ports.notify(t('download-resume.la-reprise-de-name-a-echoue', { name: basename(record.path).slice(0, 80) }))
    } finally {
      this.resuming.delete(id)
    }
  }

  private async resumeRecord(record: ResumeRecord): Promise<void> {
    const refusal = this.assess(record, false)
    if (refusal !== null) return this.refuse(record, refusal)
    let answer: ProbeAnswer
    try {
      answer = await this.ports.probe(record.profileId, { url: record.url, headers: probeHeaders(record) })
    } catch (error) {
      this.ports.log('warn', `[downloads] the server of ${record.id} did not answer the check of a resumption (${describeError(error)})`)
      return this.refuse(record, 'unreachable')
    }
    // The setting may have gone off while the server was answering: nothing is done for a function that is off.
    if (!this.started || !this.recording) return
    const verdict = judgeProbe(record, answer)
    if (!verdict.ok) return this.refuse(record, verdict.refusal)
    // The request took time: the file is judged again, and this time cut to the offset.
    const again = this.assess(record, true)
    if (again !== null) return this.refuse(record, again)
    const entry = { profileId: record.profileId, url: record.url, record, timer: undefined as unknown }
    entry.timer = this.ports.setTimer(() => this.expired(entry), EXPECT_MS)
    this.expected.push(entry)
    try {
      this.ports.createInterrupted(record.profileId, {
        path: record.path,
        urlChain: [record.url],
        ...(record.mimeType ? { mimeType: record.mimeType } : {}),
        offset: record.offset,
        length: record.length,
        lastModified: record.lastModified,
        eTag: record.etag,
        startTime: record.startTime
      })
    } catch (error) {
      this.ports.clearTimer(entry.timer)
      this.expected = this.expected.filter((e) => e !== entry)
      this.ports.log('error', `[downloads] Chromium refused to recreate the download ${record.id} (${describeError(error)})`)
      return this.refuse(record, 'failed')
    }
  }

  /**
   * The engine saw a download that Chromium announces for one of the resumptions asked: it is that record's. Null for any other download.
   * The record's id becomes the download's, so that the row of the popover goes on in place.
   */
  takeExpected(profileId: string, url: string): ResumeRecord | null {
    const at = this.expected.findIndex((e) => e.profileId === profileId && e.url === url)
    if (at < 0) return null
    const [entry] = this.expected.splice(at, 1)
    this.ports.clearTimer(entry!.timer)
    return entry!.record
  }

  // ---- inside ----

  /** Why a record cannot go on, or null. `truncate` cuts an intact file to the offset (the last look before Chromium takes over). */
  private assess(record: ResumeRecord, truncate: boolean): Refusal | null {
    const stale = isStale(record, this.ports.now())
    if (!stale && !this.ports.profileLive(record.profileId)) return 'profile'
    let found
    try {
      found = inspectPartial(record, this.ports.folderOf(record.profileId), this.ports.fs, { truncate })
    } catch (error) {
      this.ports.log('error', `[downloads] cannot look at the partial file of ${record.id} (${describeError(error)})`)
      return stale ? 'stale' : 'unsafe'
    }
    // Before anything else is said of the file: a whole file is a download that ended, whatever the age of its record.
    if (found.place === 'ok' && found.ours && found.complete) return 'complete'
    if (stale) return 'stale'
    if (found.place !== 'ok') return found.place
    if (!found.ours || (found.ours && found.size >= record.offset && !found.intact)) return 'changed'
    if (found.size < record.offset) return 'short'
    return null
  }

  /** Applies what a refusal means to the record and to the partial file. */
  private settle(record: ResumeRecord, refusal: Refusal): void {
    if (removesPartial(refusal)) this.removePartial(record)
    if (dropsRecord(refusal)) this.guarded(() => this.store.remove(record.id))
  }

  private refuse(record: ResumeRecord, refusal: Refusal): void {
    this.ports.notify(refusalMessage(basename(record.path), refusal))
    this.settle(record, refusal)
    // The row of a download that ended says so, instead of staying "interrupted" beside a whole file.
    if (refusal === 'complete') this.ports.emit({ ...this.rowOf(record, false), state: 'completed', receivedBytes: record.length }, record.profileId)
    else if (dropsRecord(refusal)) this.ports.emit(this.rowOf(record, false), record.profileId)
  }

  /** Removes the partial file of a record, only when it is certainly the file that was being downloaded and lies where this application writes. */
  private removePartial(record: ResumeRecord): void {
    try {
      const found = inspectPartial(record, this.ports.folderOf(record.profileId), this.ports.fs)
      // A file as long as the whole download is the finished file: removing it would delete what the user downloaded.
      if (found.place === 'ok' && found.ours && found.complete) return
      if (found.place === 'ok' && found.ours) this.ports.fs.remove(record.path)
      else if (found.place === 'ok') this.ports.log('warn', `[downloads] the partial file ${basename(record.path)} is not the one that was recorded: it is left in place`)
    } catch (error) {
      this.ports.log('error', `[downloads] cannot remove the partial file ${basename(record.path)} (${describeError(error)})`)
    }
  }

  private expired(entry: { profileId: string; record: ResumeRecord }): void {
    this.expected = this.expected.filter((e) => e !== entry)
    this.ports.notify(t('download-resume.la-reprise-de-name-n-a-pas-demarre-reessayez', { name: basename(entry.record.path).slice(0, 80) }))
  }

  private rowOf(record: ResumeRecord, resumable: boolean): DownloadInfo {
    return {
      id: record.id,
      filename: basename(record.path),
      // Host and path only: the row never holds the token that the record needs.
      url: displayAddress(record.url),
      path: record.path,
      state: 'interrupted',
      receivedBytes: record.offset,
      totalBytes: record.length,
      startedAt: Math.round(record.startTime * 1000),
      ...(record.mimeType ? { mimeType: record.mimeType } : {}),
      ...(resumable ? { resumable: true, recorded: true } : {})
    }
  }

  /** A failure to write the file is told once; the download itself goes on without a record. */
  private guarded(action: () => void): void {
    try {
      action()
    } catch (error) {
      this.ports.log('error', `[downloads] cannot write ${this.ports.file} (${describeError(error)}): downloads in progress will not resume after a restart`)
      if (!this.failedOnce) {
        this.failedOnce = true
        this.ports.notify(t('download-resume.impossible-d-enregistrer-de-quoi-reprendre-les'))
      }
    }
  }

  /** @internal For the trackers. */
  commit(record: ResumeRecord): boolean {
    let kept = false
    this.guarded(() => {
      this.dropStale()
      kept = this.store.put(record, new Set(this.live.keys()))
    })
    return kept
  }

  /** @internal For the trackers. */
  drop(id: string): void {
    this.guarded(() => this.store.remove(id))
  }

  /** @internal For the trackers. */
  has(id: string): boolean {
    return this.store.has(id)
  }

  /** @internal For the trackers. */
  get context(): Pick<ResumePorts, 'fs' | 'now' | 'log'> {
    return this.ports
  }

  /** @internal For the trackers. */
  release(id: string): void {
    this.live.delete(id)
  }

  /** Records that outlived their time and are not being written go, with their partial file, whenever the file is written anyway. */
  private dropStale(): void {
    for (const record of this.store.all()) {
      if (this.live.has(record.id) || !isStale(record, this.ports.now())) continue
      this.removePartial(record)
      this.store.remove(record.id)
    }
  }
}

class LiveTracker implements Tracker {
  private lastTry = 0
  private lastView: ItemView | null = null
  private detached = false

  constructor(
    private readonly service: DownloadResume,
    readonly recordId: string,
    private readonly request: TrackRequest
  ) {}

  detach(): void {
    this.detached = true
  }

  progress(): void {
    this.checkpoint(false)
  }

  interrupted(): void {
    this.checkpoint(true)
  }

  recorded(): boolean {
    return this.service.has(this.recordId)
  }

  finish(state: 'completed' | 'cancelled' | 'interrupted', canResume: boolean | undefined): boolean {
    if (this.detached) {
      // The service stopped (the window closed) and the download went on to its end: its record must not outlive it, or the next launch
      // would take the whole file for a partial one. A cancellation is not read here: Chromium cancels what is running as the application quits.
      if (state === 'completed') this.service.drop(this.recordId)
      return false
    }
    if (state === 'completed' || state === 'cancelled' || canResume === false) {
      this.service.drop(this.recordId)
      this.detached = true
      this.service.release(this.recordId)
      return false
    }
    this.checkpoint(true)
    this.detached = true
    this.service.release(this.recordId)
    return this.recorded()
  }

  private checkpoint(force: boolean): void {
    if (this.detached) return
    const { now, log, fs } = this.service.context
    const at = now()
    if (!force && at - this.lastTry < RESUME_CHECKPOINT_MS) return
    this.lastTry = at
    try {
      try {
        this.lastView = this.request.view()
      } catch {
        // The download is over and Electron no longer answers: the last answer stands.
      }
      const view = this.lastView
      if (view === null || !worthRecording(view)) return
      const print = fingerprintFile(this.request.path, this.request.folder, view.received, fs)
      if (print === null) return
      const kept = this.service.commit({
        id: this.recordId,
        profileId: this.request.profileId,
        url: view.url,
        path: this.request.path,
        offset: print.offset,
        length: view.total,
        ...(view.mimeType ? { mimeType: view.mimeType.slice(0, 100) } : {}),
        etag: view.etag,
        lastModified: view.lastModified,
        startTime: view.startTime,
        savedAt: at,
        head: print.head,
        tail: print.tail
      })
      if (!kept && this.service.has(this.recordId) === false) log('warn', `[downloads] ${this.recordId} was not recorded: the list of resumable downloads is full`)
    } catch (error) {
      log('error', `[downloads] cannot make a checkpoint of ${this.recordId} (${describeError(error)})`)
    }
  }
}
