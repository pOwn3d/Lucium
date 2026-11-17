// Service worker of the probe. The engine smoke test opens `<server>/surface-probe?ext=<id>`; once that page has loaded, this
// worker walks through every extension API an agent-style extension relies on and reports each result as a console warning
// `SURFACE_RESULT {"name","ok","value"}` that the test collects (see src/main/smoke-extensions.ts).
// Nothing here talks to an account or to a network other than the test server.

const HOST = 'com.lucium.probe_host'
const FORBIDDEN_HOST = 'com.lucium.other_host'
const MISSING_HOST = 'com.lucium.no_such_host'

const out = (name, ok, value) => console.warn('SURFACE_RESULT ' + JSON.stringify({ name, ok, value }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout: ' + label)), ms))])

/** Runs one check. A thrown error is the result (ok = false), never lost. */
async function step(name, fn, ms = 8000) {
  try {
    out(name, true, await withTimeout(Promise.resolve().then(fn), ms, name))
  } catch (error) {
    out(name, false, String(error && error.message ? error.message : error))
  }
}

const SURFACE = {
  action: ['getUserSettings', 'setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor', 'setTitle', 'onClicked'],
  alarms: ['create', 'getAll', 'clear', 'onAlarm'],
  commands: ['getAll', 'onCommand'],
  debugger: ['attach', 'detach', 'getTargets', 'sendCommand', 'onEvent', 'onDetach'],
  declarativeNetRequest: ['updateSessionRules'],
  downloads: ['download', 'search', 'onChanged'],
  identity: ['getRedirectURL', 'launchWebAuthFlow'],
  notifications: ['create', 'clear', 'onClicked'],
  offscreen: ['createDocument', 'hasDocument', 'closeDocument'],
  permissions: ['contains', 'remove', 'onAdded', 'onRemoved'],
  runtime: ['connect', 'connectNative', 'sendNativeMessage', 'getContexts', 'getManifest', 'getURL', 'onConnect', 'onInstalled', 'onMessage', 'onMessageExternal', 'onStartup', 'onUpdateAvailable', 'openOptionsPage', 'reload', 'sendMessage', 'setUninstallURL'],
  scripting: ['executeScript'],
  sidePanel: ['open', 'setOptions'],
  storage: ['local', 'managed', 'session', 'onChanged'],
  tabGroups: ['get', 'query', 'update', 'onCreated', 'onUpdated', 'onRemoved'],
  tabs: ['captureVisibleTab', 'create', 'get', 'getCurrent', 'goBack', 'goForward', 'group', 'ungroup', 'query', 'reload', 'remove', 'sendMessage', 'update', 'onActivated', 'onRemoved', 'onUpdated'],
  webNavigation: ['getAllFrames', 'onBeforeNavigate', 'onCommitted', 'onCompleted'],
  windows: ['create', 'get', 'getCurrent', 'getLastFocused', 'remove', 'update', 'onRemoved']
}

function surface() {
  const missing = []
  let present = 0
  for (const [ns, members] of Object.entries(SURFACE)) {
    const api = globalThis.chrome && globalThis.chrome[ns]
    if (!api) {
      missing.push(ns)
      continue
    }
    for (const member of members) {
      if (api[member] === undefined) missing.push(ns + '.' + member)
      else present++
    }
  }
  return { present, missing }
}

// ---- state collected by listeners that exist from the first line of the worker ----

const seen = { cs: [], external: [], commands: [], panelOpened: [], alarms: 0, navigated: [], groupEvents: [], downloads: [], detach: [], installed: [], startups: 0, storage: [], ports: [], portReplies: [] }

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'cs-hello') seen.cs.push({ tabId: sender.tab?.id, href: message.href })
  if (message?.type === 'PANEL_OPENED') seen.panelOpened.push(message.tabId)
  if (message?.type === 'PORT_REPLY') seen.portReplies.push(message.message)
  return false
})

