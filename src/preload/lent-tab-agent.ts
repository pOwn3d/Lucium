// The worker of an extension, for the script the extension injected into a tab the user lent it with a click (shared/lent-tab-runtime.ts). That script has no way to the worker of its own: the
// main process carries what it asks (a message for the listeners of `chrome.runtime.onMessage`, a call of `chrome.storage`) to the worker over the bridge of the shims, and this is what
// answers there, with the browser's own APIs: the real listeners of the extension are called, the real storage is read and written. It also tells the main process when the storage
// changes, so that the scripts that listen are told. This runs in the main world of the service worker only (a page of the extension has its own listeners and no one asks it), in the second
// pass of the shims, after `fixSenderTabs` has put the listeners of the messages where this can reach them. Self-contained on purpose: Electron serializes it.

export function answerLentTabs(noReceiver: string, portClosed: string, tooLong: string, answerMax: number): void {
  const g = globalThis as unknown as { chrome?: any; __luciumShim?: any; __luciumMessageListeners?: () => Array<(...args: unknown[]) => unknown>; __luciumLentAgent?: boolean }
  const chrome = g.chrome
  const bridge = g.__luciumShim
  const listenersOf = g.__luciumMessageListeners
  if (typeof document !== 'undefined' || !chrome || !bridge || !chrome.runtime || typeof chrome.runtime.id !== 'string' || typeof listenersOf !== 'function' || g.__luciumLentAgent) return
  const manifest = typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest() : null
  const permissions: string[] = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : []
  // Only an extension that can be lent a tab can have such a script.
  if (!permissions.includes('activeTab') || !permissions.includes('scripting')) return
  g.__luciumLentAgent = true
  const extensionId: string = chrome.runtime.id
  const reasonOf = (error: any): string => String((error && error.message) || error)
  const tell = (method: string, args: unknown[]): void => {
    bridge.call(extensionId, 'lentTab', method, args).catch((error: any) => console.warn(`[lucium] the main process did not take what a script of a lent tab asked (${method}):`, reasonOf(error)))
  }

  // What is answered is of any size, and it is received by the main process whole, then written out and copied to the page: an answer longer than is handed over is replaced here, in the worker
  // (the extension's own process), by an error. The main process measures what it receives again; this is what keeps it from receiving the most of what a worker of the usual kind sends.
  const bounded = (answer: unknown): unknown => {
    try {
      const text = JSON.stringify(answer)
      return typeof text === 'string' && text.length > answerMax ? { ok: false, error: tooLong } : answer
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  // The listeners of the extension register while its script runs: a worker started for this message may not have run them yet.
  const listenersReady = async (): Promise<Array<(...args: unknown[]) => unknown>> => {
    const deadline = Date.now() + 3000
    while (listenersOf().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    return listenersOf()
  }

  // A message of the script of a tab, as the extension platform gives one to the listeners of the worker: the sender is the extension, the page and the real tab.
  const dispatchMessage = async (ask: { tabId?: unknown; sender?: Record<string, unknown>; message?: unknown }): Promise<unknown> => {
    const listeners = await listenersReady()
    if (listeners.length === 0) return { ok: false, error: noReceiver }
    let tab: unknown
    try {
      tab = typeof ask.tabId === 'number' && chrome.tabs ? await chrome.tabs.get(ask.tabId) : undefined
    } catch (error) {
      console.warn('[lucium] the tab of a script that wrote to the worker could not be read, so its message has no tab:', reasonOf(error))
    }
    const sender = tab ? { ...ask.sender, tab } : ask.sender
    return new Promise((resolve) => {
      let over = false
      let open = false
      const finish = (answer: unknown): void => {
        if (over) return
        over = true
        resolve(answer)
      }
      const respond = (value?: unknown): void => finish(value === undefined ? { ok: true } : { ok: true, value })
      for (const listener of listeners) {
        try {
          // The listener that returns true will answer later; the others, once they have all run without an answer, leave the port closed.
          if (listener(ask.message, sender, respond) === true) open = true
        } catch (error) {
          console.error('Error in event handler:', error)
        }
      }
      if (!open) finish({ ok: false, error: portClosed })
    })
  }

  const runStorage = async (ask: { area?: unknown; method?: unknown; args?: unknown }): Promise<unknown> => {
    // The main process only passes these, and they are the only ones asked again here: no name from the page's side reaches anything else of the storage.
    const area = (ask.area === 'local' || ask.area === 'sync') && chrome.storage ? chrome.storage[ask.area] : undefined
    const method = typeof ask.method === 'string' && ['get', 'set', 'remove', 'clear', 'getBytesInUse'].includes(ask.method) ? ask.method : ''
    if (!area || method === '' || typeof area[method] !== 'function') return { ok: false, error: `chrome.storage.${String(ask.area)}.${String(ask.method)} is not available.` }
    try {
      return { ok: true, value: await area[method](...(Array.isArray(ask.args) ? ask.args : [])) }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  bridge.onEvent((api: string, name: string, args: unknown[]) => {
    if (api !== 'lentTab' || name !== 'ask' || !Array.isArray(args) || typeof args[0] !== 'string') return
    const id = args[0]
    const run = args[1] === 'message' ? dispatchMessage((args[2] ?? {}) as Record<string, unknown>) : args[1] === 'storage' ? runStorage((args[2] ?? {}) as Record<string, unknown>) : Promise.resolve({ ok: false, error: 'This request is not one the worker answers.' })
    run.then(
      (result) => tell('answer', [id, bounded(result)]),
      (error) => tell('answer', [id, { ok: false, error: reasonOf(error) }])
    )
  })

  // The scripts that listen to the storage are told of its changes, by the main process: here is where they are seen.
  if (permissions.includes('storage') && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener((changes: unknown, area: unknown) => {
      if (area === 'local' || area === 'sync') tell('changed', [changes, area])
    })
  }
}
