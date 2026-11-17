// Engine checks for three things of the running browser, in a real Electron:
//  - sharing the screen in a call (getDisplayMedia): who may ask, the prompt of the web permissions, what is remembered and how it is taken
//    back from the site panel, and what reaches the picker;
//  - a local page that reads nothing else of the disk (engine/local-file-guard.ts);
//  - the memory and processor of a tab on its hover card: real mouse, the setting that is off by default, a frozen and a sleeping tab, the
//    polling that stops with the card.
// Called from the engine smoke test: `await smokeRuntime(ctx, check)`. `LUCIUM_SMOKE_ONLY=runtime` runs only this file.
//
// NOTHING IS EVER CAPTURED HERE, and no macOS authorization is touched. The pages are refused, or they reach a handler whose menu is a stub
// that closes without a pick. The handler the engine installs lists the screens and windows (which may make macOS ask for the right to record
// the screen) and shows Lucium's own menu; it never asks for the system's picker (`useSystemPicker`, which crashes the application in
// Electron 45). So every session a page can reach gets the stub (never the real handler) before any prompt is answered with "Autoriser", and the
// check of what the engine installs looks at the call, on a session that is thrown away.

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, session, type Session, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { createDisplayMediaHandler } from './engine/display-media'
import { getWindowManager } from './shell/windows'
import type { Browser } from './shell/browser'
import type { SmokeContext } from './smoke'
import { noteCheck, openSiteSections, recorderOf, sleep, waiterOf } from './smoke-kit'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Box {
  x: number
  y: number
  w: number
  h: number
}


const waitFor = waiterOf(6000, 60)

const near = (actual: number | undefined, expected: number, tolerance = 1) => actual !== undefined && Math.abs(actual - expected) <= tolerance

/** The page that asks to share: a click on the button, or `__ask()` from a script (no click). Whatever it gets, it lets go of at once. */
const SHARE_PAGE = `<title>partage</title><body style="margin:0">
<button id="go" style="position:fixed;left:20px;top:20px;width:160px;height:60px">Partager</button>
<script>
window.__result = 'idle'
window.__ask = () => {
  window.__result = 'pending'
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(
    (stream) => { stream.getTracks().forEach((t) => t.stop()); return (window.__result = 'granted') },
    (error) => (window.__result = error.name)
  )
}
document.getElementById('go').addEventListener('click', () => { window.__ask() })
</script></body>`

