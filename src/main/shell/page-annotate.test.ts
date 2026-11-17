import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { PAGE_ANNOTATE_CHANNEL, PAGE_SHORTCUT, PAGE_TOGGLE_SHORTCUT, type PageAnnotateState } from '@shared/page-annotate'
import { BAR_METRICS, BAR_SNAP_DISTANCE, barBounds, dropZones, type BarContent } from '@shared/annotate-bar'
import { DEFAULT_BAR_POSITION, type BarPosition } from '@shared/annotate-bar-position'
import type { Bounds, PageKey } from '../engine/types'
import { drawn, hostOf, stroke, stubWindow, type StubWindow } from '../../shared/page-annotate-test-support'
import { PageAnnotate, notifyAnnotateRequest, notifyOwnWindowShare, notifyPageDocument, type PageAnnotateDeps, type PageAnnotateTarget } from './page-annotate'
import { ghostCall, ghostPage, tokenDeclaration } from './annotate-bar-ghost'
import { setLockService } from '../lock-service'
import type { AutoClear } from '@shared/annotate-auto-clear'

const BAR_WIDTH = BAR_METRICS.column.width
const BAR_HEIGHT = BAR_METRICS.column.height

// Electron replaced: the command window is a plain object, the handlers of ipcMain and the shortcut are recorded.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** The listeners of `ipcMain.on` (the drag of the grip is sent, not asked). */
  listeners: new Map<string, (...args: any[]) => void>(),
  /** The native menus the bar popped up: what was in them, and where they opened. */
  menus: [] as Array<{ template: any[]; options: Record<string, unknown> }>,
  windows: [] as Array<{
    webContents: { id: number; mainFrame: object; send: ReturnType<typeof vi.fn> }
    closed: Array<() => void>
    destroyed: boolean
    close(): void
    bounds: Bounds[]
    onTop: unknown[]
    options: Record<string, unknown>
    hidden: boolean
    visible: boolean
    url: string
    ignoresMouse: boolean
    /** How many times the window was brought above the others. */
    topped: number
    /** The scripts the main process ran in its page (`executeJavaScript`), and what to do with the next one. */
    scripts: string[]
    /** The listeners of the web contents by event, and the way to fire one as Electron would. */
    events: Map<string, Array<(...args: any[]) => void>>
    emit(event: string, ...args: any[]): void
  }>,
  /** Whether a window finishes loading its page at once (when `loadURL` is called). A test that wants to hold the load back turns it off. */
  autoLoad: { value: true },
  /** The next script run in a page fails with this error, when set. */
  scriptError: { value: null as Error | null },
  register: vi.fn(),
  unregister: vi.fn(),
  taken: { value: false },
  /** The annotated share of a window (this application) holds ⌥⌘P: `isRegistered` says yes. */
  own: { value: false }
}))

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false
    closed: Array<() => void> = []
    webContents: { id: number; mainFrame: object; send: ReturnType<typeof vi.fn>; setWindowOpenHandler: () => void; on: (event: string, listener: (...args: any[]) => void) => void; executeJavaScript: (script: string) => Promise<unknown> }
    options: Record<string, unknown>
    visible = false
    url = ''
    ignoresMouse = false
    topped = 0
    scripts: string[] = []
    events = new Map<string, Array<(...args: any[]) => void>>()
    constructor(options: Record<string, unknown>) {
      this.options = options
      const id = 100 + electron.windows.length
      this.webContents = {
        id,
        mainFrame: {},
        send: vi.fn(),
        setWindowOpenHandler: () => undefined,
        on: (event, listener) => void this.events.set(event, [...(this.events.get(event) ?? []), listener]),
        executeJavaScript: (script) => {
          this.scripts.push(script)
          return electron.scriptError.value ? Promise.reject(electron.scriptError.value) : Promise.resolve(undefined)
        }
      }
      electron.windows.push(this as never)
      ;(this as unknown as { id: number }).id = id
    }
    emit(event: string, ...args: any[]): void {
      for (const listener of this.events.get(event) ?? []) listener(...args)
    }
    moveTop(): void {
      this.topped++
    }
    once(): void {}
    on(event: string, listener: () => void): void {
      if (event === 'closed') this.closed.push(listener)
    }
    bounds: Bounds[] = []
    onTop: unknown[] = []
    setBounds(bounds: Bounds): void {
      this.bounds.push(bounds)
    }
    setAlwaysOnTop(...args: unknown[]): void {
      this.onTop.push(args)
    }
    hidden = false
    show(): void {
      this.hidden = false
      this.visible = true
    }
    showInactive(): void {
      this.visible = true
    }
    hide(): void {
      this.hidden = true
      this.visible = false
    }
    isVisible(): boolean {
      return this.visible
    }
    setIgnoreMouseEvents(ignore: boolean): void {
      this.ignoresMouse = ignore
    }
    loadURL(url: string): Promise<void> {
      this.url = url
      if (electron.autoLoad.value) this.emit('did-finish-load')
      return Promise.resolve()
    }
    destroy(): void {
      this.destroyed = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      for (const listener of this.closed) listener()
    }
  }
  return {
    BrowserWindow,
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => electron.handlers.set(channel, handler),
      on: (channel: string, listener: (...args: any[]) => void) => electron.listeners.set(channel, listener)
    },
    Menu: { buildFromTemplate: (template: any[]) => ({ popup: (options: Record<string, unknown>) => electron.menus.push({ template, options }) }) },
    globalShortcut: {
      register: (accelerator: string, callback: () => void) => {
        electron.register(accelerator, callback)
        return !electron.taken.value
      },
      unregister: electron.unregister,
      // Electron only knows the shortcuts of this application: one held by another application is not « registered ».
      isRegistered: () => electron.own.value
    }
  }
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A page of the test: its own stub window, which runs the calls of the layer as the layer's world of the page would (`runAnnotateLayer`). The two
 * ways into the page's own world (`runScript`, `evaluate`) are there to be watched: the annotation never takes them.
 */
function fakePage(id: string, win: StubWindow = stubWindow()) {
  // The keys of the page: the listener the bar gave (watchInput), called by the test as the shell would.
  const keys: { listener: ((key: PageKey) => void) | null } = { listener: null }
  return {
    id,
    win,
    keys,
    runScript: vi.fn(),
    evaluate: vi.fn(async () => undefined as unknown),
    runAnnotateLayer: vi.fn(async (js: string) => new Function('window', `return ${js}`)(win) as unknown),
    watchInput: vi.fn((listener: (key: PageKey) => void) => {
      keys.listener = listener
      return () => {
        keys.listener = null
      }
    })
  }
}
/** A key press of the page, as the shell hands it to the bar. */
const press = (key: string, modifiers: Partial<PageKey> = {}): PageKey => ({ type: 'keyDown', code: `Key${key.toUpperCase()}`, key, meta: false, control: false, alt: false, shift: false, isAutoRepeat: false, ...modifiers })
let placement: { window: Bounds; area: Bounds } | null
/** Whether the hint of the first use was seen (Settings.annotateBarHintSeen); true unless a test is about the hint, and how many times the bar asked to remember it. */
let hintSeen = true
let hintRemembered = 0
/** Where the settings say the bar stands (Settings.annotateBar), and what the bar asked them to keep. */
let barPosition: BarPosition = DEFAULT_BAR_POSITION
const saved: BarPosition[] = []
/** How many times the bar asked where the window is. */
let placementCalls = 0
/** The listeners the controller gave to watch the window: the tests call them as the window's moves would. */
const watchers = new Set<() => void>()
type FakePage = ReturnType<typeof fakePage>

let target: PageAnnotateTarget | null
const load = vi.fn()
const changed = vi.fn()
let deps: PageAnnotateDeps
let annotate: PageAnnotate

/** A message from the top frame of the page whose web contents has this id (a window of the test, or a page that is none of them). */
function fromMain(id: number): { sender: { id: number; mainFrame: object }; senderFrame: object } {
  const mainFrame = electron.windows.find((window) => window.webContents.id === id)?.webContents.mainFrame ?? {}
  return { sender: { id, mainFrame }, senderFrame: mainFrame }
}

/** A call from the command window (its sender is the command window's web contents). */
function fromCommand(channel: string, payload?: unknown, sender = commandId()): unknown {
  return electron.handlers.get(channel)!(fromMain(sender), payload)
}
const commandId = (): number => electron.windows[0]!.webContents.id
const lastState = (): PageAnnotateState => {
  const sends = electron.windows[0]!.webContents.send.mock.calls
  return sends[sends.length - 1]![1] as PageAnnotateState
}
/** The media source id of the window the tests annotate in, and the one that is focused unless a test says otherwise. */
const OWN = 'win-1'
let focusedWindow: string | null = OWN
/** A page in a second window (the tests give it a source of its own). */
let other: PageAnnotateTarget | null = null
const notice = vi.fn()
/** Réglages › Outils web › « ⌥⌘M depuis toute application » (off by default). */
let globalToggle = false
const asTarget = (page: FakePage, url = 'https://example.org/a', tabId = `tab-${page.id}`): PageAnnotateTarget => ({ tabId, page: page as never, url, source: OWN })

beforeEach(() => {
  electron.handlers.clear()
  electron.listeners.clear()
  electron.menus.length = 0
  load.mockClear()
  changed.mockClear()
  electron.windows.length = 0
  electron.register.mockReset()
  electron.unregister.mockReset()
  electron.taken.value = false
  electron.own.value = false
  target = null
  other = null
  barPosition = DEFAULT_BAR_POSITION
  saved.length = 0
  placementCalls = 0
  hintSeen = true
  hintRemembered = 0
  electron.autoLoad.value = true
  electron.scriptError.value = null
  focusedWindow = OWN
  notice.mockClear()
  globalToggle = false
  deps = {
    globalToggle: () => globalToggle,
    target: (window) => [target, other].find((item) => item !== null && item.source === (window ?? focusedWindow)) ?? null,
    focusedSource: () => focusedWindow,
    notice,
    watch: (listener) => {
      watchers.add(listener)
      return () => void watchers.delete(listener)
    },
    load,
    preload: '/preload/page-annotate-command.js',
    language: () => 'fr',
    changed,
    placement: () => {
      placementCalls++
      return placement
    },
    position: () => barPosition,
    setPosition: (position) => {
      saved.push(position)
      barPosition = position
    },
    hintSeen: () => hintSeen,
    setHintSeen: () => {
      hintSeen = true
      hintRemembered++
    }
  }
  // The shared window shows a page: a default place (the tests that check the place give their own).
  placement = { window: { x: 200, y: 100, width: 800, height: 500 }, area: { x: 0, y: 0, width: 1440, height: 900 } }
  watchers.clear()
  annotate = new PageAnnotate(deps)
})

afterEach(() => {
  annotate.dispose()
})

/** The callback the shell registered for an accelerator (the mock records every registration). */
const shortcutOf = (accelerator: string): () => void => electron.register.mock.calls.find((call) => call[0] === accelerator)![1] as () => void

