// A link of a page to another application (`zoommtg:`, `msteams:`, `slack:`, `vscode:`…), on a real `ElectronPage` over stand-ins
// (electron-page.test-support.ts): the user is asked, with the scheme, and the address goes to the system on a yes. Such a link used to be
// dropped with a line in the log, and « Ouvrir dans l'application » did nothing. Which addresses are links to an application is in
// shared/external-links.test.ts; the question itself (its place, its words, that it is never remembered) in permission-guards.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineForPages, makePage, openExternal, settle } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const ZOOM = 'zoommtg://zoom.us/join?confno=123456&pwd=secret'

let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  openExternal.mockReset()
  openExternal.mockResolvedValue(undefined)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

/** Everything the page wrote to the log, to check that no address is in it. */
const logged = (): string => [...warn.mock.calls, ...info.mock.calls].flat().join('\n')

describe('a link of a page to another application', () => {
  it('is stopped, asked about with its scheme, and handed to the system when the user says yes', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    expect(wc.navigateTo(ZOOM)).toBe(true)
    // Nothing leaves before the answer.
    expect(openExternal).not.toHaveBeenCalled()
    await settle()
    // `true`: a click explains the link, so the answer may be kept for the site and the scheme.
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('zoommtg:', true)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(ZOOM)
  })

  // « Toujours ouvrir… » needs a click for the first yes: a page that sends to its application as it loads is asked the question nobody keeps.
  it('says that no click explains a link the page goes to by itself, and that one explains the link the user clicked', async () => {
    const askAppLink = vi.fn(async () => false)
    const { wc } = await makePage({ askAppLink })
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', false)
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true)
    // The click was used up by that link: the next one has none.
    wc.emit('did-navigate')
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', false)
  })

  // A link the user chose to always open is answered yes without a question: a script still gets one opening per document without a click.
  it('opens a link that is always allowed once per document without a click, not once per try', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    for (let i = 0; i < 5; i++) wc.navigateTo(ZOOM)
    await settle()
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('opens nothing when the user says no, and the log keeps the scheme, never the address', async () => {
    const askAppLink = vi.fn(async () => false)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(1)
    expect(openExternal).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledExactlyOnceWith('[engine] a zoommtg: link was not opened: the user said no, or nobody could be asked')
    expect(logged()).not.toMatch(/confno|secret|zoom\.us/)
  })

  it('is asked about when it opens in a new window too, and opens no window', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc, events } = await makePage({ askAppLink })
    wc.click()
    expect(wc.open('slack://channel?team=T1&id=C1')).toEqual({ action: 'deny' })
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('slack:', true)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('slack://channel?team=T1&id=C1')
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('is asked about once per document when no click explains it (a page that sends to its application as it loads), not once per try', async () => {
    const askAppLink = vi.fn(async () => false)
    const { wc } = await makePage({ askAppLink })
    wc.navigateTo(ZOOM)
    await settle()
    wc.navigateTo(ZOOM)
    wc.open('msteams://teams.microsoft.com/l/meetup-join/1')
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[engine] ignored a zoommtg: link that no click explains: this document was asked about one already')
    expect(warn).toHaveBeenCalledWith('[engine] ignored a msteams: link that no click explains: this document was asked about one already')
    // Another document of the tab may ask once again; and a click always may.
    wc.emit('did-navigate')
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(2)
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(3)
  })

  it('does not put a second question behind the one on show', async () => {
    let answer: (allowed: boolean) => void = () => undefined
    const askAppLink = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const { wc } = await makePage({ askAppLink })
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    wc.click()
    wc.navigateTo('vscode://file/tmp/x')
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[engine] ignored a vscode: link: the user is being asked about another one')
    answer(true)
    await settle()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(ZOOM)
    // Once answered, the next click is asked about again.
    wc.click()
    wc.navigateTo('vscode://file/tmp/x')
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(2)
  })

  it('keeps refusing, without a question, a scheme that never leaves the browser', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    for (const url of ['javascript:alert(1)', 'data:text/html,<p>x</p>', 'x-apple.systempreferences:com.apple.preference.security', 'smb://host/share', 'chrome://settings', 'lucium://open?url=https://x.example']) {
      wc.click()
      expect(wc.navigateTo(url), url).toBe(true)
    }
    wc.click()
    expect(wc.open('file:///etc/hosts')).toEqual({ action: 'deny' })
    await settle()
    expect(askAppLink).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] blocked a page from going to smb:')
  })

  it('opens nothing for a page nobody can be asked for (no question wired)', async () => {
    const { wc } = await makePage()
    wc.click()
    expect(wc.navigateTo(ZOOM)).toBe(true)
    await settle()
    expect(openExternal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] blocked a page from going to zoommtg:')
  })

  it('tells the user, by the scheme alone, when no application could open the link', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    openExternal.mockRejectedValue(new Error('no application is registered'))
    const externalLinkFailed = vi.fn()
    const { wc } = await makePage({ askAppLink: async () => true, events: { externalLinkFailed } })
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    await settle()
    expect(externalLinkFailed).toHaveBeenCalledExactlyOnceWith('zoommtg:')
    expect(error).toHaveBeenCalledExactlyOnceWith('[engine] cannot open a zoommtg: link:', 'no application is registered')
  })

  it('opens nothing and says why in the log when the question itself fails, then asks again at the next click', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const askAppLink = vi.fn(async (): Promise<boolean> => Promise.reject(new Error('the panel is gone')))
    const externalLinkFailed = vi.fn()
    const { wc } = await makePage({ askAppLink, events: { externalLinkFailed } })
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    expect(openExternal).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledExactlyOnceWith('[engine] cannot ask about a zoommtg: link:', 'the panel is gone')
    // No application failed to open anything: the notice that says so is not shown.
    expect(externalLinkFailed).not.toHaveBeenCalled()
    wc.click()
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenCalledTimes(2)
  })

  it('leaves a mail link as it was: on a click, to the system, without a question', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    expect(wc.navigateTo('mailto:ada@example.com')).toBe(true)
    await settle()
    expect(askAppLink).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('mailto:ada@example.com')
  })
})

