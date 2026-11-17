// Engine checks for navigation between tabs, run inside a real Electron, against the reference measures:
//  - Back on the first page of a tab opened from a link closes it and returns to the tab it came from (real clicks on links, the toolbar button
//    and the menu entry that ⌘[ triggers);
//  - ⌃Tab goes through the tabs in the order they were used, with a panel of pictures kept while ⌃ is held (real key events sent to the pages);
//  - a tab dragged from the sidebar onto the page shows the veil of the split view and makes it on a drop;
//  - the bar of a private window above a page with no colour of its own.
// A local server, a space of its own (removed at the end), and the screen's scale (Retina: 2 pixels per pixel of page) for what is measured in pixels.
// The operating system's own drag session cannot be driven by synthetic input (see smoke-sidebar.ts): the drag events are dispatched on the real
// elements of the sidebar and of the veil, which exercises the handlers, the messages to the shell and the split view that comes out.
// Called from the engine smoke test; `LUCIUM_SMOKE_ONLY=navigation` runs only this file (see index.ts).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Menu, type MenuItem, type NativeImage, type WebContents } from 'electron'
import { CYCLE_PANEL, cyclePanelWidth } from '@shared/tab-cycle'
import { DROP_VEIL, dropLayout, joinLayout, type BoxSide } from '@shared/split-drop'
import { Channel, TOOLBAR_BAR_HEIGHT } from '@shared/ipc'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { SHOT_DELAYS_MS } from './shell/thumbnails'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

/** The data type a tab row of the sidebar sets on a drag (renderer/sidebar-dnd.ts). */
const DRAG_TYPE = 'application/x-lucium-tab'


const waitFor = waiterOf(8000, 50)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance
const sameRect = (r: Rect | null | undefined, e: Rect, tolerance = 1) => !!r && near(r.x, e.x, tolerance) && near(r.y, e.y, tolerance) && near(r.width, e.width, tolerance) && near(r.height, e.height, tolerance)
const show = (r: Rect | null | undefined) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'null')

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

type Rgb = [number, number, number]

/** The colour of the pixel at (x, y) of a picture, `x` and `y` in pixels of page (a Retina picture has 2 pixels for each), as red, green and blue. */
function rgbAt(image: NativeImage, cssWidth: number, x: number, y: number): Rgb {
  const { width } = image.getSize()
  const scale = width / cssWidth
  const bitmap = image.toBitmap()
  const at = (Math.round(y * scale) * width + Math.round(x * scale)) * 4
  return [bitmap[at + 2]!, bitmap[at + 1]!, bitmap[at]!]
}

/** The same, as `#rrggbb`. */
function pixelAt(image: NativeImage, cssWidth: number, x: number, y: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  const [r, g, b] = rgbAt(image, cssWidth, x, y)
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** Red, green, blue (0 to 255) and alpha (0 to 1) of a computed CSS colour (`rgb()`, `rgba()` or `color(srgb …)`), or null when it is none of them. */
function parseCssColor(text: string): [number, number, number, number] | null {
  const alphaOf = (raw: string | undefined) => (raw === undefined ? 1 : raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number(raw))
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alphaOf(rgb[4])]
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, alphaOf(srgb[4])]
  return null
}
const apart = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