describe('the split view', () => {
  // Guard: in a split view the page that has the focus is the one annotated, and the other pane's page never gets a layer: the target is the
  // active tab only. Without the focus rule, the other pane would be drawn on (the page of the call, for instance).
  it('annotates the page with the focus; the other pane gets no layer until the focus moves to it', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    annotate.start()
    await flush()
    expect(hostOf(a.win).style['pointerEvents']).toBe('auto')
    expect(b.runAnnotateLayer).not.toHaveBeenCalled()
    expect(b.runAnnotateLayer).not.toHaveBeenCalled()
    // The focus moves to the other pane: its page is the target now, and the first pane's layer is hidden (kept, not drawn on).
    target = asTarget(b, 'https://example.org/liora', 'tab-b')
    annotate.sync()
    await flush()
    expect(hostOf(a.win).style['display']).toBe('none')
    expect(hostOf(b.win).style['pointerEvents']).toBe('auto')
  })
})

describe('the window that the sharing chose', () => {
  // Guard: the window shared is the one of the choice, even when the page that asked is in another window of Lucium: the annotation starts
  // on its page, in its window, and not in the window of the request. Without the move, the layer would stay out of the shared page.
  it('starts the annotation on the page of the chosen window, not in the window of the request', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    other = { ...asTarget(b, 'https://example.org/liora', 'tab-b'), source: 'win-2' }
    focusedWindow = OWN
    notifyOwnWindowShare('tab-b', b as never, 'win-2')
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(hostOf(b.win).style['pointerEvents']).toBe('auto')
    expect(a.runAnnotateLayer).not.toHaveBeenCalled()
  })

  // Guard: a second sharing of the window the session runs in keeps the session: its layer is not taken away and put back. Without the early
  // return, the session would stop and start again on the same page.
  it('a second sharing of the same window keeps the session and its layer', async () => {
    const b = fakePage('b')
    other = { ...asTarget(b, 'https://example.org/liora', 'tab-b'), source: 'win-2' }
    notifyOwnWindowShare('tab-b', b as never, 'win-2')
    await flush()
    b.runAnnotateLayer.mockClear()
    notifyOwnWindowShare('tab-b', b as never, 'win-2')
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(b.runAnnotateLayer.mock.calls.some((call) => String(call[0]).includes('"remove"') || String(call[0]).includes("'remove'"))).toBe(false)
  })

})

describe('the window of the session', () => {
  // Guard: once a window is shared, another window cannot start the annotation: it is refused, with the notice. Without the check, the call
  // window would get the bar and the layer, as the participants saw it in the picture.
  it('another window is refused once a window is shared, and says to share this one', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, 'win-2')
    await flush()
    expect(annotate.isOn()).toBe(false)
    annotate.start()
    expect(annotate.isOn()).toBe(false)
    expect(notice).toHaveBeenCalledWith(t('page-annotate.partager-cette-fenetre'))
    expect(electron.windows).toHaveLength(0)
  })



  // Guard: a session that runs in another window moves to the shared one when that window starts sharing. Without the move, the session
  // would keep the layer of the window it was started in, and the shared page would stay without one.
  it('a session started in a window moves to the window shared later', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    other = { ...asTarget(b, 'https://meet.example/room', 'tab-b'), source: 'win-2' }
    annotate.start()
    await flush()
    expect(hostOf(a.win).style['display']).not.toBe('none')
    notifyOwnWindowShare('tab-b', b as never, 'win-2')
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(hostOf(b.win).style['pointerEvents']).toBe('auto')
    // The layer of the window the session left is taken away: no layer is left on a page without a session.
    expect(a.win.document.documentElement!.children.filter((child) => child.tagName === 'div')).toHaveLength(0)
  })

  // Guard: the bar stays above the shared window whatever has the focus: another window of Lucium (the call, in front) or another application.
  // Without it, the bar hid itself with the focus of the window of the request.
  it('the bar stays visible whatever has the focus: another window of Lucium, or another application', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, OWN)
    await flush()
    expect(electron.windows[0]!.hidden).toBe(false)
    focusedWindow = 'win-2'
    annotate.sync()
    expect(electron.windows[0]!.hidden).toBe(false)
    focusedWindow = OWN
    annotate.sync()
    expect(electron.windows[0]!.hidden).toBe(false)
  })

  // Guard: the bar is hidden when its window shows no page to annotate, and shown again when one is back.
  it('the bar is hidden when the shared window shows no page, and shown again with one', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, OWN)
    await flush()
    placement = null
    annotate.sync()
    expect(electron.windows[0]!.hidden).toBe(true)
    placement = { window: { x: 200, y: 100, width: 800, height: 500 }, area: { x: 0, y: 0, width: 1440, height: 900 } }
    annotate.sync()
    expect(electron.windows[0]!.hidden).toBe(false)
  })

  // After a recognised share the bar shows and the button shows; the navigation of the page ends both.
  it('after a recognised share the bar shows and the button shows; the navigation of the page ends both', async () => {
    const a = fakePage('a')
    target = { ...asTarget(a, 'https://meet.example/room', 'tab-a'), source: 'win-share-x' }
    notifyOwnWindowShare('tab-a', a as never, 'win-share-x')
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(electron.windows[0]!.hidden).toBe(false)
    notifyPageDocument('tab-a', a as never)
    expect(annotate.isOn()).toBe(false)
  })
})

describe('the look of the laser', () => {
  // Guard: the look chosen in the bar reaches the layers, and it is kept for the session: a new annotation starts with the same look.
  // Without the memory, a new session would fall back to the classic look.
  it('is kept for the session: the layers take it, and a new annotation starts with it', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.laser, 'lumiere')
    expect(lastState().laser).toBe('lumiere')
    expect(a.runAnnotateLayer.mock.calls.some((call) => String(call[0]).includes('"laser":"lumiere"'))).toBe(true)
    annotate.stop()
    annotate.start()
    await flush()
    expect(lastState().laser).toBe('lumiere')
  })

  // Guard: a look outside the list is refused: the state keeps the one it had.
  it('refuses a look outside the list', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.laser, 'rainbow')
    expect(lastState().laser).toBe('lumiere')
  })
})

