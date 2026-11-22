// The form guard goes into the session of every page the engine makes (a private context, a container or a profile made after the setting was switched on),
// and `syncFormGuard` registers nothing while the setting is off. The rest of the wiring: form-guard-wiring.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { engineForPages } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

describe('the form guard of a new session', () => {
  it('is synced with the session of a private context and of a profile when a page is made in it', async () => {
    for (const profile of [undefined, { ready: null }]) {
      const world = await engineForPages(profile)
      world.create('t1')
      expect(world.engine.syncFormGuard).toHaveBeenCalledTimes(1)
    }
  }, 60_000)

  it('registers nothing in a session while the setting has never been on', async () => {
    const { ElectronEngine } = await import('./electron-engine')
    const sync = (ElectronEngine.prototype as unknown as Record<string, (this: unknown, ses: unknown) => void>)['syncFormGuard']!
    const ses = { registerPreloadScript: vi.fn(), unregisterPreloadScript: vi.fn() }
    sync.call({ insecureFormAsk: null, formGuardSessions: new Set() }, ses)
    expect(ses.registerPreloadScript).not.toHaveBeenCalled()
  })
})
