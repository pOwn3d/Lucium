// The scripts of Lucium's floating video window (floating-video-scripts.ts), run against a made-up document: which video floats and which part of
// the page goes with it (its player, where the site draws its subtitles), what is put on the page and given back, a player that draws itself
// again, what the bar reads, and what a command does (never a jump in a live stream or a protected video).

import { describe, expect, it, vi } from 'vitest'
import { FLOAT_FACTS, FLOAT_FIND, FLOAT_STAGE, FLOAT_UNSTAGE, STAGE_SLACK, floatCommandScript } from './floating-video-scripts'
import type { VideoCommand } from '@shared/floating-video'

/** The inline style of an element, as the CSSOM keeps it: a value and a priority by property. */
class FakeStyle {
  readonly values = new Map<string, { value: string; priority: string }>()
  getPropertyValue(name: string): string {
    return this.values.get(name)?.value ?? ''
  }
  getPropertyPriority(name: string): string {
    return this.values.get(name)?.priority ?? ''
  }
  setProperty(name: string, value: string, priority = ''): void {
    this.values.set(name, { value, priority })
  }
  removeProperty(name: string): void {
    this.values.delete(name)
  }
}

let html: FakeElement

class FakeElement {
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly style = new FakeStyle()
  readonly listeners = new Map<string, (event: unknown) => void>()
  open = false
  /** The page already shows this element in the top layer by its own means: showPopover() throws. */
  refusesPopover = false
  constructor(
    readonly name: string,
    public box = { width: 0, height: 0 }
  ) {}
  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
    return this
  }
  remove(): void {
    if (!this.parentElement) return
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
  }
  get isConnected(): boolean {
    let node: FakeElement | null = this
    while (node && node !== html) node = node.parentElement
    return node === html
  }
  contains(other: FakeElement): boolean {
    for (let node: FakeElement | null = other; node; node = node.parentElement) if (node === this) return true
    return false
  }
  getRootNode(): unknown {
    return fakeDocument
  }
  getBoundingClientRect() {
    return this.box
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener)
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }
  /** `:popover-open`, and a list of `tag`, `a[href]`, `[role="x"]` (the only selectors the scripts ask). */
  matches(selector: string): boolean {
    if (selector === ':popover-open') return this.open
    const tag = this.name.split(/[.#]/)[0]
    return selector.split(',').some((part) => {
      const [, wanted = '', attribute = '', value] = /^\s*([a-z]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?\s*$/.exec(part) ?? []
      if (!wanted && !attribute) return false
      if (wanted && wanted !== tag) return false
      return !attribute || (value === undefined ? this.hasAttribute(attribute) : this.getAttribute(attribute) === value)
    })
  }
  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((el) => el.matches(selector)) ?? null
  }
  showPopover(): void {
    if (this.refusesPopover) throw new Error('the element is already shown')
    if (!this.hasAttribute('popover')) throw new Error('not a popover')
    this.open = true
  }
  hidePopover(): void {
    this.open = false
  }
  /** Every element below this one. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }
}

class FakeVideo extends FakeElement {
  paused = false
  ended = false
  readyState = 4
  muted = false
  volume = 1
  currentTime = 120
  duration = 600
  mediaKeys: object | null = null
  seekable = { length: 1, start: () => 0, end: () => 600 }
  play = vi.fn(() => {
    this.paused = false
    return Promise.resolve()
  })
  pause = vi.fn(() => {
    this.paused = true
  })
  constructor(
    public videoWidth = 1280,
    public videoHeight = 720,
    box = { width: 1280, height: 720 }
  ) {
    super('video', box)
  }
}

class FakeObserver {
  static all: FakeObserver[] = []
  watched: Array<[unknown, unknown]> = []
  constructor(readonly callback: (records: Array<{ type: string }>) => void) {
    FakeObserver.all.push(this)
  }
  observe(target: unknown, options: unknown): void {
    this.watched.push([target, options])
  }
  disconnect(): void {
    this.watched = []
  }
  fire(records: Array<{ type: string }>): void {
    if (this.watched.length > 0) this.callback(records)
  }
}

let fakeDocument: { body: FakeElement; documentElement: FakeElement; querySelectorAll(selector: string): FakeElement[] }

/** A page: the document, its body, and what the test puts in it. */
function page(...content: FakeElement[]) {
  html = new FakeElement('html', { width: 1440, height: 900 })
  const body = new FakeElement('body', { width: 1440, height: 2400 })
  html.append(body.append(...content))
  fakeDocument = {
    body,
    documentElement: html,
    querySelectorAll: (selector: string) => (selector === '*' ? [] : html.descendants().filter((el) => el instanceof FakeVideo))
  }
  FakeObserver.all = []
  return { body, world: {} as Record<symbol, unknown> }
}

const warn = vi.fn()
const run = (script: string, world: Record<symbol, unknown>): unknown =>
  new Function('document', 'HTMLVideoElement', 'MutationObserver', 'console', 'self', 'queueMicrotask', `return ${script}`)(fakeDocument, FakeVideo, FakeObserver, { warn }, world, (task: () => void) => task())

/** YouTube's shape: the page, a column, the player (the size of the video), the video's box, the video, the subtitles beside it in the player. */
function youtube() {
  const video = new FakeVideo()
  const holder = new FakeElement('div.html5-video-container', { width: 1280, height: 720 }).append(video)
  const captions = new FakeElement('div.ytp-caption-window-container', { width: 1280, height: 720 })
  const player = new FakeElement('div#movie_player', { width: 1280, height: 720 }).append(holder, captions)
  const column = new FakeElement('div#primary', { width: 1300, height: 2000 }).append(player)
  return { video, holder, captions, player, column }
}

/**
 * Twitch's shape: the player (the size of the video) holds the video, the chat-free overlay of the stream's own text, and the bar of controls (the
 * pause, volume, settings, theatre and full screen buttons, the progress slider and the LIVE pill) in a box of its own.
 */
function twitch() {
  const video = new FakeVideo()
  const holder = new FakeElement('div.video-ref', { width: 1280, height: 720 }).append(video)
  const adText = new FakeElement('div.ad-text', { width: 400, height: 40 })
  const catcher = new FakeElement('div.click-catcher', { width: 1280, height: 720 })
  catcher.setAttribute('role', 'button')
  const pause = new FakeElement('button.pause', { width: 30, height: 30 })
  const volume = new FakeElement('div.volume', { width: 100, height: 30 })
  volume.append(new FakeElement('input', { width: 80, height: 10 }))
  const progress = new FakeElement('div.progress', { width: 1280, height: 8 })
  progress.setAttribute('role', 'slider')
  const live = new FakeElement('div.live-pill', { width: 60, height: 30 }).append(new FakeElement('button.live', { width: 60, height: 30 }))
  const bar = new FakeElement('div.player-controls', { width: 1280, height: 120 }).append(pause, volume, progress, live)
  const player = new FakeElement('div.player', { width: 1280, height: 720 }).append(holder, adText, catcher, bar)
  const column = new FakeElement('div.layout', { width: 1300, height: 2000 }).append(player)
  return { video, holder, adText, catcher, bar, player, column }
}

describe('the controls of the site', () => {
  it('hides the bar the site draws over the video, and what only takes clicks, and leaves the text the page draws', () => {
    const { video, holder, adText, catcher, bar, player, column } = twitch()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    expect(bar.style.getPropertyValue('display')).toBe('none')
    expect(bar.style.getPropertyPriority('display')).toBe('important')
    expect(catcher.style.getPropertyValue('display')).toBe('none')
    // The video, the box it is in and the text of the page are shown; the player is the one in the top layer.
    for (const shown of [video, holder, adText, player]) expect(shown.style.getPropertyValue('display')).toBe('')
    expect(player.open).toBe(true)
    // No attribute marks the controls: the page reads its own elements.
    expect([...bar.attributes.keys()]).toEqual([])
  })

  it('hides a control wherever it is among the ancestors of the video, by what it is and not by the class of the site', () => {
    const video = new FakeVideo()
    const slider = new FakeElement('span.anything', { width: 1280, height: 10 })
    slider.setAttribute('role', 'slider')
    const inner = new FakeElement('div.inner', { width: 1280, height: 720 }).append(video, slider)
    const link = new FakeElement('a', { width: 50, height: 20 })
    link.setAttribute('href', '/x')
    const player = new FakeElement('section', { width: 1280, height: 720 }).append(inner, link)
    const { world } = page(player)
    run(FLOAT_STAGE, world)
    expect(slider.style.getPropertyValue('display')).toBe('none')
    expect(link.style.getPropertyValue('display')).toBe('none')
    expect(inner.style.getPropertyValue('display')).toBe('')
  })

  it('hides a bar the player draws again, and puts the hiding back when the page takes it off', () => {
    const { bar, player, column } = twitch()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    bar.style.removeProperty('display')
    observer.fire([{ type: 'attributes' }])
    expect(bar.style.getPropertyValue('display')).toBe('none')
    const again = new FakeElement('div.player-controls', { width: 1280, height: 120 }).append(new FakeElement('button', { width: 30, height: 30 }))
    player.append(again)
    observer.fire([{ type: 'childList' }])
    expect(again.style.getPropertyValue('display')).toBe('none')
  })

  it('gives the controls back with the page, with the values the page had', () => {
    const { bar, catcher, column } = twitch()
    bar.style.setProperty('display', 'flex', '')
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    expect(bar.style.getPropertyValue('display')).toBe('none')
    run(FLOAT_UNSTAGE, world)
    expect(bar.style.getPropertyValue('display')).toBe('flex')
    expect(bar.style.getPropertyPriority('display')).toBe('')
    expect(catcher.style.getPropertyValue('display')).toBe('')
  })

  it('leaves the subtitles of a player with no controls of its own (YouTube\'s shape without its bars)', () => {
    const { captions, column } = youtube()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    expect(captions.style.getPropertyValue('display')).toBe('')
  })
})

describe('finding the video', () => {
  it('says whether the page itself has a video to float', () => {
    const { world } = page(youtube().column)
    expect(run(FLOAT_FIND, world)).toBe(true)
    const empty = page(new FakeElement('main', { width: 1440, height: 900 }))
    expect(run(FLOAT_FIND, empty.world)).toBe(false)
  })

  it('does not take a video that has nothing to show yet, or that ended', () => {
    const waiting = new FakeVideo()
    waiting.readyState = 1
    const ended = new FakeVideo()
    ended.ended = true
    const { world } = page(waiting, ended)
    expect(run(FLOAT_FIND, world)).toBe(false)
  })
})

describe('bringing the video to fill the page', () => {
  it('puts the player in the top layer: the box about the size of the video that holds its subtitles, not the page around it', () => {
    const { video, captions, player, column } = youtube()
    const { world } = page(column)
    expect(run(FLOAT_STAGE, world)).toEqual({ staged: true, width: 1280, height: 720, live: false, protected: false })
    expect(player.open).toBe(true)
    expect(player.getAttribute('popover')).toBe('manual')
    // The only attribute the page gains is the one that puts the player in the top layer: nothing names the application.
    expect([...player.attributes.keys()]).toEqual(['popover'])
    expect([...video.attributes.keys()]).toEqual([])
    expect(column.open).toBe(false)
    // The subtitles the site draws in the page are inside what is shown.
    expect(player.contains(captions)).toBe(true)
    expect(player.style.getPropertyValue('width')).toBe('100vw')
    expect(player.style.getPropertyPriority('width')).toBe('important')
    expect(video.style.getPropertyValue('object-fit')).toBe('contain')
    expect(video.style.getPropertyPriority('position')).toBe('important')
  })

  it(`stops at an ancestor more than ${STAGE_SLACK} times the video's size, and at one the page already uses as a popover`, () => {
    const video = new FakeVideo()
    const wide = new FakeElement('div.wide', { width: 1280 * STAGE_SLACK + 10, height: 720 }).append(video)
    page(wide)
    const { world } = { world: {} as Record<symbol, unknown> }
    run(FLOAT_STAGE, world)
    expect(video.open).toBe(true)
    expect(wide.open).toBe(false)

    const inner = new FakeVideo()
    const menu = new FakeElement('div.menu', { width: 1280, height: 720 }).append(inner)
    menu.setAttribute('popover', 'auto')
    const fresh = page(menu)
    run(FLOAT_STAGE, fresh.world)
    expect(inner.open).toBe(true)
    expect(menu.getAttribute('popover')).toBe('auto')
  })

  it('does not take the page around the player when the video nearly fills the window (Twitch signed in: the player and the channel are in boxes about its size)', () => {
    const { video, player } = twitch()
    // The scrolling box of the page is about the size of the video, but it holds the channel's own content (much taller than the video) beside the
    // player: bringing it to the top layer would take the page along and hide the boxes the player needs, the video then shows black.
    const channel = new FakeElement('div.channel-root', { width: 1280, height: 1800 }).append(new FakeElement('button.follow', { width: 80, height: 30 }))
    const wrapper = new FakeElement('div.scrollable', { width: 1280, height: 760 }).append(player, channel)
    const app = new FakeElement('div.root', { width: 1440, height: 800 }).append(new FakeElement('div.nav', { width: 1440, height: 50 }).append(new FakeElement('button.menu')), wrapper)
    const { world } = page(app)
    run(FLOAT_STAGE, world)
    expect(player.open).toBe(true)
    expect(wrapper.open).toBe(false)
    expect(app.open).toBe(false)
    // What is outside the player is neither in the top layer nor hidden by the script, and nothing of the page is restyled.
    expect(channel.style.getPropertyValue('display')).toBe('')
    expect(wrapper.style.getPropertyValue('position')).toBe('')
    expect(app.style.getPropertyValue('position')).toBe('')
    expect(video.style.getPropertyValue('object-fit')).toBe('contain')
  })

  it('says why when there is no video', () => {
    const { world } = page(new FakeElement('main'))
    expect(run(FLOAT_STAGE, world)).toEqual({ staged: false, reason: 'no-video' })
  })

  it('answers the same when asked again, without doing anything twice', () => {
    const { player, column } = youtube()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    const observers = FakeObserver.all.length
    expect(run(FLOAT_STAGE, world)).toEqual({ staged: true, width: 1280, height: 720, live: false, protected: false })
    expect(FakeObserver.all.length).toBe(observers)
    expect(player.open).toBe(true)
  })

  it('tells a live stream and a protected video', () => {
    const stream = new FakeVideo()
    stream.duration = Infinity
    stream.mediaKeys = {}
    const { world } = page(stream)
    expect(run(FLOAT_STAGE, world)).toEqual({ staged: true, width: 1280, height: 720, live: true, protected: true })
  })

  it('tells a live stream that reports a finite duration (a sliding window, as on Twitch)', () => {
    const stream = new FakeVideo()
    stream.duration = 4000
    stream.seekable = { length: 1, start: () => 3400, end: () => 4000 }
    const { world } = page(stream)
    expect(run(FLOAT_STAGE, world)).toMatchObject({ live: true })
    expect(run(FLOAT_FACTS, world)).toMatchObject({ live: true })
  })

  it('keeps the video staged even when the top layer refuses it, and says so in the log', () => {
    const video = new FakeVideo()
    video.refusesPopover = true
    const { world } = page(video)
    warn.mockClear()
    expect(run(FLOAT_STAGE, world)).toMatchObject({ staged: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be put above the page'))
    expect(video.style.getPropertyValue('z-index')).toBe('2147483647')
  })
})

describe('the scrollbar of the page behind the player', () => {
  // The tab's own view is lent to the window: the scrollbar of the page's document would be drawn along the right edge of the window, over nothing
  // the player needs (YouTube and Netflix show it, Twitch's page does not scroll). The page never scrolls from the window.
  it('hides the scrollbar of the document and of its body, and lets nothing scroll, whatever the site', () => {
    const { world, body } = page(youtube().column)
    run(FLOAT_STAGE, world)
    for (const root of [html, body]) {
      expect(root.style.getPropertyValue('overflow-x'), root.name).toBe('hidden')
      expect(root.style.getPropertyValue('overflow-y'), root.name).toBe('hidden')
      expect(root.style.getPropertyValue('scrollbar-width'), root.name).toBe('none')
      expect(root.style.getPropertyValue('overscroll-behavior'), root.name).toBe('none')
      // The page's own rules cannot win over it.
      expect(root.style.getPropertyPriority('overflow-y'), root.name).toBe('important')
      expect(root.style.getPropertyPriority('scrollbar-width'), root.name).toBe('important')
    }
  })

  it('gives the page its own scrolling back with the rest, with the values it had', () => {
    const { world, body } = page(youtube().column)
    html.style.setProperty('overflow-y', 'scroll', '')
    body.style.setProperty('scrollbar-width', 'thin', 'important')
    run(FLOAT_STAGE, world)
    run(FLOAT_UNSTAGE, world)
    expect(html.style.getPropertyValue('overflow-y')).toBe('scroll')
    expect(html.style.getPropertyValue('overflow-x')).toBe('')
    expect(html.style.getPropertyValue('scrollbar-width')).toBe('')
    expect(body.style.getPropertyValue('scrollbar-width')).toBe('thin')
    expect(body.style.getPropertyPriority('scrollbar-width')).toBe('important')
    expect(body.style.getPropertyValue('overflow-y')).toBe('')
  })

  it('hides it again when the page puts its own styles back on the document or its body (a player that resets them)', () => {
    const { world, body } = page(youtube().column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    // The document and its body are watched for their styles, as the player is.
    expect(observer.watched.some(([target]) => target === html)).toBe(true)
    expect(observer.watched.some(([target]) => target === body)).toBe(true)
    html.style.setProperty('overflow-y', 'scroll', '')
    body.style.removeProperty('scrollbar-width')
    observer.fire([{ type: 'attributes' }])
    expect(html.style.getPropertyValue('overflow-y')).toBe('hidden')
    expect(body.style.getPropertyValue('scrollbar-width')).toBe('none')
  })

  it('does not touch the document of a page with no video', () => {
    const { world, body } = page(new FakeElement('main'))
    run(FLOAT_STAGE, world)
    expect(html.style.getPropertyValue('overflow-y')).toBe('')
    expect(body.style.getPropertyValue('scrollbar-width')).toBe('')
  })
})

describe('giving the page back', () => {
  it('takes the player out of the top layer and gives every element its own styles again', () => {
    const { video, player, column } = youtube()
    player.style.setProperty('width', '854px')
    video.style.setProperty('left', '12px', '')
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    expect(run(FLOAT_UNSTAGE, world)).toBe(true)
    expect(player.open).toBe(false)
    expect(player.hasAttribute('popover')).toBe(false)
    expect([...player.attributes.keys()]).toEqual([])
    expect([...video.attributes.keys()]).toEqual([])
    expect(player.style.getPropertyValue('width')).toBe('854px')
    expect(player.style.getPropertyPriority('width')).toBe('')
    expect(player.style.getPropertyValue('position')).toBe('')
    expect(video.style.getPropertyValue('left')).toBe('12px')
    expect(video.style.getPropertyValue('object-fit')).toBe('')
    expect(FakeObserver.all.every((observer) => observer.watched.length === 0)).toBe(true)
    // Nothing is left to give back.
    expect(run(FLOAT_UNSTAGE, world)).toBe(false)
  })

  it('leaves a popover of the page as the page made it', () => {
    const video = new FakeVideo()
    video.setAttribute('popover', 'auto')
    const { world } = page(video)
    run(FLOAT_STAGE, world)
    run(FLOAT_UNSTAGE, world)
    expect(video.getAttribute('popover')).toBe('auto')
  })
})

describe('a page that changes its player while the video floats', () => {
  it('has the video that replaces the old one floated, even before it has frames to show', () => {
    const { video, holder, column } = youtube()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    video.remove()
    const next = new FakeVideo()
    next.readyState = 0
    holder.append(next)
    observer.fire([{ type: 'childList' }])
    expect([...next.attributes.keys()]).toEqual([])
    expect(next.style.getPropertyValue('object-fit')).toBe('contain')
    expect((run(FLOAT_FACTS, world) as { width: number }).width).toBe(1280)
  })

  it('waits for a video when the player has none for a moment, and floats the one that comes', () => {
    const video = new FakeVideo()
    const { body, world } = page(video)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    video.remove()
    observer.fire([{ type: 'childList' }])
    expect(run(FLOAT_FACTS, world)).toBeNull()
    const next = new FakeVideo()
    body.append(next)
    observer.fire([{ type: 'childList' }])
    expect(next.open).toBe(true)
  })

  it('puts its styles back when the page writes its own over them, and opens the top layer again when the page closes it', () => {
    const { player, column } = youtube()
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    player.style.setProperty('width', '640px')
    observer.fire([{ type: 'attributes' }])
    expect(player.style.getPropertyValue('width')).toBe('100vw')
    player.hidePopover()
    player.listeners.get('toggle')?.({ newState: 'closed' })
    expect(player.open).toBe(true)
  })

  it('does not take its own changes for the page’s: it stops watching while it makes them', () => {
    const { player, column } = youtube()
    const { world, body } = page(column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    const spy = vi.spyOn(observer, 'disconnect')
    observer.fire([{ type: 'attributes' }])
    expect(spy).toHaveBeenCalled()
    // Watching again afterwards: the document, the two elements, and the styles of the page's own document and body (its scrollbar is hidden).
    expect(observer.watched.map(([target]) => target)).toEqual([fakeDocument, player, expect.any(FakeVideo), html, body])
  })
})

describe('what the bar reads', () => {
  it('is the state of the floating video, its length for a recorded one', () => {
    const video = new FakeVideo()
    video.volume = 0.4
    const { world } = page(video)
    run(FLOAT_STAGE, world)
    expect(run(FLOAT_FACTS, world)).toEqual({ paused: false, ended: false, muted: false, volume: 0.4, currentTime: 120, duration: 600, live: false, behindLive: false, protected: false, width: 1280, height: 720 })
  })

  it('says a live stream, and whether it is played behind its live edge', () => {
    const stream = new FakeVideo()
    stream.duration = Infinity
    stream.currentTime = 595
    const { world } = page(stream)
    run(FLOAT_STAGE, world)
    expect(run(FLOAT_FACTS, world)).toMatchObject({ live: true, duration: null, behindLive: false })
    stream.currentTime = 500
    expect(run(FLOAT_FACTS, world)).toMatchObject({ live: true, behindLive: true })
  })

  it('is nothing when no video floats', () => {
    const { world } = page(new FakeVideo())
    expect(run(FLOAT_FACTS, world)).toBeNull()
  })
})

describe('the commands', () => {
  const staged = () => {
    const video = new FakeVideo()
    const { world } = page(video)
    run(FLOAT_STAGE, world)
    const command = (c: VideoCommand) => run(floatCommandScript(c), world)
    return { video, command }
  }

  it('play and pause', async () => {
    const { video, command } = staged()
    expect(command({ kind: 'toggle' })).toBe(true)
    expect(video.pause).toHaveBeenCalledTimes(1)
    await expect(command({ kind: 'toggle' })).resolves.toBe(true)
    expect(video.play).toHaveBeenCalledTimes(1)
    expect(command({ kind: 'pause' })).toBe(true)
    expect(video.paused).toBe(true)
  })

  it('set the volume within 0 and 1, and give a silent video its sound', () => {
    const { video, command } = staged()
    video.muted = true
    command({ kind: 'volume', value: 0.3 })
    expect(video.volume).toBe(0.3)
    expect(video.muted).toBe(false)
    command({ kind: 'volume', value: 7 })
    expect(video.volume).toBe(1)
    video.muted = true
    video.volume = 0
    command({ kind: 'unmute' })
    expect(video.muted).toBe(false)
    expect(video.volume).toBe(0.5)
  })

  it('jump 10 s in a recorded video, never past its ends', () => {
    const { video, command } = staged()
    expect(command({ kind: 'seek', seconds: -10 })).toBe(true)
    expect(video.currentTime).toBe(110)
    video.currentTime = 595
    command({ kind: 'seek', seconds: 10 })
    expect(video.currentTime).toBe(600)
  })

  it('never jump in a live stream or a protected video, whatever was asked', () => {
    const { video, command } = staged()
    video.duration = Infinity
    expect(command({ kind: 'seek', seconds: 10 })).toBe(false)
    expect(video.currentTime).toBe(120)
    video.duration = 600
    video.mediaKeys = {}
    expect(command({ kind: 'seek', seconds: -10 })).toBe(false)
    expect(video.currentTime).toBe(120)
  })

  it('never jumps in a live stream with a finite duration', () => {
    const { video, command } = staged()
    video.duration = 4000
    video.seekable = { length: 1, start: () => 3400, end: () => 4000 }
    expect(command({ kind: 'seek', seconds: -10 })).toBe(false)
    expect(video.currentTime).toBe(120)
  })

  it('take a live stream back to its live edge', () => {
    const { video, command } = staged()
    video.duration = Infinity
    video.currentTime = 400
    expect(command({ kind: 'live' })).toBe(true)
    expect(video.currentTime).toBe(600)
  })

  it('do nothing when no video floats', () => {
    const { world } = page(new FakeVideo())
    expect(run(floatCommandScript({ kind: 'toggle' }), world)).toBe(false)
  })
})
