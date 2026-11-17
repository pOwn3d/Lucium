// The size of the windows and panels, as the application wires it: the layer of panels is zoomed by the layout (the real methods of the window, on a stand-in),
// the channel and the notice are in place, and what a private or guest window may do with the choices. The rules are tested where they live
// (shared/panel-scale.test.ts, shell/panel-scaling.test.ts, shell/panel-zoom.test.ts, shell/screen-notice.test.ts); the windows of their own are made through the
// scaling, all four, in shell/own-windows-wiring.test.ts.

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GUEST_INHERITED, guestInherited } from '@shared/guest-window'
import { interfaceMayDispatch } from '@shared/ipc-policy'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { privateAction, inheritedSettings } from '@shared/private-window'
import { isModified, isResettable } from '@shared/settings-catalog'
import { withPanelSize, screenOf } from '@shared/panel-scale'
import { fakeBrowser } from './shell/browser-fake.test-support'
import { displayOf, windowsWorld } from './shell/own-windows.test-support'

vi.mock('electron', async () => (await import('./shell/own-windows.test-support')).windowsElectron())
// `Browser.start` runs on a stand-in (shell/browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('./blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./shell/extension-shims', () => ({ ExtensionShims: class {} }))
const { Browser } = await import('./shell/browser')
const { SETTLE_DELAY_MS } = await import('./shell/screen-notice')
const shell = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const ULTRAWIDE = screenOf({ label: 'LG UltraWide', internal: false, scaleFactor: 1, size: { width: 3440, height: 1440 } })!

afterEach(() => {
  windowsWorld.reset()
  vi.useRealTimers()
})