export async function smokeNavigation(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>

  // ---- a server with pages that link to each other ----
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/a') {
      return void res.end(`<title>A</title><body style="margin:0">
        <a id="blank" href="/b?k=blank" target="_blank" style="display:block;margin:10px;height:30px">blank</a>
        <a id="noopener" href="/b?k=noopener" target="_blank" rel="noopener" style="display:block;margin:10px;height:30px">noopener</a>
        <a id="plain" href="/b?k=plain" style="display:block;margin:10px;height:30px">plain</a>
        <button id="open" style="margin:10px;height:30px" onclick="window.open('/b?k=open')">open</button></body>`)
    }
    if (url.pathname === '/b') return void res.end(`<title>B ${url.searchParams.get('k')}</title><body style="margin:0"><a id="inner" href="/c" style="display:block;margin:10px;height:30px">inner</a></body>`)
    if (url.pathname === '/colored') return void res.end('<title>colored</title><meta name="theme-color" content="#ffffff"><body style="margin:0;background:#ffffff">colored</body>')
    res.end(`<title>page ${url.pathname}</title><body style="margin:0;background:#ffffff">${url.pathname}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- a space of its own ----
  const previousSpace = state().activeSpaceId
  const original = { ...state().settings }
  win.setSize(1280, 800)
  win.showInactive()
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, showToolbar: true, hoverCards: true, sleepAfterMinutes: 0, backClosesOpenedTab: true, tabCycleRecent: true, dragToSplit: true, keyBindings: {}, interfaceAppearance: 'dark' } })
  browser.dispatch({ type: 'space/create', name: 'Navigation test', emoji: '🧭', hue: 220 })
  const spaceId = state().activeSpaceId
  const tabsHere = () => state().tabs.filter((t) => t.spaceId === spaceId)
  const runtimeOf = (id: string) => browser.snapshot().runtime.tabs[id]
  const activeId = () => state().activeTabBySpace[spaceId] ?? null
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const loaded = (id: string) => waitFor(() => runtimeOf(id)?.loading === false && wcOf(id)?.getURL().startsWith('http') === true)
  const openTab = async (path: string): Promise<string> => {
    const before = tabsHere().length
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    await waitFor(() => tabsHere().length === before + 1)
    const id = tabsHere().at(-1)!.id
    await loaded(id)
    await sleep(120)
    return id
  }
  const rectIn = (wc: WebContents, selector: string) => evaluate<{ x: number; y: number } | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const clickIn = async (wc: WebContents, selector: string, modifiers: Array<'meta'> = []) => {
    const at = await rectIn(wc, selector)
    if (!at) throw new Error(`no ${selector} to click`)
    wc.focus()
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
      wc.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1, modifiers } as Electron.MouseInputEvent)
      await sleep(25)
    }
  }
  /** Waits for a tab opened by a click, and for its page when it is on screen. */
  const newTabSince = async (before: Set<string>, show = true): Promise<string | null> => {
    const found = await waitFor(() => tabsHere().some((t) => !before.has(t.id)))
    const tab = tabsHere().find((t) => !before.has(t.id))
    if (!found || !tab) return null
    if (show) await loaded(tab.id)
    return tab.id
  }
  const idsNow = () => new Set(tabsHere().map((t) => t.id))
  const backItem = () => findMenuItem('Page précédente')
  const backButtonDisabled = () => evaluate<boolean | null>(chrome, `(() => { const b = document.querySelector('.page-toolbar [aria-label="Précédent"]'); return b ? b.disabled : null })()`)
  const toast = () => browser.snapshot().toast?.message ?? ''
  const archived = () => state().archive.map((a) => a.url)
  const originOf = (id: string) => state().tabs.find((t) => t.id === id)?.openerId

  const key = (wc: WebContents, type: 'keyDown' | 'keyUp', keyCode: string, modifiers: string[] = []) => {
    wc.sendInputEvent({ type, keyCode, modifiers } as Electron.KeyboardInputEvent)
  }
  const panel = () => browser.currentCycle()
  /** Where a key goes: to the panel once it is up (it has the keyboard), else to the page on screen. */
  const keyTarget = () => (browser.currentPanel() === 'tabcycle' ? ui : wcOf(activeId()!)!)
  const holdControl = () => key(keyTarget(), 'keyDown', 'Control', ['control'])
  const pressTab = (shift = false) => key(keyTarget(), 'keyDown', 'Tab', shift ? ['control', 'shift'] : ['control'])
  const releaseTab = (shift = false) => key(keyTarget(), 'keyUp', 'Tab', shift ? ['control', 'shift'] : ['control'])
  const releaseControl = () => key(keyTarget(), 'keyUp', 'Control', [])
  /**
   * Sends keys and waits for the key `name` going down to reach a listener of `target` added after the shell's own: the shell decides what a
   * key does as it hears it, so once that listener has it the decision is made. Only a key going down can be the witness: Chromium tells the
   * shell of no key that goes up after one the shell took.
   */
  const keyDecided = async (target: WebContents, name: string, send: () => void): Promise<boolean> => {
    let seen = false
    const listener = (_event: Electron.Event, input: Electron.Input): void => {
      if (input.type === 'keyDown' && input.key === name) seen = true
    }
    target.on('before-input-event', listener)
    try {
      send()
      return await waitFor(() => seen)
    } finally {
      target.off('before-input-event', listener)
    }
  }
  // LUCIUM_NAV_ONLY=back,cycle,drag,toolbar (comma list) runs only those parts while a part is being worked on; all of them by default.
  const only = (process.env['LUCIUM_NAV_ONLY'] ?? '').split(',').filter(Boolean)
  const want = (part: string) => only.length === 0 || only.includes(part)
  // What the overlay did while the checks ran: reloads, crashes, console output and the panels it was asked for (read by the diagnostics).
  const uiEvents: string[] = []
  const note = (what: string) => uiEvents.push(`${Math.round(process.uptime())}s ${what}`)
  ui.on('did-finish-load', () => note('overlay loaded'))
  ui.on('render-process-gone', (_e, details) => note(`overlay process gone: ${details.reason}`))
  ui.on('console-message', ((...args: unknown[]) => {
    const first = args[0] as { message?: unknown; level?: unknown } | undefined
    note(`console ${String(first?.level ?? args[1])}: ${String(first?.message ?? args[2]).slice(0, 200)}`)
  }) as never)
  // The layer is told `null` when its panel closes: the spy writes it as "closed" (reading its panel threw in the layer at every closing).
  const spyOnOverlay = () => evaluate<number>(ui, `(() => { if (!window.__shows) { window.__shows = []; window.lucium.onShowOverlay((r) => window.__shows.push(r ? r.panel : 'closed')) } return window.__shows.length })()`)
  const overlayShows = () => evaluate<string>(ui, `window.__shows ? window.__shows.join(',') : 'no spy (page reloaded)'`)
  let privateRecord: ReturnType<ReturnType<typeof getWindowManager>['openPrivate']> | null = null
  try {
    if (want('back')) {
      // ========================================================================
      // Back on the first page of a tab opened from a link
      // ========================================================================
      const a = await openTab('/a')
      browser.dispatch({ type: 'tab/rename', id: a, title: 'Origine' })
      const wcA = wcOf(a)!
      const sidebarTabs = () => evaluate<string[]>(chrome, `[...document.querySelectorAll('.tab .tab-title')].map((e) => e.textContent)`)

      // 1. target=_blank: a real click, in the foreground
      let before = idsNow()
      await clickIn(wcA, '#blank')
      const b1 = await newTabSince(before)
      check('back-closes: a click on a target=_blank link opens a tab, on screen, that remembers its origin', !!b1 && activeId() === b1 && originOf(b1!) === a, JSON.stringify({ b1, active: activeId(), origin: b1 ? originOf(b1) : null }))
      check('back-closes: the new tab is at the end of Today, not next to its origin (Arc)', tabsHere().at(-1)?.id === b1)
      await waitFor(async () => (await backButtonDisabled()) === false)
      check('back-closes: the Back button is enabled on its first page, and so is the entry of the Archive menu (⌘[)', (await backButtonDisabled()) === false && backItem()?.enabled === true && backItem()?.accelerator === 'CmdOrCtrl+[', JSON.stringify({ button: await backButtonDisabled(), menu: backItem()?.enabled, accelerator: backItem()?.accelerator }))
      check('back-closes: the runtime says Back would close the tab', browser.snapshot().runtime.backCloses === true && runtimeOf(b1!)?.backCloses === true)
      const bounds = await rectIn(chrome, '.page-toolbar [aria-label="Précédent"]')
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
        chrome.sendInputEvent({ type, x: Math.round(bounds!.x), y: Math.round(bounds!.y), button: 'left', clickCount: 1 })
        await sleep(30)
      }
      const closed1 = await waitFor(() => !tabsHere().some((t) => t.id === b1))
      check('back-closes: a real click on Back closes the tab and shows the origin again', closed1 && activeId() === a, JSON.stringify({ closed1, active: activeId() }))
      check('back-closes: the closed tab is archived, with the notice that brings it back', archived().some((u) => u.includes('k=blank')) && toast() === 'Onglet archivé', `${toast()} ${JSON.stringify(archived().slice(0, 2))}`)
      check('back-closes: the sidebar lists only the origin again', (await sidebarTabs()).join('|') === 'Origine', (await sidebarTabs()).join('|'))

      // 2. rel=noopener: the page cannot reach its opener (window.opener is null) and still goes back
      before = idsNow()
      await clickIn(wcA, '#noopener')
      const b2 = await newTabSince(before)
      check('back-closes: rel=noopener does not stop the origin from being remembered', !!b2 && originOf(b2!) === a)
      backItem()?.click()
      check('back-closes: the menu entry of ⌘[ closes it and returns to the origin', await waitFor(() => !tabsHere().some((t) => t.id === b2) && activeId() === a))

      // 3. ⌘-click: opened in the background, Back works once the tab is shown
      before = idsNow()
      await clickIn(wcA, '#plain', ['meta'])
      const b3 = await newTabSince(before, false)
      check('back-closes: a ⌘-click opens a tab in the background (the origin stays on screen) that remembers its origin', !!b3 && activeId() === a && originOf(b3!) === a, JSON.stringify({ b3, active: activeId() }))
      browser.dispatch({ type: 'tab/select', id: b3! })
      await loaded(b3!)
      await waitFor(() => backItem()?.enabled === true)
      backItem()?.click()
      check('back-closes: shown, the background tab closes with Back and the origin is back (even if it is not its neighbour)', await waitFor(() => !tabsHere().some((t) => t.id === b3) && activeId() === a))

      // 4. window.open from a click on a button
      before = idsNow()
      await clickIn(wcA, '#open')
      const b4 = await newTabSince(before, false)
      check('back-closes: window.open (from a click) opens a tab that remembers its origin', !!b4 && originOf(b4!) === a, JSON.stringify({ b4, origin: b4 ? originOf(b4) : null }))
      browser.dispatch({ type: 'tab/select', id: b4! })
      await loaded(b4!)
      browser.nav('back')
      check('back-closes: and Back (the toolbar button\'s route) returns to the origin', await waitFor(() => !tabsHere().some((t) => t.id === b4) && activeId() === a))

      // 5. a tab that was navigated is an ordinary tab: Back goes back in it, and never closes it (also back on its first page)
      before = idsNow()
      await clickIn(wcA, '#blank')
      const b5 = await newTabSince(before)
      await clickIn(wcOf(b5!)!, '#inner')
      const navigated = await waitFor(() => state().tabs.find((t) => t.id === b5)?.url.endsWith('/c') === true && runtimeOf(b5!)?.canGoBack === true)
      check('back-closes: a tab that was navigated forgets its origin', navigated && originOf(b5!) === undefined, JSON.stringify({ navigated, origin: originOf(b5!) }))
      backItem()?.click()
      const wentBack = await waitFor(() => state().tabs.find((t) => t.id === b5)?.url.includes('/b?k=blank') === true && runtimeOf(b5!)?.canGoBack === false)
      check('back-closes: Back then goes back in the page, the tab stays', wentBack && tabsHere().some((t) => t.id === b5) && activeId() === b5)
      await waitFor(() => backItem()?.enabled === false)
      browser.nav('back')
      // No wait for the tab: nav decides before it returns (browser-commands.ts), and a tab it closes is out of the state by then. Only the
      // button of the toolbar, which the interface draws from what it is sent, is waited for.
      await waitFor(async () => (await backButtonDisabled()) === true)
      check('back-closes: back on its first page the tab does not close any more, and Back is greyed out like on any tab', tabsHere().some((t) => t.id === b5) && activeId() === b5 && backItem()?.enabled === false && (await backButtonDisabled()) === true, JSON.stringify({ menu: backItem()?.enabled, button: await backButtonDisabled() }))
      browser.dispatch({ type: 'tab/close', id: b5! })

      // 6. the page's own history is still asked: a tab with an origin and something behind it goes back, whatever the memory says
      browser.dispatch({ type: 'tab/select', id: a })
      before = idsNow()
      await clickIn(wcA, '#blank')
      const b6 = await newTabSince(before)
      const realDispatch = store.dispatch.bind(store)
      store.dispatch = ((action: Parameters<typeof realDispatch>[0]) => (action.type === 'tab/forget-origin' ? undefined : realDispatch(action))) as typeof store.dispatch
      try {
        await clickIn(wcOf(b6!)!, '#inner')
        await waitFor(() => runtimeOf(b6!)?.canGoBack === true)
        check('back-closes: the origin is still remembered here (the forgetting is held back for this check)', originOf(b6!) === a)
        browser.nav('back')
        const went = await waitFor(() => state().tabs.find((t) => t.id === b6)?.url.includes('/b?k=blank') === true)
        check('back-closes: with a page behind it a tab goes back and does not close, whatever it remembers', went && tabsHere().some((t) => t.id === b6) && activeId() === b6)
      } finally {
        store.dispatch = realDispatch
      }
      browser.dispatch({ type: 'tab/close', id: b6! })

      // 7. a tab that was not opened from a link has no origin: Back does nothing, and nothing closes
      const plain = await openTab('/plain')
      const archiveBefore = state().archive.length
      await sleep(200)
      browser.nav('back')
      // No wait for the tab: nav decides before it returns, and a tab it closes is out of the state (and in the archive) by then. Only the
      // button of the toolbar is waited for.
      await waitFor(async () => (await backButtonDisabled()) === true)
      check('back-closes: a tab opened by hand has no origin: Back is greyed out, does nothing and closes nothing', originOf(plain) === undefined && (await backButtonDisabled()) === true && backItem()?.enabled === false && tabsHere().some((t) => t.id === plain) && state().archive.length === archiveBefore)
      browser.dispatch({ type: 'tab/close', id: plain })

      // 8. the origin goes (closed): the tab is an ordinary one
      browser.dispatch({ type: 'tab/select', id: a })
      before = idsNow()
      await clickIn(wcA, '#blank')
      const b8 = await newTabSince(before)
      browser.dispatch({ type: 'tab/close', id: a })
      check('back-closes: when the origin is closed the tab forgets it; Back closes nothing', originOf(b8!) === undefined && (browser.nav('back'), true))
      // No wait: nav decides before it returns, and a tab it closes is out of the state by then.
      check('back-closes: … and the tab is still there', tabsHere().some((t) => t.id === b8))
      browser.dispatch({ type: 'tab/close', id: b8! })

      // 9. the setting off: nothing is remembered, and what was remembered is forgotten
      const a2 = await openTab('/a')
      const wcA2 = wcOf(a2)!
      before = idsNow()
      await clickIn(wcA2, '#blank')
      const b9 = await newTabSince(before)
      check('back-closes: (again) a link opens a tab that remembers its origin', originOf(b9!) === a2)
      browser.dispatch({ type: 'settings/update', patch: { backClosesOpenedTab: false } })
      await waitFor(() => originOf(b9!) === undefined)
      check('back-closes: switching the setting off makes every tab forget its origin', originOf(b9!) === undefined)
      browser.nav('back')
      // No wait for the tab: nav decides before it returns. Only the menu entry, rebuilt from the state, is waited for.
      await waitFor(() => backItem()?.enabled === false)
      check('back-closes: … so Back no longer closes it', tabsHere().some((t) => t.id === b9) && backItem()?.enabled === false)
      browser.dispatch({ type: 'tab/select', id: a2 })
      before = idsNow()
      await clickIn(wcA2, '#noopener')
      const b9b = await newTabSince(before)
      check('back-closes: with the setting off a new tab from a link remembers nothing', !!b9b && originOf(b9b!) === undefined)
      browser.dispatch({ type: 'settings/update', patch: { backClosesOpenedTab: true } })
      for (const id of [b9, b9b]) browser.dispatch({ type: 'tab/close', id: id! })

    }
    if (want('cycle')) {
      // ========================================================================
      // ⌃Tab in the order of use
      // ========================================================================
      for (const t of tabsHere()) browser.dispatch({ type: 'tab/close', id: t.id })
      const t1 = await openTab('/t1')
      await sleep(8)
      browser.dispatch({ type: 'tab/open', url: `${base}/t2`, background: true })
      await sleep(8)
      browser.dispatch({ type: 'tab/open', url: `${base}/t3`, background: true })
      await waitFor(() => tabsHere().length === 3)
      const [, t2, t3] = tabsHere().map((t) => t.id) as [string, string, string]
      for (const [id, name] of [[t1, 'Un'], [t2, 'Deux'], [t3, 'Trois']] as const) browser.dispatch({ type: 'tab/rename', id, title: name })
      // A shown page is shot once, SHOT_DELAYS_MS after it came on screen (shell/thumbnails.ts): the picture of Un is waited for, not guessed with a fixed time.
      const pictureOfT1 = await waitFor(async () => !!(await evaluate<string | null>(chrome, `window.lucium.tabThumbnail(${JSON.stringify(t1)})`)), Math.max(...SHOT_DELAYS_MS) + 8000)
      const wcT1 = wcOf(t1)!
      wcT1.focus()
      await spyOnOverlay()

      check('tab-cycle: the setting is on by default and the window listens to the keys of its pages and of its interface', browser.isWatchingTabKeys() && wcT1.listenerCount('before-input-event') >= 1 && chrome.listenerCount('before-input-event') >= 1)
      // The panel appears at the first Tab and stays while ⌃ is held.
      holdControl()
      pressTab()
      const opened = await waitFor(() => browser.currentPanel() === 'tabcycle', 1500)
      check('tab-cycle: the panel has the keyboard while it is up (the page is not told of the release of ⌃)', opened && ui.isFocused(), String(ui.isFocused()))
      check('tab-cycle: ⌃Tab in a page opens the panel at once, selection on the tab used just before (the pages did not change)', opened && panel()?.index === 1 && panel()?.ids.join() === [t1, t3, t2].join() && activeId() === t1, JSON.stringify({ panel: panel(), active: activeId() }))
      releaseTab()
      // A fixed wait, for want of a witness: the release goes to the panel, which takes it and sends nothing back.
      await sleep(120)
      check('tab-cycle: the panel stays after Tab is released, as long as ⌃ is held', browser.currentPanel() === 'tabcycle' && activeId() === t1)
      // Geometry of the panel: 632 x 265 for three tabs, centred in the window, cards of 200 x 176, the selected one on the accent.
      await sleep(150)
      const tcDiag = await evaluate<string>(ui, `document.visibilityState + ' focus=' + document.hasFocus() + ' | ' + (document.getElementById('root')?.innerHTML ?? 'no root').slice(0, 120)`)
      check('tab-cycle: (diagnostic) what the overlay shows while the panel is up', tcDiag.includes('tc-panel'), tcDiag)
      const win1 = win.getContentBounds()
      const layer = overlayView.getBounds()
      const box = await evaluate<Rect | null>(ui, `(() => { const el = document.querySelector('.tc-panel'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      const absolute = box ? { x: layer.x + box.x, y: layer.y + box.y, width: box.width, height: box.height } : null
      const expectedWidth = cyclePanelWidth(3, win1.width)
      check('tab-cycle: the panel is 632 x 265 for three tabs, centred in the window', expectedWidth === 632 && sameRect(absolute, { x: (win1.width - 632) / 2, y: (win1.height - CYCLE_PANEL.height) / 2, width: 632, height: CYCLE_PANEL.height }, 1.5), `${show(absolute)} window ${win1.width}x${win1.height}`)
      const cards = await evaluate<Array<Rect & { selected: boolean; title: string; hasImage: boolean }>>(ui, `[...document.querySelectorAll('.tc-card')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, selected: el.classList.contains('selected'), title: el.querySelector('.tc-title')?.textContent ?? '', hasImage: !!el.querySelector('img.tc-img') } })`)
      check('tab-cycle: one card of 200 x 176 per tab, in the order of use: Un (on screen), Trois, Deux; the second is selected', cards.length === 3 && cards.map((c) => c.title).join() === 'Un,Trois,Deux' && cards.every((c) => near(c.width, CYCLE_PANEL.card.width, 0.6) && near(c.height, CYCLE_PANEL.card.height, 0.6)) && cards.map((c) => c.selected).join() === 'false,true,false', JSON.stringify(cards))
      check('tab-cycle: Un was on screen long enough to have a picture; Trois and Deux were never shown: no picture (the crossed eye)', cards[0]?.hasImage === true && cards[1]?.hasImage === false && cards[2]?.hasImage === false, JSON.stringify({ pictureOfT1, hasImage: cards.map((c) => c.hasImage) }))
      const shot = await ui.capturePage()
      const scale = shot.getSize().width / layer.width
      const selectedCard = cards[1] ?? { x: 0, y: 0, width: 0, height: 0 }
      // The panel is drawn in the tokens (tab-cycle.css): its ground is the overlay's, the selected card the accent's soft tint (--accent-soft), the other cards no
      // ground. What is checked is what the page computed for each, read back from the pixels of the screen (premultiplied by the panel's own alpha), not a figure
      // that a theme or a hue of the space would change. The cards are read at the middle of their foot, clear of the rounded corner and its border.
      const grounds = await evaluate<{ panel: string; selected: string; plain: string }>(ui, `(() => { const css = (el) => getComputedStyle(el).backgroundColor; return { panel: css(document.querySelector('.tc-panel')), selected: css(document.querySelector('.tc-card.selected')), plain: css(document.querySelector('.tc-card:not(.selected)')) } })()`)
      const panelColor = parseCssColor(grounds.panel)
      const selectedColor = parseCssColor(grounds.selected)
      const plainColor = parseCssColor(grounds.plain)
      const centreX = (card: Rect | undefined) => (card?.x ?? 0) + (card?.width ?? 0) / 2
      const bottomY = (card: Rect | undefined) => (card?.y ?? 0) + (card?.height ?? 0) - 4
      const onPanel = rgbAt(shot, layer.width, (box?.x ?? 0) + 6, (box?.y ?? 0) + 40)
      const onSelected = rgbAt(shot, layer.width, centreX(selectedCard), bottomY(selectedCard))
      const onPlain = rgbAt(shot, layer.width, centreX(cards[0]), bottomY(cards[0]))
      const premultiplied = (c: [number, number, number, number], under: Rgb): Rgb => [c[0] * c[3] + under[0] * (1 - c[3]), c[1] * c[3] + under[1] * (1 - c[3]), c[2] * c[3] + under[2] * (1 - c[3])]
      const panelRead = panelColor !== null && panelColor[3] > 0.85
      const selectedRead = selectedColor !== null && selectedColor[3] > 0
      check(
        'tab-cycle: the selected card has the accent\'s tint, the others have no ground (they show the panel), the panel has the overlay\'s (computed styles read back from the pixels, screen scale ' + scale + ')',
        panelRead &&
          selectedRead &&
          plainColor !== null &&
          plainColor[3] === 0 &&
          // the panel: the colour of the overlay token, whole or taken to its alpha
          Math.min(apart(onPanel, premultiplied(panelColor!, [0, 0, 0])), apart(onPanel, [panelColor![0], panelColor![1], panelColor![2]])) <= 8 &&
          // the selected card: its tint over the panel, and not the panel's ground
          Math.min(apart(onSelected, premultiplied(selectedColor!, onPanel)), apart(onSelected, [selectedColor![0], selectedColor![1], selectedColor![2]])) <= 8 &&
          apart(onSelected, onPanel) > 12 &&
          // a card with no ground shows the panel's, pixel for pixel
          apart(onPlain, onPanel) === 0,
        JSON.stringify({ grounds, onPanel, onSelected, onPlain })
      )
      const motion = await evaluate<{ transition: string; animation: string }>(ui, `(() => { const s = getComputedStyle(document.querySelector('.tc-panel')); return { transition: s.transitionDuration, animation: s.animationName } })()`)
      check('tab-cycle: the panel appears and goes in one frame: no fade, no zoom', motion.transition === '0s' && motion.animation === 'none', JSON.stringify(motion))
      // Another Tab: the next entry; ⇧Tab: back.
      pressTab()
      releaseTab()
      await waitFor(() => panel()?.index === 2)
      pressTab(true)
      releaseTab(true)
      await waitFor(() => panel()?.index === 1)
      pressTab(true)
      releaseTab(true)
      await waitFor(() => panel()?.index === 0)
      pressTab(true)
      releaseTab(true)
      await waitFor(() => panel()?.index === 2)
      check('tab-cycle: Tab moves the selection forward and ⇧Tab back, wrapping around', panel()?.index === 2)
      const selectedNow = await waitFor(async () => (await evaluate<string>(ui, `document.querySelector('.tc-card.selected .tc-title')?.textContent ?? ''`)) === 'Deux')
      check('tab-cycle: the panel follows (the third card is selected)', selectedNow)
      // Nothing changes until ⌃ is released; then the selected tab is shown.
      check('tab-cycle: the tab on screen did not change while ⌃ was held', activeId() === t1)
      releaseControl()
      const switched = await waitFor(() => activeId() === t2 && browser.currentPanel() === null)
      check('tab-cycle: releasing ⌃ shows the selected tab and puts the panel away', switched, JSON.stringify({ active: activeId(), panel: browser.currentPanel() }))
      // Four quick taps: 3 → 1 → 3 → 1 (an order of use, not the order of the sidebar).
      const quickTap = async (shift = false) => {
        holdControl()
        pressTab(shift)
        // A finger takes longer than this to leave the keys; the panel's listener is already there, but its message is a separate path.
        await sleep(40)
        releaseTab(shift)
        releaseControl()
        await waitFor(() => browser.currentPanel() === null)
        await sleep(12)
      }
      // The order of use is Un, Trois, Deux: Deux is visited first, then Trois, then Un (a pause between them, the order is by time).
      for (const id of [t2, t3, t1]) {
        browser.dispatch({ type: 'tab/select', id })
        await sleep(40)
      }
      const landed: Array<string | null> = []
      for (let i = 0; i < 4; i++) {
        await quickTap()
        landed.push(activeId())
        await sleep(30)
      }
      check('tab-cycle: four quick taps go 3 → 1 → 3 → 1 (the order of use: the second tab is never reached)', landed.join() === [t3, t1, t3, t1].join(), JSON.stringify(landed.map((id) => ['Un', 'Deux', 'Trois'][[t1, t2, t3].indexOf(id!)])))
      // ⇧⌃Tab opens on the last entry.
      holdControl()
      pressTab(true)
      await waitFor(() => browser.currentPanel() === 'tabcycle')
      const lastIndex = panel()?.index
      const order = panel()?.ids
      check('tab-cycle: ⇧⌃Tab opens the panel on the last entry of the list', lastIndex === (order?.length ?? 0) - 1 && order?.length === 3, JSON.stringify(panel()))
      // Escape leaves the tab on screen.
      const beforeEscape = activeId()
      key(keyTarget(), 'keyDown', 'Escape', ['control'])
      await waitFor(() => browser.currentPanel() === null)
      releaseTab(true)
      releaseControl()
      // A fixed wait, for want of a witness: Chromium tells the shell of no key that goes up after one the shell took (the Tab that opened the panel).
      await sleep(100)
      check('tab-cycle: Escape puts the panel away and leaves the tab on screen', browser.currentPanel() === null && activeId() === beforeEscape, JSON.stringify({ panel: browser.currentPanel(), active: activeId(), beforeEscape, events: uiEvents.slice(-4) }))
      // The layer is told which panel it shows by a message, and gets its keys by another route: a key can come first (a busy machine, a quick
      // hand). The request of the panel is held back here on purpose, Escape is typed meanwhile, and it must still put the panel away.
      const realSend = ui.send.bind(ui)
      const held: { request: (() => void) | null } = { request: null }
      ui.send = ((channel: string, ...args: unknown[]) => {
        if (channel === Channel.showOverlay && (args[0] as { panel?: string } | null)?.panel === 'tabcycle' && held.request === null) {
          held.request = () => realSend(channel, ...args)
          return
        }
        realSend(channel, ...args)
      }) as typeof ui.send
      let lateCancel = false
      let escapeFirst = false
      const beforeLate = activeId()
      try {
        // A witness in the layer, behind its own listener: the request is let through only once Escape has reached the layer.
        await evaluate(ui, `window.__lateEscape = false; window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__lateEscape = true }, true); true`)
        holdControl()
        pressTab()
        await waitFor(() => browser.currentPanel() === 'tabcycle' && held.request !== null)
        key(ui, 'keyDown', 'Escape', ['control'])
        escapeFirst = await waitFor(() => evaluate<boolean>(ui, 'window.__lateEscape === true'), 3000)
        held.request?.()
        // The panel goes by Escape alone: ⌃ and Tab are still down, and nothing else would end it.
        lateCancel = await waitFor(() => browser.currentPanel() === null, 3000)
      } finally {
        ui.send = realSend
      }
      releaseTab()
      releaseControl()
      await waitFor(() => browser.currentPanel() === null)
      check('tab-cycle: Escape typed before the layer is told that its panel is the one of ⌃Tab is not lost: the panel goes, the tab stays', escapeFirst && lateCancel && activeId() === beforeLate, JSON.stringify({ escapeFirst, lateCancel, held: held.request !== null, panel: browser.currentPanel(), active: activeId(), beforeLate }))
      // One tab: nothing to go to.
      // A split view is one entry, and ⌃Tab comes back to the pair.
      browser.dispatch({ type: 'tab/select', id: t1 })
      await sleep(30)
      browser.dispatch({ type: 'split/create', tabId: t2, withTabId: t3 })
      await sleep(60)
      browser.dispatch({ type: 'tab/select', id: t1 })
      await sleep(60)
      holdControl()
      pressTab()
      await waitFor(() => browser.currentPanel() === 'tabcycle')
      await sleep(250)
      const pairShows = await overlayShows()
      const pairCards = await evaluate<Array<{ members: number }>>(ui, `[...document.querySelectorAll('.tc-card')].map((el) => ({ members: el.querySelectorAll('.tc-ttl').length || 1 }))`)
      check('tab-cycle: the two panes of a split view are one entry, with two pastilles under its picture', pairCards.length === 2 && pairCards.map((c) => c.members).join() === '1,2', JSON.stringify({ pairCards, panel: browser.currentPanel(), shows: pairShows, events: uiEvents.slice(-6) }))
      releaseTab()
      releaseControl()
      await waitFor(() => browser.currentPanel() === null)
      check('tab-cycle: ⌃Tab from a tab goes to the pair (both panes shown)', [t2, t3].includes(activeId()!) && browser.visibleTabIds().length === 2, JSON.stringify({ active: activeId(), visible: browser.visibleTabIds() }))
      await quickTap()
      check('tab-cycle: and the next ⌃Tab comes back to the other tab', activeId() === t1)
      browser.dispatch({ type: 'split/remove', tabId: t2 })
      // Remapped: Alt+Tab instead; the panel lasts as long as Alt is held, and ⌃Tab is left alone.
      browser.dispatch({ type: 'settings/update', patch: { keyBindings: { recentTab: 'Alt+Tab' } } })
      await sleep(100)
      const remapped = await keyDecided(keyTarget(), 'Tab', () => {
        holdControl()
        pressTab()
      })
      check('tab-cycle: with the shortcut moved to ⌥Tab, ⌃Tab does nothing', remapped && browser.currentPanel() === null, JSON.stringify({ heard: remapped, panel: browser.currentPanel() }))
      releaseTab()
      releaseControl()
      key(keyTarget(), 'keyDown', 'Alt', ['alt'])
      key(keyTarget(), 'keyDown', 'Tab', ['alt'])
      const altOpened = await waitFor(() => browser.currentPanel() === 'tabcycle')
      key(keyTarget(), 'keyUp', 'Tab', ['alt'])
      await sleep(80)
      const stillOpen = browser.currentPanel() === 'tabcycle'
      key(keyTarget(), 'keyUp', 'Alt', [])
      check('tab-cycle: ⌥Tab opens the panel, which lasts while ⌥ is held and ends when it goes up', altOpened && stillOpen && (await waitFor(() => browser.currentPanel() === null)))
      browser.dispatch({ type: 'settings/update', patch: { keyBindings: {} } })
      await sleep(100)
      // From the interface: the sidebar has the focus.
      chrome.focus()
      key(chrome, 'keyDown', 'Control', ['control'])
      key(chrome, 'keyDown', 'Tab', ['control'])
      const fromInterface = await waitFor(() => browser.currentPanel() === 'tabcycle')
      key(keyTarget(), 'keyUp', 'Tab', ['control'])
      key(keyTarget(), 'keyUp', 'Control', [])
      const fromInterfaceEnded = await waitFor(() => browser.currentPanel() === null)
      check('tab-cycle: ⌃Tab works with the focus in the interface too', fromInterface && fromInterfaceEnded, JSON.stringify({ fromInterface, fromInterfaceEnded, panel: browser.currentPanel(), events: uiEvents.slice(-4) }))
      // The layer reports its keys to the shell (and keeps them from the page) for the panel of ⌃Tab only. Once that panel is gone, a key typed in the
      // next panel the layer shows is that panel's: heard in the layer after its own listener, it must not have been taken.
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      await waitFor(async () => browser.currentPanel() === 'commandbar' && String(await ui.executeJavaScript(`document.activeElement === document.querySelector('.palette-input') ? 'yes' : ''`)) === 'yes')
      // The listener is in place before the key is sent: it is added after the layer's own (which listens in the capture phase), so it reads what that one did.
      await ui.executeJavaScript(`window.__keyTaken = undefined; window.addEventListener('keydown', (event) => { window.__keyTaken = event.defaultPrevented }, { once: true }); true`)
      key(ui, 'keyDown', 'a')
      key(ui, 'keyUp', 'a')
      await waitFor(async () => (await ui.executeJavaScript('window.__keyTaken')) !== undefined, 3000)
      const takenAfterCycle: unknown = await ui.executeJavaScript('window.__keyTaken')
      check('tab-cycle: once its panel is gone, the layer no longer takes the keys of the panel shown next (the command bar)', takenAfterCycle === false, String(takenAfterCycle))
      browser.closeOverlay()
      await waitFor(() => browser.currentPanel() === null)
      // The setting off: no listener anywhere, no record of the tabs left, and ⌃Tab is the page's again.
      const listenersOn = wcOf(activeId()!)!.listenerCount('before-input-event')
      const chromeOn = chrome.listenerCount('before-input-event')
      browser.dispatch({ type: 'settings/update', patch: { tabCycleRecent: false } })
      await waitFor(() => !browser.isWatchingTabKeys())
      const listenersOff = wcOf(activeId()!)!.listenerCount('before-input-event')
      check('tab-cycle: with the setting off no key is listened to: neither in the pages nor in the interface', !browser.isWatchingTabKeys() && listenersOff === listenersOn - 1 && chrome.listenerCount('before-input-event') === chromeOn - 1, JSON.stringify({ listenersOn, listenersOff, chromeOn, chromeOff: chrome.listenerCount('before-input-event') }))
      const offHeard = await keyDecided(keyTarget(), 'Tab', () => {
        holdControl()
        pressTab()
      })
      check('tab-cycle: … and ⌃Tab does nothing', offHeard && browser.currentPanel() === null, JSON.stringify({ heard: offHeard, panel: browser.currentPanel() }))
      releaseTab()
      releaseControl()
      browser.dispatch({ type: 'settings/update', patch: { tabCycleRecent: true } })
      check('tab-cycle: switched on again it listens again (pages that already exist included)', await waitFor(() => browser.isWatchingTabKeys() && wcOf(activeId()!)!.listenerCount('before-input-event') === listenersOn))
      // The panel is put away when the window loses the focus with ⌃ down.
      holdControl()
      pressTab()
      await waitFor(() => browser.currentPanel() === 'tabcycle')
      win.emit('blur')
      check('tab-cycle: a window that loses the focus with ⌃ down ends the panel without changing tab', (await waitFor(() => browser.currentPanel() === null)) && browser.currentCycle() === null)
      releaseTab()
      releaseControl()
      await sleep(80)
      // A panel that cannot draw leaves the layer blank until the next request, and says so: it must not take the layer down for good.
      browser.openOverlay({ panel: 'tabcycle', cards: [{ id: 'broken', members: [] }], index: 0 })
      const reported = await waitFor(() => uiEvents.some((e) => e.includes('[overlay] the tabcycle panel failed to draw')), 4000)
      const blank = await evaluate<boolean>(ui, `!document.querySelector('.tc-panel')`)
      // The layer closes itself: left empty over the window it would have no way out, and a question it carried would never be answered.
      const closedItself = await waitFor(() => browser.currentPanel() === null, 3000)
      check('overlay: a panel that fails to draw closes the layer by itself', closedItself, JSON.stringify({ panel: browser.currentPanel(), events: uiEvents.slice(-4) }))
      browser.closeOverlay()
      holdControl()
      pressTab()
      const drawnAgain = await waitFor(() => browser.currentPanel() === 'tabcycle', 3000)
      await sleep(250)
      const cardsAgain = await evaluate<number>(ui, `document.querySelectorAll('.tc-card').length`)
      check('overlay: a panel that fails to draw is logged with its name and leaves the layer blank, and the next panel draws', reported && blank && drawnAgain && cardsAgain >= 2, JSON.stringify({ reported, blank, cardsAgain, events: uiEvents.slice(-4) }))
      releaseTab()
      releaseControl()
      await waitFor(() => browser.currentPanel() === null)
      // A panel that closes is unmounted by the layer, which is out of the window by then: nothing of it stays in the layer's document, so the
      // next panel is never drawn, even for one frame, over what the closed one showed.
      browser.openOverlay({ panel: 'history' })
      const historyDrawn = await waitFor(() => evaluate<boolean>(ui, `document.querySelector('[role="dialog"]') !== null`), 4000)
      browser.closeOverlay()
      const historyGone = await waitFor(() => evaluate<boolean>(ui, `document.querySelector('[role="dialog"], .backdrop') === null`), 3000)
      check('overlay: a closed panel is unmounted, the layer keeps nothing of it', historyDrawn && historyGone, JSON.stringify({ historyDrawn, historyGone, panel: browser.currentPanel() }))
    }
    if (want('drag')) {
      // ========================================================================
      // A tab dragged from the sidebar onto the page
      // ========================================================================
      for (const t of tabsHere()) browser.dispatch({ type: 'tab/close', id: t.id })
      const pa = await openTab('/da')
      browser.dispatch({ type: 'tab/rename', id: pa, title: 'Alpha' })
      const pb = await openTab('/db')
      browser.dispatch({ type: 'tab/rename', id: pb, title: 'Bravo' })
      const pc = await openTab('/dc')
      browser.dispatch({ type: 'tab/rename', id: pc, title: 'Charlie' })
      browser.dispatch({ type: 'tab/select', id: pa })
      await sleep(500)
      const rowScript = (name: string) => `[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)})`
      const sidebarDrag = (type: 'dragstart' | 'dragend', name: string) =>
        evaluate<boolean>(chrome, `(() => { const row = ${rowScript(name)}; if (!row) return false; window.__dt ??= new DataTransfer(); row.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: window.__dt })); return true })()`)
      const stageRect = (): Rect => {
        const view = overlayView.getBounds()
        return { x: view.x, y: view.y, width: view.width, height: view.height }
      }
      /** A drag event on the veil, with the data of a tab row of the sidebar, or (`foreign`) of a link. (The drop effect of a made DataTransfer cannot be read back: what a drag does is read in the veil.) */
      const veilEvent = (type: 'dragenter' | 'dragover' | 'drop' | 'dragleave', x: number, y: number, foreign = false) =>
        evaluate<boolean>(ui, `(() => { const root = document.querySelector('.split-drop'); if (!root) return false; const dt = new DataTransfer(); dt.setData(${JSON.stringify(foreign ? 'text/uri-list' : DRAG_TYPE)}, ${JSON.stringify(foreign ? 'http://example.com/' : pb)}); const e = new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }); root.dispatchEvent(e); return true })()`)
      const veilParts = () =>
        evaluate<{ box: Rect | null; page: Rect | null; ring: boolean; boxStyle: Record<string, string> | null; pageStyle: Record<string, string> | null; ringStyle: Record<string, string> | null; image: boolean }>(
          ui,
          `(() => { const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
            const style = (el, props) => { if (!el) return null; const s = getComputedStyle(el); const o = {}; for (const p of props) o[p] = s.getPropertyValue(p); return o }
            const box = document.querySelector('.sd-box'), page = document.querySelector('.sd-page'), ring = document.querySelector('.sd-ring')
            return { box: rect(box), page: rect(page), ring: !!ring, image: !!page?.querySelector('img'),
              boxStyle: style(box, ['background-color', 'border-top-width', 'border-top-color', 'border-top-left-radius', 'opacity']),
              pageStyle: style(page, ['transition-duration', 'transition-timing-function', 'border-top-left-radius']),
              ringStyle: style(ring, ['border-top-width', 'border-top-color']) } })()`
        )
      const splitsNow = () => state().splits.filter((s) => s.spaceId === spaceId)
      const pageAttached = (id: string) => win.contentView.children.includes((browser.pageFor(id) as unknown as { view: Electron.View }).view)

      // The veil: opened by the start of a drag, with the page put away under it.
      await spyOnOverlay()
      await sidebarDrag('dragstart', 'Bravo')
      const veilOpen = await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await sleep(300)
      const rootHtml = await evaluate<string>(ui, `document.visibilityState + ' | ' + (document.getElementById('root')?.innerHTML ?? 'no root').slice(0, 240)`)
      check('split-drag: (diagnostic) what the overlay shows once the veil is asked for', rootHtml.includes('split-drop'), JSON.stringify({ rootHtml, shows: await overlayShows(), events: uiEvents.slice(-8), bounds: overlayView.getBounds() }))
      const request = browser.currentOverlay() as { snapshot: string | null; size: { width: number; height: number }; tabId: string } | null
      const stage = stageRect()
      check('split-drag: starting to drag a tab row opens the veil over the page, with a picture of the page', veilOpen && request?.tabId === pb && typeof request.snapshot === 'string' && request.snapshot.startsWith('data:image/jpeg;base64,'), JSON.stringify({ panel: browser.currentPanel(), snapshot: request?.snapshot?.slice(0, 24) }))
      check('split-drag: the veil covers the page card exactly (the overlay\'s bounds are the page\'s)', request !== null && sameRect(stage, { x: stage.x, y: stage.y, width: request.size.width, height: request.size.height }) && stage.width > 400, `${show(stage)} vs ${JSON.stringify(request?.size)}`)
      check('split-drag: the page itself is put away while the veil shows its picture', !pageAttached(pa))
      await sleep(100)
      let parts = await veilParts()
      check('split-drag: in the middle of nothing yet the page is whole (the picture fills the card) and no box, no ring', sameRect(parts.page, { x: 0, y: 0, width: stage.width, height: stage.height }) && parts.image && !parts.ring && parts.boxStyle?.['opacity'] === '0', JSON.stringify(parts))
      // The zones, each checked against the layout model (shared/split-drop.ts) once the 0.2 s move is over.
      const W = stage.width
      const H = stage.height
      const zoneAt = async (fx: number, fy: number, expected: BoxSide | 'ring' | 'none', label: string) => {
        await veilEvent('dragover', Math.round(W * fx), Math.round(H * fy))
        await sleep(DROP_VEIL.moveMs + 120)
        parts = await veilParts()
        if (expected === 'none') return check(`split-drag: ${label}: nothing is armed`, !parts.ring && parts.boxStyle?.['opacity'] === '0' && sameRect(parts.page, { x: 0, y: 0, width: W, height: H }), JSON.stringify(parts))
        if (expected === 'ring') return check(`split-drag: ${label}: the page is whole inside a ring`, parts.ring && parts.ringStyle?.['border-top-width'] === `${DROP_VEIL.ringWidth}px` && parts.ringStyle['border-top-color'] !== 'rgba(0, 0, 0, 0)' && sameRect(parts.page, { x: 0, y: 0, width: W, height: H }) && parts.boxStyle?.['opacity'] === '0', JSON.stringify(parts))
        const expectedLayout = dropLayout(expected, { width: W, height: H })
        check(`split-drag: ${label}: the box and the reduced page are where the layout model puts them (the box on the ${expected})`, sameRect(parts.box, expectedLayout.box) && sameRect(parts.page, expectedLayout.page) && parts.boxStyle?.['opacity'] === '1' && !parts.ring, `${show(parts.box)} | ${show(parts.page)} expected ${show(expectedLayout.box)} | ${show(expectedLayout.page)}`)
      }
      await zoneAt(0.3, 0.5, 'left', 'pointer left of the middle')
      check('split-drag: the box is #0e0f14 with a 2 px outline #7d7e89 and 5 px corners, the reduced page keeps its 8 px corners', parts.boxStyle?.['background-color'] === 'rgb(14, 15, 20)' && parts.boxStyle['border-top-width'] === '2px' && parts.boxStyle['border-top-color'] === 'rgb(125, 126, 137)' && parts.boxStyle['border-top-left-radius'] === '5px' && parts.pageStyle?.['border-top-left-radius'] === '8px', JSON.stringify({ box: parts.boxStyle, page: parts.pageStyle }))
      check('split-drag: the move lasts 0.2 s, ease-out', parts.pageStyle?.['transition-duration']?.split(',').every((d) => d.trim() === '0.2s') === true && parts.pageStyle['transition-timing-function']?.split(',').every((d) => d.trim() === 'ease-out') === true, JSON.stringify(parts.pageStyle))
      // Pixels: the box's left and right edges on the screen, at the screen's scale.
      const veilShot = await ui.capturePage()
      const expectedBox = dropLayout('left', { width: W, height: H }).box
      const row = Math.round(H / 2)
      const colorsAcross = Array.from({ length: Math.ceil(W) }, (_, x) => pixelAt(veilShot, W, x, row))
      const firstBox = colorsAcross.findIndex((c) => c === '#7d7e89')
      const lastBoxEdge = colorsAcross.lastIndexOf('#7d7e89', Math.round(expectedBox.width) + 4)
      check(`split-drag: on the screen (scale ${veilShot.getSize().width / W}) the box is outlined at its left and right edges, ${expectedBox.width} px apart`, firstBox >= 0 && near(firstBox, 0, 1) && near(lastBoxEdge, expectedBox.width - 1, 2) && pixelAt(veilShot, W, expectedBox.width / 2, row) === '#0e0f14', JSON.stringify({ firstBox, lastBoxEdge, inside: pixelAt(veilShot, W, expectedBox.width / 2, row) }))
      // The hysteresis: the same x gives another zone according to the way the pointer came.
      await zoneAt(0.5026, 0.5, 'left', 'at 50 % going on from the left')
      await zoneAt(0.54, 0.5, 'ring', 'a little further')
      await zoneAt(0.7, 0.5, 'right', 'pointer right of the middle')
      await zoneAt(0.5026, 0.5, 'ring', 'back at the same 50 %, coming from the right')
      await zoneAt(0.5, 0.05, 'top', 'pointer near the top')
      await zoneAt(0.5, 0.99, 'bottom', 'pointer at the very bottom')
      await zoneAt(0.5, 0.5, 'ring', 'back in the middle')
      await zoneAt(0.1, 0.5, 'none', 'pointer close to the sidebar')
      // A drag that is not one of ours is not accepted: the veil stays as it was, where a drag of a tab row would have opened a box on the right.
      const sent = await veilEvent('dragover', Math.round(W * 0.7), Math.round(H * 0.5), true)
      await sleep(DROP_VEIL.moveMs + 120)
      parts = await veilParts()
      check('split-drag: a link or a file dragged over the veil does not move it', sent && !parts.ring && parts.boxStyle?.['opacity'] === '0' && sameRect(parts.page, { x: 0, y: 0, width: W, height: H }), JSON.stringify(parts))
      // Leaving the page ends the zone.
      await zoneAt(0.8, 0.5, 'right', 'again on the right')
      await veilEvent('dragleave', -5, 10)
      await sleep(DROP_VEIL.moveMs + 120)
      parts = await veilParts()
      check('split-drag: the pointer leaving the veil folds the box up', parts.boxStyle?.['opacity'] === '0' && sameRect(parts.page, { x: 0, y: 0, width: W, height: H }), JSON.stringify(parts))
      // Drop on the ring: nothing.
      // (Coming in from the sidebar's side the left box is kept up to just past the middle: the ring is a little further.)
      await zoneAt(0.54, 0.5, 'ring', 'in the middle')
      await veilEvent('drop', Math.round(W * 0.54), Math.round(H / 2))
      // The witness: the veil going, which the shell does as it takes the drop, before it would make a split view (browser-overlay.ts, `dropOnPage`).
      await waitFor(() => browser.currentPanel() === null && pageAttached(pa))
      check('split-drag: a drop on the ring makes no split view; the veil goes and the page is back', splitsNow().length === 0 && browser.currentPanel() === null && pageAttached(pa))
      await sidebarDrag('dragend', 'Bravo')

      // Drops on the sides: the split view that comes out, the dragged tab shown. A drag may end before its drop is heard (two processes).
      const dropOn = async (name: string, fx: number, fy: number, endFirst: boolean) => {
        await sidebarDrag('dragstart', name)
        await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
        await veilEvent('dragover', Math.round(stage.width * fx), Math.round(stage.height * fy))
        await sleep(60)
        if (endFirst) {
          await sidebarDrag('dragend', name)
          await veilEvent('drop', Math.round(stage.width * fx), Math.round(stage.height * fy))
        } else {
          await veilEvent('drop', Math.round(stage.width * fx), Math.round(stage.height * fy))
          await sidebarDrag('dragend', name)
        }
        await sleep(250)
      }
      const reset = async () => {
        for (const sp of [...splitsNow()]) browser.dispatch({ type: 'split/remove', tabId: sp.tabIds[0]! })
        await waitFor(() => splitsNow().length === 0)
        browser.dispatch({ type: 'tab/select', id: pa })
        await sleep(300)
      }
      // (diagnostic) The listeners of the state are told inside the dispatch itself: the stack of each change of the tab on screen names who selected it, which is
      // what a failure of the check below needs (the split view was right in the run of 0.2.15, the tab shown was another one).
      const nameOf = (id: string | null) => ({ [pa]: 'Alpha', [pb]: 'Bravo', [pc]: 'Charlie' })[id ?? ''] ?? String(id)
      const selections: string[] = []
      const stopWatching = store.subscribe(() => {
        const name = nameOf(activeId())
        if (selections.length > 0 && selections.at(-1)!.startsWith(`${name} `)) return
        // The stack is cut at ten calls by default, which ends inside the extension runtime: who called it is further up.
        const limit = Error.stackTraceLimit
        Error.stackTraceLimit = 40
        const stack = new Error().stack ?? ''
        Error.stackTraceLimit = limit
        selections.push(`${name} ${stack.split('\n').slice(2, 30).map((line) => line.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ')}`)
      })
      await dropOn('Bravo', 0.8, 0.5, false)
      stopWatching()
      let sp = splitsNow()[0]
      check('split-drag: a drop on the right makes a split view: the page on screen on the left, the dragged tab on the right and shown', splitsNow().length === 1 && sp?.tabIds.join() === [pa, pb].join() && sp.orientation === 'horizontal' && activeId() === pb && browser.currentPanel() === null, JSON.stringify({ pa, pb, pc, splits: splitsNow(), active: nameOf(activeId()), panel: browser.currentPanel(), selections }))
      await reset()
      await dropOn('Bravo', 0.2 + 0.05, 0.5, true)
      sp = splitsNow()[0]
      check('split-drag: a drop on the left (the drag having ended first) puts the dragged tab on the left', splitsNow().length === 1 && sp?.tabIds.join() === [pb, pa].join() && sp.orientation === 'horizontal' && activeId() === pb, JSON.stringify({ splits: splitsNow(), active: activeId() }))
      await reset()
      await dropOn('Bravo', 0.5, 0.99, false)
      sp = splitsNow()[0]
      check('split-drag: a drop at the bottom stacks them: the page on top, the dragged tab below and shown', splitsNow().length === 1 && sp?.tabIds.join() === [pa, pb].join() && sp.orientation === 'vertical' && activeId() === pb, JSON.stringify({ splits: splitsNow(), active: activeId() }))
      await reset()
      await dropOn('Bravo', 0.5, 0.05, false)
      sp = splitsNow()[0]
      check('split-drag: a drop at the top puts the dragged tab above', splitsNow().length === 1 && sp?.tabIds.join() === [pb, pa].join() && sp.orientation === 'vertical' && activeId() === pb, JSON.stringify({ splits: splitsNow(), active: activeId() }))
      await reset()

      // A drag that ends outside the page (a drop in the sidebar, Escape): the veil goes after a moment, nothing is made.
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.5))
      await sidebarDrag('dragend', 'Bravo')
      check('split-drag: when the drag ends without a drop the veil goes (after a short wait for a drop on its way) and the page comes back', (await waitFor(() => browser.currentPanel() === null, 2000)) && splitsNow().length === 0 && pageAttached(pa))

      // A click on a veil that stayed up puts it away.
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      ui.sendInputEvent({ type: 'mouseMove', x: 100, y: 100 })
      ui.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
      ui.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
      check('split-drag: a click on a veil left behind by a drag that never ended puts it away', (await waitFor(() => browser.currentPanel() === null, 2000)) && pageAttached(pa))
      await sidebarDrag('dragend', 'Bravo')

      // The tab on screen dragged onto itself: the split view's other pane is a new tab; the command bar asks for it.
      browser.dispatch({ type: 'tab/select', id: pb })
      await sleep(400)
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.5))
      await sleep(60)
      await veilEvent('drop', Math.round(W * 0.8), Math.round(H * 0.5))
      await sidebarDrag('dragend', 'Bravo')
      const barOpen = await waitFor(() => browser.currentPanel() === 'commandbar', 3000)
      check('split-drag: the page on screen dropped on the right opens the command bar for the other pane', barOpen && (browser.currentOverlay() as { mode?: string } | null)?.mode === 'split', JSON.stringify(browser.currentOverlay()))
      const tabsBefore = tabsHere().length
      ui.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      ui.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(() => browser.currentPanel() === null)
      check('split-drag: Escape in that bar leaves one page: no tab added, no split view', tabsHere().length === tabsBefore && splitsNow().length === 0)
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.5))
      await sleep(60)
      await veilEvent('drop', Math.round(W * 0.8), Math.round(H * 0.5))
      await sidebarDrag('dragend', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'commandbar', 3000)
      browser.submitUrl(`${base}/fresh`, 'split')
      await waitFor(() => splitsNow().length === 1 && activeId() !== pb)
      sp = splitsNow()[0]
      const fresh = tabsHere().find((t) => t.url.endsWith('/fresh'))
      check('split-drag: choosing a page makes the split view: the new tab on the side opposite to the box (left), shown', !!fresh && sp?.tabIds.join() === [fresh.id, pb].join() && sp.orientation === 'horizontal' && activeId() === fresh.id, JSON.stringify({ splits: splitsNow(), active: activeId() }))
      await reset()

      // Over a split view of two the veil opens as well, with a picture of each pane, and a drop at its right end makes the dragged tab one more pane.
      type JoinVeil = { split?: { full: boolean; snapshots: (string | null)[] } } | null
      const veilSplit = () => {
        const shown = (browser.currentOverlay() as JoinVeil)?.split
        return shown ? { full: shown.full, snapshots: shown.snapshots.map((s) => s?.slice(0, 24) ?? null) } : null
      }
      browser.dispatch({ type: 'split/create', tabId: pa, withTabId: pc })
      await sleep(300)
      await sidebarDrag('dragstart', 'Bravo')
      const joinVeil = await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await sleep(100)
      const joined = veilSplit()
      check('split-drag: over a split view of two the veil opens with a picture of each pane, the pages put away under it', joinVeil && joined?.full === false && joined.snapshots.length === 2 && !pageAttached(pa) && !pageAttached(pc), JSON.stringify({ panel: browser.currentPanel(), split: joined }))
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.5))
      await sleep(60)
      await veilEvent('drop', Math.round(W * 0.8), Math.round(H * 0.5))
      await sidebarDrag('dragend', 'Bravo')
      await sleep(250)
      sp = splitsNow()[0]
      check('split-drag: a drop at the right end of a split view of two makes the dragged tab its third pane, shown', splitsNow().length === 1 && sp?.tabIds.join() === [pa, pc, pb].join() && activeId() === pb && browser.currentPanel() === null && pageAttached(pa) && pageAttached(pc), JSON.stringify({ splits: splitsNow(), active: activeId() }))
      // The four windows asked for: in the bottom right corner of the row of three, the veil shows that cell of a 2 x 2 grid, outlined in the blue of
      // the focused pane, and the drop makes the grid.
      const pd = await openTab('/dd')
      browser.dispatch({ type: 'tab/rename', id: pd, title: 'Delta' })
      browser.dispatch({ type: 'tab/select', id: pb })
      await sleep(300)
      await sidebarDrag('dragstart', 'Delta')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await sleep(100)
      const cornerSize = (browser.currentOverlay() as { size?: { width: number; height: number } } | null)?.size ?? { width: W, height: H }
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.9))
      await sleep(DROP_VEIL.moveMs + 80)
      const corner = await veilParts()
      const cell = joinLayout('bottom-right', cornerSize, { orientation: 'horizontal', ratios: [1 / 3, 1 / 3, 1 / 3] }, TOOLBAR_BAR_HEIGHT).box
      check('split-drag: in the bottom right corner of a row of three the box is the bottom right cell of a 2 x 2 grid, outlined in blue', cell !== null && sameRect(corner.box, cell) && corner.boxStyle?.['opacity'] === '1' && corner.boxStyle['border-top-color'] === 'rgb(47, 57, 255)', JSON.stringify({ box: corner.box, cell, style: corner.boxStyle }))
      await veilEvent('drop', Math.round(W * 0.8), Math.round(H * 0.9))
      await sidebarDrag('dragend', 'Delta')
      await sleep(250)
      sp = splitsNow()[0]
      check('split-drag: that drop makes the 2 x 2 grid: the three panes in their order, the dropped tab at the bottom right and shown', splitsNow().length === 1 && sp?.tabIds.join() === [pa, pc, pb, pd].join() && sp.grid !== undefined && sp.grid.span === undefined && activeId() === pd && pageAttached(pd) && pageAttached(pa), JSON.stringify({ splits: splitsNow(), active: activeId() }))
      // Over a split view of four the veil says it is full: its pages stay, a drop does nothing and the tab keeps its row.
      const pe = await openTab('/de')
      browser.dispatch({ type: 'split/create', tabId: pa, withTabId: pd })
      browser.dispatch({ type: 'split/remove', tabId: pb })
      browser.dispatch({ type: 'split/create', tabId: pa, withTabId: pe })
      browser.dispatch({ type: 'tab/select', id: pa })
      await sleep(300)
      const fourPanes = splitsNow()[0]?.tabIds.length === 4
      await sidebarDrag('dragstart', 'Bravo')
      const fullVeil = await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await sleep(100)
      const full = veilSplit()
      const fullText = await evaluate<string>(ui, `document.querySelector('.sd-full')?.textContent ?? ''`)
      check('split-drag: over a split view of four the veil says it takes no more, and its pages stay on screen', fourPanes && fullVeil && full?.full === true && fullText.length > 0 && pageAttached(pa) && pageAttached(pe), JSON.stringify({ fourPanes, panel: browser.currentPanel(), split: full, fullText }))
      await veilEvent('dragover', Math.round(W * 0.8), Math.round(H * 0.5))
      await sleep(60)
      await veilEvent('drop', Math.round(W * 0.8), Math.round(H * 0.5))
      await sidebarDrag('dragend', 'Bravo')
      await waitFor(() => browser.currentPanel() === null, 2000)
      sp = splitsNow()[0]
      check('split-drag: a drop on a split view of four changes nothing: the four panes stay, the dragged tab is in none', splitsNow().length === 1 && sp?.tabIds.length === 4 && !sp.tabIds.includes(pb) && tabsHere().some((t) => t.id === pb), JSON.stringify({ splits: splitsNow() }))
      for (const id of sp?.tabIds.slice(0, -1) ?? []) browser.dispatch({ type: 'split/remove', tabId: id })
      browser.dispatch({ type: 'tab/close', id: pd })
      browser.dispatch({ type: 'tab/close', id: pe })
      await reset()

      // Not offered: a tab already in a split view, the sidebar hidden, a panel open, another space.
      browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
      await sleep(300)
      browser.beginSplitDrag(pb)
      // No wait: beginSplitDrag decides before it returns (browser-overlay.ts): a veil it grants is on its way (its drag is kept) by then.
      const veilOnItsWay = (): boolean => (browser as unknown as { splitDrag: unknown }).splitDrag !== null
      check('split-drag: no veil with the sidebar hidden (the floating sidebar lies over the page)', !veilOnItsWay() && browser.currentPanel() === null)
      browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
      await sleep(300)
      browser.openOverlay({ panel: 'archive' })
      await sidebarDrag('dragstart', 'Bravo')
      // The witness: the row tells the shell of the drag with a message without an answer; a question asked after it on the same channel is
      // answered once the shell has decided on it.
      await evaluate(chrome, 'window.lucium.getSnapshot().then(() => 0)')
      check('split-drag: no veil over a panel', !veilOnItsWay() && browser.currentPanel() === 'archive')
      browser.closeOverlay()
      await sidebarDrag('dragend', 'Bravo')
      await sleep(300)

      // The setting off: the sidebar does not even tell the shell.
      browser.dispatch({ type: 'settings/update', patch: { dragToSplit: false } })
      await sleep(200)
      const realBegin = browser.beginSplitDrag.bind(browser)
      let begun = 0
      browser.beginSplitDrag = (id: string) => {
        begun++
        realBegin(id)
      }
      await sidebarDrag('dragstart', 'Bravo')
      // The witness: a question asked on the same channel after the drag started, answered once whatever the row sent before it has been handled.
      await evaluate(chrome, 'window.lucium.getSnapshot().then(() => 0)')
      check('split-drag: with the setting off a dragged tab row sends nothing to the shell and no veil opens', begun === 0 && browser.currentPanel() === null)
      await sidebarDrag('dragend', 'Bravo')
      browser.dispatch({ type: 'settings/update', patch: { dragToSplit: true } })
      await sleep(200)
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      check('split-drag: and with it on, the same drag does (the shell is told once)', begun === 1 && browser.currentPanel() === 'splitdrop')
      await sidebarDrag('dragend', 'Bravo')
      await waitFor(() => browser.currentPanel() === null, 2000)
      browser.beginSplitDrag = realBegin

      // A picture that cannot be taken: the log says which tab, and the veil opens all the same over a plain card.
      const activePage = browser.pageFor(activeId()!) as unknown as { capture: (...args: unknown[]) => Promise<Buffer> }
      const realCapture = activePage.capture
      activePage.capture = () => Promise.reject(new Error('capture refused'))
      const warnings: string[] = []
      const realWarn = console.warn
      console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
      try {
        await sidebarDrag('dragstart', 'Bravo')
        await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      } finally {
        console.warn = realWarn
        activePage.capture = realCapture
      }
      const plainVeil = browser.currentOverlay() as { snapshot: string | null } | null
      check('split-drag: when the picture of the page cannot be taken the log names the tab and the cause, and the veil opens over a plain card', plainVeil?.snapshot === null && warnings.some((w) => w.includes('[split-drag]') && w.includes(pb) && w.includes('capture refused')), JSON.stringify({ snapshot: plainVeil?.snapshot, warnings: warnings.slice(0, 2) }))
      await sidebarDrag('dragend', 'Bravo')
      await waitFor(() => browser.currentPanel() === null, 2000)

      // The interface zoomed (Settings › Taille de l'interface): the layer is zoomed with it, so the veil and the panel of ⌃Tab are laid out in the
      // CSS pixels of the layer and placed in points.
      const factor = 1.5
      browser.dispatch({ type: 'settings/update', patch: { uiScale: 150 } })
      const zoomed = await waitFor(() => Math.abs(ui.getZoomFactor() - factor) < 0.001, 5000)
      await sleep(500)
      browser.dispatch({ type: 'tab/select', id: pa })
      await sleep(500)
      await sidebarDrag('dragstart', 'Bravo')
      await waitFor(() => browser.currentPanel() === 'splitdrop', 4000)
      await sleep(300)
      const zoomRequest = browser.currentOverlay() as { size: { width: number; height: number } } | null
      const zoomLayer = overlayView.getBounds()
      const cssSize = zoomRequest?.size ?? { width: 0, height: 0 }
      check(`veil at ${factor * 100} %: the layer is the page card in points, the veil is drawn in the layer's CSS pixels (points ÷ ${factor})`, zoomed && near(cssSize.width * factor, zoomLayer.width, 1.5) && near(cssSize.height * factor, zoomLayer.height, 1.5), JSON.stringify({ cssSize, zoomLayer, zoom: ui.getZoomFactor() }))
      await veilEvent('dragover', Math.round(cssSize.width * 0.3), Math.round(cssSize.height * 0.5))
      await sleep(DROP_VEIL.moveMs + 150)
      const zoomParts = await veilParts()
      const zoomExpected = dropLayout('left', cssSize)
      check(`veil at ${factor * 100} %: the box and the reduced page keep the figures of the layout model in CSS pixels`, sameRect(zoomParts.box, zoomExpected.box) && sameRect(zoomParts.page, zoomExpected.page), `${show(zoomParts.box)} | ${show(zoomParts.page)} expected ${show(zoomExpected.box)} | ${show(zoomExpected.page)}`)
      await sidebarDrag('dragend', 'Bravo')
      await waitFor(() => browser.currentPanel() === null, 2000)
      holdControl()
      pressTab()
      await waitFor(() => browser.currentPanel() === 'tabcycle', 3000)
      await sleep(300)
      const zoomedPanel = await evaluate<Rect | null>(ui, `(() => { const el = document.querySelector('.tc-panel'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      const zoomedLayer = overlayView.getBounds()
      const content = win.getContentBounds()
      const centre = zoomedPanel ? { x: zoomedLayer.x + (zoomedPanel.x + zoomedPanel.width / 2) * factor, y: zoomedLayer.y + (zoomedPanel.y + zoomedPanel.height / 2) * factor } : null
      check(`tab-cycle at ${factor * 100} %: the panel is 265 CSS pixels tall and stays centred in the window`, !!zoomedPanel && !!centre && near(zoomedPanel.height, CYCLE_PANEL.height, 1) && near(centre.x, content.width / 2, 2) && near(centre.y, content.height / 2, 2), JSON.stringify({ zoomedPanel, centre, content }))
      releaseTab()
      releaseControl()
      await waitFor(() => browser.currentPanel() === null)
      browser.dispatch({ type: 'settings/update', patch: { uiScale: 100 } })
      await waitFor(() => Math.abs(ui.getZoomFactor() - 1) < 0.001, 5000)
      await sleep(300)
    }
    if (want('toolbar')) {
      // ========================================================================
      // The bar of a page with no colour of its own
      // ========================================================================
      for (const t of tabsHere()) browser.dispatch({ type: 'tab/close', id: t.id })
      await openTab('/plain')
      await sleep(500)
      // The default bar is the surface of the tokens (toolbar.css): `--surface-3` in a dark window, `--surface-2` in a light one. It is read back from a probe that paints
      // with that very token, so that a change of the palette does not make this check lie, while a bar tinted by the page (an inline `--toolbar-bg`) or striped would not match.
      const normal = await evaluate<{ bar: string; surface: string; tinted: string; image: string }>(
        chrome,
        `(() => { const shell = document.querySelector('.shell'); const probe = document.createElement('div'); probe.style.backgroundColor = shell.classList.contains('light') ? 'var(--surface-2)' : 'var(--surface-3)'; shell.appendChild(probe); const surface = getComputedStyle(probe).backgroundColor; probe.remove(); const bar = document.querySelector('.page-toolbar'); return { bar: getComputedStyle(bar).backgroundColor, surface, tinted: [bar, shell, bar.parentElement].map((el) => el?.style.getPropertyValue('--toolbar-bg') ?? '').join(''), image: getComputedStyle(bar).backgroundImage } })()`
      )
      const normalBar = normal.bar
      check('toolbar: in a normal window a page that declares no colour keeps the default bar of the theme (the surface of the tokens), not a tint, without stripes', normal.bar === normal.surface && normal.surface !== '' && normal.tinted === '' && normal.image === 'none', JSON.stringify(normal))
      privateRecord = getWindowManager().openPrivate()
      await sleep(800)
      privateRecord.browser.dispatch({ type: 'tab/open', url: `${base}/plain` })
      await waitFor(() => privateRecord!.store.get().tabs.length === 1 && privateRecord!.browser.snapshot().runtime.tabs[privateRecord!.store.get().tabs[0]!.id]?.loading === false, 10_000)
      await sleep(600)
      const privateBar = await privateRecord.win.webContents.executeJavaScript(`(() => { const s = getComputedStyle(document.querySelector('.page-toolbar')); return { color: s.backgroundColor, image: s.backgroundImage.slice(0, 40) } })()`) as { color: string; image: string }
      check('toolbar: in a private window the same page has faint diagonal stripes, in another colour than the plain grey', privateBar.color !== normalBar && privateBar.image.startsWith('repeating-linear-gradient'), JSON.stringify({ privateBar, normalBar }))
      privateRecord.browser.dispatch({ type: 'tab/open', url: `${base}/colored` })
      await waitFor(() => privateRecord!.store.get().tabs.length === 2 && privateRecord!.browser.snapshot().runtime.tabs[privateRecord!.store.get().tabs[1]!.id]?.color === '#ffffff', 10_000)
      await sleep(500)
      const privateTinted = await privateRecord.win.webContents.executeJavaScript(`(() => { const s = getComputedStyle(document.querySelector('.page-toolbar')); return { color: s.backgroundColor, image: s.backgroundImage } })()`) as { color: string; image: string }
      check('toolbar: a page that declares its own colour keeps it in a private window, without the stripes', privateTinted.color === 'rgb(255, 255, 255)' && privateTinted.image === 'none', JSON.stringify(privateTinted))
    }
  } finally {
    if (privateRecord && !privateRecord.win.isDestroyed()) privateRecord.win.close()
    browser.closeOverlay()
    for (const t of state().tabs.filter((tab) => tab.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: t.id })
    if (state().spaces.some((s) => s.id === spaceId)) browser.dispatch({ type: 'space/delete', id: spaceId })
    if (state().spaces.some((s) => s.id === previousSpace)) browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({
      type: 'settings/update',
      patch: { backClosesOpenedTab: original.backClosesOpenedTab, tabCycleRecent: original.tabCycleRecent, dragToSplit: original.dragToSplit, keyBindings: original.keyBindings, uiScale: original.uiScale, sidebarVisible: original.sidebarVisible, hoverCards: original.hoverCards, sleepAfterMinutes: original.sleepAfterMinutes, interfaceAppearance: original.interfaceAppearance }
    })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=navigation`: only these checks, with their own report. */
export async function runNavigationSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeNavigation(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeNavigation ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_NAVIGATION ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
