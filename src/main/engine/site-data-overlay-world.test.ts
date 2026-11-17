// The animation of « Effacer les données du site » is drawn by scripts run in an isolated world of the page (shared/site-data-overlay.ts): the page of
// the engine hands them to that world only, and to no page that is gone. On the stand-in page of electron-page.test-support.ts.

import { describe, expect, it, vi } from 'vitest'
import { SITE_DATA_OVERLAY_WORLD } from '@shared/site-data-overlay'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

describe('the world of the clearing animation', () => {
  it('runs the scripts of the animation in their own isolated world, never in the page’s', async () => {
    const { page, wc } = await makePage()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true)
    expect(await page.runClearOverlay('draw()')).toBe(true)
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(SITE_DATA_OVERLAY_WORLD, [{ code: 'draw()' }])
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('refuses a page that is gone, without touching it', async () => {
    const { page, wc } = await makePage()
    wc.destroyed = true
    await expect(page.runClearOverlay('draw()')).rejects.toThrow('the page is gone')
    expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('has a world of its own, apart from the other worlds of Lucium', async () => {
    const worlds = await Promise.all([
      import('@shared/page-tools').then((m) => m.TOOLS_WORLD),
      import('@shared/translate-page-script').then((m) => m.TRANSLATE_WORLD),
      import('@shared/readable-engine').then((m) => m.READABLE_WORLD),
      import('./floating-video-scripts').then((m) => m.FLOATING_WORLD),
      import('./markdown-picker').then((m) => m.MARKDOWN_WORLD),
      import('./password-bridge').then((m) => m.PASSWORD_WORLD),
      import('./regex-find').then((m) => m.REGEX_FIND_WORLD)
    ])
    expect(worlds).not.toContain(SITE_DATA_OVERLAY_WORLD)
  })
})
