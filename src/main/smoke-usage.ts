// Engine checks for the small usage features, run inside a real Electron against a local server:
//   the commands that had no shortcut (duplicate, mute, fold a folder, move to the next / previous space, reload all, …),
//   where the tab of a link goes (⌘-click, middle click, target="_blank"), the zoom mark of the toolbar,
//   naming windows (Window menu, command bar, windows.json), the question before closing a window of several tabs,
//   the size of the interface (the page views must sit where the zoomed interface draws their card).
// Real mouse input (sendInputEvent) clicks the pages, the toolbar and the command bar; menu entries are chosen the way the menu bar would
// (a menu accelerator cannot be delivered by a synthesized key event: the check is that the entry carries it).
// Called from the engine smoke test: `await smokeUsage(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, Menu, webContents as allWebContents, type MenuItem, type WebContents } from 'electron'
import { COMMANDS } from '@shared/keybindings'
import type { Settings } from '@shared/model'
import { activeTab } from '@shared/sidebar'
import { usableSession } from '@shared/window-session'
import { selectionOf } from '@shared/window-selection'
import type { SmokeContext } from './smoke'
import { CloseGuard, type CloseAsker } from './shell/close-guard'
import { MAIN_WINDOW_ID, getWindowManager, type WindowRecord } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void
type Rect = { x: number; y: number; width: number; height: number }


const waitFor = waiterOf(8000, 80)

const walk = (items: readonly MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu.items) : [])])
/** The entries of the Fenêtre menu only (File also holds an entry of the same name, hidden while windows cannot be named). */
const windowMenuLabels = (): string[] => walk(Menu.getApplicationMenu()?.items.filter((item) => item.label === 'Fenêtre') ?? []).map((item) => item.label)
const menuItem = (label: string): MenuItem | undefined => walk(Menu.getApplicationMenu()?.items ?? []).find((item) => item.label === label)

/** The new commands, the label of their menu entry (Couper / Replier say the other thing when it applies) and the F-key combination the test gives each. */
const NEW_COMMANDS: Array<[id: string, label: string]> = [
  ['duplicateTab', 'Dupliquer l’onglet'],
  ['muteTab', 'Couper le son de l’onglet'],
  ['toggleFolder', 'Replier le dossier de l’onglet'],
  ['moveTabNextSpace', 'Déplacer l’onglet vers l’espace suivant'],
  ['moveTabPreviousSpace', 'Déplacer l’onglet vers l’espace précédent'],
  ['reloadAll', 'Actualiser tous les onglets'],
  ['clearHistory', 'Effacer l’historique de navigation…'],
  ['importData', 'Importer depuis un autre navigateur…'],
  ['taskManager', 'Ouvrir le gestionnaire de tâches'],
  ['addExtension', 'Ajouter une extension…'],
  ['manageExtensions', 'Gérer les extensions…'],
  ['nameWindow', 'Nommer la fenêtre…']
]
const ACCELERATORS = Object.fromEntries(NEW_COMMANDS.map(([id], i) => [id, `Ctrl+Alt+Shift+F${i + 1}`]))

