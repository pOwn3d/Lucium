// The readable mode runs its probe and its engine in an isolated world of the page (shared/readable-engine.ts): the page of the engine hands its
// scripts to that world only, and to no page that is gone. On the stand-in page of electron-page.test-support.ts.

import { describe, expect, it, vi } from 'vitest'
import { READABLE_WORLD } from '@shared/readable-engine'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

describe('the readable world of a page', () => {
  it('runs the scripts of the readable mode in their own isolated world, never in the page’s', async () => {
    const { page, wc } = await makePage()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ samples: [1] })
    expect(await page.runReadable('probe()')).toEqual({ samples: [1] })
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(READABLE_WORLD, [{ code: 'probe()' }])
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('refuses a page that is gone, without touching it', async () => {
    const { page, wc } = await makePage()
    wc.destroyed = true
    await expect(page.runReadable('probe()')).rejects.toThrow('the page is gone')
    expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
})
