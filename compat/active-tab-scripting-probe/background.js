// The commonest shape of a Manifest V3 extension: activeTab and scripting, no host permission. A click on its icon runs a script in the tab; the
// engine test (`smokeProbesExt`) also asks it to run the same script with no click, through a local page, and reads back what each try gave.
// It also asks what a script injected in the isolated world after the click has of the extension (the runtime, the storage, a message in each
// direction): an extension that injects its overlay on demand needs them, and a content script declared in a manifest has them.
const clicks = []

const inject = (tabId) =>
  chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }).then(
    (results) => ({ ok: true, value: results?.[0]?.result ?? null }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )

// What runs in the page. Self-contained: its text is what the page is handed. It answers what the script has of the extension, then does each thing a
// script injected on demand does with it: asks the worker something, writes to the storage, and listens for a message of the worker.
const probeRuntime = async () => {
  const seen = { hasChrome: typeof chrome !== 'undefined' }
  if (!seen.hasChrome) return seen
  seen.runtimeId = typeof chrome.runtime?.id === 'string' ? chrome.runtime.id : typeof chrome.runtime?.id
  seen.storage = typeof chrome.storage
  seen.onMessage = typeof chrome.runtime?.onMessage
  seen.sendMessage = typeof chrome.runtime?.sendMessage
  try {
    seen.roundTrip = await chrome.runtime.sendMessage({ type: 'tab-ping', from: 'the injected script' })
  } catch (error) {
    seen.roundTripError = String(error?.message ?? error)
  }
  try {
    await chrome.storage.local.set({ 'probe-key': 'written by the tab' })
    seen.storageBack = (await chrome.storage.local.get('probe-key'))['probe-key']
  } catch (error) {
    seen.storageError = String(error?.message ?? error)
  }
  try {
    if (!globalThis.__probeListening) {
      globalThis.__probeListening = true
      chrome.runtime.onMessage.addListener((message, sender, reply) => {
        if (message?.type !== 'to-tab') return undefined
        reply({ ok: true, heard: message.value, title: document.title, senderId: sender?.id ?? null })
        return undefined
      })
    }
    seen.listening = true
  } catch (error) {
    seen.listenError = String(error?.message ?? error)
  }
  return seen
}

const injectRuntime = (tabId) =>
  chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: probeRuntime }).then(
    (results) => ({ ok: true, value: results?.[0]?.result ?? null }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )

// What the worker heard from a script of a tab (`runtime.onMessage`), for the engine test to compare with the tab it injected into.
const heard = []
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'tab-ping') return undefined
  heard.push({ tabId: sender?.tab?.id ?? null, frameId: sender?.frameId ?? null, url: sender?.url ?? null, id: sender?.id ?? null })
  reply({ ok: true, tabId: sender?.tab?.id ?? null })
  return undefined
})

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id
  clicks.push({ tabId: tabId ?? null, hasUrl: typeof tab?.url === 'string', inject: typeof tabId === 'number' ? await inject(tabId) : { ok: false, error: 'the click came with no tab' } })
})

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') {
    reply({ ok: true })
    return
  }
  if (message?.type === 'clicks') {
    reply(clicks.slice())
    return
  }
  if (message?.type === 'inject') {
    inject(message.tabId).then(reply)
    return true
  }
  if (message?.type === 'inject-runtime') {
    injectRuntime(message.tabId).then(reply)
    return true
  }
  // The other direction: the worker sends a message to the script it injected, and hands back what the script answered.
  if (message?.type === 'tell') {
    chrome.tabs.sendMessage(message.tabId, { type: 'to-tab', value: message.value }).then(
      (answer) => reply({ ok: true, value: answer ?? null }),
      (error) => reply({ ok: false, error: String(error?.message ?? error) })
    )
    return true
  }
  if (message?.type === 'heard') {
    reply(heard.slice())
    return
  }
  if (message?.type === 'stored') {
    chrome.storage.local.get('probe-key').then(
      (items) => reply({ ok: true, value: items['probe-key'] ?? null }),
      (error) => reply({ ok: false, error: String(error?.message ?? error) })
    )
    return true
  }
})
