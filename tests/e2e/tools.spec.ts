// The extra tools (each off by default, or a switch of its own): what they add to the menu and the panels, and what they do in
// a page. The keys and the mouse are sent to the page of the tab the way Playwright sends them to any page; the panels are read in the layer
// of the panels (overlay.html); the commands that have no shortcut are given one first (Settings › Raccourcis does the same).

import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import {
  bindShortcut,
  callBridge,
  chooseMenuEntry,
  chooseMenuLabel,
  dismissWelcome,
  dispatch,
  menuEntryState,
  openTab,
  overlayShown,
  requestPanel,
  serveSite,
  setSettings,
  snapshotOf,
  tabAt,
  titledPage,
  waitForPanel,
  waitForState,
  waitForWindow,
  expectStays,
  type LocalSite
} from './helpers'

let site: LocalSite
let running: Running

/** A page much taller than the window: there is room to scroll. */
const longPage = (title: string) => titledPage(title, '<div style="height: 6000px; background: linear-gradient(#fff, #ddd)">Long</div>')

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B'), '/long': longPage('Longue'), '/long2': longPage('Longue 2') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  site.requests.length = 0
  running = await launchLucium()
  // The sheet of the first launch would take the place of the panels opened here.
  await dismissWelcome(running.app, running.page)
})

test.afterEach(async () => {
  await running.close()
})

const url = (path: string) => `${site.origin}${path}`
const closePanel = () => running.page.evaluate(() => (globalThis as unknown as { lucium: { closeOverlay(): void } }).lucium.closeOverlay())

/** A panel asked for while its function is off opens nothing (the main process refuses the request, whoever sends it). */
async function opensNothing(request: Record<string, unknown>): Promise<void> {
  await requestPanel(running.page, request)
  await expectStays(() => overlayShown(running.app), false, `no panel opens for ${JSON.stringify(request)} while its function is off`, 800)
}

test('qr-code: File › QR code of the page shows the code of the page while on; off, the entry is gone and nothing opens', async () => {
  await openTab(running, url('/a'), 'Page A')
  await bindShortcut(running.page, 'qrCode', 'CmdOrCtrl+Alt+Shift+Q')
  await setSettings(running.page, { qrCode: true })
  await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+Q')).toBe('enabled')
  await chooseMenuEntry(running.app, 'CmdOrCtrl+Alt+Shift+Q')
  const overlay = await waitForPanel(running.app, '.qr-panel')
  await expect(overlay.locator('.qr-panel .qr-code')).toBeVisible()
  await closePanel()

  await setSettings(running.page, { qrCode: false })
  await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+Q')).toBe('missing')
  await opensNothing({ panel: 'qr', text: url('/a') })
})

test('translate-local: the panel of the translation opens on a page while on; off, nothing opens', async () => {
  await openTab(running, url('/a'), 'Page A')
  await setSettings(running.page, { translateLocal: true })
  await requestPanel(running.page, { panel: 'translate' })
  await waitForPanel(running.app, '.card.translate-panel')
  await closePanel()
  await setSettings(running.page, { translateLocal: false })
  await opensNothing({ panel: 'translate' })
})

test('password-manager: the panel of the passwords opens while on; off, nothing opens', async () => {
  await setSettings(running.page, { passwordManager: true })
  await requestPanel(running.page, { panel: 'passwords' })
  await waitForPanel(running.app, '.card.passwords')
  await closePanel()
  await setSettings(running.page, { passwordManager: false })
  await opensNothing({ panel: 'passwords' })
})

test('live-folders: the sheet of a new live folder opens while on; off, nothing opens', async () => {
  await setSettings(running.page, { liveFolders: true })
  await requestPanel(running.page, { panel: 'livefolder' })
  await waitForPanel(running.app, '.card.livefolder')
  await closePanel()
  await setSettings(running.page, { liveFolders: false })
  await opensNothing({ panel: 'livefolder' })
})

/** The functions whose effect is an entry of the menu (choosing it opens a system dialog or acts on the Mac: it is not chosen here). */
for (const [feature, setting, command] of [
  ['pdf-with-source', 'pdfWithSource', 'savePdfSource'],
  ['page-watch', 'pageWatch', 'watchPage'],
  ['battery-saver', 'batterySaver', 'batterySaver']
] as const) {
  test(`${feature}: its entry is in the menu while on; off, it is not`, async () => {
    await openTab(running, url('/a'), 'Page A')
    await bindShortcut(running.page, command, 'CmdOrCtrl+Alt+Shift+P')
    await setSettings(running.page, { [setting]: true })
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+P')).toBe('enabled')
    await setSettings(running.page, { [setting]: false })
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Alt+Shift+P')).toBe('missing')
  })
}

