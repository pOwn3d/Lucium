// The events of a page are made once, when the page is created. What they do later is about the tab as it is then: the site it shows now and the
// space it is in now, not those it started with. The real methods of the shell run on a stand-in for the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { PageEvents } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const FIRST = 'https://premier.example/page'
const SECOND = 'https://second.example/autre'

/** A page created while its tab was on `FIRST` in the first space; the tab has since gone to `SECOND` and been moved to another space. */
function movedTab() {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  let state: SidebarState = reduce(createInitialState(ctx), { type: 'tab/open', url: FIRST }, ctx)
  const created = state.tabs.find((tab) => tab.url === FIRST)!
  const dispatched: Action[] = []
  const opened: OverlayRequest[] = []
  const fake = fakeBrowser({
    store: { get: () => state },
    dispatch: (action: Action) => void dispatched.push(action),
    openOverlay: (request: OverlayRequest) => void opened.push(request),
    isPrivate: () => false,
    littleOpener: null,
    visible: new Set([created.id]),
    blankTabs: { applyFromTab: (_id: string, _url: string, _byPage: boolean, open: () => void) => open(), closeOpenedBy: () => undefined },
    openedBy: (_who: string, open: () => void) => open(),
    treeParent: () => ({}),
    searchTemplateFor: () => 'https://recherche.example/?q=%s',
    tabNow: shell['tabNow'],
    inheritedContainer: shell['inheritedContainer'],
    openTabFromPage: shell['openTabFromPage']
  })
  const events = shell['pageEvents']!.call(fake.self, created) as PageEvents
  const elsewhere = { ...state.spaces[0]!, id: 'space-elsewhere', name: 'Ailleurs' }
  state = { ...state, spaces: [...state.spaces, elsewhere], tabs: state.tabs.map((tab) => (tab.id === created.id ? { ...tab, url: SECOND, title: 'Second site', spaceId: elsewhere.id } : tab)) }
  return { events, created, dispatched, opened, elsewhere }
}

describe('what a page asks for after its tab moved on', () => {
  it('« Créer un raccourci pour ce site » is for the site the tab shows now', () => {
    const w = movedTab()
    w.events.createShortcut!()
    expect(w.opened).toEqual([{ panel: 'shortcut', url: SECOND, title: 'Second site' }])
  })

  it('a link that opens a tab opens it in the space the tab is in now', () => {
    const w = movedTab()
    w.events.openWindow('https://lien.example/', 'foreground')
    expect(w.dispatched).toHaveLength(1)
    expect(w.dispatched[0]).toMatchObject({ type: 'tab/open', url: 'https://lien.example/', spaceId: w.elsewhere.id })
    expect(w.created.spaceId).not.toBe(w.elsewhere.id)
  })

  it('a search for the selected text opens in the space the tab is in now', () => {
    const w = movedTab()
    w.events.searchSelection('chats')
    expect(w.dispatched).toHaveLength(1)
    expect(w.dispatched[0]).toMatchObject({ type: 'tab/open', url: 'https://recherche.example/?q=chats', spaceId: w.elsewhere.id })
  })

  it('a page whose tab is gone from the state still answers with the tab it was created for', () => {
    const w = movedTab()
    const gone = { ...w.created, id: 'tab-gone' }
    expect(shell['tabNow']!.call({ store: { get: () => ({ tabs: [] }) } }, gone)).toBe(gone)
  })
})
