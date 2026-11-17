// The button « Contraste de la page » of the toolbar, drawn for real (as toolbar-notes-list.test.ts draws « Toutes les notes »): there for a web page that is not a PDF,
// not in a private tab or window, not with its setting off; before the site control center and after the other page controls; in the strip of the
// focused pane of a split view only; its icon and its name say the mode of the page's site, its tooltip what a click does; a click switches (the main
// process decides), a right click, the Menu key and Shift+F10 open the menu of every mode of its tab.

import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, Settings, SplitView, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import type { UiSnapshot } from '@shared/ipc'
import { READABLE_MODES, type ReadableMode } from '@shared/readable-mode'
import { sameToolbar, type ToolbarInputs } from '@shared/row-equality'
import { createInitialState } from '@shared/sidebar'
// The effect that measures the bar needs a page; its wiring is read from the source, as the other wiring tests of the shell do.
import actionsSource from './ExtensionActions.tsx?raw'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, menus: [] as unknown[], toggled: [] as string[], tips: [] as Array<[string, string[] | undefined]> }))
vi.mock('./api', () => ({ api: () => ({ openOverlay: () => undefined, showMenu: (target: unknown) => void holder.menus.push(target), toggleReadable: (id: string) => void holder.toggled.push(id) }), useSnapshot: () => holder.snapshot }))
vi.mock('./Sidebar', () => ({ FLOATING: false, Sidebar: () => null }))
vi.mock('./tooltip', () => ({
  hideTooltip: () => undefined,
  tipProps: (text: string, keys?: string[]) => {
    holder.tips.push([text, keys])
    return {}
  }
}))

import { App, SplitDividers } from './App'
import { ReadableButton, ReadableIcon, Toolbar } from './Toolbar'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.menus = []
  holder.toggled = []
  holder.tips = []
})
afterEach(() => vi.unstubAllGlobals())

/** What a button of a mode says, in French: « Contraste de la page : Sombre » is both its tooltip and its name for a screen reader. */
const LABELS: Record<ReadableMode, string> = { original: frenchSpaces('Contraste de la page : Original'), dark: frenchSpaces('Contraste de la page : Sombre'), light: frenchSpaces('Contraste de la page : Clair') }
const BUTTON = frenchSpaces('aria-label="Contraste de la page : ')
const count = (markup: string): number => markup.split(BUTTON).length - 1

const tab = (id: string, spaceId = 's', more: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2, ...more })
const space = { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

/** The window with one tab on screen: its settings changed by `settings`, private or not. */
function windowWith(settings: Partial<Settings> = {}, flags: { private?: boolean; guest?: boolean; dark?: boolean; tab?: Partial<TabItem> } = {}): string {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: flags.dark === true }) })
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId
  const state = { ...base, tabs: [tab('a', spaceId, flags.tab)], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, ...settings } }
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin', annotateEnabled: true, ...(flags.private ? { private: true } : {}), ...(flags.guest ? { guest: true } : {}) } as unknown as UiSnapshot
  return renderToStaticMarkup(createElement(App))
}

/** The markup of the button, from its tag to its end. */
const buttonOf = (markup: string): string => {
  const at = markup.indexOf('<button class="tb-button tb-readable"')
  return at < 0 ? '' : markup.slice(at, markup.indexOf('</button>', at) + '</button>'.length)
}
/** What the icon of a mode draws, alone. */
const iconOf = (mode: ReadableMode): string => renderToStaticMarkup(createElement(ReadableIcon, { mode }))

