// Content script of the probe: marks the document and answers the service worker.
document.documentElement.dataset.surfaceProbe = 'content-script'
chrome.runtime.sendMessage({ type: 'cs-hello', href: location.href }).catch((error) => console.warn('probe content script: hello failed', error))
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'cs-ping') {
    reply({ pong: true, mark: document.documentElement.dataset.surfaceProbe, title: document.title })
  }
})
