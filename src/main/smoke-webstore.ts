// Engine checks for installing extensions from the Chrome Web Store, run inside a real Electron against a store that is entirely local.
// Nothing here reaches the Internet: the library's `fetch` is the guard (engine/web-store-network.ts) and the guard sends what it lets
// through to a server of this file, the page of "the store" is served for the store's own origin by a protocol handler of the profile's
// session (so the page really has that origin and the library's page script runs in it), and the packages are built by the test.
// Checked: the page-to-install route end to end (sheet drawn from the downloaded manifest, not from what the page claims), the store's script
// kept to the store's own origin (a look-alike gets nothing), the gate on the library's IPC (no click, setting off), the guard (an icon address
// named by the page, a redirect elsewhere, hostile packages), one extension per profile and the switch per profile (kept, applied at load),
// updates (only when asked, held back when they ask for more), uninstall, the private window and the network audit (nothing leaves without an action).
// Called from the engine smoke test: `await smokeWebStore(ctx, check)`. The installation from the real store is for the user to try by hand.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, Menu, type MenuItem, type Session, type WebContents } from 'electron'
import { STORE_TRUST_THRESHOLD, STORE_VERSION_REPORTED, compareChromium, isStoreHost } from '@shared/web-store'
import { newTestKey, packageOf, testPublisherKeys, type TestEntry } from './engine/crx-test-support'
import { STAGING_DIR, STORE_DIR } from './engine/web-store-files'
import type { SmokeContext } from './smoke'
import { getWindowManager, MAIN_WINDOW_ID, type WindowRecord } from './shell/windows'
import { noteCheck, skippedBecause, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(6000, 80)

/** A promise that must settle: a sheet nobody can answer would otherwise leave the whole run waiting until it is killed. */
function within<T>(promise: Promise<T>, what: string, ms = 25_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

const STORE = 'https://chromewebstore.google.com'
const LOOKALIKE = 'https://chromewebstore.google.com.evil.test'
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx'
// A 1 x 1 PNG: the "icon" the store page names.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const PAGE = `<!doctype html><meta charset="utf-8"><title>Fausse boutique</title><body>
<p id="state">prête</p>
<script>
  window.hasBridge = () => typeof window.electronWebstore === 'object' && window.electronWebstore !== null
  window.bridgeNames = () => ['electronWebstore', 'electronRuntime', 'electronManagement'].filter((name) => name in window)
  window.install = (details) => (window.hasBridge() ? window.electronWebstore.beginInstallWithManifest3(details).then((r) => r, (e) => 'ERR:' + e.message) : Promise.resolve('NO-BRIDGE'))
  window.uninstall = (id) => (window.electronManagement ? new Promise((resolve) => window.electronManagement.uninstall(id, { showConfirmDialog: false }, () => resolve('called'))) : Promise.resolve('NO-BRIDGE'))
  window.statusOf = (id, manifest) => window.electronWebstore.getExtensionStatus(id, manifest)
</script></body>`

interface Served {
  crx: Buffer
  version: string
}

export async function smokeWebStore(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const userData = app.getPath('userData')
  const settings = () => store.get().settings
  const originalSettings = { webStoreInstall: settings().webStoreInstall, webStoreUpdates: settings().webStoreUpdates }
  const originalSpace = store.get().activeSpaceId

  // ---- the local store: the update service, the package host, a picture ----
  const keys = { wide: newTestKey(), calm: newTestKey(), hostile: newTestKey(), old: newTestKey(), traversal: newTestKey(), altered: newTestKey() }
  const manifestOf = (name: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    manifest_version: 3,
    name,
    version,
    description: `Extension d’essai « ${name} »`,
    update_url: UPDATE_URL,
    background: { service_worker: 'background.js' },
    action: { default_title: name },
    ...extra
  })
  const worker: TestEntry = { name: 'background.js', data: "chrome.runtime.onInstalled.addListener((d) => chrome.storage.local.set({ reason: d.reason }))" }
  const wideV = (version: string, extra: Record<string, unknown> = {}) => packageOf({ key: keys.wide, manifest: manifestOf('Outil large', version, { permissions: ['storage', 'alarms', 'history'], host_permissions: ['https://*.example.test/*'], ...extra }), files: [worker] })
  const calmV = (version: string) => packageOf({ key: keys.calm, manifest: manifestOf('Outil calme', version, { permissions: ['storage'] }), files: [worker] })
  const wide1 = wideV('1.0.0')
  const calm1 = calmV('1.0.0')
  const served = new Map<string, Served>([
    [wide1.id, { crx: wide1.crx, version: '1.0.0' }],
    [calm1.id, { crx: calm1.crx, version: '1.0.0' }]
  ])
  const hostile = packageOf({ key: keys.traversal, manifest: manifestOf('Paquet piégé', '1.0.0'), files: [worker, { name: '../../escaped.txt', data: 'x' }] })
  const old = packageOf({ key: keys.old, manifest: { manifest_version: 2, name: 'Ancienne extension', version: '1.0.0', background: { scripts: ['b.js'] } }, files: [{ name: 'b.js', data: '' }] })
  served.set(hostile.id, { crx: hostile.crx, version: '1.0.0' })
  served.set(old.id, { crx: old.crx, version: '1.0.0' })
  // A well-formed package, signed, then changed by one byte of a file on its way: the structure reads, only the signature knows.
  const filler = Buffer.alloc(300, 7)
  const alteredSource = packageOf({ key: keys.altered, manifest: manifestOf('Paquet altéré', '1.0.0'), files: [worker, { name: 'filler.bin', data: filler, method: 0 }] })
  const altered = { id: alteredSource.id, crx: Buffer.from(alteredSource.crx) }
  altered.crx[altered.crx.indexOf(filler) + 10] = altered.crx[altered.crx.indexOf(filler) + 10]! ^ 1
  served.set(altered.id, { crx: altered.crx, version: '1.0.0' })

  const seen: string[] = []
  /** The user agent of every request the local server got: the installer's own requests must carry the application's, Chromium's stack, not Node's. */
  const agents: string[] = []
  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => resolve(body))
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push(`${req.method} ${url.pathname}`)
    agents.push(String(req.headers['user-agent'] ?? ''))
    const idOf = (text: string): string => /[a-p]{32}/.exec(text)?.[0] ?? ''
    if (url.pathname === '/service/update2/crx') {
      const id = idOf(decodeURIComponent(url.searchParams.get('x') ?? ''))
      const entry = served.get(id)
      if (!entry) return void ((res.statusCode = 404), res.end('unknown'))
      // The real service redirects to a blob host: the guard must follow it, and judge the new host.
      res.statusCode = 302
      res.setHeader('location', `https://clients2.googleusercontent.com/crx/blobs/AAAA/${id}_${entry.version.replaceAll('.', '_')}.crx`)
      return void res.end()
    }
    if (url.pathname.startsWith('/crx/blobs/')) {
      const entry = served.get(idOf(url.pathname))
      if (!entry) return void ((res.statusCode = 404), res.end('unknown'))
      res.setHeader('content-type', 'application/x-chrome-extension')
      return void res.end(entry.crx)
    }
    if (url.pathname === '/service/update2/json') {
      void readBody(req).then((body) => {
        const asked = (JSON.parse(body) as { request: { app: Array<{ appid: string }> } }).request.app.map((a) => a.appid)
        const apps = asked.flatMap((appid) => {
          const entry = served.get(appid)
          return entry ? [{ appid, updatecheck: { status: 'ok', manifest: { version: entry.version, packages: { package: [{ name: `${appid}.crx` }] } }, urls: { url: [{ codebase: `https://clients2.googleusercontent.com/crx/blobs/UPD/${appid}_${entry.version.replaceAll('.', '_')}.crx` }] } } }] : []
        })
        res.end(`)]}'\n${JSON.stringify({ response: { app: apps } })}`)
      })
      return
    }
    if (url.pathname.endsWith('.png')) {
      res.setHeader('content-type', 'image/png')
      return void res.end(PNG)
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The library must hold the guard, which sends what it lets through here. Any other route would reach the real network: the picture
  // address named below is one that does not exist (`.invalid`), so a guard that was missing would show as no refusal at all.
  const realFetch = globalThis.fetch
  // No transport is given: the requests leave through the installer's own (Electron's network stack, in the session of the application), as in use.
  // Its packages carry the proof of the publisher of the tests (crx-test-support.ts) where the store's carry Google's: that key stands for it here.
  engine.webStore.useTestNetwork({ rewrite: (url) => new URL(`${url.pathname}${url.search}`, base), publisherKeys: testPublisherKeys() })

  // ---- the "store" pages, for the sessions of the two profiles ----
  const sessions: Session[] = []
  const serveStore = (ses: Session): void => {
    ses.protocol.handle('https', (request) => {
      const host = new URL(request.url).hostname
      return host === 'chromewebstore.google.com' || host === 'chromewebstore.google.com.evil.test' || host === 'ordinary.example.test' ? new Response(PAGE, { headers: { 'content-type': 'text/html' } }) : new Response('not here', { status: 404 })
    })
    sessions.push(ses)
  }

  const notices: string[] = []
  engine.onExtensionNotice((message) => notices.push(message))
  const menuActions: string[] = []
  engine.onExtensionMenu((action, profileId, extensionId) => menuActions.push(`${action}:${profileId}:${extensionId}`))
  const confirms: Array<{ message: string; detail: string }> = []
  // The window's own confirmation box is native: the check answers in its place and keeps what it would have shown.
  const actions = browser.extensionControl as unknown as { env: { confirm: (o: { message: string; detail: string; ok: string }) => Promise<boolean> } }
  const realConfirm = actions.env.confirm
  let confirmAnswer = true
  actions.env.confirm = async (options) => (confirms.push({ message: options.message, detail: options.detail }), confirmAnswer)

  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    realWarn(...args)
  }

  const tabs: string[] = []
  const wcOf = (tabId: string): WebContents => (browser.pageFor(tabId) as unknown as { webContents: WebContents }).webContents
  const openAt = async (url: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = store.get().tabs.at(-1)!
    tabs.push(tab.id)
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false && browser.pageFor(tab.id) !== undefined)
    return { id: tab.id, wc: wcOf(tab.id) }
  }
  const gesture = (): void => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
  const installFrom = (wc: WebContents, id: string, extra: Record<string, unknown> = {}): Promise<string> => {
    gesture()
    const details = { id, manifest: JSON.stringify({ manifest_version: 3, name: 'Ce que la page prétend', version: '9.9.9', permissions: [] }), iconUrl: 'https://lh3.googleusercontent.com/icon.png', localizedName: 'Ce que la page prétend', ...extra }
    return within(wc.executeJavaScript(`window.install(${JSON.stringify(details)})`) as Promise<string>, `the install of ${id}`)
  }
  const button = (profileId: string, id: string): Promise<boolean> =>
    win.webContents.executeJavaScript(`(() => { const list = [...document.querySelectorAll('browser-action-list')].find((l) => l.getAttribute('partition') === 'persist:profile-${profileId}'); return !!list?.shadowRoot?.getElementById(${JSON.stringify(id)}) })()`) as Promise<boolean>
  /** With LUCIUM_SMOKE_SHOTS=<folder>, saves a picture of a surface for the eye (never read back by the checks). */
  const shot = async (name: string, contents: WebContents): Promise<void> => {
    const folder = process.env['LUCIUM_SMOKE_SHOTS']
    if (!folder) return
    const image = await contents.capturePage()
    writeFileSync(join(folder, `webstore-${name}.png`), image.toPNG())
  }
  const toolbars = (): Promise<string> =>
    win.webContents.executeJavaScript(`JSON.stringify([...document.querySelectorAll('browser-action-list')].map((l) => ({ partition: l.getAttribute('partition'), ids: [...(l.shadowRoot?.querySelectorAll('[id]') ?? [])].map((e) => e.id).filter((id) => id.length === 32) })))`) as Promise<string>
  const sheetText = (): Promise<{ title: string; items: string[]; focus: string; warning: string; foot: string }> =>
    overlayView.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('.adlg-ext .adlg-title')?.textContent ?? '',
      items: [...document.querySelectorAll('.ext-list li')].map((li) => li.textContent ?? ''),
      focus: document.activeElement?.textContent ?? '',
      warning: document.querySelector('.ext-warning')?.textContent ?? '',
      foot: document.querySelector('.ext-foot')?.textContent ?? ''
    }))()`) as Promise<{ title: string; items: string[]; focus: string; warning: string; foot: string }>
  const clickSheet = (label: string): Promise<boolean> =>
    overlayView.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.adlg-ext .adlg-btn')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); b?.click(); return !!b })()`) as Promise<boolean>
  const askedForReview = async (): Promise<boolean> => {
    const shown = await waitFor(() => browser.currentPanel() === 'extreview', 15_000)
    if (!shown) console.log(`[smoke-webstore] no sheet: notices=${JSON.stringify(notices.slice(-3))} warnings=${JSON.stringify(warnings.slice(-3))}`)
    // The panel is chosen in the main process before its page draws the sheet: a read at once finds it empty on a slow machine (the runner of the Smoke workflow
    // read `title: ""` here). The sheet is waited for; one that never comes is read as it is, and the checks say what they found.
    else await waitFor(async () => (await sheetText()).title !== '', 5000)
    return shown
  }
  const infoOf = (profileId: string, id: string) => engine.listAllExtensions().find((e) => e.profileId === profileId && e.id === id)
  const storeDir = (profileId: string, id: string) => join(userData, STORE_DIR, profileId, id)
  const requestsNow = () => engine.webStore.requests.length

  let spaceB: string | undefined
  try {
    // ---- 0. nothing has gone out yet, whatever the setting says ----
    check('web store: the setting is on by default, the updates are manual, and no request to Google has been made so far', originalSettings.webStoreInstall === true && originalSettings.webStoreUpdates === 'manual' && requestsNow() === 0, JSON.stringify({ ...originalSettings, requests: requestsNow() }))
    browser.dispatch({ type: 'settings/update', patch: { webStoreInstall: true, webStoreUpdates: 'manual' } })

    // The store of this check is served by protocol.handle. An extension with request rules (declarativeNetRequest, webRequest) makes Chromium proxy
    // every request of its session, and the proxy skips that handler: the page then comes from the real store (a request to Google, and no bridge).
    // So the suite does not run next to the extensions of LUCIUM_EXTENSIONS (which the whole `test:engine` loads); `pnpm test:engine:webstore` runs it alone.
    const loadedByTheRun = engine.listAllExtensions().filter((e) => e.source !== 'store' && e.enabled)
    if (loadedByTheRun.length > 0) {
      console.log(`[smoke-webstore] NOT RUN next to ${loadedByTheRun.length} extension(s) loaded by the run: use LUCIUM_SMOKE_ONLY=webstore without LUCIUM_EXTENSIONS (pnpm test:engine:webstore)`)
      check('web store: the sheet, the gate, the guard, the profiles, the updates and the uninstall', true, skippedBecause(`${loadedByTheRun.length} extension(s) loaded by the run would send the store pages to the real store: pnpm test:engine:webstore runs the suite alone`))
      return
    }

    const profileA = store.get().spaces.find((s) => s.id === originalSpace)?.profileId ?? 'default'
    browser.dispatch({ type: 'space/create', name: 'Boutique B', emoji: '🧪', hue: 200, profileId: 'wsb' })
    spaceB = store.get().activeSpaceId
    browser.dispatch({ type: 'space/select', id: originalSpace })
    // Both sessions exist once a page is made in each: the store page is served in both.
    const pageA = await openAt('about:blank')
    serveStore(pageA.wc.session)
    browser.dispatch({ type: 'space/select', id: spaceB })
    const pageB = await openAt('about:blank')
    serveStore(pageB.wc.session)
    browser.dispatch({ type: 'space/select', id: originalSpace })

    // ---- 1. the page of the store gets the bridge; a look-alike address does not: the library's own script looks at the start of the address
    // alone, so the store's script is registered for the store's own origin only. The gate behind it still refuses such an origin (web-store.test.ts). ----
    const real = await openAt(`${STORE}/detail/outil/${wide1.id}`)
    check('web store: the page of the store gets the library\'s bridge (its page script runs there, from the unpacked path)', await real.wc.executeJavaScript('window.hasBridge()') === true)
    const fake = await openAt(`${LOOKALIKE}/detail/outil`)
    const lookalikeBridge = (await fake.wc.executeJavaScript('window.bridgeNames()')) as string[]
    const told = (await real.wc.executeJavaScript('window.electronWebstore.getFullChromeVersion()')) as { version_number?: string }
    check(
      'store version: the page of the store is told the last version before the one at which its server\'s verdict decides (so that its own user-agent check does), not the real Chromium version; the real one is still above the threshold',
      told.version_number === STORE_VERSION_REPORTED && compareChromium(process.versions.chrome, STORE_TRUST_THRESHOLD) >= 0,
      JSON.stringify({ told, real: process.versions.chrome })
    )
    const sheetsBefore = browser.currentPanel()
    // Without the bridge the page's call reaches nothing of the main process: there is no late effect to wait for.
    const lookalike = await installFrom(fake.wc, wide1.id)
    const unlimited = warnings.filter((w) => w.includes('could not be limited to the pages of the store'))
    check('web store: a look-alike host (chromewebstore.google.com.evil.test) gets none of the library\'s objects (the store\'s script runs in the store\'s own pages only), so it cannot install anything: no sheet, no download, nothing on disk', lookalikeBridge.length === 0 && unlimited.length === 0 && lookalike === 'NO-BRIDGE' && sheetsBefore === null && browser.currentPanel() === null && requestsNow() === 0 && !infoOf(profileA, wide1.id) && !existsSync(storeDir(profileA, wide1.id)), JSON.stringify({ lookalikeBridge, unlimited, lookalike, panel: browser.currentPanel(), requests: requestsNow() }))
    const lookalikeUninstall = (await fake.wc.executeJavaScript(`window.uninstall(${JSON.stringify(wide1.id)})`)) as string
    check('web store: a look-alike host cannot ask for an uninstall either: it has nothing to ask with, and the shell is not asked', lookalikeUninstall === 'NO-BRIDGE' && menuActions.length === 0, JSON.stringify({ lookalikeUninstall, menuActions }))

    // ---- 2. the page cannot make the installer fetch an address of its choice (an icon at a host that is not Google's) ----
    const refusedBefore = engine.webStore.refused.length
    const icon = await installFrom(real.wc, wide1.id, { iconUrl: 'https://nonexistent.invalid/icon.png' })
    check('web store: an icon address that is not Google\'s is refused by the guard before any request, and nothing is asked of the user', icon === 'icon_error' && engine.webStore.refused.slice(refusedBefore).includes('nonexistent.invalid') && browser.currentPanel() === null && requestsNow() === 0, JSON.stringify({ icon, refused: engine.webStore.refused.slice(refusedBefore), requests: requestsNow() }))

    // ---- 3. no click just before: refused ----
    ;(engine as unknown as { lastUserInput: number }).lastUserInput = 0
    const noClick = (await real.wc.executeJavaScript(`window.install(${JSON.stringify({ id: wide1.id, manifest: '{}', iconUrl: 'https://lh3.googleusercontent.com/icon.png', localizedName: 'x' })})`)) as string
    check('web store: a call that no click or key press of the user just preceded is refused', noClick.startsWith('ERR:') && browser.currentPanel() === null && requestsNow() === 0 && warnings.some((w) => w.includes('no click or key press just before')), noClick)

    // A click that a debugger sends to the page is not the user's: while one is attached, the input of the page is not a gesture; the same input without it is.
    ;(engine as unknown as { lastUserInput: number }).lastUserInput = 0
    real.wc.debugger.attach('1.3')
    real.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
    await sleep(300)
    const whileDebugged = (engine as unknown as { lastUserInput: number }).lastUserInput
    real.wc.debugger.detach()
    real.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
    await waitFor(() => (engine as unknown as { lastUserInput: number }).lastUserInput > 0, 2000)
    const afterDebugged = (engine as unknown as { lastUserInput: number }).lastUserInput
    check('web store: input that reaches a page while a debugger is attached to it is not the user\'s gesture, and the same input is once the debugger is gone', whileDebugged === 0 && afterDebugged > 0, JSON.stringify({ whileDebugged, afterDebugged }))
    ;(engine as unknown as { lastUserInput: number }).lastUserInput = 0

    // ---- 4. the sheet shows the manifest of the package that was downloaded, not what the page claims; refusing leaves nothing ----
    const answering = installFrom(real.wc, wide1.id)
    const shown = await askedForReview()
    check('web store: the install opens the sheet over the window of the page', shown)
    // Nothing after this means anything without the sheet: stop here, with the context in the log.
    if (!shown) return
    const ask = browser.currentOverlay() as { panel: string; request: { review: { name: string; version: string; broad: boolean; permissions: Array<{ id: string; level: string }>; sites: { scope: string; line: string } }; profile: string; mode: string } }
    const sheet = await sheetText()
    await shot('sheet-wide', overlayView.webContents)
    check(
      'web store: the sheet is drawn from the real package (its name, its permissions with the wide ones first), not from the page\'s claim of "no permission"',
      ask.request.review.name === 'Outil large' && ask.request.review.version === '1.0.0' && ask.request.review.permissions.map((p) => p.id).join() === 'history,alarms,storage' && ask.request.review.broad && sheet.title === frenchSpaces('Ajouter « Outil large » à Lucium ?') && sheet.items[0]!.startsWith(frenchSpaces('Lire et modifier vos données sur : example.test')) && sheet.items[1]!.includes('Lire et modifier votre historique de navigation') && sheet.items[1]!.includes('Accès étendu'),
      JSON.stringify({ ask: ask.request.review.permissions, sheet })
    )
    check('web store: the sheet says which profile it goes to and that the others are not touched; the focus is on "Annuler" because the access is wide', sheet.foot.includes(frenchSpaces('profil « Profil par défaut » seulement')) && sheet.foot.includes('vos autres profils') && sheet.focus.startsWith('Annuler') && sheet.warning !== '', JSON.stringify(sheet))
    check('web store: the package waits in a staging folder, not in the profile', readdirSync(join(userData, STAGING_DIR, profileA)).includes(wide1.id) && !existsSync(storeDir(profileA, wide1.id)))
    // The interface is not trusted: an answer for a sheet that is not on screen does nothing, the interface cannot open the sheet itself,
    // and an uninstall asked with ids that are not ids is not even put to the user.
    await overlayView.webContents.executeJavaScript(`window.lucium.answerExtensionReview('extrev-999', true)`)
    await overlayView.webContents.executeJavaScript(`window.lucium.extensionUninstall('../x', 'not-an-id')`)
    await overlayView.webContents.executeJavaScript(`window.lucium.extensionUninstall('default', 'zzzz')`)
    // The witness: those are messages without an answer; a question asked after them on the same channel is answered only once the main process
    // has handled them.
    await overlayView.webContents.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
    check('web store: from the interface, an answer for another sheet, an uninstall with ids that are not ids: nothing happens (not even a notice)', browser.currentPanel() === 'extreview' && confirms.length === 0 && !infoOf(profileA, wide1.id) && !(browser.snapshot().toast?.message ?? '').includes('pas installée'), browser.snapshot().toast?.message)
    await clickSheet('Annuler')
    // No wait after it: the page is answered once the shell has refused and cleared the staging folder (web-store.ts, `beforeInstall`).
    const refused = await answering
    check('web store: "Annuler" refuses: the page is told, the staging folder is gone, nothing is installed', refused === 'user_cancelled' && !infoOf(profileA, wide1.id) && !existsSync(join(userData, STAGING_DIR, profileA, wide1.id)) && !existsSync(storeDir(profileA, wide1.id)) && browser.currentPanel() === null, refused)

    browser.closeOverlay()
    await sleep(100)
    await overlayView.webContents.executeJavaScript(`window.lucium.openOverlay({ panel: 'extreview', request: { id: 'extrev-1', mode: 'install', extensionId: ${JSON.stringify(wide1.id)}, profile: 'x', review: { name: 'x', version: '1', description: '', permissions: [], sites: { scope: 'none', line: '', patterns: [], count: 0, files: false }, optionalCount: 0, broad: false, warning: '' } } })`)
    // The witness: a question asked after the message on the same channel, answered once the main process has handled it.
    await overlayView.webContents.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
    check('web store: the interface cannot open the extension sheet by itself', browser.currentPanel() === null)

    // ---- 5. closing the sheet without answering refuses too ----
    const second = installFrom(real.wc, wide1.id)
    await askedForReview()
    browser.closeOverlay()
    check('web store: closing the sheet (Escape, a click outside) is a refusal', (await second) === 'user_cancelled' && !infoOf(profileA, wide1.id))

    // ---- 6. accepting installs it in this profile: loaded, in the toolbar, on disk, its worker told it was installed ----
    const accepted = installFrom(real.wc, wide1.id)
    await askedForReview()
    const answerCheck = await clickSheet('Ajouter')
    const outcome = await accepted
    check('web store: "Ajouter" installs: the page is told it worked, the extension is loaded in this profile as a store extension', answerCheck && outcome === 'success' && infoOf(profileA, wide1.id)?.source === 'store' && infoOf(profileA, wide1.id)?.enabled === true && infoOf(profileA, wide1.id)?.name === 'Outil large', JSON.stringify({ outcome, info: infoOf(profileA, wide1.id) }))
    check('web store: it is on disk in the profile\'s own folder', existsSync(join(storeDir(profileA, wide1.id), '1.0.0_0', 'manifest.json')))
    check('web store: its icon appears in the toolbar of the profile', await waitFor(() => button(profileA, wide1.id)), `partition persist:profile-${profileA}`)
    check('web store: its service worker is started and told it was installed', await waitFor(() => engine.runningExtensionWorkers().some((scope) => scope.includes(wide1.id)), 8000))
    check('web store: only Google\'s hosts were contacted, through the guard, and the package came by the redirect to the blob host', engine.webStore.requests.length > 0 && engine.webStore.requests.every((r) => isStoreHost(r.host)) && engine.webStore.requests.some((r) => r.host === 'clients2.googleusercontent.com' && r.path.startsWith('/crx/blobs/')), JSON.stringify(engine.webStore.requests.map((r) => `${r.host}${r.path}`)))

    // ---- 7. an extension of one profile does not run in the others ----
    check('web store: it is installed in that profile only (the other profile does not list it, nor does its toolbar)', !infoOf('wsb', wide1.id) && !engine.listExtensions().some((e) => e.profileId === 'wsb' && e.id === wide1.id))
    browser.dispatch({ type: 'space/select', id: spaceB })
    check('web store: the toolbar of the other profile has no icon for it', await waitFor(async () => !(await button('wsb', wide1.id)), 4000) && !(await button('wsb', wide1.id)), await toolbars())
    browser.dispatch({ type: 'space/select', id: originalSpace })
    const beforeAgain = requestsNow()
    const again = await installFrom(real.wc, wide1.id)
    check('web store: asking for it again in the profile that has it is refused by the library itself, without a sheet or a download', again === 'unknown_error' && browser.currentPanel() === null && requestsNow() === beforeAgain, JSON.stringify({ again, requests: requestsNow() - beforeAgain }))

    // ---- 8. a calm extension: the sheet has no warning, and the focus is on the confirm button ----
    const calmInstall = installFrom(real.wc, calm1.id)
    await askedForReview()
    const calmSheet = await sheetText()
    await shot('sheet-calm', overlayView.webContents)
    check('web store: an extension that asks for little shows no warning, lists its one permission and puts the focus on "Ajouter"', calmSheet.warning === '' && calmSheet.items.length === 1 && calmSheet.items[0]!.includes('Enregistrer ses propres données') && calmSheet.focus.startsWith('Ajouter'), JSON.stringify(calmSheet))
    await clickSheet('Annuler')
    await calmInstall

    // ---- 9. hostile packages: refused with a sentence, nothing unpacked outside ----
    const traversal = await installFrom(real.wc, hostile.id)
    check('web store: a package with a path that leaves its folder is refused, no sheet, nothing written outside the staging folder', traversal === 'user_cancelled' && browser.currentPanel() === null && !existsSync(join(userData, STAGING_DIR, 'escaped.txt')) && !existsSync(join(userData, 'escaped.txt')) && notices.some((n) => n.includes('L’installation a échoué')) && !infoOf(profileA, hostile.id), JSON.stringify({ traversal, notices: notices.slice(-2) }))
    const changed = await installFrom(real.wc, altered.id)
    check('web store: a package changed after it was signed is refused with the reason, no sheet, nothing installed', changed === 'user_cancelled' && browser.currentPanel() === null && notices.slice(-3).some((n) => n.includes('L’installation a échoué') && n.includes('signature')) && !infoOf(profileA, altered.id), JSON.stringify({ changed, notices: notices.slice(-2) }))
    const manifestV2 = await installFrom(real.wc, old.id)
    check('web store: a Manifest V2 package is refused with the sentence that says why', manifestV2 === 'user_cancelled' && notices.some((n) => n.includes('Manifest V2')) && !infoOf(profileA, old.id), JSON.stringify(notices.slice(-2)))

    // ---- 10. the switch per profile ----
    const state = () => store.get().settings.profiles[profileA]?.disabledExtensions
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: wide1.id, enabled: false })
    check('profile switch: switching it off in the profile takes it out of that profile\'s session, keeps it on disk and in the list (switched off)', await waitFor(() => infoOf(profileA, wide1.id)?.enabled === false) && !engine.listExtensions().some((e) => e.profileId === profileA && e.id === wide1.id) && existsSync(storeDir(profileA, wide1.id)) && state()?.join() === wide1.id, JSON.stringify(infoOf(profileA, wide1.id)))
    check('profile switch: its toolbar icon goes', await waitFor(async () => !(await button(profileA, wide1.id)), 4000))
    const whileOff = await installFrom(real.wc, wide1.id)
    check('profile switch: the store does not install it again over the switched-off copy', whileOff === 'user_cancelled' && notices.some((n) => n.includes('désactivée')))
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: wide1.id, enabled: true })
    check('profile switch: switching it on loads it again, and the state forgets the switch', (await waitFor(() => infoOf(profileA, wide1.id)?.enabled === true)) && (await waitFor(() => button(profileA, wide1.id))) && state() === undefined)

    // Applied at load: a profile that starts with the extension switched off does not load it (the engine loads stored extensions when a profile is created).
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: wide1.id, enabled: false })
    await waitFor(() => infoOf(profileA, wide1.id)?.enabled === false)
    const loadEvents: string[] = []
    const ses = real.wc.session
    const onLoaded = (_e: unknown, extension: { id: string }): void => void loadEvents.push(extension.id)
    ses.extensions.on('extension-loaded', onLoaded)
    const privates = engine as unknown as { loaded: Map<string, unknown>; known: Map<string, unknown>; loadFirst: (profileId: string, ses: Session, path: string, id: string | undefined) => Promise<void> }
    privates.known.delete(`${profileA}:${wide1.id}`)
    const stored = await engine.webStore.stored(profileA)
    // No wait after it: each load is awaited, and a load that happens says so (extension-loaded) before its promise ends.
    for (const entry of stored) await privates.loadFirst(profileA, ses, entry.path, entry.id)
    ses.extensions.off('extension-loaded', onLoaded)
    check('profile switch: at load, an extension switched off in the profile is not loaded (no load event), and is listed as switched off', stored.some((e) => e.id === wide1.id) && !loadEvents.includes(wide1.id) && infoOf(profileA, wide1.id)?.enabled === false && !privates.loaded.has(`${profileA}:${wide1.id}`), JSON.stringify({ loadEvents, info: infoOf(profileA, wide1.id) }))
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: wide1.id, enabled: true })
    await waitFor(() => infoOf(profileA, wide1.id)?.enabled === true)

    // ---- 11. updates: nothing by itself, then on request; one that asks for more is held back ----
    const idleRequests = requestsNow()
    // A fixed wait, for want of a witness: what is checked is that time passes with nothing asked, and nothing comes to say that it will not be.
    await sleep(1200)
    check('updates: in manual mode nothing is scheduled and nothing is asked of Google by itself', !engine.webStore.isScheduled() && requestsNow() === idleRequests)
    served.set(wide1.id, { crx: wideV('1.1.0').crx, version: '1.1.0' })
    const toBefore = requestsNow()
    const report = await within(engine.checkExtensionUpdates(), 'the update check')
    check('updates: asked for, the check updates an extension that asks for nothing more, silently', report.updated.join() === 'Outil large' && report.waiting.length === 0 && report.failed === null && infoOf(profileA, wide1.id)?.version === '1.1.0' && requestsNow() > toBefore, JSON.stringify(report))
    check('updates: the old version\'s folder is gone, the new one is in place', existsSync(join(storeDir(profileA, wide1.id), '1.1.0_0', 'manifest.json')) && !existsSync(join(storeDir(profileA, wide1.id), '1.0.0_0')), readdirSync(storeDir(profileA, wide1.id)).join())
    served.set(wide1.id, { crx: wideV('2.0.0', { permissions: ['storage', 'alarms', 'history', 'tabs', 'debugger'], host_permissions: ['<all_urls>'] }).crx, version: '2.0.0' })
    const held = await within(engine.checkExtensionUpdates(), 'the second update check')
    check('updates: one that asks for more is held back: not applied, reported as waiting, listed with its version', held.updated.length === 0 && held.waiting.join() === 'Outil large' && infoOf(profileA, wide1.id)?.version === '1.1.0' && infoOf(profileA, wide1.id)?.update?.version === '2.0.0' && browser.currentPanel() === null, JSON.stringify({ held, info: infoOf(profileA, wide1.id) }))
    const reviewing = within(engine.reviewExtensionUpdate(profileA, wide1.id), 'the review of the update')
    await askedForReview()
    const updateSheet = await sheetText()
    await shot('sheet-update', overlayView.webContents)
    check('updates: the sheet of the held-back update lists only what is new, wide access first, and says it is an update', updateSheet.title === frenchSpaces('Mettre à jour « Outil large » ?') && updateSheet.items.length === 3 && updateSheet.items[0]!.includes('tous les sites web') && updateSheet.items.some((i) => i.includes('Piloter le débogueur')) && updateSheet.items.some((i) => i.includes('Voir l’adresse et le titre de tous vos onglets')) && !updateSheet.items.some((i) => i.includes('historique')) && updateSheet.warning.includes('plus larges'), JSON.stringify(updateSheet))
    await clickSheet('Annuler')
    check('updates: refusing leaves the installed version in place, still waiting', (await reviewing) === 'declined' && infoOf(profileA, wide1.id)?.version === '1.1.0' && infoOf(profileA, wide1.id)?.update?.version === '2.0.0')
    const accepting = within(engine.reviewExtensionUpdate(profileA, wide1.id), 'the accepted update')
    await askedForReview()
    await clickSheet('Mettre à jour')
    check('updates: accepting applies it, and nothing waits any more', (await accepting) === 'updated' && infoOf(profileA, wide1.id)?.version === '2.0.0' && infoOf(profileA, wide1.id)?.update === undefined && !existsSync(join(storeDir(profileA, wide1.id), '1.1.0_0')))

    // ---- 12. the schedule: only with a setting, only when due ----
    browser.dispatch({ type: 'settings/update', patch: { webStoreUpdates: 'daily' } })
    await sleep(200)
    const ledger = (engine as unknown as { extensionLedger(): { recordUpdateCheck(at: number): void; lastUpdateCheck(): number | undefined } }).extensionLedger()
    ledger.recordUpdateCheck(Date.now())
    const beforeSchedule = requestsNow()
    const notDue = await engine.webStore.checkIfDue()
    ledger.recordUpdateCheck(Date.now() - 2 * 24 * 3_600_000)
    const due = await engine.webStore.checkIfDue()
    browser.dispatch({ type: 'settings/update', patch: { webStoreUpdates: 'manual' } })
    await sleep(200)
    const afterManual = requestsNow()
    ledger.recordUpdateCheck(1)
    const manualDue = await engine.webStore.checkIfDue()
    check('updates: daily mode schedules a check, runs it only when the last one is old enough, and stays silent but for news', engine.webStore.isScheduled() === false /* back to manual */ && notDue === null && due !== null && due.failed === null && requestsNow() > beforeSchedule, JSON.stringify({ notDue, due }))
    check('updates: back to manual, nothing is scheduled and an old check date does not make it run', manualDue === null && requestsNow() === afterManual && !engine.webStore.isScheduled())

    // ---- 13. uninstall from the menu of the icon (confirmation first), and from the store page ----
    confirmAnswer = false
    const cancelled = await browser.extensionControl!.uninstall(profileA, calm1.id)
    check('uninstall: an extension that is not installed is not uninstalled, and a "no" in the box leaves it', cancelled === 'failed' && !infoOf(profileA, calm1.id))
    const fromPage = await real.wc.executeJavaScript(`window.uninstall(${JSON.stringify(wide1.id)})`)
    // The witness: the shell asked to confirm, which comes before any removal.
    const askedToConfirm = await waitFor(() => menuActions.includes(`uninstall:${profileA}:${wide1.id}`))
    check('uninstall: the store page\'s "remove" does not remove anything by itself: the shell is asked to confirm', fromPage === 'called' && askedToConfirm && infoOf(profileA, wide1.id) !== undefined)
    const declined = await browser.extensionControl!.uninstall(profileA, wide1.id)
    check('uninstall: the box names the extension and the profile; "Annuler" keeps it', declined === 'cancelled' && confirms.at(-1)?.message === frenchSpaces('Désinstaller « Outil large » ?') && confirms.at(-1)?.detail.includes('Profil par défaut') === true && infoOf(profileA, wide1.id) !== undefined)
    confirmAnswer = true
    const done = await browser.extensionControl!.uninstall(profileA, wide1.id)
    check('uninstall: confirmed, it goes from the profile: unloaded, files deleted, toolbar icon gone', done === 'uninstalled' && !infoOf(profileA, wide1.id) && !existsSync(storeDir(profileA, wide1.id)) && (await waitFor(async () => !(await button(profileA, wide1.id)), 4000)))
    const reinstall = installFrom(real.wc, wide1.id)
    check('uninstall: once removed it can be installed again as new (the sheet opens)', await askedForReview())
    await clickSheet('Annuler')
    await reinstall

    // ---- 14. the setting off: the page gets no bridge, installs nothing, and what is installed stays ----
    const calmAgain = installFrom(real.wc, calm1.id)
    await askedForReview()
    await clickSheet('Ajouter')
    await calmAgain
    check('setting: a second extension is installed for the check that follows', infoOf(profileA, calm1.id)?.enabled === true)
    // The Settings window with the extension list (a picture for the eye).
    if (process.env['LUCIUM_SMOKE_SHOTS']) {
      browser.openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensions' })
      await sleep(1500)
      const settingsWindow = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))
      if (settingsWindow) {
        await settingsWindow.webContents.executeJavaScript(`document.querySelector('[aria-label="Mises à jour des extensions du Web Store"]')?.scrollIntoView({ block: 'start' })`)
        await sleep(300)
        await shot('settings', settingsWindow.webContents)
        settingsWindow.close()
      }
    }

    // The library would look for updates by itself (at launch, when the application is activated, every five hours) and load every extension
    // folder it finds, the switched-off ones too: both are off, which shows in what it registers when the store is switched on again.
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: calm1.id, enabled: false })
    await waitFor(() => infoOf(profileA, calm1.id)?.enabled === false)
    const activations = app.listenerCount('did-become-active')
    browser.dispatch({ type: 'settings/update', patch: { webStoreInstall: false } })
    await sleep(300)
    const closed = await openAt(`${STORE}/detail/outil`)
    const closedBridge = (await closed.wc.executeJavaScript('window.hasBridge()')) as boolean
    const closedInstall = await installFrom(closed.wc, wide1.id)
    const closedMenu = (findMenuItem('Ouvrir le Chrome Web Store') as MenuItem | undefined)
    const tabsBefore = store.get().tabs.length
    browser.openWebStore()
    check('setting: switched off, the store\'s page gets no bridge and installs nothing; the entries to open the store are greyed out or do nothing; what was installed stays', !closedBridge && closedInstall === 'NO-BRIDGE' && browser.currentPanel() === null && infoOf(profileA, calm1.id)?.source === 'store' && store.get().tabs.length === tabsBefore && (closedMenu === undefined || closedMenu.enabled === false), JSON.stringify({ closedBridge, closedInstall, menu: closedMenu?.enabled }))
    const updatesOff = await engine.checkExtensionUpdates()
    check('setting: switched off, an update check does nothing and says why', updatesOff.failed?.includes('désactivé') === true)
    browser.dispatch({ type: 'settings/update', patch: { webStoreInstall: true } })
    // A fixed wait, for want of a witness: the setup of the library that switching on starts has no end the shell can see, and an update
    // check of its own would be registered somewhere in it.
    await sleep(1200)
    check('setting: switched on again, the library registers no update check of its own and loads nothing by itself (the extension switched off in this profile stays off)', app.listenerCount('did-become-active') === activations && infoOf(profileA, calm1.id)?.enabled === false, JSON.stringify({ listeners: app.listenerCount('did-become-active'), before: activations, info: infoOf(profileA, calm1.id) }))
    browser.dispatch({ type: 'extension/set-enabled', profileId: profileA, extensionId: calm1.id, enabled: true })
    const reopened = await openAt(`${STORE}/detail/outil`)
    check('setting: switched on again, the bridge is back for a new page, and the entry of the menu works', (await reopened.wc.executeJavaScript('window.hasBridge()')) === true && findMenuItem('Ouvrir le Chrome Web Store')?.enabled === true)
    const tabsOpen = store.get().tabs.length
    browser.openWebStore()
    check('setting: "Ouvrir le Chrome Web Store" opens the store in a tab', store.get().tabs.length === tabsOpen + 1 && store.get().tabs.at(-1)?.url === `${STORE}/`)
    tabs.push(store.get().tabs.at(-1)!.id)

    // ---- 15. a private window: no extension, no bridge, no entry ----
    const priv = getWindowManager().openPrivate()
    try {
      priv.browser.dispatch({ type: 'tab/open', url: 'about:blank' })
      const blank = priv.store.get().tabs.at(-1)!
      await waitFor(() => priv.browser.pageFor(blank.id) !== undefined)
      const privateContents = (priv.browser.pageFor(blank.id) as unknown as { webContents: WebContents }).webContents
      privateContents.session.protocol.handle('https', () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))
      priv.browser.dispatch({ type: 'tab/open', url: `${STORE}/detail/outil` })
      const storeTab = priv.store.get().tabs.at(-1)!
      await waitFor(() => priv.browser.snapshot().runtime.tabs[storeTab.id]?.loading === false && priv.browser.pageFor(storeTab.id) !== undefined)
      const storeContents = (priv.browser.pageFor(storeTab.id) as unknown as { webContents: WebContents }).webContents
      const privateBridge = (await storeContents.executeJavaScript('window.hasBridge()')) as boolean
      priv.browser.openWebStore()
      check(
        'private window: a page of the store gets no bridge, the window lists no extension, "Ouvrir le Chrome Web Store" opens nothing there',
        !privateBridge && priv.browser.snapshot().extensions.length === 0 && priv.store.get().tabs.length === 2,
        JSON.stringify({ privateBridge, extensions: priv.browser.snapshot().extensions.length, tabs: priv.store.get().tabs.length })
      )
    } finally {
      priv.win.close()
    }

    // ---- 15b. three profiles in three windows: a store extension appears in the windows of its profile only, and leaves one profile without touching the others ----
    const manager3 = getWindowManager()
    const extraWindows: WindowRecord[] = []
    let spaceC: string | undefined
    try {
      const iconsIn = (rec: WindowRecord): Promise<string[]> => rec.win.webContents.executeJavaScript(`[...document.querySelectorAll('browser-action-list')].flatMap((l) => [...(l.shadowRoot?.querySelectorAll('.action') ?? [])].map((e) => e.id)).sort()`) as Promise<string[]>
      const idsOf = (profileId: string): string[] => engine.listExtensions().filter((e) => e.profileId === profileId && e.source === 'store').map((e) => e.id).sort()
      const showsIcons = (rec: WindowRecord, expected: string[]): Promise<boolean> => waitFor(async () => JSON.stringify(await iconsIn(rec)) === JSON.stringify(expected), 8000)
      // The calm one is already in the first profile (step 14). It goes into the second one too, and the wide one into the second only: from the store page of that profile, in the main window.
      browser.dispatch({ type: 'space/select', id: spaceB })
      const storeB = await openAt(`${STORE}/detail/outil/${calm1.id}`)
      for (const id of [calm1.id, wide1.id]) {
        const installing = installFrom(storeB.wc, id)
        await askedForReview()
        await clickSheet('Ajouter')
        await installing
      }
      browser.dispatch({ type: 'space/select', id: originalSpace })
      browser.dispatch({ type: 'space/create', name: 'Boutique C', emoji: '🧪', hue: 120, profileId: 'wsc' })
      spaceC = store.get().activeSpaceId
      browser.dispatch({ type: 'space/select', id: originalSpace })
      const windowOn = async (space: string): Promise<WindowRecord> => {
        const rec = manager3.openWindow({ commandBar: false })
        extraWindows.push(rec)
        rec.browser.dispatch({ type: 'space/select', id: space })
        rec.browser.dispatch({ type: 'tab/open', url: 'about:blank' })
        const tab = rec.store.get().tabs.at(-1)!
        tabs.push(tab.id)
        await waitFor(() => rec.browser.ownsPage(tab.id) && !rec.win.webContents.isLoading(), 10_000)
        return rec
      }
      const windowA = manager3.list().find((r) => r.id === MAIN_WINDOW_ID)!
      const windowB = await windowOn(spaceB)
      const windowC = await windowOn(spaceC)
      check('three windows (6): what was installed from the store is in the profile it was installed in: the first has the calm one, the second both, the third none', idsOf(profileA).join() === [calm1.id].join() && idsOf('wsb').join() === [calm1.id, wide1.id].sort().join() && idsOf('wsc').length === 0, JSON.stringify({ a: idsOf(profileA), b: idsOf('wsb'), c: idsOf('wsc') }))
      const shown = [await showsIcons(windowA, idsOf(profileA)), await showsIcons(windowB, idsOf('wsb')), await showsIcons(windowC, idsOf('wsc'))]
      check('three windows (6): the toolbar of each window lists the icons of its own profile and no other (main window: the first profile, second window: the second, third window: the third, which has none)', shown.every(Boolean), JSON.stringify({ shown, a: await iconsIn(windowA), b: await iconsIn(windowB), c: await iconsIn(windowC) }))
      // (7) leaving one profile leaves the others: the confirmation names the profile, the copy of the other profile stays loaded, listed, on disk and in its window.
      confirmAnswer = true
      const left = await browser.extensionControl!.uninstall(profileA, calm1.id)
      const kept = await showsIcons(windowB, idsOf('wsb'))
      check('three windows (7): uninstalling the calm one from the first profile removes it there (loaded, files, icon of its window) and leaves the second profile\'s copy loaded, on disk and in its window', left === 'uninstalled' && !infoOf(profileA, calm1.id) && !existsSync(storeDir(profileA, calm1.id)) && (await showsIcons(windowA, [])) && infoOf('wsb', calm1.id)?.enabled === true && existsSync(storeDir('wsb', calm1.id)) && kept && (await iconsIn(windowB)).includes(calm1.id), JSON.stringify({ left, a: await iconsIn(windowA), b: await iconsIn(windowB), onDisk: existsSync(storeDir('wsb', calm1.id)) }))
    } finally {
      for (const rec of extraWindows) if (!rec.win.isDestroyed()) rec.win.close()
      await waitFor(() => extraWindows.every((rec) => rec.win.isDestroyed()), 6000)
      if (spaceC) browser.dispatch({ type: 'space/delete', id: spaceC })
      browser.dispatch({ type: 'space/select', id: originalSpace })
    }

    // ---- 16. the audit: everything that went out went through the guard, to Google's hosts, as the user's own actions ----
    const hosts = new Set(engine.webStore.requests.map((r) => r.host))
    check('audit: every request came from an action of this check (install, update, icon), through the guard, to a host of the list', [...hosts].every(isStoreHost) && engine.webStore.requests.every((r) => r.path.startsWith('/service/update2') || r.path.startsWith('/crx/') || r.path.endsWith('.png')), [...hosts].join())
    check('audit: the local server saw only those paths, and the picture of the page', seen.every((line) => /^(GET|POST) \/(service\/update2\/(crx|json)|crx\/blobs\/|icon\.png)/.test(line)), JSON.stringify([...new Set(seen)]))
    check('audit: the installer sent every request over the network stack of Electron (the application\'s user agent), not with the fetch of Node: so its proxy and DNS are the application\'s', agents.length > 0 && agents.every((agent) => /Electron\//.test(agent)), JSON.stringify([...new Set(agents)]))
    check('audit: no extension of the check is left in the staging folder', !existsSync(join(userData, STAGING_DIR)) || readdirSync(join(userData, STAGING_DIR)).every((profile) => readdirSync(join(userData, STAGING_DIR, profile)).length === 0))
  } finally {
    console.warn = realWarn
    actions.env.confirm = realConfirm
    globalThis.fetch = realFetch
    for (const id of [...tabs]) browser.dispatch({ type: 'tab/close', id })
    for (const ses of sessions) ses.protocol.unhandle('https')
    // Leave the profiles as they were: whatever the check installed goes.
    for (const info of engine.listAllExtensions().filter((e) => e.source === 'store')) await engine.uninstallExtension(info.profileId, info.id).catch((error: unknown) => console.error('[smoke] cannot remove a test extension:', error))
    engine.webStore.useTestNetwork(null)
    if (spaceB) browser.dispatch({ type: 'space/delete', id: spaceB })
    if (store.get().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.dispatch({ type: 'settings/update', patch: originalSettings })
    browser.closeOverlay()
    server.close()
    server.closeAllConnections()
  }
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

/** `LUCIUM_SMOKE_ONLY=webstore`: only these checks, with their own report. */
export async function runWebStoreSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeWebStore(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      // Seen as it goes: a check that hangs further on must not hide the ones that ran.
      console.log(`[smoke-webstore] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeWebStore ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_WEBSTORE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

/**
 * `LUCIUM_SMOKE_ONLY=webstore-live`: loads the page of a real extension of the Chrome Web Store, read only (no click, no install, no
 * account), and says what the page shows: the banner that asks the user to switch browsers and the state of its "Ajouter" button, with the real
 * Chromium version told to the page and with the version `versionForStore` gives. Internet needed: never part of the full chain.
 * LUCIUM_LIVE_URL changes the page.
 */
export async function runWebStoreLiveSmoke(ctx: SmokeContext): Promise<number> {
  const { browser, store, engine } = ctx
  const url = process.env['LUCIUM_LIVE_URL'] ?? 'https://chromewebstore.google.com/detail/dashlane-password-manager/fdjamakpfbbddfjaooikfcpapjohcfmg?hl=fr'
  const variants = [
    { name: 'real version', reported: null as string | null },
    { name: 'version before the threshold', reported: STORE_VERSION_REPORTED }
  ]
  const results: unknown[] = []
  const opened: string[] = []
  const original = STORE_VERSION_REPORTED
  try {
    let n = 0
    for (const variant of variants) {
      engine.webStore.setReportedVersion(variant.reported)
      browser.dispatch({ type: 'tab/open', url: `${url}${url.includes('?') ? '&' : '?'}lucium=${++n}` })
      const tab = store.get().tabs.at(-1)!
      opened.push(tab.id)
      await waitFor(() => browser.pageFor(tab.id) !== undefined && browser.snapshot().runtime.tabs[tab.id]?.loading === false, 30_000)
      await sleep(4000)
      const wc = (browser.pageFor(tab.id) as unknown as { webContents: WebContents }).webContents
      // In Europe Google asks for a choice about cookies first: "Tout refuser" in this throw-away profile, the least that lets the page load.
      if (wc.getURL().includes('consent.google.com')) {
        await wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Tout refuser|Reject all/i.test(x.textContent || '')); if (b) b.click(); return !!b })()`)
        await waitFor(() => wc.getURL().startsWith('https://chromewebstore.google.com'), 20_000)
      }
      await sleep(10_000)
      const probe = await wc.executeJavaScript(`(async () => {
        const text = document.body ? document.body.innerText : ''
        const match = text.match(/.{0,50}(Passez à Chrome|Switch to Chrome|Installer Chrome|Install Chrome).{0,80}/i)
        const told = await window.electronWebstore.getFullChromeVersion().then((r) => r.version_number, () => null)
        return {
          title: document.title,
          href: location.href.slice(0, 100),
          bridge: typeof window.electronWebstore === 'object',
          told,
          banner: match ? match[0].replace(/\\s+/g, ' ') : null,
          buttons: [...document.querySelectorAll('button, a[role=button]')].map((b) => ({ text: (b.textContent || '').trim().slice(0, 50), disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true' })).filter((b) => /Ajouter|Add to|Installer|Install|Chrome/i.test(b.text)).slice(0, 8)
        }
      })()`)
      results.push({ variant: variant.name, probe })
      browser.dispatch({ type: 'tab/close', id: tab.id })
    }
  } finally {
    engine.webStore.setReportedVersion(original)
    for (const id of opened) browser.dispatch({ type: 'tab/close', id })
  }
  console.log(`LUCIUM_SMOKE_WEBSTORE_LIVE ${JSON.stringify(results, null, 2)}`)
  return 0
}
