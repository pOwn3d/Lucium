// Engine checks for the features borrowed from other browsers, inside a real Electron: error pages and crash recovery, the
// privacy options (HTTPS first, Global Privacy Control, tracking parameters, the strict-transport hosts kept from one launch to the next), the PDF
// viewer, per-site zoom, reader mode.
// Pages come from local servers (never the Internet); buttons are clicked with real mouse events.

import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow as ElectronWindow, Menu, nativeImage, net, webContents as allWebContents, type WebContents } from 'electron'
import { isKillablePid } from '@shared/processes'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { noteCheck, OPEN_MORE_SETTINGS, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'
import { feedAnswer, feedFetchInit, updateOutcome } from '@shared/update-check'
import { feedSignatureCheck } from './shell/update-signature'
import { newFeedKeyPair, signFeedText } from './update-feed-signature'
import { t } from '@shared/i18n'
import { strictTransportHosts } from './engine/strict-transport'
import { STRICT_TRANSPORT_FILE, strictTransportStore } from './engine/strict-transport-store'
import { strictHostsFile } from './smoke-probe-kit'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(10_000, 100)

/** The host of the privacy checks that asks for strict transport security with its subdomains, and the subdomain whose certificate is refused. */
const STRICT_HOST = 'strict.example'
const STRICT_SUBDOMAIN = `sub.${STRICT_HOST}`

const evaluate = <T>(wc: WebContents, script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>

const rectIn = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  evaluate<Rect | null>(
    wc,
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
  )

/** A left click with real mouse events, in the middle of the box of the first element that matches. */
async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  let rect: Rect | null = null
  for (let i = 0; i < 40 && !(rect && rect.width > 0 && rect.height > 0); i++) {
    rect = await rectIn(wc, selector, text).catch(() => null)
    if (!rect) await sleep(100)
  }
  if (!rect) return false
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  return true
}

// `textContent`, not `innerText`: the technical name of the error (ERR_…) sits in a folded <details> of the error page, which `innerText` leaves out.
const bodyText = (wc: WebContents): Promise<string> => evaluate<string>(wc, 'document.body ? document.body.textContent : ""').catch(() => '')

/** A free port: bind, read the number, release. Nothing listens there afterwards, so a connection is refused. */
async function closedPort(): Promise<number> {
  const probe = createHttpServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const listen = (server: Server, port = 0): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

const shutdown = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })

/** A self-signed certificate for 127.0.0.1, made with the system's openssl in a throw-away folder. Null when openssl is not there. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Tabs opened by a section of the test: where their page is, what the sidebar shows of them, and closing them all at the end. */
function tabKit({ browser, store, engine }: SmokeContext) {
  const opened: string[] = []
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : allWebContents.fromId(number)
  }
  return {
    pageOf,
    open: async (url: string): Promise<{ id: string; wc: WebContents }> => {
      browser.dispatch({ type: 'tab/open', url })
      const tab = store.get().tabs.at(-1)!
      opened.push(tab.id)
      await waitFor(() => pageOf(tab.id) !== undefined)
      return { id: tab.id, wc: pageOf(tab.id)! }
    },
    url: (id: string) => store.get().tabs.find((t) => t.id === id)?.url,
    title: (id: string) => store.get().tabs.find((t) => t.id === id)?.title,
    closeAll: () => {
      for (const id of opened.splice(0)) browser.dispatch({ type: 'tab/close', id })
    }
  }
}