describe('the button in the toolbar of a window', () => {
  it('is there by default, for a web page', () => {
    expect(count(windowWith())).toBe(1)
  })

  it('is not there while its setting is off', () => {
    expect(count(windowWith({ readableToolbarButton: false }))).toBe(0)
    expect(count(windowWith({ readableToolbarButton: false, readableMode: 'dark', siteReadableMode: { 'a.example': 'light' } }))).toBe(0)
  })

  it('is not there for a page that is not a web page, nor for a PDF', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/page.html', 'view-source:https://a.example/', 'https://a.example/rapport.pdf']) {
      expect(count(windowWith({}, { tab: { url } })), url).toBe(0)
    }
    expect(count(windowWith({}, { tab: { url: 'http://a.example/' } }))).toBe(1)
  })

  it('is not there for a private tab of a normal window', () => {
    expect(count(windowWith({}, { tab: { private: true } }))).toBe(0)
  })

  it('is never there in a private window, nor in a guest one (private underneath)', () => {
    expect(count(windowWith({}, { private: true }))).toBe(0)
    expect(count(windowWith({}, { private: true, guest: true }))).toBe(0)
  })

  it('is not there with no tab on screen', () => {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    holder.snapshot = { state: base, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin' } as unknown as UiSnapshot
    expect(count(renderToStaticMarkup(createElement(App)))).toBe(0)
  })

  it('stands after « Annoter » and « Toutes les notes », right before the controls of the site, outside the extension icons', () => {
    const markup = windowWith()
    const at = (label: string) => markup.indexOf(`aria-label="${label}"`)
    expect(at('Annoter')).toBeGreaterThan(-1)
    expect(at('Toutes les notes')).toBeGreaterThan(at('Annoter'))
    expect(at(frenchSpaces('Contraste de la page : Original'))).toBeGreaterThan(at('Toutes les notes'))
    expect(at('Contraste de la page : Original')).toBeLessThan(at('Infos et réglages du site'))
    // Nothing between it and the site control center: they are neighbours. And it is not inside the box of the extension icons, so that the width
    // ExtensionActions measures (`rightGroup` less its own box) counts it among the fixed buttons.
    expect(markup.slice(markup.indexOf('</button>', at(frenchSpaces('Contraste de la page : Original'))), at('Infos et réglages du site'))).toMatch(/^<\/button><button class="tb-button tb-control" $/)
    expect(markup.slice(markup.indexOf('class="tb-actions"'), at('Contraste de la page : Original'))).toContain('</browser-action-list></div>')
  })

  it('shows the mode of the site on screen in its icon and its name: its own choice over the default', () => {
    const shown = (settings: Partial<Settings>, flags: Parameters<typeof windowWith>[1] = {}) => Object.entries(LABELS).find(([, label]) => windowWith(settings, flags).includes(`aria-label="${label}"`))?.[0]
    expect(shown({})).toBe('original')
    expect(shown({ readableMode: 'dark' })).toBe('dark')
    expect(shown({ readableMode: 'light' })).toBe('light')
    expect(shown({ readableMode: 'dark', siteReadableMode: { 'a.example': 'original' } })).toBe('original')
    expect(shown({ readableMode: 'original', siteReadableMode: { 'a.example': 'light' } })).toBe('light')
    expect(shown({ readableMode: 'original', siteReadableMode: { 'other.example': 'light' } })).toBe('original')
    // Automatic follows the appearance of the interface.
    expect(shown({ readableMode: 'auto' }, { dark: true })).toBe('dark')
    expect(shown({ readableMode: 'auto' }, { dark: false })).toBe('original')
  })

  it('says what a click does in its tooltip, the next mode of the cycle, and that a right click has every mode', () => {
    const tip = (settings: Partial<Settings>) => {
      holder.tips = []
      windowWith(settings)
      return holder.tips.filter(([text]) => / · clic droit\u00a0: tous les modes$/.test(text) || / · right-click: all modes$/.test(text))
    }
    expect(tip({ readableMode: 'original' })).toEqual([[frenchSpaces('Passer en sombre · clic droit : tous les modes'), undefined]])
    expect(tip({ readableMode: 'dark' })).toEqual([[frenchSpaces('Passer en clair · clic droit : tous les modes'), undefined]])
    expect(tip({ readableMode: 'light' })).toEqual([[frenchSpaces('Revenir à l’original · clic droit : tous les modes'), undefined]])
    expect(tip({ readableMode: 'dark', siteReadableMode: { 'a.example': 'original' } })).toEqual([[frenchSpaces('Passer en sombre · clic droit : tous les modes'), undefined]])
  })

  it('says it in English too, and keeps the current mode as its name', () => {
    setLanguage('en')
    const markup = windowWith({ siteReadableMode: { 'a.example': 'dark' } })
    expect(markup).toContain('aria-label="Page Contrast: Dark"')
    expect(holder.tips.filter(([text]) => text.includes('right-click'))).toEqual([['Switch to light · right-click: all modes', undefined]])
    holder.tips = []
    windowWith({})
    expect(holder.tips.filter(([text]) => text.includes('right-click'))).toEqual([['Switch to dark · right-click: all modes', undefined]])
    holder.tips = []
    windowWith({ siteReadableMode: { 'a.example': 'light' } })
    expect(holder.tips.filter(([text]) => text.includes('right-click'))).toEqual([['Back to the original · right-click: all modes', undefined]])
  })

  it('is a named button for the keyboard and a screen reader: its name is the mode, its description what a click does and how to get every mode', () => {
    const button = buttonOf(windowWith({ readableMode: 'dark' }))
    expect(button).toContain(frenchSpaces('aria-label="Contraste de la page : Sombre"'))
    expect(button).toContain(frenchSpaces('aria-description="Passer en clair. Tous les modes : clic droit ou ⇧F10."'))
    expect(buttonOf(windowWith({}))).toContain('aria-description="Passer en sombre. Tous les modes')
    expect(button.startsWith('<button class="tb-button tb-readable"')).toBe(true)
    // A click does not open a menu any more: the button does not say it does. Not `disabled`, nor `tabindex="-1"`: it takes the focus in the order of the bar.
    expect(button).not.toContain('aria-haspopup')
    expect(button).not.toContain('disabled')
    expect(button).not.toContain('tabindex')
  })

  it('draws a line icon of the grid of the toolbar, the size of its neighbours', async () => {
    const button = buttonOf(windowWith())
    expect(button).toContain('viewBox="0 0 20 20"')
    expect(button).toContain('width="20"')
    expect(button).toContain('stroke-width="1.5"')
    expect(button).toContain('stroke-linecap="round"')
    expect(button).toContain('aria-hidden="true"')
    const css = (await import('./toolbar.css?raw')).default
    expect(css).toMatch(/\.tb-button \{ width: 32px; height: 24px;/)
  })
})

