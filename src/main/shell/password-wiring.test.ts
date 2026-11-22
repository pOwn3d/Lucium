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
  translateStopped: vi.fn(),
  /** What the service was given, and what the clipboard of Electron was asked to write. */
  deps: undefined as undefined | { clipboard?: { writeSecret?: (text: string) => Promise<void> }; updateSettings?: (patch: unknown) => void },
  dispatched: [] as unknown[],
  written: [] as unknown[]
}))

vi.mock('electron', async () => {
  const base = (await import('./ipc-fake.test-support')).fakeElectron()
  const app = { getPath: () => '/nowhere', on: (event: string, listener: () => void) => void (event === 'will-quit' && held.quits.push(listener)) }
  class ClipboardItem {
    constructor(readonly entries: Record<string, string>) {}
  }
  const clipboard = { readText: async () => '', writeText: async () => undefined, clear: () => undefined, write: async (items: unknown[]) => void held.written.push(...items) }
  return new Proxy(base, { has: () => true, get: (target, name: string) => (name === 'app' ? app : name === 'ClipboardItem' ? ClipboardItem : name === 'clipboard' ? clipboard : (target[name] as unknown)) })
})
vi.mock('./password-service', async (original) => ({
  ...(await original<typeof import('./password-service')>()),
  PasswordService: class {
    constructor(deps: NonNullable<typeof held.deps>) {
      held.deps = deps
    }
    stop(): void {}
    lock(): void {}
  }
}))
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
    sharedStore: { get: () => ({ settings: {} }), dispatch: (action: unknown) => void held.dispatched.push(action) },
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

describe('the clipboard of the password vault, as main() gives it to the service', () => {
  it('writes a password as one item that carries the text and the concealed marker, never through writeText', async () => {
    held.written.length = 0
    installed()
    await held.deps!.clipboard!.writeSecret!('the-text')
    expect(held.written).toHaveLength(1)
    expect((held.written[0] as { entries: Record<string, string> }).entries).toMatchObject({ 'text/plain': 'the-text', 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"': expect.any(String) })
  })
})

describe('the settings the password service may write, as main() gives them', () => {
  it('goes through the store as a settings update, which is how the list of sites that never offer to save is kept', () => {
    held.dispatched.length = 0
    installed()
    held.deps!.updateSettings!({ passwordNeverSaveHosts: ['example.com'] })
    expect(held.dispatched).toEqual([{ type: 'settings/update', patch: { passwordNeverSaveHosts: ['example.com'] } }])
  })
})
