import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PEEK_HEADER_HEIGHT } from '@shared/ipc'
import type { SidebarState, SplitView } from '@shared/model'
import { PEEK_BORDER, PEEK_PAGE_RADIUS, peekPageRect } from '@shared/peek'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { splitBarRect } from '@shared/split'
import { t } from '@shared/i18n'
import type { PageEvents } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The rules themselves are tested without a window (split.test.ts, split-bar.test.ts, peek.test.ts, little.test.ts, command-bar.test.ts, shell/little.test.ts,
// renderer/split-bar.test.ts). The shell's methods run here on stand-ins (browser-fake.test-support.ts): the shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const app = readFileSync(new URL('../../renderer/App.tsx', import.meta.url), 'utf8')
const littleUi = readFileSync(new URL('../../renderer/littlearc.tsx', import.meta.url), 'utf8')
const commandBar = readFileSync(new URL('../../renderer/CommandBar.tsx', import.meta.url), 'utf8')
const peekUi = readFileSync(new URL('../../renderer/Panels.tsx', import.meta.url), 'utf8')

const STAGE = { x: 300, y: 40, width: 1000, height: 700 }
const identity = <T,>(rect: T): T => rect
let n = 0
const ctx = { now: 0, newId: () => `id${++n}` }
const base = createInitialState(ctx)
const spaceId = base.activeSpaceId
const tab = (id: string) => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0 })
const split: SplitView = { id: 'sp', spaceId, tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }
const splitState: SidebarState = { ...base, tabs: [tab('a'), tab('b')], splits: [split], activeTabBySpace: { [spaceId]: 'a' } }

/** A window laid out at zoom 1 (CSS pixels are points), with the state given and pages that keep where they were shown. */
function laidOut(state: SidebarState, own: Record<string, unknown> = {}) {
  const shown = new Map<string, unknown[]>()
  const page = (id: string) => ({ show: (...args: unknown[]) => void shown.set(id, args), raise: () => {}, hide: () => {} })
  const fake = fakeBrowser({
    store: { get: () => state },
    k: () => 1,
    toCss: identity,
    fromCss: identity,
    frame: () => ({ stage: STAGE, panel: null }),
    fullscreenTab: null,
    pages: new Map(state.tabs.map((t) => [t.id, page(t.id)])),
    sidePanel: null,
    webPanel: null,
    floatVisible: false,
    overlayRequest: null,
    peek: null,
    ...own
  })
  return { fake, shown, page }
}

