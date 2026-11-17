import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The electron surface the share uses, replaced: the windows are plain objects, and the handlers of ipcMain are called directly.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  status: { value: 'granted' as string },
  getSources: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(),
  focus: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  /** The annotation of a page (this application) holds ⌥⌘P: `isRegistered` says yes. */
  own: { value: false },
  windows: [] as Array<{ webContents: WebContentsMock; title?: string; destroyed: boolean; close(): void; getMediaSourceId(): string }>
}))

/** A message from the top frame of the page whose web contents has this id (a window of the test, or a page that is none of them). */
function fromMain(id: number): { sender: { id: number; mainFrame: object }; senderFrame: object } {
  const mainFrame = electron.windows.find((window) => window.webContents.id === id)?.webContents.mainFrame ?? {}
  return { sender: { id, mainFrame }, senderFrame: mainFrame }
}

/** The request to capture of the page of the view (the second window of a share). */
const viewRequest = (): { frame: object | undefined } => ({ frame: electron.windows[1]?.webContents.mainFrame })

/** The web contents of a window: the sends are recorded, and `finishLoad` plays the did-finish-load of the page. */
interface WebContentsMock {
  id: number
  /** The top frame of the page: a message is heard from it only. */
  mainFrame: object
  send: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  on(event: string, listener: () => void): void
  finishLoad(): void
}

vi.mock('electron', () => {
  class BrowserWindow {
    webContents: WebContentsMock
    title?: string
    destroyed = false
    private listeners = new Map<string, Array<() => void>>()
    constructor(options: { title?: string }) {
      this.title = options.title
      const loads: Array<() => void> = []
      this.webContents = {
        id: (electron.windows.length + 1) * 10,
        mainFrame: {},
        send: vi.fn(),
        reload: vi.fn(),
        on: (event, listener) => {
          if (event === 'did-finish-load') loads.push(listener)
        },
        finishLoad: () => loads.forEach((listener) => listener())
      }
      electron.windows.push(this)
    }
    on(event: string, listener: () => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    }
    once(event: string, listener: () => void): void {
      this.on(event, listener)
    }
    private emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener()
    }
    show(): void {}
    focus(): void {}
    restore(): void {}
    isMinimized(): boolean {
      return false
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      this.destroyed = true
      this.emit('closed')
    }
    getMediaSourceId(): string {
      return `window:${9000 + this.webContents.id}:1`
    }
  }
  return {
    BrowserWindow,
    desktopCapturer: { getSources: electron.getSources },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => electron.handlers.set(channel, handler),
      on: (channel: string, handler: (...args: any[]) => any) => electron.listeners.set(channel, handler)
    },
    app: { focus: electron.focus },
    globalShortcut: { register: electron.register, unregister: electron.unregister, isRegistered: () => electron.own.value },
    session: { fromPartition: () => ({ setDisplayMediaRequestHandler: electron.setDisplayMediaRequestHandler }) },
    systemPreferences: { getMediaAccessStatus: () => electron.status.value }
  }
})

import { WindowShare, type WindowShareDeps } from './window-share'
import { WINDOW_SHARE_CHANNEL, shortcutHintKey } from '@shared/window-share'
import { fr } from '@shared/i18n-fr'
import { DEFAULT_BRUSH } from '@shared/window-share-draw'
import { PASS_SHORTCUT } from '@shared/window-share-pass'
import type { NativeAccess } from './window-share-native'
import { setLockService } from '../lock-service'

const DRAW = WINDOW_SHARE_CHANNEL.draw
const CLICK = WINDOW_SHARE_CHANNEL.click

/** The native calls of the passage mode, replaced: each test sets what the system answers. */
const native = vi.hoisted(() => ({
  trusted: vi.fn(),
  window: vi.fn(),
  onScreen: vi.fn(),
  activate: vi.fn(),
  click: vi.fn()
}))
const nativeAccess = (): NativeAccess => native as unknown as NativeAccess

const sources = [
  { id: 'window:101:1', name: 'Navigateur' },
  { id: 'window:202:1', name: 'Fenêtre privée' }
]
const privateWindow = { getMediaSourceId: () => 'window:202:1', isDestroyed: () => false }

