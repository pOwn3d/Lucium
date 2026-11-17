// Engine checks for the box of a page's `window.prompt()`, `alert()` and `confirm()`, run inside a real Electron. A local server serves the pages;
// the clicks and the keys are real (`sendInputEvent`, on the page and on the panel), so the whole way is walked: the replaced function of the
// page, the message to the main process, the panel over the window, the keys of the user, and the answer that reaches the page, which is blocked
// in between. Where Lucium leaves a call to Electron's own sheet (a frame of another site, a window that is not a tab), the sheet is taken over
// while the check runs (`watchNative`), so that no sheet of macOS waits for a click.
// Nothing real is typed: the values are made up. Called from the engine smoke test: `await smokeDialogs(ctx, check)`.

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { BrowserWindow, type WebContents } from 'electron'
import { PROMPT_CANCELLED, type DialogRequest } from '@shared/page-dialog'
import type { Browser } from './shell/browser'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 50)

/** A script run in a page or panel, with a limit: one that never answers fails the check that asked instead of hanging the run. */
const evaluate = <T>(wc: WebContents, script: string, timeoutMs = 8000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to a script after ${timeoutMs} ms: ${script.slice(0, 80)}`)), timeoutMs)
    ;(wc.executeJavaScript(script) as Promise<T>).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The secret-looking value typed in the panel: made up, and looked for in every log at the end. */
const TYPED = 'valeur-test-4821'
const PROMPT_TEXT = 'Mot de passe maître pour essai ?'

const PAGE = (query: string): string => `<title>dialogs ${query}</title><body style="margin:0">
  <button id="ask" style="position:absolute;left:10px;top:10px;width:220px;height:34px" onclick="window.__r = prompt('${PROMPT_TEXT}', 'défaut'); window.__after = 'ran'">ask</button>
  <button id="long" style="position:absolute;left:10px;top:60px;width:220px;height:34px" onclick="window.__r = prompt('bank.example demande :\\n&lt;img src=x onerror=window.__xss=1&gt;\\n' + 'x'.repeat(3000), 'd'); window.__after = 'ran'">long</button>
  <button id="many" style="position:absolute;left:10px;top:110px;width:220px;height:34px" onclick="window.__n = (window.__n || 0) + 1; window.__r = prompt('boîte ' + window.__n); window.__after = 'ran' + window.__n">many</button>
  <button id="beacon" style="position:absolute;left:10px;top:160px;width:220px;height:34px" onclick="const r = prompt('avant de partir'); fetch('/seen?v=' + (r === null ? 'null' : 'text'), { keepalive: true }); window.__r = r; window.__after = 'ran'">beacon</button>
  <script>window.__r = 'unset'; window.__after = 'not yet'</script></body>`

/** A page of buttons for alert() and confirm(); with `?bye`, it calls both from its handler of `beforeunload` and says what they returned (`/bye`). */
const AC_PAGE = `<title>alert confirm</title><body style="margin:0">
  <button id="alert" style="position:absolute;left:10px;top:10px;width:220px;height:34px" onclick="window.__r = alert('Enregistré.'); window.__after = 'ran'">alert</button>
  <button id="confirm" style="position:absolute;left:10px;top:60px;width:220px;height:34px" onclick="window.__r = confirm('Supprimer ce fichier ?'); window.__after = 'ran'">confirm</button>
  <script>window.__r = 'unset'; window.__after = 'not yet'
  if (location.search === '?bye') addEventListener('beforeunload', () => { const t = Date.now(); const r = confirm('Quitter ?'); alert('au revoir'); fetch('/bye?v=' + r + '_' + (Date.now() - t), { keepalive: true }) })</script></body>`

export async function smokeDialogs(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const ui = overlayView.webContents
  win.showInactive()

  // Everything the process says while the checks run: a typed value, or the text of a page, must not be in it.
  const logs: string[] = []
  const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a) ?? String(a))).join(' '))
      realConsole[level](...args)
    }
  }
  const uiMessages: string[] = []
  const onUiMessage = (event: { message: string }) => void uiMessages.push(event.message)
  ui.on('console-message', onUiMessage)

  const slowMs = 4000
  const seen: string[] = []
  // What a page said from its handler of beforeunload: what confirm() returned there, and how long the two calls took.
  const byes: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    // What a page that was left while a box was open says once its prompt() has returned (a script cannot be run in it meanwhile: a page that is being left does not answer).
    if (url.pathname === '/seen') {
      seen.push(url.searchParams.get('v') ?? '')
      return void res.end('ok')
    }
    if (url.pathname === '/frame') {
      return void res.end(`<title>frame</title><body>frame<script>window.__frameResult = (() => { const t = Date.now(); let r; try { r = prompt('depuis un cadre') } catch (e) { r = 'ERR ' + e.message } return [r, Date.now() - t] })()</script></body>`)
    }
    if (url.pathname === '/pf') return void res.end(`<title>pf</title><body>main<iframe id="f" src="/frame" style="width:300px;height:80px"></iframe><script>window.__r = 'unset'</script></body>`)
    // A page that asks for the position as soon as it loads: the engine asks the shell whether it may.
    if (url.pathname === '/geo') return void res.end(`<title>geo</title><body><script>navigator.geolocation.getCurrentPosition(() => {}, () => {})</script></body>`)
    if (url.pathname === '/slow') {
      setTimeout(() => res.end('<title>slow</title><body>slow</body>'), slowMs)
      return
    }
    if (url.pathname === '/ac') return void res.end(AC_PAGE)
    if (url.pathname === '/bye') {
      byes.push(url.searchParams.get('v') ?? '')
      return void res.end('ok')
    }
    // A frame of another site (localhost is another site than 127.0.0.1): its confirm() and alert() are its own, Electron's.
    if (url.pathname === '/acframe') return void res.end(`<title>acframe</title><body>main<iframe id="f" src="http://localhost:${port}/acinner" style="width:300px;height:80px"></iframe></body>`)
    if (url.pathname === '/acinner') return void res.end(`<title>acinner</title><body>cadre<script>window.__go = () => { const t = Date.now(); const r = confirm('depuis un cadre'); alert('alerte du cadre'); return [r, Date.now() - t] }</script></body>`)
    // A page its server sandboxes without allow-modals: Chromium ignores its alert() and confirm().
    if (url.pathname === '/sandboxed') {
      res.setHeader('content-security-policy', 'sandbox allow-scripts')
      return void res.end(`<title>sandboxed</title><body><script>window.__r = (() => { const t = Date.now(); alert('x'); const c = confirm('y'); return [c, Date.now() - t] })()</script></body>`)
    }
    res.end(PAGE(url.search))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const host = `127.0.0.1:${port}`

  const wcOf = (b: Browser, id: string): WebContents | undefined => (b.pageFor(id) as unknown as { webContents?: WebContents } | undefined)?.webContents
  const mine = new Set<string>()
  const state = () => store.get()
  /** A box (or a page blocked on one) that a failed check left behind must not spoil the next ones. */
  const releaseAll = () => {
    for (const id of [...(browser as unknown as { dialogAnswers: Map<string, unknown> }).dialogAnswers.keys()]) browser.answerDialog(id, PROMPT_CANCELLED)
    if (browser.currentPanel() === 'dialog') browser.closeOverlay()
  }
  const openTab = async (path: string, b: Browser = browser, s = store): Promise<{ id: string; wc: WebContents }> => {
    releaseAll()
    const before = new Set(s.get().tabs.map((t) => t.id))
    b.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = s.get().tabs.find((t) => !before.has(t.id))!
    mine.add(tab.id)
    await waitFor(() => wcOf(b, tab.id) !== undefined)
    const wc = wcOf(b, tab.id)!
    await waitFor(() => !wc.isLoading() && wc.getURL() === `${base}${path}`)
    await sleep(200)
    return { id: tab.id, wc }
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  /** A real click on the centre of the first element matching the selector. */
  const clickOn = async (wc: WebContents, selector: string): Promise<boolean> => {
    const rect = await evaluate<Rect | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!rect) return false
    mouse(wc, 'mouseMove', rect.x + rect.width / 2, rect.y + rect.height / 2)
    mouse(wc, 'mouseDown', rect.x + rect.width / 2, rect.y + rect.height / 2)
    mouse(wc, 'mouseUp', rect.x + rect.width / 2, rect.y + rect.height / 2)
    await sleep(250)
    return true
  }
  const typeText = async (target: WebContents, text: string) => {
    for (const ch of text) {
      target.sendInputEvent({ type: 'keyDown', keyCode: ch })
      target.sendInputEvent({ type: 'char', keyCode: ch })
      target.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(15)
    }
  }
  const press = async (target: WebContents, keyCode: string) => {
    target.sendInputEvent({ type: 'keyDown', keyCode })
    target.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(80)
  }
  /** Return as a keyboard sends it, the key and then its character: a focused button is pressed on the character, in any page. Its effect is waited for by the caller. */
  const pressReturn = (target: WebContents): void => {
    target.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    target.sendInputEvent({ type: 'char', keyCode: '\r' })
    target.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }
  const request = (b: Browser = browser): DialogRequest | null => {
    const current = b.currentOverlay()
    return current?.panel === 'dialog' ? current.request : null
  }
  /** The panel is up and drawn. */
  const shown = async (b: Browser = browser, panelUi: WebContents = ui) =>
    (await waitFor(() => b.currentPanel() === 'dialog', 6000)) && (await waitFor(async () => (await evaluate<boolean>(panelUi, `!!document.querySelector('.adlg-prompt input.adlg-field')`).catch(() => false)) === true, 6000))
  const gone = (b: Browser = browser) => waitFor(() => b.currentPanel() !== 'dialog', 6000)
  /** The page answers a script: it is not blocked. */
  const isBlocked = async (wc: WebContents): Promise<boolean> => Promise.race([evaluate(wc, '1', 20_000).then(() => false), sleep(700).then(() => true)])
  /** What the page recorded; a page that never answers (still blocked) is reported as such, so that the check fails instead of the run. */
  const resultOf = (wc: WebContents) => evaluate<{ r: unknown; after: unknown }>(wc, `({ r: window.__r, after: window.__after })`, 2500).catch((error: unknown) => ({ r: 'NO ANSWER', after: String((error as Error)?.message ?? error).slice(0, 120) }))
  const shot = async (wc: WebContents, name: string) => {
    const dir = process.env['LUCIUM_DIALOGS_SHOTS']
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG())
  }
  const dialogCount = (b: Browser = browser) => ((b as unknown as { dialogAnswers: Map<string, unknown> }).dialogAnswers.size)
  const queueLength = (b: Browser = browser) => ((b as unknown as { dialogQueue: unknown[] }).dialogQueue.length)
  const rectOf = (panelUi: WebContents, selector: string) =>
    evaluate<Rect | null>(panelUi, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  /** The box of alert() or confirm() is up and drawn. */
  const shownBox = async (kind: 'alert' | 'confirm') =>
    (await waitFor(() => browser.currentPanel() === 'dialog' && request()?.kind === kind, 6000)) && (await waitFor(async () => (await evaluate<boolean>(ui, `!!document.querySelector('.adlg-prompt[data-kind="${kind}"] .adlg-confirm')`).catch(() => false)) === true, 6000))
  /**
   * Electron's own sheet of `alert()` and `confirm()` (its internal event `-run-dialog`, on the contents of the page) is taken over while `run` goes:
   * each call is recorded and answered OK, so that no sheet of macOS waits for a click. Electron's listeners are put back after. `hooked` says
   * whether Electron had one: without it, the event changed name and what follows proves nothing.
   */
  const watchNative = async <T>(wc: WebContents, run: () => Promise<T>): Promise<{ result: T; native: Array<{ type: unknown; message: unknown; frame: unknown }>; hooked: boolean }> => {
    const emitter = wc as unknown as NodeJS.EventEmitter
    const own = emitter.listeners('-run-dialog') as Array<(...args: unknown[]) => void>
    const native: Array<{ type: unknown; message: unknown; frame: unknown }> = []
    const ours = (...args: unknown[]): void => {
      const info = args.find((arg) => typeof arg === 'object' && arg !== null && 'dialogType' in arg) as { dialogType?: unknown; messageText?: unknown; frame?: { url?: unknown } } | undefined
      const callback = args.find((arg) => typeof arg === 'function') as ((ok: boolean, text: string) => void) | undefined
      let frame: unknown
      try {
        frame = info?.frame?.url
      } catch (error) {
        // Recorded: the check that reads it says what went wrong.
        frame = `unreadable: ${error instanceof Error ? error.message : String(error)}`
      }
      native.push({ type: info?.dialogType, message: info?.messageText, frame })
      callback?.(true, '')
    }
    emitter.removeAllListeners('-run-dialog')
    emitter.on('-run-dialog', ours)
    try {
      return { result: await run(), native, hooked: own.length > 0 }
    } finally {
      emitter.removeListener('-run-dialog', ours)
      for (const listener of own) emitter.on('-run-dialog', listener)
    }
  }

  const originalSpace = state().activeSpaceId
  let extraSpace: string | undefined
  let popup: BrowserWindow | undefined
  try {
    // =============== the way a user takes: a click, a box, keys ===============
    const a = await openTab('/p?a')
    const ping = await evaluate<boolean>(a.wc, `typeof prompt === 'function' && prompt.name === 'prompt' && prompt.length === 0`)
    check('dialogs: the page sees a function named prompt with the length of the native one', ping)
    await clickOn(a.wc, '#ask')
    check('dialogs: a click on a button that calls prompt() puts a box over the window (the panel "dialog")', await shown())
    const first = request()
    check('dialogs: the box names the host of the page in full, with the port, and carries the message and the default value of the call', first?.host === host && first.message === PROMPT_TEXT && first.defaultValue === 'défaut' && first.offerSuppress === false, JSON.stringify(first))
    const dom = await evaluate<{ title: string; message: string; value: string; focused: boolean; selected: boolean; buttons: string[]; type: string }>(
      ui,
      `(() => { const i = document.querySelector('.adlg-prompt input.adlg-field'); return { title: document.querySelector('.adlg-prompt .adlg-title')?.textContent ?? '', message: document.querySelector('.adlg-prompt .adlg-message')?.textContent ?? '', value: i.value, focused: document.activeElement === i, selected: i.selectionStart === 0 && i.selectionEnd === i.value.length, buttons: [...document.querySelectorAll('.adlg-prompt .adlg-btn')].map((b) => b.textContent), type: i.type } })()`
    )
    check('dialogs: the box reads "<hôte> demande :", shows the message, a text field holding the default value (selected, focused), and Annuler / OK', dom.title === frenchSpaces(`${host} demande :`) && dom.message === PROMPT_TEXT && dom.value === 'défaut' && dom.focused && dom.selected && dom.type === 'text' && dom.buttons.length === 2 && dom.buttons[0]!.startsWith('Annuler') && dom.buttons[1]!.startsWith('OK'), JSON.stringify(dom))
    const card = await rectOf(ui, '.adlg-prompt')
    const view = await evaluate<{ w: number; h: number }>(ui, `({ w: innerWidth, h: innerHeight })`)
    check('dialogs: the box is wholly inside the window', !!card && card.x >= 0 && card.y >= 0 && card.x + card.width <= view.w && card.y + card.height <= view.h, JSON.stringify({ card, view }))
    await shot(ui, 'prompt-default')
    check('dialogs: the page is blocked while the box is open (as in any browser)', await isBlocked(a.wc))
    await typeText(ui, TYPED)
    check('dialogs: typing in the box replaces the selected default value', (await evaluate<string>(ui, `document.querySelector('.adlg-prompt input.adlg-field').value`)) === TYPED)
    await press(ui, 'Enter')
    check('dialogs: Return closes the box', await gone())
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran', 8000)
    const typed = await resultOf(a.wc)
    check('dialogs: the page is released and prompt() returned what was typed', typed.r === TYPED && typed.after === 'ran', JSON.stringify(typed))
    check('dialogs: nothing is left waiting, and the page is not blocked any more', dialogCount() === 0 && queueLength() === 0 && !(await isBlocked(a.wc)))

    // ---- the default value, Cancel, an empty answer, Escape ----
    await evaluate(a.wc, `window.__after = 'again'`)
    await clickOn(a.wc, '#ask')
    await shown()
    await press(ui, 'Enter')
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran')
    check('dialogs: Return at once answers the default value', (await resultOf(a.wc)).r === 'défaut')

    await clickOn(a.wc, '#ask')
    await shown()
    const cancel = await rectOf(ui, '.adlg-prompt .adlg-cancel')
    mouse(ui, 'mouseMove', cancel!.x + cancel!.width / 2, cancel!.y + cancel!.height / 2)
    mouse(ui, 'mouseDown', cancel!.x + cancel!.width / 2, cancel!.y + cancel!.height / 2)
    mouse(ui, 'mouseUp', cancel!.x + cancel!.width / 2, cancel!.y + cancel!.height / 2)
    check('dialogs: a click on Annuler closes the box', await gone())
    await waitFor(async () => (await resultOf(a.wc)).r === null)
    check('dialogs: ...and prompt() returned null, not an empty string', (await resultOf(a.wc)).r === null)

    await evaluate(a.wc, `window.__r = 'unset'; window.__after = 'again'`)
    await clickOn(a.wc, '#ask')
    await shown()
    await press(ui, 'Backspace')
    await press(ui, 'Enter')
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran')
    check('dialogs: OK on an empty field returns an empty string', (await resultOf(a.wc)).r === '')

    await evaluate(a.wc, `window.__r = 'unset'; window.__after = 'again'`)
    await clickOn(a.wc, '#ask')
    await shown()
    await press(ui, 'Escape')
    check('dialogs: Escape closes the box', await gone())
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran')
    check('dialogs: ...and prompt() returned null', (await resultOf(a.wc)).r === null)

    // ---- the text of the page is text, and the host is never the page's word ----
    await evaluate(a.wc, `window.__r = 'unset'; window.__after = 'again'`)
    await clickOn(a.wc, '#long')
    await shown()
    const long = request()
    const longDom = await evaluate<{ title: string; message: string; img: boolean; xss: unknown }>(ui, `({ title: document.querySelector('.adlg-prompt .adlg-title').textContent, message: document.querySelector('.adlg-prompt .adlg-message').textContent, img: !!document.querySelector('.adlg-prompt img'), xss: window.__xss })`)
    check('dialogs: a very long message is cut (about 1000 characters, then an ellipsis)', !!long && long.message.length === 1001 && long.message.endsWith('…'), String(long?.message.length))
    check('dialogs: the message is shown as plain text: markup in it is text, nothing runs', longDom.message.includes('<img src=x onerror=window.__xss=1>') && !longDom.img && longDom.xss === undefined, JSON.stringify({ ...longDom, message: longDom.message.slice(0, 60) }))
    check('dialogs: the title still names the real host, whatever the message says (it opens with another host\'s name here)', longDom.message.startsWith('bank.example demande :') && longDom.title === frenchSpaces(`${host} demande :`) && long?.host === host, longDom.title)
    const longRect = await rectOf(ui, '.adlg-prompt')
    const longButtons = await rectOf(ui, '.adlg-prompt .adlg-actions')
    const longView = await evaluate<{ h: number }>(ui, `({ h: innerHeight })`)
    check('dialogs: a long message scrolls inside the box: the buttons stay in the window', !!longRect && !!longButtons && longRect.y >= 0 && longButtons.y + longButtons.height <= longView.h, JSON.stringify({ longRect, longButtons, longView }))
    await shot(ui, 'prompt-long')
    await press(ui, 'Escape')
    await gone()

    // ---- a box is modal: no other panel takes its place ----
    await clickOn(a.wc, '#ask')
    await shown()
    browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
    // No wait: openOverlay decides before it returns (browser-overlay.ts), and a panel it takes is the current one at once.
    check('dialogs: while a page is blocked on a box, another panel does not replace it', browser.currentPanel() === 'dialog')
    releaseAll()
    browser.closeOverlay()
    await sleep(200)

    // The interface closing the panel (or an answer that is not one) cancels the box: a page is never left waiting.
    await evaluate(a.wc, `window.__r = 'unset'; window.__after = 'again'`)
    await clickOn(a.wc, '#ask')
    await shown()
    browser.closeOverlay()
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran')
    check('dialogs: closing the panel from outside answers the page with null', browser.currentPanel() === null && (await resultOf(a.wc)).r === null && dialogCount() === 0)
    releaseAll()
    await evaluate(a.wc, `window.__r = 'unset'; window.__after = 'again'`)
    await clickOn(a.wc, '#ask')
    await shown()
    const asked = request()!
    const logsAtAnswer = logs.length
    await evaluate(ui, `window.lucium.answerDialog(${JSON.stringify(asked.id)}, { value: 42, suppress: 'yes' })`)
    await waitFor(async () => (await resultOf(a.wc)).after === 'ran')
    check('dialogs: an answer from the interface that is not one cancels the box, and the log says so', (await resultOf(a.wc)).r === null && browser.currentPanel() === null && logs.slice(logsAtAnswer).some((l) => l.includes('[dialog] the interface sent an answer that is not one')), JSON.stringify(logs.slice(logsAtAnswer)))
    releaseAll()

    // Only the main process opens this panel: a request for it that comes from the interface is refused (a box is never a thing a page or a script of the interface can forge).
    await evaluate(ui, `window.lucium.openOverlay({ panel: 'dialog', request: { id: 'dialog-forged', kind: 'prompt', host: 'bank.example', message: 'x', defaultValue: '', offerSuppress: false } })`)
    // The witness: the request is a message without an answer; a question asked after it on the same channel is answered only once the main
    // process has handled it.
    await evaluate(ui, 'window.lucium.getSnapshot().then(() => 0)')
    check('dialogs: the interface cannot open a box of its own: the panel is for the main process only', browser.currentPanel() === null)

    // =============== which tab, which space ===============
    // The tab that asks is not the one on screen: its box waits for it. Nothing opens over the tab the user is on, the tab that asks is never brought
    // forward by its own call, and a notice names the site that waits.
    const waitsNotice = (): boolean => (browser.snapshot().toast?.message ?? '').includes('attend une réponse dans son onglet')
    const background = await openTab('/p?background')
    const front = await openTab('/p?front')
    const selectedBefore = state().activeTabBySpace[state().activeSpaceId]
    await evaluate(background.wc, `setTimeout(() => { window.__r = prompt('en fond', 'x'); window.__after = 'ran' }, 30); 1`)
    // The witness is the notice: the shell gives it as it decides that the question waits for its tab (browser-dialogs.ts, `whenOnScreen`).
    const told = await waitFor(waitsNotice, 6000)
    check('dialogs: a page in another tab asks: no box opens over the tab on screen, which stays, and a notice says a site waits in its tab', told && browser.currentPanel() === null && selectedBefore === front.id && state().activeTabBySpace[state().activeSpaceId] === front.id, JSON.stringify({ toast: browser.snapshot().toast, panel: browser.currentPanel(), selectedBefore, now: state().activeTabBySpace[state().activeSpaceId] }))
    browser.dispatch({ type: 'tab/select', id: background.id })
    check('dialogs: ...and the box appears once the user goes to its tab', (await shown()) && request()?.message === 'en fond', JSON.stringify(request()))
    await press(ui, 'Enter')
    await waitFor(async () => (await resultOf(background.wc)).after === 'ran')
    check('dialogs: the answer reaches the page that asked, not the one in front', (await resultOf(background.wc)).r === 'x' && (await resultOf(front.wc)).r === 'unset')

    // A box that waited behind the command bar must not take the address the user submits: it appears after the bar has done its work, and only on its own tab.
    const waiting = await openTab('/p?waiting')
    browser.openOverlay({ panel: 'commandbar', mode: 'current', initial: '' })
    await waitFor(() => browser.currentPanel() === 'commandbar')
    await evaluate(waiting.wc, `setTimeout(() => { window.__r = prompt('derrière la barre'); window.__after = 'ran' }, 30); 1`)
    // The request reaches the queue some time after the page asks (a loaded machine takes longer than a fixed delay): its place in the line is the
    // shell's decision, and a box in line comes out only when the panel before it closes.
    await waitFor(() => queueLength() === 1, 5000)
    check('dialogs: the page on screen asks while the command bar is open: the bar stays, the box waits, the tab does not change', browser.currentPanel() === 'commandbar' && queueLength() === 1 && state().activeTabBySpace[state().activeSpaceId] === waiting.id, JSON.stringify({ panel: browser.currentPanel(), queue: queueLength() }))
    browser.submitUrl(`${base}/p?submitted`, 'new')
    const submitted = (): string | undefined => state().tabs.find((t) => t.url === `${base}/p?submitted`)?.id
    check('dialogs: ...the address opens in a tab of its own, and the page that asks keeps its address', (await waitFor(() => submitted() !== undefined && state().activeTabBySpace[state().activeSpaceId] === submitted(), 6000)) && waiting.wc.getURL() === `${base}/p?waiting`, waiting.wc.getURL())
    if (submitted()) mine.add(submitted()!)
    // The witness: the box leaves the line to wait for its tab (browser-dialogs.ts, `whenOnScreen`), which the shell decides when the bar closes.
    const offScreen = () => (browser as unknown as { offScreenQuestions: Map<string, unknown> }).offScreenQuestions
    await waitFor(() => offScreen().has(waiting.id) || browser.currentPanel() === 'dialog')
    check('dialogs: ...the box does not open over the new tab: it waits for its own', offScreen().has(waiting.id) && browser.currentPanel() !== 'dialog' && dialogCount() === 1, JSON.stringify({ panel: browser.currentPanel(), pending: dialogCount() }))
    browser.dispatch({ type: 'tab/select', id: waiting.id })
    check('dialogs: ...and appears once the user is back on the tab that asked', (await shown()) && request()?.message === 'derrière la barre' && state().activeTabBySpace[state().activeSpaceId] === waiting.id)
    await press(ui, 'Escape')
    await gone()
    await waitFor(async () => (await resultOf(waiting.wc)).after === 'ran')

    // A page in another space.
    browser.dispatch({ type: 'space/create', name: 'Espace dialogues', emoji: '💬', hue: 120 })
    extraSpace = state().activeSpaceId
    const farTab = await openTab('/p?far')
    browser.dispatch({ type: 'space/select', id: originalSpace })
    await sleep(300)
    await evaluate(farTab.wc, `setTimeout(() => { window.__r = prompt('autre espace'); window.__after = 'ran' }, 30); 1`)
    // No wait after it: the shell decides as it takes the question (browser-dialogs.ts, `askPrompt`): on screen, or waiting for its tab.
    await waitFor(() => dialogCount() === 1, 6000)
    check('dialogs: a page in another space asks: no box opens, and the window stays in the space the user is in', browser.currentPanel() !== 'dialog' && dialogCount() === 1 && state().activeSpaceId === originalSpace, JSON.stringify({ space: state().activeSpaceId, originalSpace, panel: browser.currentPanel(), pending: dialogCount() }))
    browser.dispatch({ type: 'space/select', id: extraSpace })
    check('dialogs: ...the box appears once the user goes to that space, where its tab is on screen', (await shown()) && state().activeSpaceId === extraSpace && state().activeTabBySpace[extraSpace] === farTab.id, JSON.stringify({ space: state().activeSpaceId, extraSpace }))
    await typeText(ui, 'ok')
    await press(ui, 'Enter')
    await waitFor(async () => (await resultOf(farTab.wc)).after === 'ran')
    check('dialogs: ...and gets its answer', (await resultOf(farTab.wc)).r === 'ok')
    browser.dispatch({ type: 'space/select', id: originalSpace })
    await sleep(200)

    // Two pages ask: one box at a time; the second one, whose tab is behind, waits for its tab.
    const first2 = await openTab('/p?q1')
    const second2 = await openTab('/p?q2')
    await clickOn(second2.wc, '#ask')
    await shown()
    await evaluate(first2.wc, `setTimeout(() => { window.__r = prompt('deuxième page'); window.__after = 'ran' }, 30); 1`)
    // A page that is not on screen has its timers slowed down by Chromium: it may take a second to ask.
    await waitFor(() => dialogCount() === 2, 5000)
    check('dialogs: a second page, behind, asking meanwhile waits for its tab: one box on screen, two questions pending, none in line for this tab', request()?.message === PROMPT_TEXT && queueLength() === 0 && dialogCount() === 2, JSON.stringify({ queue: queueLength(), pending: dialogCount() }))
    await press(ui, 'Enter')
    // No wait after it: closing the box takes the next one in line at once (browser-overlay.ts), and the second waits for its tab, not in that line.
    await gone()
    check('dialogs: answering the first does not bring the second over this tab, nor its tab forward', browser.currentPanel() !== 'dialog' && dialogCount() === 1 && state().activeTabBySpace[state().activeSpaceId] === second2.id, JSON.stringify({ panel: browser.currentPanel(), pending: dialogCount() }))
    browser.dispatch({ type: 'tab/select', id: first2.id })
    check('dialogs: ...the second appears once the user goes to its tab', (await waitFor(() => request()?.message === 'deuxième page', 6000)) && (await shown()) && state().activeTabBySpace[state().activeSpaceId] === first2.id)
    await typeText(ui, 'suite')
    await press(ui, 'Enter')
    await waitFor(async () => (await resultOf(first2.wc)).after === 'ran')
    check('dialogs: each page got its own answer', (await resultOf(first2.wc)).r === 'suite' && (await resultOf(second2.wc)).r === 'défaut')

    // =============== the page goes away while the box is open ===============
    const closing = await openTab('/p?closing')
    await clickOn(closing.wc, '#ask')
    await shown()
    browser.dispatch({ type: 'tab/close', id: closing.id })
    check('dialogs: the tab is closed while the box is open: the box goes', await gone())
    check('dialogs: ...and nothing is left waiting for it', dialogCount() === 0 && queueLength() === 0, JSON.stringify({ pending: dialogCount(), queue: queueLength() }))

    const leaving = await openTab('/p?leaving')
    await clickOn(leaving.wc, '#beacon')
    await shown()
    const leavingPage = browser.pageFor(leaving.id)!
    const leftAt = Date.now()
    leavingPage.loadURL(`${base}/slow`)
    check('dialogs: the page navigates elsewhere while the box is open: the box goes at once, not when the new page has arrived', (await gone()) && Date.now() - leftAt < slowMs - 1000, String(Date.now() - leftAt))
    const released = await waitFor(() => seen.length > 0, slowMs)
    check('dialogs: ...and the old page, still there, was released then (before the new page arrived), and got null', released && Date.now() - leftAt < slowMs - 500 && seen.length === 1 && seen[0] === 'null', JSON.stringify({ seen, after: Date.now() - leftAt }))
    await waitFor(() => leaving.wc.getURL() === `${base}/slow` && !leaving.wc.isLoading(), slowMs + 4000)

    const dying = await openTab('/p?dying')
    await clickOn(dying.wc, '#ask')
    await shown()
    dying.wc.forcefullyCrashRenderer()
    check('dialogs: the renderer of the page dies while the box is open: the box goes', await gone())
    check('dialogs: ...and nothing is left waiting for it', dialogCount() === 0 && queueLength() === 0)
    browser.dispatch({ type: 'tab/close', id: dying.id })

    // =============== the page goes away while a question about it is open or waiting ===============
    {
      const permissionsPending = () => (browser as unknown as { permissionAnswers: Map<string, unknown> }).permissionAnswers.size
      const permissionsQueued = () => (browser as unknown as { permissionQueue: unknown[] }).permissionQueue.length
      const asking = await openTab('/geo')
      check('permissions: a page asks for the position: the question is on screen', await waitFor(() => browser.currentPanel() === 'permission', 6000))
      browser.dispatch({ type: 'tab/open', url: `${base}/geo` })
      const askingToo = state().tabs.at(-1)!
      mine.add(askingToo.id)
      check('permissions: a second page asks meanwhile: its question waits its turn', await waitFor(() => permissionsQueued() === 1 && permissionsPending() === 2, 6000), JSON.stringify({ queued: permissionsQueued(), pending: permissionsPending() }))
      browser.dispatch({ type: 'tab/close', id: askingToo.id })
      check('permissions: the tab that waits is closed: its question is withdrawn, the one on screen stays', permissionsQueued() === 0 && permissionsPending() === 1 && browser.currentPanel() === 'permission', JSON.stringify({ queued: permissionsQueued(), pending: permissionsPending(), panel: browser.currentPanel() }))
      browser.dispatch({ type: 'tab/close', id: asking.id })
      check('permissions: the tab of the question on screen is closed: the question goes, and nothing is left waiting for it', (await waitFor(() => browser.currentPanel() !== 'permission')) && permissionsPending() === 0 && permissionsQueued() === 0, JSON.stringify({ queued: permissionsQueued(), pending: permissionsPending(), panel: browser.currentPanel() }))
      if (browser.currentPanel() === 'permission') browser.closeOverlay()

      // The second login of a page, in line behind the first: the page is gone when its turn comes, so nobody is asked.
      const gonePage = await openTab('/p?login')
      const challenge = (realm: string) => ({ host: '127.0.0.1', port, scheme: 'basic', realm, isProxy: false, url: `${base}/secret` })
      const firstLogin = browser.authenticate(gonePage.id, challenge('un'))
      const secondLogin = browser.authenticate(gonePage.id, challenge('deux'))
      check('login: a page that has two logins to ask for shows the first one', await waitFor(() => browser.currentPanel() === 'auth', 6000))
      browser.dispatch({ type: 'tab/close', id: gonePage.id })
      // The witness is the two answers: a login shown to the user would hold its answer until the user gives it.
      const answers = await Promise.all([firstLogin, secondLogin])
      check('login: the tab is closed: both logins are refused, and the second one is never shown for a page that is gone', answers[0] === null && answers[1] === null && browser.currentPanel() !== 'auth', JSON.stringify({ answers, panel: browser.currentPanel() }))
      if (browser.currentPanel() === 'auth') browser.closeOverlay()
    }

    // =============== a page that keeps asking ===============
    const spam = await openTab('/p?spam')
    const offered: boolean[] = []
    for (let i = 0; i < 3; i++) {
      await clickOn(spam.wc, '#many')
      await shown()
      offered.push(request()?.offerSuppress === true)
      if (i === 2) {
        const box = await rectOf(ui, '.adlg-prompt .adlg-suppress input')
        check('dialogs: from the third box in a row the user is offered to stop the page, with its sentence', offered[2] === true && !!box && (await evaluate<string>(ui, `document.querySelector('.adlg-prompt .adlg-suppress').textContent`)) === 'Empêcher cette page de créer d’autres boîtes de dialogue', JSON.stringify(offered))
        await shot(ui, 'prompt-suppress')
        mouse(ui, 'mouseMove', box!.x + box!.width / 2, box!.y + box!.height / 2)
        mouse(ui, 'mouseDown', box!.x + box!.width / 2, box!.y + box!.height / 2)
        mouse(ui, 'mouseUp', box!.x + box!.width / 2, box!.y + box!.height / 2)
        check('dialogs: the box can be ticked', await waitFor(async () => (await evaluate<boolean>(ui, `document.querySelector('.adlg-prompt .adlg-suppress input').checked`)) === true))
      }
      await press(ui, 'Enter')
      await gone()
    }
    check('dialogs: the first two boxes had no such offer', offered[0] === false && offered[1] === false, JSON.stringify(offered))
    await waitFor(async () => (await resultOf(spam.wc)).after === 'ran3')
    await evaluate(spam.wc, `window.__r = 'unset'`)
    await clickOn(spam.wc, '#many')
    // The witness: the page has its answer (a box on screen would hold it).
    await waitFor(async () => (await resultOf(spam.wc)).r !== 'unset')
    const refused = await resultOf(spam.wc)
    check('dialogs: once it is ticked, the page\'s next prompt() returns null without showing anything', browser.currentPanel() === null && refused.r === null && refused.after === 'ran4', JSON.stringify({ panel: browser.currentPanel(), ...refused }))

    // A new document starts again.
    void spam.wc.loadURL(`${base}/p?spam2`)
    await sleep(300)
    await waitFor(() => !spam.wc.isLoading() && spam.wc.getURL().endsWith('spam2'))
    await sleep(200)
    await clickOn(spam.wc, '#many')
    check('dialogs: a new document of the same tab can ask again, and without the offer', (await shown()) && request()?.offerSuppress === false, JSON.stringify(request()))
    await press(ui, 'Enter')
    await gone()
    // Cancelling with the box ticked stops the page too.
    for (let i = 0; i < 3; i++) {
      await clickOn(spam.wc, '#many')
      await shown()
      if (i === 2) {
        const box = await rectOf(ui, '.adlg-prompt .adlg-suppress input')
        mouse(ui, 'mouseDown', box!.x + box!.width / 2, box!.y + box!.height / 2)
        mouse(ui, 'mouseUp', box!.x + box!.width / 2, box!.y + box!.height / 2)
        await waitFor(async () => (await evaluate<boolean>(ui, `document.querySelector('.adlg-prompt .adlg-suppress input').checked`)) === true)
        await press(ui, 'Escape')
      } else await press(ui, 'Enter')
      await gone()
    }
    await evaluate(spam.wc, `window.__r = 'unset'`)
    await clickOn(spam.wc, '#many')
    // The witness: the page has its answer (a box on screen would hold it).
    await waitFor(async () => (await resultOf(spam.wc)).r !== 'unset')
    check('dialogs: Escape with the box ticked stops the page as well', browser.currentPanel() === null && (await resultOf(spam.wc)).r === null)

    // =============== frames, previews, windows, forged messages ===============
    const framed = await openTab('/pf')
    await waitFor(async () => (await evaluate<boolean>(framed.wc, `!!document.getElementById('f')`)) === true)
    await sleep(600)
    const frame = framed.wc.mainFrame.frames[0]
    const frameValue = frame ? await frame.executeJavaScript('window.__frameResult').catch(() => null) : null
    check('dialogs: a frame of a page keeps Electron\'s prompt(): null at once, no box', Array.isArray(frameValue) && frameValue[0] === null && (frameValue[1] as number) < 1000 && browser.currentPanel() === null, JSON.stringify(frameValue))

    const logsBefore = logs.length
    const pageId = engine as unknown as { pageDialog: (kind: string, event: unknown, raw: unknown) => void }
    /** What the main process does with a message on the channel, whoever the sender is: the reply, whether it was sent once, and what was said. */
    const forged = (sender: unknown, senderFrame: unknown, raw: unknown) => {
      const sets: unknown[] = []
      const event = {
        sender,
        senderFrame,
        set returnValue(value: unknown) {
          sets.push(value)
        }
      }
      const before = logs.length
      pageId.pageDialog('prompt', event, raw)
      const leaked = browser.currentPanel() === 'dialog'
      if (leaked) browser.closeOverlay()
      return { sets: leaked ? [...sets, 'a box was shown'] : sets, said: logs.slice(before).filter((line) => line.includes('[dialog]')) }
    }
    const good = { message: 'forgé', defaultValue: '' }
    const nothing = (r: { sets: unknown[] }) => r.sets.length === 1 && r.sets[0] === null
    const wrongShape = forged(framed.wc, framed.wc.mainFrame, { message: 'forgé', defaultValue: '', host: 'bank.example' })
    check('dialogs: a message with a field the bridge does not send is refused (the page gets null, once), and logged', nothing(wrongShape) && wrongShape.said.length === 1, JSON.stringify(wrongShape))
    const notStrings = forged(framed.wc, framed.wc.mainFrame, { message: 12, defaultValue: null })
    check('dialogs: a message that is not two strings is refused the same way', nothing(notStrings) && notStrings.said.length === 1, JSON.stringify(notStrings))
    const fromInterface = forged(ui, ui.mainFrame, good)
    check('dialogs: the interface of the application cannot open a box through this channel', nothing(fromInterface) && fromInterface.said.length === 1, JSON.stringify(fromInterface))
    const subframe = framed.wc.mainFrame.frames[0]
    const fromFrame = forged(framed.wc, subframe, good)
    check('dialogs: a frame of a page cannot either: only its main frame is heard', nothing(fromFrame) && fromFrame.said.length === 1, JSON.stringify(fromFrame))
    const extensionFrame = { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' }
    const fromExtension = forged({ id: framed.wc.id, mainFrame: extensionFrame }, extensionFrame, good)
    check('dialogs: a page that is not a page of the web (an extension) gets null, and it is logged', nothing(fromExtension) && fromExtension.said.length === 1, JSON.stringify(fromExtension))
    const gone2 = forged(framed.wc, null, good)
    check('dialogs: a frame that is already gone gets null too', nothing(gone2) && gone2.said.length === 1, JSON.stringify(gone2))
    const brokenFrame = { get url(): string { throw new Error('Render frame was disposed before WebFrameMain could be accessed') } }
    const fromBroken = forged({ id: framed.wc.id, mainFrame: brokenFrame }, brokenFrame, good)
    check('dialogs: a frame whose address cannot be read any more gets null, and the log says why', nothing(fromBroken) && fromBroken.said.some((l) => l.includes('the frame that asked for a box is gone') && l.includes('Render frame was disposed')), JSON.stringify(fromBroken))
    const framedPage = browser.pageFor(framed.id) as unknown as { askDialog: (...args: unknown[]) => void }
    const realAsk = framedPage.askDialog
    framedPage.askDialog = () => {
      throw new Error('boom')
    }
    const fromBug = forged(framed.wc, framed.wc.mainFrame, good)
    framedPage.askDialog = realAsk
    check('dialogs: a failure while handling a message still answers the page (null), and the log says so', nothing(fromBug) && fromBug.said.some((l) => l.includes('cannot handle a call of prompt()') && l.includes('boom')), JSON.stringify(fromBug))
    check('dialogs: none of those left a box, or anything waiting', dialogCount() === 0 && queueLength() === 0)
    const refusalLogs = logs.slice(logsBefore).filter((line) => line.includes('[dialog]'))
    check('dialogs: the logs of the refusals do not carry the text of the messages', refusalLogs.length > 0 && refusalLogs.every((line) => !line.includes('forgé') && !line.includes('bank.example')), JSON.stringify(refusalLogs))

    // A well-formed message from the main frame of a tab is a genuine call: it shows the box, and the reply comes back through the setter.
    const sets: unknown[] = []
    pageId.pageDialog('prompt', { sender: framed.wc, senderFrame: framed.wc.mainFrame, set returnValue(value: unknown) { sets.push(value) } }, { message: 'appel direct', defaultValue: 'v' })
    check('dialogs: a well-formed message from the main frame of a tab shows the box, and nothing is sent to the page yet', (await shown()) && request()?.message === 'appel direct' && sets.length === 0)
    await typeText(ui, 'w')
    await press(ui, 'Enter')
    await waitFor(() => sets.length === 1)
    check('dialogs: ...and the answer reaches the reply of the message, once', sets.length === 1 && sets[0] === 'w', JSON.stringify(sets))

    // A window opened by a page (a popup) and a preview are pages of the web with the bridge, but not tabs: they keep Electron's null.
    popup = new BrowserWindow({ show: false, webPreferences: { session: a.wc.session, sandbox: true, contextIsolation: true } })
    await popup.webContents.loadURL(`${base}/p?popup`)
    const fromPopup = await evaluate<unknown>(popup.webContents, `prompt('depuis une fenêtre')`)
    check('dialogs: the window of a popup has no box either: prompt() answers null, nothing is shown', fromPopup === null && browser.currentPanel() === null)
    popup.destroy()
    popup = undefined

    browser.openPeek(`${base}/p?peek`)
    await waitFor(() => browser.currentPanel() === 'peek')
    await sleep(800)
    const peekWc = (() => {
      const peekPage = (browser as unknown as { peek: { page: { webContents?: WebContents } } | null }).peek?.page
      return peekPage?.webContents
    })()
    const fromPeek = peekWc ? await evaluate<unknown>(peekWc, `prompt('depuis un aperçu')`).catch((e: unknown) => `error: ${String(e)}`) : 'no preview'
    check('dialogs: a preview (Glance) is not a tab: prompt() answers null, the preview stays', fromPeek === null && browser.currentPanel() === 'peek', JSON.stringify({ fromPeek, panel: browser.currentPanel() }))
    browser.closeOverlay()

    // =============== alert() and confirm() ===============
    {
      const tabOnScreen = () => state().activeTabBySpace[state().activeSpaceId]
      // ---- in the tab on screen: the box of Lucium, what confirm() returns for OK and for Annuler ----
      const ac = await openTab('/ac?front')
      const frontRun = await watchNative(ac.wc, async () => {
        await clickOn(ac.wc, '#confirm')
        check('alert/confirm: a click on a button that calls confirm() puts the box of Lucium over the tab (the panel "dialog", kind confirm)', await shownBox('confirm'), JSON.stringify(request()))
        const asked = request()
        check('alert/confirm: the box of confirm() names the host of the page and carries the message of the call, with no field', asked?.kind === 'confirm' && asked.host === host && asked.message === 'Supprimer ce fichier ?' && asked.defaultValue === '', JSON.stringify(asked))
        const look = await evaluate<{ title: string; buttons: string[]; field: boolean; focused: boolean }>(
          ui,
          `(() => { const box = document.querySelector('.adlg-prompt[data-kind="confirm"]'); return { title: box.querySelector('.adlg-title')?.textContent ?? '', buttons: [...box.querySelectorAll('.adlg-btn')].map((b) => b.textContent), field: !!box.querySelector('input.adlg-field'), focused: document.activeElement === box.querySelector('.adlg-confirm') } })()`
        )
        check('alert/confirm: it reads "<hôte> indique :", with Annuler and OK, and the keyboard on OK', look.title === frenchSpaces(`${host} indique :`) && !look.field && look.buttons.length === 2 && look.buttons[0]!.startsWith('Annuler') && look.buttons[1]!.startsWith('OK') && look.focused, JSON.stringify(look))
        await shot(ui, 'confirm')
        check('alert/confirm: the page is blocked while the box of confirm() is open (as in any browser)', await isBlocked(ac.wc))
        pressReturn(ui)
        check('alert/confirm: Return closes the box', await gone())
        await waitFor(async () => (await resultOf(ac.wc)).after === 'ran')
        check('alert/confirm: ...and confirm() returned true to the page', (await resultOf(ac.wc)).r === true, JSON.stringify(await resultOf(ac.wc)))
        check('alert/confirm: ...and the keyboard is back on the page', await waitFor(() => ac.wc.isFocused(), 3000), String(ac.wc.isFocused()))

        await evaluate(ac.wc, `window.__r = 'unset'; window.__after = 'again'`)
        await clickOn(ac.wc, '#confirm')
        await shownBox('confirm')
        await press(ui, 'Escape')
        check('alert/confirm: Escape closes the box of confirm()', await gone())
        await waitFor(async () => (await resultOf(ac.wc)).after === 'ran')
        check('alert/confirm: ...as Annuler: confirm() returned false', (await resultOf(ac.wc)).r === false, JSON.stringify(await resultOf(ac.wc)))

        await evaluate(ac.wc, `window.__r = 'unset'; window.__after = 'again'`)
        await clickOn(ac.wc, '#confirm')
        await shownBox('confirm')
        const cancelButton = await rectOf(ui, '.adlg-prompt .adlg-cancel')
        if (cancelButton) {
          mouse(ui, 'mouseMove', cancelButton.x + cancelButton.width / 2, cancelButton.y + cancelButton.height / 2)
          mouse(ui, 'mouseDown', cancelButton.x + cancelButton.width / 2, cancelButton.y + cancelButton.height / 2)
          mouse(ui, 'mouseUp', cancelButton.x + cancelButton.width / 2, cancelButton.y + cancelButton.height / 2)
        }
        await gone()
        await waitFor(async () => (await resultOf(ac.wc)).after === 'ran')
        check('alert/confirm: a click on Annuler: confirm() returned false', !!cancelButton && (await resultOf(ac.wc)).r === false, JSON.stringify(await resultOf(ac.wc)))

        await evaluate(ac.wc, `window.__r = 'unset'; window.__after = 'again'`)
        await clickOn(ac.wc, '#alert')
        check('alert/confirm: a click on a button that calls alert() puts the box of Lucium over the tab (kind alert)', (await shownBox('alert')) && request()?.message === 'Enregistré.' && request()?.host === host, JSON.stringify(request()))
        const alertLook = await evaluate<{ title: string; buttons: string[]; focused: boolean }>(
          ui,
          `(() => { const box = document.querySelector('.adlg-prompt[data-kind="alert"]'); return { title: box.querySelector('.adlg-title')?.textContent ?? '', buttons: [...box.querySelectorAll('.adlg-btn')].map((b) => b.textContent), focused: document.activeElement === box.querySelector('.adlg-confirm') } })()`
        )
        check('alert/confirm: the box of alert() reads "<hôte> indique :" and has OK alone, with the keyboard on it', alertLook.title === frenchSpaces(`${host} indique :`) && alertLook.buttons.length === 1 && alertLook.buttons[0]!.startsWith('OK') && alertLook.focused, JSON.stringify(alertLook))
        await shot(ui, 'alert')
        check('alert/confirm: the page is blocked while the box of alert() is open', await isBlocked(ac.wc))
        pressReturn(ui)
        check('alert/confirm: Return closes the box of alert()', await gone())
        await waitFor(async () => (await resultOf(ac.wc)).after === 'ran')
        const afterAlert = await resultOf(ac.wc)
        check('alert/confirm: ...and the page goes on, alert() having returned nothing', afterAlert.r === undefined && afterAlert.after === 'ran', JSON.stringify(afterAlert))
        return null
      })
      check('alert/confirm: in the tab on screen, no sheet of macOS was shown', frontRun.native.length === 0, JSON.stringify(frontRun.native))

      // ---- from a tab behind: the box waits for its tab ----
      const behind = await openTab('/ac?behind')
      const onScreen = await openTab('/ac?onscreen')
      const offScreenOf = () => (browser as unknown as { offScreenQuestions: Map<string, unknown> }).offScreenQuestions
      const behindRun = await watchNative(behind.wc, async () => {
        await evaluate(behind.wc, `setTimeout(() => { window.__r = confirm('en fond ?'); window.__after = 'ran' }, 30); 1`)
        // The witness: the shell parks the question for its tab as it takes it (browser-dialogs.ts, `whenOnScreen`). A tab behind may take a second to ask.
        await waitFor(() => offScreenOf().has(behind.id), 6000)
        check('alert/confirm: a tab behind calls confirm(): nothing opens over the tab on screen, which stays, and the question waits for its tab', offScreenOf().has(behind.id) && browser.currentPanel() !== 'dialog' && dialogCount() === 1 && tabOnScreen() === onScreen.id, JSON.stringify({ panel: browser.currentPanel(), pending: dialogCount(), selected: tabOnScreen() }))
        check('alert/confirm: ...and a notice says a site waits in its tab', (browser.snapshot().toast?.message ?? '').includes('attend une réponse dans son onglet'), JSON.stringify(browser.snapshot().toast))
        browser.dispatch({ type: 'tab/select', id: behind.id })
        check('alert/confirm: ...the box appears once the user goes to its tab', (await shownBox('confirm')) && request()?.message === 'en fond ?', JSON.stringify(request()))
        await press(ui, 'Escape')
        await gone()
        await waitFor(async () => (await resultOf(behind.wc)).after === 'ran')
        check('alert/confirm: ...and Annuler reaches the page that asked (confirm() returned false), not the one that was in front', (await resultOf(behind.wc)).r === false && (await resultOf(onScreen.wc)).r === 'unset')

        browser.dispatch({ type: 'tab/select', id: onScreen.id })
        // The witness: the tab that asks is no longer one the window shows.
        await waitFor(() => !(browser as unknown as { visibleIds: () => string[] }).visibleIds().includes(behind.id))
        await evaluate(behind.wc, `window.__after = 'again'; setTimeout(() => { window.__r = alert('fini en fond'); window.__after = 'ran' }, 30); 1`)
        await waitFor(() => offScreenOf().has(behind.id), 6000)
        check('alert/confirm: a tab behind calls alert(): it waits for its tab too, nothing over the tab on screen', offScreenOf().has(behind.id) && browser.currentPanel() !== 'dialog' && dialogCount() === 1 && tabOnScreen() === onScreen.id, JSON.stringify({ panel: browser.currentPanel(), pending: dialogCount(), selected: tabOnScreen() }))
        browser.dispatch({ type: 'tab/select', id: behind.id })
        check('alert/confirm: ...the box of alert() appears in its tab', (await shownBox('alert')) && request()?.message === 'fini en fond', JSON.stringify(request()))
        pressReturn(ui)
        await gone()
        await waitFor(async () => (await resultOf(behind.wc)).after === 'ran')
        check('alert/confirm: ...and the page goes on once OK is pressed', (await resultOf(behind.wc)).after === 'ran' && (await resultOf(behind.wc)).r === undefined, JSON.stringify(await resultOf(behind.wc)))
        return null
      })
      check('alert/confirm: no sheet of macOS for the tab behind, at any moment', behindRun.native.length === 0, JSON.stringify(behindRun.native))

      // ---- a frame of another site: Electron's own sheet, as decided (only the main frame gets the box of Lucium) ----
      const framedAc = await openTab('/acframe')
      // The witness: the frame has run its script.
      await waitFor(async () => (await framedAc.wc.mainFrame.frames[0]?.executeJavaScript('typeof window.__go').catch(() => 'not yet')) === 'function')
      const inner = framedAc.wc.mainFrame.frames[0]
      const frameRun = await watchNative(framedAc.wc, async () =>
        inner ? Promise.race([inner.executeJavaScript('window.__go()') as Promise<unknown>, sleep(8000).then(() => 'NO ANSWER')]).catch((error: unknown) => `error: ${String(error)}`) : 'no frame'
      )
      const [firstNative, secondNative] = frameRun.native
      check(
        "alert/confirm: a frame of another site keeps Electron's sheet: its confirm() and alert() go to the native box (answered OK here by the check), which does not name the site, and never to the box of Lucium",
        frameRun.hooked && Array.isArray(frameRun.result) && frameRun.result[0] === true && frameRun.native.length === 2 && firstNative?.type === 'confirm' && secondNative?.type === 'alert' && String(firstNative?.frame).startsWith(`http://localhost:${port}/`) && browser.currentPanel() !== 'dialog' && dialogCount() === 0,
        JSON.stringify(frameRun)
      )

      // ---- a window that is not a tab (a popup, here a window of the same session): Electron's sheet, as before ----
      popup = new BrowserWindow({ show: false, webPreferences: { session: ac.wc.session, sandbox: true, contextIsolation: true } })
      await popup.webContents.loadURL(`${base}/ac?popup`)
      const popupWc = popup.webContents
      const popupRun = await watchNative(popupWc, () => evaluate<unknown>(popupWc, `confirm('depuis une fenêtre')`).catch((error: unknown) => `error: ${String(error)}`))
      check("alert/confirm: a window that is not a tab gets Electron's sheet for confirm() (answered OK here), not the box of Lucium", popupRun.hooked && popupRun.result === true && popupRun.native.length === 1 && popupRun.native[0]?.type === 'confirm' && browser.currentPanel() !== 'dialog', JSON.stringify(popupRun))
      popup.destroy()
      popup = undefined

      // ---- a page being left: no box from its handler of beforeunload, as in Chromium ----
      const leaving = await openTab('/ac?bye')
      const byesBefore = byes.length
      const leaveRun = await watchNative(leaving.wc, async () => {
        void leaving.wc.loadURL(`${base}/ac?left`).catch((error: unknown) => console.warn('[smoke-dialogs] the page that was left did not load:', error))
        return waitFor(() => byes.length > byesBefore && leaving.wc.getURL() === `${base}/ac?left` && !leaving.wc.isLoading(), 8000)
      })
      const [byeConfirm, byeMs] = (byes[byesBefore] ?? '').split('_')
      check('alert/confirm: confirm() and alert() called from the handler of beforeunload return at once, without a box (confirm() is false), and the page is left', leaveRun.result && byeConfirm === 'false' && Number(byeMs) < 1000 && leaveRun.native.length === 0 && browser.currentPanel() !== 'dialog' && dialogCount() === 0, JSON.stringify({ bye: byes[byesBefore], url: leaving.wc.getURL(), native: leaveRun.native, panel: browser.currentPanel() }))

      // ---- a page its server sandboxes without allow-modals: Chromium shows nothing, and Lucium does not either ----
      const sandboxTab = await openTab('/ac?sandbox')
      const sandboxRun = await watchNative(sandboxTab.wc, async () => {
        void sandboxTab.wc.loadURL(`${base}/sandboxed`).catch((error: unknown) => console.warn('[smoke-dialogs] the sandboxed page did not load:', error))
        await waitFor(() => sandboxTab.wc.getURL() === `${base}/sandboxed` && !sandboxTab.wc.isLoading(), 8000)
        return evaluate<unknown>(sandboxTab.wc, 'window.__r', 2500).catch((error: unknown) => `NO ANSWER: ${String(error)}`)
      })
      const sandboxed = sandboxRun.result
      check('alert/confirm: a page served with `sandbox` (no allow-modals) shows no box at all: its alert() and confirm() return at once (confirm() is false), as in Chromium', Array.isArray(sandboxed) && sandboxed[0] === false && (sandboxed[1] as number) < 1000 && sandboxRun.native.length === 0 && browser.currentPanel() !== 'dialog' && dialogCount() === 0, JSON.stringify({ sandboxed, native: sandboxRun.native, panel: browser.currentPanel() }))
    }

    // =============== a private window ===============
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    priv.win.showInactive()
    const privateUi = () => priv.win.contentView.children.map((v) => (v as unknown as { webContents?: WebContents }).webContents).find((wc) => wc?.getURL().includes('overlay'))
    const privateTab = await openTab('/p?private', priv.browser, priv.store)
    await clickOn(privateTab.wc, '#ask')
    await waitFor(() => priv.browser.currentPanel() === 'dialog', 6000)
    const pui = privateUi()
    check('dialogs: a private window shows the box too, in its own window and not in the main one', priv.browser.currentPanel() === 'dialog' && browser.currentPanel() === null && request(priv.browser)?.host === host && !!pui, JSON.stringify({ priv: priv.browser.currentPanel(), main: browser.currentPanel() }))
    if (pui) {
      await waitFor(async () => (await evaluate<boolean>(pui, `!!document.querySelector('.adlg-prompt input.adlg-field')`).catch(() => false)) === true)
      await typeText(pui, 'privé')
      await press(pui, 'Enter')
      await waitFor(async () => (await resultOf(privateTab.wc)).after === 'ran')
      check('dialogs: ...and the answer reaches the page of the private window', (await resultOf(privateTab.wc)).r === 'privé')
    }
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
    win.emit('focus')

    // =============== what was said ===============
    const everything = [...logs, ...uiMessages].join('\n')
    check('dialogs: no log, of the main process or of the panel, holds a value that was typed or the text of a page', !everything.includes(TYPED) && !everything.includes('Mot de passe maître') && !everything.includes('appel direct') && !everything.includes('privé'), everything.split('\n').filter((l) => l.includes(TYPED)).join(' | ').slice(0, 300))
    const complaints = uiMessages.filter((m) => /error|warn/i.test(m))
    check('dialogs: the panel logged no error', complaints.length === 0, complaints.join(' | ').slice(0, 300))
  } finally {
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) console[level] = realConsole[level]
    ui.removeListener('console-message', onUiMessage)
    popup?.destroy()
    browser.closeOverlay()
    for (const tab of state().tabs.filter((t) => mine.has(t.id))) browser.dispatch({ type: 'tab/close', id: tab.id })
    if (state().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    if (extraSpace) {
      for (const tab of state().tabs.filter((t) => t.spaceId === extraSpace)) browser.dispatch({ type: 'tab/close', id: tab.id })
      browser.dispatch({ type: 'space/delete', id: extraSpace })
    }
    // A page that kept a connection open (a request still waiting) must not keep the run from ending.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The same checks with their own report, for `LUCIUM_SMOKE_ONLY=dialogs` and for the full chain in index.ts. */
export async function runDialogsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_DIALOGS_VERBOSE'] === '1'
    await smokeDialogs(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) process.stdout.write(`DIALOGS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}\n`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeDialogs ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DIALOGS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