test('user-scripts: a script of the user that is switched on runs in the pages it names while on; off, it does not run', async () => {
  const script = ['// ==UserScript==', '// @name Marqueur e2e', '// @match http://127.0.0.1/*', '// ==/UserScript==', "document.documentElement.setAttribute('data-e2e-userscript', 'ran')"].join('\n')
  const mark = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-e2e-userscript'))
  await setSettings(running.page, { userScripts: true })
  const added = await callBridge<{ ok: boolean; scripts?: Array<{ id: string; name: string }>; error?: string }>(running.page, 'userScripts', { kind: 'add', text: script })
  expect(added.ok, added.error).toBe(true)
  const listed = await callBridge<{ ok: boolean; scripts: Array<{ id: string; name: string }> }>(running.page, 'userScripts', { kind: 'list' })
  const id = listed.scripts.find((entry) => entry.name === 'Marqueur e2e')!.id
  expect((await callBridge<{ ok: boolean }>(running.page, 'userScripts', { kind: 'set-enabled', id, enabled: true })).ok).toBe(true)
  const on = await openTab(running, url('/a?on'), 'Page A')
  await expect.poll(() => mark(on.page)).toBe('ran')

  await setSettings(running.page, { userScripts: false })
  const off = await openTab(running, url('/a?off'), 'Page A')
  await off.page.waitForLoadState('load')
  await expectStays(() => mark(off.page), null, 'the script of the user does not run while the function is off', 800)
})

test('boosts: the style of a Tweak is applied to the pages of its site while on; off, it is not', async () => {
  const outline = (page: Page) => page.evaluate(() => getComputedStyle(document.body).outlineWidth)
  await setSettings(running.page, { boostsEnabled: true })
  await dispatch(running.page, { type: 'boost/save', boost: { host: '127.0.0.1', name: 'Tweak e2e', enabled: true, css: 'body { outline: 9px solid rgb(1, 2, 3) !important; }' } })
  await waitForState(running.page, (s) => ((s.state as unknown as { boosts: unknown[] }).boosts ?? []).length === 1, 'the Tweak saved')
  const on = await openTab(running, url('/a?on'), 'Page A')
  await expect.poll(() => outline(on.page)).toBe('9px')

  await setSettings(running.page, { boostsEnabled: false })
  await expect.poll(() => outline(on.page)).not.toBe('9px')
})

test('vim-keys: "j" scrolls the page down while on; off, the key does nothing to the page', async () => {
  const scrolled = (page: Page) => page.evaluate(() => scrollY)
  await setSettings(running.page, { vimKeys: true })
  const on = await openTab(running, url('/long?on'), 'Longue')
  await on.page.locator('body').click({ position: { x: 300, y: 200 } })
  await on.page.keyboard.press('j')
  await expect.poll(() => scrolled(on.page)).toBeGreaterThan(0)

  await setSettings(running.page, { vimKeys: false })
  const off = await openTab(running, url('/long?off'), 'Longue')
  await off.page.locator('body').click({ position: { x: 300, y: 200 } })
  await off.page.keyboard.press('j')
  await expectStays(() => scrolled(off.page), 0, 'the key does not scroll the page while the function is off', 600)
})

test('mouse-gestures: a stroke to the left with the right button goes back while on; off, the page stays', async () => {
  /** Opens A then B in the same tab, and draws the stroke on B. Answers how to read the address of the tab. */
  const strokeOn = async (tag: string): Promise<() => Promise<string>> => {
    const first = await openTab(running, url(`/a?${tag}`), 'Page A')
    await running.page.evaluate(([id, address]) => (globalThis as unknown as { lucium: { setTabAddress(tab: string, input: string): void } }).lucium.setTabAddress(id!, address!), [first.id, url(`/b?${tag}`)])
    await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === first.id)?.title === 'Page B', 'page B')
    const page = await waitForWindow(running.app, (address) => address === url(`/b?${tag}`))
    await page.mouse.move(500, 300)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(250, 305, { steps: 12 })
    await page.mouse.up({ button: 'right' })
    return async () => (await snapshotOf(running.page)).state.tabs.find((tab) => tab.id === first.id)!.url
  }
  await setSettings(running.page, { mouseGestures: true })
  await expect.poll(await strokeOn('on'), { message: 'the stroke goes back to page A' }).toBe(url('/a?on'))
  await setSettings(running.page, { mouseGestures: false })
  await expectStays(await strokeOn('off'), url('/b?off'), 'the stroke leaves the page where it is while the function is off', 1200)
})

