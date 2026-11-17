// A driver for the engine test (`smokeSec2`): a local page asks the worker to call an extension API and gets the result back; the events the
// worker hears (debugger, downloads, tab groups) are kept for the test to read.
const log = []

globalThis.__luciumShim?.onEvent((api, name) => log.push({ shimEvent: `${api}.${name}` }))
chrome.debugger.onDetach.addListener((source, reason) => log.push({ event: 'debugger.onDetach', tabId: source.tabId, reason }))
chrome.downloads?.onCreated.addListener((item) => log.push({ event: 'downloads.onCreated', url: item.url }))

function resolvePath(path) {
  let owner = chrome
  let target = chrome
  for (const part of String(path).split('.')) {
    owner = target
    target = target?.[part]
  }
  return { owner, target }
}

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'call') {
    const { owner, target } = resolvePath(message.path)
    if (typeof target !== 'function') {
      reply({ ok: false, error: `${message.path} is ${typeof target}` })
      return
    }
    const started = Date.now()
    Promise.resolve()
      .then(() => target.apply(owner, message.args ?? []))
      .then(
        (value) => reply({ ok: true, value: value === undefined ? null : value, undefined: value === undefined, ms: Date.now() - started }),
        (error) => reply({ ok: false, error: String(error?.message ?? error), ms: Date.now() - started })
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
})
