// The journal of the sidebar of a window (sidebar-trace.ts): a line for each change of where the sidebar is and what caused it, a line for each touch of the
// edge that opened the floating sidebar or was refused, limited so that a loop of them cannot fill the 50 lines the report carries. A line says booleans and
// words of the program, never an address or a title. The wiring is the real methods of the class, on a window that is a stand-in.

import { describe, expect, it, vi } from 'vitest'
import { ERROR_LINE_MAX, ErrorLog } from '../error-log'
import { defaultSettings } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { NO_WINDOW_SIDEBAR, type WindowSidebar, type WindowSidebarChange } from '@shared/window-sidebar'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { SidebarTrace, TRACE_EDGE_INTERVAL_MS, sidebarCauseOf, sidebarFacts, windowSidebarCause, type SidebarFacts } from './sidebar-trace'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')

const settings = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...defaultSettings(), sidebarVisible: true, showToolbar: true, ...over })
const column = sidebarFacts(settings(), { docked: true })
const hidden = sidebarFacts(settings({ sidebarVisible: false }), { docked: true })

describe('what a line says of the sidebar', () => {
  it('names what is on screen (the full sidebar, its column, nothing), the side, the choice of the window and the two bars away', () => {
    expect(sidebarFacts(settings(), NO_WINDOW_SIDEBAR)).toEqual({ shape: 'full', side: 'left', own: 'none', barsAway: false })
    expect(column).toEqual({ shape: 'column', side: 'left', own: 'docked', barsAway: false })
    expect(sidebarFacts(settings({ sidebarRight: true }), { side: 'left', docked: true })).toEqual({ shape: 'column', side: 'left', own: 'docked+left', barsAway: false })
    // Docked before it was hidden: nothing is on screen, whatever the window chose.
    expect(hidden).toEqual({ shape: 'hidden', side: 'left', own: 'docked', barsAway: false })
    expect(sidebarFacts(settings({ sidebarVisible: false, showToolbar: false }), NO_WINDOW_SIDEBAR).barsAway).toBe(true)
  })

  it('knows the actions that can move the sidebar, and the settings they carry; no other action is looked at', () => {
    expect(sidebarCauseOf({ type: 'compact/toggle' })).toBe('compact/toggle')
    expect(sidebarCauseOf({ type: 'settings/update', patch: { sidebarVisible: false } })).toBe('settings/update sidebarVisible=false')
    expect(sidebarCauseOf({ type: 'settings/update', patch: { sidebarRight: true, showToolbar: false, uiScale: 110 } })).toBe('settings/update sidebarRight=true,showToolbar=false')
    expect(sidebarCauseOf({ type: 'settings/update', patch: { sidebarWidth: 300 } })).toBeNull()
    expect(sidebarCauseOf({ type: 'tab/select', id: 'a' } as Action)).toBeNull()
  })

  it('names the changes of « Barre de cette fenêtre »', () => {
    const named = (change: WindowSidebarChange) => windowSidebarCause(change)
    expect(named({ op: 'dock', docked: true })).toBe('window-sidebar dock=true')
    expect(named({ op: 'toggle-dock' })).toBe('window-sidebar toggle-dock')
    expect(named({ op: 'side', side: null })).toBe('window-sidebar side=setting')
    expect(named({ op: 'toggle-side' })).toBe('window-sidebar toggle-side')
  })
})

