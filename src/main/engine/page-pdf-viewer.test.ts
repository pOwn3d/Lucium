// The forced dark mode asks a page whether the PDF viewer is in it: the real ElectronPage over a fake web contents, whose main frame lists its frames.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_VIEWER_ORIGIN } from '@shared/pdf-viewer'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => {
  vi.restoreAllMocks()
})

const framesOf = (wc: { mainFrame: object }, urls: string[]) => Object.assign(wc.mainFrame, { framesInSubtree: urls.map((url) => ({ url })) })

describe('ElectronPage.showsPdfViewer', () => {
  it('is true when a frame of the PDF viewer is in the page, whatever the address of the document', async () => {
    const { page, wc } = await makePage()
    framesOf(wc, ['https://site.example/download?id=3', `${PDF_VIEWER_ORIGIN}index.html?src=x`])
    expect(page.showsPdfViewer()).toBe(true)
  })

  it('is false for a page of the web with frames of other sites, and for another extension', async () => {
    const { page, wc } = await makePage()
    framesOf(wc, ['https://site.example/article', 'https://ads.example/frame', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html'])
    expect(page.showsPdfViewer()).toBe(false)
  })

  it('is false, without a word, for a page that is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    framesOf(wc, [`${PDF_VIEWER_ORIGIN}index.html`])
    wc.destroyed = true
    expect(page.showsPdfViewer()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('says so in the log, and is false, when a frame is disposed while the list is read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    Object.defineProperty(wc.mainFrame, 'framesInSubtree', {
      get() {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
      configurable: true
    })
    expect(page.showsPdfViewer()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('tab-1')
    expect(String(warn.mock.calls[0]![1])).toContain('disposed')
  })
})
