// How the interface learns that the buttons of the system lie over its window (Windows), and what it does with it: the attribute of the root, the button ☰, the
// room kept at the end of the toolbar, the bare strip when the toolbar is hidden. The rules of the numbers: shared/window-controls.test.ts, shared/frame-layout.test.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { RuntimeState, Settings, SplitView, TabItem } from '@shared/model'
import { sameToolbar, type ToolbarInputs } from '@shared/row-equality'
import { createInitialState } from '@shared/sidebar'
import appCss from './App.tsx?raw'
import controlsCss from './window-controls.css?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, menuAt: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => new Proxy({ showAppMenu: (at: unknown) => void holder.menuAt.push(at) } as Record<string, unknown>, { get: (target, name: string) => target[name] ?? (() => undefined) }),
  useSnapshot: () => holder.snapshot
}))
vi.mock('./tooltip', () => ({ hideTooltip: () => undefined, tipProps: () => ({}) }))

import { App } from './App'
import { AppMenuButton } from './AppMenuButton'
import { SidePanelFrame } from './SidePanelFrame'
import { controlsVisible, markControls, markPlatform, useControlsOverlay } from './window-controls'

const overlayApi = (visible: boolean) => ({ windowControlsOverlay: { visible, addEventListener: () => undefined, removeEventListener: () => undefined } })

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.menuAt = []
})
afterEach(() => vi.unstubAllGlobals())

describe('whether the buttons of the system lie over the window', () => {
  it('is what the overlay API of the window says: visible only in a window made with the overlay', () => {
    vi.stubGlobal('navigator', overlayApi(true))
    expect(controlsVisible()).toBe(true)
    vi.stubGlobal('navigator', overlayApi(false))
    expect(controlsVisible()).toBe(false)
  })

  it('is false everywhere the API is not: another system, a window with the system’s own bar, a page with no navigator', () => {
    vi.stubGlobal('navigator', {})
    expect(controlsVisible()).toBe(false)
    vi.stubGlobal('navigator', undefined)
    expect(controlsVisible()).toBe(false)
  })

  it('puts a mark on the root while they are there, and takes it off when they go', () => {
    const attributes = new Map<string, string>()
    const root = { setAttribute: (name: string, value: string) => void attributes.set(name, value), removeAttribute: (name: string) => void attributes.delete(name), getAttribute: (name: string) => attributes.get(name) ?? null } as unknown as HTMLElement
    markControls(root, true)
    expect(attributes.get('data-controls')).toBe('overlay')
    markControls(root, false)
    expect(attributes.has('data-controls')).toBe(false)
  })

  it('says the system on the root', () => {
    const attributes = new Map<string, string>()
    const root = { setAttribute: (name: string, value: string) => void attributes.set(name, value) } as unknown as HTMLElement
    markPlatform(root, 'win32')
    expect(attributes.get('data-platform')).toBe('win32')
    markPlatform(root, 'darwin')
    expect(attributes.get('data-platform')).toBe('darwin')
  })

  it('is read by the views that draw a snapshot, true only where the buttons are', () => {
    const view = () => renderToStaticMarkup(createElement(() => createElement('i', { 'data-on': String(useControlsOverlay()) })))
    vi.stubGlobal('navigator', overlayApi(true))
    expect(view()).toContain('data-on="true"')
    vi.stubGlobal('navigator', overlayApi(false))
    expect(view()).toContain('data-on="false"')
  })
})

const tab = (id: string, spaceId = 's'): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

/** The window with one tab on screen (two in a split view), its settings changed by `settings`, on `platform`. */
function windowWith(settings: Partial<Settings> = {}, flags: { platform?: string; split?: boolean } = {}): string {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId
  const splits = flags.split ? [{ id: 'sp', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] } as unknown as SplitView] : []
  const state = { ...base, tabs: [tab('a', spaceId), tab('b', spaceId)], splits, activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, ...settings } }
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: flags.platform ?? 'win32' } as unknown as UiSnapshot
  return renderToStaticMarkup(createElement(App))
}

const MENU = 'aria-label="Menu de Lucium"'
const count = (markup: string, needle: string): number => markup.split(needle).length - 1

