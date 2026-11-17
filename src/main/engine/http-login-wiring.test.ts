// The question of a login (401 of a server, 407 of a proxy) as the real ElectronPage puts it, over a fake web contents: a frame or a picture of
// another site never gets the login panel of the tab around it, the page itself does, wherever its navigation leads, and the user's answer goes back
// to Chromium. The rule alone is in http-login.test.ts; before this file a test only read that the line was in the source.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePage, settle } from './electron-page.test-support'
import { listenerLogins } from './extension-net'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => vi.restoreAllMocks())

/** A page at https://bank.example/ whose shell answers the question of a login with `credentials` (null: the user cancelled). */
async function pageAsking(credentials: { username: string; password: string } | null = { username: 'ada', password: 'the password' }) {
  const authenticate = vi.fn(async () => credentials)
  const made = await makePage({ events: { authenticate } })
  made.wc.url = 'https://bank.example/accounts'
  /** A login asked of the page: what Chromium was answered (`[]` is a refusal), and whether the default box of Electron was stopped. */
  const login = async (details: { url: string; isRequestForNavigation: boolean; firstAuthAttempt?: boolean }, info: { isProxy?: boolean; host?: string; realm?: string } = {}) => {
    const answered: unknown[][] = []
    const event = { preventDefault: vi.fn() }
    made.wc.emit('login', event, details, { isProxy: false, host: new URL(details.url).hostname, port: 443, scheme: 'basic', realm: 'Connexion', ...info }, (...args: unknown[]) => void answered.push(args))
    await settle()
    return { answered, prevented: event.preventDefault.mock.calls.length > 0 }
  }
  return { ...made, authenticate, login }
}

describe('a login asked while a page is shown', () => {
  it('is put to the user for the page itself, and the answer goes back to the server', async () => {
    const page = await pageAsking()
    page.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://intranet.example/' })
    const { answered, prevented } = await page.login({ url: 'https://intranet.example/', isRequestForNavigation: true })
    expect(prevented).toBe(true)
    expect(page.authenticate).toHaveBeenCalledWith(expect.objectContaining({ host: 'intranet.example', realm: 'Connexion', isProxy: false, url: 'https://intranet.example/' }))
    expect(answered).toEqual([['ada', 'the password']])
  })

  it('is refused without a question for a frame of another site: its realm would be read as the page’s own', async () => {
    const page = await pageAsking()
    const { answered, prevented } = await page.login({ url: 'https://evil.example/401', isRequestForNavigation: true }, { realm: 'Connexion à votre banque' })
    expect(page.authenticate).not.toHaveBeenCalled()
    expect(answered).toEqual([[]])
    expect(prevented).toBe(true)
  })

  it('is refused for that frame while the page itself navigates elsewhere, and once the navigation of the page has ended', async () => {
    const page = await pageAsking()
    page.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://bank.example/next' })
    expect((await page.login({ url: 'https://evil.example/401', isRequestForNavigation: true })).answered).toEqual([[]])
    // The page went to intranet.example and arrived: a later "navigation" there is a frame's, and the page is still at bank.example.
    page.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://intranet.example/' })
    page.wc.emit('did-navigate')
    expect((await page.login({ url: 'https://intranet.example/frame', isRequestForNavigation: true })).answered).toEqual([[]])
    expect(page.authenticate).not.toHaveBeenCalled()
  })

  it('follows the redirects of the page: the login of the address it was sent to is the page’s', async () => {
    const page = await pageAsking()
    page.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://intranet.example/' })
    page.wc.emit('did-redirect-navigation', { isMainFrame: true, url: 'https://sso.example/login' })
    expect((await page.login({ url: 'https://sso.example/login', isRequestForNavigation: true })).answered).toEqual([['ada', 'the password']])
    // A frame that starts a navigation does not become the navigation of the page.
    page.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://evil.example/frame' })
    expect((await page.login({ url: 'https://evil.example/frame', isRequestForNavigation: true })).answered).toEqual([[]])
  })

  it('is refused for a picture or a request of another site, and put to the user for one of the page’s own site and for a proxy', async () => {
    const page = await pageAsking()
    expect((await page.login({ url: 'https://tracker.example/pixel.png', isRequestForNavigation: false })).answered).toEqual([[]])
    expect(page.authenticate).not.toHaveBeenCalled()
    expect((await page.login({ url: 'https://bank.example/api/list', isRequestForNavigation: false })).answered).toEqual([['ada', 'the password']])
    expect((await page.login({ url: 'https://cdn.example/a.png', isRequestForNavigation: false }, { isProxy: true })).answered).toEqual([['ada', 'the password']])
    expect(page.authenticate).toHaveBeenCalledTimes(2)
  })

  it('is refused when the user cancels, and when the question itself fails (the reason is in the journal, never the credentials)', async () => {
    const cancelled = await pageAsking(null)
    expect((await cancelled.login({ url: 'https://bank.example/private', isRequestForNavigation: false })).answered).toEqual([[]])

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = await pageAsking()
    failing.authenticate.mockRejectedValueOnce(new Error('the panel is gone'))
    expect((await failing.login({ url: 'https://bank.example/private', isRequestForNavigation: false })).answered).toEqual([[]])
    expect(error).toHaveBeenCalledWith('[engine] cannot ask for a login:', 'the panel is gone')
  })

  it('takes what a blocking listener of onAuthRequired answered: a cancel ends it without a question, credentials go at the first attempt only', async () => {
    const page = await pageAsking()
    const url = 'https://bank.example/private'
    listenerLogins.keep(page.wc.session, url, { cancel: true }, Date.now())
    expect((await page.login({ url, isRequestForNavigation: false })).answered).toEqual([[]])
    expect(page.authenticate).not.toHaveBeenCalled()
    listenerLogins.keep(page.wc.session, url, { credentials: { username: 'from', password: 'the extension' } }, Date.now())
    expect((await page.login({ url, isRequestForNavigation: false, firstAuthAttempt: true })).answered).toEqual([['from', 'the extension']])
    expect(page.authenticate).not.toHaveBeenCalled()
    // They were wrong, and the server asks again: the user is asked, not the listener's credentials given again.
    listenerLogins.keep(page.wc.session, url, { credentials: { username: 'from', password: 'the extension' } }, Date.now())
    expect((await page.login({ url, isRequestForNavigation: false, firstAuthAttempt: false })).answered).toEqual([['ada', 'the password']])
    // Nothing is given to a frame of another site the page would not ask for.
    listenerLogins.keep(page.wc.session, 'https://evil.example/401', { credentials: { username: 'from', password: 'the extension' } }, Date.now())
    expect((await page.login({ url: 'https://evil.example/401', isRequestForNavigation: true, firstAuthAttempt: true })).answered).toEqual([[]])
  })

  it('is refused when no window answers the questions of the page', async () => {
    const made = await makePage()
    const answered: unknown[][] = []
    made.wc.emit('login', { preventDefault: () => {} }, { url: 'https://site.example/', isRequestForNavigation: true }, { isProxy: false, host: 'site.example', port: 443, scheme: 'basic', realm: 'x' }, (...args: unknown[]) => void answered.push(args))
    expect(answered).toEqual([[]])
  })
})
