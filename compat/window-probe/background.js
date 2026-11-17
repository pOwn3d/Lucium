// A driver for the engine test (`smokeExtWindows`): a local page asks the worker to call an extension API and gets the answer back, and the worker
// keeps a log of the events it was told about, so that the test can see which profile an event reached.
const events = []
const note = (name, ...args) => events.push({ name, args: JSON.parse(JSON.stringify(args)) })

function resolvePath(path) {
  let owner = chrome
  let target = chrome
  for (const part of String(path).split('.')) {
    owner = target
    target = target?.[part]
  }
  return { owner, target }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'probe-page', title: chrome.runtime.getManifest().name, contexts: ['page'] }, () => void chrome.runtime.lastError)
})
chrome.contextMenus.onClicked.addListener((info, tab) => note('contextMenus.onClicked', info.menuItemId, tab?.id, tab?.windowId))
chrome.notifications.onClicked.addListener((id) => note('notifications.onClicked', id))
chrome.action.onClicked.addListener((tab) => note('action.onClicked', tab?.id, tab?.windowId))
chrome.windows.onFocusChanged.addListener((id) => note('windows.onFocusChanged', id))
chrome.tabs.onActivated.addListener((info) => note('tabs.onActivated', info.tabId, info.windowId))

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message?.type === 'call') {
    const { owner, target } = resolvePath(message.path)
    if (typeof target !== 'function') {
      reply({ ok: false, error: `${message.path} is ${typeof target}` })
      return
    }
    Promise.resolve()
      .then(() => target.apply(owner, message.args ?? []))
      .then(
        (value) => reply({ ok: true, value: value === undefined ? null : value }),
        (error) => reply({ ok: false, error: String(error?.message ?? error) })
      )
    return true
  }
  if (message?.type === 'events') {
    reply({ ok: true, value: events })
    return
  }
  if (message?.type === 'sender') {
    reply({ ok: true, value: { tab: sender.tab ? { id: sender.tab.id, windowId: sender.tab.windowId } : null } })
  }
})
