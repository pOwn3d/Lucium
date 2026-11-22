import { describe, expect, it } from 'vitest'
import { AUTOSCROLL_DEAD_ZONE, AUTOSCROLL_IGNORED, AUTOSCROLL_MAX_SPEED, AUTOSCROLL_SCRIPTS, autoscrollStep } from './autoscroll'
import { GESTURES, GESTURE_SCRIPTS, GESTURE_STEP, gestureAction, gestureLabels, gesturePath, gestureStroke, gesturesOn, gesturesSummary } from './gestures'
import { GESTURE_MAX_STEPS, NO_PAGE_TOOLS, TOOL_CHANNEL, TOOL_NAMES, anyPageTool, parseToolMessage, samePageTools, toolMessageText, type ToolMessage } from './page-tools'
import { setLanguage } from './i18n'
import { SCROLL_SYNC_SCRIPTS, carriesScrollSync, scrollShare, scrollSyncApplyScript, syncTargets } from './scroll-sync'
import { frenchSpaces } from './french-typography'

const NONCE = 'n0nce-1'

describe('the line a tool writes to the console', () => {
  const ok: ToolMessage[] = [
    { tool: 'gesture', path: 'UD' },
    { tool: 'gesture', path: '' },
    { tool: 'scroll', x: 0, y: 0.5 },
    { tool: 'scroll', x: 1, y: 1 },
    { tool: 'speech', state: 'end' },
    { tool: 'speech', state: 'error' }
  ]

  it('is read back as it was written', () => {
    for (const message of ok) expect(parseToolMessage(toolMessageText(NONCE, message), NONCE)).toEqual(message)
  })

  it('is not believed without the secret of the page: a page that writes the same words to its own console moves nothing', () => {
    const text = toolMessageText(NONCE, { tool: 'gesture', path: 'L' })
    expect(parseToolMessage(text, 'another-secret')).toBeNull()
    expect(parseToolMessage(text, '')).toBeNull()
    expect(parseToolMessage(`${TOOL_CHANNEL}:{"tool":"gesture","path":"L"}`, NONCE)).toBeNull()
    expect(parseToolMessage('hello', NONCE)).toBeNull()
    expect(parseToolMessage(42, NONCE)).toBeNull()
    expect(parseToolMessage(undefined, NONCE)).toBeNull()
  })

  it('says "invalid" for a line that has the secret but says nothing allowed, so that the caller can log it', () => {
    const prefix = `${TOOL_CHANNEL}${NONCE}:`
    const invalid = [
      '{ not json',
      'null',
      '[]',
      '3',
      '{"tool":"gesture"}',
      '{"tool":"gesture","path":"X"}',
      '{"tool":"gesture","path":"UDUDUDUDU"}',
      '{"tool":"gesture","path":3}',
      '{"tool":"scroll","x":2,"y":0}',
      '{"tool":"scroll","x":0}',
      '{"tool":"scroll","x":"0","y":0}',
      '{"tool":"scroll","x":null,"y":0}',
      '{"tool":"speech","state":"maybe"}',
      '{"tool":"rm"}',
      '{}'
    ]
    for (const body of invalid) expect(parseToolMessage(prefix + body, NONCE), body).toBe('invalid')
    expect(parseToolMessage(prefix + '{"tool":"gesture","path":"' + 'U'.repeat(GESTURE_MAX_STEPS) + '"}', NONCE)).toEqual({ tool: 'gesture', path: 'U'.repeat(GESTURE_MAX_STEPS) })
  })

  it('refuses a line that is longer than any tool writes', () => {
    expect(parseToolMessage(`${TOOL_CHANNEL}${NONCE}:{"tool":"gesture","path":"L","pad":"${'x'.repeat(600)}"}`, NONCE)).toBeNull()
  })

  it('does not take a name from the line that the prototype chain has', () => {
    expect(parseToolMessage(`${TOOL_CHANNEL}${NONCE}:{"tool":"constructor"}`, NONCE)).toBe('invalid')
    expect(parseToolMessage(`${TOOL_CHANNEL}${NONCE}:{"tool":"__proto__"}`, NONCE)).toBe('invalid')
  })
})

