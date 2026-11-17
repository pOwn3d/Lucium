// Engine checks for an agent-style extension (a side panel, a debugger, native messaging, tab groups): `smokeSurface(ctx, check)`.
// It loads `compat/surface-probe` (declared in LUCIUM_EXTENSIONS), opens a page of a local server that triggers the
// probe's walk through every Chrome API such an extension uses, and checks what the engine gave it. Native messaging is tested
// with a stand-in host (`compat/native-host-probe/host.cjs`) registered in a throwaway manifest folder: the real hosts of other browsers
// or of any app are never started.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { app, Menu, webContents as allWebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, requireProbes, sleep, waiterOf } from './smoke-kit'
import { ruleCheck } from './smoke-probe-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface ProbeResult {
  name: string
  ok: boolean
  value: unknown
}


const waitFor = waiterOf(8000, 80)

/** Where the stand-in native host lives, found next to the probe extension. */
function findHostScript(): string | null {
  const probe = (process.env['LUCIUM_EXTENSIONS'] ?? '').split(':').find((p) => p.endsWith('/surface-probe'))
  const script = probe ? join(dirname(probe), 'native-host-probe', 'host.cjs') : null
  return script && existsSync(script) ? script : null
}

export async function smokeSurface({ browser, store, engine, little, win }: SmokeContext, check: Check): Promise<void> {
  const probe = engine.listExtensions().find((e) => e.name === 'Lucium Surface Probe')
  // Without its probe the suite verifies nothing: a missing probe is a failed check, not a silent return.
  if (!requireProbes(engine.listExtensions(), ['Lucium Surface Probe'], check) || !probe) return

  const results = new Map<string, ProbeResult>()
  const guard = new Map<string, ProbeResult>()
  const warnings: string[] = []
  const commandsSeen: string[] = []
  engine.onExtensionConsole((entry) => {
    if (entry.message.startsWith('SURFACE_RESULT ')) {
      const result = JSON.parse(entry.message.slice('SURFACE_RESULT '.length)) as ProbeResult
      results.set(result.name, result)
    } else if (entry.message.startsWith('SHIM_GUARD ')) {
      const result = JSON.parse(entry.message.slice('SHIM_GUARD '.length)) as ProbeResult
      guard.set(result.name, result)
    } else if (entry.message.startsWith('SURFACE_COMMAND ')) commandsSeen.push(entry.message.slice('SURFACE_COMMAND '.length))
    else warnings.push(`${entry.level}: ${entry.message.slice(0, 300)}`)
  })

  // The stand-in host and its manifests, in the folder Lucium reads (never another browser's).
  const hostScript = findHostScript()
  check('the stand-in native host is found next to the probe', hostScript !== null)
  if (hostScript) {
    const dir = join(app.getPath('userData'), 'NativeMessagingHosts')
    mkdirSync(dir, { recursive: true })
    const wrapper = join(dir, 'probe-host.sh')
    // The packaged application has the RunAsNode fuse off (electron-builder.yml), so it cannot play the interpreter: use the Node of the machine when there is one.
    const nodeOnPath = (() => {
      try {
        return execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })()
    const runner = nodeOnPath ? `exec '${nodeOnPath}'` : `ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}'`
    writeFileSync(wrapper, `#!/bin/sh\n${runner} '${hostScript}' "$@"\n`)
    chmodSync(wrapper, 0o755)
    const manifest = (name: string, origins: string[]) =>
      JSON.stringify({ name, description: 'Lucium test host', path: wrapper, type: 'stdio', allowed_origins: origins })
    writeFileSync(join(dir, 'com.lucium.probe_host.json'), manifest('com.lucium.probe_host', [`chrome-extension://${probe.id}/`]))
    writeFileSync(join(dir, 'com.lucium.other_host.json'), manifest('com.lucium.other_host', ['chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/']))
  }

  let authHits = 0
  const headersSeen: Array<Record<string, unknown>> = []
  // The answers the server holds back: a picture that never comes keeps its page loading (`tabs.updateWhileLoading` of the probe).
  const held: Array<{ end: () => void }> = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/never-comes')) return void held.push(res)
    if (url.startsWith('/hdr')) {
      headersSeen.push({ ...req.headers })
      res.setHeader('content-type', 'application/json')
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', '*')
      return res.end(JSON.stringify(req.headers))
    }
    if (url.startsWith('/surface-probe-download')) {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="surface-probe.bin"')
      return res.end(Buffer.alloc(1024, 3))
    }
    if (url.startsWith('/fake-auth')) {
      authHits++
      // A stand-in authorization server: it sends the browser straight back to the redirect URI with a code.
      const params = new URL(url, 'http://x').searchParams
      res.statusCode = 302
      res.setHeader('location', `${params.get('redirect_uri')}?code=fake-code&state=${params.get('state')}`)
      return res.end()
    }
    res.setHeader('content-type', 'text/html')
    if (url.startsWith('/close-me')) return res.end('<title>close-me</title><body><script>setTimeout(() => window.close(), 400)</script></body>')
    if (url.startsWith('/still-loading')) return res.end('<title>still loading</title><body>a page whose picture never comes <img src="/never-comes"></body>')
    if (url.startsWith('/surface-probe')) {
      return res.end(`<title>surface-probe</title><body><button id="b" style="width:120px;height:40px" onclick="window.__clicks=(window.__clicks||0)+1">go</button><input id="i">
        <script>
          window.__probePage = 1
          const ext = new URLSearchParams(location.search).get('ext')
          window.__external = { hasSend: typeof (window.chrome && chrome.runtime && chrome.runtime.sendMessage) }
          if (window.__external.hasSend) {
            chrome.runtime.sendMessage(ext, { type: 'oauth_redirect', redirect_uri: 'x' }, (reply) => {
              window.__external.reply = reply
              window.__external.error = chrome.runtime.lastError ? chrome.runtime.lastError.message : null
            })
          }
        </script></body>`)
    }
    return res.end(`<title>probe ${url}</title><body>probe page ${url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // Let the extension's worker finish starting: a tab opened while it boots can be missed by its listeners.
  await sleep(Number(process.env['LUCIUM_SURFACE_SMOKE_DELAY'] ?? 3000))
  // The guard probe (an extension with almost no permission) starts on a page of its own.
  if (engine.listExtensions().some((e) => e.name === 'Lucium Shim Guard Probe')) {
    browser.dispatch({ type: 'tab/open', url: `${base}/shim-guard` })
    await waitFor(() => store.get().tabs.some((t) => t.title === 'probe /shim-guard'), 10_000)
  }
  browser.dispatch({ type: 'tab/open', url: `${base}/surface-probe?ext=${probe.id}` })
  check('the probe page loads in a tab', await waitFor(() => store.get().tabs.some((t) => t.title === 'surface-probe'), 15_000), JSON.stringify(store.get().tabs.map((t) => t.title)))
  const probeTab = store.get().tabs.find((t) => t.title === 'surface-probe')
  // Who closes the side panel of the probe, for the check that looks at it once the walk is over: the calls that asked for it, the tab on screen then.
  const panelClosedBy: string[] = []
  const realCloseSidePanel = browser.closeSidePanel.bind(browser)
  browser.closeSidePanel = () => {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 30
    const stack = (new Error().stack ?? '').split('\n').slice(2, 26).map((line) => line.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ')
    Error.stackTraceLimit = limit
    panelClosedBy.push(`on screen "${store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.title}": ${stack}`)
    realCloseSidePanel()
  }
  // The probe signs in with nobody at the keyboard, and a sign-in window opens only just after a click or a key press: a key is pressed (for real,
  // through the input of the window) while it walks.
  const keyPresses = setInterval(() => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' }), 400)
  const finished = await waitFor(() => results.has('done'), 120_000)
  clearInterval(keyPresses)
  // The probe's last port is still open for a moment: measured at once, before anything else is checked.
  const heldWhileOpen = engine.heldWorkerCount()
  console.log(`SURFACE_REPORT ${JSON.stringify({ finished, results: [...results.values()], warnings: warnings.slice(0, 40), headersSeen: headersSeen.length, panel: browser.snapshot().sidePanel }, null, 1)}`)
  check('the surface probe finished its walk', finished)

  // One check per step of the probe: it passed, and what it reports is what the chrome.* API is meant to give.
  const step = (label: string, name: string, test?: (value: any) => boolean, ifItFails?: string) => {
    const r = results.get(name)
    const ok = !!r && r.ok && (!test || test(r.value))
    check(label, ok, ok || !ifItFails ? JSON.stringify(r) : `${JSON.stringify(r)} | ${ifItFails}`)
  }
  step('every Chrome API an agent extension uses exists in the worker', 'surface', (v) => v.missing.length === 0)
  step('storage.local, session and managed answer', 'storage.local', (v) => v === 'é')
  step('storage.session answers', 'storage.session', (v) => v === 2)
  step('storage.managed is empty and read-only, not an alias of the extension\'s own storage', 'storage.managed', (v) => v.keys === 0 && v.defaults === 7 && v.writeRefused === true)
  step('storage.onChanged reaches the worker (Electron does not deliver it)', 'storage.onChanged', (v) => /^local:/.test(v))
  step('alarms keep their schedule', 'alarms', (v) => v.count === 1 && v.cleared === true)
  step('alarms.onAlarm reaches the worker, which is how an agent stays connected', 'alarms.onAlarm', (v) => v >= 1)
  step('runtime.onInstalled reaches the worker once, as an install, and onStartup does not on a first install', 'runtime.lifecycle', (v) => v.installed.length === 1 && v.installed[0] === 'install' && v.startups === 0)
  step('action badge, title and settings answer', 'action', (v) => v.isOnToolbar === true)
  step('commands.getAll gives the shortcut of the manifest as Chrome shows it', 'commands.getAll', (v) => v[0]?.name === 'toggle-side-panel' && v[0]?.shortcut === '⇧⌘9')
  {
    // The same rule as `dnr.session.modifyHeaders.request` of the probes suite, asked by a worker instead of a page, and judged the same way
    // (smoke-probe-kit.ts): a rule that is not applied is a failure, and so is a probe that did not answer.
    // Electron 45.2.1 applies the rule in a bare session until any session.webRequest listener is registered (even one filtered on an address
    // nobody asks for), and then never; the sessions of pages have such listeners, so the application applies the rules itself (engine/extension-net.ts).
    const r = results.get('dnr.modifyHeaders')
    const state = !r || !r.ok ? 'unmeasured' : (r.value as { sawHeader?: unknown } | undefined)?.sawHeader === '1' ? 'applied' : 'not-applied'
    const verdict = ruleCheck('dnr.session.modifyHeaders.request', '', { state, saw: JSON.stringify(r) })
    check('declarativeNetRequest session rules rewrite the headers of a worker request', verdict.ok, verdict.detail)
  }
  step('chrome.downloads downloads, reports the end and finds the file', 'downloads', (v) => v.id === 'number' && v.found === 1 && v.state === 'complete' && v.filename === 'surface-probe.bin')
  check('the downloaded file is in the downloads folder', existsSync(join(app.getPath('downloads'), 'surface-probe.bin')), app.getPath('downloads'))
  step('chrome.identity.getRedirectURL is on chromiumapp.org', 'identity.redirectUrl', (v) => v === `https://${probe.id}.chromiumapp.org/cb`)
  step('launchWebAuthFlow resolves with the redirect an authorization server sends', 'identity.launchWebAuthFlow', (v) => v === `https://${probe.id}.chromiumapp.org/cb?code=fake-code&state=s1`)
  step('launchWebAuthFlow without interaction resolves too when the server redirects', 'identity.silent', (v) => v === `https://${probe.id}.chromiumapp.org/cb?code=fake-code&state=s2`)
  step('a page that never redirects ends a flow without interaction with "User interaction required."', 'identity.interactionRequired', (v) => v === 'rejected: User interaction required.')
  check('the authorization server was reached twice, by the two flows', authHits === 2, String(authHits))
  step('chrome.notifications creates a notification and clears it', 'notifications', (v) => v.id === 'probe-note')
  step('an offscreen document is created, answers messages as the extension, and closes', 'offscreen', (v) => v.before === false && v.during === true && v.contexts === 1 && v.reply === 'pong-offscreen' && v.extensionId === true && v.after === false)
  step('permissions.contains answers from the manifest', 'permissions', (v) => v.nativeMessaging === true && v.other === false)

  step('native messaging: a message reaches the host and its answer comes back, UTF-8 intact, with the extension origin as argument', 'native.connect', (v) => v.text === 'héllo ✓ 日本' && v.argv[0] === `chrome-extension://${probe.id}/`)
  step('sendNativeMessage answers with the first reply', 'native.sendMessage', (v) => v.ping === 2)
  step('a host without manifest ends the port with Chrome\'s error', 'native.missingHost', (v) => v === 'Specified native messaging host not found.')
  step('a host that does not allow the extension is forbidden', 'native.forbiddenHost', (v) => v === 'Access to the specified native messaging host is forbidden.')
  step('a host that leaves ends the port with "Native host has exited."', 'native.hostExits', (v) => v === 'Native host has exited.')
  step('connectNative with something else than a host name throws like Chrome', 'native.badArguments', (v) => v === 'TypeError')
  step('a host that sends more than 1 MiB is cut off without crashing the browser', 'native.oversize', (v) => v.delivered === false && v.message === 'Error when communicating with the native messaging host.')
  // The probe leaves one port open for 3 seconds at the end of its walk: the worker is held awake meanwhile, and let go after.
  step('a native port can stay open', 'native.keep', (v) => v === 'open')
  check('an open native port holds its extension\'s worker awake', heldWhileOpen === 1, String(heldWhileOpen))
  check('and the worker is let go when the port closes', await waitFor(() => engine.heldWorkerCount() === 0, 8000), String(engine.heldWorkerCount()))

  step('scripting.executeScript runs in the isolated world and in the page', 'scripting.executeScript', (v) => v.title === 'surface-probe' && v.main === 'number')
  step('a content script injects and answers the worker', 'contentScript', (v) => v.pong === true && v.mark === 'content-script')
  step('a web page reaches the worker through externally_connectable (the sign-in hand-over)', 'externalMessage', (v) => v.type === 'oauth_redirect' && v.origin === base)
  const page = allWebContents.getAllWebContents().find((wc) => wc.getURL().startsWith(`${base}/surface-probe`))
  const pageSide = page ? ((await page.executeJavaScript('JSON.stringify({ external: window.__external, mark: document.documentElement.dataset.surfaceProbe })')) as string) : ''
  check('the page gets the worker\'s answer to its message', /"reply":\{"ok":true/.test(pageSide), pageSide)
  step('tabs.getCurrent gives a worker no tab (the library gives it the active one)', 'tabs.getCurrent', (v) => v === 'undefined')
  step('windows answer', 'windows', (v) => v.got === true)
  step('tabs.create opens tabs in the window asked for', 'tabs.create', (v) => v.a === 'number' && v.b === true)
  step('tabs.create accepts chrome://newtab, the address an agent opens its tabs with', 'tabs.createNewTabUrl', (v) => v.id === 'number')
  step('tab groups are real: a tab reports its group, a query by group returns only that group, a title and a color stick', 'tabGroups.group', (v) => v.title === 'Probe' && v.color === 'orange' && v.windowOk && v.queried === 1 && v.members && v.getGroupId && v.probePageUngrouped && v.noneIsMinusOne === -1)
  step('ungrouping empties the group, which then disappears, and its events fire', 'tabGroups.ungroup', (v) => v.memberGroupId === -1 && v.remaining === 1 && v.groupGoneWhenEmpty && /(^|,)onCreated,onUpdated,onRemoved$/.test(String(v.events)))
  step('tabs.captureVisibleTab returns the visible tab, in png and in jpeg', 'tabs.captureVisibleTab', (v) => v.prefix === 'data:image/png;base64,' && v.width > 200 && v.height > 200 && v.jpegPrefix === 'data:image/jpeg;base64,')
  step('webNavigation reports a navigation and its frames', 'tabs.navigate', (v) => /onBeforeNavigate/.test(v.events) && /onCommitted/.test(v.events) && /onCompleted/.test(v.events) && v.frames === 1)
  step('windows.create opens a popup, windows.update moves and resizes it, windows.remove closes it', 'windows.createRemove', (v) => v.id === 'number' && v.width === 700 && v.height === 500 && v.left === 40 && v.top === 50)
  step('tabs.goBack and goForward move through the history of a tab', 'tabs.history', (v) => v === 'back and forward')
  step('tabs.update answers with the tab while its page is still loading, and the load it ends is no error of the extension', 'tabs.updateWhileLoading', (v) => v.answered === true)
  check('and the popup window is gone', await waitFor(() => little.count() === 0, 4000), String(little.count()))
  step('runtime.openOptionsPage opens the options page in a tab', 'runtime.openOptionsPage', (v) => v === 'opened')
  step('chrome.debugger evaluates, takes a screenshot, clicks and types like a user, and reports events', 'debugger', (v) => v.listed && v.evaluate === 42 && v.screenshotBytes > 1000 && v.clicks === 1 && v.typed === 'ok' && v.events === true)
  step('the docked panel is a side panel context for runtime.getContexts', 'sidePanel', (v) => Array.isArray(v) && v.length === 1 && v[0] === 'SIDE_PANEL')
  step('a panel holds a port to the worker (runtime.connect)', 'runtime.connect', (v) => v.reply === 'echo:hello')
  step('a group can outlive the walk', 'tabGroups.keep', (v) => typeof v === 'number')
  check('the probe raised no error in its console', warnings.filter((w) => w.startsWith('error:')).length === 0, warnings.filter((w) => w.startsWith('error:')).join(' | '))

  // Another extension that sets the options of its own panel leaves the probe's docked: the side panel probe does so on the first line of its
  // worker, which starts again whenever an event wakes it, at any moment of the walk. The probe's panel was opened for its page while its options
  // page is on screen, which has no panel of its own.
  const otherPanel = engine.listExtensions().find((e) => e.name === 'Lucium Side Panel Probe')
  if (otherPanel) {
    browser.setSidePanelOptions(otherPanel.id, undefined, { path: 'panel.html', enabled: true })
    check('another extension that sets the options of its own panel leaves the panel of the probe docked', browser.snapshot().sidePanel?.extensionId === probe.id, JSON.stringify(browser.snapshot().sidePanel))
  }

  // A page of one extension cannot speak for another through the library's channel. The probe's side panel is still open: it is a
  // page of the extension, with the library's preload in it, as any popup or options page is.
  const panelPage = allWebContents.getAllWebContents().find((wc) => wc.getURL().startsWith(`chrome-extension://${probe.id}/panel.html`))
  check('the side panel of the probe is open, to be looked at as an extension page', !!panelPage, `closed by: ${panelClosedBy.join(' || ') || 'nobody'}; on screen: ${store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.title}; ${allWebContents.getAllWebContents().map((wc) => wc.getURL().slice(0, 60)).join(' | ')}`)
  browser.closeSidePanel = realCloseSidePanel
  if (panelPage) {
    const otherId = engine.listExtensions().find((e) => e.name === 'Lucium Shim Guard Probe')?.id ?? 'p'.repeat(32)
    const bridge = String(await panelPage.executeJavaScript('typeof window.electron'))
    // The library's preload tries to delete it after use, and Electron does not allow that (the property cannot be deleted: measured). It is therefore
    // not the page that is trusted but the main process, which refuses a forged id: the checks after this one are the guard.
    console.log(`[smoke-extensions] window.electron is "${bridge}" in an extension page (kept by Electron; the router judges the sender)`)
    const router = (engine as unknown as { profiles: Map<string, { router: { handlers: Map<string, { callback: (event: unknown, ...args: unknown[]) => unknown }> } }> }).profiles.get('default')!.router
    const extensionOf = (id: string) => panelPage.session.extensions.getExtension(id) ?? { id, manifest: {} }
    const callFrom = async (name: string, sender: unknown, id: string | undefined, ...args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
      try {
        return { ok: true, value: await router.handlers.get(name)!.callback({ type: 'frame', sender, ...(id ? { extension: extensionOf(id) } : {}) }, ...args) }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }
    const own = await callFrom('commands.getAll', panelPage, probe.id)
    check('a page of an extension is served in its own name', own.ok && Array.isArray(own.value), JSON.stringify(own))
    const forged = await callFrom('commands.getAll', panelPage, otherId)
    check('and is not served in the name of another extension (the id of the message is not who sent it)', !forged.ok && /called in the name of/.test(forged.error ?? ''), JSON.stringify(forged))
    const forgedClose = await callFrom('tabs.reload', panelPage, otherId, 1)
    check('not even for a call the library serves without any permission (tabs.reload)', !forgedClose.ok && /called in the name of/.test(forgedClose.error ?? ''), JSON.stringify(forgedClose))
    const fromInterface = await callFrom('browserAction.getState', win.webContents, undefined)
    check('the toolbar of the interface can ask for the state of the actions', fromInterface.ok, JSON.stringify(fromInterface))
    for (const name of ['browserAction.getState', 'browserAction.activate', 'browserAction.addObserver']) {
      const refusedToPage = await callFrom(name, panelPage, undefined, { eventType: 'click', extensionId: otherId, tabId: 1 })
      check(`and ${name} is refused to an extension page`, !refusedToPage.ok && /interface of the application only/.test(refusedToPage.error ?? ''), JSON.stringify(refusedToPage))
    }
    // If the bridge is still there, the page itself can try to speak for another extension through the real channel: the answer is refused (the preload turns the error into undefined).
    if (bridge !== 'undefined' && engine.listExtensions().some((e) => e.id === otherId)) {
      const viaPage = (await panelPage.executeJavaScript(`(async () => JSON.stringify({ own: Array.isArray(await window.electron.invokeExtension(${JSON.stringify(probe.id)}, 'tabs.query', {}, {})), forged: await window.electron.invokeExtension(${JSON.stringify(otherId)}, 'tabs.query', {}, {}) ?? null }))()`)) as string
      check('through the real channel, a page that still holds the bridge gets its own tabs and nothing in the name of another extension', viaPage === JSON.stringify({ own: true, forged: null }), viaPage)
    } else if (bridge !== 'undefined') check('through the real channel, a page that still holds the bridge gets its own tabs and nothing in the name of another extension', false, 'the page holds the bridge, and the other extension (compat/shim-guard-probe) is not loaded: nothing to forge a call for')
  }

  // The shortcut of the manifest is a menu item with its key, and pressing it runs the command: the panel opens, and closes when pressed again.
  const extensionsMenu = Menu.getApplicationMenu()?.items.find((m) => m.label === 'Extensions')?.submenu?.items ?? []
  const shortcutItem = extensionsMenu.find((item) => item.label.includes('Toggle the probe side panel'))
  check('the Extensions menu gives the command its shortcut', shortcutItem?.accelerator === 'Shift+Cmd+9', extensionsMenu.map((i) => `${i.label}[${i.accelerator ?? ''}]`).join(' | '))
  if (probeTab) browser.dispatch({ type: 'tab/select', id: probeTab.id })
  browser.closeSidePanel()
  shortcutItem?.click()
  check('pressing the shortcut runs the command and opens the panel', await waitFor(() => browser.snapshot().sidePanel?.extensionId === probe.id, 8000), commandsSeen.join(','))
  await sleep(1500)
  shortcutItem?.click()
  check('pressing it again closes the panel: its window.close() is honored', await waitFor(() => browser.snapshot().sidePanel === null, 8000), JSON.stringify(browser.snapshot().sidePanel))
  check('the command reached the worker each time', commandsSeen.filter((c) => c === 'toggle-side-panel').length >= 2, commandsSeen.join(','))

  // A page that closes itself takes its tab with it.
  const before = store.get().tabs.length
  browser.dispatch({ type: 'tab/open', url: `${base}/close-me` })
  check('a page that calls window.close() closes its tab', (await waitFor(() => store.get().tabs.length === before + 1, 5000)) && (await waitFor(() => store.get().tabs.length === before, 8000)), `${before} -> ${store.get().tabs.length}`)

  // An extension that declared almost nothing gets none of what Lucium provides itself.
  await waitFor(() => guard.has('done'), 15_000)
  // (The extension library defines chrome.downloads for everyone, inert: Lucium's preload keeps it from existing without the permission, and the bridge below refuses the real one.)
  check('an extension without permissions does not even see the APIs Lucium defines', JSON.stringify(guard.get('namespaces')?.value) === JSON.stringify({ sidePanel: 'undefined', tabGroups: 'undefined', debugger: 'undefined', identity: 'undefined', tabsGroup: 'undefined', tabsCapture: 'function', connectNative: 'undefined', downloadsDownload: 'undefined' }), JSON.stringify(guard.get('namespaces')))
  for (const name of ['debugger', 'tabGroups', 'tabs.group', 'tabs.captureVisibleTab', 'sidePanel', 'identity', 'nativeMessaging', 'downloads', 'unknown api']) {
    check(`and the bridge refuses it ${name} when it calls it directly`, guard.get(name)?.ok === true, JSON.stringify(guard.get(name)))
  }

  // A second profile: the tab and the group of the first are out of reach of its extension.
  if (probeTab) {
    const foreignTab = engine.tabNumberOf(probeTab.id)
    const foreignGroup = Number(results.get('tabGroups.keep')?.value)
    const home = store.get().activeSpaceId
    browser.dispatch({ type: 'space/create', name: 'isolation', emoji: '🧪', hue: 200, profileId: 'surface-isolation' })
    const other = store.get().spaces.find((s) => s.name === 'isolation')
    check('a space in another profile is created', !!other && other.profileId === 'surface-isolation')
    browser.dispatch({ type: 'tab/open', url: `${base}/warm-up` })
    await sleep(4500)
    results.delete('done')
    browser.dispatch({ type: 'tab/open', url: `${base}/surface-probe?ext=${probe.id}&isolation=1&foreignTab=${foreignTab}&foreignGroup=${foreignGroup}` })
    await waitFor(() => results.has('isolation-done'), 30_000)
    const isolated = (name: string) => results.get(name)
    check('in another profile the debugger does not list the tabs of the first', isolated('isolation.targets')?.ok === true && isolated('isolation.targets')?.value === false, JSON.stringify(isolated('isolation.targets')))
    for (const [name, label] of [['isolation.attach', 'attach the debugger to'], ['isolation.group', 'group'], ['isolation.ungroup', 'ungroup']] as const) {
      check(`and cannot ${label} a tab of the first profile`, isolated(name)?.ok === false && /No tab with id/.test(String(isolated(name)?.value)), JSON.stringify(isolated(name)))
    }
    check('nor see the groups of the first profile', isolated('isolation.groupsListed')?.ok === true && isolated('isolation.groupsListed')?.value === 0, JSON.stringify(isolated('isolation.groupsListed')))
    for (const name of ['isolation.groupGet', 'isolation.groupUpdate']) {
      check(`nor reach one by its id (${name.split('.')[1]})`, isolated(name)?.ok === false && /No group with id/.test(String(isolated(name)?.value)), JSON.stringify(isolated(name)))
    }
    check('chrome.tabs.query of another profile does not list the tab either', isolated('isolation.tabsQuery')?.ok === true && isolated('isolation.tabsQuery')?.value === false, JSON.stringify(isolated('isolation.tabsQuery')))
    if (other) browser.dispatch({ type: 'space/delete', id: other.id })
    browser.dispatch({ type: 'space/select', id: home })
  }

  for (const answer of held) answer.end()
  server.close()
  browser.closeSidePanel()

  // Opt-in (about 90 seconds): a worker that is held stays up past the 30 seconds after which an idle one is stopped, and one that is
  // let go does stop (without that, the first half would pass whatever the hold did).
  if (process.env['LUCIUM_SMOKE_LONG'] === '1') {
    const scope = `chrome-extension://${probe.id}/`
    const release = engine.holdWorker(probe.id, 'default')
    // A fixed wait by nature: what is checked is a worker that outlives the 30 seconds after which an idle one is stopped.
    await sleep(40_000)
    check('a worker that is held awake is still running after 40 seconds without any event', engine.runningExtensionWorkers().includes(scope))
    release()
    check('and the same worker stops once it is let go', await waitFor(() => !engine.runningExtensionWorkers().includes(scope), 60_000))
  }
}

export async function runSurfaceSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSurface(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeSurface ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SURFACE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

// ---- the real extension, for a person who has it (never part of the repository or of the default test) ----
//
// `LUCIUM_SMOKE_ONLY=surface-real LUCIUM_EXTENSIONS=<copy of the unpacked extension> electron . --smoke --user-data-dir=<throw-away>`
// loads the extension, opens a local page, clicks its toolbar icon and reports what happened: console errors, pages it opened, whether its
// content scripts ran, and what its side panel shows. It never signs in. Set LUCIUM_SHOT_DIR to also save a picture of the panel.

export async function smokeSurfaceReal({ browser, store, engine }: SmokeContext, check: Check): Promise<void> {
  const real = engine.listExtensions().find((e) => e.name === 'Claude')
  check('the Claude extension loads', !!real, engine.listExtensions().map((e) => e.name).join(', '))
  if (!real) return

  const log: string[] = []
  engine.onExtensionConsole((entry) => log.push(`${entry.level}: ${entry.message.slice(0, 400)} (${entry.sourceUrl.split('/').slice(-1)[0]})`))
  const report: Record<string, unknown> = {}

  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>real-extension-page</title><body><h1>Hello</h1><button>Press</button></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  await sleep(5000)
  report['tabsAfterStart'] = store.get().tabs.map((t) => `${t.title} | ${t.url}`)
  report['workers'] = engine.runningExtensionWorkers()

  browser.dispatch({ type: 'tab/open', url: `${base}/page` })
  await waitFor(() => store.get().tabs.some((t) => t.title === 'real-extension-page'), 10_000)
  await sleep(1500)
  const page = allWebContents.getAllWebContents().find((wc) => wc.getURL().startsWith(base))
  if (page) {
    // The isolated worlds of the page: an extension's content scripts each run in one named after the extension.
    const worlds: string[] = []
    const dbg = page.debugger
    dbg.attach('1.3')
    dbg.on('message', (_e, method, params: { context?: { name?: string; origin?: string } }) => {
      if (method === 'Runtime.executionContextCreated') worlds.push(`${params.context?.name ?? ''}@${params.context?.origin ?? ''}`)
    })
    await dbg.sendCommand('Runtime.enable')
    await sleep(500)
    dbg.detach()
    report['pageWorlds'] = worlds
  }

  report['commands'] = real.commands
  const before = browser.snapshot().sidePanel
  await browser.activateExtension(real.id)
  report['panelOpened'] = await waitFor(() => browser.snapshot().sidePanel?.extensionId === real.id, 8000)
  await sleep(4000)
  const panel = allWebContents.getAllWebContents().find((wc) => wc.getURL().startsWith(`chrome-extension://${real.id}/sidepanel.html`))
  report['panelUrl'] = panel?.getURL() ?? null
  if (panel) {
    report['panelText'] = String(await panel.executeJavaScript('document.body.innerText.slice(0, 600)'))
    const shotDir = process.env['LUCIUM_SHOT_DIR']
    if (shotDir) writeFileSync(join(shotDir, 'extension-panel.png'), (await panel.capturePage()).toPNG())
  }
  report['panelBefore'] = before
  // The keyboard shortcut of the extension: pressed once while its panel is open, it closes it; pressed again, it opens it.
  const shortcut = real.commands?.find((c) => c.name === 'toggle-side-panel')
  if (shortcut) {
    browser.runExtensionCommand(real.id, 'toggle-side-panel')
    report['panelClosedByShortcut'] = await waitFor(() => browser.snapshot().sidePanel === null, 8000)
    await sleep(1000)
    browser.runExtensionCommand(real.id, 'toggle-side-panel')
    report['panelReopenedByShortcut'] = await waitFor(() => browser.snapshot().sidePanel?.extensionId === real.id, 8000)
  }
  report['tabsAfterClick'] = store.get().tabs.map((t) => `${t.title} | ${t.url}`)
  report['console'] = log.slice(0, 80)
  console.log(`SURFACE_REAL_REPORT ${JSON.stringify(report, null, 1)}`)
  server.close()
}

export async function runSurfaceRealSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSurfaceReal(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeSurfaceReal ran to the end', false, String((error as Error)?.stack ?? error))
  }
  console.log(`LUCIUM_SMOKE_SURFACE_REAL ${JSON.stringify({ checks }, null, 2)}`)
  return checks.every((c) => c.ok) ? 0 : 1
}
