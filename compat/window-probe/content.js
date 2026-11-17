// Answers chrome.tabs.sendMessage with where it runs: the test reads which tab (and so which profile) was reached.
document.documentElement.dataset.windowProbe = chrome.runtime.id
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'where') reply({ extension: chrome.runtime.id, href: location.href })
})