// Events that Electron does not deliver to a worker by itself: the engine hands them over. It does so once, when the extension is loaded.
// A worker that was stopped for being idle and starts again later (for the probe's walk, minutes into a long test run) has missed them
// and starts with an empty `seen`, as any restarted worker does: so they are also kept in storage, which an extension that cares would do too.
// Each key has a single writer, so the two events cannot overwrite one another.
const keepLifecycle = (key, update) => chrome.storage.local.get({ [key]: key === 'lifecycleStartups' ? 0 : [] }).then((kept) => chrome.storage.local.set({ [key]: update(kept[key]) }))
chrome.runtime.onInstalled.addListener((details) => {
  seen.installed.push(details.reason)
  void keepLifecycle('lifecycleInstalled', (reasons) => [...reasons, details.reason])
})
chrome.runtime.onStartup.addListener(() => {
  seen.startups++
  void keepLifecycle('lifecycleStartups', (count) => count + 1)
})
chrome.runtime.onConnect.addListener((port) => {
  seen.ports.push(port.name)
  port.onMessage.addListener((message) => port.postMessage('echo:' + message))
})

// An agent extension answers its own web app through this channel (sign-in hand-over).
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  seen.external.push({ type: message?.type, origin: sender.origin, url: sender.url })
  reply({ ok: true, origin: sender.origin })
  return false
})

chrome.commands.onCommand.addListener(async (command) => {
  seen.commands.push(command)
  console.warn('SURFACE_COMMAND ' + command)
  if (command !== 'toggle-side-panel') return
  // The same dance an agent panel does on its shortcut: open the panel for the active tab, or close it when it is already open.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined) return
  const contexts = chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] })
  chrome.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html?tabId=' + tab.id, enabled: true })
  const opening = chrome.sidePanel.open({ tabId: tab.id }).catch((error) => console.warn('SURFACE_COMMAND open failed ' + error.message))
  const open = (await contexts).some((c) => c.documentUrl && new URL(c.documentUrl).searchParams.get('tabId') === String(tab.id))
  if (open) await chrome.runtime.sendMessage({ type: 'close_side_panel', tabId: tab.id })
  await opening
})

chrome.storage.onChanged.addListener((changes, area) => void seen.storage.push(area + ':' + Object.keys(changes).join(',')))
chrome.action.onClicked.addListener((tab) => console.warn('SURFACE_ACTION_CLICKED ' + tab.id))
chrome.alarms.onAlarm.addListener(() => void seen.alarms++)
for (const event of ['onBeforeNavigate', 'onCommitted', 'onCompleted']) {
  chrome.webNavigation[event].addListener((details) => {
    seen.navigated.push({ event, tabId: details.tabId, frameId: details.frameId, url: String(details.url) })
  })
}
for (const event of ['onCreated', 'onUpdated', 'onRemoved']) {
  chrome.tabGroups[event].addListener((group) => void seen.groupEvents.push(event + ':' + (group && group.id !== undefined ? group.id : group)))
}
chrome.downloads.onChanged.addListener((delta) => void seen.downloads.push({ id: delta.id, state: delta.state && delta.state.current }))
chrome.debugger.onDetach.addListener((source, reason) => void seen.detach.push(source.tabId + ':' + reason))

// ---- the walk ----

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && new URL(tab.url).pathname === '/surface-probe' && !globalThis.__probeStarted) {
    globalThis.__probeStarted = true
    const params = new URL(tab.url).searchParams
    const walk = params.has('isolation') ? isolation(Number(params.get('foreignTab')), Number(params.get('foreignGroup'))) : run(tabId, new URL(tab.url).origin, tab.windowId)
    walk.catch((error) => out('fatal', false, String(error)))
  }
})

