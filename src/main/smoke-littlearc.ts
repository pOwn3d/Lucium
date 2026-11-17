// Engine checks for the leftovers of the mini window and the profiles, run inside a real Electron (docs/fonctions.md: little-modifier,
// little-download-bubble, guest-profile; and the delay of `little-archive`). A local server serves the pages; real clicks (sendInputEvent with the
// keys held) open the links; real downloads fill the tray; the guest window is opened through the window manager and its cookies are read back
// by the server. Called from the engine smoke test: `await runLittleArcSmoke(ctx)` (also LUCIUM_SMOKE_ONLY=littlearc).

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, Menu, screen, shell, webContents as allWebContents, type MenuItem, type WebContents } from 'electron'
import type { Settings } from '@shared/model'
import { t } from '@shared/i18n'
import { activeProfileId } from '@shared/profiles'
import { windowEntryLabel } from '@shared/window-names'
import { bubbleExtra } from '@shared/little-bubble'
import { LITTLE_TRAY } from '@shared/little-tray'
import { runningGates } from './shell/feature-gate'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

const evaluate = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>

type Held = Array<'shift' | 'alt' | 'meta'>

/** A real click at a point of a page, with these keys held, as the event of a mouse: the engine reads them back from the input event. */
async function clickAt(wc: WebContents, x: number, y: number, modifiers: Held = []): Promise<void> {
  wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), modifiers })
  wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers })
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers })
  await sleep(120)
}

