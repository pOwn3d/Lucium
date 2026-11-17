// `documentPictureInPicture.requestWindow()` as the handler of new windows of a page receives it (electron-page.ts), and of a popup (popup-windows.ts):
// a window of its own when the feature is on and a click explains it, else a refusal, and never a tab. On fakes (electron-page.test-support.ts); what
// Electron then hands over is document-pip-windows.test.ts, and a real Electron the engine check (src/main/smoke-docpip.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakePageContents, FakePopupWindow, FakeWindow, makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

const { ADD_NEW_CONTENTS, DocumentPipWindows } = await import('./document-pip-windows')
const { HttpsUpgrades } = await import('./https-upgrade')
const { PopupWindows } = await import('./popup-windows')

/** The request of `documentPictureInPicture.requestWindow()`, as Electron hands it to the handler. */
const PIP_REQUEST = { disposition: 'other', features: '', frameName: '' }

/** A page of a tab with the document Picture-in-Picture windows of the engine, the feature on or off, and Electron's listener of the internal event. */
async function pageWithPip(on: boolean) {
  const documentPip = new DocumentPipWindows({ workArea: () => ({ x: 0, y: 0, width: 1600, height: 1000 }), now: () => Date.now(), platform: 'darwin' })
  documentPip.setEnabled(on)
  const made = await makePage({ documentPip })
  made.wc.url = 'https://meet.example/abc'
  made.wc.on(ADD_NEW_CONTENTS, (event: { preventDefault(): void }) => event.preventDefault())
  return { ...made, documentPip }
}

let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]))

describe('a page that asks for a document Picture-in-Picture window', () => {
  it('gets it after a click, while the feature is on: Chromium is let make it, and no tab opens', async () => {
    const { wc, events } = await pageWithPip(true)
    wc.click()
    expect(wc.open('about:blank', PIP_REQUEST)).toMatchObject({ action: 'allow', outlivesOpener: false })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('is refused while the feature is off, as before, and opens no tab, not even a blank one', async () => {
    const { wc, events } = await pageWithPip(false)
    wc.click()
    for (const url of ['about:blank', '', 'about:blank#blocked']) expect(wc.open(url, PIP_REQUEST), url).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
    expect(lines(warn).filter((line) => line.startsWith('[pip] refused'))[0]).toContain('the feature document-pip is off')
    // Nothing is put on the page while the feature is off.
    expect(wc.listenerCount(ADD_NEW_CONTENTS)).toBe(1)
  })

  it('leaves the click to what it was for when the feature is off: the next window the click explains still opens', async () => {
    const { wc, events } = await pageWithPip(false)
    wc.click()
    wc.open('about:blank', PIP_REQUEST)
    wc.open('https://site.example/next')
    expect(events.openWindow).toHaveBeenCalledWith('https://site.example/next', 'foreground', true, 'foreground-tab', '')
  })

  it('is refused without a click, and opens no tab', async () => {
    const { wc, events } = await pageWithPip(true)
    expect(wc.open('about:blank', PIP_REQUEST)).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
    expect(lines(warn).some((line) => line.includes('no click or key of the user explains it'))).toBe(true)
  })

  it('is refused, without a tab, by a page that is not one of the web', async () => {
    const { wc, events } = await pageWithPip(true)
    wc.url = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html'
    wc.click()
    expect(wc.open('about:blank', PIP_REQUEST)).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('is refused, without a tab, when the engine has no document Picture-in-Picture windows', async () => {
    const { wc, events } = await makePage()
    wc.click()
    expect(wc.open('about:blank', PIP_REQUEST)).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('is refused, without a tab, when Electron hands new windows over another way', async () => {
    const documentPip = new DocumentPipWindows()
    documentPip.setEnabled(true)
    const { wc, events } = await makePage({ documentPip })
    wc.click()
    expect(wc.open('about:blank', PIP_REQUEST)).toEqual({ action: 'deny' })
    expect(events.openWindow).not.toHaveBeenCalled()
  })

  it('writes what Electron sent in the log, short, whatever the answer (the probe of the engine check)', async () => {
    const { wc } = await pageWithPip(false)
    wc.open('about:blank', { ...PIP_REQUEST, features: 'x'.repeat(500) })
    const probe = lines(info).find((line) => line.includes('asked for a document Picture-in-Picture window'))
    expect(probe).toContain('"disposition":"other"')
    expect(probe).toContain('"url":"about:blank"')
    expect(probe!.length).toBeLessThan(400)
  })

  it('leaves the other windows as they were: a link in a new tab still opens a tab', async () => {
    const { wc, events } = await pageWithPip(true)
    wc.click()
    expect(wc.open('https://site.example/other')).toEqual({ action: 'deny' })
    expect(events.openWindow).toHaveBeenCalledWith('https://site.example/other', 'foreground', true, 'foreground-tab', '')
  })
})

describe('a popup that asks for a document Picture-in-Picture window', () => {
  it('is refused, and the tab behind gets no blank tab', () => {
    const popups = new PopupWindows(new HttpsUpgrades(), () => 'allow')
    const owner = { key: 'tab-1', contents: new FakePageContents(), win: new FakeWindow(), events: { openWindow: vi.fn() }, scope: null }
    popups.watch(owner as never)
    const win = new FakePopupWindow(2)
    owner.contents.emit('did-create-window', win)
    win.webContents.emit('input-event', {}, { type: 'mouseDown' })
    expect(win.webContents.open('about:blank', PIP_REQUEST)).toEqual({ action: 'deny' })
    expect(owner.events.openWindow).not.toHaveBeenCalled()
    expect(lines(warn)).toContain('[engine] refused a document Picture-in-Picture window asked by a popup')
  })
})