describe('the tools of a page', () => {
  it('start all off', () => {
    expect(anyPageTool(NO_PAGE_TOOLS)).toBe(false)
    expect(TOOL_NAMES.every((name) => NO_PAGE_TOOLS[name] === false)).toBe(true)
    expect(Object.isFrozen(NO_PAGE_TOOLS)).toBe(true)
  })

  it('are compared one by one', () => {
    expect(samePageTools(NO_PAGE_TOOLS, { autoScroll: false, mouseGestures: false, scrollSync: false, vimKeys: false, scrollMemory: false })).toBe(true)
    for (const name of TOOL_NAMES) {
      const on = { ...NO_PAGE_TOOLS, [name]: true }
      expect(samePageTools(NO_PAGE_TOOLS, on)).toBe(false)
      expect(anyPageTool(on)).toBe(true)
    }
  })
})

// ---------- autoscroll ----------

describe('the speed of autoscroll', () => {
  it('is nothing within the dead zone, whichever way the pointer went', () => {
    for (const offset of [0, 1, -1, AUTOSCROLL_DEAD_ZONE, -AUTOSCROLL_DEAD_ZONE]) expect(autoscrollStep(offset, 16)).toBe(0)
  })

  it('grows with the distance, faster than the distance does, and is symmetrical', () => {
    const at = (offset: number) => autoscrollStep(offset, 100)
    expect(at(40)).toBeGreaterThan(0)
    expect(at(80)).toBeGreaterThan(at(40))
    expect(at(160)).toBeGreaterThan(at(80) * 2 - at(40))
    expect(autoscrollStep(-60, 50)).toBe(-autoscrollStep(60, 50))
  })

  it('never exceeds the top speed, and a pause longer than a tenth of a second counts as a tenth (a page that froze does not jump)', () => {
    expect(autoscrollStep(100_000, 1000)).toBeCloseTo(AUTOSCROLL_MAX_SPEED * 0.1, 6)
    expect(autoscrollStep(100_000, 100)).toBeCloseTo(AUTOSCROLL_MAX_SPEED * 0.1, 6)
    expect(autoscrollStep(100_000, 10)).toBeCloseTo(AUTOSCROLL_MAX_SPEED * 0.01, 6)
  })

  it('is the speed per second times the time', () => {
    const second = autoscrollStep(100, 100) * 10
    expect(autoscrollStep(100, 50) * 20).toBeCloseTo(second, 6)
  })

  it('is nothing for a distance that is not a number', () => {
    expect(autoscrollStep(Number.NaN, 16)).toBe(0)
  })
})

// ---------- the scripts, run in a stand-in for a page ----------

interface FakeEvent {
  type: string
  isTrusted?: boolean
  button?: number
  buttons?: number
  clientX?: number
  clientY?: number
  key?: string
  target?: unknown
  defaultPrevented?: boolean
  prevented?: boolean
  stopped?: boolean
  preventDefault?: () => void
  stopImmediatePropagation?: () => void
}

