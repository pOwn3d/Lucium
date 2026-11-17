import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/model'
import { withPanelSize, type PanelSizes, type Rect } from '@shared/panel-scale'
import { MOVE_SETTLE_MS, NAVIGATED_SETTLE_MS, PanelScaling, electronDisplays, type DisplayData, type Displays, type PanelWindow, type ScreenApi, type ScreenSide } from './panel-scaling'

// The windows of their own, scaled. Everything the rules touch is a stand-in: a screen that is a list of displays, a window that is a record of what it was
// told, a state that is a value and its subscribers, a timer that waits to be run. No Electron, no window.

const SETTINGS = { width: 780, height: 760, minWidth: 684, minHeight: 520 }
const ABOUT = { width: 340, height: 520 }

const data = (label: string, internal: boolean, width: number, height: number, scaleFactor: number, x = 0): DisplayData => ({
  label,
  internal,
  scaleFactor,
  size: { width, height },
  bounds: { x, y: 0, width, height },
  workArea: { x, y: 25, width, height: height - 25 }
})
const ULTRAWIDE = data('LG UltraWide', false, 3440, 1440, 1, 0)
const LAPTOP = data('Built-in Retina Display', true, 1512, 982, 2, 3440)

function screens(list: DisplayData[]): { api: ScreenApi; listeners: Map<string, Set<() => void>>; emit: (event: string) => void; lookups: () => number } {
  const listeners = new Map<string, Set<() => void>>()
  let lookups = 0
  const inside = (display: DisplayData, bounds: Rect) => {
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    return x >= display.bounds.x && x < display.bounds.x + display.bounds.width && y >= display.bounds.y && y < display.bounds.y + display.bounds.height
  }
  const api: ScreenApi = {
    getDisplayMatching: (bounds) => {
      lookups++
      return list.find((display) => inside(display, bounds)) ?? list[0]!
    },
    getPrimaryDisplay: () => list[0]!,
    getAllDisplays: () => list,
    on: (event, listener) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener),
    removeListener: (event, listener) => void listeners.get(event)?.delete(listener)
  }
  return { api, listeners, lookups: () => lookups, emit: (event) => [...(listeners.get(event) ?? [])].forEach((listener) => listener()) }
}

class FakeWindow implements PanelWindow {
  destroyed = false
  maximized = false
  fullScreen = false
  zoom = 1
  content: { width: number; height: number }
  minimum: [number, number] | null = null
  readonly zoomCalls: number[] = []
  readonly sizeCalls: Array<[number, number]> = []
  private readonly handlers = new Map<string, Array<() => void>>()
  private readonly contentHandlers = new Map<string, Array<() => void>>()
  constructor(public bounds: Rect, content?: { width: number; height: number }) {
    this.content = content ?? { width: bounds.width, height: bounds.height }
  }
  isDestroyed = () => this.destroyed
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullScreen
  getBounds = () => this.bounds
  getContentBounds = () => ({ x: this.bounds.x, y: this.bounds.y, ...this.content })
  setContentSize = (width: number, height: number) => {
    this.sizeCalls.push([width, height])
    this.content = { width, height }
  }
  setMinimumSize = (width: number, height: number) => void (this.minimum = [width, height])
  on = (event: 'move' | 'closed', listener: () => void) => void (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(listener)
  webContents = {
    isDestroyed: () => this.destroyed,
    getZoomFactor: () => this.zoom,
    setZoomFactor: (factor: number) => {
      this.zoomCalls.push(factor)
      this.zoom = factor
    },
    on: (event: string, listener: () => void) => void (this.contentHandlers.get(event) ?? this.contentHandlers.set(event, []).get(event)!).push(listener)
  }
  emit(event: 'move' | 'closed'): void {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
  emitContent(event: string): void {
    for (const handler of this.contentHandlers.get(event) ?? []) handler()
  }
}

function setup(options: { displays?: DisplayData[]; sizes?: PanelSizes; around?: Rect | null } = {}) {
  const screen = screens(options.displays ?? [ULTRAWIDE, LAPTOP])
  let settings = { ...defaultSettings(), panelSizes: options.sizes ?? {} }
  const subscribers = new Set<(state: { settings: typeof settings }) => void>()
  const store = {
    get: () => ({ settings }) as never,
    subscribe: (listener: (state: never) => void) => {
      subscribers.add(listener as never)
      return () => void subscribers.delete(listener as never)
    }
  }
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  let around: Rect | null = options.around === undefined ? { x: 100, y: 100, width: 1360, height: 860 } : options.around
  const scaling = new PanelScaling({
    store,
    displays: electronDisplays(screen.api),
    around: () => around,
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as { live: boolean }).live = false)
  })
  return {
    scaling,
    screen,
    subscribers,
    timers,
    around: (next: Rect | null) => void (around = next),
    /** The settings as they are now: another change of the state (a switch) keeps the same choices. */
    current: () => settings,
    choose: (sizes: PanelSizes) => {
      settings = { ...settings, panelSizes: sizes }
      for (const listener of [...subscribers]) listener({ settings })
    },
    /** Runs the timers that were armed and not cleared (the window rests). */
    settle: () => {
      for (const timer of timers.splice(0)) if (timer.live) timer.run()
    },
    make: (base: typeof SETTINGS | typeof ABOUT, at: Rect = { x: 0, y: 0, width: 0, height: 0 }) => {
      let received: Record<string, unknown> = {}
      const win = scaling.open(base, (made) => {
        received = made
        return new FakeWindow({ x: (made.x as number) ?? at.x, y: (made.y as number) ?? at.y, width: made.width as number, height: made.height as number })
      })
      return { win: win as FakeWindow, options: received }
    }
  }
}

