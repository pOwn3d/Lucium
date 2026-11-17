// The zoom of a split view reaches the pane that has the keyboard, not always the same one (case of the split view « Zoom | Notes du
// présentateur »: the web app of Zoom beside the notes window Google Slides writes, an about:blank page). The real methods of the
// Browser run on a stand-in for the window over the real reducer; the pages are stand-ins that say whether they have the keyboard and note their zoom. The
// rules they apply are tested on their own (shared/split.test.ts `commandPane`, shared/site-zoom.test.ts).

import { describe, expect, it, vi } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import type { PageEvents } from '../engine/types'
import { fakeBrowser } from './browser-fake.test-support'

// browser.ts reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const ZOOM_APP = 'https://app.zoom.us/wc/123/start'

/** A page of the engine: whether it has the keyboard (`keyboard`), and every factor it was given. */
function pageOf(id: string, keyboard: { in: string | null }) {
  return {
    id,
    hasFocus: vi.fn(() => keyboard.in === id),
    viewerZoom: vi.fn(async () => false),
    setZoom: vi.fn(),
    applyCss: vi.fn(),
    runScript: vi.fn(),
    focus: vi.fn()
  }
}

/** A window with the split view « Zoom | Notes du présentateur » on screen, Zoom selected, and a third tab behind; `keyboard.in` is the page that has the keyboard. */
function splitWindow() {
  const ctx = { now: 1, newId: (() => { let next = 0; return () => `id${++next}` })() }
  let state = createInitialState(ctx)
  const run = (action: Action) => {
    ctx.now += 1
    state = reduce(state, action, ctx)
  }
  const open = (url: string): string => {
    run({ type: 'tab/open', url })
    return activeTab(state)!.id
  }
  const behind = open('https://example.org/')
  const zoom = open(ZOOM_APP)
  const notes = open('about:blank')
  run({ type: 'split/create', tabId: zoom, withTabId: notes })
  run({ type: 'tab/select', id: zoom })
  const keyboard: { in: string | null } = { in: zoom }
  const pages = new Map([zoom, notes, behind].map((id) => [id, pageOf(id, keyboard)]))
  const dispatched: Action[] = []
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    store: { get: () => state },
    dispatch: (action: Action) => {
      dispatched.push(action)
      run(action)
    },
    pages,
    volatileZoom: new Map<string, number>(),
    // What the new document of a page also gets (domReady): left out here, only the zoom is looked at.
    blankTabs: { closeOpenedBy: () => undefined },
    blockerCss: { fresh: () => undefined, apply: () => undefined },
    appliedTheme: new Map(),
    appliedDark: new Map(),
    guardPage: () => undefined
  })
  ;(self as unknown as { group: Set<object> }).group = new Set([self])
  const call = (name: string, ...args: unknown[]) => methods[name]!.call(self, ...args)
  /** ⌘+ (1), ⌘− (-1), ⌘0 (0) as the menu sends them; the zoom is applied once the page has said it is no viewer. */
  const press = async (step: -1 | 0 | 1) => {
    call('zoom', step)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const eventsOf = (id: string) => call('pageEvents', state.tabs.find((t) => t.id === id)) as PageEvents
  /** A click on a tab of the sidebar. */
  const select = (id: string) => run({ type: 'tab/select', id })
  return { zoom, notes, behind, keyboard, pages, dispatched, press, call, eventsOf, select, state: () => state, selected: () => activeTab(state)?.id }
}

