// The one way the application writes the file it is about to rename into place (state, history, vault, windows, download records…): owner-only,
// complete, and on the disk before the rename. Only node:fs here, so that the rules can be tested against real files.

import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

/** The error `open(2)` gives for a link met with `O_NOFOLLOW`, made by hand where that flag does not exist (Windows). */
const linkInTheWay = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ELOOP: a link stands where the file is written, open '${path}'`), { code: 'ELOOP', syscall: 'open', path })

const isNothingThere = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | null)?.code ?? '')

/**
 * Refuses (ELOOP, as `open` does with `O_NOFOLLOW`) a link under the name that is about to be opened: a link left there, in the user's profile,
 * would send the write to whatever it points at. `O_NOFOLLOW` does not exist on Windows (`constants.O_NOFOLLOW` is undefined and adds no flag), so
 * this look is the guard there; it runs on every system, where it only repeats what the flag does. It leaves a short window between the look and the
 * open, which on macOS and Linux the flag closes; the data folder is the user's own, so only their account can put a link there. Nothing there (or a
 * file) is no reason to refuse: the open reports what it finds.
 */
export function refuseLinkSync(path: string): void {
  let found: Stats | undefined
  try {
    found = lstatSync(path)
  } catch (error) {
    // Nothing at the name, or a file where a folder should be: no link to refuse, and the open that follows reports the same error itself.
    if (!isNothingThere(error)) throw error
  }
  if (found?.isSymbolicLink() === true) throw linkInTheWay(path)
}

/** `refuseLinkSync` without holding the process. */
export async function refuseLink(path: string): Promise<void> {
  const found = await lstat(path).catch((error: unknown) => {
    if (isNothingThere(error)) return null
    throw error
  })
  if (found?.isSymbolicLink() === true) throw linkInTheWay(path)
}

/**
 * Writes every byte of `data` to `fd`. `fs.writeSync` may stop short (a full disk, a quota, a signal) and says so only by what it returns: the
 * loop goes on from where it stopped, and gives up with an error when the file system takes nothing more.
 */
export function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0
  while (offset < data.length) {
    const count = writeSync(fd, data, offset, data.length - offset)
    if (count <= 0) throw Object.assign(new Error(`short write: ${offset} of ${data.length} bytes written`), { code: 'EIO' })
    offset += count
  }
}

/**
 * Writes `data` to a file at `path`, owner-only (0600) whatever the umask and whatever an earlier crash left under that name, a link refused,
 * flushed to the disk, and checked to be as long as what was written: it throws instead of leaving a file that stops short. The caller moves it in place.
 */
export function writeDurableFile(path: string, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  refuseLinkSync(path)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try {
    // A file that already existed keeps its own mode when opened: it is set again, not trusted.
    fchmodSync(fd, 0o600)
    writeAllSync(fd, bytes)
    fsyncSync(fd)
    const size = fstatSync(fd).size
    if (size !== bytes.length) throw Object.assign(new Error(`short write: ${size} bytes on the disk, ${bytes.length} written`), { code: 'EIO' })
  } finally {
    closeSync(fd)
  }
}

/**
 * Puts `data` in place of the file at `path`: written whole beside it (`<path>.tmp`, see `writeDurableFile`), then moved over it, so that a crash
 * in the middle leaves the file as it was. Throws when it cannot; the temporary file is removed then, so that no copy of the data stays beside
 * the file under another name. Only a regular file is ours to remove: a folder or a link in its place (the reason the write failed) is left.
 */
export function replaceFileDurably(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.tmp`
  try {
    writeDurableFile(temporary, data)
    renameSync(temporary, path)
  } catch (error) {
    try {
      if (lstatSync(temporary, { throwIfNoEntry: false })?.isFile() === true) rmSync(temporary, { force: true })
    } catch (cleanup) {
      console.error(`[persist] cannot remove ${temporary} after a failed write:`, cleanup)
    }
    throw error
  }
}

/**
 * `writeDurableFile` without holding the process: the same file (owner-only, link refused, complete, on the disk, checked to be as long as what
 * was written), written while the rest of the application goes on. Rejects instead of leaving a file that stops short. The caller moves it in place.
 */
export async function writeDurableFileAsync(path: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  await refuseLink(path)
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try {
    await file.chmod(0o600)
    await file.writeFile(bytes)
    await file.sync()
    const { size } = await file.stat()
    if (size !== bytes.length) throw Object.assign(new Error(`short write: ${size} bytes on the disk, ${bytes.length} written`), { code: 'EIO' })
  } finally {
    await file.close()
  }
}
