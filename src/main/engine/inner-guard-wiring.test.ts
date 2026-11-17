// How the engine serves the fingerprint protection inside a page and in the service workers: what `answerGuardPlan` hands the guard of the frames
// and workers (engine/inner-guard.ts), when a session is attached and given back, and what a service worker is answered. Run on a stand-in of the
// engine (the class reaches Electron only when a method runs); that a real frame and a real worker read noised values is the engine test's to say.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINGERPRINT_LEVELS, type FingerprintConfig } from '@shared/fingerprint'
import { frameGuardSource } from '@shared/inner-guard'
import { NO_PLAN, PAGE_GUARD, type GuardPlan } from '@shared/page-guard'
import { guardWorld } from '../../preload/guard-world'
import { innerGuardOf } from './inner-guard'
import { holdsOwnSession } from './own-session'
import { fakeDebugger, settle } from './protocol.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: class {} }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { PAGE_GUARD_WORKER_ID } = await import('./electron-engine-base')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const strict = (seed: number): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.strict, seed })
const FALLBACK = { ...FINGERPRINT_LEVELS.standard, seed: 1000 }

function session() {
  const listeners = new Set<(details: { versionId: number; runningStatus: string }) => void>()
  const workers = new Map<number, { scope: string; ipc: { on: ReturnType<typeof vi.fn> } }>()
  return {
    registered: [] as Array<{ id: string; type: string; filePath: string }>,
    unregistered: [] as string[],
    registerPreloadScript(script: { id: string; type: string; filePath: string }) {
      this.registered.push(script)
    },
    unregisterPreloadScript(id: string) {
      this.unregistered.push(id)
    },
    serviceWorkers: {
      on: (_event: string, listener: (details: { versionId: number; runningStatus: string }) => void) => void listeners.add(listener),
      removeListener: (_event: string, listener: (details: { versionId: number; runningStatus: string }) => void) => void listeners.delete(listener),
      getWorkerFromVersionID: (versionId: number) => workers.get(versionId)
    },
    listeners,
    /** A worker of this scope reaches a status; answers the worker, with what was put on its channel. */
    status(versionId: number, scope: string | null, runningStatus = 'starting') {
      if (scope !== null && !workers.has(versionId)) workers.set(versionId, { scope, ipc: { on: vi.fn() } })
      for (const listener of [...listeners]) listener({ versionId, runningStatus })
      return workers.get(versionId)
    }
  }
}

function contents(ses: ReturnType<typeof session>, url: string) {
  const mainFrame = { url }
  const destroyed: Array<() => void> = []
  return { session: ses, mainFrame, debugger: fakeDebugger(), isDestroyed: () => false, setWebRTCIPHandlingPolicy: vi.fn(), once: (_event: string, listener: () => void) => void destroyed.push(listener), destroyed }
}

/** An engine with one session, one tab in it, and the providers a window gave it. */
function engineWith(options: { plan?: GuardPlan; inner?: (() => FingerprintConfig | null) | null } = {}) {
  const ses = session()
  const tab = contents(ses, 'https://news.test/a')
  const provider = vi.fn((_request: { pageUrl: string }) => options.plan ?? NO_PLAN)
  const engine: Record<string, unknown> = {
    guard: provider,
    innerGuard: options.inner === undefined ? () => FALLBACK : options.inner,
    scopes: new Map(),
    profiles: new Map([['p', { session: ses }]]),
    popups: { ownerKeyOf: () => undefined },
    pageOfContents: (sender: unknown) => (sender === tab ? { id: 'tab-1' } : undefined),
    webRtcGuarded: new WeakSet(),
    innerGuarded: new Set(),
    workerGuards: new Map()
  }
  for (const name of ['guardProviderOf', 'innerProviderOf', 'innerFallbackOf', 'innerGuardOfContents', 'syncWebRtc', 'syncInnerGuard', 'syncInnerGuards', 'syncWorkerGuard', 'workerGuardPlan', 'primeInnerGuard', 'setInnerGuard']) {
    engine[name] = function (this: unknown, ...args: unknown[]) {
      return engineMethods[name]!.apply(this, args)
    }
  }
  const call = (name: string, ...args: unknown[]): unknown => (engine[name] as (...a: unknown[]) => unknown)(...args)
  /** The preload of the tab asks for its plan, from its main frame unless told otherwise. */
  const ask = (frame: unknown = tab.mainFrame, claimed: unknown = (frame as { url?: string }).url): unknown => {
    const event: Record<string, unknown> = { sender: tab, senderFrame: frame }
    engineMethods['answerGuardPlan']!.call(engine, event, claimed)
    return event['returnValue']
  }
  const scripts = (): unknown[] => tab.debugger.sent.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').map((c) => (c.params as { source: string }).source)
  return { engine, ses, tab, provider, ask, call, scripts }
}

