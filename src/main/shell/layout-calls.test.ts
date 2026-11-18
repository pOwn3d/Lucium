// What the layout of a window asks of macOS at each pass: the layout runs at every change of the state, so
// the traffic lights are given only when they change, and the views on top of the pages are reordered only when they are not in order already.
// The methods of the shell run on a stand-in (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import { TOOLBAR_BAR_HEIGHT } from '@shared/ipc'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { CONTROLS_SYMBOL } from '@shared/window-controls'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const platform = vi.hoisted(() => ({ given: [] as unknown[], answers: true, controls: true, overlays: [] as unknown[], popups: [] as unknown[], menu: null as unknown }))

// The application menu is what the electron stand-in hands out (`Menu.getApplicationMenu`); everything else it is asked for is an empty object.
vi.mock('electron', () => new Proxy({ Menu: { getApplicationMenu: () => platform.menu } } as Record<string, unknown>, { get: (target, name: string) => target[name] ?? {} }))
vi.mock('../platform', () => ({
  currentPlatform: () => ({
    facts: { controlsOverlay: platform.controls },
    syncTrafficLights: (_win: unknown, lights: unknown) => {
      platform.given.push(lights)
      return platform.answers
    },
    syncControlsOverlay: (_win: unknown, overlay: unknown) => {
      platform.overlays.push(overlay)
      return platform.answers
    }
  })
}))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

describe('the traffic lights of a window', () => {
  it('are given to the window only when they change', () => {
    platform.given.length = 0
    let lights = { visible: true, position: { x: 12, y: 16 } }
    const fake = fakeBrowser({ trafficLightsGiven: '', trafficLights: () => lights, win: {} })
    const sync = () => shell['syncTrafficLights']!.call(fake.self)
    sync()
    sync()
    expect(platform.given).toEqual([lights])
    lights = { visible: true, position: { x: 17, y: 21 } }
    sync()
    lights = { visible: false, position: { x: 17, y: 21 } }
    sync()
    sync()
    expect(platform.given).toHaveLength(3)
  })

  it('are asked again on a system that has none to give (the platform says it did nothing)', () => {
    platform.given.length = 0
    platform.answers = false
    const lights = { visible: true, position: { x: 12, y: 16 } }
    const fake = fakeBrowser({ trafficLightsGiven: '', trafficLights: () => lights, win: {} })
    shell['syncTrafficLights']!.call(fake.self)
    shell['syncTrafficLights']!.call(fake.self)
    expect(platform.given).toHaveLength(2)
    platform.answers = true
  })
})

describe('the buttons of the system over the right end of a window (Windows)', () => {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId

  /** A window with a page on screen, its bar the colour `color` (none: the default bar) and its settings changed by `settings`. */
  function windowOn(o: { color?: string; settings?: Partial<Settings>; split?: boolean; dark?: boolean; private?: boolean } = {}) {
    const tab = { id: 'a', spaceId, url: 'https://a.example/', title: 'a', pinned: false, createdAt: 1, lastActiveAt: 2 }
    const state = {
      ...base,
      tabs: [tab, { ...tab, id: 'b' }],
      activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' },
      splits: o.split ? [{ id: 'sp', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }] : [],
      settings: { ...base.settings, ...o.settings }
    } as unknown as SidebarState
    return fakeBrowser({
      controlsOverlayGiven: '',
      store: { get: () => state },
      runtime: { tabs: { a: o.color ? { color: o.color } : {} }, canGoBack: false, canGoForward: false },
      systemDark: o.dark ?? true,
      k: () => 1,
      isPrivate: () => o.private === true,
      win: {}
    })
  }
  const sync = (fake: ReturnType<typeof windowOn>) => shell['syncControlsOverlay']!.call(fake.self)
  const given = () => platform.overlays as Array<{ color: string; symbolColor: string; height: number }>
  const reset = () => {
    platform.overlays.length = 0
    platform.controls = true
    platform.answers = true
  }

  it('are given to the window only when they change: the layout runs at every change of the state', () => {
    reset()
    const fake = windowOn()
    sync(fake)
    sync(fake)
    expect(given()).toHaveLength(1)
    fake.self['runtime'] = { tabs: { a: { color: '#ffffff' } }, canGoBack: false, canGoForward: false }
    sync(fake)
    sync(fake)
    expect(given()).toHaveLength(2)
  })

  it('cover the border above the toolbar and the toolbar, and follow the border the user chose', () => {
    reset()
    sync(windowOn())
    sync(windowOn({ settings: { windowBorder: 0 } }))
    sync(windowOn({ settings: { windowBorder: 24 } }))
    expect(given().map((o) => o.height)).toEqual([10 + TOOLBAR_BAR_HEIGHT, TOOLBAR_BAR_HEIGHT, 24 + TOOLBAR_BAR_HEIGHT])
  })

  it('read on the bar of the page on screen: dark ink over a pale bar, light ink over a dark one', () => {
    reset()
    sync(windowOn({ color: '#ffffff' }))
    sync(windowOn({ color: '#101010' }))
    expect(given().map((o) => o.symbolColor)).toEqual([CONTROLS_SYMBOL.onLight, CONTROLS_SYMBOL.onDark])
  })

  it('read on the window itself when the toolbar is hidden, and on the dark strips of a split view', () => {
    reset()
    sync(windowOn({ settings: { showToolbar: false }, color: '#101010' }))
    sync(windowOn({ split: true, color: '#ffffff' }))
    expect(given().map((o) => o.symbolColor)).toEqual([given()[0]!.symbolColor, CONTROLS_SYMBOL.onDark])
  })

  it('are asked again on a system that did nothing with them (the platform says so), and not at all where there are none', () => {
    reset()
    platform.answers = false
    const fake = windowOn()
    sync(fake)
    sync(fake)
    expect(given()).toHaveLength(2)
    reset()
    platform.controls = false
    sync(windowOn())
    expect(given()).toHaveLength(0)
  })
})

