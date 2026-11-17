// A driver for the engine test (`smokeExtensions2`): a local page asks the worker to call an extension API and gets the answer back. `call` goes
// through the `chrome.*` object as an extension's own code does (so it shows whether the namespace exists); `raw` goes straight to Lucium's
// bridge, as code that ignores the namespace would, so that only the main process stands between it and the data.
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
    Promise.resolve()
      .then(() => target.apply(owner, message.args ?? []))
      .then(
        (value) => reply({ ok: true, value: value === undefined ? null : value }),
        (error) => reply({ ok: false, error: String(error?.message ?? error) })
      )
    return true
  }
  if (message?.type === 'raw') {
    globalThis.__luciumShim.call(chrome.runtime.id, message.api, message.method, message.args ?? []).then(
      (value) => reply({ ok: true, value: value === undefined ? null : value }),
      (error) => reply({ ok: false, error: String(error?.message ?? error) })
    )
    return true
  }
  if (message?.type === 'typeof') {
    reply(Object.fromEntries(message.paths.map((path) => [path, typeof resolvePath(path).target])))
  }
})
