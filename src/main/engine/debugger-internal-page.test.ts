// The DevTools protocol of an extension (`chrome.debugger`) and the Extensions page (`lucium-ui:`). A session attached to a tab that is still empty or
// loading, while the shell is taking it to the Extensions page, could register a script for the next document (`Page.addScriptToEvaluateOnNewDocument`)
// that runs where the channels of the page are. The address of a page that has not committed is the previous one, so the page follows the navigation
// under way (heading-navigation.ts) and refuses, or ends, the session from the moment the shell asks. Run on the real ElectronPage over a fake web
// contents (electron-page.test-support.ts); the timing of Chromium itself is for the engine check (smoke-extensions-page.ts).

import { describe, expect, it, vi } from 'vitest'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const PAGE = 'lucium-ui://extensions/'
const WEB = 'https://site.example/'
// The caller of a real session (extension-shims.ts) judges with debuggerTargetAllowed; here it allows everything, to show the engine does not depend on it.
const everything = (): boolean => true

function attach(page: Awaited<ReturnType<typeof makePage>>['page'], detached: (reason: string) => void = () => undefined): void {
  page.debugAttach('1.3', () => undefined, detached, everything)
}

describe('an extension session on a page that goes to the Extensions page', () => {
  it('cannot be attached while the shell has asked for the page and the load waits for the network', async () => {
    const { page, wc } = await makePage({ networkSettled: () => new Promise<void>(() => undefined) })
    wc.url = ''
    page.loadURL(PAGE)
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(() => attach(page)).toThrow(/Cannot attach/)
    expect(page.isDebugAttached()).toBe(false)
  })

  it('cannot be attached while the load of the page is under way, before Chromium announces it and after', async () => {
    const { page, wc } = await makePage()
    wc.url = ''
    page.loadURL(PAGE)
    expect(wc.loadURL).toHaveBeenCalledWith(PAGE)
    expect(() => attach(page)).toThrow(/Cannot attach/)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: PAGE })
    expect(() => attach(page)).toThrow(/Cannot attach/)
    expect(wc.debugger.attaches).toBe(0)
  })

  it('cannot be attached to the page itself, whatever the caller allows', async () => {
    const { page, wc } = await makePage()
    wc.url = PAGE
    expect(() => attach(page)).toThrow(/Cannot attach/)
  })

  it('is let go when the shell asks for the page, not when the page commits', async () => {
    const { page, wc } = await makePage()
    wc.url = ''
    const detached = vi.fn()
    attach(page, detached)
    expect(page.isDebugAttached()).toBe(true)
    page.loadURL(PAGE)
    // Nothing has committed, nothing was announced: the session is already over, and nothing can be sent through it.
    expect(page.isDebugAttached()).toBe(false)
    expect(detached).toHaveBeenCalledTimes(1)
    await expect(page.debugSend('Page.addScriptToEvaluateOnNewDocument', { source: 'void 0' })).rejects.toThrow(/not attached/)
    expect(wc.debugger.commands).toEqual([])
  })

  it('is let go when Chromium announces a navigation of the page to the Extensions page', async () => {
    const { page, wc } = await makePage()
    const detached = vi.fn()
    attach(page, detached)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: PAGE })
    expect(page.isDebugAttached()).toBe(false)
    expect(detached).toHaveBeenCalledTimes(1)
    // The page is still on its way there (nothing committed): no new session may start, though the address it is on is another one.
    expect(() => attach(page)).toThrow(/Cannot attach/)
    // A navigation that starts after replaces it.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: WEB })
    expect(() => attach(page)).not.toThrow()
  })

  it('is let go when a move through the history reaches the Extensions page, and none starts until the page has left it', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    wc.navigationHistory.entries = [{ url: PAGE, title: '' }, { url: WEB, title: '' }]
    wc.navigationHistory.active = 1
    attach(page)
    page.goBack()
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    expect(page.isDebugAttached()).toBe(false)
    expect(() => attach(page)).toThrow(/Cannot attach/)
    // The document commits: the address says it from here.
    wc.url = PAGE
    wc.emit('did-navigate', {}, PAGE)
    expect(() => attach(page)).toThrow(/Cannot attach/)
    // The page goes back to the web: the move announces itself, then commits, and a session may start again.
    wc.navigationHistory.entries = [{ url: PAGE, title: '' }, { url: WEB, title: '' }]
    wc.navigationHistory.active = 0
    page.goForward()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: WEB })
    wc.url = WEB
    wc.emit('did-navigate', {}, WEB)
    expect(() => attach(page)).not.toThrow()
    expect(page.isDebugAttached()).toBe(true)
  })

  it('is let go by goToIndex as well', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    wc.navigationHistory.entries = [{ url: PAGE, title: '' }, { url: WEB, title: '' }]
    wc.navigationHistory.active = 1
    attach(page)
    page.goToIndex(0)
    expect(wc.navigationHistory.goToIndex).toHaveBeenCalledWith(0)
    expect(page.isDebugAttached()).toBe(false)
    expect(() => attach(page)).toThrow(/Cannot attach/)
  })

  it('is not disturbed by a move through the history that goes nowhere', async () => {
    const { page, wc } = await makePage()
    wc.navigationHistory.entries = [{ url: WEB, title: '' }]
    wc.navigationHistory.active = 0
    attach(page)
    page.goBack()
    page.goToIndex(7)
    expect(page.isDebugAttached()).toBe(true)
  })

  it('may be attached again once the load of the Extensions page ends without the page having reached it', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    page.loadURL(PAGE)
    expect(() => attach(page)).toThrow(/Cannot attach/)
    // The user stays on the page (or the load is cancelled): nothing loads any more.
    wc.loading = false
    wc.emit('did-stop-loading')
    expect(() => attach(page)).not.toThrow()
  })

  it('may be attached again once the load of the Extensions page was aborted', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    page.loadURL(PAGE)
    expect(() => attach(page)).toThrow(/Cannot attach/)
    // ERR_ABORTED: another navigation took its place, which shows no page of error.
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', PAGE, true)
    expect(() => attach(page)).not.toThrow()
  })

  it('stays refused when another document commits while the load of the Extensions page goes on', async () => {
    const { page, wc } = await makePage()
    wc.url = ''
    page.loadURL(PAGE)
    // A document that was already committing (the previous load) arrives after the ask: it says nothing of the navigation under way.
    wc.url = WEB
    wc.emit('did-navigate', {}, WEB)
    wc.loading = true
    wc.emit('did-stop-loading')
    expect(() => attach(page)).toThrow(/Cannot attach/)
  })

  it('is not held from a page by a load of the Extensions page that a load of the web replaced', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    page.loadURL(PAGE)
    page.loadURL('https://other.example/')
    expect(() => attach(page)).not.toThrow()
  })

  it('stays attached to a page of the web when a frame of it loads something', async () => {
    const { page, wc } = await makePage()
    wc.url = WEB
    attach(page)
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: PAGE })
    expect(page.isDebugAttached()).toBe(true)
  })
})