describe('the automatic clearing', () => {
  /** The setting as the settings hold it (0: off, else seconds), what the timer button wrote, and Lucium's « Réduire les animations ». */
  let clearing: AutoClear = 0
  let written: AutoClear[] = []
  let still = false
  beforeEach(() => {
    clearing = 0
    written = []
    still = false
    annotate.dispose()
    annotate = new PageAnnotate({
      ...deps,
      autoClear: () => clearing,
      setAutoClear: (value) => {
        written.push(value)
        clearing = value
      },
      reduceMotion: () => still
    })
  })
  const callsOf = (page: FakePage): string[] => page.runAnnotateLayer.mock.calls.map((call) => String(call[0]))
  const applied = (page: FakePage): string[] => callsOf(page).filter((call) => call.includes('(window, "apply",'))

  // Guard: the delay of the settings reaches the layers in milliseconds, with the wish of less motion, and the bar shows it. Without it in `layerConfig`, no
  // layer would ever clear; without it in the state, the bar's button would show « off » whatever the setting says.
  it('gives the layers the delay of the settings, and shows it in the bar', async () => {
    clearing = 5
    still = true
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    expect(callsOf(a).some((call) => call.includes('(window, "mount",') && call.includes('"autoClear":5000') && call.includes('"still":true'))).toBe(true)
    expect(lastState().autoClear).toBe(5)
  })

  // Guard: the timer button writes the setting, and the layers (on screen or not) and the bar follow at once. Only off and the delays of the list are taken,
  // and only from the bar: main checks again what the page of the bar sends.
  it('takes the choice of the timer button to the settings, the layers and the bar, and nothing else', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    target = asTarget(b)
    annotate.sync()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.autoClear, 10)
    expect(written).toEqual([10])
    expect(lastState().autoClear).toBe(10)
    expect(applied(a).at(-1)).toContain('"autoClear":10000')
    expect(applied(b).at(-1)).toContain('"autoClear":10000')
    for (const bad of [7, '10', -3, null, 1e9, { seconds: 10 }]) fromCommand(PAGE_ANNOTATE_CHANNEL.autoClear, bad)
    fromCommand(PAGE_ANNOTATE_CHANNEL.autoClear, 0, 999)
    expect(written).toEqual([10])
    fromCommand(PAGE_ANNOTATE_CHANNEL.autoClear, 0)
    expect(written).toEqual([10, 0])
    expect(lastState().autoClear).toBe(0)
    expect(applied(b).at(-1)).toContain('"autoClear":0')
  })

  // Guard: a change of the settings that is not the clearing tells the layers nothing: an `apply` is activity on the page on screen, and would hold its
  // marks for one more delay at each change of any setting.
  it('follows a change of the setting made elsewhere once, and tells the layers nothing for another change', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    const before = applied(a).length
    const told = electron.windows[0]!.webContents.send.mock.calls.length
    annotate.refreshAutoClear()
    expect(applied(a).length).toBe(before)
    expect(electron.windows[0]!.webContents.send.mock.calls.length).toBe(told)
    clearing = 20
    annotate.refreshAutoClear()
    annotate.refreshAutoClear()
    expect(applied(a).length).toBe(before + 1)
    expect(applied(a).at(-1)).toContain('"autoClear":20000')
    expect(lastState().autoClear).toBe(20)
    // Less motion asked for in Lucium: the layers take it.
    still = true
    annotate.refreshAutoClear()
    expect(applied(a).at(-1)).toContain('"still":true')
  })


  /** Runs `body` with the clock of the test: main's timers and the time the layers read. */
  async function withClock(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      await body()
    } finally {
      vi.useRealTimers()
    }
  }
  const asked = (page: FakePage): number => callsOf(page).filter((call) => call.includes('(window, "expire",')).length

  // Guard: every page that holds a layer has its clock, on screen or not: a page left with marks has them cleared after the delay, at once (nobody sees it
  // fade). The clocks stop with the session: no timer is left behind.
  it('keeps a clock for each page of the session, on screen or not, and none once it ends', async () => {
    await withClock(async () => {
      clearing = 3
      const a = fakePage('a')
      const b = fakePage('b')
      target = asTarget(a)
      annotate.start()
      await vi.advanceTimersByTimeAsync(0)
      stroke(a.win, [10, 10], [200, 200])
      target = asTarget(b)
      annotate.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(hostOf(a.win).style['display']).toBe('none')
      expect(drawn(a.win)).toBe(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(drawn(a.win)).toBe(0)
      expect(asked(b)).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(2)
      annotate.stop()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  // Guard: no clock runs while the clearing is off; switched on during the session, every layer is asked at once; switched off, the clocks stop.
  it('runs no clock while the setting is off, and follows it when it changes', async () => {
    await withClock(async () => {
      const a = fakePage('a')
      target = asTarget(a)
      annotate.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(asked(a)).toBe(0)
      clearing = 5
      annotate.refreshAutoClear()
      await vi.advanceTimersByTimeAsync(0)
      expect(asked(a)).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      clearing = 0
      annotate.refreshAutoClear()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  // Guard (no error swallowed): a layer that cannot answer (the page went away, the script threw) is logged with the reason, and its clock stops.
  it('logs a layer that cannot answer, and stops its clock', async () => {
    await withClock(async () => {
      clearing = 3
      const a = fakePage('a')
      target = asTarget(a)
      const real = a.runAnnotateLayer.getMockImplementation()!
      a.runAnnotateLayer.mockImplementation(async (js: string) => (js.includes('(window, "expire",') ? Promise.reject(new Error('the frame went away')) : real(js)))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        annotate.start()
        await vi.advanceTimersByTimeAsync(0)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[page-annotate] the layer could not say whether its marks are to be cleared'), expect.objectContaining({ message: 'the frame went away' }))
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })
  })

  // Guard: what the layer answers is bounded before main waits on it: no busy loop, no wait past what a timer can hold (it would run at once), and an answer
  // that is not a positive number stops the clock (a layer that is gone answers false).
  it('bounds what the layer answers, and stops on an answer that is not a delay', async () => {
    await withClock(async () => {
      clearing = 3
      const a = fakePage('a')
      target = asTarget(a)
      let answer: unknown = 1e12
      const real = a.runAnnotateLayer.getMockImplementation()!
      a.runAnnotateLayer.mockImplementation(async (js: string) => (js.includes('(window, "expire",') ? answer : real(js)))
      annotate.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(asked(a)).toBe(1)
      await vi.advanceTimersByTimeAsync(3_600_000 - 1)
      expect(asked(a)).toBe(1)
      answer = 1
      await vi.advanceTimersByTimeAsync(1)
      expect(asked(a)).toBe(2)
      // A wait of 1 ms is held to 50: the layer is not asked in a busy loop.
      await vi.advanceTimersByTimeAsync(49)
      expect(asked(a)).toBe(2)
      answer = false
      await vi.advanceTimersByTimeAsync(1)
      expect(asked(a)).toBe(3)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
  // Guard: the whole way, on a page of the session: a stroke goes once the delay of the setting has run out, and the Annuler of the bar brings it back.
  it('clears the page on screen after the delay, and the bar’s undo brings the marks back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      clearing = 3
      const a = fakePage('a')
      target = asTarget(a)
      annotate.start()
      await vi.advanceTimersByTimeAsync(0)
      stroke(a.win, [10, 10], [200, 200])
      expect(drawn(a.win)).toBe(1)
      await vi.advanceTimersByTimeAsync(2999)
      expect(drawn(a.win)).toBe(1)
      await vi.advanceTimersByTimeAsync(401)
      expect(drawn(a.win)).toBe(0)
      fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'undo')
      await vi.advanceTimersByTimeAsync(0)
      expect(drawn(a.win)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the toolbar button', () => {
  // Guard: the button of a window starts the annotation of that window and a second press ends it. Without the request listener, nothing happens.
  it('starts the annotation of its window, and a second press ends it', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    notifyAnnotateRequest(OWN)
    await flush()
    expect(annotate.isOn()).toBe(true)
    notifyAnnotateRequest(OWN)
    expect(annotate.isOn()).toBe(false)
  })

  // Guard: the sharing is over once the page that shared has a new document; then any window may start
  // the annotation again. Without it, the first sharing kept every other window refused until the application restarted.
  it('frees the other windows once the page that shared has a new document', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    notifyOwnWindowShare('tab-share', a as never, 'win-2')
    await flush()
    annotate.start()
    expect(annotate.isOn()).toBe(false)
    notifyPageDocument('tab-share', a as never)
    annotate.start()
    expect(annotate.isOn()).toBe(true)
  })

  // Guard: a shared window that was closed no longer holds the annotation to itself.
  it('frees the other windows once the shared window is closed', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    notifyOwnWindowShare('tab-share', a as never, 'win-2')
    await flush()
    deps.windowOpen = (window) => window !== 'win-2'
    annotate.start()
    expect(annotate.isOn()).toBe(true)
  })

  // Guard: a document of another tab does not end the sharing.
  it('keeps the shared window while only another tab changes its document', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    notifyOwnWindowShare('tab-share', a as never, 'win-2')
    await flush()
    deps.windowOpen = () => true
    notifyPageDocument('tab-a', a as never)
    annotate.start()
    expect(annotate.isOn()).toBe(false)
  })

  // Guard: under the same rule as ⌥⌘M, the button of a window that is not the shared one is refused, with the notice.
  it('the button of another window is refused once a window is shared', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, 'win-2')
    await flush()
    notifyAnnotateRequest(OWN)
    expect(annotate.isOn()).toBe(false)
    expect(notice).toHaveBeenCalledWith(t('page-annotate.partager-cette-fenetre'))
  })
})

describe('the shortcut ⌥⌘M', () => {
  const heldSystemWide = (): boolean => electron.register.mock.calls.some((call) => call[0] === PAGE_TOGGLE_SHORTCUT)

  // Guard: by default ⌥⌘M is the File menu's only, and no other application loses it. Without the setting
  // read, the controller would hold it system-wide from its start, as before.
  it('is not held system-wide by default: the File menu has it', () => {
    expect(heldSystemWide()).toBe(false)
    annotate.syncToggleShortcut()
    expect(heldSystemWide()).toBe(false)
  })

  // Guard: with the setting on, ⌥⌘M starts and stops the annotation from any application; switched off again, it is released at once.
  it('with the setting on, is held, starts the annotation and ends it; off again, it is released', async () => {
    const page = fakePage('a')
    target = asTarget(page)
    globalToggle = true
    annotate.syncToggleShortcut()
    shortcutOf(PAGE_TOGGLE_SHORTCUT)()
    await flush()
    expect(annotate.isOn()).toBe(true)
    shortcutOf(PAGE_TOGGLE_SHORTCUT)()
    expect(annotate.isOn()).toBe(false)
    globalToggle = false
    annotate.syncToggleShortcut()
    expect(electron.unregister).toHaveBeenCalledWith(PAGE_TOGGLE_SHORTCUT)
  })

  it('is released when the controller is disposed, if it was held', () => {
    globalToggle = true
    annotate.syncToggleShortcut()
    annotate.dispose()
    expect(electron.unregister).toHaveBeenCalledWith(PAGE_TOGGLE_SHORTCUT)
  })

  it('is asked for once when another application holds it, not at every change of the state', () => {
    electron.taken.value = true
    globalToggle = true
    annotate.syncToggleShortcut()
    annotate.syncToggleShortcut()
    expect(electron.register.mock.calls.filter((call) => call[0] === PAGE_TOGGLE_SHORTCUT)).toHaveLength(1)
    globalToggle = false
    annotate.syncToggleShortcut()
    expect(electron.unregister).not.toHaveBeenCalledWith(PAGE_TOGGLE_SHORTCUT)
  })

  it('is not released at the disposal when it was never held (another application may have it)', () => {
    annotate.dispose()
    expect(electron.unregister).not.toHaveBeenCalledWith(PAGE_TOGGLE_SHORTCUT)
  })
})

describe('starting the annotation', () => {
  it('puts a layer on the page on screen, and opens the command window in the language of the interface', async () => {
    const page = fakePage('a')
    target = asTarget(page)
    annotate.start()
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(hostOf(page.win).style['pointerEvents']).toBe('auto')
    expect(load).toHaveBeenCalledWith(expect.anything(), { lang: 'fr' })
    expect(electron.register).toHaveBeenCalledWith(PAGE_SHORTCUT, expect.any(Function))
    expect(changed).toHaveBeenCalled()
  })

  it('a page that is not a web page takes no layer: nothing is run in it, and the command window says so', async () => {
    const page = fakePage('a')
    target = asTarget(page, 'lucium://settings')
    annotate.start()
    await flush()
    expect(page.runAnnotateLayer).not.toHaveBeenCalled()
    expect(page.runAnnotateLayer).not.toHaveBeenCalled()
    expect(lastState().note).toBe('refused')
  })

  it('a page that refuses the layer (no document element) says so: the note is shown, nothing is kept', async () => {
    const page = fakePage('a', stubWindow({ html: false }))
    target = asTarget(page)
    annotate.start()
    await flush()
    expect(lastState().note).toBe('refused')
    expect(page.runAnnotateLayer).toHaveBeenCalledTimes(2)
  })

  it('a shortcut held by another application is not taken, and the state says so', async () => {
    electron.taken.value = true
    target = asTarget(fakePage('a'))
    annotate.start()
    await flush()
    expect(electron.register).toHaveBeenCalledWith(PAGE_SHORTCUT, expect.any(Function))
    expect(lastState().note).toBe('shortcut')
    annotate.stop()
    expect(electron.unregister).not.toHaveBeenCalledWith(PAGE_SHORTCUT)
  })

  it('a shortcut held by the annotated share of a window is not asked for, and the state says it is Lucium that holds it', async () => {
    electron.own.value = true
    target = asTarget(fakePage('a'))
    annotate.start()
    await flush()
    expect(electron.register).not.toHaveBeenCalledWith(PAGE_SHORTCUT, expect.any(Function))
    expect(lastState().note).toBe('shortcut-own')
    // The shortcut is the share's: ending the annotation does not take it away from it.
    annotate.stop()
    expect(electron.unregister).not.toHaveBeenCalledWith(PAGE_SHORTCUT)
  })
})

describe('the page on screen', () => {
  it('switching tabs hides the layer of the page left and shows the one of the page now on screen, with its drawing kept', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    target = asTarget(b)
    annotate.sync()
    await flush()
    expect(hostOf(a.win).style['display']).toBe('none')
    expect(hostOf(b.win).style['display']).not.toBe('none')
    target = asTarget(a)
    annotate.sync()
    await flush()
    expect(hostOf(a.win).style['display']).toBe('')
    expect(drawn(a.win)).toBe(1)
  })

  // Guard: the page left takes no pointer and ends its stroke. Without the hide (or without `settle` in it), the layer of the page left would
  // capture the clicks of the sidebar and of the other tabs.
  it('the page left takes no pointer: its layer is hidden and click-through, and its stroke in progress is ended', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    hostOf(a.win).dispatch('pointerdown', { clientX: 10, clientY: 10 })
    target = asTarget(b)
    annotate.sync()
    await flush()
    expect(hostOf(a.win).style['pointerEvents']).toBe('none')
    expect(hostOf(a.win).style['display']).toBe('none')
    hostOf(a.win).dispatch('pointermove', { clientX: 200, clientY: 200 })
    hostOf(a.win).dispatch('pointerup', {})
    expect(drawn(a.win)).toBe(0)
    expect(hostOf(b.win).style['pointerEvents']).toBe('auto')
  })

  // Guard: a navigation erases the drawing of the page on screen. Without `notifyPageDocument` → `documentChanged`, the stroke would stay.
  it('a new document of the page on screen erases its drawing: the layer starts again empty', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    expect(drawn(a.win)).toBe(1)
    notifyPageDocument('tab-a', a as never)
    await flush()
    expect(drawn(a.win)).toBe(0)
    expect(hostOf(a.win).style['display']).not.toBe('none')
  })

  // Guard: a page that leaves the screen loses its layer when its document changes: the layer of the old document must not come back.
  it('a new document of a page that is off screen takes its layer away; the layer comes back empty when it is on screen again', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    target = asTarget(b)
    annotate.sync()
    await flush()
    notifyPageDocument('tab-a', a as never)
    expect(a.win.document.documentElement!.children).toHaveLength(0)
    target = asTarget(a)
    annotate.sync()
    await flush()
    expect(drawn(a.win)).toBe(0)
  })

  it('an edit (undo, clear) goes to the page on screen', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'clear')
    expect(drawn(a.win)).toBe(0)
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'undo')
    expect(drawn(a.win)).toBe(1)
  })

  // Guard: the clear of the page clears the page on screen only; the clear of all pages clears every page of the session, the one on screen
  // and the ones left. Without the loop over the layered pages, a page left would keep its marks after the clear of all pages.
  it('the clear of the page keeps the other pages; the clear of all pages clears every page of the session', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    target = asTarget(b)
    annotate.sync()
    await flush()
    stroke(b.win, [10, 10], [300, 300])
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'clear')
    expect(drawn(b.win)).toBe(0)
    expect(drawn(a.win)).toBe(1)
    target = asTarget(a)
    annotate.sync()
    await flush()
    stroke(a.win, [50, 50], [60, 60])
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'clear-all')
    expect(drawn(a.win)).toBe(0)
    expect(drawn(b.win)).toBe(0)
  })

  // Guard: each page keeps its own history: after the clear of all pages, ⌘Z restores the page on screen only; the page left stays empty.
  it('undoing after the clear of all pages restores the page on screen only', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    target = asTarget(b)
    annotate.sync()
    await flush()
    stroke(b.win, [10, 10], [300, 300])
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'clear-all')
    fromCommand(PAGE_ANNOTATE_CHANNEL.edit, 'undo')
    expect(drawn(b.win)).toBe(1)
    expect(drawn(a.win)).toBe(0)
  })
})

