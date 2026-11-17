// The filter lists on disk, in the user's data folder: one text file per list, an index of what is known about each, and
// the compiled engine of each category. Every write goes to a temporary file first and is renamed over the old one, so a
// crash or a full disk cannot leave a half-written list in use. A list that fails to update stays as it was.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { replaceFileDurably } from '../durable-write'
import { DATA_FILE_MAX_BYTES, readTextBounded, SMALL_FILE_MAX_BYTES } from '../persist'
import { currentPlatform } from '../platform'
import type { ReviewSummary } from '@shared/custom-filter-lists'
import { isClosedToOthers, type PlatformId } from '@shared/platform'

export interface StoredList {
  /** Validators for the next conditional request. */
  etag?: string
  lastModified?: string
  /** When the copy was last fetched or confirmed current (ms). */
  checkedAt: number
  rules: number
  /** sha-256 of the text: detects a file changed or damaged behind our back, and keys the compiled engine. */
  hash: string
  /** A list of the user's: the rules left out when it was read (see custom-filter-lists.ts). Absent for the lists we download. */
  review?: ReviewSummary
}

export interface StoredError {
  message: string
  at: number
}

interface Index {
  version: 1
  lists: Record<string, StoredList>
  errors: Record<string, StoredError>
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Files and folders of the filters folder are the user's alone: owner read and write, nobody else. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Owner-only, on the disk before it takes the place of the file, a link under the temporary name refused, and nothing left beside the file when the write fails. */
const writeAtomic = replaceFileDurably

/** The compiled engine of one category and the key of what it was compiled from. */
export interface CachedEngine {
  key: string
  bytes: Uint8Array
}

/**
 * The first line of an engine file. `format` is the layout of this file (a file of another layout is ignored), `key` names what the engine was
 * compiled from (the engine's own serialization version and the hash of each list: see service.ts), `size` and `crc32` describe the bytes that
 * follow, so that a file cut short or changed behind our back is recognised before an engine is asked to read it.
 */
interface EngineHeader {
  format: 2
  key: string
  size: number
  crc32: number
}
const ENGINE_FORMAT = 2

export class ListStore {
  private index: Index = { version: 1, lists: {}, errors: {} }

  /** The folders are made at the first write: a blocker that is never switched on leaves nothing on the disk. */
  private madeDirs = false

  /** `platform` is the system the modes are read on (a test plays another one). */
  constructor(
    private readonly dir: string,
    private readonly platform: PlatformId = currentPlatform().id
  ) {
    this.index = this.readIndex()
  }