describe('the layer of panels', () => {
  const ULTRAWIDE_DISPLAY = displayOf('LG UltraWide', 3440, 1440)
  const sizes = withPanelSize({}, screenOf(ULTRAWIDE_DISPLAY)!, 140, 1)
  const surface = () => ({
    zoom: 1,
    isDestroyed: () => false,
    getZoomFactor(this: { zoom: number }) {
      return this.zoom
    },
    setZoomFactor(this: { zoom: number }, factor: number) {
      this.zoom = factor
    }
  })

  /** A window of the interface at zoom 1 on the ultrawide screen (choice: 140 %), whose three surfaces keep their zoom; `request` is the panel open over it. */
  function windowWith(request: unknown) {
    windowsWorld.display = ULTRAWIDE_DISPLAY
    const [main, layer, floating] = [surface(), surface(), surface()]
    const state = { ...createInitialState({ now: 0, newId: () => 'x' }) }
    state.settings = { ...state.settings, panelSizes: sizes }
    const fake = fakeBrowser({
      win: { isDestroyed: () => false, webContents: main, getBounds: () => ({ x: 100, y: 100, width: 1200, height: 800 }), getContentBounds: () => ({ x: 100, y: 125, width: 1200, height: 775 }) },
      overlay: { webContents: layer },
      floating: { current: () => ({ webContents: floating }) },
      store: { get: () => state },
      k: () => 1,
      overlayRequest: request,
      overlayZoom: () => shell['overlayZoom']!.call(fake.self),
      panelK: () => shell['panelK']!.call(fake.self)
    })
    return { fake, main, layer, floating }
  }

  it('is zoomed by the layout, at every layout, through one method: the zoom of the interface times the factor of the panels', () => {
    // A panel laid out by its own CSS (a sheet in the middle of the window) is zoomed by the factor of the panels on top of the zoom of the interface.
    const open = windowWith({ panel: 'history' })
    shell['syncUiZoom']!.call(open.fake.self, true)
    expect([open.main.zoom, open.floating.zoom]).toEqual([1, 1])
    expect(open.layer.zoom).toBeGreaterThan(1)
    // Without such a panel, the layer has the zoom of the interface like the rest.
    const closed = windowWith(null)
    shell['syncUiZoom']!.call(closed.fake.self, true)
    expect([closed.main.zoom, closed.layer.zoom, closed.floating.zoom]).toEqual([1, 1, 1])
    // At every layout: the layout asks for it.
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const laidOut = fakeBrowser({ store: { get: () => state }, k: () => 1, toCss: (rect: unknown) => rect, fromCss: (rect: unknown) => rect, frame: () => ({ stage: { x: 0, y: 0, width: 800, height: 600 }, panel: null }), fullscreenTab: null, pages: new Map(), floatVisible: false, overlayRequest: null })
    shell['layout']!.call(laidOut.self)
    expect(laidOut.calls.map((call) => call.name)).toContain('syncUiZoom')
  })

  it('takes the factor from the screen the window is on, its choices and the room the window has, and the zoom of the interface', () => {
    const panelK = (display: ReturnType<typeof displayOf>, k = 1, panelSizes = sizes): number => {
      const { fake } = windowWith(null)
      windowsWorld.display = display
      fake.self['k'] = () => k
      const state = { ...createInitialState({ now: 0, newId: () => 'x' }) }
      state.settings = { ...state.settings, panelSizes }
      fake.self['store'] = { get: () => state }
      windowsWorld.asked.length = 0
      const factor = shell['panelK']!.call(fake.self) as number
      // The screen is the one the window is on: it is asked about the window's own bounds.
      expect(windowsWorld.asked).toEqual([{ x: 100, y: 100, width: 1200, height: 800 }])
      return factor
    }
    // The choice made for that screen (140 %), read from the settings of the window: another choice gives another factor, and a screen without one is Automatique.
    const chosen = panelK(ULTRAWIDE_DISPLAY)
    expect(chosen).toBeGreaterThan(panelK(ULTRAWIDE_DISPLAY, 1, withPanelSize({}, screenOf(ULTRAWIDE_DISPLAY)!, 100, 1)))
    expect(panelK(displayOf('Écran de bureau', 1920, 1080))).toBeLessThan(chosen)
    // A screen that says nothing of its size gives 1; the zoom of the interface is part of what the factor is brought back to.
    expect(panelK({ ...ULTRAWIDE_DISPLAY, size: { width: 0, height: 0 } })).toBe(1)
    expect(panelK(ULTRAWIDE_DISPLAY, 1.25)).not.toBe(chosen)
  })

  it('is put right again once the interface pages have loaded (Chromium remembers a zoom for each file)', () => {
    const fake = fakeBrowser({ isPrivate: () => false, isSecondary: () => false, gates: { gate: () => undefined }, store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} }, group: new Set() })
    shell['start']!.call(fake.self)
    const loaded = fake.calls.filter((call) => (call.name === 'win.webContents.once' || call.name === 'overlay.webContents.once') && call.args[0] === 'did-finish-load')
    expect(loaded.map((call) => call.name).sort()).toEqual(['overlay.webContents.once', 'win.webContents.once'])
    for (const call of loaded) (call.args[1] as () => void)()
    expect(fake.calls.filter((call) => call.name === 'syncUiZoom').map((call) => call.args)).toEqual([[true], [true]])
  })

  /** `watchScreen` of a window whose events are kept: the window listens to its own, and to the screens through the watch it makes. */
  function watching(own: Record<string, unknown> = {}) {
    const handlers = new Map<string, () => void>()
    const win = { on: (event: string, listener: () => void) => void handlers.set(event, listener), once: (event: string, listener: () => void) => void handlers.set(`once ${event}`, listener), isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }
    const fake = fakeBrowser({ isPrivate: () => false, win, screenMoveTimer: null, screenWatch: null, overlayRequest: null, layout: vi.fn(), ...own })
    shell['watchScreen']!.call(fake.self)
    return { fake, handlers }
  }

  it('is followed by the window to another screen: a move that has rested lays the panel out again, and looks at the screen for the notice', () => {
    vi.useFakeTimers()
    const scaled = watching({ overlayRequest: { panel: 'history' } })
    const soon = vi.fn()
    scaled.fake.self['screenWatch'] = { soon }
    scaled.handlers.get('move')!()
    scaled.handlers.get('move')!()
    vi.advanceTimersByTime(SETTLE_DELAY_MS)
    // One look for the two moves, once the window rests.
    expect(scaled.fake.self['layout']).toHaveBeenCalledTimes(1)
    expect(soon).toHaveBeenCalledExactlyOnceWith(0)
    // A panel the main process places itself keeps its layout.
    const placed = watching({ overlayRequest: { panel: 'find' } })
    placed.handlers.get('move')!()
    vi.advanceTimersByTime(SETTLE_DELAY_MS)
    expect(placed.fake.self['layout']).not.toHaveBeenCalled()
  })

  it('has the notice looked at in a normal window only, and not in the engine test (a notice must not come in the way of what it checks)', () => {
    const normal = watching()
    expect(normal.fake.self['screenWatch']).toBeTruthy()
    expect([...normal.handlers.keys()]).toEqual(expect.arrayContaining(['once show', 'focus', 'move']))
    // A private window keeps no setting, so « once » would be every time.
    const secret = watching({ isPrivate: () => true })
    expect(secret.fake.self['screenWatch']).toBeFalsy()
    expect([...secret.handlers.keys()]).toEqual(['move'])
    // The engine test (--smoke).
    process.argv.push('--smoke')
    try {
      expect(watching().fake.self['screenWatch']).toBeFalsy()
    } finally {
      process.argv.pop()
    }
  })

  it('is built by the constructor and let go of when the window stops', () => {
    const fake = fakeBrowser({ isPrivate: () => false, isSecondary: () => false, gates: { gate: () => undefined }, store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} }, group: new Set() })
    shell['start']!.call(fake.self)
    // The window lays itself out when it is resized, and then follows the screen.
    const names = fake.calls.map((call) => call.name)
    const resize = fake.calls.find((call) => call.name === 'win.on' && call.args[0] === 'resize')!
    ;(resize.args[1] as () => void)()
    expect(fake.calls.at(-1)!.name).toBe('layout')
    expect(names).toContain('watchScreen')
    const stopping = fakeBrowser({ scopeGuards: new Map(), pages: new Map(), permissionAnswers: new Map(), authAnswers: new Map(), reviewAnswers: new Map(), dialogAnswers: new Map(), leaveAnswers: new Map(), passphraseAnswers: new Map(), dialogQueue: [], group: new Set() })
    shell['stop']!.call(stopping.self)
    expect(stopping.calls.map((call) => call.name)).toContain('stopWatchingScreen')
  })
})

