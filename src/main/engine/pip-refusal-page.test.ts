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

// The site's own Picture in Picture button and Lucium's own request both end in the same event of the page: only the first is taken into Lucium's window.
describe('the system’s Picture in Picture window heard from the page', () => {
  it('is the site’s own button when Lucium did not ask for it', async () => {
    const sitePictureInPicture = vi.fn()
    const { page } = await makePage({ events: { sitePictureInPicture } })
    page.sitePictureInPicture()
    expect(sitePictureInPicture).toHaveBeenCalledTimes(1)
  })

  it('is not the site’s when Lucium asked for it, while the request lasts and just after, so the fallback does not loop', async () => {
    vi.useFakeTimers()
    try {
      const sitePictureInPicture = vi.fn()
      const { page, wc } = await makePage({ events: { sitePictureInPicture } })
      let answer: (value: unknown) => void = () => undefined
      wc.executeJavaScript.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      const floating = page.floatMainVideo()
      page.sitePictureInPicture()
      answer({ entered: true })
      await floating
      page.sitePictureInPicture()
      expect(sitePictureInPicture).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000)
      page.sitePictureInPicture()
      expect(sitePictureInPicture).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