afterEach(() => vi.restoreAllMocks())

describe('the fingerprint protection inside a page, as the engine serves it', () => {
  it('gives the frames and the workers of a document what the document gets: one session on the page, and the script that carries the page and its plan', async () => {
    const { tab, ask, scripts } = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) } })
    ask()
    await settle()
    expect(tab.debugger.calls).toEqual(['attach'])
    expect(holdsOwnSession(tab)).toBe(true)
    expect(scripts()).toEqual([frameGuardSource(String(guardWorld), { current: { origin: 'https://news.test', config: strict(7) }, fallback: FALLBACK })])
  })

  it('tells them a site left out is left out, and that a page which is not a web page gives nothing', async () => {
    const left = engineWith({ plan: NO_PLAN })
    left.ask()
    await settle()
    expect(left.scripts()).toEqual([frameGuardSource(String(guardWorld), { current: { origin: 'https://news.test', config: null }, fallback: FALLBACK })])

    const local = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) } })
    local.tab.mainFrame.url = 'file:///tmp/a.html'
    local.ask()
    await settle()
    expect(local.provider).not.toHaveBeenCalled()
    expect(local.scripts()).toEqual([frameGuardSource(String(guardWorld), { current: { origin: '', config: null }, fallback: FALLBACK })])
  })

  it('attaches nothing while the protection is off, and for a question that does not come from the page itself', () => {
    const off = engineWith({ plan: NO_PLAN, inner: null })
    off.ask()
    expect(off.tab.debugger.calls).toEqual([])
    expect(innerGuardOf(off.tab)).toBeUndefined()

    const frame = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) } })
    frame.ask({ url: 'https://frame.example/' })
    expect(frame.tab.debugger.calls).toEqual([])
  })

  it('attaches the session of a new page before it loads anything, with no page known yet and no script for its frames until one is', async () => {
    const { tab, call, scripts } = engineWith()
    call('primeInnerGuard', tab)
    await settle()
    expect(tab.debugger.calls).toEqual(['attach'])
    // Frames and workers are held from the first document on; the script of the frames waits for the page, so that no stale one runs beside it.
    expect(tab.debugger.sent.map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Page.enable'])
    expect(scripts()).toEqual([])

    const off = engineWith({ inner: null })
    off.call('primeInnerGuard', off.tab)
    expect(off.tab.debugger.calls).toEqual([])
  })

  it('gives a session made after the protection was switched on the preload of its service workers with its first page, and nothing while it is off', () => {
    const { ses, tab, call } = engineWith()
    call('primeInnerGuard', tab)
    call('primeInnerGuard', tab)
    expect(ses.registered.map(({ id }) => id)).toEqual([PAGE_GUARD_WORKER_ID])

    const off = engineWith({ inner: null })
    off.call('primeInnerGuard', off.tab)
    expect(off.ses.registered).toEqual([])
  })

  it('takes everything back from a private window that closes, while the other windows keep their protection: its pages give their session back, its service workers load nothing', async () => {
    const { engine, ses, tab, ask } = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) } })
    const hooks = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() }
    Object.assign(ses, { webRequest: hooks, removeAllListeners: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() })
    const scope = { key: 'ephemeral:1', session: ses, guard: () => ({ ...NO_PLAN, fingerprint: strict(7) }), innerGuard: () => FALLBACK, downloadListeners: [] }
    ;(engine['scopes'] as Map<string, unknown>).set(scope.key, scope)
    Object.assign(engine, { syncStandIns: vi.fn(), syncPageGuard: vi.fn(), syncGuardListener: vi.fn() })
    engineMethods['syncInnerGuards']!.call(engine, ses)
    ask()
    await settle()
    expect([tab.debugger.isAttached(), ses.registered.length]).toEqual([true, 1])
    engineMethods['scopeClose']!.call(engine, scope)
    expect(tab.debugger.isAttached()).toBe(false)
    expect(ses.unregistered).toEqual([PAGE_GUARD_WORKER_ID])
    expect(scope.innerGuard).toBeNull()
  })

  it('gives the sessions back when the protection goes off, and forgets a page that is gone', async () => {
    const { engine, tab, ask, call } = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) } })
    ask()
    await settle()
    expect((engine['innerGuarded'] as Set<unknown>).has(tab)).toBe(true)
    call('setInnerGuard', null)
    expect(tab.debugger.calls).toEqual(['attach', 'detach'])
    expect(holdsOwnSession(tab)).toBe(false)
    // The next document of the page asks for nothing either.
    ask()
    expect(tab.debugger.calls).toEqual(['attach', 'detach'])
    for (const gone of tab.destroyed) gone()
    expect((engine['innerGuarded'] as Set<unknown>).size).toBe(0)
  })

  it('says so, and gives the frames nothing, when what they get cannot be worked out', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tab, ask } = engineWith({
      plan: { ...NO_PLAN, fingerprint: strict(7) },
      inner: () => {
        throw new Error('settings unreadable')
      }
    })
    // The page itself still gets its plan.
    expect(ask()).toMatchObject({ fingerprint: { seed: 7 } })
    expect(tab.debugger.calls).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot work out what the frames and the workers of a page get'), 'settings unreadable')
  })
})

