// The Extensions page is a tab: every way to it (a panel request, the command bar, an extension's button, an address typed) goes through Browser.openExtensionsTab, which
// selects the tab that already has the page or opens one, and says no in a private or guest window. The real methods of the class Browser on a stand-in.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { internalPageUrl } from '@shared/extension-page'
import { t } from '@shared/i18n'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const ID = 'a'.repeat(32)
const PAGE = 'lucium-ui://extensions/'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1, newId: () => `tab-${++n}` }
}

/** A window with a state, and the pages it holds; every action goes through the real reducer so that the tab the window opens is the one the state really holds. */
function window_(options: { isPrivate?: boolean; openFirst?: boolean; livePage?: boolean } = {}) {
  const ctx = makeCtx()
  let state: SidebarState = createInitialState(ctx)
  const dispatched: Action[] = []
  const dispatch = vi.fn((action: Action) => {
    dispatched.push(action)
    state = reduce(state, action, ctx)
  })
  state = reduce(state, { type: 'tab/open', url: 'https://a.example/' }, ctx)
  if (options.openFirst) dispatch({ type: 'tab/open', url: PAGE, allowInternalPages: true, background: true })
  const loaded: string[] = []
  // The page of the tab the window opened first, when it is a live one (a tab that sleeps has none).
  const pages = new Map(options.livePage ? state.tabs.filter((tab) => tab.url === PAGE).map((tab) => [tab.id, { loadURL: (url: string) => void loaded.push(url) }]) : [])
  const toasts: string[] = []
  const fake = fakeBrowser({
    store: { get: () => state },
    pages,
    dispatch,
    isPrivate: () => options.isPrivate === true,
    showToast: (message: string) => void toasts.push(message),
    searchTemplateFor: shell['searchTemplateFor'],
    openExtensionsTab: shell['openExtensionsTab'],
    closeOverlay: () => undefined,
    openOverlay: shell['openOverlay'],
    submitUrl: shell['submitUrl'],
    activePage: () => undefined,
    setTabAddress: shell['setTabAddress']
  })
  return { call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), dispatch, get state() { return state }, dispatched, toasts, loaded }
}

const internalTabs = (state: SidebarState) => state.tabs.filter((tab) => tab.url.startsWith('lucium-ui://'))

