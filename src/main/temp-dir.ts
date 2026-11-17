// A scratch folder for a test: made under the system's temporary folder, removed after the test that made it (a test that forgot to
// clean up left thousands of `lucium-*` folders behind it). Importing this file registers the clean-up for the importing test file.

import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const made = new Set<string>()

/** Gives write access back to a tree a test locked on purpose (chmod 0o500), so that it can be removed. */
function unlock(path: string): void {
  if (!lstatSync(path).isDirectory()) return
  chmodSync(path, 0o700)
  for (const name of readdirSync(path)) unlock(join(path, name))
}

type Remove = (dir: string) => void
const removeTree: Remove = (dir) => rmSync(dir, { recursive: true, force: true })

/** Removes every folder made since the last call. Answers the ones that stay (none, unless the system refuses); each is logged. */
export function removeTempDirs(remove: Remove = removeTree): string[] {
  const left: string[] = []
  for (const dir of made) {
    try {
      remove(dir)
    } catch {
      try {
        unlock(dir)
        remove(dir)
      } catch (error) {
        left.push(dir)
        console.warn(`[temp-dir] cannot remove ${dir}:`, error)
      }
    }
  }
  made.clear()
  // A folder that stays is tried again by the next clean-up.
  for (const dir of left) made.add(dir)
  return left
}

/** A new empty folder named `<prefix><random>`, removed after the current test. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}

afterEach(() => {
  removeTempDirs()
})
