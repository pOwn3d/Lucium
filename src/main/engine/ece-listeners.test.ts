// The listeners of another extension, on the REAL electron-chrome-extensions: a page of one extension asks, through the library's own IPC
// (`crx-add-listener`, what `window.electron.addExtensionListener` sends), for the events of another extension. There is no Electron process:
// `electron` is a stub for the time the library is loaded, and its `ipcMain` keeps the listeners the library's routing registers on it.

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { ActiveTabGrants } from '@shared/extension-access'
import { restrictLibraryApis, routerOf } from './ece-router'

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }

/** What the library's routing registers on `ipcMain`, by channel: its listeners (`on`) and the channels it answers (`handle`). */
const ipcListeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const ipcHandled = new Set<string>()

const electronStub = new Proxy(
  {
    app: Object.assign(new EventEmitter(), { isReady: () => true, getAppPath: () => '/nonexistent' }),
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (channel: string) => void ipcHandled.add(channel), on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void ipcListeners.set(channel, listener) },
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

const ME = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
/** ME may read every tab and cookie; OTHER only declared storage. */
const MANIFESTS: Record<string, unknown> = { [ME]: { permissions: ['tabs', 'cookies'], host_permissions: ['<all_urls>'] }, [OTHER]: { permissions: ['storage'] } }
const TAB = { id: 1, url: 'https://bank.example/account', title: 'My account', windowId: 3, index: 0, active: true }

/** One profile with the library on it, with Lucium's rules in front (`guarded`) or not. */
function profile(guarded: boolean) {
  const workers = new Map<number, { scope: string; ipc: { handle(): void; on(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void } }>()
  /** The workers the library was asked to start for an event, by scope. */
  const started = vi.fn(async (_scope: string) => ({ send: vi.fn() }))
  const session = Object.assign(new EventEmitter(), {
    serviceWorkers: Object.assign(new EventEmitter(), { getWorkerFromVersionID: (versionId: number) => workers.get(versionId), startWorkerForScope: started }),
    protocol: { isProtocolHandled: () => false, handle() {} },
    getPreloads: () => [],
    setPreloads() {},
    getExtension: (id: string) => (id in MANIFESTS ? { id, name: id, manifest: MANIFESTS[id] } : undefined),
    getAllExtensions: () => [],
    isPersistent: () => true,
    cookies: new EventEmitter()
  })
  const router = routerOf(new Library({ license: 'GPL-3.0', session, createTab: async () => Promise.reject(new Error('unused')) }))
  if (guarded) {
    restrictLibraryApis(router, { grants: new ActiveTabGrants(), tabUrl: () => TAB.url, manifestOf: (id) => MANIFESTS[id], extensionIds: () => Object.keys(MANIFESTS), activated: () => {}, fromInterface: () => false })
  }
  let next = 100
  /** A page of an extension (a popup), as the library's routing sees the sender of a message: its web contents. */
  const page = (id: string) => Object.assign(new EventEmitter(), { id: next++, session, getURL: () => `chrome-extension://${id}/popup.html`, isDestroyed: () => false, send: vi.fn() })
  /** What `window.electron.addExtensionListener(extensionId, eventName, …)` sends from that page. */
  const listen = (sender: ReturnType<typeof page>, extensionId: string, eventName: string) => ipcListeners.get('crx-add-listener')!({ type: 'frame', sender }, extensionId, eventName)
  /**
   * The service worker of an extension as it starts: the library's routing hears of it and listens to its messages. What comes back sends
   * `crx-add-listener` or `crx-remove-listener` from that worker, as `chrome.tabs.onUpdated.addListener` does in it.
   */
  const worker = (id: string) => {
    const versionId = next++
    const heard = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const running = { scope: `chrome-extension://${id}/`, ipc: { handle() {}, on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void heard.set(channel, listener) } }
    workers.set(versionId, running)
    session.serviceWorkers.emit('running-status-changed', { runningStatus: 'starting', versionId })
    return (channel: 'crx-add-listener' | 'crx-remove-listener', extensionId: string, eventName: string) => heard.get(channel)!({ type: 'service-worker', serviceWorker: running, session, versionId }, extensionId, eventName)
  }
  return { router, page, listen, worker, started }
}

describe('the listeners of electron-chrome-extensions', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('are recorded by the library under the extension the page names: alone, it sends the page of OTHER the tabs of ME, address and title included', () => {
    const { router, page, listen } = profile(false)
    const spy = page(OTHER)
    listen(spy, ME, 'tabs.onUpdated')
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, { url: TAB.url, title: TAB.title }, TAB)
    expect(spy.send).toHaveBeenCalledExactlyOnceWith('crx-tabs.onUpdated', TAB.id, { url: TAB.url, title: TAB.title }, TAB)
  })

  it('reach a page for its own extension only once Lucium\'s rules are in front', () => {
    const { router, page, listen } = profile(true)
    const own = page(ME)
    const spy = page(OTHER)
    listen(own, ME, 'tabs.onUpdated')
    listen(spy, ME, 'tabs.onUpdated')
    router.sendEvent(undefined, 'tabs.onUpdated', TAB.id, { url: TAB.url, title: TAB.title }, TAB)
    expect(own.send).toHaveBeenCalledExactlyOnceWith('crx-tabs.onUpdated', TAB.id, { url: TAB.url, title: TAB.title }, TAB)
    expect(spy.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(`[extensions] refused a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
  })

  it('are recorded for a worker under the extension it names too: alone, the worker of OTHER has the worker of ME started at each event, and takes its listener away', async () => {
    const { router, worker, started } = profile(false)
    const spy = worker(OTHER)
    spy('crx-add-listener', ME, 'tabs.onUpdated')
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, {}, TAB)
    expect(started).toHaveBeenCalledExactlyOnceWith(`chrome-extension://${ME}/`)
    spy('crx-remove-listener', ME, 'tabs.onUpdated')
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, {}, TAB)
    expect(started).toHaveBeenCalledTimes(1)
  })

  it('are a worker\'s for its own extension only once Lucium\'s rules are in front', () => {
    const { router, worker, started } = profile(true)
    const spy = worker(OTHER)
    spy('crx-add-listener', ME, 'tabs.onUpdated')
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, {}, TAB)
    expect(started).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(`[extensions] refused a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
    // Its own listener is kept, and the worker of OTHER cannot take it away.
    const own = worker(ME)
    own('crx-add-listener', ME, 'tabs.onUpdated')
    spy('crx-remove-listener', ME, 'tabs.onUpdated')
    expect(warn).toHaveBeenCalledWith(`[extensions] refused the removal of a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, {}, TAB)
    expect(started).toHaveBeenCalledExactlyOnceWith(`chrome-extension://${ME}/`)
    own('crx-remove-listener', ME, 'tabs.onUpdated')
    router.sendEvent(ME, 'tabs.onUpdated', TAB.id, {}, TAB)
    expect(started).toHaveBeenCalledTimes(1)
  })
})