const ON_ULTRAWIDE = { x: 800, y: 200, width: 1360, height: 860 }
const ON_LAPTOP = { x: 3700, y: 100, width: 1200, height: 800 }

describe('a window of its own at its creation', () => {
  it('opens at 100 % on a screen that is the reference: the sizes it always had, in the middle of the work area', () => {
    const t = setup({ around: ON_LAPTOP })
    const { options } = t.make(SETTINGS)
    expect(options).toMatchObject({ width: 780, height: 760, minWidth: 684, minHeight: 520 })
    // The work area of the laptop: 1512 × 957 at (3440, 25).
    expect(options.x).toBe(3440 + Math.round((1512 - 780) / 2))
    expect(options.y).toBe(25 + Math.round((957 - 760) / 2))
  })

  it('opens larger on the ultra-wide, where Automatique gives 125 %: its size and its minimum multiplied, centred on that screen', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { options } = t.make(SETTINGS)
    expect(options).toMatchObject({ width: 975, height: 950, minWidth: 855, minHeight: 650 })
    expect(options.x).toBe(Math.round((3440 - 975) / 2))
    expect(options.y).toBe(25 + Math.round((1415 - 950) / 2))
  })

  it('opens on the screen of the window the user works in, not on another one', () => {
    const t = setup({ around: ON_LAPTOP })
    expect((t.make(SETTINGS).options.x as number)).toBeGreaterThanOrEqual(3440)
    t.around(ON_ULTRAWIDE)
    expect((t.make(SETTINGS).options.x as number)).toBeLessThan(3440)
  })

  it('opens on the primary screen when no window is known', () => {
    const t = setup({ around: null })
    expect(t.make(SETTINGS).options.width).toBe(975)
  })

  it('opens with what it has at 100 % when no screen can be told (a display with no size)', () => {
    const t = setup({ displays: [{ ...ULTRAWIDE, size: { width: 0, height: 0 } }], around: ON_ULTRAWIDE })
    const { options, win } = t.make(SETTINGS)
    expect(options).toEqual(SETTINGS)
    expect(win.zoom).toBe(1)
  })

  it('opens at the size chosen for its screen, a notch down for a compact choice and a notch up for a large one', () => {
    const ultrawide = (percent: number) => withPanelSize({}, { key: 'LG UltraWide|3440x1440@1', label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }, percent, 1)
    expect(setup({ sizes: ultrawide(90), around: ON_ULTRAWIDE }).make(SETTINGS).options).toMatchObject({ width: 702, height: 684 })
    expect(setup({ sizes: ultrawide(150), around: ON_ULTRAWIDE }).make(SETTINGS).options).toMatchObject({ width: 1170, height: 1140 })
  })

  it('is never larger than the work area, and the factor falls to what lets its minimum fit: Très grande on a small laptop', () => {
    const small = data('Built-in', true, 1280, 800, 2, 0)
    const sizes = withPanelSize({}, { key: 'built-in|1280x800@2', label: '', internal: true, width: 1280, height: 800, scaleFactor: 2 }, 160, 1)
    const t = setup({ displays: [small], sizes, around: { x: 0, y: 0, width: 1000, height: 700 } })
    const { options, win } = t.make(SETTINGS)
    expect(options.width as number).toBeLessThanOrEqual(1280)
    expect(options.height as number).toBeLessThanOrEqual(775)
    expect(options.minHeight as number).toBeLessThanOrEqual(775)
    // 775 / 520 = 1.49 → 1.45: the page is zoomed at the factor the window can hold, not at 160 %.
    expect(win.zoom).toBe(1.45)
  })

  it('has the page zoomed at the factor once it has a document, and again at each navigation (Chromium remembers a zoom per address)', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    // At the creation there is nothing to zoom yet: the zoom is asked for anyway, and again at the load.
    expect(win.zoom).toBe(1.25)
    win.zoom = 1
    win.emitContent('did-finish-load')
    expect(win.zoom).toBe(1.25)
    win.zoom = 1
    win.emitContent('did-navigate-in-page')
    expect(win.zoom).toBe(1.25)
    win.zoom = 1
    win.emitContent('did-navigate')
    expect(win.zoom).toBe(1.25)
    // Already right: it is not set again.
    const calls = win.zoomCalls.length
    win.emitContent('did-finish-load')
    expect(win.zoomCalls).toHaveLength(calls)
  })

  it('looks at the zoom once more a moment after a navigation, in case Chromium gave the page the zoom of its new address after it was looked at', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    t.timers.length = 0
    // The pane of Settings changes (the hash): at that instant the page still has the zoom it was given…
    win.emitContent('did-navigate-in-page')
    expect(t.timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([NAVIGATED_SETTLE_MS])
    // …and Chromium then resets it to the zoom it remembers for the address.
    win.zoom = 1
    t.settle()
    expect(win.zoom).toBe(1.25)
    win.emitContent('did-navigate')
    win.zoom = 1
    t.settle()
    expect(win.zoom).toBe(1.25)
  })

  it('does not touch a window that was never given a factor other than 1 (a laptop at 100 %): the zoom stays what the page had', () => {
    const t = setup({ around: ON_LAPTOP })
    const { win } = t.make(SETTINGS)
    expect(win.zoomCalls).toEqual([])
  })
})

