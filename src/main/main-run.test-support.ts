// Test support (nothing of the application imports it): `main()` of the main process (index.ts) run end to end over a stand-in of Electron, in a data folder
// of its own. The stand-in keeps what main() registers on the application (`app.on`), the windows and views it makes, the channels of `ipcMain`, and
// what it loaded; the rest of Electron is inert. A test file puts it in place of Electron and of the libraries, then runs main:
//   vi.mock('electron', async () => (await import('./main-run.test-support')).mainElectron())
//   vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('./profile-made.test-support')).realLibrary() }))
//   vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
//   vi.mock('electron-chrome-web-store', () => ({}))
//   vi.mock('./blocking', async () => { const { soft } = await import('./main-run.test-support'); return { blockingService: () => soft } })   // the blocker updates its lists at the start
//   vi.mock('./smoke-run', () => ({ runSmokeSuites: ... }))      // when the run is the engine test
//   const run = await runMain({ argv: [...], packaged: false })
// The state lives on `globalThis`: the modules are loaded again for each run (`vi.resetModules`), and the stand-in and the test must see one world.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

type Listener = (...args: unknown[]) => unknown

export interface MainWorld {
  /** What main() registered on the application, in order. */
  appEvents: Array<[string, Listener]>
  /** The file of the application that registered each of them (`index.ts`, `shell/quit-flow.ts`…), in the same order. */
  origins: string[]
  /** The codes `app.exit` was given. */
  exits: number[]
  /** How many times the single instance lock was asked for. */
  locks: number
  /** Whether the stand-in application is a packaged one (the built application). */
  packaged: boolean
  userData: string
  /** The lines main() wrote to the console, with their level. */
  logged: string[]
  /** What was written to `nativeTheme.themeSource`, in order. */
  themeSources: string[]
  /** How many times the application was asked to quit (`app.quit`). */
  quits: number
  /** The boxes of the system main() showed (`dialog.showMessageBox`), by their options. */
  boxes: unknown[]
  /** The system-wide shortcuts main() holds now (`globalShortcut.register` less `unregister`), in the order they were taken. */
  shortcuts: string[]
}

const KEY = '__luciumMainWorld'
const world = (): MainWorld => {
  const holder = globalThis as unknown as Record<string, MainWorld | undefined>
  return (holder[KEY] ??= { appEvents: [], origins: [], exits: [], locks: 0, packaged: false, userData: '', logged: [], themeSources: [], quits: 0, boxes: [], shortcuts: [] })
}

/** An object that does nothing, whatever is done to it: called, built, read, iterated, turned into a number. */
export const soft: unknown = new Proxy(function () {}, {
  get: (_target, member) => (member === Symbol.toPrimitive ? () => 0 : member === Symbol.iterator ? function* () {} : typeof member === 'symbol' || member === 'then' ? undefined : soft),
  apply: () => soft,
  construct: () => ({})
})

/** `target` with every member it lacks inert, as a session of a profile or a window answers in these tests. */
const withInert = <T extends object>(target: T): T => new Proxy(target, { get: (own, member, receiver) => (member in own ? (Reflect.get(own, member, receiver) as unknown) : typeof member === 'symbol' || member === 'then' ? undefined : soft) })

/** Keeps a listener main() registered on the application, with the file of the application that registered it (read from the stack). */
function registered(current: MainWorld, event: string, listener: Listener): void {
  const frame = (new Error().stack ?? '').split('\n').slice(2).find((line) => /\/src\/main\//.test(line) && !line.includes('main-run.test-support'))
  current.appEvents.push([event, listener])
  current.origins.push(/\/src\/main\/([^:)]+?):\d+/.exec(frame ?? '')?.[1] ?? '')
}

/** The stand-in of Electron: the engine's (engine-constructed.test-support.ts), the windows' (shell/own-windows.test-support.ts) and an inert object for the rest. */
export async function mainElectron(): Promise<Record<string, unknown>> {
  const engine = await (await import('./engine/engine-constructed.test-support')).engineElectron()
  const windows = await import('./shell/own-windows.test-support')
  const display = windows.windowsElectron()
  const current = world()
  const app = withInert({
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => (current.locks++, true),
    exit: (code: number) => void current.exits.push(code),
    quit: () => void current.quits++,
    getPath: (name: string) => (name === 'userData' ? current.userData : join(current.userData, `path-${name}`)),
    getAppPath: () => '/nowhere',
    getVersion: () => '1.1.0',
    getLocale: () => 'fr',
    getName: () => 'Lucium',
    userAgentFallback: 'Lucium Electron/45',
    get isPackaged() {
      return current.packaged
    },
    on: (event: string, listener: Listener) => registered(current, event, listener),
    once: (event: string, listener: Listener) => registered(current, event, listener),
    removeListener: () => undefined,
    commandLine: { appendSwitch: () => undefined, hasSwitch: () => false }
  })
  class MadeView extends (windows.MadeWindow as unknown as new (options: object) => object) {}
  const session = engine['session'] as Record<string, unknown>
  const own: Record<string, unknown> = {
    app,
    BrowserWindow: windows.MadeWindow,
    WebContentsView: MadeView,
    session: new Proxy(session, { get: (target, member: string) => (member === 'fromPartition' ? (partition: string) => withInert((target['fromPartition'] as (name: string) => object)(partition)) : member === 'defaultSession' ? withInert(target['defaultSession'] as object) : target[member]) }),
    ipcMain: engine['ipcMain'],
    webContents: engine['webContents'],
    // Every box of the system answers at once: the first button, nothing chosen.
    dialog: new Proxy(engine['dialog'] as Record<string, unknown>, { get: (target, member: string) => (member in target ? target[member] : member === 'showMessageBox' ? async (...args: unknown[]) => (current.boxes.push(args.at(-1)), { response: 0, checkboxChecked: false }) : member.endsWith('Sync') ? () => 0 : async () => ({ response: 0, checkboxChecked: false, canceled: true, filePaths: [], filePath: undefined })) }),
    screen: display['screen'],
    // `themeSource` is written by the application only through followAppearance (shell/appearance.ts): the writes are kept.
    nativeTheme: {
      shouldUseDarkColors: false,
      on: () => undefined,
      removeListener: () => undefined,
      get themeSource(): string {
        return current.themeSources.at(-1) ?? 'system'
      },
      set themeSource(value: string) {
        current.themeSources.push(value)
      }
    },
    // The shortcuts held for every application (the mini window's): the accelerator is kept as main() wrote it.
    globalShortcut: {
      register: (accelerator: string) => (current.shortcuts.push(accelerator), true),
      unregister: (accelerator: string) => void (current.shortcuts = current.shortcuts.filter((held) => held !== accelerator))
    },
    clipboard: engine['clipboard'],
    shell: engine['shell'],
    // Nothing of the run reaches the network: the lists the blocker would update are refused here.
    net: { fetch: async () => Promise.reject(new Error('no network in the tests')) },
    Menu: display['Menu'],
    MenuItem: engine['MenuItem']
  }
  return new Proxy({}, { has: () => true, get: (_target, name: string) => (name === 'default' || name === 'then' ? undefined : name in own ? own[name] : soft) })
}

