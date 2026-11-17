// The empty tabs the user or a page opened (shell/blank-tab-watch.ts): which ones are marked, when they are closed, and where the window goes then. The
// real watch runs over the real state of the sidebar, with a stand-in for the window (what is on screen, an open overlay, the other windows). The
// rules it applies (shared/blank-tabs.ts) are tested on their own in shared/blank-tabs.test.ts: this checks how the window uses them.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import { BlankTabWatch } from './blank-tab-watch'

// browser.ts reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** A window over the real reducer: the tab on screen is the active one, and `select` is a click on another tab followed by the window's sync. */
function windowOf() {
  const ctx = { now: 1, newId: (() => { let next = 0; return () => `t${++next}` })() }
  let state = createInitialState(ctx)
  const closed: string[] = []
  const dispatch = (action: Action) => {
    ctx.now += 1
    if (action.type === 'tab/close') closed.push(action.id)
    state = reduce(state, action, ctx)
  }
  const io = { overlay: false, summary: new Set<string>(), elsewhere: new Set<string>(), offScreen: new Set<string>() }
  const watch = new BlankTabWatch({
    store: { get: () => state },
    dispatch,
    displayed: (id) => !io.offScreen.has(id) && activeTab(state)?.id === id,
    overlayOpen: () => io.overlay,
    isSummary: (id) => io.summary.has(id),
    shownElsewhere: () => io.elsewhere
  })
  let shown: string | null = activeTab(state)?.id ?? null
  /** The window's sync after a change of the state: the watch is told which tab was on screen and which one is now. */
  const sync = () => {
    const previous = shown
    shown = activeTab(state)?.id ?? null
    watch.watch(previous, shown)
  }
  const open = (url: string): string => {
    dispatch({ type: 'tab/open', url })
    sync()
    return activeTab(state)!.id
  }
  /** ⌘T, or the new tab of the command bar: an action of the interface. */
  const newBlankTab = (): string => {
    const action: Action = { type: 'tab/open', url: 'about:blank' }
    watch.applyFromInterface(action, () => dispatch(action))
    sync()
    return activeTab(state)!.id
  }
  /** A page of the tab `opener` opens an empty tab (window.open, a link without address), in front unless `background`. */
  const pageOpensBlank = (opener: string, background = false): string => {
    let created = ''
    watch.applyFromTab(opener, 'about:blank', true, () => {
      const before = new Set(state.tabs.map((t) => t.id))
      dispatch({ type: 'tab/open', url: 'about:blank', background })
      created = state.tabs.find((t) => !before.has(t.id))!.id
    })
    sync()
    return created
  }
  const select = (id: string) => {
    dispatch({ type: 'tab/select', id })
    sync()
  }
  const exists = (id: string) => state.tabs.some((t) => t.id === id)
  const spaceOf = (id: string) => state.tabs.find((t) => t.id === id)!.spaceId
  return { watch, io, closed, dispatch, sync, open, newBlankTab, pageOpensBlank, select, exists, spaceOf, state: () => state, active: () => activeTab(state)?.id ?? null }
}