describe('the channel of the screens', () => {
  it('is registered for each window with the guard of the others, and the bridge exposes it', () => {
    expect(read('./shell/ipc.ts')).toMatch(/registerScreensIpc\(ipcMain, guard, win\)/)
    expect(read('../preload/index.ts')).toMatch(/panelScreens: \(\) => ipcRenderer\.invoke\(Channel\.panelScreens\)/)
    expect(read('./shell/screens-ipc.ts')).toMatch(/if \(!guard\(e\.sender, Channel\.panelScreens\)\) return \[\]/)
  })
})

describe('the choices and « Rétablir »', () => {
  it('are put back to Automatique by the reset of the category: the saved screens are not a list the reset keeps', () => {
    expect(isResettable('panelSizes')).toBe(true)
    expect(isModified({ ...defaultSettings(), panelSizes: withPanelSize({}, ULTRAWIDE, 140, 1) }, 'panelSizes')).toBe(true)
    expect(isModified(defaultSettings(), 'panelSizes')).toBe(false)
  })
})

describe('the choices and the windows that are not the owner’s main window', () => {
  const action = { type: 'panel-size/set' as const, screen: ULTRAWIDE, percent: 140 }

  it('may be written by the interface (the Settings window), like any setting', () => {
    expect(interfaceMayDispatch(action, [])).toBe(true)
    expect(interfaceMayDispatch({ type: 'panel-size/noticed', screen: ULTRAWIDE }, [])).toBe(true)
  })

  it('are refused by a private window: its settings are not kept, so a choice made there would be lost with the window', () => {
    expect(privateAction(action)).toBeNull()
    expect(privateAction({ type: 'panel-size/noticed', screen: ULTRAWIDE })).toBeNull()
  })

  it('are followed by a private window, which has the factor of its own screen from the choices of the main window', () => {
    const main = { ...defaultSettings(), panelSizes: withPanelSize({}, ULTRAWIDE, 140, 1) }
    expect(inheritedSettings(main).panelSizes).toEqual(main.panelSizes)
  })

  it('are not handed to a guest window: nothing the owner built by hand (a record) is inherited, and its screens use Automatique', () => {
    expect((GUEST_INHERITED as readonly string[]).includes('panelSizes')).toBe(false)
    const main = { ...defaultSettings(), panelSizes: withPanelSize({}, ULTRAWIDE, 140, 1) }
    expect('panelSizes' in guestInherited(main)).toBe(false)
  })
})