describe('a window that is open follows the choice', () => {
  const key = { key: 'LG UltraWide|3440x1440@1', label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }

  it('is zoomed and resized when the choice of its screen changes, its content as large in CSS pixels as it was', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    expect(win.content).toEqual({ width: 975, height: 950 })
    t.choose(withPanelSize({}, key, 100, 1))
    expect(win.zoom).toBe(1)
    expect(win.minimum).toEqual([684, 520])
    expect(win.content).toEqual({ width: 780, height: 760 })
    t.choose(withPanelSize({}, key, 150, 2))
    expect(win.zoom).toBe(1.5)
    expect(win.minimum).toEqual([1026, 780])
    expect(win.content).toEqual({ width: 1170, height: 1140 })
  })

  it('goes back to Automatique when the choice is removed', () => {
    const t = setup({ sizes: withPanelSize({}, key, 100, 1), around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    expect(win.zoom).toBe(1)
    t.choose({})
    expect(win.zoom).toBe(1.25)
    expect(win.content).toEqual({ width: 975, height: 950 })
  })

  it('is left alone when the choice that changed is the one of another screen', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    const calls = win.zoomCalls.length
    t.choose(withPanelSize({}, { key: 'built-in|1512x982@2', label: '', internal: true, width: 1512, height: 982, scaleFactor: 2 }, 150, 1))
    expect(win.zoomCalls).toHaveLength(calls)
    expect(win.sizeCalls).toEqual([])
  })

  it('keeps its size when it is maximised or in full screen, and still takes the zoom and the minimum', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    win.maximized = true
    t.choose(withPanelSize({}, key, 100, 1))
    expect(win.zoom).toBe(1)
    expect(win.minimum).toEqual([684, 520])
    expect(win.sizeCalls).toEqual([])
    win.maximized = false
    win.fullScreen = true
    t.choose(withPanelSize({}, key, 140, 2))
    expect(win.zoom).toBe(1.4)
    expect(win.sizeCalls).toEqual([])
  })

  it('follows the choice for every window that is open, the About window too, each by its own size', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const settings = t.make(SETTINGS).win
    const about = t.make(ABOUT).win
    expect(about.content).toEqual({ width: 425, height: 650 })
    t.choose(withPanelSize({}, key, 80, 1))
    expect(settings.zoom).toBe(0.8)
    expect(about.zoom).toBe(0.8)
    expect(about.content).toEqual({ width: 272, height: 416 })
  })

  it('is moved to the size of another screen when it is dragged there: once the drag has rested, not at every step of it', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    expect(win.zoom).toBe(1.25)
    // Dragged onto the laptop's screen, in several moves.
    win.bounds = { x: 3500, y: 120, width: 975, height: 950 }
    win.emit('move')
    win.bounds = { x: 3600, y: 120, width: 975, height: 950 }
    win.emit('move')
    win.bounds = { x: 3700, y: 120, width: 975, height: 950 }
    win.emit('move')
    // Nothing yet, and a single look waiting.
    expect(win.zoom).toBe(1.25)
    expect(t.timers.filter((timer) => timer.live)).toHaveLength(1)
    expect(t.timers.find((timer) => timer.live)!.ms).toBe(MOVE_SETTLE_MS)
    t.settle()
    // The laptop is the reference: 100 %, and the window is as large in CSS pixels as it was.
    expect(win.zoom).toBe(1)
    expect(win.content).toEqual({ width: 780, height: 760 })
    expect(win.minimum).toEqual([684, 520])
  })

  it('does nothing when it is moved within the same screen', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    win.bounds = { x: 900, y: 300, width: 975, height: 950 }
    win.emit('move')
    t.settle()
    expect(win.sizeCalls).toEqual([])
    expect(win.zoom).toBe(1.25)
  })

  it('is looked at again when a screen is added, removed or changes its size (the system changes the resolution): Automatique follows the new size', () => {
    const monitor = data('LG UltraWide', false, 3440, 1440, 1, 0)
    const t = setup({ displays: [monitor, LAPTOP], around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    expect(win.zoom).toBe(1.25)
    expect(win.content).toEqual({ width: 975, height: 950 })
    // The system gives the monitor a lower resolution: 2560 × 1440, where Automatique gives 120 %.
    monitor.size = { width: 2560, height: 1440 }
    monitor.bounds = { x: 0, y: 0, width: 2560, height: 1440 }
    monitor.workArea = { x: 0, y: 25, width: 2560, height: 1415 }
    t.screen.emit('display-metrics-changed')
    expect(win.zoom).toBe(1.2)
    expect(win.content).toEqual({ width: 936, height: 912 })
  })
})