export interface MainRun {
  readonly world: MainWorld
  /** The listeners main() registered for an application event. */
  listeners(event: string): Listener[]
  /** What the process was given to listen to (`process.on`), which the run did not let reach the real process. */
  processEvents: Array<[string, Listener]>
  /** Whether main() ended with its "fatal" line. */
  fatal(): boolean
  /** The application is asked to quit: its listeners of `before-quit` run, as Electron runs them (the state, the history are written). */
  quit(): void
  dispose(): void
}

/**
 * Runs the module of the main process in a data folder of its own: `argv` are the arguments after the program, `env` the variables set for the run
 * (`undefined` removes one), `packaged` whether the stand-in application is the built one. Resolves once main() has registered its listeners.
 */
export async function runMain(options: { argv?: string[]; env?: Record<string, string | undefined>; packaged?: boolean; waitForMain?: boolean; dataFolder?: string } = {}): Promise<MainRun> {
  const current = world()
  // A data folder given is kept after the run (a second run reads what the first one left in it); otherwise it is made for the run and removed with it.
  const folder = options.dataFolder ?? mkdtempSync(join(tmpdir(), 'lucium-main-run-'))
  mkdirSync(join(folder, 'userData'), { recursive: true })
  Object.assign(current, { appEvents: [], origins: [], exits: [], locks: 0, packaged: options.packaged ?? false, userData: join(folder, 'userData'), logged: [], themeSources: [], quits: 0, boxes: [], shortcuts: [] })
  const windows = await import('./shell/own-windows.test-support')
  windows.windowsWorld.reset()
  const engineWorld = (await import('./engine/engine-constructed.test-support')).world
  engineWorld.ipcOn.clear()
  engineWorld.ipcHandle.clear()
  engineWorld.appListeners.clear()
  engineWorld.protocols.clear()
  const savedArgv = process.argv
  const savedDefaultApp = (process as { defaultApp?: boolean }).defaultApp
  const savedEnv = new Map(Object.entries(options.env ?? {}).map(([name]) => [name, process.env[name]]))
  process.argv = ['electron', '.', ...(options.argv ?? [])]
  ;(process as { defaultApp?: boolean }).defaultApp = !(options.packaged ?? false)
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const processEvents: Array<[string, Listener]> = []
  vi.stubGlobal('fetch', async () => Promise.reject(new Error('no network in the tests')))
  const onProcess = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: Listener) => {
    processEvents.push([event, listener])
    return process
  }) as never)
  const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void current.logged.push(`${level}: ${args.map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : String(arg))).join(' ')}`)))
  const dispose = (): void => {
    vi.unstubAllGlobals()
    onProcess.mockRestore()
    for (const spy of consoles) spy.mockRestore()
    process.argv = savedArgv
    ;(process as { defaultApp?: boolean }).defaultApp = savedDefaultApp
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (options.dataFolder === undefined) rmSync(folder, { recursive: true, force: true })
  }
  try {
    vi.resetModules()
    await import('./index')
    // main() is asynchronous: its listeners are there once it went through the application's start (not for a launch that was refused or handed to another instance).
    if (options.waitForMain !== false) await vi.waitFor(() => { if (!current.appEvents.some(([event]) => event === 'second-instance')) throw new Error('main() has not finished') }, { timeout: 5000, interval: 25 })
  } catch (error) {
    const logged = current.logged.slice(-12).join('\n')
    dispose()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logged}`)
  }
  return { world: current, listeners: (event) => current.appEvents.filter(([name]) => name === event).map(([, listener]) => listener), processEvents, fatal: () => current.logged.some((line) => line.includes('[main] fatal')), quit: () => { for (const [event, listener] of current.appEvents) if (event === 'before-quit') listener({ preventDefault: () => undefined }) }, dispose }
}