/** A page that is just enough for the scripts: window and document listeners, a scrolling element, a clock, frames run by hand. */
function fakePage(options: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number } = {}) {
  const listeners = new Map<string, Array<{ fn: (event: FakeEvent) => void; capture: boolean }>>()
  const documentListeners = new Map<string, Array<(event: FakeEvent) => void>>()
  const lines: string[] = []
  const frames: Array<(now: number) => void> = []
  const scrolls: Array<{ left?: number; top?: number }> = []
  const appended: unknown[] = []
  let clock = 1000
  class FakeElement {
    constructor(private readonly ignoredTarget = false) {}
    parentElement: FakeElement | null = null
    closest(selector: string) {
      return this.ignoredTarget && selector === AUTOSCROLL_IGNORED ? this : null
    }
  }
  const root = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: options.scrollHeight ?? 4000,
    clientHeight: options.clientHeight ?? 800,
    scrollWidth: options.scrollWidth ?? 1000,
    clientWidth: options.clientWidth ?? 1000,
    style: { removeProperty() {}, setProperty() {}, cursor: '' },
    append: (node: unknown) => appended.push(node),
    scrollBy(arg: { left?: number; top?: number }) {
      scrolls.push(arg)
      root.scrollTop += arg.top ?? 0
    },
    scrollTo(arg: { left?: number; top?: number }) {
      scrolls.push(arg)
      root.scrollTop = arg.top ?? root.scrollTop
      root.scrollLeft = arg.left ?? root.scrollLeft
    }
  }
  const canvas = () => ({ width: 0, height: 0, style: {} as Record<string, string>, remove() { this.removed = true }, removed: false, getContext: () => ({ scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set lineWidth(_: number) {} }) })
  const svgNode = () => ({ setAttribute() {}, append() {}, remove() { this.removed = true }, removed: false, style: {} as Record<string, string> })
  const sandbox: Record<string, unknown> = {
    console: { debug: (line: string) => lines.push(line) },
    performance: { now: () => clock },
    requestAnimationFrame: (fn: (now: number) => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, fn: (event: FakeEvent) => void, capture?: boolean | { capture?: boolean }) => {
      const list = listeners.get(type) ?? []
      list.push({ fn, capture: typeof capture === 'object' ? capture.capture === true : capture === true })
      listeners.set(type, list)
    },
    removeEventListener: (type: string, fn: (event: FakeEvent) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)),
    document: {
      scrollingElement: root,
      documentElement: root,
      body: {},
      createElement: canvas,
      createElementNS: svgNode,
      addEventListener: (type: string, fn: (event: FakeEvent) => void) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: (event: FakeEvent) => void) => documentListeners.set(type, (documentListeners.get(type) ?? []).filter((f) => f !== fn))
    },
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
    Element: FakeElement,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2
  }
  sandbox['self'] = sandbox
  sandbox['window'] = sandbox
  // The script runs with the stand-in as its global scope (`with` and a direct `eval`: no node module needed, so the web configuration compiles this file).
  const evaluate = new Function('scope', 'script', 'with (scope) { return eval(script) }') as (scope: unknown, script: string) => unknown
  const run = (script: string) => evaluate(sandbox, script)
  const fire = (event: FakeEvent): FakeEvent => {
    const full: FakeEvent = {
      isTrusted: true,
      button: 0,
      buttons: 0,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      prevented: false,
      stopped: false,
      ...event,
      preventDefault() { full.prevented = true },
      stopImmediatePropagation() { full.stopped = true }
    }
    for (const { fn } of [...(listeners.get(event.type) ?? [])]) {
      fn(full)
      if (full.stopped) break
    }
    return full
  }
  return {
    sandbox,
    root,
    lines,
    frames,
    scrolls,
    appended,
    run,
    fire,
    fireOnDocument: (event: FakeEvent) => (documentListeners.get(event.type) ?? []).forEach((fn) => fn(event)),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    /** Runs the frames asked for so far, at the clock's time. */
    frame: () => frames.splice(0).forEach((fn) => fn(clock)),
    listenerCount: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0) + [...documentListeners.values()].reduce((sum, list) => sum + list.length, 0),
    element: (ignoredTarget = false) => new FakeElement(ignoredTarget),
    reports: () => lines.map((line) => parseToolMessage(line, NONCE)),
    tools: () => sandbox['__lucium_tools'] as Record<string, { off(): void; apply?(x: number, y: number): void }> | undefined
  }
}

