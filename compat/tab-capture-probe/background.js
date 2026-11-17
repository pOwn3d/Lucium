// The worker of the tab capture probe. A page the engine check drives (http://127.0.0.1) sends it messages (externally_connectable) and gets what the
// extension platform answered; the invocation of the extension on a tab (the click on its icon) is the keyboard shortcut of the command above, which the
// engine check fires. The sound is read in an offscreen document, as a captions extension does.
//   { type: 'id', tabId }          -> chrome.tabCapture.getMediaStreamId({ targetTabId }): { ok, id } or { ok: false, error }
//   { type: 'captured' }           -> chrome.tabCapture.getCapturedTabs()
//   { type: 'listen', id }         -> the offscreen document asks getUserMedia for the sound of the tab with that identifier
//   { type: 'native' }             -> the offscreen document asks for a microphone, a camera and a screen, and says how each request ended
//   { type: 'peak', ms }           -> the highest level it heard in `ms` milliseconds
//   { type: 'state' } / 'release'  -> what the tracks are doing / stops them
chrome.commands.onCommand.addListener(() => {})

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (contexts.length > 0) return
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Listen to the sound of a tab' })
}

const say = (error) => String((error && error.message) || error)

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  ;(async () => {
    try {
      if (message.type === 'id') return reply({ ok: true, id: await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }) })
      if (message.type === 'captured') return reply({ ok: true, tabs: await chrome.tabCapture.getCapturedTabs() })
      await ensureOffscreen()
      reply(await chrome.runtime.sendMessage({ target: 'offscreen', ...message }))
    } catch (error) {
      reply({ ok: false, error: say(error) })
    }
  })()
  return true
})