describe('the bar with no page', () => {
  it('draws no button for a mode when there is no tab to set it for, in a single bar and in a strip', () => {
    const bar = (pane?: { style: unknown; focused: boolean; onSelect: () => void; onClose: () => void }): string =>
      renderToStaticMarkup(createElement(Toolbar, { space, current: undefined, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false, readable: 'dark', ...(pane ? { pane: pane as never } : {}) }))
    expect(count(bar())).toBe(0)
    expect(count(bar({ style: {}, focused: true, onSelect: () => undefined, onClose: () => undefined }))).toBe(0)
  })
})

describe('the icon of each mode', () => {
  it('is distinct for Original, Dark and Light', () => {
    const icons = READABLE_MODES.map(iconOf)
    expect(new Set(icons).size).toBe(3)
  })

  it('is drawn in the button of its mode', () => {
    for (const mode of READABLE_MODES) {
      const markup = windowWith({ readableMode: mode })
      expect(buttonOf(markup), mode).toContain(iconOf(mode))
      for (const other of READABLE_MODES.filter((m) => m !== mode)) expect(buttonOf(markup), `${mode} is not ${other}`).not.toContain(iconOf(other))
    }
  })

  it('is one simple shape each: a palette with four dots of paint, a crescent, a circle and eight rays', () => {
    const original = iconOf('original')
    // The palette, one path, and its four dots of paint, the only filled shapes of the three icons.
    expect(original.match(/<path/g)).toHaveLength(1)
    expect(original.match(/<circle/g)).toHaveLength(4)
    expect(original.match(/fill="currentColor"/g)).toHaveLength(4)
    const dark = iconOf('dark')
    expect(dark.match(/<path/g)).toHaveLength(1)
    expect(dark).not.toContain('<circle')
    expect(dark).not.toContain('fill="currentColor"')
    const light = iconOf('light')
    expect(light.match(/<circle/g)).toHaveLength(1)
    // Eight rays: four straight (h/v) and four diagonal (l), one path.
    expect(light.match(/M[\d.]+ [\d.]+(?:[hvl][-\d. ]+)/g)).toHaveLength(8)
    expect(light).not.toContain('fill="currentColor"')
  })

  it('is the only coloured glyph of the bar: its outline keeps the ink of the bar, the colour is inside it, from the tokens of the palette', async () => {
    expect(iconOf('original').match(/class="tb-paint-[1-4]"/g)).toHaveLength(4)
    expect(iconOf('dark')).toContain('class="tb-readable-tint"')
    expect(iconOf('light')).toContain('class="tb-readable-tint"')
    for (const mode of READABLE_MODES) expect(buttonOf(windowWith({ readableMode: mode }))).toContain(`data-mode="${mode}"`)
    const css = (await import('./toolbar.css?raw')).default
    // The outline is never given a colour of its own: only fills are set, from --fixed tokens.
    const rules = css.slice(css.indexOf('.tb-readable[data-mode'))
    expect(rules).not.toMatch(/(^|[;{\s])color:/)
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}/i)
    for (const token of ['--fixed-6577e8', '--fixed-eba21a', '--fixed-e5484d', '--fixed-f5a524', '--fixed-30a46c', '--fixed-3e7bfa']) expect(rules).toContain(`var(${token})`)
  })

  it('stays inside the 20 px grid, stroke included', () => {
    for (const mode of READABLE_MODES) {
      for (const number of iconOf(mode).match(/-?\d+(?:\.\d+)?/g) ?? []) expect(Math.abs(Number(number)), `${mode}: ${number}`).toBeLessThanOrEqual(20)
    }
  })
})

