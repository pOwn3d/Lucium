// The Extensions page in a tab, as the page of the engine guards it: the shell loads it, and no page of the web (nor the page itself) sends a tab to it or from it.
// A real ElectronPage over stand-ins (electron-page.test-support.ts).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { isNavigable, isShellNavigable } from './electron-page-scripts'
import { makePage, openExternal, settle } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const PAGE = 'lucium-ui://extensions/'
const ID = 'a'.repeat(32)
const FORMS = [PAGE, 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}&profile=default`]
const LOOK_ALIKES = ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui:extensions', 'lucium-ui://extensions.evil.com/', 'lucium-ui://extensions:80/', 'lucium-ui://extensions/assets/a.js', 'lucium-ui://extensions\\@evil/', 'lucium-ui://capture-helper/', 'lucium-ui://capture-helper/?x=1']

let warn: MockInstance<(...args: unknown[]) => void>
beforeEach(() => {
  openExternal.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('what the shell may load in a tab', () => {
  it('is the web, the files, the pages of extensions, the source view of a page and the Extensions page', () => {
    for (const url of ['https://example.org/', 'http://localhost:3000/', 'file:///Users/jane/a.pdf', 'about:blank', `chrome-extension://${ID}/a.html`, 'view-source:https://example.org/', ...FORMS]) {
      expect(isShellNavigable(url), url).toBe(true)
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'chrome://extensions', 'blob:https://example.org/x', 'lucium://x', 'ftp://example.org/', ...LOOK_ALIKES]) {
      expect(isShellNavigable(url), url).toBe(false)
    }
  })

  it('is wider than what a page of the web may send a tab to, by the Extensions page and the source view alone', () => {
    for (const url of FORMS) expect(isNavigable(url), url).toBe(false)
    expect(isNavigable('view-source:https://example.org/')).toBe(false)
    expect(isNavigable('https://example.org/')).toBe(true)
  })

  it('loads the Extensions page in the tab when the shell asks for it', async () => {
    const { page, wc } = await makePage()
    for (const url of FORMS) {
      wc.loadURL.mockClear()
      page.loadURL(url)
      expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(url)
    }
  })

  it('refuses an address that only looks like the page, even from the shell', async () => {
    const { page, wc } = await makePage()
    for (const url of LOOK_ALIKES) expect(() => page.loadURL(url), url).toThrow(/Refusing to load a non-web URL/)
    expect(wc.loadURL).not.toHaveBeenCalled()
  })

  it('does not restore the Extensions page among the pages a rebuilt tab had behind it: it is loaded at its address', async () => {
    const { page, wc } = await makePage()
    expect(page.restoreHistory({ entries: [{ title: 'Extensions', url: PAGE }], index: 0 })).toBe(false)
    expect(wc.loadURL).not.toHaveBeenCalled()
  })
})

describe('a page of the web', () => {
  it('cannot send the tab to the Extensions page: not by a link, and nothing is asked of the user or handed to the system', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc, events } = await makePage({ askAppLink })
    wc.url = 'https://evil.example/'
    wc.click()
    for (const url of [...FORMS, ...LOOK_ALIKES]) expect(wc.navigateTo(url), url).toBe(true)
    await settle()
    expect(askAppLink).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(events.update).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] blocked a page from going to lucium-ui:')
  })

  it('cannot open the Extensions page in a window or a tab', async () => {
    const { wc, events } = await makePage()
    wc.url = 'https://evil.example/'
    wc.click()
    for (const url of [...FORMS, ...LOOK_ALIKES]) expect(wc.open(url), url).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('cannot reach it by a redirect: a server’s 302 to the page is stopped, any other redirect is left alone', async () => {
    const { wc } = await makePage()
    wc.url = 'https://evil.example/'
    const redirect = (url: string): boolean => {
      let prevented = false
      wc.emit('will-redirect', { preventDefault: () => (prevented = true) }, url)
      return prevented
    }
    for (const url of [...FORMS, ...LOOK_ALIKES, 'LUCIUM-UI://x']) expect(redirect(url), url).toBe(true)
    expect(redirect('https://other.example/')).toBe(false)
    expect(warn).toHaveBeenCalledWith('[engine] kept a redirect from going to the Extensions page')
  })

  it('cannot show it in a frame: a frame that goes to the page is stopped, any other frame is left alone', async () => {
    const { wc } = await makePage()
    wc.url = 'https://evil.example/'
    const frame = (url: string, isMainFrame = false): boolean => {
      let prevented = false
      wc.emit('will-frame-navigate', { isMainFrame, url, frame: { origin: 'https://evil.example' }, preventDefault: () => (prevented = true) })
      return prevented
    }
    for (const url of [...FORMS, ...LOOK_ALIKES]) expect(frame(url), url).toBe(true)
    expect(frame('https://other.example/')).toBe(false)
    expect(warn).toHaveBeenCalledWith('[engine] kept a frame from going to the Extensions page')
  })

  it('still goes where a page goes: a link to the web is not stopped', async () => {
    const { wc } = await makePage()
    wc.url = 'https://example.org/'
    expect(wc.navigateTo('https://other.example/')).toBe(false)
  })
})

describe('the Extensions page itself', () => {
  it('goes nowhere by itself: a link or a script that sends the tab elsewhere is stopped, the web included', async () => {
    const { wc, events } = await makePage()
    for (const here of FORMS) {
      wc.url = here
      for (const url of ['https://example.org/', 'http://localhost:3000/', 'file:///Users/jane/a.pdf', `chrome-extension://${ID}/a.html`, ...FORMS, 'about:blank']) expect(wc.navigateTo(url), `${here} -> ${url}`).toBe(true)
    }
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(events.update).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] kept the Extensions page from going to https:')
  })

  it('opens no window, a link with a click included', async () => {
    const { wc, events } = await makePage()
    wc.url = PAGE
    wc.click()
    for (const url of ['https://example.org/', 'about:blank', PAGE]) expect(wc.open(url), url).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] kept the Extensions page from opening a window on https:')
  })

  it('is no longer held when the tab is on the web: the same link goes through', async () => {
    const { wc } = await makePage()
    wc.url = PAGE
    expect(wc.navigateTo('https://example.org/')).toBe(true)
    wc.url = 'https://example.org/start'
    expect(wc.navigateTo('https://example.org/next')).toBe(false)
  })

  it('does not let a page of the web pass for it by the address it says: only the address Chromium gives counts', async () => {
    const { wc } = await makePage()
    wc.url = 'https://evil.example/?x=lucium-ui://extensions/'
    expect(wc.navigateTo('https://example.org/')).toBe(false)
  })
})
