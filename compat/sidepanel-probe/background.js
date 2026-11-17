// Every line of evidence goes out as a console warning the engine smoke test collects.
const say = (name, value) => console.warn(`SIDEPANEL_PROBE_${name} ${value}`)

say('SURFACE', JSON.stringify({
  sidePanel: typeof chrome.sidePanel?.open,
  tabGroupsQuery: typeof chrome.tabGroups?.query,
  tabGroupColor: chrome.tabGroups?.Color?.BLUE,
  tabGroupNone: chrome.tabGroups?.TAB_GROUP_ID_NONE,
  debuggerAttach: typeof chrome.debugger?.attach,
  tabsGroup: typeof chrome.tabs?.group
}))

chrome.sidePanel.setOptions({ path: 'panel.html', enabled: true })
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
chrome.sidePanel.getPanelBehavior().then((b) => say('BEHAVIOR', JSON.stringify(b)))
chrome.tabGroups.query({}).then((groups) => say('GROUPS', JSON.stringify(groups)))

chrome.runtime.onMessage.addListener((message) => say('MESSAGE', message?.from))

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return
  if (tab.url.endsWith('/dbg')) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1 + 1' })
      say('DEBUGGER', result.result.value)
      await chrome.debugger.detach({ tabId })
    } catch (error) {
      say('DEBUGGER_ERROR', error.message)
    }
  }
  if (tab.url.endsWith('/panel')) {
    try {
      await chrome.sidePanel.open({ tabId })
      say('OPENED', 'yes')
    } catch (error) {
      say('OPEN_ERROR', error.message)
    }
  }
})
