// Test support (nothing of the application imports it): the real `ElectronEngine`, constructed over a stand-in of Electron that keeps what the constructor
// registers: the listeners of the application (`app.on`), the channels of `ipcMain`, the handler of the icon protocol, the web contents that exist already.
// A test file puts it in the place of Electron and of the libraries the engine imports:
//   vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
//   vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
//   vi.mock('electron-chrome-web-store', () => ({}))
// What the engine does is then read from what Electron is told of: `emitApp('web-contents-created', ...)` is what Electron does when a page is born.
// The sessions of the profiles it makes are those of profile-made.test-support.ts (`madeSessions`).

import { FakeProfileSession, madeSessions } from '../profile-made.test-support'

type Listener = (...args: unknown[]) => unknown

/** What the constructor of the engine registered in the stand-in of Electron. */
export interface EngineWorld {
  appListeners: Map<string, Listener[]>
  ipcOn: Map<string, Listener>
  ipcHandle: Map<string, Listener>
  protocols: Map<string, Listener>
  /** The web contents `webContents.getAllWebContents()` answers: the ones that exist before the engine does. */
  existing: unknown[]
  errorBoxes: Array<[string, string]>
}

/** Kept on `globalThis`: a test that loads the modules again (`vi.resetModules`, main-run.test-support.ts) keeps the stand-in it made first, and must read the one world. */
export const world = ((globalThis as unknown as { __luciumEngineWorld?: EngineWorld }).__luciumEngineWorld ??= {
  appListeners: new Map<string, Listener[]>(),
  ipcOn: new Map<string, Listener>(),
  ipcHandle: new Map<string, Listener>(),
  protocols: new Map<string, Listener>(),
  existing: [],
  errorBoxes: []
})

/** The default session of Electron, whose pictures and requests the engine signs: the web requests it registers are `onBeforeSendHeaders` and `onHeadersReceived`. */
export const defaultSession = {
  name: 'the session of the interface',
  setUserAgent: (_agent: string): void => undefined,
  webRequest: { onBeforeSendHeaders: (_filter: unknown, _listener?: unknown): void => undefined, onHeadersReceived: (_filter: unknown, _listener?: unknown): void => undefined },
  protocol: { isProtocolHandled: (): boolean => false, handle: (scheme: string, handler: Listener): void => void world.protocols.set(scheme, handler) }
}

/** The part of Electron the constructor of the engine reaches (the rest is an empty object, as in `electronStub`). `fromId` is `webContents.fromId`, `fromFrame` is `webContents.fromFrame`. */
export async function engineElectron(options: { fromId?: (id: number) => unknown; fromFrame?: (frame: unknown) => unknown; webFrameMain?: unknown } = {}): Promise<Record<string, unknown>> {
  const { electronStub } = await import('./electron-page.test-support')
  return electronStub({
    session: {
      defaultSession,
      fromPartition: (partition: string) => {
        let made = madeSessions.get(partition)
        if (!made) madeSessions.set(partition, (made = new FakeProfileSession(partition)))
        return made
      }
    },
    app: {
      getPath: (name: string) => `/tmp/lucium-test-${name}`,
      userAgentFallback: 'Lucium Electron/45',
      on: (name: string, listener: Listener): void => void world.appListeners.set(name, [...(world.appListeners.get(name) ?? []), listener]),
      // What the shell registers for the first time only is kept the same way: a test of the shell over this engine reads no more of it.
      once: (name: string, listener: Listener): void => void world.appListeners.set(name, [...(world.appListeners.get(name) ?? []), listener])
    },
    ipcMain: {
      on: (channel: string, listener: Listener): void => void world.ipcOn.set(channel, listener),
      handle: (channel: string, listener: Listener): void => void world.ipcHandle.set(channel, listener),
      removeHandler: (channel: string): void => void world.ipcHandle.delete(channel),
      removeListener: (channel: string): void => void world.ipcOn.delete(channel)
    },
    webContents: { getAllWebContents: () => world.existing, fromId: options.fromId ?? ((): undefined => undefined), fromFrame: options.fromFrame ?? ((): undefined => undefined) },
    ...(options.webFrameMain !== undefined ? { webFrameMain: options.webFrameMain } : {}),
    dialog: { showErrorBox: (title: string, text: string): void => void world.errorBoxes.push([title, text]) }
  })
}

/** What Electron does for the application: tells every listener of `event`. */
export function emitApp(event: string, ...args: unknown[]): void {
  for (const listener of world.appListeners.get(event) ?? []) listener({}, ...args)
}

/** The real engine, made as `main()` makes it, over the windows `windows(id)` answers. */
export async function constructEngine(windows: (id?: string) => unknown = () => ({})) {
  const { ElectronEngine } = await import('./electron-engine')
  world.appListeners.clear()
  world.ipcOn.clear()
  world.ipcHandle.clear()
  world.protocols.clear()
  return new ElectronEngine(windows as never)
}
