// A driver for the engine test (`smokeMv2Blocking`, src/main/smoke-mv2-blocking.ts). Each blocking listener acts on one path under /mv2bp/ of the
// test's own server, and lets every other request go: the answers the engine must apply, and the ones it must refuse.
const BASE = '/mv2bp/'
const pathOf = (details) => new URL(details.url).pathname

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const path = pathOf(details)
    if (path === `${BASE}cancel`) return { cancel: true }
    if (path === `${BASE}redirect-from`) return { redirectUrl: details.url.replace('/redirect-from', '/redirect-to') }
    // Refused by the engine: a listener never sends a request to a local file.
    if (path === `${BASE}redirect-file`) return { redirectUrl: 'file:///etc/hosts' }
    // An answer that comes after the time the engine gives (a promise, which the engine waits for like a returned answer): the request must go on without it.
    if (path === `${BASE}late`) return new Promise((resolve) => setTimeout(() => resolve({ cancel: true }), 3000))
    return undefined
  },
  { urls: ['http://127.0.0.1/mv2bp/*'] },
  ['blocking']
)

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (pathOf(details) !== `${BASE}request-headers`) return undefined
    const requestHeaders = details.requestHeaders.filter((header) => header.name.toLowerCase() !== 'x-mv2bp-remove')
    requestHeaders.push({ name: 'X-Mv2bp-Added', value: 'from the listener' })
    return { requestHeaders }
  },
  { urls: ['http://127.0.0.1/mv2bp/*'] },
  ['blocking', 'requestHeaders']
)

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (pathOf(details) !== `${BASE}response-headers`) return undefined
    const responseHeaders = details.responseHeaders.filter((header) => header.name.toLowerCase() !== 'x-mv2bp-server')
    responseHeaders.push({ name: 'X-Mv2bp-Answer', value: 'from the listener' })
    return { responseHeaders }
  },
  { urls: ['http://127.0.0.1/mv2bp/*'] },
  ['blocking', 'responseHeaders']
)
