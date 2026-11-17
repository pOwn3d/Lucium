// The protections, read where they act: in the page (what a script reads back), at the server of the test (what it receives: requests,
// cookies, an attempt at https://), in the cookie jar of the profile (main process). The sites are the local server, under 127.0.0.1 and
// under test host names (`*.e2e.test`, mapped to 127.0.0.1 by launch.ts) when a rule needs another site than the page's. Nothing leaves
// the machine. Each function has its control: the same steps with the function off.

import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchLucium, TEST_DOMAIN, type Running } from './launch'
import {
  bindShortcut,
  callBridge,
  chooseMenuEntry,
  dismissWelcome,
  dispatch,
  menuEntryState,
  openTab,
  pathsReceived,
  serveSite,
  setSettings,
  snapshotOf,
  tabAt,
  titledPage,
  waitForPanel,
  waitForState,
  expectStays,
  tabPage,
  type LocalSite,
  type Route
} from './helpers'

let site: LocalSite
let running: Running

/** Draws one colour on a canvas and counts the pixels that do not read back as that colour (the noise of the fingerprint protection). */
const CANVAS_PAGE = titledPage(
  'Canvas',
  `<script>
    window.alteredPixels = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 64; canvas.height = 64
      const context = canvas.getContext('2d')
      context.fillStyle = 'rgb(10, 20, 30)'
      context.fillRect(0, 0, 64, 64)
      const data = context.getImageData(0, 0, 64, 64).data
      let altered = 0
      for (let i = 0; i < data.length; i += 4) if (data[i] !== 10 || data[i + 1] !== 20 || data[i + 2] !== 30) altered++
      return altered
    }
  </script>`
)

/** The pages of the server: a page that names the port of the server is added once it listens. */
const pages: Record<string, Route> = {}

test.beforeAll(async () => {
  Object.assign(pages, {
    '/a': titledPage('Page A'),
    '/b': titledPage('Page B'),
    '/canvas': CANVAS_PAGE,
    '/cookie': { body: titledPage('Cookie posé'), headers: { 'set-cookie': 'e2e=1; Max-Age=3600; Path=/' } },
    '/echo': titledPage('Écho'),
    // Never kept in the cache: each page that asks for them must reach the server, unless the blocker stops the request.
    '/e2e-lib.js': { body: 'window.libLoaded = true', type: 'text/javascript', headers: { 'cache-control': 'no-store' } },
    '/e2e-first.js': { body: 'window.firstLoaded = true', type: 'text/javascript', headers: { 'cache-control': 'no-store' } },
    '/popup': titledPage('Fenêtre surgissante', `<script>setTimeout(() => window.open('/b'), 200)</script>`),
    '/share': titledPage('Partage', `<button id="share" onclick="navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => { document.title = 'accepté' }, (error) => { document.title = 'refusé: ' + error.name })">Partager</button>`)
  })
  site = await serveSite(pages)
  // A page of 127.0.0.1 that asks for a script of another site (third party: `ads.e2e.test`) and for one of its own (first party). The query
  // `n` of the page goes with both, so that each load asks again.
  pages['/ads'] = titledPage(
    'Annonces',
    `<script>const n = new URLSearchParams(location.search).get('n'); for (const src of ['http://thirdparty.${TEST_DOMAIN}:${site.port}/e2e-lib.js?n=' + n, '/e2e-first.js?n=' + n]) { const s = document.createElement('script'); s.src = src; document.head.append(s) }</script>`
  )
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  site.requests.length = 0
  site.tlsAttempts = 0
  site.connects.length = 0
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

const url = (path: string) => `${site.origin}${path}`

/** The cookies the default profile keeps for an address (main process). */
function cookiesOf(app: ElectronApplication, address: string): Promise<string[]> {
  return app.evaluate(async ({ session }, target) => (await session.fromPartition('persist:profile-default').cookies.get({ url: target })).map((cookie) => `${cookie.name}=${cookie.value}`), address)
}

test('fingerprint: a canvas read back by a page is noised while on; off, it reads back exactly what was drawn', async () => {
  await setSettings(running.page, { reduceFingerprint: true })
  let tab = await openTab(running, url('/canvas?on'), 'Canvas')
  await expect.poll(() => tab.page.evaluate(() => (globalThis as unknown as { alteredPixels(): number }).alteredPixels())).toBeGreaterThan(0)

  await setSettings(running.page, { reduceFingerprint: false })
  tab = await openTab(running, url('/canvas?off'), 'Canvas')
  expect(await tab.page.evaluate(() => (globalThis as unknown as { alteredPixels(): number }).alteredPixels())).toBe(0)
})

// "HTTPS first" leaves alone an address with a port other than 80 (privacy.ts): the site is reached on port 80 through the server of the test
// used as a proxy. The attempt at https:// is then a CONNECT to port 443, which the server refuses: the page falls back to http://.
test('https-first: an http:// address of a site of the Internet is tried in https:// first, then falls back; off, it is asked in http:// only', async () => {
  await setSettings(running.page, { proxyEnabled: true, proxy: { mode: 'manual', address: `http://127.0.0.1:${site.port}`, bypass: '' } })
  await setSettings(running.page, { httpsUpgrade: true })
  await dispatch(running.page, { type: 'tab/open', url: `http://secure.${TEST_DOMAIN}/a` })
  await expect.poll(() => site.connects, { timeout: 15_000 }).toContain(`secure.${TEST_DOMAIN}:443`)
  await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.url === `http://secure.${TEST_DOMAIN}/a` && tab.title === 'Page A'), 'fallen back to http', 20_000)

  await setSettings(running.page, { httpsUpgrade: false })
  await dispatch(running.page, { type: 'tab/open', url: `http://plain.${TEST_DOMAIN}/b` })
  await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.url === `http://plain.${TEST_DOMAIN}/b` && tab.title === 'Page B'), 'loaded in http')
  expect(site.connects.filter((host) => host.startsWith('plain.'))).toEqual([])
})

