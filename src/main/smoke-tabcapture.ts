// Engine checks of the capture of the sound of a tab for an extension (shared/tab-capture.ts, shared/tab-capture-pcm.ts, main/engine/tab-capture.ts,
// main/engine/tab-capture-helper.ts), run inside a real Electron with compat/tab-capture-probe, which the suite loads itself and takes out again. The probe does what a
// captions extension does: its worker asks chrome.tabCapture.getMediaStreamId for a tab the person handed it (its shortcut, as a click on its icon), and an offscreen
// document of the extension asks getUserMedia for the sound of that tab with that identifier. Electron 45 stops on a request for media made from an offscreen document
// (media_stream_ui_proxy.cc:283: a crash or a hang), and WebRTC does not work there (two connections face to face stay at `new`: measured 13 November 2026), so the
// offscreen document asks the main process to listen: a helper page of Lucium's (an ordinary hidden window, in the session of the tab) asks for the screen with the sound of
// the tab, takes the picture off, reads the samples of the sound and sends them, chunk by chunk, to the main process, which hands them to the offscreen document alone; the
// document plays them into a track.
//
// A tab plays a tone; nothing is ever heard: the tab is silent for the person as soon as the capture begins, and the tone starts after. What is read, and how each check says
// what it saw:
//  - the refusals (the function off for the extension, no hand-over, an identifier used twice, a tab that was taken back), the mark and the notice;
//  - the helper page: one hidden window, at its fixed address lucium-ui://capture-helper/ (a secure context: an about:blank window has no navigator.mediaDevices, measured on
//    13 November 2026), sandboxed, with the one function of its preload and no Node, no extension API, no bridge of the interface, in the session of the tab, that goes nowhere,
//    that no web page can load, made for the capture and destroyed with it (stop, permission taken back);
//  - the stream of the offscreen document: one track of sound, live and not muted, and none of picture, a peak above 0.05 (the tone is 0.2), the end of its track when the
//    capture ends;
//  - the offscreen document is refused every other request for media (a microphone, a camera, a desktop, a screen) with a NotSupportedError and a message, and Electron goes on;
//  - the sound of the tab as it was.
// A local server is the only outside world. `LUCIUM_SMOKE_ONLY=tabcapture` runs this file alone; LUCIUM_EXTENSIONS is not needed.
//
// Not run when it was written (the application is never started by the one who wrote it): the first run is the check of everything below, above all that a hidden
// window with no click behind it is given a stream by getDisplayMedia, that MediaStreamTrackProcessor is there in the helper page, that the first chunk comes within three
// seconds for a tab that plays nothing yet, and that the track of the offscreen document gives the tone.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { CAPTURE_HELPER_URL } from '@shared/capture-helper-page'
import { activeProfileId } from '@shared/profiles'
import { TAB_CAPTURE_ERRORS } from '@shared/tab-capture'
import type { TabCaptureEvent } from './engine/types'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'

const PROBE = 'Lucium Tab Capture Probe'
const PROBE_FOLDER = 'tab-capture-probe'
const COMMAND = 'probe-capture'

const waitFor = waiterOf(15_000, 100)
/** For what is not expected to happen: the wait for a navigation that must not come is over fast. */
const waitBriefly = waiterOf(1_500, 50)
/** What an offscreen document is refused every request for media with (preload/extension-shims.ts: `installTabAudio`). */
const OFFSCREEN_REFUSAL = 'Lucium: media capture is not available in an offscreen document (Electron 45 stops on it): use a popup or an options page'

/** The page that drives the probe: it is a page of http://127.0.0.1, which the manifest lets send messages to the extension. */
const RPC_PAGE = `<title>tabcapture-rpc</title><body>rpc<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script></body>`

/** The tab whose sound is captured: a tone of 0.2 that starts when it is told to (the capture silences the tab first, so nobody hears it). */
const TONE_PAGE = `<title>tabcapture-tone</title><body>tone<script>
  let context = null
  window.start = () => { context = new AudioContext(); const gain = context.createGain(); gain.gain.value = 0.2; const oscillator = context.createOscillator(); oscillator.frequency.value = 440; oscillator.connect(gain).connect(context.destination); oscillator.start(); return context.resume().then(() => context.state) }
  window.stop = () => { if (context) context.close(); context = null; return true }
</script></body>`