describe('the layout bar of a split view of two: the shell and the interface lay the panes out in the same room', () => {
  it('has the shell take the strip of the bar off the stage where it places the pages, and where it works out which pane a capture is of', () => {
    const t = laidOut(splitState)
    shell['layout']!.call(t.fake.self)
    const strip = splitBarRect(STAGE, split)!
    expect(strip).not.toBeNull()
    const panes = shell['splitPanes']!.call(t.fake.self, STAGE, split) as Array<{ x: number; y: number; width: number; height: number }>
    expect(panes).toHaveLength(2)
    for (const pane of panes) expect(pane.y + pane.height).toBeLessThanOrEqual(strip.y)
    for (const [i, id] of split.tabIds.entries()) {
      const [rect] = t.shown.get(id) as [{ x: number; y: number; width: number; height: number }]
      // The page is inside its pane (less the ring of the focused one), and no page goes under the bar.
      expect(rect.x).toBeGreaterThanOrEqual(STAGE.x + panes[i]!.x)
      expect(rect.x + rect.width).toBeLessThanOrEqual(STAGE.x + panes[i]!.x + panes[i]!.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(STAGE.y + strip.y)
    }
  })

  it('tells the interface which split views are linked, only while the setting is on', () => {
    const synced = (scrollSync: boolean, ids: string[]) =>
      shell['scrollSyncedOfSnapshot']!.call({ syncedSplits: new Set(ids) }, { ...splitState, settings: { ...splitState.settings, scrollSync } })
    expect(synced(true, ['sp'])).toEqual({ scrollSyncedSplits: ['sp'] })
    expect(synced(false, ['sp'])).toEqual({})
    expect(synced(true, [])).toEqual({})
    // A split view that is gone is not named.
    expect(synced(true, ['gone'])).toEqual({})
  })
})

describe('"Volet fermé" and its "Annuler"', () => {
  it('has the shell tell the closing of a pane, from the state before and the state after the action, with the action that puts it back', () => {
    let state = splitState
    const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
    const own: Record<string, unknown> = {
      // One window: the store is its own root (main/store.ts).
      store: { get: () => state, dispatch: (action: Action) => void (state = reduce(state, action, ctx)), root() { return this } },
      pages: new Map(),
      showToast: (message: string, action?: { label: string; run: () => void }) => void toasts.push({ message, ...(action ? { action } : {}) })
    }
    const fake = fakeBrowser(own)
    own['dispatch'] = (action: Action) => shell['dispatch']!.call(fake.self, action)
    shell['dispatch']!.call(fake.self, { type: 'split/remove', tabId: 'b' })
    expect(state.splits).toEqual([])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toBe(t('split-bar.volet-title-ferme', { title: 'b' }))
    expect(toasts[0]!.action?.label).toBe(t('menu.annuler'))
    toasts[0]!.action!.run()
    expect(state.splits.map((s) => s.tabIds)).toEqual([['a', 'b']])
  })
})

describe('Glance: its header and its controls', () => {
  function previewing() {
    let events: PageEvents | null = null
    const calls: string[] = []
    const page = { id: 'peek-1', loadURL: () => {}, showsError: () => false, stop: () => void calls.push('stop'), goBack: () => void calls.push('back'), goForward: () => void calls.push('forward'), reload: () => void calls.push('reload') }
    const own: Record<string, unknown> = {
      blockerCss: { fresh: () => {}, apply: () => {}, forget: () => {} },
      peek: null,
      peekCounter: 0,
      options: {},
      store: { get: () => base },
      pageId: (id: string) => id,
      containerKeyOf: () => '',
      engine: { createPage: (_options: unknown, given: PageEvents) => ((events = given), page) }
    }
    const fake = fakeBrowser(own)
    shell['openPeek']!.call(fake.self, 'https://news.test/x')
    return { fake, own, page, calls, events: () => events! }
  }

  it('places the previewed page inside the edge of the card and under the 40 px header, rounded like the edge inside', () => {
    const rect = { x: 200, y: 60, width: 800, height: 600 }
    const peekPage = { show: vi.fn(), raise: vi.fn() }
    const t = laidOut(base, { peek: { page: peekPage, url: 'https://news.test/x' }, overlayRequest: { panel: 'peek', rect, stage: STAGE }, peekRect: () => rect, overlayBounds: () => STAGE })
    shell['layout']!.call(t.fake.self)
    expect(peekPage.show).toHaveBeenCalledWith(peekPageRect(rect, PEEK_HEADER_HEIGHT, PEEK_BORDER), PEEK_PAGE_RADIUS)
    const [shown] = peekPage.show.mock.calls[0] as [{ y: number }]
    expect(shown.y).toBeGreaterThanOrEqual(rect.y + PEEK_HEADER_HEIGHT)
    // Above the dimmed backdrop of the overlay.
    expect(peekPage.raise).toHaveBeenCalled()
  })

  it('stops the previewed page when "Arrêter" is pressed, and follows its loading and its icon for the header', () => {
    const p = previewing()
    for (const action of ['stop', 'back', 'forward', 'reload']) shell['peekAction']!.call(p.fake.self, action)
    expect(p.calls).toEqual(['stop', 'back', 'forward', 'reload'])
    expect(p.own['peek']).toMatchObject({ loading: true })
    p.events().update({ loading: false, faviconUrl: 'https://news.test/icon.png' })
    expect(p.own['peek']).toMatchObject({ loading: false, faviconUrl: 'https://news.test/icon.png' })
    // A patch that does not say keeps what was known.
    p.events().update({ title: 'Les nouvelles' })
    expect(p.own['peek']).toMatchObject({ loading: false, faviconUrl: 'https://news.test/icon.png', title: 'Les nouvelles' })
  })

  it('opens the page in a tab with ⌘↩, in the header and in the previewed page', () => {
    const p = previewing()
    const key = { key: 'Enter', meta: true, shift: false, alt: false, control: false }
    expect(p.events().shortcut!(key as never)).toBe(true)
    expect(p.fake.calls.filter((call) => call.name === 'peekAction').map((call) => call.args)).toEqual([['open-in-tab']])
    expect(p.events().shortcut!({ ...key, shift: true } as never)).toBe(false)
    // Another preview took its place: the key is not this one's any more.
    p.own['peek'] = { page: {} }
    expect(p.events().shortcut!(key as never)).toBe(false)
  })
})

// Contract: the interface is a React tree drawn and driven in a real window (no DOM runs in the unit tests); these lines are where it draws the bar and
// the dividers in the room the shell gave the pages, where the header of the Glance follows the page and takes ⌘↩, and where the mini window and its bar
// send what the user chose. What they call is tested in its own module.
describe('the interface of the windows, as it is drawn', () => {
  it('has the interface draw the dividers and the bar in that same room, and the bar in the strip', () => {
    expect(app).toMatch(/const room = splitPaneStage\(size, split\)\n\s+const panes = splitLayout\(room, split, undefined, TOOLBAR_BAR_HEIGHT\)/)
    expect(app).toMatch(/const strip = splitBarRect\(size, split\)/)
    expect(app).toMatch(/\{strip && <SplitBar split=\{split\} scrollSync=\{scrollSync\} synced=\{synced\} style=\{/)
    // A drag is measured on what the panes share, not on the stage: the bar's strip is not theirs.
    expect(app).toMatch(/const available = \(horizontal \? room\.width : room\.height\)/)
  })

  it('shows the badge of linked scrolling only while the setting is on', () => {
    expect(app).toMatch(/const linked = scrollSync && synced/)
    expect(app).toMatch(/synced=\{snapshot\.scrollSyncedSplits\?\.includes\(activeSplit\.id\) === true\}/)
  })

  it('gives every divider the keyboard, a double-click that shares equally, and the words a screen reader reads', () => {
    expect(app).toMatch(/role="separator"\n\s+tabIndex=\{0\}/)
    expect(app).toMatch(/onDoubleClick=\{\(\) => void api\(\)\.dispatch\(\{ type: 'split\/ratios', id: split\.id, ratios: balancePair\(split\.ratios, i\) \}\)\}/)
    expect(app).toMatch(/dividerKeyRatios\(split\.ratios, i, e\.key, split\.orientation, e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\)/)
  })

  it('has the header of the Glance offer "Arrêter" while the page loads, and take ⌘↩', () => {
    expect(peekUi).toMatch(/const stopOrReload = loading \? 'stop' : 'reload'/)
    expect(peekUi).toMatch(/isPeekOpenKey\(\{ key: e\.key, meta: e\.metaKey/)
  })

  it('draws the header of the mini window, the banner of the archiving delay and the pin, and sends the pin and the link to the window', () => {
    expect(littleUi).toMatch(/style=\{\{ height: LITTLE_STRIP_HEIGHT \}\} role="status"/)
    expect(littleUi).toMatch(/act\.littleAction\(id, kept \? 'keep:off' : 'keep:on'\)/)
    expect(littleUi).toMatch(/act\.littleAction\(id, 'archive-delay'\)/)
    expect(littleUi).toMatch(/littleStripText\(littleStrip\(kept, archiveHours\)\)/)
  })

  it('has the bar of the first state of the mini window say the space the page will go to, group its rows, and send an open tab to the window', () => {
    expect(commandBar).toMatch(/t\('littlearc\.titre-avec-espace', \{ space: `\$\{targetSpace\.emoji\} \$\{targetSpace\.name\}`\.trim\(\) \}\)/)
    expect(commandBar).toMatch(/littleGroupStarts\(candidates\)/)
    expect(commandBar).toMatch(/if \(little\) return act\.littleAction\(little\.id, gotoTabCommand\(c\.tabId\)\)/)
  })
})
