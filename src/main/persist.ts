// Writing the files the application keeps (state.json, history.json) without ever losing one, and what is kept next to them: the file
// of a previous run that could not be read (`.corrupt-<time>`), the file of a more recent version (`.future-<time>`: not damaged, only not
// readable here, and never overwritten), the copy made before Help › Restore Data (`.avant-restauration-<time>`), and the copy of the state made
// before another version of the application than the one that wrote it writes over it (`.version-change-<time>-from-<version>`).
// Only node:fs here, so that every rule can be tested against real files.

import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeDurableFile, writeDurableFileAsync } from './durable-write'
import { reportPersistenceNotice } from './persistence-notices'
import { t } from '@shared/i18n'
import { compareVersions, isDottedVersion } from '@shared/versions'

/** The most a data file of the application is read for at start-up: a state or a history is a few megabytes at the very most, so more is a damaged or hostile file. */
export const DATA_FILE_MAX_BYTES = 64 * 1024 * 1024
/** The same for the small files (an index, a ledger of versions). */
export const SMALL_FILE_MAX_BYTES = 1024 * 1024

/**
 * The text of a data file of the application, when it is a regular file of at most `maxBytes` bytes. Throws otherwise, with the name and the
 * size, so that the caller treats it as unreadable (set aside, or started afresh) instead of reading it whole into memory at start-up.
 */
export function readTextBounded(path: string, maxBytes: number): string {
  const info = statSync(path)
  if (!info.isFile()) throw new Error(`${basename(path)} is not a regular file`)
  if (info.size > maxBytes) throw new Error(`${basename(path)} is ${info.size} bytes, more than the ${maxBytes} this application reads`)
  return readFileSync(path, 'utf8')
}

/**
 * The same text read as JSON, whether or not it starts with a byte-order mark: an editor that saved the file with one did not damage it.
 * Throws like `readTextBounded`, and like `JSON.parse` for a text that is not JSON.
 */
export function readJsonBounded(path: string, maxBytes: number): unknown {
  return JSON.parse(readTextBounded(path, maxBytes).replace(/^\uFEFF/, ''))
}

/** How many files of each sort are kept next to a data file. Older ones are deleted when a new one is made. */
export const SIDE_FILES_KEPT = 3

/**
 * `dropped`: the file as it was before entries it no longer accepts were left out (userscripts.json). `future`: a state written by a newer version.
 * `version-change`: the state as another version of the application left it, copied before this one writes it.
 */
export type SideKind = 'corrupt' | 'avant-restauration' | 'dropped' | 'future' | 'version-change'

const byAge = new Intl.Collator('en', { numeric: true })

/** The side files of `path` of one sort, the most recent first. Their names end with a time (milliseconds, or an ISO date) that sorts. */
export function sideFiles(path: string, kind: SideKind): string[] {
  const prefix = `${basename(path)}.${kind}-`
  const dir = dirname(path)
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => byAge.compare(b.slice(prefix.length), a.slice(prefix.length)))
    .map((name) => join(dir, name))
}

/** Deletes the side files of one sort beyond the `SIDE_FILES_KEPT` most recent. Never throws: a file that stays is only clutter. */
export function pruneSideFiles(path: string, kind: SideKind, keep = SIDE_FILES_KEPT): void {
  try {
    for (const old of sideFiles(path, kind).slice(keep)) rmSync(old, { force: true })
  } catch (error) {
    console.error(`[persist] cannot clean up the ${kind} files of ${path}:`, error)
  }
}

/** `base` + `ext`, or the first of `base-1` + `ext`, `base-2` + `ext`… that does not exist yet: a file of the same name is never overwritten. */
export function firstFree(base: string, ext = ''): string {
  if (!existsSync(base + ext)) return base + ext
  for (let n = 1; ; n++) if (!existsSync(`${base}-${n}${ext}`)) return `${base}-${n}${ext}`
}

/** Whether a state file was set aside at some point (a damaged or a newer one): the file it replaced may still hold what the current one does not name. */
export function hasSetAsideFiles(path: string): boolean {
  return sideFiles(path, 'corrupt').length > 0 || sideFiles(path, 'future').length > 0
}

/**
 * When a state file was last set aside (ms), from the names of the files (`setAside` writes the time in them); undefined when none was, or when
 * the folder cannot be listed. Never throws: it is asked for while copies of the session rotate, which must go on.
 */
export function lastSetAsideAt(path: string): number | undefined {
  try {
    const stamps = [...sideFiles(path, 'corrupt'), ...sideFiles(path, 'future')]
      .map((name) => /\.(?:corrupt|future)-(\d{13})(?:-\d+)?$/.exec(name))
      .filter((found) => found !== null)
      .map((found) => Number(found[1]))
    return stamps.length > 0 ? Math.max(...stamps) : undefined
  } catch (error) {
    console.error(`[persist] cannot list the files set aside next to ${path}:`, error)
    return undefined
  }
}

