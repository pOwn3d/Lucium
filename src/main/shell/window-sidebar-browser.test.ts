// The browser of a window keeps the sidebar that window chose (« Barre de cette fenêtre »): the real methods of the class, on a window that is a stand-in.
// A change lays the window out and publishes once; docking a hidden sidebar shows it; a change that changes nothing does neither; a choice given before
// the window started is only kept (its first sync lays it out); what a file hands over is kept to its known values. The menu's key follows the placement.

import { describe, expect, it, vi } from 'vitest'
import type { Action } from '@shared/sidebar'
import { NO_WINDOW_SIDEBAR, type WindowSidebar, type WindowSidebarChange } from '@shared/window-sidebar'
import { SidebarTrace } from './sidebar-trace'

// The shell (browser.ts) reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')

interface Shell {
  changeWindowSidebar(change: WindowSidebarChange): void
  setWindowSidebar(raw: unknown): void
  windowSidebar(): WindowSidebar
}

function window(settings: { sidebarRight: boolean; sidebarVisible: boolean }, choice: WindowSidebar = NO_WINDOW_SIDEBAR, started = true) {
  const calls = { dispatched: [] as Action[], layouts: 0, published: 0 }
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    sidebarChoice: choice,
    store: { get: () => ({ settings }) },
    dispatch: (action: Action) => void calls.dispatched.push(action),
    layout: () => void calls.layouts++,
    publishQueue: { now: () => void calls.published++ },
    unsubscribe: started ? () => {} : null,
    win: { isDestroyed: () => false }
  }) as unknown as Shell & { sidebarFact(): unknown }
  return { browser: self, calls }
}

describe('the sidebar a window chose, in its browser', () => {
  it('docks the sidebar of this window: laid out and published once, the shared state untouched', () => {
    const { browser, calls } = window({ sidebarRight: false, sidebarVisible: true })
    browser.changeWindowSidebar({ op: 'dock', docked: true })
    expect(browser.windowSidebar()).toEqual({ docked: true })
    expect(calls).toEqual({ dispatched: [], layouts: 1, published: 1 })
  })

  it('shows a hidden sidebar it docks (⌃⌘S on a hidden sidebar shows its column)', () => {
    const { browser, calls } = window({ sidebarRight: false, sidebarVisible: false })
    browser.changeWindowSidebar({ op: 'toggle-dock' })
    expect(browser.windowSidebar()).toEqual({ docked: true })
    expect(calls.dispatched).toEqual([{ type: 'settings/update', patch: { sidebarVisible: true } }])
  })

  it('does nothing for a change that changes nothing: no layout, no publication (and so no save of the windows)', () => {
    const { browser, calls } = window({ sidebarRight: true, sidebarVisible: true }, { side: 'right' })
    browser.changeWindowSidebar({ op: 'side', side: 'right' })
    expect(calls).toEqual({ dispatched: [], layouts: 0, published: 0 })
  })

  it('chooses a side for this window only: the setting (the side of new windows) is not dispatched', () => {
    const { browser, calls } = window({ sidebarRight: false, sidebarVisible: true })
    browser.changeWindowSidebar({ op: 'toggle-side' })
    expect(browser.windowSidebar()).toEqual({ side: 'right' })
    expect(calls.dispatched).toEqual([])
    browser.changeWindowSidebar({ op: 'side', side: null })
    expect(browser.windowSidebar()).toEqual({})
  })

  it('only keeps a choice given before the window started (the first sync lays it out), and keeps a file’s choice to its known values', () => {
    const { browser, calls } = window({ sidebarRight: false, sidebarVisible: true }, NO_WINDOW_SIDEBAR, false)
    browser.setWindowSidebar({ side: 'right', docked: true, extra: 'x' })
    expect(browser.windowSidebar()).toEqual({ side: 'right', docked: true })
    expect(calls).toEqual({ dispatched: [], layouts: 0, published: 0 })
    browser.setWindowSidebar('nonsense')
    expect(browser.windowSidebar()).toEqual({})
  })

  it('tells the menu bar how the sidebar of the window is placed: nothing for the full sidebar at the left, the case of every window that changed nothing', () => {
    const fact = (settings: { sidebarRight: boolean; sidebarVisible: boolean }, choice: WindowSidebar) => window(settings, choice).browser.sidebarFact()
    expect(fact({ sidebarRight: false, sidebarVisible: true }, NO_WINDOW_SIDEBAR)).toEqual({})
    expect(fact({ sidebarRight: false, sidebarVisible: true }, { docked: true })).toEqual({ sidebar: 'left-docked' })
    expect(fact({ sidebarRight: true, sidebarVisible: true }, NO_WINDOW_SIDEBAR)).toEqual({ sidebar: 'right' })
    expect(fact({ sidebarRight: false, sidebarVisible: true }, { side: 'right', docked: true })).toEqual({ sidebar: 'right-docked' })
  })
})

