// A tab an extension opens in the background (`chrome.tabs.create({ active: false })`) as the shell makes it (Browser.openTabForExtension), on a
// stand-in of the class Browser. The extension runtime reports every page it is given as the active one, and the shell follows that report with a
// selection unless it is told to keep quiet: the page of a background tab is made quietly, and the runtime is then told which tab is on screen.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState, TabItem } from '@shared/model'
import { activeTab, createInitialState, reduce } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A window with one tab on screen, whose runtime of extensions selects every page it is given, as the real one does. */
function windowWithOneTab() {
  let n = 0
  const ctx = { now: 0, newId: () => `id-${n++}` }
  let state: SidebarState = createInitialState(ctx)
  const dispatch = (action: Parameters<typeof reduce>[1]): void => {
    state = reduce(state, action, ctx)
  }
  dispatch({ type: 'tab/open', url: 'https://on-screen.example/' })
  const onScreen = state.tabs.at(-1)!.id
  const pages = new Map<string, object>([[onScreen, {}]])
  const told: string[] = []
  const fake = fakeBrowser({
    quietPages: false,
    pages,
    store: { get: () => state },
    dispatch,
    openedBy: (_origin: string, open: () => void) => open(),
    isTabLocked: () => false,
    engine: { listExtensions: () => [], activatePage: (id: string) => told.push(id) },
    // What the hook of the runtime does when a page is made (browser.ts, `selectTab`): the tab is selected, unless the window keeps quiet.
    ensurePage(this: { quietPages: boolean }, tab: TabItem) {
      pages.set(tab.id, {})
      if (!this.quietPages) dispatch({ type: 'tab/select', id: tab.id })
    }
  })
  const open = (active: boolean, url = 'https://asked.example/') => shell['openTabForExtension']!.call(fake.self, url, active) as Promise<string>
  return { fake, open, onScreen, told, pages, tabs: () => state.tabs.map((t) => t.id), shown: () => activeTab(state)?.id }
}

describe('a tab opened by an extension', () => {
  it('stays in the background when the extension asked for that, and the runtime is told which tab is on screen', async () => {
    const win = windowWithOneTab()
    const id = await win.open(false)
    expect(id).not.toBe(win.onScreen)
    expect(win.shown()).toBe(win.onScreen)
    expect(win.told).toEqual([win.onScreen])
    // The window listens to the runtime again afterwards.
    expect(win.fake.self['quietPages']).toBe(false)
  })

  it('is shown when the extension asked for an active tab', async () => {
    const win = windowWithOneTab()
    const id = await win.open(true)
    expect(win.shown()).toBe(id)
    expect(win.told).toEqual([])
  })
})

// The state refuses some addresses (`data:`, `blob:`, one too long…) and opens nothing. The extension must then be told so: the last tab of the
// state is the user's (it may be a tab of another profile), and handing it over would let the extension read it, navigate it or close it.
describe('a tab an extension asks for at an address that does not open in a tab', () => {
  for (const url of ['data:text/html,x', 'blob:https://asked.example/0b7c2f0e-1111-4222-8333-444455556666', 'ftp://asked.example/file', `https://asked.example/#${'x'.repeat(70_000)}`]) {
    for (const active of [true, false]) {
      it(`is an error for the extension, never another tab (${url.slice(0, 24)}…, ${active ? 'active' : 'in the background'})`, async () => {
        const win = windowWithOneTab()
        await expect(win.open(active, url)).rejects.toThrow('cannot be opened in a tab')
        // Nothing was opened, no page was made for the tab that was there, and the runtime was told nothing about it.
        expect(win.tabs()).toEqual([win.onScreen])
        expect([...win.pages.keys()]).toEqual([win.onScreen])
        expect(win.told).toEqual([])
        expect(win.shown()).toBe(win.onScreen)
      })
    }
  }

  it('is still the new tab when the address opens, with other tabs already there', async () => {
    const win = windowWithOneTab()
    const first = await win.open(true)
    const second = await win.open(false)
    expect(new Set([win.onScreen, first, second]).size).toBe(3)
    expect(win.tabs()).toEqual([win.onScreen, first, second])
  })
})
