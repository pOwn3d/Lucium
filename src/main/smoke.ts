// Engine contract test, run inside a real Electron: `pnpm test:engine`.
// This is the safety net for Chromium upgrades: bump Electron, run it, read the report.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow as ElectronWindow, clipboard, Menu, nativeTheme, webContents as allWebContents, type BrowserWindow, type MenuItem, type WebContentsView } from 'electron'
import { hexToHsl } from '@shared/theme'
import { adsBlockingPatch } from '@shared/privacy-dashboard'
import { littleForms } from '@shared/little-name'
import { Channel, type UiSnapshot } from '@shared/ipc'
import type { ElectronEngine } from './engine/electron-engine'
import type { HistoryBook } from './history'
import type { Browser } from './shell/browser'
import { loadIcon } from './shell/app-icon'
import { smokeCommandBar } from './smoke-commandbar'
import { smokeSettings } from './smoke-settings'
import { smokePages } from './smoke-pages'
import { smokeSleep } from './smoke-sleep'
import { smokeIsoMenus } from './smoke-iso-menus'
import { smokeSidebar } from './smoke-sidebar'
import { smokeIsoSidebar } from './smoke-iso-sidebar'
import { smokeIsoSettings } from './smoke-iso-settings'
import { smokeIsoToolbar } from './smoke-iso-toolbar'
import { smokeIsoPlus } from './smoke-iso-plus'
import { smokeSec2 } from './smoke-sec2'
import { smokeSec1 } from './smoke-sec1'
import { smokeIsoMedia } from './smoke-iso-media'
import { menuItems } from './shell/context-menus'
import type { LittleArc } from './shell/little'
import type { StateStore } from './store'
import { checkExtensionFolder, readSkips, recorderOf, reportFact, requireProbes, skippedBecause, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { SETTINGS_CATEGORIES } from '@shared/settings-catalog'

interface Check {
  name: string
  ok: boolean
  detail?: string
}


const waitFor = waiterOf(10_000, 100)

export interface SmokeContext {
  browser: Browser
  store: StateStore
  engine: ElectronEngine
  history: HistoryBook
  win: BrowserWindow
  overlayView: WebContentsView
  little: LittleArc
}

export async function runEngineSmoke(
  { browser, store, engine, history, win, overlayView, little }: SmokeContext,
  extensionPaths: string[]
): Promise<number> {
  const checks: Check[] = []
  // Each check is written to the log as it is made (smoke-kit.ts): a step that never returns leaves its last check to read.
  const note = recorderOf(checks)
  // LUCIUM_SMOKE_STOP_AFTER=<words of a check> ends the run (code 3) right after the first check whose name has them: a loop on one step of a long suite.
  const stopAfter = process.env['LUCIUM_SMOKE_STOP_AFTER']
  const check = (name: string, ok: boolean, detail?: string) => {
    note(name, ok, detail)
    if (stopAfter && name.includes(stopAfter)) {
      console.log(`[smoke] stopped after "${name}"`)
      setTimeout(() => app.exit(3), 300)
    }
  }

  let cookieLoads = 0
  let thirdPartyHits = 0
  let firstPartyHits = 0
  let blockedScriptHits = 0
  let allowedScriptHits = 0
  const server = createServer((req, res) => {
    if (req.url === '/download-messy') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="Smoke_Report_v2 (1).BIN"')
      return res.end(Buffer.alloc(512, 2))
    }
    if (req.url === '/ad-page') {
      res.setHeader('content-type', 'text/html')
      // A third-party script (another host name for this machine) and a first-party one as the control.
      return res.end(`<title>smoke /ad-page</title><body>ok<script src="http://localhost:${(server.address() as AddressInfo).port}/third-party-ad.js"></script><script src="/first-party.js"></script></body>`)
    }
    if (req.url === '/third-party-ad.js') {
      thirdPartyHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    if (req.url === '/first-party.js') {
      firstPartyHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    if (req.url === '/download') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="smoke.bin"')
      return res.end(Buffer.alloc(2048, 1))
    }
    if (req.url === '/find') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>smoke /find</title><body>needle one, needle two, needle three</body>')
    }
    if (req.url === '/boost') {
      res.setHeader('content-type', 'text/html')
      // Reports what the Tweak did to this document, once it has finished loading.
      return res.end(`<title>boost-pending</title><body>x<script>addEventListener('load', () => setTimeout(() => {
        document.title = 'boost:' + getComputedStyle(document.body).color + ':' + (document.documentElement.dataset.boosted || 'no')
      }, 300))</script></body>`)
    }
    if (req.url === '/pip') {
      res.setHeader('content-type', 'text/html')
      // A silent canvas stream is a video that plays without any media file.
      return res.end(`<title>smoke /pip</title><body><video id="v" muted autoplay playsinline width="320" height="180"></video><canvas id="c" width="320" height="180"></canvas>
        <script>const c = document.getElementById('c'); const g = c.getContext('2d'); setInterval(() => { g.fillStyle = 'hsl(' + (Date.now() / 20 % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180) }, 50)
        const v = document.getElementById('v'); v.onpause = () => { document.title = 'smoke /pip paused' }; v.srcObject = c.captureStream(20); v.play()</script></body>`)
    }
    if (req.url === '/tall') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>smoke /tall</title><body style="margin:0"><div style="height:3000px;background:linear-gradient(red,blue)"></div></body>')
    }
    if (req.url === '/zap') {
      res.setHeader('content-type', 'text/html')
      // Reports what a Tweak does to it, and clicks #ad over and over: the Eraser picker only listens while it is active.
      return res.end(`<title>zap-pending</title><body><div id="ad">AD</div><p>content</p><script>
        const ad = document.getElementById('ad')
        setInterval(() => { document.title = 'zap:' + getComputedStyle(ad).display + ':' + Math.round(window.devicePixelRatio * 100) }, 150)
        setInterval(() => { if (getComputedStyle(ad).display !== 'none') { ad.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); ad.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) } }, 200)
      </script></body>`)
    }
    if (req.url === '/cookie') {
      cookieLoads++
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>cookie-pending</title><script>document.title = 'seen:' + document.cookie; document.cookie = 'k=v; path=/'</script>`)
    }
    if (req.url === '/theme') {
      res.setHeader('content-type', 'text/html')
      // Declares a colour, and reports the space palette a site can read (empty unless the user allowed it).
      return res.end(`<title>theme-pending</title><meta name="theme-color" content="#336699"><body>x<script>
        setInterval(() => { document.title = 'theme:' + getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-background').trim() }, 150)
      </script></body>`)
    }
    if (req.url === '/dbg' || req.url === '/panel') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>smoke ${req.url}</title><body>probe target</body>`)
    }
    if (req.url === '/geo') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>smoke /geo</title><body><script>navigator.geolocation.getCurrentPosition(() => {}, () => {})</script></body>')
    }
    if (req.url === '/probe-allowed.js') {
      allowedScriptHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    if (req.url === '/probe-blocked.js') {
      blockedScriptHits++
      res.setHeader('content-type', 'text/javascript')
      return res.end('')
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<title>smoke ${req.url}</title><body>ok<script src="/probe-allowed.js"></script><script src="/probe-blocked.js"></script></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const consoleEntries = new Map<string, number>()
  const probes: unknown[] = []
  engine.onExtensionConsole((entry) => {
    if (entry.message.startsWith('API_PROBE ')) {
      probes.push(JSON.parse(entry.message.slice('API_PROBE '.length)))
      return
    }
    const key = `${entry.level}: ${entry.message.slice(0, 700)} (${entry.sourceUrl.split('/').slice(-2).join('/')})`
    consoleEntries.set(key, (consoleEntries.get(key) ?? 0) + 1)
  })

  const info = engine.info()
  check('engine reports a Chromium version', /^\d+\.\d+\.\d+\.\d+$/.test(info.chromium), `${info.name} ${info.version} / Chromium ${info.chromium}`)

  let dnrEnforced: boolean | null = null
  let dnrControlHits: number | null = null
  /** What a step cannot go on without (a tab, a window, a menu entry): when it is missing, the reason is a failed check of its own before the block stops. */
  const must = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) {
      check(`${what} is there`, false)
      throw new Error(`${what} is missing`)
    }
    return value
  }
  // The checks of the suite itself, up to its parts. A step that throws ends this block with one failed check (and its stack); the parts and the
  // report still come, on the state the block left.
  try {

  browser.dispatch({ type: 'tab/open', url: `${base}/one` })
  const first = must(store.get().tabs.at(-1), 'the tab opened first')
  check('page loads and its title reaches the state', await waitFor(() => store.get().tabs.find((t) => t.id === first.id)?.title === 'smoke /one'))

  browser.dispatch({ type: 'tab/pin', id: first.id })
  check('pinning keeps an anchor URL', store.get().tabs.find((t) => t.id === first.id)?.anchorUrl === `${base}/one`)

  browser.dispatch({ type: 'tab/open', url: `${base}/two` })
  const second = must(store.get().tabs.at(-1), 'the second tab')
  check('opening a tab selects it and keeps the other page alive', browser.livePageIds().includes(first.id) && store.get().activeTabBySpace[second.spaceId] === second.id)

  // Sleeping: a tab left for longer than the delay loses its view, the visible one keeps it.
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0.001 } })
  await sleep(300)
  await browser.sleepSweep()
  check('idle tabs are put to sleep, the visible tab stays awake', !browser.livePageIds().includes(first.id) && browser.livePageIds().includes(second.id))
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
  browser.dispatch({ type: 'tab/select', id: first.id })
  check('selecting a sleeping tab wakes it', browser.livePageIds().includes(first.id))
  browser.dispatch({ type: 'tab/select', id: second.id })

  browser.dispatch({ type: 'tab/close', id: first.id })
  const sleeping = store.get().tabs.find((t) => t.id === first.id)
  check('closing a pinned tab sleeps it (tab kept, view destroyed)', !!sleeping && !browser.livePageIds().includes(first.id))

  browser.dispatch({ type: 'tab/close', id: second.id })
  check('closing a Today tab removes it', !store.get().tabs.some((t) => t.id === second.id))

  check('visited pages reach the history', await waitFor(() => history.of('default').search('smoke /one').length > 0))

  // Find in page: three occurrences of "needle".
  browser.dispatch({ type: 'tab/open', url: `${base}/find` })
  await waitFor(() => store.get().tabs.some((t) => t.title === 'smoke /find'))
  // The search targets the active page: make sure the page just opened is the one on screen.
  await waitFor(() => store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.title === 'smoke /find')
  browser.openOverlay({ panel: 'find' })
  browser.findInPage('needle', {})
  check('find in page counts the matches', await waitFor(() => browser.snapshot().find?.matches === 3), `find=${JSON.stringify(browser.snapshot().find)} active=${store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.url}`)
  browser.closeOverlay()
  check('closing the find bar clears the search', browser.snapshot().find === null && browser.currentPanel() === null)

  // Mute: the page stays alive, only its audio state flips.
  const findTab = store.get().tabs.find((t) => t.title === 'smoke /find')!
  browser.toggleMute(findTab.id)
  check('a tab can be muted', browser.snapshot().runtime.tabs[findTab.id]?.muted === true)

  // Publication: the state goes to the interface once per turn of the event loop, and what is shown over it comes after it (see shell/publish-queue.ts).
  {
    // The snapshot goes to the window; what is shown over it (`showOverlay`) goes to the overlay's own page: both are listened to, in one list.
    const wcs = [win.webContents, overlayView.webContents]
    const sent: Array<{ channel: string; to: string; title?: string }> = []
    for (const wc of wcs) {
      const realSend = wc.send.bind(wc)
      wc.send = ((channel: string, ...args: unknown[]) => {
        const title = channel === Channel.snapshot ? (args[0] as UiSnapshot).state.tabs.find((t) => t.id === findTab.id)?.title : undefined
        sent.push({ channel, to: wc === win.webContents ? 'window' : 'overlay', ...(title !== undefined ? { title } : {}) })
        return realSend(channel, ...args)
      }) as typeof wc.send
    }
    try {
      const retitle = (title: string) => browser.dispatch({ type: 'tab/update', id: findTab.id, patch: { title } })
      retitle('turn 1')
      retitle('turn 2')
      const insideTurn = sent.length
      await Promise.resolve()
      await Promise.resolve()
      const snapshots = sent.filter((m) => m.channel === Channel.snapshot && m.to === 'window')
      check('two changes made in one turn send one snapshot, after the turn, with the last state', insideTurn === 0 && snapshots.length === 1 && snapshots[0]?.title === 'turn 2', JSON.stringify({ insideTurn, sent }))
      sent.length = 0
      retitle('turn 3')
      browser.openOverlay({ panel: 'find' })
      await Promise.resolve()
      await Promise.resolve()
      check('a panel shown in the same turn as a change is told after the snapshot that holds it', sent[0]?.channel === Channel.snapshot && sent.some((m) => m.channel === Channel.showOverlay) && sent.findIndex((m) => m.channel === Channel.showOverlay) > 0, JSON.stringify(sent))
      browser.closeOverlay()
      retitle('smoke /find')
    } finally {
      for (const wc of wcs) delete (wc as unknown as Record<string, unknown>)['send']
    }
  }

  // Permission prompt: a page asks for geolocation, the user refuses and the answer is remembered.
  browser.dispatch({ type: 'tab/open', url: `${base}/geo` })
  const asked = await waitFor(() => browser.currentPanel() === 'permission')
  check('a permission request opens the prompt instead of being granted', asked)
  const overlay = browser.currentOverlay()
  if (overlay?.panel === 'permission') browser.answerPermission(overlay.request.id, false, true)
  check('a refused permission is remembered for the origin', store.get().sitePermissions[base]?.geolocation === 'deny', JSON.stringify(store.get().sitePermissions))

  // Download: an attachment is saved without a dialog and listed.
  browser.dispatch({ type: 'tab/open', url: `${base}/download` })
  const downloaded = await waitFor(() => browser.snapshot().downloads.some((d) => d.state === 'completed'))
  const file = browser.snapshot().downloads[0]
  check('an attachment is downloaded and listed', downloaded && !!file && existsSync(file.path), file?.path.split('/').slice(-2).join('/'))
  check('the blank tab opened by a download link is closed', !store.get().tabs.some((t) => t.url.endsWith('/download')))

  // Split view: two tabs on screen at once, dissolved when one closes.
  browser.dispatch({ type: 'tab/open', url: `${base}/one` })
  browser.dispatch({ type: 'tab/open', url: `${base}/two` })
  const [splitA, splitB] = store.get().tabs.slice(-2)
  browser.dispatch({ type: 'split/create', tabId: splitA!.id, withTabId: splitB!.id })
  await waitFor(() => store.get().tabs.filter((t) => t.id === splitA!.id || t.id === splitB!.id).every((t) => t.title.startsWith('smoke')))
  check('a split view keeps both panes on screen with a live page each', browser.visibleTabIds().length === 2 && browser.visibleTabIds().every((id) => browser.livePageIds().includes(id)))
  browser.dispatch({ type: 'tab/close', id: splitB!.id })
  check('closing a pane dissolves the split view', store.get().splits.length === 0 && browser.visibleTabIds().length === 1)

  // Glance: Shift+click preview, then promote it to a tab.
  browser.openPeek(`${base}/one`)
  check('peek opens a preview panel', browser.currentPanel() === 'peek')
  check('the previewed page reports its title', await waitFor(() => browser.snapshot().peek?.title === 'smoke /one'), String(browser.snapshot().peek?.title))
  const tabsBeforePeek = store.get().tabs.length
  browser.peekAction('open-in-tab')
  check('promoting a peek opens a tab and closes the preview', store.get().tabs.length === tabsBeforePeek + 1 && browser.currentPanel() === null && browser.snapshot().peek === null)
  browser.openPeek(`${base}/two`)
  browser.peekAction('close')
  check('closing a peek opens nothing', store.get().tabs.length === tabsBeforePeek + 1 && browser.snapshot().peek === null)

  // Tweak: CSS and JS declared for the host reach the page.
  const host = new URL(base).hostname
  browser.dispatch({ type: 'boost/save', boost: { id: 'smoke-boost', host, css: 'body { color: rgb(1, 2, 3) !important }', js: "document.documentElement.dataset.boosted = 'yes'" } })
  browser.dispatch({ type: 'tab/open', url: `${base}/boost` })
  const boosted = await waitFor(() => store.get().tabs.some((t) => t.title.startsWith('boost:')))
  check('a boost injects its CSS and runs its script', boosted && store.get().tabs.some((t) => t.title === 'boost:rgb(1, 2, 3):yes'), store.get().tabs.find((t) => t.title.startsWith('boost'))?.title)
  browser.dispatch({ type: 'boost/delete', id: 'smoke-boost' })

  // Picture in Picture: a playing video can be floated, then brought back.
  browser.dispatch({ type: 'tab/open', url: `${base}/pip` })
  await waitFor(() => store.get().tabs.some((t) => t.title === 'smoke /pip'))
  await sleep(800)
  const entered = await browser.pictureInPicture(true)
  check('a playing video enters Picture in Picture', entered)
  check('and leaves it again', entered && (await browser.pictureInPicture(false)))

  // Capture: the visible area, then the whole 3000 px tall document.
  browser.dispatch({ type: 'tab/open', url: `${base}/tall` })
  await waitFor(() => store.get().tabs.some((t) => t.title === 'smoke /tall'))
  await sleep(300)
  const pngSignature = (buf: Buffer | null) => !!buf && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  const visibleShot = await browser.capture(false)
  const fullShot = await browser.capture(true)
  // PNG header: width at bytes 16-19, height at 20-23.
  const heightOf = (buf: Buffer) => buf.readUInt32BE(20)
  check('a visible-area capture is a PNG', pngSignature(visibleShot))
  check('a full-page capture is taller than the viewport', pngSignature(fullShot) && heightOf(fullShot!) >= 3000 && heightOf(fullShot!) > heightOf(visibleShot!), `${visibleShot ? heightOf(visibleShot) : '?'} -> ${fullShot ? heightOf(fullShot) : '?'}`)

  // Region capture: a 200 x 120 selection over the page gives a PNG with that aspect ratio.
  {
    const stageX = store.get().settings.sidebarWidth + 8 + 20
    const region = await browser.captureRegion({ x: stageX, y: 60, width: 200, height: 120 })
    const ok = !!region && region.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    const w = ok ? region!.readUInt32BE(16) : 0
    const h = ok ? region!.readUInt32BE(20) : 0
    check('a region capture is a PNG of the selected size', ok && w >= 200 && Math.abs(w / h - 200 / 120) < 0.02, `${w}x${h}`)
    check('a selection that is not over any page captures nothing', (await browser.captureRegion({ x: 2, y: 2, width: 50, height: 50 })) === null)
  }

  // Several Tweaks on one site stack: one recolours, the other injects a script; both reach the page.
  const hostB = new URL(base).hostname
  browser.dispatch({ type: 'boost/save', boost: { id: 'multi-1', host: hostB, name: 'Texte', css: 'body { color: rgb(9, 8, 7) !important }' } })
  browser.dispatch({ type: 'boost/save', boost: { id: 'multi-2', host: hostB, name: 'Script', js: "document.documentElement.dataset.boosted = 'two'" } })
  browser.dispatch({ type: 'tab/open', url: `${base}/boost` })
  await waitFor(() => store.get().tabs.some((t) => t.title.startsWith('boost:')))
  check('two boosts on the same site both apply', await waitFor(() => store.get().tabs.some((t) => t.title === 'boost:rgb(9, 8, 7):two')), store.get().tabs.find((t) => t.title.startsWith('boost'))?.title)
  browser.dispatch({ type: 'boost/delete', id: 'multi-1' })
  browser.dispatch({ type: 'boost/delete', id: 'multi-2' })

  // Shortcuts: changing one in the settings rebuilds the menu with it.
  const menuItem = (label: string) => Menu.getApplicationMenu()?.items.flatMap((m) => m.submenu?.items ?? []).find((i) => i.label === label)
  const defaultAcc = menuItem('Nouvel onglet…')?.accelerator
  browser.dispatch({ type: 'settings/update', patch: { keyBindings: { newTab: 'CmdOrCtrl+Alt+N' } } })
  check('a remapped shortcut reaches the application menu', await waitFor(() => menuItem('Nouvel onglet…')?.accelerator === 'CmdOrCtrl+Alt+N'), `${defaultAcc} -> ${menuItem('Nouvel onglet…')?.accelerator}`)
  browser.dispatch({ type: 'settings/update', patch: { keyBindings: { newTab: '' } } })
  check('a disabled shortcut leaves the menu item without one', await waitFor(() => !menuItem('Nouvel onglet…')?.accelerator), String(menuItem('Nouvel onglet…')?.accelerator))
  browser.dispatch({ type: 'settings/update', patch: { keyBindings: {} } })
  check('and resetting restores the default', await waitFor(() => menuItem('Nouvel onglet…')?.accelerator === 'CmdOrCtrl+T'))

  // Media: pausing a background tab's video from the sidebar.
  browser.dispatch({ type: 'tab/open', url: `${base}/pip` })
  const pipTab = store.get().tabs.find((t) => t.title === 'smoke /pip' || t.url.endsWith('/pip'))!
  await waitFor(() => store.get().tabs.find((t) => t.id === pipTab.id)?.title === 'smoke /pip')
  await sleep(500)
  browser.toggleMedia(pipTab.id)
  check('a playing video is paused from outside its tab', await waitFor(() => store.get().tabs.find((t) => t.id === pipTab.id)?.title === 'smoke /pip paused'))

  // Tweak zoom and Eraser: the page reports its display and pixel ratio.
  const zapHost = new URL(base).hostname
  browser.dispatch({ type: 'tab/open', url: `${base}/zap` })
  const titleOf = () => store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.title ?? ''
  await waitFor(() => /^zap:block:\d+$/.test(titleOf()))
  const ratio0 = Number(titleOf().split(':')[2])
  browser.dispatch({ type: 'boost/save', boost: { id: 'smoke-zap', host: zapHost, zoom: 1.5 } })
  check('a boost zooms the whole page', await waitFor(() => titleOf() === `zap:block:${Math.round(ratio0 * 1.5)}`), `${ratio0} -> ${titleOf()}`)
  // Eraser lasts until the user is done (the button of the page, Escape, or closing the editor): the page clicks the element, then the mode is ended.
  const zapping = browser.startZap(zapHost, 'smoke-zap')
  check('zap hides the element the user clicks', await waitFor(() => titleOf().startsWith('zap:none:')), titleOf())
  browser.endZap()
  await zapping
  check('and remembers its selector in the boost', JSON.stringify(store.get().boosts.find((b) => b.id === 'smoke-zap')?.zap) === '["#ad"]', JSON.stringify(store.get().boosts.find((b) => b.id === 'smoke-zap')?.zap))
  check('the boost editor reopens after a zap', browser.currentPanel() === 'boost')
  browser.closeOverlay()
  // Tweaks can be paused all at once without being deleted.
  browser.dispatch({ type: 'boost/save', boost: { id: 'smoke-zap', host: zapHost, zoom: 1.5, zap: ['#ad'] } })
  check('a Tweak hides and zooms the page', await waitFor(() => titleOf() === `zap:none:${Math.round(ratio0 * 1.5)}`), titleOf())
  browser.dispatch({ type: 'settings/update', patch: { boostsEnabled: false } })
  check('turning Tweaks off restores the page without deleting them', (await waitFor(() => titleOf() === `zap:block:${ratio0}`)) && store.get().boosts.some((b) => b.id === 'smoke-zap'), titleOf())
  browser.dispatch({ type: 'settings/update', patch: { boostsEnabled: true } })
  check('and turning them on applies them again', await waitFor(() => titleOf() === `zap:none:${Math.round(ratio0 * 1.5)}`), titleOf())
  browser.dispatch({ type: 'boost/delete', id: 'smoke-zap' })

  // Site data: a cookie set by the page is gone after "clear site data".
  browser.dispatch({ type: 'tab/open', url: `${base}/cookie` })
  await waitFor(() => titleOf() === 'seen:')
  browser.nav('reload')
  check('a site keeps its cookie across reloads', await waitFor(() => titleOf() === 'seen:k=v'), titleOf())
  await browser.clearSiteData()
  check('clearing site data removes the cookie', await waitFor(() => titleOf() === 'seen:'), titleOf())

  // Profiles: clearing one erases its cookies; cleaning unused ones never touches a profile a space uses.
  browser.nav('reload')
  await waitFor(() => titleOf() === 'seen:k=v')
  mkdirSync(join(app.getPath('userData'), 'Partitions', 'profile-stray'), { recursive: true })
  const usedProfiles = new Set(store.get().spaces.map((sp) => sp.profileId))
  const strays = engine.storedProfileIds().filter((id) => !usedProfiles.has(id))
  const purged = await browser.purgeUnusedProfiles(browser.unusedProfileIds())
  check('cleaning unused profiles counts only profiles no space uses', purged === strays.length && strays.includes('stray'), `${purged} / ${strays.join(',')}`)
  // The title still reads "seen:k=v" from the previous load: wait for the new request, then for the end of that load, which comes after its
  // script has written the title of the new document.
  const loadsBefore = cookieLoads
  const cookieTab = store.get().activeTabBySpace[store.get().activeSpaceId] ?? ''
  browser.nav('reload')
  await waitFor(() => cookieLoads > loadsBefore)
  await waitFor(() => browser.snapshot().runtime.tabs[cookieTab]?.loading === false)
  check('and leaves the data of a used profile alone', await waitFor(() => titleOf() === 'seen:k=v'), titleOf())
  await browser.clearProfile(store.get().spaces.find((sp) => sp.id === store.get().activeSpaceId)!.profileId)
  check('clearing a profile erases its cookies and reloads its tabs', await waitFor(() => titleOf() === 'seen:'), titleOf())
  check('a profile id that is not a plain name is refused', await browser.clearProfile('../x').then(() => false, () => true))

  // Tidy downloads, and the request blocker.
  browser.dispatch({ type: 'settings/update', patch: { tidyDownloads: true } })
  const downloadsBefore = browser.snapshot().downloads.length
  browser.dispatch({ type: 'tab/open', url: `${base}/download-messy` })
  check('a tidy download is saved under a cleaner name', await waitFor(() => browser.snapshot().downloads.some((d) => d.filename === 'Smoke Report v2.bin') && browser.snapshot().downloads.length > downloadsBefore), browser.snapshot().downloads.map((d) => d.filename).join(','))
  browser.dispatch({ type: 'settings/update', patch: { tidyDownloads: false } })

  // Per-profile settings: the download folder and the search engine of the profile the user is in.
  const profileFolder = mkdtempSync(join(tmpdir(), 'lucium-profile-downloads-'))
  browser.dispatch({ type: 'settings/update', patch: { profiles: { default: { downloadDir: profileFolder } } } })
  browser.dispatch({ type: 'tab/open', url: `${base}/download` })
  check('a profile saves its downloads in its own folder', await waitFor(() => existsSync(join(profileFolder, 'smoke.bin')), 6000), profileFolder)
  browser.dispatch({ type: 'settings/update', patch: { profiles: {} } })
  rmSync(profileFolder, { recursive: true, force: true })
  const searchBefore = store.get().settings.searchUrlTemplate
  browser.dispatch({ type: 'settings/update', patch: { searchUrlTemplate: `${base}/search?q=%s` } })
  const tabsBeforeSearch = store.get().tabs.length
  browser.submitUrl('bonjour le monde', 'new')
  check('the profile\'s search engine answers a search typed in the command bar', await waitFor(() => store.get().tabs.length === tabsBeforeSearch + 1 && store.get().tabs.at(-1)?.url === `${base}/search?q=bonjour%20le%20monde`), store.get().tabs.at(-1)?.url)
  browser.dispatch({ type: 'settings/update', patch: { searchUrlTemplate: searchBefore } })

  browser.setExtraBlockedHosts(['localhost'])
  // The one switch « Bloquer les publicités et les traqueurs » writes `blockAds` and its alias `blockTrackers` together (shared/privacy-dashboard.ts): so do these.
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
  thirdPartyHits = 0
  firstPartyHits = 0
  browser.dispatch({ type: 'tab/open', url: `${base}/ad-page` })
  const adTab = store.get().tabs.at(-1)!.id
  // The witness: the end of the load of the page, which waits for both of its scripts; a request the filter let through has reached the server by then.
  await waitFor(() => firstPartyHits > 0)
  await waitFor(() => browser.snapshot().runtime.tabs[adTab]?.loading === false)
  check('a blocked third-party request never reaches the network, the first-party one does', thirdPartyHits === 0 && firstPartyHits > 0, `third=${thirdPartyHits} first=${firstPartyHits}`)
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
  browser.dispatch({ type: 'tab/open', url: `${base}/ad-page` })
  check('with blocking off the same request goes through', await waitFor(() => thirdPartyHits > 0), `third=${thirdPartyHits}`)
  browser.setExtraBlockedHosts([])

  // The Settings window: a window of its own, reused, driven through the same IPC as the main window.
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  browser.openOverlay({ panel: 'settings', pane: 'protection' })
  check('opening the settings makes a window, not an overlay panel', await waitFor(() => settingsWindows().length === 1) && browser.currentPanel() === null)
  const settingsUi = must(settingsWindows()[0], 'the Settings window (found by its title, « Réglages »)').webContents
  const inSettings = (script: string) => settingsUi.executeJavaScript(script) as Promise<unknown>
  const selectedPane = async () => String(await inSettings(`document.querySelector('.settings-cat[aria-current=page]')?.textContent ?? ''`))
  // Every page of the sidebar is there (« Pour commencer », the categories and the two pages apart: settings-catalog.ts), the one asked for selected.
  const shownPages = async () => Number(await inSettings(`document.querySelectorAll('.settings-cat').length`))
  check('it shows the requested pane selected', (await waitFor(() => true)) && (await (async () => { for (let i = 0; i < 30; i++) { if ((await selectedPane()).includes('Vie privée')) return true; await sleep(100) } return false })()) && (await shownPages()) === SETTINGS_CATEGORIES.length, `${await selectedPane()}; ${await shownPages()} pages of ${SETTINGS_CATEGORIES.length}`)
  // The pane opens with a summary row (« Activée ») that carries the same words: the switch is found by the setting it writes, not by the text of a row.
  for (let i = 0; i < 40 && !(await inSettings(`!!document.querySelector('.pref-row[data-setting="blockAds"] input[role=switch]')`)); i++) await sleep(100)
  await inSettings(`document.querySelector('.pref-row[data-setting="blockAds"] input[role=switch]').click()`)
  check('a switch in the settings window changes the state', await waitFor(() => store.get().settings.blockAds === true && store.get().settings.blockTrackers === true), String(store.get().settings.blockAds))
  browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
  // Profiles pane: create a profile and remove it again, through the real UI. A deleted profile keeps its id taken (its folders may still be on disk): a name of its own, not the one of the profile dialogs checks later.
  browser.openOverlay({ panel: 'settings', pane: 'profiles' })
  const uiClick = (text: string) => inSettings(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))?.click() ?? 'missing'`)
  for (let i = 0; i < 40 && String(await inSettings(`document.querySelector('.profile-list') ? 'yes' : ''`)) !== 'yes'; i++) await sleep(100)
  for (let i = 0; i < 30 && (await uiClick('Ajouter un profil')) === 'missing'; i++) await sleep(100)
  await sleep(200)
  await inSettings(`(() => { const input = document.querySelector('input[placeholder="Nom du profil"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Profil Principal'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(200)
  await uiClick('Continuer')
  await sleep(300)
  await uiClick('Créer le profil')
  check('creating a profile in the settings names it', await waitFor(() => store.get().settings.profileNames['profil-principal'] === 'Profil Principal', 4000), JSON.stringify(store.get().settings.profileNames))
  await sleep(300)
  await uiClick('Supprimer le profil')
  await sleep(200)
  await uiClick('Confirmer la suppression')
  check('and deleting it removes it', await waitFor(() => store.get().settings.profileNames['profil-principal'] === undefined, 6000), JSON.stringify(store.get().settings.profileNames))

  browser.openOverlay({ panel: 'settings', pane: 'navigation', anchor: 'links' })
  check('asking again reuses the window and switches pane', await waitFor(() => settingsWindows().length === 1) && (await (async () => { for (let i = 0; i < 30; i++) { if ((await selectedPane()).includes('Navigation')) return true; await sleep(100) } return false })()), await selectedPane())
  settingsWindows()[0]!.close()
  check('closing it leaves no settings window', await waitFor(() => settingsWindows().length === 0))

  // Real mouse input in the sidebar UI: resize handle, floating sidebar, extension popup.
  const chrome = win.webContents
  const rectOf = async (selectorScript: string): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    (await chrome.executeJavaScript(`(() => { const el = ${selectorScript}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)) as never
  const mouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)

  const widthBefore = store.get().settings.sidebarWidth
  const handle = await waitFor(() => true) && (await rectOf("document.querySelector('.resize-handle')"))
  if (handle) {
    const cx = handle.x + handle.width / 2
    const cy = handle.y + handle.height / 2
    mouse('mouseMove', cx, cy)
    mouse('mouseDown', cx, cy)
    for (const dx of [10, 30, 60]) { mouse('mouseMove', cx + dx, cy); await sleep(40) }
    mouse('mouseUp', cx + 60, cy)
    // Each move is sent as it comes, the last one at the drop (60 px out): the drag is over only once the width is there. Put back at the first
    // change, the moves still on their way widened the sidebar again for every part after this one (a sidebar of 379 px under a loaded machine).
    await waitFor(() => store.get().settings.sidebarWidth >= widthBefore + 50, 3000)
  }
  check('dragging the sidebar edge resizes it', !!handle && store.get().settings.sidebarWidth > widthBefore, `${widthBefore} -> ${store.get().settings.sidebarWidth}`)
  browser.dispatch({ type: 'settings/update', patch: { sidebarWidth: widthBefore } })
  await waitFor(() => store.get().settings.sidebarWidth === widthBefore, 3000)

  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  browser.hotEdge(true)
  check('the pointer at the left edge slides the sidebar over the page', browser.isFloatingSidebarShown())
  browser.hotEdge(false)
  check('and it slides away when the pointer leaves', await waitFor(() => !browser.isFloatingSidebarShown(), 3000))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  await sleep(300)

  // Space themes: the editor with real mouse input, and the palette sites can read once the user allows it.
  const spaceId = store.get().activeSpaceId
  const spaceTheme = () => store.get().spaces.find((sp) => sp.id === spaceId)!.theme
  const originalTheme = spaceTheme()
  browser.dispatch({ type: 'tab/open', url: `${base}/theme` })
  const paletteOf = () => store.get().tabs.find((t) => t.title.startsWith('theme:'))?.title ?? ''
  check('the colour a page declares can be read for the theme', await waitFor(() => paletteOf() !== '') && (await browser.siteColor()) === '#336699', String(await browser.siteColor()))
  check('a page gets no palette until the user allows it', paletteOf() === 'theme:', paletteOf())
  browser.dispatch({ type: 'settings/update', patch: { allowThemeToSites: true } })
  check('the palette reaches pages once allowed', await waitFor(() => /^theme:#[0-9a-f]{6}$/.test(paletteOf())), paletteOf())
  const paletteBefore = paletteOf()
  const themeTabId = store.get().tabs.find((t) => t.title.startsWith('theme:'))?.id
  check('the toolbar takes the colour a page declares', !!themeTabId && (await waitFor(() => browser.snapshot().runtime.tabs[themeTabId]?.color === '#336699', 5000)), String(themeTabId && browser.snapshot().runtime.tabs[themeTabId]?.color))

  browser.openOverlay({ panel: 'theme', spaceId })
  const ui = overlayView.webContents
  // `scroll`: the editor is a scrolling panel (its colour pad is below the fold), and a real mouse only reaches what is on screen: the element is scrolled into view first.
  const overlayRect = async (selectorScript: string, scroll = false): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    await waitFor(() => browser.currentPanel() === 'theme', 3000)
    for (let i = 0; i < 30; i++) {
      const rect = (await ui.executeJavaScript(`(() => { const el = ${selectorScript}; if (!el) return null; ${scroll ? "el.scrollIntoView({ block: 'center' }); " : ''}const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)) as never
      if (rect) return rect
      await sleep(100)
    }
    return null
  }
  const overlayMouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    ui.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  // The pad is in the disclosure « Contrôles de couleur avancés », folded when the editor opens: a real click on its title unfolds it.
  const summary = await overlayRect("document.querySelector('.theme-advanced > summary')", true)
  if (summary && !(await ui.executeJavaScript(`document.querySelector('.theme-advanced').open`))) {
    overlayMouse('mouseMove', summary.x + 40, summary.y + summary.height / 2)
    overlayMouse('mouseDown', summary.x + 40, summary.y + summary.height / 2)
    overlayMouse('mouseUp', summary.x + 40, summary.y + summary.height / 2)
    await waitFor(async () => (await ui.executeJavaScript(`document.querySelector('.theme-advanced').open`)) === true, 2000)
    await sleep(150)
  }
  const pad = await overlayRect("document.querySelector('.color-pad')", true)
  if (pad) {
    // Hue runs along the pad: from 10 % to 25 % of its width, in the middle (clear of the buttons at its top and bottom).
    const y = pad.y + pad.height / 2
    const at = (fraction: number) => pad.x + pad.width * fraction
    overlayMouse('mouseMove', at(0.1), y)
    overlayMouse('mouseDown', at(0.1), y)
    for (const fraction of [0.15, 0.2, 0.25]) { overlayMouse('mouseMove', at(fraction), y); await sleep(40) }
    overlayMouse('mouseUp', at(0.25), y)
  }
  const hueOf = (hex: string | undefined) => (hex ? Math.round(hexToHsl(hex).h) : -1)
  await waitFor(() => Math.abs(hueOf(spaceTheme().baseColors[0]) - 90) <= 8, 3000)
  check('dragging on the colour pad moves the primary colour', Math.abs(hueOf(spaceTheme().baseColors[0]) - 90) <= 8, JSON.stringify(spaceTheme().baseColors))
  check('and the complementary colour follows it', Math.abs(hueOf(spaceTheme().baseColors[1]) - 270) <= 8, JSON.stringify(spaceTheme().baseColors))
  check('the page palette follows the theme live', await waitFor(() => /^theme:#[0-9a-f]{6}$/.test(paletteOf()) && paletteOf() !== paletteBefore), `${paletteBefore} -> ${paletteOf()}`)

  await ui.executeJavaScript(`[...document.querySelectorAll('.segmented button')].find((b) => b.textContent === 'Triade')?.click()`)
  check('choosing the triad harmony gives three colours', await waitFor(() => spaceTheme().harmony === 'triadic' && spaceTheme().baseColors.length === 3, 3000), JSON.stringify(spaceTheme()))
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  check('Escape closes the theme editor', await waitFor(() => browser.currentPanel() === null, 3000), String(browser.currentPanel()))

  browser.dispatch({ type: 'settings/update', patch: { allowThemeToSites: false } })
  check('turning the setting off removes the palette from the page', await waitFor(() => paletteOf() === 'theme:'), paletteOf())
  browser.dispatch({ type: 'space/update', id: spaceId, patch: { theme: originalTheme } })
  browser.dispatch({ type: 'tab/close', id: must(store.get().tabs.find((t) => t.title.startsWith('theme:')), 'the tab of the page that follows the theme').id })

  // The application menu bar: the expected structure, one shortcut per item, and entries that do what they say.
  const bar = Menu.getApplicationMenu()!
  check('the menu bar has the ten menus of the application, in order', JSON.stringify(bar.items.map((m) => m.label)) === JSON.stringify(['Lucium', 'Fichier', 'Édition', 'Affichage', 'Espaces', 'Onglets', 'Archive', 'Extensions', 'Fenêtre', 'Aide']), bar.items.map((m) => m.label).join(' | '))
  const walk = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu.items) : [])])
  const everyItem = walk(bar.items)
  const registered = everyItem.filter((item) => item.accelerator && item.registerAccelerator !== false).map((item) => String(item.accelerator))
  const duplicated = registered.filter((acc, i) => registered.indexOf(acc) !== i)
  check('no two menu items register the same shortcut', duplicated.length === 0, duplicated.join(', '))
  const itemByPath = (...path: string[]): MenuItem | undefined => {
    // The menu is rebuilt when what it shows changes: always read the current one.
    let items: MenuItem[] = Menu.getApplicationMenu()!.items
    let found: MenuItem | undefined
    for (const label of path) {
      found = items.find((item) => item.label === label)
      items = found?.submenu?.items ?? []
    }
    return found
  }
  const choose = (...path: string[]) => {
    const item = itemByPath(...path)
    if (!item) throw new Error(`menu entry not found: ${path.join(' › ')}`)
    item.click()
  }

  browser.dispatch({ type: 'tab/open', url: `${base}/one` })
  const openTab = () => store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])
  await waitFor(() => openTab()?.title === 'smoke /one')
  const tabsBefore = store.get().tabs.length
  choose('Fichier', 'Archiver l’onglet')
  check('"Archiver l’onglet" archives a Today tab instead of closing it for good', store.get().tabs.length === tabsBefore - 1 && store.get().archive[0]?.url.endsWith('/one') === true, store.get().archive[0]?.url)
  check('"Rouvrir le dernier onglet fermé" is available once something is archived', itemByPath('Fichier', 'Rouvrir le dernier onglet fermé')?.enabled === true)
  choose('Fichier', 'Rouvrir le dernier onglet fermé')
  check('and brings it back', store.get().tabs.length === tabsBefore && store.get().tabs.some((t) => t.url.endsWith('/one')) && !store.get().archive.some((a) => a.url.endsWith('/one')))

  await waitFor(() => openTab()?.title === 'smoke /one')
  const clipboardAfter = async (...path: string[]) => {
    await clipboard.writeText('')
    choose(...path)
    for (let i = 0; i < 30; i++) {
      const text = await clipboard.readText()
      if (text !== '') return text
      await sleep(100)
    }
    return ''
  }
  check('"Copier l’adresse" puts the address on the clipboard', (await clipboardAfter('Édition', 'Copier l’adresse')) === `${base}/one`)
  check('"Copier l’adresse en Markdown" makes a link with the page title', (await clipboardAfter('Édition', 'Copier l’adresse en Markdown')) === `[smoke /one](${base}/one)`)
  check('"Copier l’adresse en citation" without a selection gives title and address', (await clipboardAfter('Édition', 'Copier l’adresse en citation')) === `smoke /one\n${base}/one`)

  const loadsBeforeHard = cookieLoads
  browser.dispatch({ type: 'tab/open', url: `${base}/cookie` })
  await waitFor(() => cookieLoads > loadsBeforeHard)
  const loadsAfterOpen = cookieLoads
  choose('Affichage', 'Actualisation forcée')
  check('"Actualisation forcée" loads the page again', await waitFor(() => cookieLoads > loadsAfterOpen, 4000), String(cookieLoads))

  browser.dispatch({ type: 'tab/open', url: `${base}/zap` })
  await waitFor(() => /^zap:block:\d+$/.test(openTab()?.title ?? ''))
  const ratioNow = () => Number(openTab()?.title.split(':')[2])
  const ratioStart = ratioNow()
  choose('Affichage', 'Zoom avant')
  check('"Zoom avant" enlarges the page', await waitFor(() => ratioNow() > ratioStart, 3000), `${ratioStart} -> ${ratioNow()}`)
  choose('Affichage', 'Zoom arrière')
  choose('Affichage', 'Zoom arrière')
  check('"Zoom arrière" shrinks it', await waitFor(() => ratioNow() < ratioStart, 3000), `${ratioStart} -> ${ratioNow()}`)
  choose('Affichage', 'Taille réelle')
  check('"Taille réelle" restores it', await waitFor(() => ratioNow() === ratioStart, 3000), `${ratioStart} -> ${ratioNow()}`)

  choose('Affichage', 'Développeur', 'Console JavaScript')
  const devtoolsOpen = () => allWebContents.getAllWebContents().some((wc) => wc.getURL().startsWith('devtools://'))
  check('"Console JavaScript" opens the developer tools', await waitFor(devtoolsOpen, 5000))
  // The panel itself, read back from the frontend: a call made while the frontend is still loading leaves the Elements panel, or is lost.
  const consoleTab = `(() => { const deep = (root, sel, out = []) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) deep(el.shadowRoot, sel, out) } root.querySelectorAll(sel).forEach((e) => out.push(e)); return out }; const tab = deep(document, '#tab-console')[0]; return !!tab && tab.getAttribute('aria-selected') === 'true' })()`
  let consoleShown = false
  for (let i = 0; i < 60 && !consoleShown; i++) {
    const tools = allWebContents.getAllWebContents().find((wc) => wc.getURL().startsWith('devtools://'))
    consoleShown = (await tools?.executeJavaScript(consoleTab).catch(() => false)) === true
    if (!consoleShown) await sleep(250)
  }
  check('"Console JavaScript" shows the Console panel of the developer tools', consoleShown)

  const activeBefore = must(openTab(), 'the tab on screen').id
  choose('Onglets', 'Onglet précédent')
  check('"Onglet précédent" selects another tab', openTab()?.id !== activeBefore)
  choose('Onglets', 'Onglet suivant')
  check('and "Onglet suivant" comes back', openTab()?.id === activeBefore)

  // The tab menu: its entries, set in blocks (Ouvrir, Personnaliser, Organiser, Veille, Archiver et fermer). The titles are asked as section headers whatever the system.
  const menuTab = openTab()!
  const tabMenu = menuItems({ kind: 'tab', id: menuTab.id }, browser, store, win, { headers: true })
  const tabLabels = tabMenu.map((item) => item.label ?? '——')
  check('the tab menu is in blocks, and the one that closes comes last', JSON.stringify(tabMenu.filter((item) => item.type === 'header').map((item) => item.label)) === JSON.stringify(['Ouvrir', 'Personnaliser', 'Organiser', 'Veille', 'Archiver et fermer']) && tabLabels.at(-1) === 'Fermer les autres onglets du jour', tabLabels.join(' | '))
  check('its "Personnaliser" block holds icon, rename and mute', JSON.stringify(tabLabels.slice(tabLabels.indexOf('Personnaliser') + 1, tabLabels.indexOf('Personnaliser') + 4)) === JSON.stringify(['Changer l’icône…', 'Renommer…', 'Couper le son']), tabLabels.join(' | '))
  const tabEntry = (label: string) => tabMenu.find((item) => item.label === label)
  ;(tabEntry('Renommer…')?.click as () => void)()
  check('"Renommer…" opens the tab editor on its name', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'tab', tabId: menuTab.id, focus: 'name' }), JSON.stringify(browser.currentOverlay()))
  browser.dispatch({ type: 'tab/rename', id: menuTab.id, title: 'Mon onglet de test' })
  check('a renamed tab keeps its name when the page changes its title', await waitFor(() => store.get().tabs.find((t) => t.id === menuTab.id)?.customTitle === 'Mon onglet de test'))
  browser.closeOverlay()
  ;(tabEntry('Changer l’icône…')?.click as () => void)()
  check('"Changer l’icône…" opens it on the icons', (browser.currentOverlay() as { focus?: string } | null)?.focus === 'icon')
  browser.closeOverlay()
  browser.dispatch({ type: 'tab/rename', id: menuTab.id, title: '' })
  // The menu offers "Archive Tabs Above" only when there is a tab above: the first Today tab has no such entry, the others do.
  check('"Archiver les onglets au-dessus" is offered for every Today tab but the first', (() => {
    const today = store.get().tabs.filter((t) => t.spaceId === menuTab.spaceId && !t.pinned)
    const entry = (id: string) => menuItems({ kind: 'tab', id }, browser, store, win).find((i) => i.label === 'Archiver les onglets au-dessus')
    return today.length > 0 && !entry(today[0]!.id) && today.slice(1).every((t) => entry(t.id)?.enabled !== false)
  })())

  // Toasts: archiving says so and offers to undo; a stale click on an old toast does nothing.
  browser.dispatch({ type: 'tab/open', url: `${base}/two` })
  const toastTab = must(store.get().tabs.at(-1), 'the tab opened for the toast')
  browser.dispatch({ type: 'tab/archive', id: toastTab.id })
  const shownToast = browser.snapshot().toast
  check('archiving a tab shows a toast with an undo button', shownToast?.message === 'Onglet archivé' && shownToast.action === 'Annuler', JSON.stringify(shownToast))
  const toast = must(shownToast, 'the toast of the archived tab')
  browser.runToastAction(toast.id + 99)
  check('a click on a toast that is not the current one does nothing', !store.get().tabs.some((t) => t.url === toastTab.url) && browser.snapshot().toast?.id === toast.id)
  browser.runToastAction(toast.id)
  check('the undo button brings the tab back and clears the toast', store.get().tabs.some((t) => t.url === toastTab.url) && browser.snapshot().toast === null)
  browser.dispatch({ type: 'tab/close', id: must(store.get().tabs.find((t) => t.url === toastTab.url), 'the tab brought back by the toast').id })

  // Back and forward long press: the pages this tab went through.
  browser.dispatch({ type: 'tab/open', url: `${base}/one` })
  await waitFor(() => openTab()?.title === 'smoke /one')
  browser.submitUrl(`${base}/two`, 'current')
  await waitFor(() => openTab()?.title === 'smoke /two')
  const backMenu = menuItems({ kind: 'nav', id: 'back' }, browser, store, win)
  check('the back menu lists the previous page of the tab', backMenu.length === 1 && String(backMenu[0]?.label).includes('smoke /one'), backMenu.map((i) => i.label).join(' | '))
  check('and there is nothing to go forward to', menuItems({ kind: 'nav', id: 'forward' }, browser, store, win)[0]?.enabled === false)
  ;(backMenu[0]?.click as () => void)()
  check('choosing a page of the list goes back to it', await waitFor(() => openTab()?.title === 'smoke /one', 4000), openTab()?.title)

  // Split controls: move a pane, as the options button of a split pane does.
  const paneA = must(openTab(), 'the tab on screen, for the split view')
  browser.dispatch({ type: 'tab/open', url: `${base}/panel` })
  const paneB = must(store.get().tabs.at(-1), 'the second tab of the split view')
  browser.dispatch({ type: 'split/create', tabId: paneA.id, withTabId: paneB.id })
  const splitMenu = menuItems({ kind: 'split', id: paneB.id }, browser, store, win)
  const moveLeft = splitMenu.find((i) => i.label === 'Déplacer le volet vers la gauche')
  check('the split controls offer to move a pane, greyed out at the edge', moveLeft?.enabled === true && splitMenu.find((i) => i.label === 'Déplacer le volet vers la droite')?.enabled === false, splitMenu.map((i) => i.label ?? '——').join(' | '))
  ;(moveLeft?.click as () => void)()
  check('moving a pane swaps it with its neighbour', JSON.stringify(store.get().splits.find((sp) => sp.tabIds.includes(paneB.id))?.tabIds) === JSON.stringify([paneB.id, paneA.id]))
  browser.dispatch({ type: 'split/remove', tabId: paneB.id })
  browser.dispatch({ type: 'tab/close', id: paneB.id })

  // A download's own menu.
  const aDownload = browser.snapshot().downloads.find((d) => d.state === 'completed')
  check('a finished download is listed, for the checks of its menu', aDownload !== undefined, JSON.stringify(browser.snapshot().downloads.map((d) => d.state)))
  if (aDownload) {
    const downloadMenu = menuItems({ kind: 'download', id: aDownload.id }, browser, store, win)
    check('a finished download offers open, copy link, show in Finder, remove, trash', downloadMenu.filter((i) => i.label).length === 6 && downloadMenu.find((i) => i.label === 'Annuler le téléchargement')?.enabled === false, downloadMenu.map((i) => i.label ?? '——').join(' | '))
  }

  // The task manager lists the processes, naming tabs after their pages.
  choose('Aide', 'Dépannage', 'Ouvrir le gestionnaire de tâches')
  const taskWindow = () => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Gestionnaire de tâches')
  check('the task manager opens in a window of its own', await waitFor(() => !!taskWindow(), 5000))
  let taskRows = ''
  for (let i = 0; i < 40 && !taskRows.includes('Application'); i++) {
    await sleep(150)
    taskRows = String((await taskWindow()?.webContents.executeJavaScript(`[...document.querySelectorAll('.task-manager tbody tr')].map((r) => r.textContent).join('|')`)) ?? '')
  }
  check('it lists the application, and a tab by the title of its page', taskRows.includes('Application') && taskRows.includes('Onglet') === true && /smoke \/|Example|theme:|boost|zap/.test(taskRows), taskRows.slice(0, 200))
  taskWindow()?.close()
  check('closing it leaves no task manager window', await waitFor(() => !taskWindow(), 3000))

  choose('Archive', 'Afficher l’historique')
  check('"Afficher l’historique" opens the history panel', browser.currentPanel() === 'history')
  const historyRows = async () => Number(await ui.executeJavaScript(`document.querySelectorAll('.hist-pages li').length`))
  let rows = 0
  for (let i = 0; i < 30 && rows === 0; i++) { rows = await historyRows(); if (rows === 0) await sleep(100) }
  check('it lists the visited pages', rows > 0, String(rows))
  browser.closeOverlay()

  const littleWindowsBefore = little.count()
  choose('Fichier', `Nouvelle ${littleForms('fr').s}`)
  check('"Nouvelle fenêtre Little Arc" opens a Little Arc window in its first state (the command bar alone), not a panel over this window', little.count() === littleWindowsBefore + 1 && little.states().at(-1)?.bar === true && browser.currentPanel() === null, JSON.stringify({ count: little.count(), panel: browser.currentPanel() }))
  for (const window of little.states()) little.close(window.id)
  await waitFor(() => little.count() === littleWindowsBefore, 4000)
  const splitsBefore = store.get().splits.length
  choose('Affichage', 'Ajouter une vue scindée')
  check('"Ajouter une vue scindée" asks for the second pane in the command bar', (browser.currentOverlay() as { mode?: string } | null)?.mode === 'split')
  browser.submitUrl(`${base}/two`, 'split')
  check('and pairs the new tab with the one that was open', await waitFor(() => store.get().splits.length === splitsBefore + 1, 3000), String(store.get().splits.length))
  check('"Fermer ce volet scindé" is available inside a split view', itemByPath('Affichage', 'Fermer ce volet scindé')?.enabled === true)
  choose('Affichage', 'Fermer ce volet scindé')
  check('and dissolves it', await waitFor(() => store.get().splits.length === splitsBefore, 3000), String(store.get().splits.length))

  choose('Espaces', 'Gérer les espaces…')
  check('"Gérer les espaces…" opens the space manager', browser.currentPanel() === 'spaces')
  browser.closeOverlay()
  choose('Espaces', 'Nouvel espace…')
  check('"Nouvel espace…" opens the space creation sheet', browser.currentOverlay()?.panel === 'spacecreate')
  browser.closeOverlay()
  browser.dispatch({ type: 'space/create', name: 'Espace 2', emoji: '✨', hue: 297 })
  const secondSpace = must(store.get().spaces.at(-1), 'the second space')
  browser.dispatch({ type: 'space/select', id: store.get().spaces[0]!.id })
  choose('Espaces', 'Espace suivant')
  check('"Espace suivant" selects the next space', store.get().activeSpaceId === store.get().spaces[1]!.id)
  choose('Espaces', 'Espace précédent')
  check('and "Espace précédent" goes back', store.get().activeSpaceId === store.get().spaces[0]!.id)
  browser.dispatch({ type: 'space/delete', id: secondSpace.id })

  // The run pins the appearance of Lucium to dark (smoke-run.ts): this one starts from « Automatique », which follows the Mac, then chooses Sombre, and puts the pin back.
  const pinnedAppearance = store.get().settings.interfaceAppearance
  browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: 'auto' } })
  check('"Automatique" follows the system again (nativeTheme is left to it)', await waitFor(() => nativeTheme.themeSource === 'system', 3000), nativeTheme.themeSource)
  choose('Affichage', 'Apparence', 'Sombre')
  check('"Apparence › Apparence de Lucium › Sombre" forces the dark appearance of the interface, and asks nothing of the sites', await waitFor(() => nativeTheme.themeSource === 'dark', 3000) && store.get().settings.interfaceAppearance === 'dark' && store.get().settings.websiteAppearance === 'auto', nativeTheme.themeSource)
  browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: 'auto' } })
  check('and back to automatic follows the system again', await waitFor(() => nativeTheme.themeSource === 'system', 3000), nativeTheme.themeSource)
  browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: pinnedAppearance } })
  await waitFor(() => nativeTheme.themeSource === pinnedAppearance, 3000)

  // Application icons are PNG files of the resources: the middle of the tile is opaque, its outer corner transparent.
  try {
    const icon = loadIcon('cyber', 256)
    const bitmap = icon.toBitmap()
    const { width, height } = icon.getSize()
    const alphaAt = (x: number, y: number) => bitmap[(y * width + x) * 4 + 3]!
    check('an application icon renders as a rounded tile', width > 0 && alphaAt(Math.floor(width / 2), Math.floor(height / 2)) === 255 && alphaAt(1, 1) === 0, `${width}x${height}`)
  } catch (error) {
    check('an application icon renders as a rounded tile', false, String(error))
  }

  // The command bar completes an address inline: typing "127" offers the host of an open tab, the rest selected.
  browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
  for (let i = 0; i < 30 && String(await ui.executeJavaScript(`document.querySelector('.palette-input') ? 'yes' : ''`)) !== 'yes'; i++) await sleep(100)
  await sleep(300)
  for (const ch of '127') {
    ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
    ui.sendInputEvent({ type: 'char', keyCode: ch })
    ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(60)
  }
  await sleep(500)
  const field = (await ui.executeJavaScript(`(() => { const i = document.querySelector('.palette-input'); return { value: i.value, start: i.selectionStart, end: i.selectionEnd } })()`)) as { value: string; start: number; end: number }
  check('typing in the command bar completes the host inline, with the rest selected', field.value.startsWith('127.0.0.1') && field.start === 3 && field.end === field.value.length, JSON.stringify(field))
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  await sleep(400)
  const afterDelete = (await ui.executeJavaScript(`document.querySelector('.palette-input').value`)) as string
  check('Backspace removes the completion and does not bring it back', afterDelete === '127', afterDelete)
  browser.closeOverlay()

  // Site search pill: "yt" and a space turn into a pill, Backspace takes it away; ⇧↩ opens the first result of each search.
  const typeKeys = async (text: string) => {
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(60)
    }
    await sleep(300)
  }
  const pill = () => ui.executeJavaScript(`document.querySelector('.scope-pill')?.firstChild?.textContent ?? ''`) as Promise<string>
  browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
  for (let i = 0; i < 30 && String(await ui.executeJavaScript(`document.querySelector('.palette-input') ? 'yes' : ''`)) !== 'yes'; i++) await sleep(100)
  await sleep(300)
  await typeKeys('yt ')
  check('"yt" and a space turn into a YouTube pill', (await pill()) === 'YouTube', await pill())
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  check('Backspace on an empty field takes the pill away', await waitFor(async () => (await pill()) === ''))
  browser.closeOverlay()

  const tabsBeforeInstant = store.get().tabs.length
  browser.submitUrl('lucium, example.com', 'new', true)
  const instantTabs = store.get().tabs.slice(tabsBeforeInstant).map((t) => t.url)
  check('an instant link opens one tab per term: the first result, and the address as it is', instantTabs.length === 2 && instantTabs[0]!.includes('%5Clucium') && instantTabs[1] === 'https://example.com', JSON.stringify(instantTabs))
  for (const tab of store.get().tabs.slice(tabsBeforeInstant)) browser.dispatch({ type: 'tab/close', id: tab.id })

  await smokeCommandBar({ browser, store, engine, history, win, overlayView, little }, check)

  // The space menu: every entry does what it says, and a right click on the sidebar itself opens it.
  const spaceMenu = menuItems({ kind: 'space', id: spaceId }, browser, store, win, { headers: true })
  const labels = spaceMenu.filter((item) => item.type !== 'header').map((item) => item.label ?? '')
  check('the space menu offers one "Personnaliser l’espace…" (icon, colour, name, profile), then the name and the profile', JSON.stringify(labels.slice(0, 3)) === JSON.stringify(['Personnaliser l’espace…', 'Renommer l’espace…', 'Définir le profil']) && !labels.includes('Changer l’icône de l’espace…') && !labels.includes('Modifier la couleur du thème…'), labels.join(' | '))
  const entry = (label: string) => spaceMenu.find((item) => item.label === label)
  const press = (label: string) => (entry(label)?.click as (() => void) | undefined)?.()
  press('Personnaliser l’espace…')
  check('"Personnaliser l’espace…" opens the panel of the space', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'space', spaceId }), JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  press('Renommer l’espace…')
  check('"Renommer l’espace…" opens the space editor on its name', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'space', spaceId, focus: 'name' }), JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  const profileMenu = (entry('Définir le profil')?.submenu ?? []) as Electron.MenuItemConstructorOptions[]
  check('the profile submenu ticks the space\'s profile and offers a new one', profileMenu.some((item) => item.type === 'radio' && item.checked === true) && profileMenu.at(-1)?.label === 'Nouveau profil…', profileMenu.map((item) => `${item.label}${item.checked ? '*' : ''}`).join(' | '))
  const foldersBefore = store.get().folders.length
  press('Nouveau dossier')
  check('"Nouveau dossier" creates a folder in the space', store.get().folders.length === foldersBefore + 1 && store.get().folders.some((f) => f.spaceId === spaceId && f.name === 'Nouveau dossier'))
  const madeFolder = store.get().folders.find((f) => f.name === 'Nouveau dossier')!
  const folderMenu = menuItems({ kind: 'folder', id: madeFolder.id }, browser, store, win, { headers: true })
  check('the folder menu copies links, duplicates and deletes, in blocks', JSON.stringify(folderMenu.map((i) => i.label ?? '——')) === JSON.stringify(['Créer et copier', 'Nouveau sous-dossier', frenchSpaces('Transformer « Nouveau dossier » en espace'), 'Copier tous les liens', 'Copier tous les liens en Markdown', 'Personnaliser', 'Renommer…', 'Organiser', 'Dupliquer', 'Mettre au début d’Aujourd’hui', 'Mettre en bas de la liste', 'Ne jamais réveiller automatiquement', 'Archiver le dossier', 'Supprimer', 'Supprimer le dossier (garder les onglets)']), folderMenu.map((i) => i.label ?? '——').join(' | '))
  check('"Copier tous les liens" (plain and Markdown) is greyed out for an empty folder', folderMenu.find((i) => i.label === 'Copier tous les liens')?.enabled === false && folderMenu.find((i) => i.label === 'Copier tous les liens en Markdown')?.enabled === false)
  ;(folderMenu.find((i) => i.label === 'Dupliquer')?.click as () => void)()
  check('"Dupliquer" makes a copy of the folder', store.get().folders.some((f) => f.name === 'Nouveau dossier (copie)'))
  for (const f of store.get().folders.filter((f) => f.name.startsWith('Nouveau dossier'))) browser.dispatch({ type: 'folder/delete', id: f.id })
  const spaceNow = store.get().spaces.find((sp) => sp.id === spaceId)!
  ;(menuItems({ kind: 'space', id: spaceId }, browser, store, win).find((i) => i.label === 'Masquer l’en-tête de l’espace')?.click as () => void)()
  check('"Masquer l’en-tête de l’espace" hides the space header', store.get().spaces.find((sp) => sp.id === spaceId)?.hideHeader === true && !spaceNow.hideHeader)
  browser.dispatch({ type: 'space/header', id: spaceId, visible: true })

  // A real right click in the sidebar UI (the native menu itself is not opened: its template is recorded).
  const opened: string[][] = []
  const realPopup = Menu.prototype.popup
  Menu.prototype.popup = function (this: Menu) {
    opened.push(this.items.map((item) => item.label))
    return this
  } as never
  const rightClick = (selector: string) => chrome.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) ?? 'missing'`)
  await rightClick('.scroll')
  await waitFor(() => opened.length > 0, 3000)
  check('a right click on the sidebar opens the space menu', opened.length === 1 && opened[0]!.includes('Personnaliser l’espace…'), JSON.stringify(opened))
  opened.length = 0
  // The witness of "nothing more": a right click on the sidebar after it, whose space menu comes through the same channel and the same reading of
  // the clipboard as a second menu of the first click would have, so after it.
  const isSpaceMenu = (labels: string[] | undefined): boolean => labels?.includes('Personnaliser l’espace…') === true
  await rightClick('.sidebar .tab')
  await waitFor(() => opened.length > 0, 3000)
  await rightClick('.scroll')
  await waitFor(() => opened.some(isSpaceMenu), 3000)
  check('a right click on a tab opens the tab menu only, once', opened.length === 2 && !isSpaceMenu(opened[0]) && opened[0]!.includes('Fermer l’onglet') && isSpaceMenu(opened[1]), JSON.stringify(opened))
  opened.length = 0
  await rightClick('.tb-url')
  await rightClick('.scroll')
  await waitFor(() => opened.some(isSpaceMenu), 3000)
  check('a right click on a plain button opens nothing', opened.length === 1 && isSpaceMenu(opened[0]), JSON.stringify(opened))
  Menu.prototype.popup = realPopup

  if (extensionPaths.length === 0) check('the icon of an extension opens its popup inside the window', true, skippedBecause('no extension was loaded (LUCIUM_EXTENSIONS is empty)'))
  if (extensionPaths.length > 0) {
    await waitFor(() => engine.listExtensions().length > 0, 5000)
    // Several extensions are loaded and only some declare a popup: click every icon until one opens.
    const count = Number(await chrome.executeJavaScript("document.querySelector('browser-action-list')?.shadowRoot?.querySelectorAll('button, .action, [part=action]').length ?? 0"))
    const before = engine.extensionPopupCount()
    for (let i = 0; i < count && engine.extensionPopupCount() === before; i++) {
      const r = await rectOf(`document.querySelector('browser-action-list').shadowRoot.querySelectorAll('button, .action, [part=action]')[${i}]`)
      if (!r) continue
      mouse('mouseMove', r.x + r.width / 2, r.y + r.height / 2)
      mouse('mouseDown', r.x + r.width / 2, r.y + r.height / 2)
      mouse('mouseUp', r.x + r.width / 2, r.y + r.height / 2)
      await waitFor(() => engine.extensionPopupCount() > before, 2500)
    }
    check('clicking an extension icon opens its popup', engine.extensionPopupCount() > before, `icons=${count} popups=${engine.extensionPopupCount()}`)
    // The popup hangs under its button, which is at the right edge of the window: it must not leave the window (a wide one used to).
    await sleep(600)
    const popupWindows = ElectronWindow.getAllWindows().filter((w) => w !== win && w.getParentWindow()?.id === win.id && w.isVisible())
    const frame = win.getBounds()
    check(
      'the popup of an extension icon lies inside the window',
      popupWindows.length > 0 && popupWindows.every((w) => { const b = w.getBounds(); return b.x >= frame.x && b.y >= frame.y && b.x + b.width <= frame.x + frame.width && b.y + b.height <= frame.y + frame.height }),
      JSON.stringify({ frame, popups: popupWindows.map((w) => w.getBounds()) })
    )
  }

  // Extension shims: chrome.tabGroups, chrome.debugger and chrome.sidePanel as a real extension uses them.
  const probe = engine.listExtensions().find((e) => e.name === 'Lucium Side Panel Probe')
  // The run of the chain loads the probe: without it these checks are a failure, not a silence. A run without any extension says that it skips them.
  if (extensionPaths.length === 0) check('the tabGroups, sidePanel and debugger shims as an extension uses them', true, skippedBecause('no extension was loaded (LUCIUM_EXTENSIONS is empty)'))
  else requireProbes(engine.listExtensions(), ['Lucium Side Panel Probe'], check)
  if (probe) {
    const said = (name: string) => [...consoleEntries.keys()].find((k) => k.includes(`SIDEPANEL_PROBE_${name} `))
    await waitFor(() => !!said('SURFACE'), 8000)
    const surface = said('SURFACE') ?? ''
    check('the tabGroups, sidePanel and debugger APIs exist in the extension worker', /"sidePanel":"function"/.test(surface) && /"tabGroupsQuery":"function"/.test(surface) && /"tabGroupColor":"blue"/.test(surface) && /"debuggerAttach":"function"/.test(surface), surface.slice(0, 220))
    check('an extension can set the panel to open on icon click', await waitFor(() => !!said('BEHAVIOR')) && /"openPanelOnActionClick":true/.test(said('BEHAVIOR') ?? ''), said('BEHAVIOR'))
    check('tabGroups.query answers an empty list instead of crashing', /SIDEPANEL_PROBE_GROUPS \[\]/.test(said('GROUPS') ?? ''), said('GROUPS'))

    browser.dispatch({ type: 'tab/open', url: `${base}/dbg` })
    await waitFor(() => !!said('DEBUGGER') || !!said('DEBUGGER_ERROR'), 8000)
    check('chrome.debugger runs a DevTools command on a tab', /SIDEPANEL_PROBE_DEBUGGER 2/.test(said('DEBUGGER') ?? ''), said('DEBUGGER_ERROR') ?? said('DEBUGGER'))

    browser.dispatch({ type: 'tab/open', url: `${base}/panel` })
    await waitFor(() => browser.snapshot().sidePanel?.extensionId === probe.id, 8000)
    check('chrome.sidePanel.open docks the extension panel', browser.snapshot().sidePanel?.extensionId === probe.id, said('OPEN_ERROR'))
    check('the panel page runs with extension APIs and talks to the worker', await waitFor(() => !!said('MESSAGE')) && /SIDEPANEL_PROBE_MESSAGE panel/.test(said('MESSAGE') ?? ''), said('MESSAGE'))
    browser.closeSidePanel()
    const extensionEntry = Menu.getApplicationMenu()!.items.find((m) => m.label === 'Extensions')?.submenu?.items.find((item) => item.label === probe.name)
    check('the Extensions menu lists the loaded extensions', !!extensionEntry, Menu.getApplicationMenu()!.items.find((m) => m.label === 'Extensions')?.submenu?.items.map((i) => i.label).join(' | '))
    extensionEntry?.click()
    check('choosing one in the menu clicks its toolbar icon (the probe opens its side panel)', await waitFor(() => browser.snapshot().sidePanel?.extensionId === probe.id, 5000))
    browser.closeSidePanel()
    check('closing the panel removes it', browser.snapshot().sidePanel === null)
  }

  // Mini window: a separate small window, archived when closed, promoted to a tab on request.
  const littleId = little.open(`${base}/one`)
  check('a Little Arc window opens for a link', little.count() === 1)
  check('its page loads in that window and reports its title', await waitFor(() => little.states().find((l) => l.id === littleId)?.title === 'smoke /one'), JSON.stringify(little.states().map((l) => l.title)))
  little.close(littleId)
  check('closing it archives the page with the Little Arc source', await waitFor(() => little.count() === 0 && store.get().archive.some((a) => a.url.endsWith('/one') && a.source === 'little')), JSON.stringify(store.get().archive.slice(0, 2)))
  const secondId = little.open(`${base}/two`)
  await waitFor(() => little.states().find((l) => l.id === secondId)?.title === 'smoke /two')
  const promoted = little.states().find((l) => l.id === secondId)!.url
  const archiveBefore = store.get().archive.length
  little.command(secondId, 'open-in-main')
  check('"open in main window" turns the page into a tab and closes the Little Arc window', await waitFor(() => little.count() === 0 && store.get().tabs.some((t) => t.url === promoted)))
  check('a promoted page is not archived', store.get().archive.length === archiveBefore)

  const javascriptUrl = 'javascript:alert(1)'
  browser.submitUrl(javascriptUrl, 'new')
  check('non-web URLs are not opened as tabs', !store.get().tabs.some((t) => t.url.startsWith('javascript:')))

  // Each folder of LUCIUM_EXTENSIONS is looked for by the name of its own manifest: one loaded extension must not answer for the ten.
  for (const path of extensionPaths) checkExtensionFolder(path, engine.listExtensions(), check, (file) => readFileSync(file, 'utf8'))
  if (extensionPaths.length > 0) {
    // Let the probe register its declarativeNetRequest rule, then see whether a matching script request still reaches the server.
    await waitFor(() => probes.length > 0, 10_000)
    // The answer of the API probe is what the reference of the engine is compared with: a run where it never came measured nothing.
    if (extensionPaths.some((path) => path.endsWith('/api-probe'))) check('the API probe reported the chrome.* APIs it found', probes.length > 0)
    if (probes.length > 0) {
      // Control group: the same page also asks for a script the rule does not cover. It must arrive, the other must not.
      blockedScriptHits = 0
      allowedScriptHits = 0
      browser.dispatch({ type: 'tab/open', url: `${base}/dnr` })
      await waitFor(() => store.get().tabs.some((t) => t.title === 'smoke /dnr'))
      await sleep(1500)
      dnrControlHits = allowedScriptHits
      dnrEnforced = blockedScriptHits === 0 && allowedScriptHits > 0
    }
    await sleep(1500)
  }
  } catch (error) {
    check('the principal suite runs its own checks to the end (the parts below ran on the state it left)', false, String((error as Error)?.stack ?? error))
  }

  // A part that throws is one failed check (with the stack), and the parts after it still run: one broken step must not hide what the rest of the run would say.
  const context = { browser, store, engine, history, win, overlayView, little }
  // LUCIUM_SMOKE_SKIP=main:<part> leaves a part out (the Smoke (macOS) workflow does it for what a GitHub runner cannot pass: compat/runner-limits.json).
  const skipped = readSkips(process.env['LUCIUM_SMOKE_SKIP'], []).parts
  const seen = new Set<string>()
  const part = async (name: string, run: (ctx: SmokeContext, check: (name: string, ok: boolean, detail?: string) => void) => Promise<void>): Promise<void> => {
    seen.add(name)
    if (skipped.has(name)) {
      console.log(`[smoke] part "${name}" left out on request (LUCIUM_SMOKE_SKIP)`)
      return
    }
    try {
      await run(context, check)
    } catch (error) {
      check(`the part "${name}" runs to the end`, false, String((error as Error).stack ?? error))
    }
  }
  await part('sidebar', smokeSidebar)
  await part('settings', smokeSettings)
  await part('pages', smokePages)
  await part('sleep', smokeSleep)
  await part('iso-menus', smokeIsoMenus)
  await part('iso-sidebar', smokeIsoSidebar)
  await part('iso-settings', smokeIsoSettings)
  await part('iso-toolbar', smokeIsoToolbar)
  await part('iso-plus', smokeIsoPlus)
  await part('sec2', smokeSec2)
  await part('sec1', smokeSec1)
  await part('iso-media', smokeIsoMedia)
  // A part named in the list that does not exist is a typing mistake: it would leave out nothing, and say nothing.
  for (const name of skipped) if (!seen.has(name)) check(`LUCIUM_SMOKE_SKIP names a part of the principal suite: "${name}"`, false, [...seen].join(', '))

  server.close()
  server.closeAllConnections()
  // Measured, not judged here: `pnpm compat:compare` sets them against the reference of the engine (shared/compat-report.ts).
  reportFact('apiProbe', probes)
  reportFact('declarativeNetRequestEnforced', dnrEnforced)
  const failed = checks.filter((c) => !c.ok)
  const report = {
    engine: info,
    checks,
    runningExtensionWorkers: engine.runningExtensionWorkers(),
    apiProbe: probes,
    compat: { declarativeNetRequestEnforced: dnrEnforced, uncoveredScriptRequests: dnrControlHits },
    extensionConsole: Object.fromEntries(consoleEntries),
    failed: failed.length
  }
  console.log(`LUCIUM_SMOKE ${JSON.stringify(report, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

/** `LUCIUM_SMOKE_ONLY=parts LUCIUM_SMOKE_PARTS=settings,pages`: only these parts of the principal suite, each on a fresh application and with its own report
 *  (a quick loop: the whole principal suite takes minutes). Names: commandbar, sidebar, settings, pages, sleep, iso-menus, iso-sidebar, iso-settings, iso-toolbar, iso-plus, sec2, sec1, iso-media. */
export async function runMainParts(ctx: SmokeContext, names: string[]): Promise<number> {
  const parts: Record<string, (context: SmokeContext, check: (name: string, ok: boolean, detail?: string) => void) => Promise<void>> = {
    commandbar: smokeCommandBar,
    sidebar: smokeSidebar,
    settings: smokeSettings,
    pages: smokePages,
    sleep: smokeSleep,
    'iso-menus': smokeIsoMenus,
    'iso-sidebar': smokeIsoSidebar,
    'iso-settings': smokeIsoSettings,
    'iso-toolbar': smokeIsoToolbar,
    'iso-plus': smokeIsoPlus,
    sec2: smokeSec2,
    sec1: smokeSec1,
    'iso-media': smokeIsoMedia
  }
  const checks: Check[] = []
  const check = recorderOf(checks)
  // What the principal suite leaves for the parts that follow it: no tab is put to sleep by the clock (tabs of a part would be asleep when it looks at them).
  ctx.browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
  for (const name of names) {
    const part = parts[name]
    if (!part) {
      check(`part "${name}" exists`, false, Object.keys(parts).join(', '))
      continue
    }
    console.log(`[smoke] == part: ${name}`)
    try {
      await part(ctx, check)
    } catch (error) {
      check(`part "${name}" runs to the end`, false, String((error as Error).stack ?? error))
    }
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PARTS ${JSON.stringify({ checks: failed, total: checks.length, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
