// The patch of electron-chrome-extensions is part of the application: what an extension reads as the status of a tab ("loading" or "complete") comes from the
// installed library, patched. These tests run the REAL library (as ece-active-tabs.test.ts does) on a tab that is a plain object: there is no Electron process, so
// `electron` is a stub for the time the library is loaded. They fail if the patch is dropped (a new version of the library, a patch that no longer applies).

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installWorkerStart, routerOf } from '../engine/ece-router'
import { workerStarter } from '../engine/worker-start'

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }

class FakeWindow extends EventEmitter {
  readonly id = 11
  isDestroyed(): boolean {
    return false
  }
  isFocused(): boolean {
    return false
  }
  getPosition(): number[] {
    return [0, 0]
  }
  getSize(): number[] {
    return [900, 700]
  }
  getBounds() {
    return { x: 0, y: 0, width: 900, height: 700 }
  }
  getContentBounds() {
    return { x: 0, y: 28, width: 900, height: 672 }
  }
  isMaximized(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  isAlwaysOnTop(): boolean {
    return false
  }
}

/** A page as the library sees it: `loading` is what `isLoading()` says (any frame), `mainFrameLoading` what `isLoadingMainFrame()` says. */
class FakeTab extends EventEmitter {
  favicon: string | undefined
  audioMuted = false
  constructor(
    readonly id: number,
    readonly session: unknown,
    private readonly loading: boolean,
    private readonly mainFrameLoading: boolean
  ) {
    super()
  }
  isDestroyed(): boolean {
    return false
  }
  isCurrentlyAudible(): boolean {
    return false
  }
  isLoading(): boolean {
    return this.loading
  }
  isLoadingMainFrame(): boolean {
    return this.mainFrameLoading
  }
  /** Electron's: the navigation starts at once, and the promise settles when the page has loaded or failed. Unsettled unless a test gives one. */
  loadURL(_url: string): Promise<void> {
    return new Promise<void>(() => undefined)
  }
  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted
  }
  getTitle(): string {
    return 'A page'
  }
  getURL(): string {
    return 'https://page.example/'
  }
  getType(): string {
    return 'webview'
  }
}

const electronStub = new Proxy(
  {
    app: Object.assign(new EventEmitter(), { isReady: () => true, getAppPath: () => '/nonexistent' }),
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: Object.assign(class {}, { getAllWindows: () => [], fromWebContents: () => null }),
    BaseWindow: { getAllWindows: () => [] },
    webContents: { fromId: () => undefined }
  } as Record<string, unknown>,
  { get: (target, name: string) => (name in target ? target[name] : class Unused {}) }
)

let Library: new (options: Record<string, unknown>) => ElectronChromeExtensions

beforeAll(() => {
  const real = nodeModule._load
  nodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? electronStub : real.call(this, request, ...rest)
  }
  try {
    Library = (require('electron-chrome-extensions') as { ElectronChromeExtensions: typeof Library }).ElectronChromeExtensions
  } finally {
    nodeModule._load = real
  }
})

/** The real library with this tab in a window, and its router. */
function libraryWithTab(tab: FakeTab) {
  const extensions = new Library({ license: 'GPL-3.0', session: tab.session, createTab: async () => Promise.reject(new Error('unused')) })
  extensions.addTab(tab as never, new FakeWindow() as never)
  return routerOf(extensions)
}

/** A session as the library reads it, with no extension and no worker. */
function bareSession() {
  return Object.assign(new EventEmitter(), {
    serviceWorkers: new EventEmitter(),
    protocol: { isProtocolHandled: () => false, handle() {} },
    getPreloads: () => [],
    setPreloads() {},
    getExtension: () => undefined,
    getAllExtensions: () => [],
    isPersistent: () => true,
    cookies: new EventEmitter()
  })
}

/** What `chrome.tabs.get` gives an extension for a tab with these loading states. */
function statusSeenByExtension(loading: boolean, mainFrameLoading: boolean): unknown {
  const tab = new FakeTab(101, bareSession(), loading, mainFrameLoading)
  const details = libraryWithTab(tab).handlers.get('tabs.get')!.callback({}, tab.id) as { status: string }
  return details.status
}

