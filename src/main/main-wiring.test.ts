// What `main()` (index.ts) wires, run: the module of the main process is run end to end over a stand-in of Electron (main-run.test-support.ts), in a data folder of
// its own, and what it registered or did is read from the stand-in. The pieces it calls are tested where they live (rejection-log.test.ts, runtime.test.ts,
// shell/surface-load.test.ts, shell/appearance.test.ts…); this file is what joins them in the order main() puts them.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { LAUNCH_SHEET_DELAY_MS } from './shell/launch-sheets'
import { runMain, type MainRun } from './main-run.test-support'
import { posix } from './windows.test-support'

vi.mock('electron', async () => (await import('./main-run.test-support')).mainElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('./profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
vi.mock('electron-chrome-web-store', () => ({}))
// The blocker updates its lists at the start: nothing of it is looked at here.
vi.mock('./blocking', async () => {
  const { soft } = await import('./main-run.test-support')
  return { blockingService: () => soft }
})
// The engine test is run from its own module, loaded only when the application is run as the engine test.
vi.mock('./smoke-run', () => ({ runSmokeSuites: vi.fn(async () => undefined) }))
// The end of a refused launch (launch-refusal.ts, tested on its own): here it stands for a box that stays open, so that what index.ts does meanwhile is seen. A refusal
// that ends at once calls `exit(1)` on the application, which the first test of « a launch that the built application refuses » reads through its own stand-in.
vi.mock('./launch-refusal', async () => {
  const { vi: spies } = await import('vitest')
  const { mainElectron } = await import('./main-run.test-support')
  const electron = (await mainElectron()) as { app: { exit: (code: number) => void } }
  return { refuseLaunch: spies.fn((refused: readonly string[]) => (refused.includes('no-sandbox') ? undefined : electron.app.exit(1))) }
})

let current: MainRun | undefined
const own = mkdtempSync(join(tmpdir(), 'lucium-main-wiring-'))
afterEach(() => {
  current?.dispose()
  current = undefined
})
const run = async (options: Parameters<typeof runMain>[0] = {}): Promise<MainRun> => {
  current = await runMain(options)
  expect(current.fatal(), current.world.logged.slice(-6).join('\n')).toBe(false)
  return current
}
/** The engine test: from the sources, in a data folder of its own (the single instance lock is never asked for). */
const SMOKE = ['--smoke', `--user-data-dir=${own}`]
const worlds = async () => ({ windows: (await import('./shell/own-windows.test-support')).windowsWorld, engine: (await import('./engine/engine-constructed.test-support')).world })

// The first run imports the whole main process: seconds when the whole suite shares the machine.
describe('the start of the main process', { timeout: 30_000 }, () => {
  it('runs to its end in the application, with its listeners on the application and on the process', async () => {
    const main = await run()
    expect(main.listeners('second-instance')).toHaveLength(1)
    expect(main.world.locks).toBe(1)
    expect(main.world.exits).toEqual([])
  })
})

describe('the net for what nobody handled (rejection-log.ts)', () => {
  it('is installed when the application is not run as the engine test, for the rejections and for the exceptions', async () => {
    const main = await run()
    const events = main.processEvents.map(([event]) => event)
    expect(events).toContain('unhandledRejection')
    expect(events).toContain('uncaughtException')
  })

  it('is not installed in the engine test, which must fail on them: it keeps ending on the first exception, with a line that says it', async () => {
    const main = await run({ argv: SMOKE })
    const events = main.processEvents.map(([event]) => event)
    expect(events).not.toContain('unhandledRejection')
    // The one listener of the engine test: it writes the exception and ends the run.
    expect(events.filter((event) => event === 'uncaughtException')).toHaveLength(1)
    const uncaught = main.processEvents.find(([event]) => event === 'uncaughtException')![1]
    uncaught(new Error('a bug of the main process'))
    expect(main.world.exits).toEqual([1])
    expect(main.world.logged.some((line) => line.startsWith('error: [smoke] uncaught exception in the main process:'))).toBe(true)
  })
})

describe('the engine test', () => {
  it('is loaded where it runs, by import(), and only then: the other runs never load it', async () => {
    const asked = async (): Promise<number> => ((await import('./smoke-run')).runSmokeSuites as ReturnType<typeof vi.fn>).mock.calls.length
    await run()
    expect(await asked()).toBe(0)
    current!.dispose()
    await run({ argv: SMOKE })
    expect(await asked()).toBe(1)
    // And it never asks for the lock of the instance: it runs beside the user's application, in a data folder of its own.
    expect(current!.world.locks).toBe(0)
  })
})

describe('the interface', () => {
  it('is loaded through `loadSurface` only: every page main() loads is a built page of the interface, and locked to our own pages before its first load', async () => {
    await run()
    const { windows } = await worlds()
    const loaded = windows.made.flatMap((made) => made.webContents.loaded.map((load) => ({ ...load, locked: made.webContents.listenerCount('will-navigate') > 0 })))
    expect(loaded.length).toBeGreaterThanOrEqual(2)
    for (const load of loaded) {
      expect(load.how, load.target).toBe('loadFile')
      // `loadFile` is given a path of the system (`join`): read it with `/` whatever the system.
      expect(posix(load.target)).toMatch(/\/src\/renderer\/[a-z-]+\.html$/)
      expect(load.locked, load.target).toBe(true)
    }
    expect(loaded.map((load) => posix(load.target).split('/').pop())).toEqual(expect.arrayContaining(['index.html', 'overlay.html']))
  })
})

describe('the appearance', () => {
  it('follows the two settings through followAppearance: the one of Lucium moves nativeTheme, the one asked of the websites moves nothing but the pages', async () => {
    const main = await run()
    const { windows, engine } = await worlds()
    const sender = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    const dispatch = async (patch: Record<string, unknown>) => {
      const handler = engine.ipcHandle.get(Channel.dispatch)!
      await handler({ sender, senderFrame: sender.mainFrame }, { type: 'settings/update', patch })
    }
    expect(main.world.themeSources).toEqual([])
    await dispatch({ interfaceAppearance: 'dark' })
    expect(main.world.themeSources).toEqual(['dark'])
    await dispatch({ websiteAppearance: 'light' })
    expect(main.world.themeSources).toEqual(['dark'])
    await dispatch({ interfaceAppearance: 'auto' })
    expect(main.world.themeSources).toEqual(['dark', 'system'])
  })
})


/** What the layer of panels of the first window was asked to show (`lucium:show-overlay`, in order; null: it was asked to close). */
const panelsAsked = (windows: { made: Array<{ webContents: { sent: unknown[][] } }> }, at = 1): Array<{ panel?: string } | null> =>
  windows.made[at]!.webContents.sent.filter((args) => args[0] === Channel.showOverlay).map((args) => args[1] as { panel?: string } | null)

describe('a second launch of the program (shell/single-instance.ts)', () => {
  it('without an address asks for a window of its own, with the command bar: the one that is there is not the one that opens', async () => {
    const main = await run()
    const { windows } = await worlds()
    const before = windows.made.length
    main.listeners('second-instance')[0]!({}, ['lucium'])
    await vi.waitFor(() => expect(windows.made.length).toBe(before + 2))
    // The new window and the layer of its panels; the layer draws, and is asked for the command bar.
    const [window, layer] = windows.made.slice(before)
    window!.webContents.emit('did-finish-load')
    layer!.webContents.emit('did-finish-load')
    await vi.waitFor(() => expect(layer!.webContents.sent.filter((args) => args[0] === Channel.showOverlay).map((args) => (args[1] as { panel?: string } | null)?.panel)).toContain('commandbar'))
  })

  it('hands a command by address to the handler of the links, which refuses it while its setting is off, and runs it once the setting is on', async () => {
    const main = await run()
    const { windows, engine } = await worlds()
    const sender = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    const secondLaunch = () => main.listeners('second-instance')[0]!({}, ['lucium', 'lucium://new-tab'])
    // Off by default: nothing opens, no window and no panel (the launch brings the window forward and nothing more).
    const before = windows.made.length
    secondLaunch()
    // The handler of a second launch answers at once: what it did is there.
    expect(windows.made.length).toBe(before)
    expect(panelsAsked(windows).map((request) => request?.panel)).not.toContain('commandbar')
    // On: « new tab » by address opens the command bar of the main window.
    await engine.ipcHandle.get(Channel.dispatch)!({ sender, senderFrame: sender.mainFrame }, { type: 'settings/update', patch: { urlAutomation: true } })
    secondLaunch()
    await vi.waitFor(() => expect(panelsAsked(windows).map((request) => request?.panel)).toContain('commandbar'))
  })
})

describe('--new-window and --private-window (shell/single-instance.ts, shared/launch-flags.ts)', { timeout: 30_000 }, () => {
  // The private window itself is not made here (the stand-in engine refuses a private session): that the switch reaches the manager is read from what it does with --new-window,
  // and what it asks for a private one is in shell/single-instance.test.ts.
  it('are obeyed in a second launch once the setting of the commands by address is on, and ignored with a line while it is off', async () => {
    const main = await run()
    const { windows, engine } = await worlds()
    const sender = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    const ignored = (from: number): boolean => main.world.logged.slice(from).some((line) => line.includes('--new-window and --private-window ignored') && line.includes('urlAutomation'))
    const logBefore = main.world.logged.length
    main.listeners('second-instance')[0]!({}, ['lucium', '--new-window'])
    // Off: the launch has no address, so it asks for a window of its own as it always did (a new window is two views, the layer of the panels included), and says it ignored the switch.
    await vi.waitFor(() => expect(windows.made.length).toBe(4))
    expect(ignored(logBefore)).toBe(true)
    await engine.ipcHandle.get(Channel.dispatch)!({ sender, senderFrame: sender.mainFrame }, { type: 'settings/update', patch: { urlAutomation: true } })
    const logOn = main.world.logged.length
    main.listeners('second-instance')[0]!({}, ['lucium', '--new-window'])
    await vi.waitFor(() => expect(windows.made.length).toBe(6))
    expect(ignored(logOn)).toBe(false)
  })

  it('are ignored, with a line, by the first launch while the setting is off', async () => {
    const main = await run({ argv: ['--private-window'] })
    const { windows } = await worlds()
    expect(main.world.logged.some((line) => line.includes('--private-window ignored'))).toBe(true)
    // Only the main window and its layer of panels.
    expect(windows.made.length).toBe(2)
  })
})

describe('the sheet of the launch (shell/launch-sheets.ts)', () => {
  afterEach(() => vi.useRealTimers())

  /**
   * The first window is shown (`ready-to-show`), the clock of the sheet is the test's: `elapse` is the delay the sheet waits after the layer of the panels has drawn
   * its first page, `drawn` that page. `loading` is whether the layer is still loading when the window is shown; `windowGone`, a window closed before the delay.
   */
  const shown = async (options: { loading?: boolean; windowGone?: boolean } = {}) => {
    const { windows } = await worlds()
    const [window, layer] = windows.made as [(typeof windows.made)[number], (typeof windows.made)[number]]
    ;(layer.webContents as unknown as { isLoading: () => boolean }).isLoading = () => options.loading === true
    if (options.windowGone) (window as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    window.emit('ready-to-show')
    return { windows, drawn: () => layer.webContents.emit('did-finish-load'), elapse: () => vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS) }
  }
  const sheets = (windows: { made: Array<{ webContents: { sent: unknown[][] } }> }): string[] => panelsAsked(windows).flatMap((request) => (request?.panel === 'firstlaunch' || request?.panel === 'welcome' || request?.panel === 'news' ? [request.panel] : []))

  it('opens the guide of the first launch once the window is shown, in a profile that is new, a moment after the layer has drawn', async () => {
    await run()
    const window = await shown()
    expect(sheets(window.windows)).toEqual([])
    window.elapse()
    expect(sheets(window.windows)).toEqual(['firstlaunch'])
  })

  it('waits for the layer while it loads (a request sent before its first page is lost), and gives nothing to a window that was closed meanwhile', async () => {
    await run()
    const loading = await shown({ loading: true })
    loading.elapse()
    expect(sheets(loading.windows)).toEqual([])
    loading.drawn()
    loading.elapse()
    expect(sheets(loading.windows)).toEqual(['firstlaunch'])
    vi.useRealTimers()
    current!.dispose()
    await run()
    const gone = await shown({ windowGone: true })
    gone.elapse()
    expect(sheets(gone.windows)).toEqual([])
  })

  it('is not opened in the engine test, which has no one to close a sheet', async () => {
    await run({ argv: SMOKE })
    const window = await shown()
    window.elapse()
    expect(sheets(window.windows)).toEqual([])
  })

  it('knows whether the profile is new from the state file read at the start: a profile that was used gets no guide by itself, even one that never saw it', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-launch-'))
    try {
      const first = await run({ dataFolder: folder })
      const { windows, engine } = await worlds()
      const from = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
      // The profile was used, and left before the guide came: its state is written, with the guide not shown.
      await engine.ipcHandle.get(Channel.dispatch)!({ sender: from, senderFrame: from.mainFrame }, { type: 'settings/update', patch: { warnBeforeQuitting: true } })
      first.quit()
      first.dispose()
      await run({ dataFolder: folder })
      const two = await shown()
      two.elapse()
      expect(sheets(two.windows)).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('the sign of a clean exit and « Reprendre où vous en étiez ? » (shell/clean-exit.ts, shell/launch-sheets.ts)', { timeout: 30_000 }, () => {
  afterEach(() => vi.useRealTimers())

  /** A data folder whose profile was used (two tabs open, the state written) and left: the way it left is the test's. */
  async function usedProfile(folder: string, leave: (first: MainRun) => void) {
    const first = await run({ dataFolder: folder })
    const { windows, engine } = await worlds()
    const from = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    for (const url of ['https://one.example/', 'https://two.example/']) await engine.ipcHandle.get(Channel.dispatch)!({ sender: from, senderFrame: from.mainFrame }, { type: 'tab/open', url, background: true })
    // The state is written on the quit, as in « knows whether the profile is new »: a profile that was used.
    first.quit()
    leave(first)
    first.dispose()
  }
  const marker = (folder: string): string => join(folder, 'userData', 'running.marker')
  /** The next launch: the window is shown, the sheet's clock runs out; the panels asked for are returned. */
  async function nextLaunch(folder: string): Promise<Array<string | undefined>> {
    await run({ dataFolder: folder })
    const { windows } = await worlds()
    const [window, layer] = windows.made as [(typeof windows.made)[number], (typeof windows.made)[number]]
    ;(layer.webContents as unknown as { isLoading: () => boolean }).isLoading = () => false
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    window.emit('ready-to-show')
    vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS)
    vi.useRealTimers()
    return panelsAsked(windows).map((request) => request?.panel)
  }

  it('makes the marker at the start, and removes it when the run ends by will-quit: the next launch offers nothing', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-exit-'))
    try {
      await usedProfile(folder, (first) => {
        expect(existsSync(marker(folder))).toBe(true)
        for (const listener of first.listeners('will-quit')) listener({})
        expect(existsSync(marker(folder))).toBe(false)
      })
      expect(await nextLaunch(folder)).not.toContain('restore')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('offers « Reprendre où vous en étiez ? » at the launch after a run that left the marker (a crash), once the window is shown', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-exit-'))
    try {
      await usedProfile(folder, () => {
        // The run ended without its will-quit: the marker is still there.
        expect(existsSync(marker(folder))).toBe(true)
      })
      expect(await nextLaunch(folder)).toContain('restore')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('the folders of the containers the application left (the sweep of the launch)', () => {
  /** A data folder whose profile switched the containers on and left, with the folder of a container the state does not name. */
  async function leftWithAGhost() {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-sweep-'))
    const first = await run({ dataFolder: folder })
    const { windows, engine } = await worlds()
    const sender = { id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    await engine.ipcHandle.get(Channel.dispatch)!({ sender, senderFrame: sender.mainFrame }, { type: 'settings/update', patch: { tabContainers: true } })
    first.quit()
    first.dispose()
    const ghost = join(folder, 'userData', 'Partitions', 'container-ghost')
    mkdirSync(ghost, { recursive: true })
    writeFileSync(join(ghost, 'Cookies'), 'x')
    return { folder, ghost }
  }

  it('is given the folders the state does not name, once the state was read: the next launch removes what a deleted container left', async () => {
    const { folder, ghost } = await leftWithAGhost()
    try {
      const second = await run({ dataFolder: folder })
      second.dispose()
      expect(existsSync(ghost)).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('removes nothing when the state cannot be trusted at this launch (a copy of one that was set aside is kept beside it): what it named would be taken for unused', async () => {
    const { folder, ghost } = await leftWithAGhost()
    try {
      writeFileSync(join(folder, 'userData', 'state.json.corrupt-1700000000000'), '{}')
      const second = await run({ dataFolder: folder })
      second.dispose()
      expect(existsSync(ghost)).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('the quit (shell/quit-flow.ts)', () => {
  const sender = (windows: { made: Array<{ webContents: { id: number } }> }) => ({ id: windows.made[0]!.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' })
  const event = () => ({ prevented: false, get defaultPrevented() { return this.prevented }, preventDefault() { this.prevented = true } })

  it('watches a quit the system asks for, on the real process: it saves and goes, without a question', async () => {
    const main = await run()
    const events = main.processEvents.map(([name]) => name)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) expect(events, signal).toContain(signal)
  })

  it('asks before quitting through the real dialog, and quits the real application once the answer is the first button', async () => {
    const main = await run()
    const { windows, engine } = await worlds()
    const from = sender(windows)
    await engine.ipcHandle.get(Channel.dispatch)!({ sender: from, senderFrame: from.mainFrame }, { type: 'settings/update', patch: { warnBeforeQuitting: true } })
    const asked = event()
    for (const listener of main.listeners('before-quit')) listener(asked)
    // The quit is held for the question, which is shown by the system, and goes ahead with the answer.
    expect(asked.prevented).toBe(true)
    expect(main.world.boxes).toHaveLength(1)
    await vi.waitFor(() => expect(main.world.quits).toBe(1))
  })

  it('installs its last write after every other will-quit handler of main(): what the closing of the windows changed is written by the last one', async () => {
    const main = await run()
    const { windows, engine } = await worlds()
    const from = sender(windows)
    const state = join(main.world.userData, 'state.json')
    const dispatch = async (patch: Record<string, unknown>) => engine.ipcHandle.get(Channel.dispatch)!({ sender: from, senderFrame: from.mainFrame }, { type: 'settings/update', patch })
    const saved = (): boolean => existsSync(state) && /"warnBeforeQuitting":\s*false/.test(readFileSync(state, 'utf8'))
    // The handlers of will-quit, with the file that installed each: what main() installs itself, and what the pieces it calls install on their own (a service made on first use).
    const quits = main.world.appEvents.flatMap(([event, listener], at) => (event === 'will-quit' ? [{ listener, origin: main.world.origins[at]! }] : []))
    const ofMain = quits.filter(({ origin }) => ['index.ts', 'shell/password-wiring.ts', 'shell/quit-flow.ts'].includes(origin))
    // The last one main() installs is the one of the quit flow, and the others are in front of it.
    expect(ofMain.at(-1)!.origin).toBe('shell/quit-flow.ts')
    expect(ofMain.filter(({ origin }) => origin === 'index.ts').length).toBeGreaterThan(0)
    // And it is the one that writes: a change made after every other handler ran is written when it runs, and not before.
    await dispatch({ warnBeforeQuitting: true })
    for (const { listener } of ofMain.slice(0, -1)) listener({})
    await dispatch({ warnBeforeQuitting: false })
    expect(saved()).toBe(false)
    ofMain.at(-1)!.listener({})
    expect(saved()).toBe(true)
  })
})

describe('a launch that the built application refuses (runtime.ts)', () => {
  it('ends before the instance lock, before the state is read, and never runs main() for it: no window, no file of the profile', async () => {
    const main = await run({ packaged: true, argv: ['--smoke', '--remote-debugging-port=9222'], waitForMain: false })
    // The refusal ends the launch (and the module says so once more where it would have asked for the lock).
    expect(main.world.exits.length).toBeGreaterThan(0)
    expect(main.world.exits.every((code) => code === 1)).toBe(true)
    // It says which switches it refuses, and the built application is not the engine test: the net for what nobody handled is installed all the same.
    expect(main.world.logged.some((line) => line.includes('[launch] refused') && line.includes('--smoke') && line.includes('--remote-debugging-port'))).toBe(true)
    expect(main.processEvents.map(([event]) => event)).toContain('unhandledRejection')
    expect(main.world.locks).toBe(0)
    const { windows } = await worlds()
    expect(windows.made).toHaveLength(0)
    expect(main.listeners('second-instance')).toHaveLength(0)
    expect(existsSync(join(main.world.userData, 'state.json'))).toBe(false)
  })

  it('is the same for the engine test alone: the switch is a reason of its own, and the built application is not the engine test', async () => {
    const main = await run({ packaged: true, argv: ['--smoke', `--user-data-dir=${own}`], waitForMain: false })
    expect(main.world.exits.length).toBeGreaterThan(0)
    expect(main.world.exits.every((code) => code === 1)).toBe(true)
    expect(((await import('./smoke-run')).runSmokeSuites as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('does not hold the engine test outside a data folder of its own: it never opens the profile of the application', async () => {
    const main = await run({ argv: ['--smoke'], waitForMain: false })
    expect(main.world.locks).toBe(0)
    const { windows } = await worlds()
    expect(windows.made).toHaveLength(0)
    expect(main.world.logged.some((line) => line.includes('--user-data-dir='))).toBe(true)
  })
})

describe('the AppImage that AppArmor refuses (launch-refusal.ts, carte 469)', () => {
  it('hands a refusal of --no-sandbox to the end of the launch (which may wait for a box), and neither exits, quits nor takes the lock itself meanwhile', async () => {
    const main = await run({ packaged: true, argv: ['--no-sandbox'], waitForMain: false })
    const { refuseLaunch } = await import('./launch-refusal')
    // The line for the terminal is still written, then the end of the launch is handed the switches: its box is open (the stand-in never ends it).
    expect(main.world.logged.some((line) => line.includes('[launch] refused') && line.includes('--no-sandbox'))).toBe(true)
    expect(vi.mocked(refuseLaunch).mock.calls).toEqual([[['no-sandbox']]])
    // Ended once, and only by it: the launch was not exited at once, nor quit as a second instance, and nothing of it went on.
    expect(main.world.exits).toEqual([])
    expect(main.world.quits).toBe(0)
    expect(main.world.locks).toBe(0)
    const { windows } = await worlds()
    expect(windows.made).toHaveLength(0)
    expect(main.listeners('second-instance')).toHaveLength(0)
    expect(existsSync(join(main.world.userData, 'state.json'))).toBe(false)
  })

  it('hands the end of the launch every refusal, whatever the switch, and none for a launch that is not refused', async () => {
    const { refuseLaunch } = await import('./launch-refusal')
    vi.mocked(refuseLaunch).mockClear()
    await run({ packaged: true, argv: ['--remote-debugging-port=9222'], waitForMain: false })
    expect(vi.mocked(refuseLaunch).mock.calls).toEqual([[['remote-debugging-port']]])
    current!.dispose()
    vi.mocked(refuseLaunch).mockClear()
    await run()
    expect(vi.mocked(refuseLaunch)).not.toHaveBeenCalled()
  })
})

describe('the development variables (runtime.ts)', () => {
  it('are taken out of the environment at the start by the built application, before anything reads them, and kept by a run from the sources', async () => {
    const env = { LUCIUM_ANNOTATE: '1', LUCIUM_UPDATE_FEED: 'https://feed.example/', LUCIUM_SMOKE_ONLY: 'perf' }
    // Two launches that end at once (the engine test is refused to the built application, and has no folder of its own outside it): only the start of the module runs.
    await run({ packaged: true, argv: ['--smoke', `--user-data-dir=${own}`], env, waitForMain: false })
    expect([process.env['LUCIUM_ANNOTATE'], process.env['LUCIUM_UPDATE_FEED'], process.env['LUCIUM_SMOKE_ONLY']]).toEqual([undefined, undefined, undefined])
    current!.dispose()
    await run({ argv: ['--smoke'], env, waitForMain: false })
    expect([process.env['LUCIUM_ANNOTATE'], process.env['LUCIUM_UPDATE_FEED'], process.env['LUCIUM_SMOKE_ONLY']]).toEqual(['1', 'https://feed.example/', 'perf'])
  })
})

describe('the main window put away on macOS (shell/windows.ts)', () => {
  const realPlatform = process.platform
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

  /** The user closes the main window: on macOS it is hidden and the application goes on. */
  async function putAway() {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const main = await run()
    const { windows, engine } = await worlds()
    const mainWindow = windows.made[0]!
    const close = () => {
      const closing = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      mainWindow.emit('close', closing)
      return closing.defaultPrevented
    }
    expect(close()).toBe(true)
    expect(mainWindow.calls).toContain('hide')
    const from = { id: mainWindow.webContents.id, mainFrame: {}, getURL: () => 'file:///app/index.html' }
    return { main, windows, engine, mainWindow, close, from }
  }

  it('is brought back through the window manager by a click on the Dock, with no window opened beside it', async () => {
    const away = await putAway()
    const before = away.windows.made.length
    away.mainWindow.calls.length = 0
    away.main.listeners('activate')[0]!({})
    expect(away.mainWindow.calls).toContain('show')
    expect(away.windows.made).toHaveLength(before)
  })

  it('is brought back by a second launch, and the window that second launch asks for is the main one rather than a window beside a hidden one', async () => {
    const away = await putAway()
    const before = away.windows.made.length
    away.mainWindow.calls.length = 0
    away.main.listeners('second-instance')[0]!({}, ['lucium'])
    expect(away.mainWindow.calls).toContain('show')
    expect(away.windows.made).toHaveLength(before)
  })

  it('is brought back by a command by address that comes from another application, once it is allowed', async () => {
    const away = await putAway()
    await away.engine.ipcHandle.get(Channel.dispatch)!({ sender: away.from, senderFrame: away.from.mainFrame }, { type: 'settings/update', patch: { urlAutomation: true } })
    away.mainWindow.calls.length = 0
    away.main.listeners('open-url')[0]!({ preventDefault: () => undefined }, 'lucium://new-tab')
    expect(away.mainWindow.calls).toContain('show')
  })
})

describe('the shortcut of the mini window, held for every application (index.ts, shell/little-shortcut.ts)', () => {
  const realPlatform = process.platform
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

  /** What a run as `system` asks the system to hold for every application: the setting is on by default (model-defaults.ts). */
  async function heldOn(system: NodeJS.Platform): Promise<string[]> {
    Object.defineProperty(process, 'platform', { value: system })
    const main = await run()
    await vi.waitFor(() => expect(main.world.shortcuts.length).toBeGreaterThan(0))
    return main.world.shortcuts
  }

  // Ctrl+Alt+N is AltGr+N on a Windows keyboard that has an AltGr key: the shortcut held for every application would steal the keystroke (shared/platform.ts).
  it.each([
    ['darwin', 'CmdOrCtrl+Alt+N'],
    ['win32', 'CmdOrCtrl+Alt+Shift+N'],
    ['linux', 'CmdOrCtrl+Alt+N']
  ] as const)('is the default of the system it runs on (%s: %s)', async (system, accelerator) => {
    expect(await heldOn(system)).toEqual([accelerator])
  })
})

afterEach(() => rmSync(own, { recursive: true, force: true }))