/** A share with its command window open, and the call of each channel as the command window makes it. */
function openShare(privateWindows: unknown[] = [privateWindow], nativeCalls: () => Promise<NativeAccess> = async () => nativeAccess(), platform: NodeJS.Platform = 'darwin') {
  const load = vi.fn()
  // macOS whatever the machine of the run: the screen permission these tests play is read on that system only.
  const deps: WindowShareDeps = { load, privateWindows: () => privateWindows as never, preload: '/preload.js', viewPreload: '/view-preload.js', language: () => 'fr', native: nativeCalls, platform }
  const share = new WindowShare(deps)
  share.open()
  const commandId = electron.windows[0]!.webContents.id
  const from = fromMain(commandId)
  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!(from, ...args)
  return { share, load, call, commandId }
}

beforeEach(() => {
  electron.handlers.clear()
  electron.listeners.clear()
  electron.windows.length = 0
  electron.status.value = 'granted'
  electron.getSources.mockReset().mockResolvedValue(sources.map((s) => ({ ...s, thumbnail: null })))
  electron.setDisplayMediaRequestHandler.mockReset()
  electron.focus.mockReset()
  electron.register.mockReset().mockReturnValue(true)
  electron.unregister.mockReset()
  electron.own.value = false
  native.trusted.mockReset().mockReturnValue(true)
  native.window.mockReset().mockReturnValue({ bounds: { x: 0, y: 0, width: 1440, height: 900 }, pid: 4242 })
  native.onScreen.mockReset().mockReturnValue(true)
  native.activate.mockReset().mockReturnValue(true)
  native.click.mockReset().mockReturnValue(true)
})

describe('the list of the command window', () => {
  it('lists the normal windows, and never a private one', async () => {
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: true, windows: [{ id: 'window:101:1', name: 'Navigateur' }] })
  })

  it('reports a failed read to the command window, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    electron.getSources.mockRejectedValue(new Error('boom'))
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: false, reason: 'failed' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('lists once when macOS says "denied" (it says so before ever asking), then refuses while the permission is still missing', async () => {
    electron.status.value = 'denied'
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: false, reason: 'permission' })
    expect(electron.getSources).toHaveBeenCalledTimes(1)
  })

  it('asks nothing of the system when the screen is restricted', async () => {
    electron.status.value = 'restricted'
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: false, reason: 'permission' })
    expect(electron.getSources).not.toHaveBeenCalled()
  })

  it('takes an empty list, without the permission, for the system refusing', async () => {
    electron.status.value = 'not-determined'
    electron.getSources.mockResolvedValue([])
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: false, reason: 'permission' })
  })

  it('reads no screen permission where the system has none: off macOS the list is what the system gives, even empty', async () => {
    electron.status.value = 'restricted'
    const { call } = openShare([privateWindow], async () => nativeAccess(), 'linux')
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: true, windows: [{ id: 'window:101:1', name: 'Navigateur' }] })
    electron.getSources.mockResolvedValue([])
    expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: true, windows: [] })
  })
})