let info: MockInstance<typeof console.info>
beforeEach(() => {
  vi.useFakeTimers()
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const traces = (): string[] => info.mock.calls.map((call) => String(call[0]))

describe('an empty tab the user opened', () => {
  it('is closed once the user leaves it for another tab, on the next tick and not before', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.select(page)
    expect(win.exists(blank)).toBe(true)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(win.closed).toEqual([blank])
  })

  it('is not closed while it stays on screen', () => {
    const win = windowOf()
    win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.sync()
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
  })

  it('is only one the interface opened on the blank page: a tab of the interface with an address is never closed as empty', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const action: Action = { type: 'tab/open', url: 'https://other.example/' }
    win.watch.applyFromInterface(action, () => win.dispatch(action))
    win.sync()
    const other = win.active()!
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(other)).toBe(true)
    expect(win.closed).toEqual([])
  })

  it('is no longer closed once its page committed an address: it is a used tab from then on', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.watch.addressCommitted(blank, 'https://typed.example/path?q=secret')
    win.dispatch({ type: 'tab/update', id: blank, patch: { url: 'https://typed.example/path?q=secret' } })
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
  })

  it('stays marked when the address its page commits is the blank one', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.watch.addressCommitted(blank, 'about:blank')
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
  })

  it('is kept when the address comes between the leaving and the closing, and says why it was unmarked, with the host only', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.select(page)
    // The close is scheduled; the page of the tab commits an address before it runs.
    win.watch.addressCommitted(blank, 'https://typed.example/path?q=secret')
    win.dispatch({ type: 'tab/update', id: blank, patch: { url: 'https://typed.example/path?q=secret' } })
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    const kept = traces().find((line) => line.startsWith(`[blank-tab] not closed: tab ${blank}`))
    expect(kept).toBe(`[blank-tab] not closed: tab ${blank} (left): no longer marked as an empty tab (address committed: https://typed.example/path?q=secret); host=https://typed.example`)
  })

  it('is never taken when it is a summary tab', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.io.summary.add(blank)
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    expect(traces()).toContain(`[blank-tab] kept: tab ${blank} (left) is not closed: summary`)
  })

  it('is kept while an overlay is open: the user may be typing in it', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.io.overlay = true
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
  })

  it('traces its birth, the decision with its facts, and the close', () => {
    const win = windowOf()
    const page = win.open('https://site.example/')
    const blank = win.newBlankTab()
    const space = win.spaceOf(blank)
    win.select(page)
    vi.runAllTimers()
    // In order; the address of a tab is never written in full: the host only (`about:` for the blank page).
    expect(traces()).toEqual([
      `[blank-tab] created: tab ${blank} (interface, space ${space})`,
      `[blank-tab] deciding: tab ${blank} (left): host=about: displayed=false shared=false summary=false overlay=false tabs=2 made-by-page=false`,
      `[blank-tab] unmarked: tab ${blank} (closed)`,
      `[blank-tab] closed: tab ${blank} (left, 2 tabs, space ${space})`
    ])
  })

  it('is forgotten when it is closed by the user, and the trace says so', () => {
    const win = windowOf()
    win.open('https://site.example/')
    const blank = win.newBlankTab()
    win.dispatch({ type: 'tab/close', id: blank })
    win.sync()
    expect(traces()).toContain(`[blank-tab] unmarked: tab ${blank} (tab gone)`)
  })
})

describe('an empty tab a page opened', () => {
  it('is closed at once when it is still empty and unused (the next tick)', () => {
    const win = windowOf()
    const opener = win.open('https://site.example/')
    const blank = win.pageOpensBlank(opener, true)
    expect(win.exists(blank)).toBe(true)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(traces()).toContain(`[blank-tab] closing scheduled: tab ${blank} (création, vide), opened by tab ${opener}`)
  })

  it('is not cut when it got an address before the tick (a popup that loads)', () => {
    const win = windowOf()
    const opener = win.open('https://site.example/')
    const blank = win.pageOpensBlank(opener, true)
    win.dispatch({ type: 'tab/update', id: blank, patch: { url: 'https://login.example/' } })
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
  })

  it('may carry a title its page wrote: that is not a use by the user', () => {
    const win = windowOf()
    const opener = win.open('https://site.example/')
    const blank = win.pageOpensBlank(opener, true)
    win.dispatch({ type: 'tab/update', id: blank, patch: { title: 'Fenêtre de la page' } })
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
  })

  /** A page's empty tab that was kept at its creation (an overlay was open), so that it is left to its opener. */
  function keptAtCreation() {
    const win = windowOf()
    const opener = win.open('https://site.example/')
    const other = win.open('https://other.example/')
    win.select(opener)
    win.io.overlay = true
    const blank = win.pageOpensBlank(opener, true)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    win.io.overlay = false
    return { win, opener, other, blank }
  }

  it('goes when its opener has finished loading', () => {
    const { win, opener, blank } = keptAtCreation()
    win.watch.closeOpenedBy('https://unrelated')
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    win.watch.closeOpenedBy(opener)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(traces().some((line) => line.startsWith(`[blank-tab] closed: tab ${blank} (parent chargé,`))).toBe(true)
  })

  it('goes when the user leaves its opener', () => {
    const { win, other, blank } = keptAtCreation()
    win.select(other)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(traces().some((line) => line.startsWith(`[blank-tab] closed: tab ${blank} (parent quitté,`))).toBe(true)
  })

  it('goes when its opener is closed', () => {
    const { win, opener, blank } = keptAtCreation()
    win.dispatch({ type: 'tab/close', id: opener })
    win.sync()
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(traces().some((line) => line.startsWith(`[blank-tab] closed: tab ${blank} (parent fermé,`))).toBe(true)
  })

  it('is decided once when its opener is closed, not again at every sync after', () => {
    const { win, opener, blank } = keptAtCreation()
    win.io.overlay = true
    win.dispatch({ type: 'tab/close', id: opener })
    win.sync()
    vi.runAllTimers()
    win.sync()
    win.sync()
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    expect(traces().filter((line) => line.startsWith(`[blank-tab] deciding: tab ${blank} (parent fermé)`))).toHaveLength(1)
  })

  it('forgets its opener once its page has an address: leaving the opener later does not close a page that has content', () => {
    const { win, opener, other, blank } = keptAtCreation()
    win.watch.addressCommitted(blank, 'https://login.example/')
    win.dispatch({ type: 'tab/update', id: blank, patch: { url: 'https://login.example/' } })
    win.select(other)
    win.watch.closeOpenedBy(opener)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(true)
    // Not even a decision is scheduled for it: the opener was forgotten with the mark.
    expect(traces().filter((line) => line.includes(`tab ${blank} (parent`))).toEqual([])
  })

  it('is kept while the window sharing shows it, and goes once it is no longer on screen', () => {
    const win = windowOf()
    const opener = win.open('https://site.example/')
    const shared = win.pageOpensBlank(opener)
    win.watch.markShared(shared)
    vi.runAllTimers()
    expect(win.exists(shared)).toBe(true)
    expect(traces()).toContain(`[blank-tab] kept: tab ${shared} (création, vide) is not closed: shared`)
    // The sharing is not told when it ends: a tab no one sees any more is not in the picture.
    win.io.offScreen.add(shared)
    win.watch.closeOpenedBy(opener)
    vi.runAllTimers()
    expect(win.exists(shared)).toBe(false)
  })
})

