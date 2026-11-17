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
  matches(selector: string): boolean {
    return selector === ':popover-open' ? this.open : false
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
    const { world } = page(column)
    run(FLOAT_STAGE, world)
    const observer = FakeObserver.all[0]!
    const spy = vi.spyOn(observer, 'disconnect')
    observer.fire([{ type: 'attributes' }])
    expect(spy).toHaveBeenCalled()
    // Watching again afterwards: the document and the two elements.
    expect(observer.watched.map(([target]) => target)).toEqual([fakeDocument, player, expect.any(FakeVideo)])
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
