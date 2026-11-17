// How the engine loads the Extensions page: the shell's own load carries the secret that gets the document served (engine/internal-pages.ts), and only that
// load does. A reload of the page is such a load too, not the replay of the entry. A real ElectronPage over stand-ins (electron-page.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import { INTERNAL_LOAD_HEADER } from '@shared/internal-serve'
import { installInternalPages, internalLoadHeaders, setInternalPagesHome, type InternalPagesSession } from './internal-pages'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const PAGE = 'lucium-ui://extensions/'
const WEB = 'https://site.example/'

/** The session of a page, made to serve the Extensions page (or to refuse it): what `installInternalPages` does for the session of a profile (or a private one). */
function serving(session: object, mode: 'serve' | 'refuse' = 'serve'): void {
  setInternalPagesHome({ rendererDir: '/app/out/renderer', projectRoot: '/Users/jane/lucium' }, () => ({ readText: () => null, has: () => false, readBytes: () => new Uint8Array(), fetchDev: () => Promise.reject(new Error('none')) }))
  Object.assign(session, { protocol: { handle: () => undefined }, registerPreloadScript: (script: { id: string }) => script.id } satisfies InternalPagesSession)
  installInternalPages(session as InternalPagesSession, mode)
}

describe('the load of the Extensions page by the shell', () => {
  it('carries the secret of its session, as an extra header of that load', async () => {
    const { page, wc } = await makePage()
    serving(wc.session)
    page.loadURL(PAGE)
    const line = internalLoadHeaders(wc.session)!
    expect(line).toMatch(new RegExp(`^${INTERNAL_LOAD_HEADER}: [0-9a-f]{32}$`))
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledWith(PAGE, { extraHeaders: line })
  })

  it('carries it when the load had to wait for the network too', async () => {
    let settled!: () => void
    const { page, wc } = await makePage({ networkSettled: () => new Promise<void>((resolve) => (settled = resolve)) })
    serving(wc.session)
    page.loadURL('lucium-ui://extensions/shortcuts')
    expect(wc.loadURL).not.toHaveBeenCalled()
    settled()
    await vi.waitFor(() => expect(wc.loadURL).toHaveBeenCalledTimes(1))
    expect(wc.loadURL).toHaveBeenCalledWith('lucium-ui://extensions/shortcuts', { extraHeaders: internalLoadHeaders(wc.session) })
  })

  it('is the only load that carries it: a page of the web gets none, whatever the session', async () => {
    const { page, wc } = await makePage()
    serving(wc.session)
    page.loadURL(WEB)
    page.loadURL('view-source:https://site.example/')
    expect(wc.loadURL.mock.calls).toEqual([[WEB], ['view-source:https://site.example/']])
  })

  it('has none to carry in a session that does not serve the page', async () => {
    const { page, wc } = await makePage()
    serving(wc.session, 'refuse')
    page.loadURL(PAGE)
    expect(wc.loadURL).toHaveBeenCalledWith(PAGE)
  })

  it('is made again by a reload of the page, which does not replay the entry', async () => {
    const { page, wc } = await makePage()
    serving(wc.session)
    wc.url = PAGE
    const reload = vi.spyOn(wc, 'reload')
    const reloadIgnoringCache = vi.spyOn(wc, 'reloadIgnoringCache')
    page.reload()
    page.reloadIgnoringCache()
    expect(reload).not.toHaveBeenCalled()
    expect(reloadIgnoringCache).not.toHaveBeenCalled()
    expect(wc.loadURL.mock.calls).toEqual([[PAGE, { extraHeaders: internalLoadHeaders(wc.session) }], [PAGE, { extraHeaders: internalLoadHeaders(wc.session) }]])
  })

  it('reloads the page where it is, a shortcuts page or an extension’s details included', async () => {
    const { page, wc } = await makePage()
    serving(wc.session)
    wc.url = `lucium-ui://extensions/?id=${'a'.repeat(32)}`
    page.reload()
    expect(wc.loadURL).toHaveBeenCalledWith(wc.url, { extraHeaders: internalLoadHeaders(wc.session) })
  })

  it('leaves the reload of a page of the web to Chromium', async () => {
    const { page, wc } = await makePage()
    serving(wc.session)
    wc.url = WEB
    const reload = vi.spyOn(wc, 'reload')
    const reloadIgnoringCache = vi.spyOn(wc, 'reloadIgnoringCache')
    page.reload()
    page.reloadIgnoringCache()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).not.toHaveBeenCalled()
  })
})

