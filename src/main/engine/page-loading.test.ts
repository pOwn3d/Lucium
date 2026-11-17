// The spinner of a tab's row and the progress line of the toolbar are for the page itself: a frame of
// another site that loads inside a page (an advertisement that refreshes, a player) no longer turns them on for as long as it loads. And the
// processes of those frames, for the task manager. The page of the engine runs over a fake web contents (electron-page.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FORCED_LOADING_END_MS } from './loading-timer'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The loading the page told the shell, in order (the patches that say nothing of it left out). */
const loadings = (update: { mock: { calls: unknown[][] } }): boolean[] =>
  update.mock.calls.map(([patch]) => (patch as { loading?: boolean }).loading).filter((loading): loading is boolean => loading !== undefined)

describe('what a page says of its loading', () => {
  it('turns the spinner on for a load of the page itself, and off when the view stops loading', async () => {
    const { wc, events } = await makePage()
    wc.emit('did-start-loading')
    wc.emit('did-stop-loading')
    expect(loadings(events.update)).toEqual([true, false])
  })

  it('does not turn it on for a frame that loads inside the page', async () => {
    const { wc, events } = await makePage()
    wc.mainFrameLoading = false
    wc.emit('did-start-loading')
    wc.emit('did-stop-loading')
    // The end is still told (the shell publishes nothing for a tab that did not change).
    expect(loadings(events.update)).toEqual([false])
  })

  it('turns it on for a navigation of the page that starts while a frame is loading: Chromium announces no new start then', async () => {
    const { wc, events } = await makePage()
    wc.mainFrameLoading = false
    wc.emit('did-start-loading')
    wc.loading = true
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://site.example/b' })
    wc.emit('did-stop-loading')
    expect(loadings(events.update)).toEqual([true, false])
  })

  it('leaves the start to did-start-loading while the view loads nothing, and ignores the frames and the routes of a same document', async () => {
    const { wc, events } = await makePage()
    // A link to another application: nothing of the view loads, nothing would ever end the spinner.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'mailto:someone@site.example' })
    wc.loading = true
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://ads.example/frame' })
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://site.example/#top' })
    expect(loadings(events.update)).toEqual([])
  })

  it('tells that a frozen page loads even when only a frame does: the page is live again', async () => {
    const { page, wc, events } = await makePage()
    ;(page as unknown as { frozen: boolean }).frozen = true
    wc.mainFrameLoading = false
    wc.emit('did-start-loading')
    expect(loadings(events.update)).toEqual([true])
  })

  it('ends a load that Chromium never ends, counting from the navigation that turned it on', async () => {
    const { wc, events } = await makePage()
    vi.useFakeTimers()
    wc.mainFrameLoading = false
    wc.emit('did-start-loading')
    vi.advanceTimersByTime(FORCED_LOADING_END_MS - 5000)
    wc.loading = true
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://site.example/b' })
    // The count of the frame's load would have ended here: the page's own load has just begun.
    vi.advanceTimersByTime(6000)
    expect(loadings(events.update)).toEqual([true])
    vi.advanceTimersByTime(FORCED_LOADING_END_MS - 6000)
    expect(loadings(events.update)).toEqual([true, false])
  })
})

describe('the processes of the frames of a page (for the task manager)', () => {
  it('lists the processes of the frames of other sites, once each, the page\'s own excepted', async () => {
    const { page, wc } = await makePage()
    Object.assign(wc, { mainFrame: { framesInSubtree: [{ osProcessId: 4321 }, { osProcessId: 77 }, { osProcessId: 77 }, { osProcessId: 0 }, { osProcessId: 78 }] } })
    expect(page.frameProcessIds()).toEqual([77, 78])
  })

  it('keeps what it could read, and says why, when the frames cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    Object.assign(wc, {
      mainFrame: {
        get framesInSubtree(): never {
          throw new Error('Render frame was disposed')
        }
      }
    })
    expect(page.frameProcessIds()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('task manager'), 'Render frame was disposed')
  })
})
