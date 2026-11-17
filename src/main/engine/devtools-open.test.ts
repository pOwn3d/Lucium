import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEVTOOLS_TIMING, inspectDevToolsAt, showDevTools, type DevToolsFrontend, type DevToolsHost, type DevToolsTiming } from './devtools-open'

/** Quick enough for a test, long enough for the timers of one to fire in order. */
const FAST: DevToolsTiming = { openMs: 60, frontendMs: 150, retryMs: 5, settleMs: 5 }

/** A frontend that answers the way a real one does: `waiting` for a while, `pending` once called, then `done`. */
function fakeFrontend(replies: Array<unknown | Error>) {
  let destroyed = false
  const scripts: string[] = []
  const queue = [...replies]
  const focus = vi.fn()
  return {
    scripts,
    focus,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    executeJavaScript: async (code: string): Promise<unknown> => {
      scripts.push(code)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    }
  }
}

function fakeHost(options: { open?: boolean; frontend?: DevToolsFrontend | null; opens?: boolean; openThrows?: boolean } = {}) {
  const events = new EventEmitter()
  let open = options.open ?? false
  const host = {
    opened: [] as Array<{ mode?: string } | undefined>,
    inspected: [] as Array<{ x: number; y: number }>,
    inspectThrows: false,
    isDevToolsOpened: () => open,
    openDevTools(args?: { mode?: string }) {
      if (options.openThrows) throw new Error('the window of the tools cannot be made')
      host.opened.push(args)
      if (options.opens !== false) setTimeout(() => {
        open = true
        events.emit('devtools-opened')
      }, 1)
    },
    inspectElement(x: number, y: number) {
      if (host.inspectThrows) throw new Error('no agent to ask')
      host.inspected.push({ x, y })
    },
    once: (event: 'devtools-opened', listener: () => void) => events.once(event, listener),
    removeListener: (event: 'devtools-opened', listener: () => void) => events.removeListener(event, listener),
    get devToolsWebContents() {
      return options.frontend === undefined ? null : options.frontend
    },
    listeners: () => events.listenerCount('devtools-opened')
  }
  return host satisfies DevToolsHost & object
}

