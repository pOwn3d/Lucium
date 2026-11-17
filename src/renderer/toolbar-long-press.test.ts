// @vitest-environment happy-dom
// The long press on Back and Forward (Toolbar.tsx), mounted in a document: which press arms it, what disarms it, and what a click does afterwards.
// A native menu takes the pointer away from the page, which may then never see the button come up: nothing here counts on that event.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import { mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ menus: [] as unknown[], navs: [] as string[] }))
vi.mock('./api', () => ({
  api: () => ({ showMenu: (target: unknown) => void holder.menus.push(target), nav: (command: string) => void holder.navs.push(command), openOverlay: () => undefined, dispatch: () => undefined }),
  useSnapshot: () => null
}))
vi.mock('./tooltip', () => ({ hideTooltip: () => undefined, tipProps: () => ({}) }))
vi.mock('./ExtensionActions', () => ({ ExtensionActions: () => null }))

import { Toolbar } from './Toolbar'

const tab: TabItem = { id: 'a', spaceId: 's', url: 'https://a.example/', title: 'a', pinned: false, createdAt: 1, lastActiveAt: 2 }
const space = { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never
const runtime: RuntimeState = { tabs: {}, canGoBack: true, canGoForward: true }
const NAV_MENU = { kind: 'nav', id: 'back' }

let mounted: Mounted | null = null
const back = (): HTMLButtonElement => mounted!.container.querySelector<HTMLButtonElement>('button[aria-label="Précédent"]')!
const fire = (type: string, init: MouseEventInit = {}): void => act(() => void back().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })))
const wait = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  setLanguage('fr')
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  holder.menus = []
  holder.navs = []
  mounted = mount(createElement(Toolbar, { space, current: tab, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false }))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a press on Back', () => {
  it('held half a second with the main button lists the pages, and the click that ends it does not navigate', () => {
    fire('mousedown', { button: 0 })
    wait(499)
    expect(holder.menus).toEqual([])
    wait(1)
    expect(holder.menus).toEqual([NAV_MENU])
    fire('mouseup')
    fire('click')
    expect(holder.navs).toEqual([])
    // The next click is a click again.
    fire('click')
    expect(holder.navs).toEqual(['back'])
  })

  it('with the right button opens the menu once, even when the page never sees the button come up, and leaves the next click alone', () => {
    fire('mousedown', { button: 2 })
    fire('contextmenu', { button: 2 })
    expect(holder.menus).toEqual([NAV_MENU])
    wait(2000)
    expect(holder.menus).toEqual([NAV_MENU])
    fire('click')
    expect(holder.navs).toEqual(['back'])
  })

  it('with Control held is a right click on macOS: the menu opens once', () => {
    fire('mousedown', { button: 0, ctrlKey: true })
    wait(2000)
    expect(holder.menus).toEqual([])
    fire('click')
    expect(holder.navs).toEqual(['back'])
  })

  it('is disarmed by the menu that opens on it, whatever armed it', () => {
    fire('mousedown', { button: 0 })
    fire('contextmenu')
    wait(2000)
    expect(holder.menus).toEqual([NAV_MENU])
  })

  it('opens nothing once the toolbar is gone', () => {
    fire('mousedown', { button: 0 })
    mounted!.unmount()
    mounted = null
    vi.advanceTimersByTime(2000)
    expect(holder.menus).toEqual([])
  })
})