describe('the tool scripts', () => {
  it('compile, each of them', () => {
    for (const script of [AUTOSCROLL_SCRIPTS.install(NONCE), GESTURE_SCRIPTS.install(NONCE), SCROLL_SYNC_SCRIPTS.install(NONCE), AUTOSCROLL_SCRIPTS.uninstall, GESTURE_SCRIPTS.uninstall, SCROLL_SYNC_SCRIPTS.uninstall, scrollSyncApplyScript(0.5, 0.5)]) {
      expect(() => new Function(script)).not.toThrow()
    }
  })

  it('carry the secret of the page into the line they write, and nothing else of ours into the page', () => {
    const page = fakePage()
    page.run(GESTURE_SCRIPTS.install(NONCE))
    page.fire({ type: 'mousedown', button: 2, clientX: 10, clientY: 10 })
    page.fire({ type: 'mouseup', button: 2, clientX: 10, clientY: 10 })
    expect(page.lines).toEqual([`${TOOL_CHANNEL}${NONCE}:{"tool":"gesture","path":""}`])
    // The page's own globals are untouched: the scripts keep to one name, in the isolated world.
    expect(Object.keys(page.sandbox).filter((key) => key.startsWith('__'))).toEqual(['__lucium_tools'])
  })

  it('install once: a second run of the same script adds no listener', () => {
    const page = fakePage()
    page.run(GESTURE_SCRIPTS.install(NONCE))
    const once = page.listenerCount()
    page.run(GESTURE_SCRIPTS.install(NONCE))
    expect(page.listenerCount()).toBe(once)
    page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
    const both = page.listenerCount()
    page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
    expect(page.listenerCount()).toBe(both)
  })

  it('leave nothing behind when taken out: no listener, and the tool is forgotten', () => {
    for (const scripts of [AUTOSCROLL_SCRIPTS, GESTURE_SCRIPTS, SCROLL_SYNC_SCRIPTS]) {
      const page = fakePage()
      page.run(scripts.install(NONCE))
      expect(page.listenerCount()).toBeGreaterThan(0)
      page.run(scripts.uninstall)
      expect(page.listenerCount()).toBe(0)
      expect(Object.keys(page.tools() ?? {})).toEqual([])
      // Taking out what is not there is nothing to do.
      expect(() => page.run(scripts.uninstall)).not.toThrow()
    }
  })

  describe('autoscroll', () => {
    const start = (page: ReturnType<typeof fakePage>, init: Partial<FakeEvent> = {}) =>
      page.fire({ type: 'mousedown', button: 1, clientX: 300, clientY: 300, target: page.element(), ...init })

    it('starts on a middle click on the page, and keeps the click from the page', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      const down = start(page)
      expect(down.prevented).toBe(true)
      expect(down.stopped).toBe(true)
      expect(page.appended).toHaveLength(1)
      expect(page.frames).toHaveLength(1)
    })

    it('scrolls the page down when the pointer is below the anchor, and by more when it is further', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      start(page)
      page.fire({ type: 'mousemove', clientX: 300, clientY: 380 })
      page.advance(100)
      page.frame()
      const near = page.root.scrollTop
      expect(near).toBeGreaterThan(0)
      page.fire({ type: 'mousemove', clientX: 300, clientY: 560 })
      page.advance(100)
      page.frame()
      expect(page.root.scrollTop - near).toBeGreaterThan(near)
    })

    it('scrolls up when the pointer is above, and sideways when the page can', () => {
      const page = fakePage({ scrollWidth: 4000 })
      page.root.scrollTop = 1000
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      start(page)
      page.fire({ type: 'mousemove', clientX: 500, clientY: 200 })
      page.advance(100)
      page.frame()
      const call = page.scrolls.at(-1)!
      expect(call.top).toBeLessThan(0)
      expect(call.left).toBeGreaterThan(0)
    })

    it('scrolls nothing while the pointer stays in the dead zone', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      start(page)
      page.fire({ type: 'mousemove', clientX: 305, clientY: 305 })
      page.advance(100)
      page.frame()
      expect(page.scrolls).toEqual([])
    })

    it('ends on a click, which the page does not get (nor its release)', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      start(page)
      const click = page.fire({ type: 'mousedown', button: 0, clientX: 300, clientY: 400, target: page.element() })
      expect(click.stopped).toBe(true)
      expect(page.fire({ type: 'mouseup', button: 0 }).stopped).toBe(true)
      expect(page.fire({ type: 'click', button: 0 }).stopped).toBe(true)
      // Later clicks are the page's again.
      page.advance(1000)
      expect(page.fire({ type: 'mouseup', button: 0 }).stopped).toBe(false)
      page.fire({ type: 'mousemove', clientX: 300, clientY: 700 })
      page.advance(100)
      page.frame()
      expect(page.scrolls).toEqual([])
    })

    it('ends on Escape, on the wheel and when the page is left', () => {
      for (const end of [() => ({ type: 'keydown', key: 'Escape' }), () => ({ type: 'wheel' }), () => ({ type: 'blur' }), () => ({ type: 'pagehide' })]) {
        const page = fakePage()
        page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
        start(page)
        const marker = page.appended[0] as { removed: boolean }
        page.fire(end())
        expect(marker.removed).toBe(true)
        page.fire({ type: 'mousemove', clientX: 300, clientY: 700 })
        page.advance(100)
        page.frame()
        expect(page.scrolls).toEqual([])
      }
    })

    it('leaves a middle click on a link, a field or a button to the browser and the page', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      const down = start(page, { target: page.element(true) })
      expect(down.prevented).toBe(false)
      expect(down.stopped).toBe(false)
      expect(page.appended).toEqual([])
      expect(page.frames).toEqual([])
    })

    it('leaves the other buttons alone, and a click a script made up', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      expect(start(page, { button: 0 }).prevented).toBe(false)
      expect(start(page, { button: 2 }).prevented).toBe(false)
      expect(start(page, { isTrusted: false }).prevented).toBe(false)
      expect(page.appended).toEqual([])
    })

    it('does not start on a page that has nothing to scroll', () => {
      const page = fakePage({ scrollHeight: 800, clientHeight: 800 })
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      const down = start(page)
      expect(down.prevented).toBe(false)
      expect(page.appended).toEqual([])
    })

    it('ignores a click on something that is not an element', () => {
      const page = fakePage()
      page.run(AUTOSCROLL_SCRIPTS.install(NONCE))
      expect(start(page, { target: { closest: () => null } }).prevented).toBe(false)
    })
  })

  describe('mouse gestures', () => {
    const draw = (page: ReturnType<typeof fakePage>, ...points: Array<[number, number]>) => {
      const [first, ...rest] = points
      page.fire({ type: 'mousedown', button: 2, buttons: 2, clientX: first![0], clientY: first![1] })
      for (const [x, y] of rest) page.fire({ type: 'mousemove', buttons: 2, clientX: x, clientY: y })
      const last = points.at(-1)!
      page.fire({ type: 'mouseup', button: 2, clientX: last[0], clientY: last[1] })
      return page.reports()
    }

    it('reports a stroke to the left as "L"', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      expect(draw(page, [400, 300], [350, 300], [300, 300], [250, 302])).toEqual([{ tool: 'gesture', path: 'L' }])
    })

    it('reports each stroke once, in the order drawn: up then down is "UD"', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      expect(draw(page, [400, 300], [400, 260], [400, 230], [400, 270], [400, 310])).toEqual([{ tool: 'gesture', path: 'UD' }])
    })

    it('reports a plain click (nothing drawn) as an empty gesture, so that the page menu opens', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      expect(draw(page, [400, 300], [402, 301], [403, 300])).toEqual([{ tool: 'gesture', path: '' }])
    })

    it('draws a trail only once the pointer has moved, and takes it away when the button is released', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      page.fire({ type: 'mousedown', button: 2, buttons: 2, clientX: 400, clientY: 300 })
      page.fire({ type: 'mousemove', buttons: 2, clientX: 402, clientY: 300 })
      expect(page.appended).toHaveLength(0)
      page.fire({ type: 'mousemove', buttons: 2, clientX: 360, clientY: 300 })
      expect(page.appended).toHaveLength(1)
      const trail = page.appended[0] as { removed: boolean }
      page.fire({ type: 'mouseup', button: 2, clientX: 300, clientY: 300 })
      expect(trail.removed).toBe(true)
    })

    it('draws the trail on an element the rules of the page do not style: its own style starts from nothing', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      page.fire({ type: 'mousedown', button: 2, buttons: 2, clientX: 400, clientY: 300 })
      page.fire({ type: 'mousemove', buttons: 2, clientX: 360, clientY: 300 })
      const trail = page.appended[0] as { style: Record<string, string> }
      expect(trail.style['cssText']).toMatch(/^all:initial;/)
      expect(trail.style['cssText']).toContain('pointer-events:none')
    })

    it('gives up when the button was released unseen, and starts afresh with the next press', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      page.fire({ type: 'mousedown', button: 2, buttons: 2, clientX: 400, clientY: 300 })
      page.fire({ type: 'mousemove', buttons: 0, clientX: 300, clientY: 300 })
      page.fire({ type: 'mouseup', button: 2, clientX: 300, clientY: 300 })
      expect(page.lines).toEqual([])
      expect(draw(page, [400, 300], [400, 360])).toEqual([{ tool: 'gesture', path: 'D' }])
    })

    it('ignores the other buttons and what a script made up', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      page.fire({ type: 'mousedown', button: 0, buttons: 1, clientX: 400, clientY: 300 })
      page.fire({ type: 'mouseup', button: 0, clientX: 300, clientY: 300 })
      page.fire({ type: 'mousedown', button: 2, buttons: 2, isTrusted: false, clientX: 400, clientY: 300 })
      page.fire({ type: 'mouseup', button: 2, clientX: 300, clientY: 300 })
      expect(page.lines).toEqual([])
    })

    it('reports at most the longest gesture there is, however long the drawing', () => {
      const page = fakePage()
      page.run(GESTURE_SCRIPTS.install(NONCE))
      const zigzag: Array<[number, number]> = [[400, 300]]
      for (let i = 0; i < 20; i++) zigzag.push([400 + (i % 2 === 0 ? 40 : 0), 300 + 40 * (i + 1)])
      const [message] = draw(page, ...zigzag)
      expect(message).toMatchObject({ tool: 'gesture' })
      expect((message as { path: string }).path.length).toBeLessThanOrEqual(GESTURE_MAX_STEPS)
    })

    it('reads a drawing as the pure function does', () => {
      const shapes: Array<Array<[number, number]>> = [
        [[400, 300], [380, 302], [340, 301], [300, 300]],
        [[400, 300], [400, 340], [440, 345], [480, 340]],
        [[400, 300], [400, 250], [405, 300], [403, 350]],
        [[400, 300], [430, 330], [460, 360]]
      ]
      for (const shape of shapes) {
        const page = fakePage()
        page.run(GESTURE_SCRIPTS.install(NONCE))
        expect(draw(page, ...shape), JSON.stringify(shape)).toEqual([{ tool: 'gesture', path: gesturePath(shape) }])
      }
    })
  })

  describe('synchronized scrolling', () => {
    it('reports how far the page has scrolled, as a share of what there is to scroll, once per frame', () => {
      const page = fakePage({ scrollHeight: 2000, clientHeight: 1000 })
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.root.scrollTop = 250
      page.fire({ type: 'scroll' })
      page.fire({ type: 'scroll' })
      expect(page.frames).toHaveLength(1)
      page.frame()
      expect(page.reports()).toEqual([{ tool: 'scroll', x: 0, y: 0.25 }])
    })

    it('moves to the share it is given, and does not report that move back (the panes would answer each other for ever)', () => {
      const page = fakePage({ scrollHeight: 3000, clientHeight: 1000 })
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.run(scrollSyncApplyScript(0, 0.5))
      expect(page.root.scrollTop).toBe(1000)
      page.fire({ type: 'scroll' })
      expect(page.frames).toHaveLength(0)
      // Later, a scroll of the user's own is reported again.
      page.advance(500)
      page.root.scrollTop = 2000
      page.fire({ type: 'scroll' })
      page.frame()
      expect(page.reports()).toEqual([{ tool: 'scroll', x: 0, y: 1 }])
    })

    it('reports a scroll of the user\'s own at once, even a moment after it was moved (only the move it made itself is held back)', () => {
      const page = fakePage({ scrollHeight: 3000, clientHeight: 1000 })
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.run(scrollSyncApplyScript(0, 0.5))
      // 10 ms later, the user takes the page somewhere else.
      page.advance(10)
      page.root.scrollTop = 1500
      page.fire({ type: 'scroll' })
      page.frame()
      expect(page.reports()).toEqual([{ tool: 'scroll', x: 0, y: 0.75 }])
    })

    it('holds back the move it made itself only for a moment: the same position reached much later is the user\'s', () => {
      const page = fakePage({ scrollHeight: 3000, clientHeight: 1000 })
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.run(scrollSyncApplyScript(0, 0.5))
      page.advance(1000)
      page.root.scrollTop = 1001
      page.fire({ type: 'scroll' })
      page.frame()
      expect(page.reports()).toEqual([{ tool: 'scroll', x: 0, y: 0.5005 }])
    })

    it('does nothing when asked to move in a page that does not carry the tool', () => {
      const page = fakePage()
      expect(() => page.run(scrollSyncApplyScript(0.5, 0.5))).not.toThrow()
      expect(page.root.scrollTop).toBe(0)
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.run(SCROLL_SYNC_SCRIPTS.uninstall)
      page.run(scrollSyncApplyScript(0.5, 0.5))
      expect(page.root.scrollTop).toBe(0)
    })

    it('reports 0 for a page with nothing to scroll', () => {
      const page = fakePage({ scrollHeight: 800, clientHeight: 800 })
      page.run(SCROLL_SYNC_SCRIPTS.install(NONCE))
      page.fire({ type: 'scroll' })
      page.frame()
      expect(page.reports()).toEqual([{ tool: 'scroll', x: 0, y: 0 }])
    })
  })
})

