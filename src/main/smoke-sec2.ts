// Engine checks for what an extension may and may not do, run inside a real Electron as part of the main suite.
// Three probe extensions are driven by a local page that asks their service workers to call a Chrome API and hands the answer back:
//  - compat/no-permission-probe declares nothing: it must see no cookies, no tab addresses, and receive no event of an API it lacks;
//  - compat/sec-driver-probe holds an agent extension's permissions: what the debugger, the tabs, the windows, the sign-in window,
//    the downloads and the native ports let it do is checked against the rules;
//  - compat/active-tab-probe declares only activeTab: it sees a page from the moment the user invokes it, until the tab leaves the site.
// Local pages, a self-signed certificate (openssl) and a stand-in native host (compat/native-host-probe) are the only outside world.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, session, webContents as allWebContents, type WebContents } from 'electron'
import { AUTH_ERRORS } from '@shared/chrome-compat'
import { TAB_URL_MAX } from '@shared/state-clean'
import { GESTURE_WINDOW_MS } from '@shared/web-auth'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, requireProbes, sleep, waiterOf } from './smoke-kit'
import { DROP_WATCH, DROP_WITNESS, dropVerdict } from './smoke-probe-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Reply {
  ok: boolean
  value?: any
  error?: string
  undefined?: boolean
  ms?: number
}


/** What a worker that does not answer gives: a failed check, not a test that never ends. */
const withDeadline = <T>(promise: Promise<T>, fallback: T, ms = 25_000): Promise<T> => Promise.race([promise, sleep(ms).then(() => fallback)])
const silent: Reply = { ok: false, error: 'no answer from the worker within 25 seconds' }

const waitFor = waiterOf(10_000, 80)

