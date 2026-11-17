// Offscreen document of the probe: proves it runs with extension APIs and can be reached by runtime messages.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'ping-offscreen') return false
  reply({ type: 'pong-offscreen', extensionId: chrome.runtime.id, audio: typeof Audio, blob: typeof Blob, visible: document.visibilityState })
  return false
})
