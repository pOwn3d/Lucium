// Engine checks for the popup windows of pages (`window.open` with a feature list) and for the user agent of pages, run inside a real Electron.
// `smokePopups` is the local part: a server with two origins (`localhost` and `127.0.0.1`, the same port), real clicks, no Internet.
// `smokePopupsReal` is the end-to-end measurement on the real sign-in pages (claude.ai -> Google, Apple): it needs the Internet and is only run
// on demand (LUCIUM_POPUPS_REAL=1), never in the full chain. `LUCIUM_SMOKE_ONLY=popups` runs the local part, and the real one when asked
// (LUCIUM_POPUPS_REAL=only skips the local part); see index.ts.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { BrowserWindow, dialog, net, screen, session, webContents as allWebContents, type WebContents } from 'electron'
import { POPUP_FRAME_HEIGHT, POPUP_MIN_SIZE } from '@shared/popup'
import { isKillablePid } from '@shared/processes'
import { chromeUserAgent } from '@shared/user-agent'
import type { SmokeContext } from './smoke'
import { setLeaveAsker } from './engine/unload-guard'
import { getWindowManager } from './shell/windows'
import { closeLeftoverPanels, noteCheck, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

/** A script run in a page, with a limit: a page that never answers fails the check that asked instead of hanging the whole run. */
const evaluate = <T>(wc: WebContents, script: string, gesture = false, timeoutMs = 8000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to a script after ${timeoutMs} ms: ${script.slice(0, 80)}`)), timeoutMs)
    ;(wc.executeJavaScript(script, gesture) as Promise<T>).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the local part
// ---------------------------------------------------------------------------------------------------------------------------------

/** A self-signed certificate for 127.0.0.1, made with the system's openssl in a throw-away folder. Null when openssl is not there. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-popups-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch (error) {
    console.warn('[popups] cannot make a certificate:', error instanceof Error ? error.message : String(error))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What the server saw of each request: the paths, and the headers a check reads back. */
interface Seen {
  path: string
  host: string
  userAgent: string
  secChUa: string
  cookie: string
}

function startServer() {
  const seen: Seen[] = []
  let challenges = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const host = req.headers.host ?? ''
    const path = url.pathname
    if (path !== '/favicon.ico') seen.push({ path, host, userAgent: String(req.headers['user-agent'] ?? ''), secChUa: String(req.headers['sec-ch-ua'] ?? ''), cookie: String(req.headers.cookie ?? '') })
    const here = `http://${host}`
    // The other origin of the pair: the opener lives on one, the popups on the other.
    const port = host.split(':')[1] ?? ''
    const other = host.startsWith('localhost') ? `http://127.0.0.1:${port}` : `http://localhost:${port}`
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    if (path === '/secret') {
      challenges++
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="popups"')
      return html('<title>refus 401</title><body>refus 401</body>')
    }
    if (path === '/file.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="popup.bin"' })
      return res.end(Buffer.alloc(256, 7))
    }
    if (path === '/pixel.gif' || path === '/blocked.gif') {
      res.setHeader('content-type', 'image/gif')
      return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    }
    if (path === '/echo') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ ua: req.headers['user-agent'], chUa: req.headers['sec-ch-ua'] ?? null }))
    }
    if (path === '/plain' || path === '/plain-from-popup') return html(`<title>plain ${path}</title><body>plain</body>`)
    if (path === '/c') return html('<title>C</title><body><script>window.__cookie = document.cookie; window.__opener = window.opener !== null</script></body>')
    if (path === '/b') {
      const mode = url.search
      return html(`<title>Popup B</title><body style="margin:0">
        <button id="nested" style="position:absolute;left:10px;top:10px;width:200px;height:30px" onclick="window.__nested = window.open('/b?nested', '_blank', 'width=300,height=300'); window.__nestedType = window.__nested === null ? 'null' : typeof window.__nested">nested</button>
        <a id="link" target="_blank" href="${here}/plain-from-popup" style="position:absolute;left:10px;top:60px;width:200px;height:30px;display:block;background:#ccc">link</a>
        <button id="noop" style="position:absolute;left:10px;top:110px;width:200px;height:30px">noop</button>
        ${mode.includes('assets') ? `<img src="${other}/blocked.gif"><img src="${here}/pixel.gif">` : ''}
        <script>
          window.__received = []
          window.__hasOpener = window.opener !== null
          window.__ua = navigator.userAgent
          window.__lucium = [typeof window.lucium, typeof window.__luciumShim, typeof require, typeof process].join()
          addEventListener('message', (e) => { window.__received.push({ data: e.data, origin: e.origin }); if (window.opener) window.opener.postMessage({ reply: e.data }, '*') })
          if (window.opener) window.opener.postMessage({ hello: 'from-b', origin: location.origin, name: window.name }, '*')
          ${mode.includes('unload') ? `addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'stay' })` : ''}
        </script></body>`)
    }
    if (path === '/a') {
      return html(`<title>Opener A</title><body style="margin:0">
        ${([
          ['sized', `window.__ret = window.open('${other}/b', 'pop-sized', 'width=480,height=520'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['noopener', `window.__ret = window.open('${other}/b?noopener', '_blank', 'width=480,height=520,noopener'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['js', `window.__ret = window.open('javascript:void(window.__x=1)', 'p-js', 'width=300,height=300'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['file', `window.__ret = window.open('file:///etc/hosts', 'p-file', 'width=300,height=300'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['data', `window.__ret = window.open('data:text/html,<p>x</p>', 'p-data', 'width=300,height=300'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['blanknav', `window.__ret = window.open('', 'p-blank', 'width=400,height=400'); window.__type = window.__ret === null ? 'null' : typeof window.__ret; window.__ret.location.href = '${other}/b'`],
          ['many', `window.__types = window.__types || []; const w = window.open('${other}/b?many', '_blank', 'width=300,height=300'); window.__types.push(w === null ? 'null' : typeof w)`],
          ['assets', `window.__ret = window.open('${other}/b?assets', 'pop-assets', 'width=400,height=400'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['unload', `window.__ret = window.open('${other}/b?unload', 'pop-unload', 'width=400,height=400'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['same', `window.__ret = window.open('/c', 'pop-same', 'width=400,height=300'); window.__type = window.__ret === null ? 'null' : typeof window.__ret`],
          ['plain', `window.open('${other}/plain')`]
        ] as Array<[string, string]>)
          // Each button counts its clicks once its code has run: window.open waits for the browser's decision, so a counted click is one the browser
          // has decided on (the witness of the checks that nothing opened).
          .map(([id, code], i) => `<button id="${id}" style="position:absolute;left:10px;top:${10 + i * 40}px;width:200px;height:30px" onclick="${`try { ${code} } finally { window.__clicked = (window.__clicked || 0) + 1 }`.replace(/"/g, '&quot;')}">${id}</button>`)
          .join('')}
        <a id="blank" target="_blank" href="${other}/plain" style="position:absolute;left:10px;top:520px;width:200px;height:30px;display:block;background:#ccc">blank</a>
        <script>
          window.__messages = []
          addEventListener('message', (e) => window.__messages.push({ data: e.data, origin: e.origin }))
          document.cookie = 'popsid=from-a-' + location.search.slice(1) + '; path=/'
        </script></body>`)
    }
    // A tab page that asks to confirm leaving it once the user has clicked in it (Chromium only calls the handler of a page that was interacted with).
    if (path === '/trap') return html(`<title>trap</title><body style="margin:0"><button id="arm" style="position:absolute;left:10px;top:10px;width:200px;height:30px" onclick="window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = 'stay' }; window.__armed = true">arm</button></body>`)
    if (path === '/file-opener') return html('<title>file</title>') // never used: the opener from a file is written to disk
    res.statusCode = 404
    return html('<title>404</title><body>404</body>')
  })
  return { server, seen, challenges: () => challenges }
}

export async function smokePopups(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView, little } = ctx
  const { server, seen, challenges } = startServer()
  // Dual-stack: both `localhost` and `127.0.0.1` reach it.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const A = `http://localhost:${port}`
  const B = `http://127.0.0.1:${port}`
  const state = () => store.get()
  const tabs = () => state().tabs
  const known = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
  const popupWindows = () => BrowserWindow.getAllWindows().filter((w) => !known.has(w.id) && !w.isDestroyed())
  const hits = (path: string, host?: string) => seen.filter((s) => s.path === path && (host === undefined || s.host === host)).length
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : allWebContents.fromId(number) ?? undefined
  }
  const mine: string[] = []
  const openTab = async (url: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = tabs().at(-1)!
    mine.push(tab.id)
    await waitFor(() => pageOf(tab.id) !== undefined)
    const wc = pageOf(tab.id)!
    await waitFor(() => !wc.isLoading() && wc.getURL() === url)
    return { id: tab.id, wc }
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, modifiers: Array<'shift' | 'meta'> = []) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers } as Electron.MouseInputEvent)
  /** A real click: the pointer moves, goes down and up. */
  const clickOn = async (wc: WebContents, selector: string, modifiers: Array<'shift' | 'meta'> = []): Promise<boolean> => {
    const rect = await evaluate<Rect | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!rect) return false
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    mouse(wc, 'mouseMove', x, y, modifiers)
    mouse(wc, 'mouseDown', x, y, modifiers)
    mouse(wc, 'mouseUp', x, y, modifiers)
    await sleep(350)
    return true
  }
  const closeAllPopups = async () => {
    for (const popup of popupWindows()) popup.destroy()
    await waitFor(() => popupWindows().length === 0 && engine.pagePopupCount() === 0)
  }
  const settleTab = async (id: string) => {
    browser.dispatch({ type: 'tab/select', id })
    await sleep(400)
  }
  const popupReady = async (index = 0): Promise<{ win: BrowserWindow; wc: WebContents } | undefined> => {
    const found = await waitFor(() => popupWindows()[index] !== undefined && popupWindows()[index]!.webContents.getURL().startsWith('http') && !popupWindows()[index]!.webContents.isLoading())
    const popup = popupWindows()[index]
    return found && popup ? { win: popup, wc: popup.webContents } : undefined
  }

  win.showInactive()
  // The checks read the panels of the window and ask questions of their own (« Quitter ce site ? » is not put over another panel): what an earlier suite
  // left over the window (a sign-in asked by one of its tabs left on a 401) is closed first.
  const leftover = closeLeftoverPanels(browser)
  if (leftover.length > 0) console.warn(`[popups] closed what an earlier suite left over the window: ${leftover.join(', ')}`)
  const prior = { peekWithShift: state().settings.peekWithShift, peekOnExternalLinks: state().settings.peekOnExternalLinks, littleArcNewTabLinks: state().settings.littleArcNewTabLinks, blockAds: state().settings.blockAds, blockTrackers: state().settings.blockTrackers }
  const downloads: Array<{ sourcePageId: string | undefined; state: string }> = []
  engine.onDownload((download, sourcePageId) => downloads.push({ sourcePageId, state: download.state }))

  try {
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: true, peekOnExternalLinks: false } })
    // A port nothing listens on: the connection is refused.
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, () => {
        const free = (probe.address() as AddressInfo).port
        probe.close(() => resolve(free))
      })
    })
    const opener = await openTab(`${A}/a?main`)
    await sleep(500)

    // =============== a real popup, with an opener ===============
    await clickOn(opener.wc, '#sized')
    const popup = await popupReady()
    check('a click on a button that calls window.open with width and height opens a real window', popup !== undefined && popupWindows().length === 1, `windows ${popupWindows().length}`)
    // The page of the popup is `/b` of the server of this suite, at either of its two names. Looked for by origin and path: an unpacked extension's id
    // depends on the folder it is loaded from, and `chrome-extension://b…/options.html`, a tab an earlier suite left open, contains « /b » too.
    const popupPages = () => tabs().filter((t) => URL.canParse(t.url) && [A, B].includes(new URL(t.url).origin) && new URL(t.url).pathname === '/b')
    check('...which is not a tab, a Glance or a panel: no tab was added and no preview shown', popupPages().length === 0 && browser.snapshot().peek === null, JSON.stringify(tabs().map((t) => t.url)))
    check('window.open returned an object to the page that asked, not null', (await evaluate<string>(opener.wc, 'window.__type')) === 'object', String(await evaluate(opener.wc, 'window.__type')))
    if (!popup) return
    const [contentWidth, contentHeight] = popup.win.getContentSize()
    check('the window has the content size that was asked for', contentWidth === 480 && contentHeight === 520, `${contentWidth}x${contentHeight}`)
    const main = win.getBounds()
    const around = popup.win.getBounds()
    const centred = Math.abs(around.x + around.width / 2 - (main.x + main.width / 2)) <= 3 || around.x + around.width <= main.x + main.width
    check('...and sits at the centre of the window of the page that opened it (or on the screen when that would leave it)', centred, JSON.stringify({ main, around }))
    check('the title bar shows the host of the page and its title', popup.win.getTitle() === `127.0.0.1:${port} — Popup B`, popup.win.getTitle())
    check('the popup is a window of its own, with no menu to change the title or the state of the application', !popup.win.isDestroyed() && popup.win.getParentWindow() === null, String(popup.win.getParentWindow()))
    check('the popup is in the session of the page that opened it', popup.wc.session === opener.wc.session)
    const upgrades = (engine as unknown as { upgrades: { targets: Map<number, unknown> } }).upgrades
    const popupId = popup.wc.id
    check('the popup is known to the HTTPS-first memory, like a tab', upgrades.targets.has(popupId))
    check('the popup sees window.opener', (await evaluate<boolean>(popup.wc, 'window.__hasOpener')) === true)
    check('the popup is a web page: no window.lucium, no extension shim, no require, no process', (await evaluate<string>(popup.wc, 'window.__lucium')) === 'undefined,undefined,undefined,undefined', String(await evaluate(popup.wc, 'window.__lucium')))
    const preferences = (popup.wc as unknown as { getLastWebPreferences(): Record<string, unknown> | undefined }).getLastWebPreferences() ?? {}
    check('...and no preload of the interface was given to it', !preferences['preload'], String(preferences['preload']))
    check('...with the isolation of a page: sandbox on, context isolation on, no Node', preferences['sandbox'] === true && preferences['contextIsolation'] === true && preferences['nodeIntegration'] === false, JSON.stringify(preferences))
    // alert() and confirm() are Electron's own native sheets: a page that opens them in a row is offered a way to be stopped, in the tab and in its popup.
    const tabPreferences = (opener.wc as unknown as { getLastWebPreferences(): Record<string, unknown> | undefined }).getLastWebPreferences() ?? {}
    check('alert() and confirm() carry the protection against boxes that follow each other (safeDialogs, with our sentence), in a tab and in a popup', tabPreferences['safeDialogs'] === true && preferences['safeDialogs'] === true && typeof tabPreferences['safeDialogsMessage'] === 'string' && tabPreferences['safeDialogsMessage'] === preferences['safeDialogsMessage'], JSON.stringify({ tab: tabPreferences['safeDialogs'], popup: preferences['safeDialogs'], message: preferences['safeDialogsMessage'] }))

    // The page that asked hears the popup, with the origin of the popup.
    const heard = await waitFor(async () => ((await evaluate<unknown[]>(opener.wc, 'window.__messages')) ?? []).length >= 1)
    const messages = await evaluate<Array<{ data: { hello?: string; origin?: string; name?: string }; origin: string }>>(opener.wc, 'window.__messages')
    check('the opener receives the postMessage of the popup with the origin of the popup', heard && messages[0]?.origin === B && messages[0]?.data.hello === 'from-b' && messages[0]?.data.origin === B, JSON.stringify(messages))
    check('...and the popup carries the name the page gave it', messages[0]?.data.name === 'pop-sized', JSON.stringify(messages[0]))
    // And the other way round.
    await evaluate(opener.wc, `window.__ret.postMessage('ping', ${JSON.stringify(B)}); 0`)
    const answered = await waitFor(async () => ((await evaluate<unknown[]>(opener.wc, 'window.__messages')) ?? []).length >= 2)
    const received = await evaluate<Array<{ data: string; origin: string }>>(popup.wc, 'window.__received')
    check('the opener can post a message to the popup, which receives it from the origin of the opener and answers', answered && received[0]?.data === 'ping' && received[0]?.origin === A, JSON.stringify({ received, messages: await evaluate(opener.wc, 'window.__messages') }))

    // The user agent of a page of a profile, and of its popup.
    const wanted = chromeUserAgent(process.versions.chrome, process.platform)
    const pageAgent = await evaluate<string>(opener.wc, 'navigator.userAgent')
    const popupAgent = await evaluate<string>(popup.wc, 'window.__ua')
    check('navigator.userAgent of a page is a plain Chrome of the Chromium major, with no Electron and no application name', pageAgent === wanted && !/electron|lucium/i.test(pageAgent), pageAgent)
    check('...the same in the popup', popupAgent === wanted, popupAgent)
    const brands = await evaluate<string>(opener.wc, `JSON.stringify(navigator.userAgentData ? navigator.userAgentData.brands : null)`)
    check('...and the brands of navigator.userAgentData say Chromium, not Electron', !!brands && !/electron|lucium/i.test(brands) && brands.includes('Chromium'), brands)
    const echoed = await evaluate<{ ua: string; chUa: string | null }>(opener.wc, `fetch('/echo').then((r) => r.json())`)
    check('the request a page sends has that user agent too, and client hints that do not name Electron', echoed.ua === wanted && !/electron|lucium/i.test(`${echoed.ua} ${echoed.chUa ?? ''}`), JSON.stringify(echoed))
    check('the navigation itself was requested with it', seen.filter((s) => s.path === '/b' || s.path === '/a').every((s) => s.userAgent === wanted), JSON.stringify(seen.filter((s) => s.path === '/b' || s.path === '/a').map((s) => s.userAgent)))
    // What is not a page keeps its own identity: the interface, and what the application fetches itself (filter lists, updates).
    const interfaceAgent = overlayView.webContents.getUserAgent()
    check('the pages of the interface keep the user agent of Electron', /Electron\//.test(interfaceAgent), interfaceAgent)
    // A window of the interface made now (the Settings window, a tooltip) is in the default session too, after the pages were changed.
    const fresh = new BrowserWindow({ show: false })
    const freshAgent = fresh.webContents.getUserAgent()
    fresh.destroy()
    check('...and so does a window of the interface made after the pages were changed', /Electron\//.test(freshAgent) && /lucium/i.test(freshAgent), freshAgent)
    const fetchedBy = await net.fetch(`${B}/echo`).then((r) => r.json() as Promise<{ ua: string }>)
    check('what the application fetches for itself (lists, updates) keeps the identity of the application', /Electron\//.test(fetchedBy.ua) && /lucium/i.test(fetchedBy.ua), fetchedBy.ua)

    // A page may size and place its own window, within the bounds it was made with (shared/popup.ts): not shrink it out of sight, nor push it off the screen.
    await evaluate(popup.wc, 'window.resizeTo(1, 1); window.moveTo(-5000, -5000); 0', true).catch((error: unknown) => console.log(`[popups] resizeTo ended the script: ${String(error).slice(0, 80)}`))
    await sleep(500)
    const [shrunkWidth, shrunkHeight] = popup.win.getContentSize()
    const area = screen.getDisplayMatching(popup.win.getBounds()).workArea
    const placed = popup.win.getBounds()
    check('a page cannot shrink its popup out of sight (resizeTo(1, 1)): the window keeps the minimum size', shrunkWidth === POPUP_MIN_SIZE.width && (shrunkHeight ?? 0) >= POPUP_MIN_SIZE.height && (shrunkHeight ?? 0) <= POPUP_MIN_SIZE.height + POPUP_FRAME_HEIGHT, `${shrunkWidth}x${shrunkHeight} (the window holds the page and its header strip)`)
    check('...nor push it off the screen (moveTo(-5000, -5000)): the whole window stays in the work area of its display', placed.x >= area.x && placed.y >= area.y && placed.x + placed.width <= area.x + area.width && placed.y + placed.height <= area.y + area.height, JSON.stringify({ placed, area }))

    // The popup closes itself: the window goes, the page that asked sees it closed.
    await evaluate(popup.wc, 'window.close(); 0', true).catch((error: unknown) => console.log(`[popups] close() ended the script: ${String(error).slice(0, 80)}`))
    check('window.close() in the popup closes its window', await waitFor(() => popupWindows().length === 0 && engine.pagePopupCount() === 0), `windows ${popupWindows().length}, counted ${engine.pagePopupCount()}`)
    check('...and the page that asked sees it closed', (await evaluate<boolean>(opener.wc, 'window.__ret.closed')) === true)
    check('...and the window is forgotten by the HTTPS-first memory', !upgrades.targets.has(popupId))
    // A window whose setup fails is not shown: it is closed, and the tab gets its place back.
    const broken = new BrowserWindow({ show: false })
    known.add(broken.id)
    broken.webContents.setWindowOpenHandler = () => {
      throw new Error('the check made the setup fail')
    }
    opener.wc.emit('did-create-window', broken, {})
    check('a popup whose setup fails is closed, not shown, and the tab keeps its places', (await waitFor(() => broken.isDestroyed(), 3000)) && engine.pagePopupCount() === 0, `destroyed ${broken.isDestroyed()}, counted ${engine.pagePopupCount()}`)
    if (!broken.isDestroyed()) broken.destroy()

    // =============== no click, no window ===============
    const before = popupWindows().length
    const tabsBefore = tabs().length
    // No wait: window.open waits for the browser's decision, and the page's answer comes after it (a window it allows is made by then, a refusal is null).
    const scripted = await evaluate<string>(opener.wc, `(() => { const w = window.open('${B}/b', 'pop-script', 'width=400,height=400'); return w === null ? 'null' : typeof w })()`)
    check('window.open with features from a script, with no click, opens nothing and returns null', popupWindows().length === before && tabs().length === tabsBefore && scripted === 'null' && hits('/b', `127.0.0.1:${port}`) === 1, `${scripted} windows ${popupWindows().length} tabs ${tabs().length}`)
    check('...and the user is told, in a notice that names the site', (browser.snapshot().toast?.message ?? '').startsWith('Fenêtre bloquée sur localhost'), JSON.stringify(browser.snapshot().toast))

    // =============== noopener ===============
    await clickOn(opener.wc, '#noopener')
    const detached = await popupReady()
    check('a popup asked for with noopener opens', detached !== undefined)
    check('...with no window.opener, and window.open returned null to the page', !!detached && (await evaluate<boolean>(detached.wc, 'window.__hasOpener')) === false && (await evaluate<string>(opener.wc, 'window.__type')) === 'null', `${detached ? await evaluate(detached.wc, 'window.__hasOpener') : 'no popup'} / ${await evaluate(opener.wc, 'window.__type')}`)
    await closeAllPopups()

    // =============== addresses a popup may not be on ===============
    const windowsBefore = popupWindows().length
    const tabsNow = tabs().length
    // The witness: the two clicks counted by the page once window.open has had its answer.
    const clicksDone = (): Promise<number> => evaluate<number>(opener.wc, 'window.__clicked ?? 0')
    const clickedBefore = await clicksDone()
    await clickOn(opener.wc, '#file')
    await clickOn(opener.wc, '#data')
    const bothHandled = await waitFor(async () => (await clicksDone()) >= clickedBefore + 2)
    check('a click that asks for a file: or data: address in a popup opens nothing', bothHandled && popupWindows().length === windowsBefore && tabs().length === tabsNow && browser.snapshot().peek === null && ['null'].includes(await evaluate<string>(opener.wc, 'window.__type')), `windows ${popupWindows().length} tabs ${tabs().length} ${await evaluate(opener.wc, 'window.__type')}`)
    // A javascript: address reaches the browser as the blank page Chromium opens for it (the same as window.open('')): the script is the page's own, run in
    // a window the page could open anyway. What counts is that the window is a blank page of the opener's origin, nothing else.
    await clickOn(opener.wc, '#js')
    const scripted2 = (await waitFor(() => popupWindows().length === 1)) ? popupWindows()[0] : undefined
    await sleep(300)
    // Read from the opener: the blank window has its origin, which is what makes the script of the address its own.
    const scriptedState = await evaluate<{ url: string; ran: unknown; type: string }>(opener.wc, `({ url: window.__ret.location.href, ran: window.__ret.__x, type: window.__type })`).catch((error: unknown) => ({ url: String(error), ran: null, type: '' }))
    check('a javascript: address opens, as in Chrome, a blank window that runs the script of the page that asked, and only that', !!scripted2 && scriptedState.url === 'about:blank' && scriptedState.ran === 1 && scriptedState.type === 'object', JSON.stringify(scriptedState))
    await closeAllPopups()
    await settleTab(opener.id)
    // The usual pattern of the sign-in buttons of Apple, Facebook or PayPal: a blank window first, then the address.
    await clickOn(opener.wc, '#blanknav')
    const navigated = await popupReady()
    check('a blank popup that the page then sends to an address has its opener, and the title of the page it reached', !!navigated && (await waitFor(() => navigated.win.getTitle() === `127.0.0.1:${port} — Popup B`)) && (await evaluate<boolean>(navigated.wc, 'window.__hasOpener')) === true, `${navigated?.win.getTitle()}`)
    await closeAllPopups()
    await settleTab(opener.id)

    // =============== what a popup is allowed to do, and not ===============
    await clickOn(opener.wc, '#assets')
    const inside = await popupReady()
    check('a second popup opens (the first one is closed)', inside !== undefined && popupWindows().length === 1)
    if (inside) {
      // Permissions: a popup has no panel for the question (the panel of a tab is in the window of the tab, behind), so the question is put on the window of the popup
      // itself, as a sheet of the system, and what is answered is not kept. The sheet is replaced here by a recorder that refuses.
      const sheets: Array<{ message: string; onThePopup: boolean }> = []
      const box = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }> }
      const realBox = box.showMessageBox
      box.showMessageBox = async (window: unknown, options: unknown) => {
        sheets.push({ message: String((options as { message?: unknown }).message), onThePopup: window === inside.win })
        return { response: 0, checkboxChecked: false }
      }
      const ask = (expression: string): Promise<string> =>
        evaluate<string>(inside.wc, `Promise.race([Promise.resolve(${expression}).then(String), new Promise((resolve) => setTimeout(() => resolve('no answer'), 2500))])`, true, 6000).catch((error: unknown) => `error: ${String(error).slice(0, 60)}`)
      let answers: { notifications: string; geolocation: string; clipboard: string }
      try {
        answers = {
          notifications: await ask('Notification.requestPermission()'),
          geolocation: await ask(`new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve('denied:' + e.code)))`),
          clipboard: await ask(`navigator.clipboard.readText().then(() => 'granted', (e) => 'denied:' + e.name)`)
        }
      } finally {
        box.showMessageBox = realBox
      }
      check('a popup that asks for notifications, the position or the clipboard gets its question on its own window (a sheet, not the panel of the tab), and a refusal is a refusal', answers.notifications === 'denied' && answers.geolocation.startsWith('denied') && answers.clipboard.startsWith('denied') && sheets.length >= 2 && sheets.every((sheet) => sheet.onThePopup) && browser.currentPanel() !== 'permission', JSON.stringify({ answers, sheets, panel: browser.currentPanel() }))
      browser.closeOverlay()

      // The request filter: the third-party request it names is cancelled, the other goes through.
      await closeAllPopups()
      browser.setExtraBlockedHosts(['localhost'])
      browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
      await sleep(300)
      await settleTab(opener.id)
      const blockedBefore = hits('/blocked.gif')
      await clickOn(opener.wc, '#assets')
      // No wait: popupReady waits for the end of the load, which waits for its images: a request the filter let through has reached the server by then.
      const filtered = await popupReady()
      check('the request filter of the session holds in a popup: a third-party request it names is cancelled', !!filtered && hits('/blocked.gif') === blockedBefore, `hits ${hits('/blocked.gif')} (was ${blockedBefore})`)
      check('...and the others go through', hits('/pixel.gif') >= 1, String(hits('/pixel.gif')))
      browser.dispatch({ type: 'settings/update', patch: { blockAds: prior.blockAds, blockTrackers: prior.blockTrackers } })
      browser.setExtraBlockedHosts([])
    }
    await closeAllPopups()
    await settleTab(opener.id)

    // Downloads: one that starts in a popup is the tab's.
    await clickOn(opener.wc, '#sized')
    const downloader = await popupReady()
    if (downloader) {
      downloader.wc.loadURL(`${B}/file.bin`).catch(() => undefined)
      check('a download that starts in a popup is reported, under the tab that opened it', await waitFor(() => downloads.some((d) => d.sourcePageId === opener.id)), JSON.stringify(downloads))
    } else check('a download that starts in a popup is reported, under the tab that opened it', false, 'no popup')
    await closeAllPopups()
    await settleTab(opener.id)

    // HTTP authentication: refused in the popup (the question would be asked in the window behind it), and the page says so. Every question of a login the
    // window is asked is recorded: none may come from the popup's server, shown or waiting behind another panel (a tab another suite left on a 401 may ask too).
    await clickOn(opener.wc, '#sized')
    const login = await popupReady()
    if (login) {
      const asked = challenges()
      const shell = browser as unknown as { authenticate: (pageId: string, challenge: { url: string }) => Promise<unknown> }
      const realAuthenticate = shell.authenticate
      const loginsAsked: string[] = []
      shell.authenticate = (pageId, challenge) => (loginsAsked.push(challenge.url), realAuthenticate.call(browser, pageId, challenge))
      const ownAuthPanel = () => {
        const shown = browser.currentOverlay()
        return shown?.panel === 'auth' && shown.request.host === `127.0.0.1:${port}`
      }
      try {
        login.wc.loadURL(`${B}/secret`).catch(() => undefined)
        // The witness is the page of the refusal: a question asked of the user would have come before it, and held it.
        const refused = await waitFor(() => challenges() > asked && login.wc.getTitle() === 'refus 401')
        check('a popup whose server asks for a login gets the refusal, not a question in the window of the tab', refused && !loginsAsked.some((url) => url.startsWith(`${B}/`)) && !ownAuthPanel(), `${login.wc.getTitle()} panel ${browser.currentPanel()} asked ${JSON.stringify(loginsAsked)}`)
      } finally {
        Reflect.deleteProperty(browser, 'authenticate')
      }
      if (ownAuthPanel()) browser.closeOverlay()

      // An error page, as in a tab.
      login.wc.loadURL(`http://127.0.0.1:${closedPort}/`).catch(() => undefined)
      const errorText = async () => (await evaluate<string>(login.wc, `document.body ? document.body.innerText : ''`).catch(() => '')) ?? ''
      check('a popup whose page does not load shows the error page of a tab, with its words', await waitFor(async () => (await errorText()).includes('Ce site ne répond pas'), 10_000), (await errorText()).slice(0, 160))

      // A certificate nobody vouches for: the popup is refused it, with the page of a tab (the user's exceptions are the tabs' to make).
      const material = selfSignedCertificate()
      if (material) {
        const secure = createHttpsServer(material, (_req, res) => {
          res.setHeader('content-type', 'text/html')
          res.end('<title>secure</title><body>secure</body>')
        })
        await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
        login.wc.loadURL(`https://127.0.0.1:${(secure.address() as AddressInfo).port}/`).catch(() => undefined)
        const certificateText = async () => (await evaluate<string>(login.wc, `document.body ? document.body.innerText : ''`).catch(() => '')) ?? ''
        check('a popup on a certificate nobody vouches for is shown the page of a tab, not the site', (await waitFor(async () => (await certificateText()).includes('Votre connexion n’est pas privée'), 10_000)) && login.wc.getTitle() !== 'secure', (await certificateText()).slice(0, 160))
        secure.close()
        secure.closeAllConnections()
      } else check('a popup on a certificate nobody vouches for is shown the page of a tab, not the site', false, 'openssl is not there')

      // Where a popup may go.
      const guarded = (url: string): boolean => {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        login.wc.emit('will-navigate', event, url)
        const redirect = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        login.wc.emit('will-redirect', redirect, url)
        return event.defaultPrevented && redirect.defaultPrevented
      }
      const refused = ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,<p>x</p>', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'devtools://devtools/bundled/inspector.html', 'mailto:a@b.c', 'tel:+33123456789', 'view-source:https://example.com/', 'blob:https://example.com/1', 'x-app://open']
      check('a popup is kept from navigating to file:, javascript:, data:, an extension, the developer tools, a mail link or another application', refused.every(guarded), refused.filter((u) => !guarded(u)).join(' '))
      check('...while the web and the blank page are let through', !['https://example.com/', 'http://127.0.0.1:9/x', 'about:blank'].some(guarded))
      const inFrame = (url: string): boolean => {
        const event = { defaultPrevented: false, isMainFrame: false, url, preventDefault() { this.defaultPrevented = true } }
        login.wc.emit('will-frame-navigate', event)
        return event.defaultPrevented
      }
      check('a frame inside a popup is kept from opening a mail or telephone link, and left alone for the web', inFrame('mailto:a@b.c') && inFrame('tel:+33123456789') && !inFrame('https://example.com/') && !inFrame('about:srcdoc'))
    } else check('a popup whose server asks for a login gets the refusal, not a question in the window of the tab', false, 'no popup')
    await closeAllPopups()
    await settleTab(opener.id)

    // The keys of the menu belong to the tabs: in a popup ⌘W closes the popup and never the tab behind it.
    await clickOn(opener.wc, '#sized')
    const keyed = await popupReady()
    if (keyed) {
      const press = (key: string, extra: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        keyed.wc.emit('before-input-event', event, { type: 'keyDown', key, meta: false, control: false, alt: false, shift: false, ...extra })
        return event.defaultPrevented
      }
      const tabsHere = tabs().length
      check('a menu shortcut (⌘T) is kept from the popup, so that it cannot act on the tab behind', press('t', { meta: true }) === true && tabs().length === tabsHere)
      check('...while typing and the editing commands are left to the page', press('a') === false && press('c', { meta: true }) === false)
      check('⌘W closes the popup...', press('w', { meta: true }) === true && (await waitFor(() => popupWindows().length === 0)))
      check('...and the tab that opened it is still there', tabs().some((t) => t.id === opener.id) && tabs().length === tabsHere)
    } else check('a menu shortcut (⌘T) is kept from the popup', false, 'no popup')
    await settleTab(opener.id)

    // A page that holds back the closing of its window does not hold back the user.
    await clickOn(opener.wc, '#unload')
    const stubborn = await popupReady()
    if (stubborn) {
      await clickOn(stubborn.wc, '#noop')
      stubborn.win.close()
      check('a popup whose page asks to confirm leaving is closed when the user closes it', await waitFor(() => popupWindows().length === 0, 4000), `windows ${popupWindows().length}`)
    } else check('a popup whose page asks to confirm leaving is closed when the user closes it', false, 'no popup')
    await closeAllPopups()
    await settleTab(opener.id)

    // A tab is not held by the page it shows (beforeunload). A navigation the shell starts (the address bar) is asked with Lucium's own sheet, « Quitter ce
    // site ? » (the panel "leave"), which blocks nothing (engine/unload-guard.ts, `LeaveGate`): the page stays while the sheet is open, "Rester" keeps it,
    // "Quitter" starts the same navigation again and lets it through; it is answered here as the user would. The box of the system (`setLeaveAsker`, which
    // freezes the application) is for a navigation the page starts itself, never for this one: a recorder that says "Rester" stands in for it, and must not be asked.
    {
      const boxes: string[] = []
      setLeaveAsker((_win, site) => (boxes.push(site), false))
      const leaveSheet = () => {
        const shown = browser.currentOverlay()
        return shown?.panel === 'leave' ? shown.request : null
      }
      let trapId = ''
      const trapUrl = () => tabs().find((t) => t.id === trapId)?.url
      try {
        const trap = await openTab(`${A}/trap`)
        trapId = trap.id
        await settleTab(trap.id)
        // The sheet is never put over another panel (the page then simply stays): a question another suite's tab asked since the start is closed first.
        const late = closeLeftoverPanels(browser)
        if (late.length > 0) console.warn(`[popups] closed a panel that opened over the window during the run: ${late.join(', ')}`)
        await clickOn(trap.wc, '#arm')
        const armed = (await evaluate<boolean>(trap.wc, 'window.__armed === true')) === true
        browser.submitUrl(`${A}/plain`, 'current')
        const asked = await waitFor(() => leaveSheet() !== null, 6000)
        const question = leaveSheet()
        if (question) browser.answerLeave(question.id, false)
        // A fixed wait, for want of a witness: "Rester" starts nothing, and a navigation it let through by mistake would only show by its commit.
        await sleep(400)
        check('a page that asks to confirm leaving it (beforeunload, armed by a click) is asked of the user in the sheet « Quitter ce site ? » naming the site, and "Rester" keeps the page where it is', armed && asked && question?.site === `localhost:${port}` && trapUrl() === `${A}/trap` && leaveSheet() === null, `${armed} ${JSON.stringify(question)} ${trapUrl()} panel ${browser.currentPanel()}`)
        check('the page that was kept is not stuck loading', !(browser.snapshot().runtime.tabs[trap.id]?.loading ?? false))
        browser.submitUrl(`${A}/plain`, 'current')
        const askedAgain = await waitFor(() => leaveSheet() !== null, 6000)
        const again = leaveSheet()
        if (again) browser.answerLeave(again.id, true)
        check('"Quitter" lets the address bar take it elsewhere: a page does not hold its tab', askedAgain && (await waitFor(() => trapUrl() === `${A}/plain`, 6000)), `${JSON.stringify(again)} ${trapUrl()}`)
        check('...and both questions are the sheet of Lucium, never the box of the system that freezes the application', boxes.length === 0, JSON.stringify(boxes))
      } finally {
        setLeaveAsker(null)
        if (leaveSheet()) browser.closeOverlay()
      }
    }
    // A navigation the page starts itself is asked with the box of the system, which freezes the application while it is open. After "Rester", a page
    // that starts again by itself, with no click or key of the user since, stays without a box (unload-guard.ts): a page that reloads itself from
    // its own handler cannot keep the application frozen. A click of the user in the page lets it ask again.
    {
      const boxes: string[] = []
      setLeaveAsker((_win, site) => (boxes.push(site), false))
      // The refusal let through without a box says so once in the log: that line is what is waited for.
      const quiet: string[] = []
      const warn = console.warn
      console.warn = (...args: unknown[]) => {
        if (String(args[0]).startsWith('[unload]')) quiet.push(String(args[0]))
        warn(...args)
      }
      // How many times the page asked to be let go (Chromium's `will-prevent-unload`, heard after the engine's own listener, and left alone): it
      // tells a refusal the engine let through without a box from a page that never asked, in the detail of the check.
      let prevents = 0
      const heard = (): void => void prevents++
      const listened: WebContents[] = []
      try {
        const trap = await openTab(`${A}/trap`)
        trap.wc.on('will-prevent-unload', heard)
        listened.push(trap.wc)
        await settleTab(trap.id)
        closeLeftoverPanels(browser)
        await clickOn(trap.wc, '#arm')
        void evaluate(trap.wc, 'location.reload()').catch((error: unknown) => console.warn('[popups] the script of the first reload of the trap had no answer (the page left, or the script failed):', String(error)))
        await waitFor(() => boxes.length === 1, 4000)
        // A mark on the document: a reload that went through would leave a new document without it, at the same address.
        const marked = await evaluate<boolean>(trap.wc, 'window.__kept = true')
        void evaluate(trap.wc, 'location.reload()').catch((error: unknown) => console.warn('[popups] the script of the second reload of the trap had no answer (the page left, or the script failed):', String(error)))
        const refusedQuietly = await waitFor(() => quiet.length === 1, 4000)
        const kept = await evaluate<unknown>(trap.wc, 'window.__kept === true').catch((error: unknown) => `unreadable: ${String(error)}`)
        const sheet = browser.currentOverlay()?.panel === 'leave'
        check('after "Rester" in the box of the system, a page that reloads itself again is not asked again, and stays', refusedQuietly && boxes.length === 1 && marked && kept === true && trap.wc.getURL() === `${A}/trap`, JSON.stringify({ boxes, quiet, prevents, sameDocument: kept, sheet, url: trap.wc.getURL() }))
        await clickOn(trap.wc, '#arm')
        void evaluate(trap.wc, 'location.reload()').catch(() => undefined)
        check('...a click of the user in the page lets it ask again', await waitFor(() => boxes.length === 2, 4000), JSON.stringify(boxes))
      } finally {
        for (const wc of listened) if (!wc.isDestroyed()) wc.off('will-prevent-unload', heard)
        console.warn = warn
        setLeaveAsker(null)
      }
    }
    await settleTab(opener.id)

    // A popup whose process dies is shown what a tab shows, and nothing is left behind when it is closed.
    await clickOn(opener.wc, '#sized')
    const doomed = await popupReady()
    if (doomed) {
      const pid = doomed.wc.getOSProcessId()
      const isDataPage = (wc: WebContents) => wc.getURL().startsWith('data:text/html')
      const ignored = new Set(allWebContents.getAllWebContents().filter(isDataPage).map((wc) => wc.id))
      const covers = () => allWebContents.getAllWebContents().filter((wc) => isDataPage(wc) && !ignored.has(wc.id) && !wc.isDestroyed()).length
      if (isKillablePid(pid, process.pid)) process.kill(pid, 'SIGKILL')
      check('a popup whose process died gets the page of a tab that crashed, laid over its window', await waitFor(() => covers() === 1, 10_000), `pid ${pid}, covers ${covers()}`)
      doomed.win.close()
      check('...and it is gone with the window', await waitFor(() => popupWindows().length === 0 && covers() === 0, 6000), `windows ${popupWindows().length}, covers ${covers()}`)
    } else check('a popup whose process died gets the page of a tab that crashed, laid over its window', false, 'no popup')
    await closeAllPopups()
    await settleTab(opener.id)

    // A link in a popup (target=_blank) opens in a tab of the browser: the popup has no tabs of its own.
    await clickOn(opener.wc, '#sized')
    const linker = await popupReady()
    if (linker) {
      const tabsBeforeLink = tabs().length
      const windowsBeforeLink = popupWindows().length
      await clickOn(linker.wc, '#link')
      check('a link of a popup that asks for a new tab opens a tab of the browser, not another window', await waitFor(() => tabs().length === tabsBeforeLink + 1 && tabs().at(-1)!.url.endsWith('/plain-from-popup')) && popupWindows().length === windowsBeforeLink, `tabs ${tabsBeforeLink}->${tabs().length}, windows ${popupWindows().length}`)
      const added = tabs().at(-1)!
      mine.push(added.id)
    } else check('a link of a popup that asks for a new tab opens a tab of the browser, not another window', false, 'no popup')
    await closeAllPopups()
    await settleTab(opener.id)

    // =============== at most three popups per tab, the popups of a popup included ===============
    await clickOn(opener.wc, '#many')
    await clickOn(opener.wc, '#many')
    check('two popups from a tab open', await waitFor(() => popupWindows().length === 2), `windows ${popupWindows().length}`)
    const first = popupWindows()[0]!
    await waitFor(() => !first.webContents.isLoading() && first.webContents.getURL().startsWith('http'))
    // No wait: the answer of window.open comes after the browser's decision.
    const unclicked = await evaluate<string>(first.webContents, `(() => { const w = window.open('/b?unclicked', '_blank', 'width=300,height=300'); return w === null ? 'null' : typeof w })()`)
    check('a popup that opens a window with no click of its own gets nothing, as a tab does', unclicked === 'null' && popupWindows().length === 2, `${unclicked} windows ${popupWindows().length}`)
    await clickOn(first.webContents, '#nested')
    check('a popup may open a popup of its own (a third)', await waitFor(() => popupWindows().length === 3), `windows ${popupWindows().length}`)
    await settleTab(opener.id)
    // The witness: the answer of this window.open, which the button writes down once the browser has decided.
    const typesBefore = (await evaluate<string[]>(opener.wc, 'window.__types')).length
    await clickOn(opener.wc, '#many')
    await waitFor(async () => (await evaluate<string[]>(opener.wc, 'window.__types')).length > typesBefore)
    const types = await evaluate<string[]>(opener.wc, 'window.__types')
    check('a fourth popup of the same tab is refused: nothing opens and window.open returns null', popupWindows().length === 3 && engine.pagePopupCount() === 3 && types.at(-1) === 'null', JSON.stringify({ windows: popupWindows().length, counted: engine.pagePopupCount(), types }))
    check('...the two the tab opened itself were let through (the popup of a popup is the third: it counts for the tab it started from)', types.filter((t) => t === 'object').length === 2, JSON.stringify(types))
    await clickOn(first.webContents, '#nested')
    check('a popup that asks for one more is refused too', popupWindows().length === 3 && (await evaluate<string>(first.webContents, 'window.__nestedType')) === 'null', `windows ${popupWindows().length} ${await evaluate(first.webContents, 'window.__nestedType')}`)

    // Two requests that raced past the handler: the window that exceeds the share is closed as it appears.
    const slipped = new BrowserWindow({ show: false })
    known.add(slipped.id)
    opener.wc.emit('did-create-window', slipped, {})
    check('a window that got past the handler, with the tab at its share, is closed as it appears', (await waitFor(() => slipped.isDestroyed(), 3000)) && popupWindows().length === 3 && engine.pagePopupCount() === 3, `destroyed ${slipped.isDestroyed()}, windows ${popupWindows().length}, counted ${engine.pagePopupCount()}`)
    if (!slipped.isDestroyed()) slipped.destroy()

    // The task manager lists the popups.
    const rows = browser.pageProcesses()
    const listed = popupWindows().filter((w) => rows.has(w.webContents.getOSProcessId()))
    check('the task manager lists the popup windows by their title', listed.length >= 1 && listed.every((w) => rows.get(w.webContents.getOSProcessId())?.startsWith(`127.0.0.1:${port} — `)), JSON.stringify([...rows]))

    // Closing the tab closes every popup it opened, the nested one too.
    browser.dispatch({ type: 'tab/close', id: opener.id })
    check('closing the tab that opened them closes every popup, the popup of a popup included', await waitFor(() => popupWindows().length === 0 && engine.pagePopupCount() === 0, 6000), `windows ${popupWindows().length}, counted ${engine.pagePopupCount()}`)

    // =============== what stays a tab or a Glance ===============
    const tab2 = await openTab(`${A}/a?second`)
    await sleep(400)
    let tabCount = tabs().length
    // The pages of this server are two sites (localhost and 127.0.0.1): a link to the other one that asks for a new tab (`target="_blank"`, or window.open
    // without features after a click) opens a mini window by default (« littleArcNewTabLinks », shared/little-modifier.ts), never a popup window the page
    // can talk to, and no tab. The setting is put on whatever an earlier suite left; the checks after it are those of a tab, with the setting off.
    browser.dispatch({ type: 'settings/update', patch: { littleArcNewTabLinks: true, peekWithShift: false } })
    const minisBefore = new Set(little.states().map((st) => st.id))
    const newMinis = () => little.states().filter((st) => !minisBefore.has(st.id))
    const opensMini = () => waitFor(() => newMinis().length === 1 && newMinis()[0]!.url === `${B}/plain`, 4000)
    const miniSeen = () => JSON.stringify({ minis: newMinis().map((st) => st.url), popups: engine.pagePopupCount(), tabs: tabs().length - tabCount })
    const closeNewMinis = async () => {
      for (const st of newMinis()) little.close(st.id)
      await waitFor(() => newMinis().length === 0 && popupWindows().length === 0, 4000)
      await settleTab(tab2.id)
    }
    await clickOn(tab2.wc, '#blank')
    check('a link to another site that asks for a new tab opens a mini window by default, not a tab nor a popup window of the page', (await opensMini()) && tabs().length === tabCount && engine.pagePopupCount() === 0, miniSeen())
    await closeNewMinis()
    await clickOn(tab2.wc, '#plain')
    check('by default, window.open without features to another site opens a mini window, not a popup of the page and not a tab', (await opensMini()) && engine.pagePopupCount() === 0 && tabs().length === tabCount, miniSeen())
    await closeNewMinis()
    // With that setting off, the way before: a tab. The checks below are of what a page asks for; the mini window has its own suite (smoke-littlearc.ts).
    browser.dispatch({ type: 'settings/update', patch: { littleArcNewTabLinks: false, peekWithShift: true } })
    await settleTab(tab2.id)
    tabCount = tabs().length
    await clickOn(tab2.wc, '#plain')
    check('window.open without features still opens a tab', await waitFor(() => tabs().length === tabCount + 1 && tabs().at(-1)!.url === `${B}/plain`) && popupWindows().length === 0, `${tabs().slice(tabCount).map((t) => t.url)}`)
    for (const tab of tabs().slice(tabCount)) mine.push(tab.id)
    await settleTab(tab2.id)
    tabCount = tabs().length
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: false } })
    await clickOn(tab2.wc, '#blank')
    check('a link with target=_blank still opens a tab', await waitFor(() => tabs().length === tabCount + 1) && popupWindows().length === 0 && browser.snapshot().peek === null, `${tabs().slice(tabCount).map((t) => t.url)}`)
    for (const tab of tabs().slice(tabCount)) mine.push(tab.id)
    await settleTab(tab2.id)
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: true } })
    tabCount = tabs().length
    await clickOn(tab2.wc, '#blank', ['shift'])
    check('a Shift+click on a link is still a Glance, not a popup window', (await waitFor(() => browser.snapshot().peek !== null)) && popupWindows().length === 0 && tabs().length === tabCount, `peek ${JSON.stringify(browser.snapshot().peek?.url)} windows ${popupWindows().length}`)
    browser.closeOverlay()
    await sleep(300)
    tabCount = tabs().length
    await settleTab(tab2.id)
    await clickOn(tab2.wc, '#blank', ['meta'])
    check('a ⌘-click on a link is still a tab, in the background', (await waitFor(() => tabs().length === tabCount + 1)) && popupWindows().length === 0, `${tabs().slice(tabCount).map((t) => t.url)}`)
    for (const tab of tabs().slice(tabCount)) mine.push(tab.id)
    await settleTab(tab2.id)

    // A page that is not on the web does not get popups: a page of the user's own files that asks for one gets a tab, as before.
    const dir = mkdtempSync(join(tmpdir(), 'lucium-popups-'))
    const filePage = join(dir, 'opener.html')
    writeFileSync(filePage, `<title>file opener</title><body style="margin:0"><button id="go" style="position:absolute;left:10px;top:10px;width:200px;height:30px" onclick="window.open('${B}/plain', 'from-file', 'width=300,height=300')">go</button></body>`)
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: false } })
    const local = await openTab(`file://${filePage}`)
    tabCount = tabs().length
    await clickOn(local.wc, '#go')
    check('a page of the user’s files that asks for a popup gets a tab, not a window', (await waitFor(() => tabs().length === tabCount + 1)) && popupWindows().length === 0, `tabs ${tabCount}->${tabs().length} windows ${popupWindows().length}`)
    for (const tab of tabs().slice(tabCount)) mine.push(tab.id)
    rmSync(dir, { recursive: true, force: true })
    browser.dispatch({ type: 'settings/update', patch: { peekWithShift: true } })

    // =============== a private window: its own session ===============
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    known.add(priv.win.id)
    priv.win.showInactive()
    const privateUrl = `${A}/a?private`
    priv.browser.dispatch({ type: 'tab/open', url: privateUrl })
    const privateWc = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = allWebContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL() === privateUrl && wc.session !== tab2.wc.session)
        if (found) return found
        await sleep(100)
      }
      return undefined
    })()
    check('a page of a private window is in a session of its own', !!privateWc && privateWc.session !== tab2.wc.session && !privateWc.session.isPersistent())
    if (privateWc) {
      await sleep(500)
      const privateAgent = await evaluate<string>(privateWc, 'navigator.userAgent')
      check('...and has the same plain Chrome user agent', privateAgent === wanted, privateAgent)
      await clickOn(privateWc, '#same')
      const kin = await popupReady()
      check('a click in a private window opens a popup', kin !== undefined && popupWindows().length === 1)
      if (kin) {
        check('the popup of a private window is in the memory-only session of that window, not in a profile’s', kin.wc.session === privateWc.session && kin.wc.session !== tab2.wc.session && !kin.wc.session.isPersistent() && kin.wc.session.getStoragePath() === null)
        const cookie = await evaluate<string>(kin.wc, 'window.__cookie')
        check('the cookie the private page set is seen by its popup', cookie.includes('popsid=from-a-private'), cookie)
        const inOthers = (await Promise.all([session.defaultSession.cookies.get({ name: 'popsid' }), tab2.wc.session.cookies.get({ name: 'popsid', url: A })])).flat()
        check('...and by no other session', inOthers.every((c) => c.value !== 'from-a-private'), JSON.stringify(inOthers.map((c) => c.value)))
        check('the popup of a private window is not listed in the task manager of the normal windows, but in its own', ![...browser.pageProcesses().keys()].includes(kin.wc.getOSProcessId()) && [...priv.browser.pageProcesses().keys()].includes(kin.wc.getOSProcessId()), JSON.stringify([...priv.browser.pageProcesses()]))
        const persistedAgent = await evaluate<string>(kin.wc, 'navigator.userAgent')
        check('...and it has the same user agent', persistedAgent === wanted, persistedAgent)
      }
    }
    priv.win.close()
    check('closing the private window closes its popups', await waitFor(() => manager.privateWindows().length === 0 && popupWindows().length === 0 && engine.pagePopupCount() === 0, 8000), `windows ${popupWindows().length}, counted ${engine.pagePopupCount()}`)
    await manager.settled()
  } catch (error) {
    check('popups run to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    await closeAllPopups()
    browser.dispatch({ type: 'settings/update', patch: prior })
    browser.setExtraBlockedHosts([])
    browser.closeOverlay()
    for (const id of mine) browser.dispatch({ type: 'tab/close', id })
    server.close()
    server.closeAllConnections()
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the end-to-end measurement on the real sign-in pages
// ---------------------------------------------------------------------------------------------------------------------------------

interface Point {
  x: number
  y: number
  text: string
}

/** Where the pictures of the end-to-end measurement go (the popups of the sign-in pages, without anything typed in them). */
const REAL_OUT = process.env['LUCIUM_POPUPS_OUT'] ?? ''

/** The sign-in screens say this when they refuse a browser they take for an embedded one. */
const UNSAFE_BROWSER = /ce navigateur ou cette application|n.est peut-.tre pas s.curis|this browser or app may not be secure|couldn.t sign you in|navigateur non pris en charge/i

async function realSignIn(ctx: SmokeContext, check: Check, provider: { label: string; button: RegExp; host: RegExp; popup: boolean }): Promise<unknown> {
  const { browser, store, engine, win } = ctx
  const tabs = () => store.get().tabs
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : allWebContents.fromId(number) ?? undefined
  }
  const log = (line: string) => console.log(`[popups-real] ${provider.label}: ${line}`)
  const picture = async (wc: WebContents, name: string): Promise<string | null> => {
    if (!REAL_OUT) return null
    try {
      mkdirSync(REAL_OUT, { recursive: true })
      const path = join(REAL_OUT, name)
      writeFileSync(path, (await wc.capturePage()).toPNG())
      return path
    } catch (error) {
      log(`cannot take ${name}: ${(error as Error).message}`)
      return null
    }
  }
  const textOf = (wc: WebContents, limit: number): Promise<string> =>
    evaluate<string>(wc, `document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, ${limit}) : ''`).catch((error: unknown) => {
      log(`cannot read the text of a page: ${(error as Error).message}`)
      return ''
    })

  win.showInactive()
  browser.dispatch({ type: 'tab/open', url: 'https://claude.ai/login' })
  const tab = tabs().at(-1)!
  await waitFor(() => pageOf(tab.id) !== undefined)
  const wc = pageOf(tab.id)!
  await waitFor(() => !wc.isLoading() && wc.getURL().startsWith('https://claude.ai/'), 30_000)
  await sleep(4000)
  const title = wc.getTitle()
  log(`login page loaded: "${title}" at ${new URL(wc.getURL()).origin}${new URL(wc.getURL()).pathname}`)
  const challenged = /just a moment|un instant|attention required|verify you are human/i.test(title)
  await picture(wc, `${provider.label}-0-login.png`)

  const point = await evaluate<Point | null>(
    wc,
    `(() => {
      const els = [...document.querySelectorAll('button, a, [role=button]')]
      const el = els.find((e) => ${provider.button}.test(e.textContent || ''))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.textContent || '').trim().slice(0, 60) }
    })()`
  )
  if (!point) {
    log(`no button for ${provider.label} on the page${challenged ? ' (a challenge page is shown)' : ''}`)
    check(`${provider.label}: the login page offers the button`, false, `title="${title}"`)
    browser.dispatch({ type: 'tab/close', id: tab.id })
    return { provider: provider.label, button: false, challenged, title }
  }
  log(`button "${point.text}" at ${Math.round(point.x)},${Math.round(point.y)}`)

  const windowsBefore = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
  const tabsBefore = tabs().length
  const contentsBefore = new Set(allWebContents.getAllWebContents().map((c) => c.id))
  // A real click: move, press, release.
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
    wc.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    await sleep(40)
  }

  const isProvider = (url: string) => provider.host.test(url)
  const popupWindow = () => BrowserWindow.getAllWindows().find((w) => !windowsBefore.has(w.id) && !w.isDestroyed() && isProvider(w.webContents.getURL()))
  const providerTab = () => tabs().slice(tabsBefore).find((t) => isProvider(t.url))
  const providerContents = () => allWebContents.getAllWebContents().find((c) => !contentsBefore.has(c.id) && c.id !== wc.id && !c.isDestroyed() && isProvider(c.getURL()))
  const sameTab = () => isProvider(wc.getURL())
  await waitFor(() => popupWindow() !== undefined || providerTab() !== undefined || providerContents() !== undefined || sameTab(), 15_000)
  await sleep(5000)
  const popup = popupWindow()
  const target = popup?.webContents ?? providerContents() ?? (sameTab() ? wc : undefined)
  const where = popup ? 'popup window' : providerTab() ? 'tab' : providerContents() ? 'peek or other view' : sameTab() ? 'same tab (redirect)' : 'nothing opened'
  log(`the click opened: ${where}`)

  let text = ''
  let hasOpener: boolean | null = null
  let popupTitle = ''
  let url = ''
  let shot: string | null = null
  if (target && !target.isDestroyed()) {
    url = target.getURL()
    popupTitle = popup?.getTitle() ?? target.getTitle()
    text = await textOf(target, 400)
    hasOpener = await evaluate<boolean>(target, `window.opener !== null`).catch((error: unknown) => {
      log(`cannot read window.opener: ${(error as Error).message}`)
      return null
    })
    shot = await picture(target, `${provider.label}-1-${popup ? 'popup' : 'screen'}.png`)
  }
  const unsafe = UNSAFE_BROWSER.test(text)
  const captcha = /captcha|recaptcha|robot|verify it.s you|v.rifiez qu.il s.agit/i.test(text)
  log(`opener=${hasOpener} url=${url.split('?')[0]} title="${popupTitle}" unsafeWarning=${unsafe} captcha=${captcha}`)
  log(`screen text: ${text.slice(0, 160)}`)

  // What the page that asked says once the popup is up (the error of the screenshot of the user), read before the popup is closed.
  await sleep(2500)
  const pageText = sameTab() ? '' : await textOf(wc, 4000)
  const errorPattern = /une erreur s.est produite|an error occurred|something went wrong|erreur lors de la connexion|error during sign.?in/i
  const pageError = errorPattern.test(pageText)
  const errorSnippet = pageText.match(/.{0,60}(une erreur s.est produite|an error occurred|erreur lors de la connexion).{0,80}/i)?.[0] ?? ''
  log(`claude.ai after the click: error=${pageError}${errorSnippet ? ` "${errorSnippet}"` : ''}`)
  const pageShot = sameTab() ? null : await picture(wc, `${provider.label}-2-page-after.png`)

  const report = { provider: provider.label, button: point.text, opened: where, hasOpener, url: url.split('?')[0], popupTitle, unsafeWarning: unsafe, captcha, pageError, errorSnippet, screenText: text.slice(0, 200), pictures: [shot, pageShot] }
  if (provider.popup) check(`${provider.label}: the click opens a popup window on the provider with an opener`, popup !== undefined && hasOpener === true, JSON.stringify(report))
  check(`${provider.label}: the provider shows its normal sign-in screen, not a warning about the browser`, target !== undefined && !unsafe && isProvider(url), JSON.stringify(report))
  check(`${provider.label}: the page that asked shows no error`, !pageError, errorSnippet)

  // Nothing typed, nothing sent: the popup and the tabs are closed.
  if (popup && !popup.isDestroyed()) popup.close()
  for (const extra of tabs().slice(tabsBefore)) browser.dispatch({ type: 'tab/close', id: extra.id })
  browser.closeOverlay()
  browser.dispatch({ type: 'tab/close', id: tab.id })
  await sleep(500)
  return report
}

