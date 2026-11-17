// Engine checks for the notice over a page in HTML full screen (shell/fullscreen-notice.ts), run inside a real Electron: a local page takes the
// window with `requestFullscreen()`, and the notice must be above it, at the top of the window, name the site and Escape, leave the keyboard to the
// page, go after its time, come again when the page takes the window again, and go at once when the page leaves full screen. Escape itself must
// leave full screen (the lock of the keyboard is refused to pages): the notice says so.
// `LUCIUM_SMOKE_ONLY=fullscreen`: only these checks, with their own report.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { FULLSCREEN_NOTICE_MS } from '@shared/fullscreen-notice'
import { t } from '@shared/i18n'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 80)

const PAGE = `<!doctype html><title>fullscreen</title><body style="margin:0;background:#123"><div id="stage" style="width:100%;height:100vh">stage</div></body>`

export async function smokeFullscreen({ browser, store, win }: SmokeContext, check: Check): Promise<void> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  let tabId: string | null = null

  const pageInFullScreen = async (wc: WebContents): Promise<boolean> => (await wc.executeJavaScript('document.fullscreenElement !== null')) === true
  const enter = async (wc: WebContents): Promise<unknown> => wc.executeJavaScript(`document.documentElement.requestFullscreen().then(() => true, (error) => String(error))`, true)
  const leave = async (wc: WebContents): Promise<unknown> => wc.executeJavaScript(`document.fullscreenElement ? document.exitFullscreen().then(() => true, (error) => String(error)) : true`)
  const noticeText = async (): Promise<string> => {
    const view = browser.fullscreenNoticeForTest()
    return view ? String(await view.webContents.executeJavaScript('document.body.innerText')) : ''
  }

  try {
    browser.dispatch({ type: 'tab/open', url: `http://${host}/` })
    const tab = store.get().tabs.at(-1)!
    tabId = tab.id
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false && wcOf(tab.id)?.getURL().startsWith(`http://${host}`) === true)
    const wc = wcOf(tab.id)
    if (!wc) return check('fullscreen: the page of the test opened', false, JSON.stringify(store.get().tabs.map((item) => item.url)))

    // ---- a page takes the window: the notice is over it ----
    const entered = await enter(wc)
    check('fullscreen: the page takes the window in full screen after a gesture', entered === true && (await waitFor(() => pageInFullScreen(wc))), String(entered))
    const enteredAt = Date.now()
    check('fullscreen: a notice is drawn when a page takes the window', await waitFor(() => browser.fullscreenNoticeForTest() !== null, 5000))
    const view = browser.fullscreenNoticeForTest()
    if (view) {
      // The page of the notice, kept: once it is closed the view no longer gives it (`view.webContents` is undefined), and its end is read on it.
      const noticePage = view.webContents
      const children = win.contentView.children
      check('fullscreen: the notice is above every view of the window, the page in full screen included', children.at(-1) === view, `${children.indexOf(view)} of ${children.length}`)
      // Read first: the notice lasts a few seconds, and the animation of macOS into full screen takes about one of them.
      const text = await noticeText()
      check('fullscreen: the notice names the site that took the window', text.includes(t('fullscreen-notice.site-en-plein-ecran', { host })), text)
      check('fullscreen: the notice says that Escape leaves full screen', text.includes(t('fullscreen-notice.echap-pour-quitter')), text)
      check('fullscreen: the notice leaves the keyboard to the page', !view.webContents.isFocused(), `page focused: ${wc.isFocused()}`)
      // The window grows to the screen while macOS animates it into full screen: the layout follows each resize, and the place is judged on the window
      // as it is when it is looked at.
      const placed = (): boolean => {
        const content = win.getContentBounds()
        const bounds = view.getBounds()
        return Math.abs(bounds.x + bounds.width / 2 - content.width / 2) <= 2 && bounds.y >= 0 && bounds.y < 40 && bounds.width <= content.width && bounds.height < 160
      }
      const inFullScreen = await waitFor(() => win.isFullScreen() && placed(), 3000)
      check('fullscreen: the notice sits centred at the top of the window, inside it, once the window is in full screen', inFullScreen, JSON.stringify({ bounds: view.getBounds(), content: win.getContentBounds(), fullScreen: win.isFullScreen() }))
      // ---- it goes by itself ----
      const left = Math.max(0, enteredAt + FULLSCREEN_NOTICE_MS - Date.now())
      check('fullscreen: the notice is still there before its time is over', left < 300 || browser.fullscreenNoticeForTest() === view, `${left} ms left`)
      const gone = await waitFor(() => browser.fullscreenNoticeForTest() === null && !win.contentView.children.includes(view), left + 3000)
      check('fullscreen: the notice goes by itself after its time, its page closed with it', gone && noticePage.isDestroyed())
      check('fullscreen: the page stays in full screen when the notice goes', await pageInFullScreen(wc))
    }

    // ---- Escape leaves full screen ----
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    check('fullscreen: Escape leaves full screen, as the notice says', await waitFor(async () => !(await pageInFullScreen(wc)), 5000))
    if (await pageInFullScreen(wc)) await leave(wc)
    await waitFor(() => !win.isFullScreen(), 5000)

    // ---- taken again: announced again, and gone at once when the page leaves ----
    const again = await enter(wc)
    check('fullscreen: a page that takes the window again is announced again', again === true && (await waitFor(() => browser.fullscreenNoticeForTest() !== null, 5000)), String(again))
    const secondPage = browser.fullscreenNoticeForTest()?.webContents
    await leave(wc)
    check('fullscreen: the notice goes at once with the full screen, before its time', await waitFor(() => browser.fullscreenNoticeForTest() === null && (secondPage === undefined || secondPage.isDestroyed()), 3000))
  } finally {
    // The next suites start from a window that is not in full screen.
    const wc = tabId !== null ? wcOf(tabId) : undefined
    if (wc && !wc.isDestroyed()) await leave(wc).catch((error: unknown) => console.warn('[smoke fullscreen] the page could not be asked to leave full screen:', error))
    await waitFor(() => !win.isFullScreen(), 5000)
    if (tabId !== null) browser.dispatch({ type: 'tab/close', id: tabId })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=fullscreen`: only these checks, with their own report. */
export async function runFullscreenSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeFullscreen(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeFullscreen ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_FULLSCREEN ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
