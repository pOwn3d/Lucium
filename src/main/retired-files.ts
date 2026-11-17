// Files an earlier build kept in the data folder and that this one has no use for. They are removed at launch, so that nothing of a function
// that no longer exists stays on the disk.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `ai-keys.json`: the API keys of the online providers the page summary once could use, encrypted by the system. The summary is now made by
 * a model on this Mac only; no code reads those keys any more.
 */
export const RETIRED_FILES: readonly string[] = ['ai-keys.json']

/**
 * Removes the retired files of the data folder. A file that is not there is the usual case and is no error. One that cannot be removed is
 * said in the log with its name, and the launch goes on: the file is only a leftover.
 */
export function removeRetiredFiles(userDataPath: string, remove: (path: string) => void = (path) => rmSync(path, { force: true })): void {
  for (const name of RETIRED_FILES) {
    try {
      remove(join(userDataPath, name))
    } catch (error) {
      console.warn(`[retired-files] ${name} could not be removed from the data folder:`, error)
    }
  }
}