export async function smokeUsage(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const manager = getWindowManager()
  const state = () => store.get()
  const settings = () => state().settings
  const patch = (p: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch: p })
  const original = { ...settings() }
  const originalSpace = state().activeSpaceId
  const ui = overlayView.webContents
  const mine = new Set<string>()
  const createdSpaces: string[] = []
  const extraWindows: WindowRecord[] = []

  // ---- a local server: pages with links to click, a page that makes a little sound, a page that counts its hits ----
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.set(url.pathname + url.search, (hits.get(url.pathname + url.search) ?? 0) + 1)
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    const box = (id: string, top: number, extra: string) => `<a id="${id}" ${extra} style="position:absolute;left:10px;top:${top}px;width:240px;height:36px;display:block;background:#ccd">${id}</a>`
    if (url.pathname === '/links') {
      return res.end(`<title>u links</title><body style="margin:0">
        ${box('plain', 10, 'href="/plain"')}${box('blank', 60, 'target="_blank" href="/blank"')}
        <button id="open" style="position:absolute;left:10px;top:110px;width:240px;height:36px" onclick="window.open('/script')">open</button></body>`)
    }
    if (url.pathname === '/tone') {
      // The tone starts when the check asks (the web contents is muted first, so that nothing is heard); it is very quiet all the same.
      return res.end(`<title>u tone</title><body>tone<script>
        window.startTone = () => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.01
          osc.connect(gain); gain.connect(ctx.destination); osc.start(); window.stopTone = () => osc.stop() }</script></body>`)
    }
    res.end(`<title>u ${url.pathname}${url.search}</title><body>page ${url.pathname}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const host = '127.0.0.1'

  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const openTab = async (path: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = state().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => pageOf(tab.id) !== undefined)
    const wc = pageOf(tab.id)!
    await waitFor(() => !wc.isLoading() && wc.getURL().startsWith(base))
    await sleep(150)
    return { id: tab.id, wc }
  }
  const evaluate = <T>(wc: WebContents, js: string): Promise<T> => wc.executeJavaScript(js) as Promise<T>
  const rectOf = async (wc: WebContents, selector: string): Promise<Rect | null> =>
    evaluate<Rect | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, button: 'left' | 'middle', modifiers: Array<'shift' | 'meta'>) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers } as Electron.MouseInputEvent)
  /** A real click: the pointer moves, goes down and up. */
  const clickOn = async (wc: WebContents, selector: string, options: { button?: 'left' | 'middle'; modifiers?: Array<'shift' | 'meta'> } = {}): Promise<boolean> => {
    const rect = await rectOf(wc, selector)
    if (!rect) return false
    const [x, y] = [rect.x + rect.width / 2, rect.y + rect.height / 2]
    const { button = 'left', modifiers = [] } = options
    mouse(wc, 'mouseMove', x, y, button, modifiers)
    mouse(wc, 'mouseDown', x, y, button, modifiers)
    mouse(wc, 'mouseUp', x, y, button, modifiers)
    await sleep(450)
    return true
  }
  const pageBounds = (tabId: string): Rect | undefined => (browser.pageFor(tabId) as unknown as { view?: { getBounds(): Rect } } | undefined)?.view?.getBounds()
  const warnings: string[] = []
  const errors: string[] = []
  const realWarn = console.warn
  const realError = console.error
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '))

  win.showInactive()
  // What the suites before this one may have left: nothing may fall asleep during the test, and a site may not have an autoplay choice of its own.
  patch({ sleepAfterMinutes: 0, peekOnExternalLinks: false, peekWithShift: true })

  const section = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      check(`${name} ran to the end`, false, String((error as Error)?.stack ?? error))
    }
  }

  try {
    // ======================= the commands that had no shortcut =======================
    await section('shortcuts', async () => {
      patch({ keyBindings: {} })
      await waitFor(() => menuItem('Dupliquer l’onglet') !== undefined)
      check('shortcuts: the registry lists the twelve new commands, each once', NEW_COMMANDS.every(([id]) => COMMANDS.filter((c) => c.id === id).length === 1))
      const withKey = NEW_COMMANDS.filter(([, label]) => menuItem(label)?.accelerator)
      check('shortcuts: by default none of them has a shortcut (Arc shows none), and each has its entry in the menu bar', withKey.length === 0 && NEW_COMMANDS.every(([, label]) => menuItem(label) !== undefined), withKey.map(([id]) => id).join(', '))

      patch({ keyBindings: ACCELERATORS })
      await waitFor(() => menuItem('Dupliquer l’onglet')?.accelerator === ACCELERATORS['duplicateTab'])
      const unhosted = NEW_COMMANDS.filter(([id, label]) => menuItem(label)?.accelerator !== ACCELERATORS[id] || menuItem(label)?.registerAccelerator === false)
      check('shortcuts: given a key in Réglages, each command is the shortcut of its entry, registered once', unhosted.length === 0, unhosted.map(([id]) => id).join(', '))

      // ---- spaces: a single one first (the move entries are greyed out), then three ----
      const first = state().activeSpaceId
      const spaceCount = state().spaces.length
      const initialIds = state().spaces.map((s) => s.id)
      const links = await openTab('/count?id=u-dup')
      check('shortcuts: with a single space, "Déplacer l’onglet vers l’espace suivant / précédent" are greyed out', spaceCount !== 1 || (menuItem('Déplacer l’onglet vers l’espace suivant')?.enabled === false && menuItem('Déplacer l’onglet vers l’espace précédent')?.enabled === false))

      // Duplicate.
      const before = state().tabs.filter((t) => t.url === `${base}/count?id=u-dup`).length
      menuItem('Dupliquer l’onglet')!.click()
      check('shortcuts: Dupliquer l’onglet opens a second tab on the same address', await waitFor(() => state().tabs.filter((t) => t.url === `${base}/count?id=u-dup`).length === before + 1))
      for (const tab of state().tabs.filter((t) => t.url === `${base}/count?id=u-dup`)) mine.add(tab.id)

      // Reload all.
      browser.dispatch({ type: 'tab/select', id: links.id })
      const hitsBefore = hits.get('/count?id=u-dup') ?? 0
      menuItem('Actualiser tous les onglets')!.click()
      check('shortcuts: "Actualiser tous les onglets" reloads the pages (its entry is the command’s)', await waitFor(() => (hits.get('/count?id=u-dup') ?? 0) > hitsBefore, 10_000), `hits ${hits.get('/count?id=u-dup')} / ${hitsBefore}`)

      // Mute: a silent page greys the entry, a page that plays turns it on, the entry says what it does.
      // The tone starts from a script with no click: with Chromium's own autoplay rule (the default) it would stay silent. Electron fixes the
      // rule when a page is made, so it is let through before the tab opens (and for the site, whatever choice a suite before left for it).
      patch({ autoplayPolicy: 'allow', siteAutoplay: {} })
      const tone = await openTab('/tone')
      browser.dispatch({ type: 'tab/select', id: links.id })
      await waitFor(() => menuItem('Couper le son de l’onglet')?.enabled === false)
      check('shortcuts: the sound entry is greyed out on a tab that makes no sound, as Arc’s Mute is', menuItem('Couper le son de l’onglet')?.enabled === false)
      // The page starts silent for the user: its web contents is muted first (the tab is still reported audible).
      tone.wc.setAudioMuted(true)
      await evaluate(tone.wc, 'window.startTone(); 0')
      browser.dispatch({ type: 'tab/select', id: tone.id })
      const playing = await waitFor(() => browser.snapshot().runtime.tabs[tone.id]?.audible === true, 8000)
      await waitFor(() => menuItem('Couper le son de l’onglet')?.enabled === true)
      check('shortcuts: …and turns on for a tab that plays', playing && menuItem('Couper le son de l’onglet')?.enabled === true, JSON.stringify(browser.snapshot().runtime.tabs[tone.id]))
      menuItem('Couper le son de l’onglet')!.click()
      check('shortcuts: choosing it mutes the tab, and the entry then offers to give the sound back', (await waitFor(() => browser.snapshot().runtime.tabs[tone.id]?.muted === true)) && (await waitFor(() => menuItem('Rétablir le son de l’onglet') !== undefined)))
      await evaluate(tone.wc, 'window.stopTone(); 0').catch((error: unknown) => console.log(`[usage] the tone could not be stopped (the page is gone?): ${String(error).slice(0, 80)}`))
      menuItem('Rétablir le son de l’onglet')!.click()
      check('shortcuts: …which does so', (await waitFor(() => browser.snapshot().runtime.tabs[tone.id]?.muted === false)) && (await waitFor(() => menuItem('Couper le son de l’onglet') !== undefined)))
      browser.dispatch({ type: 'tab/close', id: tone.id })
      patch({ autoplayPolicy: original.autoplayPolicy, siteAutoplay: original.siteAutoplay })

      // Fold a folder: only for a tab that sits in one.
      browser.dispatch({ type: 'tab/select', id: links.id })
      await waitFor(() => menuItem('Replier le dossier de l’onglet')?.enabled === false)
      check('shortcuts: "Replier le dossier de l’onglet" is greyed out for a tab that is in no folder', menuItem('Replier le dossier de l’onglet')?.enabled === false)
      browser.dispatch({ type: 'tab/pin', id: links.id })
      browser.dispatch({ type: 'folder/create', name: 'Dossier usage' })
      const folder = state().folders.find((f) => f.name === 'Dossier usage')!
      browser.dispatch({ type: 'tab/move', id: links.id, toIndex: 0, pinned: true, folderId: folder.id })
      await waitFor(() => menuItem('Replier le dossier de l’onglet')?.enabled === true)
      menuItem('Replier le dossier de l’onglet')!.click()
      check('shortcuts: it folds the folder of the tab on screen, and then says Déplier', (await waitFor(() => state().folders.find((f) => f.id === folder.id)?.collapsed === true)) && (await waitFor(() => menuItem('Déplier le dossier de l’onglet') !== undefined)))
      menuItem('Déplier le dossier de l’onglet')!.click()
      check('shortcuts: …and unfolds it', await waitFor(() => state().folders.find((f) => f.id === folder.id)?.collapsed === false))
      browser.dispatch({ type: 'folder/delete', id: folder.id })
      browser.dispatch({ type: 'tab/unpin', id: links.id })

      // Move to the next / previous space (three spaces: the neighbours differ).
      while (state().spaces.length < 3) {
        browser.dispatch({ type: 'space/create', name: `usage ${state().spaces.length + 1}`, emoji: '🧭', hue: 90 })
        const created = state().spaces.find((s) => !initialIds.includes(s.id) && !createdSpaces.includes(s.id))
        if (created) createdSpaces.push(created.id)
      }
      const order = state().spaces.map((s) => s.id)
      const middle = order[1]!
      browser.dispatch({ type: 'space/select', id: middle })
      const a = await openTab('/count?id=u-move-a')
      await waitFor(() => menuItem('Déplacer l’onglet vers l’espace suivant')?.enabled === true)
      menuItem('Déplacer l’onglet vers l’espace suivant')!.click()
      check('shortcuts: "Déplacer l’onglet vers l’espace suivant" sends the tab to the space after the current one', await waitFor(() => state().tabs.find((t) => t.id === a.id)?.spaceId === order[2]), String(state().tabs.find((t) => t.id === a.id)?.spaceId))
      browser.dispatch({ type: 'space/select', id: middle })
      const b = await openTab('/count?id=u-move-b')
      menuItem('Déplacer l’onglet vers l’espace précédent')!.click()
      check('shortcuts: …and "précédent" to the space before it', await waitFor(() => state().tabs.find((t) => t.id === b.id)?.spaceId === order[0]), String(state().tabs.find((t) => t.id === b.id)?.spaceId))
      browser.dispatch({ type: 'space/select', id: first })

      // A real key through the event queue: informative only (macOS hands key equivalents to the menu from the keyboard, not from a synthesized event).
      const dupBefore = state().tabs.length
      const knownTabs = new Set(state().tabs.map((t) => t.id))
      browser.dispatch({ type: 'tab/select', id: links.id })
      // The page of a tab of a space that was left may be gone (put to sleep): selecting the tab brings it back, and it is read once it is there.
      await waitFor(() => pageOf(links.id) !== undefined, 8000)
      const wcLinks = pageOf(links.id)!
      wcLinks.focus()
      wcLinks.sendInputEvent({ type: 'keyDown', keyCode: 'F1', modifiers: ['control', 'alt', 'shift'] })
      wcLinks.sendInputEvent({ type: 'keyUp', keyCode: 'F1', modifiers: ['control', 'alt', 'shift'] })
      await sleep(500)
      for (const tab of state().tabs) if (!knownTabs.has(tab.id)) mine.add(tab.id)
      console.log(`[usage] a synthesized ⌃⌥⇧F1 reaches the menu entry: ${state().tabs.length > dupBefore ? 'yes' : 'no (expected: key equivalents come from the keyboard)'}`)
      patch({ keyBindings: {} })
    })

    // ======================= where the tab of a link goes =======================
    await section('links', async () => {
      patch({ modifiedClickBackground: true, blankLinkBackground: false, peekWithShift: true })
      const page = await openTab('/links')
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(300)
      const selected = () => activeTab(state())?.id
      const newTabs = (since: Set<string>) => state().tabs.filter((t) => !since.has(t.id))
      const ids = () => new Set(state().tabs.map((t) => t.id))
      const settle = async (since: Set<string>) => {
        await waitFor(() => newTabs(since).length > 0, 4000)
        for (const tab of newTabs(since)) mine.add(tab.id)
      }

      let since = ids()
      await clickOn(page.wc, '#plain', { modifiers: ['meta'] })
      await settle(since)
      check('links: ⌘-click on a link opens its tab in the background (Arc’s default), the page stays on screen', newTabs(since).length === 1 && selected() === page.id, `${newTabs(since).length} new, selected ${selected() === page.id ? 'the page' : 'another'}`)

      since = ids()
      await clickOn(page.wc, '#plain', { button: 'middle' })
      await settle(since)
      check('links: a middle click does the same', newTabs(since).length === 1 && selected() === page.id, `${newTabs(since).length} new`)

      since = ids()
      await clickOn(page.wc, '#blank')
      await settle(since)
      const blankTab = newTabs(since)[0]
      check('links: a link that opens a tab by itself (target="_blank") brings it to the front (Arc’s default)', newTabs(since).length === 1 && selected() === blankTab?.id, `${newTabs(since).length} new`)
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(300)

      patch({ modifiedClickBackground: false })
      since = ids()
      await clickOn(page.wc, '#plain', { modifiers: ['meta'] })
      await settle(since)
      check('links: with the setting off, a ⌘-click brings the new tab to the front', newTabs(since).length === 1 && selected() === newTabs(since)[0]?.id)
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(300)
      since = ids()
      await clickOn(page.wc, '#plain', { button: 'middle' })
      await settle(since)
      check('links: …and so does a middle click', newTabs(since).length === 1 && selected() === newTabs(since)[0]?.id)
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(300)

      patch({ modifiedClickBackground: true, blankLinkBackground: true })
      since = ids()
      await clickOn(page.wc, '#blank')
      await settle(since)
      check('links: with its own setting on, a target="_blank" link opens behind', newTabs(since).length === 1 && selected() === page.id, `${newTabs(since).length} new`)
      since = ids()
      await clickOn(page.wc, '#plain', { modifiers: ['meta'] })
      await settle(since)
      check('links: …and the other setting still governs the ⌘-click', newTabs(since).length === 1 && selected() === page.id)

      // What this does not change.
      patch({ blankLinkBackground: false })
      since = ids()
      await clickOn(page.wc, '#open')
      await settle(since)
      console.log(`[usage] window.open() after a click on a button opens its tab ${newTabs(since).length === 1 && selected() === newTabs(since)[0]?.id ? 'in front (Arc: behind, mesures-arc-5 §3)' : 'behind'}`)
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(300)
      since = ids()
      await clickOn(page.wc, '#plain', { modifiers: ['shift'] })
      // The witness is the Glance: the shell opens it where it would otherwise have opened the tab, so once it is there no tab is coming.
      const glance = await waitFor(() => browser.snapshot().peek !== null)
      check('links: a Shift-click still opens a Glance and no tab', glance && newTabs(since).length === 0, `peek ${browser.snapshot().peek === null ? 'none' : 'open'}, ${newTabs(since).length} new`)
      browser.closeOverlay()
      await sleep(300)
      since = ids()
      await clickOn(page.wc, '#plain')
      // The witness: the page of the tab reaches the link's address (earlier clicks opened /plain in other tabs, so the count of the server says nothing).
      const inPlace = await waitFor(() => !page.wc.isDestroyed() && page.wc.getURL() === `${base}/plain`)
      check('links: a plain click on a link still navigates in place', inPlace && newTabs(since).length === 0 && (hits.get('/plain') ?? 0) >= 1, page.wc.isDestroyed() ? 'the page is gone' : page.wc.getURL())
      patch({ modifiedClickBackground: true, blankLinkBackground: false })
    })

    // ======================= the zoom mark =======================
    await section('zoom mark', async () => {
      patch({ showZoomIndicator: true, siteZoom: {} })
      const page = await openTab('/zoom')
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(400)
      const mark = () => rectOf(win.webContents, '.tb-zoom')
      check('zoom: nothing is drawn while the page is at 100 %', (await mark()) === null)
      browser.zoom(1)
      check('zoom: ⌘+ puts the mark in the toolbar, with the zoom of the page', await waitFor(async () => (await evaluate<string>(win.webContents, `document.querySelector('.tb-zoom')?.textContent ?? ''`)) === frenchSpaces('110 %')), String(await evaluate(win.webContents, `document.querySelector('.tb-zoom')?.textContent ?? ''`)))
      check('zoom: the page really is at 110 %', Math.abs(page.wc.getZoomFactor() - 1.1) < 0.01, String(page.wc.getZoomFactor()))
      const label = await evaluate<string>(win.webContents, `document.querySelector('.tb-zoom')?.getAttribute('aria-label') ?? ''`)
      check('zoom: the mark is a button that says what a click does', label.includes(frenchSpaces('110 %')) && label.includes(frenchSpaces('Rétablir 100 %')), label)
      const rect = (await mark())!
      const [x, y] = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)]
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
      check('zoom: a real click on the mark puts the page back to 100 % and the mark goes away', (await waitFor(() => Math.abs(page.wc.getZoomFactor() - 1) < 0.01 && settings().siteZoom[host] === undefined)) && (await waitFor(async () => (await mark()) === null)), `zoom ${page.wc.getZoomFactor()} / ${JSON.stringify(settings().siteZoom)}`)
      patch({ showZoomIndicator: false })
      browser.zoom(1)
      await waitFor(() => settings().siteZoom[host] !== undefined)
      // A fixed wait, for want of a witness: the toolbar is drawn from what the window is told, and with the setting off nothing it draws says
      // that it has been told of this zoom.
      await sleep(400)
      check('zoom: with the setting off nothing is drawn, though the page is zoomed', (await mark()) === null && settings().siteZoom[host] !== undefined)
      browser.zoom(0)
      await waitFor(() => settings().siteZoom[host] === undefined)
      patch({ showZoomIndicator: true })
    })

    // ======================= naming windows =======================
    await section('window names', async () => {
      // Off by default: the Window menu is the system's own, File's entry is hidden and greyed out, nobody is told a name.
      patch({ nameWindows: false })
      check('names: by default the Window menu is the system’s own, with no entry to name a window', await waitFor(() => !windowMenuLabels().includes('Nommer la fenêtre…') && windowMenuLabels().length > 0), windowMenuLabels().join(' | '))
      check('names: …File’s entry (which hosts the command’s shortcut) is hidden and greyed out, and no window is told any name', menuItem('Nommer la fenêtre…')?.visible === false && menuItem('Nommer la fenêtre…')?.enabled === false && browser.snapshot().windows === undefined)
      patch({ nameWindows: true })
      const second = manager.openWindow({ commandBar: false })
      extraWindows.push(second)
      await waitFor(() => !second.win.webContents.isLoading())
      await waitFor(async () => (await evaluate<string>(second.win.webContents, 'typeof window.lucium')) === 'object')
      check('names: a window has no name until it is given one, and its title is the application’s', second.name === undefined && manager.entries().every((e) => e.name === undefined || e.id === MAIN_WINDOW_ID))
      check('names: with windows nameable the Window menu offers "Nommer la fenêtre…" and lists the windows, and File’s entry is shown', (await waitFor(() => windowMenuLabels().includes('Nommer la fenêtre…') && windowMenuLabels().includes('Fenêtre 2'))) && menuItem('Nommer la fenêtre…')?.visible === true, windowMenuLabels().join(' | '))

      // The name comes from the interface of the window itself, through the preload.
      await evaluate(second.win.webContents, `window.lucium.setWindowName('  Travail  ')`)
      check('names: the interface of a window can name it (spaces trimmed)', await waitFor(() => second.name === 'Travail'), String(second.name))
      check('names: the title of the window becomes the name (the system’s list of windows shows it)', await waitFor(() => second.win.getTitle() === 'Travail'), second.win.getTitle())
      check('names: the Window menu lists it by its name', await waitFor(() => windowMenuLabels().includes('Travail')), windowMenuLabels().join(' | '))
      check('names: and the other windows are told, for their command bar', await waitFor(() => (browser.snapshot().windows ?? []).some((w) => w.id === second.id && w.name === 'Travail')), JSON.stringify(browser.snapshot().windows))
      check('names: the window itself is told its own name, and not offered itself', (await waitFor(() => second.browser.snapshot().windowName === 'Travail')) && !(second.browser.snapshot().windows ?? []).some((w) => w.id === second.id))

      // The command bar of the main window: real keys, then Enter.
      const focusCalls: string[] = []
      const realFocus = manager.focusWindow.bind(manager)
      manager.focusWindow = (id: string) => {
        focusCalls.push(id)
        return realFocus(id)
      }
      const typeText = async (text: string) => {
        for (const ch of text) {
          const keyCode = ch === ' ' ? 'Space' : ch
          ui.sendInputEvent({ type: 'keyDown', keyCode })
          ui.sendInputEvent({ type: 'char', keyCode: ch })
          ui.sendInputEvent({ type: 'keyUp', keyCode })
          await sleep(45)
        }
        await sleep(350)
      }
      const fieldFocused = async () => String(await ui.executeJavaScript(`document.activeElement === document.querySelector('.palette-input') ? 'yes' : ''`)) === 'yes'
      for (let attempt = 0; attempt < 4; attempt++) {
        browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
        if (await waitFor(fieldFocused, 3000)) break
      }
      await sleep(200)
      await typeText('travail')
      const rows = () => ui.executeJavaScript(`[...document.querySelectorAll('.results li[role="option"]')].map((li) => li.querySelector('.label')?.textContent ?? '')`) as Promise<string[]>
      let listed = await rows()
      check('names: typing a name in the command bar offers "Aller à la fenêtre « Travail »"', listed.includes(frenchSpaces('Aller à la fenêtre « Travail »')), JSON.stringify(listed))
      const at = listed.indexOf(frenchSpaces('Aller à la fenêtre « Travail »'))
      for (let i = 0; i < at; i++) {
        ui.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
        ui.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
        await sleep(40)
      }
      ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      check('names: Enter brings that window to the front (the shell is asked to), and the bar closes', (await waitFor(() => focusCalls.includes(second.id))) && (await waitFor(() => browser.currentPanel() === null)), `${focusCalls.join(',')} panel=${browser.currentPanel()}`)
      manager.focusWindow = realFocus
      await sleep(200)
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      await waitFor(fieldFocused, 3000)
      await typeText('nommer')
      listed = await rows()
      check('names: "Nommer la fenêtre…" is a command of the bar too, and opens its panel', listed.includes('Nommer la fenêtre…'), JSON.stringify(listed))
      browser.closeOverlay()

      // The panel itself.
      browser.openOverlay({ panel: 'windowname' })
      check('names: the naming panel opens in the window', await waitFor(() => browser.currentPanel() === 'windowname'))
      browser.closeOverlay()

      // Hostile and damaged names.
      await evaluate(second.win.webContents, `window.lucium.setWindowName('a\\u202Eb\\nc')`)
      check('names: control and direction marks are taken out of a name', await waitFor(() => second.name === 'ab c'), JSON.stringify(second.name))
      await evaluate(second.win.webContents, `window.lucium.setWindowName('x'.repeat(500))`)
      check('names: a name is cut at 60 characters', await waitFor(() => second.name?.length === 60), String(second.name?.length))
      warnings.length = 0
      await evaluate(second.win.webContents, `window.lucium.setWindowName(42)`)
      // The witness is the line of the log: the main process writes it as it refuses the name (usage-ipc.ts).
      const notText = await waitFor(() => warnings.some((w) => w.includes('not text')))
      check('names: something that is not text is refused, and the log says so', notText && second.name?.length === 60, JSON.stringify(warnings.slice(0, 2)))
      await evaluate(second.win.webContents, `window.lucium.setWindowName('Travail')`)
      await waitFor(() => second.name === 'Travail')

      // Remembered with the session: the snapshot written at quit, read back at the next launch (windows.json), an old file too.
      manager.setName(MAIN_WINDOW_ID, 'Principale')
      const written = JSON.parse(JSON.stringify(manager.sessionSnapshot()))
      check('names: windows.json keeps the name of each window, the first one included', written.mainName === 'Principale' && written.windows.some((w: { name?: string }) => w.name === 'Travail'), JSON.stringify(written).slice(0, 200))
      const reread = usableSession(written, [{ x: 0, y: 0, width: 4000, height: 3000 }], state())
      second.win.close()
      await waitFor(() => second.win.isDestroyed())
      extraWindows.splice(extraWindows.indexOf(second), 1)
      const saved = reread.windows.find((w) => w.name === 'Travail')
      const reopened = manager.openWindow({ commandBar: false, restore: { bounds: saved?.bounds ?? { x: 50, y: 50, width: 900, height: 600 }, selection: selectionOf(state()), name: saved?.name } })
      extraWindows.push(reopened)
      check('names: after a restart the window comes back with its name, and its title', reopened.name === 'Travail' && (await waitFor(() => reopened.win.getTitle() === 'Travail', 10_000)), `${reopened.name} / ${reopened.win.getTitle()}`)
      const legacy = usableSession({ main: { x: 0, y: 0, width: 900, height: 600 }, windows: [{ bounds: { x: 10, y: 10, width: 900, height: 600 }, spaceId: state().activeSpaceId, tabs: {}, sidebarVisible: true }] }, [{ x: 0, y: 0, width: 4000, height: 3000 }], state())
      check('names: a file written before names existed gives windows with none', legacy.mainName === undefined && legacy.windows.length === 1 && legacy.windows[0]!.name === undefined)
      manager.setName(MAIN_WINDOW_ID, '')

      // Off: no entry, no name shown, nothing accepted.
      patch({ nameWindows: false })
      check('names: with the setting off the Window menu is the system’s own again', await waitFor(() => !windowMenuLabels().includes('Nommer la fenêtre…') && !windowMenuLabels().includes('Travail')), windowMenuLabels().join(' | '))
      check('names: …the windows are not told any name', await waitFor(() => browser.snapshot().windows === undefined && reopened.browser.snapshot().windowName === undefined))
      check('names: …the title is the usual one again', await waitFor(() => reopened.win.getTitle() === 'Lucium'), reopened.win.getTitle())
      warnings.length = 0
      await evaluate(reopened.win.webContents, `window.lucium.setWindowName('Refusé')`)
      // The witness is the line of the log: the main process writes it as it refuses the name (usage-ipc.ts).
      const refusedName = await waitFor(() => warnings.some((w) => w.includes('cannot be named')))
      check('names: …and a name sent anyway is refused with a log', refusedName && reopened.name === 'Travail', JSON.stringify(warnings.slice(0, 2)))
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      await waitFor(fieldFocused, 3000)
      await typeText('fenetre')
      listed = await rows()
      // Other rows say « fenêtre » and are not about names (the side of the sidebar in this window, the settings of the windows): only the two
      // entries of the names are looked for, the one that names and the one that goes to a named window.
      const aboutNames = (l: string) => l.startsWith('Nommer la fenêtre') || l.startsWith('Aller à la fenêtre') || l.includes(frenchSpaces('« Travail »'))
      check('names: …and the command bar offers nothing about window names', !listed.some(aboutNames), JSON.stringify(listed))
      await typeText(' travail')
      listed = await rows()
      check('names: …not even for the name the window had', !listed.some(aboutNames), JSON.stringify(listed))
      browser.closeOverlay()
      patch({ nameWindows: true })
      check('names: switched on again, the name that was kept is back', await waitFor(() => reopened.win.getTitle() === 'Travail'))
      reopened.win.close()
      await waitFor(() => reopened.win.isDestroyed())
      extraWindows.splice(extraWindows.indexOf(reopened), 1)
    })

    // ======================= the question before closing a window =======================
    await section('close guard', async () => {
      const asked: Array<{ message: string; detail: string }> = []
      let answer: { close: boolean; stopAsking: boolean } | 'reject' = { close: false, stopAsking: false }
      const asker: CloseAsker = async (_win, warning) => {
        asked.push(warning)
        if (answer === 'reject') throw new Error('the sheet could not be shown')
        return answer
      }
      const realAsk = manager.closeGuard.ask
      manager.closeGuard.ask = asker
      patch({ warnBeforeClosingWindow: false })
      const tabsHere = state().tabs.filter((t) => t.spaceId === state().activeSpaceId).length
      for (let i = tabsHere; i < 3; i++) {
        const t = await openTab(`/guard-${i}`)
        mine.add(t.id)
      }
      check('close guard: switched off (the default) no window carries a listener for it', manager.closeGuard.listening() === 0, String(manager.closeGuard.listening()))
      const plain = manager.openWindow({ commandBar: false })
      extraWindows.push(plain)
      plain.win.close()
      check('close guard: …and a window of several tabs closes without a question', (await waitFor(() => plain.win.isDestroyed())) && asked.length === 0)
      extraWindows.splice(extraWindows.indexOf(plain), 1)

      patch({ warnBeforeClosingWindow: true })
      // The main window going away closes the others without a question, and only for that call: the windows test uses it as a helper and
      // goes on with the same window manager, where the next window must be asked about again.
      const doomed = manager.openWindow({ commandBar: false })
      extraWindows.push(doomed)
      await waitFor(() => manager.closeGuard.listening() === manager.list().length)
      manager.closeOtherWindows()
      check('close guard: closeOtherWindows (the main window is going away) closes the others without a question', (await waitFor(() => doomed.win.isDestroyed())) && asked.length === 0, JSON.stringify(asked))
      extraWindows.splice(extraWindows.indexOf(doomed), 1)
      const windowOne = manager.openWindow({ commandBar: false })
      extraWindows.push(windowOne)
      await waitFor(() => manager.closeGuard.listening() === manager.list().length)
      check('close guard: switched on, every window carries the listener (the one opened after too)', manager.closeGuard.listening() === manager.list().length, `${manager.closeGuard.listening()} / ${manager.list().length}`)
      windowOne.win.close()
      // A fixed wait, for want of a witness: after the answer no, a close started by mistake would only end some time later, and nothing comes
      // to say that none was started.
      await sleep(600)
      check('close guard: closing a window that shows several tabs asks first, and the window stays when the answer is no', asked.length === 1 && !windowOne.win.isDestroyed(), JSON.stringify(asked))
      check('close guard: the question names the tabs and where they stay', anySpace(/^Ses \d+ onglets de l’espace « .+ » restent dans la barre latérale des autres fenêtres\.$/).test(asked[0]?.detail ?? ''), asked[0]?.detail)
      answer = { close: true, stopAsking: false }
      windowOne.win.close()
      check('close guard: the window closes when the answer is yes, and the setting stays on', (await waitFor(() => windowOne.win.isDestroyed())) && asked.length === 2 && settings().warnBeforeClosingWindow === true)
      extraWindows.splice(extraWindows.indexOf(windowOne), 1)

      // The sheet cannot be shown: the window stays, and the log says which one and why.
      const windowTwo = manager.openWindow({ commandBar: false })
      extraWindows.push(windowTwo)
      answer = 'reject'
      errors.length = 0
      windowTwo.win.close()
      // The witness is the line of the log: the guard writes it where the question failed, and that way never closes the window (close-guard.ts).
      const failureLogged = await waitFor(() => errors.some((e) => e.includes('[close-guard]') && e.includes(windowTwo.id)))
      check('close guard: when the question cannot be asked the window stays open, and the log names the window and the cause', failureLogged && !windowTwo.win.isDestroyed(), JSON.stringify(errors.slice(0, 2)))

      // "Fermer et ne plus demander".
      answer = { close: true, stopAsking: true }
      windowTwo.win.close()
      check('close guard: "ne plus demander" closes the window and switches the setting off, and the listeners go', (await waitFor(() => windowTwo.win.isDestroyed())) && (await waitFor(() => settings().warnBeforeClosingWindow === false)) && (await waitFor(() => manager.closeGuard.listening() === 0)), `${settings().warnBeforeClosingWindow} ${manager.closeGuard.listening()}`)
      extraWindows.splice(extraWindows.indexOf(windowTwo), 1)

      // A private window: its tabs are lost with it.
      patch({ warnBeforeClosingWindow: true })
      const priv = manager.openPrivate({ commandBar: false })
      extraWindows.push(priv)
      priv.browser.dispatch({ type: 'tab/open', url: `${base}/priv-1` })
      priv.browser.dispatch({ type: 'tab/open', url: `${base}/priv-2` })
      await waitFor(() => priv.store.get().tabs.length === 2)
      answer = { close: false, stopAsking: false }
      const askedBefore = asked.length
      priv.win.close()
      // A fixed wait, for want of a witness: after the answer no, a close started by mistake would only end some time later.
      await sleep(600)
      check('close guard: a private window with two tabs asks, and says they will be lost', asked.length === askedBefore + 1 && !priv.win.isDestroyed() && asked.at(-1)?.message === frenchSpaces('Fermer cette fenêtre privée ?') && /seront perdus/.test(asked.at(-1)?.detail ?? ''), JSON.stringify(asked.at(-1)))
      answer = { close: true, stopAsking: false }
      priv.win.close()
      await waitFor(() => priv.win.isDestroyed())
      extraWindows.splice(extraWindows.indexOf(priv), 1)

      // The last window and the quit never ask: a guard of its own, on windows that are not the application's.
      const spare = new BrowserWindow({ show: false, width: 800, height: 600 })
      const fakeRecord = { id: 'spare', kind: 'window', win: spare, browser: undefined, store } as unknown as WindowRecord
      for (const [name, host2] of [['the last window', { windowCount: () => 1, quitting: () => false }], ['a window closed by the quit', { windowCount: () => 3, quitting: () => true }]] as const) {
        const guard = new CloseGuard({ ...host2, stopAsking: () => undefined }, async () => {
          asked.push({ message: `unexpected: ${name}`, detail: '' })
          return { close: false, stopAsking: false }
        })
        const askedNow = asked.length
        const target = new BrowserWindow({ show: false, width: 800, height: 600 })
        guard.watch({ ...fakeRecord, win: target })
        guard.sync(true)
        target.close()
        check(`close guard: ${name} is never asked about`, (await waitFor(() => target.isDestroyed())) && asked.length === askedNow)
      }
      spare.destroy()
      patch({ warnBeforeClosingWindow: false })
      await waitFor(() => manager.closeGuard.listening() === 0)
      manager.closeGuard.ask = realAsk
    })

    // ======================= the size of the interface =======================
    await section('interface size', async () => {
      patch({ uiScale: 100 })
      const page = await openTab('/size')
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(500)
      const zooms = () => [win.webContents.getZoomFactor(), ui.getZoomFactor()]
      check('size: at 100 % (the default) nothing is zoomed', zooms().every((z) => Math.abs(z - 1) < 0.001), JSON.stringify(zooms()))
      const measure = async () => {
        const stage = await rectOf(win.webContents, 'main.stage')
        const bar = await rectOf(win.webContents, '.page-toolbar')
        const sidebar = await rectOf(win.webContents, '.sidebar')
        return { stage, bar, sidebar, view: pageBounds(page.id) }
      }
      const base100 = await measure()
      const baseline = { view: base100.view, lights: browser.trafficLights().position }
      check('size: at 100 % the page card sits where the interface draws it (to within a point)', !!base100.view && !!base100.stage && Math.abs(base100.view.x - base100.stage.x) <= 1.5 && Math.abs(base100.view.width - base100.stage.width) <= 1.5 && Math.abs(base100.view.y - base100.stage.y) <= 2, JSON.stringify(base100))

      for (const percent of [125, 150]) {
        const k = percent / 100
        patch({ uiScale: percent })
        await waitFor(() => Math.abs(win.webContents.getZoomFactor() - k) < 0.001 && Math.abs(ui.getZoomFactor() - k) < 0.001)
        await sleep(600)
        const m = await measure()
        check(`size: ${percent} % zooms the interface surfaces (window and layer) by ${k}`, Math.abs(win.webContents.getZoomFactor() - k) < 0.001 && Math.abs(ui.getZoomFactor() - k) < 0.001, JSON.stringify(zooms()))
        const v = m.view
        const s = m.stage
        const err = v && s ? [v.x - s.x * k, v.y - s.y * k, v.width - s.width * k, v.height - s.height * k].map((n) => Math.round(n * 10) / 10) : null
        check(`size: ${percent} % the page card sits where the zoomed interface draws it (to within 2 or 3 points)`, !!err && err.every((n, i) => Math.abs(n) <= (i === 1 || i === 3 ? 3 : 2)), JSON.stringify({ err, view: v, stage: s }))
        check(`size: ${percent} % the sidebar is ${percent} % as wide, and the card starts at its edge`, !!m.sidebar && !!v && Math.abs(m.sidebar.width * k - 323 * k) <= 1 && Math.abs(v.x - Math.round(323 * k)) <= 1, JSON.stringify({ sidebar: m.sidebar, x: v?.x }))
        const lights = browser.trafficLights().position
        check(`size: ${percent} % the traffic lights follow the header`, lights.x === Math.round(baseline.lights.x * k) && lights.y === Math.round(baseline.lights.y * k), JSON.stringify(lights))
        // The find panel: the layer is placed from the scaled constants, the panel inside it is zoomed with the surface.
        browser.openOverlay({ panel: 'find' })
        await waitFor(() => browser.currentPanel() === 'find')
        await sleep(500)
        const panel = await ui.executeJavaScript(`(() => { const el = document.querySelector('.find-bar, .fb'); if (!el) return null; const r = el.getBoundingClientRect(); return { right: r.right, top: r.top, width: r.width } })()`) as { right: number; top: number; width: number } | null
        const overlayBounds = (browser as unknown as { overlay: { getBounds(): Rect } }).overlay.getBounds()
        const stageNow = (browser as unknown as { stageRect(): Rect }).stageRect()
        const rightEdge = overlayBounds.x + (panel?.right ?? 0) * k
        check(`size: ${percent} % the find panel keeps its 10 px from the right edge of the card, scaled`, !!panel && Math.abs(rightEdge - (stageNow.x + stageNow.width - 10 * k)) <= 2.5, JSON.stringify({ panel, overlayBounds, stageNow, rightEdge }))
        browser.closeOverlay()
        // The tooltip capsule is placed from the pointer, in points.
        browser.showTooltip({ text: 'taille', x: 100, y: 60 })
        await waitFor(() => browser.tooltipWindowForTest() !== null && browser.tooltipWindowForTest()?.isVisible() === true, 4000)
        const tip = browser.tooltipWindowForTest()
        const content = win.getContentBounds()
        check(`size: ${percent} % the tooltip opens at the pointer, which was read in zoomed pixels`, !!tip && Math.abs(tip.getBounds().y - (content.y + Math.round(60 * k) + 6 - 12)) <= 2, JSON.stringify({ tip: tip?.getBounds(), content }))
        browser.showTooltip(null)
      }

      // A split view: the panes sit inside the cards the interface draws.
      patch({ uiScale: 125 })
      await sleep(400)
      const other = await openTab('/size-b')
      browser.dispatch({ type: 'split/create', tabId: page.id, withTabId: other.id })
      await sleep(900)
      const rings = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.pane-ring')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, shown: getComputedStyle(el).visibility } })`) as Array<Rect & { shown: string }>
      const views = [pageBounds(page.id), pageBounds(other.id)]
      const k125 = 1.25
      const idle = rings.findIndex((r) => r.shown === 'hidden')
      if (idle >= 0 && rings.length === 2) {
        const r = rings[idle]!
        const tabOfPane = state().splits[0]!.tabIds[idle]!
        const v = pageBounds(tabOfPane)!
        const e = [v.x - r.x * k125, v.y - (r.y + 32) * k125, v.width - r.width * k125, v.height - (r.height - 32) * k125].map((n) => Math.round(n * 10) / 10)
        check('size: 125 % in a split view the page of a pane sits under its strip, inside the card the interface draws', e.every((n) => Math.abs(n) <= 2.5), JSON.stringify({ e, ring: r, view: v }))
      } else check('size: 125 % in a split view the page of a pane sits under its strip, inside the card the interface draws', false, JSON.stringify({ rings, views }))
      browser.dispatch({ type: 'split/remove', tabId: page.id })

      // Back to 100 %: every figure is the default again.
      patch({ uiScale: 100 })
      await waitFor(() => Math.abs(win.webContents.getZoomFactor() - 1) < 0.001 && Math.abs(ui.getZoomFactor() - 1) < 0.001)
      browser.dispatch({ type: 'tab/select', id: page.id })
      await sleep(700)
      const back = await measure()
      check('size: back at 100 % the surfaces are not zoomed and the page card is where it was, to the point', zooms().every((z) => Math.abs(z - 1) < 0.001) && JSON.stringify(back.view) === JSON.stringify(baseline.view) && JSON.stringify(browser.trafficLights().position) === JSON.stringify(baseline.lights), JSON.stringify({ back: back.view, was: baseline.view }))
      browser.dispatch({ type: 'settings/update', patch: { uiScale: 9999 } })
      check('size: a value out of range is brought to 200 %, and a value that is not a number to 100 %', settings().uiScale === 200 && ((): boolean => { browser.dispatch({ type: 'settings/update', patch: { uiScale: 'grand' as unknown as number } }); return settings().uiScale === 100 })())
      await waitFor(() => Math.abs(win.webContents.getZoomFactor() - 1) < 0.001)
    })
  } finally {
    console.warn = realWarn
    console.error = realError
    for (const record of extraWindows) if (!record.win.isDestroyed()) record.win.destroy()
    manager.setName(MAIN_WINDOW_ID, '')
    for (const id of [...mine]) if (state().tabs.some((t) => t.id === id)) browser.dispatch({ type: 'tab/close', id })
    for (const id of createdSpaces) if (state().spaces.some((s) => s.id === id)) browser.dispatch({ type: 'space/delete', id })
    if (state().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.closeOverlay()
    patch({
      keyBindings: original.keyBindings,
      warnBeforeClosingWindow: original.warnBeforeClosingWindow,
      modifiedClickBackground: original.modifiedClickBackground,
      blankLinkBackground: original.blankLinkBackground,
      showZoomIndicator: original.showZoomIndicator,
      nameWindows: original.nameWindows,
      uiScale: original.uiScale,
      peekWithShift: original.peekWithShift,
      peekOnExternalLinks: original.peekOnExternalLinks,
      sleepAfterMinutes: original.sleepAfterMinutes,
      autoplayPolicy: original.autoplayPolicy,
      siteAutoplay: original.siteAutoplay,
      siteZoom: original.siteZoom
    })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=usage`: only these checks, with their own report. */
export async function runUsageSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeUsage(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeUsage ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_USAGE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
