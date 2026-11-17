// What runs in the isolated world of the extension, in a tab the user lent it with a click (shared/lent-tab-runtime.ts): the few things of `chrome` that a script injected on
// demand needs, made over the bridge of the tab (preload/lent-tab.ts). Self-contained on purpose: the preload serializes this function and runs it in that world, so it reads
// nothing outside itself and is handed everything in `init`.

export interface LentRuntimeInit {
  extensionId: string
  /** The manifest of the extension, as its worker reads it (`chrome.runtime.getManifest`). */
  manifest: unknown
  /** The permissions it holds: `chrome.storage` exists for the one that declared "storage". */
  permissions: string[]
  bridgeKey: string
  runtimeKey: string
  noReceiver: string
  portClosed: string
}

export function installLentRuntime(init: LentRuntimeInit): void {
  const g = globalThis as any
  const bridge = g[init.bridgeKey]
  // Once for each document: a second script of the same extension finds the first one's listeners where it left them, as in a content script.
  if (!bridge || typeof bridge.call !== 'function' || g[init.runtimeKey]) return
  const extensionId = init.extensionId
  const chrome = g.chrome && typeof g.chrome === 'object' ? g.chrome : (g.chrome = {})
  const manifestText = JSON.stringify(init.manifest ?? {})

  // The IPC layer prefixes the text of an error ("Error invoking remote method…"): the script reads the words the extension platform gives.
  const reasonOf = (error: any): string => String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const ask = (op: string, payload: unknown): Promise<any> =>
    new Promise((resolve) => resolve(bridge.call(op, JSON.stringify(payload)))).then(
      (text: any) => {
        const answer = JSON.parse(String(text))
        if (!answer.ok) throw new Error(answer.error)
        return answer.value
      },
      (error: any) => {
        throw new Error(reasonOf(error))
      }
    )

  const runtime: any = {}
  // An extension API answers with a promise, or hands its result to a trailing callback and reports a failure through `chrome.runtime.lastError`.
  const settle = (promise: Promise<unknown>, callback: unknown): Promise<unknown> | undefined => {
    if (typeof callback !== 'function') return promise
    promise.then(
      (value) => void callback(value),
      (error: any) => {
        runtime.lastError = { message: reasonOf(error) }
        try {
          callback()
        } finally {
          delete runtime.lastError
        }
      }
    )
    return undefined
  }
  const makeEvent = (): any => {
    const listeners = new Set<(...args: unknown[]) => unknown>()
    return {
      listeners,
      addListener: (listener: unknown) => {
        if (typeof listener === 'function') listeners.add(listener as (...args: unknown[]) => unknown)
      },
      removeListener: (listener: unknown) => void listeners.delete(listener as (...args: unknown[]) => unknown),
      hasListener: (listener: unknown) => listeners.has(listener as (...args: unknown[]) => unknown),
      hasListeners: () => listeners.size > 0
    }
  }

  const onMessage = makeEvent()
  runtime.id = extensionId
  runtime.getURL = (path: unknown) => `chrome-extension://${extensionId}/${String(path ?? '').replace(/^\/+/, '')}`
  runtime.getManifest = () => JSON.parse(manifestText)
  runtime.onMessage = onMessage
  runtime.sendMessage = function sendMessage(...args: unknown[]): Promise<unknown> | undefined {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
    // The first argument names another extension when a message follows it; this one speaks to its own only.
    const target = typeof args[0] === 'string' && args.length >= 2 ? args.shift() : undefined
    if (args[0] === undefined) throw new TypeError('Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function callback): No matching signature.')
    const sent = target !== undefined && target !== extensionId ? Promise.reject(new Error('Lucium: a script injected after a click can only write to its own extension.')) : ask('send', { message: args[0] })
    return settle(sent, callback)
  }
  runtime.connect = function connect(): never {
    throw new Error('Lucium: runtime.connect is not provided to a script injected after a click. Declare the script in content_scripts of the manifest to have ports.')
  }
  Object.defineProperty(chrome, 'runtime', { value: runtime, configurable: true, enumerable: true, writable: true })

  const storageChanged = makeEvent()
  const areas: Record<string, any> = {}
  if (init.permissions.indexOf('storage') >= 0) {
    const makeArea = (name: string): any => {
      const run = (method: string) =>
        function (...args: unknown[]): Promise<unknown> | undefined {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
          return settle(ask('storage', { area: name, method, args }), callback)
        }
      return { get: run('get'), set: run('set'), remove: run('remove'), clear: run('clear'), getBytesInUse: run('getBytesInUse'), onChanged: makeEvent() }
    }
    areas['local'] = makeArea('local')
    areas['sync'] = makeArea('sync')
    Object.defineProperty(chrome, 'storage', { value: { local: areas['local'], sync: areas['sync'], onChanged: storageChanged }, configurable: true, enumerable: true, writable: true })
  }

  const fire = (event: any, args: unknown[]): void => {
    for (const listener of [...event.listeners]) {
      try {
        listener(...args)
      } catch (error) {
        console.error('Error in event handler:', error)
      }
    }
  }

  // What the main process hands over: a message of the worker (the answer is what a listener sends back), or a change of the storage.
  const deliver = (text: unknown): Promise<string> => {
    let payload: any
    try {
      payload = JSON.parse(String(text))
    } catch (error) {
      return Promise.resolve(JSON.stringify({ ok: false, error: `The main process handed over text that is not JSON: ${reasonOf(error)}` }))
    }
    if (payload && payload.kind === 'changed') {
      if (areas[payload.area]) {
        fire(storageChanged, [payload.changes, payload.area])
        fire(areas[payload.area].onChanged, [payload.changes])
      }
      return Promise.resolve(JSON.stringify({ ok: true }))
    }
    if (!payload || payload.kind !== 'message') return Promise.resolve(JSON.stringify({ ok: false, error: 'The main process handed over something this script cannot take.' }))
    return new Promise((resolve) => {
      const listeners = [...onMessage.listeners]
      if (listeners.length === 0) return resolve(JSON.stringify({ ok: false, error: init.noReceiver }))
      let over = false
      let open = false
      const finish = (answer: unknown): void => {
        if (over) return
        over = true
        try {
          resolve(JSON.stringify(answer))
        } catch (error) {
          resolve(JSON.stringify({ ok: false, error: `The answer cannot be sent: ${reasonOf(error)}` }))
        }
      }
      const respond = (value?: unknown): void => finish(value === undefined ? { ok: true } : { ok: true, value })
      for (const listener of listeners) {
        try {
          // A listener that returns true will answer later; one that does not, and has not answered, has no more to say.
          if (listener(payload.message, payload.sender, respond) === true) open = true
        } catch (error) {
          console.error('Error in event handler:', error)
        }
      }
      if (!open) finish({ ok: false, error: init.portClosed })
    }).then((text) => String(text))
  }
  Object.defineProperty(g, init.runtimeKey, { value: { deliver }, configurable: true, enumerable: false, writable: false })
}
