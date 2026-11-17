// The window around a docked sidebar (« barre collée »), drawn for real without a window (as toolbar-notes-list.test.ts draws the toolbar): the column is
// 56 px wide, the traffic lights stay at the window's top left corner whatever its side, so the toolbar of the page leaves them room (the column at the left:
// the card starts at 56, the lights reach 76; at the right: the card starts at the border), and a hidden toolbar leaves a bare strip for them.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { DOCK_WIDTH, LIGHTS_CLEARANCE } from '@shared/frame-layout'
import { PAGE_MARGIN } from '@shared/ipc'
import type { WindowSidebar } from '@shared/window-sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))
vi.mock('./Sidebar', () => ({ FLOATING: false, Sidebar: () => null }))
vi.mock('./tooltip', () => ({ hideTooltip: () => undefined, tipProps: () => ({}) }))

import { App } from './App'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

const tab = (id: string, spaceId: string): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })

/** The window with one tab on screen, its settings changed by `settings`, and the sidebar it chose for itself. */
function windowWith(windowSidebar: WindowSidebar | undefined, settings: Partial<Settings> = {}): string {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId
  const state = { ...base, tabs: [tab('a', spaceId)], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, ...settings } }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, extensions: [], downloads: [], windows: [], platform: 'darwin', ...(windowSidebar ? { windowSidebar } : {}) } as unknown as UiSnapshot
  return renderToStaticMarkup(createElement(App))
}

/** The room the toolbar leaves at its start (its padding is 5 px, and the room of the lights is added to it), 0 when it leaves none. */
function leading(markup: string): number {
  const style = /<div[^>]*class="page-toolbar[^"]*"[^>]*style="([^"]*)"/.exec(markup)?.[1] ?? ''
  const padding = /padding-left:(\d+)px/.exec(style)?.[1]
  return padding === undefined ? 0 : Number(padding) - 5
}

describe('the window of a docked sidebar', () => {
  it('gives the column its 56 px, and keeps the width of the full sidebar for when it is unfolded', () => {
    expect(windowWith({ docked: true })).toContain(`--sidebar-width:${DOCK_WIDTH}px`)
    expect(windowWith(undefined)).toContain('--sidebar-width:323px')
  })

  it('leaves the traffic lights room in the toolbar, the column at the left or at the right', () => {
    expect(leading(windowWith(undefined))).toBe(0)
    expect(leading(windowWith({ docked: true }))).toBe(LIGHTS_CLEARANCE - DOCK_WIDTH)
    expect(leading(windowWith({ docked: true, side: 'right' }))).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
    // At the right by the setting, the window having chosen nothing but the column.
    expect(leading(windowWith({ docked: true }, { sidebarRight: true }))).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
    // The full sidebar at the right, by this window's own choice: as a mirrored window always did.
    expect(leading(windowWith({ side: 'right' }))).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
  })

  it('mirrors a window that put its sidebar at the right, whatever the setting, and only that window', () => {
    expect(windowWith({ side: 'right' })).toMatch(/class="shell [^"]*sidebar-right/)
    expect(windowWith({ side: 'left' }, { sidebarRight: true })).not.toMatch(/class="shell [^"]*sidebar-right/)
    expect(windowWith(undefined, { sidebarRight: true })).toMatch(/class="shell [^"]*sidebar-right/)
  })

  it('keeps a bare strip above the page for the lights when the toolbar is hidden, the column at the left', () => {
    expect(windowWith({ docked: true }, { showToolbar: false })).toContain('class="stage with-toolbar"')
    expect(windowWith(undefined, { showToolbar: false })).toContain('class="stage "')
  })
})