describe('showDevTools', () => {
  it('opens the window with no mode, so that the dock side last chosen is kept, waits for it, and shows the panel asked for', async () => {
    const frontend = fakeFrontend(['done'])
    const host = fakeHost({ frontend })
    expect(await showDevTools(host, 'console', FAST)).toEqual({ ok: true })
    expect(host.opened).toEqual([undefined])
    expect(frontend.scripts[0]).toContain('api.showPanel("console")')
    // Asked once to call, once more (looking only) after the settling pause.
    expect(frontend.scripts).toHaveLength(2)
    expect(host.listeners()).toBe(0)
  })

  it('does not open the window again when it is open, and goes to the panel', async () => {
    const frontend = fakeFrontend(['done'])
    const host = fakeHost({ open: true, frontend })
    expect(await showDevTools(host, 'network', FAST)).toEqual({ ok: true })
    expect(host.opened).toEqual([])
    expect(frontend.scripts[0]).toContain('api.showPanel("network")')
  })

  it('asks again while the frontend has not built its panels, and calls only when it is ready', async () => {
    const frontend = fakeFrontend(['waiting', 'waiting', 'pending', 'done'])
    const host = fakeHost({ frontend })
    expect(await showDevTools(host, 'elements', FAST)).toEqual({ ok: true })
    expect(frontend.scripts.length).toBeGreaterThanOrEqual(4)
  })

  it('asks again when the frontend put its own panel back after the one asked for (it restores the one it was last on when it ends loading)', async () => {
    // done, then (after the pause) no longer shown, then pending, then done twice.
    const frontend = fakeFrontend(['done', 'pending', 'pending', 'done'])
    const host = fakeHost({ frontend })
    expect(await showDevTools(host, 'console', FAST)).toEqual({ ok: true })
    expect(frontend.scripts.length).toBeGreaterThanOrEqual(4)
  })

  it('asks for the picking mode once, then only looks (it is a toggle in the frontend)', async () => {
    const frontend = fakeFrontend(['pending', 'pending', 'done'])
    const host = fakeHost({ frontend })
    expect(await showDevTools(host, 'inspect', FAST)).toEqual({ ok: true })
    const calling = frontend.scripts.filter((script) => script.includes('api.enterInspectElementMode();'))
    expect(calling).toHaveLength(1)
    expect(frontend.scripts.length).toBeGreaterThan(1)
  })

  it('puts the window in front when only the tools are asked for and they were open, and tells the frontend nothing', async () => {
    const frontend = fakeFrontend(['done'])
    const host = fakeHost({ open: true, frontend })
    expect(await showDevTools(host, 'tools', FAST)).toEqual({ ok: true })
    expect(frontend.focus).toHaveBeenCalledTimes(1)
    expect(frontend.scripts).toEqual([])
  })

  it('does not bring a window to the front that has just opened (it is there already), for the tools alone', async () => {
    const frontend = fakeFrontend(['done'])
    const host = fakeHost({ frontend })
    expect(await showDevTools(host, 'tools', FAST)).toEqual({ ok: true })
    expect(frontend.focus).not.toHaveBeenCalled()
  })

  it('fails with "not-opened" when the window never reports itself open, and stops listening', async () => {
    const host = fakeHost({ frontend: fakeFrontend(['done']), opens: false })
    expect(await showDevTools(host, 'console', FAST)).toEqual({ ok: false, reason: 'not-opened', detail: expect.stringContaining('no devtools-opened') })
    expect(host.listeners()).toBe(0)
  })

  it('fails with "not-opened" when the window cannot be made, and says why', async () => {
    const host = fakeHost({ frontend: fakeFrontend(['done']), openThrows: true })
    expect(await showDevTools(host, 'console', FAST)).toEqual({ ok: false, reason: 'not-opened', detail: 'the window of the tools cannot be made' })
    expect(host.listeners()).toBe(0)
  })

  it('fails with "closed" when the window is gone once it was open', async () => {
    expect(await showDevTools(fakeHost({ open: true, frontend: null }), 'console', FAST)).toMatchObject({ ok: false, reason: 'closed' })
    const frontend = fakeFrontend(['done'])
    frontend.destroy()
    expect(await showDevTools(fakeHost({ open: true, frontend }), 'console', FAST)).toMatchObject({ ok: false, reason: 'closed' })
  })

  it('fails with "frontend" when the frontend never shows the panel, and says what it kept answering', async () => {
    const outcome = await showDevTools(fakeHost({ open: true, frontend: fakeFrontend(['waiting']) }), 'console', FAST)
    expect(outcome).toEqual({ ok: false, reason: 'frontend', detail: expect.stringContaining('"waiting"') })
  })

  it('fails with "script" when the frontend throws, and with "closed" when it was the window going away that made it throw', async () => {
    const throws = fakeFrontend([new Error('Uncaught TypeError')])
    expect(await showDevTools(fakeHost({ open: true, frontend: throws }), 'console', FAST)).toEqual({ ok: false, reason: 'script', detail: 'Uncaught TypeError' })
    const dying = fakeFrontend([new Error('Object has been destroyed')])
    dying.executeJavaScript = async () => {
      dying.destroy()
      throw new Error('Object has been destroyed')
    }
    expect(await showDevTools(fakeHost({ open: true, frontend: dying }), 'console', FAST)).toMatchObject({ ok: false, reason: 'closed' })
  })

  it('has delays that give a loaded machine time (the 400 ms it used to wait is the least of it)', () => {
    expect(DEVTOOLS_TIMING.frontendMs).toBeGreaterThan(400)
    expect(DEVTOOLS_TIMING.openMs).toBeGreaterThan(DEVTOOLS_TIMING.frontendMs)
  })
})

describe('inspectDevToolsAt', () => {
  it('opens the window apart before pointing at the element, so that the tools are not docked into the window, and waits for it', async () => {
    const host = fakeHost({ frontend: fakeFrontend(['done']) })
    expect(await inspectDevToolsAt(host, { x: 540, y: 420 }, FAST)).toEqual({ ok: true })
    expect(host.opened).toEqual([undefined])
    expect(host.inspected).toEqual([{ x: 540, y: 420 }])
  })

  it('only points at the element when the tools are open', async () => {
    const host = fakeHost({ open: true, frontend: fakeFrontend(['done']) })
    expect(await inspectDevToolsAt(host, { x: 1, y: 2 }, FAST)).toEqual({ ok: true })
    expect(host.opened).toEqual([])
    expect(host.inspected).toEqual([{ x: 1, y: 2 }])
  })

  it('fails with "not-opened" when the window never opens', async () => {
    const host = fakeHost({ opens: false })
    expect(await inspectDevToolsAt(host, { x: 1, y: 2 }, FAST)).toMatchObject({ ok: false, reason: 'not-opened' })
    expect(host.listeners()).toBe(0)
  })

  it('fails with "not-opened" when the page cannot be inspected, and with "script" when it cannot while the tools are open', async () => {
    const closed = fakeHost()
    closed.inspectThrows = true
    expect(await inspectDevToolsAt(closed, { x: 1, y: 2 }, FAST)).toEqual({ ok: false, reason: 'not-opened', detail: 'no agent to ask' })
    const open = fakeHost({ open: true })
    open.inspectThrows = true
    expect(await inspectDevToolsAt(open, { x: 1, y: 2 }, FAST)).toEqual({ ok: false, reason: 'script', detail: 'no agent to ask' })
  })
})
