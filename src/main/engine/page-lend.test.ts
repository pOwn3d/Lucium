// The view of a page lent to Lucium's floating video window (ElectronPage.lendView): the real ElectronPage over a fake web contents
// (electron-page.test-support.ts). The view goes into the other window as it is, the layout of the tab's window cannot take it back while it is lent,
// and the loan ends when the page closes, crashes or goes to another document; given back, the tab's window shows it again.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeWindow, makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => vi.restoreAllMocks())

/** A page whose view can be lent to `host`, the window known as 'floating-video'. */
async function lendable() {
  const host = new FakeWindow(9)
  const other = new FakeWindow(2)
  const made = await makePage({ lendHost: (id) => (id === 'floating-video' ? host : undefined), relocate: (id) => (id === 'other' ? other : undefined) })
  return { ...made, host, other }
}

describe('lending the view of a page', () => {
  it('moves the view, as it is, out of the tab’s window into the other one, where it is placed and drawn again', async () => {
    const { page, win, view, wc, host } = await lendable()
    page.show({ x: 10, y: 10, width: 800, height: 600 })
    const loan = page.lendView('floating-video', vi.fn())!
    expect(loan).not.toBeNull()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(host.contentView.addChildView).toHaveBeenCalledWith(view)
    loan.place({ x: 0, y: 0, width: 480, height: 270 })
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 480, height: 270 })
    expect(wc.invalidate).toHaveBeenCalled()
    // Nothing loads again: the page is the same.
    expect(wc.loadURL).not.toHaveBeenCalled()
  })

  it('keeps the layout of the tab’s window from taking it back while it is lent: show, hide, raise, focus and a move to another window do nothing', async () => {
    const { page, win, view, wc } = await lendable()
    page.lendView('floating-video', vi.fn())
    win.contentView.addChildView.mockClear()
    win.contentView.removeChildView.mockClear()
    page.show({ x: 0, y: 0, width: 800, height: 600 })
    page.raise()
    page.hide()
    const focus = vi.spyOn(wc, 'focus')
    page.focus()
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(view.setBounds).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 })
    expect(focus).not.toHaveBeenCalled()
    expect(page.moveToWindow('other')).toBe(false)
  })

  it('goes to another window of the application once it is given back, not before', async () => {
    const { page } = await lendable()
    const loan = page.lendView('floating-video', vi.fn())!
    expect(page.moveToWindow('other')).toBe(false)
    loan.giveBack()
    expect(page.moveToWindow('other')).toBe(true)
  })

  it('is given back: the view leaves the other window, and the next layout of the tab’s window shows it there again', async () => {
    const { page, win, view, host } = await lendable()
    const ended = vi.fn()
    const loan = page.lendView('floating-video', ended)!
    loan.giveBack()
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(ended).not.toHaveBeenCalled()
    win.contentView.addChildView.mockClear()
    page.show({ x: 0, y: 0, width: 800, height: 600 })
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view)
    // A second give back, or a place after it, does nothing.
    host.contentView.removeChildView.mockClear()
    loan.giveBack()
    loan.place({ x: 0, y: 0, width: 1, height: 1 })
    expect(host.contentView.removeChildView).not.toHaveBeenCalled()
    expect(view.setBounds).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('ends when the page closes, crashes or goes to another document, which is told, and the view is out of the other window', async () => {
    for (const [event, why] of [['destroyed', 'gone'], ['render-process-gone', 'crashed'], ['did-navigate', 'navigated']] as const) {
      const { page, wc, view, host } = await lendable()
      const ended = vi.fn()
      page.lendView('floating-video', ended)
      const details = event === 'render-process-gone' ? { reason: 'crashed', exitCode: 133 } : {}
      wc.emit(event, {}, details)
      expect(ended, event).toHaveBeenCalledWith(why)
      expect(host.contentView.removeChildView, event).toHaveBeenCalledWith(view)
      // Once only.
      wc.emit(event, {}, details)
      expect(ended, event).toHaveBeenCalledTimes(1)
    }
  })

  it('ends when the tab closes its page', async () => {
    const { page, view, host } = await lendable()
    const ended = vi.fn()
    page.lendView('floating-video', ended)
    page.destroy()
    expect(ended).toHaveBeenCalledWith('gone')
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(view)
  })

  it('is refused for a window that is not known or is gone, and twice', async () => {
    const { page, host } = await lendable()
    expect(page.lendView('nowhere', vi.fn())).toBeNull()
    host.destroyed = true
    expect(page.lendView('floating-video', vi.fn())).toBeNull()
    host.destroyed = false
    expect(page.lendView('floating-video', vi.fn())).not.toBeNull()
    expect(page.lendView('floating-video', vi.fn())).toBeNull()
  })

  it('is refused by a page that can lend to no window', async () => {
    const { page } = await makePage()
    expect(page.lendView('floating-video', vi.fn())).toBeNull()
  })
})

describe('the floating video of a page', () => {
  it('is looked for in the page’s own world, and in its frames only when the page has none', async () => {
    const { page, wc } = await lendable()
    const embedded = { isDestroyed: () => false, detached: false, executeJavaScript: vi.fn(async () => false) }
    Object.assign(wc.mainFrame, { framesInSubtree: [Object.assign(wc.mainFrame, { isDestroyed: () => false, detached: false }), embedded] })
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true)
    expect(await page.findFloatingVideo()).toBe('page')
    expect(embedded.executeJavaScript).not.toHaveBeenCalled()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(false)
    expect(await page.findFloatingVideo()).toBe('none')
    // The video of an embedded player: the system's window takes it (Browser.floatTabVideo).
    embedded.executeJavaScript.mockResolvedValueOnce(true)
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(false)
    expect(await page.findFloatingVideo()).toBe('frame')
  })

  it('is read as the bar expects it, and nothing when the page answers something else', async () => {
    const { page, wc } = await lendable()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ paused: false, ended: false, muted: false, volume: 1, currentTime: 3, duration: 60, live: false, behindLive: false, protected: false, width: 640, height: 360 })
    expect(await page.floatingVideoFacts()).toMatchObject({ duration: 60, width: 640 })
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('nonsense')
    expect(await page.floatingVideoFacts()).toBeNull()
  })

  it('is driven with a user gesture (the user clicked the bar), and a failure is logged', async () => {
    const { page, wc } = await lendable()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true)
    expect(await page.floatingVideoCommand({ kind: 'toggle' })).toBe(true)
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenLastCalledWith(expect.any(Number), [expect.objectContaining({ code: expect.stringContaining('"kind":"toggle"') })], true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('boom'))
    expect(await page.floatingVideoCommand({ kind: 'pause' })).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not take "pause"'), 'boom')
  })

  it('says what was staged, and why nothing was', async () => {
    const { page, wc } = await lendable()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ staged: true, width: 1920, height: 1080, live: true, protected: true })
    expect(await page.stageFloatingVideo()).toEqual({ staged: true, width: 1920, height: 1080, live: true, protected: true })
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ staged: false, reason: 'no-video' })
    expect(await page.stageFloatingVideo()).toEqual({ staged: false, reason: 'no-video' })
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('Script failed to execute'))
    expect(await page.stageFloatingVideo()).toEqual({ staged: false, reason: 'error', detail: 'Script failed to execute' })
  })
})
