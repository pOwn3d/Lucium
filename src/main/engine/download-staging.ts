// The application's own temporary folder for downloads: where a file waits while the user is asked where to put it, and where a file
// opened "without keeping it" lives. Nothing outside this folder is ever read, moved or deleted by this module. The folder is swept
// at launch and on quit, so a file opened this way does not outlive the session.

import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isRequestedDownload } from '@shared/chrome-compat'
import { suggestedFileName } from '@shared/file-names'
import type { PlatformId } from '@shared/platform'
import { currentPlatform } from '../platform'
import { isInside } from './download-names'

/** The folder of this installation: named after its data folder, so that two copies of the application (or a test) never sweep each other's files. */
export function stagingRootFor(userDataDir: string, tempDir: string): string {
  return join(tempDir, `lucium-${createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)}`)
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The file system calls this module makes: a seam for the tests that force an error. */
export interface StagingFs {
  mkdir(path: string): void
  readdir(path: string): string[]
  remove(path: string): void
  isRealFolder(path: string): boolean
  rename(from: string, to: string): void
  copy(from: string, to: string): void
  unlink(path: string): void
}

const realFs: StagingFs = {
  mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
  readdir: (path) => readdirSync(path),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  isRealFolder: (path) => {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  },
  rename: (from, to) => renameSync(from, to),
  copy: (from, to) => copyFileSync(from, to),
  unlink: (path) => unlinkSync(path)
}

export class DownloadStaging {
  constructor(
    readonly root: string,
    private readonly fs: StagingFs = realFs
  ) {}

  /** Whether `path` is inside the folder (by its written form: a `..` step does not count as inside). */
  contains(path: string): boolean {
    return path !== this.root && isInside(this.root, path)
  }

  /**
   * A path in a folder of its own for the download `id`, named from the page's file name (cleaned, with the rules of `platform`: Windows refuses
   * some characters and device names); the folder exists, the file does not.
   */
  allocate(id: string, filename: string, platform: PlatformId = currentPlatform().id): string {
    if (!ID.test(id)) throw new Error('Invalid download id')
    this.fs.mkdir(this.root)
    if (!this.fs.isRealFolder(this.root)) throw new Error(`${this.root} is not a plain folder`)
    const folder = join(this.root, id)
    if (!this.contains(folder)) throw new Error('The folder of a download must be inside the temporary folder')
    this.fs.mkdir(folder)
    const path = join(folder, suggestedFileName(filename, { platform }))
    if (!this.contains(path)) throw new Error('The file of a download must be inside the temporary folder')
    return path
  }

  /** Removes the folder of one download. A path outside the temporary folder is refused. */
  release(path: string): void {
    if (!this.contains(path)) throw new Error('Refusing to remove a path outside the temporary folder')
    // The first level under the root is the folder of the download: that is what goes.
    const first = relative(resolve(this.root), resolve(path)).split(sep)[0]!
    this.fs.remove(join(this.root, first))
  }

  /**
   * Empties the folder (it stays). Each failure is returned with its path, and the others go on. A root that is not a plain folder
   * (a link put there) is left alone and reported.
   */
  sweep(): { removed: number; failures: Array<{ path: string; error: string }> } {
    const failures: Array<{ path: string; error: string }> = []
    let entries: string[]
    try {
      if (!this.fs.isRealFolder(this.root)) return { removed: 0, failures: [{ path: this.root, error: 'not a plain folder' }] }
      entries = this.fs.readdir(this.root)
    } catch (error) {
      // Nothing was ever staged here: not a failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, failures }
      return { removed: 0, failures: [{ path: this.root, error: String((error as Error).message ?? error) }] }
    }
    let removed = 0
    for (const name of entries) {
      const path = join(this.root, name)
      if (!this.contains(path)) {
        failures.push({ path, error: 'outside the temporary folder' })
        continue
      }
      try {
        this.fs.remove(path)
        removed++
      } catch (error) {
        failures.push({ path, error: String((error as Error).message ?? error) })
      }
    }
    return { removed, failures }
  }

  /**
   * Moves a staged file to the place the user chose. Only a file of this folder can be moved; the destination folder is created. A
   * move between two disks is a copy followed by the removal of the original.
   */
  moveOut(from: string, to: string): void {
    if (!this.contains(from)) throw new Error('Refusing to move a file from outside the temporary folder')
    this.fs.mkdir(dirname(to))
    try {
      this.fs.rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      this.fs.copy(from, to)
      this.fs.unlink(from)
    }
  }
}

/**
 * What a download that waited for its place ends as. A "Save as" the user closed (or one that failed, or answered with no file path)
 * cancels the download; when Chromium had finished it first, the cancel comes too late and Chromium's last word stays "completed", while
 * the staged file is removed right after: the row says cancelled, not completed with a file that is gone.
 */
export function stagedOutcome(state: 'completed' | 'cancelled' | 'interrupted', placeRefused: boolean): 'completed' | 'cancelled' | 'interrupted' {
  return placeRefused ? 'cancelled' : state
}

/** How long a request waits for the download it asked for to start. */
const REQUEST_TTL_MS = 15_000
const REQUESTS_MAX = 20

/**
 * The links the user asked to open without keeping: an entry waits for the download of its address in the session of the page, then is
 * used up. It does not wait for ever, and does not grow: a link that never downloads (a page that opens) leaves nothing behind.
 */
export class UnsavedRequests {
  private readonly waiting: Array<{ session: object; url: string; at: number }> = []

  constructor(private readonly now: () => number = Date.now) {}

  expect(session: object, url: string): void {
    this.prune()
    this.waiting.push({ session, url, at: this.now() })
    if (this.waiting.length > REQUESTS_MAX) this.waiting.shift()
  }

  /** True once when a request was waiting for a download of these addresses (the address and its redirections) in this session. */
  take(session: object, urls: readonly string[]): boolean {
    this.prune()
    const at = this.waiting.findIndex((r) => r.session === session && isRequestedDownload(r.url, urls))
    if (at < 0) return false
    this.waiting.splice(at, 1)
    return true
  }

  get size(): number {
    this.prune()
    return this.waiting.length
  }

  private prune(): void {
    const limit = this.now() - REQUEST_TTL_MS
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i]!.at < limit) this.waiting.splice(i, 1)
  }
}