describe('what it listens to', () => {
  it('nothing while no window of its own is open: no subscription to the state, no listener on the screens', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    expect(t.subscribers.size).toBe(0)
    expect([...t.screen.listeners.values()].reduce((sum, set) => sum + set.size, 0)).toBe(0)
    expect(t.scaling.count()).toBe(0)
  })

  it('one subscription and three screen listeners from the first window to the last, however many windows there are', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const first = t.make(SETTINGS).win
    const second = t.make(ABOUT).win
    expect(t.subscribers.size).toBe(1)
    expect([...t.screen.listeners.values()].map((set) => set.size)).toEqual([1, 1, 1])
    expect(t.scaling.count()).toBe(2)
    first.emit('closed')
    expect(t.subscribers.size).toBe(1)
    expect(t.scaling.count()).toBe(1)
    second.emit('closed')
    expect(t.subscribers.size).toBe(0)
    expect([...t.screen.listeners.values()].reduce((sum, set) => sum + set.size, 0)).toBe(0)
    expect(t.scaling.count()).toBe(0)
  })

  it('is armed again by the next window', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    t.make(SETTINGS).win.emit('closed')
    expect(t.subscribers.size).toBe(0)
    t.make(SETTINGS)
    expect(t.subscribers.size).toBe(1)
  })

  it('passes over a change of the state that is not a change of the choices, with one comparison', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    const calls = win.zoomCalls.length
    const lookups = t.screen.lookups()
    for (const listener of [...t.subscribers]) listener({ settings: { ...t.current(), autoUpdate: !t.current().autoUpdate } })
    expect(win.zoomCalls).toHaveLength(calls)
    expect(win.sizeCalls).toEqual([])
    // Not even a look at the screen: the choices are the same object, which is all that is compared.
    expect(t.screen.lookups()).toBe(lookups)
  })

  it('forgets a window that was destroyed without telling (and lets go of the rest when it was the last), and never touches it', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    win.destroyed = true
    t.choose(withPanelSize({}, { key: 'LG UltraWide|3440x1440@1', label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }, 100, 1))
    expect(win.sizeCalls).toEqual([])
    expect(t.scaling.count()).toBe(0)
    expect(t.subscribers.size).toBe(0)
  })

  it('has no look waiting once the window is closed', () => {
    const t = setup({ around: ON_ULTRAWIDE })
    const { win } = t.make(SETTINGS)
    win.emit('move')
    expect(t.timers.filter((timer) => timer.live)).toHaveLength(1)
    win.emit('closed')
    expect(t.timers.filter((timer) => timer.live)).toHaveLength(0)
  })
})

