// The layer of the page annotation runs in an isolated world of the page (shared/page-annotate-layer.ts): the page of the engine hands its calls
// to that world only, and to no page that is gone. On the stand-in page of electron-page.test-support.ts.

import { describe, expect, it, vi } from 'vitest'
import { PAGE_ANNOTATE_WORLD, pageLayerCall } from '@shared/page-annotate-layer'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

describe('the world of the annotation layer', () => {
  it('runs the calls of the layer in their own isolated world, never in the page’s', async () => {
    const { page, wc } = await makePage()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true)
    const call = pageLayerCall('undo')
    expect(await page.runAnnotateLayer(call)).toBe(true)
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(PAGE_ANNOTATE_WORLD, [{ code: call }])
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('refuses a page that is gone, without touching it', async () => {
    const { page, wc } = await makePage()
    wc.destroyed = true
    await expect(page.runAnnotateLayer(pageLayerCall('remove'))).rejects.toThrow('the page is gone')
    expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('has a world of its own, apart from the other worlds of Lucium', async () => {
    const worlds = await Promise.all([
      import('@shared/page-tools').then((m) => m.TOOLS_WORLD),
      import('@shared/translate-page-script').then((m) => m.TRANSLATE_WORLD),
      import('@shared/readable-engine').then((m) => m.READABLE_WORLD),
      import('@shared/site-data-overlay').then((m) => m.SITE_DATA_OVERLAY_WORLD),
      import('./floating-video-scripts').then((m) => m.FLOATING_WORLD),
      import('./markdown-picker').then((m) => m.MARKDOWN_WORLD),
      import('./password-bridge').then((m) => m.PASSWORD_WORLD),
      import('./regex-find').then((m) => m.REGEX_FIND_WORLD)
    ])
    expect(worlds).not.toContain(PAGE_ANNOTATE_WORLD)
    // The numbers written in place in the engine (the sleep check, the reader, the page watch, the search discovery).
    expect([4_200_017, 4_200_018, 4_200_044, 4_200_072]).not.toContain(PAGE_ANNOTATE_WORLD)
  })
})