describe('the button in a split view', () => {
  const split: SplitView = { id: 'v', spaceId: 's', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }
  const strip = (focused: boolean, readable?: ReadableMode): string =>
    renderToStaticMarkup(createElement(Toolbar, { space, current: tab('a'), runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false, readable, pane: { style: {}, focused, onSelect: () => undefined, onClose: () => undefined } }))
  const layer = (readable: ReadableMode | undefined, activeId = 'a'): string =>
    renderToStaticMarkup(
      createElement(SplitDividers, { split, tabs: [tab('a'), tab('b')], activeId, space, runtime, sidebarVisible: true, fullUrl: false, draggable: false, stageLeft: null, zoom: { showZoomIndicator: false, siteZoom: {} }, scrollSync: false, synced: false, annotate: false, readable })
    )

  it('belongs to the strip of the focused pane only: the page that has the focus is the one it is for', () => {
    expect(count(strip(true, 'dark'))).toBe(1)
    expect(count(strip(false, 'dark'))).toBe(0)
    expect(count(strip(true))).toBe(0)
  })

  it('is handed by the split layer to its strips: one button, over the focused pane', () => {
    expect(count(layer('light'))).toBe(1)
    expect(layer('light')).toContain(frenchSpaces('aria-label="Contraste de la page : Clair"'))
    expect(count(layer(undefined))).toBe(0)
    expect(count(layer('light', 'elsewhere'))).toBe(0)
  })

  it('is drawn for the focused page of a whole window in a split view, not for a page that is not a web page', () => {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    const spaceId = base.activeSpaceId
    const at = (url: string) => {
      const state = { ...base, tabs: [tab('a', spaceId, { url }), tab('b', spaceId)], splits: [{ ...split, spaceId }], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, readableMode: 'dark' as const } }
      holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin' } as unknown as UiSnapshot
      return renderToStaticMarkup(createElement(App))
    }
    expect(count(at('https://a.example/'))).toBe(1)
    expect(count(at('about:blank'))).toBe(0)
    expect(count(at('https://a.example/a.pdf'))).toBe(0)
  })
})