describe('the toolbar of a window with the buttons of the system over it', () => {
  it('starts with the button ☰, before the buttons of navigation, and ends with room for the buttons of the system', () => {
    vi.stubGlobal('navigator', overlayApi(true))
    const markup = windowWith()
    expect(count(markup, MENU)).toBe(1)
    expect(markup.indexOf(MENU)).toBeLessThan(markup.indexOf('aria-label="Précédent"'))
    expect(count(markup, 'class="tb-controls-room"')).toBe(1)
    // The room is the last thing of the right group, which it ends.
    expect(markup.indexOf('class="tb-controls-room"')).toBeGreaterThan(markup.indexOf('aria-label="Ajouter une vue scindée"'))
  })

  it('tells the stylesheets how far the card ends from the window’s edge, for the room', () => {
    vi.stubGlobal('navigator', overlayApi(true))
    expect(windowWith()).toContain('--card-gap-right:10px')
    expect(windowWith({ sidebarRight: true, sidebarWidth: 300 })).toContain('--card-gap-right:300px')
  })

  it('is the toolbar it always was where the buttons are not: no button ☰, no room, nothing added to the shell', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      vi.stubGlobal('navigator', overlayApi(false))
      const markup = windowWith({}, { platform })
      expect(count(markup, MENU), platform).toBe(0)
      expect(count(markup, 'tb-controls-room'), platform).toBe(0)
      expect(markup, platform).not.toContain('--card-gap-right')
      expect(count(markup, 'stage-strip'), platform).toBe(0)
      // With the toolbar hidden the button ☰ is not in the sidebar either: those windows have a menu bar, or the system’s own.
      expect(count(windowWith({ showToolbar: false }, { platform }), MENU), `${platform}, toolbar hidden`).toBe(0)
    }
  })

  it('leaves a bare strip above the card, which drags the window, when the toolbar is hidden: the buttons lie over it, not over the page', () => {
    vi.stubGlobal('navigator', overlayApi(true))
    const markup = windowWith({ showToolbar: false })
    expect(count(markup, 'class="stage-strip"')).toBe(1)
    expect(markup).toContain('class="stage with-toolbar"')
    // No toolbar to hold the button ☰: it starts the first row of the sidebar, which is on screen.
    expect(count(markup, MENU)).toBe(1)
    expect(markup).toContain('class="icon sidebar-menu app-menu-button"')
    // With the toolbar there, the strip is the toolbar's own row.
    expect(count(windowWith(), 'stage-strip')).toBe(0)
  })

  it('draws them on the strips of a split view too (which strip holds which: shared/window-controls.test.ts)', () => {
    vi.stubGlobal('navigator', overlayApi(true))
    const markup = windowWith({}, { split: true })
    expect(count(markup, MENU)).toBeGreaterThan(0)
    expect(count(markup, 'class="tb-controls-room"')).toBeGreaterThan(0)
    vi.stubGlobal('navigator', overlayApi(false))
    expect(count(windowWith({}, { split: true, platform: 'darwin' }), 'tb-controls-room')).toBe(0)
  })

  it('opens the menu of the application under the button, from its lower left corner', () => {
    const button = AppMenuButton({ className: 'tb-button' })
    const onClick = button.props.onClick as (event: unknown) => void
    onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 12, bottom: 42 }) } })
    expect(holder.menuAt).toEqual([{ x: 12, y: 42 }])
    expect(button.props['aria-label']).toBe('Menu de Lucium')
  })

  it('is told in English with the interface in English', () => {
    setLanguage('en')
    vi.stubGlobal('navigator', overlayApi(true))
    expect(count(windowWith(), 'aria-label="Lucium menu"')).toBe(1)
  })
})

describe('the room for the traffic lights', () => {
  it('is kept on macOS only: the strip that starts under them leaves nothing on a system that has none', () => {
    vi.stubGlobal('navigator', overlayApi(false))
    const mirrored = { sidebarRight: true }
    expect(windowWith(mirrored, { platform: 'darwin' })).toContain('padding-left:')
    expect(windowWith(mirrored, { platform: 'win32' })).not.toContain('padding-left:')
    // The same in a split view: its first strip starts under the lights.
    expect(windowWith(mirrored, { platform: 'darwin', split: true })).toContain('padding-left:')
    expect(windowWith(mirrored, { platform: 'win32', split: true })).not.toContain('padding-left:')
  })
})

describe('the header of the panel docked beside the page, at the left of a mirrored window', () => {
  const header = (lights?: boolean): string =>
    renderToStaticMarkup(createElement(SidePanelFrame, { name: 'Panneau', width: 320, margin: 10, panelAtLeft: true, onClose: () => undefined, onWidth: () => undefined, ...(lights === undefined ? {} : { lights }) }))

  it('starts under the traffic lights on macOS, and from its own margin where there are none', () => {
    expect(header()).toContain('padding-left:82px')
    expect(header(true)).toContain('padding-left:82px')
    expect(header(false)).toContain('padding-left:14px')
  })
})

describe('the bar drawn again', () => {
  it('when the button ☰ or the room for the buttons comes or goes', () => {
    const inputs: ToolbarInputs = { space: { profileId: 'default' }, current: undefined, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }
    expect(sameToolbar({ ...inputs, menu: true, underControls: true }, { ...inputs, menu: true, underControls: true })).toBe(true)
    expect(sameToolbar({ ...inputs, menu: true }, inputs)).toBe(false)
    expect(sameToolbar({ ...inputs, underControls: true }, inputs)).toBe(false)
    expect(sameToolbar({ ...inputs, menu: false, underControls: false }, inputs)).toBe(true)
  })
})

describe('the stylesheet of the buttons of the system', () => {
  const code = controlsCss.replace(/\/\*[\s\S]*?\*\//g, '')

  it('reads the width of the buttons from the system, never from a number of its own', () => {
    expect(code).toMatch(/--controls-w:\s*calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)/)
    // 138 px (3 × 46) is the width Windows 11 gives them at 100 %: a guess about one machine, not to be written.
    expect(code).not.toMatch(/\b(138|136|140|144|46|92)px/)
  })

  it('applies only to a window that has them: every rule that uses the width hangs on the attribute, or on what exists only there', () => {
    for (const rule of code.split('}').filter((part) => /--controls-w/.test(part.split('{')[1] ?? ''))) {
      const selector = rule.split('{')[0]!.trim()
      expect(selector === '.tb-controls-room' || /^:root\[data-controls='overlay'\]/.test(selector), selector).toBe(true)
    }
  })

  it('writes no colour of its own', () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })

  it('says the room for the lights is nothing everywhere but on macOS', () => {
    expect(code).toMatch(/:root\[data-platform\]:not\(\[data-platform='darwin'\]\)\s*\{\s*--lights-room:\s*0px;/)
  })

  it('is loaded by the window of the interface', () => {
    expect(appCss).toContain("import './window-controls.css'")
  })
})
