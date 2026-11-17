// What an extension that declared only activeTab sees of a tab, before it is invoked, right after, and a few seconds later once the tab has
// gone elsewhere. Each moment is a console warning `ACTIVE_TAB {...}` for the engine test (`smokeSec2`); the invocation is the keyboard
// shortcut of the command above.
const out = (name, value) => console.warn('ACTIVE_TAB ' + JSON.stringify({ name, value }))

async function observe(label, tabId) {
  const tab = await chrome.tabs.get(tabId).catch((error) => ({ error: String(error?.message ?? error) }))
  const fromQuery = (await chrome.tabs.query({ active: true }).catch(() => [])).map((t) => ({ id: t.id, hasUrl: 'url' in t, hasTitle: 'title' in t }))
  const capture = await chrome.tabs.captureVisibleTab().then(
    (data) => ({ ok: String(data).startsWith('data:image/png') }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )
  out(label, { hasUrl: 'url' in tab, hasTitle: 'title' in tab, query: fromQuery, capture })
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'probe-activate' || !tab) return
  out('command', { hasUrl: typeof tab.url === 'string', url: tab.url })
  await observe('invoked', tab.id)
  // The test sends the tab elsewhere in the meantime.
  setTimeout(() => void observe('later', tab.id), 3500)
})

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message?.type !== 'observe') return
  chrome.tabs.query({ active: true }).then(async (tabs) => {
    const id = tabs[0]?.id
    await observe(message.label ?? 'before', id)
    reply({ ok: true })
  })
  return true
})
