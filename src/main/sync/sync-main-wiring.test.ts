// What closes the Mac's door is wired where the application starts (docs/synchronisation.md §6.1): a lock and an unlock set the door, the quit shuts it, the launch opens it when an iPhone is paired, and the Settings window
// that closes takes the sheet of a pairing with it. These are read from the source of the launch, as the other wiring tests do, because the launch itself needs Electron.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(join(__dirname, '..', file), 'utf8')

describe('the synchronisation at the launch (main/index.ts)', () => {
  const index = read('index.ts')

  it('makes the service with the lock as its refusal, and puts it where the IPC channel finds it', () => {
    expect(index).toMatch(/const sync = createSyncService\(\{\s+userData: app\.getPath\('userData'\),\s+isLocked: \(\) => lock\.isAppLocked\(\)/)
    expect(index).toContain('setSyncService(sync)')
  })

  it('gives the exchange of the data the shared state, written through the browser, and the lock of the spaces', () => {
    expect(index).toContain("apply: (patch) => browser.dispatch({ type: 'sync/apply', patch })")
    expect(index).toContain('isSpaceLocked: (spaceId) => lock.isSpaceLocked(spaceId)')
    expect(index).toContain('state: () => sharedStore.get()')
  })

  it('has the marks follow the state again at the launch when the switch is on', () => {
    expect(index).toMatch(/setSyncService\(sync\)\s+sync\.start\(\)/)
  })

  it('sets the door when the application locks or unlocks, and says so in the log if it cannot', () => {
    expect(index).toMatch(/lock\.subscribe\(\(\) => void sync\.lockChanged\(\)\.catch\(/)
  })

  it('closes the door at the quit', () => {
    expect(index).toMatch(/app\.on\('will-quit', \(\) => void sync\.dispose\(\)\.catch\(/)
  })

  it('starts the service at the launch, so that a Mac with an iPhone paired listens without anyone opening a page', () => {
    expect(index).toMatch(/setSyncService\(sync\)\s+sync\.start\(\)/)
  })

  it('makes the service after the lock, which it asks, and before any window is shown', () => {
    expect(index.indexOf('setLockService(lock)')).toBeLessThan(index.indexOf('createSyncService('))
  })
})

describe('the Settings window (main/shell/own-windows-wiring.ts)', () => {
  it('tells the service the page is gone when it closes with itself (the sheet of a pairing goes), and says so in the log if it cannot', () => {
    expect(read('shell/own-windows-wiring.ts')).toMatch(/onClosed: \(\) => void getSyncService\(\)\?\.leave\(\)\.catch\(/)
  })
})

describe('the IPC channel (main/shell/ipc.ts)', () => {
  it('is registered with the other channels of a window, behind their guard', () => {
    expect(read('shell/ipc.ts')).toContain('registerSyncIpc(ipcMain, guard, browser, store)')
  })
})
