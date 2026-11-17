// What grows with a long session has a ceiling (the ceilings themselves are tested in shared/bounded.test.ts). Run on the real code: the shell's rebuild of
// a page for the autoplay rule (`Browser.rebuildForAutoplay`), the favicons of a private context (`EphemeralScope`), the extension workers of the engine
// (`installShims`) on stand-ins (the classes reach Electron only when a method runs), and the watch of the empty tabs over the real reducer.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser } from './shell/browser-fake.test-support'
import { BlankTabWatch } from './shell/blank-tab-watch'

vi.mock('electron', async () => (await import('./engine/electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))
// `Browser.start` runs on a stand-in (shell/browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('./blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./shell/extension-shims', () => ({ ExtensionShims: class {} }))

const { Browser } = await import('./shell/browser')
const { MEMORY_MAX } = await import('./shell/browser-base')
const { ElectronEngine } = await import('./engine/electron-engine')
const { EphemeralScope } = await import('./engine/ephemeral-scope')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('what grows with a long session has a ceiling', () => {
  it('remembers the last autoplay rebuild of a tab up to a ceiling', () => {
    const autoplayRebuiltAt = new Map<string, number>()
    for (let n = 0; n < MEMORY_MAX; n++) autoplayRebuiltAt.set(`old-${n}`, n)
    const shell = {
      pages: new Map([['t', { navigationEntries: () => [] }]]),
      store: { get: () => ({ tabs: [{ id: 't' }] }) },
      autoplayRebuildWanted: () => true,
      autoplayRebuiltAt,
      carriedHistory: new Map(),
      destroyPage: vi.fn(),
      sync: vi.fn()
    }
    shellMethods['rebuildForAutoplay']!.call(shell, 't')
    expect(shell.destroyPage).toHaveBeenCalledWith('t')
    expect(autoplayRebuiltAt.size).toBe(MEMORY_MAX)
    expect(autoplayRebuiltAt.has('t')).toBe(true)
    expect(autoplayRebuiltAt.has('old-0')).toBe(false)
  })

  it('remembers the downloads already opened up to a ceiling, and opens each one once', () => {
    const openedTemporary = new Set<string>()
    for (let n = 0; n < MEMORY_MAX; n++) openedTemporary.add(`old-${n}`)
    const openTemporary = vi.fn(async () => undefined)
    const fake = fakeBrowser({
      isPrivate: () => false,
      isSecondary: () => false,
      gates: { gate: () => undefined },
      store: { get: () => ({ settings: {} }), subscribe: () => () => {} },
      group: new Set(),
      openedTemporary,
      openTemporary
    })
    shellMethods['start']!.call(fake.self)
    const onDownload = fake.calls.find((call) => call.name === 'engine.onDownload')!.args[0] as (download: object, sourcePageId?: string) => void
    const done = { id: 'new-download', temporary: true, state: 'completed' }
    onDownload(done)
    onDownload(done)
    expect(openTemporary).toHaveBeenCalledExactlyOnceWith(done)
    expect(openedTemporary.size).toBe(MEMORY_MAX)
    expect(openedTemporary.has('new-download')).toBe(true)
    expect(openedTemporary.has('old-0')).toBe(false)
  })

  it('keeps the favicons a private context fetched up to a ceiling', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    const scope = new EphemeralScope({} as never, { session: { fetch }, key: 'private' } as never)
    const fetchFavicon = (url: string) => (scope as unknown as { fetchFavicon(url: string): Promise<string | null> }).fetchFavicon(url)
    for (let n = 0; n < 300; n++) await fetchFavicon(`https://site-${n}.example/favicon.png`)
    const favicons = (scope as unknown as { favicons: Map<string, unknown> }).favicons
    expect(favicons.size).toBeLessThan(300)
    expect(favicons.has('https://site-299.example/favicon.png')).toBe(true)
    expect(favicons.has('https://site-0.example/favicon.png')).toBe(false)
    // One that is kept is not fetched again.
    await fetchFavicon('https://site-299.example/favicon.png')
    expect(fetch).toHaveBeenCalledTimes(300)
  })

  it('does not keep the extension workers that are gone, nor the profile of a worker that is', () => {
    const workers = new EventEmitter()
    const made = new Map<number, { scope: string; destroyed: boolean; isDestroyed(): boolean; ipc: { handle: () => void } }>()
    const worker = (versionId: number) => {
      const it = { scope: `chrome-extension://ext${versionId}/`, destroyed: false, isDestroyed: () => it.destroyed, ipc: { handle: vi.fn() } }
      made.set(versionId, it)
      return it
    }
    const ses = { registerPreloadScript: vi.fn(), serviceWorkers: Object.assign(workers, { getWorkerFromVersionID: (id: number) => made.get(id) ?? worker(id) }) }
    const engine = { extensionWorkers: new Set(), workerProfile: new WeakMap(), contextGone: vi.fn(), dispatchShim: vi.fn(), registerFrameShims: vi.fn() }
    engineMethods['installShims']!.call(engine, ses, 'p')
    const start = (versionId: number) => workers.emit('running-status-changed', { runningStatus: 'starting', versionId })
    for (let n = 0; n < 600; n++) start(n)
    expect(engine.extensionWorkers.size).toBeLessThan(600)
    expect(engine.extensionWorkers.has(made.get(599))).toBe(true)
    expect(engine.workerProfile.get(made.get(599)!)).toBe('p')
    // A worker that is gone leaves the table when the next one starts.
    made.get(599)!.destroyed = true
    start(600)
    expect(engine.extensionWorkers.has(made.get(599))).toBe(false)
    expect(engine.extensionWorkers.has(made.get(600))).toBe(true)
  })
})

describe('the shims of the extension contexts, as the engine puts them in a session', () => {
  const session = (refusesMatches = false) => {
    const scripts: Array<Record<string, unknown>> = []
    const registerPreloadScript = (script: Record<string, unknown>) => {
      if (refusesMatches && script['matches']) throw new Error('unknown option matches')
      scripts.push(script)
    }
    return { scripts, ses: { registerPreloadScript, serviceWorkers: new EventEmitter() } }
  }
  const engine = () => ({ extensionWorkers: new Set(), workerProfile: new WeakMap(), contextGone: vi.fn(), dispatchShim: vi.fn(), registerFrameShims: engineMethods['registerFrameShims'] })

  it('run in every service worker (the script tells an extension worker by itself) and, for the frames, in the pages of extensions only: a web page does not read them', () => {
    const { scripts, ses } = session()
    engineMethods['installShims']!.call(engine(), ses, 'p')
    engineMethods['installPatches']!.call(engine(), ses)
    expect(scripts.map((script) => [script['id'], script['type'], script['matches']])).toEqual([
      ['lucium-shims-sw', 'service-worker', undefined],
      ['lucium-shims-frame', 'frame', ['chrome-extension://*/*']],
      // The runtime of the scripts an extension injects into a tab the user lent it: in the pages of the web, where those scripts run, and inert until the main process asks (lent-tab.ts).
      ['lucium-lent-tab', 'frame', ['http://*/*', 'https://*/*']],
      ['lucium-patches-sw', 'service-worker', undefined],
      ['lucium-patches-frame', 'frame', ['chrome-extension://*/*']]
    ])
  })

  it('still go in the frames, for every document, on an Electron that refuses the limit, and the log says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { scripts, ses } = session(true)
    engineMethods['installShims']!.call(engine(), ses, 'p')
    expect(scripts.map((script) => [script['id'], script['matches']])).toEqual([['lucium-shims-sw', undefined], ['lucium-shims-frame', undefined], ['lucium-lent-tab', undefined]])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lucium-shims-frame could not be limited to the pages of extensions'), expect.any(Error))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the script of the lent tabs could not be limited to the pages of the web'), expect.any(Error))
  })
})