const PATCH = new URL('../../../patches/electron-chrome-extensions@4.10.0.patch', import.meta.url)
const LOCKFILE = new URL('../../../pnpm-lock.yaml', import.meta.url)
/** The library installed in node_modules calls the start of Lucium: false until `pnpm install` has applied the patch that brought it. */
const installedCallsStart = readFileSync(require.resolve('electron-chrome-extensions'), 'utf8').includes('this.startWorker(scope, extensionId, eventName)')

describe('the patch of electron-chrome-extensions', () => {
  it('hands the start of a worker for an event to Lucium, in the CommonJS and the ESM builds of the library', () => {
    const files = readFileSync(PATCH, 'utf8').split(/^diff --git /m)
    for (const name of ['dist/cjs/index.js', 'dist/esm/index.mjs']) {
      const file = files.find((part) => part.startsWith(`a/${name} `))
      expect(file, name).toContain('+        const started = hooked ? this.startWorker(scope, extensionId, eventName) : this.session.serviceWorkers.startWorkerForScope(scope);')
      expect(file, name).toContain('+          if (!hooked) console.error(error);')
      expect(file, name).toContain('+    if (url) tab.loadURL(url).catch((error) => console.warn(')
    }
  })

  it('is the one the lockfile names, so that an install applies it (pnpm names a patch by the SHA-256 of its file)', () => {
    const hash = createHash('sha256').update(readFileSync(PATCH)).digest('hex')
    const lockfile = readFileSync(LOCKFILE, 'utf8')
    expect(lockfile).toContain(`electron-chrome-extensions@4.10.0: ${hash}`)
    expect(lockfile.match(/electron-chrome-extensions@4\.10\.0\(patch_hash=([0-9a-f]+)\)/g)?.every((key) => key.includes(hash))).toBe(true)
  })
})