describe('the share of a scroll', () => {
  it('is the position over what can be scrolled, kept between 0 and 1', () => {
    expect(scrollShare(0, 2000, 1000)).toBe(0)
    expect(scrollShare(500, 2000, 1000)).toBe(0.5)
    expect(scrollShare(1000, 2000, 1000)).toBe(1)
    expect(scrollShare(1300, 2000, 1000)).toBe(1)
    expect(scrollShare(-20, 2000, 1000)).toBe(0)
  })

  it('is 0 when there is nothing to scroll', () => {
    expect(scrollShare(0, 800, 800)).toBe(0)
    expect(scrollShare(10, 700, 800)).toBe(0)
  })

  it('is what the other pane is moved to, clamped, and never a number the script could not read', () => {
    expect(scrollSyncApplyScript(0.25, 2)).toContain('apply(0.25, 1)')
    expect(scrollSyncApplyScript(-3, Number.NaN)).toContain('apply(0, 0)')
    expect(scrollSyncApplyScript(Number.POSITIVE_INFINITY, 0.5)).toContain('apply(0, 0.5)')
  })
})

describe('which panes follow', () => {
  it('are the other panes of the split view, when it scrolls together', () => {
    expect(syncTargets(['a', 'b', 'c'], 'b', true)).toEqual(['a', 'c'])
    expect(syncTargets(['a', 'b'], 'a', true)).toEqual(['b'])
  })

  it('are none when it does not, or when the page that scrolled is not one of its panes', () => {
    expect(syncTargets(['a', 'b'], 'a', false)).toEqual([])
    expect(syncTargets(['a', 'b'], 'z', true)).toEqual([])
    expect(syncTargets([], 'a', true)).toEqual([])
  })

  it('carry the tool only in a split view that was asked to scroll together, and only while the tool is on', () => {
    const synced = new Set(['s1'])
    expect(carriesScrollSync(true, synced, 's1')).toBe(true)
    expect(carriesScrollSync(false, synced, 's1')).toBe(false)
    expect(carriesScrollSync(true, synced, 's2')).toBe(false)
    expect(carriesScrollSync(true, synced, undefined)).toBe(false)
  })
})

