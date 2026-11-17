// Engine checks of the console of the pages of an extension, as the "Erreurs et journal" part of the Extensions page (chrome://extensions) shows it
// (src/shared/extension-journal.ts, main/engine/extension-console.ts), run inside a real Electron with a probe the suite writes itself, loads, and takes out again.
//
// What it is about: the preloads of Lucium that patch the main world of a page (the dialog bridge, the media bridge, `window.chrome.app` and the state of the permissions)
// are registered for every page of a session, an extension's too, and they reach the main world through `contextBridge`, which Electron refuses in a document without context
// isolation (an offscreen document, the background page of a Manifest V2 extension, the pages of the DevTools). Each of them then said so on the console of the page, and
// the journal of the Extensions page showed those lines as the extension's own: "contextBridge API can only be used when contextIsolation is enabled". A line of the library
// (electron-chrome-extensions) said "injectExtensionAPIs: context isolation disabled" there too.
//
// The probe has an offscreen document (made without isolation by Electron), an options page (opened in a tab, with isolation) and a popup (the library's own window, with
// isolation); a second probe, in Manifest V2, has a background page (made without isolation too). Each page says one line of its own when it is ready, which proves the
// journal heard that page. What is read:
//  - the pages without isolation really are such (the library says so on their console: if it ever stops saying it, the checks below prove nothing, and say so);
//  - the journal of the extension holds no line of Lucium's preloads and no line about the context isolation, for any page of the probes, and the console of the pages
//    themselves holds no line of Lucium's preloads (the raw lines, read from the pages, not from the journal; the library's own notice stays there);
//  - the pages that have isolation still have their bridges (the media bridge of the options page is installed: nothing was taken from them).
// A local server is the only outside world. `LUCIUM_SMOKE_ONLY=extconsole` runs this file alone; LUCIUM_EXTENSIONS is not needed.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { activeProfileId } from '@shared/profiles'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf, sleep, type CheckFn, type CheckRecord } from './smoke-kit'

const PROBE = 'Lucium Console Probe'
const PROBE_V2 = 'Lucium Console Probe V2'
const waitFor = waiterOf(12_000, 100)

/** What a line of the console of a page must not say: Lucium's own preloads (`[lucium] …`) and what Electron says of a bridge it refuses. */
const NOISE = /contextBridge|^\[lucium\]/i
/** The same for the journal, which does not show either the library's notice about a page without isolation. */
const JOURNAL_NOISE = /contextBridge|contextIsolation|context isolation|injectExtensionAPIs|^\[lucium\]/i
/** The library's own notice, the proof that a page has no context isolation. */
const LIBRARY_NOTICE = /injectExtensionAPIs: context isolation disabled/

const MANIFEST = {
  manifest_version: 3,
  name: PROBE,
  version: '0.1.0',
  description: 'Opens an offscreen document, an options page and a popup that each say one line, to read what the journal of the Extensions page shows of them (smokeExtConsole).',
  background: { service_worker: 'background.js' },
  permissions: ['offscreen'],
  action: { default_title: 'Console probe', default_popup: 'popup.html' },
  options_page: 'options.html',
  externally_connectable: { matches: ['http://127.0.0.1/*'] }
}

const MANIFEST_V2 = {
  manifest_version: 2,
  name: PROBE_V2,
  version: '0.1.0',
  description: 'A Manifest V2 extension whose background page says one line, to read what the journal of the Extensions page shows of a page without context isolation (smokeExtConsole).',
  background: { page: 'background.html', persistent: true }
}

/** The worker opens each page when a local page asks it to (an extension page of a site may send it messages: `externally_connectable`). */
const WORKER = `chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  const said = (value) => reply({ ok: true, value: value === undefined ? null : value })
  const failed = (error) => reply({ ok: false, error: String((error && error.message) || error) })
  const lastError = () => (chrome.runtime.lastError ? failed(chrome.runtime.lastError) : said())
  try {
    if (message && message.type === 'offscreen') chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'console probe' }).then(said, failed)
    else if (message && message.type === 'closeOffscreen') chrome.offscreen.closeDocument().then(said, failed)
    else if (message && message.type === 'options') chrome.runtime.openOptionsPage(lastError)
    else if (message && message.type === 'popup') chrome.action.openPopup(lastError)
    else reply({ ok: false, error: 'unknown request' })
  } catch (error) {
    failed(error)
  }
  return true
})
`

