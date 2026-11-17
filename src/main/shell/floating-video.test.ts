// Lucium's floating video window (floating-video.ts) with windows, views and pages that are stand-ins: what floats it and what does not (a video
// in a frame of the page, none), where it opens, what its bar may drive and who may drive it, the tab's sound, and how it ends (« Revenir à
// l'onglet », the close button, ⌘W, a page that closes). Nothing here opens a window.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { FLOATING_WATCH_MS, type FloatingVideoFacts } from '@shared/floating-video'
import type { FloatingStage } from '../engine/types'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { FloatingVideo, FLOATING_WINDOW_ID } = await import('./floating-video')
const { setLockService } = await import('../lock-service')

let contentsIds = 500

class FakeContents extends EventEmitter {
  readonly id = ++contentsIds
  readonly mainFrame = { top: true }
  destroyed = false
  send = vi.fn()
  focus = vi.fn()
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  bounds: { x: number; y: number; width: number; height: number }
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  setAspectRatio = vi.fn()
  setAlwaysOnTop = vi.fn()
  setVisibleOnAllWorkspaces = vi.fn()
  showInactive = vi.fn()
  show = vi.fn()
  moveTop = vi.fn()
  restore = vi.fn()
  constructor(bounds: { x: number; y: number; width: number; height: number }) {
    super()
    this.bounds = bounds
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return false
  }
  getBounds() {
    return this.bounds
  }
  getContentBounds() {
    return { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height }
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

const recorded = (over: Partial<FloatingVideoFacts> = {}): FloatingVideoFacts => ({ paused: false, ended: false, muted: false, volume: 1, currentTime: 10, duration: 600, live: false, behindLive: false, protected: false, width: 1280, height: 720, ...over })

function fakePage(options: { where?: 'page' | 'frame' | 'none'; stage?: FloatingStage; facts?: FloatingVideoFacts | null; lends?: boolean } = {}) {
  let ended: ((why: 'gone' | 'crashed' | 'navigated') => void) | null = null
  const loan = { place: vi.fn(), raise: vi.fn(), giveBack: vi.fn() }
  const page = {
    facts: options.facts === undefined ? recorded() : options.facts,
    findFloatingVideo: vi.fn(async () => options.where ?? 'page'),
    stageFloatingVideo: vi.fn(async (): Promise<FloatingStage> => options.stage ?? { staged: true, width: 1280, height: 720, live: false, protected: false }),
    unstageFloatingVideo: vi.fn(async () => undefined),
    floatingVideoFacts: vi.fn(async () => page.facts),
    floatingVideoCommand: vi.fn(async () => true),
    lendView: vi.fn((_windowId: string, onEnd: (why: 'gone' | 'crashed' | 'navigated') => void) => {
      if (options.lends === false) return null
      ended = onEnd
      return loan
    }),
    loan,
    /** The page closes, crashes or goes to another document while it is lent. */
    end: (why: 'gone' | 'crashed' | 'navigated') => ended?.(why)
  }
  return page
}

function fakeOwner(muted = false) {
  const owner = {
    muted,
    showTab: vi.fn(),
    tabMuted: vi.fn(() => owner.muted),
    setTabMuted: vi.fn((_tabId: string, value: boolean) => {
      owner.muted = value
    }),
    floatingChanged: vi.fn(),
    siteOf: vi.fn(() => 'twitch.tv'),
    windowBounds: vi.fn(() => ({ x: 0, y: 0, width: 1400, height: 900 }))
  }
  return owner
}

function setup() {
  let listener: ((event: unknown, raw: unknown) => void) | null = null
  const ipc = {
    on: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => void) => {
      if (channel === Channel.floatingVideoAction) listener = handler
    })
  }
  const windows = new Map<string, unknown>()
  const trusted = new Set<number>()
  const created: FakeWindow[] = []
  const bars: Array<{ webContents: FakeContents; setBounds: ReturnType<typeof vi.fn> }> = []
  const floating = new FloatingVideo({
    windows: windows as never,
    trusted,
    ipc: ipc as never,
    createWindow: (bounds) => {
      const win = new FakeWindow(bounds)
      created.push(win)
      return win as never
    },
    createBar: () => {
      const bar = { webContents: new FakeContents(), setBounds: vi.fn() }
      bars.push(bar)
      return bar as never
    },
    workArea: () => ({ x: 0, y: 25, width: 1512, height: 920 })
  })
  /** A message on the bar's channel, from `sender` (by default the bar of the window that floats), from its top frame unless said. */
  const send = (raw: unknown, sender: { id: number; mainFrame: object } = bars.at(-1)!.webContents, subframe = false) => {
    listener?.({ sender, senderFrame: subframe ? { top: false } : sender.mainFrame }, raw)
  }
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { floating, windows, trusted, created, bars, send, flush }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('floating a video', () => {
  it('lends the tab’s view to a window that opens at the bottom right, in the proportions of the video, above the others, without taking the focus', async () => {
    const { floating, windows, trusted, created, bars } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    expect(await floating.float(owner, 'tab-1', page as never)).toEqual({ ok: true })
    const win = created[0]!
    expect(win.bounds).toEqual({ x: 1512 - 480 - 16, y: 25 + 920 - 270 - 16, width: 480, height: 270 })
    expect(windows.get(FLOATING_WINDOW_ID)).toBe(win)
    expect(page.lendView).toHaveBeenCalledWith(FLOATING_WINDOW_ID, expect.any(Function))
    expect(page.loan.place).toHaveBeenCalledWith({ x: 0, y: 0, width: 480, height: 270 })
    // The bar is a surface of ours, over the page, while the window exists.
    expect(win.contentView.addChildView).toHaveBeenCalledWith(bars[0])
    expect(trusted.has(bars[0]!.webContents.id)).toBe(true)
    expect(win.setAspectRatio).toHaveBeenCalledWith(1280 / 720)
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { skipTransformProcessType: true })
    expect(win.showInactive).toHaveBeenCalled()
    expect(owner.floatingChanged).toHaveBeenCalledWith('tab-1', true)
    expect(floating.floatingTab()).toBe('tab-1')
  })

  it('gives the keys to the bar when the window takes the focus, whatever part of it was clicked', async () => {
    const { floating, created, bars } = setup()
    await floating.float(fakeOwner(), 't', fakePage() as never)
    created[0]!.emit('focus')
    expect(bars[0]!.webContents.focus).toHaveBeenCalled()
  })

  it('answers `frame` for a video that is only in a frame of the page, and `no-video` for none: no window opens', async () => {
    const { floating, created } = setup()
    expect(await floating.float(fakeOwner(), 't', fakePage({ where: 'frame' }) as never)).toEqual({ ok: false, reason: 'frame' })
    expect(await floating.float(fakeOwner(), 't', fakePage({ where: 'none' }) as never)).toEqual({ ok: false, reason: 'no-video' })
    expect(await floating.float(fakeOwner(), 't', fakePage({ stage: { staged: false, reason: 'no-video' } }) as never)).toEqual({ ok: false, reason: 'no-video' })
    expect(created).toEqual([])
  })

  it('closes the window it opened when the page cannot be lent, and gives the page back as it was', async () => {
    const { floating, windows, created } = setup()
    const page = fakePage({ lends: false })
    expect(await floating.float(fakeOwner(), 't', page as never)).toMatchObject({ ok: false, reason: 'refused' })
    expect(created[0]!.destroyed).toBe(true)
    expect(windows.has(FLOATING_WINDOW_ID)).toBe(false)
    expect(page.unstageFloatingVideo).toHaveBeenCalled()
  })

  it('brings the window to the front when the tab floats already, and floats one video at a time', async () => {
    const { floating, created } = setup()
    const first = fakePage()
    const firstOwner = fakeOwner()
    await floating.float(firstOwner, 'a', first as never)
    expect(await floating.float(firstOwner, 'a', first as never)).toEqual({ ok: true })
    expect(created).toHaveLength(1)
    expect(created[0]!.moveTop).toHaveBeenCalled()
    // Another tab: the first video goes back to its tab without showing it.
    await floating.float(fakeOwner(), 'b', fakePage() as never)
    expect(first.loan.giveBack).toHaveBeenCalled()
    expect(created[0]!.destroyed).toBe(true)
    expect(firstOwner.showTab).not.toHaveBeenCalled()
    expect(floating.floatingTab()).toBe('b')
  })

  it('opens the next window where the last one was, at its size', async () => {
    const { floating, created, send } = setup()
    await floating.float(fakeOwner(), 'a', fakePage() as never)
    created[0]!.bounds = { x: 100, y: 200, width: 640, height: 360 }
    created[0]!.emit('move')
    send({ kind: 'close' })
    await floating.float(fakeOwner(), 'a', fakePage() as never)
    expect(created[1]!.bounds).toEqual({ x: 100, y: 200, width: 640, height: 360 })
  })
})

