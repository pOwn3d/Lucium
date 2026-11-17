// Engine checks for the site icons of favourites and pinned tabs, run inside a real Electron against a handful of local "sites":
// a favourite and a pinned tab without an icon receive the one their page declares, /favicon.ico when the page declares none, an
// apple-touch-icon when it is all there is; a site with no usable icon keeps the letter; a slow site is given up after 5 s; a redirect
// from https to http is refused; no cookie and no Referer ever reach a site; an icon that is already there is never replaced; a
// private window asks for nothing; the setting off asks for nothing; a local host is not asked at all unless the test names it.
// And what the sidebar draws: the copy the main process keeps of an icon, asked under its own scheme; the interface itself can load no picture of
// the web, an icon nothing shows is not downloaded, and the icon of a tab is downloaded by the session of its profile.
// Called from the engine smoke test: `await smokeFavicons(ctx, check)`; `LUCIUM_SMOKE_ONLY=favicons` runs only this file (see index.ts).
// `LUCIUM_SMOKE_ONLY=favicons-measure` instead measures the lookup on a copy of a real state (Internet needed, counts only).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { session } from 'electron'
import { iconsWanted, type IconJob } from '@shared/favicon'
import type { SmokeContext } from './smoke'
import { FaviconResolver } from './shell/favicon-resolver'
import { requestFetch, type FaviconService } from './shell/favicon-service'
import { getWindowManager } from './shell/windows'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(15_000, 80)

// ---------- pictures a browser really draws ----------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A 16x16 PNG of one colour. */
function solidPng(r: number, g: number, b: number): Buffer {
  const size = 16
  const rows = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
}

/** An icon file holding one PNG image: the format of a real favicon.ico. */
function solidIco(r: number, g: number, b: number): Buffer {
  const png = solidPng(r, g, b)
  const entry = Buffer.alloc(16)
  entry.set([16, 16, 0, 0], 0)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), entry, png])
}

// ---------- the local "sites" ----------

interface Hit {
  at: number
  site: string
  method: string
  path: string
  cookie: string | null
  referer: string | null
  authorization: string | null
  userAgent: string | null
}

interface Site {
  base: string
  /** `host:port`, as the lookup names a host. */
  host: string
  server: Server
}

const reply = (res: ServerResponse, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
  res.writeHead(200, { 'content-type': type, ...extra })
  res.end(body)
}
const html = (res: ServerResponse, head: string, extra: Record<string, string> = {}): void => reply(res, 'text/html; charset=utf-8', `<!doctype html><html><head><title>Un site</title>${head}</head><body>x</body></html>`, extra)
const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body>introuvable</body></html>')
}

