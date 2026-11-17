// The worker of the probe: what it does with a tab, and in which order, is told by the page that drives the suite (smokeActiveTabOrigin).
//  - `run` asks for one script or one style sheet in a tab;
//  - `race` sends the tab to `url` and, without waiting for it, asks `burst` times for the same thing: the calls reach the engine while the tab is
//    between two documents, which is when a script that was judged on the first one can end up in the second (`delay` pauses before the calls);
//  - `burst` makes the calls alone, for a tab that leaves by itself;
//  - `last` answers what the calls of the last `race` or `burst` got (null until they have all been answered): the page that asked is gone by then.
const STYLE = 'html { outline: 7px solid rgb(1, 2, 3) !important }'

// What a script of the probe does in a document: it marks it with its origin and answers its text. Serialized by the browser: no free variable.
const stamp = () => {
  document.documentElement.setAttribute('data-lent-ran', location.origin)
  return document.body ? document.body.innerText : null
}

const outcome = (promise) =>
  promise.then(
    (results) => ({ ok: true, value: Array.isArray(results) ? (results[0]?.result ?? null) : null }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )

/** One call to chrome.scripting, by name: `func`, `file`, `css`, `css-file`, `remove-css`. */
const attempt = ({ tabId, how, world, origin }) => {
  const target = { tabId }
  switch (how) {
    case 'func':
      return outcome(chrome.scripting.executeScript({ target, world, func: stamp }))
    case 'file':
      return outcome(chrome.scripting.executeScript({ target, world, files: ['stamp.js'] }))
    case 'css':
      return outcome(chrome.scripting.insertCSS({ target, css: STYLE, origin }))
    case 'css-file':
      return outcome(chrome.scripting.insertCSS({ target, files: ['stamp.css'], origin }))
    case 'remove-css':
      return outcome(chrome.scripting.removeCSS({ target, css: STYLE, origin }))
    default:
      return Promise.resolve({ ok: false, error: `unknown call ${how}` })
  }
}

/** What the calls of the last `race` or `burst` got: null while they are being answered. */
let last = null

const burstOf = (message) => Math.max(1, Math.min(32, Number(message.burst) || 1))

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') {
    reply({ ok: true })
    return
  }
  if (message?.type === 'run') {
    attempt(message).then(reply)
    return true
  }
  if (message?.type === 'last') {
    reply(last)
    return
  }
  if (message?.type === 'burst') {
    // The tab goes elsewhere by itself (the page does it, or a server redirect does): only the calls are made, many at once. The page that asked may be gone before the
    // answer: it is told at once that the calls are made, and what they got is kept for `last`.
    last = null
    reply({ started: true })
    Promise.all(Array.from({ length: burstOf(message) }, () => attempt(message))).then((results) => {
      last = { moved: null, results }
    })
    return
  }
  if (message?.type === 'race') {
    last = null
    reply({ started: true })
    // The tab is sent away first; nothing waits for it. If the browser refuses to send it, `last` says so: a race that never took place proves nothing.
    const moved = chrome.tabs.update(message.tabId, { url: message.url }).then(
      () => null,
      (error) => String(error?.message ?? error)
    )
    // A pause before the calls moves them along the time the tab takes to change documents: no one pause is the moment, so the suite tries several.
    const pause = Math.max(0, Math.min(500, Number(message.delay) || 0))
    const calls = pause > 0 ? new Promise((resolve) => setTimeout(resolve, pause)) : Promise.resolve()
    calls
      .then(() => Promise.all(Array.from({ length: burstOf(message) }, () => attempt(message))))
      .then(async (results) => {
        last = { moved: await moved, results }
      })
  }
})
