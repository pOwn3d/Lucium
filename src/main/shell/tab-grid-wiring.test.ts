// The tab overview (setting `tabGrid`) is a function of its own: off, its menu entry is hidden and its key dead, the command bar does not offer it, and the main
// process refuses the panel whoever asks. On, the pictures are the main process's to give: the interface cannot hand the panel one, and a private window or a private tab has none.

import { describe, expect, it, vi } from 'vitest'
import { rankCandidates } from '@shared/command-bar'
import { defaultSettings, type SidebarState, type TabItem } from '@shared/model'
import { canOpenInPrivate } from '@shared/private-window'
import { canOpenWhileLocked } from '@shared/lock'
import { createInitialState } from '@shared/sidebar'
import { Channel, type OverlayRequest } from '@shared/ipc'
import { methodsOf, overlayHost, type FakeBrowser } from './browser-fake.test-support'

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

const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 'space', title: id, url: `https://${id}.example/`, lastActiveAt: 1, createdAt: 1, ...extra }) as TabItem

const stateWith = (patch: Partial<SidebarState['settings']>, tabs: TabItem[] = []): SidebarState => {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  return { ...base, tabs, settings: { ...defaultSettings(), ...patch } }
}
const storeOf = (state: SidebarState) => ({ get: () => state })

/** What the window's own `openOverlay` sent to the layer for this request, or null when it showed nothing. */
function sent(settings: Partial<SidebarState['settings']>, request: OverlayRequest, own: Record<string, unknown> = {}): { request: OverlayRequest | null; fake: FakeBrowser } {
  const fake = overlayHost(settings, own)
  shell['openOverlay']!.call(fake.self, request)
  const call = fake.calls.find((c) => c.name === 'overlay.webContents.send' && c.args[0] === Channel.showOverlay)
  return { request: (call?.args[1] as OverlayRequest | undefined) ?? null, fake }
}

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

const LABEL = 'Vue d’ensemble des onglets'

describe('the tab overview, a function of its own', () => {
  it('is off by default', () => {
    expect(defaultSettings().tabGrid).toBe(false)
  })

  it('is opened by the interface when the function is on, and refused when it is off; the interface cannot give it pictures', () => {
    expect(validOverlay({ panel: 'tabgrid' }, storeOf(stateWith({ tabGrid: true })))).toBe(true)
    expect(validOverlay({ panel: 'tabgrid' }, storeOf(stateWith({ tabGrid: false })))).toBe(false)
    expect(validOverlay({ panel: 'tabgrid', pictures: { a: 'data:image/jpeg;base64,AAAA' } }, storeOf(stateWith({ tabGrid: true })))).toBe(false)
  })

  it('has its entry in the Tabs menu with ⇧⌘O while on; off, the entry is hidden and its key is dead', () => {
    expect(menuOf(stateWith({ tabGrid: true })).item(LABEL)).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+O', visible: true, enabled: true })
    expect(menuOf(stateWith({ tabGrid: false })).item(LABEL)).toMatchObject({ visible: false, enabled: false })
  })

  it('follows the key the user gave it', () => {
    expect(menuOf(stateWith({ tabGrid: true, keyBindings: { tabGrid: 'CmdOrCtrl+Alt+Shift+O' } })).item(LABEL)!.accelerator).toBe('CmdOrCtrl+Alt+Shift+O')
    expect(menuOf(stateWith({ tabGrid: true, keyBindings: { tabGrid: '' } })).item(LABEL)!.accelerator).toBeUndefined()
  })

  it('opens the panel, and closes it when the same key is pressed over it', () => {
    const closed = menuOf(stateWith({ tabGrid: true }))
    closed.item(LABEL)!.click!()
    expect(closed.opened).toEqual([{ panel: 'tabgrid' }])
    const over = menuOf(stateWith({ tabGrid: true }), { panel: 'tabgrid' })
    over.item(LABEL)!.click!()
    expect(over.opened).toEqual([])
    expect(over.closed()).toBe(1)
  })

  it('is refused by the main process itself when the function is off: no caller can open it', () => {
    expect(sent({ tabGrid: false }, { panel: 'tabgrid' }).request).toBeNull()
    expect(sent({ tabGrid: true }, { panel: 'tabgrid' }).request).toMatchObject({ panel: 'tabgrid' })
  })

  it('is offered by the command bar when typed, while on only', () => {
    const offered = (patch: Partial<SidebarState['settings']>) => rankCandidates('vue d’ensemble', stateWith(patch)).find((c) => c.kind === 'action' && c.action === 'tab-grid')
    expect(offered({ tabGrid: true })).toMatchObject({ label: LABEL })
    expect(offered({ tabGrid: false })).toBeUndefined()
  })

  it('may be opened in a private window, and not over the lock screen', () => {
    expect(canOpenInPrivate('tabgrid')).toBe(true)
    expect(canOpenWhileLocked('tabgrid', true)).toBe(false)
    expect(canOpenWhileLocked('tabgrid', false)).toBe(true)
  })
})

describe('the pictures of the tab overview', () => {
  const tabs = [tab('a', { lastActiveAt: 2 }), tab('b', { lastActiveAt: 1 }), tab('p', { lastActiveAt: 9, private: true })]
  const pictureOf = (id: string) => (id === 'b' ? null : `data:image/jpeg;base64,${id}`)
  const own = (extra: Record<string, unknown> = {}) => ({ store: { get: () => stateWith({ tabGrid: true }, tabs) }, thumbnailSource: { get: pictureOf, forgetLocked: () => {} }, isPrivate: () => false, ...extra })

  it('are the ones the hover cards took, for the tabs that have one, never for a private tab', () => {
    const { request } = sent({ tabGrid: true }, { panel: 'tabgrid' }, own())
    expect(request).toEqual({ panel: 'tabgrid', pictures: { a: 'data:image/jpeg;base64,a' } })
  })

  it('are none in a private window', () => {
    const { request } = sent({ tabGrid: true }, { panel: 'tabgrid' }, own({ isPrivate: () => true }))
    expect(request).toEqual({ panel: 'tabgrid', pictures: {} })
  })

  it('are none when the pictures are not taken at all (no source)', () => {
    const { request } = sent({ tabGrid: true }, { panel: 'tabgrid' }, own({ thumbnailSource: null }))
    expect(request).toEqual({ panel: 'tabgrid', pictures: {} })
  })

  it('are never taken from the request: a picture that came with it is dropped', () => {
    const { request } = sent({ tabGrid: true }, { panel: 'tabgrid', pictures: { a: 'data:image/jpeg;base64,FORGED' } }, own({ thumbnailSource: null }))
    expect(request).toEqual({ panel: 'tabgrid', pictures: {} })
  })
})