export async function smokeFavicons(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const state = () => store.get()
  // The lookup exists only while the setting is on (feature-gate.ts): after each switch off and on this is a new one, found again with `renew()`.
  const first = browser.faviconLookup()
  const evaluate = <T>(script: string) => win.webContents.executeJavaScript(script) as Promise<T>
  check('the main window runs the site-icon lookup', first !== null)
  if (!first) return
  let service: FaviconService = first
  /**
   * The witness of a lookup that must not happen: the lookup decides as it scans (favicon-resolver.ts, `enqueue` and `pump`), and once nothing of
   * it waits or runs, a request it made has reached its site and an icon it found has been handed over.
   */
  const lookupIdle = (lookup: FaviconService): Promise<boolean> =>
    waitFor(() => {
      const now = lookup.stats()
      return now.pending === 0 && now.active === 0
    })

  const hits: Hit[] = []
  const servers: Server[] = []
  const cleanups: Array<() => void> = []
  const startSite = async (name: string, handler: (req: IncomingMessage, res: ServerResponse) => void, tls?: { key: string; cert: string }): Promise<Site> => {
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      hits.push({ at: Date.now(), site: name, method: req.method ?? '', path: req.url ?? '/', cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null, authorization: req.headers.authorization ?? null, userAgent: req.headers['user-agent'] ?? null })
      handler(req, res)
    }
    const server = tls ? createHttps(tls, listener) : createHttp(listener)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return { base: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, server }
  }
  const hitsOf = (site: string) => hits.filter((h) => h.site === site)
  const rootHits = (site: string) => hitsOf(site).filter((h) => h.path === '/').length

  // A: the page declares an icon. B: the same, for a pinned tab. C: nothing declared, /favicon.ico answers. D: an icon that is gone and no /favicon.ico.
  const A = await startSite('A', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" type="image/png" href="/assets/a.png">') : req.url === '/assets/a.png' ? reply(res, 'image/png', solidPng(229, 72, 77)) : notFound(res)))
  const B = await startSite('B', (req, res) => (req.url === '/' ? html(res, '<link rel="shortcut icon" href="b.png">') : req.url === '/b.png' ? reply(res, 'image/png', solidPng(48, 164, 108)) : notFound(res)))
  const C = await startSite('C', (req, res) => (req.url === '/' ? html(res, '') : req.url === '/favicon.ico' ? reply(res, 'image/x-icon', solidIco(0, 145, 255)) : notFound(res)))
  const D = await startSite('D', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/missing.png">') : notFound(res)))
  // E: only an apple-touch-icon. R: a tab of Today.
  const E = await startSite('E', (req, res) => (req.url === '/' ? html(res, '<link rel="apple-touch-icon" href="/apple.png">') : req.url === '/apple.png' ? reply(res, 'image/png', solidPng(245, 165, 36)) : notFound(res)))
  const R = await startSite('R', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/r.png">') : req.url === '/r.png' ? reply(res, 'image/png', solidPng(142, 78, 198)) : notFound(res)))
  // F: a home page that never answers (the delay is 5 s).
  const F = await startSite('F', (_req, res) => {
    const timer = setTimeout(() => html(res, '<link rel="icon" href="/f.png">'), 9000)
    res.on('close', () => clearTimeout(timer))
  })
  // I: sets a cookie and checks that none comes back; a cookie is put in the lookup's own session for this site beforehand.
  const I = await startSite('I', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/i.png">', { 'set-cookie': 'srv=1; Path=/' }) : req.url === '/i.png' ? reply(res, 'image/png', solidPng(18, 165, 148), { 'set-cookie': 'img=1; Path=/' }) : notFound(res)))
  // J: has an icon already: never asked. K: answers slowly, and the page gives its own icon meanwhile.
  const J = await startSite('J', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/j.png">') : reply(res, 'image/png', solidPng(1, 2, 3))))
  const K = await startSite('K', (req, res) => {
    if (req.url === '/') {
      const timer = setTimeout(() => html(res, '<link rel="icon" href="/k.png">'), 1500)
      res.on('close', () => clearTimeout(timer))
    } else if (req.url === '/k.png') reply(res, 'image/png', solidPng(9, 9, 9))
    else notFound(res)
  })
  // L: opened in a private window. M: looked up only while the setting is on.
  const L = await startSite('L', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/l.png">') : reply(res, 'image/png', solidPng(5, 5, 5))))
  const M = await startSite('M', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/m.png">') : req.url === '/m.png' ? reply(res, 'image/png', solidPng(233, 61, 130)) : notFound(res)))
  // P and N declare an icon on another host ("localhost"): P is the control, N has that host blocked by the request blocker. Its /favicon.ico answers.
  const O = await startSite('O', (_req, res) => reply(res, 'image/png', solidPng(10, 20, 30)))
  const otherHost = `localhost:${(O.server.address() as AddressInfo).port}`
  const P = await startSite('P', (req, res) => (req.url === '/' ? html(res, `<link rel="icon" href="http://${otherHost}/p.png">`) : notFound(res)))
  const N = await startSite('N', (req, res) => (req.url === '/' ? html(res, `<link rel="icon" href="http://${otherHost}/n.png">`) : req.url === '/favicon.ico' ? reply(res, 'image/x-icon', solidIco(136, 144, 150)) : notFound(res)))

  // G is https (a certificate made for the test), and sends the visitor to H, which is http.
  const tlsDir = mkdtempSync(join(tmpdir(), 'lucium-favicons-'))
  cleanups.push(() => rmSync(tlsDir, { recursive: true, force: true }))
  let tls: { key: string; cert: string } | null = null
  try {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
    tls = { key: readFileSync(join(tlsDir, 'key.pem'), 'utf8'), cert: readFileSync(join(tlsDir, 'cert.pem'), 'utf8') }
  } catch (error) {
    check('a certificate for the https test site could be made', false, String(error))
  }
  const H = await startSite('H', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/h.png">') : req.url === '/h.png' ? reply(res, 'image/png', solidPng(1, 1, 1)) : reply(res, 'image/x-icon', solidIco(1, 1, 1))))
  const G = tls
    ? await startSite('G', (req, res) => (req.url === '/' ? (res.writeHead(302, { location: `${H.base}/` }), res.end()) : notFound(res)), tls)
    : null
  // S is https too, and answers well: the control that shows the test setup reaches an https site at all.
  const S = tls ? await startSite('S', (req, res) => (req.url === '/' ? html(res, '<link rel="icon" href="/s.png">') : req.url === '/s.png' ? reply(res, 'image/png', solidPng(99, 99, 99)) : notFound(res)), tls) : null

  // ---- the user's state is put back at the end ----
  const previous = { space: state().activeSpaceId, resolve: state().settings.resolveFavicons, blockAds: state().settings.blockAds, blockTrackers: state().settings.blockTrackers, sidebarVisible: state().settings.sidebarVisible }
  const favoritesBefore = state().favorites.map((f) => f.id)
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: true, sidebarVisible: true, ...adsBlockingPatch(false) } })
  browser.dispatch({ type: 'space/create', name: 'Icônes', emoji: '🖼️', hue: 150 })
  const spaceId = state().activeSpaceId
  const otherSpace = (() => {
    browser.dispatch({ type: 'space/create', name: 'Autre', emoji: '📎', hue: 20 })
    const id = state().activeSpaceId
    browser.dispatch({ type: 'space/select', id: spaceId })
    return id
  })()
  const favorite = (site: Site, title: string, extra: { faviconUrl?: string } = {}) => {
    browser.dispatch({ type: 'favorite/add', url: `${site.base}/section/page?x=1`, title, ...extra })
    return state().favorites.find((f) => f.title === title)!
  }
  const tabAt = (site: Site, path: string, pinned: boolean) => {
    browser.dispatch({ type: 'tab/open', url: `${site.base}${path}`, spaceId, background: true })
    const tab = state().tabs.at(-1)!
    if (pinned) browser.dispatch({ type: 'tab/pin', id: tab.id })
    return tab.id
  }
  const iconOfFavorite = (id: string) => state().favorites.find((f) => f.id === id)?.faviconUrl
  const iconOfTab = (id: string) => state().tabs.find((t) => t.id === id)?.faviconUrl

  const favA = favorite(A, 'Favori A')
  const favC = favorite(C, 'Favori C')
  const favD = favorite(D, 'Favori D')
  const favE = favorite(E, 'Favori E')
  const favF = favorite(F, 'Favori F')
  const favI = favorite(I, 'Favori I')
  const favG = G ? favorite(G, 'Favori G') : null
  const favJ = favorite(J, 'Favori J', { faviconUrl: 'https://own.example/propre.png' })
  const pinnedB = tabAt(B, '/docs/intro', true)
  const todayR = tabAt(R, '/une/page', false)
  const pinnedJ = tabAt(J, '/autre', true)
  browser.dispatch({ type: 'tab/update', id: pinnedJ, patch: { faviconUrl: 'data:image/png;base64,iVBORw0KGgo=' } })
  const favS = S ? favorite(S, 'Favori S') : null

  // ---- 1. in production a local host is not asked at all ----
  // Nothing names the test sites: they are on this machine, which the lookup never goes to. The wait is longer than the delay that
  // groups changes and the start-up delay together, so a lookup that was going to happen has happened.
  await sleep(3500)
  service.scan()
  const scanned = await lookupIdle(service)
  check('a favourite and a pinned tab on a local host are not asked for an icon: no request reaches the sites', scanned && hits.length === 0, JSON.stringify(hits.slice(0, 3)))
  check('…and no request was even counted', service.stats().requests === 0 && service.stats().attempted === 0, JSON.stringify(service.stats()))
  check('…so they still show the initial', iconOfFavorite(favA.id) === undefined && iconOfTab(pinnedB) === undefined)

  // ---- 2. the setting off asks for nothing, even for a host the test allows ----
  const allowed = [A, B, C, D, E, R, F, I, J, K, L, M, N, O, P, H, ...(G ? [G] : []), ...(S ? [S] : [])].map((s) => s.host).concat([otherHost])
  service.allowHostsForTest(allowed)
  /** The lookup the setting just switched back on, told again which local hosts it may ask. */
  const renew = (): void => {
    const fresh = browser.faviconLookup()
    if (!fresh) throw new Error('the lookup was not made when the setting went on')
    fresh.allowHostsForTest(allowed)
    service = fresh
  }
  const offLookup = service
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: false } })
  browser.dispatch({ type: 'space/select', id: otherSpace })
  browser.dispatch({ type: 'space/select', id: spaceId })
  offLookup.scan()
  // The witness: a lookup with the setting off empties its queue as it scans (favicon-service.ts, `scan`), and nothing of it runs any more.
  const offIdle = await lookupIdle(offLookup)
  check('with the setting off the lookup does not exist, and no site is asked even when the space is shown again', offIdle && browser.faviconLookup() === null && hits.length === 0 && offLookup.stats().requests === 0, JSON.stringify(offLookup.stats()))

  // ---- 3. the setting on, and a change of space: the favourites and the pinned tabs of the space shown are looked up ----
  await service.requestSession().cookies.set({ url: I.base, name: 'sid', value: 'secret' })
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: true } })
  renew()
  browser.dispatch({ type: 'space/select', id: otherSpace })
  browser.dispatch({ type: 'space/select', id: spaceId })
  const startedAt = Date.now()
  check('a favourite receives the icon its page declares', await waitFor(() => iconOfFavorite(favA.id) === `${A.base}/assets/a.png`), String(iconOfFavorite(favA.id)))
  check('a pinned tab receives the icon its page declares (a relative address, rel="shortcut icon")', await waitFor(() => iconOfTab(pinnedB) === `${B.base}/b.png`), String(iconOfTab(pinnedB)))
  check('a tab of Today receives it too', await waitFor(() => iconOfTab(todayR) === `${R.base}/r.png`), String(iconOfTab(todayR)))
  check('a page that declares no icon gets /favicon.ico', await waitFor(() => iconOfFavorite(favC.id) === `${C.base}/favicon.ico`), String(iconOfFavorite(favC.id)))
  check('a page with only an apple-touch-icon gets it', await waitFor(() => iconOfFavorite(favE.id) === `${E.base}/apple.png`), String(iconOfFavorite(favE.id)))
  check('an https site is reached like an http one', !!favS && (await waitFor(() => iconOfFavorite(favS.id) === `${S!.base}/s.png`)), String(favS && iconOfFavorite(favS.id)))
  check('the address kept is a short web address, not the picture (the state does not grow)', [iconOfFavorite(favA.id), iconOfTab(pinnedB), iconOfFavorite(favC.id)].every((u) => typeof u === 'string' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(u) && u.length < 80))

  // ---- 4. the lookups that must not give an icon ----
  await waitFor(() => rootHits('D') > 0 && hitsOf('D').some((h) => h.path === '/favicon.ico'))
  check('an icon that is gone and no /favicon.ico leave the favourite without one (the letter stays)', (await waitFor(() => service.stats().reasons['no-icon'] >= 1)) && iconOfFavorite(favD.id) === undefined, JSON.stringify(service.stats()))
  check('…D was asked for what its page declares and for /favicon.ico, nothing else', hitsOf('D').map((h) => h.path).sort().join() === ['/', '/favicon.ico', '/missing.png'].sort().join(), hitsOf('D').map((h) => h.path).join())

  await waitFor(() => hitsOf('F').length > 0)
  const slowStart = hitsOf('F')[0]?.at ?? startedAt
  const timedOut = await waitFor(() => service.stats().reasons.timeout >= 1, 12_000)
  const slowTook = Date.now() - slowStart
  check('a home page that never answers is given up on, and the favourite keeps the letter', timedOut && iconOfFavorite(favF.id) === undefined, `${slowTook} ms, ${JSON.stringify(service.stats().reasons)}`)
  check('…after 5 s: no sooner than 4.5 s, no later than 7.5 s after the request left', timedOut && slowTook >= 4500 && slowTook <= 7500, `${slowTook} ms`)
  check('…and only the home page of F was asked: a slow site is not pressed with more requests', hitsOf('F').length === 1, hitsOf('F').map((h) => h.path).join())

  check('the https site of the redirect check was started (it needs a certificate made with openssl)', favG !== null)
  if (favG) {
    await waitFor(() => rootHits('G') > 0)
    await waitFor(() => service.stats().reasons.refused >= 1)
    // The witness: the lookup of G has ended (a request to H would have been made inside it).
    await lookupIdle(service)
    check('a redirect from https to http is refused: the favourite has no icon and the http site is never asked', iconOfFavorite(favG.id) === undefined && hitsOf('H').length === 0 && service.stats().reasons.refused >= 1, `${JSON.stringify(service.stats().reasons)} H=${hitsOf('H').length}`)
  }

  // ---- 5. what a request carries ----
  await waitFor(() => iconOfFavorite(favI.id) === `${I.base}/i.png`)
  check('a site that sets cookies is looked up like the others', iconOfFavorite(favI.id) === `${I.base}/i.png`, String(iconOfFavorite(favI.id)))
  const jar = (await service.requestSession().cookies.get({})).map((c) => c.name).sort()
  check('no cookie is sent, though one was put in the lookup session for that very site, and none the site sets is kept', hitsOf('I').length >= 2 && hitsOf('I').every((h) => h.cookie === null) && jar.join() === 'sid', `${hitsOf('I').map((h) => h.cookie).join('|')} jar=${jar.join()}`)
  check('no Referer, no authorization, only GET, on any request', hits.length > 0 && hits.every((h) => h.referer === null && h.authorization === null && h.method === 'GET'), JSON.stringify(hits.find((h) => h.referer !== null || h.authorization !== null || h.method !== 'GET')))
  check('a site is asked once for its home page', ['A', 'B', 'C', 'D', 'E', 'I', 'R'].every((site) => rootHits(site) === 1), ['A', 'B', 'C', 'D', 'E', 'I', 'R'].map((site) => `${site}:${rootHits(site)}`).join(' '))
  check('nothing found is a data: address: the picture is not copied into the file', [iconOfFavorite(favA.id), iconOfFavorite(favC.id), iconOfFavorite(favE.id), iconOfTab(pinnedB)].every((u) => typeof u === 'string' && !u.startsWith('data:')))

  // ---- 6. an icon that is there is never replaced ----
  check('a favourite that has an icon keeps it, and its site is never asked', iconOfFavorite(favJ.id) === 'https://own.example/propre.png' && hitsOf('J').length === 0, `${iconOfFavorite(favJ.id)} hits=${hitsOf('J').length}`)
  check('a tab that has an icon keeps it', iconOfTab(pinnedJ) === 'data:image/png;base64,iVBORw0KGgo=')
  // K takes 1.5 s to answer: its tab is added only now, so that the request is still out when the tab is given its own icon (as its page would).
  const todayK = tabAt(K, '/lent', false)
  service.scan()
  check('the request for K is out before the tab has an icon', await waitFor(() => hitsOf('K').length > 0, 4000) && !hitsOf('K').some((h) => h.path === '/k.png'))
  browser.dispatch({ type: 'tab/update', id: todayK, patch: { faviconUrl: `${K.base}/ceux-de-la-page.png` } })
  await waitFor(() => hitsOf('K').some((h) => h.path === '/k.png'), 6000)
  // The witness: the lookup of K has ended, and handed its answer over if it was to.
  await lookupIdle(service)
  check('an icon the page gave while the lookup was under way is not replaced by the answer', hitsOf('K').some((h) => h.path === '/k.png') && iconOfTab(todayK) === `${K.base}/ceux-de-la-page.png`, `${hitsOf('K').map((h) => h.path).join()} -> ${iconOfTab(todayK)}`)

  // ---- 7. the sidebar shows them ----
  const grid = () =>
    evaluate<Array<{ id: string; img: boolean; loaded: boolean; letter: string }>>(
      `[...document.querySelectorAll('.favorite')].map((f) => { const img = f.querySelector('img.favicon'); return { id: f.dataset.favorite, img: !!img, loaded: img ? img.complete && img.naturalWidth > 0 : false, letter: f.querySelector('.favicon.monogram')?.textContent ?? '' } })`
    )
  const shown = async (id: string) => (await grid()).find((g) => g.id === id)
  await waitFor(async () => (await shown(favA.id))?.loaded === true, 6000)
  const [gridA, gridC, gridE, gridD, gridF] = await Promise.all([shown(favA.id), shown(favC.id), shown(favE.id), shown(favD.id), shown(favF.id)])
  check('the favourites grid draws the icons found (the picture loads)', !!gridA?.loaded && !!gridC?.loaded && !!gridE?.loaded, JSON.stringify([gridA, gridC, gridE]))
  check('…and keeps the monogram (the first letter of the site) for the favourites that have none', !!gridD && !gridD.img && gridD.letter !== '' && !!gridF && !gridF.img && gridF.letter !== '', JSON.stringify([gridD, gridF]))

  // ---- 8. a private window asks for nothing ----
  const manager = getWindowManager()
  const priv = manager.openPrivate()
  check('a private window has no lookup', priv.browser.faviconLookup() === null)
  priv.browser.dispatch({ type: 'tab/open', url: `${L.base}/privee`, background: true })
  const privTab = priv.store.get().tabs.at(-1)
  priv.browser.dispatch({ type: 'favicon/fill', entries: [{ kind: 'tab', id: privTab?.id ?? '', origin: L.base, faviconUrl: `${L.base}/l.png` }] })
  service.scan()
  // The witness: the lookup of the main window has scanned (the private tab is not among what it sees) and nothing of it runs; the private
  // window has none, and the reducer of its state refused the icon as it was dispatched.
  await lookupIdle(service)
  check('…nothing is asked of its sites, and an icon cannot be written into it', rootHits('L') === 0 && !hitsOf('L').some((h) => h.path === '/l.png') && !!privTab && priv.store.get().tabs.find((t) => t.id === privTab.id)?.faviconUrl === undefined, hitsOf('L').map((h) => h.path).join())
  priv.win.close()
  await waitFor(() => manager.privateWindows().length === 0)
  await manager.settled()
  win.emit('focus')

  // ---- 9. the setting off, then on again, for a site not yet asked ----
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: false } })
  const favM = favorite(M, 'Favori M')
  // No wait: with the setting off the lookup does not exist (its gate drops it at once), and it is the only one that asks.
  check('a favourite added while the setting is off is not looked up', browser.faviconLookup() === null && hitsOf('M').length === 0 && iconOfFavorite(favM.id) === undefined, `hits=${hitsOf('M').length}`)
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: true } })
  renew()
  check('…and is, as soon as the setting is back on', await waitFor(() => iconOfFavorite(favM.id) === `${M.base}/m.png`), String(iconOfFavorite(favM.id)))

  // ---- 10. the request blocker has its say about the icon, not about the home page ----
  const favP = favorite(P, 'Favori P')
  check('control: an icon on another host is taken when nothing blocks it', await waitFor(() => iconOfFavorite(favP.id) === `http://${otherHost}/p.png`), String(iconOfFavorite(favP.id)))
  browser.setExtraBlockedHosts(['localhost'])
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
  const otherHitsBefore = hitsOf('O').length
  const favN = favorite(N, 'Favori N')
  check('an icon the blocker would cancel in a page is not asked for: /favicon.ico of the site is used instead', await waitFor(() => iconOfFavorite(favN.id) === `${N.base}/favicon.ico`), String(iconOfFavorite(favN.id)))
  check('…the blocked host received nothing', hitsOf('O').length === otherHitsBefore, `${hitsOf('O').length} vs ${otherHitsBefore}`)
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
  browser.setExtraBlockedHosts([])

  // ---- 11. the interface asks no site: it draws the copy the main process keeps of an icon ----
  const drawnSources = await evaluate<string[]>(`[...document.querySelectorAll('.favorite img.favicon')].map((image) => image.src)`)
  check('every icon the favourites grid draws is asked of the main process, under its own scheme: none is the address of a site', drawnSources.length >= 3 && drawnSources.every((source) => source.startsWith('lucium-icon://site/?u=') || source.startsWith('data:image/')), JSON.stringify(drawnSources.slice(0, 4)))
  // The lookup read the picture of A once to check it; the copy the grid draws is those bytes, and the site was not asked again.
  check('…and the icon of a favourite that was looked up was asked of its site once in all', hitsOf('A').filter((h) => h.path === '/assets/a.png').length === 1, hitsOf('A').map((h) => h.path).join())
  // U serves a picture nothing of the state names. The interface may load no picture of the web, and the main process downloads none it is merely asked for.
  const U = await startSite('U', (req, res) => (req.url === '/u.png' ? reply(res, 'image/png', solidPng(7, 7, 7)) : notFound(res)))
  const tryImage = (address: string) => evaluate<string>(`new Promise((resolve) => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('error'); image.src = ${JSON.stringify(address)} })`)
  const direct = await tryImage(`${U.base}/u.png`)
  check('the interface cannot load a picture from a site: its policy refuses it, and the site receives nothing', direct === 'error' && hitsOf('U').length === 0, `${direct} hits=${hitsOf('U').length}`)
  const unnamed = await tryImage(`lucium-icon://site/?u=${encodeURIComponent(`${U.base}/u.png`)}`)
  check('an icon nothing of the state shows is not downloaded for the interface either', unnamed === 'error' && hitsOf('U').length === 0, `${unnamed} hits=${hitsOf('U').length}`)

  // V is opened in a tab: its page sets a cookie and declares an icon. The copy is downloaded by the session of the tab's profile, as the page itself asks for it.
  const V = await startSite('V', (req, res) => (req.url === '/page' ? html(res, '<link rel="icon" type="image/png" href="/v.png">', { 'set-cookie': 'profil=1; Path=/' }) : req.url === '/v.png' ? reply(res, 'image/png', solidPng(40, 90, 200), { 'cache-control': 'no-store' }) : notFound(res)))
  browser.dispatch({ type: 'tab/open', url: `${V.base}/page`, spaceId })
  const tabV = state().tabs.at(-1)!.id
  check('a tab receives the icon its page declares, as a web address (the state does not hold the picture)', await waitFor(() => iconOfTab(tabV) === `${V.base}/v.png`), String(iconOfTab(tabV)))
  const rowOfV = () => evaluate<{ source: string; loaded: boolean } | null>(`(() => { const image = document.querySelector('.tab[data-id=${JSON.stringify(tabV)}] img.favicon'); return image ? { source: image.src, loaded: image.complete && image.naturalWidth > 0 } : null })()`)
  const rowDrawn = await waitFor(async () => (await rowOfV())?.loaded === true, 8000)
  const row = await rowOfV()
  check('its row draws the copy of the main process (the picture loads)', rowDrawn && row?.source === `lucium-icon://site/?u=${encodeURIComponent(`${V.base}/v.png`)}`, JSON.stringify(row))
  const iconHits = hitsOf('V').filter((h) => h.path === '/v.png')
  // The page asks for its own icon and the main process for its copy: with `no-store` both reach the site, and both are the profile's.
  // The sites of this suite share one host (127.0.0.1), so the jar of the profile may hold other cookies for it: the one of the page is looked for among them.
  check('the icon was asked by the session of the profile: with the cookie the page set, as a Chrome, without a Referer', iconHits.length >= 1 && iconHits.length <= 2 && iconHits.every((h) => (h.cookie ?? '').split('; ').includes('profil=1') && h.referer === null && /Chrome\/\d+/.test(h.userAgent ?? '') && !/Electron|Lucium/i.test(h.userAgent ?? '')), JSON.stringify(iconHits.map((h) => [h.cookie, h.referer, h.userAgent])))
  const again = await tryImage(`lucium-icon://site/?u=${encodeURIComponent(`${V.base}/v.png`)}`)
  check('asked again, the copy is served without another request to the site', again === 'loaded' && hitsOf('V').filter((h) => h.path === '/v.png').length === iconHits.length, `${again} ${hitsOf('V').filter((h) => h.path === '/v.png').length} vs ${iconHits.length}`)
  browser.dispatch({ type: 'tab/close', id: tabV })

  // ---- the end: everything put back ----
  await service.idle()
  service.allowHostsForTest([])
  for (const id of state().favorites.map((f) => f.id)) if (!favoritesBefore.includes(id)) browser.dispatch({ type: 'favorite/remove', id })
  browser.dispatch({ type: 'settings/update', patch: { resolveFavicons: previous.resolve, blockAds: previous.blockAds, blockTrackers: previous.blockTrackers, sidebarVisible: previous.sidebarVisible } })
  for (const tab of state().tabs.filter((t) => t.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: tab.id })
  browser.dispatch({ type: 'space/select', id: previous.space })
  browser.dispatch({ type: 'space/delete', id: spaceId })
  browser.dispatch({ type: 'space/delete', id: otherSpace })
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const cleanup of cleanups) cleanup()
  check('the favourites, the spaces and the settings are as the run found them', state().favorites.length === favoritesBefore.length && state().activeSpaceId === previous.space && state().settings.resolveFavicons === previous.resolve)
}

