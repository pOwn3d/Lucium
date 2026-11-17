// Engine checks for "Effacer les données du site", run inside a real Electron after the main contract test.
// A local server hands out pages that fill every kind of storage (cookies, localStorage, sessionStorage, IndexedDB, a service
// worker, Cache Storage, the HTTP cache). Hosts that are different origins of this one machine play different sites:
// 127.0.0.1 (the site that gets cleared), localhost (another site), p.localhost and its subdomain q.p.localhost.
// The panel is driven the way a user drives it (real mouse clicks); the extensions loaded for the test must keep answering.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Menu, session, type MenuItem, type WebContents } from 'electron'
import { defaultSettings } from '@shared/model'
import { SITE_DATA_TYPES, type SiteDataRequest } from '@shared/site-data'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { listStorageHosts } from './engine/storage-hosts'
import { openSiteSections, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
/** What a probe page reports about the storage of its origin. */
export interface Stored {
  cookie: string
  ls: string | null
  ss: string | null
  idb: boolean
  sw: number
  caches: string
  /** The site's sandboxed file system (`navigator.storage.getDirectory()`) holds the file the seeding page wrote. */
  fs?: boolean
  n: string
  /** Why a stored value went missing, when one did: how the page was reached, and what survived of its window. */
  nav?: string
  hist?: number
  name?: string
}


export const waitFor = waiterOf(10_000, 100)

export const evaluate = <T>(wc: WebContents, script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>

export const rectIn = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
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

export async function waitRect(wc: WebContents, selector: string, text?: string): Promise<Rect | null> {
  for (let i = 0; i < 40; i++) {
    const rect = await rectIn(wc, selector, text)
    if (rect && rect.width > 0 && rect.height > 0) return rect
    await sleep(100)
  }
  return null
}

/** A left click with real mouse events, in the middle of the box. */
export async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  const rect = await waitRect(wc, selector, text)
  if (!rect) return false
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  return true
}

export const SITE_PAGE = `<title>seeding</title><script>
(async () => {
  window.name = 'smoke-window'
  document.cookie = 'js=ok; path=/'
  localStorage.setItem('ls', 'ok')
  sessionStorage.setItem('ss', 'ok')
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('smokedb', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite')
      tx.objectStore('kv').put('ok', 'k')
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
  await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  await (await caches.open('smokecache')).put('/cs', new Response('x'))
  await fetch('/cached.txt')
  // Its sandboxed file system: erased with the site's IndexedDB, where it used to stay.
  try {
    const writer = await (await (await navigator.storage.getDirectory()).getFileHandle('smoke.txt', { create: true })).createWritable()
    await writer.write('ok')
    await writer.close()
  } catch (error) { console.warn('[smoke] the sandboxed file system is not available:', error) }
  document.title = 'seeded'
})().catch((error) => { document.title = 'seed-error ' + error })
</script>`

export const PROBE_PAGE = `<title>probing</title><script>
(async () => {
  const stored = { cookie: document.cookie, ls: localStorage.getItem('ls'), ss: sessionStorage.getItem('ss'), n: location.search, nav: performance.getEntriesByType('navigation')[0]?.type, hist: history.length, name: window.name }
  stored.idb = (await indexedDB.databases()).some((d) => d.name === 'smokedb')
  stored.sw = (await navigator.serviceWorker.getRegistrations()).length
  stored.caches = (await caches.keys()).join(',')
  stored.fs = await navigator.storage.getDirectory().then((root) => root.getFileHandle('smoke.txt')).then(() => true, () => false)
  // Served from the HTTP cache when it still holds the file: the server only sees this request when it does not.
  await fetch('/cached.txt')
  document.title = 'probe:' + JSON.stringify(stored)
})().catch((error) => { document.title = 'probe-error ' + error })
</script>`

export async function smokeSiteData(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, overlayView } = ctx
  // The pages are visited in the default profile's space.
  const history = ctx.history.of('default')
  const ui = overlayView.webContents
  const manager = getWindowManager()

  // The server: one process, several host names. `cachedHits` counts the requests for the cacheable file that reached it.
  const cachedHits = new Map<string, number>()
  const server = createServer((req, res) => {
    const host = req.headers.host ?? ''
    const path = (req.url ?? '/').split('?')[0]
    res.setHeader('content-type', 'text/html')
    if (path === '/site') {
      res.setHeader('set-cookie', 'srv=ok; Path=/')
      return res.end(SITE_PAGE)
    }
    if (path === '/probe') return res.end(PROBE_PAGE)
    if (path === '/cached.txt') {
      cachedHits.set(host, (cachedHits.get(host) ?? 0) + 1)
      res.setHeader('content-type', 'text/plain')
      res.setHeader('cache-control', 'max-age=3600')
      return res.end('cached')
    }
    if (path === '/sw.js') {
      res.setHeader('content-type', 'text/javascript')
      return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))")
    }
    if (path === '/dbg') return res.end('<title>sitedata /dbg</title><body>debugger target</body>')
    res.end(`<title>root ${path}</title><body>root</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const A = `127.0.0.1:${port}`
  const B = `localhost:${port}`
  const P = `p.localhost:${port}`
  const Q = `q.p.localhost:${port}`
  const urlOf = (host: string, path = '') => `http://${host}${path}`

  // The extension probes (loaded by `pnpm test:engine`) report what they handle on the console of their service worker.
  const consoleLines: string[] = []
  engine.onExtensionConsole((entry) => consoleLines.push(entry.message))
  const sidePanelProbe = engine.listExtensions().some((e) => e.name === 'Lucium Side Panel Probe')
  const extensionWorkers = () => engine.runningExtensionWorkers().filter((scope) => scope.startsWith('chrome-extension://'))

  const homeSpace = store.get().spaces.find((s) => s.profileId === 'default')!.id
  browser.dispatch({ type: 'space/select', id: homeSpace })
  const openedTabs: string[] = []
  const titleOf = (id: string) => store.get().tabs.find((t) => t.id === id)?.title ?? ''
  const openTab = async (url: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url })
    const id = store.get().tabs.at(-1)!.id
    openedTabs.push(id)
    return id
  }

  let probeCounter = 0
  /** Loads the probe page in a tab and reads what the origin still holds. */
  const probe = async (tabId: string, host: string, using = browser, state = store): Promise<Stored | null> => {
    using.dispatch({ type: 'tab/select', id: tabId })
    const n = `?n=${++probeCounter}`
    using.submitUrl(urlOf(host, `/probe${n}`), 'current')
    const read = (): Stored | null => {
      const title = state.get().tabs.find((t) => t.id === tabId)?.title ?? ''
      if (!title.startsWith('probe:')) return null
      const parsed = JSON.parse(title.slice('probe:'.length)) as Stored
      return parsed.n === n ? parsed : null
    }
    return (await waitFor(() => read() !== null, 8000)) ? read() : null
  }
  const seed = async (host: string): Promise<string> => {
    const id = await openTab(urlOf(host, '/site'))
    check(`${host} finished filling its storage`, await waitFor(() => titleOf(id) === 'seeded', 12_000), titleOf(id))
    return id
  }
  /** Fills a tab's site with data again (a clearing test leaves it empty). */
  const reseed = async (tabId: string, host: string): Promise<void> => {
    browser.dispatch({ type: 'tab/select', id: tabId })
    browser.submitUrl(urlOf(host, '/site'), 'current')
    check(`${host} was filled again`, await waitFor(() => titleOf(tabId) === 'seeded', 12_000), titleOf(tabId))
  }
  const full = (s: Stored | null, withSession = true) =>
    s !== null && s.cookie.includes('srv=ok') && s.cookie.includes('js=ok') && s.ls === 'ok' && (!withSession || s.ss === 'ok') && s.idb && s.sw === 1 && s.caches === 'smokecache' && s.fs === true
  const empty = (s: Stored | null) => s !== null && s.cookie === '' && s.ls === null && s.ss === null && !s.idb && s.sw === 0 && s.caches === '' && s.fs !== true
  const show = (s: Stored | null) => JSON.stringify(s)

  const workersBefore = extensionWorkers()
  const debuggerReplies = () => consoleLines.filter((line) => line === 'SIDEPANEL_PROBE_DEBUGGER 2').length
  /** A tab of its own for the extension round trips, so no other test tab is moved away from its site. */
  let tabDbg = ''
  /** The extension probe still handles tab events (a killed service worker would stay silent). */
  const extensionStillAnswers = async (): Promise<boolean> => {
    if (!sidePanelProbe) return true
    const before = debuggerReplies()
    browser.dispatch({ type: 'tab/select', id: tabDbg })
    browser.submitUrl(urlOf(B, '/'), 'current')
    await waitFor(() => store.get().tabs.find((t) => t.id === tabDbg)?.url === urlOf(B, '/'))
    browser.submitUrl(urlOf(B, '/dbg'), 'current')
    return waitFor(() => debuggerReplies() > before, 10_000)
  }

  try {
    // ---------- seeding: four sites that each hold every kind of data ----------
    // The API probe extension discards the first tab of the window when it starts: let that be this one, not a test site.
    tabDbg = await openTab(urlOf(B, '/'))
    const tabA = await seed(A)
    const tabB = await seed(B)
    const tabP = await seed(P)
    const tabQ = await seed(Q)
    const seeded = { A: await probe(tabA, A), B: await probe(tabB, B), P: await probe(tabP, P), Q: await probe(tabQ, Q) }
    for (const [name, stored] of Object.entries(seeded)) check(`the test site ${name} really holds cookies, localStorage, sessionStorage, IndexedDB, a service worker and Cache Storage`, full(stored), show(stored))
    check('the extension probe answers before anything is cleared (reference)', await extensionStillAnswers())
    const hitsBefore = new Map(cachedHits)
    check('the HTTP cache holds the cacheable file of each site (the probe did not reach the server)', [A, B, P, Q].every((h) => cachedHits.get(h) === 1), JSON.stringify([...cachedHits]))
    check('the history knows the pages of the sites', [A, B, P, Q].every((h) => history.hosts().includes(h)), history.hosts().join(', '))

    // ---------- a private window: its own session, cleared on its own ----------
    {
      const priv = manager.openPrivate()
      const pid = (url: string) => {
        priv.browser.dispatch({ type: 'tab/open', url })
        return priv.store.get().tabs.at(-1)!.id
      }
      const pTab = pid(urlOf(A, '/site'))
      await waitFor(() => priv.store.get().tabs.find((t) => t.id === pTab)?.title === 'seeded', 12_000)
      const inPrivate = await probe(pTab, A, priv.browser, priv.store)
      check('the private window holds its own data for the same address (its session is separate)', full(inPrivate), show(inPrivate))
      const results = await priv.browser.clearSiteDataFor({ host: A, types: [...SITE_DATA_TYPES], subdomains: false, http: true, reload: false })
      check('clearing in the private window answers every type and the licences of protected video, all fine', results.length === SITE_DATA_TYPES.length + 1 && results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)))
      const afterPrivate = await probe(pTab, A, priv.browser, priv.store)
      check('and empties the private session', empty(afterPrivate), show(afterPrivate))
      priv.browser.openOverlay({ panel: 'sitedata' })
      check('the panel opens in a private window too', priv.browser.currentPanel() === 'sitedata')
      priv.browser.closeOverlay()
      const mainStill = await probe(tabA, A)
      check('the same address in the normal session is untouched', full(mainStill, false) && mainStill?.ss === 'ok', show(mainStill))
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
      browser.dispatch({ type: 'tab/select', id: tabA })
    }

    // ---------- the panel: only the types ticked go, and the choice is remembered ----------
    // The sheet closes at once by default (« Fermeture auto », as in the extension): this run reads its answer, so it stays open. The animation on the
    // page would hide the sheet for its duration and hold the answer back (shell/site-data.ts): the runs below look at the answer, not at the drawing.
    browser.dispatch({ type: 'settings/update', patch: { siteDataAutoClose: false, siteDataAnimation: 'none' } })
    browser.dispatch({ type: 'tab/select', id: tabP })
    browser.openOverlay({ panel: 'sitedata' })
    await waitRect(ui, '.sitedata input.field')
    await sleep(400)
    // The sites of the panel are tags now (the field only holds what is being typed).
    const hostField = () => evaluate<string>(ui, `[...document.querySelectorAll('.sd-tag-label')].map((e) => e.textContent).join(',')`)
    const ticked = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.sd-types li')].filter((li) => li.querySelector('input').checked).map((li) => li.querySelector('strong').textContent)`)
    const flag = (label: string) => evaluate<boolean | null>(ui, `[...document.querySelectorAll('.sitedata label.sd-switch, .sitedata label.sd-scope')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('input').checked ?? null`)
    check('the panel opens with the host of the current site filled in', (await hostField()) === P, await hostField())
    check('and every type but the history ticked the first time, subdomains off, reload on', (await ticked()).length === SITE_DATA_TYPES.length - 1 && !(await ticked()).includes('Historique du site') && (await flag('Sous-domaines')) === false && (await flag('Recharger')) === true, JSON.stringify(await ticked()))
    check('it shows how many cookies the site has', await waitFor(async () => /^\d+$/.test(await evaluate<string>(ui, `[...document.querySelectorAll('.sd-tile')].find((r) => r.textContent.includes('Cookies'))?.querySelector('.sd-badge')?.textContent ?? ''`)), 4000))

    // Untick everything but the local storage and the reload, through real clicks on the tiles.
    for (const label of ['Cache du réseau', 'Cookies', 'Bases IndexedDB', 'Service workers', 'Cache Storage', 'sessionStorage']) await clickOn(ui, '.sd-tile', label)
    await clickOn(ui, '.sitedata label.sd-switch', 'Recharger')
    check('clicking the tiles unticks the types', JSON.stringify(await ticked()) === JSON.stringify(['Stockage local']), JSON.stringify(await ticked()))
    await clickOn(ui, '.sd-cta')
    // A chip per type: whether it went, its name and count, and the sentence of its tooltip.
    const lines = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.sd-result')].map((e) => e.classList.contains('is-ok') + ':' + e.textContent + ' ' + e.title)`)
    check('Effacer shows one result line for the one type, successful', await waitFor(async () => (await lines()).length === 1), JSON.stringify(await lines()))
    check('which says it worked', (await lines())[0]?.startsWith('true:') === true, JSON.stringify(await lines()))
    const afterLocal = await probe(tabP, P)
    // Chromium treats local and session storage as one family: erasing the first also empties the second in the tabs that are open.
    check(
      'only the local storage of that site is gone: its cookies, IndexedDB, service worker and Cache Storage remain',
      afterLocal !== null && afterLocal.ls === null && afterLocal.cookie.includes('srv=ok') && afterLocal.cookie.includes('js=ok') && afterLocal.idb && afterLocal.sw === 1 && afterLocal.caches === 'smokecache' && afterLocal.fs === true,
      show(afterLocal)
    )
    check('the selection and the options were remembered in the settings', JSON.stringify(store.get().settings.siteDataTypes) === '["localStorage"]' && store.get().settings.siteDataReload === false && store.get().settings.siteDataSubdomains === false, JSON.stringify([store.get().settings.siteDataTypes, store.get().settings.siteDataReload]))
    browser.closeOverlay()
    browser.dispatch({ type: 'tab/select', id: tabP })
    browser.openOverlay({ panel: 'sitedata' })
    await waitRect(ui, '.sitedata input.field')
    check('and the panel reopens with them', await waitFor(async () => JSON.stringify(await ticked()) === JSON.stringify(['Stockage local']) && (await flag('Recharger')) === false), JSON.stringify(await ticked()))
    browser.closeOverlay()

    // ---------- one type at a time, through the browser: cookies only ----------
    await reseed(tabP, P)
    const cookiesOnly = await browser.clearSiteDataFor({ host: P, types: ['cookies'], subdomains: false, http: true, reload: false })
    check('clearing only the cookies answers one line, with the number of cookies removed', cookiesOnly.length === 1 && cookiesOnly[0]!.ok && cookiesOnly[0]!.count === 2, JSON.stringify(cookiesOnly))
    const afterCookies = await probe(tabP, P)
    check(
      'and leaves the local storage, sessionStorage, IndexedDB, service worker and Cache Storage of the site alone',
      afterCookies !== null && afterCookies.cookie === '' && afterCookies.ls === 'ok' && afterCookies.ss === 'ok' && afterCookies.idb && afterCookies.sw === 1 && afterCookies.caches === 'smokecache',
      show(afterCookies)
    )
    await reseed(tabP, P)

    // ---------- sessionStorage alone: it is the pages that are emptied, not the profile ----------
    const sessionOnly = await browser.clearSiteDataFor({ host: P, types: ['sessionStorage'], subdomains: false, http: true, reload: false })
    check('clearing only the sessionStorage answers one line, with the number of entries removed', sessionOnly.length === 1 && sessionOnly[0]!.ok && (sessionOnly[0]!.count ?? 0) >= 1, JSON.stringify(sessionOnly))
    const afterSession = await probe(tabP, P)
    check(
      'and leaves the cookies, local storage, IndexedDB, service worker and Cache Storage of the site alone',
      afterSession !== null && afterSession.ss === null && afterSession.cookie.includes('srv=ok') && afterSession.ls === 'ok' && afterSession.idb && afterSession.sw === 1 && afterSession.caches === 'smokecache',
      show(afterSession)
    )
    await reseed(tabP, P)

    // ---------- subdomains: only when asked ----------
    const everything: SiteDataRequest = { host: P, types: [...SITE_DATA_TYPES], subdomains: false, http: true, reload: false }
    const knownBefore = history.hosts()
    check('the history lists the subdomain among its hosts', knownBefore.includes(Q), knownBefore.join(', '))
    const clearP = await browser.clearSiteDataFor(everything)
    check('clearing a site answers every type', clearP.filter((r) => r.type !== 'mediaLicenses').length === SITE_DATA_TYPES.length && clearP.every((r) => r.ok), JSON.stringify(clearP.filter((r) => !r.ok)))
    // The call without a list of storages is only seen to be accepted here: that the licences are gone is checked by hand, on a service of protected video.
    check('…and the engine accepted the erasure of every storage of the site, the one that takes the licences of protected video', clearP.some((r) => r.type === 'mediaLicenses' && r.ok), JSON.stringify(clearP))
    check('its history is gone but the subdomain’s remains', !history.hosts().includes(P) && history.hosts().includes(Q), history.hosts().join(', '))
    const pAfter = await probe(tabP, P)
    const qAfter = await probe(tabQ, Q)
    check('without “sous-domaines”, the site is emptied', empty(pAfter), show(pAfter))
    check('and its subdomain keeps everything', full(qAfter), show(qAfter))
    // What the engine keeps on disk names the subdomain without the tabs, the history or the cookie jar: the read that reaches a subdomain no tab ever showed.
    // It is the one place where the layout of the engine's own files is relied on, so each record is seen to be read here.
    const profileFolder = session.fromPartition('persist:profile-default').getStoragePath()
    const onDisk = profileFolder === null ? null : await listStorageHosts(profileFolder)
    check('the records of the profile that name the sites with storage are all read (local storage, IndexedDB folders, quota manager)', onDisk !== null && onDisk.unread.length === 0, JSON.stringify(onDisk?.unread ?? profileFolder))
    check('and they name the subdomain that holds storage, and the other sites', onDisk !== null && [Q, B].every((host) => onDisk.hosts.includes(host)), JSON.stringify(onDisk?.hosts))
    const clearQ = await browser.clearSiteDataFor({ ...everything, subdomains: true })
    check('with “sous-domaines” the call is fine too', clearQ.every((r) => r.ok), JSON.stringify(clearQ.filter((r) => !r.ok)))
    check('and it answers a line for the subdomains found with storage, the one of this site among them', clearQ.some((r) => r.type === 'subdomains' && r.ok && (r.count ?? 0) >= 1), JSON.stringify(clearQ))
    check('and the history of the subdomain goes with it', !history.hosts().includes(Q), history.hosts().join(', '))
    const qGone = await probe(tabQ, Q)
    check('and the subdomain is emptied as well (its tab, origin and cookies were known)', empty(qGone), show(qGone))
    const afterQ = profileFolder === null ? null : await listStorageHosts(profileFolder)
    check('and the records of the profile are still read after the erasure: it leaves no file the reader refuses', afterQ !== null && afterQ.unread.length === 0, JSON.stringify(afterQ))

    // ---------- the full clear of A, from the panel, then everything around it ----------
    const historyOfA = history.search('127.0.0.1').length
    browser.dispatch({ type: 'tab/select', id: tabA })
    browser.openOverlay({ panel: 'sitedata' })
    await waitRect(ui, '.sitedata input.field')
    check('the panel pre-fills the host of the tab it was opened from', await waitFor(async () => (await hostField()) === A), await hostField())
    // Remembered: only the local storage is ticked. Tick the rest, and the reload to the site's root.
    for (const label of ['Cache du réseau', 'Cookies', 'Bases IndexedDB', 'Service workers', 'Cache Storage', 'sessionStorage', 'Historique du site']) await clickOn(ui, '.sd-tile', label)
    await clickOn(ui, '.sitedata label.sd-switch', 'Recharger')
    check('all types ticked again and the reload on', (await ticked()).length === SITE_DATA_TYPES.length && (await flag('Recharger')) === true, JSON.stringify(await ticked()))
    const workersAtClear = extensionWorkers()
    const hitsAtClear = new Map(cachedHits)
    await clickOn(ui, '.sd-cta')
    check('Effacer shows one result line per type, and one for the licences of protected video', await waitFor(async () => (await lines()).length === SITE_DATA_TYPES.length + 1), JSON.stringify(await lines()))
    check('each one successful', (await lines()).every((l) => l.startsWith('true:')), JSON.stringify(await lines()))
    // Read now, and again at the end: the worker of an extension also stops and starts again by itself (Chromium stops an idle one, an event wakes it), so a list read at one
    // moment may lack one that is back at the next. What Effacer must not do is take a worker away for good: one that is in neither list was.
    const workersAfterClear = extensionWorkers()
    const reloadedToRoot = await waitFor(() => store.get().tabs.find((t) => t.id === tabA)?.url === urlOf(A, '/'), 8000)
    check('the tab stayed open and went back to the root of the site', reloadedToRoot && store.get().tabs.some((t) => t.id === tabA), store.get().tabs.find((t) => t.id === tabA)?.url)
    check('the history of the site was emptied', historyOfA > 0 && (await lines()).some((l) => l.includes('oubliée')), `${historyOfA} / ${JSON.stringify(await lines())}`)
    browser.closeOverlay()

    const aAfter = await probe(tabA, A)
    check('after Effacer, the site holds no cookie, localStorage, sessionStorage, IndexedDB, service worker or Cache Storage', empty(aAfter), show(aAfter))
    check('and its cached file is fetched from the server again (the HTTP cache was emptied)', cachedHits.get(A) === (hitsAtClear.get(A) ?? 0) + 1, `${hitsAtClear.get(A)} -> ${cachedHits.get(A)}`)

    const bAfter = await probe(tabB, B)
    check('another site (localhost, a different origin of this machine) keeps all its data', full(bAfter), show(bAfter))
    check('and its cached file is still served from the HTTP cache', cachedHits.get(B) === hitsBefore.get(B), `${hitsBefore.get(B)} -> ${cachedHits.get(B)}`)
    check('and its history is still there', history.hosts().includes(B))
    check('the extensions kept their running service workers', workersAtClear.every((scope) => workersAfterClear.includes(scope) || extensionWorkers().includes(scope)), JSON.stringify({ before: workersBefore, atClear: workersAtClear, afterClear: workersAfterClear, after: extensionWorkers() }))
    check('and the extension probe still answers events (its service worker was not killed)', await extensionStillAnswers())

    // ---------- the ways in: site panel, menu, command bar ----------
    browser.dispatch({ type: 'tab/select', id: tabB })
    browser.openOverlay({ panel: 'site' })
    // The button is in the section « Cookies et données » of the panel, folded until it is opened.
    await waitRect(ui, '.scc-section-head')
    await openSiteSections((script) => evaluate(ui, script))
    check('the site panel has the button', await clickOn(ui, '.scc-setting', 'Effacer les données'))
    check('which opens the clearing panel on the site of the tab', (await waitFor(() => browser.currentPanel() === 'sitedata')) && (await waitRect(ui, '.sitedata input.field')) !== null && (await hostField()) === B, `${browser.currentPanel()} ${await hostField()}`)
    browser.closeOverlay()

    const menuItem = (label: string): MenuItem | undefined => {
      const find = (items: MenuItem[]): MenuItem | undefined => {
        for (const item of items) {
          if (item.label === label) return item
          const inner = item.submenu ? find(item.submenu.items) : undefined
          if (inner) return inner
        }
        return undefined
      }
      return find(Menu.getApplicationMenu()?.items ?? [])
    }
    const entry = menuItem('Effacer les données du site…')
    check('the Archive menu lists it with ⇧⌘X', entry !== undefined && entry.accelerator === 'CmdOrCtrl+Shift+X' && Menu.getApplicationMenu()!.items.find((m) => m.label === 'Archive')?.submenu?.items.includes(entry) === true, String(entry?.accelerator))
    entry?.click()
    check('and choosing it opens the panel', await waitFor(() => browser.currentPanel() === 'sitedata'))
    browser.closeOverlay()

    const typeInBar = async (text: string) => {
      for (const ch of text) {
        const keyCode = ch === ' ' ? 'Space' : ch
        ui.sendInputEvent({ type: 'keyDown', keyCode })
        ui.sendInputEvent({ type: 'char', keyCode: ch })
        ui.sendInputEvent({ type: 'keyUp', keyCode })
        await sleep(40)
      }
      await sleep(350)
    }
    const barRows = () => evaluate<Array<{ label: string; selected: boolean }>>(ui, `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', selected: li.classList.contains('selected') }))`)
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(async () => evaluate<boolean>(ui, `document.activeElement === document.querySelector('.palette-input')`), 3000)) break
    }
    await sleep(200)
    await typeInBar('efface les donnees du site')
    const barList = await barRows()
    const at = barList.findIndex((r) => r.label === 'Effacer les données du site')
    check('typing “efface les donnees du site” in the command bar offers the action', at >= 0, JSON.stringify(barList.map((r) => r.label)))
    const selectedAt = barList.findIndex((r) => r.selected)
    for (let i = selectedAt; i < at; i++) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      ui.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await sleep(80)
    }
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    check('and Enter on it opens the clearing panel', await waitFor(() => browser.currentPanel() === 'sitedata'), String(browser.currentPanel()))
    browser.closeOverlay()

    // ---------- guards, in the real engine ----------
    const refused = async (origins: string[]) => engine.clearSiteData('default', { origins, host: A, subdomains: false, types: ['cookies', 'localStorage'] }).then(() => 'erased', (error: Error) => error.message)
    check('the engine refuses to erase without an origin', /without an origin/.test(await refused([])), await refused([]))
    const extensionOrigin = `chrome-extension://${engine.listExtensions()[0]?.id ?? 'a'.repeat(32)}`
    check('and refuses an extension’s origin', /Refusing/.test(await refused([extensionOrigin])), await refused([extensionOrigin]))
    check('the extension probe still answers after those refusals', await extensionStillAnswers())
    const stillB = await probe(tabB, B)
    check('and the other site is still complete', full(stillB), show(stillB))

    const invalid = await browser.clearSiteDataFor({ host: 'a b', types: ['cookies'], subdomains: false, http: true, reload: false }).then(() => 'erased', (error: Error) => error.message)
    check('an invalid host is refused by the browser, nothing erased', /Invalid site/.test(invalid), invalid)
  } finally {
    // Leave the window as it was: the settings back to their defaults, no tab of ours, no panel.
    const defaults = defaultSettings()
    browser.dispatch({ type: 'settings/update', patch: { siteDataTypes: defaults.siteDataTypes, siteDataSubdomains: defaults.siteDataSubdomains, siteDataReload: defaults.siteDataReload } })
    browser.closeOverlay()
    for (const id of openedTabs) browser.dispatch({ type: 'tab/close', id })
    server.close()
  }
}

/** The same checks with their own report, for a quick local loop (see LUCIUM_SMOKE_ONLY in index.ts). Returns the exit code. */
export async function runSiteDataSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const check: Check = recorderOf(checks)
  try {
    await smokeSiteData(ctx, check)
  } catch (error) {
    check('smokeSiteData ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SITEDATA ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