describe('the bar', () => {
  // The floating window ends when the lock drops its page; a bar that is still there must not drive a video behind the lock screen.
  it('is not listened to while the application is locked, and the log says so', async () => {
    const { floating, send, flush } = setup()
    const page = fakePage()
    await floating.float(fakeOwner(), 't', page as never)
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    try {
      send({ kind: 'toggle' })
      await flush()
      expect(page.floatingVideoCommand).not.toHaveBeenCalled()
      expect(console.warn).toHaveBeenCalledWith(`[lock] ignored ${Channel.floatingVideoAction}: the application is locked`)
      locked = false
      send({ kind: 'toggle' })
      await flush()
      expect(page.floatingVideoCommand).toHaveBeenCalledWith({ kind: 'toggle' })
    } finally {
      setLockService(null)
    }
  })

  it('is listened to only from its own surface, through its top frame, and only for what it may ask', async () => {
    const { floating, send, flush } = setup()
    const page = fakePage()
    await floating.float(fakeOwner(), 't', page as never)
    send({ kind: 'toggle' }, { id: 99_999, mainFrame: {} })
    send({ kind: 'toggle' }, undefined, true)
    send({ kind: 'volume', value: 9 })
    await flush()
    expect(page.floatingVideoCommand).not.toHaveBeenCalled()
    send({ kind: 'toggle' })
    await flush()
    expect(page.floatingVideoCommand).toHaveBeenCalledWith({ kind: 'toggle' })
  })

  it('cuts the tab’s sound (the sidebar follows) and gives it back, with the video’s own when it was silent', async () => {
    const { floating, send, flush } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    await floating.float(owner, 't', page as never)
    send({ kind: 'watch', on: true })
    await flush()
    send({ kind: 'mute' })
    await flush()
    expect(owner.setTabMuted).toHaveBeenLastCalledWith('t', true)
    expect(page.floatingVideoCommand).not.toHaveBeenCalled()
    page.facts = recorded({ muted: true })
    send({ kind: 'mute' })
    await flush()
    expect(owner.setTabMuted).toHaveBeenLastCalledWith('t', false)
    expect(page.floatingVideoCommand).toHaveBeenCalledWith({ kind: 'unmute' })
  })

  it('never moves a live stream or a protected video in time', async () => {
    const { floating, send, flush } = setup()
    const page = fakePage({ facts: recorded({ live: true, duration: null }) })
    await floating.float(fakeOwner(), 't', page as never)
    send({ kind: 'watch', on: true })
    await flush()
    send({ kind: 'seek', seconds: 10 })
    await flush()
    expect(page.floatingVideoCommand).not.toHaveBeenCalled()
    page.facts = recorded()
    send({ kind: 'watch', on: false })
    send({ kind: 'watch', on: true })
    await flush()
    send({ kind: 'seek', seconds: -10 })
    await flush()
    expect(page.floatingVideoCommand).toHaveBeenCalledWith({ kind: 'seek', seconds: -10 })
  })

  it('is sent what it shows: the site, the pin, the tab’s sound and the video', async () => {
    const { floating, send, flush, bars } = setup()
    await floating.float(fakeOwner(true), 't', fakePage() as never)
    send({ kind: 'watch', on: true })
    await flush()
    expect(bars[0]!.webContents.send).toHaveBeenLastCalledWith(Channel.floatingVideoState, { site: 'twitch.tv', pinned: true, tabMuted: true, facts: recorded() })
    send({ kind: 'pin' })
    expect(bars[0]!.webContents.send).toHaveBeenLastCalledWith(Channel.floatingVideoState, expect.objectContaining({ pinned: false }))
  })

  it('reads the video only while it is on screen', async () => {
    vi.useFakeTimers()
    try {
      const { floating, send } = setup()
      const page = fakePage()
      await floating.float(fakeOwner(), 't', page as never)
      await vi.advanceTimersByTimeAsync(FLOATING_WATCH_MS * 10)
      expect(page.floatingVideoFacts).not.toHaveBeenCalled()
      send({ kind: 'watch', on: true })
      await vi.advanceTimersByTimeAsync(FLOATING_WATCH_MS * 4)
      expect(page.floatingVideoFacts).toHaveBeenCalledTimes(5)
      // Told twice that it is on screen, it reads it at the same pace: one reading at a time.
      send({ kind: 'watch', on: true })
      expect(vi.getTimerCount()).toBe(1)
      send({ kind: 'watch', on: false })
      await vi.advanceTimersByTimeAsync(FLOATING_WATCH_MS * 10)
      expect(page.floatingVideoFacts).toHaveBeenCalledTimes(5)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the end of a floating video', () => {
  it('« Revenir à l’onglet »: the page is given back, the view goes back to its tab, which is shown in its window brought to the front', async () => {
    const { floating, send, windows, trusted, created, bars } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    await floating.float(owner, 't', page as never)
    send({ kind: 'back' })
    expect(page.unstageFloatingVideo).toHaveBeenCalled()
    expect(page.loan.giveBack).toHaveBeenCalled()
    expect(created[0]!.destroyed).toBe(true)
    expect(bars[0]!.webContents.destroyed).toBe(true)
    expect(windows.has(FLOATING_WINDOW_ID)).toBe(false)
    expect(trusted.has(bars[0]!.webContents.id)).toBe(false)
    expect(owner.floatingChanged).toHaveBeenLastCalledWith('t', false)
    expect(owner.showTab).toHaveBeenCalledWith('t', true)
    expect(page.floatingVideoCommand).not.toHaveBeenCalledWith({ kind: 'pause' })
    expect(floating.floatingTab()).toBeNull()
  })

  it('the close button and ⌘W: the video is paused and its tab shown, its window left where it is', async () => {
    const { floating, send, bars } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    await floating.float(owner, 't', page as never)
    send({ kind: 'close' })
    expect(page.floatingVideoCommand).toHaveBeenCalledWith({ kind: 'pause' })
    expect(owner.showTab).toHaveBeenCalledWith('t', false)

    const again = fakePage()
    await floating.float(owner, 't', again as never)
    const preventDefault = vi.fn()
    bars[1]!.webContents.emit('before-input-event', { preventDefault }, { type: 'keyDown', meta: true, key: 'w' })
    expect(preventDefault).toHaveBeenCalled()
    expect(again.loan.giveBack).toHaveBeenCalled()
    // Another key with ⌘ is the application's.
    const third = fakePage()
    await floating.float(owner, 't', third as never)
    const other = vi.fn()
    bars[2]!.webContents.emit('before-input-event', { preventDefault: other }, { type: 'keyDown', meta: true, key: 't' })
    expect(other).not.toHaveBeenCalled()
    expect(floating.floatingTab()).toBe('t')
  })

  it('a page that closes, crashes or goes to another document ends it without showing anything', async () => {
    for (const why of ['gone', 'crashed', 'navigated'] as const) {
      const { floating, created } = setup()
      const page = fakePage()
      const owner = fakeOwner()
      await floating.float(owner, 't', page as never)
      page.end(why)
      expect(created[0]!.destroyed, why).toBe(true)
      expect(owner.floatingChanged, why).toHaveBeenLastCalledWith('t', false)
      expect(owner.showTab, why).not.toHaveBeenCalled()
      expect(floating.floatingTab(), why).toBeNull()
    }
  })

  it('the tab taken to another window: its video goes back to it first, without showing it', async () => {
    const { floating } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    await floating.float(owner, 't', page as never)
    floating.release('other')
    expect(floating.floatingTab()).toBe('t')
    floating.release('t')
    expect(page.loan.giveBack).toHaveBeenCalled()
    expect(owner.showTab).not.toHaveBeenCalled()
  })

  it('ends once: the window closing as it ends does not end it again', async () => {
    const { floating, send } = setup()
    const page = fakePage()
    const owner = fakeOwner()
    await floating.float(owner, 't', page as never)
    send({ kind: 'back' })
    expect(owner.floatingChanged).toHaveBeenCalledTimes(2)
    expect(page.loan.giveBack).toHaveBeenCalledTimes(1)
  })
})
