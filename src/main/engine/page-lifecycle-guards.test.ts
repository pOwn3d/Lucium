// Guards of the life of a page (the engine checks exercise them in a running Electron: smoke-privacy2, smoke-popups, smoke-dialogs, smoke-sessionsplus).
// Here they run on fakes: the page of the engine and its popups over event emitters (electron-page.test-support.ts), `ElectronEngine.createPage`
// and `ensureProfile` over the real library, and the shell's methods (`ensurePage`, `sync`) on stand-ins (the classes reach Electron only when a method runs).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { displaySite } from '@shared/error-pages'
import { t } from '@shared/i18n'
import { pageDialogPreferences, safeDialogsMessage } from '@shared/page-dialog'
import { POPUP_MIN_SIZE, popupContentBounds } from '@shared/popup'
import { defaultSettings, type TabItem } from '@shared/model'
import { fakeBrowser } from '../shell/browser-fake.test-support'
import { syncHost } from '../shell/sync-host.test-support'
import { inertEngine, madeSessions } from '../profile-made.test-support'
import { engineForPages, FakePageContents, FakePopupWindow, FakeWindow, itemLabelled, madeViews, makePage, settle } from './electron-page.test-support'
import { played, resetPlayedPlatform } from '../platform/platform.test-support'

vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('../profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))
// The platform layer of macOS on any machine, and of another system when a test asks: a popup is wired through it (its menu bar).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

const { ElectronEngine } = await import('./electron-engine')
const { HttpsUpgrades } = await import('./https-upgrade')
const { PopupWindows } = await import('./popup-windows')
const { Browser } = await import('../shell/browser')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** A tab whose page opened a popup: the window Electron made for it, wired by `PopupWindows`. */
function popupOfTab() {
  const upgrades = new HttpsUpgrades()
  const popups = new PopupWindows(upgrades, () => 'allow')
  const owner = { key: 'tab-1', contents: new FakePageContents(), win: new FakeWindow(), events: { openWindow: vi.fn() }, scope: null }
  popups.watch(owner as never)
  const win = new FakePopupWindow(2)
  owner.contents.emit('did-create-window', win)
  return { popups, owner, win, contents: win.webContents }
}

/** The events the shell gives the page of `tab`, on a stand-in of the shell. */
function shellEventsOf(tab: TabItem, shell: Record<string, unknown>, current: () => boolean = () => true) {
  return shellMethods['pageEvents']!.call(shell, tab, current) as Record<string, (...args: unknown[]) => unknown>
}

const TAB: TabItem = { id: 'tab-1', spaceId: 's', url: 'https://site.example/', title: 'Site', pinned: false, createdAt: 1, lastActiveAt: 1 }

beforeEach(() => {
  madeViews.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlayedPlatform()
})

describe('the engine and a page rebuilt under the same id', () => {
  it('forgets a page when it is destroyed only if it is still the one registered under its id', async () => {
    const { engine, create } = (await engineForPages())
    const first = create('t')
    const second = create('t')
    // `close()` is asynchronous: the first page goes long after the second one was registered under the same id.
    first.view.webContents.emit('destroyed')
    expect(engine.pages.get('t')).toBe(second.page)
    second.view.webContents.emit('destroyed')
    expect(engine.pages.has('t')).toBe(false)
  })
})

describe('the boxes of alert() and confirm()', () => {
  it('are protected against a page that opens them in a row, with the sentence of the box of prompt()', () => {
    expect(pageDialogPreferences().safeDialogs).toBe(true)
    expect(pageDialogPreferences().safeDialogsMessage).toBe(safeDialogsMessage())
    expect(safeDialogsMessage()).toContain('Empêcher cette page')
  })

  it('are given to the pages of tabs and to popups', async () => {
    const { view } = (await engineForPages()).create('t')
    expect(view.options.webPreferences).toMatchObject(pageDialogPreferences())
    const { popups, owner } = popupOfTab()
    const response = popups.request(owner as never, { url: 'https://login.example/', disposition: 'new-window', features: 'width=400,height=500' } as never, { kind: 'popup', opener: true, size: { width: 400, height: 500 } })
    expect(response?.overrideBrowserWindowOptions?.webPreferences).toMatchObject(pageDialogPreferences())
  })
})

describe('the engine and what an extension was lent of a tab', () => {
  it('tells the loans of each document a tab of a profile shows, so that one ends when the tab leaves its site', async () => {
    const { engine, create } = await engineForPages({ ready: null })
    const { view } = create('t')
    view.webContents.emit('did-navigate', {}, 'https://bank.example/account')
    expect(engine.activeTabs.navigated).toHaveBeenCalledExactlyOnceWith(view.webContents.id, 'https://bank.example/account')
    // A panel of an extension is not a tab, and a private page is none an extension sees: nothing was lent of them.
    const panel = create('p', undefined, true)
    panel.view.webContents.emit('did-navigate', {}, 'https://bank.example/')
    const privately = await engineForPages()
    privately.create('t').view.webContents.emit('did-navigate', {}, 'https://bank.example/')
    expect(engine.activeTabs.navigated).toHaveBeenCalledTimes(1)
    expect(privately.engine.activeTabs.navigated).not.toHaveBeenCalled()
  })

  it('forgets the style sheets an extension put in a tab when the tab shows a new document, and when it closes: their keys mean nothing in the next document', async () => {
    const { engine, create } = await engineForPages({ ready: null })
    const { view } = create('t')
    const tabNumber = view.webContents.id
    const held = (id: number) => `${'a'.repeat(32)}:${id}:a:body { color: red }`
    const lent = engine.lentStyles
    lent.set(held(tabNumber), 'key-1')
    lent.set(held(tabNumber + 1000), 'key-2')
    // A page that moves inside its document (pushState, a link to an anchor) keeps its sheets: it is not another document.
    view.webContents.emit('did-navigate-in-page', {}, 'https://bank.example/account#top')
    expect([...lent.keys()]).toEqual([held(tabNumber), held(tabNumber + 1000)])
    view.webContents.emit('did-navigate', {}, 'https://bank.example/account')
    expect([...lent.keys()]).toEqual([held(tabNumber + 1000)])
    lent.set(held(tabNumber), 'key-3')
    view.webContents.emit('destroyed')
    expect([...lent.keys()]).toEqual([held(tabNumber + 1000)])
  })

  it('tells the captures of the sound of the tab where it went, after the loans were judged: a capture lasts while the extension still holds the tab', async () => {
    const { engine, create } = await engineForPages({ ready: null })
    const calls: string[] = []
    engine.activeTabs.navigated.mockImplementation(() => void calls.push('loans'))
    engine.tabCaptures.targetNavigated.mockImplementation(() => void calls.push('captures'))
    const { view } = create('t')
    view.webContents.emit('did-navigate', {}, 'https://bank.example/account')
    expect(engine.tabCaptures.targetNavigated).toHaveBeenCalledExactlyOnceWith(view.webContents.id, 'https://bank.example/account')
    expect(calls).toEqual(['loans', 'captures'])
    // Nothing is captured of a panel of an extension or of a private page.
    create('p', undefined, true).view.webContents.emit('did-navigate', {}, 'https://bank.example/')
    const privately = await engineForPages()
    privately.create('t').view.webContents.emit('did-navigate', {}, 'https://bank.example/')
    expect(engine.tabCaptures.targetNavigated).toHaveBeenCalledTimes(1)
    expect(privately.engine.tabCaptures.targetNavigated).not.toHaveBeenCalled()
  })
})

describe('a tab is not held by its page, nor sent off the web by a redirect', () => {
  // A page that loaded while it was out of sight can come on screen as a black rectangle until it is reloaded: it is drawn again as it is shown, and only
  // then (not at each move of its box).
  it('asks for the whole page to be drawn again when it comes on screen, and not when it only moves', async () => {
    const { page, wc } = await makePage()
    const bounds = { x: 0, y: 0, width: 800, height: 600 }
    page.show(bounds)
    expect(wc.invalidate).toHaveBeenCalledTimes(1)
    page.show({ ...bounds, width: 700 })
    expect(wc.invalidate).toHaveBeenCalledTimes(1)
    page.hide()
    page.show(bounds)
    expect(wc.invalidate).toHaveBeenCalledTimes(2)
  })

  it('asks the user before it lets a page that is on screen go, and keeps a page nobody looks at without a word (the popup always lets go)', async () => {
    const askLeave = vi.fn(async (_site: string) => false)
    const { page, wc } = await makePage({ events: { askLeave } })
    const leaving = () => {
      const event = { preventDefault: vi.fn() }
      wc.emit('will-prevent-unload', event)
      return event.preventDefault.mock.calls.length > 0
    }
    // Not on screen: the page stays as it is (its handler is kept, the navigation does not happen), nobody is asked.
    page.loadURL('https://site.example/suite')
    expect(leaving()).toBe(false)
    expect(askLeave).not.toHaveBeenCalled()
    // On screen, for a navigation the shell started: the user is asked, and the page stays meanwhile.
    page.show({ x: 0, y: 0, width: 800, height: 600 })
    page.loadURL('https://site.example/suite')
    expect(leaving()).toBe(false)
    expect(askLeave).toHaveBeenCalledWith('site.example')
    await settle()

    const { contents } = popupOfTab()
    const event = { preventDefault: vi.fn() }
    contents.emit('will-prevent-unload', event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('asks with the system box, not the sheet, a page that reloads itself once the document the address bar asked for has committed', async () => {
    const { setLeaveAsker } = await import('./unload-guard')
    const boxes: string[] = []
    setLeaveAsker((_win, site) => (boxes.push(site), false))
    try {
      const askLeave = vi.fn(async (_site: string) => false)
      const { page, wc } = await makePage({ events: { askLeave } })
      page.show({ x: 0, y: 0, width: 800, height: 600 })
      page.loadURL('https://site.example/trap')
      wc.url = 'https://site.example/trap'
      wc.emit('did-navigate', {}, 'https://site.example/trap')
      // The page reloads itself at once (well within the time a refusal still belongs to the shell's navigation): that one is not the shell's.
      wc.emit('will-prevent-unload', { preventDefault: vi.fn() })
      expect(askLeave).not.toHaveBeenCalled()
      expect(boxes).toEqual(['site.example'])
    } finally {
      setLeaveAsker(null)
    }
  })

  it('asks again, after "Rester", only once the user has clicked or typed in the page: a page that reloads itself cannot keep the system box up', async () => {
    const { setLeaveAsker } = await import('./unload-guard')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const answers: string[] = []
    setLeaveAsker((_win, site) => (answers.push(site), false))
    try {
      const { page, wc } = await makePage()
      page.show({ x: 0, y: 0, width: 800, height: 600 })
      wc.url = 'https://site.example/form'
      const refuse = () => wc.emit('will-prevent-unload', { preventDefault: vi.fn() })
      // A navigation the page starts itself (a link): the system box; the user stays. Then the page goes on by itself: no box.
      refuse()
      refuse()
      refuse()
      expect(answers).toHaveLength(1)
      // A real click of the user in the page: the next one is asked again.
      wc.click()
      refuse()
      expect(answers).toHaveLength(2)
    } finally {
      setLeaveAsker(null)
      warn.mockRestore()
    }
  })

  it('tells the bridge of a page the user stopped that it is stopped, and starts again with a new document', async () => {
    const { PROMPT_STOPPED } = await import('@shared/page-dialog')
    const promptDialog = vi.fn(async (): Promise<{ value: string | null; suppress: boolean }> => ({ value: 'réponse', suppress: true }))
    const { page, wc } = await makePage({ events: { promptDialog } })
    const replies: unknown[] = []
    const ask = () => page.askDialog('prompt', { message: '?', defaultValue: '' }, 'https://site.example/', (value) => (replies.push(value), true))
    // The user answers and ticks "stop this page": the page gets its answer, the next call gets "stopped" without a box.
    ask()
    await settle()
    ask()
    expect(replies).toEqual(['réponse', PROMPT_STOPPED])
    expect(promptDialog).toHaveBeenCalledTimes(1)
    // A new document asks again.
    wc.emit('did-navigate', {}, 'https://site.example/autre')
    promptDialog.mockResolvedValueOnce({ value: null, suppress: false })
    ask()
    await settle()
    expect(replies.at(-1)).toBeNull()
    expect(promptDialog).toHaveBeenCalledTimes(2)
  })

  it('puts alert() and confirm() of the main frame of a tab in the box of the shell, and gives each call what it returns', async () => {
    const promptDialog = vi.fn(async (): Promise<{ value: string | null; suppress: boolean }> => ({ value: '', suppress: false }))
    const { page } = await makePage({ events: { promptDialog } })
    const replies: unknown[] = []
    const ask = (kind: 'alert' | 'confirm', message: string) => page.askDialog(kind, { message }, 'https://site.example/', (value) => (replies.push(value), true))
    ask('confirm', 'Supprimer ?')
    await settle()
    expect(promptDialog).toHaveBeenLastCalledWith({ kind: 'confirm', host: 'site.example', message: 'Supprimer ?', defaultValue: '', offerSuppress: false }, expect.any(AbortSignal))
    // OK, then Annuler, then the OK of an alert().
    promptDialog.mockResolvedValueOnce({ value: null, suppress: false })
    ask('confirm', 'Supprimer ?')
    await settle()
    ask('alert', 'Fait.')
    await settle()
    expect(promptDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'alert', message: 'Fait.' }), expect.any(AbortSignal))
    expect(replies).toEqual([true, false, null])
  })

  it('answers a confirm() as a cancel at once when its page goes elsewhere while the box is open, and takes the box away', async () => {
    let signal: AbortSignal | undefined
    const promptDialog = vi.fn((_request: unknown, given: AbortSignal) => ((signal = given), new Promise(() => undefined)))
    const { page, wc } = await makePage({ events: { promptDialog } })
    const replies: unknown[] = []
    page.askDialog('confirm', { message: '?' }, 'https://site.example/', (value) => (replies.push(value), true))
    expect(replies).toEqual([])
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(replies).toEqual([false])
    expect(signal?.aborted).toBe(true)
  })

  it('sends alert() and confirm() of a page without a box of ours (not a tab, or not a page of the web) back to the page’s own function', async () => {
    const { DIALOG_NATIVE } = await import('@shared/page-dialog')
    const replies: unknown[] = []
    const reply = (value: unknown) => (replies.push(value), true)
    // A page that is not a tab: the shell gave it no box.
    const { page: notATab } = await makePage()
    notATab.askDialog('alert', { message: '?' }, 'https://site.example/', reply)
    notATab.askDialog('confirm', { message: '?' }, 'https://site.example/', reply)
    notATab.askDialog('prompt', { message: '?', defaultValue: '' }, 'https://site.example/', reply)
    // A tab whose document is not a page of the web.
    const promptDialog = vi.fn()
    const { page: tab } = await makePage({ events: { promptDialog } })
    tab.askDialog('confirm', { message: '?' }, 'about:blank', reply)
    expect(replies).toEqual([DIALOG_NATIVE, DIALOG_NATIVE, null, DIALOG_NATIVE])
    expect(promptDialog).not.toHaveBeenCalled()
  })

  it('stops alert() and confirm() of a page the user stopped from its prompt(): one guard for the three', async () => {
    const { PROMPT_STOPPED } = await import('@shared/page-dialog')
    const promptDialog = vi.fn(async (): Promise<{ value: string | null; suppress: boolean }> => ({ value: 'x', suppress: true }))
    const { page } = await makePage({ events: { promptDialog } })
    const replies: unknown[] = []
    const reply = (value: unknown) => (replies.push(value), true)
    page.askDialog('prompt', { message: '?', defaultValue: '' }, 'https://site.example/', reply)
    await settle()
    page.askDialog('alert', { message: '!' }, 'https://site.example/', reply)
    page.askDialog('confirm', { message: '?' }, 'https://site.example/', reply)
    expect(replies).toEqual(['x', PROMPT_STOPPED, PROMPT_STOPPED])
    expect(promptDialog).toHaveBeenCalledTimes(1)
  })

  it('keeps a navigation of the top frame to the web, and leaves a server redirect to the question Chromium asks the user', async () => {
    const { wc } = await makePage()
    expect(wc.navigateTo('https://site.example/b')).toBe(false)
    expect(wc.navigateTo('chrome://settings')).toBe(true)
    expect(wc.navigateTo('smb://serveur/partage')).toBe(true)
    // A redirect is left to Chromium, which asks the user for another application's scheme; only one to the Extensions page is stopped (internal-page-guards.test.ts).
    const redirect = (url: string): boolean => {
      let prevented = false
      wc.emit('will-redirect', { preventDefault: () => (prevented = true) }, url)
      return prevented
    }
    for (const url of ['https://site.example/c', 'zoommtg://zoom.us/join?confno=1', 'smb://serveur/partage', 'chrome://settings']) expect(redirect(url), url).toBe(false)
  })
})

describe('a window that a page opens without a click of the user', () => {
  it('is refused, and the user is told once per document (a sign-in whose window comes too late would be a button that does nothing)', async () => {
    const popupBlocked = vi.fn()
    const { wc, events } = await makePage({ events: { popupBlocked } })
    wc.url = 'https://site.example/connexion'
    expect(wc.open('https://login.example/a')).toEqual({ action: 'deny' })
    expect(wc.open('https://login.example/b')).toEqual({ action: 'deny' })
    expect(popupBlocked.mock.calls).toEqual([[displaySite('https://site.example/connexion'), 'https://login.example/a']])
    expect(events.openWindow).not.toHaveBeenCalled()
    // A new document: told again.
    wc.emit('did-navigate', {}, 'https://site.example/autre')
    wc.open('https://login.example/c')
    expect(popupBlocked).toHaveBeenCalledTimes(2)
    // After a click, the window opens.
    wc.click()
    wc.open('https://login.example/d')
    expect(events.openWindow).toHaveBeenCalledWith('https://login.example/d', 'foreground', true, 'foreground-tab', '')
  })

  it('opens for a frame of another site after a click in that frame (a payment or sign-in button), once per click', async () => {
    const popupBlocked = vi.fn()
    const { wc, events } = await makePage({ events: { popupBlocked } })
    wc.url = 'https://shop.example/panier'
    wc.clickInFrame('https://pay.example')
    wc.openFromFrame('https://pay.example/window', 'https://pay.example/button')
    expect(events.openWindow).toHaveBeenCalledWith('https://pay.example/window', 'foreground', true, 'foreground-tab', '')
    expect(popupBlocked).not.toHaveBeenCalled()
    // One click, one window: the same frame asking again is a script.
    expect(wc.openFromFrame('https://pay.example/second', 'https://pay.example/button')).toEqual({ action: 'deny' })
    expect(events.openWindow).toHaveBeenCalledTimes(1)
    expect(popupBlocked).toHaveBeenCalledTimes(1)
  })

  it('does not open for another frame than the one that was clicked, and that frame cannot spend the click twice', async () => {
    const { wc, events } = await makePage({ events: { popupBlocked: vi.fn() } })
    wc.url = 'https://shop.example/panier'
    wc.clickInFrame('https://pay.example')
    // An advertisement beside the button asks for a window right after the click.
    expect(wc.openFromFrame('https://ads.example/win', 'https://ads.example/slot')).toEqual({ action: 'deny' })
    expect(wc.openFromFrame('https://ads.example/win', 'https://ads.example/slot')).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('does not open for a request that names no document, nor for a frame whose click is old', async () => {
    vi.useFakeTimers()
    try {
      const { wc, events } = await makePage({ events: { popupBlocked: vi.fn() } })
      wc.url = 'https://shop.example/panier'
      wc.clickInFrame('https://pay.example')
      expect(wc.open('https://pay.example/window')).toEqual({ action: 'deny' })
      wc.clickInFrame('https://pay.example')
      vi.advanceTimersByTime(5001)
      expect(wc.openFromFrame('https://pay.example/window', 'https://pay.example/button')).toEqual({ action: 'deny' })
      expect(events.openWindow).not.toHaveBeenCalled()
      // The same request within the time of a click opens.
      wc.clickInFrame('https://pay.example')
      vi.advanceTimersByTime(4000)
      wc.openFromFrame('https://pay.example/window', 'https://pay.example/button')
      expect(events.openWindow).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens one window for a click in the page itself: the click leaves no second window to a frame', async () => {
    const { wc, events } = await makePage({ events: { popupBlocked: vi.fn() } })
    wc.url = 'https://shop.example/panier'
    wc.click()
    wc.open('https://shop.example/aide')
    expect(events.openWindow).toHaveBeenCalledTimes(1)
    // A frame takes the focus by itself and asks for a window on the strength of the same click.
    wc.focusedFrame = { origin: 'https://ads.example', parent: wc.mainFrame }
    expect(wc.openFromFrame('https://ads.example/win', 'https://ads.example/slot')).toEqual({ action: 'deny' })
    expect(events.openWindow).toHaveBeenCalledTimes(1)
  })

  it('opens nothing for a frame when the frame that has the focus cannot be read, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { wc, events } = await makePage({ events: { popupBlocked: vi.fn() } })
    wc.clickInFrame('https://pay.example')
    Object.defineProperty(wc, 'focusedFrame', { get: () => { throw new Error('Render frame was disposed') } })
    expect(wc.openFromFrame('https://pay.example/window', 'https://pay.example/button')).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read which frame of a page has the focus'), 'Render frame was disposed')
    warn.mockRestore()
  })

  it('is announced for the page on screen only: what a tab behind tries has nobody to tell', () => {
    const showToast = vi.fn()
    const openTabFromPage = vi.fn()
    const dispatch = vi.fn()
    const visible = new Set<string>()
    const shell = { visible, showToast, openTabFromPage, dispatch, store: { get: () => ({ tabs: [TAB], settings: { popupExceptions: [] } }) } }
    const events = shellEventsOf(TAB, shell)
    events['popupBlocked']!('site.example', 'https://login.example/a')
    expect(showToast).not.toHaveBeenCalled()
    visible.add(TAB.id)
    events['popupBlocked']!('site.example', 'https://login.example/a')
    const [text, action] = showToast.mock.calls[0] as [string, { label: string; run: () => void; second: { label: string; run: () => void } }]
    expect(text).toBe(t('browser.fenetre-bloquee-sur-site-la-page-l-a-ouverte-sans-clic', { site: 'site.example' }))
    expect(action.label).toBe(t('browser.ouvrir-quand-meme'))
    action.run()
    expect(openTabFromPage).toHaveBeenLastCalledWith(TAB, 'https://login.example/a', 'foreground', true)
    expect(action.second.label).toBe(t('browser.toujours-autoriser-sur-ce-site'))
    action.second.run()
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { popupExceptions: ['site.example'] } })
    expect(openTabFromPage).toHaveBeenCalledTimes(2)
  })
})

describe('a popup keeps the bounds it was made with', () => {
  it('has a minimum size, and a page that resizes or moves it is held to the same bounds', () => {
    const { popups, owner, win, contents } = popupOfTab()
    const options = popups.request(owner as never, { url: 'https://login.example/' } as never, { kind: 'popup', opener: true, size: {} })?.overrideBrowserWindowOptions
    expect(options).toMatchObject({ minWidth: POPUP_MIN_SIZE.width, minHeight: POPUP_MIN_SIZE.height })
    const event = { preventDefault: vi.fn() }
    const requested = { x: -5000, y: -5000, width: 10, height: 10 }
    contents.emit('content-bounds-updated', event, requested)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(win.setContentBounds).toHaveBeenCalledWith(popupContentBounds(requested, { x: 0, y: 0, width: 1600, height: 1000 }))
  })
})

describe('a popup on a system where each window carries a menu bar', () => {
  it('is wired and shown like on macOS, its menu bar taken off (macOS has none to take off)', () => {
    const mac = popupOfTab()
    expect(mac.win.removeMenu).not.toHaveBeenCalled()
    expect(mac.win.shown).toBe(true)
    for (const id of ['linux', 'win32'] as const) {
      played.id = id
      const { win, contents } = popupOfTab()
      expect(win.removeMenu, id).toHaveBeenCalledTimes(1)
      expect(win.shown, id).toBe(true)
      expect(win.destroyed, id).toBe(false)
      // The guards wired after the menu bar are there too: the user closing the window is not held back.
      const event = { preventDefault: vi.fn() }
      contents.emit('will-prevent-unload', event)
      expect(event.preventDefault, id).toHaveBeenCalled()
    }
  })
})

describe('"Enregistrer l’image sous…"', () => {
  it('is offered only for an address a page can show as an image', async () => {
    const { wc } = await makePage()
    const save = itemLabelled(wc.rightClick({ mediaType: 'image', srcURL: 'https://site.example/photo.png' }), t('engine.enregistrer-l-image-sous'))
    save!.click!()
    expect(wc.downloadURL).toHaveBeenCalledWith('https://site.example/photo.png')
    expect(itemLabelled(wc.rightClick({ mediaType: 'image', srcURL: 'file:///Users/moi/photo.png' }), t('engine.enregistrer-l-image-sous'))).toBeUndefined()
  })
})

describe('the first page of a profile and its extensions', () => {
  it('waits for the profile’s loads before it navigates, together with the proxy change of its session', async () => {
    let loaded!: () => void
    const ready = new Promise<void>((resolve) => (loaded = resolve))
    const { page, view } = (await engineForPages({ ready })).create('t')
    page.loadURL('https://site.example/')
    await settle()
    expect(view.webContents.loadURL).not.toHaveBeenCalled()
    loaded()
    await settle()
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://site.example/')

    // Nothing to wait for: the page navigates at once.
    const now = (await engineForPages({ ready: null })).create('u')
    now.page.loadURL('https://site.example/')
    expect(now.view.webContents.loadURL).toHaveBeenCalledWith('https://site.example/')
  })

  it('waits for the proxy change of the session as well', async () => {
    let switched!: () => void
    const proxy = new Promise<void>((resolve) => (switched = resolve))
    const waits = engineMethods['beforeNavigation']!.call({ proxies: { settled: () => proxy } }, {}, { ready: null }) as Promise<void>
    let done = false
    void waits.then(() => (done = true))
    await settle()
    expect(done).toBe(false)
    switched()
    await settle()
    expect(done).toBe(true)
    expect(engineMethods['beforeNavigation']!.call({ proxies: { settled: () => undefined } }, {}, undefined)).toBeUndefined()
  })

  it('is made to wait only when the profile inherits folders to load (the timing itself is profileReady\'s, tested in profile-ready.test.ts)', async () => {
    const profileOf = (paths: string[], load: () => Promise<void>) => {
      madeSessions.clear()
      const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, inertEngine({ extensionPaths: new Set(paths), loadFirst: load }))
      return engineMethods['ensureProfile']!.call(engine, 'p') as { ready: Promise<void> | null }
    }
    // Nothing to load: the first page does not wait.
    expect(profileOf([], async () => undefined).ready).toBeNull()
    // A folder loaded by hand is inherited: the first page waits for its load, and the wait is gone once it ends.
    let loaded!: () => void
    const profile = profileOf(['/folder-of-an-extension'], () => new Promise<void>((resolve) => (loaded = resolve)))
    expect(profile.ready).not.toBeNull()
    let done = false
    void profile.ready!.then(() => (done = true))
    await settle()
    expect(done).toBe(false)
    loaded()
    await settle()
    expect(done).toBe(true)
    expect(profile.ready).toBeNull()
  })
})

describe('the shell and a page that is gone', () => {
  it('ignores the update and the media events of a page that is no longer the tab’s page', () => {
    const onPageUpdate = vi.fn()
    const mediaChanged = vi.fn()
    let current = true
    const events = shellEventsOf(TAB, { onPageUpdate, mediaChanged, pages: new Map() }, () => current)
    events['update']!({ title: 'Nouveau' })
    events['mediaChanged']!()
    current = false
    events['update']!({ title: 'Trop tard' })
    events['mediaChanged']!()
    expect(onPageUpdate.mock.calls).toEqual([[TAB.id, { title: 'Nouveau' }]])
    expect(mediaChanged).toHaveBeenCalledTimes(1)
  })

  it('gives the page events the test of its own page: the page made for the tab is current until another one is registered under its id', () => {
    const onPageUpdate = vi.fn()
    let given: Record<string, (...args: unknown[]) => unknown> | undefined
    const first = { loadURL: vi.fn() }
    const fake = fakeBrowser({
      pages: new Map(),
      creating: new Set(),
      pageSession: new Map(),
      pageAutoplay: new Map(),
      privatePages: new Set(),
      pageContainer: new Map(),
      containerKeyOf: () => '',
      cycleWatching: false,
      isPrivate: () => false,
      options: { windowId: 1 },
      store: { get: () => ({ spaces: [{ id: TAB.spaceId, profileId: 'default' }], settings: defaultSettings() }) },
      engine: { createPage: (_options: unknown, events: Record<string, (...args: unknown[]) => unknown>) => ((given = events), first) },
      onPageUpdate,
      pageEvents: (tab: TabItem, current: () => boolean) => shellMethods['pageEvents']!.call(fake.self, tab, current)
    })
    shellMethods['ensurePage']!.call(fake.self, TAB)
    given!['update']!({ title: 'Nouveau' })
    expect(onPageUpdate).toHaveBeenCalledTimes(1)
    // The page is made again under the same id (the autoplay rule, a container): the events of the first one come late and say nothing of the tab.
    ;(fake.self['pages'] as Map<string, object>).set(TAB.id, {})
    given!['update']!({ title: 'Trop tard' })
    expect(onPageUpdate).toHaveBeenCalledTimes(1)
  })

  it('withdraws the permission questions of a page that is destroyed', async () => {
    const answers: boolean[] = []
    const shell: Record<string, unknown> = {
      permissionCounter: 0,
      permissionAnswers: new Map(),
      permissionPages: new Map(),
      permissionQueue: [] as Array<{ id: string }>,
      // A panel is open: the questions wait in line.
      overlayRequest: { panel: 'find' },
      ownerOf: () => undefined,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      dispatch: vi.fn(),
      // The pages that ask are not tabs of the window: their questions are put at once, behind the panel (a tab off screen waits: off-screen-questions.test.ts).
      store: { get: () => ({ tabs: [] }) },
      visibleIds: () => [],
      offScreenQuestions: new Map()
    }
    for (const name of ['whenOnScreen', 'waitsOffScreen', 'putPermission']) shell[name] = (...args: unknown[]) => shellMethods[name]!.apply(shell, args)
    shell['answerPermission'] = (...args: unknown[]) => shellMethods['answerPermission']!.apply(shell, args)
    const ask = (pageId: string) => (shellMethods['askPermission']!.call(shell, 'https://site.example', 'geolocation', pageId) as Promise<boolean>).then((answer) => answers.push(answer))
    void ask('gone')
    void ask('gone')
    void ask('stays')
    shellMethods['cancelPermissionsOf']!.call(shell, 'gone')
    await settle()
    expect(answers).toEqual([false, false])
    expect((shell['permissionQueue'] as Array<{ id: string }>).map((request) => request.id)).toEqual(['perm-3'])
    expect([...(shell['permissionPages'] as Map<string, string>).values()]).toEqual(['stays'])

    // The question carries its page from the window of the page to the window that shows it.
    const askPermission = vi.fn(async () => true)
    const owner = { askPermission }
    await shellMethods['askPermission']!.call({ ownerOf: () => owner }, 'https://site.example', 'camera', 'p', 'détail', true, 'travail')
    expect(askPermission).toHaveBeenCalledWith('https://site.example', 'camera', 'p', 'détail', true, 'travail')
  })

  // The real `destroyPage` of the window, over a stand-in: the page that goes takes its questions with it, and the site is answered no.
  it('withdraws them when the page goes: the question a destroyed page was asking is answered no, and nothing else of it stays', async () => {
    const destroy = vi.fn()
    const window = fakeBrowser({
      pages: new Map([['gone', { destroy }], ['stays', { destroy: vi.fn() }]]),
      fullscreenTab: null,
      store: { get: () => ({ tabs: [] }) },
      permissionCounter: 0,
      permissionAnswers: new Map(),
      permissionPages: new Map(),
      permissionQueue: [] as Array<{ id: string }>,
      // A panel is open: the questions wait in line.
      overlayRequest: { panel: 'find' },
      ownerOf: () => undefined,
      dropPageState: shellMethods['dropPageState'],
      cancelPermissionsOf: shellMethods['cancelPermissionsOf'],
      answerPermission: shellMethods['answerPermission']
    })
    const answers: Array<[string, boolean]> = []
    const ask = (pageId: string) => (shellMethods['askPermission']!.call(window.self, 'https://site.example', 'geolocation', pageId) as Promise<boolean>).then((answer) => answers.push([pageId, answer]))
    void ask('gone')
    void ask('stays')
    shellMethods['destroyPage']!.call(window.self, 'gone')
    await settle()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(answers).toEqual([['gone', false]])
    expect([...(window.self['permissionPages'] as Map<string, string>).values()]).toEqual(['stays'])
    // The other questions of the page are withdrawn by the same call: a login, a box of the page, « Quitter ce site ? ».
    for (const withdrawn of ['cancelAuthOf', 'cancelDialogsOf', 'cancelLeaveOf']) expect(window.calls, withdrawn).toContainEqual({ name: withdrawn, args: ['gone'] })
  })

  it('does not ask a second login for a page whose slot was taken away while the question waited in line', async () => {
    let answerFirst!: (credentials: null) => void
    const askAuth = vi.fn(() => new Promise((resolve) => (answerFirst = resolve)))
    const shell = { ownerOf: () => undefined, authCounter: 0, authPages: new Map(), askAuth }
    const challenge = { host: 'site.example', port: 443, scheme: 'basic', realm: 'Privé', isProxy: false, url: 'https://site.example/' }
    const first = shellMethods['authenticate']!.call(shell, 'p', challenge) as Promise<unknown>
    const second = shellMethods['authenticate']!.call(shell, 'p', { ...challenge, realm: 'Autre' }) as Promise<unknown>
    await settle()
    // The page goes (`cancelAuthOf`): its slot is taken away, then the question on screen is refused.
    shell.authPages.delete('p')
    answerFirst(null)
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(askAuth).toHaveBeenCalledTimes(1)
  })

  it('tells the extensions about the new page of an active tab that was rebuilt, and about nothing when the page is the same', () => {
    const activated = (rebuild: boolean): unknown[] => {
      const host = syncHost(['https://site.example/'], (tab, pages) => {
        if (rebuild || !pages.has(tab.id)) pages.set(tab.id, {})
      })
      host.pages.set(host.active()!.id, {})
      shellMethods['sync']!.call(host.fake.self)
      return host.fake.calls.filter((call) => call.name === 'engine.activatePage').map((call) => call.args[0])
    }
    // The same tab, with a page made again (the autoplay rule, a container, a profile): the extensions' idea of the active tab is the page that is gone.
    expect(activated(true)).toEqual([expect.any(String)])
    expect(activated(false)).toEqual([])
  })
})