async function centerOf(wc: WebContents, selector: string): Promise<{ x: number; y: number }> {
  return evaluate<{ x: number; y: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
}

/** The menu item with this label, anywhere in the application menu. */
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

const near = (a: number | undefined, b: number, tolerance = 1) => a !== undefined && Math.abs(a - b) <= tolerance

export async function smokeLittleArc(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, history, little, win } = ctx
  const manager = getWindowManager()
  const originalSettings = store.get().settings
  const originalTabs = new Set(store.get().tabs.map((t) => t.id))
  const archiveBefore = store.get().archive.length
  const patch = (p: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch: p })
  const state = () => store.get()

  const cookies: Array<{ who: string; cookie: string }> = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html')
    if (url.pathname === '/links') {
      return res.end(
        `<title>links</title><body style="margin:0"><a id="plain" href="/t?id=plain" style="display:block;width:300px;height:60px">plain</a>` +
          `<a id="blank" href="/t?id=blank" target="_blank" style="display:block;width:300px;height:60px">blank</a></body>`
      )
    }
    if (url.pathname === '/dlpage') {
      return res.end(
        `<title>dl</title><body style="margin:0"><a id="dl1" href="/dl?n=1" download style="display:block;width:300px;height:60px">1</a>` +
          `<a id="dl2" href="/dl?n=2" download style="display:block;width:300px;height:60px">2</a><a id="dl3" href="/dl?n=3" download style="display:block;width:300px;height:60px">3</a></body>`
      )
    }
    if (url.pathname === '/dl') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', `attachment; filename="bubble-${url.searchParams.get('n') ?? '0'}.bin"`)
      return res.end(Buffer.alloc(4096, 7))
    }
    if (url.pathname === '/set') {
      res.setHeader('set-cookie', 'littlearcguest=1; Path=/')
      return res.end('<title>set</title><body>set</body>')
    }
    if (url.pathname === '/read') {
      cookies.push({ who: url.searchParams.get('who') ?? '', cookie: req.headers.cookie ?? '' })
      return res.end(`<title>read ${url.searchParams.get('who') ?? ''}</title><body>read</body>`)
    }
    res.end(`<title>t ${url.searchParams.get('id') ?? url.pathname}</title><body>t</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const pageWc = (url: string) => allWebContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === url)
  const stateOf = (id: string) => little.states().find((st) => st.id === id)
  const downloadsFolder = mkdtempSync(join(tmpdir(), 'littlearc-downloads-'))
  const profileId = activeProfileId(state())
  const profilesBefore = state().settings.profiles
  const openedPaths: string[] = []
  const revealed: string[] = []
  const realReveal = shell.showItemInFolder
  const realOpenPath = shell.openPath
  const closeLittleWindows = async () => {
    for (const st of little.states()) little.close(st.id)
    await waitFor(() => little.count() === 0, 4000)
  }

  try {
    // Nothing of the files of the user is written or opened: the downloads of this test go to a folder of its own and the shell is stubbed.
    patch({ profiles: { ...profilesBefore, [profileId]: { ...profilesBefore[profileId], downloadDir: downloadsFolder } } })
    ;(shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (p: string) => void revealed.push(p)
    ;(shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p: string) => {
      openedPaths.push(p)
      return ''
    }

    // ============================== ⌥⌘ + clic opens a link in a mini window (little-modifier) ==============================
    // Electron gives the shell no keys for a mouse event: ⌥⌘ is recognised by the disposition Chromium gives the window ("other", measured).
    patch({ littleArcModifier: false, peekWithShift: true, littleArcArchiveHours: 0 })
    browser.dispatch({ type: 'tab/open', url: `${base}/links` })
    const linksTab = state().tabs.at(-1)!.id
    const linksWc = () => (browser.pageFor(linksTab) as unknown as { webContents: WebContents } | undefined)?.webContents
    check('modifier: the page of links loads', await waitFor(() => linksWc()?.getURL() === `${base}/links` && state().tabs.find((t) => t.id === linksTab)?.title === 'links'))
    await sleep(300)
    const wc = linksWc()!
    const link = async (selector: string, held: Held) => {
      const at = await centerOf(wc, selector)
      await clickAt(wc, at.x, at.y, held)
    }
    const tabCount = () => state().tabs.length
    const closeNewTabs = () => {
      for (const tab of state().tabs) if (!originalTabs.has(tab.id) && tab.id !== linksTab) browser.dispatch({ type: 'tab/close', id: tab.id })
    }

    // off: ⌥⌘-click opens a tab, as it always did
    const before0 = { tabs: tabCount(), little: little.count() }
    await link('#plain', ['alt', 'meta'])
    check('modifier: off, ⌥⌘ + clic opens a tab, as always, and no Little Arc', (await waitFor(() => tabCount() === before0.tabs + 1)) && little.count() === before0.little, JSON.stringify({ tabs: tabCount(), little: little.count() }))
    closeNewTabs()

    // on
    patch({ littleArcModifier: true })
    const before1 = { tabs: tabCount(), little: little.count() }
    await link('#plain', ['alt', 'meta'])
    check('modifier: on, ⌥⌘ + clic opens the link in a Little Arc window', await waitFor(() => little.count() === before1.little + 1 && little.states().some((st) => st.url === `${base}/t?id=plain`)), JSON.stringify(little.states().map((st) => st.url)))
    check('modifier: ...and in no tab', tabCount() === before1.tabs, String(tabCount()))
    await closeLittleWindows()

    // the same keys but ⌘ alone, a plain click on a link that opens a tab: not a mini window
    await link('#plain', ['meta'])
    check('modifier: ⌘ + clic alone still opens a tab behind', (await waitFor(() => tabCount() === before1.tabs + 1)) && little.count() === 0)
    closeNewTabs()
    await link('#blank', [])
    check('modifier: a plain click on a target="_blank" link still opens a tab in front', (await waitFor(() => tabCount() === before1.tabs + 1)) && little.count() === 0)
    closeNewTabs()
    await link('#plain', ['alt'])
    // The witness: a ⌘-click on the other link after it, which opens a tab behind. The page hands its clicks to the browser in order: a window or a
    // tab the ⌥-click opened would be there before the witness's tab.
    await link('#blank', ['meta'])
    const witnessed = await waitFor(() => state().tabs.some((t) => t.url === `${base}/t?id=blank`))
    check('modifier: ⌥ alone is not a Little Arc (Chromium downloads the link)', witnessed && little.count() === 0 && tabCount() === before1.tabs + 1 && !state().tabs.some((t) => t.url === `${base}/t?id=plain`), JSON.stringify({ witnessed, little: little.count(), tabs: state().tabs.filter((t) => !originalTabs.has(t.id) && t.id !== linksTab).map((t) => t.url) }))
    closeNewTabs()

    // The menu of the Dock (macOS): New Window and New Private Window, and the two entries for the mini window, which are on only while one is open.
    if (process.platform === 'darwin') {
      const dockItems = (): Array<{ label: string; enabled: boolean; click: () => void }> =>
        (app.dock?.getMenu()?.items ?? []).filter((item) => item.type !== 'separator').map((item) => ({ label: item.label, enabled: item.enabled, click: () => item.click() }))
      const shown = (): string => dockItems().map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`).join(' | ')
      const labels = [t('menu.nouvelle-fenetre'), t('menu.nouvelle-fenetre-privee'), t('dock.afficher-les-mini-fenetres'), t('dock.fermer-les-mini-fenetres')]
      check('dock: the menu has New Window, New Private Window and the two Little Arc entries, the last two off while no Little Arc window is open', dockItems().map((i) => i.label).join('|') === labels.join('|') && dockItems().every((i, n) => i.enabled === (n < 2)), shown())
      little.openBar()
      check('dock: the two Little Arc entries come on when a Little Arc window opens', await waitFor(() => dockItems().every((i) => i.enabled)), shown())
      dockItems()[3]?.click()
      check('dock: "Fermer les fenêtres Little Arc" closes them, and the entries go off again', (await waitFor(() => little.count() === 0)) && (await waitFor(() => dockItems().every((i, n) => i.enabled === (n < 2)))), shown())
      const windowsBefore = getWindowManager().extraWindows().length
      dockItems()[0]?.click()
      check('dock: "Nouvelle fenêtre" opens a window of the browser', await waitFor(() => getWindowManager().extraWindows().length === windowsBefore + 1), String(getWindowManager().extraWindows().length))
      for (const extra of getWindowManager().extraWindows()) if (!extra.win.isDestroyed()) extra.win.close()
    }

    // the other keys keep their usual use: Maj alone is still the Glance, ⇧⌘ a tab in front
    await link('#plain', ['shift'])
    check('modifier: on, ⇧-clic alone still opens the Glance', (await waitFor(() => browser.snapshot().peek !== null)) && little.count() === 0)
    browser.peekAction('close')
    await sleep(300)
    await link('#plain', ['shift', 'meta'])
    check('modifier: on, ⇧⌘ + clic still opens a tab in front, not a Little Arc', (await waitFor(() => tabCount() === before1.tabs + 1)) && little.count() === 0 && browser.snapshot().peek === null)
    closeNewTabs()

    // a private window has no mini window to open: the link opens where it always did
    const priv = manager.openPrivate()
    priv.browser.dispatch({ type: 'tab/open', url: `${base}/links` })
    const privTab = priv.store.get().tabs.at(-1)!.id
    const privWc = () => (priv.browser.pageFor(privTab) as unknown as { webContents: WebContents } | undefined)?.webContents
    await waitFor(() => priv.store.get().tabs.find((t) => t.id === privTab)?.title === 'links')
    await sleep(300)
    const privAt = await centerOf(privWc()!, '#plain')
    const privBefore = priv.store.get().tabs.length
    await clickAt(privWc()!, privAt.x, privAt.y, ['alt', 'meta'])
    check('modifier: in a private window ⌥⌘ + clic opens a tab of that window, never a Little Arc', (await waitFor(() => priv.store.get().tabs.length === privBefore + 1)) && little.count() === 0, JSON.stringify({ tabs: priv.store.get().tabs.length, little: little.count() }))
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()

    // off again: the keys go back to their usual use (a tab)
    patch({ littleArcModifier: false })
    await link('#plain', ['alt', 'meta'])
    check('modifier: switched off again, ⌥⌘ + clic opens a tab', (await waitFor(() => tabCount() === before1.tabs + 1)) && little.count() === 0)
    closeNewTabs()
    browser.dispatch({ type: 'tab/close', id: linksTab })

    // ============================== the delay before a forgotten window is archived (little-archive) ==============================
    patch({ littleArcArchiveHours: 1 })
    check('delay: the archiving gate runs while there is a delay', runningGates().includes('little-archive'))
    const forgotten = little.open(`${base}/t?id=forgotten`)
    check('delay: a window of a web page opens', await waitFor(() => stateOf(forgotten)?.url === `${base}/t?id=forgotten`))
    // Where it opened: the middle of the work area of its screen, and above the other windows (the level of a palette). Written, not run by the person who wrote it
    // (opening a window needs the owner of the machine, AGENTS.md §1): the cut of the layout is shared/little-window.test.ts.
    const forgottenWindow = ElectronWindow.getAllWindows().find((w) => new RegExp(`[?&]id=${forgotten}(&|$)`).test(w.webContents.getURL()))
    if (forgottenWindow) {
      const at = forgottenWindow.getBounds()
      const area = screen.getDisplayMatching(at).workArea
      const off = { x: Math.abs(at.x + at.width / 2 - (area.x + area.width / 2)), y: Math.abs(at.y + at.height / 2 - (area.y + area.height / 2)) }
      check('position: a window of a page opens in the middle of the work area of its screen', off.x <= 2 && off.y <= 2, JSON.stringify({ at, area }))
      check('position: ...and stays above the other windows', forgottenWindow.isAlwaysOnTop())
    } else {
      check('position: the window of the page is found', false)
    }
    check('delay: it is not closed before the delay (30 minutes of 1 hour)', little.sweep(Date.now() + 30 * 60_000) === 0 && little.count() === 1)
    const archived = state().archive.length
    check('delay: it is closed once the delay is over (2 hours of 1 hour)', little.sweep(Date.now() + 2 * 3_600_000) === 1 && (await waitFor(() => little.count() === 0)))
    check('delay: ...and its page is archived as a Little Arc', await waitFor(() => state().archive.length === archived + 1 && state().archive.some((a) => a.url === `${base}/t?id=forgotten` && a.source === 'little')), JSON.stringify(state().archive.slice(-2)))
    patch({ littleArcArchiveHours: 0 })
    check('delay: "Jamais": the gate stops, and nothing is closed however old the window', !runningGates().includes('little-archive'))
    const kept = little.open(`${base}/t?id=kept`)
    await waitFor(() => stateOf(kept)?.url === `${base}/t?id=kept`)
    check('delay: ...a window kept for a year is still there', little.sweep(Date.now() + 8760 * 3_600_000) === 0 && little.count() === 1)
    await closeLittleWindows()

    // ============================== the action bubble of the tray (little-download-bubble) ==============================
    patch({ littleDownloadBubble: false })
    check('bubble: the feature is not running while the setting is off', !runningGates().includes('little-download-bubble') && !little.bubbleRunning() && little.bubbleTimerCount() === 0)
    const dlUrl = `${base}/dlpage?id=bubble`
    const bubbleId = little.open(dlUrl)
    await waitFor(() => pageWc(dlUrl) !== undefined)
    await sleep(500)
    const dlWc = pageWc(dlUrl)!
    const header = () => allWebContents.getAllWebContents().find((w) => w.getURL().includes('littlearc') && w.getURL().includes(`id=${bubbleId}`) && !w.getURL().includes('picker') && !w.getURL().includes('tray=1'))
    const littleWin = () => {
      const h = header()
      return h ? ElectronWindow.fromWebContents(h) : null
    }
    const trayView = () => littleWin()?.contentView.children.find((v) => (v as unknown as { webContents?: WebContents }).webContents?.getURL().includes('tray=1')) as unknown as { webContents: WebContents; getBounds(): { x: number; y: number; width: number; height: number } } | undefined
    const clickDownload = async (selector: string) => {
      const at = await centerOf(dlWc, selector)
      await clickAt(dlWc, at.x, at.y)
    }
    const finishedCount = () => stateOf(bubbleId)?.downloads.filter((d) => d.state === 'completed').length ?? 0

    await clickDownload('#dl1')
    check('bubble: off, a download of the window fills the tray as it always did', await waitFor(() => finishedCount() === 1 && trayView() !== undefined, 10_000), JSON.stringify(stateOf(bubbleId)?.downloads.map((d) => d.state)))
    // No wait: the shell lays out the tray and decides on the bubble in the step that records the download as finished (little.ts, `onDownload`).
    check('bubble: ...with no bubble, a tray of one row (66 px) and no timer', stateOf(bubbleId)?.bubble === undefined && near(trayView()?.getBounds().height, 66) && little.bubbleTimerCount() === 0)
    check('bubble: ...and no bubble in the page of the tray', (await evaluate<number>(trayView()!.webContents, `document.querySelectorAll('.lt-bubble').length`)) === 0)

    patch({ littleDownloadBubble: true })
    check('bubble: on, the feature runs', runningGates().includes('little-download-bubble') && little.bubbleRunning())
    const tallest = 66 + 54 + bubbleExtra(true)
    // The pointer of the Mac, where the person left it, holds a bubble that rises under it (its timer stops, as it should: little.ts, 'bubble-hold'), and
    // the timer read below would say where the pointer is. Before the bubble, the window is moved so that the pointer is off the tray at its tallest.
    const pointer = (() => {
      const win = littleWin()
      if (!win) return 'no window'
      const cursor = screen.getCursorScreenPoint()
      const content = win.getContentBounds()
      const zone = { x: content.x, y: content.y + content.height - tallest - 40, width: LITTLE_TRAY.width + 40, height: tallest + 40 }
      if (cursor.x < zone.x || cursor.x >= zone.x + zone.width || cursor.y < zone.y || cursor.y >= zone.y + zone.height) return 'off the tray'
      const area = screen.getDisplayNearestPoint(cursor).workArea
      const { x, y, width } = win.getBounds()
      // The tray to the right of the pointer when the window still fits there, else to its left.
      const right = cursor.x + 20 - zone.x
      const dx = x + right + width <= area.x + area.width ? right : cursor.x - 20 - (zone.x + zone.width)
      win.setPosition(x + dx, y)
      return `moved by ${dx} px off the pointer`
    })()
    await clickDownload('#dl2')
    check('bubble: on, a download that finishes raises the bubble', await waitFor(() => finishedCount() === 2 && stateOf(bubbleId)?.bubble !== undefined, 10_000), JSON.stringify(stateOf(bubbleId)))
    // The page of the tray draws the bubble once it has the state: the checks below read it there.
    await waitFor(() => evaluate<boolean>(trayView()!.webContents, `!!document.querySelector('.lt-bubble')`), 3000)
    check('bubble: the tray grows by the bubble (two rows + 50 px), upwards from its place', near(trayView()?.getBounds().height, tallest) && little.bubbleTimerCount() === 1, JSON.stringify({ tray: trayView()?.getBounds(), timers: little.bubbleTimerCount(), pointer }))
    const bubbleDom = await evaluate<{ text: string; buttons: string[] } | null>(trayView()!.webContents, `(() => { const b = document.querySelector('.lt-bubble'); return b ? { text: b.querySelector('.lt-bubble-text').textContent, buttons: [...b.querySelectorAll('button')].map((x) => x.textContent || x.getAttribute('aria-label')) } : null })()`)
    check('bubble: it says "Téléchargé" with "Ouvrir", "Afficher dans le Finder" and a close button', bubbleDom?.text === 'Téléchargé' && bubbleDom.buttons[0] === 'Ouvrir' && bubbleDom.buttons[1] === 'Afficher dans le Finder' && bubbleDom.buttons.length === 3, JSON.stringify(bubbleDom))

    // the pointer on the bubble keeps it up
    const bubbleBox = await evaluate<{ x: number; y: number; width: number; height: number }>(trayView()!.webContents, `(() => { const r = document.querySelector('.lt-bubble').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    trayView()!.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bubbleBox.x + 10), y: Math.round(bubbleBox.y + bubbleBox.height / 2) })
    check('bubble: the pointer on it stops its timer', await waitFor(() => little.bubbleTimerCount() === 0, 3000))
    trayView()!.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bubbleBox.x + 10), y: Math.round(bubbleBox.y + bubbleBox.height + 30) })
    check('bubble: ...and it starts again when the pointer leaves', await waitFor(() => little.bubbleTimerCount() === 1, 3000))

    const buttonAt = async (index: number) => {
      const box = await evaluate<{ x: number; y: number; width: number; height: number }>(trayView()!.webContents, `(() => { const r = document.querySelectorAll('.lt-bubble button')[${index}].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const open = await buttonAt(0)
    await clickAt(trayView()!.webContents, open.x, open.y)
    check('bubble: "Ouvrir" opens the file that just came, and the bubble goes', (await waitFor(() => openedPaths.length === 1 && openedPaths[0]!.endsWith('bubble-2.bin'), 4000)) && (await waitFor(() => stateOf(bubbleId)?.bubble === undefined, 3000)), JSON.stringify({ openedPaths, bubble: stateOf(bubbleId)?.bubble }))
    check('bubble: ...and the tray gets its height back', await waitFor(() => near(trayView()?.getBounds().height, 66 + 54), 3000), JSON.stringify(trayView()?.getBounds()))

    await clickDownload('#dl3')
    check('bubble: a third download raises it again', await waitFor(() => finishedCount() === 3 && stateOf(bubbleId)?.bubble !== undefined, 10_000))
    await sleep(500)
    const reveal = await buttonAt(1)
    await clickAt(trayView()!.webContents, reveal.x, reveal.y)
    check('bubble: "Afficher dans le Finder" shows the file, and the bubble goes', (await waitFor(() => revealed.length === 1 && revealed[0]!.endsWith('bubble-3.bin') && revealed[0]!.startsWith(downloadsFolder), 4000)) && (await waitFor(() => stateOf(bubbleId)?.bubble === undefined, 3000)), JSON.stringify({ revealed }))
    check('bubble: the main window’s list of downloads has the files too', browser.snapshot().downloads.filter((d) => d.filename.startsWith('bubble-')).length >= 3)

    // switching the setting off takes the bubble down at once
    await clickDownload('#dl1')
    await waitFor(() => stateOf(bubbleId)?.bubble !== undefined, 10_000)
    patch({ littleDownloadBubble: false })
    check('bubble: switched off, a bubble that was up goes with its timer, and the feature stops', (await waitFor(() => stateOf(bubbleId)?.bubble === undefined && little.bubbleTimerCount() === 0, 3000)) && !runningGates().includes('little-download-bubble'))
    await closeLittleWindows()
    check('bubble: closing the window leaves no timer', little.bubbleTimerCount() === 0)
    ;(shell as unknown as { showItemInFolder: typeof realReveal }).showItemInFolder = realReveal
    ;(shell as unknown as { openPath: typeof realOpenPath }).openPath = realOpenPath

    // ============================== the guest window (guest-profile) ==============================
    const countBefore = manager.list().length
    patch({ guestProfile: false })
    check('guest: refused while the setting is off', manager.openGuest() === null && manager.list().length === countBefore)
    const hiddenEntry = findMenuItem('Nouvelle fenêtre invité')
    check('guest: File › Nouvelle fenêtre invité exists in the menu bar, hidden while the setting is off', hiddenEntry !== undefined && hiddenEntry.visible === false, String(hiddenEntry?.visible))
    patch({ guestProfile: true })
    check('guest: ...and shown once it is on', await waitFor(() => findMenuItem('Nouvelle fenêtre invité')?.visible === true))

    // something of the owner's in the main window, to look for in the guest's
    patch({ blockExceptions: ['owner-secret.example'], siteDataRecents: ['owner-secret.example'] })
    const guest = manager.openGuest()
    check('guest: the window manager opens a guest window, a private one underneath', guest !== null && guest.guest === true && guest.kind === 'private' && guest.browser.isPrivate() && manager.guestWindows().length === 1)
    if (!guest) throw new Error('no guest window: the checks that follow cannot run')
    const guestUi = guest.win.webContents
    check('guest: its interface loads', await waitFor(() => evaluate<boolean>(guestUi, '!!window.lucium').catch(() => false)))
    check('guest: the window is called "Invité" and the Window menu says "Fenêtre invité"', guest.win.getTitle() === 'Invité' && manager.entries().some((entry) => entry.id === guest.id && entry.guest === true && windowEntryLabel(entry) === 'Fenêtre invité'), guest.win.getTitle())
    // The interface has an API before it has drawn the snapshot: the name of the space is read once it is there.
    await waitFor(() => evaluate<boolean>(guestUi, `!!document.querySelector('.space-header-name')?.textContent`).catch(() => false), 10_000)
    const look = await evaluate<{ guest: boolean; private: boolean; space: string }>(guestUi, `({ guest: document.documentElement.classList.contains('guest'), private: document.documentElement.classList.contains('private'), space: document.querySelector('.space-header-name')?.textContent ?? '' })`)
    check('guest: the interface wears the guest’s class and none of the private window’s, and names its space "Invité"', look.guest && !look.private && look.space === 'Invité', JSON.stringify(look))
    const toolbarBg = await evaluate<string>(guestUi, `getComputedStyle(document.querySelector('.shell') || document.body).getPropertyValue('--toolbar-bg').trim()`)
    check('guest: the toolbar is not the private window’s blue-striped one', toolbarBg !== '#4147d3', toolbarBg)
    const snapshot = await evaluate<{ private?: boolean; guest?: boolean; state: { spaces: Array<{ name: string }>; tabs: unknown[]; favorites: unknown[]; archive: unknown[]; settings: Settings } }>(guestUi, 'window.lucium.getSnapshot()')
    check('guest: its snapshot is private and guest’s, with one space, nothing of the owner’s tabs, favourites or archive', snapshot.private === true && snapshot.guest === true && snapshot.state.spaces.length === 1 && snapshot.state.spaces[0]!.name === 'Invité' && snapshot.state.favorites.length === 0 && snapshot.state.archive.length === 0 && snapshot.state.tabs.length === 0, JSON.stringify({ spaces: snapshot.state.spaces.length, tabs: snapshot.state.tabs.length }))
    check('guest: ...nor of the owner’s lists (sites erased, blocking exceptions)', snapshot.state.settings.blockExceptions.length === 0 && snapshot.state.settings.siteDataRecents.length === 0 && !JSON.stringify(snapshot).includes('owner-secret'))
    const mainSnapshot = browser.snapshot()
    check('guest: ...and the main window is untouched', mainSnapshot.guest !== true && mainSnapshot.private !== true && mainSnapshot.state.settings.siteDataRecents.length === 1)

    guest.browser.showToast('Les extensions ne fonctionnent pas dans une fenêtre privée.')
    check('guest: the notices of the private rules call it a guest window, not a private one', guest.browser.snapshot().toast?.message === 'Les extensions ne fonctionnent pas dans une fenêtre invité.', guest.browser.snapshot().toast?.message)

    // a session of its own
    guest.browser.dispatch({ type: 'tab/open', url: `${base}/set` })
    await waitFor(() => guest.store.get().tabs.some((t) => t.title === 'set'))
    guest.browser.dispatch({ type: 'tab/open', url: `${base}/read?who=guest1` })
    check('guest: a cookie set in the guest window is sent back to the site from there', await waitFor(() => cookies.some((c) => c.who === 'guest1' && c.cookie.includes('littlearcguest=1')), 8000), JSON.stringify(cookies))
    browser.dispatch({ type: 'tab/open', url: `${base}/read?who=owner` })
    await waitFor(() => cookies.some((c) => c.who === 'owner'))
    check('guest: ...and the owner’s window never sees it', cookies.some((c) => c.who === 'owner' && !c.cookie.includes('littlearcguest')), JSON.stringify(cookies))
    const secret = `guest-${Date.now()}`
    guest.browser.dispatch({ type: 'tab/open', url: `${base}/t?id=${secret}` })
    await waitFor(() => guest.store.get().tabs.some((t) => t.url.includes(secret) && t.title.includes(secret)))
    await sleep(300)
    history.flush()
    check('guest: what it visits is in the history of no profile', !history.profiles().some((profile) => history.of(profile).search(secret).length > 0))
    check('guest: its own interface gets no history to suggest', (await evaluate<unknown[]>(guestUi, `window.lucium.searchHistory('')`)).length === 0)

    // the Settings window shows the owner's data: a guest does not open it
    guest.browser.openOverlay({ panel: 'settings' })
    check('guest: the Settings do not open there, and it says so', await waitFor(() => /Réglages ne sont pas disponibles/.test(guest.browser.snapshot().toast?.message ?? ''), 3000), guest.browser.snapshot().toast?.message)

    // the menu follows the window that has the focus; the task manager lists the tabs of every window, so a guest window does not open it
    guest.win.emit('focus')
    check('guest: the menu is built for the guest window (its entry to open another guest window is gone)', (await waitFor(() => manager.focused().id === guest.id && findMenuItem('Nouvelle fenêtre invité')?.visible === false, 4000)) && findMenuItem('Nouvelle fenêtre invité')?.visible === false)
    findMenuItem('Ouvrir le gestionnaire de tâches')?.click()
    check('guest: the task manager does not open from a guest window, and it says so', await waitFor(() => /gestionnaire de tâches n’est pas disponible/.test(guest.browser.snapshot().toast?.message ?? ''), 3000), guest.browser.snapshot().toast?.message)
    check('guest: ...and no window of the task manager exists', !allWebContents.getAllWebContents().some((w) => !w.isDestroyed() && /taskmanager/.test(w.getURL())))
    win.emit('focus')
    await waitFor(() => manager.focused().id === 'main', 4000)

    // the keys of the mini window do nothing there: a mini window would archive the page in the owner's profile
    patch({ littleArcModifier: true })
    guest.browser.dispatch({ type: 'tab/open', url: `${base}/links` })
    const guestLinks = guest.store.get().tabs.at(-1)!.id
    const guestLinksWc = () => (guest.browser.pageFor(guestLinks) as unknown as { webContents: WebContents } | undefined)?.webContents
    await waitFor(() => guest.store.get().tabs.find((t) => t.id === guestLinks)?.title === 'links')
    await sleep(300)
    const guestAt = await centerOf(guestLinksWc()!, '#plain')
    const guestTabs = guest.store.get().tabs.length
    await clickAt(guestLinksWc()!, guestAt.x, guestAt.y, ['alt', 'meta'])
    check('guest: ⌥⌘ + clic opens a tab of the guest window, never a Little Arc', (await waitFor(() => guest.store.get().tabs.length === guestTabs + 1)) && little.count() === 0, JSON.stringify({ tabs: guest.store.get().tabs.length, little: little.count() }))
    patch({ littleArcModifier: false })

    // closed, it leaves nothing: a new guest window starts afresh
    guest.win.close()
    await waitFor(() => manager.guestWindows().length === 0)
    await manager.settled()
    check('guest: closing the window ends it, and the session is erased', manager.guestWindows().length === 0 && !manager.list().some((r) => r.id === guest.id))
    const second = manager.openGuest()
    if (second) {
      second.browser.dispatch({ type: 'tab/open', url: `${base}/read?who=guest2` })
      check('guest: a new guest window does not get the cookie of the one before', (await waitFor(() => cookies.some((c) => c.who === 'guest2'), 8000)) && cookies.some((c) => c.who === 'guest2' && !c.cookie.includes('littlearcguest')), JSON.stringify(cookies))
      second.win.close()
      await waitFor(() => manager.guestWindows().length === 0)
      await manager.settled()
    } else check('guest: a second guest window opens', false)

    // off again: refused, and the entry hidden
    patch({ guestProfile: false })
    check('guest: switched off again, no guest window opens and the entry is hidden', manager.openGuest() === null && (await waitFor(() => findMenuItem('Nouvelle fenêtre invité')?.visible === false)))
  } finally {
    ;(shell as unknown as { showItemInFolder: typeof realReveal }).showItemInFolder = realReveal
    ;(shell as unknown as { openPath: typeof realOpenPath }).openPath = realOpenPath
    for (const st of little.states()) little.close(st.id)
    for (const record of manager.privateWindows()) record.win.close()
    await waitFor(() => manager.privateWindows().length === 0 && little.count() === 0, 4000)
    await manager.settled()
    for (const tab of state().tabs) if (!originalTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    if (archiveBefore === 0) browser.dispatch({ type: 'archive/clear' })
    browser.closeOverlay()
    patch({
      profiles: originalSettings.profiles,
      littleArcModifier: originalSettings.littleArcModifier,
      littleDownloadBubble: originalSettings.littleDownloadBubble,
      guestProfile: originalSettings.guestProfile,
      littleArcArchiveHours: originalSettings.littleArcArchiveHours,
      peekWithShift: originalSettings.peekWithShift,
      blockExceptions: originalSettings.blockExceptions,
      siteDataRecents: originalSettings.siteDataRecents
    })
    rmSync(downloadsFolder, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=littlearc`: only these checks, with their own report. */
export async function runLittleArcSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeLittleArc(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeLittleArc ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_LITTLEARC ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