describe('Electron’s screen as the rules see it', () => {
  it('gives each display its key from its name, size and density (not its id), and the whole screen and the work area apart', () => {
    const displays: Displays = electronDisplays(screens([ULTRAWIDE, LAPTOP]).api)
    const sides = displays.all() as ScreenSide[]
    expect(sides.map((side) => side.screen.key)).toEqual(['LG UltraWide|3440x1440@1', 'built-in|1512x982@2'])
    expect(sides[0]!.bounds).toEqual({ x: 0, y: 0, width: 3440, height: 1440 })
    expect(sides[0]!.area).toEqual({ x: 0, y: 25, width: 3440, height: 1415 })
    expect(displays.matching({ x: 3600, y: 100, width: 10, height: 10 })!.screen.key).toBe('built-in|1512x982@2')
    expect(displays.primary()!.screen.key).toBe('LG UltraWide|3440x1440@1')
  })

  it('leaves out a display that gives no size, and says nothing for it', () => {
    const displays = electronDisplays(screens([ULTRAWIDE, { ...LAPTOP, size: { width: 0, height: 0 } }]).api)
    expect(displays.all()).toHaveLength(1)
    expect(electronDisplays(screens([{ ...ULTRAWIDE, size: { width: Number.NaN, height: 1 } }]).api).primary()).toBeNull()
  })

  it('listens to the three events of the screens, and lets go of the three', () => {
    const screen = screens([ULTRAWIDE])
    const displays = electronDisplays(screen.api)
    let heard = 0
    const stop = displays.onChange(() => heard++)
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.emit(event)
    expect(heard).toBe(3)
    stop()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.emit(event)
    expect(heard).toBe(3)
  })
})
