import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { Channel, WEB_APP_HEADER_HEIGHT, type LittleState } from '@shared/ipc'
import { WEB_APPS_MAX, type WebAppRequest } from '@shared/web-apps'
import type { Action } from '@shared/sidebar'
import type { Engine, Page, PageEvents } from '../engine/types'
import { frenchSpaces } from '@shared/french-typography'
import { controlsOverlay } from '@shared/window-controls'

const electron = vi.hoisted(() => ({ ipc: new (require('node:events').EventEmitter)(), clipboard: { writeText: vi.fn(async () => undefined) } }))
vi.mock('electron', () => ({ ipcMain: electron.ipc, clipboard: electron.clipboard }))

const { WebAppWindows, webAppWindowFrame } = await import('./web-apps')
const { createPlatform } = await import('../platform')
const { setLockService } = await import('../lock-service')

interface FakeWindow {
  win: BrowserWindow
  webContents: { id: number; sent: Array<[string, unknown]> }
  close: () => void
  destroyed: boolean
  shown: boolean
}
let nextWc = 100
function fakeWindow(): FakeWindow {
  const handlers = new Map<string, Array<(...args: never[]) => void>>()
  const wcHandlers = new Map<string, Array<(...args: never[]) => void>>()
  const wc = { id: ++nextWc, sent: [] as Array<[string, unknown]> }
  const fake: FakeWindow = { win: undefined as unknown as BrowserWindow, webContents: wc, destroyed: false, shown: false, close: () => undefined }
  const webContents = {
    id: wc.id,
    send: (channel: string, payload: unknown) => wc.sent.push([channel, payload]),
    isDestroyed: () => false,
    on: (event: string, fn: (...args: never[]) => void) => wcHandlers.set(event, [...(wcHandlers.get(event) ?? []), fn]),
    once: (event: string, fn: (...args: never[]) => void) => wcHandlers.set(event, [...(wcHandlers.get(event) ?? []), fn]),
    emit: (event: string) => (wcHandlers.get(event) ?? []).forEach((fn) => (fn as () => void)())
  }
  fake.close = () => {
    fake.destroyed = true
    for (const fn of handlers.get('closed') ?? []) (fn as () => void)()
  }
  fake.win = {
    webContents,
    isDestroyed: () => fake.destroyed,
    on: (event: string, fn: (...args: never[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    close: () => fake.close(),
    show: () => (fake.shown = true),
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 })
  } as unknown as BrowserWindow
  return fake
}

interface FakePage extends Page {
  calls: string[]
  shownAt?: { x: number; y: number; width: number; height: number }
  destroyed: boolean
}

function setup(over: { createWindow?: () => FakeWindow } = {}) {
  const windows = new Map<string, BrowserWindow>()
  const trusted = new Set<number>()
  const fakes: FakeWindow[] = []
  const pages: Array<{ opts: { id: string; profileId: string; windowId?: string }; events: PageEvents; page: FakePage }> = []
  const dispatched: Action[] = []
  const toasts: string[] = []
  let focused = 0
  const engine = {
    createPage: (opts: { id: string; profileId: string; windowId?: string }, events: PageEvents) => {
      const page = {
        calls: [] as string[],
        destroyed: false,
        loadURL: (url: string) => page.calls.push(`load:${url}`),
        goBack: () => page.calls.push('back'),
        goForward: () => page.calls.push('forward'),
        reload: () => page.calls.push('reload'),
        show: (bounds: { x: number; y: number; width: number; height: number }) => {
          page.shownAt = bounds
        },
        destroy: () => {
          page.destroyed = true
        }
      } as unknown as FakePage
      pages.push({ opts, events, page })
      return page
    }
  } as unknown as Engine
  const browser = { dispatch: (a: Action) => dispatched.push(a), showToast: (m: string) => toasts.push(m), hideAdsOn: vi.fn(), forgetBlockerCss: vi.fn() }
  const apps = new WebAppWindows({
    engine,
    store: { get: () => ({ settings: { keyBindings: {}, stripCopiedLinks: false } }) } as never,
    browser: browser as never,
    windows,
    trusted,
    focusMain: () => void focused++,
    createWindow: () => {
      const f = over.createWindow?.() ?? fakeWindow()
      fakes.push(f)
      return f.win
    }
  })
  return { apps, windows, trusted, fakes, pages, dispatched, toasts, focused: () => focused, browser }
}

const request = (over: Partial<WebAppRequest> = {}): WebAppRequest => ({ url: 'https://mail.example.com/inbox', name: 'Mail', icon: 'https://mail.example.com/i.png', profileId: 'travail', spaceId: 'space-a', ...over })
/** The message an application window's UI sends: only from its own web contents, through its top frame. */
function send(_t: ReturnType<typeof setup>, sender: FakeWindow | { webContents: { id: number } }, id: string, command: string, frame: 'main' | 'sub' = 'main') {
  const mainFrame = {}
  electron.ipc.emit(Channel.littleAction, { sender: { id: sender.webContents.id, mainFrame }, senderFrame: frame === 'main' ? mainFrame : {} }, id, command)
}

beforeEach(() => {
  electron.ipc.removeAllListeners()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the ads and banners of the page of an application window', () => {
  it('are hidden as a tab hides them, for the page the window shows now, and forgotten before the page goes with the window', () => {
    const t = setup()
    const id = t.apps.open(request())
    t.pages[0]!.events.domReady!()
    expect(t.browser.hideAdsOn).toHaveBeenCalledWith(id, t.pages[0]!.page, expect.any(Function), expect.any(Function))
    const [, , urlOf, isCurrent] = t.browser.hideAdsOn.mock.calls[0] as [string, unknown, () => string | undefined, () => boolean]
    expect(urlOf()).toBe('https://mail.example.com/inbox')
    expect(isCurrent()).toBe(true)
    let destroyedFirst: boolean | null = null
    t.browser.forgetBlockerCss.mockImplementation(() => void (destroyedFirst = t.pages[0]!.page.destroyed))
    t.fakes[0]!.close()
    expect(t.browser.forgetBlockerCss).toHaveBeenCalledWith(id)
    expect(destroyedFirst).toBe(false)
    expect(t.pages[0]!.page.destroyed).toBe(true)
    expect(isCurrent()).toBe(false)
  })
})

describe('the windows of the sites opened as applications', () => {
  it('opens a window on the site, in the profile it came from, with its own name and icon, no sidebar', () => {
    const t = setup()
    const id = t.apps.open(request())
    expect(id).toBe('webapp-1')
    expect(t.pages[0]!.opts).toEqual({ id: 'webapp-1', profileId: 'travail', windowId: 'webapp-1' })
    expect(t.pages[0]!.page.calls).toEqual(['load:https://mail.example.com/inbox'])
    // The page fills the window under the header, edge to edge.
    expect(t.pages[0]!.page.shownAt).toEqual({ x: 0, y: WEB_APP_HEADER_HEIGHT, width: 1000, height: 700 - WEB_APP_HEADER_HEIGHT })
    expect(t.fakes[0]!.shown).toBe(true)
    expect(t.trusted.has(t.fakes[0]!.webContents.id)).toBe(true)
    expect(t.windows.has('webapp-1')).toBe(true)
    const state = t.apps.states()[0]!
    expect(state).toMatchObject({ id: 'webapp-1', url: 'https://mail.example.com/inbox', app: { name: 'Mail', icon: 'https://mail.example.com/i.png' }, bar: false, spaces: [] })
  })

  it('refuses what is not a web page, and a ninth window, with a notice', () => {
    const t = setup()
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@a.example/', 'about:blank']) expect(t.apps.open(request({ url })), url).toBeNull()
    expect(t.apps.count()).toBe(0)
    for (let i = 0; i < WEB_APPS_MAX; i++) expect(t.apps.open(request())).not.toBeNull()
    expect(t.apps.open(request())).toBeNull()
    expect(t.apps.count()).toBe(WEB_APPS_MAX)
    expect(t.toasts).toEqual([frenchSpaces(`Déjà ${WEB_APPS_MAX} fenêtres d’application ouvertes : fermez-en une.`)])
  })

  // The application windows close with the lock; a header that is still there must not drive its page behind the lock screen.
  it('does not obey its header while the application is locked, and says so in the log', () => {
    const t = setup()
    t.apps.open(request())
    const [first] = t.fakes as [FakeWindow]
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    try {
      send(t, first, 'webapp-1', 'reload')
      expect(t.pages[0]!.page.calls).toEqual(['load:https://mail.example.com/inbox'])
      expect(console.warn).toHaveBeenCalledWith(`[lock] ignored ${Channel.littleAction}: the application is locked`)
      locked = false
      send(t, first, 'webapp-1', 'reload')
      expect(t.pages[0]!.page.calls).toEqual(['load:https://mail.example.com/inbox', 'reload'])
    } finally {
      setLockService(null)
    }
  })

  it('obeys the header of its own window only: not another window, not a subframe, not an id it does not know', () => {
    const t = setup()
    t.apps.open(request())
    t.apps.open(request({ url: 'https://other.example/' }))
    const [first, second] = t.fakes as [FakeWindow, FakeWindow]
    send(t, first, 'webapp-1', 'reload')
    expect(t.pages[0]!.page.calls).toContain('reload')
    send(t, second, 'webapp-1', 'back')
    send(t, first, 'webapp-1', 'forward', 'sub')
    send(t, { webContents: { id: 1 } }, 'webapp-1', 'back')
    send(t, first, 'little-1', 'back')
    send(t, first, 'webapp-1', 42 as never)
    send(t, first, 'webapp-1', 'move-menu')
    expect(t.pages[0]!.page.calls).toEqual(['load:https://mail.example.com/inbox', 'reload'])
    expect(t.pages[1]!.page.calls).toEqual(['load:https://other.example/'])
    send(t, second, 'webapp-2', 'back')
    expect(t.pages[1]!.page.calls).toContain('back')
  })

  it('keeps a link of the same site in the window and sends any other to the browser as a tab, never a script', () => {
    const t = setup()
    t.apps.open(request())
    const { events, page } = t.pages[0]!
    events.openWindow('https://mail.example.com/settings', 'foreground', true)
    expect(page.calls).toContain('load:https://mail.example.com/settings')
    // The sign-in service of the same site (another subdomain) stays in the window too.
    events.openWindow('https://accounts.example.com/login', 'background', true)
    expect(page.calls).toContain('load:https://accounts.example.com/login')
    expect(t.dispatched).toEqual([])
    events.openWindow('https://elsewhere.example.org/page', 'foreground', true)
    expect(t.dispatched).toEqual([{ type: 'tab/open', url: 'https://elsewhere.example.org/page' }])
    expect(t.focused()).toBe(1)
    for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html']) events.openWindow(target, 'foreground', true)
    expect(t.dispatched).toHaveLength(1)
  })

  it('follows the page: its title and whether it can go back, pushed to the header', () => {
    const t = setup()
    t.apps.open(request())
    t.pages[0]!.events.update({ url: 'https://mail.example.com/next', title: 'Suite', canGoBack: true })
    const [channel, payload] = t.fakes[0]!.webContents.sent.at(-1)!
    expect(channel).toBe(Channel.littleState)
    expect(payload as LittleState).toMatchObject({ url: 'https://mail.example.com/next', title: 'Suite', canGoBack: true, app: { name: 'Mail' } })
    t.pages[0]!.events.update({ url: 'chrome-error://chromewebdata/' })
    expect(t.apps.states()[0]!.url).toBe('https://mail.example.com/next')
  })

  // What the window sent as its page loaded may have come before the header listened: once it listens, it asks again.
  it('sends its state again to the header that says it listens now', () => {
    const t = setup()
    t.apps.open(request())
    const sent = t.fakes[0]!.webContents.sent
    sent.length = 0
    send(t, t.fakes[0]!, 'webapp-1', 'ready')
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe(Channel.littleState)
    expect(sent[0]![1] as LittleState).toMatchObject({ id: 'webapp-1', app: { name: 'Mail' } })
  })

  it('"Ouvrir dans un onglet" makes a tab of the page on screen, closes the window and brings the browser forward', () => {
    const t = setup()
    t.apps.open(request())
    t.pages[0]!.events.update({ url: 'https://mail.example.com/thread/9' })
    send(t, t.fakes[0]!, 'webapp-1', 'open-in-main')
    expect(t.dispatched).toEqual([{ type: 'tab/open', url: 'https://mail.example.com/thread/9' }])
    expect(t.focused()).toBe(1)
    expect(t.fakes[0]!.destroyed).toBe(true)
    expect(t.apps.count()).toBe(0)
  })

  it('lets everything go when the window closes: trust, the engine’s window, the page; and keeps nothing', () => {
    const t = setup()
    t.apps.open(request())
    const wc = t.fakes[0]!.webContents.id
    t.fakes[0]!.close()
    expect(t.windows.size).toBe(0)
    expect(t.trusted.has(wc)).toBe(false)
    expect(t.pages[0]!.page.destroyed).toBe(true)
    expect(t.apps.count()).toBe(0)
    expect(t.dispatched).toEqual([])
  })

  it('a page that closes itself takes its window with it', () => {
    const t = setup()
    t.apps.open(request())
    t.pages[0]!.events.closed?.()
    expect(t.fakes[0]!.destroyed).toBe(true)
  })

  it('closeLocked() closes the windows made from a locked space, destroys their pages and trust, and leaves the others alone (this fails if it is not called or does not close)', () => {
    const t = setup()
    t.apps.open(request({ spaceId: 'locked' }))
    t.apps.open(request({ spaceId: 'free', url: 'https://other.example.com/' }))
    t.apps.open(request({ spaceId: 'locked', url: 'https://third.example.com/' }))
    const wc = t.fakes.map((f) => f.webContents.id)
    t.apps.closeLocked((spaceId) => spaceId === 'locked')
    expect(t.fakes.map((f) => f.destroyed)).toEqual([true, false, true])
    expect(t.pages.map((p) => p.page.destroyed)).toEqual([true, false, true])
    expect(t.apps.states().map((s) => s.url)).toEqual(['https://other.example.com/'])
    expect(t.trusted.has(wc[0]!)).toBe(false)
    expect(t.trusted.has(wc[1]!)).toBe(true)
    expect(t.windows.has('webapp-2')).toBe(true)
    expect(t.windows.has('webapp-1')).toBe(false)
    // A second call, or the closed events that come later, change nothing.
    t.apps.closeLocked((spaceId) => spaceId === 'locked')
    expect(t.apps.count()).toBe(1)
  })

  it('closeLocked() does not wait for the window to say it is closed: the page is destroyed and the window no longer trusted at once (Electron closes a window a moment later)', () => {
    const slow = () => {
      const f = fakeWindow()
      // A window that closes later: `close()` asks, and `closed` comes afterwards.
      f.win.close = () => undefined
      return f
    }
    const t = setup({ createWindow: slow })
    t.apps.open(request({ spaceId: 'locked' }))
    const wc = t.fakes[0]!.webContents.id
    t.apps.closeLocked(() => true)
    expect(t.pages[0]!.page.destroyed).toBe(true)
    expect(t.trusted.has(wc)).toBe(false)
    expect(t.apps.count()).toBe(0)
    // The event that comes later finds nothing to do.
    expect(() => t.fakes[0]!.close()).not.toThrow()
    expect(t.apps.count()).toBe(0)
  })

  it('closeLocked() with the whole application locked closes every window, and its header answers nothing afterwards', () => {
    const t = setup()
    t.apps.open(request())
    t.apps.open(request({ spaceId: 'free' }))
    const first = t.fakes[0]!
    t.apps.closeLocked(() => true)
    expect(t.apps.count()).toBe(0)
    expect(t.pages.every((p) => p.page.destroyed)).toBe(true)
    send(t, first, 'webapp-1', 'open-in-main')
    expect(t.dispatched).toEqual([])
  })

  it('stop() closes the windows, removes its listener from the IPC and opens nothing afterwards', () => {
    const t = setup()
    t.apps.open(request())
    t.apps.open(request())
    expect(electron.ipc.listenerCount(Channel.littleAction)).toBe(1)
    t.apps.stop()
    expect(t.fakes.every((f) => f.destroyed)).toBe(true)
    expect(electron.ipc.listenerCount(Channel.littleAction)).toBe(0)
    expect(t.apps.open(request())).toBeNull()
    expect(t.apps.count()).toBe(0)
  })
})

describe('the title bar of an application window', () => {
  it('keeps the three lights centred on the header on macOS', () => {
    expect(webAppWindowFrame(createPlatform('darwin'))).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: Math.round((WEB_APP_HEADER_HEIGHT - 14) / 2) } })
  })

  it('leaves the system title bar on Windows and Linux when no buttons are asked for: a hidden bar there would leave the window with no button to close it', () => {
    for (const id of ['win32', 'linux'] as const) expect(webAppWindowFrame(createPlatform(id))).toEqual({})
  })

  it('lays the three buttons of Windows over the header, as high as the header, in the colours given', () => {
    const overlay = controlsOverlay({ kind: 'app', margin: 0, toolbar: false, split: false, privateBar: false, appearance: 'dark' })
    expect(overlay.height).toBe(WEB_APP_HEADER_HEIGHT)
    expect(webAppWindowFrame(createPlatform('win32'), overlay)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: overlay })
  })

  it('keeps the system title bar on Linux and the lights on macOS even when the buttons are asked for', () => {
    const overlay = controlsOverlay({ kind: 'app', margin: 0, toolbar: false, split: false, privateBar: false, appearance: 'light' })
    expect(webAppWindowFrame(createPlatform('linux'), overlay)).toEqual({})
    expect(webAppWindowFrame(createPlatform('darwin'), overlay)).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: Math.round((WEB_APP_HEADER_HEIGHT - 14) / 2) } })
  })
})