export async function smokeRuntime(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const chrome = win.webContents
  const state = () => store.get()

  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    res.end(req.url?.startsWith('/share') ? SHARE_PAGE : `<title>page ${req.url}</title><body>runtime ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const origin = base

  const mine = new Set<string>()
  const wcOf = (b: Browser, id: string) => (b.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const openTab = async (b: Browser, bStore: SmokeContext['store'], url: string, title?: string): Promise<{ id: string; wc: WebContents }> => {
    b.dispatch({ type: 'tab/open', url })
    const tab = bStore.get().tabs.at(-1)!
    if (b === browser) mine.add(tab.id)
    if (title) b.dispatch({ type: 'tab/rename', id: tab.id, title })
    await waitFor(() => wcOf(b, tab.id) !== undefined && b.snapshot().runtime.tabs[tab.id]?.loading === false)
    await sleep(200)
    return { id: tab.id, wc: wcOf(b, tab.id)! }
  }

  // ---- the stub that stands in for the system picker: it records what reached it and closes without a pick ----
  const reached: Array<{ frameUrl: string | undefined; userGesture: boolean; audioRequested: boolean }> = []
  const offered: string[][] = []
  const blockedNotices: string[] = []
  const stub = createDisplayMediaHandler({
    platform: process.platform,
    screenAccess: () => 'granted',
    listSources: async () => [
      { id: 'screen:1:0', name: 'Entire Screen' },
      { id: 'window:7:0', name: 'Fenêtre factice' }
    ],
    choose: async (request, choices) => {
      reached.push({ frameUrl: request.frame?.url, userGesture: request.userGesture, audioRequested: request.audioRequested })
      offered.push(choices.map((c) => c.label))
      return null
    },
    blocked: (_request, notice) => void blockedNotices.push(notice),
    warn: () => {}
  })
  const stubbed = new Set<Session>()
  const withStub = (ses: Session) => {
    stubbed.add(ses)
    ses.setDisplayMediaRequestHandler(stub, { useSystemPicker: false })
  }

  const savedBounds = win.getBounds()
  const previous = { space: state().activeSpaceId, settings: { allowScreenShare: state().settings.allowScreenShare, sidebarVisible: state().settings.sidebarVisible, sidebarWidth: state().settings.sidebarWidth, hoverCards: state().settings.hoverCards, showTabMemory: state().settings.showTabMemory, sleepAfterMinutes: state().settings.sleepAfterMinutes } }
  const realWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    realWarn(...args)
  }
  // What the window of the interface writes to its console (it exists already, so it is listened to by hand).
  const pageMessages: string[] = []
  const onConsole = (event: unknown, ...legacy: unknown[]) => {
    pageMessages.push(String((event as { message?: unknown })?.message ?? legacy[1]))
  }
  chrome.on('console-message', onConsole)
  let createdSpace: string | undefined
  let defaultSession: Session | undefined
  let tempDir: string | undefined

  try {
    // Nothing may be put to sleep by the delay while the checks run: only the sleeps asked for.
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

    // =========================================================== sharing the screen ===========================================================
    // ---- the engine asks for the system picker, and lets go of the handler with the session ----
    // The call is watched on a session made for this check, and the real handler is made to run without the system picker whatever it asked.
    const proto = Object.getPrototypeOf(session.defaultSession) as { setDisplayMediaRequestHandler: (this: Session, handler: unknown, options?: { useSystemPicker?: boolean }) => void }
    const realSet = proto.setDisplayMediaRequestHandler
    const installs: Array<{ handler: unknown; useSystemPicker: boolean | undefined }> = []
    proto.setDisplayMediaRequestHandler = function (this: Session, handler, options) {
      installs.push({ handler, useSystemPicker: options?.useSystemPicker })
      return realSet.call(this, handler, handler ? { ...options, useSystemPicker: false } : options)
    }
    try {
      const scope = engine.openEphemeral('runtime-smoke')
      await scope.dispose()
    } finally {
      proto.setDisplayMediaRequestHandler = realSet
    }
    // Lucium's own list of screens and windows, never the system's picker, which crashes the application (ScreenCaptureKit; engine/electron-engine-permissions.ts `installDisplayMedia`).
    check('share: the engine installs its own picker on the session it makes for a page, never the system one (it crashes the application)', installs.length >= 1 && typeof installs[0]!.handler === 'function' && installs[0]!.useSystemPicker === false, JSON.stringify(installs.map((i) => [typeof i.handler, i.useSystemPicker])))
    check('share: ...and lets go of the handler when that session is released (a private window that closed)', installs.at(-1)?.handler === null, JSON.stringify(installs.map((i) => typeof i.handler)))

    // ---- from here every page of the main window shares through the stub ----
    const first = await openTab(browser, store, `${base}/share`)
    defaultSession = first.wc.session
    withStub(defaultSession)
    check('share: the stub is on the session of the tabs (otherwise the checks below could reach the system picker)', session.fromPartition('persist:profile-default') === defaultSession)
    if (session.fromPartition('persist:profile-default') !== defaultSession) throw new Error('the session of the tabs is not the one the stub was put on: stopped before any prompt')

    const asker = browser as unknown as { overlayRequest: { panel: string; request?: { id: string } } | null }
    const askedPanel = () => asker.overlayRequest?.panel === 'permission'
    const resultOf = (wc: WebContents) => wc.executeJavaScript('window.__result') as Promise<string>
    const settled = async (wc: WebContents) => {
      // One read per turn: two reads let the click land between them, and "pending" then passed for a settled answer.
      await waitFor(async () => {
        const now = await resultOf(wc)
        return now !== 'pending' && now !== 'idle'
      }, 6000)
      return resultOf(wc)
    }
    const click = async (wc: WebContents, x = 60, y = 40) => {
      wc.focus()
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    }
    const promptText = () => overlayView.webContents.executeJavaScript(`document.querySelector('.iv-bubble')?.innerText ?? ''`) as Promise<string>
    const hasRemember = () => overlayView.webContents.executeJavaScript(`!!document.querySelector('.iv-bubble .iv-remember')`) as Promise<boolean>
    const answer = (b: Browser, allow: boolean, remember: boolean) => {
      const id = (b as unknown as typeof asker).overlayRequest?.request?.id
      if (id) b.answerPermission(id, allow, remember)
    }
    const remembered = () => state().sitePermissions[origin]?.['display-capture']
    const reset = async (wc: WebContents) => {
      await wc.executeJavaScript(`window.__result = 'idle'`)
    }
    /** A request from a script, with no click: started, not awaited (a request that wrongly reaches the prompt would hang), and the prompt it left is closed. */
    const scripted = async (b: Browser, wc: WebContents) => {
      await reset(wc)
      await wc.executeJavaScript('void window.__ask(); 0')
      const result = await settled(wc)
      if ((b as unknown as typeof asker).overlayRequest?.panel === 'permission') answer(b, false, false)
      return result
    }
    browser.closeOverlay()

    // ---- no click behind the request: refused, and the user is not asked ----
    const asNoClick = await scripted(browser, first.wc)
    check('share: getDisplayMedia from a script, with no click in the tab, is refused (NotAllowedError)', asNoClick === 'NotAllowedError', asNoClick)
    check('...and the user is not asked, and nothing reaches the picker', !askedPanel() && reached.length === 0, `${asker.overlayRequest?.panel} / ${reached.length}`)
    check('...and the log says why, with the origin', warnings.some((w) => w.includes('refused to share the screen') && w.includes(origin)), warnings.slice(-2).join(' | '))

    // ---- a click: the prompt of the web permissions ----
    await reset(first.wc)
    await click(first.wc)
    const asked = await waitFor(askedPanel)
    await waitFor(async () => (await promptText()).length > 0)
    const text = await promptText()
    check('share: with a click, the user is asked, in the prompt of the web permissions, naming the site and what it wants', asked && text.includes('127.0.0.1') && text.includes('partager votre écran ou une fenêtre'), text)
    check('...and the prompt offers to remember the answer', await hasRemember())
    answer(browser, false, false)
    const refused = await settled(first.wc)
    check('share: "Refuser" leaves the page with a NotAllowedError, and nothing was offered to pick', refused === 'NotAllowedError' && reached.length === 0 && !askedPanel(), `${refused} / ${reached.length}`)
    check('...and, not asked to remember, nothing is kept', remembered() === undefined, JSON.stringify(state().sitePermissions))

    // ---- "Refuser" + remember: refused at once next time; the site panel names it and takes it back ----
    await reset(first.wc)
    await click(first.wc)
    await waitFor(askedPanel)
    answer(browser, false, true)
    await settled(first.wc)
    check('share: a refusal that is remembered is kept for the site', remembered() === 'deny', JSON.stringify(state().sitePermissions))
    await reset(first.wc)
    await click(first.wc)
    const quick = await settled(first.wc)
    check('...and the next request is refused with no question', quick === 'NotAllowedError' && !askedPanel(), `${quick} / ${asker.overlayRequest?.panel}`)

    browser.openOverlay({ panel: 'site' })
    await waitFor(() => asker.overlayRequest?.panel === 'site')
    // The row is in a section of the panel that is folded until it is opened.
    await sleep(500)
    await openSiteSections((script) => overlayView.webContents.executeJavaScript(script))
    // The row of a permission (SitePermissions.tsx): its name, the answer, « Oublier » beside it and the choice Demander / Autoriser / Bloquer.
    const siteRow = () =>
      overlayView.webContents.executeJavaScript(`(() => { const row = [...document.querySelectorAll('.scc-perm')].find((r) => r.querySelector('strong')?.textContent === 'Partage d’écran'); if (!row) return null; row.scrollIntoView({ block: 'center' }); const forget = row.querySelector('.scc-perm-forget'); const r = (forget ?? row).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: row.innerText, forget: !!forget } })()`) as Promise<(Box & { text: string; forget: boolean }) | null>
    await waitFor(async () => (await siteRow()) !== null)
    const row = await siteRow()
    check('share: the site panel lists the remembered answer by its French name, with the answer', !!row && row.text.includes('Refusé') && row.forget, row ? `${row.text} / forget ${row.forget}` : 'absent')
    if (row?.forget) {
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) overlayView.webContents.sendInputEvent({ type, x: Math.round(row.x + row.w / 2), y: Math.round(row.y + row.h / 2), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    }
    check('...and a click on « Oublier » in that row takes the answer back', await waitFor(() => remembered() === undefined), JSON.stringify(state().sitePermissions))
    browser.closeOverlay()
    await reset(first.wc)
    await click(first.wc)
    check('...after which the site is asked again', await waitFor(askedPanel))
    answer(browser, false, false)
    await settled(first.wc)

    // ---- a remembered "Autoriser": no question, but never without a click; with one, it reaches the picker (the stub here) ----
    browser.dispatch({ type: 'permission/set', origin, permission: 'display-capture', decision: 'allow' })
    const beforeReached = reached.length
    const allowedNoClick = await scripted(browser, first.wc)
    check('share: an answer "Autoriser" that is remembered still does not let a script share with no click in the tab', allowedNoClick === 'NotAllowedError' && reached.length === beforeReached && !askedPanel(), `${allowedNoClick} / ${reached.length - beforeReached}`)
    await reset(first.wc)
    await click(first.wc)
    const afterCancel = await settled(first.wc)
    check('share: with a click it goes to the picker with no question; the picker closed without a pick, the page is refused', !askedPanel() && reached.length === beforeReached + 1 && afterCancel === 'AbortError', `${afterCancel} / ${reached.length - beforeReached}`)
    const last = reached.at(-1)
    check('...the picker was reached by the page that asked, with its click and its request for sound', last?.frameUrl === `${base}/share` && last.userGesture === true && last.audioRequested === true, JSON.stringify(last))
    check('...and it was offered the displays and the windows, by name', JSON.stringify(offered.at(-1)) === JSON.stringify(['Écran entier', 'Fenêtre factice']), JSON.stringify(offered.at(-1)))
    browser.dispatch({ type: 'permission/set', origin, permission: 'display-capture', decision: null })

    // ---- "Autoriser" for this time only ----
    await reset(first.wc)
    await click(first.wc)
    await waitFor(askedPanel)
    answer(browser, true, false)
    const once = await settled(first.wc)
    check('share: "Autoriser" this time reaches the picker, and keeps nothing', once === 'AbortError' && reached.length === beforeReached + 2 && remembered() === undefined, `${once} / ${reached.length - beforeReached} / ${JSON.stringify(state().sitePermissions)}`)

    // ---- the switch: off, every request is refused with no question, even with a click and a remembered "Autoriser" ----
    browser.dispatch({ type: 'settings/update', patch: { allowScreenShare: false } })
    browser.dispatch({ type: 'permission/set', origin, permission: 'display-capture', decision: 'allow' })
    const reachedOff = reached.length
    await reset(first.wc)
    await click(first.wc)
    const switchedOff = await settled(first.wc)
    check('share: with the setting off, a click is refused (NotAllowedError) with no question and nothing reaching the picker', switchedOff === 'NotAllowedError' && !askedPanel() && reached.length === reachedOff, `${switchedOff} / ${asker.overlayRequest?.panel} / ${reached.length - reachedOff}`)
    check('...and the log says it is the setting', warnings.some((w) => w.includes('turned off in the settings')), warnings.slice(-2).join(' | '))
    browser.dispatch({ type: 'settings/update', patch: { allowScreenShare: true } })
    await reset(first.wc)
    await click(first.wc)
    const switchedOn = await settled(first.wc)
    check('share: with the setting back on, the remembered answer goes to the picker again', switchedOn === 'AbortError' && reached.length === reachedOff + 1, `${switchedOn} / ${reached.length - reachedOff}`)
    browser.dispatch({ type: 'permission/set', origin, permission: 'display-capture', decision: null })

    // ---- a page that is not a web page ----
    tempDir = mkdtempSync(join(tmpdir(), 'lucium-runtime-'))
    const filePath = join(tempDir, 'share.html')
    writeFileSync(filePath, SHARE_PAGE)
    const filePage = await openTab(browser, store, `file://${filePath}`)
    withStub(filePage.wc.session)
    const fileReached = reached.length
    await click(filePage.wc)
    const fileResult = await settled(filePage.wc)
    check('share: a file: page that clicks and asks is refused at once, with no question and nothing reaching the picker', fileResult === 'NotAllowedError' && !askedPanel() && reached.length === fileReached, `${fileResult} / ${asker.overlayRequest?.panel}`)
    check('...and nothing is remembered for the origin "null"', state().sitePermissions['null'] === undefined)
    browser.dispatch({ type: 'tab/close', id: filePage.id })

    // ---- a local page reads nothing else of the disk, though the fuse grantFileProtocolExtraPrivileges is on (engine/local-file-guard.ts) ----
    writeFileSync(join(tempDir, 'secret.txt'), 'SECRET-OF-THE-DISK')
    writeFileSync(join(tempDir, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync(join(tempDir, 'local.html'), '<title>local</title><body><img id="dot" src="dot.png"></body>')
    const localPage = await openTab(browser, store, `file://${join(tempDir, 'local.html')}`)
    const fetched = String(await localPage.wc.executeJavaScript(`fetch('secret.txt').then((r) => r.text()).catch(() => 'refused')`))
    const framed = String(
      await localPage.wc.executeJavaScript(`new Promise((done) => {
        const frame = document.createElement('iframe')
        frame.src = 'secret.txt'
        frame.onload = () => { let text = 'refused'; try { text = frame.contentDocument?.body?.textContent ?? 'refused' } catch {} ; done(text) }
        document.body.append(frame)
        setTimeout(() => done('refused'), 3000)
      })`)
    )
    const shown = await localPage.wc.executeJavaScript(`new Promise((done) => { const image = document.getElementById('dot'); if (image.complete) done(image.naturalWidth); else { image.onload = () => done(image.naturalWidth); image.onerror = () => done(0) } })`)
    check('local file: a local page cannot fetch another file of the disk', !fetched.includes('SECRET'), fetched.slice(0, 40))
    check('local file: ...nor read one through a frame', !framed.includes('SECRET'), framed.slice(0, 40))
    check('local file: ...and still shows the image that lies beside it', shown === 1, String(shown))
    browser.dispatch({ type: 'tab/close', id: localPage.id })

    // ---- the tell-tale when the system does not let the application see the screen ----
    const enginePage = (engine as unknown as { pages: Map<string, { screenShareBlocked(notice: string): void }> }).pages.get(first.id)
    enginePage?.screenShareBlocked('Autorisez Lucium à enregistrer l’écran (essai).')
    check('share: when the system refuses the recording of the screen, the user reads where to change it in a notice', !!enginePage && browser.snapshot().toast?.message === 'Autorisez Lucium à enregistrer l’écran (essai).', browser.snapshot().toast?.message)

    // ---- a private window: its own prompt, its own memory, and the same refusals ----
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    try {
      const privTab = await openTab(priv.browser, priv.store, `${base}/share`)
      withStub(privTab.wc.session)
      const privAsker = priv.browser as unknown as typeof asker
      const privNoClick = await scripted(priv.browser, privTab.wc)
      check('share: in a private window too, a script with no click is refused', privNoClick === 'NotAllowedError' && privAsker.overlayRequest?.panel !== 'permission', privNoClick)
      await reset(privTab.wc)
      await click(privTab.wc)
      const privAsked = await waitFor(() => privAsker.overlayRequest?.panel === 'permission')
      check('share: ...and a click asks in the private window (not in the main one)', privAsked && !askedPanel())
      answer(priv.browser, false, true)
      const privResult = await settled(privTab.wc)
      check('share: ...whose answer stays in the private window\'s own memory', privResult === 'NotAllowedError' && priv.store.get().sitePermissions[origin]?.['display-capture'] === 'deny' && remembered() === undefined, `${privResult} / ${JSON.stringify(priv.store.get().sitePermissions)}`)
    } finally {
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
    }

    // =========================================================== memory and processor on the card ===========================================================
    const bounds = screen.getPrimaryDisplay().workArea
    win.setBounds({ x: bounds.x, y: bounds.y, width: 1200, height: 800 })
    await sleep(600)
    browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, sidebarWidth: 323, hoverCards: false, showTabMemory: false } })
    browser.dispatch({ type: 'space/create', name: 'Mémoire ISO', emoji: '📊', hue: 150 })
    createdSpace = state().activeSpaceId
    const alpha = await openTab(browser, store, `${base}/alpha`, 'Alpha')
    const beta = await openTab(browser, store, `${base}/beta`, 'Beta')
    const gamma = await openTab(browser, store, `${base}/gamma`, 'Gamma')
    const delta = await openTab(browser, store, `${base}/delta`, 'Delta')
    const slept = await browser.sleepNow(gamma.id)
    const froze = await browser.sleepNow(beta.id, 'freeze')
    // No wait for this one: the two sleeps were awaited, and what it reads is the state they left.
    check('card: the tabs are set up (one awake and hidden, one frozen, one asleep, one on screen)', slept && froze && browser.sleepStateOf(beta.id) === 'frozen' && browser.sleepStateOf(gamma.id) === 'asleep' && browser.sleepStateOf(alpha.id) === 'awake')
    browser.dispatch({ type: 'tab/select', id: delta.id })
    // Lets the window show that tab before the pointer goes over the rows: nothing says when it has been drawn.
    await sleep(500)

    const evaluate = <T>(script: string) => chrome.executeJavaScript(script) as Promise<T>
    const rowRect = (name: string) => evaluate<Box | null>(`(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    const cardBox = () => evaluate<(Box & { text: string }) | null>(`(() => { const el = document.querySelector('.hover-card'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.innerText } })()`)
    const mouse = (type: 'mouseMove', x: number, y: number) => chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y) } as Electron.MouseInputEvent)
    const park = async () => {
      mouse('mouseMove', 800, 500)
      await sleep(200)
    }
    /** The card of a tab, with the real mouse: the pointer comes from outside, rests on the row, and the card shows after about 1.5 s. */
    const hover = async (name: string) => {
      let target = { x: 0, y: 0, rect: { x: 0, y: 0, w: 0, h: 0 } as Box }
      for (let attempt = 1; attempt <= 3; attempt++) {
        win.focus()
        await park()
        const rect = (await rowRect(name))!
        target = { x: rect.x + rect.w * 0.4, y: rect.y + rect.h / 2, rect }
        mouse('mouseMove', target.x, target.y)
        if (await waitFor(async () => (await cardBox()) !== null, 2600)) break
      }
      return target
    }
    // The calls to the main process that give the figures, counted.
    const spy = browser as unknown as { tabResources: Browser['tabResources'] }
    const realResources = spy.tabResources.bind(browser)
    let measured = 0
    spy.tabResources = (...args) => {
      measured++
      return realResources(...args)
    }

    // ---- off by default: the card is the plain one, and nothing is measured ----
    check('card: the setting is off by default, so the card is Arc\'s', ctx.store.get().settings.showTabMemory === false)
    const offTarget = await hover('Alpha')
    const offCard = await cardBox()
    // A fixed wait, for want of a witness: what is checked is that time passes with the card open and nothing asked; a measure would come at the
    // card's own pace, and nothing says it will not.
    await sleep(1800)
    check('card: with the setting off, the card holds the name and the hint to rename, and no line of figures', !!offCard && offCard.text.includes('Alpha') && offCard.text.includes('Double-cliquez pour renommer') && !offCard.text.includes('Mémoire'), offCard?.text)
    check('card: ...and no measure is asked of the main process while it is open', measured === 0, String(measured))
    await park()

    // ---- on: a line with the memory, then the processor a second later ----
    browser.dispatch({ type: 'settings/update', patch: { showTabMemory: true } })
    const onTarget = await hover('Alpha')
    const firstText = (await cardBox())?.text ?? ''
    check('card: with the setting on, the card has a line of memory and processor for the tab', /Mémoire (…|\d)/.test(firstText) && firstText.includes('Processeur'), firstText)
    const complete = await waitFor(async () => anySpace(/Mémoire \d+(,\d)? (Mo|Go) · Processeur \d+,\d %/).test((await cardBox())?.text ?? ''), 4500)
    const onCard = await cardBox()
    check('card: ...which gives the processor figure once a second measure exists', complete, onCard?.text)
    const pid = (browser.pageFor(alpha.id) as unknown as { processId(): number }).processId()
    const metric = app.getAppMetrics().find((m) => m.pid === pid)
    const shownMb = Number(anySpace(/Mémoire (\d+)(?:,\d)? (Mo|Go)/).exec(onCard?.text ?? '')?.[1] ?? NaN)
    const metricMb = (metric?.memory.workingSetSize ?? 0) / 1024
    check('card: the memory shown is the one Electron reports for the tab\'s own process', !!metric && Number.isFinite(shownMb) && Math.abs(shownMb - metricMb) <= Math.max(30, metricMb * 0.5), `${shownMb} Mo shown / ${metricMb.toFixed(0)} Mo measured for pid ${pid}`)
    check('card: ...and it was asked for more than once while the card stayed open', measured >= 2, String(measured))
    check('card: the line adds one row to the card and nothing else moves (same corner as the card without it)', !!offCard && !!onCard && near(onCard.h - offCard.h, 17, 1.5) && onTarget.rect.y === offTarget.rect.y, `${offCard?.h} -> ${onCard?.h}`)
    check('card: ...which starts 11 px right of the pointer (pulled back inside the sidebar) and covers the last 11 px of the row', !!onCard && near(onCard.x, Math.min(onTarget.x + 11, 323 - 6 - onCard.w), 2) && near(onCard.y, onTarget.rect.y + onTarget.rect.h - 11, 1.5), `${onCard && JSON.stringify(onCard)} / pointer ${onTarget.x},${onTarget.y}`)
    check('card: ...and stays inside the sidebar', !!onCard && onCard.x >= 0 && onCard.x + onCard.w <= 323, JSON.stringify(onCard))
    // The card is gone: no more measures.
    await park()
    await waitFor(async () => (await cardBox()) === null, 2000)
    const atClose = measured
    // A fixed wait, for want of a witness: what is checked is that time passes and nothing is asked; nothing says it will not be.
    await sleep(3800)
    check('card: once the pointer leaves, nothing is measured any more (no polling in the background)', (await cardBox()) === null && measured === atClose, `${atClose} -> ${measured}`)

    // ---- a frozen tab and a sleeping tab have no figure to give ----
    // A frozen tab keeps its process and shows dashes; a sleeping tab has none, and the card says so in words (HoverCard.tsx, « Mémoire libérée »).
    const sleepers: Array<[string, string, string]> = [['Beta', 'frozen', 'Mémoire — · Processeur —'], ['Gamma', 'sleeping', 'Mémoire libérée']]
    for (const [name, kind, line] of sleepers) {
      await hover(name)
      const done = await waitFor(async () => ((await cardBox())?.text ?? '').includes(line), 3000)
      const card = await cardBox()
      check(`card: a ${kind} tab shows no figure for the memory and the processor ("${line}")`, done && !!card && card.text.includes(line) && !/Mémoire \d|Processeur \d/.test(card.text), card?.text)
      await park()
    }
    // The page of a frozen tab keeps its process: the dash is a choice of the card (nothing to show of a page that runs nothing), not a missing process.
    check('card: ...the frozen page still has its process (the dash is the card\'s choice for a page that runs nothing)', (browser.pageFor(beta.id) as unknown as { processId(): number }).processId() > 0)

    // ---- the process of another tab never shows, and a stranger gets nothing ----
    const viaIpc = (id: unknown) => evaluate<unknown>(`window.lucium.tabResources(${JSON.stringify(id)})`)
    const own = (await viaIpc(alpha.id)) as { memoryMb: number; cpu: number; shared: boolean } | null
    check('card: the interface gets the figures of a tab of the window through the preload', !!own && own.memoryMb > 0 && typeof own.cpu === 'number' && own.shared === false, JSON.stringify(own))
    const odd = await Promise.all([viaIpc('ghost'), viaIpc(42), viaIpc(null), viaIpc({}), viaIpc(gamma.id), viaIpc(beta.id)])
    check('card: a tab that does not exist, a value that is not a tab id, a sleeping tab and a frozen one give nothing', odd.every((v) => v === null), JSON.stringify(odd))
    const stranger = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true } })
    try {
      await stranger.loadURL(`${base}/stranger`)
      warnings.length = 0
      const reply = await stranger.webContents.executeJavaScript(`window.lucium.tabResources(${JSON.stringify(alpha.id)})`)
      check('card: a page that is not one of our surfaces gets no figures, and the refusal is logged', reply === undefined && warnings.some((w) => w.includes('untrusted sender')), `${JSON.stringify(reply)} / ${warnings.join(' | ').slice(0, 200)}`)
    } finally {
      stranger.destroy()
    }

    // ---- the main process fails to answer: "—" on the card, and the cause in the console ----
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers
    const originalHandler = handlers.get(Channel.tabResources)
    check('card: the channel is a registered handler (the control for the next check)', typeof originalHandler === 'function')
    handlers.set(Channel.tabResources, async () => {
      throw new Error('forced: no figures')
    })
    pageMessages.length = 0
    try {
      await hover('Alpha')
      const failed = await waitFor(async () => ((await cardBox())?.text ?? '').includes('Mémoire — · Processeur —'), 3000)
      check('card: when the main process cannot answer, the line says "—"', failed, (await cardBox())?.text)
      check('card: ...and the cause is written to the console of the window, with its context', pageMessages.some((m) => m.includes('[hover card] no resources for the tab')), pageMessages.join(' | ').slice(0, 300))
      await park()
    } finally {
      if (originalHandler) handlers.set(Channel.tabResources, originalHandler)
    }

    // ---- with the preview on, the line comes after the address and the state ----
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: true } })
    await hover('Gamma')
    const previewText = (await cardBox())?.text ?? ''
    const order = ['Gamma', 'En veille', 'Mémoire', 'Double-cliquez pour renommer'].map((s) => previewText.indexOf(s))
    check('card: with the preview, the line sits after the state and before the hint', order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), previewText.replace(/\n/g, ' | '))
    await park()

    // ---- off again: gone ----
    browser.dispatch({ type: 'settings/update', patch: { showTabMemory: false, hoverCards: false } })
    measured = 0
    await hover('Alpha')
    await sleep(1500)
    const offAgain = await cardBox()
    check('card: turned off again, the line is gone and nothing is measured', !!offAgain && !offAgain.text.includes('Mémoire') && measured === 0, `${offAgain?.text} / ${measured}`)
    await park()
    spy.tabResources = realResources as Browser['tabResources']
  } finally {
    // The suites that follow in the chain (the capture of the sound of a tab) use the handler of the engine on the sessions of the tabs: the stub of this suite
    // would refuse their requests. A throw-away session (a private window that closed) is not put back: it is gone with its window.
    const putBack = (engine as unknown as { installDisplayMedia?: (ses: Session) => void }).installDisplayMedia
    let restored = typeof putBack === 'function'
    for (const ses of stubbed) {
      if (!ses.isPersistent()) continue
      try {
        putBack?.call(engine, ses)
      } catch (error) {
        restored = false
        console.warn('[runtime-smoke] the handler of the engine could not be put back on a session:', error)
      }
    }
    check('share: the handler of the engine is put back on the sessions of the tabs when the checks end (the suites after this one need it)', restored)
    console.warn = realWarn
    chrome.off('console-message', onConsole)
    browser.dispatch({ type: 'permission/set', origin, permission: 'display-capture', decision: null })
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    if (createdSpace) browser.dispatch({ type: 'space/delete', id: createdSpace })
    if (state().spaces.some((s) => s.id === previous.space)) browser.dispatch({ type: 'space/select', id: previous.space })
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: previous.settings })
    win.setBounds(savedBounds)
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=runtime`: only these checks, with their own report. */
export async function runRuntimeSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeRuntime(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeRuntime ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_RUNTIME ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