describe('the mode and the brush', () => {
  // Guard: one switch, applied to every layer (on screen or not). Without the loop in `applyToLayers`, the hidden page keeps drawing.
  it('the pass mode reaches every layer, on screen or not', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    target = asTarget(b)
    annotate.sync()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.mode, 'pass')
    expect(hostOf(a.win).style['pointerEvents']).toBe('none')
    expect(hostOf(b.win).style['pointerEvents']).toBe('none')
    expect(lastState()).toMatchObject({ on: true, mode: 'pass' })
  })

  it('the shortcut ⌥⌘P switches between drawing and passing', async () => {
    target = asTarget(fakePage('a'))
    annotate.start()
    await flush()
    const callback = electron.register.mock.calls.find((call) => call[0] === PAGE_SHORTCUT)![1] as () => void
    callback()
    expect(lastState().mode).toBe('pass')
    callback()
    expect(lastState().mode).toBe('draw')
  })

  it('a brush of the palette reaches the layer; a value outside the palette is refused', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'rectangle', color: '#1e88e5', width: 10 })
    expect(lastState().brush).toEqual({ tool: 'rectangle', color: '#1e88e5', width: 10 })
    const sent = a.runAnnotateLayer.mock.calls.length
    fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'select', color: '#1e88e5', width: 10 })
    expect(a.runAnnotateLayer).toHaveBeenCalledTimes(sent)
    expect(lastState().brush.tool).toBe('rectangle')
  })

  // Guard: only the command window may send. Without the sender check, another window could change the mode.
  it('a message from a window other than the command window is refused', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.mode, 'pass', 999)
    fromCommand(PAGE_ANNOTATE_CHANNEL.stop, undefined, 999)
    expect(annotate.isOn()).toBe(true)
    expect(hostOf(a.win).style['pointerEvents']).toBe('auto')
  })

  // The annotation stops when the application locks; a bar that is still there must not change anything behind the lock screen.
  it('a message of the command window is refused while the application is locked, and the log says so', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    try {
      fromCommand(PAGE_ANNOTATE_CHANNEL.mode, 'pass')
      expect(fromCommand(PAGE_ANNOTATE_CHANNEL.state)).toBeNull()
      expect(hostOf(a.win).style['pointerEvents']).toBe('auto')
      expect(warn).toHaveBeenCalledWith('[lock] ignored the annotation bar: the application is locked')
      locked = false
      fromCommand(PAGE_ANNOTATE_CHANNEL.mode, 'pass')
      expect(hostOf(a.win).style['pointerEvents']).toBe('none')
    } finally {
      setLockService(null)
      warn.mockRestore()
    }
  })
})

describe('ending the annotation', () => {
  it('takes every layer away, releases the shortcut and closes the command window', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    target = asTarget(b)
    annotate.sync()
    await flush()
    annotate.stop()
    expect(a.win.document.documentElement!.children).toHaveLength(0)
    expect(b.win.document.documentElement!.children).toHaveLength(0)
    expect(electron.unregister).toHaveBeenCalledWith(PAGE_SHORTCUT)
    expect(electron.windows[0]!.destroyed).toBe(true)
    expect(annotate.isOn()).toBe(false)
  })

  it('the stop of the command window ends the annotation too, and the state says so', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.stop)
    expect(annotate.isOn()).toBe(false)
    expect(a.win.document.documentElement!.children).toHaveLength(0)
  })

  it('closing the command window by hand ends the annotation', async () => {
    target = asTarget(fakePage('a'))
    annotate.start()
    await flush()
    electron.windows[0]!.close()
    expect(annotate.isOn()).toBe(false)
  })

  it('the menu entry starts, then ends, the annotation', async () => {
    target = asTarget(fakePage('a'))
    annotate.toggle()
    expect(annotate.isOn()).toBe(true)
    annotate.toggle()
    expect(annotate.isOn()).toBe(false)
  })

  it('nothing reaches the pages once the annotation is off: a navigation does not put a layer back', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    annotate.stop()
    notifyPageDocument('tab-a', a as never)
    annotate.sync()
    await flush()
    expect(a.win.document.documentElement!.children).toHaveLength(0)
  })
})

describe('a call that fails in the page', () => {
  // Guard: a failed call is logged, and the page takes no layer (the note says so). Without the log, the cause would disappear.
  it('is logged with its cause, and the command window says the page takes no layer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = fakePage('a')
    page.runAnnotateLayer.mockRejectedValue(new Error('the page went away'))
    target = asTarget(page)
    annotate.start()
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page-annotate'), expect.any(Error))
    expect(lastState().note).toBe('refused')
    warn.mockRestore()
  })
})

describe('the world the layer runs in', () => {
  // Guard: every call of a session goes to the layer's own world of the page. One call sent to the page's own world would put the layer, or
  // a second one, where the scripts of the page read the drawing and the text.
  it('is its own, for every call of a session: making the layer, the brush, a key, an edit, another page on screen, a new document, the end', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a, 'https://example.org/a', 'tab-a')
    annotate.start()
    await flush()
    fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'rectangle', color: '#1e88e5', width: 10 })
    stroke(a.win, [10, 10], [200, 200])
    a.keys.listener!({ type: 'keyDown', code: 'KeyZ', key: 'z', meta: true, shift: false, control: false, alt: false, isAutoRepeat: false })
    await flush()
    annotate.edit('clear')
    annotate.edit('clear-all')
    annotate.setLaser('lumiere')
    target = asTarget(b, 'https://example.org/b', 'tab-b')
    annotate.sync()
    await flush()
    notifyPageDocument('tab-b', b as never)
    notifyPageDocument('tab-a', a as never)
    await flush()
    annotate.stop()
    await flush()
    for (const page of [a, b]) {
      expect(page.runAnnotateLayer.mock.calls.length).toBeGreaterThan(2)
      expect(page.runScript).not.toHaveBeenCalled()
      expect(page.evaluate).not.toHaveBeenCalled()
    }
    const sent = a.runAnnotateLayer.mock.calls.map((call) => /\(window, "([a-z]+)"/.exec(String(call[0]))?.[1])
    for (const action of ['show', 'mount', 'apply', 'editing', 'undo', 'clear', 'hide', 'remove']) expect(sent, action).toContain(action)
  })

  // Guard: a page that has no world for the layer takes no layer, and says so; it is not given one in its own world instead.
  it('a page without that world takes no layer: the note says so, and nothing runs in the page', async () => {
    const { runAnnotateLayer: _none, ...page } = fakePage('a')
    target = asTarget(page as never)
    annotate.start()
    await flush()
    expect(lastState().note).toBe('refused')
    expect(page.runScript).not.toHaveBeenCalled()
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(page.win.document.documentElement!.children).toHaveLength(0)
  })

  // Guard: a call nothing waits for (an edit, the brush, hide, remove) that fails is logged with its cause. Without it the failure would be lost.
  it('logs a call that fails though nothing waits for its answer', async () => {
    const page = fakePage('a')
    target = asTarget(page)
    annotate.start()
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    page.runAnnotateLayer.mockRejectedValue(new Error('the page is gone'))
    annotate.edit('undo')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page-annotate'), expect.objectContaining({ message: 'the page is gone' }))
    warn.mockRestore()
  })

  // Guard: a key whose page cannot say whether a field has the keys does nothing (the tool stays), and the failure is logged.
  it('a key does nothing when the page cannot say whether a field has the keys, and the failure is logged', async () => {
    const page = fakePage('a')
    target = asTarget(page)
    annotate.start()
    await flush()
    const tool = lastState().brush.tool
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    page.runAnnotateLayer.mockRejectedValue(new Error('the page is gone'))
    page.keys.listener!({ type: 'keyDown', code: 'KeyR', key: 'r', meta: false, shift: false, control: false, alt: false, isAutoRepeat: false })
    await flush()
    expect(lastState().brush.tool).toBe(tool)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('whether a field has the keys'), expect.objectContaining({ message: 'the page is gone' }))
    warn.mockRestore()
  })
})

describe('a layer made while the session changes', () => {
  /** The page answers only once `release` is called: the layer is made while the session moves on. */
  function gated(page: ReturnType<typeof fakePage>): () => void {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const answer = page.runAnnotateLayer.getMockImplementation()!
    page.runAnnotateLayer.mockImplementation(async (js: string) => {
      await gate
      return answer(js)
    })
    return release
  }

  // Guard: a layer made after the page left the screen is hidden at once. Without it, it would stay on screen when the page comes back.
  it('is hidden when the page left the screen while it was made, and taken away when the annotation ends', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    const release = gated(a)
    target = asTarget(a)
    annotate.start()
    target = asTarget(b)
    annotate.sync()
    await flush()
    release()
    await flush()
    expect(hostOf(a.win).style['display']).toBe('none')
    annotate.stop()
    // The page of this test answers after a turn (the gate): so does the call that takes its layer away.
    await flush()
    expect(a.win.document.documentElement!.children).toHaveLength(0)
  })

  // Guard: a layer made after the annotation ended is taken away at once. Without it, a page would keep a layer no session owns.
  it('is taken away at once when the annotation ended while it was made', async () => {
    const a = fakePage('a')
    const release = gated(a)
    target = asTarget(a)
    annotate.start()
    annotate.stop()
    release()
    await flush()
    await flush()
    expect(a.win.document.documentElement!.children).toHaveLength(0)
  })
})