describe('Browser.openExtensionsTab', () => {
  it('opens the page in a tab of the active space when the window has none, and selects it', () => {
    const w = window_()
    w.call('openExtensionsTab')
    expect(internalTabs(w.state)).toHaveLength(1)
    const tab = internalTabs(w.state)[0]!
    expect(tab).toMatchObject({ url: PAGE, spaceId: w.state.activeSpaceId })
    expect(w.state.activeTabBySpace[tab.spaceId]).toBe(tab.id)
    expect(w.dispatched.at(-1)).toMatchObject({ type: 'tab/open', url: PAGE, allowInternalPages: true })
  })

  it('opens it at the view asked for: the extension, its profile, the shortcuts', () => {
    for (const target of [{ view: 'shortcuts' }, { view: 'detail', extensionId: ID }, { view: 'detail', extensionId: ID, profileId: 'work' }] as const) {
      const w = window_()
      w.call('openExtensionsTab', target)
      expect(internalTabs(w.state)[0]?.url).toBe(internalPageUrl(target))
    }
  })

  it('selects the tab that already has the page instead of opening a second one, whatever the view it is on', () => {
    const w = window_({ openFirst: true })
    expect(internalTabs(w.state)).toHaveLength(1)
    const [tab] = internalTabs(w.state)
    w.call('openExtensionsTab')
    expect(internalTabs(w.state)).toHaveLength(1)
    expect(w.state.activeTabBySpace[tab!.spaceId]).toBe(tab!.id)
    w.call('openExtensionsTab', { view: 'shortcuts' })
    expect(internalTabs(w.state)).toHaveLength(1)
  })

  it('sends the page it already has to the view asked for: the state first, and the live page too', () => {
    const w = window_({ openFirst: true })
    const [tab] = internalTabs(w.state)
    const live = window_({ openFirst: true, livePage: true })
    w.call('openExtensionsTab', { view: 'detail', extensionId: ID })
    expect(internalTabs(w.state)[0]?.url).toBe(internalPageUrl({ view: 'detail', extensionId: ID }))
    expect(internalTabs(w.state)[0]?.id).toBe(tab!.id)
    // A tab with no page (asleep) is not loaded from here: it loads the view when it wakes.
    expect(w.loaded).toEqual([])
    // A live page is loaded at the address (a sleeping tab loads it when it wakes).
    live.call('openExtensionsTab', { view: 'detail', extensionId: ID })
    expect(live.loaded).toEqual([internalPageUrl({ view: 'detail', extensionId: ID })])
    // Already on that view: nothing is loaded again.
    live.loaded.length = 0
    live.call('openExtensionsTab', { view: 'detail', extensionId: ID })
    expect(live.loaded).toEqual([])
  })

  it('finds the page in another space of the window, and brings that space forward', () => {
    const w = window_({ openFirst: true })
    const [tab] = internalTabs(w.state)
    w.dispatch({ type: 'space/create', name: 'Autre', emoji: '🌿', hue: 120 })
    const other = w.state.spaces.find((space) => space.id !== tab!.spaceId)!
    w.dispatch({ type: 'space/select', id: other.id })
    expect(w.state.activeSpaceId).toBe(other.id)
    w.call('openExtensionsTab')
    expect(internalTabs(w.state)).toHaveLength(1)
    expect(w.state.activeSpaceId).toBe(tab!.spaceId)
    expect(w.state.activeTabBySpace[tab!.spaceId]).toBe(tab!.id)
  })

  it('opens the page in the active space when it is not the first', () => {
    const w = window_()
    w.dispatch({ type: 'space/create', name: 'Autre', emoji: '🌿', hue: 120 })
    const other = w.state.spaces.at(-1)!
    w.dispatch({ type: 'space/select', id: other.id })
    w.call('openExtensionsTab')
    expect(internalTabs(w.state)[0]?.spaceId).toBe(other.id)
  })

  it('says no in a private or guest window, and opens nothing', () => {
    const w = window_({ isPrivate: true })
    w.call('openExtensionsTab')
    expect(internalTabs(w.state)).toHaveLength(0)
    expect(w.toasts).toEqual([t('browser.les-extensions-ne-fonctionnent-pas-dans-une')])
    w.call('openExtensionsTab', { view: 'shortcuts' })
    expect(internalTabs(w.state)).toHaveLength(0)
  })

  it('is what the panel request of the extensions, and chrome://extensions typed in the command bar, come to', () => {
    const w = window_()
    w.call('openOverlay', { panel: 'extensions', target: { view: 'shortcuts' } })
    expect(internalTabs(w.state)[0]?.url).toBe(internalPageUrl({ view: 'shortcuts' }))
    // Without a target (the button of the row of the extensions in the panel of the site): the whole page.
    const whole = window_()
    whole.call('openOverlay', { panel: 'extensions' })
    expect(internalTabs(whole.state).map((tab) => tab.url)).toEqual([PAGE])
    const typed = window_()
    typed.call('submitUrl', `chrome://extensions/?id=${ID}&profile=work`, 'current')
    expect(internalTabs(typed.state)[0]?.url).toBe(internalPageUrl({ view: 'detail', extensionId: ID, profileId: 'work' }))
    const arc = window_()
    arc.call('submitUrl', 'arc://extensions', 'new')
    expect(internalTabs(arc.state)[0]?.url).toBe(PAGE)
    // Typed twice, it is the same tab.
    arc.call('submitUrl', 'chrome://extensions', 'new')
    expect(internalTabs(arc.state)).toHaveLength(1)
  })

  it('is what chrome://extensions typed in the editor of the address of a tab comes to, over the page itself or any other tab', () => {
    const w = window_({ openFirst: true })
    const web = w.state.tabs.find((tab) => tab.url === 'https://a.example/')!
    w.call('setTabAddress', web.id, 'chrome://extensions/shortcuts')
    expect(internalTabs(w.state)).toHaveLength(1)
    expect(internalTabs(w.state)[0]?.url).toBe(internalPageUrl({ view: 'shortcuts' }))
    w.call('setTabAddress', internalTabs(w.state)[0]!.id, 'chrome://extensions')
    expect(internalTabs(w.state)).toHaveLength(1)
    expect(internalTabs(w.state)[0]?.url).toBe(PAGE)
    // The tab of the web stays where it was: it is not sent to a search.
    expect(w.state.tabs.find((tab) => tab.id === web.id)?.url).toBe('https://a.example/')
  })

  it('is not what an address that only looks like the page comes to: it is a search', () => {
    const w = window_()
    w.call('submitUrl', 'lucium-ui://extensions/', 'new')
    expect(internalTabs(w.state)).toHaveLength(0)
    expect(w.state.tabs.at(-1)?.url).toMatch(/^https:\/\//)
  })
})

describe('the pages of the Extensions page in a window', () => {
  const maps = ['scopeGuards', 'pages', 'privatePages', 'pageContainer', 'permissionAnswers', 'permissionPages', 'authAnswers', 'reviewAnswers', 'dialogAnswers', 'leaveAnswers', 'passphraseAnswers']

  it('are reconciled with the console of the extensions when the page of a tab is let go, and when the window stops', () => {
    const dropped = fakeBrowser({ store: { get: () => ({ tabs: [] }) }, runtime: { tabs: {} } })
    shell['dropPageState']!.call(dropped.self, 'gone')
    expect(dropped.names()).toContain('internalPages.reconcile')
    const stopped = fakeBrowser({
      ...Object.fromEntries(maps.map((name) => [name, new Map()])),
      ...Object.fromEntries(['passwordView', 'floatTimer', 'splitDrag', 'tabDragExpiry'].map((name) => [name, null])),
      group: new Set(),
      dialogQueue: []
    })
    shell['stop']!.call(stopped.self)
    expect(stopped.names()).toContain('internalPages.dispose')
  })

  it('are sent the reduced snapshot with each publication of the window, with the lock as the window says it', () => {
    const snapshot = { state: { settings: {} }, extensions: [], platform: 'darwin', lock: { appLocked: true } }
    const sent: unknown[] = []
    const fake = fakeBrowser({ publishListeners: [], snapshot: () => snapshot, win: { webContents: { isDestroyed: () => false, send: () => undefined } }, surfaces: new Map(), floating: { current: () => null }, overlayRequest: null, internalPages: { publish: (...args: unknown[]) => void sent.push(args) } })
    shell['publishHere']!.call(fake.self)
    expect(sent).toEqual([[snapshot, true]])
    sent.length = 0
    const unlocked = fakeBrowser({ publishListeners: [], snapshot: () => ({ ...snapshot, lock: undefined }), win: { webContents: { isDestroyed: () => false, send: () => undefined } }, surfaces: new Map(), floating: { current: () => null }, overlayRequest: null, internalPages: { publish: (...args: unknown[]) => void sent.push(args) } })
    shell['publishHere']!.call(unlocked.self)
    expect((sent[0] as unknown[])[1]).toBe(false)
  })

  it('are reconciled when a page is made for a tab and when a window takes the page of another', () => {
    const source = readFileSync(join(__dirname, 'browser-pages.ts'), 'utf8')
    // The three places a window gains or loses a page: its creation (`ensurePage`), its end (`dropPageState`, which an adoption also calls in the window that gives it up) and its adoption.
    expect(source.match(/this\.internalPages\.reconcile\(\)/g)).toHaveLength(3)
  })
})
