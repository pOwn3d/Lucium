// The tooltips of the toolbar say the shortcut of their command as Réglages › Raccourcis sets it: a shortcut changed there changes its tooltip, and a
// command left without a shortcut shows its text alone. They used to carry the default keys written out, which stayed after a change. The bar is
// drawn for real, in the window and in the strip of a split view; the tooltips are recorded as the buttons ask for them.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, Settings, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import { toolbarKeys } from '@shared/keybindings'
import { sameToolbar, type ToolbarInputs } from '@shared/row-equality'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, tips: [] as Array<[string, string[] | undefined]> }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))
vi.mock('./Sidebar', () => ({ FLOATING: false, Sidebar: () => null }))
vi.mock('./tooltip', () => ({
  hideTooltip: () => undefined,
  tipProps: (text: string, keys?: string[]) => {
    holder.tips.push([text, keys])
    return {}
  }
}))

import { App } from './App'
import { Toolbar } from './Toolbar'
import toolbarSource from './Toolbar.tsx?raw'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.tips = []
})
afterEach(() => vi.unstubAllGlobals())

const tab = (id: string, spaceId = 's'): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })
const space = { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

/** The tooltips of the window with one tab on screen (its sidebar hidden, so that the bar draws the button that shows it), by their text. */
function tipsOfWindow(settings: Partial<Settings> = {}): Map<string, string[] | undefined> {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId
  const state = { ...base, tabs: [tab('a', spaceId)], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, sidebarVisible: false, ...settings } }
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin', annotateEnabled: true }
  holder.tips = []
  renderToStaticMarkup(createElement(App))
  return new Map(holder.tips)
}

describe('the tooltips of the toolbar', () => {
  it('say the default shortcut of each command', () => {
    const tips = tipsOfWindow()
    expect(tips.get('Afficher la barre latérale')).toEqual(['⌘', 'S'])
    expect(tips.get('Page précédente')).toEqual(['⌘', '['])
    expect(tips.get('Page suivante')).toEqual(['⌘', ']'])
    expect(tips.get('Actualiser la page')).toEqual(['⌘', 'R'])
    expect(tips.get('Copier l’adresse')).toEqual(['⇧', '⌘', 'C'])
    expect(tips.get('Infos et réglages du site')).toEqual(['⇧', '⌘', 'I'])
    expect(tips.get('Ajouter une vue scindée')).toEqual(['⌃', '⇧', '='])
  })

  it('follow a shortcut changed in the Settings, and show none for a command left without one', () => {
    const tips = tipsOfWindow({ keyBindings: { back: 'CmdOrCtrl+Alt+Left', reload: 'F5', copyUrl: '', toggleSidebar: 'CmdOrCtrl+Shift+L', siteInfo: 'CmdOrCtrl+Alt+Y', addSplit: 'Ctrl+Alt+V' } })
    expect(tips.get('Page précédente')).toEqual(['⌥', '⌘', '←'])
    expect(tips.get('Actualiser la page')).toEqual(['F5'])
    expect(tips.get('Copier l’adresse')).toBeUndefined()
    expect(tips.has('Copier l’adresse')).toBe(true)
    expect(tips.get('Afficher la barre latérale')).toEqual(['⇧', '⌘', 'L'])
    expect(tips.get('Infos et réglages du site')).toEqual(['⌥', '⌘', 'Y'])
    expect(tips.get('Ajouter une vue scindée')).toEqual(['⌃', '⌥', 'V'])
    // A command that was not touched keeps its own.
    expect(tips.get('Page suivante')).toEqual(['⌘', ']'])
  })

  it('say the fixed shortcut of « Annoter », which is not one of the Settings', () => {
    expect([...tipsOfWindow()].find(([, keys]) => keys?.join('') === '⌥⌘M')).toBeDefined()
    expect(toolbarKeys({ annotate: 'CmdOrCtrl+K' }).annotate).toEqual(['⌥', '⌘', 'M'])
  })

  it('follow the shortcuts in the strip of a split view and on the mark of the zoom', () => {
    const keys = toolbarKeys({ closeSplitPane: 'Ctrl+Alt+W', zoomReset: 'CmdOrCtrl+Alt+0' })
    renderToStaticMarkup(createElement(Toolbar, { space, current: tab('a'), runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false, zoomMark: '125 %', keys, pane: { style: {}, focused: true, onSelect: () => undefined, onClose: () => undefined } }))
    const tips = new Map(holder.tips)
    expect(tips.get('Fermer ce volet')).toEqual(['⌃', '⌥', 'W'])
    expect([...tips].find(([text]) => text.includes('125 %'))?.[1]).toEqual(['⌥', '⌘', '0'])
  })

  it('carry no key written out: every one comes from the shortcuts in force', () => {
    expect(toolbarSource.match(/tipProps\([^)]*\[\s*'[^']*'/g) ?? []).toEqual([])
    expect(toolbarSource.match(/['"][⌘⌥⌃⇧]['"]/g) ?? []).toEqual([])
  })
})

describe('the bar and a change of shortcut', () => {
  it('is drawn again when the keys of a tooltip change, and not when they are the same', () => {
    const inputs: ToolbarInputs = { space: { profileId: 'default' }, current: undefined, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }
    expect(sameToolbar({ ...inputs, keys: toolbarKeys({}) }, { ...inputs, keys: toolbarKeys({}) })).toBe(true)
    expect(sameToolbar({ ...inputs, keys: toolbarKeys({}) }, { ...inputs, keys: toolbarKeys({ back: 'CmdOrCtrl+Alt+Left' }) })).toBe(false)
  })
})