describe('the menu of the application opened from the button ☰', () => {
  const popupOn = (bounds: { width: number; height: number }, anchor: unknown, k = 1) => {
    platform.popups.length = 0
    platform.menu = { popup: (options: unknown) => void platform.popups.push(options) }
    const win = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, ...bounds }) }
    const toCss = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k })
    const fromCss = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x * k, y: b.y * k, width: b.width * k, height: b.height * k })
    const answer = shell['popupAppMenu']!.call(fakeBrowser({ win, toCss, fromCss }).self, anchor)
    return { answer, win }
  }

  it('opens at the point of the button, in the window', () => {
    const { answer, win } = popupOn({ width: 1360, height: 860 }, { x: 14.2, y: 42 })
    expect(answer).toBe(true)
    expect(platform.popups).toEqual([{ window: win, x: 14, y: 42 }])
  })

  it('scales the point with the zoom of the interface: the button is drawn in CSS pixels, the menu opens in points', () => {
    expect(popupOn({ width: 1700, height: 1000 }, { x: 40, y: 50 }, 1.25).answer).toBe(true)
    expect(platform.popups).toMatchObject([{ x: 50, y: 63 }])
  })

  it('opens nothing for a point outside the window, or not a point: the interface is not trusted', () => {
    for (const bad of [{ x: -1, y: 0 }, { x: 5000, y: 10 }, { x: 'a', y: 1 }, null, 'x']) {
      expect(popupOn({ width: 1360, height: 860 }, bad).answer, JSON.stringify(bad)).toBe(false)
      expect(platform.popups).toEqual([])
    }
  })

  it('opens nothing when the application has no menu installed', () => {
    const win = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }
    platform.menu = null
    const ident = (b: unknown) => b
    expect(shell['popupAppMenu']!.call(fakeBrowser({ win, toCss: ident, fromCss: ident }).self, { x: 1, y: 1 })).toBe(false)
  })
})

describe('the views on top of the pages', () => {
  /** A window's content view: `addChildView` puts the view on top, as Electron does with a view it already holds. */
  function contentView(...children: string[]) {
    const added: string[] = []
    const view = {
      children,
      addChildView: (child: string) => {
        view.children = [...view.children.filter((one) => one !== child), child]
        added.push(child)
      }
    }
    return { view, added }
  }
  const stack = (content: ReturnType<typeof contentView>, views: string[]) => shell['stackOnTop']!.call(fakeBrowser({ win: { contentView: content.view } }).self, views)

  it('are left alone when they already are on top, in their order', () => {
    const content = contentView('page', 'floating', 'overlay')
    stack(content, ['floating', 'overlay'])
    stack(content, ['overlay'])
    stack(content, [])
    expect(content.added).toEqual([])
  })

  it('go back on top, in their order, when a view came above them or the order is not theirs', () => {
    const above = contentView('floating', 'overlay', 'new page')
    stack(above, ['floating', 'overlay'])
    expect(above.view.children).toEqual(['new page', 'floating', 'overlay'])
    const swapped = contentView('page', 'overlay', 'floating')
    stack(swapped, ['floating', 'overlay'])
    expect(swapped.view.children).toEqual(['page', 'floating', 'overlay'])
    const missing = contentView('page')
    stack(missing, ['overlay'])
    expect(missing.view.children).toEqual(['page', 'overlay'])
  })
})
