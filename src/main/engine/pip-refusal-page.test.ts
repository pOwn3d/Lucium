// A video that refuses to float: the script of the page answers with the reason and writes nothing in the page (media-scripts.test.ts), so the
// page of the engine is the one that writes it in the journal. The web contents are fakes (electron-page.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => vi.restoreAllMocks())

describe('a video asked to float when its tab is left', () => {
  it('writes the refusal of the page in the journal of the application, with the page and who asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true)
    wc.executeJavaScript.mockResolvedValueOnce({ entered: false, reason: 'refused', detail: 'Internal error: no window' })
    await expect(page.setPictureInPicture(true, 'tab-switch')).resolves.toBe(false)
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[pip]'))).toEqual([`[pip] page ${page.id}: the video did not float (tab-switch): Internal error: no window`])
  })

  it('writes nothing when the video floats', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    wc.executeJavaScript.mockResolvedValueOnce(true).mockResolvedValueOnce({ entered: true })
    await expect(page.setPictureInPicture(true, 'user')).resolves.toBe(true)
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[pip]'))).toEqual([])
  })

  // A page that answers in its own world that it has a video being watched (a builtin replaced) must not get a gesture for it at each tab switch.
  it('asks whether a tab left has a video being watched in a world of our own, and runs nothing with a gesture when it has none', async () => {
    const { page, wc } = await makePage()
    wc.executeJavaScript.mockResolvedValue(true)
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(false)
    await expect(page.setPictureInPicture(true, 'tab-switch')).resolves.toBe(false)
    expect(wc.executeJavaScript.mock.calls.filter((call) => (call as unknown[])[1] === true)).toEqual([])
  })
})