/** Run in a second profile: what the first profile owns (a tab, a group) must be out of reach. */
async function isolation(foreignTab, foreignGroup) {
  await step('isolation.targets', async () => (await chrome.debugger.getTargets()).some((t) => t.tabId === foreignTab))
  await step('isolation.attach', () => chrome.debugger.attach({ tabId: foreignTab }, '1.3'))
  await step('isolation.group', () => chrome.tabs.group({ tabIds: [foreignTab] }))
  await step('isolation.ungroup', () => chrome.tabs.ungroup([foreignTab]))
  await step('isolation.groupsListed', async () => (await chrome.tabGroups.query({})).length)
  await step('isolation.groupGet', () => chrome.tabGroups.get(foreignGroup))
  await step('isolation.groupUpdate', () => chrome.tabGroups.update(foreignGroup, { title: 'hijacked' }))
  await step('isolation.tabsQuery', async () => (await chrome.tabs.query({})).some((t) => t.id === foreignTab))
  out('isolation-done', true, null)
}

async function waitUntil(predicate, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(100)
  }
  throw new Error('timeout: ' + label)
}

async function run(probeTab, origin, windowId) {
  let redirectUrl = null

  await step('surface', surface)
  await step('runtime.basics', () => {
    const url = chrome.runtime.getURL('x.html')
    if (url !== 'chrome-extension://' + chrome.runtime.id + '/x.html') throw new Error('bad getURL: ' + url)
    return { name: chrome.runtime.getManifest().name }
  })
  await step('runtime.contextType', () => ({ sidePanel: chrome.runtime.ContextType && chrome.runtime.ContextType.SIDE_PANEL, offscreen: chrome.runtime.ContextType && chrome.runtime.ContextType.OFFSCREEN_DOCUMENT }))

  // storage
  await step('storage.local', async () => {
    await chrome.storage.local.set({ probe: 'é' })
    return (await chrome.storage.local.get('probe')).probe
  })
  await step('storage.session', async () => {
    await chrome.storage.session.set({ probe: 2 })
    return (await chrome.storage.session.get('probe')).probe
  })
  await step('storage.managed', async () => {
    const keys = Object.keys(await chrome.storage.managed.get(null)).length
    const defaults = await chrome.storage.managed.get({ fallback: 7 })
    let writeRefused = false
    try {
      await chrome.storage.managed.set({ blockedUrlPatterns: ['*'] })
    } catch (error) {
      writeRefused = /read-only/i.test(error.message)
    }
    return { keys, defaults: defaults.fallback, writeRefused }
  })
  // The engine hands the install event over once the worker is up: how soon depends on the machine, so wait for it
  // (a missing event still fails by timeout), then leave a short grace period for an onStartup that must not come.
  await step('runtime.lifecycle', async () => {
    const kept = () => chrome.storage.local.get({ lifecycleInstalled: [], lifecycleStartups: 0 })
    await waitUntil(async () => (await kept()).lifecycleInstalled.length > 0, 10_000, 'runtime.onInstalled')
    await sleep(400)
    const { lifecycleInstalled, lifecycleStartups } = await kept()
    return { installed: lifecycleInstalled, startups: lifecycleStartups }
  })
  await step('storage.onChanged', async () => {
    await chrome.storage.local.set({ changed: Date.now() })
    await waitUntil(() => seen.storage.some((e) => e.startsWith('local:') && e.includes('changed')), 4000, 'storage.onChanged')
    return seen.storage[seen.storage.length - 1]
  })

  // alarms, action, commands
  await step('alarms', async () => {
    await chrome.alarms.create('probe', { delayInMinutes: 60 })
    const all = await chrome.alarms.getAll()
    return { count: all.length, cleared: await chrome.alarms.clear('probe') }
  })
  await step('alarms.onAlarm', async () => {
    await chrome.alarms.create('probe-soon', { when: Date.now() + 1500 })
    await waitUntil(() => seen.alarms > 0, 8000, 'alarms.onAlarm')
    return seen.alarms
  })
  await step('action', async () => {
    const settings = await chrome.action.getUserSettings()
    await chrome.action.setBadgeText({ text: '1' })
    await chrome.action.setBadgeBackgroundColor({ color: '#cc3300' })
    await chrome.action.setBadgeTextColor({ color: '#ffffff' })
    await chrome.action.setTitle({ title: 'probe title' })
    return { isOnToolbar: settings && settings.isOnToolbar }
  })
  await step('commands.getAll', async () => (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut })))

  // declarativeNetRequest session rules: modifyHeaders on a request made by the worker.
  await step('dnr.modifyHeaders', async () => {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: 7001,
          priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'x-surface-probe', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: '1' }] },
          condition: { urlFilter: origin + '/hdr', resourceTypes: ['xmlhttprequest', 'other'] }
        }
      ]
    })
    const headers = await (await fetch(origin + '/hdr')).json()
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [7001] })
    return { sawHeader: headers['x-surface-probe'] }
  })

  // downloads
  await step('downloads', async () => {
    const id = await chrome.downloads.download({ url: origin + '/surface-probe-download' })
    if (typeof id !== 'number') throw new Error('download() returned ' + typeof id)
    await waitUntil(() => seen.downloads.some((d) => d.id === id && d.state === 'complete'), 8000, 'downloads.onChanged complete')
    const found = await chrome.downloads.search({ id })
    return { id: typeof id, found: found.length, state: found[0] && found[0].state, filename: found[0] && found[0].filename ? found[0].filename.split('/').pop() : null }
  })

  // identity
  await step('identity.redirectUrl', () => {
    redirectUrl = chrome.identity.getRedirectURL('cb')
    if (!redirectUrl.startsWith('https://' + chrome.runtime.id + '.chromiumapp.org/')) throw new Error('bad redirect url: ' + redirectUrl)
    return redirectUrl
  })
  await step('identity.launchWebAuthFlow', async () => {
    const url = origin + '/fake-auth?redirect_uri=' + encodeURIComponent(redirectUrl) + '&state=s1'
    const result = await chrome.identity.launchWebAuthFlow({ url, interactive: true })
    return result
  })
  await step('identity.silent', async () => {
    const url = origin + '/fake-auth?redirect_uri=' + encodeURIComponent(redirectUrl) + '&state=s2'
    return await chrome.identity.launchWebAuthFlow({ url, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 5000 })
  })
  await step('identity.interactionRequired', async () => {
    try {
      await chrome.identity.launchWebAuthFlow({ url: origin + '/fake-login-page', interactive: false })
    } catch (error) {
      return 'rejected: ' + error.message
    }
    throw new Error('a page that never redirects must not resolve')
  })

  // notifications
  await step('notifications', async () => {
    const id = await chrome.notifications.create('probe-note', { type: 'basic', iconUrl: 'icon.png', title: 'Probe', message: 'Probe notification' })
    const cleared = await chrome.notifications.clear(id)
    return { id, cleared }
  })

  // offscreen documents
  await step('offscreen', async () => {
    const before = await chrome.offscreen.hasDocument()
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'probe' })
    const during = await chrome.offscreen.hasDocument()
    const contexts = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length
    const reply = await chrome.runtime.sendMessage({ type: 'ping-offscreen' })
    await chrome.offscreen.closeDocument()
    const after = await chrome.offscreen.hasDocument()
    return { before, during, contexts, reply: reply && reply.type, extensionId: reply && reply.extensionId === chrome.runtime.id, audio: reply && reply.audio, after }
  })

  // permissions
  await step('permissions', async () => ({
    nativeMessaging: await chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
    other: await chrome.permissions.contains({ permissions: ['bookmarks'] })
  }))

  // native messaging (the test registers a fake host; the real ones are never reachable from here)
  await step('native.connect', () =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative(HOST)
      const timer = setTimeout(() => reject(new Error('no reply from the host')), 6000)
      port.onMessage.addListener((message) => {
        clearTimeout(timer)
        resolve({ text: message.echo && message.echo.text, argv: message.argv, hasName: typeof port.name })
        port.disconnect()
      })
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        reject(new Error('disconnected: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no error')))
      })
      port.postMessage({ ping: 1, text: 'héllo ✓ 日本' })
    })
  )
  await step('native.sendMessage', async () => {
    const reply = await chrome.runtime.sendNativeMessage(HOST, { ping: 2 })
    return { ping: reply && reply.echo && reply.echo.ping }
  })
  await step('native.missingHost', () =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative(MISSING_HOST)
      const timer = setTimeout(() => reject(new Error('no disconnect')), 6000)
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no lastError')
      })
    })
  )
  await step('native.forbiddenHost', () =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative(FORBIDDEN_HOST)
      const timer = setTimeout(() => reject(new Error('no disconnect')), 6000)
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no lastError')
      })
    })
  )
  await step('native.hostExits', () =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative(HOST)
      const timer = setTimeout(() => reject(new Error('no disconnect')), 6000)
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no lastError')
      })
      port.postMessage({ cmd: 'exit' })
    })
  )
  await step('native.badArguments', async () => {
    try {
      chrome.runtime.connectNative(42)
    } catch (error) {
      return error.name
    }
    throw new Error('a host name that is not a string must be refused')
  })
  await step('native.oversize', () =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative(HOST)
      const timer = setTimeout(() => reject(new Error('no disconnect')), 6000)
      let delivered = false
      port.onMessage.addListener(() => void (delivered = true))
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        resolve({ delivered, message: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no lastError' })
      })
      port.postMessage({ cmd: 'oversize' })
    })
  )

  // scripting
  await step('scripting.executeScript', async () => {
    const [isolated] = await chrome.scripting.executeScript({ target: { tabId: probeTab }, func: () => document.title })
    const [main] = await chrome.scripting.executeScript({ target: { tabId: probeTab }, world: 'MAIN', func: () => typeof window.__probePage })
    return { title: isolated.result, main: main.result }
  })

  // content scripts
  await step('contentScript', async () => {
    await waitUntil(() => seen.cs.some((c) => c.tabId === probeTab), 5000, 'content script hello')
    const reply = await chrome.tabs.sendMessage(probeTab, { type: 'cs-ping' })
    return { pong: reply && reply.pong, mark: reply && reply.mark }
  })

  // externally_connectable: the page asks the worker (the page itself records its side in window.__external)
  await step('externalMessage', async () => {
    await waitUntil(() => seen.external.length > 0, 6000, 'onMessageExternal')
    return seen.external[0]
  })

  // A worker is not a tab: the API gives it no "current tab" (a panel tells itself from a tab page by that).
  await step('tabs.getCurrent', async () => String(await chrome.tabs.getCurrent()))

  // windows
  await step('windows', async () => {
    const current = await chrome.windows.getCurrent()
    const last = await chrome.windows.getLastFocused()
    const got = await chrome.windows.get(windowId)
    return { current: typeof current.id, last: typeof last.id, got: got.id === windowId }
  })

  // tabs and tab groups (an agent scopes itself to a group: the group must be real)
  const created = []
  await step('tabs.create', async () => {
    const a = await chrome.tabs.create({ url: origin + '/g1', active: false })
    const b = await chrome.tabs.create({ url: origin + '/g2', active: false, windowId })
    created.push(a.id, b.id)
    return { a: typeof a.id, b: b.windowId === windowId }
  })
  await step('tabs.createNewTabUrl', async () => {
    const tab = await chrome.tabs.create({ windowId, url: 'chrome://newtab', active: false })
    created.push(tab.id)
    return { id: typeof tab.id }
  })
  await step('tabGroups.group', async () => {
    const [a, b] = created
    const groupId = await chrome.tabs.group({ tabIds: [a], createProperties: { windowId } })
    await chrome.tabs.group({ tabIds: b, groupId })
    await chrome.tabGroups.update(groupId, { title: 'Probe', color: chrome.tabGroups.Color.ORANGE, collapsed: false })
    const group = await chrome.tabGroups.get(groupId)
    const queried = await chrome.tabGroups.query({ title: 'Probe' })
    const members = await chrome.tabs.query({ groupId })
    const fromGet = (await chrome.tabs.get(a)).groupId
    const ungrouped = await chrome.tabs.query({ groupId: chrome.tabGroups.TAB_GROUP_ID_NONE })
    globalThis.__groupId = groupId
    return {
      groupIdType: typeof groupId,
      title: group.title,
      color: group.color,
      windowOk: group.windowId === windowId,
      queried: queried.length,
      members: members.map((t) => t.id).sort().join(',') === [a, b].sort().join(','),
      getGroupId: fromGet === groupId,
      probePageUngrouped: ungrouped.some((t) => t.id === probeTab),
      noneIsMinusOne: chrome.tabGroups.TAB_GROUP_ID_NONE
    }
  })
  await step('tabGroups.ungroup', async () => {
    const [a, b] = created
    const groupId = globalThis.__groupId
    await chrome.tabs.ungroup([b])
    const afterOne = (await chrome.tabs.get(b)).groupId
    const remaining = (await chrome.tabs.query({ groupId })).length
    await chrome.tabs.ungroup(a)
    let gone = false
    try {
      await chrome.tabGroups.get(groupId)
    } catch (error) {
      gone = true
    }
    await waitUntil(() => seen.groupEvents.some((e) => e.startsWith('onRemoved')), 3000, 'tabGroups.onRemoved')
    return { memberGroupId: afterOne, remaining, groupGoneWhenEmpty: gone, events: seen.groupEvents.map((e) => e.split(':')[0]).join(',') }
  })
  await step('tabs.captureVisibleTab', async () => {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    // The size is in the PNG header: width and height are the two 32-bit numbers after the 8-byte signature and the chunk name.
    const header = atob(dataUrl.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 44))
    const word = (at) => (header.charCodeAt(at) << 24) | (header.charCodeAt(at + 1) << 16) | (header.charCodeAt(at + 2) << 8) | header.charCodeAt(at + 3)
    const jpeg = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 })
    return { prefix: dataUrl.slice(0, 22), width: word(16), height: word(20), jpegPrefix: jpeg.slice(0, 23) }
  })
  await step('tabs.navigate', async () => {
    const [a] = created
    // The events are told by their address: the tab was opened in the background a moment ago and may still be loading its first page, whose end
    // would otherwise be taken for the end of this navigation.
    const target = origin + '/g3'
    const ofTarget = () => seen.navigated.filter((e) => e.tabId === a && e.url === target)
    await chrome.tabs.update(a, { url: target })
    await waitUntil(() => ofTarget().some((e) => e.event === 'onCompleted' && e.frameId === 0), 8000, 'webNavigation.onCompleted')
    const events = ofTarget().map((e) => e.event).join(',')
    const frames = await chrome.webNavigation.getAllFrames({ tabId: a })
    await chrome.tabs.reload(a)
    return { events, frames: frames.length }
  })
  await step('windows.createRemove', async () => {
    const created = await chrome.windows.create({ url: origin + '/popup', type: 'popup', width: 420, height: 320 })
    const id = created.id
    await chrome.windows.update(id, { focused: true })
    await sleep(600)
    const moved = await chrome.windows.update(id, { left: 40, top: 50, width: 700, height: 500 })
    await chrome.windows.remove(id)
    return { id: typeof id, width: moved.width, height: moved.height, left: moved.left, top: moved.top }
  })
  await step('tabs.history', async () => {
    const [a] = created
    const before = (await chrome.tabs.get(a)).url
    await chrome.tabs.update(a, { url: origin + '/g4' })
    await waitUntil(async () => (await chrome.tabs.get(a)).url.endsWith('/g4'), 6000, 'navigation to /g4')
    await chrome.tabs.goBack(a)
    await waitUntil(async () => (await chrome.tabs.get(a)).url === before, 6000, 'goBack')
    await chrome.tabs.goForward(a)
    await waitUntil(async () => (await chrome.tabs.get(a)).url.endsWith('/g4'), 6000, 'goForward')
    return 'back and forward'
  })
  // A tab whose page is still loading (a picture of it never comes) is sent to another address: the call answers with the tab, as Chrome answers
  // it, and the load the new address ends is not an error of the extension.
  await step('tabs.updateWhileLoading', async () => {
    const tab = await chrome.tabs.create({ url: origin + '/still-loading', active: false })
    created.push(tab.id)
    const reached = (event, path) => seen.navigated.some((e) => e.tabId === tab.id && e.frameId === 0 && e.event === event && e.url === origin + path)
    await waitUntil(() => reached('onCommitted', '/still-loading'), 6000, 'the page that keeps loading is shown')
    const updated = await chrome.tabs.update(tab.id, { url: origin + '/g5' })
    await waitUntil(() => reached('onCompleted', '/g5'), 6000, 'the address the tab was sent to has loaded')
    return { answered: updated === undefined ? 'nothing' : updated.id === tab.id }
  })

  // options page
  await step('runtime.openOptionsPage', async () => {
    await chrome.runtime.openOptionsPage()
    await waitUntil(async () => (await chrome.tabs.query({})).some((t) => (t.url || '').endsWith('/options.html')), 4000, 'options tab')
    return 'opened'
  })

  // debugger: the way an agent sees and drives a page
  await step('debugger', async () => {
    const target = { tabId: probeTab }
    await chrome.debugger.attach(target, '1.3')
    const result = {}
    try {
      const targets = await chrome.debugger.getTargets()
      result.listed = targets.some((t) => t.tabId === probeTab)
      let evalEvents = 0
      chrome.debugger.onEvent.addListener((source, method) => {
        if (source.tabId === probeTab && method === 'Runtime.consoleAPICalled') evalEvents++
      })
      await chrome.debugger.sendCommand(target, 'Runtime.enable')
      result.evaluate = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: '6 * 7', returnByValue: true })).result.value
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'console.log("probe-event")' })
      const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' })
      result.screenshotBytes = shot.data.length
      const rect = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("b").getBoundingClientRect())', returnByValue: true })).result.value
      const box = JSON.parse(rect)
      const x = Math.round(box.x + box.width / 2)
      const y = Math.round(box.y + box.height / 2)
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      result.clicks = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'window.__clicks || 0', returnByValue: true })).result.value
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.getElementById("i").focus()' })
      for (const text of ['o', 'k']) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', text, key: text })
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: text })
      }
      result.typed = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.getElementById("i").value', returnByValue: true })).result.value
      result.layout = typeof (await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')).cssVisualViewport
      await waitUntil(() => evalEvents > 0, 3000, 'debugger.onEvent')
      result.events = evalEvents > 0
    } finally {
      await chrome.debugger.detach(target)
    }
    return result
  })

  // side panel, last: it stays open for the test to inspect and close
  await step('sidePanel', async () => {
    chrome.sidePanel.setOptions({ tabId: probeTab, path: 'panel.html?tabId=' + probeTab, enabled: true })
    await chrome.sidePanel.open({ tabId: probeTab })
    await waitUntil(() => seen.panelOpened.includes(probeTab), 6000, 'panel page loaded')
    const contexts = await chrome.runtime.getContexts({})
    return contexts.filter((c) => c.documentUrl && c.documentUrl.includes('/panel.html')).map((c) => c.contextType)
  })
  await step('runtime.connect', async () => {
    await waitUntil(() => seen.portReplies.length > 0, 5000, 'port reply')
    return { ports: seen.ports, reply: seen.portReplies[0] }
  })

  // A group that outlives the walk, for the test of a second profile to try to reach.
  await step('tabGroups.keep', async () => {
    const groupId = await chrome.tabs.group({ tabIds: [probeTab] })
    await chrome.tabGroups.update(groupId, { title: 'kept' })
    return groupId
  })

  // A native port that stays open for a moment: the worker must be held awake for as long as it is.
  await step('native.keep', async () => {
    const port = chrome.runtime.connectNative(HOST)
    port.onDisconnect.addListener(() => console.warn('probe: the kept native port was closed by the host'))
    setTimeout(() => port.disconnect(), 3000)
    return 'open'
  })

  // created tabs are closed so that later checks start clean
  await step('tabs.remove', async () => {
    await chrome.tabs.remove(created)
    return created.length
  })
  out('done', true, null)
}
