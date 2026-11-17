// The password vault main() installs (shell/password-wiring.ts), run over a stand-in of Electron and of the keychain module: the keychain is asked for only by the
// built application, outside the engine test, on a Mac that has Touch ID, and the requests it still waits for are cancelled when the application quits.
// The keychain itself is vault-keychain.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => ({
  runner: undefined as undefined | (() => unknown),
  quits: [] as Array<() => void>,
  built: true,
  transportOf: vi.fn((_resources: string): unknown => ({ the: 'transport' })),
  stopped: vi.fn(),
  translateStopped: vi.fn()
}))

vi.mock('electron', async () => {
  const base = (await import('./ipc-fake.test-support')).fakeElectron()
  const app = { getPath: () => '/nowhere', on: (event: string, listener: () => void) => void (event === 'will-quit' && held.quits.push(listener)) }
  return new Proxy(base, { has: () => true, get: (target, name: string) => (name === 'app' ? app : (target[name] as unknown)) })
})
vi.mock('../runtime', () => ({ isBuiltApp: () => held.built }))
vi.mock('../translate/system', () => ({ stopSystemTranslateHelpers: () => held.translateStopped() }))
vi.mock('../vault-keychain', async (original) => ({
  ...(await original<typeof import('../vault-keychain')>()),
  VaultKeychain: class {
    constructor(options: { runner: () => unknown }) {
      held.runner = options.runner
    }
  },
  helperRunner: (transport: unknown) => ({ runs: transport }),
  keychainTransport: (resources: string) => held.transportOf(resources),
  stopKeychainHelpers: () => held.stopped()
}))
const { installPasswordVault } = await import('./password-wiring')

/** The vault installed as main() installs it: `smoke` is the engine test, `touchId` what the Mac offers. */
function installed(options: { smoke?: boolean; touchId?: boolean } = {}) {
  held.runner = undefined
  held.quits.length = 0
  installPasswordVault({
    sharedStore: { get: () => ({ settings: {} }) },
    gates: { gate: () => undefined },
    engine: { setPasswordBridge: () => undefined },
    lock: { subscribe: () => () => undefined, isAppLocked: () => false },
    win: {},
    platform: { touchId: () => ({ available: () => false }), facts: { touchId: options.touchId ?? true } },
    smoke: options.smoke ?? false
  } as never)
  return held.runner!
}

beforeEach(() => {
  held.built = true
  held.transportOf.mockClear()
  held.transportOf.mockImplementation(() => ({ the: 'transport' }))
  held.stopped.mockClear()
  held.translateStopped.mockClear()
})

describe('the keychain of the password vault, as main() gives it its runner', () => {
  it('is asked for in the built application only, with Touch ID on the Mac, and never in the engine test', () => {
    expect(installed()()).toEqual({ runs: { the: 'transport' } })
    expect(held.transportOf).toHaveBeenCalledExactlyOnceWith(process.resourcesPath)
    held.transportOf.mockClear()
    // None of these reaches the keychain: not a word of it is looked at before the answer is known.
    expect(installed({ smoke: true })()).toBeNull()
    expect(installed({ touchId: false })()).toBeNull()
    held.built = false
    expect(installed()()).toBeNull()
    expect(held.transportOf).not.toHaveBeenCalled()
  })

  it('has no runner when the application has no service to ask (a build without a team)', () => {
    held.transportOf.mockImplementation(() => null)
    expect(installed()()).toBeNull()
  })

  it('has its requests that are still waiting cancelled when the application quits, with the batch of the translation', () => {
    installed()
    expect(held.stopped).not.toHaveBeenCalled()
    for (const quit of held.quits) quit()
    expect(held.stopped).toHaveBeenCalledTimes(1)
    expect(held.translateStopped).toHaveBeenCalledTimes(1)
  })
})
