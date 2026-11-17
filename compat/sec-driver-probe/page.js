// A page of the extension that opens a native port the way a panel does. The engine test closes the tab and checks that the host does
// not outlive the page.
const params = new URLSearchParams(location.search)
const host = params.get('host')
if (host) {
  const port = chrome.runtime.connectNative(host)
  port.onMessage.addListener((message) => {
    document.title = `native:${message?.pid ?? 'none'}`
  })
  port.onDisconnect.addListener(() => {
    document.title = `native-closed:${chrome.runtime.lastError?.message ?? ''}`
  })
  port.postMessage({ hello: 'from a page' })
}
