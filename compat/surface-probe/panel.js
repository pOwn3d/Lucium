// Side panel of the probe. Like an agent panel, it tells the worker it is open and closes itself when asked to.
const tabId = Number(new URLSearchParams(location.search).get('tabId'))
chrome.runtime.sendMessage({ type: 'PANEL_OPENED', tabId }).catch((error) => console.warn('probe panel: PANEL_OPENED failed', error))
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'close_side_panel' && message.tabId === tabId) window.close()
})

// A long-lived port to the worker, the way a panel talks to its extension's worker.
const port = chrome.runtime.connect({ name: 'probe-port' })
port.onMessage.addListener((message) => chrome.runtime.sendMessage({ type: 'PORT_REPLY', message }).catch((error) => console.warn('probe panel: PORT_REPLY failed', error)))
port.postMessage('hello')