/** LUCIUM_MARKET_ONLY=errors,privacy,pdf,zoom,reader runs only those sections (a quick loop while working on one). */
export async function smokeMarket(ctx: SmokeContext, check: Check): Promise<void> {
  const only = process.env['LUCIUM_MARKET_ONLY']?.split(',')
  const sections: Array<[string, (ctx: SmokeContext, check: Check) => Promise<void>]> = [
    ['errors', smokeErrorPages],
    ['privacy', smokePrivacy],
    ['privacy', smokePrivacySettings],
    ['pdf', smokePdf],
    ['zoom', smokeZoom],
    ['reader', smokeReader]
  ]
  for (const [name, run] of sections) if (!only || only.includes(name)) await run(ctx, check)
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Error pages, certificate exceptions, crash recovery
// ---------------------------------------------------------------------------------------------------------------------

async function smokeErrorPages(ctx: SmokeContext, check: Check): Promise<void> {
  const servers: Server[] = []
  const kit = tabKit(ctx)
  const { open } = kit
  const tabUrl = kit.url
  const tabTitle = kit.title
  const showsError = (wc: WebContents) => waitFor(async () => (await bodyText(wc)).includes('ERR_'), 15_000)

  try {
    // ---- a server that is not there ----
    const port = await closedPort()
    const refusedUrl = `http://127.0.0.1:${port}/chemin?q=1`
    const refused = await open(refusedUrl)
    check('a refused connection shows a page of ours, not a blank one', await showsError(refused.wc), (await bodyText(refused.wc)).slice(0, 200))
    const text = await bodyText(refused.wc)
    check('...titled "Ce site ne répond pas", with the reason in French and the technical name', text.includes('Ce site ne répond pas') && text.includes(`127.0.0.1:${port} a refusé la connexion`) && (await evaluate<string>(refused.wc, `document.querySelector('details .code')?.textContent ?? ''`)) === 'ERR_CONNECTION_REFUSED', text.slice(0, 300))
    check('...the address of the tab stays the one that was asked for', tabUrl(refused.id) === refusedUrl && refused.wc.getURL() === refusedUrl, `${tabUrl(refused.id)} | ${refused.wc.getURL()}`)
    check('...and the tab is named after the site, as for a page that loaded', tabTitle(refused.id) === `127.0.0.1:${port}`, String(tabTitle(refused.id)))
    check('...the page follows the system appearance (light and dark)', await evaluate<boolean>(refused.wc, `getComputedStyle(document.documentElement).colorScheme.includes('light') && !!document.querySelector('meta[name="color-scheme"]')`))

    // "Réessayer" with the server back up: the same address now answers.
    const later = createHttpServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<title>de retour</title><body>le serveur répond</body>')
    })
    servers.push(later)
    await listen(later, port)
    check('"Réessayer" is a button of the page and a real click on it loads the page again', await clickOn(refused.wc, 'a.button', 'Réessayer') && (await waitFor(() => tabTitle(refused.id) === 'de retour', 10_000)), String(tabTitle(refused.id)))
    check('...at the same address, without a new history entry', tabUrl(refused.id) === refusedUrl && refused.wc.navigationHistory.getAllEntries().length === 1, `${refused.wc.navigationHistory.getAllEntries().length}`)
    await shutdown(later)
    servers.pop()

    // ---- a name nobody knows ----
    const dns = await open('http://lucium-inexistant.invalid/')
    check('an unknown host name says so', await showsError(dns.wc) && (await bodyText(dns.wc)).includes('est introuvable') && (await evaluate<string>(dns.wc, `document.querySelector('details .code')?.textContent ?? ''`)) === 'ERR_NAME_NOT_RESOLVED', (await bodyText(dns.wc)).slice(0, 200))

    // ---- no network at all ----
    // The tab is blank when the emulation starts, so the navigation after it meets a machine without a connection.
    const blank = await open('about:blank')
    blank.wc.debugger.attach('1.3')
    await blank.wc.debugger.sendCommand('Network.enable')
    await blank.wc.debugger.sendCommand('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    blank.wc.loadURL(`http://127.0.0.1:${port}/hors-ligne`).catch(() => undefined)
    const offlineShown = await showsError(blank.wc)
    check('without a connection the page says so', offlineShown && (await bodyText(blank.wc)).includes('pas connecté à Internet') && (await bodyText(blank.wc)).includes('ERR_INTERNET_DISCONNECTED'), (await bodyText(blank.wc)).slice(0, 200))
    blank.wc.debugger.detach()

    // ---- what is not a failure ----
    const quiet = createHttpServer((req, res) => {
      if (req.url === '/gone') {
        res.statusCode = 404
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.end('<title>404 de la page</title><body>la page elle-même</body>')
      }
      if (req.url === '/file.bin') {
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('content-disposition', 'attachment; filename="smoke.bin"')
        return res.end(Buffer.alloc(64, 1))
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<title>fine</title><body>fine <iframe src="http://127.0.0.1:${port}/frame"></iframe></body>`)
    })
    servers.push(quiet)
    const quietPort = await listen(quiet)
    const notFound = await open(`http://127.0.0.1:${quietPort}/gone`)
    await waitFor(() => tabTitle(notFound.id) === '404 de la page')
    check('an HTTP error status shows the site’s own page, not ours', (await bodyText(notFound.wc)) === 'la page elle-même', await bodyText(notFound.wc))
    const framed = await open(`http://127.0.0.1:${quietPort}/`)
    await waitFor(() => tabTitle(framed.id) === 'fine')
    // The witness: the end of the load of the page, which waits for its frames, the one that failed included. An error page the engine would
    // write for it goes into the page at that end, by a script that reaches the page before this reading.
    const framedLoaded = await waitFor(() => !framed.wc.isLoading())
    check('a frame that cannot load does not replace the page around it', framedLoaded && (await bodyText(framed.wc)).startsWith('fine') && !(await bodyText(framed.wc)).includes('Impossible'), await bodyText(framed.wc))

    // ---- history is left alone ----
    const first = await open(`http://127.0.0.1:${quietPort}/gone`)
    await waitFor(() => tabTitle(first.id) === '404 de la page')
    first.wc.loadURL(`http://127.0.0.1:${await closedPort()}/ailleurs`).catch(() => undefined)
    check('a failed navigation after a good page shows the error page', await showsError(first.wc))
    check('...and the tab shows the address that failed', tabUrl(first.id)?.endsWith('/ailleurs') === true, String(tabUrl(first.id)))
    first.wc.navigationHistory.goBack()
    check('...going back returns to the good page', await waitFor(() => tabTitle(first.id) === '404 de la page'), String(tabTitle(first.id)))
    await shutdown(quiet)
    servers.pop()

    // ---- a certificate nobody vouches for ----
    const material = selfSignedCertificate()
    check('openssl is there to make a self-signed certificate for the test', material !== null)
    if (material) {
      const secure = createHttpsServer(material, (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<title>page sécurisée</title><body>contenu après exception</body>')
      })
      servers.push(secure)
      const securePort = await listen(secure)
      const secureUrl = `https://127.0.0.1:${securePort}/`
      const bad = await open(secureUrl)
      check('an untrusted certificate shows "Votre connexion n’est pas privée"', await showsError(bad.wc) && (await bodyText(bad.wc)).includes('Votre connexion n’est pas privée') && (await bodyText(bad.wc)).includes('ERR_CERT_AUTHORITY_INVALID'), (await bodyText(bad.wc)).slice(0, 300))
      const badText = await bodyText(bad.wc)
      // The details are folded: their text is in the page, not in what is drawn.
      const badAll = await evaluate<string>(bad.wc, 'document.body.textContent')
      check('...with the certificate details and the choice to go on, marked unsafe', badText.includes('Continuer quand même (non sécurisé)') && badAll.includes('Empreinte') && badAll.includes('sha256/'), badAll.slice(0, 500))
      check('...and nothing of the site was loaded', !badText.includes('contenu après exception'))

      // The same host through another tab, before any exception: still refused.
      const other = await open(secureUrl)
      check('another tab is refused too: nothing is trusted yet', await showsError(other.wc))

      check('a click on "Continuer quand même" loads the site', await clickOn(bad.wc, 'a.proceed') && (await waitFor(() => tabTitle(bad.id) === 'page sécurisée', 10_000)), String(tabTitle(bad.id)))
      check('...at the address that was asked for', tabUrl(bad.id) === secureUrl, String(tabUrl(bad.id)))
      other.wc.reload()
      check('the exception holds for the host in this session: the other tab now loads', await waitFor(() => tabTitle(other.id) === 'page sécurisée', 10_000), String(tabTitle(other.id)))

      // Another certificate on the same host name is not the one the user accepted.
      const second = selfSignedCertificate()!
      const impostor = createHttpsServer(second, (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<title>autre certificat</title><body>x</body>')
      })
      servers.push(impostor)
      const impostorPort = await listen(impostor)
      const changed = await open(`https://127.0.0.1:${impostorPort}/`)
      check('a different certificate for the same host asks again', await showsError(changed.wc) && (await bodyText(changed.wc)).includes('Votre connexion n’est pas privée'), (await bodyText(changed.wc)).slice(0, 200))

      // A page cannot click for the user: a link to the action without the nonce of the page on screen does nothing.
      await changed.wc.executeJavaScript(`location.href = 'lucium-error:proceed?n=forged'`).catch(() => undefined)
      await sleep(800)
      const stillBlocked = (await bodyText(changed.wc)).includes('Votre connexion n’est pas privée') && tabTitle(changed.id) !== 'autre certificat'
      const retry = await open(`https://127.0.0.1:${impostorPort}/`)
      check('a forged "continue" link (wrong nonce) changes nothing: the page stays, and no exception was recorded', stillBlocked && (await showsError(retry.wc)) && (await bodyText(retry.wc)).includes('Votre connexion n’est pas privée'), `${tabTitle(changed.id)} | ${(await bodyText(retry.wc)).slice(0, 80)}`)

      // "Retour" when there is somewhere to go back to.
      const trail = await open(secureUrl)
      await waitFor(() => tabTitle(trail.id) === 'page sécurisée')
      trail.wc.loadURL(`https://127.0.0.1:${impostorPort}/`).catch(() => undefined)
      check('after a good page, the certificate page offers "Retour"', await showsError(trail.wc) && (await bodyText(trail.wc)).includes('Retour') && !(await bodyText(trail.wc)).includes('Réessayer'), (await bodyText(trail.wc)).slice(-120))
      check('...and "Retour" goes back to the good page', await clickOn(trail.wc, 'a.button', 'Retour') && (await waitFor(() => tabTitle(trail.id) === 'page sécurisée', 10_000)), String(tabTitle(trail.id)))

      // Another host name that reaches the same server is another host.
      const named = await open(`https://localhost:${securePort}/`)
      check('another host name for the same server asks again', await showsError(named.wc) && (await bodyText(named.wc)).includes('Votre connexion n’est pas privée'), (await bodyText(named.wc)).slice(0, 200))

      // A private window has its own session: it does not inherit the exception.
      const priv = getWindowManager().openPrivate()
      priv.browser.dispatch({ type: 'tab/open', url: secureUrl })
            const privWc = await (async () => {
        for (let i = 0; i < 50; i++) {
          const candidate = allWebContents.getAllWebContents().find((wc) => wc.getURL() === secureUrl && wc.session !== bad.wc.session)
          if (candidate) return candidate
          await sleep(100)
        }
        return undefined
      })()
      check('a private window does not inherit the exception', !!privWc && (await showsError(privWc)) && (await bodyText(privWc)).includes('Votre connexion n’est pas privée'), privWc ? (await bodyText(privWc)).slice(0, 200) : 'no page')
      priv.win.close()
      await waitFor(() => getWindowManager().privateWindows().length === 0)
      await getWindowManager().settled()
    }

    // ---- a tab that dies ----
    const live = createHttpServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<title>vivant ${Date.now()}</title><body>page vivante</body>`)
    })
    servers.push(live)
    const livePort = await listen(live)
    const liveUrl = `http://localhost:${livePort}/viv`
    const doomed = await open(liveUrl)
    await waitFor(() => (tabTitle(doomed.id) ?? '').startsWith('vivant'))
    const pid = doomed.wc.getOSProcessId()
    // Other surfaces are data: documents too (tooltips of the toolbar, for one): only the ones that appear from now on are covers.
    const isDataPage = (wc: WebContents) => wc.getURL().startsWith('data:text/html')
    const ignoredPages = new Set(allWebContents.getAllWebContents().filter(isDataPage).map((wc) => wc.id))
    const isCover = (wc: WebContents) => isDataPage(wc) && !ignoredPages.has(wc.id)
    const coverCount = () => allWebContents.getAllWebContents().filter(isCover).length
    const coversBefore = coverCount()
    check('the tab has a process of its own that a test may kill', isKillablePid(pid, process.pid), String(pid))
    if (isKillablePid(pid, process.pid)) process.kill(pid, 'SIGKILL')
    check('the process of a killed tab gets a page "L’onglet a planté"', await waitFor(() => coverCount() === coversBefore + 1, 10_000))
    const cover = allWebContents.getAllWebContents().find(isCover)
    const coverText = cover ? await bodyText(cover) : ''
    check('...which says what happened and offers to reload', coverText.includes('L’onglet a planté') && coverText.includes('Recharger') && coverText.includes('localhost:'), coverText.slice(0, 300))
    check('...the tab keeps its address and is not lost', tabUrl(doomed.id) === liveUrl, String(tabUrl(doomed.id)))
    check('...the page stands where the dead one stood', !!cover && (await evaluate<number>(cover, 'innerWidth')) > 100)
    if (cover) {
      check('a real click on "Recharger" brings the page back', await clickOn(cover, 'a.button', 'Recharger') && (await waitFor(async () => (await bodyText(doomed.wc)).includes('page vivante'), 10_000)), await bodyText(doomed.wc))
      check('...in a new process, with the cover gone', doomed.wc.getOSProcessId() !== pid && (await waitFor(() => coverCount() === coversBefore, 5000)))
    }
    const secondPid = doomed.wc.getOSProcessId()
    check('...and again after it came back', isKillablePid(secondPid, process.pid), String(secondPid))
    if (isKillablePid(secondPid, process.pid)) process.kill(secondPid, 'SIGKILL')
    await waitFor(() => coverCount() === coversBefore + 1, 10_000)
    doomed.wc.reload()
    check('reloading the dead tab by other means (⌘R) also clears the page', await waitFor(() => coverCount() === coversBefore, 10_000))
  } finally {
    kit.closeAll()
    for (const server of servers) await shutdown(server)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Privacy options: HTTPS first, Global Privacy Control, tracking parameters
// ---------------------------------------------------------------------------------------------------------------------

// 1x1 transparent GIF.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

async function smokePrivacy(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const kit = tabKit(ctx)
  const servers: Server[] = []
  const sockets = new Set<Socket>()
  const sleepOf = (ms: number) => sleep(ms)

  // The update feeds the local web server answers, by path (the signature of the feed, below).
  const feeds: Record<string, string> = {}
  // What the local web server saw: the address and the Global Privacy Control header of each request.
  const web: Array<{ url: string; gpc: string | undefined }> = []
  const webServer = createHttpServer((req, res) => {
    web.push({ url: req.url ?? '', gpc: req.headers['sec-gpc'] as string | undefined })
    const path = (req.url ?? '').split('?')[0]
    if (path === '/pixel.gif' || path === '/blocked.gif') {
      res.setHeader('content-type', 'image/gif')
      return res.end(GIF)
    }
    const feed = path === undefined ? undefined : feeds[path]
    if (feed !== undefined) {
      res.setHeader('content-type', 'application/json')
      return res.end(feed)
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>local ${path}</title><body>local<img src="/pixel.gif"><img src="http://up.example/sub.gif"><img src="http://localhost:${(webServer.address() as AddressInfo).port}/blocked.gif"></body>`)
  })
  servers.push(webServer)
  const webPort = await listen(webServer)

  // Names that are not local, served by this machine: a proxy answers for them over http and tunnels https to a server of ours.
  const material = selfSignedCertificate()
  check('openssl is there for the HTTPS-first checks', material !== null)
  if (!material) return
  const proxyHttp: string[] = []
  const secureHits: Array<{ host: string; url: string }> = []
  const secure = createHttpsServer(material, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!
    secureHits.push({ host, url: req.url ?? '' })
    // A host that asks for strict transport security, with its subdomains; `/forget` withdraws what it asked (max-age=0).
    if (host === STRICT_HOST || host.endsWith(`.${STRICT_HOST}`)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'strict-transport-security': req.url === '/forget' ? 'max-age=0' : 'max-age=600; includeSubDomains' })
      return res.end(`<title>strict ${req.url ?? ''}</title><body>strict</body>`)
    }
    if (host === 'loop.example') {
      res.writeHead(302, { location: 'http://loop.example/' })
      return res.end()
    }
    if (host === 'dl.example') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="dl.bin"' })
      return res.end(Buffer.alloc(64, 1))
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<title>https-up</title><body>secure</body>')
  })
  servers.push(secure)
  const securePort = await listen(secure)
  const proxy = createHttpServer((req, res) => {
    const url = req.url ?? ''
    proxyHttp.push(url)
    const host = URL.canParse(url) ? new URL(url).hostname : ''
    if (url.endsWith('/sub.gif')) {
      res.setHeader('content-type', 'image/gif')
      return res.end(GIF)
    }
    if (url.endsWith('/file.bin')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' })
      return res.end(Buffer.alloc(64, 2))
    }
    const titles: Record<string, string> = { 'up.example': 'http-up', 'down.example': 'http-only', 'slow.example': 'http-slow', 'loop.example': 'loop-http' }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>${titles[host] ?? 'http-other'}</title><body>plain</body>`)
  })
  proxy.on('connect', (req, clientSide, head) => {
    const client = clientSide as Socket
    sockets.add(client)
    client.on('error', () => undefined)
    const host = (req.url ?? '').split(':')[0]
    if (host === 'down.example') return void client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    // Never answered: the site that accepts the connection and says nothing.
    if (host === 'slow.example') return
    const upstream = connect(securePort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.on('error', () => client.destroy())
  })
  servers.push(proxy)
  const proxyPort = await listen(proxy)

  const hitsFor = (host: string) => secureHits.filter((h) => h.host === host).length
  const plainFor = (host: string) => proxyHttp.filter((u) => URL.canParse(u) && new URL(u).hostname === host).length
  const setOptions = (patch: { httpsUpgrade?: boolean; sendGpc?: boolean; stripTrackingParams?: boolean }) => browser.dispatch({ type: 'settings/update', patch })
  const allOff = { httpsUpgrade: false, sendGpc: false, stripTrackingParams: false }
  const anchor = await kit.open('about:blank')
  const ses = anchor.wc.session

  try {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}` })
    // The test certificate stands for a real one on the names above, and on them alone. Not on the subdomain of the strict host: its certificate is
    // refused, as on a network that intercepts (the strict hosts below).
    ses.setCertificateVerifyProc((request, callback) => callback(request.hostname.endsWith('.example') && request.hostname !== STRICT_SUBDOMAIN ? 0 : -3))

    // ---- everything off: nothing is rewritten, nothing is sent ----
    setOptions(allOff)
    const plain = await kit.open(`http://up.example/p?utm_source=a&k=1`)
    check('with every option off, an http address stays http and keeps its parameters', await waitFor(() => kit.title(plain.id) === 'http-up') && kit.url(plain.id) === 'http://up.example/p?utm_source=a&k=1' && hitsFor('up.example') === 0, `${kit.url(plain.id)} https ${hitsFor('up.example')}`)
    const quiet = await kit.open(`http://127.0.0.1:${webPort}/off?utm_source=a&fbclid=b&k=1`)
    await waitFor(() => kit.title(quiet.id) === 'local /off')
    await sleepOf(300)
    check('...and no request carries Sec-GPC', web.length > 0 && web.every((r) => r.gpc === undefined), JSON.stringify(web.map((r) => r.gpc)))
    check('...the web server got the full address', web.some((r) => r.url === '/off?utm_source=a&fbclid=b&k=1'), JSON.stringify(web.map((r) => r.url)))

    // ---- Global Privacy Control ----
    setOptions({ sendGpc: true })
    web.length = 0
    const gpc = await kit.open(`http://127.0.0.1:${webPort}/gpc`)
    await waitFor(() => kit.title(gpc.id) === 'local /gpc')
    await waitFor(() => web.some((r) => r.url === '/pixel.gif'))
    check('with Global Privacy Control on, the page request carries Sec-GPC: 1', web.find((r) => r.url === '/gpc')?.gpc === '1', JSON.stringify(web))
    check('...and so does a subresource of that page', web.find((r) => r.url === '/pixel.gif')?.gpc === '1', JSON.stringify(web))
    // What the application asks for itself (the feed of the versions, the filter lists, the Chrome Web Store) leaves by its own session, which no page
    // is behind: it carries the header too.
    await net.fetch(`http://127.0.0.1:${webPort}/own-on`, { credentials: 'omit' }).then((answer) => answer.text())
    check('...and so does a request the application makes for itself, in its own session', web.find((r) => r.url === '/own-on')?.gpc === '1', JSON.stringify(web.filter((r) => r.url.startsWith('/own'))))
    setOptions({ sendGpc: false })
    web.length = 0
    await net.fetch(`http://127.0.0.1:${webPort}/own-off`, { credentials: 'omit' }).then((answer) => answer.text())
    check('switched off again, a request of the application carries no header', web.some((r) => r.url === '/own-off') && web.find((r) => r.url === '/own-off')?.gpc === undefined, JSON.stringify(web.filter((r) => r.url.startsWith('/own'))))

    // ---- the signature of the update feed, on an answer of the real network stack ----
    // The body is read as Electron hands it over (a stream), checked against a key, and only its signed bytes are read. The pair is made here: a run
    // from the sources carries no key of its own, and the maintainer's private key is never in a test.
    {
      const pair = newFeedKeyPair()
      const stranger = newFeedKeyPair()
      const unsigned = `${JSON.stringify({ currentRelease: '99.0.0', releases: [{ version: '99.0.0', updateTo: { version: '99.0.0', url: 'https://updates.example/Lucium-99.0.0-arm64.zip', notes: 'Été « sûr ».' } }], withdrawn: ['0.0.1'] }, null, 2)}\n`
      feeds['/feed-signed.json'] = signFeedText(unsigned, [pair.privatePem])
      feeds['/feed-unsigned.json'] = unsigned
      feeds['/feed-stranger.json'] = signFeedText(unsigned, [stranger.privatePem])
      feeds['/feed-changed.json'] = signFeedText(unsigned, [pair.privatePem]).replace('99.0.0-arm64', '99.0.1-arm64')
      const refusals: string[] = []
      const read = async (path: string) => {
        const address = `http://127.0.0.1:${webPort}${path}`
        return feedAnswer(address, await net.fetch(address, feedFetchInit(AbortSignal.timeout(10_000))), feedSignatureCheck(address, [pair.publicKey], (line) => refusals.push(line)))
      }
      const believed = await read('/feed-signed.json')
      check('a feed signed by a key of the application is believed, and offers its version', believed.ok && updateOutcome('0.0.1', 'https://updates.example/feed.json', believed).kind === 'withdrawn', JSON.stringify(believed))
      check('...and nothing was written to the log for it', refusals.length === 0, refusals.join(' | '))
      for (const [path, why] of [['/feed-unsigned.json', 'no signature'], ['/feed-stranger.json', 'a key the application does not carry'], ['/feed-changed.json', 'a byte changed after the signature']] as const) {
        refusals.length = 0
        const answer = await read(path)
        const outcome = updateOutcome('0.0.1', 'https://updates.example/feed.json', answer)
        check(`a feed with ${why} is refused: no update offered, no version said withdrawn`, !answer.ok && outcome.kind === 'failed', JSON.stringify(outcome))
        check('...with one line in the log that names the address', refusals.length === 1 && refusals[0]?.includes(path) === true, refusals.join(' | '))
      }
      // The keys this run was built with: a run from the sources has none, and then believes nothing, a signed feed included.
      const own = await feedAnswer(`http://127.0.0.1:${webPort}/feed-signed.json`, await net.fetch(`http://127.0.0.1:${webPort}/feed-signed.json`, feedFetchInit(AbortSignal.timeout(10_000))), feedSignatureCheck('the feed of the test', undefined, () => undefined))
      check('a feed signed by a key this build does not carry is refused by the check the application really uses', !own.ok, JSON.stringify(own))
    }
    const gpcOff = await kit.open(`http://127.0.0.1:${webPort}/gpc-off`)
    await waitFor(() => kit.title(gpcOff.id) === 'local /gpc-off')
    check('switched off again, the header is gone', web.length > 0 && web.every((r) => r.gpc === undefined), JSON.stringify(web))

    // ---- tracking parameters ----
    setOptions({ stripTrackingParams: true })
    web.length = 0
    const stripped = await kit.open(`http://127.0.0.1:${webPort}/strip?utm_source=a&k=1&fbclid=b&gclid=c`)
    await waitFor(() => kit.title(stripped.id) === 'local /strip')
    check('with the option on, the tracking parameters never reach the server', web.some((r) => r.url === '/strip?k=1') && !web.some((r) => /utm_|fbclid|gclid/.test(r.url)), JSON.stringify(web.map((r) => r.url)))
    check('...the tab shows the cleaned address', kit.url(stripped.id) === `http://127.0.0.1:${webPort}/strip?k=1`, String(kit.url(stripped.id)))
    web.length = 0
    const kept = await kit.open(`http://127.0.0.1:${webPort}/keep?q=a+b&page=2`)
    await waitFor(() => kit.title(kept.id) === 'local /keep')
    check('other parameters are left exactly as they were', web.some((r) => r.url === '/keep?q=a+b&page=2'), JSON.stringify(web.map((r) => r.url)))
    web.length = 0
    kept.wc.loadURL(`http://127.0.0.1:${webPort}/typed?utm_campaign=x`).catch(() => undefined)
    await waitFor(() => kit.title(kept.id) === 'local /typed')
    check('a navigation the page itself starts is cleaned too', web.some((r) => r.url === '/typed') && !web.some((r) => r.url.includes('utm_')), JSON.stringify(web.map((r) => r.url)))
    setOptions({ stripTrackingParams: false })

    // ---- HTTPS first ----
    setOptions({ httpsUpgrade: true })
    const upgraded = await kit.open('http://up.example/p?x=1')
    // The icon of the page is downloaded by the main process through the tab's own session, from the page as it was served (https here): the only
    // request over https that is not the document. Anything else over https on this host, a second fetch of the page included, fails the checks.
    const secureUp = () => secureHits.filter((h) => h.host === 'up.example').map((h) => h.url)
    const secureUpButIcon = () => secureUp().filter((url) => url !== '/favicon.ico')
    check('an http address of a public site is opened over https', await waitFor(() => kit.title(upgraded.id) === 'https-up') && JSON.stringify(secureUpButIcon()) === JSON.stringify(['/p?x=1']) && !proxyHttp.includes('http://up.example/p?x=1'), `https ${JSON.stringify(secureUp())} http ${JSON.stringify(proxyHttp)}`)
    check('...and the tab shows the https address', kit.url(upgraded.id) === 'https://up.example/p?x=1', String(kit.url(upgraded.id)))
    web.length = 0
    const subImages = () => proxyHttp.filter((u) => u === 'http://up.example/sub.gif').length
    const imagesBefore = subImages()
    const local = await kit.open(`http://127.0.0.1:${webPort}/local`)
    await waitFor(() => kit.title(local.id) === 'local /local')
    check('a local address is never upgraded', web.some((r) => r.url === '/local') && kit.url(local.id) === `http://127.0.0.1:${webPort}/local`, String(kit.url(local.id)))
    check('a subresource over http is left as it is (only the document is upgraded)', await waitFor(() => subImages() === imagesBefore + 1) && JSON.stringify(secureUpButIcon()) === JSON.stringify(['/p?x=1']), `images ${subImages() - imagesBefore} https ${JSON.stringify(secureUp())}`)

    // A site with no HTTPS: the page opens over http, with a notice, and no error page.
    const down = await kit.open('http://down.example/')
    check('a site that does not answer over https opens over http', await waitFor(() => kit.title(down.id) === 'http-only', 15_000), String(kit.title(down.id)))
    check('...at its http address, without an error page', kit.url(down.id) === 'http://down.example/' && !(await bodyText(down.wc)).includes('ERR_'), `${kit.url(down.id)} ${(await bodyText(down.wc)).slice(0, 80)}`)
    check('...and the user is told', browser.snapshot().toast?.message === frenchSpaces('down.example ne répond pas en HTTPS : la page s’ouvre en HTTP, sans chiffrement.'), JSON.stringify(browser.snapshot().toast))

    // A site that accepts the connection and never answers.
    const startedAt = Date.now()
    const slow = await kit.open('http://slow.example/')
    check('a site that never answers over https falls back after the delay', await waitFor(() => kit.title(slow.id) === 'http-slow', 20_000), String(kit.title(slow.id)))
    const waited = Date.now() - startedAt
    check('...in about five seconds, not before', waited >= 4500 && waited < 12_000, `${waited} ms`)

    // A site whose https certificate is not valid: never served in http by itself, the certificate page shows and offers it.
    // `badcert.test` is not a name the test certificate stands for: Chromium's own check refuses it.
    const badCert = await kit.open('http://badcert.test/')
    check('a site whose https certificate is not valid shows the certificate page, not its http page', await waitFor(async () => (await bodyText(badCert.wc)).includes('Votre connexion n’est pas privée'), 15_000), (await bodyText(badCert.wc)).slice(0, 120))
    check('...which offers the http address, on a click only', (await bodyText(badCert.wc)).includes('Ouvrir en HTTP (non sécurisé)'), (await bodyText(badCert.wc)).slice(0, 200))
    await sleepOf(6500)
    check('...and nothing is fetched over http, even after the delay of the upgrade', plainFor('badcert.test') === 0 && kit.url(badCert.id) === 'https://badcert.test/', `http ${plainFor('badcert.test')} ${kit.url(badCert.id)}`)

    // A site that sends https visitors back to http.
    const looping = await kit.open('http://loop.example/')
    check('a site that sends https back to http does not loop', await waitFor(() => kit.title(looping.id) === 'loop-http', 15_000) && hitsFor('loop.example') === 1, `title ${kit.title(looping.id)} https ${hitsFor('loop.example')}`)
    await sleepOf(1500)
    check('...it was tried over https once', hitsFor('loop.example') === 1, String(hitsFor('loop.example')))

    // A download over https is not fetched again over http when the five seconds pass.
    const download = await kit.open('http://dl.example/file.bin')
    await sleepOf(7000)
    check('a download that starts over https is not fetched a second time over http', hitsFor('dl.example') === 1 && plainFor('dl.example') === 0, `https ${hitsFor('dl.example')} http ${plainFor('dl.example')} ${kit.title(download.id)}`)

    // ---- the hosts that asked for strict transport security, from one launch to the next ----
    // A host seen asking for it over a valid certificate is written to the folder of the session (strict-transport-store.ts), and a launch reads
    // it back: a certificate refused on it, or on a subdomain it covers, then offers no « Continuer quand même ». The restart is what a launch
    // does to the record: what this run holds in memory is dropped, and the file of the session is read again. Before the correction nothing
    // was written, and right after a launch the error page offered the way through again.
    {
      const strictFile = join(ses.getStoragePath() ?? '', STRICT_TRANSPORT_FILE)
      const readStrictFile = (): string | null => {
        try {
          return readFileSync(strictFile, 'utf8')
        } catch (error) {
          // No file yet is the state before the first write; any other failure is said in the detail of the check, as a file that is not JSON.
          return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : `the file cannot be read: ${(error as Error).message}`
        }
      }
      const strictPage = await kit.open(`https://${STRICT_HOST}/`)
      const seenStrict = await waitFor(() => kit.title(strictPage.id) === 'strict /')
      let written = strictHostsFile(readStrictFile(), STRICT_HOST)
      await waitFor(() => (written = strictHostsFile(readStrictFile(), STRICT_HOST)).held)
      check('strict hosts: a host that asked for strict transport security over a valid certificate is written to the folder of the session, by the SHA-256 of its name only', seenStrict && written.held && !written.inClear, `page loaded: ${seenStrict}; ${written.detail}`)
      const record = strictTransportStore as unknown as { files?: unknown }
      const files = record.files instanceof WeakMap ? record.files : null
      strictTransportHosts.forget(ses)
      const dropped = !strictTransportHosts.isStrict(ses, STRICT_SUBDOMAIN)
      files?.delete(ses)
      strictTransportStore.attach(ses)
      const readBack = strictTransportHosts.isStrict(ses, STRICT_SUBDOMAIN)
      check('strict hosts: after a restart of the record (memory dropped, the file of the session read as at a launch), the host and its subdomains are held again', files !== null && dropped && readBack, `the store keeps its sessions where this check looks: ${files !== null}; dropped: ${dropped}; read back: ${readBack}`)
      const refused = await kit.open(`https://${STRICT_SUBDOMAIN}/`)
      let shown = ''
      const errorShown = await waitFor(async () => (shown = await bodyText(refused.wc)).includes('Votre connexion n’est pas privée'), 15_000)
      const wayThrough = await evaluate<boolean>(refused.wc, `document.querySelector('a.proceed') !== null`).catch((error: unknown) => `the page did not answer: ${String((error as Error)?.message ?? error)}`)
      check(
        'strict hosts: ...and a certificate refused on a subdomain it covers shows the error page without « Continuer quand même », saying the site requires a secure connection',
        errorShown && wayThrough === false && shown.includes(t('errpage.site-exige-une-connexion-securisee')) && !shown.includes('Continuer quand même'),
        `a way through: ${String(wayThrough)}; ${shown.slice(0, 300)}`
      )
      // Put back: the host withdraws what it asked, and the file no longer holds it.
      const withdrawn = await kit.open(`https://${STRICT_HOST}/forget`)
      const forgot = (await waitFor(() => kit.title(withdrawn.id) === 'strict /forget')) && (await waitFor(() => !strictHostsFile(readStrictFile(), STRICT_HOST).held))
      check('strict hosts: the host withdraws it (max-age=0), and neither the record nor the file of the session holds it any more', forgot && !strictTransportHosts.isStrict(ses, STRICT_SUBDOMAIN), strictHostsFile(readStrictFile(), STRICT_HOST).detail)
    }

    // ---- blocking still works next to the rewrites ----
    setOptions({ stripTrackingParams: true })
    browser.setExtraBlockedHosts(['localhost'])
    browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
    web.length = 0
    const blocked = await kit.open(`http://127.0.0.1:${webPort}/blocking?utm_source=a`)
    await waitFor(() => kit.title(blocked.id) === 'local /blocking')
    await sleepOf(1500)
    check('the blocker still cancels a third-party request while the rewrites are on', !web.some((r) => r.url === '/blocked.gif') && web.some((r) => r.url === '/pixel.gif'), JSON.stringify(web.map((r) => r.url)))
    check('...and the navigation was still cleaned', web.some((r) => r.url === '/blocking') && !web.some((r) => r.url.includes('utm_')), JSON.stringify(web.map((r) => r.url)))
    browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
    browser.setExtraBlockedHosts([])

    // ---- a private window follows the options, with its own session ----
    setOptions({ sendGpc: true, stripTrackingParams: true, httpsUpgrade: true })
    const priv = getWindowManager().openPrivate()
    web.length = 0
    // The private session is its own: it needs the proxy and the test certificate too.
    priv.browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const privWc = await (async () => {
      for (let i = 0; i < 50; i++) {
        const found = allWebContents.getAllWebContents().find((wc) => wc.getURL() === 'about:blank' && wc.session !== ses && wc.session !== anchor.wc.session && !wc.getURL().startsWith('file:'))
        if (found && found.session.getStoragePath() === null) return found
        await sleep(100)
      }
      return undefined
    })()
    check('the private window has a page of its own session', !!privWc)
    if (!privWc) return
    await privWc.session.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}` })
    privWc.session.setCertificateVerifyProc((request, callback) => callback(request.hostname.endsWith('.example') ? 0 : -3))
    privWc.loadURL(`http://127.0.0.1:${webPort}/private?utm_source=a&k=2`).catch(() => undefined)
    await waitFor(() => web.some((r) => r.url === '/pixel.gif'))
    check('a private window sends Global Privacy Control too', web.find((r) => r.url === '/pixel.gif')?.gpc === '1' && web.find((r) => r.url === '/private?k=2')?.gpc === '1', JSON.stringify(web))
    check('...and cleans the address', web.some((r) => r.url === '/private?k=2') && !web.some((r) => r.url.includes('utm_')), JSON.stringify(web.map((r) => r.url)))
    const privateUpgrade = secureHits.length
    privWc.loadURL('http://up.example/private').catch(() => undefined)
    await waitFor(() => secureHits.length > privateUpgrade)
    check('...and tries https first', secureHits.slice(privateUpgrade).some((h) => h.host === 'up.example' && h.url === '/private'), JSON.stringify(secureHits.slice(privateUpgrade)))
    priv.win.close()
    await waitFor(() => getWindowManager().privateWindows().length === 0)
    await getWindowManager().settled()
  } finally {
    setOptions(allOff)
    browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
    browser.setExtraBlockedHosts([])
    ses.setCertificateVerifyProc(null)
    await ses.setProxy({ mode: 'system' })
    kit.closeAll()
    for (const socket of sockets) socket.destroy()
    for (const server of servers) await shutdown(server)
  }
  check('the options are back to off for what follows', store.get().settings.httpsUpgrade === false && store.get().settings.sendGpc === false && store.get().settings.stripTrackingParams === false)
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. PDF viewer
// ---------------------------------------------------------------------------------------------------------------------

/** A one-page PDF (300 × 200) whose text is `text`, with a valid cross-reference table. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'
const viewerToolbar = `document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot`

async function smokePdf(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser } = ctx
  const kit = tabKit(ctx)
  const downloads: string[] = []
  const server = createHttpServer((req, res) => {
    downloads.push(req.url ?? '')
    res.setHeader('content-type', 'application/pdf')
    res.end(makePdf('Hello Lucium PDF'))
  })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/doc.pdf`
  try {
    const tab = await kit.open(url)
    const viewer = () => tab.wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(PDF_VIEWER))
    check('a PDF opens in the tab with the viewer of Chromium (its extension frame is there)', await waitFor(() => viewer() !== undefined, 15_000), JSON.stringify(tab.wc.mainFrame.framesInSubtree.map((f) => f.url)))
    check('...and the tab is named after the file', await waitFor(() => kit.title(tab.id) === 'doc.pdf'), String(kit.title(tab.id)))
    const toolbarIds = await waitFor(async () => String(await viewer()?.executeJavaScript(`!!(${viewerToolbar})`).catch(() => false)) === 'true', 15_000)
    check('the viewer’s toolbar is there', toolbarIds)
    const has = (id: string) => viewer()!.executeJavaScript(`!!${viewerToolbar}.querySelector('${id}')`) as Promise<boolean>
    check('...with the page counter, the zoom, download and print buttons', (await has('#zoom-controls')) && (await has('#downloads')) && (await has('#print')))

    // What is drawn: the viewer's dark toolbar across the top and the white sheet of the document below it.
    await sleep(800)
    const png = await browser.capture(false)
    const image = png ? nativeImage.createFromBuffer(png) : null
    const bitmap = image?.toBitmap()
    const size = image?.getSize()
    const pixel = (x: number, y: number): [number, number, number] => {
      const at = (y * size!.width + x) * 4
      return [bitmap![at + 2]!, bitmap![at + 1]!, bitmap![at]!]
    }
    const dark = !!bitmap && pixel(Math.floor(size!.width / 2), 5).every((c) => c < 90)
    let white = false
    for (let y = 80; bitmap && y < size!.height && !white; y += 6) for (let x = 0; x < size!.width && !white; x += 6) white = pixel(x, y).every((c) => c > 245)
    check('the viewer is drawn: its dark toolbar on top, the white sheet of the document under it', dark && white, `${size?.width}x${size?.height} toolbar ${bitmap ? pixel(Math.floor(size!.width / 2), 5) : 'no image'}`)

    // Search: the browser's own find panel reaches the text of the document.
    browser.findInPage('Lucium', {})
    check('the find panel finds a word of the document', await waitFor(() => (browser.snapshot().find?.matches ?? 0) === 1), JSON.stringify(browser.snapshot().find))
    browser.endFind()

    // Zoom: the menu entries move the viewer's own zoom, not the browser's.
    const label = () => viewer()!.executeJavaScript(`${viewerToolbar}.querySelector('#zoom-controls input').value`) as Promise<string>
    const settle = async (expected: string) => waitFor(async () => (await label()) === expected, 5000)
    check('the zoom of the viewer starts at 100 %', (await label()) === '100%', await label())
    browser.zoom(1)
    check('Zoom avant (⌘+) zooms the PDF', await settle('110%'), await label())
    browser.zoom(1)
    check('...again', await settle('125%'), await label())
    browser.zoom(-1)
    check('Zoom arrière (⌘−) zooms out', await settle('110%'), await label())
    browser.zoom(0)
    check('Taille réelle (⌘0) goes back to 100 %', await settle('100%'), await label())
    check('...and the site’s remembered zoom is not touched by the viewer’s', Object.keys(ctx.store.get().settings.siteZoom).length === 0, JSON.stringify(ctx.store.get().settings.siteZoom))

    // Download: the viewer's button saves the original file through the browser's own downloads.
    const before = browser.snapshot().downloads.length
    await viewer()!.executeJavaScript(`${viewerToolbar}.querySelector('viewer-download-controls').shadowRoot.querySelector('#save').click()`)
    check('the download button saves the PDF into the downloads', await waitFor(() => browser.snapshot().downloads.length > before && browser.snapshot().downloads[0]?.filename === 'doc.pdf' && browser.snapshot().downloads[0]?.state === 'completed', 15_000), JSON.stringify(browser.snapshot().downloads.slice(0, 1)))
    check('...the tab of the PDF stays open', kit.pageOf(tab.id) !== undefined && kit.url(tab.id) === url)

    // Print: what the system prints is the document, not the viewer around it.
    const printed = await tab.wc.printToPDF({})
    const text = printed.toString('latin1')
    check('printing gives the document itself (a 300 × 200 pt PDF), not the viewer’s toolbar', text.startsWith('%PDF') && /MediaBox\[ ?0 0 300 200\]/.test(text), text.slice(0, 120))
  } finally {
    kit.closeAll()
    await shutdown(server)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Zoom kept per site
// ---------------------------------------------------------------------------------------------------------------------

async function smokeZoom(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const kit = tabKit(ctx)
  const server = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<title>zoom</title><body>zoom</body>')
  })
  const port = await listen(server)
  const dir = mkdtempSync(join(tmpdir(), 'lucium-zoom-'))
  writeFileSync(join(dir, 'a.html'), '<title>fichier</title><body>fichier</body>')
  const siteZoom = () => store.get().settings.siteZoom
  const factorOf = (wc: WebContents) => Math.round(wc.getZoomFactor() * 1000) / 1000
  const reaches = (wc: WebContents, factor: number) => waitFor(() => Math.abs(factorOf(wc) - factor) < 0.006, 5000)
  const A = `http://127.0.0.1:${port}/a`
  const B = `http://localhost:${port}/b`
  browser.dispatch({ type: 'settings/update', patch: { siteZoom: {} } })
  try {
    const first = await kit.open(A)
    await waitFor(() => kit.title(first.id) === 'zoom')
    check('a site starts at 100 %', factorOf(first.wc) === 1, String(factorOf(first.wc)))
    browser.zoom(1)
    check('Zoom avant goes to 110 %, as Chromium’s own steps do', await reaches(first.wc, 1.1), String(factorOf(first.wc)))
    browser.zoom(1)
    check('...then 125 %', await reaches(first.wc, 1.25), String(factorOf(first.wc)))
    check('the level is kept for the site, by host name', siteZoom()['127.0.0.1'] === 1.25, JSON.stringify(siteZoom()))

    // The same site in another tab, opened afterwards or already open.
    const second = await kit.open(`http://127.0.0.1:${port}/c`)
    await waitFor(() => kit.title(second.id) === 'zoom')
    check('another tab of the site opens at the remembered zoom', await reaches(second.wc, 1.25), String(factorOf(second.wc)))
    first.wc.reload()
    await sleep(800)
    await waitFor(() => !first.wc.isLoading())
    check('a reload keeps it (a page load used to put the zoom back to 100 %)', await reaches(first.wc, 1.25), String(factorOf(first.wc)))
    first.wc.loadURL(`http://127.0.0.1:${port}/other`).catch(() => undefined)
    await sleep(800)
    await waitFor(() => !first.wc.isLoading())
    check('...and so does another page of the same site', await reaches(first.wc, 1.25), String(factorOf(first.wc)))

    // Another site is another zoom.
    const other = await kit.open(B)
    await waitFor(() => kit.title(other.id) === 'zoom')
    check('another site is not affected', factorOf(other.wc) === 1, String(factorOf(other.wc)))

    // Changing it from one tab moves the others of the site at once.
    kit.pageOf(first.id) && browser.dispatch({ type: 'tab/select', id: first.id })
    browser.zoom(-1)
    check('Zoom arrière steps back down', await reaches(first.wc, 1.1), String(factorOf(first.wc)))
    check('...and the other tab of the site follows at once', await reaches(second.wc, 1.1), String(factorOf(second.wc)))
    check('...while the other site stays', factorOf(other.wc) === 1)

    // A Tweak's text size is the base, the user's zoom comes on top.
    browser.dispatch({ type: 'boost/save', boost: { id: 'zoom-boost', host: '127.0.0.1', zoom: 1.5 } })
    check('with a Tweak at 150 % on the site, the zoom of the site comes on top of it', await reaches(first.wc, 1.65), String(factorOf(first.wc)))
    browser.dispatch({ type: 'boost/delete', id: 'zoom-boost' })
    check('...and without it the page goes back to the site’s zoom', await reaches(first.wc, 1.1), String(factorOf(first.wc)))

    browser.zoom(0)
    check('Taille réelle (⌘0) puts the site back to 100 %', await reaches(first.wc, 1), String(factorOf(first.wc)))
    check('...forgets it, and the other tab follows', !('127.0.0.1' in siteZoom()) && (await reaches(second.wc, 1)), JSON.stringify(siteZoom()))

    // Limits.
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    browser.zoom(-1)
    await waitFor(() => factorOf(first.wc) === 0.25, 5000)
    check('the zoom stops at 25 %', factorOf(first.wc) === 0.25 && siteZoom()['127.0.0.1'] === 0.25, `${factorOf(first.wc)} ${JSON.stringify(siteZoom())}`)
    browser.zoom(0)
    await reaches(first.wc, 1)

    // A page that has no host to be remembered under.
    const file = await kit.open(pathToFileURL(join(dir, 'a.html')).href)
    await waitFor(() => kit.title(file.id) === 'fichier')
    browser.zoom(1)
    check('a file zooms while it is open', await reaches(file.wc, 1.1), String(factorOf(file.wc)))
    check('...without a remembered site', Object.keys(siteZoom()).length === 0, JSON.stringify(siteZoom()))
    file.wc.reload()
    await sleep(800)
    await waitFor(() => !file.wc.isLoading())
    // The tab keeps the zoom of a page that has no host for as long as its page lives, as a site keeps its own (the split view « Zoom | Notes du présentateur »).
    check('...and keeps it once the page is loaded again', await reaches(file.wc, 1.1), String(factorOf(file.wc)))
    browser.zoom(0)
    check('...until ⌘0 puts it back to 100 %', await reaches(file.wc, 1), String(factorOf(file.wc)))

    // A private window starts from the main window's zooms and keeps its own afterwards.
    browser.dispatch({ type: 'settings/update', patch: { siteZoom: { '127.0.0.1': 1.5 } } })
    const priv = getWindowManager().openPrivate()
    check('a private window starts with the zooms of the main window', priv.store.get().settings.siteZoom['127.0.0.1'] === 1.5, JSON.stringify(priv.store.get().settings.siteZoom))
    priv.browser.dispatch({ type: 'tab/open', url: `http://127.0.0.1:${port}/private` })
    const privWc = await (async () => {
      for (let i = 0; i < 80; i++) {
        const found = allWebContents.getAllWebContents().find((wc) => wc.getURL() === `http://127.0.0.1:${port}/private`)
        if (found) return found
        await sleep(100)
      }
      return undefined
    })()
    check('...and its page opens at that zoom', !!privWc && (await reaches(privWc, 1.5)), privWc ? String(factorOf(privWc)) : 'no page')
    priv.browser.zoom(1)
    check('zooming in the private window moves its page', !!privWc && (await reaches(privWc, 1.75)), privWc ? String(factorOf(privWc)) : 'no page')
    check('...is kept in the window only: the main window’s zoom is not touched', priv.store.get().settings.siteZoom['127.0.0.1'] === 1.75 && siteZoom()['127.0.0.1'] === 1.5, `${JSON.stringify(priv.store.get().settings.siteZoom)} | ${JSON.stringify(siteZoom())}`)
    browser.dispatch({ type: 'settings/update', patch: { siteZoom: { '127.0.0.1': 1.1 } } })
    check('...and a change in the main window does not move the private one', priv.store.get().settings.siteZoom['127.0.0.1'] === 1.75, JSON.stringify(priv.store.get().settings.siteZoom))
    priv.win.close()
    await waitFor(() => getWindowManager().privateWindows().length === 0)
    await getWindowManager().settled()
  } finally {
    browser.dispatch({ type: 'boost/delete', id: 'zoom-boost' })
    browser.dispatch({ type: 'settings/update', patch: { siteZoom: {} } })
    kit.closeAll()
    await shutdown(server)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Reader mode
// ---------------------------------------------------------------------------------------------------------------------

const PARAGRAPH = (n: number) =>
  `<p>Paragraphe ${n} de l’article : les navigateurs affichent le texte d’une page sans ce qui l’entoure, avec une typographie pensée pour la lecture, ` +
  `des lignes de longueur confortable, des images à leur place et un fond qui suit l’apparence du système, clair ou sombre, pendant que la page d’origine attend sagement dessous.</p>`

const ARTICLE_PAGE = (port: number) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Un grand titre | Le Journal</title><meta property="og:site_name" content="Le Journal"></head>
<body style="margin:0"><nav id="menu">Menu principal Accueil Sport Culture Connexion</nav>
<article><h1>Un grand titre</h1><p class="byline">Par Jeanne Martin</p>
${PARAGRAPH(1)}${PARAGRAPH(2)}
<p>Une phrase avec <a id="more" href="/suite">un lien vers la suite</a> et <a href="file:///etc/hosts">un lien vers un fichier local</a> pour la lire plus tard, ${'et du texte pour la remplir, '.repeat(6)}</p>
<img src="/pic.gif" alt="Une image" width="40" height="40">${PARAGRAPH(3)}${PARAGRAPH(4)}
<p onclick="document.body.dataset.ran='click'"><img src="x" onerror="document.body.dataset.ran='yes'">Un paragraphe qui tente d’exécuter du code : ${'rien ne doit s’exécuter dans le mode lecture, '.repeat(5)}</p></article>
<aside id="promo">Abonnez-vous à notre lettre d’information gratuite</aside><footer id="legal">Mentions légales et conditions générales</footer>
<div style="height:3000px"></div><script>/* port ${port} */</script></body></html>`

async function smokeReader(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const kit = tabKit(ctx)
  const hits: string[] = []
  const server = createHttpServer((req, res) => {
    hits.push(req.url ?? '')
    const path = (req.url ?? '').split('?')[0]
    if (path === '/pic.gif') {
      res.setHeader('content-type', 'image/gif')
      return res.end(GIF)
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/menu') return res.end('<title>Menu</title><body><a href="/a">Accueil</a> <a href="/b">Sport</a></body>')
    if (path === '/suite') return res.end('<title>La suite</title><body>suite</body>')
    res.end(ARTICLE_PAGE(port))
  })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const isDataPage = (wc: WebContents) => !wc.isDestroyed() && wc.getURL().startsWith('data:text/html')
  // Other surfaces are data: documents too (tooltips of the toolbar): only the readers that appear from now on count.
  const ignoredPages = new Set(allWebContents.getAllWebContents().filter(isDataPage).map((wc) => wc.id))
  const covers = () => allWebContents.getAllWebContents().filter((wc) => isDataPage(wc) && !ignoredPages.has(wc.id))
  const attached = (wc: WebContents) => ctx.win.contentView.children.some((view) => (view as { webContents?: WebContents }).webContents?.id === wc.id)
  const menuItem = () => Menu.getApplicationMenu()?.items.flatMap((m) => m.submenu?.items ?? []).find((i) => i.label === 'Mode lecture')
  try {
    const tab = await kit.open(`${base}/article`)
    await waitFor(() => kit.title(tab.id) === 'Un grand titre | Le Journal')
    await waitFor(() => !tab.wc.isLoading())
    await tab.wc.executeJavaScript('scrollTo(0, 300)')
    await waitFor(async () => (await tab.wc.executeJavaScript('scrollY')) === 300)
    // The page runs its own scripts, as ever (the picture that cannot load runs its handler here, in the page): the reader must not.
    check('the article page runs its own script, in the page', await waitFor(async () => (await tab.wc.executeJavaScript('document.body.dataset.ran')) === 'yes'))

    const entry = menuItem()
    check('the View menu has a "Mode lecture" entry', !!entry, Menu.getApplicationMenu()?.items.map((m) => m.label).join(','))
    check('...enabled on a web page, with no shortcut of its own (Arc has none)', entry?.enabled === true && !entry.accelerator, JSON.stringify({ enabled: entry?.enabled, accelerator: entry?.accelerator }))

    const before = covers().length
    entry?.click()
    check('choosing it lays a reader over the page', await waitFor(() => covers().length === before + 1, 15_000))
    const cover = covers().find((wc) => wc.getURL() !== '')!
    await waitFor(async () => (await bodyText(cover)).includes('Un grand titre'))
    const text = await bodyText(cover)
    check('it shows the title, the site, the author and the reading time', text.includes('Un grand titre') && anySpace(/le journal/i).test(text) && text.includes('Jeanne Martin') && anySpace(/\d+ min de lecture/).test(text), text.slice(0, 160))
    check('...the text of the article and its link', text.includes('Paragraphe 1 de l’article') && text.includes('Paragraphe 4 de l’article') && (await evaluate<boolean>(cover, `!!document.querySelector('article a[href="${base}/suite"]')`)), text.slice(160, 300))
    check('...and nothing of what surrounds it (menu, promotion, footer)', !text.includes('Menu principal') && !text.includes('Abonnez-vous') && !text.includes('Mentions légales'), text.slice(-200))
    check('...the picture, with its absolute address', await evaluate<boolean>(cover, `!!document.querySelector('article img[src="${base}/pic.gif"]')`))
    // The reader's own script is the one of its pill (shared/reader-pill.ts), allowed by the nonce of the document (and the voice's, with « Lire à voix haute »
    // on): nothing else, and the article's is not one of them.
    const readerOwn = store.get().settings.readAloud ? 2 : 1
    const readerScripts = await evaluate<{ count: number; nonced: boolean; ran: string | null }>(cover, `(() => { const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''; const scripts = [...document.scripts]; return { count: scripts.length, nonced: scripts.every((s) => s.nonce !== '' && policy.includes("'nonce-" + s.nonce + "'")), ran: document.body.dataset.ran ?? null } })()`)
    check('...runs no script of the article: the one it carries did not run, the only script is the pill’s, allowed by the nonce of the reader', readerScripts.count === readerOwn && readerScripts.nonced && readerScripts.ran === null, JSON.stringify(readerScripts))
    check('...under a policy that forbids scripts and connections', await evaluate<boolean>(cover, `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("default-src 'none'") === true`))
    check('...laid exactly over the page', Math.abs((await evaluate<number>(cover, 'innerWidth')) - (await tab.wc.executeJavaScript('innerWidth'))) <= 2 && attached(cover))
    check('the tab keeps its address and history while reading', kit.url(tab.id) === `${base}/article` && tab.wc.navigationHistory.getAllEntries().length === 1, `${kit.url(tab.id)} ${tab.wc.navigationHistory.getAllEntries().length}`)

    // The article's own zoom.
    browser.zoom(1)
    check('Zoom avant while reading enlarges the article, not the site', await waitFor(() => Math.abs(cover.getZoomFactor() - 1.1) < 0.006) && Object.keys(store.get().settings.siteZoom).length === 0 && tab.wc.getZoomFactor() === 1, `${cover.getZoomFactor()} ${tab.wc.getZoomFactor()}`)

    // Another tab: the reader belongs to its page.
    const other = await kit.open(`${base}/menu`)
    await waitFor(() => kit.title(other.id) === 'Menu')
    check('showing another tab takes the reader off the screen', await waitFor(() => !attached(cover)))
    browser.dispatch({ type: 'tab/select', id: tab.id })
    check('...and coming back to the tab brings it back', await waitFor(() => attached(cover)))

    // Escape.
    cover.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    cover.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    check('Escape leaves the reader', await waitFor(() => covers().length === before, 5000), `${covers().length}`)
    check('...the page is exactly where it was: same document, same scroll', (await tab.wc.executeJavaScript('scrollY')) === 300 && (await tab.wc.executeJavaScript('document.body.dataset.ran')) === 'yes')
    check('...with the keyboard back on it', await waitFor(() => tab.wc.isFocused()), String(tab.wc.isFocused()))

    // The same entry again: in and out.
    await browser.toggleReader()
    check('the entry shows the reader again', await waitFor(() => covers().length === before + 1, 15_000))
    await browser.toggleReader()
    check('...and a second time takes it away', await waitFor(() => covers().length === before, 5000))

    // A link of the article opens in the tab.
    await browser.toggleReader()
    await waitFor(() => covers().length === before + 1, 15_000)
    const again = covers()[0]!
    await waitFor(async () => (await bodyText(again)).includes('Un grand titre'))
    check('a link to a local file does nothing: only web addresses open from the reader', (await clickOn(again, 'article a', 'un lien vers un fichier local')) && (await sleep(800), kit.url(tab.id) === `${base}/article` && covers().length === before + 1), `${kit.url(tab.id)} ${covers().length}`)
    check('a click on a link of the article opens it in the tab', (await clickOn(again, 'article a', 'un lien vers la suite')) && (await waitFor(() => kit.title(tab.id) === 'La suite', 10_000)), String(kit.title(tab.id)))
    check('...and the reader gives way to it', await waitFor(() => covers().length === before, 5000))

    // The reader goes when the page does.
    tab.wc.loadURL(`${base}/article?2`).catch(() => undefined)
    await waitFor(() => kit.title(tab.id) === 'Un grand titre | Le Journal' && !tab.wc.isLoading())
    await browser.toggleReader()
    await waitFor(() => covers().length === before + 1, 15_000)
    tab.wc.loadURL(`${base}/menu`).catch(() => undefined)
    check('a navigation of the tab (the address bar, back…) takes the reader away', await waitFor(() => covers().length === before, 10_000))

    // A local file is not a web page, whatever it holds.
    const dir = mkdtempSync(join(tmpdir(), 'lucium-reader-'))
    writeFileSync(join(dir, 'a.html'), ARTICLE_PAGE(port))
    const file = await kit.open(pathToFileURL(join(dir, 'a.html')).href)
    await waitFor(() => kit.title(file.id) === 'Un grand titre | Le Journal' && !file.wc.isLoading())
    await browser.toggleReader()
    check('a local file with an article in it is not read (the reader is for web pages)', covers().length === before, `${covers().length}`)
    rmSync(dir, { recursive: true, force: true })
    browser.dispatch({ type: 'tab/select', id: tab.id })

    // A page without an article.
    await waitFor(() => kit.title(tab.id) === 'Menu' && !tab.wc.isLoading())
    await browser.toggleReader()
    check('a page with nothing to read does not open a reader, and says so', covers().length === before && browser.snapshot().toast?.message === 'Cette page n’a pas d’article à afficher en mode lecture.', JSON.stringify(browser.snapshot().toast))
    check('...the page is untouched', kit.url(tab.id) === `${base}/menu`)

    // Pages that are not web pages.
    const blank = await kit.open('about:blank')
    browser.dispatch({ type: 'tab/select', id: blank.id })
    check('the entry is greyed out where there is no web page to read', await waitFor(() => menuItem()?.enabled === false), JSON.stringify(menuItem()?.enabled))
    await browser.toggleReader()
    check('...and the command itself refuses it', covers().length === before)
  } finally {
    kit.closeAll()
    await shutdown(server)
  }
}

/** The group of options in the Settings window (Avancé), driven by its own DOM and a real click on a switch. */
async function smokePrivacySettings({ browser, store }: SmokeContext, check: Check): Promise<void> {
  const settings = () => store.get().settings
  // A new profile has the four on (the protection « Renforcée »): the group is measured from all off.
  browser.dispatch({ type: 'settings/update', patch: { httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false } })
  // The three switches are a group of the Vie privée category (Settings in eight categories); the title of a group carries the number of its settings, so it is read by its beginning.
  browser.openOverlay({ panel: 'settings', pane: 'protection' })
  const settingsWindow = () => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')
  check('the Settings window opens on the Vie privée category', await waitFor(() => settingsWindow() !== undefined))
  const ui = settingsWindow()?.webContents
  if (!ui) return
  // The group is drawn in two parts under one title: the tracking parameters of the addresses under the level of protection, the three others in
  // « Plus de réglages », opened here. Its switches are read in both parts.
  await waitFor(async () => (await evaluate<boolean>(ui, `!!document.querySelector('.settings-content .more-settings-toggle')`)) && (await evaluate<boolean>(ui, OPEN_MORE_SETTINGS)))
  const parts = `[...document.querySelectorAll('h3')].filter((e) => e.textContent.startsWith('Pistage et HTTPS')).map((h) => h.closest('section')).filter(Boolean)`
  const boxes = `${parts}.flatMap((g) => [...g.querySelectorAll('input[role=switch]')])`
  check('a group "Pistage et HTTPS" is there, apart from the blocker', await waitFor(async () => (await evaluate<number>(ui, `${parts}.length`)) > 0))
  // https first, Global Privacy Control, the tracking parameters, and (added since) the tracking parameters of copied links: four switches, all off by default.
  check('...with four switches, all off', await evaluate<boolean>(ui, `(() => { const all = ${boxes}; return all.length === 4 && all.every((b) => !b.checked) })()`), await evaluate<string>(ui, `JSON.stringify(${boxes}.map((b) => [b.getAttribute('aria-label'), b.checked]))`))
  check('...named for what they do', await evaluate<boolean>(ui, `(() => { const t = ${parts}.map((g) => g.textContent).join(' '); return t.includes('HTTPS d’abord') && t.includes('signal GPC') && t.includes('paramètres de suivi') })()`))
  const toggle = async (label: string) => {
    const locate = () => evaluate<Rect | null>(ui, `(() => { const row = ${parts}.flatMap((g) => [...g.querySelectorAll('label')]).find((l) => l.textContent.includes(${JSON.stringify(label)})); if (!row) return null; row.scrollIntoView({ block: 'center' }); const r = (row.closest('.pref-row') ?? row).querySelector('input').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!(await locate())) return false
    const again = (await locate())!
    const x = Math.round(again.x + again.width / 2)
    const y = Math.round(again.y + again.height / 2)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    return true
  }
  check('a click on the first switch turns HTTPS first on', (await toggle('HTTPS d’abord')) && (await waitFor(() => settings().httpsUpgrade === true)), JSON.stringify(settings().httpsUpgrade))
  check('a click on the second turns Global Privacy Control on', (await toggle('signal GPC')) && (await waitFor(() => settings().sendGpc === true)), JSON.stringify(settings().sendGpc))
  check('a click on the third turns the removal of tracking parameters on', (await toggle('paramètres de suivi des adresses')) && (await waitFor(() => settings().stripTrackingParams === true)), JSON.stringify(settings().stripTrackingParams))
  // The three switched on show it; the fourth of the group (the tracking parameters of copied links, whose name also says « paramètres de suivi ») stays off.
  check('the switches show the state', await evaluate<boolean>(ui, `(() => { const all = ${boxes}; const own = all.filter((b) => ['HTTPS', 'signal GPC', 'paramètres de suivi des adresses'].some((word) => (b.getAttribute('aria-label') ?? '').includes(word))); return all.length === 4 && own.length === 3 && own.every((b) => b.checked) && all.filter((b) => !own.includes(b)).every((b) => !b.checked) })()`), await evaluate<string>(ui, `JSON.stringify(${boxes}.map((b) => [b.getAttribute('aria-label'), b.checked]))`))
  browser.dispatch({ type: 'settings/update', patch: { httpsUpgrade: false, sendGpc: false, stripTrackingParams: false } })
  settingsWindow()?.close()
}

/** The same checks with their own report, for the local branching in index.ts. Returns the exit code. */
export async function runMarketSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    // LUCIUM_MARKET_VERBOSE=1 prints each check as it is made (the report only comes at the end).
    const verbose = process.env['LUCIUM_MARKET_VERBOSE'] === '1'
    await smokeMarket(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`MARKET ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 300)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeMarket ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_MARKET ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
