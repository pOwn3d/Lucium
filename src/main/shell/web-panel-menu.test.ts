import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { Browser } from './browser'
import { webPanelMenuItems } from './web-panel-menu'
import { frenchSpaces } from '@shared/french-typography'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

function fakeBrowser(priv = false) {
  const calls: string[] = []
  const dispatched: Action[] = []
  const browser = {
    isPrivate: () => priv,
    dispatch: (action: Action) => void dispatched.push(action),
    openWebPanel: (id: string) => void calls.push(`open:${id}`),
    addWebPanelFromPage: () => void calls.push('add'),
    closeWebPanel: () => void calls.push('close')
  } as unknown as Browser
  return { browser, calls, dispatched }
}

/** A state with two spaces, the first on screen with a page, three sites in the second. */
function state(enabled: boolean, page = 'https://news.example/'): SidebarState {
  let s = createInitialState(ctx)
  s = reduce(s, { type: 'settings/update', patch: { webPanels: true } }, ctx)
  s = reduce(s, { type: 'tab/open', url: page }, ctx)
  s = reduce(s, { type: 'space/panel-add', id: s.spaces[0]!.id, panelId: 'wa', url: 'https://web.whatsapp.com/', title: 'WhatsApp' }, ctx)
  s = reduce(s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
  s = reduce(s, { type: 'space/panel-add', id: s.spaces[1]!.id, panelId: 'ch', url: 'https://chat.example/', title: 'Discussion' }, ctx)
  s = reduce(s, { type: 'space/select', id: s.spaces[0]!.id }, ctx)
  return enabled ? s : { ...s, settings: { ...s.settings, webPanels: false } }
}

const labels = (items: MenuItemConstructorOptions[]): string[] => items.flatMap((i) => [i.label ?? '', ...(Array.isArray(i.submenu) ? labels(i.submenu) : [])]).filter(Boolean)
const submenuOf = (items: MenuItemConstructorOptions[]) => items[0]!.submenu as MenuItemConstructorOptions[]
const find = (items: MenuItemConstructorOptions[], label: string) => submenuOf(items).find((i) => i.label === label)!

describe('webPanelMenuItems', () => {
  it('lists nothing while the function is off, and nothing in a private window', () => {
    const off = state(false)
    expect(webPanelMenuItems(fakeBrowser().browser, off, off.spaces[0]!)).toEqual([])
    const on = state(true)
    expect(webPanelMenuItems(fakeBrowser(true).browser, on, on.spaces[0]!)).toEqual([])
  })

  it('has one submenu, "Volets web", with an entry to open each site of the space, add the page, remove a site and put the panel away', () => {
    const on = state(true)
    const items = webPanelMenuItems(fakeBrowser().browser, on, on.spaces[0]!)
    expect(items).toHaveLength(1)
    expect(items[0]!.label).toBe('Volets web')
    expect(labels(items)).toEqual(['Volets web', frenchSpaces('Ouvrir « WhatsApp » en volet'), 'Ajouter la page en volet web', 'Retirer un volet web', 'WhatsApp', 'Fermer le volet web'])
  })

  it('opens a site of the space on screen directly', () => {
    const on = state(true)
    const { browser, calls, dispatched } = fakeBrowser()
    const items = webPanelMenuItems(browser, on, on.spaces[0]!)
    ;(find(items, frenchSpaces('Ouvrir « WhatsApp » en volet')).click as () => void)()
    expect(calls).toEqual(['open:wa'])
    expect(dispatched).toEqual([])
  })

  it('goes to the space first when the site is one of another space (its pages use that space\'s profile)', () => {
    const on = state(true)
    const { browser, calls, dispatched } = fakeBrowser()
    const items = webPanelMenuItems(browser, on, on.spaces[1]!)
    ;(find(items, frenchSpaces('Ouvrir « Discussion » en volet')).click as () => void)()
    expect(dispatched).toEqual([{ type: 'space/select', id: on.spaces[1]!.id }])
    expect(calls).toEqual(['open:ch'])
  })

  it('offers to add the page only for the space on screen, and only when the page can be a panel and is not one already', () => {
    const on = state(true)
    expect(find(webPanelMenuItems(fakeBrowser().browser, on, on.spaces[0]!), 'Ajouter la page en volet web').enabled).toBe(true)
    expect(find(webPanelMenuItems(fakeBrowser().browser, on, on.spaces[1]!), 'Ajouter la page en volet web').enabled).toBe(false)
    const already = state(true, 'https://web.whatsapp.com/')
    expect(find(webPanelMenuItems(fakeBrowser().browser, already, already.spaces[0]!), 'Ajouter la page en volet web').enabled).toBe(false)
    const local = state(true, 'file:///Users/me/notes.html')
    expect(find(webPanelMenuItems(fakeBrowser().browser, local, local.spaces[0]!), 'Ajouter la page en volet web').enabled).toBe(false)
  })

  it('removes the site that is chosen, from the space the menu is about', () => {
    const on = state(true)
    const { browser, dispatched } = fakeBrowser()
    const items = webPanelMenuItems(browser, on, on.spaces[1]!)
    const remove = find(items, 'Retirer un volet web').submenu as MenuItemConstructorOptions[]
    ;(remove[0]!.click as () => void)()
    expect(dispatched).toEqual([{ type: 'space/panel-remove', id: on.spaces[1]!.id, panelId: 'ch' }])
  })

  it('greys out removal for a space with no site, and still offers to add', () => {
    const base = state(true)
    const bare = { ...base, spaces: base.spaces.map((s) => ({ ...s, webPanels: undefined })) } as SidebarState
    const items = webPanelMenuItems(fakeBrowser().browser, bare, bare.spaces[0]!)
    expect(labels(items)).toEqual(['Volets web', 'Ajouter la page en volet web', 'Retirer un volet web', 'Fermer le volet web'])
    expect(find(items, 'Retirer un volet web').enabled).toBe(false)
  })

  it('puts the panel away', () => {
    const on = state(true)
    const { browser, calls } = fakeBrowser()
    ;(find(webPanelMenuItems(browser, on, on.spaces[0]!), 'Fermer le volet web').click as () => void)()
    expect(calls).toEqual(['close'])
    vi.restoreAllMocks()
  })
})
