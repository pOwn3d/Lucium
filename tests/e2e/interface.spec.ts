// The functions that change what the window shows: the toolbar, the rows of the sidebar, the frame of the page, the mode compact, the
// appearance given to the sites. Each test switches its function on and reads the effect in the window (the DOM of the interface, the page of
// the tab, the main process), then switches it off in the same window: the effect must go (the control).

import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, callBridge, dispatch, openTab, serveSite, setSettings, snapshotOf, titledPage, waitForState, expectStays, type LocalSite } from './helpers'

let site: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({
    '/a': titledPage('Page A'),
    '/b': titledPage('Page B'),
    '/counter': titledPage('(3) Messages'),
    // A light page that declares no colour scheme: the readable mode (Dark) recolours this one.
    // A light page whose linked sheet puts a picture the server forbids to keep behind the text: the readable mode copies that sheet.
    '/pictured': `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Page à image</title><link rel="stylesheet" href="/pictured.css"></head><body><main><h1>Page à image</h1><p>Texte.</p></main></body></html>`,
    '/pictured.css': { body: 'html, body { background-color: #ffffff; color: #111111; } main { background-image: url(/pixel.svg); }', type: 'text/css' },
    '/pixel.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', type: 'image/svg+xml', headers: { 'cache-control': 'no-store' } },
    '/light': `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Page claire</title><style>html, body { background: #ffffff; color: #111111; }</style></head><body><main><h1>Page claire</h1><p>Texte.</p></main></body></html>`
  })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

const url = (path: string) => `${site.origin}${path}`

/** The classes of the row of a tab in the sidebar. */
const rowClasses = (id: string) => running.page.locator(`.sidebar .tab[data-id="${id}"]`).first().evaluate((row) => [...row.classList])

test('full-url: the toolbar shows the whole address while on; off, only the host', async () => {
  await openTab(running, url('/a?x=1'), 'Page A')
  const toolbar = running.page.locator('.page-toolbar .tb-url')
  await setSettings(running.page, { fullUrlInToolbar: true })
  await expect(toolbar.locator('.tb-host')).toHaveText(`127.0.0.1:${site.port}`)
  await expect(toolbar.locator('.tb-rest')).toHaveText('/a?x=1')

  await setSettings(running.page, { fullUrlInToolbar: false })
  await expect(toolbar.locator('.tb-host')).toHaveText(`127.0.0.1:${site.port}`)
  await expect(toolbar.locator('.tb-rest')).toHaveCount(0)
})

test('reload-all-button: the two reload buttons are in the sidebar while on, and reload the pages; off, they are gone', async () => {
  await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { showReloadAllButton: true })
  const buttons = running.page.locator('.sidebar .sidebar-reload-all')
  await expect(buttons).toHaveCount(2)
  const before = site.requests.filter((request) => request.path === '/a').length
  await buttons.first().click()
  await expect.poll(() => site.requests.filter((request) => request.path === '/a').length).toBeGreaterThan(before)

  await setSettings(running.page, { showReloadAllButton: false })
  await expect(buttons).toHaveCount(0)
})

test('favorite-names: the favourites are drawn with their names while on; off, as icons only', async () => {
  await openTab(running, url('/a'), 'Page A')
  await dispatch(running.page, { type: 'favorite/add', url: url('/a'), title: 'Favori A' })
  await waitForState(running.page, (s) => s.state.favorites.length === 1, 'favourite')
  const favorites = running.page.locator('.sidebar .favorites')
  await setSettings(running.page, { favoriteNames: true })
  await expect(favorites).toHaveClass(/\bnamed\b/)
  await setSettings(running.page, { favoriteNames: false })
  await expect(favorites).not.toHaveClass(/\bnamed\b/)
})

test('tab-state-badges: a tab put to sleep wears the mark of its state while on; off, the row has no state mark', async () => {
  const asleep = await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  await setSettings(running.page, { tabStateBadges: true })
  await callBridge(running.page, 'sleepTab', asleep.id)
  await expect.poll(() => rowClasses(asleep.id)).toContain('st-asleep')

  await setSettings(running.page, { tabStateBadges: false })
  await expect.poll(async () => (await rowClasses(asleep.id)).filter((name) => name.startsWith('st-'))).toEqual([])
})

