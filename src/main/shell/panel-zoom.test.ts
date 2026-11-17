import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings } from '@shared/model'
import type { OverlayRequest } from '@shared/ipc'
import { PANEL_NEED, screenOf, withPanelSize, type PanelSizes, type ScreenInfo } from '@shared/panel-scale'
import { createInitialState } from '@shared/sidebar'
import { setLockService } from '../lock-service'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { frenchSpaces } from '@shared/french-typography'

// The zoom of the layer of panels: the zoom of the interface times the factor of the panels while a sheet in the middle of the window is open, the zoom of the
// interface alone for everything else. The methods of the class Browser run here on a stand-in (browser-fake.test-support.ts); the screen is the one
// `world` says (the window is on it), and Electron's `screen` is a stand-in too.

const world = vi.hoisted(() => ({ display: { label: 'LG UltraWide', internal: false, scaleFactor: 1, size: { width: 3440, height: 1440 } } as { label: string; internal: boolean; scaleFactor: number; size: { width: number; height: number } } }))
vi.mock('electron', () => new Proxy({ screen: { getDisplayMatching: () => world.display } }, { get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : {}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const ULTRAWIDE: ScreenInfo = screenOf({ label: 'LG UltraWide', internal: false, scaleFactor: 1, size: { width: 3440, height: 1440 } })!
const LAPTOP_DISPLAY = { label: 'Built-in Retina Display', internal: true, scaleFactor: 2, size: { width: 1512, height: 982 } }

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  world.display = { label: 'LG UltraWide', internal: false, scaleFactor: 1, size: { width: 3440, height: 1440 } }
})

interface Surface {
  zoom: number
  calls: number[]
  reads: number
  wc: { isDestroyed: () => boolean; getZoomFactor: () => number; setZoomFactor: (factor: number) => void }
}
const surface = (zoom = 1): Surface => {
  const made: Surface = {
    zoom,
    calls: [],
    reads: 0,
    wc: { isDestroyed: () => false, getZoomFactor: () => (made.reads++, made.zoom), setZoomFactor: (factor: number) => void (made.calls.push(factor), (made.zoom = factor)) }
  }
  return made
}

/** A window of 1360 × 860 (or `content`) with the interface at `k`, on the screen of `world`, showing `request`, with these choices. */
function window(request: OverlayRequest | null, options: { k?: number; sizes?: PanelSizes; content?: { width: number; height: number } } = {}) {
  const main = surface()
  const layer = surface()
  const own: Record<string, unknown> = {
    k: () => options.k ?? 1,
    overlayRequest: request,
    store: { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), panelSizes: options.sizes ?? {} } }) },
    win: { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 100, width: 1360, height: 860 }), getContentBounds: () => ({ x: 0, y: 0, ...(options.content ?? { width: 1360, height: 860 }) }), webContents: main.wc },
    overlay: { webContents: layer.wc },
    floating: { current: () => null },
    uiZoom: null,
    layerZoom: null
  }
  const fake = fakeBrowser(own)
  own['panelK'] = () => shell['panelK']!.call(fake.self)
  own['overlayZoom'] = () => shell['overlayZoom']!.call(fake.self)
  return { fake, main, layer, zoom: () => shell['overlayZoom']!.call(fake.self) as number, panel: () => shell['panelK']!.call(fake.self) as number, sync: () => shell['syncUiZoom']!.call(fake.self) }
}

