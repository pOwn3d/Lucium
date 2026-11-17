// Taking back an update Squirrel staged (squirrel-staging.ts), on stand-ins of launchctl and of the disk: nothing here touches the system (the real
// job of an installed Lucium is named like the one below, and must not be removed by a test).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discardStagedUpdate, LUCIUM_BUNDLE_ID, type StagingDeps } from './squirrel-staging'

// Written with `join`, as the code under test writes it: a text with `/` would not be equal to it on Windows.
const FOLDER = join('/Users/someone/Library/Caches', 'app.lucium.browser.ShipIt')

/** The system as the test sets it: what each step does, and the log of what happened, in order. */
function system(over: { run?: () => Promise<void>; names?: string[] | Error; remove?: (path: string) => Promise<void> } = {}) {
  const steps: string[] = []
  const logs: string[] = []
  const deps: StagingDeps = {
    bundleId: 'app.lucium.browser',
    cachesDir: '/Users/someone/Library/Caches',
    run: async (file, args) => {
      steps.push(`${file} ${args.join(' ')}`)
      await over.run?.()
    },
    list: async (dir) => {
      steps.push(`list ${dir}`)
      const names = over.names ?? ['ShipItState.plist', 'update.Kp4sLeM', 'ShipIt_stdout.log', 'ShipIt_stderr.log']
      if (names instanceof Error) throw names
      return names
    },
    remove: async (path) => {
      steps.push(`remove ${path}`)
      await over.remove?.(path)
    },
    log: (line) => void logs.push(line)
  }
  return { deps, steps, logs }
}

describe('discardStagedUpdate', () => {
  it('removes the job of ShipIt first, then the request and the unpacked application; the logs stay', async () => {
    const { deps, steps, logs } = system()
    await discardStagedUpdate(deps)
    expect(steps).toEqual(['/bin/launchctl remove app.lucium.browser.ShipIt', `list ${FOLDER}`, `remove ${join(FOLDER, 'ShipItState.plist')}`, `remove ${join(FOLDER, 'update.Kp4sLeM')}`])
    expect(logs).toEqual([])
  })

  it('removes the files even when the job cannot be removed, and says so in the log', async () => {
    const { deps, steps, logs } = system({ run: () => Promise.reject(new Error('Could not find specified service')) })
    await discardStagedUpdate(deps)
    expect(steps).toContain(`remove ${join(FOLDER, 'update.Kp4sLeM')}`)
    expect(logs).toEqual([expect.stringContaining('app.lucium.browser.ShipIt could not be removed (Could not find specified service)')])
  })

  it('has nothing to remove when Squirrel left no folder, and says so in the log', async () => {
    const { deps, steps, logs } = system({ names: Object.assign(new Error('no such folder'), { code: 'ENOENT' }) })
    await discardStagedUpdate(deps)
    expect(steps.filter((step) => step.startsWith('remove'))).toEqual([])
    expect(logs).toEqual([expect.stringContaining(`${FOLDER} does not exist`)])
  })

  it('fails, naming what stays, when the folder cannot be read or a file cannot be removed', async () => {
    await expect(discardStagedUpdate(system({ names: Object.assign(new Error('not permitted'), { code: 'EPERM' }) }).deps)).rejects.toThrow(`cannot read ${FOLDER}: not permitted`)
    const refused = system({ remove: (path) => (path.endsWith('update.Kp4sLeM') ? Promise.reject(new Error('busy')) : Promise.resolve()) })
    await expect(discardStagedUpdate(refused.deps)).rejects.toThrow(`cannot remove ${join(FOLDER, 'update.Kp4sLeM')}: busy`)
  })

  it('names the job and the folder after the identifier the application is built with', () => {
    const appId = /^appId:\s*(\S+)\s*$/m.exec(readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8'))?.[1]
    expect(LUCIUM_BUNDLE_ID).toBe(appId)
  })
})
