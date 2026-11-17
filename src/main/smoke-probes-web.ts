// Engine checks that answer three open questions about pages, run inside a real Electron. A local server with two sites (`localhost` and
// `127.0.0.1`, the same port) and a throw-away folder of files are the only outside world.
//  - A page of a local file (the fuse grantFileProtocolExtraPrivileges gives every file: document universal access, engine/local-file-guard.ts):
//    does it read the answer of a web site (fetch, XMLHttpRequest, a frame), or another file of the disk? Chrome refuses each of these reads. And the
//    other way round: can a web page send its tab, or a frame, to a local file? And a shared worker such a page starts: in which origin does it run,
//    and does its request to a web site leave?
//  - Notifications: after « Autoriser » without « Se souvenir », does the page read "granted" (Notification.permission, permissions.query, a
//    notification it makes)? The answer given to one site must give nothing to another.
//  - window.open from a frame of another site, after a real click on a button of that frame (a payment or sign-in button): does the window open,
//    and what does the frame get back? With no click nothing may open.
//  - The fingerprint protection inside a page: do the frames of the page (of the same site, of another one, `about:blank`, `srcdoc`), its workers
//    (from a file, from a blob, started by a worker, started by a frame of another site) and its service worker read what the page reads, from
//    their first line? Each one is compared with what it reads while the protection is off.
// Each check says in its detail what was seen, passed or not; the report printed at the end (LUCIUM_SMOKE_PROBES_WEB) keeps every detail.
// `LUCIUM_SMOKE_ONLY=probes-web` runs this file alone.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, webContents as allWebContents, type WebContents, type WebFrameMain } from 'electron'
import type { SmokeContext } from './smoke'
import { closeLeftoverPanels, noteCheck, recorderOf, sleep, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import { fetchScript, frameScript, readVerdict, settled, sharedWorkerScript, sharedWorkerVerdict, xhrScript } from './smoke-probe-kit'

const waitFor = waiterOf(8000, 60)

/** What a web site keeps to itself, and what a file of the disk holds: a page that shows either text read what it must not. */
const SITE_SECRET = 'CROSS-ORIGIN-SECRET'
const FILE_SECRET = 'LOCAL-FILE-SECRET'

const DOT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** Where the two frames and their button are in the page that holds them (CSS pixels of the tab): the clicks are real, made at these places. */
const FRAME = { left: 0, width: 400, height: 120, crossTop: 0, sameTop: 140 }
const BUTTON = { left: 10, top: 10, width: 200, height: 40 }

/** What the page reads of its notification permission: `<Notification.permission>/<permissions.query state>`. */
const NOTIFICATION_STATE = `navigator.permissions.query({ name: 'notifications' }).then((status) => status.state, (e) => 'error ' + (e && e.name)).then((state) => Notification.permission + '/' + state)`

/** A notification the page makes, closed as soon as it shows: `shown`, `error event` (what a page without the permission gets), or what else happened. */
const MAKE_NOTIFICATION = `new Promise((done) => { try { const n = new Notification('Lucium engine test', { body: 'A check of the engine tests: it closes at once.', silent: true }); n.onshow = () => { n.close(); done('shown') }; n.onerror = () => done('error event'); setTimeout(() => { n.close(); done('neither shown nor refused after 3 s') }, 3000) } catch (e) { done('threw ' + (e && e.name)) } })`

/**
 * What a script reads of the machine, in a window or in a worker: the cores, the memory, a hash of the pixels of a small drawing, and whether a
 * shared worker can be made. One expression, so that a frame or a worker evaluates it as its very first line.
 */
const FP_READ = `(() => { const out = { cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory === undefined ? null : navigator.deviceMemory, shared: typeof SharedWorker, canvas: null }; try { const c = typeof document === 'undefined' ? new OffscreenCanvas(64, 32) : Object.assign(document.createElement('canvas'), { width: 64, height: 32 }); const g = c.getContext('2d'); g.fillStyle = '#f60'; g.fillRect(0, 0, 64, 32); g.fillStyle = '#036'; g.fillRect(7, 5, 30, 11); const d = g.getImageData(0, 0, 64, 32).data; let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619) >>> 0; out.canvas = h } catch (e) { out.canvas = 'error ' + (e && e.name) } return out })()`

/** One reading of `FP_READ`, or the sentence that says why there is none. */
interface FpRead {
  cores: number
  memory: number | null
  shared: string
  canvas: number | string | null
}
const isFpRead = (value: unknown): value is FpRead => typeof value === 'object' && value !== null && typeof (value as FpRead).cores === 'number'

/** The places of a page the protection must reach, in the order they are reported. */
const FP_PLACES = ['blank', 'srcdoc', 'same', 'cross', 'worker', 'blobWorker', 'nested', 'crossWorker', 'service'] as const
const FP_NAMES: Record<(typeof FP_PLACES)[number], string> = {
  blank: 'an about:blank frame, read in the task that made it',
  srcdoc: 'a srcdoc frame',
  same: 'a frame of the same site',
  cross: 'a frame of another site',
  worker: 'a worker',
  blobWorker: 'a worker made from a blob',
  nested: 'a worker started by a worker',
  crossWorker: 'a worker started by a frame of another site',
  service: 'a service worker'
}

/**
 * The script of the page that holds them all: it makes each frame and each worker, collects what each read at its first line, and keeps the lot
 * in `window.__fp` (a promise). A place that does not answer in time is a sentence, never a wait without end. `n` gives the service worker a
 * scope of its own, so that it starts for this page and not earlier; it is unregistered once it has answered.
 */
const fpHostScript = (other: string, n: string): string => `
  window.__fp = (async () => {
    const out = { page: ${FP_READ} }
    const within = (ms, what, promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done('no answer from ' + what + ' after ' + ms + ' ms'), ms))])
    const said = (tag) => new Promise((done) => addEventListener('message', function heard(e) { if (e.data && e.data.tag === tag) { removeEventListener('message', heard); done(e.data.read) } }))
    const frame = (set) => { const f = document.createElement('iframe'); set(f); document.body.append(f); return f }
    try {
      const blank = frame(() => {})
      out.blank = blank.contentWindow.eval(${JSON.stringify(FP_READ)})
      // The way around a protection that only patches the page: the getter of a fresh frame, called on the navigator of the page.
      out.borrowed = Object.getOwnPropertyDescriptor(blank.contentWindow.Navigator.prototype, 'hardwareConcurrency').get.call(navigator)
    } catch (e) { out.blank = 'threw ' + (e && e.message) }
    const srcdoc = said('srcdoc'); frame((f) => { f.srcdoc = '<script>parent.postMessage({ tag: "srcdoc", read: ' + ${JSON.stringify(FP_READ)} + ' }, "*")</' + 'script>' })
    out.srcdoc = await within(6000, 'the srcdoc frame', srcdoc)
    const same = said('same'); frame((f) => { f.src = '/fp-frame?tag=same' })
    out.same = await within(6000, 'the frame of the same site', same)
    const cross = said('cross'); const crossWorker = said('cross-worker'); frame((f) => { f.src = ${JSON.stringify(other)} + '/fp-frame?tag=cross' })
    out.cross = await within(6000, 'the frame of another site', cross)
    out.crossWorker = await within(6000, 'the worker of the frame of another site', crossWorker)
    const worker = (url) => new Promise((done) => { try { const w = new Worker(url); w.onmessage = (e) => done(e.data); w.onerror = (e) => done('worker error: ' + e.message) } catch (e) { done('threw ' + (e && e.message)) } })
    out.worker = await within(6000, 'the worker', worker('/fp-worker.js'))
    out.blobWorker = await within(6000, 'the blob worker', worker(URL.createObjectURL(new Blob(['postMessage(' + ${JSON.stringify(FP_READ)} + ')'], { type: 'text/javascript' }))))
    out.nested = await within(6000, 'the nested worker', worker('/fp-nesting.js'))
    out.service = await within(10000, 'the service worker', (async () => {
      const registration = await navigator.serviceWorker.register('/fp-sw/${n}/sw.js')
      const sw = registration.installing || registration.waiting || registration.active
      const answer = new Promise((done) => navigator.serviceWorker.addEventListener('message', (e) => done(e.data), { once: true }))
      sw.postMessage('read')
      const read = await answer
      await registration.unregister()
      return read
    })().catch((e) => 'threw ' + (e && e.message)))
    return out
  })()`

export async function smokeProbesWeb(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { browser, store, engine, win, little } = ctx
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const host = req.headers.host ?? ''
    hits.push(path)
    res.setHeader('cache-control', 'no-store')
    const html = (body: string): void => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    // The other site of the pair: a page of one holds a frame of the other.
    const portOf = host.split(':')[1] ?? ''
    const other = host.startsWith('localhost') ? `http://127.0.0.1:${portOf}` : `http://localhost:${portOf}`
    // No Access-Control-Allow-Origin anywhere: no other origin is given these answers.
    if (path === '/secret' || path === '/shared-secret') {
      res.setHeader('content-type', 'text/plain')
      return void res.end(SITE_SECRET)
    }
    if (path === '/framed') return html(`<title>framed</title><body>${SITE_SECRET}</body>`)
    if (path === '/pixel.gif') {
      res.setHeader('content-type', 'image/gif')
      return void res.end(PIXEL_GIF)
    }
    if (path === '/host') {
      const frame = (id: string, src: string, top: number): string => `<iframe id="${id}" src="${src}" style="position:absolute;left:${FRAME.left}px;top:${top}px;width:${FRAME.width}px;height:${FRAME.height}px;border:0"></iframe>`
      return html(`<title>frame host</title><body style="margin:0">${frame('cross', `${other}/inner`, FRAME.crossTop)}${frame('same', '/inner', FRAME.sameTop)}</body>`)
    }
    if (path === '/inner') {
      return html(`<title>inner</title><body style="margin:0">
        <button id="open" style="position:absolute;left:${BUTTON.left}px;top:${BUTTON.top}px;width:${BUTTON.width}px;height:${BUTTON.height}px" onclick="window.__clicks++; const w = window.open('/popup-target', '_blank', 'width=420,height=360'); window.__type = w === null ? 'null' : typeof w">open</button>
        <script>window.__clicks = 0; window.__type = 'window.open was not called'</script></body>`)
    }
    const script = (body: string): void => {
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.end(body)
    }
    if (path === '/fp-host') return html(`<title>fp host</title><body><script>${fpHostScript(other, url.searchParams.get('n') ?? '0')}</script></body>`)
    // A frame says what it read at its first line, then what a worker it starts read at its own.
    if (path === '/fp-frame') {
      const tag = url.searchParams.get('tag') === 'cross' ? 'cross' : 'same'
      return html(`<title>fp frame</title><body><script>parent.postMessage({ tag: '${tag}', read: ${FP_READ} }, '*'); const w = new Worker('/fp-worker.js'); w.onmessage = (e) => parent.postMessage({ tag: '${tag}-worker', read: e.data }, '*'); w.onerror = (e) => parent.postMessage({ tag: '${tag}-worker', read: 'worker error: ' + e.message }, '*')</script></body>`)
    }
    if (path === '/fp-worker.js') return script(`postMessage(${FP_READ})`)
    if (path === '/fp-nesting.js') return script(`const w = new Worker('/fp-worker.js'); w.onmessage = (e) => postMessage(e.data); w.onerror = (e) => postMessage('worker error: ' + e.message)`)
    if (/^\/fp-sw\/\d+\/sw\.js$/.test(path)) return script(`const first = ${FP_READ}; self.addEventListener('message', (e) => e.source.postMessage(first))`)
    if (path === '/popup-target') return html('<title>popup target</title><body>popup<script>window.__hasOpener = window.opener !== null</script></body>')
    return html(`<title>web ${path}</title><body>web ${path}</body>`)
  })
  // Dual-stack: both `localhost` and `127.0.0.1` reach it.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const A = `http://localhost:${port}`
  const B = `http://127.0.0.1:${port}`
  const count = (path: string): number => hits.filter((hit) => hit === path).length

  const dir = mkdtempSync(join(tmpdir(), 'lucium-probes-'))
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const known = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
  const popupWindows = (): BrowserWindow[] => BrowserWindow.getAllWindows().filter((w) => !known.has(w.id) && !w.isDestroyed())
  const closePopups = async (): Promise<void> => {
    for (const popup of popupWindows()) popup.destroy()
    await waitFor(() => popupWindows().length === 0 && engine.pagePopupCount() === 0)
  }
  const before = store.get().settings
  const prior = { sleepAfterMinutes: before.sleepAfterMinutes, reduceFingerprint: before.reduceFingerprint, fingerprintStrict: before.fingerprintStrict, fingerprintExceptions: before.fingerprintExceptions }

  const wcOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const titleOf = (tabId: string): string => store.get().tabs.find((t) => t.id === tabId)?.title ?? ''
  /** Opens a tab (it is then the one on screen) and waits for the title of its page. */
  const openTab = async (url: string, title: string): Promise<{ id: string; wc: WebContents | undefined; loaded: boolean }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = store.get().tabs.at(-1)!
    const loaded = (await waitFor(() => wcOf(tab.id) !== undefined)) && (await waitFor(() => titleOf(tab.id) === title))
    await sleep(300)
    return { id: tab.id, wc: wcOf(tab.id), loaded }
  }
  /** A script in a page or in a frame; a script that fails or says nothing ends as a sentence in the detail of the check. */
  const evaluate = (target: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }, script: string, gesture = false, ms = 8000): Promise<unknown> =>
    settled(target.executeJavaScript(script, gesture), (why) => `the script of the page: ${why}`, ms)
  /**
   * A click at a place of the tab, sent the way a click of the mouse arrives: through the input router of the browser, which finds the frame under
   * the pointer and hands the event to the process that draws it (the DevTools protocol does that). `sendInputEvent`, which the other suites click
   * with, hands the event to the process of the page whatever frame is under it: a frame of another site would never get the click, and the page
   * would be noted a click it did not get. Answers 'sent', or why the click could not be sent.
   */
  const clickAt = async (wc: WebContents, x: number, y: number): Promise<string> => {
    const own = !wc.debugger.isAttached()
    let outcome = 'sent'
    try {
      if (own) wc.debugger.attach('1.3')
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
        const params = { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }
        const sent = await settled(wc.debugger.sendCommand('Input.dispatchMouseEvent', params).then(() => 'sent'), (why) => `Input.dispatchMouseEvent ${type}: ${why}`, 4000)
        if (sent !== 'sent') outcome = sent
      }
    } catch (error) {
      outcome = `the click could not be sent: ${String((error as Error)?.message ?? error)}`
    } finally {
      if (own && wc.debugger.isAttached()) wc.debugger.detach()
    }
    await sleep(350)
    return outcome
  }
  const fileUrl = (...parts: string[]): string => pathToFileURL(join(dir, ...parts)).href

  win.showInactive()
  const leftover = closeLeftoverPanels(browser)
  if (leftover.length > 0) console.warn(`[probes-web] closed what an earlier suite left over the window: ${leftover.join(', ')}`)
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  try {
    // ================= a page of a local file =================
    try {
      mkdirSync(join(dir, 'page'))
      mkdirSync(join(dir, 'elsewhere'))
      writeFileSync(join(dir, 'page', 'dot.png'), DOT_PNG)
      writeFileSync(join(dir, 'page', 'secret.txt'), FILE_SECRET)
      writeFileSync(join(dir, 'page', 'next.html'), '<title>local next</title><body>next</body>')
      writeFileSync(join(dir, 'page', 'local.html'), `<title>local page</title><body><img id="beside" src="dot.png"><img id="remote" src="${B}/pixel.gif"><a id="next" href="next.html">next</a></body>`)
      writeFileSync(join(dir, 'elsewhere', 'secret.txt'), FILE_SECRET)
      writeFileSync(join(dir, 'elsewhere', 'secret.html'), `<title>elsewhere</title><body>${FILE_SECRET}</body>`)
      writeFileSync(join(dir, 'target.html'), `<title>local target</title><body>${FILE_SECRET}</body>`)

      const local = await openTab(fileUrl('page', 'local.html'), 'local page')
      check('local page: a page of a local file loads in a tab', local.loaded && local.wc !== undefined, `title "${titleOf(local.id)}"`)
      if (local.wc) {
        const page = local.wc
        const imageWidth = (id: string): string => `new Promise((done) => { const image = document.getElementById(${JSON.stringify(id)}); const say = () => done(image.naturalWidth); if (image.complete) say(); else { image.onload = say; image.onerror = () => done(0); setTimeout(() => done(-1), 3000) } })`
        const beside = await evaluate(page, imageWidth('beside'))
        const remote = await evaluate(page, imageWidth('remote'))
        check('local page (control): it shows the image that lies beside it', beside === 1, `natural width ${String(beside)}`)
        check('local page (control): it shows an image of a web site, as a saved page does', remote === 1 && count('/pixel.gif') > 0, `natural width ${String(remote)}, the server saw the image ${count('/pixel.gif')} time(s)`)

        // What Chrome refuses a local page: the answer of another origin.
        const judge = (name: string, answer: unknown, secret: string, serverHits: number | null = null): void => {
          const verdict = readVerdict(answer, secret, serverHits)
          check(name, verdict.kept, verdict.detail)
        }
        judge('local page: fetch does not hand it the answer of a web site', await evaluate(page, fetchScript(`${B}/secret`)), SITE_SECRET, count('/secret'))
        const secretHits = count('/secret')
        judge('local page: nor does XMLHttpRequest', await evaluate(page, xhrScript(`${B}/secret`)), SITE_SECRET, count('/secret') - secretHits)
        // The same read in each way a page may say it asks, with what identifies the user: with universal access the mode the page names
        // changes nothing to what Chromium hands back, so none of them may be what lets the answer through (an answer without its text is kept).
        for (const mode of ['cors', 'same-origin', 'no-cors'] as const) {
          const before = count('/secret')
          const answer = await evaluate(page, fetchScript(`${B}/secret`, { mode, credentials: 'include' }))
          judge(`local page: nor does a fetch that says "${mode}" and sends the cookies`, answer, SITE_SECRET, count('/secret') - before)
        }
        judge('local page: nor can it read the document of a web site it puts in a frame', await evaluate(page, frameScript(`${B}/framed`)), SITE_SECRET, count('/framed'))
        // ...and the other files of the disk.
        judge('local page: fetch does not hand it another file of its own folder', await evaluate(page, fetchScript('secret.txt')), FILE_SECRET)
        judge('local page: nor a file of another folder', await evaluate(page, fetchScript(fileUrl('elsewhere', 'secret.txt'))), FILE_SECRET)
        judge('local page: nor does XMLHttpRequest hand it a file of another folder', await evaluate(page, xhrScript(fileUrl('elsewhere', 'secret.txt'))), FILE_SECRET)
        judge('local page: nor can it read another file it puts in a frame', await evaluate(page, frameScript(fileUrl('elsewhere', 'secret.html'))), FILE_SECRET)
        // What must keep working: a link from a local page to the file beside it.
        await evaluate(page, `document.getElementById('next').click(); 0`, true)
        const followed = await waitFor(() => titleOf(local.id) === 'local next', 5000)
        check('local page (control): a link to the file beside it is followed, as in any browser', followed, `the tab shows "${titleOf(local.id)}" at ${page.isDestroyed() ? 'a page that is gone' : page.getURL()}`)
      }

      // ---- a shared worker of a local page ----
      // It belongs to no tab and to no frame: its request to the web carries only the origin that issued it, which the guard takes to be the one
      // of the file and stops before it leaves (`localPageRead`, local-file-guard.ts). That origin came from the documentation alone; it is
      // measured here, with what the request does. Below the strict fingerprint protection, which takes the shared worker away from a page.
      browser.dispatch({ type: 'settings/update', patch: { reduceFingerprint: false, fingerprintStrict: false } })
      writeFileSync(join(dir, 'page', 'shared.html'), '<title>local shared</title><body>shared</body>')
      const sharing = await openTab(fileUrl('page', 'shared.html'), 'local shared')
      check('local page: the page that starts a shared worker loads', sharing.loaded && sharing.wc !== undefined, `title "${titleOf(sharing.id)}"`)
      if (sharing.wc) {
        const asked = count('/shared-secret')
        const answer = await evaluate(sharing.wc, sharedWorkerScript(`${B}/shared-secret`))
        const seen = sharedWorkerVerdict(answer, SITE_SECRET, count('/shared-secret') - asked)
        check('local page: a shared worker it starts runs in the origin of the file (file://), the one the guard knows its requests by', seen.ran && seen.origin === 'file://', `origin ${seen.origin}; ${seen.kept.detail}`)
        check('local page: ...and the request that shared worker makes to a web site does not leave, and reads nothing', seen.kept.ok, seen.kept.detail)
      }

      // The other way round: a page of the web and the files of the disk.
      const web = await openTab(`${B}/web`, 'web /web')
      check('web page: the page of the check loads', web.loaded && web.wc !== undefined, `title "${titleOf(web.id)}"`)
      if (web.wc) {
        const page = web.wc
        const target = fileUrl('target.html')
        /**
         * The witness: after the navigation that must not happen, the page asks for one to a web address of its own, which is stopped here before
         * it loads anything. A page's navigations reach the browser in the order it asks for them: once the witness is there, the one before it has
         * arrived too, or was stopped inside the page. Answers whether the witness came, and what arrived before it that nothing refused.
         */
        const askThenWitness = async (script: string): Promise<{ arrived: boolean; through: string[] }> => {
          const witness = `${B}/stay-witness`
          const through: string[] = []
          let arrived = false
          const listener = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
            if (arrived || !event.isMainFrame) return
            if (event.url === witness) {
              arrived = true
              event.preventDefault()
            } else if (!event.defaultPrevented) through.push(event.url)
          }
          page.on('will-frame-navigate', listener)
          try {
            await evaluate(page, script, true)
            await evaluate(page, `location.href = ${JSON.stringify(witness)}; 0`, true)
            await waitFor(() => arrived)
          } finally {
            page.off('will-frame-navigate', listener)
          }
          return { arrived, through }
        }
        const stayed = (sent: { arrived: boolean; through: string[] }): { ok: boolean; detail: string } => {
          const at = page.isDestroyed() ? 'a page that is gone' : page.getURL()
          return { ok: sent.arrived && sent.through.length === 0 && at.startsWith(B) && titleOf(web.id) !== 'local target', detail: `the tab is at ${at} with the title "${titleOf(web.id)}"; the witness came: ${sent.arrived}; let through before it: ${JSON.stringify(sent.through)}` }
        }
        const byScript = stayed(await askThenWitness(`location.href = ${JSON.stringify(target)}; 0`))
        check('web page: a script cannot send its tab to a local file (location.href)', byScript.ok, byScript.detail)
        const byLink = stayed(await askThenWitness(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(target)}; a.textContent = 'file'; document.body.append(a); a.click(); return 0 })()`))
        check('web page: nor can a link of the page (a click on <a href="file:…">)', byLink.ok, byLink.detail)
        if (byScript.ok && byLink.ok) {
          const readByPage = readVerdict(await evaluate(page, frameScript(target)), FILE_SECRET)
          // What the frame really holds is read from the main process too: a page that cannot read its frame may still be showing the file in it.
          const shown: string[] = []
          for (const frame of page.mainFrame.frames) shown.push(String(await evaluate(frame, `document.body ? document.body.textContent : ''`, false, 3000)).slice(0, 80))
          const showsFile = shown.some((text) => text.includes(FILE_SECRET))
          check('web page: a frame of it does not load a local file', readByPage.kept && !showsFile, `${readByPage.detail}; the frames of the page hold ${JSON.stringify(shown)}`)
        } else {
          check('web page: a frame of it does not load a local file', false, 'not measured: the tab had already left the web page for the local file')
        }
      }
    } catch (error) {
      check('local page: the checks ran to the end', false, String((error as Error)?.stack ?? error))
    }

    // ================= what a page reads of a permission it was just given =================
    try {
      /** Asks for the notifications in `page` and answers the question of the tab; `remember` is the box « Se souvenir pour ce site ». */
      const askAndAllow = async (page: WebContents, origin: string, remember: boolean): Promise<{ shown: boolean; answer: unknown }> => {
        const asking = evaluate(page, 'Notification.requestPermission()', true, 12_000)
        const question = (): { id: string } | null => {
          const overlay = browser.currentOverlay()
          return overlay?.panel === 'permission' && overlay.request.origin === origin && overlay.request.permission === 'notifications' ? overlay.request : null
        }
        const shown = await waitFor(() => question() !== null, 6000)
        const asked = question()
        if (asked) browser.answerPermission(asked.id, true, remember)
        return { shown, answer: await asking }
      }
      const once = await openTab(`${B}/notify`, 'web /notify')
      const kept = await openTab(`${A}/notify`, 'web /notify')
      check('notifications: the two pages of the check load', once.loaded && kept.loaded && once.wc !== undefined && kept.wc !== undefined, `titles "${titleOf(once.id)}" and "${titleOf(kept.id)}"`)
      if (once.wc && kept.wc) {
        browser.dispatch({ type: 'tab/select', id: once.id })
        await sleep(400)
        const fresh = await evaluate(once.wc, NOTIFICATION_STATE)
        check('notifications: a site that was never asked reads "default" (Notification.permission) and "prompt" (permissions.query)', fresh === 'default/prompt', `the page read "${String(fresh)}"`)
        const allowed = await askAndAllow(once.wc, B, false)
        check('notifications: the request shows the question of the tab, and « Autoriser » without « Se souvenir » answers "granted" to it', allowed.shown && allowed.answer === 'granted', `question shown: ${allowed.shown}, Notification.requestPermission() gave "${String(allowed.answer)}", panel now: ${browser.currentPanel()}`)
        const after = String(await evaluate(once.wc, NOTIFICATION_STATE))
        const [permission, queried] = after.split('/')
        const context = `the page read "${after}" after a request answered "${String(allowed.answer)}"; kept for the site: ${JSON.stringify(store.get().sitePermissions[B] ?? null)}`
        check('notifications: after « Autoriser » without « Se souvenir », the page reads Notification.permission as "granted"', permission === 'granted', context)
        check('notifications: ...and permissions.query answers "granted"', queried === 'granted', context)
        const made = await evaluate(once.wc, MAKE_NOTIFICATION, true)
        check('notifications: ...and a notification the page makes is not refused', made !== 'error event' && !String(made).startsWith('threw') && !String(made).startsWith('the script'), `new Notification(): ${String(made)}`)
        check('notifications: an answer without « Se souvenir » is not kept in the state', store.get().sitePermissions[B]?.['notifications'] === undefined, JSON.stringify(store.get().sitePermissions[B] ?? null))

        browser.dispatch({ type: 'tab/select', id: kept.id })
        await sleep(400)
        const elsewhere = await evaluate(kept.wc, NOTIFICATION_STATE)
        check('notifications: the answer given to one site gives nothing to another', elsewhere === 'default/prompt', `the page of the other site read "${String(elsewhere)}"`)
        // The control: with the box ticked the answer is kept, and the page reads it. If this one fails too, the checks above say nothing about the box.
        const remembered = await askAndAllow(kept.wc, A, true)
        const afterKept = await evaluate(kept.wc, NOTIFICATION_STATE)
        check('notifications (control): with « Se souvenir », the page reads "granted" both ways', remembered.shown && remembered.answer === 'granted' && afterKept === 'granted/granted', `question shown: ${remembered.shown}, the request gave "${String(remembered.answer)}", the page read "${String(afterKept)}"`)
      }
    } catch (error) {
      check('notifications: the checks ran to the end', false, String((error as Error)?.stack ?? error))
    }

    // ================= window.open from a frame of another site =================
    try {
      const holder = await openTab(`${A}/host`, 'frame host')
      check('frame popup: the page that holds the frames loads', holder.loaded && holder.wc !== undefined, `title "${titleOf(holder.id)}"`)
      if (holder.wc) {
        const page = holder.wc
        const frameOf = (origin: string): WebFrameMain | undefined => page.mainFrame.frames.find((frame) => frame.url.startsWith(`${origin}/inner`))
        await waitFor(async () => frameOf(A) !== undefined && frameOf(B) !== undefined && (await evaluate(frameOf(B)!, 'typeof window.__clicks', false, 2000)) === 'number' && (await evaluate(frameOf(A)!, 'typeof window.__clicks', false, 2000)) === 'number')
        const cross = frameOf(B)
        const same = frameOf(A)
        // The question is about a frame Chromium draws in another process than the page: a frame of the same process would prove nothing.
        check(
          'frame popup (control): the frame of the other site is drawn by a process of its own, the frame of the same site by the process of the page',
          cross !== undefined && same !== undefined && cross.processId !== page.mainFrame.processId && same.processId === page.mainFrame.processId,
          `page ${page.mainFrame.processId}, frame of the other site ${cross?.processId ?? 'missing'}, frame of the same site ${same?.processId ?? 'missing'}`
        )
        if (cross && same) {
          const tabsBefore = store.get().tabs.length
          const minisBefore = little.count()
          const around = (): string => `${popupWindows().length} window(s), ${store.get().tabs.length - tabsBefore} tab(s) more, ${little.count() - minisBefore} mini window(s) more, notice: ${JSON.stringify(browser.snapshot().toast?.message ?? null)}`

          // No click: nothing may open, whatever the frame.
          // No wait: window.open waits for the browser's decision, which opens the tab or the window it allows before the frame gets its answer.
          const scripted = await evaluate(cross, `(() => { const w = window.open('/popup-target', '_blank', 'width=420,height=360'); return w === null ? 'null' : typeof w })()`)
          check('frame popup: window.open from the frame of another site with no click opens nothing and answers null', scripted === 'null' && popupWindows().length === 0 && store.get().tabs.length === tabsBefore, `window.open answered "${String(scripted)}"; ${around()}`)
          await closePopups()

          // A click on the button of the frame of the other site. Nothing was clicked in this tab before: no earlier click can explain the window.
          await sleep(700)
          const sent = await clickAt(page, FRAME.left + BUTTON.left + BUTTON.width / 2, FRAME.crossTop + BUTTON.top + BUTTON.height / 2)
          const opened = await waitFor(() => popupWindows().length === 1 && !popupWindows()[0]!.webContents.isLoading() && popupWindows()[0]!.webContents.getURL().startsWith('http'), 5000)
          const clicks = await evaluate(cross, 'window.__clicks')
          const type = await evaluate(cross, 'window.__type')
          const reached = clicks === 1
          check('frame popup (control): the click reaches the button of the frame of the other site', reached, `click ${sent}; the button counted ${String(clicks)} click(s)`)
          // A click that did not reach the button says nothing of what a click does: the three checks below are then red for that reason, said in their detail.
          const unreached = 'not measured: the click did not reach the button of the frame, so window.open was never called by a click'
          check('frame popup: a click on a button in a frame of another site opens the window the frame asks for', reached && opened, reached ? `window.open answered "${String(type)}" to the frame; ${around()}` : unreached)
          check('frame popup: ...and the frame gets the window back, not null', reached && type === 'object', reached ? `window.open answered "${String(type)}" to the frame` : unreached)
          const popup = popupWindows()[0]
          const hasOpener = popup ? await evaluate(popup.webContents, 'window.__hasOpener') : 'no window opened'
          check('frame popup: ...and the window sees the frame that opened it (window.opener)', reached && hasOpener === true, reached ? `window.opener !== null: ${String(hasOpener)}, the window is at ${popup ? popup.webContents.getURL() : 'nowhere'}` : unreached)
          await closePopups()

          // The control: the same button in a frame of the same site as the page. If it fails too, the frame of another site is not what is refused.
          browser.dispatch({ type: 'tab/select', id: holder.id })
          await sleep(400)
          const sentSame = await clickAt(page, FRAME.left + BUTTON.left + BUTTON.width / 2, FRAME.sameTop + BUTTON.top + BUTTON.height / 2)
          const openedSame = await waitFor(() => popupWindows().length === 1, 5000)
          const sameType = await evaluate(same, 'window.__type')
          check('frame popup (control): the same click in a frame of the same site opens the window', openedSame && sameType === 'object', `click ${sentSame}; the button counted ${String(await evaluate(same, 'window.__clicks'))} click(s), window.open answered "${String(sameType)}"; ${around()}`)
          await closePopups()
        }
      }
    } catch (error) {
      check('frame popup: the checks ran to the end', false, String((error as Error)?.stack ?? error))
    }

    // ================= the fingerprint protection inside a page: its frames, its workers, its service worker =================
    try {
      const setFp = (patch: { reduceFingerprint?: boolean; fingerprintStrict?: boolean; fingerprintExceptions?: string[] }): void => browser.dispatch({ type: 'settings/update', patch })
      let load = 0
      /** Opens the page that holds every frame and worker, and answers what each of them read (or why nothing was read). */
      const measure = async (): Promise<{ wc: WebContents | undefined; read: Record<string, unknown> | null; why: string }> => {
        const tab = await openTab(`${A}/fp-host?n=${++load}`, 'fp host')
        if (!tab.loaded || !tab.wc) return { wc: tab.wc, read: null, why: `the page did not load: title "${titleOf(tab.id)}"` }
        const read = await evaluate(tab.wc, 'window.__fp', false, 70_000)
        return typeof read === 'object' && read !== null ? { wc: tab.wc, read: read as Record<string, unknown>, why: '' } : { wc: tab.wc, read: null, why: String(read) }
      }
      const workerGuard = (wc: WebContents | undefined): boolean => wc?.session.getPreloadScripts().some((registered) => registered.id === 'lucium-page-guard-sw' && registered.type === 'service-worker') === true

      setFp({ reduceFingerprint: false, fingerprintStrict: false, fingerprintExceptions: [] })
      const open = await measure()
      const reference = open.read
      const realPage = reference?.['page']
      check('fingerprint inside a page (control): with the protection off, the page, its frames and its workers all answer', reference !== null && isFpRead(realPage) && FP_PLACES.every((place) => isFpRead(reference[place])), reference === null ? open.why : JSON.stringify(reference))
      check('fingerprint inside a page (control): ...no protocol session is attached to the page, and no preload is registered for the service workers', open.wc !== undefined && !open.wc.debugger.isAttached() && !workerGuard(open.wc), `session attached: ${String(open.wc?.debugger.isAttached())}, preload for service workers: ${String(workerGuard(open.wc))}`)

      if (reference !== null && isFpRead(realPage)) {
        const ceiling = Math.min(realPage.cores, 4)
        const tellsByCores = realPage.cores > 4
        setFp({ reduceFingerprint: true, fingerprintStrict: true })
        const guarded = await measure()
        const got = guarded.read
        const page = got?.['page']
        check('fingerprint inside a page (control): with the strict protection on, the page itself reads a noised canvas and at most 4 cores', isFpRead(page) && page.canvas !== realPage.canvas && page.cores === ceiling, got === null ? guarded.why : `the page read ${JSON.stringify(page)}, unprotected ${JSON.stringify(realPage)}`)
        check('fingerprint inside a page: one protocol session of Lucium is on the page, and the service workers of the session load the guard', guarded.wc !== undefined && guarded.wc.debugger.isAttached() && workerGuard(guarded.wc), `session attached: ${String(guarded.wc?.debugger.isAttached())}, preload for service workers: ${String(workerGuard(guarded.wc))}`)
        for (const place of FP_PLACES) {
          const real = reference[place]
          const read = got?.[place]
          // The canvas is what tells on every machine; the cores tell only on a machine that has more than the ceiling.
          const ok = isFpRead(read) && isFpRead(real) && typeof read.canvas === 'number' && read.canvas !== real.canvas && read.cores === Math.min(real.cores, 4)
          check(`fingerprint inside a page: ${FP_NAMES[place]} reads a noised canvas and at most 4 cores, from its first line`, ok, `read ${JSON.stringify(read)}, unprotected ${JSON.stringify(real)}${tellsByCores ? '' : `; this machine has ${realPage.cores} core(s), so only the canvas tells`}`)
        }
        // The guard once, with the seed of the page: a frame given two scripts (the one of the page and a stale one), or only the stale one, reads another noise.
        const pageCanvas = isFpRead(page) ? page.canvas : null
        const otherNoise = FP_PLACES.filter((place) => !isFpRead(got?.[place]) || (got![place] as FpRead).canvas !== pageCanvas)
        check(
          'fingerprint inside a page: every frame and every worker reads the noise the page reads (the guard once, with the seed of the page)',
          pageCanvas !== null && otherNoise.length === 0,
          otherNoise.length === 0 ? `all read ${String(pageCanvas)}` : `another noise in ${otherNoise.map((place) => `${place}: ${JSON.stringify(got?.[place])}`).join('; ')}; the page read ${String(pageCanvas)}`
        )
        check('fingerprint inside a page: the getter of a fresh about:blank frame, called on the navigator of the page, answers the protected figure', got?.['borrowed'] === ceiling, `it answered ${String(got?.['borrowed'])}, the machine has ${realPage.cores}${tellsByCores ? '' : ' (not more than the ceiling: this check cannot tell on this machine)'}`)
        const sharedIn = (read: Record<string, unknown> | null): string[] => ['page', 'blank', 'srcdoc', 'same', 'cross'].map((place) => (isFpRead(read?.[place]) ? (read![place] as FpRead).shared : 'unread'))
        check('fingerprint inside a page: in the strict strength a protected document, and each of its frames, has no shared worker to start (nothing of ours could run in one first)', sharedIn(got).every((kind) => kind === 'undefined') && sharedIn(reference).every((kind) => kind === 'function'), `protected: ${sharedIn(got).join(', ')}; unprotected: ${sharedIn(reference).join(', ')}`)

        // The standard strength leaves the shared worker to the sites that need one (the setting says it is not covered), and still protects the page.
        setFp({ fingerprintStrict: false })
        const standard = await measure()
        const standardPage = standard.read?.['page']
        check('fingerprint inside a page: in the standard strength the page still reads a noised canvas', isFpRead(standardPage) && standardPage.canvas !== realPage.canvas, standard.read === null ? standard.why : `the page read ${JSON.stringify(standardPage)}, unprotected ${JSON.stringify(realPage)}`)
        check('fingerprint inside a page: ...and the document and each of its frames keep the shared worker', sharedIn(standard.read).every((kind) => kind === 'function'), `standard: ${sharedIn(standard.read).join(', ')}`)
        setFp({ fingerprintStrict: true })

        // A site left out is left out whole: the frames of another site it holds follow the page, not their own site.
        setFp({ fingerprintExceptions: ['localhost'] })
        const left = await measure()
        const same = left.read !== null && ['page', ...FP_PLACES].every((place) => isFpRead(left.read![place]) && isFpRead(reference[place]) && (left.read![place] as FpRead).canvas === (reference[place] as FpRead).canvas && (left.read![place] as FpRead).cores === (reference[place] as FpRead).cores)
        check('fingerprint inside a page: on a site left out, the page, its frames and its workers read what they read without the protection', same, left.read === null ? left.why : JSON.stringify(left.read))

        setFp({ reduceFingerprint: false, fingerprintStrict: false, fingerprintExceptions: [] })
        const released = await waitFor(() => [guarded.wc, standard.wc, left.wc].every((wc) => wc === undefined || wc.isDestroyed() || !wc.debugger.isAttached()) && !workerGuard(guarded.wc), 4000)
        check('fingerprint inside a page: with the protection off again, the sessions are given back and the service workers load nothing', released, `sessions attached: ${[guarded.wc, standard.wc, left.wc].map((wc) => String(wc?.debugger.isAttached())).join(', ')}, preload for service workers: ${String(workerGuard(guarded.wc))}`)
      }
    } catch (error) {
      check('fingerprint inside a page: the checks ran to the end', false, String((error as Error)?.stack ?? error))
    }
  } finally {
    for (const popup of popupWindows()) popup.destroy()
    closeLeftoverPanels(browser)
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    for (const origin of [A, B]) browser.dispatch({ type: 'permission/set', origin, permission: 'notifications', decision: null })
    browser.dispatch({ type: 'settings/update', patch: prior })
    rmSync(dir, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=probes-web`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runProbesWebSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeProbesWeb(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeProbesWeb ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PROBES_WEB ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
