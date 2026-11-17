// What is left on disk by a download that stopped without finishing. Electron writes the file under its final name from the first byte (there is no `.crdownload`),
// so a download that is interrupted and not resumed leaves a truncated file that looks like the real one. When the user removes such a row from the list, the
// partial file goes with it, but only when it is surely the partial file: a file of the same name that the user put there since is theirs.

import { lstatSync, unlinkSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** The row of the list, as far as the check needs it. */
export interface PartialRow {
  path: string
  receivedBytes: number
  totalBytes: number
  startedAt: number
}

/** The file system calls this module makes: a seam for the tests. */
export interface PartialFs {
  stat(path: string): { isFile: boolean; size: number; mtimeMs: number } | null
  unlink(path: string): void
}

const realFs: PartialFs = {
  stat: (path) => {
    try {
      const stat = lstatSync(path)
      return { isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  unlink: (path) => unlinkSync(path)
}

/** A clock that is a little off, or a file system that rounds times, must not keep a partial file: this much is allowed before the download started. */
const START_SLACK_MS = 2000

export type PartialOutcome = { kind: 'none' } | { kind: 'removed' } | { kind: 'kept' } | { kind: 'failed'; reason: string }

/**
 * Removes the partial file of an interrupted download. It is removed when it is an ordinary file (not a link), of exactly the size received, short of the size
 * announced (when one was), and written since the download began. Anything else is left alone (`kept`). A file that is already gone is nothing to do (`none`);
 * a file that cannot be removed is `failed`, with the reason, for the caller to tell the user.
 */
export function discardPartialFile(row: PartialRow, fs: PartialFs = realFs): PartialOutcome {
  if (!isAbsolute(row.path) || row.receivedBytes <= 0) return { kind: 'none' }
  try {
    const stat = fs.stat(row.path)
    if (stat === null) return { kind: 'none' }
    const whole = row.totalBytes > 0 && stat.size >= row.totalBytes
    if (!stat.isFile || stat.size !== row.receivedBytes || whole || stat.mtimeMs < row.startedAt - START_SLACK_MS) return { kind: 'kept' }
    fs.unlink(row.path)
    return { kind: 'removed' }
  } catch (error) {
    // Gone between the look and the removal (Chromium deletes the file of a download it cancels, at the same moment): nothing was left to do.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