/** Each page of the probe loads this and says one line of its own, once it runs. */
const PAGE_SCRIPT = `console.log('console-probe ready: ' + location.pathname)\n`
const PAGE = (title: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:13px system-ui;padding:8px">${title}<script src="page.js"></script></body>\n`

/** The page that drives the probe: it is a page of http://127.0.0.1, which the manifest lets send messages to the extension. */
const RPC_PAGE = `<title>extconsole-rpc</title><body>rpc<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script></body>`

interface Reply {
  ok: boolean
  error?: string
}

/** A line of the console of a page of the probes, as the page said it. */
interface RawLine {
  extensionId: string
  page: string
  level: string
  message: string
}

const shown = (lines: ReadonlyArray<{ message: string }>): string => JSON.stringify(lines.map((line) => line.message.slice(0, 160)))

export async function smokeExtConsole(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { store, engine, browser } = ctx
  const profile = activeProfileId(store.get())
  const root = mkdtempSync(join(tmpdir(), 'lucium-extconsole-'))
  const folder = join(root, 'probe')
  const folderV2 = join(root, 'probe-v2')
  for (const dir of [folder, folderV2]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(folder, 'background.js'), WORKER)
  writeFileSync(join(folder, 'page.js'), PAGE_SCRIPT)
  for (const page of ['offscreen', 'options', 'popup']) writeFileSync(join(folder, `${page}.html`), PAGE(page))
  writeFileSync(join(folderV2, 'manifest.json'), JSON.stringify(MANIFEST_V2, null, 2))
  writeFileSync(join(folderV2, 'page.js'), PAGE_SCRIPT)
  writeFileSync(join(folderV2, 'background.html'), PAGE('background'))

  const loaded: Array<{ folder: string }> = []
  const load = async (name: string, path: string): Promise<{ id: string } | undefined> => {
    try {
      const info = await engine.loadExtension(profile, path)
      loaded.push({ folder: path })
      check(`the probe extension "${name}" is loaded`, info.name === name, `${path} gave "${info.name}" (${info.id}); Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform} ${process.arch}`)
      return info.name === name ? info : undefined
    } catch (error) {
      check(`the probe extension "${name}" is loaded`, false, `${path}: ${String((error as Error)?.message ?? error)}`)
      return undefined
    }
  }
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes }
  // The console of every page of the probes, read from the pages themselves (the journal below is what the Extensions page shows; these are the lines it was given).
  const rawAll: RawLine[] = []
  /** The probes' ids, known once they are loaded: the console of a page that spoke while its extension was loading is kept all the same, and read by the id afterwards. */
  const ids = new Set<string>()
  const mine = (): RawLine[] => rawAll.filter((line) => ids.has(line.extensionId))
  const firstAddress = new WeakMap<WebContents, string>()
  const heard = new WeakSet<WebContents>()
  const ownerOf = (address: string): { extensionId: string; page: string } | undefined => {
    const match = /^chrome-extension:\/\/([a-p]{32})\/([^?#]*)/.exec(address)
    return match ? { extensionId: match[1]!, page: match[2]! } : undefined
  }
  const listen = (_event: unknown, wc: WebContents): void => {
    if (heard.has(wc)) return
    heard.add(wc)
    wc.on('did-start-navigation', (details: { url: string; isMainFrame: boolean }) => {
      if (details.isMainFrame && ownerOf(details.url) && !firstAddress.has(wc)) firstAddress.set(wc, details.url)
    })
    wc.on('console-message', (event: { message: string; level: string }) => {
      const owner = ownerOf((wc.isDestroyed() ? '' : wc.getURL()) || firstAddress.get(wc) || '')
      if (owner) rawAll.push({ ...owner, level: event.level, message: event.message })
    })
  }
  app.on('web-contents-created', listen)
  for (const wc of allWebContents.getAllWebContents()) listen(null, wc)
  // The journal is filled only while someone watches: the page of the Extensions page does, and so does this. Started before the probes are loaded: the background page of the
  // Manifest V2 probe speaks as soon as it is made.
  const stopWatching = engine.extensionTools.watchConsoles()
  let server: Server | undefined

  try {
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
    const probe = await load(PROBE, folder)
    const probeV2 = await load(PROBE_V2, folderV2)
    if (!probe) return
    ids.add(probe.id)
    if (probeV2) ids.add(probeV2.id)

    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(RPC_PAGE)
    })
    const listening = server
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`

    const pageOf = (id: string, name: string): WebContents | undefined => allWebContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(`chrome-extension://${id}/${name}`))
    const said = (id: string, name: string): boolean => mine().some((line) => line.extensionId === id && line.page === name && line.message.includes(`console-probe ready: /${name}`))

    browser.dispatch({ type: 'tab/open', url: `${base}/rpc` })
    const driverTab = store.get().tabs.at(-1)!
    const wcOfTab = (tabId: string): WebContents | undefined => {
      const number = engine.tabNumberOf(tabId)
      return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
    }
    const driverLoaded = await waitFor(() => wcOfTab(driverTab.id) !== undefined && store.get().tabs.find((t) => t.id === driverTab.id)?.title === 'extconsole-rpc')
    const driver = wcOfTab(driverTab.id)
    check('extconsole: the page that drives the probe loads', driverLoaded && driver !== undefined, driverTab.id)
    if (!driver) return
    const ask = async (message: Record<string, unknown>): Promise<Reply> =>
      Promise.race([driver.executeJavaScript(`window.rpc(${JSON.stringify(probe.id)}, ${JSON.stringify(message)})`) as Promise<Reply>, sleep(15_000).then((): Reply => ({ ok: false, error: 'no answer from the worker within 15 seconds' }))])

    // ---- the pages: each one says its line when it runs ----
    const offscreenAsked = await ask({ type: 'offscreen' })
    const offscreenReady = offscreenAsked.ok && (await waitFor(() => said(probe.id, 'offscreen.html')))
    check('extconsole: the offscreen document of the probe opens and its page is heard (it says its own line)', offscreenReady, JSON.stringify({ asked: offscreenAsked, lines: mine().length }))
    const optionsAsked = await ask({ type: 'options' })
    const optionsReady = optionsAsked.ok && (await waitFor(() => said(probe.id, 'options.html')))
    check('extconsole: the options page of the probe opens in a tab and its page is heard', optionsReady, JSON.stringify({ asked: optionsAsked, lines: mine().length }))
    const popupAsked = await ask({ type: 'popup' })
    const popupReady = popupAsked.ok && (await waitFor(() => said(probe.id, 'popup.html')))
    check('extconsole: the popup of the probe opens and its page is heard', popupReady, JSON.stringify({ asked: popupAsked, lines: mine().length }))
    const backgroundReady = probeV2 !== undefined && (await waitFor(() => said(probeV2.id, 'background.html')))
    check('extconsole: the background page of the Manifest V2 probe is heard', backgroundReady, JSON.stringify({ lines: mine().filter((line) => line.page === 'background.html').length }))
    // What a page says as it starts is said before its own line, and the journal hears a message in the same dispatch as the console read above: no wait is needed here.

    const journal = engine.extensionTools.readJournal({ profileId: profile }).filter((entry) => entry.extensionId !== undefined && ids.has(entry.extensionId))
    const inJournal = (id: string, name: string): boolean => journal.some((entry) => entry.source === 'page' && entry.extensionId === id && entry.message.includes(`console-probe ready: /${name}`))
    check(
      'extconsole: the journal holds the line of each page that opened (it was listening to them: an empty journal proves nothing)',
      (!offscreenReady || inJournal(probe.id, 'offscreen.html')) && (!optionsReady || inJournal(probe.id, 'options.html')) && (!popupReady || inJournal(probe.id, 'popup.html')) && (!backgroundReady || inJournal(probeV2!.id, 'background.html')),
      shown(journal)
    )

    // ---- the pages without isolation really are such ----
    const withoutIsolation = mine().filter((line) => (line.page === 'offscreen.html' || line.page === 'background.html') && LIBRARY_NOTICE.test(line.message)).map((line) => line.page)
    check(
      'extconsole: the offscreen document and the background page of the Manifest V2 probe have no context isolation (the library says so on their console: the checks below prove something)',
      offscreenReady && backgroundReady && withoutIsolation.includes('offscreen.html') && withoutIsolation.includes('background.html'),
      JSON.stringify({ offscreenReady, backgroundReady, lines: mine().filter((line) => LIBRARY_NOTICE.test(line.message)).map((line) => `${line.page}: ${line.message.slice(0, 100)}`) })
    )

    // ---- what must not be there ----
    const noisy = journal.filter((entry) => JOURNAL_NOISE.test(entry.message))
    check('extconsole: the journal of the extensions holds no line of Lucium\'s preloads and none about the context isolation (what the Extensions page shows)', noisy.length === 0, `${noisy.length} such lines of ${journal.length}: ${shown(noisy)}`)
    const noisyRaw = mine().filter((line) => NOISE.test(line.message))
    check('extconsole: the console of the pages themselves holds no line of Lucium\'s preloads (offscreen document, background page, options page, popup)', noisyRaw.length === 0, `${noisyRaw.length} such lines of ${mine().length}: ${JSON.stringify(noisyRaw.map((line) => `${line.page} ${line.level} ${line.message.slice(0, 160)}`))}`)

    // ---- nothing was taken from the pages that have isolation ----
    const options = pageOf(probe.id, 'options.html')
    const mediaBridged = optionsReady && options ? ((await options.executeJavaScript(`!/\\[native code\\]/.test(Function.prototype.toString.call(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get))`)) as boolean) : undefined
    check('extconsole: the options page, which has context isolation, still has the media bridge of Lucium (the volume of a tab)', mediaBridged === true, String(mediaBridged ?? 'the options page did not open'))
  } catch (error) {
    check('extconsole: the checks ran to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    stopWatching()
    app.off('web-contents-created', listen)
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || !ownerOf(wc.getURL())) continue
      const own = BrowserWindow.fromWebContents(wc)
      if (own && own !== ctx.win) own.destroy()
    }
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'settings/update', patch: prior })
    const forget = engine as unknown as { forgetExtensionFolder(path: string): void }
    for (const { folder: path } of loaded) forget.forgetExtensionFolder(path)
    rmSync(root, { recursive: true, force: true })
    server?.close()
    server?.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=extconsole`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runExtConsoleSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeExtConsole(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeExtConsole ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_EXTCONSOLE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