describe('the tab the window goes to when a selected empty tab closes', () => {
  it('is the tab used before it in its space, not a neighbour of the list nor the tab opened last', () => {
    const win = windowOf()
    const used = win.open('https://used.example/')
    win.open('https://recent.example/')
    win.select(used)
    // A page of `used` opens an empty tab in front: it is selected, then closed at once. A tab opened behind in the meantime is the most recent one.
    const blank = win.pageOpensBlank(used)
    expect(win.active()).toBe(blank)
    win.dispatch({ type: 'tab/open', url: 'https://behind.example/', background: true })
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(win.active()).toBe(used)
  })

  it('is never a tab another window shows: that tab would be taken from its window', () => {
    const win = windowOf()
    const used = win.open('https://used.example/')
    const recent = win.open('https://recent.example/')
    win.select(used)
    const blank = win.pageOpensBlank(used)
    win.io.elsewhere.add(used)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(win.active()).not.toBe(used)
    expect(win.active()).toBe(recent)
  })
})

describe('the window hands the tabs it opens to the watch', () => {
  /** The real methods of the Browser that open tabs, run on a stand-in for the window over the real reducer, with a real watch. */
  function browserOf() {
    const win = windowOf()
    const self = {
      store: { get: () => win.state() },
      dispatch: (action: Action) => win.dispatch(action),
      blankTabs: win.watch,
      devTools: vi.fn(),
      namesLockedTarget: () => false,
      openedBy: methods['openedBy'],
      inheritedContainer: () => ({}),
      tabNow: methods['tabNow'],
      treeParent: () => ({})
    }
    return { win, self }
  }

  it('marks the empty tab ⌘T opens through the interface, and not a tab with an address', () => {
    const { win, self } = browserOf()
    const page = win.open('https://site.example/')
    methods['dispatchFromInterface']!.call(self, { type: 'tab/open', url: 'about:blank' })
    win.sync()
    const blank = win.active()!
    methods['dispatchFromInterface']!.call(self, { type: 'tab/open', url: 'https://other.example/' })
    win.sync()
    const other = win.active()!
    win.select(page)
    vi.runAllTimers()
    expect(win.exists(blank)).toBe(false)
    expect(win.exists(other)).toBe(true)
  })

  it('marks the empty tab a page opens with its opener and closes it at once; an empty tab the shell opens for a link waits until it is left', () => {
    const { win, self } = browserOf()
    const opener = win.open('https://site.example/')
    const openerTab = { id: opener, spaceId: win.spaceOf(opener) }
    methods['openTabFromPage']!.call(self, openerTab, 'about:blank', 'background', true)
    expect(traces().find((line) => line.startsWith('[blank-tab] closing scheduled:'))).toMatch(new RegExp(`opened by tab ${opener}$`))
    vi.runAllTimers()
    expect(traces().filter((line) => line.startsWith('[blank-tab] closed:'))).toHaveLength(1)
    methods['openTabFromPage']!.call(self, openerTab, 'about:blank', 'background', false)
    vi.runAllTimers()
    expect(traces().filter((line) => line.startsWith('[blank-tab] closed:'))).toHaveLength(1)
  })
})