describe('a document of the Extensions page that was refused', () => {
  function served() {
    return makePage().then((made) => {
      serving(made.wc.session)
      made.wc.loadURL.mockClear()
      return made
    })
  }

  it('is loaded again by the shell’s way, once: what a Back or a Forward onto the page, or chrome.tabs.reload, asks for does not carry the secret', async () => {
    const { wc } = await served()
    wc.url = PAGE
    // The document of the page committed with an answer of 403.
    wc.emit('did-navigate', {}, PAGE, 403)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledWith(PAGE, { extraHeaders: internalLoadHeaders(wc.session) })
  })

  it('is also what Chromium calls a failed load of a status with no body', async () => {
    const { wc } = await served()
    wc.url = PAGE
    // The failure of a frame, or another failure of the page, is no refusal of the document.
    wc.emit('did-fail-load', {}, -379, 'ERR_HTTP_RESPONSE_CODE_FAILURE', PAGE, false)
    wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', PAGE, true)
    expect(wc.loadURL).not.toHaveBeenCalled()
    wc.emit('did-fail-load', {}, -379, 'ERR_HTTP_RESPONSE_CODE_FAILURE', PAGE, true)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledWith(PAGE, { extraHeaders: internalLoadHeaders(wc.session) })
  })

  it('is not loaded a second time when the shell’s own load was refused: the secret is wrong, and the log says it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { wc } = await served()
    wc.url = PAGE
    wc.emit('did-navigate', {}, PAGE, 403)
    wc.emit('did-navigate', {}, PAGE, 403)
    wc.emit('did-navigate', {}, PAGE, 403)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the Extensions page was refused again to a load of the shell'))
    warn.mockRestore()
  })

  it('may be tried again once a document of the page was served', async () => {
    const { wc } = await served()
    wc.url = PAGE
    wc.emit('did-navigate', {}, PAGE, 403)
    wc.emit('did-navigate', {}, PAGE, 200)
    wc.emit('did-navigate', {}, PAGE, 403)
    expect(wc.loadURL).toHaveBeenCalledTimes(2)
  })

  it('is no business of a page of the web: its refusals, and the pages whose address only looks like the page’s, are left alone', async () => {
    const { wc } = await served()
    wc.url = WEB
    wc.emit('did-navigate', {}, WEB, 403)
    wc.emit('did-navigate', {}, 'lucium-ui://extensions@evil/', 403)
    wc.emit('did-navigate', {}, 'lucium-ui://extensions/assets/a.js', 403)
    wc.emit('did-fail-load', {}, -379, 'ERR_HTTP_RESPONSE_CODE_FAILURE', WEB, true)
    expect(wc.loadURL).not.toHaveBeenCalled()
  })
})

describe('a message sent to the document of a page', () => {
  it('goes to the web contents of the page, and says it did', async () => {
    const { page, wc } = await makePage()
    const send = vi.fn()
    Object.assign(wc, { send })
    expect(page.sendToDocument('lucium-ui:snapshot', { extensions: [] })).toBe(true)
    expect(send).toHaveBeenCalledWith('lucium-ui:snapshot', { extensions: [] })
  })

  it('sends nothing to a page that is gone, and says so', async () => {
    const { page, wc } = await makePage()
    const send = vi.fn()
    Object.assign(wc, { send })
    wc.destroyed = true
    expect(page.sendToDocument('lucium-ui:snapshot', {})).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
