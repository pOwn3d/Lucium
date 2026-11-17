// An extension that holds nothing by its manifest and asks for the rest: a permission (bookmarks) and a site (127.0.0.1), both optional. The engine
// test (`smokeProbesExt`) drives it through a local page: it asks, gives back, and reports what chrome.permissions says and what it can really do.
const events = []
chrome.permissions.onAdded.addListener((added) => events.push({ event: 'added', permissions: added.permissions ?? [], origins: added.origins ?? [] }))
chrome.permissions.onRemoved.addListener((removed) => events.push({ event: 'removed', permissions: removed.permissions ?? [], origins: removed.origins ?? [] }))

const said = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )

// What the extension can do now, beyond what chrome.permissions answers: read the address of a tab, and call the API of the optional permission.
const state = async (tabId) => {
  const tab = typeof tabId === 'number' ? await said(chrome.tabs.get(tabId)) : { ok: false, error: 'no tab asked for' }
  return {
    containsPermission: await said(chrome.permissions.contains({ permissions: ['bookmarks'] })),
    containsOrigin: await said(chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })),
    all: await said(chrome.permissions.getAll()),
    tabUrl: tab.ok ? (typeof tab.value?.url === 'string' ? 'read' : 'hidden') : `failed: ${tab.error}`,
    bookmarks: typeof chrome.bookmarks?.getTree === 'function' ? await said(chrome.bookmarks.getTree().then(() => 'answered')) : { ok: false, error: 'chrome.bookmarks is not defined' },
    events: events.slice()
  }
}

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') {
    reply({ ok: true })
    return
  }
  if (message?.type === 'state') {
    state(message.tabId).then(reply)
    return true
  }
  if (message?.type === 'request') {
    said(chrome.permissions.request(message.what)).then(reply)
    return true
  }
  if (message?.type === 'remove') {
    said(chrome.permissions.remove(message.what)).then(reply)
    return true
  }
})