interface Reply {
  ok: boolean
  error?: string
  id?: string
  audio?: number
  video?: number
  peak?: number
  ended?: boolean
  tracks?: string[]
  tabs?: Array<{ tabId: number; status: string }>
  /** The audio tracks of the stream the document holds: their state, and whether they are muted. */
  states?: Array<{ readyState: string; muted: boolean }>
  results?: Array<{ call: string; ok: boolean; name?: string; message?: string }>
}

export async function smokeTabCapture(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { store, engine, browser } = ctx
  const profile = activeProfileId(store.get())
  const folder = join(app.getAppPath(), 'compat', PROBE_FOLDER)
  let probe: { id: string; name: string } | undefined
  try {
    probe = await engine.loadExtension(profile, folder)
  } catch (error) {
    check(`the probe extension "${PROBE}" is loaded`, false, `${folder}: ${String((error as Error)?.message ?? error)}`)
    return
  }
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes, extensionTabCapture: store.get().settings.extensionTabCapture }
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0, extensionTabCapture: true } })
  const events: TabCaptureEvent[] = []
  engine.onTabCapture((event) => void events.push(event))

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(url.pathname === '/rpc' ? RPC_PAGE : TONE_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    check(`the probe extension "${PROBE}" is loaded`, probe.name === PROBE, `${folder} gave "${probe.name}" (${probe.id}); Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform} ${process.arch}`)
    if (probe.name !== PROBE) return
    const wcOf = (tabId: string): WebContents | undefined => {
      const number = engine.tabNumberOf(tabId)
      return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
    }
    const open = async (path: string, title: string) => {
      browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
      const tab = store.get().tabs.at(-1)!
      const loaded = await waitFor(() => wcOf(tab.id) !== undefined && store.get().tabs.find((t) => t.id === tab.id)?.title === title)
      return { tab, wc: wcOf(tab.id), loaded }
    }
    const driver = await open('/rpc', 'tabcapture-rpc')
    const target = await open('/tone', 'tabcapture-tone')
    check('tabcapture: the page that drives the probe and the tab to capture load', driver.loaded && target.loaded && driver.wc !== undefined && target.wc !== undefined)
    if (!driver.wc || !target.wc) return
    const driverWc = driver.wc
    const targetWc = target.wc
    const targetNumber = targetWc.id
    const ask = (message: Record<string, unknown>): Promise<Reply> => driverWc.executeJavaScript(`window.rpc(${JSON.stringify(probe!.id)}, ${JSON.stringify(message)})`) as Promise<Reply>
    const mark = (): string | undefined => browser.snapshot().runtime.tabs[target.tab.id]?.capturedBy
    // The helper pages: the windows that were not there before the capture, that no one sees, and whose page is at the fixed address of the helper.
    const windowsBefore = new Set(BrowserWindow.getAllWindows().map((win) => win.id))
    const helperWindows = (): BrowserWindow[] => BrowserWindow.getAllWindows().filter((win) => !windowsBefore.has(win.id) && !win.isDestroyed() && win.webContents.getURL() === CAPTURE_HELPER_URL)
    const windowsNow = (): string => JSON.stringify(BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => ({ id: win.id, url: win.webContents.getURL(), visible: win.isVisible() })))
    const handOver = (): void => {
      // The tab on screen is the one handed over (the shortcut of the command is a click on the icon of the extension): the tab to capture is the last one opened.
      browser.dispatch({ type: 'tab/select', id: target.tab.id })
      browser.runExtensionCommand(probe!.id, COMMAND)
    }

    // ---- refused: the person has not allowed the extension (off by default), and is told ----
    handOver()
    const off = await ask({ type: 'id', tabId: targetNumber })
    check('tabcapture: the capture is off for the extension until the person allows it: getMediaStreamId is refused with the sentence that says so', !off.ok && /switched off for this extension \(Extensions › Details\)/.test(off.error ?? ''), JSON.stringify(off))
    check('tabcapture: ...and the person is told, by an event that the window turns into a notice with « Ouvrir les détails »', events.some((event) => event.kind === 'refused' && event.extensionId === probe!.id), JSON.stringify(events))

    // ---- refused: allowed, but the tab was not handed over ----
    browser.dispatch({ type: 'extension/set-tab-capture', profileId: profile, extensionId: probe.id, allowed: true })
    // The page that drives the probe was never handed over: asking for it says whether the choice reached the engine (it no longer says « switched off »), and makes no identifier.
    let notHanded: Reply = { ok: false }
    await waitFor(async () => ((notHanded = await ask({ type: 'id', tabId: driverWc.id })).error !== undefined && !notHanded.error.includes('switched off')))
    check('tabcapture: a tab that was not handed over to the extension is refused, in the words of the extension platform', !notHanded.ok && notHanded.error === TAB_CAPTURE_ERRORS.notInvoked, JSON.stringify(notHanded))

    // ---- an offscreen document is refused the requests for media that Electron 45 stops on ----
    const native = await ask({ type: 'native' })
    const refusedAll = native.ok && native.results?.length === 4 && native.results.every((result) => !result.ok && result.name === 'NotSupportedError' && result.message === OFFSCREEN_REFUSAL)
    check('tabcapture: the offscreen document is refused a microphone, a camera, a desktop and a screen with a NotSupportedError and the message that says why (Electron went on)', refusedAll, JSON.stringify(native))
    check('tabcapture: ...and no window was made by those requests (the helper page is only made for a capture)', helperWindows().length === 0, windowsNow())

    // ---- a web page cannot load the address of the helper page, nor tell that it is there ----
    const probeFrames = await targetWc.executeJavaScript(`new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.src = ${JSON.stringify(CAPTURE_HELPER_URL)}
      const script = document.createElement('script')
      script.src = ${JSON.stringify(CAPTURE_HELPER_URL)}
      const seen = { frame: 'pending', script: 'pending', opened: String(Boolean(window.open(${JSON.stringify(CAPTURE_HELPER_URL)}))) }
      const done = () => { if (seen.frame !== 'pending' && seen.script !== 'pending') resolve(seen) }
      frame.addEventListener('load', () => { seen.frame = 'load'; done() })
      script.addEventListener('load', () => { seen.script = 'load'; done() })
      script.addEventListener('error', () => { seen.script = 'error'; done() })
      document.body.append(frame, script)
      setTimeout(() => resolve(seen), 8000)
    })`, true) as { frame: string; script: string; opened: string }
    const framed = targetWc.mainFrame.frames.map((frame) => frame.url)
    check('tabcapture: a web page that asks for the address of the helper page (a frame, a script, window.open) is given no document: the script fails, nothing opens, no frame of it holds the helper', probeFrames.script === 'error' && probeFrames.opened === 'false' && !framed.includes(CAPTURE_HELPER_URL) && helperWindows().length === 0 && !store.get().tabs.some((tab) => tab.url === CAPTURE_HELPER_URL), `${JSON.stringify(probeFrames)}; frames ${JSON.stringify(framed)}; windows now ${windowsNow()}`)

    // ---- the whole way, the tab silent for the person before ----
    const wasMuted = true
    browser.dispatch({ type: 'tab/select', id: target.tab.id })
    browser.toggleMute(target.tab.id)
    check('tabcapture: the tab is silent for the person before the capture (the state the sound must go back to)', await waitFor(() => targetWc.isAudioMuted() === wasMuted), `muted ${targetWc.isAudioMuted()}`)
    handOver()
    const made = await ask({ type: 'id', tabId: targetNumber })
    check('tabcapture: handed over, allowed, the extension gets an identifier (a random UUID)', made.ok && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(made.id ?? ''), JSON.stringify(made))
    const heard = await ask({ type: 'listen', id: made.id })
    check('tabcapture: the offscreen document gets a stream with one track of sound and none of picture, and that track is live and not muted', heard.ok && heard.audio === 1 && heard.video === 0 && heard.states?.length === 1 && heard.states[0]!.readyState === 'live' && heard.states[0]!.muted === false, JSON.stringify(heard))
    check('tabcapture: the tab carries the mark of the extension while it listens, and the shell was told it began', await waitFor(() => mark() === PROBE) && events.some((event) => event.kind === 'started'), `mark ${mark()}; events ${JSON.stringify(events)}`)
    const helpers = helperWindows()
    const helperWc = helpers[0]?.webContents
    check('tabcapture: one helper page was made for the capture: a window nobody sees, on the fixed address of the helper', helpers.length === 1 && helpers[0]!.isVisible() === false, `${helpers.length} helper window(s); windows now ${windowsNow()}`)
    if (helperWc) {
      // What the page itself can reach: none of Node, none of the interface's bridges, no extension API.
      const reach = JSON.parse((await helperWc.executeJavaScript(`JSON.stringify({ require: typeof require, process: typeof process, shim: typeof __luciumShim, lucium: typeof window.lucium, chromeRuntime: typeof (window.chrome && window.chrome.runtime), chromeStorage: typeof (window.chrome && window.chrome.storage), bridge: Object.keys(window.luciumCapture || {}).join(), secure: isSecureContext, origin: location.origin, href: location.href, display: typeof navigator.mediaDevices?.getDisplayMedia, processor: typeof MediaStreamTrackProcessor })`, true)) as string) as Record<string, string | boolean>
      const metric = app.getAppMetrics().find((entry) => entry.pid === helperWc.getOSProcessId())
      check('tabcapture: the helper page reaches no Node, no bridge of the interface, no extension API (window.chrome of any page has no runtime or storage), and one function only of Lucium (luciumCapture.send), and its process is sandboxed', reach['require'] === 'undefined' && reach['process'] === 'undefined' && reach['shim'] === 'undefined' && reach['lucium'] === 'undefined' && reach['chromeRuntime'] === 'undefined' && reach['chromeStorage'] === 'undefined' && reach['bridge'] === 'send' && metric?.sandboxed === true, `${JSON.stringify(reach)}; process ${helperWc.getOSProcessId()} sandboxed ${String(metric?.sandboxed)}`)
      check('tabcapture: ...and its address is a secure context where it may ask for the screen and read the samples of a track (isSecureContext, origin of the helper, getDisplayMedia and MediaStreamTrackProcessor present)', reach['secure'] === true && reach['origin'] === CAPTURE_HELPER_URL.slice(0, -1) && reach['href'] === CAPTURE_HELPER_URL && reach['display'] === 'function' && reach['processor'] === 'function', JSON.stringify(reach))
      check('tabcapture: the helper page is in the session of the tab it listens to (the profile of the extension)', helperWc.session === targetWc.session, `helper partition ${helperWc.session.storagePath ?? 'memory'}, tab partition ${targetWc.session.storagePath ?? 'memory'}`)
      // A navigation of its own is stopped before it begins, or comes to nothing: the page stays where it is. Seeing the attempt is not asked for (Chromium may not tell it).
      const prevented: boolean[] = []
      helperWc.on('will-navigate', (event) => void prevented.push(event.defaultPrevented))
      void helperWc.executeJavaScript(`location.href = ${JSON.stringify(`${base}/tone`)}`, true)
      await waitBriefly(() => prevented.length > 0 || helperWc.getURL() !== CAPTURE_HELPER_URL)
      check('tabcapture: the helper page cannot be made to go anywhere: it stays on its address and no window opens', helperWc.getURL() === CAPTURE_HELPER_URL && helperWindows().length === 1 && prevented.every((one) => one), `navigations seen ${JSON.stringify(prevented)}, url ${helperWc.getURL()}; windows now ${windowsNow()}`)
      const opened = await helperWc.executeJavaScript(`Boolean(window.open(${JSON.stringify(`${base}/tone`)}))`, true)
      check('tabcapture: ...and it opens no window of its own', opened === false && helperWindows().length === 1, `window.open gave ${String(opened)}; windows now ${windowsNow()}`)
    }
    check('tabcapture: the tab is silent for the person while the capture runs', targetWc.isAudioMuted() === true)
    await targetWc.executeJavaScript('window.start()', true)
    const level = await ask({ type: 'peak', ms: 2000 })
    check('tabcapture: the stream carries the sound of the tab (a peak above 0.05 for a tone of 0.2) although the tab is silent for the person', level.ok && (level.peak ?? 0) > 0.05, JSON.stringify(level))
    const flowing = await ask({ type: 'state' })
    check('tabcapture: ...and the track is still one audio track, live, not muted, after the sound ran', flowing.ok && flowing.tracks?.length === 1 && flowing.tracks[0] === 'audio:live' && flowing.states?.[0]?.muted === false, JSON.stringify(flowing))
    const captured = await ask({ type: 'captured' })
    check('tabcapture: getCapturedTabs lists the tab', captured.ok && captured.tabs?.some((entry) => entry.tabId === targetNumber && entry.status === 'active') === true, JSON.stringify(captured))

    // ---- an identifier is used once ----
    const again = await ask({ type: 'listen', id: made.id })
    check('tabcapture: the same identifier is refused the second time', !again.ok, JSON.stringify(again))
    const second = await ask({ type: 'id', tabId: targetNumber })
    check('tabcapture: a tab that is captured cannot be captured again (one capture by tab)', !second.ok && second.error === TAB_CAPTURE_ERRORS.busy, JSON.stringify(second))

    // ---- the person stops it: the sound is as it was, the stream ends, and the tab has to be handed over again ----
    browser.stopTabCapture(target.tab.id)
    check('tabcapture: stopped by the person, the mark goes and the sound is as it was (silent: it was silent before)', (await waitFor(() => mark() === undefined)) && targetWc.isAudioMuted() === wasMuted, `mark ${mark()}, muted ${targetWc.isAudioMuted()}`)
    check('tabcapture: ...and the helper page is destroyed with the capture it was made for', await waitFor(() => helperWindows().length === 0), `windows now ${windowsNow()}`)
    let after: Reply = { ok: false }
    const ended = await waitFor(async () => ((after = await ask({ type: 'state' })).ok && after.tracks?.every((track) => track.endsWith(':ended')) === true))
    check('tabcapture: ...and the page that listened sees its track end (it was asked to, or its document was replaced)', ended, JSON.stringify(after))
    const taken = await ask({ type: 'id', tabId: targetNumber })
    check('tabcapture: the tab was taken back from the extension: it has to be handed over again', !taken.ok && taken.error === TAB_CAPTURE_ERRORS.notInvoked, JSON.stringify(taken))

    // ---- the sound of a tab that was not silent comes back as it was, and what ends the capture is the person's choice for the extension ----
    browser.toggleMute(target.tab.id)
    check('tabcapture: the tab is made audible again for the next capture', await waitFor(() => targetWc.isAudioMuted() === false))
    handOver()
    const next = await ask({ type: 'id', tabId: targetNumber })
    const nextHeard = next.ok ? await ask({ type: 'listen', id: next.id }) : next
    check('tabcapture: a second capture begins after the first one ended', nextHeard.ok && (await waitFor(() => mark() === PROBE)), JSON.stringify(nextHeard))
    check('tabcapture: the tab is silent for the person while it runs', targetWc.isAudioMuted() === true)
    check('tabcapture: the second capture has a helper page of its own: one window, not two', helperWindows().length === 1, `windows now ${windowsNow()}`)
    browser.dispatch({ type: 'extension/set-tab-capture', profileId: profile, extensionId: probe.id, allowed: false })
    check('tabcapture: the person takes the permission back: the capture ends, the mark goes and the tab is audible as before', (await waitFor(() => mark() === undefined)) && (await waitFor(() => targetWc.isAudioMuted() === false)), `mark ${mark()}, muted ${targetWc.isAudioMuted()}`)
    check('tabcapture: ...and its helper page is destroyed: no window is left', await waitFor(() => helperWindows().length === 0), `windows now ${windowsNow()}`)
    await targetWc.executeJavaScript('window.stop()')
  } catch (error) {
    check('tabcapture: the checks ran to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'settings/update', patch: prior })
    browser.dispatch({ type: 'extension/set-tab-capture', profileId: profile, extensionId: probe.id, allowed: false })
    server.close()
    server.closeAllConnections()
    // Nothing of the probe stays in the profile of the run, nor in the profiles made after this suite.
    ;(engine as unknown as { forgetExtensionFolder(path: string): void }).forgetExtensionFolder(folder)
  }
}

/** `LUCIUM_SMOKE_ONLY=tabcapture`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runTabCaptureSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeTabCapture(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeTabCapture ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_TAB_CAPTURE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
