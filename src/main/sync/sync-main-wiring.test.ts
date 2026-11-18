// What closes the Mac's door is wired where the application starts (docs/synchronisation.md §6.1): a lock, the quit and the Settings window that closes each shut the
// synchronisation window. These are read from the source of the launch, as the other wiring tests do, because the launch itself needs Electron.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(join(__dirname, '..', file), 'utf8')

describe('the synchronisation at the launch (main/index.ts)', () => {
  const index = read('index.ts')

  it('makes the service with the lock as its refusal, and puts it where the IPC channel finds it', () => {
    expect(index).toMatch(/const sync = createSyncService\(\{ userData: app\.getPath\('userData'\), isLocked: \(\) => lock\.isAppLocked\(\) \}\)/)
    expect(index).toContain('setSyncService(sync)')
  })

  it('closes the window when the application locks, and says so in the log if it cannot', () => {
    expect(index).toMatch(/lock\.subscribe\(\(\) => void sync\.lockChanged\(\)\.catch\(/)
  })

  it('closes the door at the quit', () => {
    expect(index).toMatch(/app\.on\('will-quit', \(\) => void sync\.dispose\(\)\.catch\(/)
  })

  it('makes the service after the lock, which it asks, and before any window is shown', () => {
    expect(index.indexOf('setLockService(lock)')).toBeLessThan(index.indexOf('createSyncService('))
  })
})

describe('the Settings window (main/shell/own-windows-wiring.ts)', () => {
  it('closes the synchronisation window with itself, and says so in the log if it cannot', () => {
    expect(read('shell/own-windows-wiring.ts')).toMatch(/onClosed: \(\) => void getSyncService\(\)\?\.leave\(\)\.catch\(/)
  })
})

describe('the IPC channel (main/shell/ipc.ts)', () => {
  it('is registered with the other channels of a window, behind their guard', () => {
    expect(read('shell/ipc.ts')).toContain('registerSyncIpc(ipcMain, guard, browser)')
  })
})