describe('starting a share', () => {
  it('refuses a private window, even when desktopCapturer gives it', async () => {
    const { call, load } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:202:1')).toEqual({ ok: false, reason: 'private' })
    // Only the command window exists: no view was made for the refused window.
    expect(electron.windows).toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("refuses the share's own command window", async () => {
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:9010:1')).toEqual({ ok: false, reason: 'own' })
  })

  it('grants the display request to the chosen window only, and nothing before it starts', async () => {
    const { call } = openShare()
    const grant = (): unknown => {
      let answer: unknown = 'no answer'
      electron.setDisplayMediaRequestHandler.mock.calls[0]![0](viewRequest(), (streams: unknown) => (answer = streams))
      return answer
    }
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')).toEqual({ ok: true })
    expect(grant()).toEqual({ video: { id: 'window:101:1', name: 'Navigateur' } })
    expect(electron.windows).toHaveLength(2)
    expect(electron.windows[1]!.title).toBe('Fenêtre annotée')
  })

  it('refuses the display request of anything but the page of the view', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const handler = electron.setDisplayMediaRequestHandler.mock.calls[0]![0] as (request: unknown, callback: (streams: unknown) => void) => void
    const answers: unknown[] = []
    // A frame inside the view, the command window, and a request that names no frame.
    for (const request of [{ frame: {} }, { frame: electron.windows[0]!.webContents.mainFrame }, { frame: null }, {}]) handler(request, (streams) => answers.push(streams))
    expect(answers).toEqual([null, null, null, null])
  })

  it('does not hear a frame inside the command window', async () => {
    const { commandId } = openShare()
    const mainFrame = electron.windows[0]!.webContents.mainFrame
    const fromFrame = { sender: { id: commandId, mainFrame }, senderFrame: {} }
    expect(await electron.handlers.get(WINDOW_SHARE_CHANNEL.list)!(fromFrame)).toEqual({ ok: false, reason: 'failed' })
    expect(await electron.handlers.get(WINDOW_SHARE_CHANNEL.start)!(fromFrame, 'window:101:1')).toEqual({ ok: false, reason: 'failed' })
    expect(electron.windows).toHaveLength(1)
  })

  it('ends the grant when the share stops, and tells the command window', async () => {
    const { call, commandId } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await call(WINDOW_SHARE_CHANNEL.stop)
    const handler = electron.setDisplayMediaRequestHandler.mock.calls[0]![0] as (request: unknown, callback: (streams: unknown) => void) => void
    let answer: unknown = 'no answer'
    handler(viewRequest(), (streams) => (answer = streams))
    expect(answer).toBeNull()
    const command = electron.windows[0]!
    expect(command.webContents.id).toBe(commandId)
    expect(command.webContents.send).toHaveBeenLastCalledWith(WINDOW_SHARE_CHANNEL.state, { sharing: null, missing: false, pass: false, passNote: null, shortcut: 'off', hidden: false, blank: false })
  })

  it('refuses a call from a window that is not the command window', async () => {
    openShare()
    const answer = electron.handlers.get(WINDOW_SHARE_CHANNEL.list)!(fromMain(999))
    expect(answer).toEqual({ ok: false, reason: 'failed' })
    expect(electron.getSources).not.toHaveBeenCalled()
  })
})

describe('the drawing', () => {
  const pen = { tool: 'pen', color: '#e53935', width: 5 }

  it('sends the brush to the view once its page has loaded, and to the view alone', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    expect(view.webContents.send).not.toHaveBeenCalled()
    view.webContents.finishLoad()
    expect(view.webContents.send).toHaveBeenCalledWith(DRAW, { type: 'brush', brush: DEFAULT_BRUSH })
    expect(electron.windows[0]!.webContents.send).not.toHaveBeenCalledWith(DRAW, expect.anything())
  })

  it('forwards a brush of the palette to the view, and drops a brush outside it', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    await call(WINDOW_SHARE_CHANNEL.brush, { ...pen, color: '#000000' })
    expect(view.webContents.send).not.toHaveBeenCalled()
    await call(WINDOW_SHARE_CHANNEL.brush, pen)
    expect(view.webContents.send).toHaveBeenCalledWith(DRAW, { type: 'brush', brush: pen })
  })

  it('forwards undo, redo and clear, and refuses any other command', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    await call(WINDOW_SHARE_CHANNEL.edit, 'undo')
    expect(view.webContents.send).toHaveBeenLastCalledWith(DRAW, { type: 'undo' })
    await call(WINDOW_SHARE_CHANNEL.edit, 'delete')
    await call(WINDOW_SHARE_CHANNEL.edit, { type: 'clear' })
    expect(view.webContents.send).toHaveBeenCalledTimes(1)
  })

  // The share closes when the application locks; its two windows must not be heard behind the lock screen if one is still there.
  it('hears neither the command window nor the view while the application is locked, and the log says so', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    try {
      expect(await call(WINDOW_SHARE_CHANNEL.list)).toEqual({ ok: false, reason: 'failed' })
      await call(WINDOW_SHARE_CHANNEL.edit, 'clear')
      expect(view.webContents.send).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('[lock] ignored the share window: the application is locked')
      electron.listeners.get(WINDOW_SHARE_CHANNEL.picture)!(fromMain(view.webContents.id), true)
      expect(warn).toHaveBeenCalledWith('[lock] ignored the view of the share: the application is locked')
      locked = false
      await call(WINDOW_SHARE_CHANNEL.edit, 'clear')
      expect(view.webContents.send).toHaveBeenLastCalledWith(DRAW, { type: 'clear' })
    } finally {
      setLockService(null)
      warn.mockRestore()
    }
  })

  it('takes no edit from a window that is not the command window', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    electron.handlers.get(WINDOW_SHARE_CHANNEL.edit)!(fromMain(999), 'clear')
    expect(view.webContents.send).not.toHaveBeenCalled()
  })
})


