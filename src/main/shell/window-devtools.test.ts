import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { PageEvents } from '../engine/types'

// Mini windows and application windows have a page of their own and no menu bar worth the name: ⌥⌘I, ⌥⌘J, ⌥⌘C and F12 pressed there must
// open the tools of THAT page (through the menu bar they would open those of a tab of the main window), and a failure is said in a box.
const dialog = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 0 })) }))
vi.mock('electron', () => ({ BrowserWindow: class {}, clipboard: {}, dialog, ipcMain: { on: vi.fn() }, screen: {} }))

const { LittleArc } = await import('./little')
const { WebAppWindows } = await import('./web-apps')

let wcIds = 400
function fakeWindow() {
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    webContents: { id: ++wcIds, send: vi.fn(), isDestroyed: () => false, on: vi.fn(), once: vi.fn(), close: vi.fn() },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    setWindowButtonVisibility: vi.fn(),
    show: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 650 }),
    isDestroyed: () => win.destroyed,
    close: () => {
      win.destroyed = true
      win.emit('closed')
    }
  })
  return win
}

type Opened = (request: string) => Promise<{ ok: true } | { ok: false; reason: 'frontend' | 'not-opened'; detail?: string }>

function fakeEngine(openDevTools: Opened) {
  const pages: Array<{ events: PageEvents; page: { openDevTools: Mock<Opened> } }> = []
  const engine = {
    createPage: (_options: unknown, events: PageEvents) => {
      const page = { loadURL: vi.fn(), show: vi.fn(), destroy: vi.fn(), focus: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), openDevTools: vi.fn<Opened>(openDevTools) }
      pages.push({ events, page })
      return page
    },
    onDownload: vi.fn()
  }
  return { engine, pages }
}

const input = (key: string, over: Partial<{ code: string; meta: boolean; alt: boolean; shift: boolean; control: boolean }> = {}) => ({ key, meta: false, alt: false, shift: false, control: false, ...over })
const store = () => ({ get: () => createInitialState({ now: 1, newId: () => 'id' }), subscribe: () => () => undefined })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
  dialog.showMessageBox.mockClear()
})

describe('mini window', () => {
  function open(openDevTools: Opened) {
    const { engine, pages } = fakeEngine(openDevTools)
    const wins: Array<ReturnType<typeof fakeWindow>> = []
    const view = () => ({ webContents: { id: ++wcIds, send: vi.fn(), isDestroyed: () => false, on: vi.fn(), once: vi.fn(), close: vi.fn() }, setBounds: vi.fn() }) as never
    const little = new LittleArc({
      engine: engine as never,
      store: store() as never,
      browser: { dispatch: vi.fn() } as never,
      history: { of: () => ({ record: vi.fn(), retitle: vi.fn() }) } as never,
      windows: new Map() as never,
      trusted: new Set<number>(),
      workArea: () => ({ x: 0, y: 25, width: 1680, height: 960 }),
      createWindow: () => {
        const win = fakeWindow()
        wins.push(win)
        return win as never
      },
      createPicker: view,
      createTray: view,
      focusMain: vi.fn()
    })
    little.open('https://little.example/page')
    return { pages, wins }
  }

  it('opens the tools of its own page on ⌥⌘I, ⌥⌘J, ⌥⌘C and F12, and keeps the key from the menu bar', () => {
    const { pages } = open(async () => ({ ok: true }))
    const { events, page } = pages[0]!
    expect(events.shortcut!(input('i', { meta: true, alt: true }))).toBe(true)
    expect(events.shortcut!(input('∆', { meta: true, alt: true, code: 'KeyJ' }))).toBe(true)
    expect(events.shortcut!(input('c', { meta: true, alt: true }))).toBe(true)
    expect(events.shortcut!(input('F12'))).toBe(true)
    expect(page.openDevTools.mock.calls.map((call) => call[0])).toEqual(['tools', 'console', 'inspect', 'tools'])
  })

  it('says in a box on the window that the tools did not open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { pages, wins } = open(async () => ({ ok: false, reason: 'not-opened', detail: 'no devtools-opened after 10000 ms' }))
    pages[0]!.events.shortcut!(input('F12'))
    await flush()
    expect(dialog.showMessageBox).toHaveBeenCalledWith(wins[0], { type: 'warning', message: 'Les outils de développement n’ont pas pu s’ouvrir.' })
  })

  it('says the same when "Inspecter l’élément" of the page’s menu could not open them', () => {
    const { pages, wins } = open(async () => ({ ok: true }))
    pages[0]!.events.devToolsFailed!('Les outils de développement n’ont pas pu s’ouvrir.')
    expect(dialog.showMessageBox).toHaveBeenCalledWith(wins[0], { type: 'warning', message: 'Les outils de développement n’ont pas pu s’ouvrir.' })
  })

  it('leaves the other keys to the page', () => {
    const { pages } = open(async () => ({ ok: true }))
    expect(pages[0]!.events.shortcut!(input('i', { meta: true }))).toBe(false)
    expect(pages[0]!.page.openDevTools).not.toHaveBeenCalled()
  })
})

describe('application window', () => {
  function open(openDevTools: Opened) {
    const { engine, pages } = fakeEngine(openDevTools)
    const wins: Array<ReturnType<typeof fakeWindow>> = []
    const apps = new WebAppWindows({
      engine: engine as never,
      store: { get: () => ({ settings: { keyBindings: {}, stripCopiedLinks: false } }) } as never,
      browser: { dispatch: vi.fn(), showToast: vi.fn() } as never,
      windows: new Map() as never,
      trusted: new Set<number>(),
      focusMain: vi.fn(),
      createWindow: () => {
        const win = fakeWindow()
        wins.push(win)
        return win as never
      }
    })
    apps.open({ url: 'https://mail.example.com/inbox', name: 'Mail', icon: '', profileId: 'travail', spaceId: 'space-a' })
    return { pages, wins }
  }

  it('opens the tools of its own page on ⌥⌘J and F12', () => {
    const { pages } = open(async () => ({ ok: true }))
    expect(pages[0]!.events.shortcut!(input('j', { meta: true, alt: true }))).toBe(true)
    expect(pages[0]!.events.shortcut!(input('F12'))).toBe(true)
    expect(pages[0]!.page.openDevTools.mock.calls.map((call) => call[0])).toEqual(['console', 'tools'])
  })

  it('says in a box on the window that the panel could not be shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { pages, wins } = open(async () => ({ ok: false, reason: 'frontend' }))
    pages[0]!.events.shortcut!(input('j', { meta: true, alt: true }))
    await flush()
    expect(dialog.showMessageBox).toHaveBeenCalledWith(wins[0], { type: 'warning', message: 'Les outils de développement sont ouverts, mais le panneau demandé n’a pas pu s’afficher.' })
  })
})
