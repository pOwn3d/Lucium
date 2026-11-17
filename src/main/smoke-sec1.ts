// Engine checks for security fixes, run inside a real Electron: the surfaces of the interface cannot be sent
// to a remote page, a page cannot open what is not the web or open windows without a click, permissions are decided on the protocol of the
// page and never remembered for the origin "null", the request filter cannot suspend a request, downloads of one name do not share a file,
// the HTTP authentication cache is forgotten with a profile or a site, and the private window lets go of its session.
// `smokeSec1` is what smoke.ts calls (it opens no private window); `smokeSec1Late` opens private windows and runs last (index.ts), because
// smoke-windows looks for the first ephemeral session ("ephemeral-1"). `LUCIUM_SMOKE_ONLY=sec1` runs both (quick loop).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { app, BrowserWindow, ipcMain, Menu, net, session, WebContentsView, webContents as allWebContents, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { isAppUrl } from '@shared/surface-guard'
import { littleForms } from '@shared/little-name'
import type { DownloadInfo } from '@shared/model'
import { SUGGEST_FETCH_INIT } from './suggestions'
import { appRoots, isSurfaceLocked } from './shell/surface-guard'
import { getWindowManager } from './shell/windows'
import { setNoticeSink, type SystemNotice } from './shell/system-notice'
import type { SmokeContext } from './smoke'
import { isBuiltApp } from './runtime'
import type { PageEvents } from './engine/types'
import { anySpace, noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

const evaluate = <T>(wc: WebContents, script: string, gesture = false): Promise<T> => wc.executeJavaScript(script, gesture) as Promise<T>

/** For a script whose own result does not matter (it navigates, or tries to): a rejection is told, and the check that follows judges the outcome. */
const noted =
  (what: string) =>
  (error: unknown): undefined => {
    console.warn(`[sec1] ${what} was rejected:`, error instanceof Error ? error.message : error)
    return undefined
  }

/**
 * The witness of a navigation that must be refused: the verdict of the guard of `wc` on the first navigation whose address contains `marker`.
 * The listener is added after the guard's own, so it reads what the guard decided. `verdict()` is undefined until the request has reached the
 * browser, then whether it was refused: once it is known, a refused navigation can no longer load anything.
 */
function navigationVerdict(wc: WebContents, marker: string): { verdict: () => boolean | undefined; stop: () => void } {
  let refused: boolean | undefined
  const listener = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
    if (refused === undefined && event.url.includes(marker)) refused = event.defaultPrevented
  }
  wc.on('will-frame-navigate', listener)
  return { verdict: () => refused, stop: () => void wc.off('will-frame-navigate', listener) }
}

/** A script that calls window.open and answers what the page got: 'null' when the browser opened nothing, which it has decided by then. */
const openScript = (url: string): string => `window.open(${JSON.stringify(url)}) === null ? 'null' : 'a window'`

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The server of the checks. Every request is counted by path; the routes below answer what a check needs. */
function startServer() {
  const hits = new Map<string, number>()
  const cookies: Array<string | undefined> = []
  const held: ServerResponse[] = []
  let challenges = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (path !== '/favicon.ico') hits.set(path, (hits.get(path) ?? 0) + 1)
    if (path === '/secret') {
      const sent = req.headers.authorization
      if (sent && Buffer.from(sent.replace(/^Basic /, ''), 'base64').toString() === 'ada:lovelace') {
        res.setHeader('content-type', 'text/html')
        return res.end('<title>secret ok</title><body>ok</body>')
      }
      challenges++
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="sec1"')
      res.setHeader('content-type', 'text/html')
      return res.end('<title>refus 401</title><body>refus</body>')
    }
    if (path === '/suggest') {
      cookies.push(req.headers.cookie)
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'max-age=3600')
      return res.end('["ar",["lucium"]]')
    }
    if (path === '/slow-dl') {
      // The headers and a first chunk go out now, the rest when the check says so: two such downloads run together.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="race.bin"' })
      res.write(Buffer.alloc(1024, 3))
      held.push(res)
      return
    }
    if (path === '/to-app') {
      // A server that sends the browser to another application: not a navigation the page can see coming, so it reaches the permission.
      res.statusCode = 302
      res.setHeader('location', 'x-sec1-app://open?doc=1')
      return res.end()
    }
    if (path === '/frame-links') {
      // A page with a frame of another site (`localhost` against `127.0.0.1`): an advertisement or a widget whose link goes to another application.
      const port = (req.headers.host ?? '').split(':')[1] ?? ''
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>frame links</title><body style="margin:0"><iframe id="frame" src="http://localhost:${port}/frame-app" style="position:absolute;left:20px;top:20px;width:240px;height:120px;border:0"></iframe></body>`)
    }
    if (path === '/frame-app') {
      res.setHeader('content-type', 'text/html')
      // The link counts the clicks it gets: the check tells a click that never reached the frame from a link that was not asked about.
      return res.end('<body style="margin:0"><a id="go" href="x-sec1-app://frame?doc=2" onclick="window.__clicks = (window.__clicks || 0) + 1" style="display:block;width:240px;height:120px;background:#cde">appli</a></body>')
    }
    if (path === '/opener') {
      res.setHeader('content-type', 'text/html')
      // Each button counts its clicks once its code has run: window.open waits for the browser's answer, so a counted click is one the browser
      // has decided on, and a check of "nothing opened" reads the outcome after that witness instead of after a fixed time.
      const button = (id: string, top: number, code: string) => `<button id="${id}" style="position:absolute;left:20px;top:${top}px;width:220px;height:36px" onclick="try { ${code} } finally { window.__clicked = (window.__clicked || 0) + 1 }">${id}</button>`
      return res.end(`<title>opener</title><body style="margin:0">
        ${button('web', 20, `window.open('/opened-web')`)}
        ${button('file', 70, `window.open('file:///etc/hosts')`)}
        ${button('extension', 120, `window.open('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')`)}
        ${button('burst', 170, `for (let i = 0; i < 5; i++) window.open('/opened-burst-' + i)`)}
        <a id="app" href="/to-app" style="position:absolute;left:20px;top:270px;width:220px;height:36px;display:block;background:#cde">appli</a>
        <a id="blank" target="_blank" href="/opened-link" style="position:absolute;left:20px;top:220px;width:220px;height:36px;display:block;background:#ccc">lien</a>
        <iframe id="frame" src="about:blank" style="position:absolute;left:300px;top:20px;width:200px;height:100px"></iframe>
      </body>`)
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<title>sec1 ${path}</title><body>${path} text</body>`)
  })
  return {
    server,
    hits: (path: string) => hits.get(path) ?? 0,
    cookies,
    held,
    challenges: () => challenges
  }
}

