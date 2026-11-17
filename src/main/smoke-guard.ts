// Engine checks for the extended rules of the blocker (scriptlets, stand-in resources, $removeparam, $csp) and for the fingerprint protection,
// inside a real Electron: the lists come from a local server (never the Internet), the pages from another, and what the pages measure of
// themselves (a canvas, WebGL, audio, `navigator`, `screen`, WebRTC candidates, the order in which a script runs) is read back from their title.
//
// The point is the rule "a feature that is off costs nothing" as much as the effect when it is on: with both switches off no preload is
// registered on the session, the channel the preload asks on does not exist, no header is touched, and the page measures what Chromium gives it.
// `LUCIUM_SMOKE_ONLY=guard` runs only this file (see index.ts).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { FILTER_LISTS } from '@shared/filter-lists'
import { PAGE_GUARD } from '@shared/page-guard'
import { STAND_IN_SCHEME } from '@shared/redirect-resources'
import { blockingService } from './blocking'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 100)

const GUARD_ID = 'lucium-page-guard'

/** What a page of the fingerprint suite measures of itself (see the script of `/fp`). */
interface Measure {
  canvas: string
  canvasAgain: string
  pixel: number[]
  webgl: string
  renderer: string
  audio: number
  cores: number
  memory: number | null
  screen: number[]
  fonts: number | string
  native: boolean
  ice: string
}

// The rules of the list the suite serves as "easylist". `127.0.0.1` is the site of the pages, `localhost` is a third party to it.
const RULES = [
  // scriptlets (arguments of the library; two are refused on purpose: an unknown name, a constant that is not one)
  '127.0.0.1##+js(set-constant, smokeAds.enabled, false)',
  '127.0.0.1##+js(aopr, smokeDetector)',
  '127.0.0.1##+js(nostif, defuseMe)',
  '127.0.0.1##+js(set-constant, smokeOk, 12345)',
  '127.0.0.1##+js(set-constant, smokeNoRun, 123456)',
  '127.0.0.1##+js(trusted-click-element, button)',
  // stand-in resources: a known one, one the library does not have, a picture
  '/smoke-redir/gpt.js$script,redirect=googletagservices_gpt.js',
  '/smoke-redir/unknown.js$script,redirect=no-such-resource.js',
  '/smoke-redir/pixel.gif$image,redirect=1x1.gif',
  // $removeparam, on a request of the page and on a navigation
  '/smoke-param/$removeparam=fbclid',
  // $csp: one that is accepted, one that would make the browser report to a third party
  "/smoke-csp$csp=script-src 'none'",
  "/smoke-badpolicy$csp=script-src 'none'; report-uri http://localhost:PORT/csp-report"
]


/** A self-signed certificate for 127.0.0.1, made with the system's openssl in a throw-away folder. Null when openssl is not there. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-guard-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch (error) {
    console.warn('[smoke-guard] openssl cannot make a certificate, the https part of the probe is skipped:', error instanceof Error ? error.message : error)
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * What Chromium does with a redirect made by `webRequest` to a custom scheme the session serves itself, tried on sessions of their own (nothing of
 * the application's is touched): the scheme of the stand-ins as the application declares it (`secure`) and a scheme nobody declared, for a script
 * of the same site and of another site and for a picture, on a page of http and on a page of https (a self-signed certificate; the point is the
 * mixed-content rule). Returns what each did, with the errors Chromium reported.
 */