test('scroll-sync: the panes of a split view scroll together once synced while on; off, they cannot be synced', async () => {
  const left = await openTab(running, url('/long'), 'Longue')
  const right = await openTab(running, url('/long2'), 'Longue 2')
  await dispatch(running.page, { type: 'split/create', tabId: left.id, withTabId: right.id })
  const state = await waitForState(running.page, (s) => s.state.splits.length === 1, 'split view')
  const split = state.state.splits[0]!.id
  const scrolled = (page: Page) => page.evaluate(() => scrollY)

  await setSettings(running.page, { scrollSync: false })
  await callBridge(running.page, 'setScrollSynced', split, true)
  await left.page.evaluate(() => scrollTo(0, 800))
  await expectStays(() => scrolled(right.page), 0, 'the other pane does not follow while the function is off', 800)
  await left.page.evaluate(() => scrollTo(0, 0))

  await setSettings(running.page, { scrollSync: true })
  await callBridge(running.page, 'setScrollSynced', split, true)
  // The panes are tied a moment after the request, and nothing tells when: the left pane is scrolled again until the right one follows.
  await expect(async () => {
    await left.page.evaluate(() => scrollTo(0, scrollY === 900 ? 901 : 900))
    await expect.poll(() => scrolled(right.page), { timeout: 1000 }).toBeGreaterThan(0)
  }, 'the right pane follows the left one').toPass({ timeout: 15_000 })
})

test('applescript: an lucium://open link from another application opens its page while on; off, it is refused', async () => {
  const send = (address: string) => running.app.evaluate(({ app }, link) => void app.emit('open-url', { preventDefault: () => undefined }, link), address)
  await setSettings(running.page, { urlAutomation: false })
  await send(`lucium://open?url=${encodeURIComponent(url('/a?off'))}`)
  await expectStays(async () => tabAt(await snapshotOf(running.page), url('/a?off')) === undefined, true, 'the command opens no tab while the function is off', 1000)

  await setSettings(running.page, { urlAutomation: true })
  await send(`lucium://open?url=${encodeURIComponent(url('/a?on'))}`)
  await waitForState(running.page, (s) => tabAt(s, url('/a?on')) !== undefined, 'the page opened by the command')
})

test('web-panels: a site kept as a web panel is in the Spaces menu and opens beside the page while on; off, no panel can be kept', async () => {
  const space = (await snapshotOf(running.page)).state.activeSpaceId
  await setSettings(running.page, { webPanels: false })
  await dispatch(running.page, { type: 'space/panel-add', id: space, panelId: 'panel-off', url: url('/b?off'), title: 'Volet éteint' })
  await expectStays(() => chooseMenuLabel(running.app, 'Volet éteint'), 'missing', 'no web panel is kept while the function is off', 500)

  await setSettings(running.page, { webPanels: true })
  await openTab(running, url('/a'), 'Page A')
  await dispatch(running.page, { type: 'space/panel-add', id: space, panelId: 'panel-on', url: url('/b?on'), title: 'Volet e2e' })
  await expect.poll(() => chooseMenuLabel(running.app, 'Volet e2e')).toBe('ok')
  await waitForWindow(running.app, (address) => address === url('/b?on'))
})

test('name-windows: a name given to the window becomes its title while on; off, the name is refused', async () => {
  await openTab(running, url('/a'), 'Page A')
  const title = () => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))!.getTitle())
  await setSettings(running.page, { nameWindows: false })
  await callBridge(running.page, 'setWindowName', 'Fenêtre éteinte')
  await expectStays(async () => (await title()).includes('Fenêtre éteinte'), false, 'the window does not take the name while the function is off', 500)

  await setSettings(running.page, { nameWindows: true })
  await callBridge(running.page, 'setWindowName', 'Fenêtre e2e')
  await expect.poll(title).toContain('Fenêtre e2e')
})