describe('the lines', () => {
  const sink = () => {
    const lines: string[] = []
    let now = 0
    const trace = new SidebarTrace(() => 'main', (line) => void lines.push(line), () => now)
    return { trace, lines, at: (ms: number) => void (now = ms) }
  }

  it('says where the window starts, then each change with its cause, and nothing while nothing changes', () => {
    const { trace, lines } = sink()
    trace.placement(column)
    trace.placement(column)
    trace.during('window-sidebar dock=false', () => trace.placement({ ...column, shape: 'full', own: 'none' }))
    trace.placement({ ...column, shape: 'full', own: 'none' })
    trace.during('toggleSidebar', () => trace.placement({ ...hidden, own: 'none' }))
    trace.placement({ ...hidden, own: 'none', barsAway: true })
    expect(lines).toEqual([
      '[sidebar] main: column left own=docked (start)',
      '[sidebar] main: column left own=docked -> full left own=none (window-sidebar dock=false)',
      '[sidebar] main: full left own=none -> hidden left own=none (toggleSidebar)',
      '[sidebar] main: hidden left own=none -> hidden left own=none bars-away (state)'
    ])
  })

  it('puts the cause of the innermost call on the line, and none of it once the call has returned', () => {
    const { trace, lines } = sink()
    trace.placement(column)
    trace.during('compact/toggle', () => trace.during('settings/update sidebarVisible=false', () => trace.placement(hidden)))
    trace.placement(column)
    expect(lines.slice(1)).toEqual([
      '[sidebar] main: column left own=docked -> hidden left own=docked (settings/update sidebarVisible=false)',
      '[sidebar] main: hidden left own=docked -> column left own=docked (state)'
    ])
    expect(trace.during(null, () => 7)).toBe(7)
    expect(() => trace.during('x', () => { throw new Error('refused') })).toThrow('refused')
    trace.placement(hidden)
    expect(lines.at(-1)).toContain('(state)')
  })

  it('writes a touch of the edge, and holds back the same one repeated within a second, saying how many it held back', () => {
    const { trace, lines, at } = sink()
    for (let i = 0; i < 40; i++) {
      at(i * 20)
      trace.edgeEvent('opened', hidden)
    }
    expect(lines).toEqual(['[sidebar] main: edge opened while hidden left own=docked'])
    at(TRACE_EDGE_INTERVAL_MS + 100)
    trace.edgeEvent('opened', hidden)
    expect(lines.at(-1)).toBe('[sidebar] main: edge opened while hidden left own=docked (+39 more)')
    // Another kind of touch has its own line at once.
    trace.edgeEvent('closing', hidden)
    trace.edgeEvent('ignored', column)
    expect(lines.slice(-2)).toEqual(['[sidebar] main: edge closing while hidden left own=docked', '[sidebar] main: edge ignored while column left own=docked'])
  })

  it('fits the journal of the report: one short line each, redacted and cut like the others, and a loop of reveals leaves room for the errors', () => {
    const journal = new ErrorLog(() => 0)
    const trace = new SidebarTrace(() => 'window-12', (line) => journal.add([line]), (() => { let t = 0; return () => (t += 25) })())
    for (let i = 0; i < 400; i++) trace.edgeEvent(i % 2 === 0 ? 'opened' : 'gone', hidden)
    // 10 s of a loop: each kind is written at 0, 1, 3 and 7 s, with the waits doubling; the journal keeps room for the errors.
    expect(journal.lines().length).toBeLessThanOrEqual(10)
    for (const line of journal.lines()) expect(line.length).toBeLessThanOrEqual(ERROR_LINE_MAX + 40)
    // And a loop of five minutes does not fill it either.
    const long = new ErrorLog(() => 0)
    let t = 0
    const loop = new SidebarTrace(() => 'main', (line) => long.add([line]), () => (t += 25))
    for (let i = 0; i < 12_000; i++) loop.edgeEvent(i % 2 === 0 ? 'opened' : 'gone', hidden)
    expect(long.lines().length).toBeLessThan(30)
    expect(journal.lines().every((line) => line.includes('[sidebar] window-12: edge '))).toBe(true)
  })
})

describe('the window that writes them', () => {
  function window(choice: WindowSidebar, state: { sidebarVisible: boolean; showToolbar?: boolean }) {
    const lines: string[] = []
    const current = { ...settings(), sidebarVisible: state.sidebarVisible, showToolbar: state.showToolbar ?? true }
    const self = Object.assign(Object.create(Browser.prototype) as object, {
      sidebarChoice: choice,
      store: { get: () => ({ settings: current }) },
      traceKept: new SidebarTrace(() => 'main', (line) => void lines.push(line), () => 0),
      dispatch(action: Action) {
        // The state follows the action as the store does, then the window is laid out (what the store's subscription does).
        if (action.type === 'settings/update') Object.assign(current, action.patch)
        ;(self as unknown as { layout(): void }).layout()
      },
      layout() {
        ;(self as unknown as { sidebarTrace: SidebarTrace; sidebarFacts(): SidebarFacts }).sidebarTrace.placement((self as unknown as { sidebarFacts(): SidebarFacts }).sidebarFacts())
      },
      publishQueue: { now: () => undefined },
      unsubscribe: () => undefined,
      win: { isDestroyed: () => false }
    }) as unknown as { changeWindowSidebar(change: WindowSidebarChange): void; toggleSidebar(): void; layout(): void }
    self.layout()
    lines.length = 0
    return { browser: self, lines }
  }

  it('says the change of « Barre de cette fenêtre » that docks the sidebar, and what showing a hidden one adds', () => {
    const shown = window(NO_WINDOW_SIDEBAR, { sidebarVisible: true })
    shown.browser.changeWindowSidebar({ op: 'dock', docked: true })
    expect(shown.lines).toEqual(['[sidebar] main: full left own=none -> column left own=docked (window-sidebar dock=true)'])
    const away = window(NO_WINDOW_SIDEBAR, { sidebarVisible: false })
    away.browser.changeWindowSidebar({ op: 'toggle-dock' })
    expect(away.lines.length).toBeGreaterThan(0)
    expect(away.lines.every((line) => line.endsWith('(window-sidebar toggle-dock)'))).toBe(true)
    expect(away.lines.at(-1)).toContain('column left own=docked')
  })

  it('says ⌘S and the menu (toggleSidebar), on the column as on the full sidebar: the sidebar goes hidden with that cause', () => {
    const docked = window({ docked: true }, { sidebarVisible: true })
    docked.browser.toggleSidebar()
    expect(docked.lines).toEqual(['[sidebar] main: column left own=docked -> hidden left own=docked (toggleSidebar)'])
    docked.browser.toggleSidebar()
    expect(docked.lines.at(-1)).toBe('[sidebar] main: hidden left own=docked -> column left own=docked (toggleSidebar)')
  })

  it('says its edge: opened at a hidden sidebar, ignored over a column', () => {
    const lines: string[] = []
    const make = (state: { sidebarVisible: boolean }, choice: WindowSidebar) =>
      Object.assign(Object.create(Browser.prototype) as object, {
        sidebarChoice: choice,
        store: { get: () => ({ settings: { ...settings(), ...state } }) },
        traceKept: new SidebarTrace(() => 'main', (line) => void lines.push(line), () => 0),
        fullscreenTab: null,
        floatTimer: null,
        floatVisible: false,
        floatPhase: null,
        floating: { ensure: () => undefined },
        layout: () => undefined,
        publish: () => undefined
      }) as unknown as { hotEdge(inside: boolean): void }
    make({ sidebarVisible: true }, { docked: true }).hotEdge(true)
    make({ sidebarVisible: false }, { docked: true }).hotEdge(true)
    expect(lines).toEqual(['[sidebar] main: edge ignored while column left own=docked', '[sidebar] main: edge opened while hidden left own=docked'])
  })
})

