document.title = 'panel-ok'
document.getElementById('m').textContent = `chrome.runtime.id = ${chrome.runtime.id}`
chrome.runtime.sendMessage({ from: 'panel' })