export async function smokeSec1(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView, little } = ctx
  const { server, hits, cookies, held, challenges } = startServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const roots = appRoots(join(__dirname, '../renderer'), isBuiltApp())
  const state = () => store.get()
  const tabs = () => state().tabs
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : allWebContents.fromId(number) ?? undefined
  }
  const opened: string[] = []
  const openTab = async (url: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = tabs().at(-1)!
    opened.push(tab.id)
    await waitFor(() => pageOf(tab.id) !== undefined)
    const wc = pageOf(tab.id)!
    await waitFor(() => !wc.isLoading() && wc.getURL() === url)
    return { id: tab.id, wc }
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const clickOn = async (wc: WebContents, selector: string): Promise<boolean> => {
    const rect = await evaluate<Rect | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!rect) return false
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
    await sleep(500)
    return true
  }
  /**
   * A left click at a place of the tab sent through the input router of the browser (the DevTools protocol), which hands it to the process that
   * draws the frame under the pointer: the way to click in a frame of another site. Answers 'sent', or why the click could not be sent.
   */
  const clickThroughRouter = async (wc: WebContents, x: number, y: number): Promise<string> => {
    const own = !wc.debugger.isAttached()
    try {
      if (own) wc.debugger.attach('1.3')
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
      }
      return 'sent'
    } catch (error) {
      return `the click could not be sent: ${String((error as Error)?.message ?? error)}`
    } finally {
      if (own && wc.debugger.isAttached()) wc.debugger.detach()
    }
  }
  win.showInactive()
  let priorSettings: { peekWithShift: boolean; peekOnExternalLinks: boolean } | null = null

  try {
    // =============== the surfaces of the interface cannot leave it ===============
    const surfaces = () => allWebContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && isAppUrl(wc.getURL(), roots))
    // The floating sidebar is made only while the sidebar is hidden: it is made here so that it is tried with the others.
    browser.prepareFloatingSidebar()
    // In the quick loop nothing else has run: the pages of the interface are still loading.
    await waitFor(() => surfaces().length >= 3, 15_000)
    const unlocked = surfaces().filter((wc) => !isSurfaceLocked(wc))
    check('every web contents that shows a page of the interface is locked', surfaces().length >= 3 && unlocked.length === 0, JSON.stringify({ surfaces: surfaces().map((wc) => wc.getURL().split('/').pop()), unlocked: unlocked.map((wc) => wc.getURL()) }))

    // The Settings window, the task manager and a mini window are surfaces too: open them to try.
    browser.openOverlay({ panel: 'settings' })
    const settingsWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === 'Réglages')
    await waitFor(() => settingsWindow() !== undefined)
    const menuItem = (...path: string[]) => {
      let items = Menu.getApplicationMenu()!.items
      let found
      for (const label of path) {
        found = items.find((i) => i.label === label)
        items = found?.submenu?.items ?? []
      }
      return found
    }
    menuItem('Aide', 'Dépannage', 'Ouvrir le gestionnaire de tâches')?.click()
    const taskWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === 'Gestionnaire de tâches')
    await waitFor(() => taskWindow() !== undefined)
    const littleId = little.open(`${base}/little-page`)
    const littleWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(`id=${littleId}`))
    await waitFor(() => littleWindow() !== undefined)
    // Pages of the interface take a moment to be loaded and to answer scripts.
    await sleep(1200)

    const floating = surfaces().find((wc) => wc.getURL().includes('#float'))
    const named: Array<[string, WebContents | undefined]> = [
      ['main window', win.webContents],
      ['panels layer', overlayView.webContents],
      ['floating sidebar', floating],
      ['Settings window', settingsWindow()?.webContents],
      ['task manager', taskWindow()?.webContents],
      ['Little Arc window', littleWindow()?.webContents]
    ]
    check('the main window, the panels layer, the floating sidebar, Settings, the task manager and Little Arc are all there to be tried', named.every(([, wc]) => wc !== undefined), named.filter(([, wc]) => !wc).map(([name]) => name).join())
    check('...and every one of them is locked', named.every(([, wc]) => wc !== undefined && isSurfaceLocked(wc)))

    for (const [name, wc] of named) {
      if (!wc) continue
      const before = wc.getURL()
      const windows = BrowserWindow.getAllWindows().length
      const contents = allWebContents.getAllWebContents().length
      const slug = name.replace(/\W+/g, '-')
      // The witnesses: the guard's verdict on the navigation, and what window.open gave the page (it waits for the browser's decision).
      const navigation = navigationVerdict(wc, `/surface-nav/${slug}`)
      await evaluate(wc, `location.href = ${JSON.stringify(`${base}/surface-nav/${slug}`)}; 0`, true).catch(noted('a script of the check'))
      const opening = await evaluate<string>(wc, openScript(`${base}/surface-open/${slug}`), true).catch(noted('a script of the check'))
      await waitFor(() => navigation.verdict() !== undefined)
      navigation.stop()
      check(`${name}: a script cannot send it to a remote page`, navigation.verdict() === true && !wc.isDestroyed() && wc.getURL() === before && hits(`/surface-nav/${slug}`) === 0, `refused=${String(navigation.verdict())} ${wc.isDestroyed() ? 'destroyed' : wc.getURL()} hits=${hits(`/surface-nav/${slug}`)}`)
      check(`${name}: window.open from it opens nothing`, opening === 'null' && hits(`/surface-open/${slug}`) === 0 && BrowserWindow.getAllWindows().length === windows && allWebContents.getAllWebContents().length === contents, `window.open=${String(opening)} hits=${hits(`/surface-open/${slug}`)} windows ${windows}->${BrowserWindow.getAllWindows().length} contents ${contents}->${allWebContents.getAllWebContents().length}`)
      // A drop: Chromium opens what is dropped on a document that does not take it. Synthetic events cannot start that navigation, but
      // they show whether the document cancels the drop (the page's default) for a foreign drag and leaves our own alone.
      const drops = await evaluate<{ foreign: boolean[]; files: boolean[]; internal: boolean[] }>(
        wc,
        `(() => {
          const fire = (types) => {
            const dt = new DataTransfer()
            for (const [type, value] of types) dt.setData(type, value)
            const out = []
            for (const name of ['dragover', 'drop']) {
              const event = new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: dt })
              document.body.dispatchEvent(event)
              out.push(event.defaultPrevented)
            }
            return out
          }
          const files = new DataTransfer()
          files.items.add(new File(['x'], 'x.txt'))
          const fileEvents = ['dragover', 'drop'].map((name) => { const e = new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: files }); document.body.dispatchEvent(e); return e.defaultPrevented })
          return {
            foreign: fire([['text/uri-list', 'https://example.com/'], ['text/plain', 'https://example.com/']]),
            files: fileEvents,
            internal: fire([['application/x-lucium-tab', 'x']])
          }
        })()`
      )
      check(`${name}: a link or a file dropped on it is cancelled, one of its own drags is not`, drops.foreign.every(Boolean) && drops.files.every(Boolean) && drops.internal.every((prevented) => !prevented), JSON.stringify(drops))
    }

    // =============== client certificates ===============
    const certificateEvent = { preventDefault: () => (certificateEvent.prevented = true), prevented: false }
    let certificateAnswers: unknown[][] = []
    // No notice of the system is made for the refusal any more: one made by mistake is recorded here, not shown on the machine the run is on.
    const certificateNotices: SystemNotice[] = []
    const releaseCertificateNotices = setNoticeSink((notice) => {
      certificateNotices.push(notice)
      return true
    })
    try {
      // No page of a tab made these requests (no web contents): nobody is told, and the journal says so.
      app.emit('select-client-certificate', certificateEvent, null, 'https://mtls.example/', [{ subjectName: 'the user' }], (...args: unknown[]) => certificateAnswers.push(args))
      app.emit('select-client-certificate', { preventDefault: () => undefined }, null, 'https://mtls.example/again', [], () => undefined)
    } finally {
      releaseCertificateNotices()
    }
    check('a server that asks for a client certificate gets none, and Electron is stopped from choosing the first of the keychain', app.listenerCount('select-client-certificate') >= 1 && certificateEvent.prevented && certificateAnswers.length === 1 && certificateAnswers[0]!.length === 0, JSON.stringify({ listeners: app.listenerCount('select-client-certificate'), prevented: certificateEvent.prevented, answers: certificateAnswers }))
    check('a refused client certificate is no longer said by a notice of the system', certificateNotices.length === 0, JSON.stringify(certificateNotices))
    certificateAnswers = []

    // =============== what a page may open ===============
    priorSettings = { peekWithShift: state().settings.peekWithShift, peekOnExternalLinks: state().settings.peekOnExternalLinks }
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: false, peekOnExternalLinks: false } })
    browser.closeOverlay()
    // A web page cannot even ask for a file: address (Blink stops it before the browser hears of it): a page of the user's own files can.
    const pagesDir = mkdtempSync(join(tmpdir(), 'lucium-sec1-'))
    const fileOpener = join(pagesDir, 'opener.html')
    writeFileSync(fileOpener, `<title>file opener</title><body style="margin:0"><button id="file" style="position:absolute;left:20px;top:20px;width:220px;height:36px" onclick="try { window.open('file:///etc/hosts') } finally { window.__clicked = (window.__clicked || 0) + 1 }">file</button></body>`)
    const permissionFile = join(pagesDir, 'permission.html')
    writeFileSync(permissionFile, `<title>asking</title><script>navigator.geolocation.getCurrentPosition(() => { document.title = 'granted' }, (e) => { document.title = 'denied:' + e.code })</script>`)
    const opener = await openTab(`${base}/opener`)
    // A server asks the page of a tab for a client certificate: the window of that tab says so in a notice of its own, which names the site.
    const certificateTold = (): string => browser.snapshot().toast?.message ?? ''
    app.emit('select-client-certificate', { preventDefault: () => undefined }, opener.wc, 'https://mtls-tab.example:8443/login?token=s3cr3t', [{ subjectName: 'the user' }], () => undefined)
    const certificateSaid = await waitFor(() => certificateTold().includes('mtls-tab.example:8443'), 4000)
    check('the user is told in the window of the tab that no certificate was presented, with the site and nothing else of the address', certificateSaid && anySpace(/Lucium n’en présente aucun/).test(certificateTold()) && !/s3cr3t|login/.test(certificateTold()), certificateTold())
    const tabCount = () => tabs().length
    // A tab that window.open opens comes to the front and hides this one: a click only reaches it once it is shown again.
    const reshow = async () => {
      browser.dispatch({ type: 'tab/select', id: opener.id })
      await sleep(500)
    }
    // The handler of the page opens its tab while window.open waits for its answer: once the page has its answer, a tab it opened is in the state.
    // So a check of "nothing opened" reads the state after that witness: the answer of the script, or the click a button has finished handling.
    const clicksDone = (wc: WebContents): Promise<number> => evaluate<number>(wc, 'window.__clicked ?? 0')
    const clickDone = async (wc: WebContents, selector: string): Promise<boolean> => {
      const done = await clicksDone(wc)
      return (await clickOn(wc, selector)) && (await waitFor(async () => (await clicksDone(wc)) > done))
    }
    let before = tabCount()
    const scripted = await evaluate<string>(opener.wc, openScript(`${base}/opened-script`)).catch(noted('a script of the check'))
    check('window.open from a script with no click opens nothing', scripted === 'null' && tabCount() === before && hits('/opened-script') === 0, `window.open=${String(scripted)} tabs ${before}->${tabCount()}`)
    before = tabCount()
    await reshow()
    const forbiddenClicks = (await clickDone(opener.wc, '#file')) && (await clickDone(opener.wc, '#extension'))
    check('a click that makes the page open a file: or an extension page opens nothing', forbiddenClicks && tabCount() === before && !tabs().some((t) => t.url.startsWith('file:') || t.url.startsWith('chrome-extension:')), `clicks handled=${forbiddenClicks} tabs ${before}->${tabCount()}: ${tabs().slice(before).map((t) => t.url)}`)
    const localOpener = await openTab(`file://${fileOpener}`)
    before = tabCount()
    const localClick = await clickDone(localOpener.wc, '#file')
    check('...and a page of the user’s files that asks for another file: gets nothing either', localClick && tabCount() === before && !tabs().slice(before).some((t) => t.url.startsWith('file:')), `click handled=${localClick} tabs ${before}->${tabCount()}: ${tabs().slice(before).map((t) => t.url)}`)
    await reshow()
    await clickOn(opener.wc, '#web')
    check('window.open on a click opens the web address in a tab', await waitFor(() => tabs().some((t) => t.url === `${base}/opened-web`)), `${tabs().slice(before).map((t) => t.url)}`)
    for (const tab of tabs().slice(before)) opened.push(tab.id)
    before = tabCount()
    await reshow()
    const burst = await clickDone(opener.wc, '#burst')
    check('five window.open calls from one click open one tab, not five', burst && tabCount() === before + 1, `click handled=${burst} tabs ${before}->${tabCount()}: ${tabs().slice(before).map((t) => t.url)}`)
    for (const tab of tabs().slice(before)) opened.push(tab.id)
    before = tabCount()
    const afterBurst = await evaluate<string>(opener.wc, openScript(`${base}/opened-after`)).catch(noted('a script of the check'))
    check('...and a script that asks again once that click is used up gets nothing', afterBurst === 'null' && tabCount() === before && hits('/opened-after') === 0, `window.open=${String(afterBurst)} tabs ${before}->${tabCount()}`)
    await reshow()
    await clickOn(opener.wc, '#blank')
    check('a link with target=_blank that is clicked still opens a tab', await waitFor(() => tabs().some((t) => t.url === `${base}/opened-link`)), `${tabs().slice(before).map((t) => t.url)}`)
    for (const tab of tabs().slice(before)) opened.push(tab.id)

    // A Glance asked for an address the browser cannot load leaves nothing behind.
    await sleep(800)
    const pagesBefore = engine.pageCount()
    for (const url of ['javascript:alert(1)', 'data:text/html,<p>x</p>', 'file:///etc/hosts', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'devtools://devtools/bundled/inspector.html']) browser.openPeek(url)
    // No wait: openPeek decides before it returns (shell/browser-panels.ts), and an address it takes has its page and its preview at once.
    check('a Glance of javascript:, data:, file:, an extension or devtools address creates no page, no preview and no panel', engine.pageCount() === pagesBefore && browser.snapshot().peek === null && browser.currentPanel() === null, JSON.stringify({ pages: [pagesBefore, engine.pageCount()], peek: browser.snapshot().peek, panel: browser.currentPanel() }))

    // The mini window stays on the web: the handler a page's links reach is checked on its own.
    const littleNow = littleWindow()
    const littlePage = littleNow ? (engine as unknown as { pages: Map<string, { events: PageEvents }> }).pages.get(littleId) : undefined
    await waitFor(() => littleWindow() !== undefined && (little.states().find((s) => s.id === littleId)?.url ?? '').includes('/little-page'))
    const refused: string[] = []
    if (littlePage) {
      for (const target of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x']) {
        try {
          littlePage.events.openWindow(target, 'foreground')
        } catch (error) {
          // A handler that passes the address on makes the engine refuse it with an exception: the check below reports it.
          refused.push(`${target.split(':')[0]}: ${(error as Error).message}`)
        }
      }
      await sleep(500)
    }
    check('links that reach the handler of a Little Arc window do not take it to file:, javascript: or data:', !!littlePage && refused.length === 0 && (little.states().find((s) => s.id === littleId)?.url ?? '').startsWith(base), JSON.stringify({ url: little.states().find((s) => s.id === littleId)?.url, refused }))

    // A message that does not come from the top frame of a surface is not answered. A frame inside one has no preload and cannot send any: the
    // events are made up, with the real web contents of the window as sender, and handed to the listeners that ipcMain holds.
    const fromFrame = (contents: WebContents, frame: unknown) => ({ sender: contents, senderFrame: frame })
    ipcMain.emit(Channel.openOverlay, fromFrame(win.webContents, { notTheMainFrame: true }), { panel: 'find' })
    ipcMain.emit(Channel.openOverlay, fromFrame(win.webContents, null), { panel: 'find' })
    check('a message from a frame that is not the top frame of the window opens nothing', browser.currentPanel() === null, String(browser.currentPanel()))
    ipcMain.emit(Channel.openOverlay, fromFrame(win.webContents, win.webContents.mainFrame), { panel: 'find' })
    check('...while the same message from the top frame is answered (the control)', browser.currentPanel() === 'find', String(browser.currentPanel()))
    browser.closeOverlay()
    const littleContents = littleWindow()?.webContents
    check('the mini window is there, for the check of the frames that may command it', littleContents !== undefined)
    if (littleContents) {
      ipcMain.emit(Channel.littleAction, fromFrame(littleContents, { notTheMainFrame: true }), littleId, 'close')
      // A fixed wait, for want of a witness: a close the command started would end later, and the same command from the top frame closes
      // the window just the same, so it cannot tell that close from its own.
      await sleep(400)
      check('a command to a Little Arc window from a frame that is not its top frame does nothing', littleWindow() !== undefined)
    }

    // The menu of a link offers to open it only when it is a web link; any link can be copied.
    const linkMenu = (linkURL: string): string[] => {
      let template: MenuItemConstructorOptions[] = []
      const realBuild = Menu.buildFromTemplate
      Menu.buildFromTemplate = ((items: MenuItemConstructorOptions[]) => {
        template = items
        return { popup: () => {} } as unknown as Menu
      }) as typeof Menu.buildFromTemplate
      try {
        opener.wc.emit('context-menu', {}, { linkURL, mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 0, y: 0, misspelledWord: '', dictionarySuggestions: [] })
      } finally {
        Menu.buildFromTemplate = realBuild
      }
      return template.map((item) => item.label ?? '').filter(Boolean)
    }
    const webMenu = linkMenu('https://example.com/a')
    const fileMenu = linkMenu('file:///etc/hosts')
    check('the context menu of a web link offers to open it (tab, background, Glance, Little Arc) and to copy it', ['Ouvrir le lien dans un nouvel onglet', 'Aperçu du lien (Coup d’œil)', `Ouvrir dans une ${littleForms('fr').s}`, 'Copier l’adresse du lien'].every((label) => webMenu.includes(label)), JSON.stringify(webMenu))
    check('...and the menu of a file: link only offers to copy it', fileMenu.includes('Copier l’adresse du lien') && !fileMenu.some((label) => label.startsWith('Ouvrir') || label.startsWith('Aperçu')), JSON.stringify(fileMenu))

    // =============== the actions of an error page, and the document it is written into ===============
    const wcOpener = opener.wc
    const seen: Array<{ kind: string; prevented: boolean }> = []
    wcOpener.on('will-navigate', (event, url) => {
      if (url.startsWith('lucium-error:')) seen.push({ kind: 'main', prevented: event.defaultPrevented })
    })
    wcOpener.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && event.url.startsWith('lucium-error:')) seen.push({ kind: 'frame', prevented: event.defaultPrevented })
    })
    await evaluate(wcOpener, `location.href = 'lucium-error:evil?n=nonce'; 0`, true).catch(noted('a script of the check'))
    await waitFor(() => seen.some((s) => s.kind === 'main'))
    await evaluate(wcOpener, `document.getElementById('frame').contentWindow.location.href = 'lucium-error:retry?n=nonce'; 0`, true).catch(noted('a script of the check'))
    await waitFor(() => seen.some((s) => s.kind === 'frame'))
    check('a page that sends itself to an error page action with no real one behind it is cancelled', seen.some((s) => s.kind === 'main' && s.prevented), JSON.stringify(seen))
    check('...and a frame of a page cannot press the buttons of an error page', seen.some((s) => s.kind === 'frame' && s.prevented), JSON.stringify(seen))

    const stale = await openTab(`${base}/stale-ok`)
    const errorsOf = () => (engine as unknown as { pages: Map<string, { errors: { pending: unknown } }> }).pages.get(stale.id)?.errors
    stale.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://nowhere.invalid/', true)
    check('a failed load is remembered until its error document is committed', errorsOf()?.pending != null)
    stale.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${base}/stale-ok-2` })
    check('...and forgotten as soon as another navigation starts', errorsOf()?.pending === null || errorsOf()?.pending === undefined)
    stale.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://nowhere.invalid/', true)
    stale.wc.emit('dom-ready')
    await sleep(500)
    const staleText = await evaluate<string>(stale.wc, 'document.body.innerText')
    check('an error page is never written into a document that is not the one that failed', staleText.includes('/stale-ok text') && !staleText.includes('Impossible'), staleText.slice(0, 120))

    // =============== permissions ===============
    const filePage = await openTab(`file://${permissionFile}`)
    const answered = await waitFor(() => /^(granted|denied)/.test(tabs().find((t) => t.id === filePage.id)?.title ?? ''), 10_000)
    check('a file: page that asks for a permission is refused at once, with no prompt', answered && tabs().find((t) => t.id === filePage.id)?.title === 'denied:1' && browser.currentPanel() !== 'permission', `${tabs().find((t) => t.id === filePage.id)?.title} panel=${browser.currentPanel()}`)
    check('...and nothing is remembered for the origin "null"', Object.keys(state().sitePermissions).every((origin) => origin !== 'null'), JSON.stringify(Object.keys(state().sitePermissions)))
    rmSync(pagesDir, { recursive: true, force: true })

    const asker = browser as unknown as { askPermission(origin: string, permission: string, pageId?: string, detail?: string): Promise<boolean>; overlayRequest: { panel: string; request?: { id: string } } | null }
    // A prompt a failed check left on screen would hold this one in the queue: closing the panel refuses it.
    browser.closeOverlay()
    const answer = async (origin: string, permission: string, detail: string | undefined, allow: boolean, remember: boolean) => {
      const decision = asker.askPermission(origin, permission, undefined, detail)
      await waitFor(() => asker.overlayRequest?.panel === 'permission', 4000)
      await waitFor(() => evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble')`).catch(() => false), 4000)
      const prompt = await evaluate<string>(overlayView.webContents, `document.querySelector('.iv-bubble')?.innerText ?? ''`).catch(() => '')
      const hasCheckbox = await evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble .iv-remember')`).catch(() => false)
      const id = asker.overlayRequest?.request?.id
      if (id) browser.answerPermission(id, allow, remember)
      // Never wait for ever on a prompt that was not the one asked for.
      await Promise.race([decision, sleep(3000)])
      return { prompt, hasCheckbox }
    }
    const external = await answer('https://mail.example', 'openExternal', 'mailto:', true, true)
    check('the prompt of an external application says which scheme would open, and does not offer to remember', external.prompt.includes('mailto:') && !external.hasCheckbox, JSON.stringify(external))
    check('...and an answer "remember" to it keeps nothing, so the origin does not get every scheme', state().sitePermissions['https://mail.example']?.['openExternal'] === undefined, JSON.stringify(state().sitePermissions['https://mail.example']))
    // « Toujours ouvrir les liens de ce type depuis ce site »: the question of a link a click explains comes under a name that carries the scheme.
    const always = await answer('https://meet.example', 'openExternal:x-sec1-app:', 'x-sec1-app:', true, true)
    check('the question about a link to another application that a click explains offers to always open the links of this type from this site', always.hasCheckbox && always.prompt.includes('x-sec1-app:') && anySpace(/Toujours ouvrir les liens de ce type depuis ce site/).test(always.prompt), JSON.stringify(always))
    check('...and the yes is kept for that scheme of that site, not for the site as a whole', state().sitePermissions['https://meet.example']?.['openExternal:x-sec1-app:'] === 'allow' && state().sitePermissions['https://meet.example']?.['openExternal'] === undefined, JSON.stringify(state().sitePermissions['https://meet.example']))
    await answer('https://meet.example', 'openExternal:x-sec1-other:', 'x-sec1-other:', false, true)
    check('...a no with the box ticked keeps nothing', state().sitePermissions['https://meet.example']?.['openExternal:x-sec1-other:'] === undefined, JSON.stringify(state().sitePermissions['https://meet.example']))
    const neverLeaves = await answer('https://meet.example', 'openExternal:file:', 'file:', true, true)
    check('...and a scheme that never leaves the browser is offered no box and keeps nothing', !neverLeaves.hasCheckbox && state().sitePermissions['https://meet.example']?.['openExternal:file:'] === undefined, JSON.stringify(neverLeaves))
    browser.dispatch({ type: 'permission/set', origin: 'https://meet.example', permission: 'openExternal:x-sec1-app:', decision: null })
    await answer('null', 'geolocation', undefined, true, true)
    check('an answer "remember" for the origin "null" keeps nothing', state().sitePermissions['null'] === undefined, JSON.stringify(state().sitePermissions['null']))
    const plain = await answer('https://where.example', 'geolocation', undefined, true, true)
    check('...while the same answer for a web origin is kept (the control)', state().sitePermissions['https://where.example']?.['geolocation'] === 'allow' && plain.hasCheckbox, JSON.stringify(state().sitePermissions['https://where.example']))
    browser.dispatch({ type: 'permission/set', origin: 'https://where.example', permission: 'geolocation', decision: null })

    // The real thing: a redirect to another application's scheme makes Chromium ask the permission "openExternal" for the page's origin.
    await reshow()
    await clickOn(opener.wc, '#app')
    const appAsked = await waitFor(() => asker.overlayRequest?.panel === 'permission', 6000)
    await waitFor(() => evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble')`).catch(() => false), 4000)
    const appPrompt = await evaluate<string>(overlayView.webContents, `document.querySelector('.iv-bubble')?.innerText ?? ''`).catch(() => '')
    const appRemember = await evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble .iv-remember')`).catch(() => true)
    check('a redirect to the scheme of another application asks the user, and the prompt names that scheme', appAsked && appPrompt.includes('x-sec1-app:') && !appRemember, JSON.stringify({ appAsked, appPrompt, appRemember }))
    browser.closeOverlay()

    // A frame of another site whose link goes to another application, on a page whose site the user always lets open such links: the plain
    // question, under the frame's own site, without the box; the yes kept for the page does not answer for the frame.
    browser.dispatch({ type: 'permission/set', origin: base, permission: 'openExternal:x-sec1-app:', decision: 'allow' })
    const framePage = await openTab(`${base}/frame-links`)
    const frameSite = base.replace('127.0.0.1', 'localhost')
    // The link of the frame is there to be clicked once the frame's document has loaded.
    const frameReady = async (): Promise<boolean> => {
      const frame = framePage.wc.mainFrame.framesInSubtree.find((candidate) => candidate.origin === frameSite && candidate.url.endsWith('/frame-app'))
      return frame !== undefined && (await frame.executeJavaScript(`document.readyState === 'complete' && document.getElementById('go') !== null`).catch(() => false)) === true
    }
    const frameLoaded = await waitFor(frameReady, 6000)
    // The click goes through the input router of the browser, which hands it to the process that draws the frame under the pointer (the DevTools
    // protocol does that, as a mouse does). `sendInputEvent` (clickOn) hands it to the process of the page whatever frame is under it: a frame of
    // another site, drawn by a process of its own, never gets it (smoke-probes-web.ts, `clickAt`).
    const frameBox = await evaluate<Rect | null>(framePage.wc, `(() => { const r = document.getElementById('frame')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })()`)
    const frameClick = frameBox ? await clickThroughRouter(framePage.wc, frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2) : 'the frame is not in the page'
    const frameAsked = await waitFor(() => asker.overlayRequest?.panel === 'permission', 6000)
    const appFrame = framePage.wc.mainFrame.framesInSubtree.find((candidate) => candidate.origin === frameSite && candidate.url.endsWith('/frame-app'))
    const frameClicks = appFrame ? await appFrame.executeJavaScript('window.__clicks ?? 0').catch((error: unknown) => `unreadable: ${String((error as Error)?.message ?? error)}`) : 'no frame'
    // A click that did not reach the link says nothing of the question: the check below is then red for that reason, said in its detail.
    check('the control: the click reaches the link of the frame of another site', frameLoaded && frameClicks === 1, JSON.stringify({ frameLoaded, frameClick, frameClicks }))
    await waitFor(() => evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble')`).catch(() => false), 4000)
    const frameRequest = (asker.overlayRequest as { request?: { origin?: string; permission?: string } } | null)?.request
    const frameRemember = await evaluate<boolean>(overlayView.webContents, `!!document.querySelector('.iv-bubble .iv-remember')`).catch(() => true)
    const framePrompt = await evaluate<string>(overlayView.webContents, `document.querySelector('.iv-bubble')?.innerText ?? ''`).catch(() => '')
    check('a link to another application in a frame of another site asks the plain question under the frame’s site, though the page’s site always opens such links', frameAsked && frameRequest?.origin === frameSite && frameRequest?.permission === 'openExternal' && !frameRemember && framePrompt.includes('localhost'), JSON.stringify({ frameAsked, frameRequest: frameRequest ?? null, frameRemember, framePrompt, frameClicks }))
    browser.closeOverlay()
    browser.dispatch({ type: 'permission/set', origin: base, permission: 'openExternal:x-sec1-app:', decision: null })

    // =============== the HTTP authentication cache ===============
    // A bare view on a session, so that no profile is made (a profile would load every extension of the test into it): the 401 box is answered
    // here, and the number of times it was asked says whether the login was cached.
    let logins = 0
    // A view that nothing holds is collected, and its web contents with it.
    const askingViews: WebContentsView[] = []
    const askingView = (ses: Electron.Session) => {
      const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      askingViews.push(view)
      view.webContents.on('login', (event, _details, _info, callback) => {
        event.preventDefault()
        logins++
        callback('ada', 'lovelace')
      })
      return view.webContents
    }
    const loadSecret = async (wc: WebContents) => {
      void wc.loadURL(`${base}/secret`).catch(noted('the load of the protected page'))
      await waitFor(() => !wc.isLoading() && wc.getURL() === `${base}/secret`)
      await sleep(250)
    }
    // Clearing a profile: a session of its own, wiped by the engine as a whole.
    const profileSession = session.fromPartition('persist:profile-sec1')
    const profileView = askingView(profileSession)
    await loadSecret(profileView)
    check('the control: a login typed in the 401 box is asked once', logins === 1 && challenges() === 1, `logins=${logins} challenges=${challenges()}`)
    await loadSecret(profileView)
    check('...and cached for the next load of the same address', logins === 1 && challenges() === 1, `logins=${logins} challenges=${challenges()}`)
    await engine.clearProfileData('sec1')
    await loadSecret(profileView)
    check('clearing the data of a profile also forgets the login of the authentication box', logins === 2 && challenges() === 2, `logins=${logins} challenges=${challenges()}`)
    // Erasing a site: the cookies of a host that does not exist (so that no one else's are touched) still empty the authentication cache,
    // which is the session's. The default profile's session is the one that goes through the engine without making a profile.
    const siteView = askingView(session.fromPartition('persist:profile-default'))
    logins = 0
    const challengesBefore = challenges()
    await loadSecret(siteView)
    await loadSecret(siteView)
    check('(the login is cached in the default profile as well)', logins === 1 && challenges() === challengesBefore + 1, `logins=${logins} challenges=${challenges() - challengesBefore}`)
    const erased = await engine.clearSiteData('default', { origins: ['http://sec1-absent.invalid'], host: 'sec1-absent.invalid', subdomains: false, types: ['cookies'] })
    await loadSecret(siteView)
    check('erasing the cookies of a site forgets the login of the authentication box too', erased.every((r) => r.ok) && logins === 2 && challenges() === challengesBefore + 2, `erased=${JSON.stringify(erased)} logins=${logins} challenges=${challenges() - challengesBefore}`)
    for (const view of askingViews.splice(0)) view.webContents.close()

    // =============== two downloads of one name ===============
    const downloads = new Map<string, DownloadInfo>()
    engine.onDownload((download) => downloads.set(download.id, download))
    const host = await openTab(`${base}/downloader`)
    host.wc.downloadURL(`${base}/slow-dl?a=1`)
    host.wc.downloadURL(`${base}/slow-dl?a=2`)
    await waitFor(() => held.length === 2 && downloads.size >= 2, 8000)
    const paths = [...downloads.values()].map((d) => d.path)
    check('two downloads of the same name that run together are saved to two different files', paths.length === 2 && new Set(paths).size === 2, JSON.stringify(paths))
    for (const response of held.splice(0)) response.end()
    await waitFor(() => [...downloads.values()].every((d) => d.state === 'completed'), 8000)

    // =============== what a suggestion request sends and keeps ===============
    await session.defaultSession.cookies.set({ url: base, name: 'sec1', value: 'cookie' })
    const hitsBefore = hits('/suggest')
    await (await net.fetch(`${base}/suggest?q=a`, SUGGEST_FETCH_INIT)).text()
    await (await net.fetch(`${base}/suggest?q=a`, SUGGEST_FETCH_INIT)).text()
    const afterSuggest = hits('/suggest')
    check('a suggestion request is not cached: the same one twice reaches the server twice', afterSuggest - hitsBefore === 2, `hits ${hitsBefore}->${afterSuggest}`)
    check('...and carries no cookie of the session', cookies.slice(-2).every((header) => header === undefined), JSON.stringify(cookies.slice(-2)))
    await (await net.fetch(`${base}/suggest?q=control`)).text()
    check('(the control: the same request with the defaults sends the cookie)', (cookies.at(-1) ?? '').includes('sec1=cookie'), JSON.stringify(cookies.at(-1)))
    await session.defaultSession.cookies.remove(base, 'sec1')

    // =============== a closed window lets go of the shared state ===============
    const shared = (store as unknown as { shared?: { listeners?: Set<unknown> } }).shared
    const listeners = () => shared?.listeners?.size
    const manager = getWindowManager()
    const listenersBefore = listeners()
    const contentsBefore = allWebContents.getAllWebContents().length
    const extra = manager.openWindow({ commandBar: false })
    await sleep(800)
    const listenersOpen = listeners()
    extra.win.close()
    await waitFor(() => extra.win.isDestroyed(), 6000)
    await waitFor(() => allWebContents.getAllWebContents().length === contentsBefore, 6000)
    check('closing a second window takes back every listener it put on the shared state (hover pictures included)', listenersBefore !== undefined && listenersOpen !== undefined && listenersOpen > listenersBefore && listeners() === listenersBefore, JSON.stringify({ before: listenersBefore, open: listenersOpen, after: listeners() }))
  } finally {
    if (priorSettings) browser.dispatch({ type: 'settings/update', patch: priorSettings })
    for (const id of opened.splice(0)) browser.dispatch({ type: 'tab/close', id })
    const toolWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && (w.getTitle() === 'Réglages' || w.getTitle() === 'Gestionnaire de tâches'))
    for (const window of toolWindows()) window.close()
    for (const stateOfLittle of little.states()) if (stateOfLittle.url.startsWith(base)) little.close(stateOfLittle.id)
    // The suites that follow count windows and web contents: leave none of ours behind.
    await waitFor(() => toolWindows().length === 0 && !little.states().some((s) => s.url.startsWith(base)), 6000)
    await sleep(300)
    server.closeAllConnections()
    server.close()
  }
}