describe('the bar', () => {
  // Guard: the first click on the bar works while the window is not active (macOS would only activate the window and lose the click).
  it('accepts the first click, so that a tool chosen at once takes effect', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    expect(electron.windows[0]!.options).toMatchObject({ acceptFirstMouse: true })
  })

  // Guard: the bar is as tall as its tools (it holds them without scrolling on a page of its height). Its height is the constant, clamped to the page.
  it('floats on the left edge of the shared window, inside it, as tall as its tools', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    placement = { window: { x: 200, y: 100, width: 800, height: 500 }, area: { x: 0, y: 0, width: 1440, height: 900 } }
    annotate.start()
    await flush()
    const bounds = electron.windows[0]!.bounds.at(-1)!
    expect(bounds.x).toBe(200 + 12)
    expect(bounds.width).toBe(BAR_WIDTH)
    expect(bounds.height).toBe(500 - 24)
    expect(bounds.y).toBe(100 + 12)
    expect(electron.windows[0]!.onTop.at(-1)).toEqual([true, 'floating'])
    expect(BAR_HEIGHT).toBe(1000)
  })

  // Guard: the bar is on the screen of the shared window, not of the window the user works in: its area is the one given for the shared window.
  // Without the screen of the window, the bar would be on the screen of the return.
  // Guard: a shared window that hangs over the edge of its screen keeps the bar on that screen: the bar is clamped to the screen's area, not to the window.
  it('keeps the bar on the screen of a window that hangs over the edge of it', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    const second = { x: 1440, y: 0, width: 1440, height: 900 }
    placement = { window: { x: 2850, y: 100, width: 800, height: 500 }, area: second }
    annotate.start()
    await flush()
    const bar = electron.windows[0]!.bounds.at(-1)!
    expect(bar.x).toBe(second.x + second.width - BAR_WIDTH)
    expect(bar.x + bar.width).toBeLessThanOrEqual(second.x + second.width)
  })

  it('sits on the screen of the shared window, and follows that window when it moves to another screen', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    const second = { x: 1440, y: 0, width: 1440, height: 900 }
    placement = { window: { x: 1600, y: 100, width: 800, height: 500 }, area: second }
    annotate.start()
    await flush()
    const first = electron.windows[0]!.bounds.at(-1)!
    expect(first.x).toBe(1600 + 12)
    expect(first.x).toBeGreaterThanOrEqual(second.x)
    // The shared window moves: the bar follows, on the watch of the controller.
    placement = { window: { x: 100, y: 50, width: 800, height: 500 }, area: { x: 0, y: 0, width: 1440, height: 900 } }
    for (const watcher of watchers) watcher()
    expect(electron.windows[0]!.bounds.at(-1)!.x).toBe(100 + 12)
  })
})

describe('the sharing of the window of Lucium', () => {
  // Guard: the annotation starts on the page that asked, when it is on screen. Without `ownWindowShared` the page annotation never starts by itself.
  it('a page on screen whose sharing took the window of Lucium starts the annotation, with no menu', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, OWN)
    await flush()
    expect(annotate.isOn()).toBe(true)
    expect(hostOf(a.win).style['display']).not.toBe('none')
  })

  // Guard: only the page on screen starts it. Without the check `current.tabId !== tabId`, a background tab would start the annotation on the page on screen.
  it('a page that is not on screen does not start it', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-b', b as never, OWN)
    await flush()
    expect(annotate.isOn()).toBe(false)
    expect(electron.windows).toHaveLength(0)
  })

  // Guard: the navigation of the page that started it ends the annotation. Without the `autoTab` check in documentChanged, the layer would be erased and the bar would stay.
  it('the navigation of the page that started it ends the annotation', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    notifyOwnWindowShare('tab-a', a as never, OWN)
    await flush()
    notifyPageDocument('tab-a', a as never)
    await flush()
    expect(annotate.isOn()).toBe(false)
    expect(a.win.document.documentElement!.children.some((child) => child.tagName === 'div')).toBe(false)
  })

  it('a session started by hand is not ended by a navigation of its page', async () => {
    const a = fakePage('a')
    target = asTarget(a, 'https://meet.example/room', 'tab-a')
    annotate.start()
    await flush()
    notifyPageDocument('tab-a', a as never)
    await flush()
    expect(annotate.isOn()).toBe(true)
  })
})

describe('the keys of the page', () => {
  it('a letter picks its tool in draw mode; the tool of the bar follows it', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    a.keys.listener!(press('d'))
    await flush()
    expect(lastState().brush.tool).toBe('diamond')
    expect(lastState().brush.tool).toBe('diamond')
    // E clears the page on screen: the brush stays where it is, and the drawing of the page goes.
    stroke(a.win, [10, 10], [200, 200])
    a.keys.listener!(press('E'))
    await flush()
    expect(drawn(a.win)).toBe(0)
    expect(lastState().brush.tool).toBe('diamond')
  })

  // Guard: X clears every page of the session (as ⇧⌥⌘⌫), and leaves the brush alone. Without the X branch, X would do nothing.
  it('X clears the drawing of every page', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    target = asTarget(b)
    annotate.sync()
    await flush()
    stroke(b.win, [10, 10], [300, 300])
    // The keys belong to the page on screen (b here): the bar listens to that page only.
    b.keys.listener!(press('x'))
    await flush()
    expect(drawn(a.win)).toBe(0)
    expect(drawn(b.win)).toBe(0)
  })

  describe('with the keys of one letter switched off (Réglages › Fonctions en option)', () => {
    let letters = true
    beforeEach(() => {
      letters = true
      annotate.dispose()
      annotate = new PageAnnotate({ ...deps, letterKeys: () => letters })
    })

    // Guard: a person who switched the letters off keeps them for the page: X would clear every page of the session, and E the page. Without the setting
    // in `key`, the letters would act whatever the switch says.
    it('leaves every letter to the page: no tool, no E, no X', async () => {
      const a = fakePage('a')
      target = asTarget(a)
      letters = false
      annotate.start()
      await flush()
      stroke(a.win, [10, 10], [200, 200])
      for (const letter of ['d', 'p', 'h', 'e', 'E', 'x', 'k']) a.keys.listener!(press(letter))
      await flush()
      expect(lastState().brush.tool).toBe('pen')
      expect(drawn(a.win)).toBe(1)
    })

    // Guard: only the letters go. ⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ and Escape are not keys of one letter, and the buttons of the bar do the same as the letters did.
    it('keeps ⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ and Escape, and the tools of the bar', async () => {
      const a = fakePage('a')
      target = asTarget(a)
      letters = false
      annotate.start()
      await flush()
      fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'diamond', color: '#e53935', width: 5 })
      expect(lastState().brush.tool).toBe('diamond')
      stroke(a.win, [10, 10], [200, 200])
      a.keys.listener!(press('z', { meta: true }))
      await flush()
      expect(drawn(a.win)).toBe(0)
      a.keys.listener!(press('z', { meta: true, shift: true }))
      await flush()
      expect(drawn(a.win)).toBe(1)
      a.keys.listener!(press('Backspace', { meta: true, alt: true }))
      await flush()
      expect(drawn(a.win)).toBe(0)
      a.keys.listener!(press('Escape'))
      await flush()
      expect(annotate.isOn()).toBe(false)
    })

    it('tells the bar, so that it names no letter, and tells it again when the setting changes while it is open', async () => {
      const a = fakePage('a')
      target = asTarget(a)
      annotate.start()
      await flush()
      expect(lastState().letterKeys).toBe(true)
      letters = false
      annotate.refreshLetterKeys()
      expect(lastState().letterKeys).toBe(false)
      a.keys.listener!(press('d'))
      await flush()
      expect(lastState().brush.tool).toBe('pen')
      letters = true
      annotate.refreshLetterKeys()
      expect(lastState().letterKeys).toBe(true)
      a.keys.listener!(press('d'))
      await flush()
      expect(lastState().brush.tool).toBe('diamond')
    })

    it('does not tell the bar again for a change of the settings that is not this one', async () => {
      const a = fakePage('a')
      target = asTarget(a)
      annotate.start()
      await flush()
      const sends = electron.windows[0]!.webContents.send.mock.calls.length
      annotate.refreshLetterKeys()
      annotate.refreshLetterKeys()
      expect(electron.windows[0]!.webContents.send.mock.calls.length).toBe(sends)
    })
  })

  // Guard: the letters act in draw mode only. Without the mode check in pageKeyAction, a letter would pick a tool while the page is passed through.
  it('a letter does nothing in pass mode', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    annotate.setMode('pass')
    a.keys.listener!(press('h'))
    await flush()
    expect(lastState().brush.tool).toBe('pen')
  })

  // Guard: a field of the page, or a text box, keeps its typing. Without the `editing` check in `key`, the letter would pick a tool in the field.
  it('a letter typed in a field of the page is left to the field', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    a.win.document.activeElement = { tagName: 'INPUT', isContentEditable: false }
    a.keys.listener!(press('d'))
    await flush()
    expect(lastState().brush.tool).toBe('pen')
    a.win.document.activeElement = null
    a.keys.listener!(press('d'))
    await flush()
    expect(lastState().brush.tool).toBe('diamond')
  })

  // Guard: ⌥⌘⌫ and ⇧⌥⌘⌫ reach the edits of the page and of all pages from the keys of the page. Without the alt branch, the keys would do nothing.
  it('⌥⌘⌫ clears the page on screen, ⇧⌥⌘⌫ clears all the pages', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    a.keys.listener!(press('Backspace', { meta: true, alt: true }))
    await flush()
    expect(drawn(a.win)).toBe(0)
    stroke(a.win, [10, 10], [200, 200])
    a.keys.listener!(press('Backspace', { meta: true, alt: true, shift: true }))
    await flush()
    expect(drawn(a.win)).toBe(0)
  })

  it('Escape ends the annotation, and ⌘Z undoes the last step', async () => {
    const a = fakePage('a')
    target = asTarget(a)
    annotate.start()
    await flush()
    stroke(a.win, [10, 10], [200, 200])
    expect(drawn(a.win)).toBe(1)
    a.keys.listener!(press('z', { meta: true }))
    await flush()
    expect(drawn(a.win)).toBe(0)
    a.keys.listener!(press('Escape'))
    await flush()
    expect(annotate.isOn()).toBe(false)
  })

  it('the page left stops listening to its keys', async () => {
    const a = fakePage('a')
    const b = fakePage('b')
    target = asTarget(a)
    annotate.start()
    await flush()
    target = asTarget(b)
    annotate.sync()
    await flush()
    expect(a.keys.listener).toBeNull()
    expect(b.keys.listener).not.toBeNull()
  })
})



