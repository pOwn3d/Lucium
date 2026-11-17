// Prints one `API_PROBE {...}` warning line per run; the engine smoke test collects it.
// "present" = the function or event exists. "calls" = the call also succeeds when invoked for real.

const SURFACE = {
  runtime: ['sendMessage', 'getURL', 'onMessage', 'onInstalled', 'onStartup', 'getManifest'],
  storage: ['local', 'sync', 'session', 'onChanged'],
  tabs: ['query', 'get', 'create', 'update', 'remove', 'reload', 'sendMessage', 'discard', 'duplicate', 'move', 'captureVisibleTab', 'group', 'ungroup',
    'onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onAttached', 'onDetached', 'onMoved'],
  windows: ['getCurrent', 'getAll', 'create', 'update', 'get', 'onRemoved', 'onFocusChanged'],
  tabGroups: ['query', 'get', 'update', 'move', 'onCreated', 'onUpdated', 'onRemoved'],
  alarms: ['create', 'get', 'clear', 'onAlarm'],
  scripting: ['executeScript', 'insertCSS', 'registerContentScripts', 'getRegisteredContentScripts', 'unregisterContentScripts'],
  declarativeNetRequest: ['updateDynamicRules', 'getDynamicRules', 'updateEnabledRulesets', 'getEnabledRulesets', 'getMatchedRules'],
  contextMenus: ['create', 'remove', 'removeAll', 'onClicked'],
  notifications: ['create', 'clear', 'onClicked'],
  downloads: ['download', 'search', 'onCreated'],
  offscreen: ['createDocument', 'closeDocument', 'hasDocument'],
  omnibox: ['onInputChanged', 'onInputEntered', 'setDefaultSuggestion'],
  cookies: ['get', 'getAll', 'set', 'remove', 'onChanged'],
  history: ['search', 'deleteUrl', 'deleteAll'],
  browsingData: ['remove', 'removeCookies'],
  debugger: ['attach', 'detach', 'sendCommand', 'onEvent'],
  webNavigation: ['onCompleted', 'onCommitted', 'onBeforeNavigate'],
  webRequest: ['onBeforeRequest', 'onHeadersReceived'],
  idle: ['queryState', 'onStateChanged'],
  system: ['memory'],
  management: ['getAll', 'getSelf'],
  bookmarks: ['getTree', 'create'],
  sessions: ['getRecentlyClosed', 'restore'],
  topSites: ['get'],
  action: ['setBadgeText', 'setIcon', 'onClicked'],
  sidePanel: ['open', 'setOptions']
}

const present = [], missing = []
for (const [ns, members] of Object.entries(SURFACE)) {
  const api = globalThis.chrome?.[ns]
  if (!api) { missing.push(ns); continue }
  for (const member of members) (api[member] === undefined ? missing : present).push(`${ns}.${member}`)
}

const attempt = async (name, fn) => {
  try { await fn(); return [name, 'ok'] } catch (error) { return [name, `error: ${String(error?.message ?? error).slice(0, 90)}`] }
}

async function main() {
const calls = Object.fromEntries(await Promise.all([
  attempt('storage.local set/get', async () => { await chrome.storage.local.set({ probe: 1 }); if ((await chrome.storage.local.get('probe')).probe !== 1) throw new Error('value lost') }),
  attempt('storage.session set/get', async () => { await chrome.storage.session.set({ probe: 1 }); await chrome.storage.session.get('probe') }),
  attempt('alarms.create/get', async () => { await chrome.alarms.create('probe', { delayInMinutes: 60 }); if (!(await chrome.alarms.get('probe'))) throw new Error('alarm not found') }),
  attempt('tabs.query({})', async () => { const tabs = await chrome.tabs.query({}); if (!Array.isArray(tabs)) throw new Error('not an array') }),
  attempt('tabs.create+remove', async () => { const t = await chrome.tabs.create({ url: 'about:blank', active: false }); await chrome.tabs.remove(t.id) }),
  attempt('tabs.discard', async () => { const [t] = await chrome.tabs.query({}); await chrome.tabs.discard(t?.id) }),
  attempt('windows.getCurrent', async () => { await chrome.windows.getCurrent() }),
  attempt('scripting.registerContentScripts', async () => { await chrome.scripting.registerContentScripts([{ id: 'probe', matches: ['https://example.invalid/*'], js: ['background.js'] }]); await chrome.scripting.unregisterContentScripts({ ids: ['probe'] }) }),
  attempt('declarativeNetRequest.updateDynamicRules', async () => { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'probe-blocked.js', resourceTypes: ['script'] } }] }) }),
  attempt('contextMenus.create', async () => { chrome.contextMenus.create({ id: 'probe', title: 'probe', contexts: ['page'] }) }),
  attempt('offscreen.createDocument', async () => { await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' }); await chrome.offscreen.closeDocument() }),
  attempt('cookies.getAll', async () => { await chrome.cookies.getAll({}) }),
  attempt('system.memory.getInfo', async () => { await chrome.system.memory.getInfo() })
]))

console.warn('API_PROBE ' + JSON.stringify({ present: present.length, missing, calls }))
}

main().catch((error) => console.warn('API_PROBE ' + JSON.stringify({ fatal: String(error) })))
