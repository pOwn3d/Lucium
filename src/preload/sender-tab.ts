// What an extension is told about the tab a message comes from. The extension API gives it `sender.tab` for a content script (and for an extension page shown in a tab), with the tab as
// it is: its window, its place, whether it is the active one. Two things differ here, and extensions are written for that API:
//  1. A popup, a side panel or an offscreen document is not a tab, but its messages carry a made-up one (an id `chrome.tabs` does not list). Merci answers "the tab"
//     instead of the popup, which then shows the signed-out screen to a signed-in user.
//  2. The tab of a content script is a made-up one too: window 0, index 0, never active, never highlighted. Dashlane reads `sender.tab.highlighted || sender.tab.active`,
//     is told the tab is not the one on screen, and its page never looks for forms to fill.
// This runs in the main world of an extension service worker or page, in the second pass of the shims (when `chrome` is frozen, the libraries being done). It keeps a
// picture of the real tabs (what `chrome.tabs.query` answers, renewed when tabs change) and wraps the listeners of the message events so that they are handed a sender
// whose tab is the real one, read at the moment the listener looks at it, or no tab at all for a page that is not in one. Self-contained on purpose: Electron serializes it.

export function fixSenderTabs(): void {
  const g = globalThis as unknown as { chrome?: any; __luciumSenderFixed?: boolean; __luciumMessageListeners?: () => Array<(...args: unknown[]) => unknown> }
  const chrome = g.chrome
  const runtime = chrome && chrome.runtime
  if (!runtime || typeof runtime.id !== 'string' || runtime.id === '' || !Object.isFrozen(chrome) || g.__luciumSenderFixed) return
  g.__luciumSenderFixed = true
  const own = `chrome-extension://${runtime.id}/`

  // ---- the real tabs ----
  const LIVE = ['windowId', 'index', 'active', 'highlighted', 'pinned', 'selected', 'status', 'audible', 'discarded', 'autoDiscardable', 'groupId', 'favIconUrl', 'width', 'height', 'mutedInfo']
  const known = new Map<number, Record<string, unknown>>()
  // The tabs announced by `tabs.onCreated` since the list was read: a page of the extension that opens in a tab (its options page) sends its first message before the list is
  // read again, and must not be taken for a popup because the list does not have its tab yet.
  const created = new Set<number>()
  const tabsApi = chrome.tabs
  let dirty = true
  let loading = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const load = (): void => {
    if (loading || !tabsApi || typeof tabsApi.query !== 'function') return
    loading = true
    dirty = false
    Promise.resolve(tabsApi.query({}))
      .then(
        (list: any[]) => {
          known.clear()
          for (const tab of list || []) {
            created.delete(tab.id)
            const row: Record<string, unknown> = {}
            for (const key of LIVE) if (key in tab) row[key] = tab[key]
            known.set(tab.id, row)
          }
        },
        (error: unknown) => console.warn('[lucium] the list of tabs could not be read for the senders of messages:', error)
      )
      .finally(() => {
        loading = false
        if (dirty) schedule()
      })
  }
  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      load()
    }, 20)
  }
  const touch = (): void => {
    dirty = true
    schedule()
  }
  try {
    if (tabsApi && tabsApi.onCreated && typeof tabsApi.onCreated.addListener === 'function') {
      tabsApi.onCreated.addListener((tab: { id?: unknown }) => {
        if (tab && typeof tab.id === 'number') created.add(tab.id)
      })
    }
    for (const name of ['onCreated', 'onRemoved', 'onActivated', 'onHighlighted', 'onAttached', 'onDetached', 'onMoved', 'onReplaced']) {
      const event = tabsApi && tabsApi[name]
      if (event && typeof event.addListener === 'function') event.addListener(touch)
    }
    if (tabsApi && tabsApi.onUpdated && typeof tabsApi.onUpdated.addListener === 'function') {
      tabsApi.onUpdated.addListener((_id: unknown, change: Record<string, unknown>) => {
        if (change && ('status' in change || 'pinned' in change || 'discarded' in change || 'audible' in change || 'groupId' in change)) touch()
      })
    }
  } catch (error) {
    console.warn('[lucium] the changes of tabs could not be followed for the senders of messages:', error)
  }
  load()

  // The tab of a sender, with the fields of the real tab read when they are asked for (a listener usually reads them after something awaited). They are properties that
  // are worked out when read, so that a copy of the tab or its JSON carries the real values too.
  const view = (tab: any): any => {
    const out: any = { ...tab }
    for (const key of LIVE) {
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: true,
        get: () => {
          const row = known.get(tab.id)
          return row && key in row ? row[key] : tab[key]
        }
      })
    }
    return out
  }

  // A page of the extension whose "tab" is not among the real ones is a popup, a panel or an offscreen document: the API gives it no tab. (Before the first list has come,
  // nothing is known, and a page of the extension with no window is taken for one: the made-up tab always has window id 0.)
  const clean = (sender: any): any => {
    const tab = sender && sender.tab
    if (!tab) return sender
    const real = known.has(tab.id) || created.has(tab.id)
    if (typeof sender.url === 'string' && sender.url.startsWith(own) && tab.windowId < 1 && !real) {
      const { tab: _pseudo, ...rest } = sender
      return rest
    }
    if (!real || dirty) touch()
    return { ...sender, tab: view(tab) }
  }

  /** The listeners of the event as the browser holds them (the wrappers), for whoever has to call them itself: the script of a lent tab writes to the worker that way (preload/lent-tab-agent.ts). */
  const wrapEvent = (event: any, adapt: (listener: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): Map<unknown, unknown> | undefined => {
    if (!event || typeof event.addListener !== 'function') return undefined
    const wrappers = new Map<unknown, unknown>()
    const add = event.addListener
    const remove = event.removeListener
    const has = event.hasListener
    event.addListener = function (this: unknown, listener: unknown, ...rest: unknown[]) {
      if (typeof listener !== 'function') return add.call(this, listener, ...rest)
      let wrapper = wrappers.get(listener)
      if (!wrapper) {
        wrapper = adapt(listener as (...args: unknown[]) => unknown)
        wrappers.set(listener, wrapper)
      }
      return add.call(this, wrapper, ...rest)
    }
    if (typeof remove === 'function') {
      event.removeListener = function (this: unknown, listener: unknown, ...rest: unknown[]) {
        const wrapper = wrappers.get(listener)
        // A listener taken off is let go of: an extension that adds and removes listeners in a loop must not keep every one of them alive.
        wrappers.delete(listener)
        return remove.call(this, wrapper ?? listener, ...rest)
      }
    }
    if (typeof has === 'function') {
      event.hasListener = function (this: unknown, listener: unknown) {
        return has.call(this, wrappers.get(listener) ?? listener)
      }
    }
    return wrappers
  }

  const forMessage = (listener: (...args: unknown[]) => unknown) =>
    function (this: unknown, message: unknown, sender: unknown, sendResponse: unknown) {
      return listener.call(this, message, clean(sender), sendResponse)
    }
  const forConnect = (listener: (...args: unknown[]) => unknown) =>
    function (this: unknown, port: any) {
      if (port && port.sender) {
        try {
          Object.defineProperty(port, 'sender', { value: clean(port.sender), configurable: true })
        } catch (error) {
          console.warn('[lucium] the tab of a port could not be corrected:', error)
        }
      }
      return listener.call(this, port)
    }

  const messageListeners = wrapEvent(runtime.onMessage, forMessage)
  if (messageListeners) g.__luciumMessageListeners = () => [...messageListeners.values()] as Array<(...args: unknown[]) => unknown>
  wrapEvent(runtime.onMessageExternal, forMessage)
  wrapEvent(runtime.onConnect, forConnect)
  wrapEvent(runtime.onConnectExternal, forConnect)
}
