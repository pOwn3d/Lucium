// The installer main() makes (createUpdateInstaller) drops a withdrawn update with the procedure of squirrel-staging.ts, for the identifier the
// application is built with. The procedure is a stand-in here: the real one would remove the job of the Lucium installed on this machine.
import { afterEach, describe, expect, it, vi } from 'vitest'

const staging = vi.hoisted(() => ({ discard: vi.fn(async (_deps: unknown) => {}), system: vi.fn((bundleId: string) => ({ bundleId })) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Squirrel extends EventEmitter {
    setFeedURL(): void {}
    checkForUpdates(): void {}
    quitAndInstall(): void {}
  }
  return { autoUpdater: new Squirrel(), BrowserWindow: { getFocusedWindow: () => null }, dialog: { showMessageBox: vi.fn() }, shell: { openExternal: vi.fn() } }
})
vi.mock('./squirrel-staging', async (original) => ({ ...(await original<typeof import('./squirrel-staging')>()), discardStagedUpdate: staging.discard, systemStaging: staging.system }))

const { autoUpdater } = await import('electron')
const { createUpdateInstaller } = await import('./app-update')

afterEach(() => vi.restoreAllMocks())

describe('the installer of the running application', () => {
  it('drops a withdrawn update by taking back what Squirrel staged for app.lucium.browser', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const installer = createUpdateInstaller(() => 'https://test.lucium.app/updates/darwin-arm64/feed.json', vi.fn(), () => false, async () => undefined)
    const download = installer.download('0.2.2')
    ;(autoUpdater as unknown as { emit(event: string): void }).emit('update-downloaded')
    await download
    expect(await installer.dropWithdrawn(['0.2.2'])).toEqual({ kind: 'dropped', version: '0.2.2' })
    expect(staging.system).toHaveBeenCalledWith('app.lucium.browser')
    expect(staging.discard).toHaveBeenCalledWith({ bundleId: 'app.lucium.browser' })
  })
})