/** The end-to-end measurement on the real sign-in pages: no credential is ever typed, the popups are only looked at and closed. */
export async function smokePopupsReal(ctx: SmokeContext, check: Check): Promise<void> {
  const reports: unknown[] = []
  reports.push(await realSignIn(ctx, check, { label: 'google', button: /google/i, host: /^https:\/\/accounts\.google\./i, popup: true }))
  reports.push(await realSignIn(ctx, check, { label: 'apple', button: /apple/i, host: /^https:\/\/appleid\.apple\.com\//i, popup: false }))
  console.log(`[popups-real] report ${JSON.stringify(reports)}`)
}

/** The same checks with their own report, for `LUCIUM_SMOKE_ONLY=popups` and for the chain in index.ts. */
export async function runPopupsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  const record: Check = (name, ok, detail) => {
    noteCheck(checks, name, ok, detail)
    if (process.env['LUCIUM_POPUPS_VERBOSE'] === '1') console.log(`POPUPS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 600)}`}`)
  }
  try {
    const real = process.env['LUCIUM_POPUPS_REAL']
    if (real !== 'only') await smokePopups(ctx, record)
    if (real === '1' || real === 'only') await smokePopupsReal(ctx, record)
  } catch (error) {
    noteCheck(checks, 'smokePopups ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_POPUPS ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
