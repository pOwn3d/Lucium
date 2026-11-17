// The DevTools protocol of an extension (`chrome.debugger`) on a page: it is let go before the page reaches an address the extension may not
// debug (the Chrome Web Store, a page of another extension), whether the page navigates there or is redirected there on the way. Run on the real
// ElectronPage over a fake web contents (electron-page.test-support.ts); the rule of the addresses: shared/debugger-policy.ts.

import { describe, expect, it, vi } from 'vitest'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const STORE = 'https://chromewebstore.google.com/detail/an-extension/abcdefghijklmnopabcdefghijklmnop'
const allowed = (url: string): boolean => !url.startsWith('https://chromewebstore.google.com/')

async function debugged() {
  const made = await makePage()
  const detached = vi.fn()
  made.page.debugAttach('1.3', () => undefined, detached, allowed)
  expect(made.page.isDebugAttached()).toBe(true)
  return { ...made, detached }
}

describe('the protocol session of an extension on a page', () => {
  it('is let go when a navigation of the page is redirected to an address the extension may not debug, before the redirect is followed', async () => {
    const { page, wc, detached } = await debugged()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://relay.example/' })
    expect(page.isDebugAttached()).toBe(true)
    wc.emit('will-redirect', { isMainFrame: true, url: STORE })
    expect(page.isDebugAttached()).toBe(false)
    expect(detached).toHaveBeenCalledTimes(1)
  })

  it('stays through a redirect of a frame, and through one to an address it may debug', async () => {
    const { page, wc, detached } = await debugged()
    wc.emit('will-redirect', { isMainFrame: false, url: STORE })
    wc.emit('will-redirect', { isMainFrame: true, url: 'https://elsewhere.example/' })
    expect(page.isDebugAttached()).toBe(true)
    expect(detached).not.toHaveBeenCalled()
  })

  it('listens to the redirects only while it lasts', async () => {
    const { page, wc } = await debugged()
    const before = wc.listenerCount('will-redirect')
    page.debugDetach()
    expect(wc.listenerCount('will-redirect')).toBe(before - 1)
  })
})
