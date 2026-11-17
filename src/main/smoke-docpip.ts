// Engine checks of the floating window of a call (document Picture-in-Picture, feature `document-pip`: shared/document-pip.ts, engine/document-pip-windows.ts),
// run inside a real Electron, and the probe of what Electron hands over for it: run at each upgrade of Electron (docs/mise-a-jour-chromium.md). A server of
// its own on localhost (a secure context: the page has `documentPictureInPicture`; no camera, no Internet) serves a page whose button calls
// `requestWindow()` and writes a button into the window. `LUCIUM_SMOKE_ONLY=docpip` runs it. Every `[pip]` line of the log and what Electron handed to
// the page's internal event are printed at the end, whatever the checks say: they are the probe.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BaseWindow, webContents as allWebContents, type WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { ADD_NEW_CONTENTS } from './engine/document-pip-windows'
import { closeLeftoverPanels, noteCheck, waiterOf, type CheckRecord } from './smoke-kit'
import { OPEN_GESTURE_WINDOW_MS } from '@shared/external-links'
import { DOCUMENT_PIP_DEFAULT_SIZE } from '@shared/document-pip'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(8000, 60)

/** A script run in a page, with a limit: a page that never answers fails the check that asked instead of hanging the run. */
const evaluate = <T>(wc: WebContents, script: string, gesture = false, timeoutMs = 8000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to a script after ${timeoutMs} ms: ${script.slice(0, 80)}`)), timeoutMs)
    ;(wc.executeJavaScript(script, gesture) as Promise<T>).then(
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

/** The page of a call: a button that asks for the window (after a click), and a way to ask without one. What happens is kept in `window.__pip`. */
const CALL_PAGE = `<title>call</title><body style="margin:0">
<button id="float" style="position:absolute;left:10px;top:10px;width:220px;height:40px">float</button>
<script>
  window.__pip = { supported: 'documentPictureInPicture' in window, state: 'idle', error: '', clicks: 0, closed: false, entered: 0, size: null }
  if (window.documentPictureInPicture) documentPictureInPicture.addEventListener('enter', () => { window.__pip.entered++ })
  document.getElementById('float').addEventListener('click', async () => {
    window.__pip.state = 'asking'
    try {
      const pip = await documentPictureInPicture.requestWindow({ width: 360, height: 220 })
      window.__pipWindow = pip
      const button = pip.document.createElement('button')
      button.id = 'hangup'
      button.textContent = 'hang up'
      button.style.cssText = 'position:absolute;left:10px;top:10px;width:160px;height:40px'
      button.addEventListener('click', () => { window.__pip.clicks++ })
      pip.document.body.append(button)
      pip.addEventListener('pagehide', () => { window.__pip.closed = true })
      window.__pip.size = { width: pip.innerWidth, height: pip.innerHeight }
      window.__pip.state = 'open'
    } catch (error) {
      window.__pip.state = 'refused'
      window.__pip.error = String((error && error.name) || error)
    }
  })
  // The same request with no click behind it.
  window.__askWithoutClick = () => documentPictureInPicture.requestWindow().then((w) => { window.__pipWindow = w; return 'open' }, (e) => 'refused:' + ((e && e.name) || e))
</script></body>`

/**
 * The size Electron handed the last document Picture-in-Picture window over with, read from the line the engine writes of it (`"bounds":{…}`,
 * document-pip-windows.ts); null without such a line, or when the size it gives is not two numbers.
 */
function sizeHandedOver(probe: readonly string[]): { width: number; height: number } | null {
  const line = probe.findLast((entry) => entry.startsWith('[pip] Electron handed over'))
  const bounds = line?.match(/"bounds":\{"left":[^,]*,"top":[^,]*,"width":(-?\d+(?:\.\d+)?),"height":(-?\d+(?:\.\d+)?)\}/)
  return bounds ? { width: Number(bounds[1]), height: Number(bounds[2]) } : null
}

interface PipState {
  supported: boolean
  state: 'idle' | 'asking' | 'open' | 'refused'
  error: string
  clicks: number
  closed: boolean
  entered: number
  size: { width: number; height: number } | null
}

export async function smokeDocPip(ctx: SmokeContext, check: Check, probe: string[]): Promise<void> {
  const { browser, store, engine, win } = ctx
  const seen: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== '/favicon.ico') seen.push(path)
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/call') return res.end(CALL_PAGE)
    return res.end('<title>elsewhere</title><body>elsewhere</body>')
  })
  // Dual-stack: both `localhost` (the page) and `127.0.0.1` (another origin, where the window must never go) reach it.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const A = `http://localhost:${port}`
  const B = `http://127.0.0.1:${port}`
  const docPip = engine.documentPipWindows()
  const tabs = () => store.get().tabs
  const prior = { documentPictureInPicture: store.get().settings.documentPictureInPicture }
  const baseWindows = () => BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const mine: string[] = []
  const openTab = async (url: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = tabs().at(-1)!
    mine.push(tab.id)
    await waitFor(() => pageOf(tab.id) !== undefined)
    const wc = pageOf(tab.id)!
    await waitFor(() => !wc.isLoading() && wc.getURL() === url)
    return { id: tab.id, wc }
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  /** A real click on an element of a page: the pointer moves, goes down and up. */
  const clickOn = async (wc: WebContents, selector: string): Promise<boolean> => {
    const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!rect) return false
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
    return true
  }
  const pipState = (wc: WebContents): Promise<PipState> => evaluate<PipState>(wc, 'window.__pip')
  /** Clicks the button of the page and waits for its request to end; the state the page is left in. */
  const askWithClick = async (wc: WebContents): Promise<PipState> => {
    await evaluate(wc, `window.__pip.state = 'idle'; window.__pip.error = ''; 0`)
    await clickOn(wc, '#float')
    await waitFor(async () => ['open', 'refused'].includes((await pipState(wc)).state))
    return pipState(wc)
  }
  /** What Electron hands to the page's internal event, whoever takes it: the probe (nothing here prevents or changes anything). */
  const listenTo = (wc: WebContents): void => {
    ;(wc as unknown as NodeJS.EventEmitter).on(ADD_NEW_CONTENTS, (...args: unknown[]) => {
      const [, contents, disposition, userGesture, left, top, width, height, url, frameName] = args
      const described = typeof contents === 'object' && contents !== null && 'id' in contents ? `web contents ${String((contents as { id: unknown }).id)}` : typeof contents
      probe.push(`${ADD_NEW_CONTENTS} reached the page: ${JSON.stringify({ disposition, userGesture, bounds: { left, top, width, height }, url, frameName, contents: described, count: args.length })}`)
    })
  }
  const setFeature = async (on: boolean): Promise<boolean> => {
    browser.dispatch({ type: 'settings/update', patch: { documentPictureInPicture: on } })
    return waitFor(() => docPip.enabled() === on, 3000)
  }

  win.showInactive()
  const leftover = closeLeftoverPanels(browser)
  if (leftover.length > 0) console.warn(`[docpip] closed what an earlier suite left over the window: ${leftover.join(', ')}`)
  try {
    // =============== the switch off: the request fails as it always did, without a tab ===============
    await setFeature(false)
    const opener = await openTab(`${A}/call`)
    listenTo(opener.wc)
    const start = await pipState(opener.wc)
    check('the page of a call has documentPictureInPicture (http://localhost is a secure context)', start.supported, JSON.stringify(start))
    if (!start.supported) return
    const tabsBefore = tabs().length
    const windowsBefore = baseWindows()
    // The page's request has ended (refused): the handler had answered by then, and a tab it would have opened is in the state already.
    const off = await askWithClick(opener.wc)
    // The click is behind this moment: what is measured from here is at least its age.
    const offClickedBy = Date.now()
    check('feature off: requestWindow() after a click is refused, as before', off.state === 'refused', JSON.stringify(off))
    check('...without a tab (not even a blank one) and without a window', tabs().length === tabsBefore && docPip.count() === 0 && baseWindows() === windowsBefore, `tabs ${tabs().length}/${tabsBefore}, pip ${docPip.count()}, windows ${baseWindows()}/${windowsBefore}`)
    check('...and the log says why', probe.some((line) => line.includes('[pip] refused') && line.includes('is off')), probe.join(' | ').slice(0, 600))

    // =============== on, without a click: refused ===============
    check('the feature switches on through its setting', await setFeature(true))
    // The click of the refusal above was not used up (a refusal for the switch leaves it, in Lucium's memory of clicks and in Chromium's transient
    // activation of the page, which lasts 5 s): asked within those seconds, the request below had a click behind it, and opened its window. It must be
    // too old to explain anything first, for both. What is waited for is time itself, the age of that click.
    await waitFor(() => Date.now() - offClickedBy > OPEN_GESTURE_WINDOW_MS + 500, OPEN_GESTURE_WINDOW_MS + 3000)
    const asked = () => probe.filter((line) => line.includes('asked for a document Picture-in-Picture window')).length
    const askedBefore = asked()
    const scripted = await evaluate<string>(opener.wc, 'window.__askWithoutClick()')
    // Who refused is the probe's: Chromium (the request never reached the handler of the page) or Lucium (it did, and found no click).
    const refusedBy = asked() > askedBefore ? 'Lucium: the request reached the handler, which found no click' : 'Chromium: the request never reached the handler'
    probe.push(`[docpip] a requestWindow() with no click at all: ${scripted}, refused by ${refusedBy}`)
    check('feature on: requestWindow() with no click at all is refused, without a window or a tab', scripted.startsWith('refused') && docPip.count() === 0 && tabs().length === tabsBefore, `${scripted} (${refusedBy}), pip ${docPip.count()}, tabs ${tabs().length}/${tabsBefore}`)
    // A window the check above let open would be counted against the next one: closed first, so that each check judges its own request.
    const leftOpen = docPip.closeAll('the check before let a window open')
    if (leftOpen > 0) console.warn(`[docpip] closed ${leftOpen} window(s) the check without a click let open`)
    const handed = await evaluate<string>(opener.wc, 'window.__askWithoutClick()', true)
    check('...and so is one that only a script says is a gesture: no click or key of the user in the tab explains it', handed.startsWith('refused') && docPip.count() === 0 && tabs().length === tabsBefore, `${handed}, pip ${docPip.count()}, tabs ${tabs().length}/${tabsBefore}`)
    check('...with its reason in the log', probe.some((line) => line.includes('no click or key of the user explains it')), probe.slice(-4).join(' | '))

    // =============== on, after a click: the window ===============
    const on = await askWithClick(opener.wc)
    const shown = await waitFor(() => docPip.windowOf(opener.id) !== undefined)
    const floating = docPip.windowOf(opener.id)
    check('feature on: requestWindow() after a click resolves, and the page gets its window', on.state === 'open' && shown && floating !== undefined, JSON.stringify({ on, count: docPip.count() }))
    check('...without a tab', tabs().length === tabsBefore, `tabs ${tabs().length}/${tabsBefore}`)
    if (!floating) return
    const pip = floating.contents
    check('the window is shown, above the other windows', floating.win.isVisible() && floating.win.isAlwaysOnTop(), `visible ${floating.win.isVisible()}, on top ${floating.win.isAlwaysOnTop()}`)
    const content = floating.win.getContentBounds()
    // The size the page asked for (360 × 220) reaches the main process only if Electron hands it over with the window: Electron 45 hands 0 × 0 (the
    // size travels in Chromium's options of the window, which Electron does not pass on), and the window then has the default size. The check holds
    // the window to what was handed over, and to the page's own size the day Electron passes it on; the probe says which it was.
    const handedSize = sizeHandedOver(probe)
    const sizeKnown = handedSize !== null && handedSize.width > 0 && handedSize.height > 0
    const expected = sizeKnown ? { width: 360, height: 220 } : DOCUMENT_PIP_DEFAULT_SIZE
    probe.push(`[docpip] Electron handed the window over with ${sizeKnown ? `the size ${handedSize.width} × ${handedSize.height}` : `no size (${JSON.stringify(handedSize)}): it opens at the default ${DOCUMENT_PIP_DEFAULT_SIZE.width} × ${DOCUMENT_PIP_DEFAULT_SIZE.height}, not at the 360 × 220 the page asked for`}`)
    const near = (size: { width: number; height: number }, to: { width: number; height: number }) => Math.abs(size.width - to.width) <= 2 && Math.abs(size.height - to.height) <= 2
    check('...at the size the page asked for when Electron hands it over (360 × 220), else at the default size (400 × 300)', near(content, expected) && (!sizeKnown || near(handedSize, expected)), JSON.stringify({ content, handedOver: handedSize }))
    check('...with the site of its page in its title bar', floating.win.getTitle() === `localhost:${port}`, floating.win.getTitle())
    const entered = await pipState(opener.wc)
    check('the page sees its window (documentPictureInPicture.window, the enter event)', (await evaluate<boolean>(opener.wc, '!!documentPictureInPicture.window')) && entered.entered >= 1, JSON.stringify(entered))
    check('the window is in the session of its page, and in its process', pip.session === opener.wc.session && pip.getOSProcessId() === opener.wc.getOSProcessId(), `${pip.getOSProcessId()} / ${opener.wc.getOSProcessId()}`)
    const preferences = (pip as unknown as { getLastWebPreferences(): Record<string, unknown> | undefined }).getLastWebPreferences() ?? {}
    check('...a page: sandbox, isolation, no Node, no preload', preferences['sandbox'] === true && preferences['contextIsolation'] === true && preferences['nodeIntegration'] === false && !preferences['preload'], JSON.stringify(preferences))
    check('...without the bridge of the interface (window.lucium), require or process', (await evaluate<string>(pip, '[typeof window.lucium, typeof require, typeof process].join()')) === 'undefined,undefined,undefined')
    check('the button the page wrote is in the window', await waitFor(async () => (await evaluate<boolean>(pip, '!!document.getElementById("hangup")')) === true, 3000))
    await clickOn(pip, '#hangup')
    check('...and a real click on it works (the page counts it)', await waitFor(async () => (await pipState(opener.wc)).clicks === 1, 3000), JSON.stringify(await pipState(opener.wc)))
    check('the probe saw Electron hand the window over', probe.some((line) => line.startsWith('[pip] Electron handed over')), probe.join(' | ').slice(0, 600))

    // =============== it goes nowhere ===============
    const seenBefore = seen.length
    await evaluate(opener.wc, `window.__pipWindow.location.href = '${B}/elsewhere'; 0`).catch((error: unknown) => console.log(`[docpip] the navigation ended the script: ${String(error).slice(0, 80)}`))
    check('sent to another origin, the window closes and goes nowhere', (await waitFor(() => docPip.count() === 0, 4000)) && !seen.slice(seenBefore).includes('/elsewhere'), `pip ${docPip.count()}, requests ${JSON.stringify(seen.slice(seenBefore))}`)

    // =============== the page closes it ===============
    await askWithClick(opener.wc)
    await waitFor(() => docPip.count() === 1)
    await evaluate(opener.wc, 'window.__pipWindow.close(); 0')
    check('the page closes its window (pipWindow.close()): it is gone, and the page sees it closed', (await waitFor(() => docPip.count() === 0)) && (await waitFor(async () => (await pipState(opener.wc)).closed === true, 3000)), JSON.stringify(await pipState(opener.wc)))

    // =============== one at a time ===============
    await askWithClick(opener.wc)
    await waitFor(() => docPip.count() === 1)
    const first = docPip.windowOf(opener.id)?.contents.id
    await askWithClick(opener.wc)
    await waitFor(() => docPip.windowOf(opener.id)?.contents.id !== first)
    check('a second window of the tab takes the place of the first: one at a time', docPip.count() === 1 && docPip.windowOf(opener.id)?.contents.id !== first, `count ${docPip.count()}`)

    // =============== it goes with its page ===============
    await opener.wc.loadURL(`${A}/call?next`).catch((error: unknown) => console.log(`[docpip] the tab's next document: ${String(error).slice(0, 120)}`))
    check('the tab goes to another document: the window closes', await waitFor(() => docPip.count() === 0), `count ${docPip.count()}`)
    await waitFor(async () => (await pipState(opener.wc).catch(() => null))?.state === 'idle', 3000)
    await askWithClick(opener.wc)
    await waitFor(() => docPip.count() === 1)
    browser.dispatch({ type: 'tab/close', id: opener.id })
    check('the tab closes: the window closes', await waitFor(() => docPip.count() === 0), `count ${docPip.count()}`)

    // =============== switched off: the windows close, and the request fails again ===============
    const second = await openTab(`${A}/call?again`)
    listenTo(second.wc)
    await askWithClick(second.wc)
    await waitFor(() => docPip.count() === 1)
    await setFeature(false)
    check('switching the feature off closes the window that is open', await waitFor(() => docPip.count() === 0), `count ${docPip.count()}`)
    const tabsNow = tabs().length
    const again = await askWithClick(second.wc)
    check('...and the request fails again as before, without a tab', again.state === 'refused' && tabs().length === tabsNow && docPip.count() === 0, JSON.stringify({ again, tabs: tabs().length }))
  } finally {
    browser.dispatch({ type: 'settings/update', patch: prior })
    for (const id of mine) if (tabs().some((tab) => tab.id === id)) browser.dispatch({ type: 'tab/close', id })
    docPip.closeAll('the engine check ended')
    server.close()
  }
}

export async function runDocPipSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  const probe: string[] = []
  // The probe: every `[pip]` line the engine writes while the suite runs, kept as well as written.
  const keep = (write: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].startsWith('[pip]')) probe.push(args.map(String).join(' ').slice(0, 800))
    write(...args)
  }
  const real = { info: console.info, warn: console.warn, error: console.error }
  console.info = keep(real.info)
  console.warn = keep(real.warn)
  console.error = keep(real.error)
  try {
    await smokeDocPip(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail), probe)
  } catch (error) {
    noteCheck(checks, 'smokeDocPip ran to the end', false, String((error as Error).stack ?? error))
  } finally {
    Object.assign(console, real)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DOCPIP ${JSON.stringify({ checks, probe, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
