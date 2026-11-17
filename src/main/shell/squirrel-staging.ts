// What Squirrel.Mac keeps of a downloaded update until Lucium quits, and how Lucium takes it back. Once Electron's autoUpdater says
// `update-downloaded`, Squirrel has unpacked the application into its folder, `~/Library/Caches/<bundle id>.ShipIt` (an `update.XXXXXX` folder,
// and the request `ShipItState.plist`), and submitted a launchd job, `<bundle id>.ShipIt`, that runs ShipIt: it waits for Lucium to end, then
// swaps the bundle (the names are the strings of Squirrel.framework and ShipIt in the engine Lucium ships). Electron has no call that takes a
// downloaded update back. What is left is what Squirrel itself does before it stages a newer update: remove the job; and the files go, so that
// a ShipIt still waiting (the job of a copy installed where only an administrator writes runs as root, out of reach) finds nothing to install.
//
// Not proven against a real update here: that needs a signed build, a feed and two versions (the maintainer's to try). The unit test proves the
// order and that a failure is told, on stand-ins.

import { execFile } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the drop asks of the system; the real ones are below, a test gives stand-ins. */
export interface StagingDeps {
  /** The identifier of the application (electron-builder.yml, `appId`), which Squirrel names its job and its folder after. */
  bundleId: string
  /** `~/Library/Caches`. */
  cachesDir: string
  /** Runs a program and resolves once it ended well; rejects with its words otherwise. */
  run(file: string, args: readonly string[]): Promise<void>
  /** The names in a folder; rejects with `code: 'ENOENT'` when it does not exist. */
  list(dir: string): Promise<string[]>
  /** Removes a file or a folder and what it holds. */
  remove(path: string): Promise<void>
  log(line: string): void
}

/** The parts of Squirrel's folder that make an install: the request ShipIt reads, and the unpacked application. Its logs stay. */
const STAGED = (name: string): boolean => name === 'ShipItState.plist' || name.startsWith('update.')

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Takes back the update Squirrel staged: its launchd job, then its files. Resolves once nothing is left to install; rejects, with what could not be
 * removed, when a part of it stays (the update may then still be installed at the quit).
 */
export async function discardStagedUpdate(deps: StagingDeps): Promise<void> {
  const label = `${deps.bundleId}.ShipIt`
  // The job first: a ShipIt that loses its files while it waits fails and is started again by launchd, once its job is gone it is not.
  try {
    await deps.run('/bin/launchctl', ['remove', label])
  } catch (error) {
    // No such job in this session (ShipIt already ended, or it runs as root): the files below are what keeps it from installing.
    deps.log(`[update] the launchd job ${label} could not be removed (${words(error)}); its files are removed all the same`)
  }
  const folder = join(deps.cachesDir, label)
  let names: string[]
  try {
    names = await deps.list(folder)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      deps.log(`[update] ${folder} does not exist: Squirrel left nothing there to remove`)
      return
    }
    throw new Error(`cannot read ${folder}: ${words(error)}`)
  }
  for (const name of names.filter(STAGED)) {
    try {
      await deps.remove(join(folder, name))
    } catch (error) {
      throw new Error(`cannot remove ${join(folder, name)}: ${words(error)}`)
    }
  }
}

/** The real system: launchctl, the caches folder of the user. */
export function systemStaging(bundleId: string): StagingDeps {
  return {
    bundleId,
    cachesDir: join(homedir(), 'Library', 'Caches'),
    run: (file, args) =>
      new Promise((resolve, reject) =>
        execFile(file, [...args], { timeout: 10_000 }, (error, _stdout, stderr) => (error ? reject(new Error(`${error.message.trim()} ${String(stderr).trim()}`.trim())) : resolve()))
      ),
    list: (dir) => readdir(dir),
    remove: (path) => rm(path, { recursive: true, force: true }),
    log: (line) => console.warn(line)
  }
}

/** The identifier of the application built from this repository (electron-builder.yml, `appId`); squirrel-staging.test.ts keeps the two equal. */
export const LUCIUM_BUNDLE_ID = 'app.lucium.browser'