// The edge of the window (the strip of a hidden sidebar, or the touch of the floating copy) opens the floating sidebar only while no sidebar is on screen:
// never for the column of a docked sidebar, which is a shown sidebar. The real method of the class, on a window that is a stand-in.
interface Edge {
  hotEdge(inside: boolean): void
}

function edgeWindow(settings: { sidebarRight: boolean; sidebarVisible: boolean; compactMode?: boolean; showToolbar?: boolean }, choice: WindowSidebar, extra: { fullscreenTab?: string } = {}) {
  const calls = { ensured: 0, layouts: 0, published: 0 }
  const lines: string[] = []
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    sidebarChoice: choice,
    store: { get: () => ({ settings }) },
    traceKept: new SidebarTrace(() => 'main', (line) => void lines.push(line), () => 0),
    fullscreenTab: extra.fullscreenTab ?? null,
    floatTimer: null,
    floatVisible: false,
    floatPhase: null,
    floating: { ensure: () => void calls.ensured++ },
    layout: () => void calls.layouts++,
    publish: () => void calls.published++
  }) as unknown as Edge & { floatVisible: boolean; floatPhase: string | null }
  return { browser: self, calls, lines }
}

describe('the edge of a window that docked its sidebar', () => {
  it('opens no floating sidebar for the pointer on the column (the sidebar is shown, docked or not)', () => {
    for (const choice of [NO_WINDOW_SIDEBAR, { docked: true } as WindowSidebar, { side: 'right', docked: true } as WindowSidebar]) {
      const { browser, calls } = edgeWindow({ sidebarRight: false, sidebarVisible: true }, choice)
      browser.hotEdge(true)
      expect(calls).toEqual({ ensured: 0, layouts: 0, published: 0 })
      expect(browser.floatVisible).toBe(false)
      expect(browser.floatPhase).toBeNull()
    }
  })

  it('opens it at the edge of a hidden sidebar (⌘S), even one that was docked before: the column is gone then', () => {
    for (const choice of [NO_WINDOW_SIDEBAR, { docked: true } as WindowSidebar]) {
      const { browser, calls } = edgeWindow({ sidebarRight: false, sidebarVisible: false }, choice)
      browser.hotEdge(true)
      expect(calls).toEqual({ ensured: 1, layouts: 1, published: 1 })
      expect(browser.floatVisible).toBe(true)
      expect(browser.floatPhase).toBe('in')
    }
  })

  it('opens nothing, and lays nothing out, at the edge of a docked window in compact mode (the function on, the column shown): the window is not compact', () => {
    for (const showToolbar of [true, false]) {
      const { browser, calls } = edgeWindow({ sidebarRight: false, sidebarVisible: true, compactMode: true, showToolbar }, { docked: true })
      for (const inside of [true, false, true, false]) browser.hotEdge(inside)
      expect(calls).toEqual({ ensured: 0, layouts: 0, published: 0 })
      expect(browser.floatVisible).toBe(false)
    }
  })

  it('keeps the edge of a compact window (both bars away) as before, docked before it went compact or not', () => {
    for (const choice of [NO_WINDOW_SIDEBAR, { docked: true } as WindowSidebar]) {
      const { browser, calls } = edgeWindow({ sidebarRight: false, sidebarVisible: false, compactMode: true, showToolbar: false }, choice)
      browser.hotEdge(true)
      expect(calls).toEqual({ ensured: 1, layouts: 1, published: 1 })
      expect(browser.floatVisible).toBe(true)
    }
  })

  it('opens nothing under a page in full screen, hidden sidebar or not', () => {
    const { browser, calls } = edgeWindow({ sidebarRight: false, sidebarVisible: false }, NO_WINDOW_SIDEBAR, { fullscreenTab: 'tab' })
    browser.hotEdge(true)
    expect(calls).toEqual({ ensured: 0, layouts: 0, published: 0 })
  })
})
