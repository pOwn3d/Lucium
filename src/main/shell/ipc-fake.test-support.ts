// Test support (nothing of the application imports it): an Electron that keeps what the shell registers on `ipcMain` and what the preload script
// exposes and sends, so that a test can run `registerIpc` of a window and the bridge of its interface end to end, without a window. A test file
// mocks Electron with it (`vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())`) and reads `ipcHost`.

type Listener = (event: unknown, ...args: unknown[]) => unknown

export const ipcHost = {
  /** What `ipcMain.on` and `ipcMain.handle` were given, by channel (the single real listener `scopedIpc` registers). */
  on: new Map<string, Listener>(),
  handle: new Map<string, Listener>(),
  /** What the preload script put in the page's world, by name. */
  exposed: new Map<string, unknown>(),
  /** What the preload script sent or invoked, in order. */
  sent: [] as Array<{ kind: 'send' | 'invoke'; channel: string; args: unknown[] }>,
  /** The text Electron's clipboard holds, and whether writing to it fails. */
  clipboardText: '',
  clipboardFails: false
}

/** A sender that is the top frame of a web contents with this id (what `scopedIpc` and the guard of a window look at). */
export function senderOf(id: number): { sender: { id: number; mainFrame: object; getURL: () => string }; senderFrame: object } {
  const mainFrame = {}
  return { sender: { id, mainFrame, getURL: () => 'app://test' }, senderFrame: mainFrame }
}

/** A message on a channel registered with `ipcMain.on`, from the web contents `id`. */
export function sendFrom(id: number, channel: string, ...args: unknown[]): void {
  const listener = ipcHost.on.get(channel)
  if (!listener) throw new Error(`nothing listens on ${channel}`)
  listener(senderOf(id), ...args)
}

/** A request on a channel registered with `ipcMain.handle`, from the web contents `id`. */
export function invokeFrom(id: number, channel: string, ...args: unknown[]): unknown {
  const listener = ipcHost.handle.get(channel)
  if (!listener) throw new Error(`nothing handles ${channel}`)
  return listener(senderOf(id), ...args)
}

const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub, construct: () => stub as object })

export function fakeElectron(): Record<string, unknown> {
  const target: Record<string, unknown> = {
    ipcMain: { on: (channel: string, listener: Listener) => void ipcHost.on.set(channel, listener), handle: (channel: string, listener: Listener) => void ipcHost.handle.set(channel, listener) },
    // Electron's clipboard answers with promises (Electron 45: see TextClipboard in clipboard-ipc.ts).
    clipboard: {
      readText: () => Promise.resolve(ipcHost.clipboardText),
      writeText: (text: string) => (ipcHost.clipboardFails ? Promise.reject(new Error('the clipboard is busy')) : ((ipcHost.clipboardText = text), Promise.resolve()))
    },
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void ipcHost.exposed.set(name, api) },
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void ipcHost.sent.push({ kind: 'send', channel, args }),
      invoke: (channel: string, ...args: unknown[]) => (ipcHost.sent.push({ kind: 'invoke', channel, args }), Promise.resolve(undefined)),
      on: () => {},
      removeListener: () => {}
    },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} }
  }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
}