test('interface-language: with the translation on, the interface follows the language chosen; off, it stays in French', async () => {
  await openTab(running, url('/a'), 'Page A')
  // The button that goes back, named in the language of the interface.
  const back = (name: string) => running.page.locator(`.page-toolbar .tb-button[aria-label="${name}"]`)
  await setSettings(running.page, { interfaceTranslated: true, language: 'en' })
  await expect(back('Back')).toHaveCount(1)
  await setSettings(running.page, { interfaceTranslated: false })
  await expect(back('Précédent')).toHaveCount(1)
  await expect(back('Back')).toHaveCount(0)
})

/** Puts the pointer on the row of a tab, then away, and answers what its card showed: the picture of the page, the line of its memory. */
async function hoverCardOf(id: string): Promise<{ preview: boolean; memory: boolean }> {
  const card = running.page.locator('.hover-card')
  await running.page.locator(`.sidebar .tab[data-id="${id}"]`).hover()
  await expect(card).toHaveCount(1, { timeout: 8000 })
  const shown = { preview: await card.evaluate((element) => element.classList.contains('preview')), memory: (await card.locator('.hover-card-resources').count()) > 0 }
  await running.page.mouse.move(900, 600)
  await expect(card).toHaveCount(0, { timeout: 8000 })
  return shown
}

// The card itself is always there; the switch of "Cartes de survol" gives it the picture of the page.
test('hover-cards: the card of a tab carries the picture of its page while on; off, the card has none', async () => {
  const a = await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  await setSettings(running.page, { hoverCards: true })
  expect((await hoverCardOf(a.id)).preview).toBe(true)
  await setSettings(running.page, { hoverCards: false })
  expect((await hoverCardOf(a.id)).preview).toBe(false)
})

test('tab-memory: the card of a tab says the memory of its page while on; off, it does not', async () => {
  const a = await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  await setSettings(running.page, { showTabMemory: true })
  expect((await hoverCardOf(a.id)).memory).toBe(true)
  await setSettings(running.page, { showTabMemory: false })
  expect((await hoverCardOf(a.id)).memory).toBe(false)
})

test('lock (what needs no passphrase): the interface cannot switch the lock on, and an unlock with no lock set is refused with its reason', async () => {
  await dispatch(running.page, { type: 'settings/update', patch: { lockEnabled: true } })
  await expectStays(async () => (await snapshotOf(running.page)).state.settings['lockEnabled'], false, 'the interface cannot switch the lock on', 500)
  const reply = await callBridge<{ ok: boolean; message?: string }>(running.page, 'lockUnlock', { target: { scope: 'app' } })
  expect(reply.ok).toBe(false)
  expect(reply.message ?? '').not.toBe('')
})

test('warn-quit: a quit waits for the question while on; off, the application quits at once', async () => {
  const quit = () => running.app.evaluate(({ app }) => app.quit())
  // Taken before the quit: Playwright no longer hands the process out once a quit has begun.
  const child = running.app.process()
  const alive = () => child.exitCode === null && child.signalCode === null
  await setSettings(running.page, { warnBeforeQuitting: true })
  await quit()
  await expectStays(alive, true, 'the application does not quit while its question waits', 1500)
  expect(await running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)

  // The question is still up; with the function off, the next quit goes through it.
  await setSettings(running.page, { warnBeforeQuitting: false })
  // The call may not get its answer: the process it runs in ends. What counts is checked just after, that the process is gone.
  await quit().catch((error: unknown) => console.log('[e2e] the quit ended the process before it answered:', (error as Error).message.split('\n')[0]))
  await expect.poll(alive, { timeout: 10_000 }).toBe(false)
})

test('find-regex: a search marked as a regular expression finds by its pattern while on; off, the same text is searched as it is', async () => {
  await openTab(running, url('/a'), 'Page A')
  const matches = async () => ((await snapshotOf(running.page)) as unknown as { find?: { matches: number } | null }).find?.matches ?? 0
  // The search ends the way the find bar ends it when its field is emptied: an empty text (the bridge has no call of its own for that).
  const endSearch = async () => {
    await callBridge(running.page, 'find', '', {})
    await waitForState(running.page, (s) => (s as unknown as { find?: unknown }).find == null, 'the search ended')
  }
  await setSettings(running.page, { findRegex: false })
  await callBridge(running.page, 'find', 'P.ge', { regex: true })
  await expectStays(matches, 0, 'the pattern is searched as plain text while the function is off', 800)
  await endSearch()

  await setSettings(running.page, { findRegex: true })
  await callBridge(running.page, 'find', 'P.ge', { regex: true })
  await expect.poll(matches).toBeGreaterThan(0)
  await endSearch()
})

