// An offscreen document runs without context isolation, so Lucium's own layer (which hides the APIs the extension did not declare) is
// not injected into it: the namespaces the extension library defines for everyone are all there, and only the main process stands
// between this page and the data. Each call is made for real; what it gets back is reported to the worker.
const results = {}
const attempt = async (name, fn) => {
  try {
    const value = await fn()
    results[name] = { returned: value === undefined ? 'undefined' : JSON.stringify(value).slice(0, 400) }
  } catch (error) {
    results[name] = { threw: String(error?.message ?? error) }
  }
}

async function main() {
  results.visible = { cookies: typeof chrome.cookies, webNavigation: typeof chrome.webNavigation, contextMenus: typeof chrome.contextMenus, notifications: typeof chrome.notifications }
  await attempt('cookies.getAll', () => chrome.cookies.getAll({}))
  await attempt('cookies.getAllUrl', () => chrome.cookies.getAll({ url: 'http://127.0.0.1/' }))
  await attempt('cookies.get', () => chrome.cookies.get({ url: 'http://127.0.0.1/', name: 'sec2-session' }))
  await attempt('cookies.set', () => chrome.cookies.set({ url: 'http://127.0.0.1/', name: 'sec2-planted', value: 'x' }))
  await attempt('webNavigation.getAllFrames', async () => {
    const [first] = (await chrome.tabs.query({})) ?? []
    return chrome.webNavigation.getAllFrames({ tabId: first?.id ?? 1 })
  })
  await attempt('contextMenus.create', () => chrome.contextMenus.removeAll())
  await attempt('notifications.getAll', () => chrome.notifications.getAll())
  await attempt('tabs.insertCSS', async () => {
    const [first] = (await chrome.tabs.query({})) ?? []
    return chrome.tabs.insertCSS(first?.id ?? 1, { code: 'body { display: none }' })
  })
  await attempt('tabs.query', async () => ((await chrome.tabs.query({})) ?? []).map((tab) => Object.keys(tab).filter((key) => ['url', 'pendingUrl', 'title', 'favIconUrl'].includes(key))))
  await attempt('windows.getAll', async () => ((await chrome.windows.getAll()) ?? []).flatMap((window) => (window.tabs ?? []).map((tab) => Object.keys(tab).filter((key) => ['url', 'title'].includes(key)))))
  chrome.runtime.sendMessage({ type: 'offscreen-report', results })
}

main().catch((error) => chrome.runtime.sendMessage({ type: 'offscreen-report', results: { fatal: String(error?.message ?? error) } }))