test('proxy: with a manual proxy the pages are asked of the proxy (the server of the test) by their whole address; off, directly', async () => {
  // A host that resolves nowhere without the proxy: the request can only reach the server through it.
  const address = 'http://via-proxy.invalid/a'
  await setSettings(running.page, { proxyEnabled: true, proxy: { mode: 'manual', address: `http://127.0.0.1:${site.port}`, bypass: '' } })
  await dispatch(running.page, { type: 'tab/open', url: address })
  await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.url === address && tab.title === 'Page A'), 'the page through the proxy', 15_000)
  expect(pathsReceived(site, 'http://via-proxy.invalid/')).toContain(address)

  await setSettings(running.page, { proxyEnabled: false })
  const asked = pathsReceived(site, 'http://via-proxy.invalid/').length
  await dispatch(running.page, { type: 'tab/open', url: 'http://via-proxy.invalid/b' })
  await expectStays(() => pathsReceived(site, 'http://via-proxy.invalid/').length, asked, 'the server is not asked as a proxy once the proxy is off', 2500)
})

test.describe('the blocker, with a list of the user', () => {
  /**
   * The rules of the test: the host of the third party, and one rule that names a file of the first party. The names are chosen so that no
   * list of the catalogue would match them either (EasyList blocks "ads." hosts and "-ad.js" files). Under the tests the blocker downloads no list
   * (LUCIUM_E2E, src/main/blocking/index.ts): the list given here as text is the only one compiled.
   */
  const RULES = `||thirdparty.${TEST_DOMAIN}^\n/e2e-first.js\n`

  async function addList(): Promise<void> {
    const result = await callBridge<{ ok: boolean; reason?: string }>(running.page, 'addFilterListText', 'Liste de test', RULES)
    expect(result, 'the list of the test is taken').toMatchObject({ ok: true })
    await waitForState(running.page, (s) => (s.state.settings['customFilterLists'] as unknown[]).length === 1, 'the list in the settings')
  }

  let loads = 0

  /** Loads the page of 127.0.0.1 that asks for both scripts, and says which ones the server received. */
  async function loadAds(): Promise<{ third: boolean; first: boolean }> {
    const n = ++loads
    await dispatch(running.page, { type: 'tab/open', url: url(`/ads?n=${n}`) })
    await waitForState(running.page, (s) => tabAt(s, url(`/ads?n=${n}`))?.title === 'Annonces', 'the page of the scripts')
    // The page is loaded once each of its scripts has come or has been refused: what the server received by then is all it will receive.
    await (await tabPage(running.app, url(`/ads?n=${n}`))).waitForLoadState('load')
    return { third: pathsReceived(site, '/e2e-lib.js').includes(`/e2e-lib.js?n=${n}`), first: pathsReceived(site, '/e2e-first.js').includes(`/e2e-first.js?n=${n}`) }
  }

  test('block-ads and custom-filter-lists: a rule of the list stops the script of another site; with the lists of the user off, or the blocker off, it is loaded', async () => {
    await setSettings(running.page, { blockAds: true, customFilterListsEnabled: true })
    await addList()
    await expect.poll(async () => (await loadAds()).third, { timeout: 40_000, intervals: [1000] }).toBe(false)

    // The blocker stays on, the lists of the user are switched off: no other list names the host of the test.
    await setSettings(running.page, { customFilterListsEnabled: false })
    await expect.poll(async () => (await loadAds()).third, { timeout: 30_000, intervals: [1000] }).toBe(true)

    await setSettings(running.page, { customFilterListsEnabled: true, blockAds: false, blockTrackers: false })
    expect((await loadAds()).third).toBe(true)
  })

  test('block-scriptlets: a $removeparam rule of the list takes the parameter out of a request while on; off, the request keeps it', async () => {
    // A rule that only the extended rules apply; its host is a third party of the page (127.0.0.1).
    const result = await callBridge<{ ok: boolean }>(running.page, 'addFilterListText', 'Paramètres', `||cdn.${TEST_DOMAIN}^$removeparam=e2etrack\n||thirdparty.${TEST_DOMAIN}^\n`)
    expect(result).toMatchObject({ ok: true })
    const asked = async (on: boolean): Promise<string[]> => {
      await setSettings(running.page, { blockAds: true, blockScriptlets: on })
      const n = ++loads
      const address = url(`/track?n=${n}`)
      pages['/track'] = titledPage('Suivi', `<script src="http://cdn.${TEST_DOMAIN}:${site.port}/e2e-first.js?e2etrack=1&keep=1&n=${n}"></script>`)
      await dispatch(running.page, { type: 'tab/open', url: address })
      await waitForState(running.page, (s) => tabAt(s, address)?.title === 'Suivi', 'the page of the request')
      // As in loadAds: once the page is loaded, its script has been asked for (or refused).
      await (await tabPage(running.app, address)).waitForLoadState('load')
      return pathsReceived(site, '/e2e-first.js').filter((path) => path.endsWith(`n=${n}`))
    }
    // The list is in force once the script of the other host is stopped.
    await expect.poll(async () => (await loadAds()).third, { timeout: 40_000, intervals: [1000] }).toBe(false)
    await expect.poll(() => asked(true), { timeout: 20_000, intervals: [1000] }).toEqual([expect.stringMatching(/^\/e2e-first\.js\?keep=1&n=\d+$/)])
    expect(await asked(false)).toEqual([expect.stringMatching(/^\/e2e-first\.js\?e2etrack=1&keep=1&n=\d+$/)])
  })

  test('block-scriptlets: a function of the page that a stand-in script calls does not find the address of the stand-in in its call stack', async () => {
    // The stand-in is served at an address whose host is a word drawn at launch, the same for every site until the application quits: a page
    // that could read it would hold a mark common to all the sites of the profile, and could ask for the other stand-ins by itself.
    const result = await callBridge<{ ok: boolean }>(running.page, 'addFilterListText', 'Remplacement', `||cdn.${TEST_DOMAIN}^$script,redirect=googletagservices_gpt.js\n||thirdparty.${TEST_DOMAIN}^\n`)
    expect(result).toMatchObject({ ok: true })
    await setSettings(running.page, { blockAds: true, blockScriptlets: true })
    // The list is in force once the script of the other host is stopped.
    await expect.poll(async () => (await loadAds()).third, { timeout: 40_000, intervals: [1000] }).toBe(false)

    const n = ++loads
    const address = url(`/stack?n=${n}`)
    // The page queues a command before the library comes, as every page that uses it does; the stand-in runs the queue.
    pages['/stack'] = titledPage(
      'Pile',
      `<script>window.stacks = []; window.googletag = { cmd: [function () { window.stacks.push(String(new Error().stack)) }] }</script>
       <script src="http://cdn.${TEST_DOMAIN}:${site.port}/e2e-gpt.js?n=${n}"></script>
       <script>window.googletag.cmd.push(function () { window.stacks.push(String(new Error().stack)) })</script>`
    )
    await dispatch(running.page, { type: 'tab/open', url: address })
    await waitForState(running.page, (s) => tabAt(s, address)?.title === 'Pile', 'the page of the stack')
    const tab = await tabPage(running.app, address)
    await tab.waitForLoadState('load')
    const stacks = await tab.evaluate(() => (window as unknown as { stacks: string[] }).stacks)
    // The stand-in ran both commands (the queued one and the one pushed after it), and the real file was never asked for: without
    // these two the test would say nothing about the stack.
    expect(stacks).toHaveLength(2)
    expect(pathsReceived(site, '/e2e-gpt.js').filter((path) => path.endsWith(`n=${n}`))).toEqual([])
    for (const stack of stacks) expect(stack).not.toContain('lucium-stand-in')
  })

  test('the mode of a site: Strict applies the rule to the files of the site itself; Standard leaves them alone', async () => {
    await setSettings(running.page, { blockAds: true, customFilterListsEnabled: true })
    await addList()
    // The list is in force once the script of the third party is stopped.
    await expect.poll(async () => (await loadAds()).third, { timeout: 40_000, intervals: [1000] }).toBe(false)
    // Standard (the default): the rule that names a file of the site is not applied to the site's own request.
    expect((await loadAds()).first).toBe(true)

    await dispatch(running.page, { type: 'blocking/site-mode', site: '127.0.0.1', mode: 'strict' })
    await waitForState(running.page, (s) => s.state.settings.blockModeSites['127.0.0.1'] === 'strict', 'strict')
    expect((await loadAds()).first).toBe(false)
  })
})

