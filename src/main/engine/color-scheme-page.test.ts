// The colour scheme asked of the web pages, as the page and the engine carry it (the rules of the session are in color-scheme.test.ts): every page of the application
// gets it, a private window's included, a page made later reads it from its first document, a navigation keeps it, an extension that debugs the page has the page
// to itself, and the page of an extension is not given any. The web contents are fakes (electron-page.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { engineForPages, FakePageContents, makePage, settle } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined))

const dark = { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
const light = { features: [{ name: 'prefers-color-scheme', value: 'light' }] }
const sent = (wc: FakePageContents) => wc.debugger.commands.map((command) => command.params)

describe('a page of the engine', () => {
  it('has no session while no scheme is asked, whatever it does', async () => {
    const { page, wc } = await makePage()
    wc.emit('dom-ready')
    wc.emit('did-navigate', {}, 'https://other.example/')
    page.setColorScheme(null)
    expect(wc.debugger.attaches).toBe(0)
    expect(wc.debugger.commands).toEqual([])
  })

  it('reads the scheme asked, and gives it back with the session', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    expect(wc.debugger.attached).toBe(true)
    expect(sent(wc)).toEqual([dark])
    page.setColorScheme(null)
    expect(wc.debugger.attached).toBe(false)
  })

  // THE GUARD of the navigations: each new document asks again, and takes the page back when its session was lost or was not free.
  it('keeps the scheme through a navigation: each new document asks for it again', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('light')
    wc.emit('dom-ready')
    expect(sent(wc)).toEqual([light, light])
    wc.debugger.detach()
    expect(wc.debugger.attached).toBe(false)
    wc.emit('dom-ready')
    expect(wc.debugger.attached).toBe(true)
    expect(sent(wc)).toEqual([light, light, light])
  })

  it('is not touched once it is gone', async () => {
    const { page, wc } = await makePage()
    wc.destroyed = true
    page.setColorScheme('dark')
    expect(wc.debugger.attaches).toBe(0)
  })
})

describe('an extension that debugs the page (chrome.debugger)', () => {
  const allowed = (): boolean => true

  it('has the page to itself: the session of the scheme leaves, and is back when the extension’s ends', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    const detached = vi.fn()
    page.debugAttach('1.3', () => undefined, detached, allowed)
    // The page is the extension's: one session, its own, and the extension sees it.
    expect(wc.debugger.attached).toBe(true)
    expect(page.isDebugAttached()).toBe(true)
    expect(wc.debugger.attaches).toBe(2)
    page.debugDetach()
    expect(detached).toHaveBeenCalledTimes(1)
    // And the scheme is asked again.
    expect(wc.debugger.attached).toBe(true)
    expect(page.isDebugAttached()).toBe(false)
    expect(wc.debugger.attaches).toBe(3)
    expect(sent(wc)).toEqual([dark, dark])
  })

  // THE GUARD: the session that gives the page its scheme is not the extension's, whatever the extension asks.
  it('does not see the session of the scheme: the page is free for it, and nothing it sends goes through ours', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    expect(page.isDebugAttached()).toBe(false)
    await expect(page.debugSend('Page.reload', {})).rejects.toThrow('not attached')
    expect(sent(wc)).toEqual([dark])
    // Its detach does not take the page's own session away.
    page.debugDetach()
    expect(wc.debugger.attached).toBe(true)
    expect(wc.debugger.detaches).toBe(0)
  })

  it('is not stopped by the session of the scheme when it attaches to a page that is asked for one', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('light')
    expect(() => page.debugAttach('1.3', () => undefined, () => undefined, allowed)).not.toThrow()
    expect(page.isDebugAttached()).toBe(true)
    expect(wc.debugger.attached).toBe(true)
  })

  it('leaves the page as it found it when the attach fails', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    expect(() => page.debugAttach('1.3', () => undefined, () => undefined, () => false)).toThrow('Cannot attach')
    expect(wc.debugger.attached).toBe(true)
    expect(page.isDebugAttached()).toBe(false)
  })
})

describe('the engine, for every page it makes', () => {
  it('gives each page the scheme asked, the pages of a private window included, and takes it back from all', async () => {
    const { create, setPageColorScheme } = await engineForPages()
    const a = create('private/one')
    const b = create('private/two')
    setPageColorScheme('dark')
    expect([a.view.webContents.debugger.attached, b.view.webContents.debugger.attached]).toEqual([true, true])
    setPageColorScheme(null)
    expect([a.view.webContents.debugger.attached, b.view.webContents.debugger.attached]).toEqual([false, false])
  })

  // THE GUARD of the new pages: a page made while the scheme is asked reads it from its first document, not only the pages that were there.
  it('gives a page made later the scheme asked, and a page made while nothing is asked nothing', async () => {
    const { create, setPageColorScheme } = await engineForPages({ ready: null })
    const before = create('t1')
    expect(before.view.webContents.debugger.attaches).toBe(0)
    setPageColorScheme('light')
    const later = create('t2')
    expect(later.view.webContents.debugger.attached).toBe(true)
    expect(sent(later.view.webContents)).toEqual([light])
    expect(before.view.webContents.debugger.attached).toBe(true)
  })

  it('does not give the page of an extension a scheme: it is not a web page', async () => {
    const { create, setPageColorScheme } = await engineForPages({ ready: null })
    setPageColorScheme('dark')
    const panel = create('panel', undefined, true)
    expect(panel.view.webContents.debugger.attaches).toBe(0)
  })

  it('forgets a page that is destroyed, and asks nothing twice for the same scheme', async () => {
    const { create, setPageColorScheme } = await engineForPages({ ready: null })
    const a = create('t1')
    setPageColorScheme('dark')
    setPageColorScheme('dark')
    expect(sent(a.view.webContents)).toEqual([dark])
    a.view.webContents.emit('destroyed')
    await settle()
    setPageColorScheme('light')
    expect(sent(a.view.webContents)).toEqual([dark])
  })
})
