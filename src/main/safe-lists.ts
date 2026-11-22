// The two lists of safe browsing on this machine (shared/safe-browsing.ts): packed files of the application's resources folder, read the first time a
// page is checked while the feature is on, and let go of when it is switched off. They come with the application and change with its versions; this
// file opens no connection. The hosts the user let through with « Continuer quand même » are kept here, in memory, for this run only.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { SafeSet } from '@shared/safe-set'
import type { SafeLists } from '@shared/safe-browsing'
import { isBuiltApp } from './runtime'

/** Where the files are: next to the other resources of a packaged application, in the repository while developing. */
export function safeListsFolder(): string {
  return join(isBuiltApp() ? process.resourcesPath : app.getAppPath(), isBuiltApp() ? 'safe-browsing' : 'resources/safe-browsing')
}

/** One packed list, or null with the reason told on the console: a missing or damaged file warns nobody about a site, and says so once. */
function readList(path: string): SafeSet | null {
  try {
    const set = SafeSet.read(new Uint8Array(readFileSync(path)))
    if (set === null) console.warn(`[safe-browsing] ${path} is not a list of this version, ignored`)
    return set
  } catch (error) {
    console.warn(`[safe-browsing] cannot read ${path}, ignored:`, (error as Error).message)
    return null
  }
}

let loaded: SafeLists | null = null
const allowed = new Set<string>()

/** The lists, read on the first call. `folder` is where a test puts its own. */
export function safeLists(folder: string = safeListsFolder()): SafeLists {
  loaded ??= { phishing: readList(join(folder, 'phishing.bin')), malware: readList(join(folder, 'malware.bin')) }
  return loaded
}

/** Whether the lists are in memory now (what the cost of the feature is made of). */
export const safeListsLoaded = (): boolean => loaded !== null

/** The feature went off: the lists are let go of, and so is what the user let through. */
export function releaseSafeLists(): void {
  loaded = null
  allowed.clear()
}

/** The hosts let through for this run. */
export const safeAllowedHosts = (): ReadonlySet<string> => allowed

export function allowSafeHost(host: string): void {
  allowed.add(host)
}