test('cookie-manager: the panel of the cookies lists the site that set one while on; off, its entry is gone and the list is refused', async () => {
  await dismissWelcome(running.app, running.page)
  await openTab(running, url('/cookie'), 'Cookie posé')
  await expect.poll(() => cookiesOf(running.app, url('/'))).toContain('e2e=1')
  // The entry has no shortcut of its own: one is given to it, as Settings › Raccourcis does.
  await bindShortcut(running.page, 'cookieManager', 'CmdOrCtrl+Alt+Shift+K')
  await setSettings(running.page, { cookieManager: true })
  await chooseMenuEntry(running.app, 'CmdOrCtrl+Alt+Shift+K')
  const overlay = await waitForPanel(running.app, '.card.cookies')
  await expect(overlay.locator('.card.cookies')).toContainText('127.0.0.1')
  await running.page.evaluate(() => (globalThis as unknown as { lucium: { closeOverlay(): void } }).lucium.closeOverlay())

  await setSettings(running.page, { cookieManager: false })
  await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+K')).toBe('disabled')
  await expect(callBridge(running.page, 'cookieSites')).rejects.toThrow()
})

test('clear-on-close: the cookies of a listed site are erased when its last tab closes; off, they stay', async () => {
  const host = `127.0.0.1:${site.port}`
  // Off first (the site is on the list, the function is not): closing the tab leaves the cookie.
  await dispatch(running.page, { type: 'siteclear/site', site: host, on: true })
  await setSettings(running.page, { siteDataClearOnCloseEnabled: false })
  let tab = await openTab(running, url('/cookie'), 'Cookie posé')
  await expect.poll(() => cookiesOf(running.app, url('/'))).toContain('e2e=1')
  await dispatch(running.page, { type: 'tab/close', id: tab.id })
  await waitForState(running.page, (s) => !s.state.tabs.some((item) => item.id === tab.id), 'closed')
  await expectStays(async () => (await cookiesOf(running.app, url('/'))).includes('e2e=1'), true, 'the cookie stays after the tab is closed while the function is off', 1500)

  await setSettings(running.page, { siteDataClearOnCloseEnabled: true })
  tab = await openTab(running, url('/cookie?again'), 'Cookie posé')
  await dispatch(running.page, { type: 'tab/close', id: tab.id })
  await expect.poll(() => cookiesOf(running.app, url('/')), { timeout: 10_000 }).toEqual([])
})