describe('the zoom in a split view', () => {
  // Guard: the zoom follows the keyboard (`followPaneFocus` at the head of `zoom`); without it, ⌘+ zoomed Zoom while the notes had the keyboard.
  it('zooms the pane that has the keyboard, and that pane becomes the selected one (a click in a frame of another site told the shell nothing)', async () => {
    const w = splitWindow()
    w.keyboard.in = w.notes
    await w.press(1)
    expect(w.selected()).toBe(w.notes)
    expect(w.pages.get(w.notes)!.setZoom).toHaveBeenLastCalledWith(1.1)
    expect(w.pages.get(w.zoom)!.setZoom).not.toHaveBeenCalled()
    expect(w.state().settings.siteZoom).toEqual({})
  })

  it('zooms the other pane in its turn, its site this time (⌘+ in Zoom after the notes)', async () => {
    const w = splitWindow()
    w.keyboard.in = w.notes
    await w.press(1)
    w.keyboard.in = w.zoom
    await w.press(1)
    expect(w.selected()).toBe(w.zoom)
    expect(w.state().settings.siteZoom).toEqual({ 'app.zoom.us': 1.1 })
    expect(w.pages.get(w.zoom)!.setZoom).toHaveBeenLastCalledWith(1.1)
    // The notes keep their own zoom: the site of the other pane is not theirs.
    expect(w.pages.get(w.notes)!.setZoom).toHaveBeenCalledTimes(1)
  })

  it('zooms the selected pane when no page has the keyboard (the button of the zoom mark, the sidebar, the menu bar after a click there)', async () => {
    const w = splitWindow()
    w.keyboard.in = null
    await w.press(1)
    expect(w.selected()).toBe(w.zoom)
    expect(w.dispatched.some((a) => a.type === 'tab/select')).toBe(false)
    expect(w.state().settings.siteZoom).toEqual({ 'app.zoom.us': 1.1 })
    expect(w.pages.get(w.notes)!.setZoom).not.toHaveBeenCalled()
  })

  it('asks no page for the keyboard outside a split view', async () => {
    const w = splitWindow()
    w.select(w.behind)
    w.keyboard.in = w.notes
    await w.press(1)
    expect(w.selected()).toBe(w.behind)
    for (const page of w.pages.values()) expect(page.hasFocus).not.toHaveBeenCalled()
    expect(w.state().settings.siteZoom).toEqual({ 'example.org': 1.1 })
  })
})

describe('the zoom of a page that has no host (the notes, an about:blank page written by Google Slides)', () => {
  it('is applied to the page, step after step, and ⌘0 puts it back to 100 %', async () => {
    const w = splitWindow()
    w.keyboard.in = w.notes
    const notes = w.pages.get(w.notes)!
    await w.press(1)
    await w.press(1)
    expect(notes.setZoom).toHaveBeenLastCalledWith(1.25)
    await w.press(-1)
    expect(notes.setZoom).toHaveBeenLastCalledWith(1.1)
    await w.press(0)
    expect(notes.setZoom).toHaveBeenLastCalledWith(1)
    expect(w.state().settings.siteZoom).toEqual({})
  })

  // Guard: a new document of the page (a reload, the opener writing it again) does not forget the tab's zoom; the domReady handler used to.
  it('is kept by a new document of the page, for as long as the tab’s page lives', async () => {
    const w = splitWindow()
    w.keyboard.in = w.notes
    await w.press(1)
    await w.press(1)
    const notes = w.pages.get(w.notes)!
    notes.setZoom.mockClear()
    w.eventsOf(w.notes).domReady()
    expect(notes.setZoom).toHaveBeenCalledWith(1.25)
    // Once the page goes (closed, put to sleep, taken by another window that carries the factor), this window forgets it.
    const volatileZoom = new Map([['gone', 1.25], ['stays', 1.1]])
    methods['dropPageState']!.call(fakeBrowser({ volatileZoom, store: { get: () => ({ tabs: [] }) }, runtime: { tabs: {} } }).self, 'gone')
    expect([...volatileZoom]).toEqual([['stays', 1.1]])
  })
})