/** A self-signed certificate for 127.0.0.1, made with the system's openssl in a throw-away folder. Null when openssl is not there. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-sec2-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const RPC_PAGE = `<title>sec2-rpc</title><body>rpc page<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
  window.call = (ext, path, ...args) => window.rpc(ext, { type: 'call', path, args })
</script></body>`

export async function smokeSec2({ browser, store, engine, little, win }: SmokeContext, check: Check): Promise<void> {
  const named = (name: string) => engine.listExtensions().find((e) => e.name === name)
  const none = named('Sec2 No Permission Probe')
  const driver = named('Sec2 Driver Probe')
  const active = named('Sec2 Active Tab Probe')
  // Without its three probes the suite verifies nothing: each missing one is a failed check, not a silent return.
  if (!requireProbes(engine.listExtensions(), ['Sec2 No Permission Probe', 'Sec2 Driver Probe', 'Sec2 Active Tab Probe'], check) || !none || !driver || !active) return
  const startedAt = Date.now()
  const tabsAtStart = new Set(store.get().tabs.map((t) => t.id))
  // The suites before this one leave tabs to sleep after a split second: the pages that drive the probes must stay.
  const sleepAfter = store.get().settings.sleepAfterMinutes
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  const activeLog: Array<{ name: string; value: any }> = []
  engine.onExtensionConsole((entry) => {
    if (entry.message.startsWith('ACTIVE_TAB ')) activeLog.push(JSON.parse(entry.message.slice('ACTIVE_TAB '.length)))
  })
  const downloadsSeen: string[] = []
  engine.onDownload((download) => {
    if (download.state === 'progressing') downloadsSeen.push(download.url)
  })

  // ---- the world around: a server of small pages, a server with a bad certificate, a stand-in native host ----
  const material = selfSignedCertificate()
  check('sec2: openssl is there to make a self-signed certificate for the test', material !== null)
  const title = (text: string) => `<title>${text}</title><body>${text}</body>`
  const server: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (path === '/rpc') return void res.setHeader('content-type', 'text/html').end(RPC_PAGE)
    if (path === '/dl' || path === '/dl-auth') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="sec2-dl.bin"')
      return void res.end(Buffer.alloc(512, 7))
    }
    if (path === '/dl-redirect') {
      res.statusCode = 302
      res.setHeader('location', '/dl')
      return void res.end()
    }
    if (path === '/') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="sec2-root.bin"')
      return void res.end(Buffer.alloc(256, 3))
    }
    if (path === '/fake-auth') {
      res.statusCode = 302
      res.setHeader('location', `${url.searchParams.get('redirect_uri')}?code=sec2&state=${url.searchParams.get('state')}`)
      return void res.end()
    }
    if (path === '/hang') {
      // A sign-in page that lies about where it is, asks for a permission and tries to download a file.
      res.setHeader('content-type', 'text/html')
      return void res.end(`<title>accounts.google.com - sign in</title><body>hang<script>setTimeout(() => { location.href = '/dl-auth' }, 400)</script></body>`)
    }
    if (path === '/sw-page') {
      res.setHeader('content-type', 'text/html')
      return void res.end(`<title>sw-wait</title><body><script>
        navigator.serviceWorker.addEventListener('message', (e) => { document.title = 'sw:' + e.data })
        navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then((reg) => reg.active.postMessage('ask'))
      </script></body>`)
    }
    if (path === '/sw.js') {
      res.setHeader('content-type', 'text/javascript')
      return void res.end(`self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
        self.addEventListener('message', (e) => e.source.postMessage(typeof self.__luciumShim))`)
    }
    res.setHeader('content-type', 'text/html')
    if (path === '/aaaa') return void res.end(title('a'.repeat(32)))
    return void res.end(title(`sec2 ${path}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const httpsServer = material ? createHttpsServer(material, (_req, res) => void res.setHeader('content-type', 'text/html').end(title('sec2 tls'))) : null
  if (httpsServer) await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve))
  const tlsBase = httpsServer ? `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}` : null

  const hostDir = join(app.getPath('userData'), 'NativeMessagingHosts')
  const hostScript = join(dirname((process.env['LUCIUM_EXTENSIONS'] ?? '').split(':').find((p) => p.endsWith('sec-driver-probe')) ?? ''), 'native-host-probe', 'host.cjs')
  const hostReady = existsSync(hostScript)
  if (hostReady) {
    mkdirSync(hostDir, { recursive: true })
    const wrapper = join(hostDir, 'sec2-host.sh')
    // The packaged application has the RunAsNode fuse off: use the Node of the machine when there is one.
    let nodeOnPath = ''
    try {
      nodeOnPath = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
    } catch {
      // No Node on this machine: the development binary can still play the interpreter.
    }
    const runner = nodeOnPath ? `exec '${nodeOnPath}'` : `ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}'`
    writeFileSync(wrapper, `#!/bin/sh\n${runner} '${hostScript}' "$@"\n`)
    chmodSync(wrapper, 0o755)
    writeFileSync(join(hostDir, 'com.lucium.sec2_host.json'), JSON.stringify({ name: 'com.lucium.sec2_host', description: 'Lucium test host', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${driver.id}/`] }))
  }
  check('sec2: the stand-in native host is found next to the probes', hostReady, hostScript)

  // ---- tabs ----
  const opened: string[] = []
  const wcOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const numberOf = (tabId: string): number => engine.tabNumberOf(tabId) ?? -1
  const openTab = async (url: string, readyTitle?: (t: string) => boolean): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = store.get().tabs.at(-1)!
    opened.push(tab.id)
    await waitFor(() => wcOf(tab.id) !== undefined, 8000)
    if (readyTitle) await waitFor(() => readyTitle(store.get().tabs.find((t) => t.id === tab.id)?.title ?? ''), 8000)
    return { id: tab.id, wc: wcOf(tab.id)! }
  }
  const tabByTitle = (text: string) => store.get().tabs.find((t) => t.title === text)
  const profileOfTab = (tabId: string): string | undefined => {
    const state = store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    return tab ? (state.spaces.find((s) => s.id === tab.spaceId)?.profileId ?? 'default') : undefined
  }

  const home = store.get().activeSpaceId
  const rpcTab = await openTab(`${base}/rpc`, (t) => t === 'sec2-rpc')
  check('sec2: the page that drives the probes loads', rpcTab.wc !== undefined && tabByTitle('sec2-rpc') !== undefined)
  const rpcIn = (wc: WebContents) => ({
    message: (ext: string, message: unknown): Promise<Reply> => withDeadline(wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify(message)})`) as Promise<Reply>, silent),
    /** `argsSource` is JavaScript: an argument that is not JSON (NaN) can be given. */
    callJs: (ext: string, path: string, argsSource: string): Promise<Reply> => withDeadline(wc.executeJavaScript(`window.call(${JSON.stringify(ext)}, ${JSON.stringify(path)}, ...${argsSource})`) as Promise<Reply>, silent)
  })
  const rpc = rpcIn(rpcTab.wc)
  const call = (ext: string, path: string, ...args: unknown[]) => rpc.callJs(ext, path, JSON.stringify(args))
  // The worker answers the log itself (an array), not a result record.
  const logOf = async (ext: string): Promise<any[]> => {
    const log: unknown = await rpc.message(ext, { type: 'log' })
    return Array.isArray(log) ? log : []
  }

  // ==== an extension that declared nothing ====
  console.log('[sec2] C1')
  const hidden = ['cookies', 'webNavigation', 'contextMenus', 'notifications', 'topSites', 'privacy', 'downloads', 'debugger', 'tabGroups', 'sidePanel', 'identity']
  const kinds = (await rpc.message(none.id, { type: 'typeof', paths: [...hidden, 'tabs', 'windows', 'runtime', 'tabs.query', 'tabs.captureVisibleTab', 'runtime.connectNative'] })) as unknown as Record<string, string>
  check('sec2 C1: with no permission, chrome.cookies, webNavigation, contextMenus, notifications, downloads, debugger, identity... do not exist', hidden.every((name) => kinds[name] === 'undefined'), JSON.stringify(kinds))
  check('sec2 C1: tabs, windows and runtime exist for everyone, as in Chrome; captureVisibleTab and connectNative do not', kinds['tabs'] === 'object' && kinds['windows'] === 'object' && kinds['runtime'] === 'object' && kinds['tabs.query'] === 'function' && kinds['runtime.connectNative'] === 'undefined', JSON.stringify(kinds))
  const driverKinds = (await rpc.message(driver.id, { type: 'typeof', paths: ['cookies', 'webNavigation', 'debugger', 'downloads'] })) as unknown as Record<string, string>
  check('sec2 C1: an extension that declared them keeps them', Object.values(driverKinds).every((k) => k === 'object'), JSON.stringify(driverKinds))

  const stripped = (tab: Record<string, unknown>) => ['url', 'pendingUrl', 'title', 'favIconUrl'].filter((field) => field in tab)
  const noneTabs = ((await call(none.id, 'tabs.query', {})).value ?? []) as Array<Record<string, unknown>>
  check('sec2 C1: tabs.query gives such an extension the tabs without their address, title or icon', noneTabs.length > 0 && noneTabs.every((t) => stripped(t).length === 0), JSON.stringify(noneTabs[0]))
  check('sec2 C1: filtering by address or title does not find a tab it may not read', ((await call(none.id, 'tabs.query', { url: '*://*/*' })).value as unknown[]).length === 0 && ((await call(none.id, 'tabs.query', { title: '*' })).value as unknown[]).length === 0)
  const noneWindows = ((await call(none.id, 'windows.getAll', { populate: true })).value ?? []) as Array<{ tabs?: Array<Record<string, unknown>> }>
  check('sec2 C1: the tabs inside a window are stripped too', noneWindows.length > 0 && noneWindows.every((w) => (w.tabs ?? []).every((t) => stripped(t).length === 0)), JSON.stringify(noneWindows[0]?.tabs?.[0]))
  const driverTabs = ((await call(driver.id, 'tabs.query', {})).value ?? []) as Array<Record<string, unknown>>
  check('sec2 C1: an extension with "tabs" still sees them whole', driverTabs.some((t) => typeof t['url'] === 'string' && String(t['url']).startsWith(base)), JSON.stringify(driverTabs.map((t) => t['url'])))

  // The main process refuses even where nothing hides the namespaces: an offscreen document runs without our layer.
  const profileSession = session.fromPartition('persist:profile-default')
  await profileSession.cookies.set({ url: `${base}/`, name: 'sec2-session', value: 'secret' })
  const offscreen = await rpc.message(none.id, { type: 'offscreen' })
  const report = (offscreen.value ?? {}) as Record<string, any>
  check('sec2 C1: in a page where nothing hides them, the library does define chrome.cookies and the others (so the next checks prove something)', report['visible']?.cookies === 'object' && report['visible']?.webNavigation === 'object', JSON.stringify(report['visible'] ?? offscreen))
  check('sec2 C1: but the main process answers nothing to the cookies calls of an extension without "cookies"', ['cookies.getAll', 'cookies.getAllUrl', 'cookies.get', 'cookies.set'].every((name) => report[name]?.returned === 'undefined'), JSON.stringify(report))
  const planted = await profileSession.cookies.get({ name: 'sec2-planted' })
  check('sec2 C1: ...and it wrote no cookie', planted.length === 0, JSON.stringify(planted))
  check('sec2 C1: nor does it answer web navigation, menus, notifications or a style insertion', ['webNavigation.getAllFrames', 'contextMenus.create', 'notifications.getAll', 'tabs.insertCSS'].every((name) => report[name]?.returned === 'undefined'), JSON.stringify(report))
  check('sec2 C1: the tabs and windows it does answer carry no address or title', JSON.stringify(report['tabs.query']?.returned) !== undefined && !/url|title|favIconUrl/.test(String(report['tabs.query']?.returned)) && !/url|title/.test(String(report['windows.getAll']?.returned)), JSON.stringify([report['tabs.query'], report['windows.getAll']]))
  const driverCookies = ((await call(driver.id, 'cookies.getAll', {})).value ?? []) as Array<{ name: string }>
  check('sec2 C1: an extension with "cookies" and a host permission reads them (the same session)', driverCookies.some((c) => c.name === 'sec2-session'), JSON.stringify(driverCookies.map((c) => c.name)))

  // ==== where an extension may send a tab ====
  console.log('[sec2] H2')
  const forbidden = ['file:///etc/hosts', 'data:text/html,<b>x</b>', 'blob:http://127.0.0.1/none', `view-source:${base}/created`, `chrome-extension://${driver.id}/page.html`, 'chrome://settings', 'javascript:alert(1)']
  const tabsBefore = store.get().tabs.length
  const createRefusals = new Map<string, Reply>()
  for (const url of forbidden) createRefusals.set(url, await call(none.id, 'tabs.create', { url, active: false }))
  // A web address longer than a tab keeps: the guard of the library lets it through, the state refuses it. The shell used to answer it with the last
  // tab of the state, the user's, perhaps of another profile.
  const tooLong = `${base}/${'a'.repeat(TAB_URL_MAX)}`
  createRefusals.set(tooLong, await call(none.id, 'tabs.create', { url: tooLong, active: false }))
  // The main process refuses each of them with an error. The library of the extensions answers any error of the main process with nothing (its preload,
  // `invokeExtension`) and writes it in the console of the extension, for every API: no rejection reaches the extension. No tab may come back.
  const noTab = (reply: Reply | undefined) => reply !== undefined && (!reply.ok || reply.value === null)
  const toldRefused = ['file:///etc/hosts', 'data:text/html,<b>x</b>', 'blob:http://127.0.0.1/none', tooLong].every((url) => noTab(createRefusals.get(url)))
  check('sec2 H2: a refused tabs.create hands the extension no tab, never one that was already there', toldRefused, JSON.stringify([...createRefusals].map(([url, reply]) => [url.slice(0, 40), reply.ok, reply.value?.id ?? reply.error ?? null])))
  check('sec2 H2: tabs.create opens no local file, data: or blob: document, source view, page of another extension or page of the browser', store.get().tabs.length === tabsBefore && !store.get().tabs.some((t) => forbidden.includes(t.url)), JSON.stringify(store.get().tabs.slice(tabsBefore).map((t) => t.url)))
  const created = await call(none.id, 'tabs.create', { url: `${base}/created`, active: false })
  const createdTab = await waitFor(() => tabByTitle('sec2 /created') !== undefined)
  check('sec2 H2: ...but a web page opens', created.ok && createdTab)
  const createdId = tabByTitle('sec2 /created')?.id
  if (createdId) opened.push(createdId)
  const kept = createdId ? store.get().tabs.find((t) => t.id === createdId)?.url : undefined
  // The witness is the answer: the main process gives it once it has refused the address, or once the navigation it took has started (the
  // window it took exists), so nothing of a refused call can come after it.
  const updated = await call(none.id, 'tabs.update', numberOf(createdId ?? ''), { url: 'file:///etc/hosts' })
  check('sec2 H2: tabs.update does not send a tab to a local file either', noTab(updated) && createdId !== undefined && store.get().tabs.find((t) => t.id === createdId)?.url === kept && kept === `${base}/created`, `${String(kept)} ${JSON.stringify(updated)}`)
  const windowsBefore = getWindowManager().extraWindows().length
  const littleBefore = little.count()
  const normalOnFile = await call(none.id, 'windows.create', { url: 'file:///etc/hosts' })
  const popupOnFile = await call(none.id, 'windows.create', { url: 'file:///etc/hosts', type: 'popup' })
  check('sec2 H2: windows.create opens no window on a local file (neither a normal one nor a popup)', noTab(normalOnFile) && noTab(popupOnFile) && getWindowManager().extraWindows().length === windowsBefore && little.count() === littleBefore, `${getWindowManager().extraWindows().length} ${little.count()} ${JSON.stringify([normalOnFile, popupOnFile])}`)
  await call(none.id, 'tabs.create', { url: `chrome-extension://${none.id}/offscreen.html`, active: false })
  const ownPage = await waitFor(() => store.get().tabs.some((t) => t.url === `chrome-extension://${none.id}/offscreen.html`), 5000)
  check('sec2 H2: an extension opens its own pages', ownPage)

  // ==== the windows an extension may move ====
  console.log('[sec2] M6')
  // A window of the application that shows no tab of the profile (Settings, a private window...). A private window would take the number of the first
  // private session, which the window checks that follow expect to find: a window of its own, never shown, stands for it.
  const foreign = new BrowserWindow({ show: false, width: 400, height: 300 })
  const foreignBounds = foreign.getBounds()
  await call(none.id, 'windows.update', foreign.id, { width: 321, height: 222, left: 7, top: 9, focused: true })
  const foreignAfter = foreign.getBounds()
  check('sec2 M6: windows.update does not move or resize a window that shows no tab of the extension\'s profile', JSON.stringify(foreignAfter) === JSON.stringify(foreignBounds), JSON.stringify([foreignBounds, foreignAfter]))
  foreign.destroy()
  const littleNow = little.count()
  const popup = await rpc.callJs(none.id, 'windows.create', "[{ type: 'popup', url: 'about:blank', width: NaN, height: 500 }]")
  check('sec2 M6: a popup asked for with a width that is not a number still opens, with the size it can have', popup.ok && popup.value?.id !== undefined && little.count() === littleNow + 1, JSON.stringify(popup))
  const popupWindow = BrowserWindow.fromId(popup.value?.id ?? -1)
  check('sec2 M6: ...and it is a window like any other (a size that is not a number is not applied)', popupWindow !== null && popupWindow.getBounds().width <= 16384 && popupWindow.getBounds().height > 0, JSON.stringify(popupWindow?.getBounds()))
  const huge = await rpc.callJs(none.id, 'windows.create', "[{ type: 'popup', url: 'about:blank', width: 1e12, height: -50 }]")
  check('sec2 M6: a size beyond any screen, or negative, is brought back within limits (the window opens)', huge.ok && huge.value?.id !== undefined && (BrowserWindow.fromId(huge.value.id)?.getBounds().width ?? Infinity) <= 16384, JSON.stringify(huge))
  for (const reply of [popup, huge]) if (reply.value?.id !== undefined) await call(none.id, 'windows.remove', reply.value.id)
  check('sec2 M6: the popups can be closed again', await waitFor(() => little.count() === littleNow, 4000), String(little.count()))

  // ==== a pattern of stars ====
  console.log('[sec2] M2')
  await openTab(`${base}/aaaa`, (t) => t === 'a'.repeat(32)).then((tab) => opened.push(tab.id))
  const stars = await call(driver.id, 'tabs.query', { title: '*a'.repeat(14) + '*b' })
  check('sec2 M2: a title pattern of stars is answered at once (16 seconds with a regular expression)', stars.ok && (stars.value as unknown[]).length === 0 && (stars.ms ?? 99_999) < 2000, JSON.stringify(stars))
  const starUrl = await call(driver.id, 'tabs.query', { url: '*a'.repeat(14) + '*b' })
  check('sec2 M2: so is an address pattern', starUrl.ok && (starUrl.ms ?? 99_999) < 2000, JSON.stringify(starUrl))
  const found = await call(driver.id, 'tabs.query', { title: 'a*a' })
  check('sec2 M2: a pattern that matches still finds the tab', found.ok && (found.value as unknown[]).length === 1, JSON.stringify(found))

  // ==== what the debugger attaches to, and what it sends ====
  console.log('[sec2] H1')
  const fileTab = await openTab('file:///etc/hosts')
  await sleep(500)
  const attachFile = await call(driver.id, 'debugger.attach', { tabId: numberOf(fileTab.id) }, '1.3')
  check('sec2 H1: the debugger does not attach to a tab that shows a local file', !attachFile.ok && /Cannot attach to this target/.test(attachFile.error ?? ''), JSON.stringify(attachFile))
  const attachAgain = await call(driver.id, 'debugger.attach', { tabId: numberOf(fileTab.id) }, '1.3')
  check('sec2 B1: a refused attach leaves no "already attached" behind', !attachAgain.ok && !/already attached/.test(attachAgain.error ?? ''), JSON.stringify(attachAgain))
  const foreignId = await browser.openTabForExtension(`chrome-extension://${none.id}/offscreen.html`, false)
  opened.push(foreignId)
  // Attached to a tab that has not loaded anything yet it would be allowed (and let go as soon as the page goes where it may not follow).
  await waitFor(() => wcOf(foreignId)?.getURL().startsWith('chrome-extension://') === true, 8000)
  const attachForeign = await call(driver.id, 'debugger.attach', { tabId: numberOf(foreignId) }, '1.3')
  check('sec2 H1: nor to a page of another extension (it would run as that extension)', !attachForeign.ok && /Cannot attach to this target/.test(attachForeign.error ?? ''), JSON.stringify(attachForeign))
  const web = await openTab(`${base}/debug-target`, (t) => t === 'sec2 /debug-target')
  const webNumber = numberOf(web.id)
  const attachWeb = await call(driver.id, 'debugger.attach', { tabId: webNumber }, '1.3')
  check('sec2 H1: it attaches to a web page', attachWeb.ok, JSON.stringify(attachWeb))
  const evaluated = await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, 'Runtime.evaluate', { expression: '6 * 7', returnByValue: true })
  check('sec2 H1: ...and drives it', evaluated.ok && evaluated.value?.result?.value === 42, JSON.stringify(evaluated))
  // A drag that carries a file of the disk hands the file to the page, as a file field does; a key that pastes hands it the clipboard. Both are
  // refused by what they carry (debugger-policy.ts). The page watches its drops; a drag of text sent after the refused one is the witness that
  // drops reach it at all, so that "no file came" is not only "nothing came".
  const dragDir = mkdtempSync(join(tmpdir(), 'lucium-sec2-drag-'))
  try {
    const dragFile = join(dragDir, 'lucium-drag-secret.txt')
    writeFileSync(dragFile, 'a file of the disk that no page may be handed by an extension')
    const watching = await web.wc.executeJavaScript(DROP_WATCH).catch((error: unknown) => String((error as Error)?.message ?? error))
    const dragOf = async (data: Record<string, unknown>): Promise<Reply[]> => {
      const replies: Reply[] = []
      for (const type of ['dragEnter', 'dragOver', 'drop']) replies.push(await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, 'Input.dispatchDragEvent', { type, x: 40, y: 40, data }))
      return replies
    }
    const withFile = await dragOf({ items: [], files: [dragFile], dragOperationsMask: 1 })
    check('sec2 H1: a drag that carries a file of the disk is refused (Input.dispatchDragEvent with data.files)', withFile.every((reply) => !reply.ok && /Not allowed$/.test(reply.error ?? '')), JSON.stringify(withFile))
    const witness = await dragOf({ items: [{ mimeType: 'text/plain', data: DROP_WITNESS }], dragOperationsMask: 1 })
    let drops: unknown = null
    await waitFor(async () => {
      drops = await web.wc.executeJavaScript('window.__drops').catch((error: unknown) => `the page did not answer: ${String((error as Error)?.message ?? error)}`)
      return Array.isArray(drops) && drops.some((drop: { text?: unknown }) => drop.text === DROP_WITNESS)
    }, 8000)
    const dropped = dropVerdict(drops)
    check('sec2 H1: ...the page gets no file, and the drag of text that follows reaches it (the witness)', watching === true && witness.every((reply) => reply.ok) && dropped.ok, `${dropped.detail}; watching: ${String(watching)}; the drag of text: ${JSON.stringify(witness)}`)
    const paste = await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] })
    check('sec2 H1: a key that pastes the clipboard into the page is refused (Input.dispatchKeyEvent with a paste command)', !paste.ok && /Not allowed$/.test(paste.error ?? ''), JSON.stringify(paste))
  } finally {
    rmSync(dragDir, { recursive: true, force: true })
  }
  const refusals: Array<[string, unknown]> = [
    ['Browser.getVersion', {}],
    ['Target.getTargets', {}],
    ['Target.createTarget', { url: 'file:///etc/hosts' }],
    ['Storage.getCookies', {}],
    ['Network.getAllCookies', {}],
    ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
    ['Page.navigate', { url: 'file:///etc/hosts' }],
    ['DOM.setFileInputFiles', { files: ['/etc/hosts'], objectId: 'x' }]
  ]
  const results: string[] = []
  for (const [method, params] of refusals) {
    const reply = await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, method, params)
    results.push(`${method}:${reply.ok ? 'sent' : reply.error}`)
  }
  check('sec2 H1: the Browser, Target and Storage domains, browser-wide cookies, a download path, a local file and a navigation to a file are refused', results.every((r) => r.endsWith(':Not allowed')), results.join(' | '))
  const stillWorks = await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, 'Page.navigate', { url: `${base}/debug-next` })
  check('sec2 H1: a navigation to a web page goes through', stillWorks.ok, JSON.stringify(stillWorks))
  await waitFor(() => tabByTitle('sec2 /debug-next') !== undefined, 8000)
  await logOf(driver.id)
  // The page goes to a local file while the extension is attached: it is let go.
  browser.pageFor(web.id)?.loadURL('file:///etc/hosts')
  const detached = await waitFor(async () => (await logOf(driver.id)).some((e) => e.event === 'debugger.onDetach' && e.tabId === webNumber), 8000)
  check('sec2 H1: a page that goes to a local file while it is debugged is detached from the extension', detached)
  const afterDetach = await call(driver.id, 'debugger.sendCommand', { tabId: webNumber }, 'Runtime.evaluate', { expression: '1' })
  check('sec2 H1: ...and nothing more can be sent to it', !afterDetach.ok, JSON.stringify(afterDetach))

  // A certificate error page carries the key that lets the certificate through for every tab.
  if (tlsBase) {
    const bad = await openTab(`${tlsBase}/`)
    const showsError = async (wc: WebContents) => String(await wc.executeJavaScript('document.body ? document.body.innerText : ""')).includes('Votre connexion n’est pas privée')
    await waitFor(() => showsError(bad.wc), 10_000)
    check('sec2 B9: the page of a refused certificate is shown', await showsError(bad.wc))
    const attachError = await call(driver.id, 'debugger.attach', { tabId: numberOf(bad.id) }, '1.3')
    check('sec2 B9: the debugger does not attach to it (it could read the key to go on anyway)', !attachError.ok && /Cannot attach to this target/.test(attachError.error ?? ''), JSON.stringify(attachError))
    const web2 = await openTab(`${base}/debug-error`, (t) => t === 'sec2 /debug-error')
    const web2Number = numberOf(web2.id)
    await call(driver.id, 'debugger.attach', { tabId: web2Number }, '1.3')
    await logOf(driver.id)
    browser.pageFor(web2.id)?.loadURL(`${tlsBase}/`)
    check('sec2 B9: a page that fails on a certificate while it is debugged is let go', await waitFor(async () => (await logOf(driver.id)).some((e) => e.event === 'debugger.onDetach' && e.tabId === web2Number), 10_000))
  }

  // ==== the service worker of a web site gets none of the bridge ====
  console.log('[sec2] B5')
  const swTab = await openTab(`${base}/sw-page`, (t) => t.startsWith('sw:'))
  check('sec2 B5: the service worker of a web site is not handed the bridge of the extension shims', tabByTitle('sw:undefined') !== undefined, store.get().tabs.find((t) => t.id === swTab.id)?.title)

  // ==== another profile ====
  console.log('[sec2] H3')
  browser.dispatch({ type: 'space/create', name: 'sec2-other', emoji: '🧪', hue: 200, profileId: 'sec2-other' })
  const other = store.get().spaces.find((s) => s.name === 'sec2-other')
  check('sec2: a space in another profile is created', other?.profileId === 'sec2-other')
  const otherId = other?.id ?? home
  browser.dispatch({ type: 'space/select', id: otherId })
  // The extension of the first profile asks while the user is in a space of the second one.
  const h3 = await call(driver.id, 'tabs.create', { url: `${base}/h3-tab`, active: false })
  await waitFor(() => tabByTitle('sec2 /h3-tab') !== undefined, 8000)
  const h3Tab = tabByTitle('sec2 /h3-tab')
  if (h3Tab) opened.push(h3Tab.id)
  check('sec2 H3: a tab opened by the extension of a profile opens in a space of that profile, not in the space the user is in', h3.ok && h3Tab !== undefined && profileOfTab(h3Tab.id) === 'default', `${profileOfTab(h3Tab?.id ?? '')} | active ${store.get().activeSpaceId}`)
  const wm = getWindowManager()
  const extraBefore = wm.extraWindows().length
  const h3Window = await call(driver.id, 'windows.create', { url: `${base}/h3-window` })
  await waitFor(() => wm.extraWindows().length === extraBefore + 1, 8000)
  const extraRecord = wm.extraWindows().at(-1)
  await waitFor(() => (extraRecord?.store.get().tabs ?? []).some((t) => t.url === `${base}/h3-window`), 5000)
  const windowTab = extraRecord?.store.get().tabs.find((t) => t.url === `${base}/h3-window`)
  const windowProfile = windowTab ? extraRecord!.store.get().spaces.find((s) => s.id === windowTab.spaceId)?.profileId : undefined
  check('sec2 H3: so does the tab of a window it opens', h3Window.ok && windowProfile === 'default', `${windowProfile} ${JSON.stringify(h3Window)}`)
  extraRecord?.win.close()
  const popupStates = little.states().length
  const h3Popup = await call(driver.id, 'windows.create', { url: `${base}/h3-popup`, type: 'popup' })
  await waitFor(() => little.count() === popupStates + 1, 5000)
  const littleId = little.states().at(-1)?.id
  const popupProfile = littleId ? engine.profileOfTab(engine.tabNumberOf(littleId) ?? -1) : undefined
  check('sec2 H3: and the page of a popup it opens', h3Popup.ok && popupProfile === 'default', `${popupProfile} ${JSON.stringify(h3Popup)}`)
  if (h3Popup.value?.id !== undefined) await call(driver.id, 'windows.remove', h3Popup.value.id)
  // The other way round: an extension of the second profile, while the user is in a space of the first.
  browser.dispatch({ type: 'space/select', id: otherId })
  // The first page of a profile that has just been made can be lost while its extensions load: one is opened for nothing, then the real one.
  await openTab(`${base}/warm-up`, (t) => t === 'sec2 /warm-up')
  await sleep(4500)
  const otherTab = await openTab(`${base}/rpc`, (t) => t === 'sec2-rpc')
  const otherRpc = rpcIn(otherTab.wc)
  // A profile that has just been made loads its extensions in the background, and the worker starts when first asked.
  const tabsKind = async (): Promise<unknown> => ((await otherRpc.message(driver.id, { type: 'typeof', paths: ['tabs'] })) as unknown as Record<string, string>)['tabs']
  const workerReady = await waitFor(async () => (await tabsKind()) === 'object', 40_000)
  browser.dispatch({ type: 'space/select', id: home })
  const reverse = await otherRpc.callJs(driver.id, 'tabs.create', JSON.stringify([{ url: `${base}/h3-reverse`, active: false }]))
  await waitFor(() => tabByTitle('sec2 /h3-reverse') !== undefined, 8000)
  const reverseTab = tabByTitle('sec2 /h3-reverse')
  if (reverseTab) opened.push(reverseTab.id)
  check('sec2 H3: an extension of the second profile opens its tab in a space of the second profile', reverse.ok && reverseTab !== undefined && profileOfTab(reverseTab.id) === 'sec2-other', `${profileOfTab(reverseTab?.id ?? '')} ${JSON.stringify(reverse)} worker answered: ${workerReady}, page alive: ${!otherTab.wc.isDestroyed()} at ${otherTab.wc.isDestroyed() ? '' : otherTab.wc.getURL()}, workers: ${engine.runningExtensionWorkers().join(' ')}`)
  let ghost = ''
  await browser.openTabForExtension('about:blank', true, 'sec2-ghost').catch((error: Error) => void (ghost = error.message))
  check('sec2 H3: a profile with no space gets no tab', /no space for the profile/.test(ghost), ghost)

  // A panel with no tab named opens for the active tab, in the extension's own profile only.
  browser.dispatch({ type: 'space/select', id: otherId })
  const panel = await call(driver.id, 'sidePanel.open', { windowId: win.id })
  check('sec2 B6: sidePanel.open with no tab does not open in the space of another profile', !panel.ok && /no active tab in the profile of this extension/.test(panel.error ?? ''), JSON.stringify(panel))
  browser.dispatch({ type: 'space/select', id: home })

  // The events of the APIs an extension lacks do not reach it.
  await logOf(none.id)
  await logOf(driver.id)
  const grouped = await call(driver.id, 'tabs.group', { tabIds: [numberOf(rpcTab.id)] })
  const dlTab = await openTab(`${base}/dl`)
  opened.push(dlTab.id)
  await waitFor(() => downloadsSeen.some((u) => u.endsWith('/dl')), 8000)
  // The witness: the same events reaching the extension that declared them (each read empties its log). Only then is the other one asked.
  const driverEvents: string[] = []
  await waitFor(async () => {
    driverEvents.push(...(await logOf(driver.id)).map((e) => e.shimEvent).filter(Boolean))
    return driverEvents.includes('downloads.onCreated') && driverEvents.includes('tabGroups.onCreated')
  })
  const noneEvents = (await logOf(none.id)).map((e) => e.shimEvent).filter(Boolean)
  check('sec2 M1: the extension that declared downloads and tabGroups hears their events', grouped.ok && driverEvents.includes('downloads.onCreated') && driverEvents.includes('tabGroups.onCreated'), JSON.stringify(driverEvents))
  check('sec2 M1: the extension that declared nothing hears none of them (the address and the path of a download, the groups of the tabs)', noneEvents.length === 0, JSON.stringify(noneEvents))

  // An extension's download is recognised when the browser starts it, whatever the address becomes on the way.
  const redirected = await call(driver.id, 'downloads.download', { url: `${base}/dl-redirect`, filename: 'sec2/redirected.bin' })
  check('sec2 B7: a download that redirects is recognised (the extension gets its id and its file name)', redirected.ok && typeof redirected.value === 'number', JSON.stringify(redirected))
  check('sec2 B7: ...and the file has the name it asked for', await waitFor(() => existsSync(join(app.getPath('downloads'), 'sec2', 'redirected.bin')), 8000))
  const bare = await call(driver.id, 'downloads.download', { url: base, filename: 'sec2/root.bin' })
  check('sec2 B7: an address with no path (the browser writes it with a slash) is recognised too', bare.ok && typeof bare.value === 'number', JSON.stringify(bare))

  // ==== activeTab ====
  console.log('[sec2] M3')
  const first = await openTab(`${base}/active-a`, (t) => t === 'sec2 /active-a')
  await rpc.message(active.id, { type: 'observe', label: 'before' })
  await waitFor(() => activeLog.some((e) => e.name === 'before'), 5000)
  const before = activeLog.find((e) => e.name === 'before')?.value
  check('sec2 M3: an extension with activeTab only, that was not invoked, sees neither the address nor the title of the tab', before?.hasUrl === false && before?.hasTitle === false && before?.query?.every((t: any) => !t.hasUrl), JSON.stringify(before))
  check('sec2 M3: ...and cannot capture it', before?.capture?.ok === false && /activeTab/.test(before?.capture?.error ?? ''), JSON.stringify(before?.capture))
  browser.dispatch({ type: 'tab/select', id: first.id })
  await sleep(300)
  browser.runExtensionCommand(active.id, 'probe-activate')
  await waitFor(() => activeLog.some((e) => e.name === 'invoked'), 8000)
  // The user's tab goes to another site before the extension looks again.
  browser.pageFor(first.id)?.loadURL(`http://localhost:${new URL(base).port}/active-b`)
  const invoked = activeLog.find((e) => e.name === 'invoked')?.value
  const commandSaw = activeLog.find((e) => e.name === 'command')?.value
  check('sec2 M3: invoked on a tab (its shortcut), it sees the tab and its address', commandSaw?.hasUrl === true && invoked?.hasUrl === true && invoked?.hasTitle === true, JSON.stringify([commandSaw, invoked]))
  check('sec2 M3: ...and can capture it', invoked?.capture?.ok === true, JSON.stringify(invoked?.capture))
  await waitFor(() => activeLog.some((e) => e.name === 'later'), 10_000)
  const later = activeLog.find((e) => e.name === 'later')?.value
  check('sec2 M3: once the tab has gone to another site it sees nothing of it again, and cannot capture it', later?.hasUrl === false && later?.capture?.ok === false, JSON.stringify(later))
  const driverShot = await call(driver.id, 'tabs.captureVisibleTab')
  check('sec2 M3: an extension with access to every site captures without being invoked', driverShot.ok && String(driverShot.value).startsWith('data:image/png'), JSON.stringify(driverShot).slice(0, 120))

  // ==== a native port lives as long as the page that opened it ====
  console.log('[sec2] M4')
  if (hostReady) {
    const heldBefore = engine.heldWorkerCount()
    const pageTabId = await browser.openTabForExtension(`chrome-extension://${driver.id}/page.html?host=com.lucium.sec2_host`, true)
    opened.push(pageTabId)
    // The host announces itself on the command line of its process (the native messaging protocol gives it the origin of the extension). The page cannot be asked for its
    // pid: the events of Lucium's own APIs reach workers and side panels, not the pages of an extension open in a tab.
    const hostPid = (): number => {
      const lines = execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n')
      const line = lines.find((l) => l.includes('host.cjs') && l.includes(`chrome-extension://${driver.id}/`))
      return line ? Number(line.trim().split(/\s+/)[0]) : NaN
    }
    const gotPid = await waitFor(() => !Number.isNaN(hostPid()), 10_000)
    const pid = hostPid()
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    check('sec2 M4: a page of the extension opens a native port, and the host runs', gotPid && alive() && engine.heldWorkerCount() === heldBefore + 1, `${pid} held ${engine.heldWorkerCount()}`)
    browser.dispatch({ type: 'tab/close', id: pageTabId })
    check('sec2 M4: when the page is gone, the host is closed (it did not outlive the page)', await waitFor(() => !alive(), 8000), `pid ${pid} still running`)
    check('sec2 M4: ...and the worker the port held awake is let go', await waitFor(() => engine.heldWorkerCount() === heldBefore, 4000), String(engine.heldWorkerCount()))
  }

  // ==== the sign-in window ====
  console.log('[sec2] M5')
  // The window needs a click or a key just before; wait for the last ones of the other tests to be old enough to prove it.
  await waitFor(() => Date.now() - startedAt > GESTURE_WINDOW_MS + 1500, GESTURE_WINDOW_MS + 3000)
  const redirectUri = `https://${driver.id}.chromiumapp.org/cb`
  const authUrl = (path: string, state: string) => `${base}${path}?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  const authWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle().startsWith('Connexion'))
  const idle = await call(driver.id, 'identity.launchWebAuthFlow', { url: authUrl('/fake-auth', 'idle'), interactive: true })
  check('sec2 M5: a sign-in window is not opened for an extension when the user has done nothing just before', !idle.ok && idle.error === AUTH_ERRORS.interactionRequired && authWindows().length === 0, JSON.stringify(idle))
  const press = (): void => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
  press()
  await sleep(100)
  const signed = await call(driver.id, 'identity.launchWebAuthFlow', { url: authUrl('/fake-auth', 's1'), interactive: true })
  check('sec2 M5: just after a key press, the flow runs and ends on the redirect', signed.ok && signed.value === `${redirectUri}?code=sec2&state=s1`, JSON.stringify(signed))
  press()
  await sleep(100)
  const firstFlow = call(driver.id, 'identity.launchWebAuthFlow', { url: authUrl('/hang', 'h1'), interactive: true })
  await waitFor(() => authWindows().length === 1, 8000)
  const authWin = authWindows()[0]
  // The witnesses: the page's own title reaching its web contents, and the file it asks for 400 ms after loading reaching the decision of
  // the session (a listener added after the engine's reads its verdict).
  const authSession = authWin && !authWin.isDestroyed() ? authWin.webContents.session : undefined
  let authDownload: boolean | undefined
  const onAuthDownload = (event: Electron.Event, item: Electron.DownloadItem): void => {
    if (item.getURL().endsWith('/dl-auth')) authDownload = event.defaultPrevented
  }
  authSession?.on('will-download', onAuthDownload)
  await waitFor(() => !!authWin && !authWin.isDestroyed() && authWin.webContents.getTitle() === 'accounts.google.com - sign in' && authDownload !== undefined)
  authSession?.off('will-download', onAuthDownload)
  check('sec2 M5: the window says where it is in words of its own, whatever the page writes in its title', authWin?.getTitle() === `Connexion — ${new URL(base).host}`, authWin?.getTitle())
  const secondFlow = await call(driver.id, 'identity.launchWebAuthFlow', { url: authUrl('/fake-auth', 'h2'), interactive: true })
  check('sec2 M5: a second flow of the same extension is refused while one is open', !secondFlow.ok && secondFlow.error === AUTH_ERRORS.alreadyRunning && authWindows().length === 1, JSON.stringify(secondFlow))
  check('sec2 M5: the page of the window downloads nothing (it asked for a file 400 ms after loading)', authDownload === true && !downloadsSeen.some((u) => u.endsWith('/dl-auth')), `refused=${String(authDownload)} ${downloadsSeen.join(',')}`)
  const permission = await Promise.race([authWin?.webContents.executeJavaScript('Notification.requestPermission()'), sleep(3000).then(() => 'still asking')])
  check('sec2 M5: nor can it ask for a permission: the answer is no, with no prompt', permission === 'denied', String(permission))
  authWin?.close()
  const ended = await firstFlow
  check('sec2 M5: closing the window ends the flow as a refusal', !ended.ok && ended.error === AUTH_ERRORS.userRejected, JSON.stringify(ended))
  check('sec2 M5: no window is left', await waitFor(() => authWindows().length === 0, 3000))

  // ---- tidy up: the tabs the probes opened too (an extension page or a file left open is something the checks after this one look for) ----
  for (const id of opened) browser.dispatch({ type: 'tab/close', id })
  for (const tab of store.get().tabs) if (!tabsAtStart.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
  await profileSession.cookies.remove(`${base}/`, 'sec2-session')
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: sleepAfter } })
  browser.dispatch({ type: 'space/select', id: home })
  if (other) browser.dispatch({ type: 'space/delete', id: other.id })
  server.close()
  server.closeAllConnections()
  httpsServer?.close()
  httpsServer?.closeAllConnections()
}

/** `LUCIUM_SMOKE_ONLY=sec2` with the three probes in `LUCIUM_EXTENSIONS`: only these checks (the quick loop while working on them). */
export async function runSec2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSec2(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeSec2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SEC2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