test('containers: a tab of a container keeps its cookies apart from the profile; off, no container can be made', async () => {
  await setSettings(running.page, { tabContainers: false })
  await dispatch(running.page, { type: 'container/create', name: 'Travail' })
  await expectStays(async () => (await snapshotOf(running.page)).state.settings['containers'], [], 'no container is made while the function is off', 400)

  await setSettings(running.page, { tabContainers: true })
  await dispatch(running.page, { type: 'container/create', name: 'Travail' })
  const state = await waitForState(running.page, (s) => (s.state.settings['containers'] as unknown[]).length === 1, 'container')
  const container = (state.state.settings['containers'] as Array<{ id: string }>)[0]!.id
  await dispatch(running.page, { type: 'tab/open', url: url('/cookie'), container })
  await waitForState(running.page, (s) => tabAt(s, url('/cookie'))?.title === 'Cookie posé', 'the page in the container')
  await expect.poll(() => site.requests.some((request) => request.path === '/cookie')).toBe(true)
  // The profile's own jar has no cookie of the site, and an ordinary tab sends none.
  expect(await cookiesOf(running.app, url('/'))).toEqual([])
  await openTab(running, url('/echo'), 'Écho')
  expect(site.requests.find((request) => request.path === '/echo')?.headers.cookie).toBeUndefined()
})

