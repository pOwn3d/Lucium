// A driver for the engine test (`smokeSec2`): a local page asks the worker to call an extension API and gets the result back. The extension
// declares no permission, so what comes back is what such an extension is given. The shim bridge is listened to as well: no event of an
// API it did not declare may reach it.
const log = []
let offscreenReport = null

globalThis.__luciumShim?.onEvent((api, name) => log.push({ shimEvent: `${api}.${name}` }))

function resolvePath(path) {
  let owner = chrome
  let target = chrome
  for (const part of String(path).split('.')) {
    owner = target
    target = target?.[part]
  }
  return { owner, target }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'offscreen-report') offscreenReport = message.results
})

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'call') {
    const { owner, target } = resolvePath(message.path)
    if (typeof target !== 'function') {
      reply({ ok: false, error: `${message.path} is ${typeof target}` })
      return
    }
    Promise.resolve()
      .then(() => target.apply(owner, message.args ?? []))
      .then(
        (value) => reply({ ok: true, value: value === undefined ? null : value, undefined: value === undefined }),
        (error) => reply({ ok: false, error: String(error?.message ?? error) })
      )
    return true
  }
  if (message?.type === 'typeof') {
    reply(Object.fromEntries(message.paths.map((path) => [path, typeof resolvePath(path).target])))
    return
  }
  if (message?.type === 'log') {
    reply(log.splice(0))
    return
  }
  if (message?.type === 'offscreen') {
    offscreenReport = null
    chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' })
      .then(
        async () => {
          const deadline = Date.now() + 8000
          while (!offscreenReport && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
          await chrome.offscreen.closeDocument().catch(() => {})
          reply({ ok: true, value: offscreenReport })
        },
        (error) => reply({ ok: false, error: String(error?.message ?? error) })
      )
    return true
  }
})