describe('the focus of a split view', () => {
  // Guard: a click or a key in the other pane selects it (`paneTakesFocus`).
  it('moves to the pane the user pressed in', () => {
    const w = splitWindow()
    w.eventsOf(w.notes).focused()
    expect(w.selected()).toBe(w.notes)
    w.eventsOf(w.zoom).focused()
    expect(w.selected()).toBe(w.zoom)
  })

  it('leaves the selection alone for the selected pane and for a page that is not in the split view', () => {
    const w = splitWindow()
    w.eventsOf(w.zoom).focused()
    w.eventsOf(w.behind).focused()
    expect(w.selected()).toBe(w.zoom)
    expect(w.dispatched).toEqual([])
  })

  describe('is asked of the engine by the commands of the page that act on the pane on screen', () => {
    /**
     * A window whose `followPaneFocus`, `activePage` and the selected tab are read by the method under test, in order: the method is the real one, the rest of the
     * window answers nothing (browser-fake.test-support.ts). `reads` says what the method looked at, and `followed` whether it followed the keyboard first.
     */
    function run(name: string, args: unknown[]) {
      const order: string[] = []
      const base = createInitialState({ now: 1, newId: () => 'id' })
      // The selected tab of the window is read through the state of its space: `activeTab` goes by these two members.
      const state = new Proxy({ ...base, settings: { ...base.settings, pdfWithSource: true, pageWatch: true } }, {
        get: (target, member, receiver) => {
          if (member === 'activeTabBySpace') order.push('selected tab')
          return Reflect.get(target, member, receiver) as unknown
        }
      })
      const page = fakeBrowser({ openDevTools: async () => ({ ok: true }) }).self
      const fake = fakeBrowser({ store: { get: () => state, dispatch: () => undefined, subscribe: () => () => undefined }, followPaneFocus: () => void order.push('follow'), activePage: () => (order.push('page'), page), isPrivate: () => false })
      const outcome = (): Promise<unknown> => Promise.resolve().then(() => methods[name]!.call(fake.self, ...args))
      return outcome().then(
        () => order,
        () => order
      )
    }

    it.each([
      ['nav', ['reload']],
      ['hardReload', []],
      ['clearCacheAndReload', []],
      ['printPage', []],
      ['activePageTitle', []],
      ['zoom', [1]],
      ['toggleReader', []],
      ['devTools', ['toggle']],
      ['copyUrl', ['plain']],
      ['exportMarkdown', []],
      ['openSummaryTab', ['normal']],
      ['watchPage', [false]],
      ['savePdfWithSource', []],
      ['floatMainVideo', []]
    ] as Array<[string, unknown[]]>)('%s follows the keyboard before it reads the selected tab or its page', async (name, args) => {
      const order = await run(name, args)
      expect(order, `${name} did not follow the pane the user is in`).toContain('follow')
      const firstRead = order.findIndex((what) => what !== 'follow')
      if (firstRead !== -1) expect(order.indexOf('follow'), `${name} reads ${order[firstRead]} before following the focus`).toBeLessThan(firstRead)
    })

    it('has the captures of the menu follow it too, and the thumbnails of the hover cards (called on their own timer) select nothing', async () => {
      const { captureActivePage, captureActivePagePortrait } = await import('./capture')
      for (const take of [(browser: unknown) => captureActivePage(browser as never, true), (browser: unknown) => captureActivePagePortrait(browser as never)]) {
        const order: string[] = []
        await take({ followPaneFocus: () => void order.push('follow'), capture: async () => (order.push('capture'), null) })
        expect(order).toEqual(['follow', 'capture'])
      }
      const followed = vi.fn()
      const taken = vi.fn(async () => Buffer.from('png'))
      const fake = fakeBrowser({ followPaneFocus: followed, activePage: () => ({ capture: taken }) })
      expect(await methods['capture']!.call(fake.self, false)).toEqual(Buffer.from('png'))
      expect(followed).not.toHaveBeenCalled()
    })

    it('has the find bar take the keyboard: the pane is chosen before the bar opens', () => {
      const order: string[] = []
      const fake = fakeBrowser({ followPaneFocus: () => void order.push('follow'), overlayRequest: null, store: { get: () => createInitialState({ now: 1, newId: () => 'id' }) }, isPrivate: () => false })
      methods['openOverlay']!.call(fake.self, { panel: 'find' })
      expect(order).toEqual(['follow'])
      // Another panel does not ask which pane the user is in.
      const other = fakeBrowser({ followPaneFocus: () => void order.push('other follow'), overlayRequest: null, store: { get: () => createInitialState({ now: 1, newId: () => 'id' }) }, isPrivate: () => false })
      methods['openOverlay']!.call(other.self, { panel: 'settings' })
      expect(order).toEqual(['follow'])
    })
  })
})