describe('the start of a worker for the events of electron-chrome-extensions', () => {
  const ID = 'abcdefghijklmnopabcdefghijklmnop'
  const SCOPE = `chrome-extension://${ID}/`

  interface Worker {
    send(channel: string, ...args: unknown[]): void
  }

  /**
   * The real library on a session whose worker of ID starts with `start` (handed the worker that records what it is sent), with Lucium's start
   * handed to its router and the worker listening to tabs.onUpdated. No worker counts as running, so every start goes through `start`.
   */
  function library(start: (worker: Worker) => Promise<Worker>) {
    const sent: unknown[][] = []
    const worker: Worker = { send: (...args: unknown[]) => void sent.push(args) }
    const serviceWorkers = Object.assign(new EventEmitter(), {
      startWorkerForScope: vi.fn((_scope: string) => start(worker)),
      getAllRunning: (): Record<number, { scope: string }> => ({}),
      getWorkerFromVersionID: (_versionId: number): Worker | undefined => undefined
    })
    const session = Object.assign(new EventEmitter(), {
      serviceWorkers,
      protocol: { isProtocolHandled: () => false, handle() {} },
      getPreloads: () => [],
      setPreloads() {},
      getExtension: (id: string) => (id === ID ? { id, name: 'An extension', manifest: {} } : undefined),
      getAllExtensions: () => [],
      isPersistent: () => true,
      cookies: new EventEmitter()
    })
    const router = routerOf(new Library({ license: 'GPL-3.0', session, createTab: async () => Promise.reject(new Error('unused')) }))
    const hooked = installWorkerStart(router, workerStarter(serviceWorkers, { warn: () => undefined, limitMs: 0 }), () => undefined)
    ;(router as unknown as { addListener(listener: unknown, extensionId: string, eventName: string): void }).addListener({ type: 'service-worker', extensionId: ID }, ID, 'tabs.onUpdated')
    return { router, sent, serviceWorkers, hooked }
  }

  // The two tests below need the patched library and are skipped without it: this one says so, so that they are never skipped unseen.
  it('is installed with its patch (run `pnpm install` when this fails)', () => {
    expect(installedCallsStart).toBe(true)
  })

  it.skipIf(!installedCallsStart)('starts the worker once for a burst of events, and every event reaches it (skipped until pnpm install applies the patch)', async () => {
    const { router, sent, serviceWorkers, hooked } = library(async (worker) => worker)
    expect(hooked).toBe(true)
    for (const n of [1, 2, 3]) router.sendEvent(ID, 'tabs.onUpdated', n)
    await new Promise<void>((done) => setImmediate(done))
    expect(serviceWorkers.startWorkerForScope).toHaveBeenCalledExactlyOnceWith(SCOPE)
    expect(sent).toEqual([['crx-tabs.onUpdated', 1], ['crx-tabs.onUpdated', 2], ['crx-tabs.onUpdated', 3]])
  })

  it.skipIf(!installedCallsStart)('leaves the line of a failed start to Lucium, and names the extension when the worker cannot take the event', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const refused = library(() => Promise.reject(new Error('Failed to start service worker.')))
      refused.router.sendEvent(ID, 'tabs.onUpdated', 1)
      await new Promise<void>((done) => setTimeout(done, 5))
      expect(errors).not.toHaveBeenCalled()
      const broken = library(async () => ({ send: () => { throw new Error('the worker is gone') } }))
      broken.router.sendEvent(ID, 'tabs.onUpdated', 1)
      await new Promise<void>((done) => setImmediate(done))
      expect(errors).toHaveBeenCalledExactlyOnceWith(`[extensions] cannot send tabs.onUpdated to ${ID}:`, expect.objectContaining({ message: 'the worker is gone' }))
    } finally {
      errors.mockRestore()
    }
  })

  it('says so when the installed library does not call the start of Lucium', () => {
    const warn = vi.fn()
    const unpatched = { handlers: new Map(), sendEvent(this: { session: { serviceWorkers: { startWorkerForScope(scope: string): Promise<unknown> } } }, id: string) { void this.session.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`) } }
    expect(installWorkerStart(unpatched, async () => ({ send() {} }), warn)).toBe(false)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('run pnpm install'))
  })
})

describe('the tab status of electron-chrome-extensions', () => {
  it('is complete while only a frame of the page loads, so that the frames of a page (the WAVE bar) do not reset its extension', () => {
    expect(statusSeenByExtension(true, false)).toBe('complete')
  })

  it('is loading while the main frame loads', () => {
    expect(statusSeenByExtension(true, true)).toBe('loading')
  })

  it('is complete once nothing loads', () => {
    expect(statusSeenByExtension(false, false)).toBe('complete')
  })
})

describe('chrome.tabs.update with an address, in electron-chrome-extensions', () => {
  const EXTENSION = { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' }

  /** Calls tabs.update on a tab whose load settles as `load` says; tells whether the extension was answered before anything else ran. */
  async function update(load: () => Promise<void>) {
    const tab = new FakeTab(101, bareSession(), true, true)
    const loadURL = vi.spyOn(tab, 'loadURL').mockImplementation(load)
    const call = Promise.resolve(libraryWithTab(tab).handlers.get('tabs.update')!.callback({ extension: EXTENSION }, tab.id, { url: 'https://next.example/' }))
    const answer = await Promise.race([
      call.then((details) => ({ answered: details as { id?: number; status?: string } }), (error: Error) => ({ refused: error.message })),
      new Promise<{ waiting: true }>((done) => setImmediate(() => done({ waiting: true })))
    ])
    return { tab, loadURL, answer }
  }

  it.skipIf(!installedCallsStart)('answers with the tab once the navigation has started, without waiting for the page to load', async () => {
    const { tab, loadURL, answer } = await update(() => new Promise<void>(() => undefined))
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://next.example/')
    expect(answer).toEqual({ answered: expect.objectContaining({ id: tab.id, status: 'loading' }) })
  })

  it.skipIf(!installedCallsStart)('answers with the tab when the load rejects with the abort of the page it replaced, and logs that failure with the tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Electron's loadURL rejects with the error of the first page, still loading, that the new navigation cancelled: ERR_ABORTED, under that page's address.
      const aborted = Object.assign(new Error(" (-3) loading 'https://first.example/'"), { errno: -3, code: '' })
      const { tab, answer } = await update(() => Promise.reject(aborted))
      expect(answer).toEqual({ answered: expect.objectContaining({ id: tab.id }) })
      await new Promise<void>((done) => setImmediate(done))
      expect(warn).toHaveBeenCalledExactlyOnceWith(`[extensions] chrome.tabs.update: a load in tab ${tab.id} failed after the extension was answered (error -3)`)
    } finally {
      warn.mockRestore()
    }
  })
})