// What a page of an extension can reach through `window.electron` (it stays in the page: the property cannot be deleted), and what keeps each
// part in check. A new version of the library that adds a function or a channel fails here, so that someone reads it before it ships.
describe('the surface of electron-chrome-extensions in an extension page', () => {
  const preload = readFileSync(join(require.resolve('electron-chrome-extensions').replace(/dist[\\/]cjs[\\/]index\.js$/, ''), 'dist/chrome-extension-api.preload.js'), 'utf8')

  it('is five functions on window.electron: the calls (every handler wrapped by restrictLibraryApis), the listeners (addListener guarded), native messaging (revoked)', () => {
    const exposed = /const electronContext = \{([^}]*)\}/.exec(preload)?.[1]
    expect(exposed?.split(',').map((name) => name.trim()).filter(Boolean)).toEqual(['invokeExtension', 'addExtensionListener', 'removeExtensionListener', 'connectNative', 'disconnectNative'])
  })

  it('sends on three channels, and the library listens on those alone', () => {
    profile(false)
    const sent = [...preload.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\((["'`])([^"'`]+)\1/g)].map((match) => match[2])
    expect([...new Set(sent)].sort()).toEqual(['crx-add-listener', 'crx-msg', 'crx-native-msg-${connectionId}', 'crx-remove-listener'])
    expect([...ipcListeners.keys()].sort()).toEqual(['crx-add-listener', 'crx-remove-listener'])
    expect([...ipcHandled].sort()).toEqual(['crx-msg', 'crx-msg-remote'])
  })
})
