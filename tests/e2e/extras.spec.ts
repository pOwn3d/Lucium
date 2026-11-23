// More functions read where they act: the page (the palette a site is given), the windows of the application (a window of its own for a site,
// a second window and its tabs), the drag of a tab onto the page (the same messages the sidebar sends while the user drags), the requests a
// function makes for itself (the icon of a favourite), the menu (an entry greyed out). Each with its control, the function off.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchLucium, TEST_DOMAIN, type Running } from './launch'
import {
  callBridge,
  chooseMenuEntry,
  chooseMenuLabel,
  dismissWelcome,
  dispatch,
  editStateOnDisk,
  openTab,
  serveSite,
  setSettings,
  snapshotOf,
  titledPage,
  waitForPanel,
  waitForState,
  waitForStateFile,
  expectStays,
  overlayPage,
  type LocalSite
} from './helpers'

let site: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B'), '/app': titledPage('Application') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  site.requests.length = 0
  running = await launchLucium()
  await dismissWelcome(running.app, running.page)
})

test.afterEach(async () => {
  await running.close()
})

const url = (path: string) => `${site.origin}${path}`

/** The pages of the main windows of the application (index.html, not the floating sidebar `#float`). */
const mainWindows = (app: ElectronApplication): Page[] => app.windows().filter((page) => page.url().endsWith('/index.html'))

test('theme-to-sites: a page is given the palette of its space while on; off, it is given none', async () => {
  const palette = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-background').trim())
  await setSettings(running.page, { allowThemeToSites: true })
  const tab = await openTab(running, url('/a'), 'Page A')
  await expect.poll(() => palette(tab.page)).not.toBe('')
  await setSettings(running.page, { allowThemeToSites: false })
  await expect.poll(() => palette(tab.page)).toBe('')
})

test('drag-to-split: a tab dropped on the right of the page makes a split view while on; off, the drop does nothing', async () => {
  const dragged = await openTab(running, url('/a'), 'Page A')
  const shown = await openTab(running, url('/b'), 'Page B')
  await setSettings(running.page, { dragToSplit: false })
  await callBridge(running.page, 'splitDrag', 'start', dragged.id)
  // With the function on, the page shows a veil to drop the tab on (awaited below): off, it never comes.
  const layer = await overlayPage(running.app)
  await expectStays(() => layer.locator('.split-drop').count(), 0, 'no veil to drop on while the function is off', 600)
  await callBridge(running.page, 'splitDrop', 'right')
  await callBridge(running.page, 'splitDrag', 'end')
  await expectStays(async () => (await snapshotOf(running.page)).state.splits, [], 'the drop makes no split view while the function is off', 800)

  await setSettings(running.page, { dragToSplit: true })
  await callBridge(running.page, 'splitDrag', 'start', dragged.id)
  // The veil the page shows while a tab is dragged over it.
  await waitForPanel(running.app, '.split-drop')
  await callBridge(running.page, 'splitDrop', 'right')
  const state = await waitForState(running.page, (s) => s.state.splits.length === 1, 'split view made by the drop')
  expect([...(state.state.splits[0] as unknown as { tabIds: string[] }).tabIds].sort()).toEqual([dragged.id, shown.id].sort())
})

test('independent-windows: a new window has tabs of its own while on; off, it lists the tabs of the first window', async () => {
  const tabsOfSecond = async (): Promise<string[]> => {
    const before = mainWindows(running.app).length
    await chooseMenuEntry(running.app, 'CmdOrCtrl+N')
    await expect.poll(() => mainWindows(running.app).length).toBe(before + 1)
    const second = mainWindows(running.app).find((page) => page !== running.page)!
    await second.waitForLoadState('domcontentloaded')
    return (await snapshotOf(second)).state.tabs.map((tab) => tab.url)
  }
  await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { independentWindows: false })
  await expect.poll(tabsOfSecond).toContain(url('/a'))
  // Back to one window before the second try: the windows opened after the first are closed.
  await running.app.evaluate(({ BrowserWindow }) => {
    const mains = BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().endsWith('/index.html')).sort((x, y) => x.id - y.id)
    for (const window of mains.slice(1)) window.close()
  })
  await expect.poll(() => mainWindows(running.app).length).toBe(1)

  await setSettings(running.page, { independentWindows: true })
  expect(await tabsOfSecond()).not.toContain(url('/a'))
})