describe('moving the share to another window', () => {
  it('keeps the same view window, without reloading it, and grants and reports the new window', async () => {
    electron.getSources.mockResolvedValue([...sources, { id: 'window:404:1', name: 'Notes', thumbnail: null }].map((s) => ({ ...s, thumbnail: null })))
    const { call } = openShare()
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')).toEqual({ ok: true })
    const view = electron.windows[1]!
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:404:1')).toEqual({ ok: true })
    // The same window: no second one made, the first one neither closed nor reloaded. Its picture is asked again.
    expect(electron.windows).toHaveLength(2)
    expect(view.destroyed).toBe(false)
    expect(view.webContents.reload).not.toHaveBeenCalled()
    expect(view.webContents.send).toHaveBeenLastCalledWith(DRAW, { type: 'source' })
    // The grant and the state follow the new window.
    const grant = electron.setDisplayMediaRequestHandler.mock.calls.at(-1)![0] as (request: unknown, callback: (streams: unknown) => void) => void
    let answer: unknown = 'no answer'
    grant(viewRequest(), (streams) => (answer = streams))
    expect(answer).toEqual({ video: { id: 'window:404:1', name: 'Notes' } })
    expect(electron.windows[0]!.webContents.send).toHaveBeenLastCalledWith(WINDOW_SHARE_CHANNEL.state, {
      sharing: { id: 'window:404:1', name: 'Notes' },
      missing: false,
      pass: false,
      passNote: null,
      shortcut: 'on',
      hidden: false,
      blank: false
    })
  })
})

describe('the shared window closed', () => {
  const shared = { id: 'window:101:1', name: 'Navigateur' }
  const stateOf = (command: { webContents: WebContentsMock }) => command.webContents.send.mock.calls.filter(([channel]) => channel === WINDOW_SHARE_CHANNEL.state)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tells the command window when the shared window is no longer listed', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const command = electron.windows[0]!
    electron.getSources.mockResolvedValue([{ id: 'window:303:1', name: 'Autre', thumbnail: null }])
    await vi.advanceTimersByTimeAsync(2000)
    expect(command.webContents.send).toHaveBeenLastCalledWith(WINDOW_SHARE_CHANNEL.state, { sharing: shared, missing: true, pass: false, passNote: null, shortcut: 'on', hidden: false, blank: false })
  })

  it('says nothing while the window is still listed, and nothing when the list cannot be read', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const command = electron.windows[0]!
    const before = stateOf(command).length
    await vi.advanceTimersByTimeAsync(4000)
    electron.getSources.mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(4000)
    expect(stateOf(command)).toHaveLength(before)
  })

  it('stops looking once the share stops', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    expect(vi.getTimerCount()).toBe(1)
    await call(WINDOW_SHARE_CHANNEL.stop)
    // The timer itself is gone, not only ignored: a check left running would keep waking up for nothing.
    expect(vi.getTimerCount()).toBe(0)
    electron.getSources.mockClear()
    await vi.advanceTimersByTimeAsync(6000)
    expect(electron.getSources).not.toHaveBeenCalled()
  })

  it('clears the flag when another window is chosen', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const command = electron.windows[0]!
    electron.getSources.mockResolvedValue([{ id: 'window:303:1', name: 'Autre', thumbnail: null }])
    await vi.advanceTimersByTimeAsync(2000)
    expect(await call(WINDOW_SHARE_CHANNEL.start, 'window:303:1')).toEqual({ ok: true })
    expect(command.webContents.send).toHaveBeenLastCalledWith(WINDOW_SHARE_CHANNEL.state, {
      sharing: { id: 'window:303:1', name: 'Autre' },
      missing: false,
      pass: false,
      passNote: null,
      shortcut: 'on',
      hidden: false,
      blank: false
    })
  })
})

