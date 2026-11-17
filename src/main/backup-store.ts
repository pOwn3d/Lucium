// The files of the automatic copies of the session: a folder of dated JSON files in the application's data folder (see session-backups.ts for
// what a copy holds and how it is named). Only node:fs here, so that every rule can be tested against real files.

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFile } from './durable-write'
import { readTextBounded } from './persist'
import {
  COPY_BYTES_MAX,
  COPY_HEAD_BYTES,
  backupId,
  copiesToPrune,
  entryOf,
  isBackupId,
  newestFirst,
  nextStamp,
  parseCopy,
  reasonOfCopyHead,
  serializeCopy,
  stampOfBackupId,
  type BackupEntry,
  type CopyEdit,
  type CopyReason,
  type SessionCopy
} from '@shared/session-backups'

const EXTENSION = '.json'
const PARTIAL = '.tmp'

export class BackupFiles {
  /**
   * `heldBefore`: the time (ms) a state file was last set aside as unreadable, when one was; undefined otherwise. The automatic copies made before
   * it are kept apart from those made since (see `copiesToPrune`).
   */
  constructor(
    readonly dir: string,
    private readonly heldBefore: () => number | undefined = () => undefined
  ) {}

  private fileOf(id: string): string {
    return join(this.dir, `${id}${EXTENSION}`)
  }

  /** The ids of the copies on disk, newest first. A file that is not named like a copy is not one (and is never touched). */
  ids(): string[] {
    if (!existsSync(this.dir)) return []
    try {
      return newestFirst(
        readdirSync(this.dir)
          .filter((name) => name.endsWith(EXTENSION))
          .map((name) => name.slice(0, -EXTENSION.length))
          .filter(isBackupId)
      )
    } catch (error) {
      // A folder that cannot be listed holds no copy anyone can use: the panel shows none, and this says why.
      console.error(`[backups] cannot list the copies in ${this.dir}:`, error)
      return []
    }
  }

  /**
   * Writes a copy next to the others, then lets the oldest go (see `prune`). The file is written whole under another name and renamed, so that a crash
   * or a full disk leaves either the whole copy or none, never half of one; it is readable by the user only. Throws when it cannot be written
   * (nothing has been pruned then: the copies already there are all that is left).
   */
  write(copy: SessionCopy, keep: number): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    // A folder an earlier version made with the umask (0755) is closed to the others too: `mkdir` leaves the mode of a folder that is already there.
    // Only their bits are taken away; what the owner may do is left as it is.
    const mode = statSync(this.dir).mode & 0o777
    if ((mode & 0o077) !== 0) chmodSync(this.dir, mode & 0o700)
    const newest = this.ids()[0]
    const stamp = nextStamp(copy.createdAt, newest === undefined ? undefined : stampOfBackupId(newest))
    let counter = 0
    while (existsSync(this.fileOf(backupId(stamp, counter)))) counter++
    const id = backupId(stamp, counter)
    const partial = `${this.fileOf(id)}${PARTIAL}`
    try {
      // Owner-only whatever a crash left under that name, a link refused, and on the disk before the rename: a copy is what a lost state is rebuilt from.
      writeDurableFile(partial, serializeCopy(copy))
      renameSync(partial, this.fileOf(id))
    } catch (error) {
      rmSync(partial, { force: true })
      throw error
    }
    this.prune(keep)
    return id
  }

  /**
   * Why a copy was made, from the start of its file. Null for a file that cannot be read or does not say: it rotates with the automatic copies.
   * Only a regular file is opened: a pipe under that name would hold the application for ever.
   */
  private reasonOf(id: string): CopyReason | null {
    const file = this.fileOf(id)
    try {
      if (!lstatSync(file).isFile()) return null
      const fd = openSync(file, 'r')
      try {
        const head = Buffer.alloc(COPY_HEAD_BYTES)
        return reasonOfCopyHead(head.toString('utf8', 0, readSync(fd, head, 0, COPY_HEAD_BYTES, 0)))
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      console.error(`[backups] cannot read why the copy ${id} was made, it rotates with the automatic ones:`, error)
      return null
    }
  }

  /**
   * Deletes the copies beyond the ones kept (`copiesToPrune`: the `keep` newest automatic ones, and apart from them the ones somebody asked for),
   * and the half-written files a crash left. Never throws: a copy that stays is only clutter.
   */
  prune(keep: number): void {
    try {
      const copies = this.ids().map((id) => ({ id, reason: this.reasonOf(id) }))
      for (const id of copiesToPrune(copies, keep, this.heldBefore())) rmSync(this.fileOf(id), { force: true })
      for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
        if (name.endsWith(`${EXTENSION}${PARTIAL}`) && isBackupId(name.slice(0, -(EXTENSION.length + PARTIAL.length)))) rmSync(join(this.dir, name), { force: true })
      }
    } catch (error) {
      console.error(`[backups] cannot clean up the old copies in ${this.dir}:`, error)
    }
  }

  /**
   * Edits the copies on disk one by one: `edit` gets the text of each and says what to do (see `copyAfterForgetting`). A copy that changes is written
   * whole under another name and renamed over the old one, like `write` (owner-only, on the disk before the rename): a crash leaves the old copy or the
   * new one, never half of one. Never throws: a copy that cannot be read, edited or written stays as it was and is counted in `left`, with the reason logged.
   */
  edit(edit: (text: string) => CopyEdit): { rewritten: number; left: number } {
    let rewritten = 0
    let left = 0
    for (const id of this.ids()) {
      const partial = `${this.fileOf(id)}${PARTIAL}`
      try {
        const outcome = edit(readTextBounded(this.fileOf(id), COPY_BYTES_MAX))
        if (outcome.kind === 'unchanged') continue
        if (outcome.kind === 'left') {
          left++
          console.error(`[backups] the copy ${id} was not edited (${outcome.why})`)
          continue
        }
        writeDurableFile(partial, outcome.text)
        renameSync(partial, this.fileOf(id))
        rewritten++
      } catch (error) {
        rmSync(partial, { force: true })
        left++
        console.error(`[backups] the copy ${id} could not be edited (${String((error as Error).message ?? error)})`)
      }
    }
    return { rewritten, left }
  }

  /** One copy, read back and repaired. Throws for an id that is not a copy's, a file that is missing, too big or not a copy. */
  read(id: string): SessionCopy {
    if (!isBackupId(id)) throw new Error('not the name of a copy')
    const file = this.fileOf(id)
    // A regular file of the size of a copy, looked at before it is opened: a pipe under that name would hold the application for ever.
    return parseCopy(readTextBounded(file, COPY_BYTES_MAX))
  }

  /**
   * What the panel lists, newest first. A copy that cannot be read is left out and counted, and says why in the log: it is the file's
   * problem, never the application's.
   */
  list(): { entries: BackupEntry[]; unreadable: number } {
    const entries: BackupEntry[] = []
    let unreadable = 0
    for (const id of this.ids()) {
      try {
        entries.push(entryOf(id, this.read(id)))
      } catch (error) {
        unreadable++
        console.error(`[backups] ignoring the copy ${id}, which cannot be read (${String((error as Error).message ?? error)})`)
      }
    }
    return { entries, unreadable }
  }

  /** The newest copy that can be read, or null. */
  newest(): SessionCopy | null {
    for (const id of this.ids()) {
      try {
        return this.read(id)
      } catch (error) {
        // The next one is as good for what this is asked for.
        console.error(`[backups] skipping the copy ${id}, which cannot be read (${String((error as Error).message ?? error)})`)
      }
    }
    return null
  }
}