describe('the page the engine makes', () => {
  it('asks the engine’s own question for its links to another application, about its own web contents', async () => {
    const { engine, create } = await engineForPages()
    const askAppLink = vi.fn(async () => true)
    Object.assign(engine, { askAppLink })
    const { view } = create('tab-1')
    view.webContents.click()
    expect(view.webContents.navigateTo(ZOOM)).toBe(true)
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith(view.webContents, 'zoommtg:', true)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(ZOOM)
  })
})

// A frame goes to `mailto:` or `tel:`: `will-frame-navigate`, with the frame that navigates.
describe('a mailto: or tel: link inside a frame of the page', () => {
  const TEL = 'tel:+33900000000'
  const frameGoes = (wc: Awaited<ReturnType<typeof makePage>>['wc'], origin: string | null, url = TEL): boolean => {
    let prevented = false
    wc.emit('will-frame-navigate', { isMainFrame: false, url, frame: origin === null ? null : { origin }, preventDefault: () => (prevented = true) })
    return prevented
  }

  it('opens with the click in the page when the frame is of the page\'s own site', async () => {
    const { wc } = await makePage()
    wc.click()
    expect(frameGoes(wc, 'https://site.example')).toBe(true)
    await settle()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(TEL)
  })

  // The decoy: the user clicks something of the page, and a frame of another site sends to a telephone number.
  it('does not open for a frame of another site on a click given to the page, and does not use that click up', async () => {
    const { wc } = await makePage()
    wc.click()
    expect(frameGoes(wc, 'https://ads.example')).toBe(true)
    await settle()
    expect(openExternal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] ignored a tel: link of a frame of another site that no click in that frame explains')
    expect(logged()).not.toContain('33900000000')
    // The click of the user is still there for the page's own link.
    wc.navigateTo('mailto:contact@site.example')
    await settle()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('mailto:contact@site.example')
  })

  // The link is the frame's, not the page's: the plain question, under the frame's site, then the system on a yes.
  it('asks, under the site of the frame, for a frame of another site when the click was in that frame, and opens once', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.clickInFrame('https://widget.example')
    frameGoes(wc, 'https://widget.example')
    frameGoes(wc, 'https://widget.example')
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('tel:', true, { kind: 'frame', origin: 'https://widget.example' })
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(TEL)
  })

  it('does not open for a frame that names no document, nor for another frame than the one clicked', async () => {
    const { wc } = await makePage()
    wc.clickInFrame('https://widget.example')
    frameGoes(wc, null)
    frameGoes(wc, 'https://ads.example')
    await settle()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

// An advertisement or a widget in a frame of another site, on a site where the user may have chosen « Toujours ouvrir les liens de ce type depuis
// ce site »: what the frame asks for is the plain question under the frame's own site (a third argument names it), never the page's kept answer.
describe('a link that leaves the browser, asked by a frame of another site', () => {
  const ADS = 'https://ads.example'
  const frameGoes = (wc: Awaited<ReturnType<typeof makePage>>['wc'], origin: string, url = ZOOM): boolean => {
    let prevented = false
    wc.emit('will-frame-navigate', { isMainFrame: false, url, frame: { origin }, preventDefault: () => (prevented = true) })
    return prevented
  }

  it('is stopped when the frame goes to another application, and asked about under the frame\'s site, with the click in that frame', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.clickInFrame(ADS)
    expect(frameGoes(wc, ADS)).toBe(true)
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('zoommtg:', true, { kind: 'frame', origin: ADS })
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(ZOOM)
  })

  // A click given to the page is not the frame's: the frame asks as one that no click explains.
  it('does not use the click the user gave to the page, and asks once per document without one, apart from the page\'s own question', async () => {
    const askAppLink = vi.fn(async () => false)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    frameGoes(wc, ADS)
    await settle()
    frameGoes(wc, ADS)
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('zoommtg:', false, { kind: 'frame', origin: ADS })
    expect(warn).toHaveBeenCalledWith('[engine] ignored a zoommtg: link that no click explains: this document was asked about one already')
    // The click is still the page's, and the frame did not spend the page's one question without a click.
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true)
    wc.navigateTo(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', false)
    expect(askAppLink).toHaveBeenCalledTimes(3)
  })

  it('leaves a frame of the page\'s own site to Chromium, as before', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    expect(frameGoes(wc, 'https://site.example')).toBe(false)
    await settle()
    expect(askAppLink).not.toHaveBeenCalled()
  })

  // `target=_top`: the frame sends the whole tab to the link, and Electron names it as the initiator of the navigation.
  it('names the frame that sends the whole tab to the link, and keeps the page\'s own question for the page\'s own links', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.clickInFrame(ADS)
    expect(wc.navigateTo(ZOOM, { origin: ADS })).toBe(true)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true, { kind: 'frame', origin: ADS })
    wc.click()
    wc.navigateTo(ZOOM, { origin: 'https://site.example' })
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true)
  })

  it('asks about a mail link of the frame that sends the whole tab to it, instead of opening it on the page\'s click', async () => {
    const askAppLink = vi.fn(async () => false)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    wc.navigateTo('mailto:x@ads.example', { origin: ADS })
    await settle()
    expect(openExternal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[engine] ignored a mailto: link of a frame of another site that no click in that frame explains')
    wc.clickInFrame(ADS)
    wc.navigateTo('mailto:x@ads.example', { origin: ADS })
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('mailto:', true, { kind: 'frame', origin: ADS })
    expect(openExternal).not.toHaveBeenCalled()
  })

  // `window.open` does not say which frame made it: the click names the frame, and a page with a frame of another site is not sure of the asker.
  it('names the frame for a window opened to the link after a click in that frame', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc, events } = await makePage({ askAppLink })
    wc.subFrames.push({ origin: ADS })
    wc.clickInFrame(ADS)
    expect(wc.open(ZOOM)).toEqual({ action: 'deny' })
    await settle()
    wc.clickInFrame(ADS)
    wc.open('tel:+33900000000')
    await settle()
    expect(askAppLink).toHaveBeenNthCalledWith(1, 'zoommtg:', true, { kind: 'frame', origin: ADS })
    expect(askAppLink).toHaveBeenNthCalledWith(2, 'tel:', true, { kind: 'frame', origin: ADS })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('reads nothing the user kept for a window opened to the link in a page that holds a frame of another site, and is unchanged without one', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    wc.click()
    wc.open(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true)
    wc.click()
    wc.open('mailto:contact@site.example')
    await settle()
    expect(openExternal).toHaveBeenLastCalledWith('mailto:contact@site.example')
    expect(askAppLink).toHaveBeenCalledTimes(1)
    wc.subFrames.push({ origin: ADS })
    wc.click()
    wc.open(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('zoommtg:', true, { kind: 'unsure' })
    wc.click()
    wc.open('mailto:contact@site.example')
    await settle()
    expect(askAppLink).toHaveBeenLastCalledWith('mailto:', true, { kind: 'unsure' })
  })

  it('takes the page for unsure when its frames cannot be read, and the log says why', async () => {
    const askAppLink = vi.fn(async () => true)
    const { wc } = await makePage({ askAppLink })
    Object.defineProperty(wc.mainFrame, 'framesInSubtree', { get: () => { throw new Error('Render frame was disposed') } })
    wc.click()
    wc.open(ZOOM)
    await settle()
    expect(askAppLink).toHaveBeenCalledExactlyOnceWith('zoommtg:', true, { kind: 'unsure' })
    expect(warn).toHaveBeenCalledWith("[engine] cannot list the frames of a page, so a link that names nobody is not taken for the page's own:", 'Render frame was disposed')
  })
})

// A server asked this page for a client certificate and got none: the page hands the site to the shell, which says it in its window.
describe('the refusal of a client certificate, for a page', () => {
  it('reaches the shell with the site, and says whether anybody was there to hear it', async () => {
    const clientCertificateRefused = vi.fn()
    const wired = await makePage({ events: { clientCertificateRefused } })
    expect(wired.page.clientCertificateRefused('intranet.example:8443')).toBe(true)
    expect(clientCertificateRefused).toHaveBeenCalledExactlyOnceWith('intranet.example:8443')
    // A page of a window that shows no notice (nothing wired): the caller is told so, and writes it in the journal.
    const bare = await makePage()
    expect(bare.page.clientCertificateRefused('intranet.example')).toBe(false)
  })
})