describe('the passage mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** The click the view page sends for a point of its window (the picture is 960 × 480 at y 60, the stream 1440 × 900). */
  const clickAt = (point: { x: number; y: number } = { x: 480, y: 300 }) => ({
    point,
    picture: { x: 0, y: 60, width: 960, height: 480 },
    stream: { width: 1440, height: 900 }
  })
  /** A share started, its passage asked: the view and the command window, and the call of the view's click. */
  async function sharing(nativeCalls?: () => Promise<NativeAccess>) {
    // A share made after another one in the same test: its windows are the first of the list.
    electron.windows.length = 0
    const share = openShare(undefined, nativeCalls)
    expect(await share.call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')).toEqual({ ok: true })
    const view = electron.windows[1]!
    const command = electron.windows[0]!
    const viewClick = (raw: unknown, from: unknown = fromMain(view.webContents.id)) => electron.listeners.get(CLICK)!(from, raw)
    return { ...share, view, command, viewClick }
  }
  const lastState = (command: { webContents: WebContentsMock }) => command.webContents.send.mock.calls.filter(([channel]) => channel === WINDOW_SHARE_CHANNEL.state).at(-1)![1]

  it('switches nothing while no window is shared, and loads nothing for it', async () => {
    const loader = vi.fn(async () => nativeAccess())
    const { call } = openShare(undefined, loader)
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    expect(loader).not.toHaveBeenCalled()
    expect(native.trusted).not.toHaveBeenCalled()
  })

  it('takes the switch from the command window only, and only as a yes or no', async () => {
    const { call } = await sharing()
    await electron.handlers.get(WINDOW_SHARE_CHANNEL.pass)!(fromMain(999), true)
    await call(WINDOW_SHARE_CHANNEL.pass, 'yes')
    expect(native.trusted).not.toHaveBeenCalled()
  })

  it('refuses the passage mode without the Accessibility permission, and asks for the permission only then', async () => {
    native.trusted.mockReturnValue(false)
    const { call, view, command } = await sharing()
    expect(await call(WINDOW_SHARE_CHANNEL.pass, true)).toBeUndefined()
    expect(native.trusted).toHaveBeenCalledWith(true)
    expect(lastState(command)).toMatchObject({ pass: false, passNote: 'accessibility' })
    expect(view.webContents.send).not.toHaveBeenCalledWith(DRAW, { type: 'pass', on: true })
  })

  it('switches the passage mode on once the permission is granted, and tells the view', async () => {
    const { call, view, command } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    expect(view.webContents.send).toHaveBeenLastCalledWith(DRAW, { type: 'pass', on: true })
    expect(lastState(command)).toMatchObject({ pass: true, passNote: null })
  })

  it('brings the window to the front, sends the click at the point of the window, then brings the view back', async () => {
    const order: string[] = []
    native.activate.mockImplementation(() => (order.push('activate'), true))
    native.click.mockImplementation(() => (order.push('click'), true))
    const { call, viewClick } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.window).toHaveBeenCalledWith(101)
    expect(native.activate).toHaveBeenCalledWith(4242)
    // The centre of the picture is the centre of the 1440 × 900 window.
    expect(native.click).toHaveBeenCalledWith({ x: 720, y: 450 })
    expect(order).toEqual(['activate', 'click'])
    expect(electron.focus).toHaveBeenCalledWith({ steal: true })
  })

  it('sends no click, and activates nothing, when the permission is gone after the mode was switched on', async () => {
    const { call, viewClick, command } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    native.trusted.mockReturnValue(false)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.activate).not.toHaveBeenCalled()
    expect(native.click).not.toHaveBeenCalled()
    expect(lastState(command)).toMatchObject({ pass: false, passNote: 'accessibility' })
  })

  it('sends no click for a point of the margin around the picture, nor when the window changed proportions', async () => {
    const { call, viewClick } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt({ x: 500, y: 20 }))
    await vi.advanceTimersByTimeAsync(200)
    expect(native.click).not.toHaveBeenCalled()
    native.window.mockReturnValue({ bounds: { x: 0, y: 0, width: 1000, height: 900 }, pid: 4242 })
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.activate).not.toHaveBeenCalled()
    expect(native.click).not.toHaveBeenCalled()
  })

  it('reports that the shared window is gone, and sends nothing', async () => {
    const { call, viewClick, command } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    native.window.mockReturnValue(null)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.click).not.toHaveBeenCalled()
    expect(lastState(command)).toMatchObject({ passNote: 'unavailable' })
  })

  it('takes a click only from the view, and only when it is well formed', async () => {
    const { call, viewClick, command } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt(), fromMain(command.webContents.id))
    viewClick({ ...clickAt(), point: { x: Number.NaN, y: 1 } })
    viewClick({ point: { x: 1, y: 1 } })
    await vi.advanceTimersByTimeAsync(200)
    expect(native.window).not.toHaveBeenCalled()
    expect(native.click).not.toHaveBeenCalled()
  })

  it('takes no second click while the first one is being sent', async () => {
    const { call, viewClick } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt())
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.activate).toHaveBeenCalledTimes(1)
    expect(native.click).toHaveBeenCalledTimes(1)
  })

  it('sends no click when the share stopped while the window was being brought forward', async () => {
    const { call, viewClick } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt())
    // The window is brought forward (the delay runs), then the share stops before the click.
    await vi.advanceTimersByTimeAsync(10)
    expect(native.activate).toHaveBeenCalledTimes(1)
    await call(WINDOW_SHARE_CHANNEL.stop)
    await vi.advanceTimersByTimeAsync(200)
    expect(native.click).not.toHaveBeenCalled()
  })

  it('does not turn the mode on when the share ended while the permission was being read', async () => {
    let answer: (native: NativeAccess) => void = () => {}
    const { call, command } = await sharing(() => new Promise<NativeAccess>((resolve) => (answer = resolve)))
    const asked = call(WINDOW_SHARE_CHANNEL.pass, true)
    await call(WINDOW_SHARE_CHANNEL.stop)
    answer(nativeAccess())
    await asked
    expect(lastState(command)).toMatchObject({ pass: false })
  })

  it('sends nothing while the mode is off, even for a click of the view', async () => {
    const { viewClick } = await sharing()
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.click).not.toHaveBeenCalled()
  })

  it('does not send back the clicks that come right after one, while the view may take the click', async () => {
    const { call, viewClick } = await sharing()
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(100)
    expect(native.click).toHaveBeenCalledTimes(1)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(100)
    expect(native.click).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    viewClick(clickAt())
    await vi.advanceTimersByTimeAsync(200)
    expect(native.click).toHaveBeenCalledTimes(2)
  })

  it('ends with the share, with the view closed, and with the lock of the application', async () => {
    const stopped = await sharing()
    await stopped.call(WINDOW_SHARE_CHANNEL.pass, true)
    await stopped.call(WINDOW_SHARE_CHANNEL.stop)
    expect(lastState(stopped.command)).toMatchObject({ pass: false, passNote: null })

    const closed = await sharing()
    await closed.call(WINDOW_SHARE_CHANNEL.pass, true)
    closed.view.close()
    expect(lastState(closed.command)).toMatchObject({ pass: false, passNote: null })

    // The lock with the command window already gone: the share still ends by itself (the close of the command window is not the way in).
    const locked = await sharing()
    await locked.call(WINDOW_SHARE_CHANNEL.pass, true)
    locked.command.destroyed = true
    locked.share.close()
    expect(electron.unregister).toHaveBeenCalledWith(PASS_SHORTCUT)
    expect(locked.view.destroyed).toBe(true)
  })

  it('says the passage mode is unavailable when the native calls cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { call, command } = await sharing(async () => {
      throw new Error('no koffi')
    })
    await call(WINDOW_SHARE_CHANNEL.pass, true)
    expect(lastState(command)).toMatchObject({ pass: false, passNote: 'unavailable' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the shortcut ⌥⌘P', () => {
  it('holds the shortcut while a window is shared, and releases it when the share stops', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    expect(electron.register).toHaveBeenCalledWith(PASS_SHORTCUT, expect.any(Function))
    await call(WINDOW_SHARE_CHANNEL.stop)
    expect(electron.unregister).toHaveBeenCalledWith(PASS_SHORTCUT)
    // Held once: stopping does not hold it again.
    expect(electron.register).toHaveBeenCalledTimes(1)
  })

  it('switches the passage mode from the shortcut, whatever window has the focus', async () => {
    const { call } = openShare()
    const command = electron.windows[0]!
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const press = electron.register.mock.calls[0]![1] as () => void
    press()
    await vi.waitFor(() => expect(command.webContents.send.mock.calls.filter(([channel]) => channel === WINDOW_SHARE_CHANNEL.state).at(-1)![1]).toMatchObject({ pass: true }))
    press()
    await vi.waitFor(() => expect(command.webContents.send.mock.calls.filter(([channel]) => channel === WINDOW_SHARE_CHANNEL.state).at(-1)![1]).toMatchObject({ pass: false }))
  })

  it('does not hold the shortcut at all while its switch is off, when a share starts or stops', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.shortcut, false)
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await call(WINDOW_SHARE_CHANNEL.stop)
    expect(electron.register).not.toHaveBeenCalled()
  })

  it('holds nothing while its switch is off, and holds it again when the switch goes on', async () => {
    const { call } = openShare()
    const command = electron.windows[0]!
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await call(WINDOW_SHARE_CHANNEL.shortcut, false)
    expect(electron.unregister).toHaveBeenCalledWith(PASS_SHORTCUT)
    expect(command.webContents.send.mock.calls.at(-1)![1]).toMatchObject({ shortcut: 'off' })
    electron.register.mockClear()
    await call(WINDOW_SHARE_CHANNEL.shortcut, true)
    expect(electron.register).toHaveBeenCalledWith(PASS_SHORTCUT, expect.any(Function))
  })

  it('takes the switch only as a yes or no: a value of another kind leaves the shortcut as it is', async () => {
    const { call } = openShare()
    const command = electron.windows[0]!
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    electron.unregister.mockClear()
    await call(WINDOW_SHARE_CHANNEL.shortcut, 0)
    expect(electron.unregister).not.toHaveBeenCalled()
    expect(command.webContents.send.mock.calls.at(-1)![1]).toMatchObject({ shortcut: 'on' })
  })

  it('says so when another application holds the shortcut', async () => {
    electron.register.mockReturnValue(false)
    const { call } = openShare()
    const command = electron.windows[0]!
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    expect(command.webContents.send.mock.calls.at(-1)![1]).toMatchObject({ shortcut: 'taken' })
  })

  it('says it is the annotation of a page when Lucium itself holds the shortcut, and does not ask for it', async () => {
    electron.own.value = true
    const { call } = openShare()
    const command = electron.windows[0]!
    electron.register.mockClear()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    expect(electron.register).not.toHaveBeenCalled()
    expect(command.webContents.send.mock.calls.at(-1)![1]).toMatchObject({ shortcut: 'own' })
  })

  it('has a sentence of its own for each holder, and none when the shortcut is held or off', () => {
    expect(shortcutHintKey('taken')).toBe('window-share.raccourci-pris')
    expect(shortcutHintKey('own')).toBe('window-share.raccourci-pris-annotation')
    expect(shortcutHintKey('on')).toBeNull()
    expect(shortcutHintKey('off')).toBeNull()
    expect(fr['window-share.raccourci-pris-annotation']).toContain('Lucium')
    expect(fr['window-share.raccourci-pris-annotation']).not.toContain('autre application')
    expect(fr['page-annotate.note-raccourci-partage']).not.toContain('autre application')
  })
})