  private ensureDirs(): void {
    if (this.madeDirs) return
    mkdirSync(join(this.dir, 'lists'), { recursive: true, mode: DIR_MODE })
    this.tightenExisting()
    this.madeDirs = true
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private listPath(id: string): string {
    return join(this.dir, 'lists', `${id}.txt`)
  }

  private enginePath(category: string): string {
    return join(this.dir, `engine-${category}.bin`)
  }

  private readIndex(): Index {
    try {
      const parsed = JSON.parse(readTextBounded(this.indexPath, SMALL_FILE_MAX_BYTES)) as Partial<Index>
      if (parsed.version !== 1 || typeof parsed.lists !== 'object' || parsed.lists === null) throw new Error('unknown format')
      const lists = Object.fromEntries(Object.entries(parsed.lists).filter(([id, meta]) => /^[a-z0-9-]+$/.test(id) && typeof meta?.hash === 'string' && existsSync(this.listPath(id))))
      return { version: 1, lists, errors: typeof parsed.errors === 'object' && parsed.errors !== null ? parsed.errors : {} }
    } catch (error) {
      // No index yet is the normal first run; anything else means the lists are fetched again, which is safe.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[blocking] cannot read the filter list index, starting over:', (error as Error).message)
      return { version: 1, lists: {}, errors: {} }
    }
  }

  private save(): void {
    this.ensureDirs()
    writeAtomic(this.indexPath, JSON.stringify(this.index))
  }

  meta(id: string): StoredList | undefined {
    return this.index.lists[id]
  }

  errorOf(id: string): StoredError | undefined {
    return this.index.errors[id]
  }

  /**
   * The text of an installed list, or null when it is missing or no longer matches what was installed. A copy that fails
   * the check is forgotten, so the next update fetches the list again instead of trusting it.
   */
  read(id: string): string | null {
    const meta = this.index.lists[id]
    if (!meta) return null
    try {
      const text = readTextBounded(this.listPath(id), DATA_FILE_MAX_BYTES)
      if (sha256(text) === meta.hash) return text
    } catch {
      // Falls through: an unreadable file is as good as a changed one.
    }
    delete this.index.lists[id]
    this.saveOrWarn(`forget the damaged copy of ${id}`)
    return null
  }

  /** Replaces a list with a new copy. The index only changes once the file is in place. */
  install(id: string, text: string, meta: Omit<StoredList, 'hash'>): void {
    this.ensureDirs()
    writeAtomic(this.listPath(id), text)
    this.index.lists[id] = { ...meta, hash: sha256(text) }
    delete this.index.errors[id]
    this.save()
  }

  /** Forgets a list: its file, what is known about it and the failure recorded for it. Nothing to do for an id that is not installed. */
  remove(id: string): void {
    rmSync(this.listPath(id), { force: true })
    delete this.index.lists[id]
    delete this.index.errors[id]
    this.save()
  }

  /** The server confirmed the installed copy is current. */
  confirm(id: string, at: number): void {
    const meta = this.index.lists[id]
    if (!meta) return
    this.index.lists[id] = { ...meta, checkedAt: at }
    delete this.index.errors[id]
    this.save()
  }

  /**
   * An attempt failed. The installed copy, if any, is untouched. The failure is kept in memory first, so that the settings show it even when the
   * disk refuses the index (a read-only volume, a full disk: the likeliest reasons for the attempt to have failed in the first place).
   */
  fail(id: string, message: string, at: number): void {
    this.index.errors[id] = { message, at }
    this.saveOrWarn(`record that the update of ${id} failed`)
  }

  /** Writes the index for a change that is already made in memory: a disk that refuses is told, and the memory stays the truth of this session. */
  private saveOrWarn(what: string): void {
    try {
      this.save()
    } catch (error) {
      console.warn(`[blocking] cannot ${what} on disk (kept in memory until the application quits):`, (error as Error).message)
    }
  }

  /**
   * The engine kept for a category, or null: no file (the first launch), a file of another layout, one that is cut short or changed, one that
   * cannot be read. Every case but the first is told on the console with the file's name, and a damaged file is removed; the caller compiles
   * the lists again. Whether the engine is the right one for the lists installed now is the caller's to say (the `key`).
   */
  readEngine(category: string): CachedEngine | null {
    const path = this.enginePath(category)
    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[blocking] cannot read the compiled ${category} engine (${path}), compiling again:`, (error as Error).message)
      return null
    }
    const refuse = (why: string, drop: boolean): null => {
      console.warn(`[blocking] the compiled ${category} engine (${path}) ${why}: it is ignored and the lists are compiled again`)
      if (drop) this.dropEngine(category)
      return null
    }
    const end = raw.indexOf(10)
    if (end < 0) return refuse('has no header', true)
    let header: Partial<EngineHeader>
    try {
      header = JSON.parse(raw.subarray(0, end).toString('utf8')) as Partial<EngineHeader>
    } catch {
      return refuse('has a header that is not readable', true)
    }
    // A file written by an older layout (no format number) is not damaged, only not ours any more.
    if (header.format !== ENGINE_FORMAT) return refuse(`was written by another version of the cache (layout ${String(header.format)})`, true)
    const payload = raw.subarray(end + 1)
    if (typeof header.key !== 'string' || header.size !== payload.length) return refuse(`is cut short (${payload.length} bytes of ${String(header.size)})`, true)
    if (header.crc32 !== crc32(payload)) return refuse('does not match its checksum', true)
    this.tighten(path)
    // A copy: the engines read the buffer as a whole and must not see the header line.
    return { key: header.key, bytes: Uint8Array.from(payload) }
  }

  /** One file, header line then payload, written in one go: the key and the bytes can never disagree. Owner-only. */
  writeEngine(category: string, cached: CachedEngine): void {
    this.ensureDirs()
    const header: EngineHeader = { format: ENGINE_FORMAT, key: cached.key, size: cached.bytes.length, crc32: crc32(cached.bytes) }
    writeAtomic(this.enginePath(category), Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), cached.bytes]))
  }

  /** A file other users could read (copied by hand, restored from a backup) is made owner-only again, and the change is told. */
  private tighten(path: string, mode = FILE_MODE): void {
    try {
      // Windows reports 0666 for every file: no mode says the file is open there, and "tightening" it would be told at every launch for nothing.
      if (isClosedToOthers(statSync(path).mode, this.platform)) return
      chmodSync(path, mode)
      console.warn(`[blocking] ${path} could be read by other users: it is now for its owner only`)
    } catch (error) {
      console.warn(`[blocking] cannot check the permissions of ${path}:`, (error as Error).message)
    }
  }

  /**
   * At the first write of a launch: the folders and files that an earlier version made for everyone to read (0755/0644) are made owner-only.
   * Nothing happens while the blocker writes nothing (a blocker that is off touches nothing), and a file already private is not touched.
   */
  private tightenExisting(): void {
    for (const folder of [this.dir, join(this.dir, 'lists')]) {
      let names: string[]
      try {
        names = readdirSync(folder)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[blocking] cannot look at ${folder}:`, (error as Error).message)
        continue
      }
      this.tighten(folder, DIR_MODE)
      for (const name of names) {
        const path = join(folder, name)
        try {
          if (statSync(path).isFile()) this.tighten(path)
        } catch (error) {
          console.warn(`[blocking] cannot check ${path}:`, (error as Error).message)
        }
      }
    }
  }

  dropEngine(category: string): void {
    rmSync(this.enginePath(category), { force: true })
  }
}