describe('the factor of the panels of a window', () => {
  it('is the choice of the screen the window is on: Automatique on the ultra-wide (125 %), 100 % on the reference laptop, what was chosen where there is a choice', () => {
    expect(window(null).panel()).toBe(1.25)
    world.display = LAPTOP_DISPLAY
    expect(window(null).panel()).toBe(1)
    world.display = { label: 'LG UltraWide', internal: false, scaleFactor: 1, size: { width: 3440, height: 1440 } }
    expect(window(null, { sizes: withPanelSize({}, ULTRAWIDE, 90, 1) }).panel()).toBe(0.9)
  })

  it('is brought back to what the window holds: a window of 810 × 700 cannot hold 125 %', () => {
    expect(window(null, { content: { width: 810, height: 700 } }).panel()).toBe(1.15)
    expect(window(null, { content: { width: PANEL_NEED.width, height: PANEL_NEED.height } }).panel()).toBe(1)
  })

  it('goes on top of the zoom of the interface, and the room it needs grows with it', () => {
    expect(window(null, { k: 1.3 }).panel()).toBe(1.25)
    // The height decides: 860 / (1.5 × 520) = 1.10 at an interface of 150 %, and under 1 at 175 %, where the panels keep 100 % of what they are there.
    expect(window(null, { k: 1.5 }).panel()).toBe(1.1)
    expect(window(null, { k: 1.75 }).panel()).toBe(1)
  })

  it('is 1 when the screen of the window cannot be told', () => {
    world.display = { label: '', internal: false, scaleFactor: 1, size: { width: 0, height: 0 } }
    expect(window(null).panel()).toBe(1)
  })
})

describe('the zoom of the layer of panels', () => {
  it('is the zoom of the interface times the factor of the panels for a sheet in the middle of the window: Notes, Traduire, a confirmation', () => {
    for (const request of [{ panel: 'notes' }, { panel: 'translate' }, { panel: 'leave', request: {} }, { panel: 'whatsnew', sheet: {} }] as OverlayRequest[]) {
      expect(window(request).zoom(), request.panel).toBe(1.25)
    }
    expect(window({ panel: 'notes' }, { k: 1.2 }).zoom()).toBe(1.5)
    expect(window({ panel: 'notes' }, { sizes: withPanelSize({}, ULTRAWIDE, 80, 1) }).zoom()).toBe(0.8)
  })

  it('is the zoom of the interface alone for what hangs from the sidebar or the toolbar, or that the main process places: the places it works out are in those CSS pixels', () => {
    const anchor = { x: 10, y: 20, width: 100, height: 30 }
    const placed: OverlayRequest[] = [
      { panel: 'plus', anchor },
      { panel: 'spacemenu', spaceId: 's', anchor },
      { panel: 'tab', tabId: 't', anchor },
      { panel: 'site' },
      { panel: 'find' },
      { panel: 'theme', spaceId: 's' },
      { panel: 'commandbar', mode: 'new', initial: '' },
      { panel: 'tabcycle', cards: [], index: 0 }
    ]
    for (const request of placed) {
      expect(window(request).zoom(), request.panel).toBe(1)
      expect(window(request, { k: 1.4 }).zoom(), request.panel).toBe(1.4)
    }
  })

  it('is the zoom of the interface when no panel is open', () => {
    expect(window(null).zoom()).toBe(1)
    expect(window(null, { k: 1.2 }).zoom()).toBe(1.2)
  })

  it('is given to the layer alone: the window and the floating sidebar keep the zoom of the interface', () => {
    const w = window({ panel: 'notes' }, { k: 1.2 })
    w.sync()
    expect(w.layer.zoom).toBe(1.5)
    expect(w.main.zoom).toBe(1.2)
  })

  it('is put back to the zoom of the interface when the next panel is one that is placed, and not touched when nothing changed', () => {
    const w = window({ panel: 'notes' })
    w.sync()
    expect(w.layer.calls).toEqual([1.25])
    // Laid out again with the same panel: the cache holds, nothing is set.
    w.sync()
    expect(w.layer.calls).toEqual([1.25])
    ;(w.fake.self as Record<string, unknown>)['overlayRequest'] = { panel: 'plus', anchor: { x: 1, y: 2, width: 3, height: 4 } }
    w.sync()
    expect(w.layer.calls).toEqual([1.25, 1])
    expect(w.main.calls).toEqual([])
  })

  it('is looked at once, not at every layout: a layout with nothing changed reads no zoom, and a forced one (the page has loaded) reads them all', () => {
    const w = window({ panel: 'notes' })
    w.sync()
    const reads = w.layer.reads
    w.sync()
    w.sync()
    expect(w.layer.reads).toBe(reads)
    shell['syncUiZoom']!.call(w.fake.self, true)
    expect(w.layer.reads).toBe(reads + 1)
  })

  it('follows a change of the choice while the panel is open, and a window moved to another screen', () => {
    const w = window({ panel: 'notes' })
    w.sync()
    expect(w.layer.zoom).toBe(1.25)
    ;(w.fake.self as Record<string, unknown>)['store'] = { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), panelSizes: withPanelSize({}, ULTRAWIDE, 150, 1) } }) }
    w.sync()
    expect(w.layer.zoom).toBe(1.5)
    world.display = LAPTOP_DISPLAY
    w.sync()
    // The choice was made for the ultra-wide: the laptop has none, and Automatique gives it 100 %.
    expect(w.layer.zoom).toBe(1)
  })

  it('leaves a surface that is gone alone, and a window that is closed', () => {
    const w = window({ panel: 'notes' })
    w.layer.wc.isDestroyed = () => true
    expect(() => w.sync()).not.toThrow()
    expect(w.layer.calls).toEqual([])
    ;(w.fake.self as { win: { isDestroyed: () => boolean } }).win.isDestroyed = () => true
    expect(() => w.sync()).not.toThrow()
  })
})