// ---------- gestures ----------

describe('what a gesture is', () => {
  it('is read from the strokes: the axis that moved most, once the move is long enough', () => {
    expect(gestureStroke(0, 0, -50, 5, GESTURE_STEP)).toBe('L')
    expect(gestureStroke(0, 0, 50, -5, GESTURE_STEP)).toBe('R')
    expect(gestureStroke(0, 0, 5, 50, GESTURE_STEP)).toBe('D')
    expect(gestureStroke(0, 0, -5, -50, GESTURE_STEP)).toBe('U')
    expect(gestureStroke(0, 0, 10, 10, GESTURE_STEP)).toBe('')
    expect(gestureStroke(0, 0, GESTURE_STEP - 1, 0, GESTURE_STEP)).toBe('')
    expect(gestureStroke(0, 0, GESTURE_STEP, 0, GESTURE_STEP)).toBe('R')
  })

  it('is the strokes in order, a repeated direction counting once', () => {
    expect(gesturePath([[0, 0], [-30, 0], [-60, 0], [-90, 0]])).toBe('L')
    expect(gesturePath([[0, 0], [0, -30], [0, 0]])).toBe('UD')
    expect(gesturePath([[0, 0], [0, 40], [40, 40]])).toBe('DR')
    expect(gesturePath([[0, 0], [1, 1], [2, 0]])).toBe('')
    expect(gesturePath([[0, 0]])).toBe('')
    expect(gesturePath([])).toBe('')
  })

  it('stops at the longest gesture: a scribble is not a gesture', () => {
    const scribble: Array<[number, number]> = [[0, 0]]
    for (let i = 1; i <= 30; i++) scribble.push([i % 2 === 0 ? 0 : 80, 4 * i])
    expect(gesturePath(scribble)).toBe('RLRLRLRL')
    expect(gesturePath(scribble).length).toBeLessThanOrEqual(GESTURE_MAX_STEPS)
    expect(gestureAction(gesturePath(scribble))).toBeNull()
  })

  it('has an action for the shapes that mean something, and none for the rest (a plain click included)', () => {
    expect(gestureAction('L')).toBe('back')
    expect(gestureAction('R')).toBe('forward')
    expect(gestureAction('D')).toBe('new-tab')
    expect(gestureAction('UD')).toBe('reload')
    expect(gestureAction('DR')).toBe('close-tab')
    expect(gestureAction('DL')).toBe('reopen-tab')
    expect(gestureAction('')).toBeNull()
    expect(gestureAction('U')).toBeNull()
    expect(gestureAction('LLL')).toBeNull()
    // A name from the prototype chain is not a shape.
    expect(gestureAction('constructor')).toBeNull()
    expect(gestureAction('__proto__')).toBeNull()
    expect(gestureAction('toString')).toBeNull()
  })

  it('is listed for the settings, one line for each shape', () => {
    expect(gestureLabels()).toHaveLength(Object.keys(GESTURES).length)
  })

  it('is written with the words and the punctuation of the language of the interface', () => {
    expect(gesturesSummary()).toBe(
      frenchSpaces('← : Page précédente ; → : Page suivante ; ↓ : Nouvel onglet ; ↑ puis ↓ : Actualiser la page ; ↓ puis → : Archiver l’onglet ; ↓ puis ← : Rouvrir le dernier onglet fermé')
    )
    try {
      setLanguage('en')
      expect(gesturesSummary()).toBe('←: Back; →: Forward; ↓: New Tab; ↑ then ↓: Reload Page; ↓ then →: Archive Tab; ↓ then ←: Reopen Last Closed Tab')
    } finally {
      setLanguage('fr')
    }
  })

  it('is on for a page when the setting is on and the site is not left out (a subdomain of a site left out is left out too)', () => {
    expect(gesturesOn(true, [], 'https://example.org/')).toBe(true)
    expect(gesturesOn(false, [], 'https://example.org/')).toBe(false)
    expect(gesturesOn(true, ['maps.example.org'], 'https://maps.example.org/x')).toBe(false)
    expect(gesturesOn(true, ['example.org'], 'https://maps.example.org/x')).toBe(false)
    expect(gesturesOn(true, ['maps.example.org'], 'https://example.org/')).toBe(true)
    expect(gesturesOn(true, ['example.org'], 'https://notexample.org/')).toBe(true)
  })
})
