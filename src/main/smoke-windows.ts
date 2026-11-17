// Engine checks for the private window, run inside a real Electron after the main contract test.
// `smokeWindows` is what smoke.ts calls; `runWindowsSmoke` is the same with its own report, for the local branching in index.ts.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, session, webContents as allWebContents, type BrowserWindow as Window, type MenuItem } from 'electron'
import type { UiSnapshot } from '@shared/ipc'
import { PRIVATE_BACKGROUND, privateSpaceName } from '@shared/private-window'
import { activeTab } from '@shared/sidebar'
import type { SmokeContext } from './smoke'
import { menuItems } from './shell/context-menus'
import { getWindowManager } from './shell/windows'
import { closeLeftoverPanels, recorderOf, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 100)

// A 1x1 transparent PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

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

export async function smokeWindows(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, history } = ctx
  const mainWin = ctx.win
  const manager = getWindowManager()
  const userData = app.getPath('userData')
  const statePath = join(userData, 'state.json')
  const historyPath = join(userData, 'history.json')
  const secret = `priv-secret-${Date.now()}`
  // What the main window visits during the test is legitimately recorded; the private visits must never be.
  const normalToken = `normal-${Date.now()}`
  const mainUrls: string[] = []

  let thirdPartyHits = 0
  let firstPartyHits = 0
  const faviconPaths: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    if (path === '/cookie') {
      res.setHeader('content-type', 'text/html')
      // Reports what this document can read, then leaves a cookie and a stored value behind.
      return res.end(`<title>cookie-pending</title><script>
        document.title = 'seen:' + document.cookie + '|' + (localStorage.getItem('pl') || '')
        document.cookie = 'pk=private; path=/'
        localStorage.setItem('pl', 'stored')
      </script>`)
    }
    if (path === '/shared-cookie') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>cookie-pending</title><script>document.title = 'seen:' + document.cookie</script>`)
    }
    if (path === '/download-w') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="extra-window.bin"')
      return res.end(Buffer.alloc(1024, 4))
    }
    if (path === '/download-link') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>download-link</title><body><a id="d" href="/download-w" download>get</a></body>')
    }
    if (path === '/fav') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>fav</title><link rel="icon" type="image/png" href="/fav.png">ok')
    }
    if (path === '/nofav') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>nofav</title><link rel="icon" type="image/png" href="/missing.png">ok')
    }
    if (path === '/fav.png' || path === '/missing.png') {
      faviconPaths.push(path)
      if (path === '/missing.png') {
        res.statusCode = 404
        return res.end('nope')
      }
      res.setHeader('content-type', 'image/png')
      return res.end(PIXEL)
    }
    if (path === '/download') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="window-smoke.bin"')
      return res.end(Buffer.alloc(1024, 3))
    }
    if (path === '/geo') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>geo</title><body><script>navigator.geolocation.getCurrentPosition(() => {}, () => {})</script></body>')
    }
    if (path === '/ad-page') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>ad-page</title><body>ok<script src="http://localhost:${(server.address() as AddressInfo).port}/third-party-ad.js"></script><script src="/first-party.js"></script></body>`)
    }
    if (path === '/third-party-ad.js') {
      thirdPartyHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    if (path === '/first-party.js') {
      firstPartyHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<title>plain ${path}</title><body>plain</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The checks below read the panels of the main window: what an earlier suite left open there (the list of downloads of the sidebar's checks) is closed first.
  const leftover = closeLeftoverPanels(browser)
  if (leftover.length > 0) console.warn(`[windows] closed what an earlier suite left over the main window: ${leftover.join(', ')}`)

  const titleOf = (record: { store: { get(): { tabs: Array<{ url: string; title: string; faviconUrl?: string }> } } }, needle: string) =>
    record.store.get().tabs.find((t) => t.url.includes(needle))?.title
  const exec = <T>(win: Window, js: string): Promise<T> => win.webContents.executeJavaScript(js) as Promise<T>
  const snapshotOf = (win: Window) => exec<UiSnapshot>(win, 'window.lucium.getSnapshot()')

  // ---- selecting tabs keeps working when two profiles are in use (the extension runtime of each profile is told about a tab) ----
  const homeSpace = store.get().activeSpaceId
  let selectFailure = ''
  try {
    browser.dispatch({ type: 'space/create', name: 'Autre profil', emoji: '2', hue: 40, profileId: 'smoke-second' })
    browser.dispatch({ type: 'tab/open', url: `${base}/plain/other-profile` })
    await waitFor(() => store.get().tabs.some((t) => t.url.endsWith('/plain/other-profile') && t.title.startsWith('plain')))
    browser.dispatch({ type: 'tab/open', url: `${base}/plain/home`, spaceId: homeSpace })
    await waitFor(() => store.get().tabs.some((t) => t.url.endsWith('/plain/home') && t.title.startsWith('plain')))
    const home = store.get().tabs.find((t) => t.url.endsWith('/plain/home'))!
    browser.dispatch({ type: 'tab/select', id: home.id })
    browser.dispatch({ type: 'tab/select', id: store.get().tabs.find((t) => t.url.endsWith('/plain/other-profile'))!.id })
    browser.dispatch({ type: 'tab/select', id: home.id })
  } catch (error) {
    selectFailure = String((error as Error).message ?? error)
  }
  check('selecting tabs of two profiles in turn works', selectFailure === '' && activeTab(store.get())?.url.endsWith('/plain/home') === true, selectFailure)
  const otherSpace = store.get().spaces.find((sp) => sp.profileId === 'smoke-second')
  if (otherSpace) browser.dispatch({ type: 'space/delete', id: otherSpace.id })
  browser.dispatch({ type: 'space/select', id: homeSpace })

  // ---- a second window over the same tabs ----
  for (const tab of [...store.get().tabs]) browser.dispatch({ type: 'tab/close', id: tab.id })
  browser.dispatch({ type: 'tab/open', url: `${base}/plain/one` })
  browser.dispatch({ type: 'tab/open', url: `${base}/plain/two` })
  await waitFor(() => store.get().tabs.length === 2 && store.get().tabs.every((t) => t.title.startsWith('plain')))
  const tabOne = store.get().tabs.find((t) => t.url.endsWith('/plain/one'))!
  const tabTwo = store.get().tabs.find((t) => t.url.endsWith('/plain/two'))!
  const idOf = (v: { get(): Parameters<typeof activeTab>[0] }) => activeTab(v.get())?.url.split('/').at(-1) ?? 'none'
  const second0 = manager.extraWindows().length
  const blank = manager.openWindow({ commandBar: false })
  check('a second window opens over the same tabs, with none selected, and the main window keeps its tab', manager.extraWindows().length === second0 + 1 && blank.kind === 'window' && blank.store.get().tabs.length === store.get().tabs.length && activeTab(blank.store.get()) === undefined && activeTab(store.get())?.id === tabTwo.id)
  await waitFor(() => exec<boolean>(blank.win, '!!window.lucium && !!document.querySelector(".space-header-name")').catch(() => false))
  const blankSnapshot = await snapshotOf(blank.win)
  check('its UI shows the shared tabs through its own snapshot (private flag off, same space)', blankSnapshot.private !== true && blankSnapshot.state.tabs.length === store.get().tabs.length && blankSnapshot.state.activeSpaceId === store.get().activeSpaceId)
  await exec(blank.win, `window.lucium.dispatch({ type: 'tab/select', id: ${JSON.stringify(tabOne.id)} })`)
  check('selecting a tab in the second window leaves the main window’s selection alone', activeTab(blank.store.get())?.id === tabOne.id && activeTab(store.get())?.id === tabTwo.id, `second ${idOf(blank.store)}, main ${idOf(store)}`)
  check('the page of that tab now lives in the second window only', await waitFor(() => blank.browser.ownsPage(tabOne.id) && !browser.ownsPage(tabOne.id)), `second ${blank.browser.ownsPage(tabOne.id)}, main ${browser.ownsPage(tabOne.id)}`)
  blank.browser.dispatch({ type: 'tab/select', id: tabTwo.id })
  check('a tab is shown by one window at a time: selecting the main window’s tab takes it from there', activeTab(blank.store.get())?.id === tabTwo.id && activeTab(store.get()) === undefined && (await waitFor(() => blank.browser.ownsPage(tabTwo.id) && !browser.ownsPage(tabTwo.id))))
  browser.dispatch({ type: 'tab/select', id: tabOne.id })
  check('...and back', activeTab(store.get())?.id === tabOne.id && activeTab(blank.store.get())?.id === tabTwo.id)
  await exec(blank.win, `window.lucium.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })`)
  check('hiding the sidebar in the second window does not hide it in the main one', blank.store.get().settings.sidebarVisible === false && store.get().settings.sidebarVisible === true)
  blank.browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  const sharedProfile = store.get().spaces.find((sp) => sp.id === store.get().activeSpaceId)?.profileId ?? 'default'
  await session.fromPartition(`persist:profile-${sharedProfile}`).cookies.set({ url: base, name: 'shared', value: '1' })
  blank.browser.dispatch({ type: 'tab/open', url: `${base}/shared-cookie` })
  check('the second window browses with the same profile (it sees the cookie the main one has)', await waitFor(() => (blank.store.get().tabs.find((t) => t.url.endsWith('/shared-cookie'))?.title ?? '').includes('shared=1')), String(blank.store.get().tabs.find((t) => t.url.endsWith('/shared-cookie'))?.title))
  blank.browser.dispatch({ type: 'tab/open', url: `${base}/geo?window` })
  const promptInSecond = await waitFor(() => blank.browser.currentPanel() === 'permission')
  check('a permission prompt from the second window opens in the second window', promptInSecond && browser.currentPanel() !== 'permission', `second ${blank.browser.currentPanel()}, main ${browser.currentPanel()}`)
  const windowPrompt = blank.browser.currentOverlay()
  if (windowPrompt?.panel === 'permission') blank.browser.answerPermission(windowPrompt.request.id, false, false)
  blank.browser.dispatch({ type: 'tab/open', url: `${base}/download-w` })
  check('a download from the second window is listed in both windows', await waitFor(() => browser.snapshot().downloads.some((d) => d.filename === 'extra-window.bin' && d.state === 'completed') && blank.browser.snapshot().downloads.some((d) => d.filename === 'extra-window.bin')))
  check('a tab alive in the main window is not drawn as asleep in the second one', blank.browser.snapshot().runtime.tabs[tabOne.id]?.awake === true && browser.snapshot().runtime.tabs[tabOne.id]?.awake === true)
  blank.browser.dispatch({ type: 'tab/open', url: `${base}/download-link` })
  await waitFor(() => blank.store.get().tabs.some((t) => t.url.endsWith('/download-link') && t.title === 'download-link'))
  const linkTab = blank.store.get().tabs.find((t) => t.url.endsWith('/download-link'))!
  const downloadsSeen = browser.snapshot().downloads.length
  const idsSeen = new Set(browser.snapshot().downloads.map((d) => d.id))
  await blank.browser.pageFor(linkTab.id)?.evaluate(`document.getElementById('d').click()`)
  await waitFor(() => browser.snapshot().downloads.length > downloadsSeen)
  // The witness: the end of that download, the last thing it does; the tab that started it is looked at after it.
  await waitFor(() => browser.snapshot().downloads.some((d) => !idsSeen.has(d.id) && d.state !== 'progressing'))
  check('a download started from a page loaded in the second window keeps that tab', browser.snapshot().downloads.length > downloadsSeen && blank.store.get().tabs.some((t) => t.id === linkTab.id))
  // The main window, cleared at the start of the suite, is left as it was: nothing over it before ⌘N, and no command bar nor anything else after.
  const mainPanelBefore = browser.currentPanel()
  const ordered = manager.openWindow({ commandBar: true })
  check('New Window (⌘N) opens the command bar in the new window', (await waitFor(() => ordered.browser.currentPanel() === 'commandbar')) && mainPanelBefore === null && browser.currentPanel() === null, `new ${ordered.browser.currentPanel()}, main ${browser.currentPanel()} (was ${mainPanelBefore})`)
  const overlayOfNew = ordered.win.contentView.children.map((v) => (v as unknown as { webContents?: Electron.WebContents }).webContents).find((wc) => wc?.getURL().includes('overlay'))
  check('...and the command bar is really drawn there', !!overlayOfNew && (await waitFor(async () => (await overlayOfNew.executeJavaScript(`!!document.querySelector('input')`).catch(() => false)) === true)))
  // The system lists the windows of an application by their title (the Dock): a window with no name is titled by the page it shows.
  ordered.browser.dispatch({ type: 'tab/open', url: `${base}/plain/titled` })
  check('a window without a name is titled by the page it shows (what the Dock lists)', await waitFor(() => ordered.win.getTitle() === 'plain /plain/titled'), ordered.win.getTitle())
  const newEntry2 = menuItem('Nouvelle fenêtre')
  const windowsBefore = manager.extraWindows().length
  newEntry2?.click()
  check('File › New Window creates a window from the menu', manager.extraWindows().length === windowsBefore + 1)
  const tabsBeforeClose = store.get().tabs.length
  const pagesBeforeClose = engine.pageCount()
  manager.closeOtherWindows()
  check('closing the other windows leaves the shared tabs where they are', await waitFor(() => manager.list().length === 1 && blank.win.isDestroyed() && ordered.win.isDestroyed()) && store.get().tabs.length >= tabsBeforeClose)
  await waitFor(() => engine.pageCount() < pagesBeforeClose)
  browser.dispatch({ type: 'tab/open', url: `${base}/plain/after` })
  check('the main window carries on normally after a second window closed', await waitFor(() => store.get().tabs.some((t) => t.url.endsWith('/plain/after') && t.title === 'plain /plain/after')))

  // ---- a quiet baseline: no main tab is still changing the state file ----
  for (const tab of [...store.get().tabs]) browser.dispatch({ type: 'tab/close', id: tab.id })
  browser.dispatch({ type: 'settings/update', patch: { ...adsBlockingPatch(false), blockCookieBanners: false } })
  browser.setExtraBlockedHosts([])
  history.of('default').record('https://seed.example/', 'seed page')
  await sleep(1500)
  store.flush()
  history.flush()
  const stateBefore = readFileSync(statePath, 'utf8')
  const historyBefore = readFileSync(historyPath, 'utf8')
  const partitionsDir = join(userData, 'Partitions')
  const partitionsBefore = existsSync(partitionsDir) ? readdirSync(partitionsDir).sort() : []
  const mainTabsBefore = store.get().tabs.length
  const mainSpacesBefore = store.get().spaces.length
  const downloadsBefore = browser.snapshot().downloads.length
  await sleep(500)
  const baseline = {
    pages: engine.pageCount(),
    scopes: engine.ephemeralCount(),
    windows: BrowserWindow.getAllWindows().length,
    contents: allWebContents.getAllWebContents().length
  }

  // ---- the window ----
  const opened = manager.openPrivate()
  const priv = opened.win
  check('a private window opens, with its own browser and a state of its own', manager.privateWindows().length === 1 && opened.store !== store && opened.browser !== browser && opened.browser.isPrivate() && !browser.isPrivate())
  // ...but a private window says nothing of what it shows.
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/plain/hidden-title` })
  await waitFor(() => opened.store.get().tabs.some((t) => t.title === 'plain /plain/hidden-title'))
  check('a private window keeps a title that tells nothing about its page', !priv.getTitle().includes('hidden-title'), priv.getTitle())
  // The window goes back to the state the checks below expect: no tab.
  for (const tab of [...opened.store.get().tabs]) opened.browser.dispatch({ type: 'tab/close', id: tab.id })
  await waitFor(() => opened.store.get().tabs.length === 0)
  opened.browser.openOverlay({ panel: 'archive' })
  opened.browser.openOverlay({ panel: 'spaces' })
  check('the private window does not open the archive or the space manager', opened.browser.currentPanel() === null)
  browser.dispatch({ type: 'settings/update', patch: { peekWithShift: !store.get().settings.peekWithShift } })
  const spaceId = opened.store.get().spaces[0]!.id
  // The + of the sidebar opens a popover (new space, folder…) in a normal window; a private window has nothing of the sort to offer.
  const plusAnchor = { x: 283, y: 847, width: 32, height: 32 }
  opened.browser.openOverlay({ panel: 'plus', anchor: plusAnchor })
  const plusInPrivate = opened.browser.currentPanel()
  browser.openOverlay({ panel: 'plus', anchor: plusAnchor })
  const plusInMain = browser.currentPanel()
  browser.closeOverlay()
  check(
    'the private window offers no space menu and no popover behind the +, the main window still has it',
    menuItems({ kind: 'space', id: spaceId }, opened.browser, opened.store, priv).length === 0 &&
      menuItems({ kind: 'space', id: store.get().spaces[0]!.id }, browser, store, mainWin).length > 0 &&
      plusInPrivate === null &&
      plusInMain === 'plus',
    `private: ${plusInPrivate}, main: ${plusInMain}`
  )
  check('it follows a setting changed in the main window', opened.store.get().settings.peekWithShift === store.get().settings.peekWithShift)
  check('the private window has one space and no tabs, the main window is untouched', opened.store.get().spaces.length === 1 && opened.store.get().tabs.length === 0 && store.get().tabs.length === mainTabsBefore)
  await waitFor(() => exec<boolean>(priv, '!!window.lucium && !!document.querySelector(".space-header-name")').catch(() => false))
  const privSnapshot = await snapshotOf(priv)
  const mainSnapshot = await snapshotOf(mainWin)
  check('IPC answers each window with its own state: the private UI gets the private snapshot', privSnapshot.private === true && privSnapshot.state.spaces.length === 1 && privSnapshot.state.spaces[0]!.name === privateSpaceName(), privSnapshot.state.spaces.map((s) => s.name).join(','))
  check('...and the main UI still gets the main one', mainSnapshot.private !== true && mainSnapshot.state.spaces.length === mainSpacesBefore, `${mainSnapshot.state.spaces.length} spaces`)

  const look = await exec<{ header: string; dark: boolean; background: string; switcher: string; actionList: boolean; privateClass: boolean }>(
    priv,
    `({
      header: document.querySelector('.space-header-name')?.textContent ?? '',
      dark: !!document.querySelector('.shell.dark'),
      background: getComputedStyle(document.querySelector('.shell')).backgroundImage,
      switcher: getComputedStyle(document.querySelector('.footer .spaces')).display,
      actionList: !!customElements.get('browser-action-list'),
      privateClass: document.documentElement.classList.contains('private')
    })`
  )
  const [r, g, b] = [14, 15, 21]
  check('the sidebar says "Onglets privés", is dark (#0e0f15) and has no space switcher', look.header === privateSpaceName() && look.dark && look.background.includes(`rgb(${r}, ${g}, ${b})`) && look.switcher === 'none' && look.privateClass, JSON.stringify(look))
  check(`the background is ${PRIVATE_BACKGROUND}`, look.background.includes('rgb(14, 15, 21)'), look.background)
  const mainLook = await exec<{ actionList: boolean; privateClass: boolean }>(mainWin, `({ actionList: !!customElements.get('browser-action-list'), privateClass: document.documentElement.classList.contains('private') })`)
  check('the extension toolbar element exists in the main window, not in the private one', mainLook.actionList && !look.actionList && !mainLook.privateClass, JSON.stringify({ main: mainLook, private: look }))

  // ---- the private UI drives the private browser only ----
  await exec(priv, `window.lucium.dispatch({ type: 'tab/open', url: ${JSON.stringify(`${base}/cookie?${secret}`)} })`)
  check('a tab opened from the private UI lands in the private state only', opened.store.get().tabs.length === 1 && store.get().tabs.length === mainTabsBefore)
  await exec(priv, `window.lucium.dispatch({ type: 'space/create', name: 'Nope', emoji: 'x', hue: 10 })`)
  await exec(priv, `window.lucium.dispatch({ type: 'tab/pin', id: ${JSON.stringify(opened.store.get().tabs[0]!.id)} })`)
  check('the private window refuses a new space and pinned tabs', opened.store.get().spaces.length === 1 && !opened.store.get().tabs.some((t) => t.pinned) && store.get().spaces.length === mainSpacesBefore)

  // ---- cookies and storage: kept inside the window, never shared ----
  check('the private page loaded without any cookie', await waitFor(() => titleOf(opened, secret) === 'seen:|'), String(titleOf(opened, secret)))
  opened.browser.nav('reload')
  check('within the window, the cookie and the stored value are kept (reload sees them)', await waitFor(() => titleOf(opened, secret) === 'seen:pk=private|stored'), String(titleOf(opened, secret)))
  const profileId = store.get().spaces.find((s) => s.id === store.get().activeSpaceId)?.profileId ?? 'default'
  const normalSession = session.fromPartition(`persist:profile-${profileId}`)
  check('the main window’s profile never received the private cookie', (await normalSession.cookies.get({ name: 'pk' })).length === 0)
  mainUrls.push(`${base}/cookie?${normalToken}`)
  browser.dispatch({ type: 'tab/open', url: mainUrls.at(-1)! })
  // Cookies are shared by every port of a host, so the main profile may hold an unrelated cookie of 127.0.0.1: only the private one matters.
  const normalSeen = await waitFor(() => (titleOf({ store }, normalToken) ?? '').startsWith('seen:'))
  const normalTitle = titleOf({ store }, normalToken) ?? ''
  check('a normal tab of the same site does not see the private cookie nor the private storage', normalSeen && !normalTitle.includes('pk=private') && !normalTitle.endsWith('stored'), normalTitle)
  const privSession = session.fromPartition('ephemeral-1')
  check('the private session is memory only (not persistent, no folder)', !privSession.isPersistent() && privSession.getStoragePath() === null)
  check('it holds the cookie while the window is open', (await privSession.cookies.get({ name: 'pk' })).length === 1)

  // ---- history, archive, suggestions ----
  check('the private visit is not in the history', history.of('default').search(secret).length === 0 && opened.browser.searchHistory('').length === 0)
  check('the command bar of the private window suggests nothing from the history, the main one does', opened.browser.searchHistory('seed').length === 0 && browser.searchHistory('seed').length >= 1)
  const closing = opened.store.get().tabs[0]!
  opened.browser.dispatch({ type: 'tab/archive', id: closing.id })
  check('closing a private tab archives nothing and shows no "archived" notice', opened.store.get().archive.length === 0 && opened.store.get().tabs.length === 0 && opened.browser.snapshot().toast === null)
  opened.browser.dispatch({ type: 'archive/restore-last' })
  check('there is nothing to reopen', opened.store.get().tabs.length === 0)

  // ---- favicons are fetched through the private session ----
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/fav?${secret}` })
  check('a favicon reaches the sidebar as data fetched by the private session', await waitFor(() => titleOf(opened, `/fav?${secret}`) === 'fav' && (opened.store.get().tabs.find((t) => t.url.includes('/fav?'))?.faviconUrl ?? '').startsWith('data:image/png;base64,')), String(opened.store.get().tabs.find((t) => t.url.includes('/fav?'))?.faviconUrl).slice(0, 40))
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/nofav?${secret}` })
  await waitFor(() => titleOf(opened, `/nofav?${secret}`) === 'nofav')
  await waitFor(() => faviconPaths.includes('/missing.png'))
  // A fixed wait, for want of a witness: a favicon that cannot be fetched ends with nothing the shell is told of, so only time says that none came.
  await sleep(800)
  check('a favicon that cannot be fetched leaves the tab without one', opened.store.get().tabs.find((t) => t.url.includes('/nofav?'))?.faviconUrl === undefined)

  // ---- downloads work, and stay in the window that started them ----
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/download` })
  check('a download from the private window completes', await waitFor(() => opened.browser.snapshot().downloads.some((d) => d.filename === 'window-smoke.bin' && d.state === 'completed')), JSON.stringify(opened.browser.snapshot().downloads.map((d) => d.state)))
  const file = opened.browser.snapshot().downloads.find((d) => d.filename === 'window-smoke.bin')
  check('...the file is on disk, listed in the private window and not in the main window', !!file && existsSync(file.path) && browser.snapshot().downloads.length === downloadsBefore && !browser.snapshot().downloads.some((d) => d.filename === 'window-smoke.bin'))

  // ---- permissions are asked in the window that needs the answer ----
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/geo` })
  check('a permission prompt opens in the private window, not in the main one', (await waitFor(() => opened.browser.currentPanel() === 'permission')) && browser.currentPanel() !== 'permission', `private ${opened.browser.currentPanel()}, main ${browser.currentPanel()}`)
  const prompt = opened.browser.currentOverlay()
  if (prompt?.panel === 'permission') opened.browser.answerPermission(prompt.request.id, false, true)
  const origin = new URL(base).origin
  check('...its answer is remembered by the private window only', opened.store.get().sitePermissions[origin]?.['geolocation'] === 'deny' && store.get().sitePermissions[origin] === undefined, JSON.stringify({ private: opened.store.get().sitePermissions[origin], main: store.get().sitePermissions[origin] }))

  // ---- request blocking is the window's own ----
  opened.store.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
  opened.browser.setExtraBlockedHosts(['localhost'])
  const hitsBefore = { third: thirdPartyHits, first: firstPartyHits }
  opened.browser.dispatch({ type: 'tab/open', url: `${base}/ad-page?private` })
  const privateAdTab = opened.store.get().tabs.at(-1)!.id
  // The witness: the end of the load of the page, which waits for both of its scripts; a request the filter let through has reached the server by then.
  await waitFor(() => firstPartyHits > hitsBefore.first)
  await waitFor(() => opened.browser.snapshot().runtime.tabs[privateAdTab]?.loading === false)
  check('the private window blocks a third-party script with its own filter', thirdPartyHits === hitsBefore.third && firstPartyHits === hitsBefore.first + 1, `third ${thirdPartyHits - hitsBefore.third}, first ${firstPartyHits - hitsBefore.first}`)
  mainUrls.push(`${base}/ad-page?main`)
  browser.dispatch({ type: 'tab/open', url: mainUrls.at(-1)! })
  await waitFor(() => firstPartyHits > hitsBefore.first + 1)
  check('...and the main window, which does not block, still loads it (the private filter did not replace the main one)', await waitFor(() => thirdPartyHits === hitsBefore.third + 1), `third ${thirdPartyHits - hitsBefore.third}`)

  // ---- the main window keeps its own engine hooks ----
  mainUrls.push(`${base}/geo?main`)
  browser.dispatch({ type: 'tab/open', url: mainUrls.at(-1)! })
  check('a permission prompt of the main window still opens in the main window', await waitFor(() => browser.currentPanel() === 'permission'))
  const mainPrompt = browser.currentOverlay()
  if (mainPrompt?.panel === 'permission') browser.answerPermission(mainPrompt.request.id, false, false)
  await waitFor(() => browser.currentPanel() === null)
  check('the main window’s answer does not reach the private window', opened.browser.currentPanel() === null || opened.browser.currentPanel() !== 'permission')

  // ---- the menu acts on the window with the focus ----
  priv.emit('focus')
  check('focusing the private window rebuilds the menu for it: Archive entries are disabled', menuItem('Afficher l’archive…')?.enabled === false && menuItem('Nouvel onglet…')?.enabled !== false)
  const privateEntry = menuItem('Nouvelle fenêtre privée')
  const blankEntry = menuItem('Fenêtre vierge')
  const newEntry = menuItem('Nouvelle fenêtre')
  check('File has New Window ⌘N, Blank Window ⌃⌘N and New Private Window ⇧⌘N', newEntry?.accelerator === 'CmdOrCtrl+N' && blankEntry?.accelerator === 'Ctrl+CmdOrCtrl+N' && privateEntry?.accelerator === 'CmdOrCtrl+Shift+N', JSON.stringify([newEntry?.accelerator, blankEntry?.accelerator, privateEntry?.accelerator]))
  opened.browser.closeOverlay()
  menuItem('Nouvel onglet…')?.click()
  check('"New tab" from the menu opens the command bar of the focused (private) window only', opened.browser.currentPanel() === 'commandbar' && browser.currentPanel() === null)
  opened.browser.closeOverlay()
  mainWin.emit('focus')
  check('focusing the main window rebuilds the menu for it: the archive is available again', menuItem('Afficher l’archive…')?.enabled === true)
  menuItem('Nouvel onglet…')?.click()
  check('"New tab" now opens the command bar of the main window only', browser.currentPanel() === 'commandbar' && opened.browser.currentPanel() === null)
  browser.closeOverlay()

  // ---- a second private window is a window of its own ----
  const second = manager.openPrivate()
  check('a second private window has its own state and session', manager.privateWindows().length === 2 && second.store !== opened.store && second.store.get().spaces[0]!.id !== opened.store.get().spaces[0]!.id)
  second.browser.dispatch({ type: 'tab/open', url: `${base}/cookie?second-${secret}` })
  check('...and does not see the first one’s cookie', await waitFor(() => titleOf(second, `second-${secret}`) === 'seen:|'), String(titleOf(second, `second-${secret}`)))
  second.win.close()
  check('closing one private window leaves the other open', await waitFor(() => manager.privateWindows().length === 1) && !opened.win.isDestroyed())

  // ---- closing the window frees everything ----
  for (const tab of [...store.get().tabs]) browser.dispatch({ type: 'tab/close', id: tab.id })
  await sleep(500)
  mainWin.emit('blur')
  priv.emit('focus')
  if (BrowserWindow.getFocusedWindow() && BrowserWindow.getFocusedWindow() !== priv) priv.focus()
  menuItem('Fermer la fenêtre')?.click()
  check('File › Close Window closes the focused (private) window', await waitFor(() => manager.privateWindows().length === 0 && priv.isDestroyed()))
  await manager.settled()
  await waitFor(() => engine.pageCount() === baseline.pages && allWebContents.getAllWebContents().length === baseline.contents)
  check('closing the windows destroys their pages, views and private contexts', engine.pageCount() === baseline.pages && engine.ephemeralCount() === baseline.scopes && BrowserWindow.getAllWindows().length === baseline.windows && allWebContents.getAllWebContents().length === baseline.contents, JSON.stringify({ pages: engine.pageCount(), scopes: engine.ephemeralCount(), windows: BrowserWindow.getAllWindows().length, contents: allWebContents.getAllWebContents().length, baseline }))
  check('the private session was emptied when its window closed', (await privSession.cookies.get({})).length === 0)
  const reopened = manager.openPrivate()
  reopened.browser.dispatch({ type: 'tab/open', url: `${base}/cookie?again-${secret}` })
  check('a window opened afterwards starts clean: no cookie, no stored value', await waitFor(() => titleOf(reopened, `again-${secret}`) === 'seen:|'), String(titleOf(reopened, `again-${secret}`)))
  reopened.win.close()
  await waitFor(() => manager.privateWindows().length === 0)
  await manager.settled()

  // ---- nothing was written ----
  await sleep(500)
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
  for (const tab of [...store.get().tabs]) browser.dispatch({ type: 'tab/close', id: tab.id })
  store.flush()
  history.flush()
  const stateAfter = readFileSync(statePath, 'utf8')
  const historyAfter = readFileSync(historyPath, 'utf8')
  check('no trace of the private visits in state.json or history.json', !stateAfter.includes(secret) && !historyAfter.includes(secret) && !stateAfter.includes('Onglets privés'))
  check('state.json has the same content as before the private windows', JSON.stringify(JSON.parse(stateAfter).spaces) === JSON.stringify(JSON.parse(stateBefore).spaces) && JSON.parse(stateAfter).archive.length === JSON.parse(stateBefore).archive.length && JSON.parse(stateAfter).favorites.length === JSON.parse(stateBefore).favorites.length)
  const urlsOf = (json: string) => (JSON.parse(json) as Array<{ url: string }>).map((e) => e.url)
  const added = urlsOf(historyAfter).filter((url) => !urlsOf(historyBefore).includes(url))
  check('history.json only gained what the main window visited', added.every((url) => mainUrls.includes(url)) && urlsOf(historyBefore).every((url) => urlsOf(historyAfter).includes(url)), JSON.stringify(added))
  const partitionsAfter = existsSync(partitionsDir) ? readdirSync(partitionsDir).sort() : []
  const mainProfiles = new Set(store.get().spaces.map((sp) => `profile-${sp.profileId}`))
  const newPartitions = partitionsAfter.filter((name) => !partitionsBefore.includes(name))
  const leftovers = readdirSync(userData, { recursive: true }).map(String).filter((name) => /ephemeral|private/i.test(name))
  check('no session folder was created on disk for the private windows (only the main profile’s own)', newPartitions.every((name) => mainProfiles.has(name)) && leftovers.length === 0, JSON.stringify({ partitionsBefore, partitionsAfter, leftovers: leftovers.slice(0, 6) }))
  server.close()
}

/** The same checks with their own report, for the local branching in index.ts. Returns the exit code. */
export async function runWindowsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const check: Check = recorderOf(checks)
  try {
    await smokeWindows(ctx, check)
  } catch (error) {
    check('smokeWindows ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_WINDOWS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