/** Moves the unreadable `path` to `path.corrupt-<time>` (`.future-<time>` for a file of a more recent version) and keeps only the most recent ones. Throws when the move fails; nothing is lost then. */
export function setAside(path: string, now = Date.now(), kind: 'corrupt' | 'future' = 'corrupt'): string {
  const backup = firstFree(`${path}.${kind}-${now}`)
  renameSync(path, backup)
  pruneSideFiles(path, kind)
  return backup
}

const stamp = (when: Date) => when.toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** The copy of `path` kept before a restoration replaces it. Throws when the copy fails. */
export function copyBeforeRestore(path: string, when = new Date()): string {
  const copy = firstFree(`${path}.avant-restauration-${stamp(when)}`)
  copyFileSync(path, copy)
  pruneSideFiles(path, 'avant-restauration')
  return copy
}

/** The version of the application a state file says wrote it, when it is one (`writtenBy`, see store.ts); null for a file that does not say. */
export const writerVersionOf = (value: unknown): string | null => (typeof value === 'string' && isDottedVersion(value) && value.length <= 32 ? value.trim() : null)

/**
 * The copy of `path` kept at the first launch of a version of the application other than the one that wrote the file (`writer`; null when the file
 * does not say), before this version writes it: an older version does not keep what it does not know inside a tab, a space or a folder, and a
 * migration of a newer one cannot be undone. The name says when and from which version; the three most recent are kept. Throws when the copy fails.
 */
export function copyOnVersionChange(path: string, writer: string | null, when = new Date()): string {
  const copy = firstFree(`${path}.version-change-${stamp(when)}-from-${writer ?? 'unknown'}`)
  copyFileSync(path, copy)
  pruneSideFiles(path, 'version-change')
  return copy
}

/** The version a copy made by `copyOnVersionChange` was written by, from its name; null for `unknown` or another name. */
export function versionOfCopy(copy: string): string | null {
  return writerVersionOf(/\.version-change-[0-9T-]+-from-(\d+(?:\.\d+){0,3})(?:-\d+)?$/.exec(copy)?.[1])
}

/**
 * The copies of the state made when a version of the application older than the one that wrote it was started (`copyOnVersionChange`), the most
 * recent first: the files written by a later version than `running`. What such a copy names (a background, a container) may be unknown to this
 * version, so nothing the current state does not name is deleted while one is kept (see `mayDeleteBackgroundMedia`).
 */
export function copiesFromNewerVersion(path: string, running: string): string[] {
  return sideFiles(path, 'version-change').filter((copy) => {
    const writer = versionOfCopy(copy)
    return writer !== null && compareVersions(writer, running) > 0
  })
}

/**
 * The copy to offer back at the first launch of `running` over a state `writer` wrote, when `running` is the newer: the most recent copy of a state
 * written by a version above `writer` and not above `running`. That is the state of someone who used a newer version, went back to an older one
 * and now returns: the older version may not have kept everything. Null when there is none (the usual update).
 */
export function copyToResume(path: string, writer: string | null, running: string): string | null {
  // A file that does not say who wrote it gives nothing to compare with. When `running` is not above `writer`, no version lies between the two.
  if (writer === null) return null
  return (
    sideFiles(path, 'version-change').find((copy) => {
      const from = versionOfCopy(copy)
      return from !== null && compareVersions(from, writer) > 0 && compareVersions(from, running) <= 0
    }) ?? null
  )
}

/**
 * Files that could not be read and could not be moved aside either. Writing the fresh state to such a path would replace the file
 * nobody has read yet, so nothing is written there until the move works (see `writeFileAtomic`).
 */
const held = new Map<string, string>()
/** Whether `path` is held: read by the notes store, which then reads nothing rather than a file nobody could move aside. */
export const isHeld = (path: string): boolean => held.has(path)

/**
 * `path` could not be read: it is moved aside (never silently discarded) and the caller starts again from nothing. When even the move
 * fails (permissions, a full disk), nothing is thrown: the file is held, the failure is logged and reported, and the caller starts anyway.
 * `tag` names the caller in the log.
 */
export function setAsideOrHold(path: string, error: unknown, tag: string, kind: 'corrupt' | 'future' = 'corrupt'): void {
  const reason = String(error)
  try {
    const backup = setAside(path, Date.now(), kind)
    console.error(`[${tag}] ${path} is unreadable (${reason}); moved to ${backup}`)
    reportPersistenceNotice({ kind: kind === 'future' ? 'newer-version' : 'set-aside', file: basename(path), backup, reason })
  } catch (moveError) {
    held.set(path, reason)
    console.error(`[${tag}] ${path} is unreadable (${reason}) and could not be moved aside (${String(moveError)}); it is left as it is and nothing will be written over it until it can be moved`)
    reportPersistenceNotice({ kind: 'kept-in-place', file: basename(path), reason, moveError: String(moveError) })
  }
}