/** The last state the command window was sent. */
const lastStateOf = (command: { webContents: WebContentsMock }) => command.webContents.send.mock.calls.filter(([channel]) => channel === WINDOW_SHARE_CHANNEL.state).at(-1)![1]
const NOTICE = WINDOW_SHARE_CHANNEL.draw

describe('the shared window that is not on the screen', () => {
  const shared = { id: 'window:101:1', name: 'Navigateur' }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // A minimized window, a hidden one or one on another desktop is still listed, but macOS does not have it on the screen: it sends no picture.
  it('tells the command window and the view that the listed window is away when macOS does not have it on the screen', async () => {
    native.onScreen.mockReturnValue(false)
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await vi.advanceTimersByTimeAsync(2000)
    const command = electron.windows[0]!
    expect(lastStateOf(command)).toEqual({ sharing: shared, missing: false, pass: false, passNote: null, shortcut: 'on', hidden: true, blank: false })
    expect(electron.windows[1]!.webContents.send).toHaveBeenLastCalledWith(NOTICE, { type: 'notice', notice: 'away' })
    expect(native.onScreen).toHaveBeenCalledWith(101)
  })

  it('reads the state at the start of the share, not two seconds later', async () => {
    native.onScreen.mockReturnValue(false)
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await vi.advanceTimersByTimeAsync(10)
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ hidden: true })
  })

  it('says nothing while macOS has the window on the screen, or while it cannot tell', async () => {
    native.onScreen.mockReturnValue(true)
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await vi.advanceTimersByTimeAsync(4000)
    native.onScreen.mockReturnValue(null)
    await vi.advanceTimersByTimeAsync(4000)
    const command = electron.windows[0]!
    expect(lastStateOf(command)).toMatchObject({ hidden: false })
    expect(electron.windows[1]!.webContents.send).not.toHaveBeenCalledWith(NOTICE, { type: 'notice', notice: 'away' })
  })

  it('clears the notice when the window is back on the screen', async () => {
    native.onScreen.mockReturnValue(false)
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    await vi.advanceTimersByTimeAsync(2000)
    native.onScreen.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ hidden: false })
    expect(electron.windows[1]!.webContents.send).toHaveBeenLastCalledWith(NOTICE, { type: 'notice', notice: null })
  })

  it('says the window is closed, not away, when it is no longer listed', async () => {
    native.onScreen.mockReturnValue(false)
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    electron.getSources.mockResolvedValue([{ id: 'window:303:1', name: 'Autre', thumbnail: null }])
    await vi.advanceTimersByTimeAsync(2000)
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ missing: true, hidden: false })
    expect(electron.windows[1]!.webContents.send).toHaveBeenLastCalledWith(NOTICE, { type: 'notice', notice: 'closed' })
  })
})

