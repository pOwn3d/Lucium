import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { Browser } from './browser'
import { containerMenuItems } from './container-menu'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }

function fakeBrowser(priv = false) {
  const dispatched: Action[] = []
  const browser = { isPrivate: () => priv, dispatch: (action: Action) => void dispatched.push(action) } as unknown as Browser
  return { browser, dispatched }
}

/** The function on, two containers, and a tab on `url` (in the first container when `inside`). */
function state(url = 'https://www.intranet.example.org/page', inside = false): SidebarState {
  let s = createInitialState(ctx)
  s = reduce(s, { type: 'settings/update', patch: { tabContainers: true } }, ctx)
  s = reduce(s, { type: 'container/create', name: 'Travail' }, ctx)
  s = reduce(s, { type: 'container/create', name: 'Perso' }, ctx)
  s = reduce(s, { type: 'tab/open', url, ...(inside ? { container: s.settings.containers[0]!.id } : {}) }, ctx)
  return s
}

const sub = (item: MenuItemConstructorOptions): MenuItemConstructorOptions[] => item.submenu as MenuItemConstructorOptions[]
const tabOf = (s: SidebarState) => s.tabs[0]!

describe('containerMenuItems', () => {
  it('lists nothing while the function is off, in a private window, for a private tab and without a container', () => {
    const on = state()
    expect(containerMenuItems(fakeBrowser().browser, { ...on, settings: { ...on.settings, tabContainers: false } }, tabOf(on))).toEqual([])
    expect(containerMenuItems(fakeBrowser(true).browser, on, tabOf(on))).toEqual([])
    expect(containerMenuItems(fakeBrowser().browser, on, { ...tabOf(on), private: true })).toEqual([])
    expect(containerMenuItems(fakeBrowser().browser, { ...on, settings: { ...on.settings, containers: [] } }, tabOf(on))).toEqual([])
  })

  it('offers the containers for the tab and for its site, and sends the choice to the reducer', () => {
    const s = state()
    const { browser, dispatched } = fakeBrowser()
    const items = containerMenuItems(browser, s, tabOf(s))
    expect(items.map((i) => i.label)).toEqual(['Ouvrir dans un conteneur', 'Toujours ouvrir intranet.example.org dans'])
    const [work, perso] = s.settings.containers
    expect(sub(items[0]!).map((i) => i.label)).toEqual(['Travail', 'Perso', undefined, 'Sans conteneur'])
    sub(items[0]!)[1]!.click!({} as never, undefined, {} as never)
    sub(items[1]!)[0]!.click!({} as never, undefined, {} as never)
    expect(dispatched).toEqual([
      { type: 'tab/set-container', id: tabOf(s).id, container: perso!.id },
      { type: 'container/rule', host: 'intranet.example.org', container: work!.id }
    ])
  })

  it('checks the container the tab is in and the one its site is sent to, and only then lets them be taken away', () => {
    const outside = state()
    const before = containerMenuItems(fakeBrowser().browser, outside, tabOf(outside))
    expect(sub(before[0]!).map((i) => i.enabled)).toEqual([undefined, undefined, undefined, false])
    expect(sub(before[1]!).at(-1)!.enabled).toBe(false)

    const inside = state('https://intranet.example.org/', true)
    const ruled = reduce(inside, { type: 'container/rule', host: 'intranet.example.org', container: inside.settings.containers[0]!.id }, ctx)
    const items = containerMenuItems(fakeBrowser().browser, ruled, tabOf(ruled))
    expect(sub(items[0]!).slice(0, 2).map((i) => i.checked)).toEqual([true, false])
    expect(sub(items[0]!).at(-1)!.enabled).toBe(true)
    expect(sub(items[1]!).slice(0, 2).map((i) => i.checked)).toEqual([true, false])
    expect(sub(items[1]!).at(-1)!.enabled).toBe(true)
  })

  it('has no "open in" entry for an extension page, and no rule entry for a page that has no site', () => {
    const base = state()
    const extension = { ...tabOf(base), url: `chrome-extension://${'a'.repeat(32)}/options.html` }
    expect(containerMenuItems(fakeBrowser().browser, base, extension)).toEqual([])
    const blank = state('about:blank')
    expect(containerMenuItems(fakeBrowser().browser, blank, tabOf(blank)).map((i) => i.label)).toEqual(['Ouvrir dans un conteneur'])
  })
})