/** The checks that open a private window: they run after the suites that look for "ephemeral-1" (see index.ts). */
export async function smokeSec1Late(ctx: SmokeContext, check: Check): Promise<void> {
  const { engine, browser, store } = ctx
  const manager = getWindowManager()
  const { server, hits } = startServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The request filter cannot suspend a request. Late, because installing a filter clears the other hooks of the sessions (the extension
  // suite's header rewriting included), which the suites that run after the principal one must not meet.
  engine.setRequestBlocker(() => {
    throw new Error('a filter that throws')
  })
  browser.dispatch({ type: 'tab/open', url: `${base}/filtered` })
  const filteredTab = store.get().tabs.at(-1)!
  const filtered = await waitFor(() => store.get().tabs.find((t) => t.id === filteredTab.id)?.title === 'sec1 /filtered', 10_000)
  check('a request filter that throws lets the request through instead of suspending it', filtered, String(store.get().tabs.find((t) => t.id === filteredTab.id)?.title))
  browser.dispatch({ type: 'tab/close', id: filteredTab.id })
  ;(browser as unknown as { configureBlocker(): void }).configureBlocker()
  const roots = appRoots(join(__dirname, '../renderer'), isBuiltApp())
  const scopeKeys = (): string[] => [...(engine as unknown as { scopes: Map<string, unknown> }).scopes.keys()]
  const known = new Set(scopeKeys())
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void

  // Everything that holds the window strongly stays inside this function: once it returns, only the weak reference is left.
  const openAndClose = async (): Promise<{ browser: WeakRef<object>; ses: Electron.Session | undefined; key: string | undefined }> => {
    const record = manager.openPrivate()
    const privateSurfaces = () => allWebContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && isAppUrl(wc.getURL(), roots) && wc.getURL().includes('private=1'))
    // Its session, and its surfaces once they have loaded their pages.
    await waitFor(() => scopeKeys().some((k) => !known.has(k)) && privateSurfaces().length >= 2)
    const key = scopeKeys().find((k) => !known.has(k))
    const ses = key ? session.fromPartition(key.replace(':', '-')) : undefined
    check('a private window opens its own session', !!ses && ses.isPersistent() === false, String(key))

    // The surfaces of a private window are locked like the others.
    check('the surfaces of a private window are locked', privateSurfaces().length >= 2 && privateSurfaces().every((wc) => isSurfaceLocked(wc)), `${privateSurfaces().length} surfaces`)
    const chrome = record.win.webContents
    const before = chrome.getURL()
    // The witness: the guard's verdict on the navigation, once the request has reached the browser.
    const navigation = navigationVerdict(chrome, '/private-nav')
    await evaluate(chrome, `location.href = ${JSON.stringify(`${base}/private-nav`)}; 0`, true).catch(noted('a script of the check'))
    await waitFor(() => navigation.verdict() !== undefined)
    navigation.stop()
    check('...and a script cannot send the private window to a remote page', navigation.verdict() === true && chrome.getURL() === before && hits('/private-nav') === 0, `refused=${String(navigation.verdict())} ${chrome.getURL()} hits=${hits('/private-nav')}`)
    const hooksOpen = ses?.listenerCount('will-download') ?? 0
    check('(the control: the private session has its download listener while the window is open)', hooksOpen > 0, String(hooksOpen))

    const win = record.win
    const weak = new WeakRef<object>(record.browser)
    win.close()
    await waitFor(() => win.isDestroyed(), 6000)
    await waitFor(() => !scopeKeys().includes(key ?? ''), 6000)
    return { browser: weak, ses, key }
  }

  const closed = await openAndClose()
  check('closing a private window takes the download listener off its session', !!closed.ses && (await waitFor(() => closed.ses!.listenerCount('will-download') === 0)), String(closed.ses?.listenerCount('will-download')))
  let released = false
  for (let attempt = 0; attempt < 30 && !released; attempt++) {
    gc()
    await sleep(150)
    released = closed.browser.deref() === undefined
  }
  check('...and the browser of the private window can be collected once it is closed: the hooks of its session no longer hold it', released)
  server.closeAllConnections()
  server.close()
}

/** Every check of this file with its own report: LUCIUM_SMOKE_ONLY=sec1 (quick loop), and the last suite of the engine test for `late`. */
export async function runSec1Smoke(ctx: SmokeContext, parts: 'late' | 'all'): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const verbose = process.env['LUCIUM_SEC1_VERBOSE'] === '1'
  const record = (name: string, ok: boolean, detail?: string) => {
    noteCheck(checks, name, ok, detail)
    if (verbose) console.log(`SEC1 ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
  }
  try {
    if (parts === 'all') await smokeSec1(ctx, record)
    await smokeSec1Late(ctx, record)
  } catch (error) {
    noteCheck(checks, 'smokeSec1 ran to the end', false, String((error as Error)?.stack ?? error))
    console.log(`SEC1 FAIL smokeSec1 ran to the end -- ${String((error as Error)?.stack ?? error)}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SEC1 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