test('private-tabs: a private tab keeps its cookies out of the profile; off, no private tab opens', async () => {
  await setSettings(running.page, { privateTabs: false })
  await dispatch(running.page, { type: 'tab/open', url: url('/cookie'), private: true })
  await expectStays(async () => tabAt(await snapshotOf(running.page), url('/cookie')) === undefined, true, 'no private tab opens while the function is off', 800)

  await setSettings(running.page, { privateTabs: true })
  await dispatch(running.page, { type: 'tab/open', url: url('/cookie'), private: true })
  const state = await waitForState(running.page, (s) => tabAt(s, url('/cookie'))?.title === 'Cookie posé', 'the private tab')
  expect(tabAt(state, url('/cookie'))?.private).toBe(true)
  await expect.poll(() => site.requests.some((request) => request.path === '/cookie')).toBe(true)
  expect(await cookiesOf(running.app, url('/'))).toEqual([])
})

test('strip-copied-links: Copy Address (⇧⌘C) leaves the tracking parameters out while on; off, the address is copied as it is', async () => {
  // The clipboard of the Mac is the user's: what it held is put back at the end.
  const saved = await running.app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const address = url('/a?utm_source=e2e&keep=1')
    // A new profile is in the « Renforcée » protection, which also removes the tracking parameters of an address as it opens: the tab would then be on
    // `/a?keep=1` and the address with its parameters never in the tab. Only the copy is under test here: the removal on opening has its own test.
    await setSettings(running.page, { stripTrackingParams: false })
    await openTab(running, address, 'Page A')
    const copied = () => running.app.evaluate(({ clipboard }) => clipboard.readText())
    await setSettings(running.page, { stripCopiedLinks: true })
    await chooseMenuEntry(running.app, 'CmdOrCtrl+Shift+C')
    await expect.poll(copied).toBe(url('/a?keep=1'))

    await setSettings(running.page, { stripCopiedLinks: false })
    await chooseMenuEntry(running.app, 'CmdOrCtrl+Shift+C')
    await expect.poll(copied).toBe(address)
  } finally {
    await running.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }
})

test('site permissions: a permission refused to a site is refused to its page, and an allowed one is granted', async () => {
  const origin = site.origin
  const state = async (address: string) => (await openTab(running, address, 'Page A')).page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state)
  await dispatch(running.page, { type: 'permission/set', origin, permission: 'geolocation', decision: 'deny' })
  expect(await state(url('/a?deny'))).toBe('denied')
  await dispatch(running.page, { type: 'permission/set', origin, permission: 'geolocation', decision: 'allow' })
  expect(await state(url('/a?allow'))).toBe('granted')
})

test('popups: a window a page opens without a click is refused; a site in the exceptions may open it', async () => {
  await openTab(running, url('/popup'), 'Fenêtre surgissante')
  await expectStays(async () => tabAt(await snapshotOf(running.page), url('/b')) === undefined, true, 'the window the page opens without a click is refused', 1500)

  await setSettings(running.page, { popupExceptions: [`127.0.0.1`] })
  await openTab(running, url('/popup?again'), 'Fenêtre surgissante')
  await expect.poll(async () => running.app.windows().some((page) => page.url() === url('/b')), { timeout: 10_000 }).toBe(true)
})

test('screen-share: off, a page that asks to share the screen is refused at once, without a system prompt', async () => {
  await setSettings(running.page, { allowScreenShare: false })
  const tab = await openTab(running, url('/share'), 'Partage')
  await tab.page.click('#share')
  await expect.poll(() => tab.page.title()).toBe('refusé: NotAllowedError')
})

test('guest-profile: the entry of a guest window opens a window of its own while on; off, the entry is not offered', async () => {
  await dismissWelcome(running.app, running.page)
  await bindShortcut(running.page, 'guestWindow', 'CmdOrCtrl+Alt+Shift+G')
  await setSettings(running.page, { guestProfile: false })
  await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+G')).toBe('disabled')
  const windows = () => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().includes('/index.html')).length)
  const before = await windows()

  await setSettings(running.page, { guestProfile: true })
  await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+G')).toBe('enabled')
  await chooseMenuEntry(running.app, 'CmdOrCtrl+Alt+Shift+G')
  await expect.poll(windows, { timeout: 10_000 }).toBe(before + 1)
})
