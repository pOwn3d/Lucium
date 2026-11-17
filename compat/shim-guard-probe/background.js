// An extension that declared only "storage" (and "tabs", to see the address of the page that starts it) goes for every API Lucium defines itself, the polite way (the namespace is absent)
// and the rude way (calling the bridge of the shims directly). Each result is a console warning `SHIM_GUARD {...}` for the engine test.
const out = (name, ok, value) => console.warn('SHIM_GUARD ' + JSON.stringify({ name, ok, value }))

async function refused(name, api, method, args) {
  try {
    await globalThis.__luciumShim.call(chrome.runtime.id, api, method, args)
    out(name, false, 'the call was allowed')
  } catch (error) {
    out(name, /no permission/i.test(String(error.message)), String(error.message))
  }
}

async function run() {
  out('namespaces', true, {
    sidePanel: typeof chrome.sidePanel,
    tabGroups: typeof chrome.tabGroups,
    debugger: typeof chrome.debugger,
    identity: typeof chrome.identity,
    tabsGroup: typeof chrome.tabs.group,
    tabsCapture: typeof chrome.tabs.captureVisibleTab,
    connectNative: typeof chrome.runtime.connectNative,
    downloadsDownload: typeof chrome.downloads?.download
  })
  await refused('debugger', 'debugger', 'getTargets', [])
  await refused('tabGroups', 'tabGroups', 'query', [{}])
  await refused('tabs.group', 'tabs', 'group', [{ tabIds: [1] }])
  await refused('tabs.captureVisibleTab', 'tabs', 'captureVisibleTab', [])
  await refused('sidePanel', 'sidePanel', 'getOptions', [{}])
  await refused('identity', 'identity', 'launchWebAuthFlow', [{ url: 'http://127.0.0.1/', interactive: false }])
  await refused('nativeMessaging', 'nativeMessaging', 'sendMessage', ['com.example.host', {}])
  await refused('downloads', 'downloads', 'search', [{}])
  await refused('unknown api', 'fs', 'readFile', ['/etc/passwd'])
  out('done', true, null)
}

// Started by a page of the test server, so that the test is listening when the results come.
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && new URL(tab.url).pathname === '/shim-guard' && !globalThis.__guardStarted) {
    globalThis.__guardStarted = true
    run().catch((error) => out('fatal', false, String(error)))
  }
})