describe('the picture of the view', () => {
  const shared = { id: 'window:101:1', name: 'Navigateur' }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is taken from the view window: a black picture is away, and the view is told the same', async () => {
    const { call, commandId } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    const picture = electron.listeners.get(WINDOW_SHARE_CHANNEL.picture)!
    picture(fromMain(view.webContents.id), true)
    expect(lastStateOf(electron.windows[0]!)).toEqual({ sharing: shared, missing: false, pass: false, passNote: null, shortcut: 'on', hidden: false, blank: true })
    expect(view.webContents.send).toHaveBeenLastCalledWith(NOTICE, { type: 'notice', notice: 'away' })
    picture(fromMain(view.webContents.id), false)
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ blank: false })
    expect(view.webContents.send).toHaveBeenLastCalledWith(NOTICE, { type: 'notice', notice: null })
    expect(commandId).toBe(electron.windows[0]!.webContents.id)
  })

  it('is refused from any window but the view, and when it is not a boolean', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    const view = electron.windows[1]!
    const picture = electron.listeners.get(WINDOW_SHARE_CHANNEL.picture)!
    picture(fromMain(electron.windows[0]!.webContents.id), true)
    picture(fromMain(999), true)
    picture(fromMain(view.webContents.id), 'yes')
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ blank: false })
    expect(view.webContents.send).not.toHaveBeenCalledWith(NOTICE, { type: 'notice', notice: 'away' })
  })

  it('does not carry a black verdict into the next share', async () => {
    const { call } = openShare()
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    electron.listeners.get(WINDOW_SHARE_CHANNEL.picture)!(fromMain(electron.windows[1]!.webContents.id), true)
    await call(WINDOW_SHARE_CHANNEL.stop)
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ blank: false, hidden: false })
    await call(WINDOW_SHARE_CHANNEL.start, 'window:101:1')
    expect(lastStateOf(electron.windows[0]!)).toMatchObject({ blank: false })
  })
})
