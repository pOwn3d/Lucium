// Test support (nothing of the application imports it): the real `ensureProfile` of the engine, which builds the session, the library of the extensions
// and the loads of a profile, run on an engine whose other members are inert unless a test gives them. The library is the real electron-chrome-extensions
// (its router, its store, its tabs API), loaded over a stand-in of Electron; the session is an event emitter that keeps what is registered on it.
// It is here, and not in engine/, on purpose: engine-port.test.ts refuses a file of engine/ that names the library of the extensions.
// A test file puts it in the place of Electron and of the library:
//   vi.mock('electron', async () => (await import('./profile-made.test-support')).profileElectron())
//   vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('./profile-made.test-support')).realLibrary() }))
//   vi.mock('electron-chrome-web-store', () => ({}))
// What the engine did for the profile is then read from the session (`ses.extensions` listeners), the router of the library and the calls on the engine.

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { vi } from 'vitest'
import { ActiveTabGrants } from '@shared/extension-access'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }

class Unused {}
/** The web contents `webContents.fromId` finds for the library (it refuses to add a tab it cannot find): a test puts the tabs it makes here. */
export const libraryContents = new Map<number, unknown>()
/** The Electron the library reads as it is loaded (and keeps): its popups, its windows and its protocol are not run here. */
const libraryElectron = new Proxy(
  {
    app: Object.assign(new EventEmitter(), { isReady: () => true, getAppPath: () => '/nonexistent' }),
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: Object.assign(class {}, { getAllWindows: () => [], fromWebContents: () => null }),
    BaseWindow: { getAllWindows: () => [] },
    webContents: { fromId: (id: number) => libraryContents.get(id) }
  } as Record<string, unknown>,
  { get: (target, name: string) => (name in target ? target[name] : Unused) }
)

/** The real library, loaded with `electron` replaced for the time of the load. */
export function realLibrary(): new (options: Record<string, unknown>) => ElectronChromeExtensions {
  Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true, enumerable: true })
  const real = nodeModule._load
  nodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? libraryElectron : real.call(this, request, ...rest)
  }
  try {
    return (require('electron-chrome-extensions') as { ElectronChromeExtensions: new (options: Record<string, unknown>) => ElectronChromeExtensions }).ElectronChromeExtensions
  } finally {
    nodeModule._load = real
  }
}

/** A session of a profile, as Electron makes it for a partition: what the library and the engine register on it is kept. */
export class FakeProfileSession extends EventEmitter {
  /** The workers: `getWorkerFromVersionID` answers with the scope a test gave the version (`scopes`), as Electron does for a worker that runs or stops. */
  readonly scopes = new Map<number, string>()
  readonly serviceWorkers = Object.assign(new EventEmitter(), { getWorkerFromVersionID: (versionId: number): { scope: string } | undefined => (this.scopes.has(versionId) ? { scope: this.scopes.get(versionId)! } : undefined) })
  readonly cookies = new EventEmitter()
  /** What `protocol.handle` was given, by scheme (the Extensions page's scheme is served by each session, engine/internal-pages.ts). */
  readonly handled = new Map<string, (request: Request) => Response | Promise<Response>>()
  readonly protocol = { isProtocolHandled: () => false, handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>): void => void this.handled.set(scheme, handler) }
  /** The loaded extensions (`session.extensions`): a test emits `extension-loaded` and `extension-unloaded` on it as Electron does. */
  readonly extensions = Object.assign(new EventEmitter(), { getExtension: (): undefined => undefined, getAllExtensions: (): unknown[] => [], removeExtension: vi.fn() })
  /** The preload scripts registered in the session (the library registers two as it is set up on it). */
  readonly scripts: Array<{ id: string; type: string; filePath: string; matches?: string[] }> = []
  constructor(readonly partition: string) {
    super()
  }
  registerPreloadScript(script: { id: string; type: string; filePath: string; matches?: string[] }): string {
    this.scripts.push(script)
    return script.id
  }
  unregisterPreloadScript(id: string): void {
    const at = this.scripts.findIndex((script) => script.id === id)
    if (at >= 0) this.scripts.splice(at, 1)
  }
  getPreloadScripts(): typeof this.scripts {
    return [...this.scripts]
  }
  getPreloads(): string[] {
    return []
  }
  setPreloads(): void {}
  getExtension(): undefined {
    return undefined
  }
  getAllExtensions(): unknown[] {
    return []
  }
  isPersistent(): boolean {
    return true
  }
  /** The folder of the session's data: none for these (nothing is read from or written to a disk). */
  getStoragePath(): null {
    return null
  }
}

/** The sessions `session.fromPartition` made, by partition. */
export const madeSessions = new Map<string, FakeProfileSession>()

/** The part of Electron the engine reaches while it makes a profile (the rest is an empty object, as in `electronStub`). */
export async function profileElectron(): Promise<Record<string, unknown>> {
  const { electronStub } = await import('./engine/electron-page.test-support')
  return electronStub({
    session: {
      defaultSession: {},
      fromPartition: (partition: string) => {
        let made = madeSessions.get(partition)
        if (!made) madeSessions.set(partition, (made = new FakeProfileSession(partition)))
        return made
      }
    },
    app: { getPath: () => '/nowhere', userAgentFallback: 'Lucium Electron/45', on: () => undefined },
    MenuItem: class {}
  })
}

const none = (): undefined => undefined

/**
 * What `ensureProfile` reads of the engine, inert: a profile made with these has no proxy, no permission rule, no blocker, no download hook, no hardware.
 * A test gives what it looks at (`over`): the loads the profile inherits, the hooks of the shell, the sink of the request rules.
 */
export function inertEngine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profiles: new Map(),
    pages: new Map(),
    loaded: new Map(),
    manifests: new Map(),
    known: new Map(),
    activeTabs: new ActiveTabGrants(),
    applyProxyTo: none,
    installPermissions: none,
    hardware: { attach: none },
    installDisplayMedia: none,
    installDownloads: none,
    extensionNetOf: () => ({ remove: vi.fn() }),
    installRequestBlocker: none,
    installResponsePolicy: none,
    responsePolicy: null,
    syncPageGuard: none,
    guard: null,
    watchWorkerConsole: none,
    extensionTools: { attach: none },
    webStore: { addProfile: none, stored: async () => [] },
    extensionPaths: [],
    extensionLedger: () => ({ idOfPath: none }),
    loadFirst: async () => undefined,
    ...over
  }
}

/** A window as the library reads one when it adds a tab to it: the state it puts in the details of the window. */
export class LibraryWindow extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
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
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 900, height: 700 }
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
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

/** A tab (a web contents) as the library reads one when it adds it: the state it puts in the details of the tab. */
export class LibraryTab extends EventEmitter {
  favicon: string | undefined
  constructor(
    readonly id: number,
    readonly url: string,
    readonly session: unknown
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
    return false
  }
  isLoadingMainFrame(): boolean {
    return false
  }
  getTitle(): string {
    return `Tab ${this.id}`
  }
  getURL(): string {
    return this.url
  }
  getType(): string {
    return 'webview'
  }
  get audioMuted(): boolean {
    return false
  }
}
