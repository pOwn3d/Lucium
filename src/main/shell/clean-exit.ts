// The sign of a clean exit. A file is made in the data folder when Lucium starts and removed when it quits the way it is meant to (the last `will-quit`, or the forced exit
// that saves first, shell/quit-flow.ts): a file still there at the next start means the last run ended by a crash, a kill, a power cut or a logout that did not wait.
// The model is the file-sign of single-stream.ts: one look at a file, no content to trust. Nothing leaves the machine and nothing is read from the file but its presence.
// A launch that cannot write the sign says so, and the next one then sees none (an offer to restore that is not needed is worse than one that is missed).

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The file that is there while Lucium runs. */
export const RUNNING_MARKER = 'running.marker'

/** What the marker needs of the disk; a test gives its own. */
export interface MarkerIo {
  exists(path: string): boolean
  write(path: string, text: string): void
  remove(path: string): void
  warn(line: string, error?: unknown): void
}

export const diskMarkerIo: MarkerIo = {
  exists: existsSync,
  write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  remove: unlinkSync,
  warn: (line, error) => (error === undefined ? console.warn(line) : console.warn(line, error))
}

/**
 * The start of a run: whether the last one ended abnormally (the marker was still there), and the marker made for this one. A marker that cannot be looked
 * for counts as a clean exit (no offer), and one that cannot be made is told: the next launch will not know.
 */
export function noteLaunch(folder: string, io: MarkerIo = diskMarkerIo, now: () => number = Date.now): { abnormal: boolean } {
  const path = join(folder, RUNNING_MARKER)
  let abnormal = false
  try {
    abnormal = io.exists(path)
  } catch (error) {
    io.warn(`[exit] cannot look for ${RUNNING_MARKER}: a crash at the last run will not be offered a restore:`, error)
  }
  try {
    io.write(path, String(now()))
  } catch (error) {
    io.warn(`[exit] cannot write ${RUNNING_MARKER}: a crash during this run will not be offered a restore at the next launch:`, error)
  }
  return { abnormal }
}

/** The end of a run, the way it is meant to end: the marker goes. A marker that stays says why, as the next launch will offer a restore it did not need. */
export function noteCleanExit(folder: string, io: MarkerIo = diskMarkerIo): void {
  const path = join(folder, RUNNING_MARKER)
  try {
    if (io.exists(path)) io.remove(path)
  } catch (error) {
    io.warn(`[exit] cannot remove ${RUNNING_MARKER}: the next launch will offer a restore it does not need:`, error)
  }
}
