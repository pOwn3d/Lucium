// A driver for the engine test (`smokeKeyExt`): it keeps what the command bar tells it through chrome.omnibox, and a local page reads the log.
// `started` and `entered` are the events of the API; `changed` must never be written (no suggestions are asked for).
// It also answers the question of the site access of extensions: what chrome.permissions says after its own host permission was taken back.
const log = []

chrome.omnibox.onInputStarted.addListener(() => log.push({ event: 'started' }))
chrome.omnibox.onInputChanged.addListener((text) => log.push({ event: 'changed', text }))
chrome.omnibox.onInputEntered.addListener((text, disposition) => log.push({ event: 'entered', text, disposition }))
chrome.omnibox.onInputCancelled.addListener(() => log.push({ event: 'cancelled' }))
chrome.omnibox.setDefaultSuggestion({ description: 'Probe %s' })

const ORIGINS = ['http://127.0.0.1/*']

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'log') {
    reply(log.splice(0))
    return
  }
  if (message?.type === 'surface') {
    reply({
      omnibox: typeof chrome.omnibox,
      started: typeof chrome.omnibox.onInputStarted?.addListener,
      entered: typeof chrome.omnibox.onInputEntered?.addListener,
      setDefaultSuggestion: typeof chrome.omnibox.setDefaultSuggestion,
      disposition: chrome.omnibox.OnInputEnteredDisposition ?? null
    })
    return
  }
  if (message?.type === 'withhold') {
    // What the "on click" site access does: take the host permission back. Answers what the API says before and after.
    ;(async () => {
      const before = await chrome.permissions.contains({ origins: ORIGINS }).catch((error) => `error: ${error?.message ?? error}`)
      const removed = await chrome.permissions.remove({ origins: ORIGINS }).catch((error) => `error: ${error?.message ?? error}`)
      const after = await chrome.permissions.contains({ origins: ORIGINS }).catch((error) => `error: ${error?.message ?? error}`)
      reply({ before, removed, after })
    })()
    return true
  }
})