describe('the table of empty tabs that were unmarked has a ceiling and forgets closed tabs', () => {
  it('bounds the reasons it keeps, and drops the reason of a tab that is gone', () => {
    const ctx = { now: 1, newId: (() => { let next = 0; return () => `t${++next}` })() }
    let state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://autre.example/' }, ctx)
    const dispatch = (action: Action) => {
      ctx.now += 1
      state = reduce(state, action, ctx)
    }
    const watch = new BlankTabWatch({ store: { get: () => state }, dispatch, displayed: () => false, overlayOpen: () => false, isSummary: () => false, shownElsewhere: () => new Set() })
    const unmarked = (watch as unknown as { unmarked: Map<string, string> }).unmarked
    const open: Action = { type: 'tab/open', url: 'about:blank' }
    const ids: string[] = []
    for (let n = 0; n < 520; n++) {
      watch.applyFromInterface(open, () => dispatch(open))
      const id = activeTab(state)!.id
      ids.push(id)
      // The page of the empty tab commits an address: the tab is a used one now.
      watch.addressCommitted(id, `https://site-${n}.example/`)
    }
    expect(unmarked.size).toBe(500)
    expect(unmarked.has(ids.at(-1)!)).toBe(true)
    expect(unmarked.has(ids[0]!)).toBe(false)
    // A tab that is still there keeps its reason; one that is gone loses it.
    const last = ids.at(-1)!
    watch.dropTraceIfGone(last)
    expect(unmarked.has(last)).toBe(true)
    dispatch({ type: 'tab/close', id: last })
    watch.dropTraceIfGone(last)
    expect(unmarked.has(last)).toBe(false)
  })

  it('is asked to drop the reason of a tab when its page goes', () => {
    const fake = fakeBrowser({ store: { get: () => ({ tabs: [] }) }, runtime: { tabs: {} } })
    shellMethods['dropPageState']!.call(fake.self, 't1')
    expect(fake.calls).toContainEqual({ name: 'blankTabs.dropTraceIfGone', args: ['t1'] })
  })
})
