// An extension made of pages only has no service worker: nothing is started for it and nothing is waited for (electron-engine-bridge.ts: `deliverToWorker`,
// `wakeExtension`; electron-engine-extensions.ts: `holdWorker`). Electron refuses to start a worker that does not exist, the callers read that refusal as
// a start under way, and an extension without a worker made every one of them wait 10 s and write a failure line. The manifest says it, so it is read.
// Run on stand-ins of the engine and of the session; the same in a real Electron: the Highlighter of the site captures has no worker.

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => `/tmp/lucium-test-${name}` },
    session: { defaultSession: {} }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { SHIM_EVENT_CHANNEL } = await import('./electron-engine-base')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => Promise<void> | (() => void)>

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const SCOPE = `chrome-extension://${EXT}/`

/** An engine with one profile whose session refuses to start a worker the way Electron does for an extension that has none. */
function engineWith(manifest: Record<string, unknown> | undefined, running: Record<number, { scope: string }> = {}) {
  const startWorkerForScope = vi.fn(async () => {
    throw new Error('Failed to start service worker.')
  })
  const session = { serviceWorkers: { startWorkerForScope, getAllRunning: () => running }, extensions: { getExtension: (id: string) => (id === EXT ? {} : null) } }
  const worker = { scope: SCOPE, isDestroyed: () => false, send: vi.fn(), startTask: () => ({ end: () => undefined }) }
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    profiles: new Map([['default', { session }]]),
    manifests: new Map(manifest === undefined ? [] : [[`default:${EXT}`, manifest]]),
    extensionWorkers: new Set([worker]),
    workerProfile: new Map([[worker, 'default']]),
    heldWorkers: 0
  })
  return { engine, startWorkerForScope, worker }
}

/** Runs `call` with the clock faked: what waits 10 s is still waiting when the clock has gone 11 s, and the test fails on what it did meanwhile. */
async function settled(call: () => Promise<void>): Promise<{ done: boolean; error?: unknown }> {
  vi.useFakeTimers()
  try {
    const outcome: { done: boolean; error?: unknown } = { done: false }
    const promise = call().then(
      () => void (outcome.done = true),
      (error: unknown) => void Object.assign(outcome, { done: true, error })
    )
    await vi.advanceTimersByTimeAsync(11_000)
    await promise
    return outcome
  } finally {
    vi.useRealTimers()
  }
}

const NO_WORKER = { manifest_version: 3, name: 'Highlighter', version: '1.0', action: { default_popup: 'popup.html' } }
const WITH_WORKER = { ...NO_WORKER, background: { service_worker: 'background.js' } }

describe('an extension without a service worker', () => {
  it('is not waited for when an event is delivered to its worker: no start, no wait, no failure', async () => {
    const { engine, startWorkerForScope, worker } = engineWith(NO_WORKER)
    const outcome = await settled(() => methods['deliverToWorker']!.call(engine, EXT, 'default', 'runtime', 'onInstalled', [{ reason: 'install' }]) as Promise<void>)
    expect(outcome).toEqual({ done: true })
    expect(startWorkerForScope).not.toHaveBeenCalled()
    expect(worker.send).not.toHaveBeenCalled()
  })

  it('is not woken for a click on its icon', async () => {
    const { engine, startWorkerForScope } = engineWith(NO_WORKER)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await settled(() => methods['wakeExtension']!.call(engine, EXT) as Promise<void>)).toEqual({ done: true })
      expect(startWorkerForScope).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('has no worker held for a port: nothing is started, no line of failure', () => {
    const { engine, startWorkerForScope } = engineWith({ ...NO_WORKER, background: {} })
    // No worker of this extension is running: a held worker would be started.
    Object.assign(engine, { extensionWorkers: new Set() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const release = methods['holdWorker']!.call(engine, EXT, 'default') as () => void
      expect(startWorkerForScope).not.toHaveBeenCalled()
      expect(engine['heldWorkers']).toBe(1)
      release()
      expect(engine['heldWorkers']).toBe(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('an extension with a service worker, or one whose manifest is not known', () => {
  it('is delivered to as before: the event reaches the worker that runs', async () => {
    const { engine, startWorkerForScope, worker } = engineWith(WITH_WORKER, { 1: { scope: SCOPE } })
    expect(await settled(() => methods['deliverToWorker']!.call(engine, EXT, 'default', 'runtime', 'onStartup', []) as Promise<void>)).toEqual({ done: true })
    expect(startWorkerForScope).not.toHaveBeenCalled()
    expect(worker.send).toHaveBeenCalledWith(SHIM_EVENT_CHANNEL, 'runtime', 'onStartup', [])
  })

  it('has its idle worker started for the event, and a worker that never starts still fails after the wait', async () => {
    const { engine, startWorkerForScope } = engineWith(WITH_WORKER)
    const outcome = await settled(() => methods['deliverToWorker']!.call(engine, EXT, 'default', 'runtime', 'onStartup', []) as Promise<void>)
    expect(startWorkerForScope).toHaveBeenCalledWith(SCOPE)
    expect((outcome.error as Error).message).toBe(`The worker of ${EXT} did not start`)
  })

  it('is started and waited for when the manifest is not known yet: nothing is assumed about it', async () => {
    const { engine, startWorkerForScope } = engineWith(undefined)
    const outcome = await settled(() => methods['deliverToWorker']!.call(engine, EXT, 'default', 'runtime', 'onStartup', []) as Promise<void>)
    expect(startWorkerForScope).toHaveBeenCalledWith(SCOPE)
    expect((outcome.error as Error).message).toBe(`The worker of ${EXT} did not start`)
  })

  it('is woken for a click on its icon', async () => {
    const { engine, startWorkerForScope } = engineWith(WITH_WORKER)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await settled(() => methods['wakeExtension']!.call(engine, EXT) as Promise<void>)
      expect(startWorkerForScope).toHaveBeenCalledWith(SCOPE)
    } finally {
      warn.mockRestore()
    }
  })
})
