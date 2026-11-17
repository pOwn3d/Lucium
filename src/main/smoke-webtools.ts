// Engine checks for the extra web tools, run inside a real Electron against a local server and with real input events: the QR
// code panel, autoscroll, synchronized scrolling of a split view, mouse gestures, page watching, reading aloud, the battery saver (and its
// measured effect on the CPU). Every tool is checked off first (nothing changes, nothing is installed), then on. Called from the engine
// smoke test: `await smokeWebTools(ctx, check)`; `LUCIUM_SMOKE_ONLY=webtools` runs only these.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, ipcMain, Menu, session, webContents as allWebContents, type MenuItem, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { TOOLS_WORLD } from '@shared/page-tools'
import { setNoticeSink } from './shell/system-notice'
import { batterySaver, type PowerSource } from './shell/battery-saver'
import { menuItems } from './shell/context-menus'
import { isReading } from './engine/page-reader'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, reportFact, skippedBecause, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 60)

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

const PAGE_CSS = 'body{margin:0;font:16px sans-serif}'

export async function smokeWebTools(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView, engine } = ctx
  const original = { ...store.get().settings }
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
  const tools = { qrCode: false, autoScroll: false, scrollSync: false, mouseGestures: false, mouseGestureExcludedHosts: [] as string[], pageWatch: false, pageWatches: [], readAloud: false, batterySaver: false }
  browser.dispatch({ type: 'settings/update', patch: tools })
  const set = (patch: Record<string, unknown>) => browser.dispatch({ type: 'settings/update', patch: patch as never })

  // ---- a server whose pages are the fixtures ----
  let watchText = 'prix 10'
  let sawProfileCookie = false
  const watchHits: string[] = []
  const article = `<p>${'Voici une phrase assez longue pour que le mode lecture trouve un article à afficher. '.repeat(8)}</p>`.repeat(4)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/watch') {
      watchHits.push(req.url ?? '')
      if ((req.headers.cookie ?? '').includes('who=profile')) sawProfileCookie = true
      return void res.end(`<title>Surveillée</title><body><div id="zone">${watchText}</div><div id="other">fixe</div></body>`)
    }
    if (url.pathname === '/article') return void res.end(`<title>Un article</title><body><article><h1>Un article</h1>${article}</article></body>`)
    if (url.pathname === '/anim') {
      return void res.end(
        `<title>Animée</title><style>${PAGE_CSS}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{box-shadow:0 0 14px #f80;background-color:#f48;border-radius:40%}}` +
          `.b{width:18px;height:18px;margin:2px;display:inline-block;background:#48f;animation:spin 1s linear infinite,pulse .7s ease-in-out infinite}</style><body>${'<i class="b"></i>'.repeat(600)}</body>`
      )
    }
    const height = Number(url.searchParams.get('h') ?? '8000')
    const id = url.searchParams.get('id') ?? url.pathname
    res.end(
      `<title>${id}</title><style>${PAGE_CSS}</style><body><div style="height:${height}px;background:linear-gradient(#fff,#ccc)">${id}</div>` +
        `<a id="lnk" href="/b?id=lien" style="position:absolute;top:100px;left:100px;font-size:30px">un lien</a><input id="q" style="position:absolute;top:200px;left:100px">` +
        // The middle presses the page sees: the autoscroll of the tools stops the one it takes before the page, so a press seen here is one it left alone.
        `<script>window.__clicks=0;addEventListener('click',()=>window.__clicks++);window.__middle=0;addEventListener('mousedown',(e)=>{if(e.button===1)window.__middle++})</script></body>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const mine = new Set<string>()
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const runtimeOf = (id: string) => browser.snapshot().runtime.tabs[id]
  const open = async (path: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = store.get().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => wcOf(tab.id) !== undefined && runtimeOf(tab.id)?.loading === false)
    await sleep(250)
    return { id: tab.id, wc: wcOf(tab.id)! }
  }
  const inPage = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>
  const inTools = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code }]) as Promise<T>
  const toolsInstalled = async (wc: WebContents): Promise<string[]> => inTools<string[]>(wc, `Object.keys(self.__lucium_tools || {}).filter((k) => typeof self.__lucium_tools[k] === 'object' && typeof self.__lucium_tools[k].off === 'function')`)
  const mouse = (wc: WebContents, type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number, button: 'left' | 'middle' | 'right' = 'left', down = false) =>
    wc.sendInputEvent({ type, x, y, button, clickCount: type === 'mouseMove' ? 0 : 1, ...(down ? { modifiers: [button === 'right' ? 'rightButtonDown' : button === 'middle' ? 'middleButtonDown' : 'leftButtonDown'] as never } : {}) })
  const click = (wc: WebContents, x: number, y: number, button: 'left' | 'middle' | 'right' = 'left') => {
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y, button)
    mouse(wc, 'mouseUp', x, y, button)
  }
  const scrollY = (wc: WebContents) => inPage<number>(wc, 'Math.round(scrollY)')
  /**
   * Waits until the page has drawn `count` frames, two seconds at most: the witness of what moves a page from frame to frame (the autoscroll of
   * the tools scrolls once a frame). False when the frames did not come, which leaves a check of "nothing moved" without its proof.
   */
  const framesDrawn = (wc: WebContents, count = 3): Promise<boolean> =>
    inPage<boolean>(wc, `new Promise((resolve) => { let left = ${count}; const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick)); requestAnimationFrame(tick); setTimeout(() => resolve(false), 2000) })`)
  const middleSeen = (wc: WebContents) => inPage<number>(wc, 'window.__middle')
  const anchors = (wc: WebContents) => inPage<number>(wc, `document.querySelectorAll('svg').length`)
  /** A middle click, and the witness that the page saw it, so that the tool has had it and left it alone (an anchor is made as the button goes down). */
  const middleClickSeen = async (wc: WebContents, x: number, y: number): Promise<boolean> => {
    const before = await middleSeen(wc)
    click(wc, x, y, 'middle')
    return waitFor(async () => (await middleSeen(wc)) > before)
  }
  const toastNow = () => browser.snapshot().toast?.message ?? ''
  /** The labels (and, with `checked`, only the checked ones) of the context menu of a sidebar target. */
  const menuItemsOf = (target: Parameters<typeof menuItems>[0], checkedOnly = false): string[] =>
    menuItems(target, browser, store, win)
      .filter((item) => !checkedOnly || item.checked === true)
      .map((item) => item.label ?? '')

  // The menus and notices the checks watch, put back at the end.
  const popups: string[][] = []
  const menus: Menu[] = []
  const realPopup = Menu.prototype.popup
  Menu.prototype.popup = function (this: Menu) {
    menus.push(this)
    popups.push(this.items.map((i) => i.label))
    return this
  } as never
  const notices: Array<{ title: string; body: string }> = []
  const restoreNotices = setNoticeSink((notice) => {
    notices.push(notice)
    return true
  })
  const fromTopFrame = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  // The machine this runs on may be on battery and low (the mode would then come on by itself): the power is a stand-in the checks drive.
  const power = { onBattery: false, percent: 100, listeners: new Set<() => void>() }
  const fakePower: PowerSource = {
    onBattery: () => power.onBattery,
    percent: async () => power.percent,
    watch: (listener) => {
      power.listeners.add(listener)
      return () => power.listeners.delete(listener)
    }
  }
  const restorePower = batterySaver().useSource(fakePower)
  const plug = (onBattery: boolean, percent: number) => {
    power.onBattery = onBattery
    power.percent = percent
    for (const listener of [...power.listeners]) listener()
  }

  try {
    // ================================================================= the QR code
    const page = await open('/page?id=qr')
    const itemOff = findMenuItem('Code QR de cette page')
    check('qr: with the setting off, the File menu has no "Code QR de cette page" (Arc\'s menu)', itemOff === undefined)
    browser.openOverlay({ panel: 'qr', text: 'https://example.org/' })
    check('qr: ...and the panel opens for no one', browser.currentPanel() === null)
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'qr', text: 'https://example.org/' })
    check('qr: ...not even when the interface asks', browser.currentPanel() === null)

    set({ qrCode: true })
    await sleep(150)
    const item = findMenuItem('Code QR de cette page')
    check('qr: with the setting on, the File menu offers it, for a web page', item !== undefined && item.enabled)
    item?.click({} as never, undefined, undefined)
    check('qr: the entry opens the panel with the address of the page', await waitFor(() => browser.currentPanel() === 'qr'), String(browser.currentPanel()))
    // The code is the `svg.qr-code` of the sheet: the sheet's own title glyph is an SVG with a path too (templates/Sheet.tsx).
    const drawn = await waitFor(async () => (await overlayView.webContents.executeJavaScript(`(document.querySelector('.qr-panel svg.qr-code path')?.getAttribute('d') || '').length`)) > 500)
    check('qr: the overlay draws the code from modules computed here (an SVG path of dark modules)', drawn)
    const shownText = await overlayView.webContents.executeJavaScript(`document.querySelector('.qr-panel .qr-text')?.textContent`)
    check('qr: ...with the address under it', shownText === store.get().tabs.find((t) => t.id === page.id)?.url, String(shownText))
    browser.closeOverlay()
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'qr', text: 'x'.repeat(5000) })
    check('qr: the interface cannot send a text of any size', browser.currentPanel() === null)
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'qr' })
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'qr', text: 42 })
    check('qr: ...nor something that is not a text', browser.currentPanel() === null)
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'qr', text: 'y'.repeat(400) })
    check('qr: a text too long for a code opens the panel, which says so instead of drawing', await waitFor(async () => (await overlayView.webContents.executeJavaScript(`document.querySelector('.qr-panel [role=alert]')?.textContent || ''`)).includes('trop longue')))
    browser.closeOverlay()

    // The menu of a link has the entry too (and only with the setting on).
    const linkParams = (extra: object = {}) => ({ linkURL: `${base}/b`, mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 5, y: 5, misspelledWord: '', dictionarySuggestions: [], frame: page.wc.mainFrame, ...extra })
    page.wc.emit('context-menu', {}, linkParams())
    const withLink = popups.at(-1) ?? []
    check('qr: the menu of a link offers "Code QR de ce lien" after "Copier l’adresse du lien"', withLink.indexOf('Code QR de ce lien') === withLink.indexOf('Copier l’adresse du lien') + 1 && withLink.includes('Code QR de ce lien'), withLink.join(' | '))
    menus.at(-1)!.items.find((i) => i.label === 'Code QR de ce lien')!.click({} as never, undefined, undefined)
    check('qr: ...and it opens the panel with the address of the link', await waitFor(() => browser.currentOverlay()?.panel === 'qr' && (browser.currentOverlay() as { text?: string }).text === `${base}/b`))
    browser.closeOverlay()
    page.wc.emit('context-menu', {}, linkParams({ linkURL: 'javascript:alert(1)' }))
    check('qr: ...but not for a link that is not a web address', !(popups.at(-1) ?? []).includes('Code QR de ce lien'), (popups.at(-1) ?? []).join(' | '))
    set({ qrCode: false })
    page.wc.emit('context-menu', {}, linkParams())
    check('qr: with the setting off again, the menu of a link is Arc\'s', !(popups.at(-1) ?? []).includes('Code QR de ce lien'))

    // ================================================================= autoscroll
    set({ autoScroll: false })
    const auto = await open('/page?id=auto&h=9000')
    check('autoscroll: off, no tool is installed in the page', (await toolsInstalled(auto.wc)).length === 0, JSON.stringify(await toolsInstalled(auto.wc)))
    const offSeen = await middleClickSeen(auto.wc, 300, 300)
    mouse(auto.wc, 'mouseMove', 300, 450)
    // No anchor once the page has had the press: nothing can scroll it.
    check('autoscroll: off, a middle click does not scroll the page', offSeen && (await anchors(auto.wc)) === 0 && (await scrollY(auto.wc)) === 0, `the page saw the press: ${offSeen}`)

    set({ autoScroll: true })
    check('autoscroll: switching it on installs the tool in the page already open', await waitFor(async () => (await toolsInstalled(auto.wc)).includes('autoScroll')))
    mouse(auto.wc, 'mouseMove', 300, 300)
    mouse(auto.wc, 'mouseDown', 300, 300, 'middle')
    mouse(auto.wc, 'mouseUp', 300, 300, 'middle')
    check('autoscroll: a middle click puts the anchor', await waitFor(async () => (await inPage<number>(auto.wc, `document.querySelectorAll('svg').length`)) === 1))
    mouse(auto.wc, 'mouseMove', 300, 300)
    // The witness: frames drawn with the anchor up and the pointer on it, each of which would have moved the page.
    const restFrames = await framesDrawn(auto.wc)
    check('autoscroll: the pointer on the anchor scrolls nothing', restFrames && (await scrollY(auto.wc)) === 0, `frames drawn: ${restFrames}`)
    mouse(auto.wc, 'mouseMove', 300, 420)
    await sleep(800)
    const nearY = await scrollY(auto.wc)
    check('autoscroll: the pointer below the anchor scrolls the page down', nearY > 150, String(nearY))
    mouse(auto.wc, 'mouseMove', 300, 600)
    const before = await scrollY(auto.wc)
    await sleep(500)
    const fastSpeed = ((await scrollY(auto.wc)) - before) / 0.5
    mouse(auto.wc, 'mouseMove', 300, 360)
    const mid = await scrollY(auto.wc)
    await sleep(500)
    const slowSpeed = ((await scrollY(auto.wc)) - mid) / 0.5
    check('autoscroll: the further the pointer, the faster the page scrolls', fastSpeed > slowSpeed * 2 && slowSpeed > 0, `${Math.round(fastSpeed)} px/s against ${Math.round(slowSpeed)} px/s`)
    click(auto.wc, 300, 600, 'left')
    // The witnesses: the anchor going (the click has ended it), then frames drawn after it, each of which would have moved the page.
    await waitFor(async () => (await anchors(auto.wc)) === 0)
    const stoppedAt = await scrollY(auto.wc)
    const stoppedFrames = await framesDrawn(auto.wc)
    check('autoscroll: a click ends it, and the page stays where it was', stoppedFrames && (await scrollY(auto.wc)) === stoppedAt && (await anchors(auto.wc)) === 0, `frames drawn: ${stoppedFrames}`)
    check('autoscroll: ...and that click did not reach the page', (await inPage<number>(auto.wc, 'window.__clicks')) === 0)
    mouse(auto.wc, 'mouseMove', 300, 300)
    mouse(auto.wc, 'mouseDown', 300, 300, 'middle')
    mouse(auto.wc, 'mouseUp', 300, 300, 'middle')
    await sleep(100)
    mouse(auto.wc, 'mouseMove', 300, 500)
    await sleep(300)
    auto.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    auto.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    // The witnesses: the anchor going (the key has ended it), then frames drawn after it, each of which would have moved the page.
    await waitFor(async () => (await anchors(auto.wc)) === 0)
    const escapedAt = await scrollY(auto.wc)
    const escapedFrames = await framesDrawn(auto.wc)
    check('autoscroll: Escape ends it', escapedFrames && (await scrollY(auto.wc)) === escapedAt && (await anchors(auto.wc)) === 0, `frames drawn: ${escapedFrames}`)

    // The middle click on a link or in a field is left alone.
    await inPage(auto.wc, `scrollTo(0, 0)`)
    await sleep(150)
    const linkSpot = await inPage<{ x: number; y: number }>(auto.wc, `(() => { const r = document.getElementById('lnk').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    const tabsBefore = store.get().tabs.length
    const linkSeen = await middleClickSeen(auto.wc, linkSpot.x, linkSpot.y)
    check('autoscroll: a middle click on a link starts no anchor (it opens the link, as it always did)', linkSeen && (await anchors(auto.wc)) === 0, `${linkSpot.x},${linkSpot.y}, the page saw the press: ${linkSeen}`)
    for (const tab of store.get().tabs.slice(tabsBefore)) {
      mine.add(tab.id)
      browser.dispatch({ type: 'tab/close', id: tab.id })
    }
    browser.dispatch({ type: 'tab/select', id: auto.id })
    await sleep(150)
    await inPage(auto.wc, `document.getElementById('q').focus()`)
    const fieldSeen = await middleClickSeen(auto.wc, 110, 210)
    check('autoscroll: a middle click in a text field starts no anchor', fieldSeen && (await anchors(auto.wc)) === 0, `the page saw the press: ${fieldSeen}`)

    set({ autoScroll: false })
    check('autoscroll: switching it off takes the tool out of the page', await waitFor(async () => (await toolsInstalled(auto.wc)).length === 0))
    const offAgainSeen = await middleClickSeen(auto.wc, 300, 300)
    mouse(auto.wc, 'mouseMove', 300, 500)
    // No anchor once the page has had the press: nothing can scroll it.
    check('autoscroll: ...and a middle click scrolls nothing again', offAgainSeen && (await anchors(auto.wc)) === 0 && (await scrollY(auto.wc)) === 0, `the page saw the press: ${offAgainSeen}`)

    // ================================================================= synchronized scrolling
    const left = await open('/page?id=gauche&h=6000')
    const right = await open('/page?id=droite&h=12000')
    browser.dispatch({ type: 'split/create', tabId: left.id, withTabId: right.id })
    const split = store.get().splits.find((s) => s.tabIds.includes(left.id))
    check('scroll sync: the two tabs are the panes of a split view', split !== undefined && split.tabIds.includes(right.id), JSON.stringify(store.get().splits.map((s) => s.tabIds)))
    if (split) {
      await sleep(400)
      const paneMenu = menuItemsOf({ kind: 'split', id: left.id })
      check('scroll sync: off, the menu of the split pane has no such entry (Arc\'s menu)', !paneMenu.some((label) => label.includes('Défilement synchronisé')), paneMenu.join(' | '))
      browser.setScrollSynced(split.id, true)
      check('scroll sync: off, asking for it does nothing', !browser.isScrollSynced(split.id))
      await inPage(left.wc, `scrollTo(0, 2500)`)
      // No wait: a pane follows the other only through the tool of the pane that scrolled, and the check reads that it has none (the reading
      // reaches the page after any script that would have put it in: they go to the same frame, in order).
      check('scroll sync: off, the other pane does not follow', (await scrollY(right.wc)) === 0 && (await toolsInstalled(left.wc)).length === 0)

      set({ scrollSync: true })
      // No wait: the tools a setting brings are sent to the pages as it changes (browser-tools.ts, `refreshPageTools`), and this reading goes to
      // the page after them.
      check('scroll sync: on, nothing is installed until a split view is told to scroll together', (await toolsInstalled(left.wc)).length === 0)
      browser.setScrollSynced(split.id, true)
      check('scroll sync: ...then both panes carry the tool', await waitFor(async () => (await toolsInstalled(left.wc)).includes('scrollSync') && (await toolsInstalled(right.wc)).includes('scrollSync')))
      await inPage(left.wc, `scrollTo(0, 3000)`)
      const leftShare = (await scrollY(left.wc)) / (await inPage<number>(left.wc, 'document.documentElement.scrollHeight - innerHeight'))
      const followed = await waitFor(async () => {
        const share = (await scrollY(right.wc)) / (await inPage<number>(right.wc, 'document.documentElement.scrollHeight - innerHeight'))
        return Math.abs(share - leftShare) < 0.01 && share > 0.1
      })
      check('scroll sync: scrolling a pane scrolls the other to the same share of its length', followed, `${leftShare.toFixed(3)} against ${((await scrollY(right.wc)) / (await inPage<number>(right.wc, 'document.documentElement.scrollHeight - innerHeight'))).toFixed(3)}`)
      await inPage(right.wc, `scrollTo(0, 1200)`)
      const rightShare = 1200 / (await inPage<number>(right.wc, 'document.documentElement.scrollHeight - innerHeight'))
      check('scroll sync: ...in both directions', await waitFor(async () => Math.abs((await scrollY(left.wc)) / (await inPage<number>(left.wc, 'document.documentElement.scrollHeight - innerHeight')) - rightShare) < 0.01))
      await sleep(600)
      const settledLeft = await scrollY(left.wc)
      const settledRight = await scrollY(right.wc)
      // A fixed wait, for want of a witness: what is checked is that the two panes come to rest, and an exchange between them would go back and
      // forth through the main process with nothing to say it has stopped.
      await sleep(800)
      check('scroll sync: the two panes do not answer each other for ever', (await scrollY(left.wc)) === settledLeft && (await scrollY(right.wc)) === settledRight)
      browser.setScrollSynced(split.id, false)
      check('scroll sync: asked to stop, the tool leaves the panes', await waitFor(async () => (await toolsInstalled(left.wc)).length === 0 && (await toolsInstalled(right.wc)).length === 0))
      await inPage(left.wc, `scrollTo(0, 100)`)
      // No wait: the tool that would carry the scroll has left the pane (waited for above, and read again here).
      check('scroll sync: ...and the other pane stays', (await toolsInstalled(left.wc)).length === 0 && (await scrollY(right.wc)) === settledRight)
      browser.setScrollSynced(split.id, true)
      const paneMenuOn = menuItemsOf({ kind: 'split', id: left.id })
      check('scroll sync: on, the menu of the split pane offers "Défilement synchronisé", checked', menuItemsOf({ kind: 'split', id: left.id }, true).includes('Défilement synchronisé') && paneMenuOn.length > 0)
      set({ scrollSync: false })
      check('scroll sync: switching the setting off forgets the request', !browser.isScrollSynced(split.id) && (await waitFor(async () => (await toolsInstalled(left.wc)).length === 0)))
      browser.dispatch({ type: 'split/remove', tabId: right.id })
    }
    browser.dispatch({ type: 'tab/close', id: right.id })
    browser.dispatch({ type: 'tab/close', id: left.id })

    // ================================================================= mouse gestures
    const gest = await open('/page?id=geste-a')
    browser.dispatch({ type: 'tab/select', id: gest.id })
    void gest.wc.loadURL(`${base}/page?id=geste-b`)
    await waitFor(() => gest.wc.getURL().includes('geste-b') && !gest.wc.isLoading())
    await sleep(250)
    const drawGesture = async (wc: WebContents, ...points: Array<[number, number]>) => {
      const [first, ...rest] = points
      mouse(wc, 'mouseMove', first![0], first![1])
      mouse(wc, 'mouseDown', first![0], first![1], 'right')
      for (const [x, y] of rest) {
        mouse(wc, 'mouseMove', x, y, 'right', true)
        await sleep(25)
      }
      const last = points.at(-1)!
      mouse(wc, 'mouseUp', last[0], last[1], 'right')
    }
    check('gestures: off, no tool is installed in the page', (await toolsInstalled(gest.wc)).length === 0)
    const popupsOff = popups.length
    await drawGesture(gest.wc, [500, 300], [450, 300], [400, 300], [350, 300])
    // No wait: a stroke is read only by the tool of the page, and the check reads that the page has none.
    check('gestures: off, a stroke to the left goes nowhere', (await toolsInstalled(gest.wc)).length === 0 && gest.wc.getURL().includes('geste-b'), gest.wc.getURL())
    void popupsOff

    set({ mouseGestures: true })
    check('gestures: switching them on installs the tool in the page already open', await waitFor(async () => (await toolsInstalled(gest.wc)).includes('mouseGestures')))
    const popupsBefore = popups.length
    await drawGesture(gest.wc, [500, 300], [450, 300], [400, 300], [350, 300])
    check('gestures: a stroke to the left goes back', await waitFor(() => gest.wc.getURL().includes('geste-a')), gest.wc.getURL())
    // No wait after it: going back is the tool's verdict on the stroke, which drops the menu the page asked for before it (electron-page-media.ts).
    check('gestures: ...and the menu of the page did not open for it', popups.length === popupsBefore, `${popups.length - popupsBefore} menus`)
    await waitFor(() => !gest.wc.isLoading())
    await sleep(300)
    await drawGesture(gest.wc, [300, 300], [350, 300], [400, 300], [450, 300])
    check('gestures: a stroke to the right goes forward', await waitFor(() => gest.wc.getURL().includes('geste-b')), gest.wc.getURL())
    await waitFor(() => !gest.wc.isLoading())
    await sleep(300)
    const hitsBefore = watchHits.length
    void hitsBefore
    const reloads = await inPage<number>(gest.wc, `(performance.getEntriesByType('navigation')[0]?.type === 'reload') ? 1 : 0`)
    await drawGesture(gest.wc, [400, 400], [400, 350], [400, 300], [400, 350], [400, 400], [400, 450])
    check('gestures: up then down reloads the page', (await waitFor(async () => (await inPage<number>(gest.wc, `(performance.getEntriesByType('navigation')[0]?.type === 'reload') ? 1 : 0`)) === 1)) && reloads === 0)
    await waitFor(() => !gest.wc.isLoading())
    await sleep(300)
    const tabsNow = store.get().tabs.length
    await drawGesture(gest.wc, [400, 300], [400, 350], [400, 400], [400, 450])
    check('gestures: a stroke down asks for a new tab (the command bar opens)', await waitFor(() => browser.currentPanel() === 'commandbar'))
    browser.closeOverlay()
    check('gestures: ...and opens none by itself', store.get().tabs.length === tabsNow)
    await drawGesture(gest.wc, [400, 300], [430, 300], [400, 320], [380, 280], [420, 330])
    // A fixed wait, for want of a witness: the verdict on a shape reaches the shell as a line of the page's console, and what it would start (a
    // navigation) shows only when it lands.
    await sleep(500)
    check('gestures: a shape that means nothing does nothing, and no menu opens either', gest.wc.getURL().includes('geste-b') && browser.currentPanel() === null)

    // A right click that does not move opens the menu of the page, as it always did.
    const menusBefore = popups.length
    mouse(gest.wc, 'mouseMove', 400, 300)
    mouse(gest.wc, 'mouseDown', 400, 300, 'right')
    // Chromium asks for the menu when the button goes down (on this system) or up: either way the menu waits for the verdict of the script.
    gest.wc.emit('context-menu', {}, { linkURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 400, y: 300, misspelledWord: '', dictionarySuggestions: [], frame: gest.wc.mainFrame })
    const heldOpen = popups.length
    mouse(gest.wc, 'mouseUp', 400, 300, 'right')
    check('gestures: a right click that does not move opens the menu of the page', await waitFor(() => popups.length > menusBefore), `${popups.length - menusBefore} menus`)
    check('gestures: ...but only once the button is released', heldOpen === menusBefore, `${heldOpen - menusBefore} before the release`)
    const menu = popups.at(-1) ?? []
    check('gestures: ...with the entry that leaves this site out of the gestures', menu.includes('Désactiver les gestes de souris sur ce site'), menu.join(' | '))
    menus.at(-1)!.items.find((i) => i.label === 'Désactiver les gestes de souris sur ce site')?.click({} as never, undefined, undefined)
    check('gestures: choosing it puts the site in the list of those left out, and says so', store.get().settings.mouseGestureExcludedHosts.includes('127.0.0.1') && toastNow().includes('127.0.0.1'), JSON.stringify(store.get().settings.mouseGestureExcludedHosts))
    check('gestures: ...and the tool leaves the page', await waitFor(async () => (await toolsInstalled(gest.wc)).length === 0))
    await drawGesture(gest.wc, [500, 300], [450, 300], [400, 300], [350, 300])
    // No wait: a stroke is read only by the tool of the page, which has left it (waited for above, and read again here).
    check('gestures: on a site left out, a stroke goes nowhere', (await toolsInstalled(gest.wc)).length === 0 && gest.wc.getURL().includes('geste-b'))
    set({ mouseGestureExcludedHosts: [] })
    check('gestures: taking the site out of the list brings them back', await waitFor(async () => (await toolsInstalled(gest.wc)).includes('mouseGestures')))

    // A menu that is held must come out even if the script never answers (a frame we have no script in, a page that froze).
    const menusSilent = popups.length
    mouse(gest.wc, 'mouseMove', 400, 300)
    mouse(gest.wc, 'mouseDown', 400, 300, 'right')
    await inTools(gest.wc, `self.__lucium_tools.mouseGestures.off(); delete self.__lucium_tools.mouseGestures`)
    gest.wc.emit('context-menu', {}, { linkURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 400, y: 300, misspelledWord: '', dictionarySuggestions: [], frame: gest.wc.mainFrame })
    mouse(gest.wc, 'mouseUp', 400, 300, 'right')
    check('gestures: a menu held for a gesture opens anyway if the page never says what the gesture was', await waitFor(() => popups.length > menusSilent, 3000), `${popups.length - menusSilent} menus`)
    set({ mouseGestures: false })
    check('gestures: switching them off takes the tool out of the page', await waitFor(async () => (await toolsInstalled(gest.wc)).length === 0))
    const menusOff = popups.length
    gest.wc.emit('context-menu', {}, { linkURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 400, y: 300, misspelledWord: '', dictionarySuggestions: [], frame: gest.wc.mainFrame })
    check('gestures: off, the menu of the page opens at once and has no entry about them', popups.length === menusOff + 1 && !(popups.at(-1) ?? []).some((label) => label.includes('gestes de souris')), (popups.at(-1) ?? []).join(' | '))
    browser.dispatch({ type: 'tab/close', id: gest.id })

    // ================================================================= page watching
    browser.setPageWatchGap(300)
    const watchSession = session.fromPartition('persist:profile-default')
    await watchSession.cookies.set({ url: base, name: 'who', value: 'profile' })
    const watched = await open('/watch')
    check('watch: off, the File menu has no "Surveiller cette page" (Arc\'s menu)', findMenuItem('Surveiller cette page') === undefined)
    await browser.watchPage(false)
    check('watch: ...and asking watches nothing', store.get().settings.pageWatches.length === 0)
    check('watch: ...and no timer is armed', !browser.pageWatchArmed())
    set({ pageWatch: true })
    // No wait: the watcher is told of the setting as it changes, and arms its timer then or not at all (page-watch.ts).
    check('watch: on, no page is watched yet and still no timer is armed (zero cost without a watch)', !browser.pageWatchArmed())
    const watchItem = findMenuItem('Surveiller cette page')
    check('watch: on, the File menu offers "Surveiller cette page" and "Surveiller une zone de la page…"', watchItem !== undefined && findMenuItem('Surveiller une zone de la page…') !== undefined)
    const liveBefore = browser.livePageIds().length
    watchItem?.click({} as never, undefined, undefined)
    check('watch: choosing it adds the page to the list, hourly at first', await waitFor(() => store.get().settings.pageWatches.length === 1), JSON.stringify(store.get().settings.pageWatches))
    const added = store.get().settings.pageWatches[0]!
    check('watch: ...with its address, its title and the profile of its space', added.url === `${base}/watch` && added.title === 'Surveillée' && added.profileId === 'default' && added.minutes === 60, JSON.stringify(added))
    check('watch: ...and a notice says so', /surveillée/i.test(toastNow()), toastNow())
    watchItem?.click({} as never, undefined, undefined)
    check('watch: the same page is not watched twice', store.get().settings.pageWatches.length === 1 && /déjà surveillée/.test(toastNow()), toastNow())
    check('watch: the schedule arms its timer for the first look', browser.pageWatchArmed())
    const first = await waitFor(() => store.get().settings.pageWatches[0]?.hash !== undefined, 20_000)
    check('watch: the first look records what the page shows, without a notice', first && notices.length === 0, JSON.stringify(store.get().settings.pageWatches[0]))
    check('watch: ...with the cookies of the profile (the page was loaded with its session)', sawProfileCookie)
    check('watch: ...in a view nobody sees: no page was added to the window, and none is left reading', browser.livePageIds().length === liveBefore && !isReading(), `${browser.livePageIds().length} against ${liveBefore}`)
    check('watch: ...and no tab was opened for it', store.get().tabs.filter((t) => t.url.includes('/watch')).length === 1)

    await waitFor(() => !browser.pageWatchBusy(), 20_000)
    const hashFirst = store.get().settings.pageWatches[0]!.hash
    // Due again at once: the stored date is moved back (the interval itself cannot be below five minutes). Only between two looks: a look
    // that is under way would write its own date over it.
    const makeDue = async () => {
      await waitFor(() => !browser.pageWatchBusy(), 20_000)
      set({ pageWatches: store.get().settings.pageWatches.map((w) => ({ ...w, checkedAt: 0 })) })
    }
    /** Waits for the look that follows `makeDue` to end: the page was fetched, and the list has a date again. */
    const lookEnded = async (hitsBefore: number) => {
      await waitFor(() => watchHits.length > hitsBefore, 20_000)
      return waitFor(() => !browser.pageWatchBusy() && (store.get().settings.pageWatches[0]?.checkedAt ?? 0) > 0, 20_000)
    }
    const hitsSame = watchHits.length
    await makeDue()
    const sameEnded = await lookEnded(hitsSame)
    check('watch: a look at a page that did not change tells no one', sameEnded && notices.length === 0 && store.get().settings.pageWatches[0]!.hash === hashFirst && store.get().settings.pageWatches[0]!.changedAt === undefined, JSON.stringify(store.get().settings.pageWatches[0]))
    watchText = 'prix 8'
    const hitsChanged = watchHits.length
    await makeDue()
    check('watch: a page that changed is announced to the system, by its name and not by its text', (await waitFor(() => notices.length === 1, 30_000)) && notices[0]!.title === 'Page modifiée' && notices[0]!.body === 'Surveillée' && !JSON.stringify(notices).includes('prix'), `${JSON.stringify(notices)} ${JSON.stringify(store.get().settings.pageWatches[0])} hits=${watchHits.length - hitsChanged}`)
    await lookEnded(hitsChanged)
    check('watch: ...and the list records when', store.get().settings.pageWatches[0]?.hash !== hashFirst && (store.get().settings.pageWatches[0]?.changedAt ?? 0) > 0, JSON.stringify(store.get().settings.pageWatches[0]))

    // A zone of the page: only what is inside it counts.
    await waitFor(() => !browser.pageWatchBusy(), 20_000)
    set({ pageWatches: [] })
    await sleep(100)
    const zone = { id: 'zone-1', url: `${base}/watch`, title: 'La zone', profileId: 'default', minutes: 5, selector: '#zone' }
    set({ pageWatches: [zone] })
    await waitFor(() => store.get().settings.pageWatches[0]?.hash !== undefined, 20_000)
    const zoneHash = store.get().settings.pageWatches[0]!.hash
    check('watch: a zone of the page is watched on its own text', zoneHash !== undefined && zoneHash !== hashFirst)
    // A missing zone is a failure that the list says, not a silence.
    await waitFor(() => !browser.pageWatchBusy(), 20_000)
    set({ pageWatches: [{ ...zone, id: 'zone-2', selector: '#absente' }] })
    await waitFor(() => store.get().settings.pageWatches[0]?.failure !== undefined, 20_000)
    check('watch: a zone that is not in the page is a failure the list says', /n’existe plus/.test(store.get().settings.pageWatches[0]?.failure ?? ''), String(store.get().settings.pageWatches[0]?.failure))
    // A page that does not answer.
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as AddressInfo).port
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    await waitFor(() => !browser.pageWatchBusy(), 20_000)
    set({ pageWatches: [{ id: 'dead-1', url: `http://127.0.0.1:${deadPort}/`, title: 'Morte', profileId: 'default', minutes: 5 }] })
    await waitFor(() => store.get().settings.pageWatches[0]?.failure !== undefined, 30_000)
    check('watch: a page that cannot be loaded is a failure the list says, and nothing is announced', /pas pu être chargée/.test(store.get().settings.pageWatches[0]?.failure ?? '') && notices.length === 1, String(store.get().settings.pageWatches[0]?.failure))
    // A profile that is gone.
    await waitFor(() => !browser.pageWatchBusy(), 20_000)
    set({ pageWatches: [{ id: 'gone-1', url: `${base}/watch`, title: 'Sans profil', profileId: 'disparu', minutes: 5 }] })
    await waitFor(() => store.get().settings.pageWatches[0]?.failure !== undefined, 10_000)
    check('watch: a page whose profile is gone is a failure the list says, without loading anything', /profil/.test(store.get().settings.pageWatches[0]?.failure ?? ''))
    // Not the web.
    set({ pageWatches: [{ id: 'file-1', url: 'file:///etc/hosts', title: 'Fichier', profileId: 'default', minutes: 5 }] })
    check('watch: a file cannot be put in the list, whoever asks', store.get().settings.pageWatches.length === 0)
    const readFile = await engine.readPageText('default', 'file:///etc/hosts', { settleMs: 0 })
    check('watch: ...and the engine refuses to read it', !readFile.ok, JSON.stringify(readFile))
    const ephemeral = engine.openEphemeral('watch-smoke')
    const readPrivate = await ephemeral.readPageText('default', `${base}/watch`, { settleMs: 0 })
    await ephemeral.dispose()
    check('watch: a private window reads no page for watching', !readPrivate.ok && /privée/.test((readPrivate as { error: string }).error), JSON.stringify(readPrivate))
    // Off again: the timer goes, the list stays.
    set({ pageWatches: [{ ...zone, id: 'zone-3' }] })
    await waitFor(() => browser.pageWatchArmed())
    set({ pageWatch: false })
    // No wait: the watcher is told of the setting as it changes, and drops its timer then (page-watch.ts).
    check('watch: switching it off drops the timer and keeps the list', !browser.pageWatchArmed() && store.get().settings.pageWatches.length === 1)
    set({ pageWatches: [] })
    browser.setPageWatchGap(15_000)
    browser.dispatch({ type: 'tab/close', id: watched.id })

    // ================================================================= reading aloud
    const reader = await open('/article')
    // The reader is a cover whose document is a data address in base64 (engine/page-cover.ts `coverUrl`, the only form it makes): its text is read decoded,
    // and the cover is told by the title it carries, the article's.
    const coverText = (url: string): string => {
      const comma = url.indexOf(',')
      if (!url.startsWith('data:text/html') || comma < 0 || !url.slice(0, comma).endsWith(';base64')) return ''
      return Buffer.from(url.slice(comma + 1), 'base64').toString('utf8')
    }
    const coverOf = (): WebContents | undefined => allWebContents.getAllWebContents().find((c) => !c.isDestroyed() && coverText(c.getURL()).includes('<title>Un article</title>'))
    await browser.toggleReader()
    await waitFor(() => coverOf() !== undefined)
    await sleep(300)
    const coverOff = coverOf()
    check('read aloud: off, the reader has no button to read aloud and one script, the pill\'s', coverOff !== undefined && (await coverOff.executeJavaScript(`document.querySelector('.listen') === null && document.scripts.length === 1 && !!document.querySelector('.rp')`)))
    await browser.toggleReader()
    await waitFor(() => coverOf() === undefined)
    set({ readAloud: true })
    await sleep(100)
    await browser.toggleReader()
    await waitFor(() => coverOf() !== undefined)
    await sleep(500)
    const cover = coverOf()
    const visible = cover ? await cover.executeJavaScript(`(() => { const b = document.querySelector('.listen'); return !!b && !b.hidden && !document.getElementById('listen-play').hidden && document.getElementById('listen-pause').hidden })()`) : false
    check('read aloud: on, the reader shows "Lire à voix haute" in its header', visible === true)
    check('read aloud: ...with a second script besides the pill one, and a policy that allows those scripts and no other', cover !== undefined && (await cover.executeJavaScript(`document.scripts.length === 2 && /script-src 'nonce-/.test(document.querySelector('meta[http-equiv]').content)`)) === true)
    const voices = cover ? await cover.executeJavaScript(`speechSynthesis.getVoices().length`) : 0
    if (cover && voices > 0) {
      await cover.executeJavaScript(`document.getElementById('listen-play').click()`, true)
      const speaking = await waitFor(async () => (await cover.executeJavaScript(`speechSynthesis.speaking || speechSynthesis.pending`)) === true, 4000)
      check('read aloud: the button makes the system\'s voice read the article', speaking)
      check('read aloud: ...and "Pause" and "Arrêter" take its place', (await cover.executeJavaScript(`document.getElementById('listen-play').hidden && !document.getElementById('listen-pause').hidden && !document.getElementById('listen-stop').hidden`)) === true)
      await cover.executeJavaScript(`document.getElementById('listen-stop').click()`, true)
      check('read aloud: "Arrêter" silences it', await waitFor(async () => (await cover.executeJavaScript(`!speechSynthesis.speaking && !speechSynthesis.pending`)) === true, 3000))
    } else {
      check('read aloud: the button makes the system\'s voice read the article', true, skippedBecause(`this system lists no voice (${voices}): the buttons are checked, the voice is not`))
    }
    await browser.toggleReader()
    await waitFor(() => coverOf() === undefined)
    // The selection, from the page menu.
    await inPage(reader.wc, `getSelection().selectAllChildren(document.querySelector('article p'))`)
    const selectionParams = { linkURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText: 'Voici une phrase assez longue.', x: 5, y: 5, misspelledWord: '', dictionarySuggestions: [], frame: reader.wc.mainFrame }
    reader.wc.emit('context-menu', {}, selectionParams)
    check('read aloud: the menu of a selected text offers "Lire la sélection à voix haute"', (popups.at(-1) ?? []).includes('Lire la sélection à voix haute'), (popups.at(-1) ?? []).join(' | '))
    if (voices > 0) {
      menus.at(-1)!.items.find((i) => i.label === 'Lire la sélection à voix haute')!.click({} as never, undefined, undefined)
      check('read aloud: ...and it reads the selection in the page', await waitFor(async () => (await inTools<boolean>(reader.wc, `speechSynthesis.speaking || speechSynthesis.pending`)) === true, 4000))
      reader.wc.emit('context-menu', {}, selectionParams)
      check('read aloud: ...then the menu offers to stop', (popups.at(-1) ?? []).includes('Arrêter la lecture à voix haute'))
      menus.at(-1)!.items.find((i) => i.label === 'Arrêter la lecture à voix haute')!.click({} as never, undefined, undefined)
      check('read aloud: ...and it stops', await waitFor(async () => (await inTools<boolean>(reader.wc, `!speechSynthesis.speaking && !speechSynthesis.pending`)) === true, 3000))
    } else check('read aloud: ...and it reads the selection in the page', true, skippedBecause(`this system lists no voice (${voices})`))
    set({ readAloud: false })
    reader.wc.emit('context-menu', {}, selectionParams)
    check('read aloud: off, the menu of a selected text is Arc\'s', !(popups.at(-1) ?? []).some((label) => label.includes('voix haute')))
    browser.dispatch({ type: 'tab/close', id: reader.id })

    // ================================================================= the battery saver
    const anim = await open('/anim')
    // The boxes run two animations (a turn of 1 s and a pulse of 0.7 s); the mode makes both last a thousandth of a second.
    const ANIMATED = '1s, 0.7s'
    const animationOf = () => inPage<string>(anim.wc, `getComputedStyle(document.querySelector('.b')).animationDuration`)
    check('battery: off, the menu has no such entry (Arc\'s menu) and the pages animate as they do', findMenuItem('Mode économie de batterie') === undefined && (await animationOf()) === ANIMATED)
    browser.setBatterySaverAsked(true)
    check('battery: off, asking for it does nothing', !browser.powerSaving() && (await animationOf()) === ANIMATED)
    set({ batterySaver: true })
    await sleep(250)
    const saverItem = findMenuItem('Mode économie de batterie')
    check('battery: on, the View menu offers "Mode économie de batterie", unchecked while the battery is not low', saverItem !== undefined && saverItem.checked === false && !browser.powerSaving())
    // What the engine relies on to end the mode: a stylesheet it put in is taken out again (an author sheet; a user-origin one is not, so the
    // mode does not use one: the second check only records what Electron does).
    const durationNow = () => inPage<string>(anim.wc, `getComputedStyle(document.querySelector('.b')).animationDuration`)
    const key = await anim.wc.insertCSS('.b{animation-duration:3s!important}')
    const inserted = await durationNow()
    await anim.wc.removeInsertedCSS(key)
    await sleep(100)
    const removed = await durationNow()
    check('engine: an author stylesheet put in with insertCSS goes away with removeInsertedCSS', inserted === '3s' && removed === ANIMATED, `inserted: ${inserted}, after removal: ${removed}`)
    const animPage = browser.pageFor(anim.id)!
    animPage.applyCss('.b{animation-duration:3s!important}', 'saver')
    const viaPage = await waitFor(async () => (await durationNow()) === '3s', 3000)
    animPage.applyCss('', 'saver')
    const viaPageBack = await waitFor(async () => (await durationNow()) === ANIMATED, 3000)
    check('engine: the stylesheet of the saver slot goes away again with applyCss(\'\', \'saver\')', viaPage && viaPageBack, `then: ${await durationNow()}`)
    const scratch = await open('/anim?scratch=1')
    const userKey = await scratch.wc.insertCSS('.b{animation-duration:3s!important}', { cssOrigin: 'user' })
    await scratch.wc.removeInsertedCSS(userKey)
    await sleep(100)
    const userLeft = await inPage<string>(scratch.wc, `getComputedStyle(document.querySelector('.b')).animationDuration`)
    // A measurement, not a check: what this Electron does of a user-origin stylesheet goes to the report of the run.
    console.log(`[smoke-webtools] a user-origin stylesheet is ${userLeft === ANIMATED ? 'taken out' : 'NOT taken out'} by removeInsertedCSS in this Electron (after removal: ${userLeft})`)
    reportFact('removeInsertedCssTakesUserStylesheetOut', userLeft === ANIMATED)
    browser.dispatch({ type: 'tab/close', id: scratch.id })
    browser.dispatch({ type: 'tab/select', id: anim.id })
    await sleep(300)
    // The CPU of the animated page, without the mode and with it (the same page, the same 600 animated boxes): the page's renderer, the GPU
    // process and the browser process, because a stylesheet that stops animations saves work in all three.
    const cpuOf = async (wc: WebContents, ms: number): Promise<{ page: number; gpu: number; browser: number; total: number }> => {
      const pid = wc.getOSProcessId()
      const read = () => {
        const metrics = app.getAppMetrics()
        const sum = (pick: (m: (typeof metrics)[number]) => boolean) => metrics.filter(pick).reduce((total, m) => total + m.cpu.percentCPUUsage, 0)
        const page = sum((m) => m.pid === pid)
        const gpu = sum((m) => m.type === 'GPU')
        const browserProcess = sum((m) => m.type === 'Browser')
        return { page, gpu, browser: browserProcess, total: page + gpu + browserProcess }
      }
      read()
      await sleep(ms)
      return read()
    }
    const cpuText = (cpu: { page: number; gpu: number; browser: number; total: number }) => `${cpu.total.toFixed(1)} % (page ${cpu.page.toFixed(1)}, GPU ${cpu.gpu.toFixed(1)}, browser ${cpu.browser.toFixed(1)})`
    await sleep(1500)
    const cpuBefore = await cpuOf(anim.wc, 5000)
    saverItem?.click({} as never, undefined, undefined)
    check('battery: choosing it turns the mode on, and a notice says so', await waitFor(() => browser.powerSaving()) && /activé/.test(toastNow()), toastNow())
    check('battery: the animations of the open page stop (they run once, in a thousandth of a second)', await waitFor(async () => (await animationOf()) === '0.001s'), await animationOf())
    await sleep(1500)
    const cpuAfter = await cpuOf(anim.wc, 5000)
    // A measurement, not a check: the processor depends on the machine and on what else it does, so no threshold is set here (`pnpm perf` has the budget).
    console.log(`[smoke-webtools] battery: CPU with 600 animated boxes on screen: ${cpuText(cpuBefore)} without the mode, ${cpuText(cpuAfter)} with it (5 s each)`)
    reportFact('batterySaverCpu', { before: cpuBefore, after: cpuAfter })
    void anim.wc.loadURL(`${base}/anim?again=1`)
    await waitFor(() => !anim.wc.isLoading())
    check('battery: a page loaded while the mode is on gets the same stylesheet', await waitFor(async () => (await animationOf()) === '0.001s'))
    check('battery: the menu entry is checked while it is asked for', findMenuItem('Mode économie de batterie')?.checked === true)
    // Tabs that reload themselves are stopped, and start again.
    browser.dispatch({ type: 'tab/auto-reload', id: anim.id, seconds: 30 })
    // No wait: the countdowns are set again as the state changes (auto-reload.ts, `refresh`).
    check('battery: the tab that reloads itself has no countdown while the mode is on', browser.autoReloadState(anim.id).at === null)
    findMenuItem('Mode économie de batterie')?.click({} as never, undefined, undefined)
    const offNow = await waitFor(() => !browser.powerSaving())
    const backNow = await waitFor(async () => (await animationOf()) === ANIMATED)
    check('battery: asking again turns it off, and the animations come back', offNow && backNow, `off: ${offNow}, animation: ${await animationOf()}`)
    check('battery: ...and the countdown of the tab that reloads itself starts again', await waitFor(() => browser.autoReloadState(anim.id).at !== null))
    // By itself: on battery, at 20 % or below, whatever the machine this runs on is doing.
    plug(true, 60)
    // The stand-in power answers the charge at once: the saver has read it and decided once the promises of this turn have run.
    await new Promise<void>((resolve) => setImmediate(resolve))
    check('battery: on battery with more than 20 % left, the mode stays off', !browser.powerSaving())
    plug(true, 15)
    check('battery: ...and it comes on by itself when the charge falls to 20 % or below, the animations stopping', (await waitFor(() => browser.powerSaving())) && (await waitFor(async () => (await animationOf()) === '0.001s')))
    check('battery: ...with the menu entry not checked (it was not asked for by hand)', findMenuItem('Mode économie de batterie')?.checked === false)
    plug(false, 15)
    const unplugged = await waitFor(() => !browser.powerSaving())
    const animatedAgain = await waitFor(async () => (await animationOf()) === ANIMATED)
    check('battery: plugged in again, it ends by itself', unplugged && animatedAgain, `off: ${unplugged}, animation: ${await animationOf()}`)
    browser.dispatch({ type: 'tab/auto-reload', id: anim.id, seconds: null })
    set({ batterySaver: false })
    await sleep(150)
    browser.setBatterySaverAsked(true)
    check('battery: switching the setting off forgets the request', !browser.powerSaving() && findMenuItem('Mode économie de batterie') === undefined)
    browser.dispatch({ type: 'tab/close', id: anim.id })
  } finally {
    restorePower()
    Menu.prototype.popup = realPopup
    restoreNotices()
    browser.setPageWatchGap(15_000)
    for (const id of mine) if (store.get().tabs.some((t) => t.id === id)) browser.dispatch({ type: 'tab/close', id })
    browser.dispatch({ type: 'settings/update', patch: Object.fromEntries(Object.keys(tools).map((key) => [key, (original as unknown as Record<string, unknown>)[key]])) as never })
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: original.sleepAfterMinutes } })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=webtools`: only these checks, with their own report. */
export async function runWebToolsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeWebTools(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeWebTools ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_WEBTOOLS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
