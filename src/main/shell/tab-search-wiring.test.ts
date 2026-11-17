// The "Onglets" mode of the command bar (⌘⇧A) and the sheet of the shortcuts (⌘/) are functions with a switch: off, their entry is hidden and
// its key dead, the main process refuses the request whoever asks, and the sheet is allowed in a private window. On, the key opens the panel and, pressed again, closes it.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type SidebarState } from '@shared/model'
import { canOpenInPrivate } from '@shared/private-window'
import { createInitialState } from '@shared/sidebar'
import type { OverlayRequest } from '@shared/ipc'
import { methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'

// ipc.ts, menu.ts and the shell reach Electron only when a message arrives, a menu is built or a method runs.
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { validOverlay } = await import('./ipc')
const { buildMenu } = await import('./menu')
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** Whether the window's own `openOverlay` shows the panel, with these settings (run on a stand-in: browser-fake.test-support.ts). */
function opens(settings: Partial<SidebarState['settings']>, request: OverlayRequest): boolean {
  const fake = overlayHost(settings)
  shell['openOverlay']!.call(fake.self, request)
  return showedPanel(fake, request.panel)
}

const stateWith = (patch: Partial<SidebarState['settings']>): SidebarState => {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  return { ...base, settings: { ...defaultSettings(), ...patch } }
}
const storeOf = (state: SidebarState) => ({ get: () => state })

interface Item {
  label?: string
  accelerator?: string
  visible?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: Item[]
}
const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))

function menuOf(state: SidebarState, open: OverlayRequest | null = null) {
  const opened: OverlayRequest[] = []
  let closed = 0
  const browser = new Proxy(
    {
      openOverlay: (request: OverlayRequest) => void opened.push(request),
      closeOverlay: () => void (closed += 1),
      currentOverlay: () => open,
      menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false })
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const items = leaves(buildMenu(browser as never, storeOf(state) as never, actions as never) as unknown as Item[])
  return { item: (label: string) => items.find((i) => i.label === label), opened, closed: () => closed }
}

describe('the "Onglets" mode of the command bar, a function of its own', () => {
  it('is opened by the interface when the function is on, and refused when it is off, while the other modes are not', () => {
    const request = { panel: 'commandbar', mode: 'tabs', initial: '' }
    expect(validOverlay(request, storeOf(stateWith({ tabSearch: true })))).toBe(true)
    expect(validOverlay(request, storeOf(stateWith({ tabSearch: false })))).toBe(false)
    for (const mode of ['new', 'current', 'split', 'little']) expect(validOverlay({ panel: 'commandbar', mode, initial: '' }, storeOf(stateWith({ tabSearch: false }))), mode).toBe(true)
    expect(validOverlay({ panel: 'commandbar', mode: 'other', initial: '' }, storeOf(stateWith({}))), 'unknown mode').toBe(false)
  })

  it('has its entry in the Tabs menu with ⇧⌘A while on; off, the entry is hidden and its key is dead', () => {
    const on = menuOf(stateWith({ tabSearch: true })).item('Rechercher un onglet…')
    expect(on).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+A', visible: true, enabled: true })
    const off = menuOf(stateWith({ tabSearch: false })).item('Rechercher un onglet…')
    expect(off).toMatchObject({ visible: false, enabled: false })
  })

  it('follows the key the user gave it', () => {
    expect(menuOf(stateWith({ keyBindings: { tabSearch: 'CmdOrCtrl+Alt+Shift+T' } })).item('Rechercher un onglet…')!.accelerator).toBe('CmdOrCtrl+Alt+Shift+T')
    expect(menuOf(stateWith({ keyBindings: { tabSearch: '' } })).item('Rechercher un onglet…')!.accelerator).toBeUndefined()
  })

  it('opens the bar in this mode, and closes it when the same key is pressed over it; over another panel, it takes its place', () => {
    const closed = menuOf(stateWith({}))
    closed.item('Rechercher un onglet…')!.click!()
    expect(closed.opened).toEqual([{ panel: 'commandbar', mode: 'tabs', initial: '' }])

    const over = menuOf(stateWith({}), { panel: 'commandbar', mode: 'tabs', initial: '' })
    over.item('Rechercher un onglet…')!.click!()
    expect(over.opened).toEqual([])
    expect(over.closed()).toBe(1)

    const other = menuOf(stateWith({}), { panel: 'commandbar', mode: 'new', initial: '' })
    other.item('Rechercher un onglet…')!.click!()
    expect(other.opened).toEqual([{ panel: 'commandbar', mode: 'tabs', initial: '' }])
    expect(other.closed()).toBe(0)
  })

  it('is refused by the main process itself when the function is off: no caller can open it', () => {
    expect(opens({ tabSearch: false }, { panel: 'commandbar', mode: 'tabs', initial: '' })).toBe(false)
    expect(opens({ tabSearch: true }, { panel: 'commandbar', mode: 'tabs', initial: '' })).toBe(true)
    // The other modes of the bar are not this function.
    expect(opens({ tabSearch: false }, { panel: 'commandbar', mode: 'new', initial: '' })).toBe(true)
  })
})

describe('the sheet of the shortcuts, a function of its own', () => {
  it('is opened by the interface when the function is on, and refused when it is off', () => {
    expect(validOverlay({ panel: 'shortcuts' }, storeOf(stateWith({ shortcutHelp: true })))).toBe(true)
    expect(validOverlay({ panel: 'shortcuts' }, storeOf(stateWith({ shortcutHelp: false })))).toBe(false)
  })

  it('has its entry in the Help menu with ⌘/ while on; off, the entry is hidden and its key is dead', () => {
    expect(menuOf(stateWith({ shortcutHelp: true })).item('Aide des raccourcis')).toMatchObject({ accelerator: 'CmdOrCtrl+/', visible: true, enabled: true })
    expect(menuOf(stateWith({ shortcutHelp: false })).item('Aide des raccourcis')).toMatchObject({ visible: false, enabled: false })
  })

  it('opens, and closes when the same key is pressed over it', () => {
    const closed = menuOf(stateWith({}))
    closed.item('Aide des raccourcis')!.click!()
    expect(closed.opened).toEqual([{ panel: 'shortcuts' }])
    const over = menuOf(stateWith({}), { panel: 'shortcuts' })
    over.item('Aide des raccourcis')!.click!()
    expect(over.opened).toEqual([])
    expect(over.closed()).toBe(1)
  })

  it('is refused by the main process itself when the function is off', () => {
    expect(opens({ shortcutHelp: false }, { panel: 'shortcuts' })).toBe(false)
    expect(opens({ shortcutHelp: true }, { panel: 'shortcuts' })).toBe(true)
  })

  it('can be opened in a private window: it lists keys, it keeps nothing', () => {
    expect(canOpenInPrivate('shortcuts')).toBe(true)
    expect(canOpenInPrivate('commandbar')).toBe(true)
  })

  it('keeps the Help menu entry that leads to Réglages › Raccourcis', () => {
    expect(menuOf(stateWith({})).item('Raccourcis clavier essentiels')).toBeDefined()
  })
})