/** The unreadable file in the way still cannot be moved: the user was told when it was found, so a failed save has nothing more to say. */
export class HeldFileError extends Error {}

/** Files nothing is written over for the rest of this run, and why (see `refuseWrites`). */
const writeRefused = new Map<string, string>()

/**
 * Nothing is written over `path` until the application is started again: every write throws `HeldFileError`. For a state written by a newer
 * version that could not be copied first: the file is the only place its data exists. The user is told by the caller.
 */
export function refuseWrites(path: string, reason: string): void {
  writeRefused.set(path, reason)
}
/** Whether writes to `path` are refused for this run. */
export const writesRefused = (path: string): boolean => writeRefused.has(path)
/** Lets `path` be written again (the tests, which reuse one process). */
export const allowWrites = (path: string): void => void writeRefused.delete(path)

/**
 * A file that was held (see `setAsideOrHold`) and still cannot be moved aside is not written over: throws `HeldFileError`. Once it can be moved, it is, and the
 * path is free again.
 */
function releaseHeldFile(path: string): void {
  // THE GUARD of "a state of a newer version is never written over without a copy of it".
  const refused = writeRefused.get(path)
  if (refused !== undefined) throw new HeldFileError(`nothing is written over ${basename(path)} in this run (${refused})`)
  if (!held.has(path)) return
  // The unreadable file that is still there: try once more to put it aside before writing in its place.
  if (existsSync(path)) {
    try {
      const backup = setAside(path)
      console.error(`[persist] ${path} was moved aside at last, to ${backup}`)
      reportPersistenceNotice({ kind: 'set-aside', file: basename(path), backup, reason: held.get(path) ?? t('persist.illisible') })
    } catch (error) {
      throw new HeldFileError(`the unreadable ${basename(path)} still cannot be moved aside, so nothing is written over it (${String(error)})`)
    }
  }
  held.delete(path)
}

/**
 * The temporary file of a write that failed (a full disk, a folder without permission, a rename refused) goes: a complete copy of the data must not stay
 * beside the file under another name. Only a regular file is ours: a folder or a link in its place (the reason the write failed) is left as it is.
 * Never throws, so that the caller rethrows the failure itself.
 */
function dropTemporary(tmp: string): void {
  try {
    if (lstatSync(tmp, { throwIfNoEntry: false })?.isFile() !== true) return
    rmSync(tmp, { force: true })
  } catch (error) {
    console.error(`[persist] cannot remove ${tmp} after a failed write:`, error)
  }
}

/**
 * Writes then renames, so that a crash in the middle cannot leave a truncated file. The file is owner-only and on the disk before the rename. Throws when it
 * cannot be written; the temporary file is removed then.
 */
export function writeFileAtomic(path: string, text: string): void {
  releaseHeldFile(path)
  const tmp = `${path}.tmp`
  try {
    writeDurableFile(tmp, text)
    renameSync(tmp, path)
  } catch (error) {
    dropTemporary(tmp)
    throw error
  }
}

/**
 * `writeFileAtomic` that does not hold the process while the disk takes the bytes. It writes `path.tmp-async`, then asks `stillWanted` right before the
 * rename: a synchronous write of newer content (a flush, an erasure) may have been made meanwhile, and this older text must not replace it. Nothing awaits
 * between that question and the rename. Answers whether the file was replaced; rejects when it cannot be written (its temporary file removed).
 */
export async function writeFileAtomicAsync(path: string, text: string, stillWanted: () => boolean): Promise<boolean> {
  releaseHeldFile(path)
  const tmp = `${path}.tmp-async`
  try {
    await writeDurableFileAsync(tmp, text)
    if (!stillWanted()) {
      rmSync(tmp, { force: true })
      return false
    }
    renameSync(tmp, path)
    return true
  } catch (error) {
    dropTemporary(tmp)
    throw error
  }
}

/**
 * The copy that Help › Restore Data makes before it replaces the state. `flush` saves the state in memory first, so the copy is the
 * current one. Answers null when the copy is made (or there is nothing to copy), or the reason it could not be: then nothing may be
 * restored, because the data about to be replaced would exist nowhere else.
 */
export function backUpBeforeRestore(flush: () => boolean, path: string, when = new Date()): string | null {
  if (!flush()) return t('persist.l-etat-actuel-n-a-pas-pu-etre-enregistre-sur-le')
  if (!existsSync(path)) return null
  try {
    copyBeforeRestore(path, when)
    return null
  } catch (error) {
    return String((error as Error).message ?? error)
  }
}
