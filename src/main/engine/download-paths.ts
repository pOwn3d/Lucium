// Where a download is saved. The name is free on disk, and also not promised to another download that has not written its file yet:
// two downloads of the same name that run together would otherwise pick the same path and write over each other.

import { basename, dirname, extname, join } from 'node:path'

/** The key a path is kept under: macOS volumes are case-insensitive by default, so `Report.pdf` and `report.pdf` are one file. */
const keyOf = (path: string): string => path.toLowerCase()

/** The paths promised to downloads in progress, released when they end. */
export class ReservedPaths {
  private readonly held = new Set<string>()

  has(path: string): boolean {
    return this.held.has(keyOf(path))
  }

  reserve(path: string): void {
    this.held.add(keyOf(path))
  }

  release(path: string): void {
    this.held.delete(keyOf(path))
  }

  get size(): number {
    return this.held.size
  }
}

/** `report.pdf` → `report (1).pdf` (then `(2)`…) when the name is on disk or already promised to a download in progress. */
export function uniquePath(dir: string, filename: string, reserved: Pick<ReservedPaths, 'has'>, exists: (path: string) => boolean): string {
  // A tarball keeps its two extensions together: `backup.tar.gz` becomes `backup (1).tar.gz`, not `backup.tar (1).gz` (which no tool would unpack).
  const name = basename(filename)
  const last = extname(name)
  const ext = last !== '' && /.\.tar$/i.test(name.slice(0, name.length - last.length)) ? name.slice(name.length - last.length - 4) : last
  const stem = name.slice(0, name.length - ext.length)
  // An extension may ask for a folder inside the downloads folder ("sub/file.bin"): the number goes in the name, not in the folder.
  const folder = join(dir, dirname(filename))
  const taken = (path: string): boolean => reserved.has(path) || exists(path)
  let candidate = join(dir, filename)
  for (let n = 1; taken(candidate); n++) candidate = join(folder, `${stem} (${n})${ext}`)
  return candidate
}