describe('the fingerprint protection in the service workers of the web', () => {
  it('registers the page guard for the service workers of a session while the protection is on, once, and takes it away with it', () => {
    const { ses, call } = engineWith()
    call('syncWorkerGuard', ses, true)
    call('syncWorkerGuard', ses, true)
    expect(ses.registered.map(({ id, type }) => [id, type])).toEqual([[PAGE_GUARD_WORKER_ID, 'service-worker']])
    expect(ses.registered[0]!.filePath).toMatch(/page-guard\.js$/)
    expect(ses.listeners.size).toBe(1)
    call('syncWorkerGuard', ses, false)
    call('syncWorkerGuard', ses, false)
    expect(ses.unregistered).toEqual([PAGE_GUARD_WORKER_ID])
    expect(ses.listeners.size).toBe(0)
  })

  it('follows the switch of the session: on with a provider, off without', () => {
    const { engine, ses, call } = engineWith()
    call('syncInnerGuards', ses)
    expect(ses.registered).toHaveLength(1)
    engine['innerGuard'] = null
    call('syncInnerGuards', ses)
    expect(ses.unregistered).toEqual([PAGE_GUARD_WORKER_ID])
  })

  it('answers the worker of a web site, as it starts, with the protection of the site its scope is on and no scriptlet', () => {
    const plan: GuardPlan = { scriptlets: [{ id: 'abort-on-property-read', args: ['adsbygoogle'] }], fingerprint: strict(7) }
    const { ses, provider, call } = engineWith({ plan })
    call('syncWorkerGuard', ses, true)
    const worker = ses.status(1, 'https://news.test/app/')!
    expect(worker.ipc.on).toHaveBeenCalledTimes(1)
    const [channel, listener] = worker.ipc.on.mock.calls[0] as [string, (event: { returnValue?: unknown }) => void]
    expect(channel).toBe(PAGE_GUARD.plan)
    const event: { returnValue?: unknown } = {}
    listener(event)
    expect(event.returnValue).toEqual({ scriptlets: [], fingerprint: strict(7) })
    expect(provider).toHaveBeenCalledWith({ pageUrl: 'https://news.test/app/' })
    // The same worker starting again is not given a second listener.
    ses.status(1, 'https://news.test/app/')
    expect(worker.ipc.on).toHaveBeenCalledTimes(1)
  })

  it('leaves the workers of extensions alone, and those in another status, and one Electron does not know', () => {
    const { ses, call } = engineWith()
    call('syncWorkerGuard', ses, true)
    expect(ses.status(1, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/')!.ipc.on).not.toHaveBeenCalled()
    expect(ses.status(2, 'https://news.test/', 'running')!.ipc.on).not.toHaveBeenCalled()
    expect(() => ses.status(3, null)).not.toThrow()
  })

  it('answers nothing once the protection is off, or when the plan cannot be worked out, which is told: the worker never waits', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = engineWith({ plan: { ...NO_PLAN, fingerprint: strict(7) }, inner: null })
    expect(off.call('workerGuardPlan', off.ses, 'https://news.test/')).toBe(NO_PLAN)
    expect(off.provider).not.toHaveBeenCalled()

    const broken = engineWith()
    broken.provider.mockImplementation(() => {
      throw new Error('lists unreadable')
    })
    expect(broken.call('workerGuardPlan', broken.ses, 'https://news.test/')).toBe(NO_PLAN)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot work out what a service worker gets'), 'lists unreadable')
  })

  it('says so when a session refuses the script', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, call } = engineWith()
    ses.registerPreloadScript = () => {
      throw new Error('no such file')
    }
    call('syncWorkerGuard', ses, true)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot add the page guard of the service workers of a session'), 'no such file')
  })
})