async function probeRedirectTargets(origin: string): Promise<{ summary: Record<string, string>; httpsSecure: string | null }> {
  const summary: Record<string, string> = {}
  let httpsSecure: string | null = null
  const received: string[] = []
  const serve = (scheme: string, marker: string) => (probeSession: Electron.Session) =>
    probeSession.protocol.handle(scheme, (request) => {
      received.push(request.url)
      return request.url.endsWith('.gif')
        ? new Response(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), { headers: { 'content-type': 'image/gif' } })
        : new Response(`window.${marker} = "ok"`, { headers: { 'content-type': 'text/javascript' } })
    })
  const run = async (name: string, pageOrigin: string, setup: (probeSession: Electron.Session) => void, redirects: Record<string, string>, certificate = false): Promise<string> => {
    const errors: string[] = []
    const probeSession = session.fromPartition(`guard-probe-${name}-${Date.now()}`)
    const win = new BrowserWindow({ show: false, webPreferences: { session: probeSession, sandbox: true } })
    try {
      if (certificate) probeSession.setCertificateVerifyProc((_request, callback) => callback(0))
      setup(probeSession)
      probeSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        const target = redirects[new URL(details.url).pathname]
        callback(target ? { redirectURL: target } : { cancel: false })
      })
      probeSession.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => errors.push(`${new URL(details.url).pathname} ${details.error}`))
      await win.loadURL(`${pageOrigin}/probe-page?third=${encodeURIComponent(pageOrigin.replace('127.0.0.1', 'localhost'))}`)
      await sleep(1800)
      return `${String(await win.webContents.executeJavaScript('document.title'))} | errors: ${errors.join(' ; ')}`
    } catch (error) {
      return `probe failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      win.destroy()
    }
  }
  const redirects = (scheme: string): Record<string, string> => ({ '/probe/script.js': `${scheme}://probe/a.js`, '/probe/xscript.js': `${scheme}://probe/b.js`, '/probe/pixel.gif': `${scheme}://probe/p.gif`, '/probe/xpixel.gif': `${scheme}://probe/q.gif` })
  summary['http, scheme declared secure'] = await run('http-secure', origin, serve(STAND_IN_SCHEME, 'pStandIn'), redirects(STAND_IN_SCHEME))
  summary['http, scheme not declared'] = await run('http-plain', origin, serve('lucium-probe', 'pStandIn'), redirects('lucium-probe'))
  const material = selfSignedCertificate()
  if (material) {
    const server = createHttpsServer(material, (req, res) => {
      const url = new URL(req.url ?? '/', 'https://x')
      res.setHeader('content-type', 'text/html')
      res.end(PROBE_PAGE.replaceAll('${third}', url.searchParams.get('third') ?? ''))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const secureOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      summary['https, scheme declared secure'] = await run('https-secure', secureOrigin, serve(STAND_IN_SCHEME, 'pStandIn'), redirects(STAND_IN_SCHEME), true)
      httpsSecure = summary['https, scheme declared secure']!
      summary['https, scheme not declared'] = await run('https-plain', secureOrigin, serve('lucium-probe', 'pStandIn'), redirects('lucium-probe'), true)
    } finally {
      server.close()
      server.closeAllConnections()
    }
  }
  summary['addresses the handler was given'] = received.slice(0, 4).join(' ')
  return { summary, httpsSecure }
}

/** The page of the probe: a script and a picture of its own site, a script and a picture of another site, each reporting how it ended. */
const PROBE_PAGE = `<title>probe-pending</title><body>
  <script src="/probe/script.js" onload="window.r_script='load'" onerror="window.r_script='error'"></script>
  <script src="\${third}/probe/xscript.js" onload="window.r_xscript='load'" onerror="window.r_xscript='error'"></script>
  <img src="/probe/pixel.gif" onload="window.r_pixel='load'" onerror="window.r_pixel='error'">
  <img src="\${third}/probe/xpixel.gif" onload="window.r_xpixel='load'" onerror="window.r_xpixel='error'">
  <script>setTimeout(function () { document.title = JSON.stringify({ script: window.r_script + '/' + window.pStandIn, xscript: window.r_xscript, pixel: window.r_pixel, xpixel: window.r_xpixel }) }, 1000)</script></body>`

export async function smokeGuard({ browser, store }: SmokeContext, check: Check): Promise<void> {
  const service = blockingService()
  const hits = new Map<string, number>()
  const seen: string[] = []
  const hit = (path: string) => hits.set(path, (hits.get(path) ?? 0) + 1)
  const count = (path: string) => hits.get(path) ?? 0
  let page = 0
  let port = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    hit(path)
    if (path.startsWith('/smoke-param/') || path === '/csp-report') seen.push(req.url ?? '')
    if (path.startsWith('/lists/')) {
      const id = path.slice('/lists/'.length).replace(/\.txt$/, '')
      res.writeHead(200, { 'content-type': 'text/plain', etag: `"${id}-1"` })
      return res.end(['[Adblock Plus 2.0]', `! Title: ${id}`, ...(id === 'easylist' ? RULES.map((rule) => rule.replace('PORT', String(port))) : [`/smoke-other/${id}.js`]), ''].join('\n'))
    }
    res.setHeader('cache-control', 'no-store')
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    const n = url.search
    switch (path) {
      case '/scriptlets':
        return html(`<title>sl-pending</title><body><script>
          window.smokeAds = { enabled: true }
          let detector = 'read'
          try { void window.smokeDetector } catch (error) { detector = 'aborted' }
          setTimeout(function () { window.defuseMeRan = true }, 20)
          setTimeout(function () { window.controlRan = true }, 20)
          setTimeout(function () {
            document.title = ['sl', window.smokeAds.enabled, detector, window['defuse' + 'MeRan'] === true ? 'ran' : 'defused', window.controlRan === true ? 'ran' : 'lost', typeof window.smokeNoRun, window.smokeOk].map(String).join(',')
          }, 500)
        </script></body>`)
      case '/redirects':
        return html(`<title>rd-pending</title><body>
          <script src="http://localhost:${port}/smoke-redir/gpt.js${n}" onload="window.r1='load'" onerror="window.r1='error'"></script>
          <script src="http://localhost:${port}/smoke-redir/unknown.js${n}" onload="window.r2='load'" onerror="window.r2='error'"></script>
          <img id="px" src="http://localhost:${port}/smoke-redir/pixel.gif${n}">
          <script>setTimeout(function () {
            document.title = ['rd', window.r1, window.r2, document.getElementById('px').naturalWidth, typeof window.googletag === 'object' && window.googletag.apiReady === true].map(String).join(',')
          }, 1500)</script></body>`)
      case '/params':
        return html(`<title>pa-pending</title><body><script>
          fetch('http://localhost:${port}/smoke-param/echo?fbclid=1&keep=2').then(function () { return 'ok' }, function () { return 'failed' }).then(function (state) { document.title = 'pa,' + state })
        </script></body>`)
      case '/smoke-param/echo':
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
        return void res.end('echo')
      case '/smoke-param/page':
        return html('<title>nav-landed</title><body>landed</body>')
      case '/smoke-csp':
      case '/smoke-badpolicy':
        return html('<title>csp-static</title><body><script>document.title = "csp-ran"</script></body>')
      case '/probe-page':
        return html(PROBE_PAGE.replaceAll('${third}', url.searchParams.get('third') ?? ''))
      case '/fp':
        return html(FINGERPRINT_PAGE)
      case '/hop':
        // A tab that goes to another site by itself: the new document must be given the plan of its own site.
        return html(`<title>hop</title><script>location.replace('http://localhost:${port}/fp${n}')</script>`)
      default:
        return html('<title>other</title><body>other</body>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const third = `http://localhost:${port}`

  const catalog = FILTER_LISTS.map((list) => ({ ...list, url: `${origin}/lists/${list.id}.txt`, minRules: undefined }))
  service.useForTests({ fetch: (url, init) => fetch(url, init), catalog, allowInsecure: true, timeoutMs: 4000 })

  const saved = { ...store.get().settings }
  const patch = (settings: Partial<typeof saved>) => browser.dispatch({ type: 'settings/update', patch: settings })
  const opened: string[] = []
  const wcOf = (id: string): WebContents | undefined => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  /** Opens a page of the suite and waits until its title says it is done (or is the given one). */
  const open = async (url: string, done: (title: string) => boolean, owner = browser, ownerStore = store): Promise<{ id: string; title: () => string; wc: () => WebContents | undefined }> => {
    owner.dispatch({ type: 'tab/open', url })
    const id = ownerStore.get().tabs.at(-1)!.id
    opened.push(id)
    const title = () => ownerStore.get().tabs.find((t) => t.id === id)?.title ?? ''
    await waitFor(() => done(title()), 20_000)
    return { id, title, wc: () => (owner.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents }
  }
  const measure = async (host: string, owner = browser, ownerStore = store): Promise<{ measure: Measure | null; wc: WebContents | undefined }> => {
    const tab = await open(`${host}/fp?n=${++page}`, (t) => t.startsWith('fp:'), owner, ownerStore)
    const text = tab.title()
    return { measure: text.startsWith('fp:') ? (JSON.parse(text.slice(3)) as Measure) : null, wc: tab.wc() }
  }
  const hasGuard = (wc: WebContents | undefined): boolean => wc?.session.getPreloadScripts().some((script) => script.id === GUARD_ID) === true

  try {
    // The mechanism the stand-ins rely on, tried on sessions of its own: a redirect to a scheme the session serves itself, on a page of http and on a page of https.
    const probed: { summary: Record<string, string>; httpsSecure: string | null } = await probeRedirectTargets(origin).catch((error: unknown) => ({ summary: { failed: error instanceof Error ? error.message : String(error) }, httpsSecure: null }))
    check('probe: a script and a picture redirected to the scheme of the stand-ins load, on a page of http', (probed.summary['http, scheme declared secure'] ?? '').startsWith('{"script":"load/ok","xscript":"load","pixel":"load","xpixel":"load"}'), JSON.stringify(probed.summary))
    check('probe: ...and on a page of https (the scheme is declared secure, so no mixed content)', probed.httpsSecure !== null && probed.httpsSecure.startsWith('{"script":"load/ok","xscript":"load","pixel":"load","xpixel":"load"}'), probed.httpsSecure === null ? 'skipped: no openssl' : probed.httpsSecure)

    // ===================================================== off: nothing is registered, nothing is changed =====================================================
    // The tracking parameters of the addresses opened are taken off by the protection « Renforcée » of a new profile, before any rule of a list: set off
    // here, so that a navigation is cleaned by $removeparam alone, or not at all.
    patch({ ...adsBlockingPatch(false), blockCookieBanners: false, blockScriptlets: false, reduceFingerprint: false, fingerprintStrict: false, fingerprintExceptions: [], blockExceptions: [], disabledFilterLists: [], blockMode: 'standard', customFilterLists: [], stripTrackingParams: false })
    await sleep(500)
    const baseline = await measure(origin)
    const base = baseline.measure
    // What Chromium reports for the requests of the redirect pages (the engine itself listens to no error event, so this does not disturb it).
    const netErrors: string[] = []
    baseline.wc?.session.webRequest.onErrorOccurred({ urls: ['http://*/*', 'data:*'] }, (details) => {
      if (details.url.includes('/smoke-redir/') || details.url.startsWith('data:')) netErrors.push(`${details.url.slice(0, 50)} ${details.error}`)
    })
    check('off: the page measures itself (the baseline of the suite)', base !== null && base.canvas !== '' && base.canvas === base.canvasAgain, JSON.stringify(base))
    check('off: no page guard is registered on the session, and the channel it asks on does not exist', !hasGuard(baseline.wc) && ipcMain.listenerCount(PAGE_GUARD.plan) === 0, `guard ${String(hasGuard(baseline.wc))}, listeners ${ipcMain.listenerCount(PAGE_GUARD.plan)}`)
    check('off: Chromium\'s own WebRTC policy', baseline.wc?.getWebRTCIPHandlingPolicy() === 'default', String(baseline.wc?.getWebRTCIPHandlingPolicy()))
    check('off: the patched functions are the browser\'s own', base?.native === true)

    // The page of the scriptlets with the setting off, to compare with.
    patch(adsBlockingPatch(true))
    // The lists are the application's, kept on disk: an earlier suite of the same run may have installed its own "easylist" a moment ago, and a list
    // that is not due is not fetched again. Ask for ours at once, and wait until it is the one the engine holds.
    await service.updateNow()
    const ownRules = await waitFor(() => service.status().engineReady && !service.status().updating && service.status().lists.find((l) => l.id === 'easylist')?.rules === RULES.length, 20_000)
    check('the lists of the suite are installed and compiled (not those an earlier suite left)', ownRules, JSON.stringify(service.status().lists.find((l) => l.id === 'easylist')))
    const slOff = await open(`${origin}/scriptlets?n=${++page}`, (t) => t.startsWith('sl,'))
    check('blocker on, extended rules off: the scriptlet rules do nothing', slOff.title() === 'sl,true,read,ran,ran,undefined,undefined', slOff.title())
    // The ads switch alone keeps the page guard for the YouTube player rules (page-guard.ts, 963baef9): it is there, and it gives this page nothing (the title above).
    check('...the page guard is there for the YouTube player rules only, and the page is as it was', hasGuard(slOff.wc()) && ipcMain.listenerCount(PAGE_GUARD.plan) === 1, `guard ${String(hasGuard(slOff.wc()))}, listeners ${ipcMain.listenerCount(PAGE_GUARD.plan)}`)
    const rdOff = await open(`${origin}/redirects?n=${++page}`, (t) => t.startsWith('rd,'))
    check('...a redirect rule cancels the request: the script and the picture fail, and nothing reaches the server', rdOff.title() === 'rd,error,error,0,false' && count('/smoke-redir/gpt.js') === 0 && count('/smoke-redir/pixel.gif') === 0, `${rdOff.title()} hits ${count('/smoke-redir/gpt.js')}/${count('/smoke-redir/pixel.gif')}`)
    seen.length = 0
    await open(`${origin}/params?n=${++page}`, (t) => t.startsWith('pa,'))
    check('...$removeparam does nothing: the server receives the address as it was', seen.some((url) => url.includes('fbclid=1')) && seen.every((url) => !url.includes('keep=2') || url.includes('fbclid=1')), JSON.stringify(seen))
    const navOff = await open(`${origin}/smoke-param/page?fbclid=1&keep=2`, (t) => t === 'nav-landed')
    check('...nor does it clean a navigation', store.get().tabs.find((t) => t.id === navOff.id)?.url.includes('fbclid=1') === true, store.get().tabs.find((t) => t.id === navOff.id)?.url)
    const cspOff = await open(`${origin}/smoke-csp?n=${++page}`, (t) => t === 'csp-ran' || t === 'csp-static')
    check('...nor does $csp: the page\'s script runs', await waitFor(() => cspOff.title() === 'csp-ran', 4000), cspOff.title())

    // ===================================================== extended rules on =====================================================
    patch({ blockScriptlets: true })
    await sleep(300)
    const slOn = await open(`${origin}/scriptlets?n=${++page}`, (t) => t.startsWith('sl,'))
    check('scriptlets: set-constant, aopr and nostif act on the page, the control timer still runs', slOn.title() === 'sl,false,aborted,defused,ran,undefined,12345', slOn.title())
    check('...the page guard is registered, and the channel exists', hasGuard(slOn.wc()) && ipcMain.listenerCount(PAGE_GUARD.plan) === 1, `guard ${String(hasGuard(slOn.wc()))}, listeners ${ipcMain.listenerCount(PAGE_GUARD.plan)}`)
    check('...a scriptlet the library does not have, and a constant that is not one, do nothing', slOn.title().includes(',undefined,'), slOn.title())

    const hitsGpt = count('/smoke-redir/gpt.js')
    const rdOn = await open(`${origin}/redirects?n=${++page}`, (t) => t.startsWith('rd,'))
    check('redirect: the script named in the library is replaced by a stand-in that loads and defines googletag, the picture by a pixel', rdOn.title() === 'rd,load,error,1,true', `${rdOn.title()} | ${netErrors.join(' ; ')}`)
    check('...a resource the library does not have is a plain cancel, and the server saw none of it', count('/smoke-redir/gpt.js') === hitsGpt && count('/smoke-redir/unknown.js') === 0 && count('/smoke-redir/pixel.gif') === 0)

    seen.length = 0
    await open(`${origin}/params?n=${++page}`, (t) => t.startsWith('pa,'))
    check('removeparam: the server receives the fetch without the parameter the rule names, and with the other', seen.includes('/smoke-param/echo?keep=2'), JSON.stringify(seen))
    seen.length = 0
    const navOn = await open(`${origin}/smoke-param/page?fbclid=1&keep=2`, (t) => t === 'nav-landed')
    check('removeparam: a navigation is cleaned too, and the page still opens', seen.includes('/smoke-param/page?keep=2') && !seen.some((url) => url.includes('fbclid')), JSON.stringify(seen))
    check('...the tab shows the cleaned address', store.get().tabs.find((t) => t.id === navOn.id)?.url.includes('fbclid') === false, store.get().tabs.find((t) => t.id === navOn.id)?.url)

    const cspOn = await open(`${origin}/smoke-csp?n=${++page}`, (t) => t === 'csp-ran' || t === 'csp-static')
    // The witness: the end of the load, which comes after the inline script would have run; the document itself is asked for its title.
    const cspPage = cspOn.wc()
    await waitFor(() => cspPage !== undefined && !cspPage.isDestroyed() && !cspPage.isLoading())
    const cspTitle = cspPage && !cspPage.isDestroyed() ? String(await cspPage.executeJavaScript('document.title')) : 'no page'
    check('csp: the policy of the rule is applied to the document, whose inline script is stopped', cspTitle === 'csp-static', cspTitle)
    const bad = await open(`${origin}/smoke-badpolicy?n=${++page}`, (t) => t === 'csp-ran' || t === 'csp-static')
    check('csp: a policy that would report to a third party is refused: the script runs and nothing is reported', (await waitFor(() => bad.title() === 'csp-ran', 4000)) && count('/csp-report') === 0, `${bad.title()} reports ${count('/csp-report')}`)

    // a site with an exception, and a private window
    netErrors.length = 0
    patch({ blockExceptions: ['127.0.0.1'] })
    const exempt = await open(`${origin}/scriptlets?n=${++page}`, (t) => t.startsWith('sl,'))
    check('a site with an exception keeps its pages as they are', exempt.title() === 'sl,true,read,ran,ran,undefined,undefined', exempt.title())
    patch({ blockExceptions: [] })
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    const privSl = await open(`${origin}/scriptlets?n=${++page}`, (t) => t.startsWith('sl,'), priv.browser, priv.store)
    check('a private window follows: the same scriptlets act', privSl.title() === 'sl,false,aborted,defused,ran,undefined,12345', privSl.title())

    // ===================================================== fingerprint =====================================================
    const strictBefore = store.get().settings.fingerprintStrict
    patch({ reduceFingerprint: true })
    await sleep(300)
    const g1 = await measure(origin)
    const m1 = g1.measure
    const realCores = base?.cores ?? 0
    check('fingerprint: the canvas reads differently, and the same twice in the page', m1 !== null && base !== null && m1.canvas !== base.canvas && m1.canvas === m1.canvasAgain, `${m1?.canvas} vs ${base?.canvas}`)
    check('...the picture is still the picture: a pixel inside a solid rectangle is within one unit of its colour', m1 !== null && [255, 102, 0, 255].every((v, i) => Math.abs((m1.pixel[i] ?? -9) - v) <= 1), JSON.stringify(m1?.pixel))
    check('...the WebGL pixels and the audio differ from the baseline', m1 !== null && base !== null && (m1.webgl === 'none' || m1.webgl !== base.webgl) && m1.audio !== base.audio && Math.abs(m1.audio - base.audio) <= Math.abs(base.audio) * 1e-4, `${m1?.webgl} vs ${base?.webgl}, ${m1?.audio} vs ${base?.audio}`)
    check('...navigator announces at most 8 cores and 8 GB, never more than there are; the screen is the real one', m1 !== null && base !== null && m1.cores === Math.min(realCores, 8) && (m1.memory ?? 0) <= 8 && m1.screen.join() === base.screen.join(), JSON.stringify([m1?.cores, m1?.memory, m1?.screen]))
    check('...the patched functions still look native', m1?.native === true)
    check('...WebRTC shows no address of the machine, and Chromium\'s policy for the page is the narrow one', m1 !== null && !m1.ice.includes('host') && g1.wc?.getWebRTCIPHandlingPolicy() === 'default_public_interface_only', `${m1?.ice} / ${g1.wc?.getWebRTCIPHandlingPolicy()}`)
    check('...the guard serves it, and the channel exists', hasGuard(g1.wc) && ipcMain.listenerCount(PAGE_GUARD.plan) === 1)

    const g2 = await measure(origin)
    check('the same site reads the same canvas in another document of the session', g2.measure?.canvas === m1?.canvas, `${g2.measure?.canvas} vs ${m1?.canvas}`)
    const other = await measure(third)
    check('another site reads another canvas', other.measure !== null && m1 !== null && other.measure.canvas !== m1.canvas, `${other.measure?.canvas} vs ${m1?.canvas}`)
    const hop = await open(`${origin}/hop?n=${++page}`, (t) => t.startsWith('fp:'))
    check('a tab that goes to another site is given that site\'s noise, not the one of the page it left', hop.title().startsWith('fp:') && (JSON.parse(hop.title().slice(3)) as Measure).canvas === other.measure?.canvas && other.measure?.canvas !== m1?.canvas, `${hop.title().slice(0, 40)} vs ${other.measure?.canvas}`)
    const privFp = await measure(origin, priv.browser, priv.store)
    check('a private window is protected too, with noise of its own', privFp.measure !== null && m1 !== null && base !== null && privFp.measure.canvas !== m1.canvas && privFp.measure.canvas !== base.canvas && privFp.wc?.getWebRTCIPHandlingPolicy() === 'default_public_interface_only', `${privFp.measure?.canvas} / ${privFp.wc?.getWebRTCIPHandlingPolicy()}`)

    patch({ fingerprintStrict: true })
    await sleep(300)
    const s1 = (await measure(origin)).measure
    const common = ['1280x720', '1366x768', '1440x900', '1536x864', '1600x900', '1920x1080', '2560x1440', '3840x2160']
    // A screen smaller than every common size keeps its figures (the guard does not invent a larger one: guard-world.test.ts), and that is what the virtual screen of
    // a CI runner is (1024 x 768).
    const fits = (size: string): boolean => {
      const [width = 0, height = 0] = size.split('x').map(Number)
      return base !== null && width <= (base.screen[0] ?? 0) && height <= (base.screen[1] ?? 0)
    }
    const smallerThanAll = base !== null && !common.some(fits)
    const rounded = s1 !== null && base !== null && common.includes(`${s1.screen[0]}x${s1.screen[1]}`) && (s1.screen[0] ?? 0) <= (base.screen[0] ?? 0)
    const kept = smallerThanAll && s1 !== null && base !== null && s1.screen[0] === base.screen[0] && s1.screen[1] === base.screen[1]
    check('strict: the screen is a common size that fits the real one (or the real one, when it is smaller than all of them), and the colour depth is 24', (rounded || kept) && s1?.screen[2] === 24, JSON.stringify([s1?.screen, base?.screen]))
    check('...the graphics card is a generic one, the list of local fonts is empty, at most 4 cores', s1 !== null && (s1.renderer === 'none' || s1.renderer === 'ANGLE (Generic GPU)') && (s1.fonts === 0 || s1.fonts === 'none') && s1.cores <= 4, JSON.stringify([s1?.renderer, s1?.fonts, s1?.cores]))

    patch({ fingerprintExceptions: ['127.0.0.1'] })
    await sleep(300)
    const x1 = await measure(origin)
    check('a site left out reads what the browser gives: the baseline canvas and audio, Chromium\'s WebRTC policy', x1.measure?.canvas === base?.canvas && x1.measure?.audio === base?.audio && x1.wc?.getWebRTCIPHandlingPolicy() === 'default', `${x1.measure?.canvas} vs ${base?.canvas} / ${x1.wc?.getWebRTCIPHandlingPolicy()}`)
    const stillThird = await measure(third)
    check('...and another site is still protected', stillThird.measure !== null && base !== null && stillThird.measure.canvas !== base.canvas)

    // ===================================================== off again: everything goes =====================================================
    patch({ fingerprintExceptions: [], fingerprintStrict: strictBefore, reduceFingerprint: false })
    await sleep(300)
    const stillOn = hasGuard(wcOf(opened.at(-1) ?? ''))
    check('with the fingerprint protection off but the extended rules on, the guard stays for the scriptlets', stillOn && ipcMain.listenerCount(PAGE_GUARD.plan) === 1)
    const back = await measure(origin)
    check('...and a new page reads the baseline again', back.measure?.canvas === base?.canvas && back.wc?.getWebRTCIPHandlingPolicy() === 'default', `${back.measure?.canvas} vs ${base?.canvas}`)
    // The ads switch goes too: it alone keeps the guard for the YouTube player rules (see above).
    patch({ blockScriptlets: false, ...adsBlockingPatch(false) })
    await sleep(300)
    const quiet = await open(`${origin}/scriptlets?n=${++page}`, (t) => t.startsWith('sl,'))
    check('both off, and the ads switch: the guard is taken from the session, the channel is gone, and the page is as it was', !hasGuard(quiet.wc()) && ipcMain.listenerCount(PAGE_GUARD.plan) === 0 && quiet.title() === 'sl,true,read,ran,ran,undefined,undefined', `guard ${String(hasGuard(quiet.wc()))}, listeners ${ipcMain.listenerCount(PAGE_GUARD.plan)}, ${quiet.title()}`)

    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
  } finally {
    patch({
      blockAds: saved.blockAds,
      blockTrackers: saved.blockTrackers,
      blockCookieBanners: saved.blockCookieBanners,
      blockScriptlets: saved.blockScriptlets,
      reduceFingerprint: saved.reduceFingerprint,
      fingerprintStrict: saved.fingerprintStrict,
      fingerprintExceptions: saved.fingerprintExceptions,
      blockExceptions: saved.blockExceptions,
      disabledFilterLists: saved.disabledFilterLists,
      blockMode: saved.blockMode,
      customFilterLists: saved.customFilterLists,
      stripTrackingParams: saved.stripTrackingParams
    })
    service.useForTests({ fetch: () => Promise.reject(new Error('Pas de réseau pendant le test du moteur.')), catalog: FILTER_LISTS })
    for (const id of opened) browser.dispatch({ type: 'tab/close', id })
    server.close()
    server.closeAllConnections()
  }
}

// What a page can measure of itself, written to its title as JSON (the checks above compare it with the baseline of the same suite).
const FINGERPRINT_PAGE = `<title>fp-pending</title><body><canvas id="c" width="200" height="50"></canvas><script>
(async () => {
  const out = {}
  const hash = (text) => { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0; return h.toString(16) }
  const c = document.getElementById('c')
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ff6600'; ctx.fillRect(0, 0, 100, 30)
  ctx.fillStyle = '#006699'; ctx.font = '18px Arial'; ctx.fillText('Lucium fingerprint test 123', 4, 44)
  out.canvas = hash(c.toDataURL())
  out.canvasAgain = hash(c.toDataURL())
  out.pixel = Array.from(ctx.getImageData(20, 10, 1, 1).data)
  out.webgl = 'none'; out.renderer = 'none'
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    if (gl) {
      gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT)
      const pixels = new Uint8Array(16 * 16 * 4)
      gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      out.webgl = hash(Array.from(pixels).join(','))
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      out.renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'none'
    }
  } catch (error) { out.webgl = 'error' }
  const offline = new OfflineAudioContext(1, 44100, 44100)
  const osc = offline.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000
  const compressor = offline.createDynamicsCompressor()
  osc.connect(compressor); compressor.connect(offline.destination); osc.start(0)
  const rendered = await offline.startRendering()
  const data = rendered.getChannelData(0)
  let sum = 0
  for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i])
  out.audio = sum
  out.cores = navigator.hardwareConcurrency
  out.memory = navigator.deviceMemory === undefined ? null : navigator.deviceMemory
  out.screen = [screen.width, screen.height, screen.colorDepth]
  out.fonts = typeof queryLocalFonts === 'function' ? await queryLocalFonts().then((list) => list.length, () => 'denied') : 'none'
  out.native = Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL).includes('[native code]')
  const kinds = []
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.createDataChannel('x')
  pc.onicecandidate = (event) => { if (event.candidate) kinds.push(event.candidate.type) }
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise((resolve) => setTimeout(resolve, 1500))
  out.ice = kinds.sort().join('+')
  pc.close()
  document.title = 'fp:' + JSON.stringify(out)
})()
</script></body>`

/**
 * The same checks with their own report, for the local branching in index.ts. Returns the exit code. It opens a private window:
 * run it after `runWindowsSmoke`, whose checks name the first private session ("ephemeral-1").
 */
export async function runGuardSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeGuard(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeGuard ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_GUARD ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