/** The same checks with their own report, for `LUCIUM_SMOKE_ONLY=favicons` and for the full chain in index.ts. */
export async function runFaviconsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.win.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_FAVICONS_VERBOSE'] === '1'
    await smokeFavicons(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`FAVICONS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeFavicons ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_FAVICONS ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

// ---------- the measure on a real state ----------

/**
 * Looks up every favourite and every pinned or Today tab of the state the application was started with (a copy of a real one: its
 * pages are not opened, nothing is written back to the user's file), with the production rules and the real network, and prints
 * counts only: no title, no address. `LUCIUM_SMOKE_ONLY=favicons-measure`.
 */
export async function runFaviconsMeasure(ctx: SmokeContext): Promise<number> {
  // The window's own lookup would ask the same sites a second time and fill the copy: only this measure runs.
  ctx.browser.faviconLookup()?.stop()
  const full = ctx.store.get()
  const views = full.spaces.map((space) => ({ ...full, activeSpaceId: space.id }))
  const jobs = iconsWanted(views, () => false)
  const kinds = { favorite: 0, pinned: 0, today: 0 }
  for (const job of jobs) kinds[job.rank === 0 ? 'favorite' : job.rank === 1 ? 'pinned' : 'today']++
  const rankOf = new Map(jobs.map((job) => [job.id, job.rank]))
  const found = { favorite: 0, pinned: 0, today: 0 }
  const origins = new Set<string>()
  const started = Date.now()
  const resolver = new FaviconResolver({
    fetch: requestFetch(session.fromPartition('lucium-favicons-measure')),
    enabled: () => true,
    deliver: (ids) => {
      for (const id of ids) found[rankOf.get(id) === 0 ? 'favorite' : rankOf.get(id) === 1 ? 'pinned' : 'today']++
    }
  })
  const accepted: IconJob[] = []
  for (const job of jobs) {
    const origin = URL.canParse(job.url) ? new URL(job.url) : null
    if (origin) origins.add(origin.origin)
    accepted.push(job)
  }
  resolver.enqueue(accepted)
  await resolver.idle()
  const stats = resolver.stats()
  const seconds = Math.round((Date.now() - started) / 100) / 10
  const itemsFound = found.favorite + found.pinned + found.today
  console.log(
    `LUCIUM_FAVICONS_MEASURE ${JSON.stringify({
      spaces: full.spaces.length,
      items: { ...kinds, total: jobs.length },
      itemsWithIcon: { ...found, total: itemsFound },
      hostsDistinct: origins.size,
      hostsAsked: stats.attempted,
      hostsFound: stats.found,
      hostsFailed: stats.failed,
      reasons: stats.reasons,
      causes: stats.causes,
      requests: stats.requests,
      seconds
    })}`
  )
  return 0
}