test('tab-cycle-recent: ⌃Tab goes to the tab used before while on; off, the key does not change the tab', async () => {
  const a = await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  const c = await openTab(running, url('/long'), 'Longue')
  // Used last: C, and before it A (B was left before A was looked at again).
  await dispatch(running.page, { type: 'tab/select', id: a.id })
  await dispatch(running.page, { type: 'tab/select', id: c.id })
  const active = async () => {
    const snapshot = (await snapshotOf(running.page)) as unknown as { state: { activeSpaceId: string; activeTabBySpace: Record<string, string> } }
    return snapshot.state.activeTabBySpace[snapshot.state.activeSpaceId]
  }
  await expect.poll(active).toBe(c.id)
  // ⌃Tab is read before the page gets it (before-input-event), which the keys Playwright sends do not reach: they are sent the way the
  // system sends them (webContents.sendInputEvent), to the page on screen, then ⌃ goes up where the panel of the recent tabs has the keyboard.
  const send = (target: 'page' | 'overlay', event: { type: 'keyDown' | 'keyUp'; keyCode: string; modifiers?: Array<'control'> }) =>
    running.app.evaluate(({ webContents }, [where, input, page]) => {
      const contents = webContents.getAllWebContents().find((item) => (where === 'overlay' ? item.getURL().endsWith('/overlay.html') : item.getURL() === page))
      contents?.sendInputEvent(input as Electron.KeyboardInputEvent)
    }, [target, event, url('/long')] as const)
  const controlTab = async () => {
    await send('page', { type: 'keyDown', keyCode: 'Control', modifiers: ['control'] })
    await send('page', { type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
    await send('page', { type: 'keyUp', keyCode: 'Tab', modifiers: ['control'] })
  }

  await setSettings(running.page, { tabCycleRecent: false })
  await controlTab()
  await send('page', { type: 'keyUp', keyCode: 'Control' })
  await expectStays(async () => ({ panel: await overlayShown(running.app), tab: await active() }), { panel: false, tab: c.id }, 'the key does not change the tab while the function is off', 800)

  await setSettings(running.page, { tabCycleRecent: true })
  await controlTab()
  await waitForPanel(running.app, '[role="dialog"], [role="listbox"], [role="menu"]')
  await send('overlay', { type: 'keyUp', keyCode: 'Control' })
  await expect.poll(active, { timeout: 8000 }).toBe(a.id)
})

test('auto-scroll: a middle click on the page and the pointer below it scroll the page while on; off, nothing scrolls', async () => {
  for (const on of [false, true]) {
    await setSettings(running.page, { autoScroll: on })
    const tab = await openTab(running, url(`/long?${on}`), 'Longue')
    await tab.page.mouse.move(400, 300)
    await tab.page.mouse.down({ button: 'middle' })
    await tab.page.mouse.up({ button: 'middle' })
    await tab.page.mouse.move(400, 480, { steps: 8 })
    const scrolled = () => tab.page.evaluate(() => scrollY)
    if (on) await expect.poll(scrolled, { message: 'the page scrolls under the pointer' }).toBeGreaterThan(0)
    // Windows: Chromium has its own middle-click autoscroll there (macOS has none), so the page scrolls with the function off as well; only the "on" half holds.
    else if (process.platform !== 'win32') await expectStays(scrolled, 0, 'nothing scrolls while the function is off', 1200)
    // Leaves the mode (a click ends it).
    await tab.page.mouse.click(400, 480)
  }
})

test('warn-close-window: closing a window of several tabs waits for the question while on; off, the window closes', async () => {
  await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  // A window that is being closed is still in the list for a moment and its web contents is already destroyed (the call then throws): it is not counted.
  const windows = () => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL().endsWith('/index.html')).length)
  /** Opens a second window (⌘N: it lists the same tabs) and closes it as its red button does. */
  const closeSecond = async (): Promise<void> => {
    const before = await windows()
    await chooseMenuEntry(running.app, 'CmdOrCtrl+N')
    await expect.poll(windows).toBe(before + 1)
    await running.app.evaluate(({ BrowserWindow }) => {
      const mains = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL().endsWith('/index.html')).sort((x, y) => x.id - y.id)
      mains.at(-1)?.close()
    })
  }
  await setSettings(running.page, { warnBeforeClosingWindow: false })
  await closeSecond()
  await expect.poll(windows, { message: 'the second window closes at once' }).toBe(1)
  await setSettings(running.page, { warnBeforeClosingWindow: true })
  // The question is up on the second window: it is still there (the end of the test quits without a question, see launch.ts).
  await closeSecond()
  await expectStays(windows, 2, 'the second window waits for the answer to its question', 1500)
})