describe('the position of the bar', () => {
  const AREA = { x: 0, y: 0, width: 1440, height: 900 }
  const WINDOW = { x: 200, y: 100, width: 800, height: 500 }
  const none: BarContent = { laser: false, note: false }

  async function startBar(position: BarPosition = DEFAULT_BAR_POSITION): Promise<void> {
    barPosition = position
    target = asTarget(fakePage('a'))
    placement = { window: WINDOW, area: AREA }
    annotate.start()
    await flush()
  }
  const command = () => electron.windows[0]!
  const barNow = (): Bounds => command().bounds.at(-1)!
  /** The grip tells main where the pointer is on the screen: sent, not asked (the preload uses `send`). */
  const drag = (phase: string, x: unknown, y: unknown, sender = commandId()): void => electron.listeners.get(PAGE_ANNOTATE_CHANNEL.drag)!(fromMain(sender), { phase, x, y })
  const ghost = () => electron.windows[1]
  const menu = (anchor: unknown = null, sender = commandId()): unknown => electron.handlers.get(PAGE_ANNOTATE_CHANNEL.menu)!(fromMain(sender), anchor)
  const nudge = (direction: unknown, large: unknown = false, sender = commandId()): unknown => electron.handlers.get(PAGE_ANNOTATE_CHANNEL.nudge)!(fromMain(sender), direction, large)
  /** The entries of the menu the bar popped up: their label (or type, for the line), their check, and what a click does. */
  const entries = (): Array<{ label?: string; type?: string; checked?: boolean; enabled?: boolean; click?: () => void }> => electron.menus.at(-1)!.template

  // Guard: the bar stands where the settings say. Without the position it would stand on the left edge whatever was chosen.
  it.each([
    ['right', { kind: 'edge', edge: 'right' }],
    ['left', { kind: 'edge', edge: 'left' }],
    ['top', { kind: 'edge', edge: 'top' }],
    ['bottom', { kind: 'edge', edge: 'bottom' }],
    ['floating', { kind: 'floating', x: 300, y: 40, layout: 'row' }]
  ] as const)('stands where the settings put it: %s', async (_name, position) => {
    await startBar(position)
    expect(barNow()).toEqual(barBounds(position, none, WINDOW, AREA))
  })

  it('stands on the left edge by default, as a column (what it was before the position could be chosen)', async () => {
    await startBar()
    expect(barNow()).toEqual({ x: 212, y: 112, width: BAR_WIDTH, height: 476 })
    expect(lastState().layout).toBe('column')
  })

  // Guard: the page of the bar is told how to lay out (a column on a side edge, a row on the top or bottom), so that it draws what the window was sized for.
  it.each([
    ['right', { kind: 'edge', edge: 'right' }, 'column'],
    ['top', { kind: 'edge', edge: 'top' }, 'row'],
    ['bottom', { kind: 'edge', edge: 'bottom' }, 'row'],
    ['floating as a row', { kind: 'floating', x: 10, y: 10, layout: 'row' }, 'row']
  ] as const)('tells the page its layout: %s', async (_name, position, layout) => {
    await startBar(position)
    expect(lastState().layout).toBe(layout)
  })

  // Guard: a row is sized for the buttons it shows: the looks of the laser widen it while the laser is the tool, and a note makes it taller. Without the
  // content, the window would cut the looks (or the note) off.
  it('sizes the row for what it shows: the looks of the laser, and the note', async () => {
    // A window wide enough for every group on one line, with or without the looks of the laser: they widen the row.
    const wide = { x: 0, y: 100, width: 1300, height: 500 }
    barPosition = { kind: 'edge', edge: 'top' }
    target = asTarget(fakePage('a'))
    placement = { window: wide, area: AREA }
    annotate.start()
    await flush()
    const plain = barNow()
    fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'laser', color: '#e53935', width: 5 })
    expect(barNow()).toEqual(barBounds({ kind: 'edge', edge: 'top' }, { laser: true, note: false }, wide, AREA))
    expect(barNow().width).toBeGreaterThan(plain.width)
    fromCommand(PAGE_ANNOTATE_CHANNEL.brush, { tool: 'pen', color: '#e53935', width: 5 })
    expect(barNow()).toEqual(plain)
    // A page that takes no layer: the note says so, under the buttons.
    target = asTarget(fakePage('b'), 'about:blank')
    annotate.sync()
    await flush()
    expect(barNow().height).toBe(plain.height + BAR_METRICS.row.noteHeight)
  })

  it('does not place the window again when nothing changed its place', async () => {
    await startBar({ kind: 'edge', edge: 'top' })
    const count = command().bounds.length
    annotate.sync()
    fromCommand(PAGE_ANNOTATE_CHANNEL.mode, 'pass')
    expect(command().bounds.length).toBe(count)
  })

  describe('the drag of the grip', () => {
    // Guard: a click on the grip moves nothing (the pointer has to go a few points away first), and keeps nothing: it does not turn a bar on an edge into a floating one.
    it('does nothing for a click, or a slip of the pointer', async () => {
      await startBar()
      const before = command().bounds.length
      drag('start', 230, 130)
      drag('move', 232, 131)
      drag('end', 232, 131)
      expect(command().bounds.length).toBe(before)
      expect(saved).toEqual([])
      expect(ghost()).toBeUndefined()
    })

    // Guard: the bar follows the pointer, as it was taken (the grip stays under the pointer), kept inside the window.
    it('follows the pointer, kept inside the window', async () => {
      await startBar({ kind: 'edge', edge: 'top' })
      const start = barNow()
      drag('start', start.x + 10, start.y + 10)
      drag('move', start.x + 50, start.y + 60)
      expect(barNow()).toMatchObject({ x: start.x + 40, y: start.y + 50, width: start.width, height: start.height })
      // Pushed far out of the window: held in it (the window is 800 wide at 200, the bar 676).
      drag('move', 5000, 5000)
      const held = barNow()
      expect(held.x + held.width).toBeLessThanOrEqual(WINDOW.x + WINDOW.width)
      expect(held.y + held.height).toBeLessThanOrEqual(WINDOW.y + WINDOW.height)
    })

    // Guard: once the drag has started (the pointer went a few points), the four drop zones show along the edges of the window, faint, in an overlay of their own that
    // covers the window; before that (a click) there is nothing. Without the overlay one sees the landing place only near an edge, and not where the edges are.
    it('shows the four drop zones along the edges of the window once the drag starts, and not for a click', async () => {
      await startBar()
      drag('start', 230, 130)
      expect(ghost()).toBeUndefined()
      drag('move', 232, 131)
      expect(ghost()).toBeUndefined()
      drag('move', 600, 300)
      expect(ghost()).toBeDefined()
      expect(ghost()!.visible).toBe(true)
      // The overlay is the window of the bar's page, in its place: the zones are drawn in it from its corner (24 wide along the four edges).
      expect(ghost()!.options).toMatchObject({ ...WINDOW })
      const page = decodeURIComponent(ghost()!.url.replace('data:text/html;charset=utf-8,', ''))
      expect(page).toBe(ghostPage(WINDOW, dropZones(WINDOW)))
      expect(page).toContain('class="zone zone-left" style="left:0px;top:0px;width:24px;height:500px"')
      expect(page).toContain('class="zone zone-right" style="left:776px;top:0px;width:24px;height:500px"')
      expect(page).toContain('class="zone zone-top" style="left:0px;top:0px;width:800px;height:24px"')
      expect(page).toContain('class="zone zone-bottom" style="left:0px;top:476px;width:800px;height:24px"')
      // None is lit while the pointer is in none: nothing was said to the page.
      expect(ghost()!.scripts).toEqual([])
    })

    // Guard: the overlay is an outline, not a surface: the pointer goes through it, it is never the focus, it is transparent, it shows no script of its own and goes nowhere.
    it('is transparent, never the focus, and the pointer goes through it', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, 300)
      expect(ghost()!.ignoresMouse).toBe(true)
      expect(ghost()!.options).toMatchObject({ transparent: true, focusable: false, frame: false, skipTaskbar: true })
      expect(ghost()!.options['webPreferences']).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
      expect(ghost()!.options['webPreferences']).not.toHaveProperty('preload')
      const event = { preventDefault: vi.fn() }
      ghost()!.emit('will-navigate', event)
      expect(event.preventDefault).toHaveBeenCalled()
    })

    // Guard: the bar stays above the overlay (both float): the bar's window is brought to the top as the overlay appears, once.
    it('brings the bar above the overlay when it shows, once', async () => {
      await startBar()
      expect(command().topped).toBe(0)
      drag('start', 230, 130)
      drag('move', 600, 300)
      drag('move', 650, 320)
      expect(command().topped).toBe(1)
    })

    // Guard: the preview of the drop zones is drawn in the accent of the theme, copied from tokens.css and worked out at the hue of the space on screen: light in
    // light, dark in dark, like the bar. Without the tokens it kept one blue of its own on every space and in both appearances.
    it('draws the drop zones in the accent of the theme, at the hue of the space on screen, with no colour of its own', async () => {
      deps.hue = () => 30
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, 300)
      const page = decodeURIComponent(ghost()!.url.replace('data:text/html;charset=utf-8,', ''))
      expect(page).toBe(ghostPage(WINDOW, dropZones(WINDOW), 30))
      expect(page).not.toBe(ghostPage(WINDOW, dropZones(WINDOW)))
      const tokens = readFileSync(new URL('../../renderer/tokens.css', import.meta.url), 'utf8')
      const accent = /^\s*(--accent: light-dark\([^;]+;)/m.exec(tokens)![1]!
      const lightness = /^\s*(--accent-l: [^;]+;)/m.exec(tokens)![1]!
      expect(tokenDeclaration(tokens, '--accent')).toBe(accent)
      expect(page).toContain(`:root { color-scheme: light dark; --hue: 30; ${lightness} ${accent} }`)
      // Every colour of the page is the accent or a share of it: no hexadecimal value and no rgb() is written in its rules.
      const rules = page.slice(page.indexOf('html, body'), page.indexOf('</style>'))
      expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
      expect(rules.match(/var\(--accent\)/g)!.length).toBe(6)
      expect(rules).toContain('background: transparent')
      // A hue that is not one (nothing told, a text, a number out of the circle) is the one the tokens start from, never a text put in the page.
      for (const odd of [undefined, Number.NaN, -1, 360, '30; } html { background: red' as never]) expect(ghostPage(WINDOW, dropZones(WINDOW), odd)).toContain('--hue: 250;')
      expect(() => tokenDeclaration(tokens, '--no-such-token')).toThrow(/declares no --no-such-token/)
    })

    // Guard: the bar is told the hue of the space on screen in the annotated window, and again when that space changes: its accent is the one of the window.
    it('tells the bar the hue of the space on screen, and the new one when the space changes', async () => {
      let hue: number | null = 30
      const asked: Array<string | null> = []
      deps.hue = (window) => {
        asked.push(window)
        return hue
      }
      await startBar()
      expect(lastState().hue).toBe(30)
      expect(asked.at(-1)).toBe(OWN)
      hue = 200
      for (const listener of watchers) listener()
      expect(lastState().hue).toBe(200)
      // A window that shows no space: the hue the tokens start from.
      hue = null
      for (const listener of watchers) listener()
      expect(lastState().hue).toBe(250)
    })

    // Guard: the zone the pointer is in is lit, and the dashed outline of the landing place goes with it; the pointer leaving puts both out. The call is the one `ghostCall` makes
    // for that edge and that place: the zone is named, the outline is the bar's bounds on that edge, in the coordinates of the overlay.
    it('lights the zone the pointer is in, with the outline of the landing place, and puts them out when it leaves', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, 300)
      drag('move', 600, WINDOW.y + WINDOW.height - 10)
      const landing = barBounds({ kind: 'edge', edge: 'bottom' }, none, WINDOW, AREA)
      expect(ghost()!.scripts).toEqual([ghostCall('bottom', landing, WINDOW)])
      expect(ghost()!.scripts[0]).toContain('dataset.target="bottom"')
      expect(ghost()!.scripts[0]).toContain(`left:${landing.x - WINDOW.x}px;top:${landing.y - WINDOW.y}px;width:${landing.width}px;height:${landing.height}px`)
      // A move inside the same zone says nothing again.
      drag('move', 650, WINDOW.y + WINDOW.height - 12)
      expect(ghost()!.scripts).toHaveLength(1)
      // Another zone: lit in its place.
      drag('move', WINDOW.x + 8, 300)
      expect(ghost()!.scripts.at(-1)).toBe(ghostCall('left', barBounds({ kind: 'edge', edge: 'left' }, none, WINDOW, AREA), WINDOW))
      // The pointer leaves the zones: none is lit, no outline.
      drag('move', 600, 300)
      expect(ghost()!.scripts.at(-1)).toBe(ghostCall(null, null, WINDOW))
      expect(ghost()!.scripts.at(-1)).toContain('dataset.target=""')
      expect(ghost()!.scripts.at(-1)).toContain('o.hidden=true')
    })

    it('is within the snap distance of an edge, and not beyond it', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - BAR_SNAP_DISTANCE - 1)
      expect(ghost()!.scripts).toEqual([])
      drag('move', 600, WINDOW.y + WINDOW.height - BAR_SNAP_DISTANCE)
      expect(ghost()!.scripts).toHaveLength(1)
      expect(ghost()!.scripts[0]).toContain('dataset.target="bottom"')
    })

    // Guard: what is said to the overlay before its page has loaded is not lost: the last call is run when it loads (and only that one).
    it('runs the last call once the page of the overlay has loaded, when it was asked for before', async () => {
      await startBar()
      electron.autoLoad.value = false
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - 10)
      drag('move', WINDOW.x + 8, 300)
      expect(ghost()!.scripts).toEqual([])
      ghost()!.emit('did-finish-load')
      expect(ghost()!.scripts).toEqual([ghostCall('left', barBounds({ kind: 'edge', edge: 'left' }, none, WINDOW, AREA), WINDOW)])
    })

    // Guard: a call the page could not run is logged with its cause, not hidden; the drag goes on and the drop does what it always did.
    it('logs a call that could not be run, and the drag goes on', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await startBar()
        electron.scriptError.value = new Error('the page went away')
        drag('start', 230, 130)
        drag('move', 600, WINDOW.y + WINDOW.height - 10)
        await flush()
        expect(warn).toHaveBeenCalledWith('[page-annotate] the drop zones could not be updated:', electron.scriptError.value)
        drag('end', 600, WINDOW.y + WINDOW.height - 10)
        expect(saved).toEqual([{ kind: 'edge', edge: 'bottom' }])
      } finally {
        warn.mockRestore()
      }
    })

    it('makes the call of the overlay from numbers and the name of an edge only', () => {
      expect(ghostCall('left', { x: 212, y: 112.4, width: 84, height: 476 }, WINDOW)).toBe(
        `(()=>{document.documentElement.dataset.target="left";const o=document.getElementById('landing');if(o){o.style.cssText='left:12px;top:12px;width:84px;height:476px';o.hidden=false}})()`
      )
      // A name that is not an edge lights nothing, and numbers that are not numbers put no outline: nothing else gets into the script.
      expect(ghostCall('"+alert(1)+"' as never, null, WINDOW)).toContain('dataset.target=""')
      const odd = ghostCall('top', { x: Number.NaN, y: 0, width: 1, height: 1 }, WINDOW)
      expect(odd).toContain('o.hidden=true')
      expect(odd).not.toContain('NaN')
    })

    // Guard: dropped near an edge, the bar goes on that edge (kept in the settings), in the layout of that edge, and the outline is gone.
    it('goes on the edge it is dropped near, and keeps that', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - 10)
      drag('end', 600, WINDOW.y + WINDOW.height - 10)
      expect(saved).toEqual([{ kind: 'edge', edge: 'bottom' }])
      expect(barNow()).toEqual(barBounds({ kind: 'edge', edge: 'bottom' }, none, WINDOW, AREA))
      expect(lastState().layout).toBe('row')
      expect(ghost()!.destroyed).toBe(true)
    })

    // Guard: dropped away from the edges, the bar floats where it is, its place counted from the corner of the window, with the layout it had.
    it('floats where it is dropped, from the corner of the window, with its layout', async () => {
      await startBar({ kind: 'edge', edge: 'top' })
      const start = barNow()
      drag('start', start.x + 10, start.y + 10)
      drag('move', start.x + 50, start.y + 110)
      drag('end', start.x + 50, start.y + 110)
      expect(saved).toEqual([{ kind: 'floating', x: start.x + 40 - WINDOW.x, y: start.y + 100 - WINDOW.y, layout: 'row' }])
      expect(barNow()).toEqual({ ...start, x: start.x + 40, y: start.y + 100 })
      expect(ghost()!.destroyed).toBe(true)
    })

    // Guard: what is kept is where the bar really is: pushed against the window's edge, it is kept there, not where the pointer went.
    it('keeps the place inside the window when the pointer went beyond it', async () => {
      await startBar({ kind: 'edge', edge: 'top' })
      const start = barNow()
      drag('start', start.x + 10, start.y + 10)
      drag('move', WINDOW.x + 400, WINDOW.y + 300)
      drag('end', WINDOW.x + 400, WINDOW.y + 300)
      const kept = saved.at(-1)!
      expect(kept.kind).toBe('floating')
      expect(barNow().y + barNow().height).toBeLessThanOrEqual(WINDOW.y + WINDOW.height)
    })

    // Guard: a drag that is taken away (the pointer is cancelled) puts the bar back where its position says, and keeps nothing.
    it('puts the bar back when the drag is cancelled', async () => {
      await startBar({ kind: 'edge', edge: 'top' })
      const home = barNow()
      drag('start', home.x + 10, home.y + 10)
      drag('move', 700, WINDOW.y + WINDOW.height - 5)
      expect(ghost()).toBeDefined()
      expect(ghost()!.destroyed).toBe(false)
      drag('cancel', 700, 300)
      expect(saved).toEqual([])
      expect(barNow()).toEqual(home)
      expect(ghost()!.destroyed).toBe(true)
    })

    // Guard: while the bar is dragged, the window changing around it (the focus, a tab) does not snap it back under the pointer.
    it('is not put back by a change of the window while it is dragged', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 500, 300)
      const dragged = barNow()
      for (const watcher of watchers) watcher()
      expect(barNow()).toEqual(dragged)
    })

    it('is dropped with the annotation: ending it mid-drag closes the outline', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - 5)
      annotate.stop()
      expect(ghost()!.destroyed).toBe(true)
      expect(saved).toEqual([])
    })

    it('is dropped when the window shows no page any more', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - 5)
      placement = null
      for (const watcher of watchers) watcher()
      expect(ghost()!.destroyed).toBe(true)
      drag('end', 600, WINDOW.y + WINDOW.height - 5)
      expect(saved).toEqual([])
    })

    // Guard: only the bar's own window may drag it: another page that reached the channel is refused.
    it('refuses another sender', async () => {
      await startBar()
      const before = command().bounds.length
      drag('start', 230, 130, 999)
      drag('move', 500, 300, 999)
      expect(command().bounds.length).toBe(before)
      // The drag that never started does not go on with the move of the right sender either.
      drag('move', 500, 300)
      expect(command().bounds.length).toBe(before)
    })

    // Guard: a message that is not a drag is not acted on: a text for a coordinate (JavaScript would still do the sums with it), numbers past any screen, a phase of no list.
    // Each would move the bar, or end the drag, if it were taken.
    it('refuses a message that is not a drag, and the drag goes on', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 300, 200)
      const held = barNow()
      for (const [phase, x, y] of [['move', '600', 300], ['move', 5e9, 300], ['move', 600, Infinity], ['move', 600, Number.NaN], ['move', undefined, 300], ['move', 600, null]] as const) drag(phase, x, y)
      expect(barNow()).toEqual(held)
      // A phase that is not one does not end the drag, which then follows the pointer.
      drag('teleport', 500, 300)
      drag('move', 320, 210)
      expect(barNow()).toMatchObject({ x: held.x + 20 })
      expect(saved).toEqual([])
    })
  })

  describe('the menu of the positions', () => {
    // Guard: the menu names the positions in the order of the design, and checks the one the bar has.
    it('lists the positions, and checks the current one', async () => {
      await startBar()
      menu()
      expect(entries().map((entry) => entry.label ?? entry.type)).toEqual(['Position de la barre', 'À droite', 'À gauche', 'En haut', 'En bas', 'separator', 'Flottante'])
      expect(entries().map((entry) => entry.checked)).toEqual([undefined, false, true, false, false, undefined, false])
      // The title is not a choice.
      expect(entries()[0]!.enabled).toBe(false)
      expect(electron.menus.at(-1)!.options).toMatchObject({ window: command() })
    })

    it('checks « Flottante » when the bar floats', async () => {
      await startBar({ kind: 'floating', x: 30, y: 30, layout: 'column' })
      menu()
      expect(entries().map((entry) => entry.checked)).toEqual([undefined, false, false, false, false, undefined, true])
    })

    it('opens at the place the grip gave (the keyboard), rounded, and at the pointer for a right click', async () => {
      await startBar()
      menu()
      expect(electron.menus.at(-1)!.options).not.toHaveProperty('x')
      menu({ x: 10.4, y: 20.6 })
      expect(electron.menus.at(-1)!.options).toMatchObject({ x: 10, y: 21 })
    })

    // Guard: a choice of an edge puts the bar there and keeps it.
    it.each([
      ['À droite', 'right'],
      ['En haut', 'top'],
      ['En bas', 'bottom']
    ] as const)('puts the bar on the edge chosen: %s', async (label, edge) => {
      await startBar()
      menu()
      entries().find((entry) => entry.label === label)!.click!()
      expect(saved).toEqual([{ kind: 'edge', edge }])
      expect(barNow()).toEqual(barBounds({ kind: 'edge', edge }, none, WINDOW, AREA))
    })

    it('does not keep the edge the bar already has', async () => {
      await startBar()
      menu()
      entries().find((entry) => entry.label === 'À gauche')!.click!()
      expect(saved).toEqual([])
    })

    // Guard: « Flottante » from an edge leaves the bar where it is, in its layout: it does not jump.
    it('floats the bar where it stands, in its layout', async () => {
      await startBar({ kind: 'edge', edge: 'top' })
      const home = barNow()
      menu()
      entries().find((entry) => entry.label === 'Flottante')!.click!()
      expect(saved).toEqual([{ kind: 'floating', x: home.x - WINDOW.x, y: home.y - WINDOW.y, layout: 'row' }])
      expect(barNow()).toEqual(home)
    })

    it('keeps a floating bar as it is when « Flottante » is chosen again', async () => {
      await startBar({ kind: 'floating', x: 30, y: 30, layout: 'column' })
      menu()
      entries().find((entry) => entry.label === 'Flottante')!.click!()
      expect(saved).toEqual([])
    })

    // Guard: only the bar's window asks for the menu, with a place it can read, and not in the middle of a drag.
    it('refuses another sender, a place that is not one, and a menu during a drag', async () => {
      await startBar()
      menu(null, 999)
      menu({ x: -5, y: 3 })
      menu({ x: '3', y: 3 })
      menu('here')
      expect(electron.menus).toHaveLength(0)
      drag('start', 230, 130)
      drag('move', 500, 300)
      menu()
      expect(electron.menus).toHaveLength(0)
    })
  })

  describe('the arrow keys of the grip', () => {
    // Guard: an arrow moves a floating bar ten points, and fifty with Shift, and keeps the result.
    it('moves a floating bar a step, a large one with Shift', async () => {
      await startBar({ kind: 'floating', x: 50, y: 100, layout: 'row' })
      await nudge('right')
      expect(saved.at(-1)).toEqual({ kind: 'floating', x: 60, y: 100, layout: 'row' })
      await nudge('down', true)
      expect(saved.at(-1)).toEqual({ kind: 'floating', x: 60, y: 150, layout: 'row' })
      await nudge('left')
      await nudge('up')
      expect(saved.at(-1)).toEqual({ kind: 'floating', x: 50, y: 140, layout: 'row' })
      expect(barNow()).toEqual(barBounds({ kind: 'floating', x: 50, y: 140, layout: 'row' }, none, WINDOW, AREA))
    })

    it('stops at the edge of the window, and keeps the place it really has', async () => {
      await startBar({ kind: 'floating', x: 0, y: 0, layout: 'row' })
      await nudge('left')
      await nudge('up', true)
      expect(saved).toEqual([])
    })

    // Guard: the keys do not touch a bar on an edge (the menu moves it from edge to edge).
    it('does not move a bar on an edge', async () => {
      await startBar()
      await nudge('right')
      expect(saved).toEqual([])
    })

    it('refuses another sender, a direction that is not one, and a step that is not a boolean', async () => {
      await startBar({ kind: 'floating', x: 100, y: 100, layout: 'row' })
      await nudge('right', false, 999)
      await nudge('right', 'yes')
      expect(saved).toEqual([])
      // A direction that is not one is turned back before anything is read (a direction the position does not know would move nothing, which is not a refusal).
      const asked = placementCalls
      await nudge('sideways')
      await nudge(undefined)
      await nudge('constructor')
      expect(placementCalls).toBe(asked)
      expect(saved).toEqual([])
      await nudge('right')
      expect(saved).toHaveLength(1)
    })

    // Guard: the keys do nothing while the bar is being dragged (the bar is under the pointer, not at its position).
    it('does not move the bar while it is dragged', async () => {
      await startBar({ kind: 'floating', x: 100, y: 100, layout: 'row' })
      const home = barNow()
      drag('start', home.x + 5, home.y + 5)
      drag('move', home.x + 200, home.y + 100)
      await nudge('right')
      expect(saved).toEqual([])
    })
  })

  describe('the hint of the first use', () => {
    // A window high enough for the column to have the room it asks for, so that the room of the hint shows in the size of the window.
    const BIG = { x: 100, y: 50, width: 1400, height: 1300 }
    const BIG_AREA = { x: 0, y: 0, width: 1600, height: 1400 }
    const hinted: BarContent = { laser: false, note: false, hint: true }
    const hint = (): string => PAGE_ANNOTATE_CHANNEL.hint
    const dismiss = (sender = commandId()): unknown => electron.handlers.get(hint())!(fromMain(sender))
    async function startFirst(position: BarPosition = DEFAULT_BAR_POSITION): Promise<void> {
      hintSeen = false
      barPosition = position
      target = asTarget(fakePage('a'))
      placement = { window: BIG, area: BIG_AREA }
      annotate.start()
      await flush()
    }

    // Guard: the first time the bar opens (the hint was not seen), it is told to show the hint, and the window is made for it; once seen, never. Without it, the bubble
    // would not show, or would show at every start.
    it('is shown the first time the bar opens, and the window is made for it', async () => {
      await startFirst()
      expect(lastState().hint).toBe(true)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, hinted, BIG, BIG_AREA))
      expect(barNow().height).toBe(BAR_METRICS.column.height + BAR_METRICS.column.hintHeight)
    })

    it('is shown above a row as well, which is made higher by it', async () => {
      await startFirst({ kind: 'edge', edge: 'top' })
      expect(lastState().hint).toBe(true)
      expect(barNow()).toEqual(barBounds({ kind: 'edge', edge: 'top' }, hinted, BIG, BIG_AREA))
      expect(barNow().height).toBe(BAR_METRICS.button + 14 + BAR_METRICS.row.hintHeight)
    })

    it('is not shown once it was seen', async () => {
      hintSeen = true
      barPosition = DEFAULT_BAR_POSITION
      target = asTarget(fakePage('a'))
      placement = { window: BIG, area: BIG_AREA }
      annotate.start()
      await flush()
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, none, BIG, BIG_AREA))
      expect(hintRemembered).toBe(0)
    })

    // Guard: nothing is remembered while the hint is only shown: it was not read yet. A bar closed at once shows it again next time.
    it('is not remembered as seen until it is dismissed, so that a bar closed at once shows it again', async () => {
      await startFirst()
      expect(hintRemembered).toBe(0)
      annotate.stop()
      electron.windows.length = 0
      annotate.start()
      await flush()
      expect(lastState().hint).toBe(true)
      expect(hintRemembered).toBe(0)
    })

    // Guard: « OK » dismisses it: it is remembered (once), the page is told, and the window is made the size it has without it. It is not shown the next time the bar opens.
    it('is dismissed by OK: remembered, the page told, the window made smaller, and not shown again', async () => {
      await startFirst()
      await dismiss()
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, none, BIG, BIG_AREA))
      // A second « OK » (the page was slow to hide it) changes nothing and remembers nothing more.
      const sends = command().webContents.send.mock.calls.length
      await dismiss()
      expect(hintRemembered).toBe(1)
      expect(command().webContents.send.mock.calls.length).toBe(sends)
      annotate.stop()
      electron.windows.length = 0
      annotate.start()
      await flush()
      expect(lastState().hint).toBe(false)
    })

    // Guard: only the bar's own window dismisses the hint: another page that reached the channel is refused.
    it('is not dismissed by another window', async () => {
      await startFirst()
      await dismiss(999)
      expect(hintRemembered).toBe(0)
      expect(lastState().hint).toBe(true)
    })

    // Guard: Escape closes the hint first, and does not end the annotation; the next Escape does. Without the rule, the first Escape of a person who never saw the hint
    // would end the annotation.
    it('is closed by the first Escape of the page, which does not end the annotation; the second one does', async () => {
      const page = fakePage('a')
      hintSeen = false
      target = asTarget(page)
      placement = { window: BIG, area: BIG_AREA }
      annotate.start()
      await flush()
      page.keys.listener!(press('Escape'))
      await flush()
      expect(annotate.isOn()).toBe(true)
      expect(lastState().hint).toBe(false)
      expect(hintRemembered).toBe(1)
      page.keys.listener!(press('Escape'))
      await flush()
      expect(annotate.isOn()).toBe(false)
    })

    // Guard: taking the bar by its grip is what the hint is about: a drag that goes somewhere dismisses it, with the drop (the window keeps its size during the drag, so that
    // the bar does not jump under the pointer), and the bar is then made the size it has without the hint. A click on the grip does not.
    it('is dismissed by a drag that moved the bar, at the drop, and not by a click on the grip', async () => {
      await startFirst({ kind: 'edge', edge: 'top' })
      const home = barNow()
      drag('start', home.x + 10, home.y + 10)
      drag('end', home.x + 10, home.y + 10)
      expect(hintRemembered).toBe(0)
      expect(lastState().hint).toBe(true)
      drag('start', home.x + 10, home.y + 10)
      drag('move', home.x + 60, home.y + 300)
      // During the drag the hint is still there, and so is the size of the window.
      expect(lastState().hint).toBe(true)
      expect(barNow()).toMatchObject({ width: home.width, height: home.height })
      drag('end', home.x + 60, home.y + 300)
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow().height).toBe(home.height - BAR_METRICS.row.hintHeight)
      expect(saved).toHaveLength(1)
    })

    // Guard: the outline of the landing place is the bar without the hint (the hint is gone with the drop), not the bar as tall as it is while the hint shows.
    it('shows the outline of the landing place without the room of the hint', async () => {
      await startFirst()
      const home = barNow()
      drag('start', home.x + 10, home.y + 10)
      drag('move', BIG.x + BIG.width / 2, BIG.y + 5)
      expect(ghost()!.scripts.at(-1)).toBe(ghostCall('top', barBounds({ kind: 'edge', edge: 'top' }, none, BIG, BIG_AREA), BIG))
    })

    it('is dismissed by a drag that was cancelled after it moved the bar', async () => {
      await startFirst()
      const home = barNow()
      drag('start', home.x + 10, home.y + 10)
      drag('move', home.x + 200, home.y + 200)
      drag('cancel', home.x + 200, home.y + 200)
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, none, BIG, BIG_AREA))
    })

    // Guard: a position chosen in the menu is the bar placed by the user: the hint is done with, whether the bar moves or not. Opening the menu alone changes nothing (the window
    // keeps its size, and so the place the menu opened at).
    it('is dismissed by a position chosen in the menu, and not by opening it', async () => {
      await startFirst()
      menu()
      expect(hintRemembered).toBe(0)
      expect(lastState().hint).toBe(true)
      entries().find((entry) => entry.label === 'En bas')!.click!()
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds({ kind: 'edge', edge: 'bottom' }, none, BIG, BIG_AREA))
    })

    it('is dismissed by the choice of the position the bar already has', async () => {
      await startFirst()
      menu()
      entries().find((entry) => entry.label === 'À gauche')!.click!()
      expect(saved).toEqual([])
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, none, BIG, BIG_AREA))
    })

    it('is dismissed by an arrow key on the grip, whether or not the bar moves', async () => {
      await startFirst({ kind: 'floating', x: 100, y: 100, layout: 'row' })
      await nudge('right')
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds({ kind: 'floating', x: 110, y: 100, layout: 'row' }, none, BIG, BIG_AREA))
    })

    it('is dismissed by an arrow key on a bar on an edge, which does not move', async () => {
      await startFirst()
      await nudge('right')
      expect(saved).toEqual([])
      expect(hintRemembered).toBe(1)
      expect(lastState().hint).toBe(false)
    })

    // Guard: a caller that keeps no memory of the hint never shows it (it would show at every start).
    it('is never shown when the caller keeps no memory of it', async () => {
      annotate.dispose()
      const { hintSeen: _seen, setHintSeen: _set, ...without } = deps
      annotate = new PageAnnotate(without)
      target = asTarget(fakePage('a'))
      placement = { window: BIG, area: BIG_AREA }
      annotate.start()
      await flush()
      expect(lastState().hint).toBe(false)
      expect(barNow()).toEqual(barBounds(DEFAULT_BAR_POSITION, none, BIG, BIG_AREA))
    })

    it('is gone with the annotation: the state says so', async () => {
      await startFirst()
      annotate.stop()
      electron.windows.length = 0
      hintSeen = true
      annotate.start()
      await flush()
      expect(lastState().hint).toBe(false)
    })
  })

  describe('the settings', () => {
    // Guard: the bar moves when the position in the settings changes elsewhere (a restore, another window), and not for any other change of the settings.
    it('follows a change of the position in the settings, and only that', async () => {
      await startBar()
      const count = command().bounds.length
      const told = command().webContents.send.mock.calls.length
      annotate.refreshPosition()
      expect(command().bounds.length).toBe(count)
      // The page of the bar is not told again for a change of the settings that is not a move of the bar.
      expect(command().webContents.send.mock.calls.length).toBe(told)
      barPosition = { kind: 'edge', edge: 'right' }
      annotate.refreshPosition()
      expect(barNow()).toEqual(barBounds({ kind: 'edge', edge: 'right' }, none, WINDOW, AREA))
      expect(lastState().layout).toBe('column')
    })

    // Guard: a floating bar kept for a large window is brought back inside a smaller one, and the screen.
    it('brings a floating bar back inside a window that became smaller', async () => {
      await startBar({ kind: 'floating', x: 700, y: 400, layout: 'row' })
      placement = { window: { x: 200, y: 100, width: 720, height: 480 }, area: AREA }
      for (const watcher of watchers) watcher()
      const bar = barNow()
      expect(bar.x + bar.width).toBeLessThanOrEqual(200 + 720)
      expect(bar.y + bar.height).toBeLessThanOrEqual(100 + 480)
    })

    it('keeps no position of its own: a second annotation stands where the settings say', async () => {
      await startBar()
      drag('start', 230, 130)
      drag('move', 600, WINDOW.y + WINDOW.height - 10)
      drag('end', 600, WINDOW.y + WINDOW.height - 10)
      annotate.stop()
      electron.windows.length = 0
      annotate.start()
      await flush()
      expect(electron.windows[0]!.bounds.at(-1)).toEqual(barBounds({ kind: 'edge', edge: 'bottom' }, none, WINDOW, AREA))
    })
  })
})
