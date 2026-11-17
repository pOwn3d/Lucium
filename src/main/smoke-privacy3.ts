// Engine checks for privacy features, run inside a real Electron against a local server: the copy of an address without
// tracking parameters, the history that is not recorded, encrypted DNS and the proxy applied to real sessions (an HTTP proxy and a SOCKS5
// proxy of our own count the requests that go through them), the cookies by site, and the private tabs of a normal window (their own
// session, no history, no archive, nothing in the state file). Called from the engine smoke test: `await smokePrivacy3(ctx, check)`.

import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, Menu, session, type MenuItem, type WebContents } from 'electron'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

function findMenuItem(label: string): MenuItem | undefined {
  const walk = (items: readonly MenuItem[]): MenuItem | undefined => {
    for (const item of items) {
      if (item.label === label) return item
      const inner = item.submenu ? walk(item.submenu.items) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return walk(Menu.getApplicationMenu()?.items ?? [])
}

/** A SOCKS5 proxy with no login: it answers the greeting, reads the request, and joins the client to the local server whatever name was asked for. */
function socksServer(targetPort: number, log: string[]): NetServer {
  return createNetServer((client) => {
    client.on('error', () => {})
    client.once('data', () => {
      client.write(Buffer.from([5, 0]))
      client.once('data', (request: Buffer) => {
        const atyp = request[3]
        const host = atyp === 3 ? request.subarray(5, 5 + request[4]!).toString() : atyp === 1 ? [...request.subarray(4, 8)].join('.') : '?'
        log.push(host)
        const upstream: Socket = netConnect(targetPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
  })
}

export async function smokePrivacy3(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, history, win, overlayView } = ctx
  const ui: WebContents = overlayView.webContents
  const state = () => store.get()
  const originalSpace = state().activeSpaceId
  const settingsBefore = state().settings

  // ---- the servers: the site (cookies, links), an HTTP proxy (counts, can ask for a login), a SOCKS5 proxy (counts) ----
  const seen: Array<{ host: string; path: string; cookie: string }> = []
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push({ host: (req.headers.host ?? '').replace(/:\d+$/, ''), path: url.pathname + url.search, cookie: req.headers.cookie ?? '' })
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/cookies') res.setHeader('set-cookie', ['smoke_a=SECRETVALUE-aaa; Path=/', 'smoke_b=SECRETVALUE-bb; Path=/x', 'smoke_c=SECRETVALUE-c; Path=/; Max-Age=3600'])
    if (url.pathname === '/priv') res.setHeader('set-cookie', 'priv_cookie=PRIVSECRET; Path=/')
    if (url.pathname === '/echo') return void res.end(`<title>echo</title><body id="b">[${req.headers.cookie ?? ''}]</body>`)
    res.end(`<title>p3 ${url.searchParams.get('id') ?? url.pathname}</title><body>ok <a id="l" href="/target?utm_source=news&fbclid=abc&keep=1">lien</a></body>`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const sitePort = (site.address() as AddressInfo).port
  const base = `http://127.0.0.1:${sitePort}`

  const proxyLog: Array<{ url: string; auth: string }> = []
  let proxyAsksLogin = false
  const proxy = createServer((req: IncomingMessage, res) => {
    proxyLog.push({ url: req.url ?? '', auth: String(req.headers['proxy-authorization'] ?? '') })
    if (proxyAsksLogin && !req.headers['proxy-authorization']) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy de fumée"', 'content-length': '0' })
      return void res.end()
    }
    const target = new URL(req.url ?? '/')
    const upstream = httpRequest({ host: '127.0.0.1', port: sitePort, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as AddressInfo).port
  const socksLog: string[] = []
  const socks = socksServer(sitePort, socksLog)
  await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve))
  const socksPort = (socks.address() as AddressInfo).port

  const mine = new Set<string>()
  const titleOf = (id: string) => state().tabs.find((t) => t.id === id)?.title
  const open = async (url: string, options: { private?: boolean; title?: string } = {}): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url, ...(options.private ? { private: true } : {}) })
    const tab = state().tabs.at(-1)!
    mine.add(tab.id)
    if (options.title) await waitFor(() => titleOf(tab.id) === options.title)
    else await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false)
    return tab.id
  }
  const bodyOf = async (id: string): Promise<string> => {
    const wc = (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
    return wc ? String(await wc.executeJavaScript('document.body.innerText')) : ''
  }
  const stateFile = (): string => readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8')
  const warnings: string[] = []
  const realWarn = console.warn
  const realError = console.error
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  const errors: string[] = []
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
    realError(...args)
  }

  // Everything below happens in a space of its own, on a profile of its own: its cookie jar and history start empty, and are the only ones touched.
  browser.dispatch({ type: 'space/create', name: 'Fumée vie privée', emoji: '🧪', hue: 30, profileId: 'smoke-p3' })
  const space = state().activeSpaceId
  // What Chromium is really given: the spy sits on Electron's own call, below the engine, which turns "no settings" into Chromium's defaults.
  const spyHostResolver: Array<unknown> = []
  let spying = true
  const realSetHostResolver = engine.setHostResolver.bind(engine)
  const realConfigureHostResolver = app.configureHostResolver.bind(app)
  const proxyCalls: Array<unknown> = []
  const realSetProxies = engine.setProxies.bind(engine)

  try {
    // ---------------------------------------------------------------------------------------------------------------------------------
    // copied addresses lose their tracking parameters (a setting, on for a new profile since « Renforcée » is its protection: set off here first)
    // ---------------------------------------------------------------------------------------------------------------------------------
    const tracked = `${base}/page?id=copy&utm_source=nl&fbclid=zz&keep=1`
    const cleanCopy = `${base}/page?id=copy&keep=1`
    const clip = async (): Promise<string> => await clipboard.readText()
    // Off before the page opens: « Renforcée » also takes the parameters off the address opened, and the tab would hold a clean address to copy.
    browser.dispatch({ type: 'settings/update', patch: { stripTrackingParams: false, stripCopiedLinks: false } })
    const copyTab = await open(tracked, { title: 'p3 copy' })
    await browser.copyUrl('plain')
    check('privacy3 copy: with the setting off, the address is copied as it is', state().settings.stripCopiedLinks === false && (await clip()) === tracked, await clip())
    browser.dispatch({ type: 'settings/update', patch: { stripCopiedLinks: true } })
    await browser.copyUrl('plain')
    check('privacy3 copy: with the setting on, Copy Address leaves only the tracking parameters out', (await clip()) === cleanCopy, await clip())
    findMenuItem('Copier l’adresse en Markdown')?.click()
    check('privacy3 copy: the Markdown copy of the Edit menu uses the cleaned address too', await waitFor(async () => (await clip()).endsWith(`(${cleanCopy})`)), await clip())
    await clipboard.writeText('')
    await win.webContents.executeJavaScript('window.lucium.copyUrl()')
    await waitFor(async () => (await clip()) !== '')
    check('privacy3 copy: the toolbar’s route (the interface asks through the preload) cleans it as well', (await clip()) === cleanCopy, await clip())
    const events = (browser.pageFor(copyTab) as unknown as { events: { copyLink?: (url: string) => string } }).events
    check('privacy3 copy: the page’s own menu (“Copier l’adresse du lien”) asks the browser to clean the address; a non-tracking link is untouched', events.copyLink?.(`${base}/target?utm_source=news&fbclid=abc&keep=1`) === `${base}/target?keep=1` && events.copyLink?.(`${base}/t?page=2`) === `${base}/t?page=2`)
    browser.dispatch({ type: 'settings/update', patch: { stripCopiedLinks: false } })
    check('privacy3 copy: back off, the page’s menu copies the address as it is', events.copyLink?.(`${base}/t?utm_source=x`) === `${base}/t?utm_source=x`)

    // ---------------------------------------------------------------------------------------------------------------------------------
    // history that is not recorded (a setting, off by default; a profile can say otherwise)
    // ---------------------------------------------------------------------------------------------------------------------------------
    // The history is read as entries and compared as text: `search()` is the command bar’s loose matcher (the letters of a query in order are enough),
    // which in a process where earlier suites visited many pages finds entries that merely contain the letters. Whether a page was recorded is an exact question.
    const visits = (profile: string): string[] => history.of(profile).search('', 1_000_000).map((entry) => entry.url)
    const visited = (profile: string, token: string): boolean => visits(profile).some((url) => url.includes(token))
    await open(`${base}/page?id=hist-before`, { title: 'p3 hist-before' })
    check('privacy3 history: by default a visited page is recorded', state().settings.historyOff === false && (await waitFor(() => visited('smoke-p3', 'hist-before'))))
    browser.dispatch({ type: 'settings/update', patch: { historyOff: true } })
    const offVisit = await open(`${base}/page?id=hist-off`, { title: 'p3 hist-off' })
    // The witness: the end of the load reported to the shell, which records the visit or not as it takes that report (shell/browser-pages.ts).
    await waitFor(() => browser.snapshot().runtime.tabs[offVisit]?.loading === false)
    check('privacy3 history: with the setting on, the next visit is not recorded and what was there stays', !visited('smoke-p3', 'hist-off') && visited('smoke-p3', 'hist-before'))
    browser.dispatch({ type: 'settings/update', patch: { profiles: { ...state().settings.profiles, 'smoke-p3': { historyOff: false } } } })
    await open(`${base}/page?id=hist-own`, { title: 'p3 hist-own' })
    check('privacy3 history: a profile that says otherwise records its own visits', await waitFor(() => visited('smoke-p3', 'hist-own')))
    browser.dispatch({ type: 'settings/update', patch: { historyOff: false, profiles: Object.fromEntries(Object.entries(state().settings.profiles).filter(([id]) => id !== 'smoke-p3')) } })

    // ---------------------------------------------------------------------------------------------------------------------------------
    // encrypted DNS (nothing configured while the switch is off)
    // ---------------------------------------------------------------------------------------------------------------------------------
    app.configureHostResolver = (options) => {
      if (spying) spyHostResolver.push(options)
      return realConfigureHostResolver(options)
    }
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: !state().settings.hoverCards } })
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: !state().settings.hoverCards } })
    check('privacy3 dns: off by default, and nothing is asked of Chromium however often the settings change', state().settings.dohCustom === false && spyHostResolver.length === 0)
    browser.dispatch({ type: 'settings/update', patch: { dohCustom: true, dohMode: 'automatic', dohProvider: 'cloudflare' } })
    check('privacy3 dns: switched on, the chosen server is given to Chromium in automatic mode', spyHostResolver.length === 1 && JSON.stringify(spyHostResolver[0]) === JSON.stringify({ secureDnsMode: 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] }), JSON.stringify(spyHostResolver))
    warnings.length = 0
    browser.dispatch({ type: 'settings/update', patch: { dohMode: 'secure', dohProvider: 'system' } })
    check('privacy3 dns: “Activé” without a server is refused: nothing is applied and the log says why', spyHostResolver.length === 1 && warnings.some((w) => w.includes('[network] encrypted DNS not applied') && w.includes('exige un serveur')), JSON.stringify({ calls: spyHostResolver.length, warnings }))
    browser.dispatch({ type: 'settings/update', patch: { dohProvider: 'custom', dohCustomUrl: 'https://dns.example.org/dns-query' } })
    check('privacy3 dns: with an https address of its own, the secure mode is applied', spyHostResolver.length === 2 && JSON.stringify(spyHostResolver[1]) === JSON.stringify({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.example.org/dns-query'] }), JSON.stringify(spyHostResolver))
    browser.dispatch({ type: 'settings/update', patch: { dohCustomUrl: 'http://dns.example.org/dns-query' } })
    check('privacy3 dns: a plain http address does not even stay in the settings', state().settings.dohCustomUrl === '' && spyHostResolver.length === 2)
    errors.length = 0
    spying = false
    const refusal = realSetHostResolver({ secureDnsMode: 'bogus' } as never)
    spying = true
    check('privacy3 dns: a refusal of Chromium comes back as a reason, and is logged with its context', typeof refusal === 'string' && errors.some((e) => e.includes('[engine] cannot configure encrypted DNS')), JSON.stringify({ refusal, errors: errors.slice(0, 2) }))
    browser.dispatch({ type: 'settings/update', patch: { dohCustom: false } })
    check('privacy3 dns: switched off again, Chromium’s defaults are put back (automatic, no server)', spyHostResolver.length === 3 && JSON.stringify(spyHostResolver[2]) === JSON.stringify({ secureDnsMode: 'automatic', secureDnsServers: [] }), JSON.stringify(spyHostResolver))
    app.configureHostResolver = realConfigureHostResolver

    // ---------------------------------------------------------------------------------------------------------------------------------
    // the proxy, on real sessions
    // ---------------------------------------------------------------------------------------------------------------------------------
    engine.setProxies = (plan) => {
      proxyCalls.push(plan)
      return realSetProxies(plan)
    }
    const viaProxy = (id: string) => `http://proxy-target.test:${sitePort}/page?id=${id}`
    const viaSocks = (id: string) => `http://socks-target.test:${sitePort}/page?id=${id}`
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: !state().settings.hoverCards } })
    check('privacy3 proxy: off by default, and nothing is applied to any session however often the settings change', state().settings.proxyEnabled === false && proxyCalls.length === 0)
    const direct = await open(viaProxy('no-proxy'))
    check('privacy3 proxy: without a proxy the name of the test site does not resolve (the control of the checks that follow)', titleOf(direct) !== 'p3 no-proxy' && proxyLog.length === 0 && !seen.some((s) => s.host === 'proxy-target.test'), `title=${titleOf(direct)}`)

    browser.dispatch({ type: 'settings/update', patch: { proxyEnabled: true, proxy: { mode: 'manual', address: `127.0.0.1:${proxyPort}`, bypass: '' } } })
    check('privacy3 proxy: the address typed is kept in its written form, without any login', state().settings.proxy.address === `http://127.0.0.1:${proxyPort}`)
    const throughHttp = await open(viaProxy('http-proxy'), { title: 'p3 http-proxy' })
    check('privacy3 proxy: with an HTTP proxy, the page loads through it (the proxy saw the absolute address, the site saw the proxied host name)', titleOf(throughHttp) === 'p3 http-proxy' && proxyLog.some((p) => p.url === viaProxy('http-proxy')) && seen.some((s) => s.host === 'proxy-target.test' && s.path.includes('http-proxy')), JSON.stringify({ title: titleOf(throughHttp), proxyLog: proxyLog.slice(0, 3) }))

    browser.dispatch({ type: 'settings/update', patch: { proxy: { mode: 'manual', address: `socks5://127.0.0.1:${socksPort}`, bypass: '' } } })
    const throughSocks = await open(viaSocks('socks-proxy'), { title: 'p3 socks-proxy' })
    check('privacy3 proxy: with a SOCKS5 proxy, the page loads through it and the proxy was asked for the name, not an address', titleOf(throughSocks) === 'p3 socks-proxy' && socksLog.includes('socks-target.test'), JSON.stringify({ title: titleOf(throughSocks), socksLog }))

    // A profile whose session is made after the proxy was set: its very first page already goes through it.
    browser.dispatch({ type: 'space/create', name: 'Fumée proxy', emoji: '🧦', hue: 90, profileId: 'smoke-p3b' })
    const lateSpace = state().activeSpaceId
    const lateTab = await open(viaSocks('late-profile'), { title: 'p3 late-profile' })
    check('privacy3 proxy: a profile whose session is created after the proxy was set uses it from its first page', titleOf(lateTab) === 'p3 late-profile' && socksLog.filter((h) => h === 'socks-target.test').length >= 2, `title=${titleOf(lateTab)}`)
    browser.dispatch({ type: 'tab/close', id: lateTab })
    browser.dispatch({ type: 'space/delete', id: lateSpace })
    browser.dispatch({ type: 'space/select', id: space })

    // A profile of its own: a global SOCKS proxy for everyone, "no proxy" for this profile.
    const countBefore = socksLog.length
    browser.dispatch({ type: 'settings/update', patch: { profiles: { ...state().settings.profiles, 'smoke-p3': { proxy: { mode: 'direct', address: '', bypass: '' } } } } })
    const ownDirect = await open(viaSocks('profile-direct'))
    // The witness: the load ending in its failure (without the proxy the test name resolves nowhere); a page that went through the proxy would
    // have loaded instead, which the check below sees.
    await waitFor(() => browser.pageFor(ownDirect)?.loadFailure() != null)
    // The site is the judge, not the proxy’s count: another session may still ask the proxy for something (an icon, a kept-alive connection) while the page is loaded.
    check('privacy3 proxy: a profile with its own “no proxy” does not use the global proxy (its page never reaches the site through it)', titleOf(ownDirect) !== 'p3 profile-direct' && !seen.some((s) => s.path.includes('profile-direct')), `title=${titleOf(ownDirect)} socks=${JSON.stringify(socksLog.slice(countBefore))} seen=${JSON.stringify(seen.filter((s) => s.path.includes('profile-direct')))}`)
    browser.dispatch({ type: 'settings/update', patch: { profiles: { ...state().settings.profiles, 'smoke-p3': { proxy: { mode: 'manual', address: `http://127.0.0.1:${proxyPort}`, bypass: '' } } } } })
    const ownHttp = await open(viaProxy('profile-http'), { title: 'p3 profile-http' })
    check('privacy3 proxy: a profile with a proxy of its own uses it instead of the global one', titleOf(ownHttp) === 'p3 profile-http' && proxyLog.some((p) => p.url === viaProxy('profile-http')))
    browser.dispatch({ type: 'settings/update', patch: { profiles: Object.fromEntries(Object.entries(state().settings.profiles).filter(([id]) => id !== 'smoke-p3')) } })

    // A proxy that asks for a login: the sign-in prompt appears, the answer goes to the proxy and nowhere else.
    proxyAsksLogin = true
    browser.dispatch({ type: 'settings/update', patch: { proxy: { mode: 'manual', address: `http://127.0.0.1:${proxyPort}`, bypass: '' } } })
    const askedTab = await open(viaProxy('proxy-login'))
    const asked = await waitFor(() => browser.currentPanel() === 'auth', 10_000)
    const request = browser.currentOverlay()
    const secret = 'mdp-proxy-de-fumee-8d41'
    check('privacy3 proxy: a proxy that asks for a login makes the sign-in prompt appear, and says it is the proxy', asked && request?.panel === 'auth' && request.request.isProxy === true, JSON.stringify(request))
    if (request?.panel === 'auth') browser.answerAuth(request.request.id, { username: 'fumee', password: secret })
    check('privacy3 proxy: once answered, the page loads and the proxy received the login', (await waitFor(() => titleOf(askedTab) === 'p3 proxy-login')) && proxyLog.some((p) => p.auth === `Basic ${Buffer.from(`fumee:${secret}`).toString('base64')}`), `title=${titleOf(askedTab)}`)
    store.flush()
    check('privacy3 proxy: no login of the proxy is in the state, its file or the log', !JSON.stringify(state()).includes(secret) && !stateFile().includes(secret) && !errors.some((e) => e.includes(secret)) && !warnings.some((w) => w.includes(secret)))
    proxyAsksLogin = false

    // The sessions the shell requests with on its own (icon lookups, live folders) follow the global proxy too: they were left on the system's route.
    browser.dispatch({ type: 'settings/update', patch: { liveFolders: true } })
    const ownRoute = async (partition: string): Promise<string> => await session.fromPartition(partition).resolveProxy(viaProxy('own-session'))
    const onGlobalProxy = async (partition: string): Promise<boolean> => (await waitFor(async () => (await ownRoute(partition)).includes(`127.0.0.1:${proxyPort}`), 5_000))
    check('privacy3 proxy: the session of the icon lookups uses the global proxy (it used to leave by the system’s route)', await onGlobalProxy('lucium-favicons'), await ownRoute('lucium-favicons'))
    check('privacy3 proxy: the session of the live folders uses the global proxy too', await onGlobalProxy('lucium-live-folders'), await ownRoute('lucium-live-folders'))
    browser.dispatch({ type: 'settings/update', patch: { liveFolders: false } })

    // The facultative test reaches the proxy only.
    const testOk = (await win.webContents.executeJavaScript(`window.lucium.testProxy(${JSON.stringify(`127.0.0.1:${proxyPort}`)})`)) as { ok: boolean }
    const closedPort = (await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port
        probe.close(() => resolve(port))
      })
    }))
    const testRefused = (await win.webContents.executeJavaScript(`window.lucium.testProxy(${JSON.stringify(`127.0.0.1:${closedPort}`)})`)) as { ok: boolean; error?: string }
    const testBad = (await win.webContents.executeJavaScript(`window.lucium.testProxy('http://user:secret@127.0.0.1:1')`)) as { ok: boolean; error?: string }
    check('privacy3 proxy: the test says a listening server answers, a closed port refuses, and an address with a login is never connected to', testOk.ok && !testRefused.ok && testRefused.error === 'connexion refusée' && !testBad.ok && testBad.error === 'adresse non valide', JSON.stringify({ testOk, testRefused, testBad }))

    // A private window follows the global proxy too.
    const privateRecord = getWindowManager().openPrivate()
    await waitFor(() => !privateRecord.win.webContents.isLoading())
    const proxiedBefore = proxyLog.length
    privateRecord.browser.dispatch({ type: 'tab/open', url: viaProxy('private-window') })
    const privateTabId = privateRecord.store.get().tabs.at(-1)!.id
    const privateLoaded = await waitFor(() => privateRecord.store.get().tabs.find((t) => t.id === privateTabId)?.title === 'p3 private-window')
    check('privacy3 proxy: a private window’s own session uses the global proxy too', privateLoaded && proxyLog.length > proxiedBefore)

    // Cookies by site, from the private window: refused (it has no profile whose cookies to manage).
    const refusedInPrivate = await privateRecord.win.webContents.executeJavaScript(`window.lucium.cookieSites().then(() => 'answered', () => 'refused')`)
    check('privacy3 cookies: the private window cannot list the cookies of a profile', refusedInPrivate === 'refused')
    privateRecord.win.close()
    await getWindowManager().settled()

    // Back off: every session goes back to the system's route.
    browser.dispatch({ type: 'settings/update', patch: { proxyEnabled: false } })
    await sleep(800)
    const afterOff = await open(viaProxy('after-off'))
    check('privacy3 proxy: switched off, the sessions go back to the system’s route (the test name no longer resolves)', titleOf(afterOff) !== 'p3 after-off' && proxyCalls.length >= 2, `title=${titleOf(afterOff)} calls=${proxyCalls.length}`)
    engine.setProxies = realSetProxies

    // ---------------------------------------------------------------------------------------------------------------------------------
    // cookies by site, the list to keep, the clean-up
    // ---------------------------------------------------------------------------------------------------------------------------------
    await open(`${base}/cookies`, { title: 'p3 /cookies' })
    await open(`http://localhost:${sitePort}/cookies`, { title: 'p3 /cookies' })
    await sleep(300)
    const sites = await browser.cookieSites()
    const local = sites.find((s) => s.host === 'localhost')
    const loopback = sites.find((s) => s.host === '127.0.0.1')
    check('privacy3 cookies: the profile’s cookies are listed by site, with their count and size', local?.count === 3 && loopback?.count === 3 && local.bytes > 0, JSON.stringify(sites))
    check('privacy3 cookies: no value is in what the list carries', !JSON.stringify(sites).includes('SECRETVALUE'))
    const names = await browser.cookieNames('127.0.0.1')
    check('privacy3 cookies: the names of a site come with their size and place, never their value', names.map((n) => n.name).join() === 'smoke_a,smoke_b,smoke_c' && names.every((n) => !('value' in n)) && !JSON.stringify(names).includes('SECRETVALUE') && names.find((n) => n.name === 'smoke_b')?.path === '/x', JSON.stringify(names))
    const viaInterface = (await win.webContents.executeJavaScript(`window.lucium.cookieSites()`)) as Array<{ host: string }>
    check('privacy3 cookies: the interface reads the list through the preload', viaInterface.some((s) => s.host === 'localhost'))
    const badName = await win.webContents.executeJavaScript(`window.lucium.cookieNames('127.0.0.1:80')`)
    const badRemove = await win.webContents.executeJavaScript(`window.lucium.removeCookieSite('../etc').then(() => 'removed', (e) => 'refused')`)
    check('privacy3 cookies: a site that is not a plain host is refused (nothing listed, nothing removed)', Array.isArray(badName) && badName.length === 0 && badRemove === 'refused')

    // The panel, with real input.
    browser.openOverlay({ panel: 'cookies' })
    const rows = () => ui.executeJavaScript(`[...document.querySelectorAll('.cookies-site')].map((e) => e.querySelector('.cookies-host')?.textContent)`) as Promise<string[]>
    const shown = await waitFor(async () => (await rows()).includes('localhost') && (await rows()).includes('127.0.0.1'))
    const panelText = String(await ui.executeJavaScript(`document.querySelector('.cookies')?.innerText ?? ''`))
    check('privacy3 cookies: the panel lists the sites, and shows no cookie content', shown && !panelText.includes('SECRETVALUE') && panelText.includes('3 cookies'), panelText.slice(0, 200))
    await ui.executeJavaScript(`document.querySelector('input[aria-label="Garder toujours localhost"]').click()`)
    check('privacy3 cookies: ticking “Garder” puts the site in the list to keep', await waitFor(() => state().settings.cookieKeepHosts.includes('localhost')), JSON.stringify(state().settings.cookieKeepHosts))

    const cleaned = await browser.cleanCookies()
    const afterClean = await browser.cookieSites()
    check('privacy3 cookies: the clean-up removes every cookie but those of the kept site', cleaned.removed === 3 && cleaned.failed === 0 && afterClean.length === 1 && afterClean[0]!.host === 'localhost' && afterClean[0]!.count === 3, JSON.stringify({ cleaned, afterClean }))
    // A real click on the button the label names, once it is there and enabled; false when it never is (a check fails, the suite goes on).
    const centreOf = async (label: string): Promise<{ x: number; y: number } | null> =>
      (await ui.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number } | null
    const clickLabelled = async (label: string): Promise<boolean> => {
      if (!(await waitFor(async () => (await centreOf(label)) !== null))) return false
      const target = await centreOf(label)
      if (!target) return false
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 })
      return true
    }
    // « Supprimer » takes a second click: the first one only offers « Confirmer la suppression » in its row, and removes nothing.
    const askedToConfirm = (await clickLabelled('Supprimer les cookies du site localhost')) && (await waitFor(async () => (await centreOf('Confirmer la suppression des cookies du site localhost')) !== null))
    check('privacy3 cookies: a real click on “Supprimer” asks for a confirmation and removes nothing yet', askedToConfirm && (await browser.cookieSites()).length === 1, JSON.stringify({ askedToConfirm, sites: await browser.cookieSites() }))
    const confirmed = await clickLabelled('Confirmer la suppression des cookies du site localhost')
    check('privacy3 cookies: “Confirmer la suppression” removes a site’s cookies even if it is kept (the user asked for that site)', confirmed && (await waitFor(async () => (await browser.cookieSites()).length === 0)), JSON.stringify({ confirmed, sites: await browser.cookieSites() }))
    browser.closeOverlay()

    browser.dispatch({ type: 'settings/update', patch: { cookieManager: false } })
    const refusedOff = await win.webContents.executeJavaScript(`window.lucium.cookieSites().then(() => 'answered', () => 'refused')`)
    // The application menu is rebuilt a moment after the settings change.
    const cookieEntryHidden = await waitFor(() => findMenuItem('Cookies par site…')?.visible === false)
    check('privacy3 cookies: with the view switched off, the interface gets nothing and the menu entry is hidden', refusedOff === 'refused' && cookieEntryHidden, JSON.stringify({ refusedOff, cookieEntryHidden, visible: findMenuItem('Cookies par site…')?.visible }))
    browser.dispatch({ type: 'settings/update', patch: { cookieManager: true, cookieKeepHosts: [] } })

    // ---------------------------------------------------------------------------------------------------------------------------------
    // private tabs in a normal window
    // ---------------------------------------------------------------------------------------------------------------------------------
    await open(`${base}/cookies`, { title: 'p3 /cookies' })
    const zoomBefore = JSON.stringify(state().settings.siteZoom)
    // A look-alike already in the default history, as the pages of earlier suites of the same process are: it holds the letters of “P1-secret” in order,
    // not the text. The command bar’s loose search finds it; it is not a visit of the private tab.
    const decoy = 'https://decoy.example/p1x-secret-notes'
    history.of('default').record(decoy, 'Faux positif')
    const privateTab = await open(`${base}/priv?id=P1-secret`, { private: true, title: 'p3 /priv' })
    const tabNow = state().tabs.find((t) => t.id === privateTab)
    check('privacy3 private tab: the tab is marked private, has a live page and a throw-away context', tabNow?.private === true && browser.livePageIds().includes(privateTab) && browser.hasPrivateContext())
    const profileNames = (await browser.cookieNames('127.0.0.1')).map((n) => n.name)
    check('privacy3 private tab: the cookie it received is not in the profile’s jar, and the profile’s cookies are still there', !profileNames.includes('priv_cookie') && profileNames.includes('smoke_a'), profileNames.join())
    const echoTab = await open(`${base}/echo`, { private: true, title: 'echo' })
    const echoed = await bodyOf(echoTab)
    check('privacy3 private tab: it sends its own cookie and none of the profile’s (another private tab shares the context)', echoed.includes('priv_cookie=PRIVSECRET') && !echoed.includes('smoke_a'), echoed)
    const normalEcho = await open(`${base}/echo`, { title: 'echo' })
    const normalBody = await bodyOf(normalEcho)
    check('privacy3 private tab: a normal tab sends the profile’s cookies and never the private one', normalBody.includes('smoke_a') && !normalBody.includes('priv_cookie'), normalBody)
    // Every history there is (the profiles that have one, the default one, the one of this suite), by exact address. The control proves the reading finds visits.
    const everyProfile = [...new Set(['default', 'smoke-p3', ...history.profiles()])]
    const privateVisits = everyProfile.filter((profile) => visited(profile, 'P1-secret'))
    check('privacy3 private tab: a look-alike entry makes the loose search answer, which is why the history is read by exact address', history.of('default').search('P1-secret').some((entry) => entry.url === decoy) && !decoy.includes('P1-secret'))
    history.of('default').remove(decoy)
    check(
      'privacy3 private tab: the visit is in no history (read entry by entry, by exact address, in every profile that has one)',
      privateVisits.length === 0 && visited('smoke-p3', '/cookies'),
      JSON.stringify({ privateVisits, profiles: everyProfile, entries: visits('smoke-p3').length, looseMatchesOfTheOldCheck: history.of('default').search('P1-secret').map((e) => e.url).slice(0, 3) })
    )

    // A link opened from a private page stays private; zoom is not saved.
    const pageEvents = (browser.pageFor(privateTab) as unknown as { events: { openWindow: (url: string, how: string) => void } }).events
    pageEvents.openWindow(`${base}/page?id=child`, 'foreground')
    const child = state().tabs.at(-1)!
    mine.add(child.id)
    check('privacy3 private tab: what a private page opens is private too', child.private === true && child.url.endsWith('id=child'))
    browser.dispatch({ type: 'tab/select', id: privateTab })
    browser.zoom(1)
    // The witness: the private page zoomed in, which is what the zoom does instead of writing the site to the settings (browser-commands.ts).
    await waitFor(() => ((browser.pageFor(privateTab) as unknown as { webContents?: WebContents } | undefined)?.webContents?.getZoomFactor() ?? 1) > 1)
    check('privacy3 private tab: zooming it does not write the site to the saved settings', JSON.stringify(state().settings.siteZoom) === zoomBefore)

    // Nothing in the state file, the archive, a session or an export.
    store.flush()
    const file = stateFile()
    check('privacy3 private tab: the state file never holds the address or the flag', !file.includes('P1-secret') && !file.includes('/priv') && !file.includes('"private":true'))
    browser.dispatch({ type: 'tab/archive', id: child.id })
    browser.dispatch({ type: 'session/save', name: 'avec privé' })
    check('privacy3 private tab: archiving it, or saving a session, keeps no trace of it', !state().archive.some((a) => a.url.includes('id=child')) && !JSON.stringify(state().sessions).includes('P1-secret') && !state().tabs.some((t) => t.id === child.id))
    browser.dispatch({ type: 'session/delete', id: state().sessions[0]!.id })

    // The look: the sidebar row and the toolbar.
    const look = (await win.webContents.executeJavaScript(`({ rows: document.querySelectorAll('.sidebar .tab.private-tab').length, badges: document.querySelectorAll('.sidebar .private-badge').length, bar: !!document.querySelector('.page-toolbar .tb-private') })`)) as { rows: number; badges: number; bar: boolean }
    check('privacy3 private tab: the sidebar shows its row in the dark of the private window with a badge, and the toolbar wears the glasses', look.rows >= 2 && look.badges >= 2 && look.bar === true, JSON.stringify(look))
    // The proxy of a profile does not reach a private tab (the private context goes out by the general proxy): its row wears the mark that says so, and an ordinary tab of the
    // same profile, which does go through the proxy of its profile, wears none.
    const privateSpace = state().tabs.find((t) => t.id === privateTab)?.spaceId
    const privateProfile = state().spaces.find((sp) => sp.id === privateSpace)?.profileId ?? 'default'
    const proxiesBefore = { proxyEnabled: state().settings.proxyEnabled, proxy: state().settings.proxy, profiles: state().settings.profiles }
    browser.dispatch({
      type: 'settings/update',
      patch: { proxyEnabled: true, proxy: { mode: 'manual', address: `http://127.0.0.1:${proxyPort}`, bypass: '' }, profiles: { ...proxiesBefore.profiles, [privateProfile]: { ...proxiesBefore.profiles[privateProfile], proxy: { mode: 'direct', address: '', bypass: '' } } } }
    })
    const markOf = () => win.webContents.executeJavaScript(`({ onPrivate: [...document.querySelectorAll('.sidebar .tab.private-tab .proxy-badge')].map((el) => el.getAttribute('aria-label')), onOthers: document.querySelectorAll('.sidebar .tab:not(.private-tab) .proxy-badge').length })`) as Promise<{ onPrivate: string[]; onOthers: number }>
    check('privacy3 private tab: when its profile has a proxy of its own, the row of the private tab wears the mark that says it leaves by the general proxy', await waitFor(async () => (await markOf()).onPrivate.length >= 1), JSON.stringify(await markOf()))
    check('privacy3 private tab: …with its words, and an ordinary tab of the same profile wears none', (await markOf()).onPrivate.every((words) => words.includes('onglet privé')) && (await markOf()).onOthers === 0, JSON.stringify(await markOf()))
    browser.dispatch({ type: 'settings/update', patch: proxiesBefore })
    check('privacy3 private tab: …and the mark goes with the proxy of the profile', await waitFor(async () => (await markOf()).onPrivate.length === 0), JSON.stringify(await markOf()))

    // The menu, and the setting that turns it all off.
    await waitFor(() => findMenuItem('Nouvel onglet privé')?.visible === true)
    const entry = findMenuItem('Nouvel onglet privé')
    const count = state().tabs.length
    entry?.click()
    const fresh = state().tabs.at(-1)!
    mine.add(fresh.id)
    check('privacy3 private tab: File › Nouvel onglet privé opens a blank private tab', entry?.visible === true && state().tabs.length === count + 1 && fresh.private === true && fresh.url === 'about:blank')
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { privateTabs: false } })
    const countOff = state().tabs.length
    browser.dispatch({ type: 'tab/open', url: `${base}/page?id=refused`, private: true })
    const privateEntryHidden = await waitFor(() => findMenuItem('Nouvel onglet privé')?.visible === false)
    check('privacy3 private tab: with the setting off, a private tab is refused (never an ordinary one in its place) and the entry is hidden', state().tabs.length === countOff && privateEntryHidden, JSON.stringify({ tabs: state().tabs.length, countOff, privateEntryHidden }))
    browser.dispatch({ type: 'settings/update', patch: { privateTabs: true } })

    // The last private tab goes: its session goes with it.
    for (const tab of state().tabs.filter((t) => t.private)) browser.dispatch({ type: 'tab/close', id: tab.id })
    const erased = await waitFor(() => !browser.hasPrivateContext())
    const after = await open(`${base}/echo`, { private: true, title: 'echo' })
    const afterBody = await bodyOf(after)
    check('privacy3 private tab: with the last private tab closed the context is erased; a new private tab starts without the old cookie', erased && !afterBody.includes('priv_cookie'), afterBody)
    for (const tab of state().tabs.filter((t) => t.private)) browser.dispatch({ type: 'tab/close', id: tab.id })
  } finally {
    console.warn = realWarn
    console.error = realError
    app.configureHostResolver = realConfigureHostResolver
    engine.setProxies = realSetProxies
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    for (const tab of state().tabs.filter((t) => t.private)) browser.dispatch({ type: 'tab/close', id: tab.id })
    if (state().spaces.some((s) => s.id === space) && state().spaces.length > 1) browser.dispatch({ type: 'space/delete', id: space })
    if (state().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.closeOverlay()
    browser.dispatch({
      type: 'settings/update',
      patch: { proxyEnabled: false, proxy: settingsBefore.proxy, dohCustom: false, historyOff: false, stripCopiedLinks: settingsBefore.stripCopiedLinks, stripTrackingParams: settingsBefore.stripTrackingParams, cookieManager: true, cookieKeepHosts: [], privateTabs: true, hoverCards: settingsBefore.hoverCards, profiles: settingsBefore.profiles }
    })
    void clipboard.writeText('')
    site.close()
    site.closeAllConnections()
    proxy.close()
    proxy.closeAllConnections()
    socks.close()
  }
}

/** `LUCIUM_SMOKE_ONLY=privacy3`: only these checks, with their own report. */
export async function runPrivacy3Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokePrivacy3(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokePrivacy3 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PRIVACY3 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