describe('a click on the button', () => {
  type Handlers = { onClick: () => void; onContextMenu: (event: { preventDefault: () => void }) => void; onKeyDown: (event: { key: string; shiftKey?: boolean; preventDefault: () => void }) => void; 'aria-label': string }
  const button = (mode: ReadableMode = 'dark', tabId = 'tab-7') => ReadableButton({ mode, tabId }) as ReactElement<Handlers>
  /** An event that says whether its default was prevented. */
  const event = (more: { key?: string; shiftKey?: boolean } = {}) => {
    const seen = { prevented: 0 }
    return { seen, event: { key: 'x', ...more, preventDefault: () => void (seen.prevented += 1) } }
  }

  it('switches the page of the tab it is on: the main process decides which way, and no menu opens', () => {
    const element = button('dark', 'tab-7')
    expect(isValidElement(element)).toBe(true)
    expect(element.props['aria-label']).toBe(LABELS.dark)
    element.props.onClick()
    expect(holder.toggled).toEqual(['tab-7'])
    expect(holder.menus).toEqual([])
  })

  it('switches the tab on screen, in a window', () => {
    windowWith()
    button('original', 'a').props.onClick()
    expect(holder.toggled).toEqual(['a'])
    expect(holder.menus).toEqual([])
  })

  it('opens the menu of every mode of its tab on a right click, which is not the system’s own menu, and switches nothing', () => {
    const { seen, event: right } = event()
    button('dark', 'tab-7').props.onContextMenu(right)
    expect(seen.prevented).toBe(1)
    expect(holder.menus).toEqual([{ kind: 'readable', id: 'tab-7' }])
    expect(holder.toggled).toEqual([])
  })

  it('opens the same menu from the keyboard, with the Menu key or Shift+F10 (once: the key is handled), and with no other key', () => {
    for (const keys of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      holder.menus = []
      const { seen, event: pressed } = event(keys)
      button('light', 'tab-9').props.onKeyDown(pressed)
      expect(seen.prevented, JSON.stringify(keys)).toBe(1)
      expect(holder.menus, JSON.stringify(keys)).toEqual([{ kind: 'readable', id: 'tab-9' }])
    }
    holder.menus = []
    for (const keys of [{ key: 'Enter' }, { key: ' ' }, { key: 'F10' }, { key: 'F10', shiftKey: false }, { key: 'Escape' }, { key: 'm', shiftKey: true }]) {
      const { seen, event: pressed } = event(keys)
      button('light', 'tab-9').props.onKeyDown(pressed)
      expect(seen.prevented, JSON.stringify(keys)).toBe(0)
    }
    expect(holder.menus).toEqual([])
    expect(holder.toggled).toEqual([])
  })
})

describe('the list of the pages a tab went through', () => {
  // A long press and a right click on « Précédent » or « Suivant » were the only ways to it: nothing for the keyboard.
  it('opens from the keyboard too, with the Menu key or Shift+F10 on either button, and with no other key', () => {
    const buttons = elementsOf(createElement(Toolbar, { space, current: tab('a'), runtime: { ...runtime, canGoBack: true, canGoForward: true }, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false }))
    for (const [name, id] of [['Précédent', 'back'], ['Suivant', 'forward']] as const) {
      const button = buttons.find((element) => element.type === 'button' && element.props['aria-label'] === name)!
      const press = (keys: { key: string; shiftKey?: boolean }): number => {
        let prevented = 0
        ;(button.props['onKeyDown'] as (event: unknown) => void)({ ...keys, preventDefault: () => void (prevented += 1) })
        return prevented
      }
      holder.menus = []
      expect(press({ key: 'ContextMenu' })).toBe(1)
      expect(press({ key: 'F10', shiftKey: true })).toBe(1)
      expect(holder.menus).toEqual([{ kind: 'nav', id }, { kind: 'nav', id }])
      for (const keys of [{ key: 'Enter' }, { key: ' ' }, { key: 'F10' }, { key: 'ArrowDown' }]) expect(press(keys), JSON.stringify(keys)).toBe(0)
      expect(holder.menus).toHaveLength(2)
    }
  })
})

describe('the bar around the button', () => {
  const inputs: ToolbarInputs = { space: { profileId: 'default' }, current: undefined, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }

  it('is drawn again when the button comes or goes, or the mode of the page changes', () => {
    expect(sameToolbar({ ...inputs, readable: 'dark' }, { ...inputs, readable: 'dark' })).toBe(true)
    expect(sameToolbar(inputs, { ...inputs })).toBe(true)
    expect(sameToolbar({ ...inputs, readable: 'dark' }, inputs)).toBe(false)
    expect(sameToolbar(inputs, { ...inputs, readable: 'original' })).toBe(false)
    expect(sameToolbar({ ...inputs, readable: 'dark' }, { ...inputs, readable: 'light' })).toBe(false)
  })

  it('has the extension icons measured again when the buttons beside them come or go (the page changes whether this one is there)', () => {
    expect(actionsSource).toMatch(/resize\.observe\(root\)/)
    expect(actionsSource).toMatch(/resize\.observe\(leftGroup\)/)
    expect(actionsSource).toMatch(/resize\.observe\(rightGroup\)/)
  })
})