describe('where the shell calls it', () => {
  const shell = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

  it('lays out with a look at the sidebar', () => {
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const placed: SidebarFacts[] = []
    const facts = sidebarFacts(settings(), NO_WINDOW_SIDEBAR)
    const fake = fakeBrowser({
      store: { get: () => state },
      sidebarTrace: { placement: (seen: SidebarFacts) => void placed.push(seen) },
      sidebarFacts: () => facts,
      k: () => 1,
      toCss: (rect: unknown) => rect,
      fromCss: (rect: unknown) => rect,
      frame: () => ({ stage: { x: 0, y: 0, width: 800, height: 600 }, panel: null }),
      fullscreenTab: null,
      pages: new Map(),
      floatVisible: false,
      overlayRequest: null
    })
    shell['layout']!.call(fake.self)
    expect(placed).toEqual([facts])
  })

  it('wraps the actions that can move the sidebar, and no other', () => {
    const run = (action: Action) => {
      const causes: Array<string | null> = []
      const state = createInitialState({ now: 0, newId: () => 'x' })
      const direct = vi.fn()
      const fake = fakeBrowser({
        isPrivate: () => false,
        store: { get: () => state, root: () => ({ get: () => state }), dispatch: direct },
        sidebarTrace: { during: (cause: string, work: () => void) => (causes.push(cause), work()) },
        closedHistoryCtx: () => undefined,
        reopenedWithHistory: () => null,
        reopened: { begin: () => null, end: () => undefined }
      })
      shell['dispatch']!.call(fake.self, action)
      return { causes, direct }
    }
    const moving = run({ type: 'settings/update', patch: { sidebarVisible: false } })
    expect(moving.causes).toEqual(['settings/update sidebarVisible=false'])
    // The action is applied inside the wrapper, once.
    expect(moving.direct).toHaveBeenCalledTimes(1)
    expect(run({ type: 'compact/toggle' } as Action).causes).toEqual(['compact/toggle'])
    const other = run({ type: 'tab/open', url: 'https://site.example/' })
    expect(other.causes).toEqual([])
    expect(other.direct).toHaveBeenCalledTimes(1)
  })

  it('says every touch of the edge: opened, ignored, then closing and gone when the hand leaves the floating sidebar', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const self = Object.assign(Object.create(Browser.prototype) as object, {
        sidebarChoice: { docked: true },
        store: { get: () => ({ settings: { ...settings(), sidebarVisible: false } }) },
        traceKept: new SidebarTrace(() => 'main', (line) => void lines.push(line), () => 0),
        fullscreenTab: null,
        floatTimer: null,
        floatVisible: false,
        floatPhase: null,
        floating: { ensure: () => undefined },
        layout: () => undefined,
        publish: () => undefined
      }) as unknown as { hotEdge(inside: boolean): void }
      self.hotEdge(true)
      self.hotEdge(false)
      vi.advanceTimersByTime(5_000)
      expect(lines.map((line) => /edge (\w+)/.exec(line)?.[1])).toEqual(['opened', 'closing', 'gone'])
    } finally {
      vi.useRealTimers()
    }
  })
})