test('pwa: Open as application opens the site in a window of its own while on; off, nothing opens', async () => {
  const windows = () => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  await openTab(running, url('/app'), 'Application')
  await setSettings(running.page, { webAppWindows: false })
  const before = await windows()
  await callBridge(running.page, 'openAsApp')
  await expectStays(windows, before, 'no window opens while the function is off', 1000)

  await setSettings(running.page, { webAppWindows: true })
  await callBridge(running.page, 'openAsApp')
  await expect.poll(windows).toBe(before + 1)
  await expect.poll(() => running.app.windows().filter((page) => page.url() === url('/app')).length).toBeGreaterThan(0)
})

test('web-store: Extensions › Open the Chrome Web Store can be chosen while on; off, it is greyed out', async () => {
  // Read, never chosen: the store is on the Internet.
  await setSettings(running.page, { webStoreInstall: true })
  await expect.poll(() => chooseMenuLabel(running.app, 'Chrome Web Store', { click: false })).toBe('ok')
  await setSettings(running.page, { webStoreInstall: false })
  await expect.poll(() => chooseMenuLabel(running.app, 'Chrome Web Store', { click: false })).toBe('disabled')
})

test('favicons: the site of a favourite without an icon is asked for its icon while on; off, it is asked nothing', async () => {
  // A site of its own, which no tab opens: what it receives comes from the lookup of the icon. The lookup never asks a host of this machine
  // (favicon-resolver.ts): the site is reached under a test host name (launch.ts).
  for (const on of [false, true]) {
    const icons = await serveSite({ '/': titledPage('Accueil'), '/favicon.ico': { body: '', type: 'image/x-icon' } })
    try {
      await setSettings(running.page, { resolveFavicons: on })
      await dispatch(running.page, { type: 'favorite/add', url: `http://icons-${on}.${TEST_DOMAIN}:${icons.port}/page`, title: `Favori ${on}` })
      await waitForState(running.page, (s) => s.state.favorites.some((favorite) => favorite.title === `Favori ${on}`), 'the favourite')
      if (on) await expect.poll(() => icons.requests.length, { timeout: 10_000 }).toBeGreaterThan(0)
      else await expectStays(() => icons.requests.map((request) => request.path), [], 'no icon is asked for while the function is off', 2500)
    } finally {
      await icons.close()
    }
  }
})

// The first look at the feed comes 20 s after the function starts (AUTO_UPDATE_FIRST_DELAY_MS): the test waits that long, twice.
test('auto-update: the feed of the updates is asked while on; off, it is never asked', async () => {
  test.setTimeout(150_000)
  // The feed must be an https:// address: a server of the tests in https, whose certificate the application is told to accept.
  const feed = await serveSite({ '/feed.json': { body: '{}', type: 'application/json' } }, { secure: true })
  const address = `${feed.origin}/feed.json`
  try {
    // The address of the feed has no control, and the interface may not send it (shared/ipc-policy.ts): it is written by hand in the state file,
    // as the setting is meant to be, and the function is off from the launch on. The switch of the function is the one of the system (shared/platform.ts,
    // `autoUpdateKey`): `autoUpdate` on macOS, `windowsAutoUpdate` on Windows and Linux, where `autoUpdate` stays ON in this phase to show that it asks nothing.
    const windows = process.platform !== 'darwin'
    const key = windows ? 'windowsAutoUpdate' : 'autoUpdate'
    const dataDir = running.dataDir
    await waitForStateFile(dataDir)
    await running.close({ keepData: true })
    editStateOnDisk(dataDir, (state) => Object.assign(state.settings, { autoUpdate: windows, windowsAutoUpdate: false, updateFeedUrl: address }))
    running = await launchLucium({ dataDir, args: ['--ignore-certificate-errors'] })
    await waitForState(running.page, (s) => s.state.settings['updateFeedUrl'] === address && s.state.settings[key] === false, 'the feed of the state file, the function off')
    await expectStays(() => feed.requests.map((request) => request.path), [], 'the feed is not asked while the function is off', 25_000)

    await setSettings(running.page, { [key]: true })
    await expect.poll(() => feed.requests.map((request) => request.path), { timeout: 40_000, intervals: [1000] }).toContain('/feed.json')
  } finally {
    await feed.close()
  }
})