test('card-outline: the frame of the page has its outline while on; off, it has not', async () => {
  const shell = running.page.locator('.shell').first()
  await setSettings(running.page, { cardOutline: true })
  await expect(shell).toHaveClass(/\boutlined\b/)
  await setSettings(running.page, { cardOutline: false })
  await expect(shell).not.toHaveClass(/\boutlined\b/)
})

test('zoom-indicator: a page zoomed in shows its zoom in the toolbar while on; off, nothing is shown', async () => {
  const tab = await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { showZoomIndicator: true })
  await chooseMenuEntry(running.app, 'CmdOrCtrl+Plus')
  await expect.poll(() => tab.page.evaluate(() => (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio)).toBeGreaterThan(await running.page.evaluate(() => (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio))
  await expect(running.page.locator('.page-toolbar .tb-zoom')).toHaveCount(1)

  await setSettings(running.page, { showZoomIndicator: false })
  await expect(running.page.locator('.page-toolbar .tb-zoom')).toHaveCount(0)
})

test('compact-mode: the command of the mode compact hides the sidebar and the toolbar while on; off, the same command changes nothing', async () => {
  await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { compactMode: false })
  await dispatch(running.page, { type: 'compact/toggle' })
  const shown = async () => {
    const read = (await snapshotOf(running.page)).state.settings
    return [read['sidebarVisible'], read['showToolbar']]
  }
  await expectStays(shown, [true, true], 'the sidebar and the toolbar stay while the compact mode is off', 500)
  let settings = (await snapshotOf(running.page)).state.settings

  await setSettings(running.page, { compactMode: true })
  await dispatch(running.page, { type: 'compact/toggle' })
  await waitForState(running.page, (s) => s.state.settings['sidebarVisible'] === false && s.state.settings['showToolbar'] === false, 'compact')
  await expect(running.page.locator('.page-toolbar')).toHaveCount(0)
  // The same command brings both bars back.
  await dispatch(running.page, { type: 'compact/toggle' })
  settings = (await waitForState(running.page, (s) => s.state.settings['sidebarVisible'] === true, 'not compact')).state.settings
  expect(settings['showToolbar']).toBe(true)
})

test('tidy-pinned-titles: a tab pinned while on loses the counter of its title; off, it keeps it', async () => {
  const first = await openTab(running, url('/counter'), '(3) Messages')
  await setSettings(running.page, { tidyPinnedTitles: true })
  await dispatch(running.page, { type: 'tab/pin', id: first.id })
  await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === first.id)?.title === 'Messages', 'the title tidied')

  // Control: a second tab of the same page, pinned with the function off.
  await setSettings(running.page, { tidyPinnedTitles: false })
  await dispatch(running.page, { type: 'tab/open', url: url('/counter?again') })
  const state = await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.url === url('/counter?again') && tab.title === '(3) Messages'), 'second tab')
  const second = state.state.tabs.find((tab) => tab.url === url('/counter?again'))!
  await dispatch(running.page, { type: 'tab/pin', id: second.id })
  await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === second.id)?.pinned === true, 'second pinned')
  expect((await snapshotOf(running.page)).state.tabs.find((tab) => tab.id === second.id)?.title).toBe('(3) Messages')
})

/** The colour scheme the page of a tab is given, as its CSS sees it. */
const schemeOf = (page: Page) => page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

test('appearance: View › Appearance › Appearance asked of websites › Dark gives the sites the dark scheme, Light the light one', async () => {
  // The scheme Playwright would force on the pages is left alone here: the page must see the one the application gives it.
  await running.close()
  running = await launchLucium({ colorScheme: null })
  const tab = await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { websiteAppearance: 'dark' })
  await expect.poll(() => schemeOf(tab.page)).toBe('dark')
  await setSettings(running.page, { websiteAppearance: 'light' })
  await expect.poll(() => schemeOf(tab.page)).toBe('light')
})

