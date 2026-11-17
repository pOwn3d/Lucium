// The start of an extension's worker for the events of electron-chrome-extensions (worker-start.ts): a burst asks for one start, a start refused
// because another is under way is waited for, and a start that never comes writes one line that names the extension. The workers are stand-ins
// for `session.serviceWorkers`; the clock and the wait are the test's, so nothing waits for real.

import { describe, expect, it, vi } from 'vitest'
import { ActiveTabGrants } from '@shared/extension-access'
import type { EceRouter } from './ece-router'
import { inertEngine, madeSessions, type FakeProfileSession } from '../profile-made.test-support'
import { WORKER_START_LIMIT_MS, workerStarter, type ServiceWorkersSide } from './worker-start'

vi.mock('electron', async () => (await import('../profile-made.test-support')).profileElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('../profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))
const { ElectronEngine } = await import('./electron-engine')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const SCOPE = `chrome-extension://${ID}/`

interface Worker {
  sent: string[]
}

/** A promise the test settles when it says so. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)))
  return { promise, resolve, reject }
}

/** The workers of a session: `start` is what `startWorkerForScope` does, and the worker counts as running once `running` is set. */
function session(start: () => Promise<Worker>) {
  const worker: Worker = { sent: [] }
  const state = { running: false }
  const workers: ServiceWorkersSide<Worker> = {
    startWorkerForScope: vi.fn(start),
    getAllRunning: (): Record<number, { scope: string }> => (state.running ? { 7: { scope: SCOPE } } : {}),
    getWorkerFromVersionID: (versionId) => (state.running && versionId === 7 ? worker : undefined)
  }
  return { workers, worker, state }
}

/** A clock the waits move on: each wait of the starter is `ms` later, and `onWait` may change the world meanwhile. */
function clock(onWait: (elapsed: number) => void = () => undefined) {
  let time = 0
  return { now: () => time, wait: async (ms: number) => ((time += ms), onWait(time)) }
}

describe('the start of an extension worker for an event', () => {
  it('asks for one start for a burst of events, and every event of the burst reaches the worker', async () => {
    const started = deferred<Worker>()
    const side = session(() => started.promise)
    const startFor = workerStarter(side.workers, { warn: () => undefined })
    const sends = ['tabs.onUpdated', 'tabs.onUpdated', 'tabs.onActivated'].map((event) => startFor(SCOPE, ID, event).then((worker) => worker.sent.push(event)))
    started.resolve(side.worker)
    await Promise.all(sends)
    expect(side.workers.startWorkerForScope).toHaveBeenCalledExactlyOnceWith(SCOPE)
    expect(side.worker.sent).toEqual(['tabs.onUpdated', 'tabs.onUpdated', 'tabs.onActivated'])
  })

  it('asks for no start at all when the worker is running', async () => {
    const side = session(async () => side.worker)
    side.state.running = true
    expect(await workerStarter(side.workers)(SCOPE, ID, 'tabs.onUpdated')).toBe(side.worker)
    expect(side.workers.startWorkerForScope).not.toHaveBeenCalled()
  })

  it('waits for a start already under way elsewhere when Electron refuses, then gives the worker', async () => {
    const side = session(() => Promise.reject(new Error('Failed to start service worker.')))
    const warn = vi.fn()
    // The other start ends 300 ms later.
    const time = clock((elapsed) => (side.state.running = elapsed >= 300))
    const worker = await workerStarter(side.workers, { warn, ...time })(SCOPE, ID, 'tabs.onUpdated')
    expect(worker).toBe(side.worker)
    expect(time.now()).toBe(300)
    expect(warn).not.toHaveBeenCalled()
  })

  it('gives up after the limit with one line that names the extension and the events lost, and rejects every event', async () => {
    const side = session(() => Promise.reject(new Error('Failed to start service worker.')))
    const warn = vi.fn()
    const time = clock()
    const startFor = workerStarter(side.workers, { warn, nameOf: (id) => (id === ID ? 'Tab Stash' : undefined), ...time })
    const outcomes = ['tabs.onUpdated', 'tabs.onUpdated', 'tabs.onRemoved'].map((event) => startFor(SCOPE, ID, event).then(() => 'sent', (error: Error) => error.message))
    expect(await Promise.all(outcomes)).toEqual(Array(3).fill(`The worker of ${ID} did not start`))
    expect(time.now()).toBe(WORKER_START_LIMIT_MS)
    expect(side.workers.startWorkerForScope).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[extensions] the worker of Tab Stash (${ID}) did not start within 10 s (Failed to start service worker.): lost tabs.onUpdated, tabs.onRemoved`)
  })

  it('names the extension by its id when its name is not known', async () => {
    const side = session(() => Promise.reject(new Error('Failed to start service worker.')))
    const warn = vi.fn()
    await expect(workerStarter(side.workers, { warn, limitMs: 100, ...clock() })(SCOPE, ID, 'alarms.onAlarm')).rejects.toThrow(`The worker of ${ID} did not start`)
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[extensions] the worker of ${ID} did not start within 0.1 s (Failed to start service worker.): lost alarms.onAlarm`)
  })

  it('starts again for an event that comes after the previous start ended', async () => {
    let refuse = true
    const side = session(() => (refuse ? Promise.reject(new Error('Failed to start service worker.')) : Promise.resolve(side.worker)))
    const startFor = workerStarter(side.workers, { warn: () => undefined, limitMs: 100, ...clock() })
    await expect(startFor(SCOPE, ID, 'tabs.onUpdated')).rejects.toThrow()
    refuse = false
    expect(await startFor(SCOPE, ID, 'tabs.onUpdated')).toBe(side.worker)
    expect(side.workers.startWorkerForScope).toHaveBeenCalledTimes(2)
  })

  it('keeps the starts of two extensions apart', async () => {
    const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    const side = session(async () => side.worker)
    const startFor = workerStarter(side.workers)
    await Promise.all([startFor(SCOPE, ID, 'tabs.onUpdated'), startFor(`chrome-extension://${other}/`, other, 'tabs.onUpdated')])
    expect(side.workers.startWorkerForScope).toHaveBeenCalledTimes(2)
  })
})

describe('the engine', () => {
  /** A profile `ensureProfile` makes, with the extension `ID` loaded in it, and the router of its library. The worker of the extension is not running. */
  function profileWithWorker(startWorkerForScope: () => Promise<unknown>, named?: string) {
    madeSessions.clear()
    const engine = Object.assign(
      Object.create(ElectronEngine.prototype) as object,
      inertEngine({ pages: new Map(), loaded: new Map([[`p:${ID}`, { id: ID }]]), manifests: new Map([[`p:${ID}`, { manifest_version: 3, permissions: ['alarms'] }]]), activeTabs: new ActiveTabGrants() })
    )
    const made = engineMethods['ensureProfile']!.call(engine, 'p') as { router: EceRouter & { listeners: Map<string, unknown[]> } }
    const ses: FakeProfileSession = [...madeSessions.values()][0]!
    Object.assign(ses.serviceWorkers, { startWorkerForScope: vi.fn(startWorkerForScope), getAllRunning: () => ({}), getWorkerFromVersionID: () => undefined })
    if (named) ses.extensions.getExtension = () => ({ name: named }) as never
    made.router.listeners.set('alarms.onAlarm', [{ type: 'service-worker', extensionId: ID }])
    return { made, ses }
  }

  it('hands the start to the library of every profile it makes: a burst of events for the worker of an extension asks for one start, and the library did not say its patch is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const worker = { sent: [] as string[], send(channel: string): void {
      this.sent.push(channel)
    } }
    const { made, ses } = profileWithWorker(async () => worker)
    // The patch is there, and `installWorkerStart` saw it: it runs before `restrictLibraryApis` wraps `sendEvent`, which hides it.
    expect(warn).not.toHaveBeenCalled()
    for (let n = 0; n < 3; n++) made.router.sendEvent(ID, 'alarms.onAlarm', { name: `a${n}` })
    await new Promise((resolve) => setImmediate(resolve))
    expect((ses.serviceWorkers as unknown as { startWorkerForScope: ReturnType<typeof vi.fn> }).startWorkerForScope).toHaveBeenCalledExactlyOnceWith(SCOPE)
    expect(worker.sent).toEqual(['crx-alarms.onAlarm', 'crx-alarms.onAlarm', 'crx-alarms.onAlarm'])
    warn.mockRestore()
  })

  it('names the extension, by what its session knows of it, when the start of its worker fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // The clock is the starter's, read as the engine makes it: the fake timers come first.
    vi.useFakeTimers()
    try {
      const { made } = profileWithWorker(() => Promise.reject(new Error('Failed to start service worker.')), 'Tab Stash')
      made.router.sendEvent(ID, 'alarms.onAlarm', { name: 'a' })
      await vi.advanceTimersByTimeAsync(WORKER_START_LIMIT_MS + 100)
    } finally {
      vi.useRealTimers()
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`the worker of Tab Stash (${ID}) did not start within 10 s`))
    // The line of the application is the only one: the library writes none of its own for a start it did not make.
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })
})