test('annotate-timer: the timer of the annotation bar cycles the automatic clearing through its delays, says each one, and writes the setting', async () => {
  await openTab(running, url('/a'), 'Page A')
  // The bar on the top edge: the row, where the room is the tightest (the column keeps its height).
  await setSettings(running.page, { annotateBar: { kind: 'edge', edge: 'top' } })
  await chooseMenuEntry(running.app, 'Alt+CmdOrCtrl+M')
  const bar = await waitForWindow(running.app, (address) => address.includes('page-annotate-command'))
  const timer = bar.locator('#page-annotate-timer')
  await expect(timer).toBeEnabled()
  // The hint of the first use is closed: the pictures below show the bar as it is used.
  await bar.locator('#page-annotate-hint-ok').click()
  await expect(bar.locator('#page-annotate-hint')).toBeHidden()
  // Off by default: the icon alone, not in the accent, and a name that says it is off.
  await expect(timer).toHaveAttribute('data-on', 'false')
  await expect(timer).toHaveAccessibleName(/^(Effacement automatique\s*:\s*désactivé|Automatic clearing: off)$/)
  await expect(timer).toHaveText('')
  const settings = async () => (await snapshotOf(running.page)).state.settings
  for (const seconds of [3, 5, 10, 20, 30]) {
    await timer.click()
    await expect(timer).toHaveAttribute('data-on', 'true')
    await expect(timer).toHaveText(new RegExp(`^${seconds}\\s*s$`))
    await expect(timer).toHaveAccessibleName(new RegExp(`(après ${seconds} secondes sans activité|after ${seconds} seconds without activity)$`))
    await expect.poll(async () => { const now = await settings(); return [now['annotateAutoClear'], now['annotateAutoClearSeconds']] }, { message: `the setting after the click to ${seconds} s` }).toEqual([true, seconds])
  }
  await timer.click()
  await expect(timer).toHaveAttribute('data-on', 'false')
  // Off keeps the delay: switched on again in the Settings, the clearing has the one it had.
  await expect.poll(async () => { const now = await settings(); return [now['annotateAutoClear'], now['annotateAutoClearSeconds']] }).toEqual([false, 30])
  // A change made in the Settings reaches the bar.
  await setSettings(running.page, { annotateAutoClear: true, annotateAutoClearSeconds: 5 })
  await expect(timer).toHaveText(/^5\s*s$/)

  // The row keeps every label whole (the text buttons gave the timer their spare room), and the pictures of the bar, light and dark, with the timer on.
  const cut = await bar.evaluate(() => [...document.querySelectorAll<HTMLElement>('#page-annotate-bar button')].filter((button) => button.offsetParent !== null && button.scrollWidth > button.clientWidth).map((button) => button.id || button.className))
  expect(cut, 'no button of the row cuts its label').toEqual([])
  const nav = bar.locator('#page-annotate-bar')
  for (const scheme of ['light', 'dark'] as const) {
    await bar.emulateMedia({ colorScheme: scheme })
    await nav.screenshot({ path: test.info().outputPath(`annotate-bar-row-${scheme}.png`), animations: 'disabled' })
  }
  // The column, on the left edge, scrolled to its foot (a window lower than the column scrolls it): the timer above Annuler.
  await setSettings(running.page, { annotateBar: { kind: 'edge', edge: 'left' } })
  await expect(nav).toHaveAttribute('data-layout', 'column')
  await nav.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  for (const scheme of ['light', 'dark'] as const) {
    await bar.emulateMedia({ colorScheme: scheme })
    await nav.screenshot({ path: test.info().outputPath(`annotate-bar-column-${scheme}.png`), animations: 'disabled' })
  }
})