test('appearance: the interface follows its own setting, and the sites the one asked of them: neither moves the other', async () => {
  await running.close()
  running = await launchLucium({ colorScheme: null })
  const tab = await openTab(running, url('/a'), 'Page A')
  // Lucium dark, sites automatic: the sites follow Lucium.
  await setSettings(running.page, { interfaceAppearance: 'dark', websiteAppearance: 'auto' })
  await expect.poll(() => schemeOf(running.page)).toBe('dark')
  await expect.poll(() => schemeOf(tab.page)).toBe('dark')
  // Lucium light, sites asked for dark: the interface (the window of the tabs) stays light, the page reads dark.
  await setSettings(running.page, { interfaceAppearance: 'light', websiteAppearance: 'dark' })
  await expect.poll(() => schemeOf(running.page)).toBe('light')
  await expect.poll(() => schemeOf(tab.page)).toBe('dark')
  // A page opened while the sites are asked for dark reads it from its first document; back to automatic, the page follows Lucium again.
  const other = await openTab(running, url('/b'), 'Page B')
  await expect.poll(() => schemeOf(other.page)).toBe('dark')
  await setSettings(running.page, { websiteAppearance: 'auto' })
  await expect.poll(() => schemeOf(tab.page)).toBe('light')
  await expect.poll(() => schemeOf(other.page)).toBe('light')
})

test('page contrast: a light page is recoloured (not inverted) while the mode is Dark; on Original, it keeps its colours', async () => {
  // Dark applies to light pages: the window is asked for the light appearance, so that the page is light whatever the Mac says.
  await setSettings(running.page, { websiteAppearance: 'light', readableMode: 'dark' })
  const tab = await openTab(running, url('/light'), 'Page claire')
  // The engine gives the page it recolours its colour scheme; the page's own colours are mapped, no filter is laid on it.
  const look = () => tab.page.evaluate(() => ({ scheme: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(document.body).backgroundColor, filter: getComputedStyle(document.documentElement).filter }))
  await expect.poll(async () => (await look()).scheme, { timeout: 15_000 }).toBe('dark')
  const dark = await look()
  expect(dark.background).not.toBe('rgb(255, 255, 255)')
  expect(dark.filter).toBe('none')

  await setSettings(running.page, { readableMode: 'original' })
  await expect.poll(async () => (await look()).background).toBe('rgb(255, 255, 255)')
})

test('page contrast: the copy of a sheet does not make the page ask again for the pictures the sheet names', async () => {
  // The engine repeats the declarations that may hold a colour, `background-image` among them, with their addresses made whole. A picture
  // served with `no-store` (a pixel of measure put in a sheet) must be asked for once, with the mode as without it.
  const asked = () => site.requests.filter((request) => request.path === '/pixel.svg').length
  await setSettings(running.page, { websiteAppearance: 'light', readableMode: 'original' })
  const plain = await openTab(running, url('/pictured'), 'Page à image')
  await plain.page.waitForLoadState('load')
  await expect.poll(asked).toBe(1)

  await setSettings(running.page, { readableMode: 'dark' })
  await expect.poll(() => plain.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), { timeout: 15_000 }).toBe('dark')
  // The copy is in the page: the picture it names again is the one already there.
  await expectStays(asked, 1, 'the picture of the sheet is not asked for a second time once the sheet is copied', 2500)

  // A page loaded with the mode on asks for it once as well.
  const again = await openTab(running, url('/pictured?again=1'), 'Page à image')
  await again.page.waitForLoadState('load')
  await expect.poll(() => again.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), { timeout: 15_000 }).toBe('dark')
  await expectStays(asked, 2, 'one request for the second page, none for its copy', 2500)
})

test('ui-scale: the size of the interface zooms the window of the interface, and 100 % gives it back', async () => {
  const zoom = () => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))?.webContents.getZoomFactor() ?? 0)
  await setSettings(running.page, { uiScale: 120 })
  await expect.poll(zoom).toBeCloseTo(1.2, 2)
  await setSettings(running.page, { uiScale: 100 })
  await expect.poll(zoom).toBeCloseTo(1, 2)
})
