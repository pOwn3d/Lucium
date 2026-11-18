// The service made from the real pieces (docs/synchronisation.md §3.3), with Electron put aside: what is read from the system, and what a fresh service is.
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from '../temp-dir'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (plain: string) => Buffer.from(plain), decryptString: (sealed: Buffer) => sealed.toString() } }))

describe('deviceNameOf: the name the iPhone shows', () => {
  it('drops the .local of a host name, and keeps the rest as it is', async () => {
    const { deviceNameOf } = await import('./sync-wiring')
    expect(deviceNameOf('MacBook-Pro-de-Camille.local')).toBe('MacBook-Pro-de-Camille')
    expect(deviceNameOf('mac.LOCAL')).toBe('mac')
    expect(deviceNameOf('studio.example.com')).toBe('studio.example.com')
  })

  it('gives `Mac` for an empty name, and cuts at 80 characters (what the protocol allows), by characters and not by bytes', async () => {
    const { deviceNameOf } = await import('./sync-wiring')
    expect(deviceNameOf('')).toBe('Mac')
    expect(deviceNameOf('.local')).toBe('Mac')
    expect([...deviceNameOf('é'.repeat(200))]).toHaveLength(80)
    expect(deviceNameOf('😀'.repeat(100)).length).toBe(160)
  })
})

describe('createSyncService', () => {
  it('makes a service that is OFF and writes nothing: no file, no port, until the person turns it on', async () => {
    const { createSyncService, SYNC_FILES } = await import('./sync-wiring')
    const { existsSync } = await import('node:fs')
    const dir = tempDir('lucium-sync-wiring-')
    const service = createSyncService({ userData: dir, isLocked: () => false })
    expect(service.status()).toMatchObject({ available: true, enabled: false, devices: [], window: { open: false } })
    expect(existsSync(join(dir, SYNC_FILES.config))).toBe(false)
    expect(existsSync(join(dir, SYNC_FILES.identity))).toBe(false)
  })

  it('keeps its two files next to the state, under the names the specification gives', async () => {
    const { SYNC_FILES } = await import('./sync-wiring')
    expect(SYNC_FILES).toEqual({ config: 'sync.json', identity: 'sync-identity.json', marks: 'sync-marks.json' })
  })

  it('makes the identity, sealed, in the data folder, when the person turns it on', async () => {
    const { createSyncService, SYNC_FILES } = await import('./sync-wiring')
    const { existsSync, readFileSync } = await import('node:fs')
    const dir = tempDir('lucium-sync-wiring-')
    const service = createSyncService({ userData: dir, isLocked: () => false })
    await service.setEnabled(true)
    expect(existsSync(join(dir, SYNC_FILES.identity))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, SYNC_FILES.config), 'utf8'))).toMatchObject({ enabled: true })
    expect(service.status().window.open).toBe(false)
  })
})