describe('opening a panel', () => {
  it('has the zoom of the layer read again at every opening: another window may have changed it under this one (they share the page)', async () => {
    const { overlayHost } = await import('./browser-fake.test-support')
    const host = overlayHost({}, { layerZoom: 1.25, uiZoom: 1, layout: () => undefined, publishQueue: { flush: () => undefined }, sendMissedSnapshot: () => undefined })
    shell['openOverlay']!.call(host.self, { panel: 'notes' })
    expect((host.self as Record<string, unknown>)['layerZoom']).toBeNull()
  })
})

describe('the notice about the size of the panels, in a window', () => {
  /** A normal window whose screen is `display`, with what `watchScreen` needs, and the calls it makes. */
  function noticing(options: { priv?: boolean; request?: OverlayRequest | null } = {}) {
    const dispatched: unknown[] = []
    const toasts: Array<{ message: string; label: string | undefined; run: (() => void) | undefined }> = []
    const opened: unknown[] = []
    const handlers = new Map<string, () => void>()
    const own: Record<string, unknown> = {
      isPrivate: () => options.priv === true,
      overlayRequest: options.request ?? null,
      store: { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), panelSizes: {} } }) },
      win: {
        isVisible: () => true,
        isMinimized: () => false,
        isDestroyed: () => false,
        getBounds: () => ({ x: 100, y: 100, width: 1360, height: 860 }),
        on: (event: string, handler: () => void) => void handlers.set(event, handler),
        once: (event: string, handler: () => void) => void handlers.set(`once:${event}`, handler)
      },
      dispatch: (action: unknown) => void dispatched.push(action),
      showToast: (message: string, action?: { label: string; run: () => void }) => void toasts.push({ message, label: action?.label, run: action?.run }),
      openOverlay: (request: unknown) => void opened.push(request),
      layout: () => undefined
    }
    const fake = fakeBrowser(own)
    shell['watchScreen']!.call(fake.self)
    return { own, fake, handlers, dispatched, toasts, opened, look: () => (own['screenWatch'] as { look(): string | null } | null)?.look() ?? null }
  }

  it('is offered on the ultra-wide: « Les panneaux vous semblent trop petits ? » with « Régler… », remembered for the screen first', () => {
    const t = noticing()
    expect(t.look()).toBe('wide')
    expect(t.dispatched).toEqual([{ type: 'panel-size/noticed', screen: ULTRAWIDE }])
    expect(t.toasts).toHaveLength(1)
    expect(t.toasts[0]!.message).toBe(frenchSpaces('Les panneaux vous semblent trop petits ?'))
    expect(t.toasts[0]!.label).toBe('Régler…')
  })

  it('has « Régler… » open the guided setting: Settings, Apparence, at the group of the size of the panels', () => {
    const t = noticing()
    t.look()
    t.toasts[0]!.run!()
    expect(t.opened).toEqual([{ panel: 'settings', pane: 'appearance', anchor: 'panelsize' }])
  })

  it('says « trop grands » on a very small screen', () => {
    world.display = { label: '', internal: true, scaleFactor: 2, size: { width: 1280, height: 800 } }
    const t = noticing()
    expect(t.look()).toBe('small')
    expect(t.toasts[0]!.message).toBe(frenchSpaces('Les panneaux vous semblent trop grands ?'))
  })

  it('says nothing on an ordinary screen', () => {
    world.display = LAPTOP_DISPLAY
    const t = noticing()
    expect(t.look()).toBeNull()
    expect(t.toasts).toEqual([])
    expect(t.dispatched).toEqual([])
  })

  it('waits while the application is locked, and comes at the next look once it is not', () => {
    setLockService({ isAppLocked: () => true } as never)
    try {
      const t = noticing()
      expect(t.look()).toBeNull()
      expect(t.toasts).toEqual([])
      expect(t.dispatched).toEqual([])
    } finally {
      setLockService(null)
    }
    expect(noticing().look()).toBe('wide')
  })

  it('waits while a panel is open over the window, so as not to come in the way of what is being done', () => {
    const t = noticing({ request: { panel: 'notes' } })
    expect(t.look()).toBeNull()
    expect(t.toasts).toEqual([])
    expect(t.dispatched).toEqual([])
  })

  it('is not offered in a private window (its settings are not kept: once would be every time), nor looked at', () => {
    const t = noticing({ priv: true })
    expect(t.own['screenWatch']).toBeUndefined()
    expect(t.handlers.has('focus')).toBe(false)
    expect(t.handlers.has('once:show')).toBe(false)
  })

  it('is looked at when the window is shown, takes the focus and moves; the panel that is open follows the window to another screen', () => {
    const t = noticing()
    expect([...t.handlers.keys()].sort()).toEqual(['focus', 'move', 'once:show'])
  })

  it('is not offered in the engine test (--smoke): a notice must not come in the way of what it checks', () => {
    process.argv.push('--smoke')
    try {
      const t = noticing()
      expect(t.own['screenWatch']).toBeUndefined()
      expect(t.handlers.has('focus')).toBe(false)
      // The panel that is open still follows the window to another screen.
      expect(t.handlers.has('move')).toBe(true)
    } finally {
      process.argv.pop()
    }
  })

  it('lays the panel that is open out again once a move has rested, and only then: a window being dragged is looked at where the drag ends', () => {
    vi.useFakeTimers()
    try {
      const t = noticing({ request: { panel: 'notes' } })
      const layouts: number[] = []
      t.own['layout'] = () => void layouts.push(1)
      t.handlers.get('move')!()
      t.handlers.get('move')!()
      t.handlers.get('move')!()
      expect(layouts).toEqual([])
      vi.advanceTimersByTime(1000)
      expect(layouts).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lay out a panel that keeps the zoom of the interface when the window moves: nothing to put right', () => {
    vi.useFakeTimers()
    try {
      const t = noticing({ request: { panel: 'plus', anchor: { x: 1, y: 2, width: 3, height: 4 } } })
      const layouts: number[] = []
      t.own['layout'] = () => void layouts.push(1)
      t.handlers.get('move')!()
      vi.advanceTimersByTime(1000)
      expect(layouts).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('is let go of when the window is closed: no move left waiting, no look left waiting', () => {
    vi.useFakeTimers()
    try {
      const t = noticing({ request: { panel: 'notes' } })
      const layouts: number[] = []
      t.own['layout'] = () => void layouts.push(1)
      t.handlers.get('move')!()
      t.handlers.get('focus')!()
      shell['stopWatchingScreen']!.call(t.fake.self)
      vi.advanceTimersByTime(10_000)
      expect(layouts).toEqual([])
      expect(t.toasts).toEqual([])
      expect(t.own['screenMoveTimer']).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
