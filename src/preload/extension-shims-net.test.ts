// What the shims do for the request rules, the request listeners and the scripts of a lent tab (extension-shims.ts): the rules an extension
// registers with the browser are copied to the main process, which applies them; the listeners of chrome.webRequest are fed by the main process;
// a script the browser refuses on a lent tab is handed to the main process. The function the preload injects is run for real, against a
// made-up `chrome`, in its two passes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }
const g = globalThis as Record<string, any>

async function injected(): Promise<() => void> {
  vi.resetModules()
  g['__luciumBridged'] = undefined
  contextBridge.executeInMainWorld.mockReset()
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
  proc.type = 'service-worker'
  proc.contextIsolated = true
  await import('./extension-shims')
  const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
  return () => call.func(...call.args)
}

type EventListener = (api: string, name: string, args: unknown[]) => void

/** A worker of an extension with this manifest: the browser's own chrome.declarativeNetRequest, chrome.webRequest and chrome.scripting, as far as the shims call them. */
async function worker(permissions: string[], more: { scripting?: (injection: unknown) => Promise<unknown>; updateFails?: string; manifestVersion?: number; sendMessage?: (...args: unknown[]) => Promise<unknown> } = {}) {
  const held = { session: [] as unknown[], dynamic: [{ id: 9 }] as unknown[] }
  const nativeRules = {
    getSessionRules: vi.fn(async () => held.session),
    getDynamicRules: vi.fn(async () => held.dynamic),
    updateSessionRules: vi.fn(async (options: { addRules?: unknown[] }) => {
      if (more.updateFails) throw new Error(more.updateFails)
      held.session = options.addRules ?? []
    }),
    updateDynamicRules: vi.fn(async (options: { addRules?: unknown[] }) => void (held.dynamic = options.addRules ?? [])),
    getEnabledRulesets: vi.fn(async () => []),
    updateEnabledRulesets: vi.fn(async () => undefined)
  }
  const nativeEvent = { addListener: vi.fn() }
  const webRequest: Record<string, unknown> = { onBeforeRequest: nativeEvent, onCompleted: nativeEvent }
  const scripting = { executeScript: vi.fn(more.scripting ?? (async () => [{ result: 'native' }])), insertCSS: vi.fn(async () => undefined), removeCSS: vi.fn(async () => undefined) }
  const nativeScript = scripting.executeScript
  const sendMessage = vi.fn(more.sendMessage ?? (async () => 'native'))
  const chrome: Record<string, any> = { runtime: { id: ID, getManifest: () => ({ manifest_version: more.manifestVersion ?? 3, permissions }) }, declarativeNetRequest: { ...nativeRules }, webRequest, scripting, storage: {}, tabs: { sendMessage } }
  const listeners: EventListener[] = []
  const bridge = { call: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), onEvent: vi.fn((listener: EventListener) => void listeners.push(listener)) }
  g['chrome'] = chrome
  g['__luciumShim'] = bridge
  const run = await injected()
  run()
  Object.freeze(chrome)
  run()
  const calls = (api: string, method: string): unknown[][] => bridge.call.mock.calls.filter((call) => call[1] === api && call[2] === method).map((call) => call[3] as unknown[])
  const tell = (name: string, details: Record<string, unknown>): void => listeners.forEach((listener) => listener('webRequest', name, [details]))
  /** The main process asks this context about a request: the event carries the token its blocking listeners answer with. */
  const ask = (name: string, details: Record<string, unknown>, token: string): void => listeners.forEach((listener) => listener('webRequest', name, [details, { ask: token }]))
  return { chrome, bridge, nativeRules, nativeEvent, nativeScript, nativeSend: sendMessage, calls, tell, ask }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['__luciumShim']
  vi.restoreAllMocks()
})

describe('the request rules of an extension', () => {
  it('the worker hands the rules the browser holds to the main process when it starts: the dynamic ones outlive the browser', async () => {
    const { calls } = await worker(['declarativeNetRequest'])
    await settle()
    expect(calls('declarativeNetRequest', 'mirror')).toEqual([[{ session: [], dynamic: [{ id: 9 }] }]])
  })

  it('getMatchedRules is asked of the main process', async () => {
    const { chrome, bridge } = await worker(['declarativeNetRequest', 'declarativeNetRequestFeedback'])
    bridge.call.mockResolvedValueOnce({ rulesMatchedInfo: [] })
    expect(await chrome.declarativeNetRequest.getMatchedRules({ tabId: 3 })).toEqual({ rulesMatchedInfo: [] })
    expect(bridge.call).toHaveBeenCalledWith(expect.any(String), 'declarativeNetRequest', 'getMatchedRules', [{ tabId: 3 }])
  })

  it('a change of the rules is registered with the browser first, then copied to the main process as the browser holds it', async () => {
    const { chrome, nativeRules, calls } = await worker(['declarativeNetRequestWithHostAccess'])
    await settle()
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1 }] })
    expect(nativeRules.updateSessionRules).toHaveBeenCalledWith({ addRules: [{ id: 1 }] })
    expect(calls('declarativeNetRequest', 'mirror').at(-1)).toEqual([{ session: [{ id: 1 }], dynamic: [{ id: 9 }] }])
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [] })
    expect(calls('declarativeNetRequest', 'mirror').at(-1)).toEqual([{ session: [{ id: 1 }], dynamic: [] }])
  })

  it('a change the browser refuses is refused to the extension in the browser\'s words, and nothing is copied', async () => {
    const { chrome, calls } = await worker(['declarativeNetRequest'], { updateFails: 'Rule with id 1 does not have a unique ID.' })
    await settle()
    const copies = calls('declarativeNetRequest', 'mirror').length
    await expect(chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1 }, { id: 1 }] })).rejects.toThrow('does not have a unique ID')
    expect(calls('declarativeNetRequest', 'mirror')).toHaveLength(copies)
  })

  it('a copy the main process does not take is said in the console of the extension, and the change still succeeds', async () => {
    const { chrome, bridge } = await worker(['declarativeNetRequest'])
    await settle()
    bridge.call.mockRejectedValueOnce(new Error('the main process is busy'))
    await expect(chrome.declarativeNetRequest.updateSessionRules({ addRules: [] })).resolves.toBeUndefined()
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('could not be handed to the browser')
  })

  it('the static rulesets are answered for by the main process, with a promise or a callback', async () => {
    const { chrome, bridge, nativeRules, calls } = await worker(['declarativeNetRequest'])
    bridge.call.mockImplementation(async (_id, _api, method) => (method === 'getEnabledRulesets' ? ['main'] : undefined))
    expect(await chrome.declarativeNetRequest.getEnabledRulesets()).toEqual(['main'])
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['extra'] })
    expect(calls('declarativeNetRequest', 'updateEnabledRulesets')).toEqual([[{ enableRulesetIds: ['extra'] }]])
    expect(nativeRules.getEnabledRulesets).not.toHaveBeenCalled()
    const viaCallback = await new Promise((resolve) => chrome.declarativeNetRequest.getEnabledRulesets(resolve))
    expect(viaCallback).toEqual(['main'])
  })

  it('an extension without the permission keeps the browser\'s own API, untouched', async () => {
    const { chrome, nativeRules, calls } = await worker(['storage'])
    await settle()
    expect(chrome.declarativeNetRequest.updateSessionRules).toBe(nativeRules.updateSessionRules)
    expect(calls('declarativeNetRequest', 'mirror')).toEqual([])
  })
})

describe('the listeners of chrome.webRequest', () => {
  it('a listener is registered with the main process, the first of a context that starts saying so, and never with the browser', async () => {
    const { chrome, nativeEvent, calls } = await worker(['webRequest'])
    chrome.webRequest.onCompleted.addListener(() => undefined, { urls: ['https://x.example/*'], types: ['script'] })
    chrome.webRequest.onBeforeRequest.addListener(() => undefined, { urls: ['<all_urls>'] }, ['requestBody'])
    expect(calls('webRequest', 'listen')).toEqual([
      ['onCompleted', { urls: ['https://x.example/*'], types: ['script'], tabId: undefined }, [], true],
      ['onBeforeRequest', { urls: ['<all_urls>'], types: undefined, tabId: undefined }, ['requestBody'], false]
    ])
    expect(nativeEvent.addListener).not.toHaveBeenCalled()
  })

  it('a listener hears the requests its own filter covers, with the headers only if it asked for them', async () => {
    const { chrome, tell } = await worker(['webRequest'])
    const scripts = vi.fn()
    const everything = vi.fn()
    const oneTab = vi.fn()
    chrome.webRequest.onCompleted.addListener(scripts, { urls: ['https://*.example/app/*'], types: ['script'] })
    chrome.webRequest.onCompleted.addListener(everything, { urls: ['<all_urls>'] }, ['responseHeaders'])
    chrome.webRequest.onCompleted.addListener(oneTab, { urls: ['*://x.example/*'], tabId: 5 })
    await settle()
    tell('onCompleted', { url: 'https://x.example/app/a.js', type: 'script', tabId: 4, responseHeaders: [{ name: 'a', value: 'b' }] })
    tell('onCompleted', { url: 'https://x.example/other/a.js', type: 'script', tabId: 5 })
    tell('onCompleted', { url: 'https://example/app/a.png', type: 'image', tabId: 4 })
    tell('onCompleted', { url: 'https://x.other.org/app/a.js', type: 'script', tabId: 4 })
    tell('onBeforeRequest', { url: 'https://x.example/app/a.js', type: 'script', tabId: 4 })
    expect(scripts.mock.calls.map(([details]) => details)).toEqual([{ url: 'https://x.example/app/a.js', type: 'script', tabId: 4 }])
    expect(everything).toHaveBeenCalledTimes(4)
    expect(everything.mock.calls[0]?.[0]).toHaveProperty('responseHeaders')
    expect(oneTab.mock.calls.map(([details]) => details.url)).toEqual(['https://x.example/other/a.js'])
  })

  it('a listener gets the body of an upload only if it asked for requestBody', async () => {
    const { chrome, tell } = await worker(['webRequest'])
    const asked = vi.fn()
    const not = vi.fn()
    chrome.webRequest.onBeforeRequest.addListener(asked, { urls: ['<all_urls>'] }, ['requestBody'])
    chrome.webRequest.onBeforeRequest.addListener(not, { urls: ['<all_urls>'] })
    await settle()
    tell('onBeforeRequest', { url: 'https://x.example/a', type: 'xmlhttprequest', tabId: 4, requestBody: { raw: [{ bytes: new ArrayBuffer(2) }] } })
    expect(asked.mock.calls[0]?.[0]).toHaveProperty('requestBody')
    expect(not.mock.calls[0]?.[0]).not.toHaveProperty('requestBody')
  })

  it('a worker started for a request hears it once its script has put its listeners back', async () => {
    const { chrome, tell } = await worker(['webRequest'])
    tell('onCompleted', { url: 'https://x.example/a.js', type: 'script', tabId: 4 })
    const heard = vi.fn()
    chrome.webRequest.onCompleted.addListener(heard, { urls: ['<all_urls>'] })
    await settle()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a listener that was removed hears nothing more', async () => {
    const { chrome, tell } = await worker(['webRequest'])
    const heard = vi.fn()
    chrome.webRequest.onCompleted.addListener(heard, { urls: ['<all_urls>'] })
    expect(chrome.webRequest.onCompleted.hasListener(heard)).toBe(true)
    chrome.webRequest.onCompleted.removeListener(heard)
    expect(chrome.webRequest.onCompleted.hasListeners()).toBe(false)
    await settle()
    tell('onCompleted', { url: 'https://x.example/a.js', type: 'script', tabId: 4 })
    expect(heard).not.toHaveBeenCalled()
  })

  it('refuses a blocking listener to an extension without the permission to block, and a listener without a filter', async () => {
    const { chrome, calls } = await worker(['webRequest'])
    expect(() => chrome.webRequest.onBeforeRequest.addListener(() => undefined, { urls: ['<all_urls>'] }, ['blocking'])).toThrow('webRequestBlocking')
    expect(() => chrome.webRequest.onBeforeRequest.addListener(() => undefined)).toThrow("needs 'urls'")
    expect(calls('webRequest', 'listen')).toEqual([])
  })

  it('takes a blocking listener of a Manifest V3 extension, and says once in its console that what the listener answers is not applied', async () => {
    const { chrome, calls, tell } = await worker(['webRequest', 'webRequestBlocking'])
    const warned = (): string[] => vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).filter((line) => line.includes('asks to block'))
    chrome.webRequest.onCompleted.addListener(() => undefined, { urls: ['<all_urls>'] }, ['responseHeaders'])
    expect(warned()).toEqual([])
    const heard = vi.fn(() => ({ cancel: true }))
    chrome.webRequest.onBeforeRequest.addListener(heard, { urls: ['<all_urls>'] }, ['blocking'])
    chrome.webRequest.onHeadersReceived.addListener(() => undefined, { urls: ['<all_urls>'] }, ['asyncBlocking'])
    expect(warned()).toHaveLength(1)
    expect(warned()[0]).toContain('chrome.webRequest.onBeforeRequest')
    expect(warned()[0]).toContain('does not apply what it answers')
    expect(warned()[0]).toContain('only a Manifest V2 extension may do')
    expect(warned()[0]).toContain('chrome.declarativeNetRequest')
    // The listener is registered and told like any other.
    expect(calls('webRequest', 'listen').map((call) => [call[0], call[2]])).toEqual([['onCompleted', ['responseHeaders']], ['onBeforeRequest', ['blocking']], ['onHeadersReceived', ['asyncBlocking']]])
    await settle()
    tell('onBeforeRequest', { url: 'https://x.example/a.js', type: 'script', tabId: 4 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a blocking listener of a Manifest V2 extension answers the request it is asked about, with no word in its console', async () => {
    const { chrome, calls, ask, tell } = await worker(['webRequest', 'webRequestBlocking'], { manifestVersion: 2 })
    const told = vi.fn()
    chrome.webRequest.onBeforeRequest.addListener((details: { url: string }) => (details.url.includes('/ad') ? { cancel: true } : undefined), { urls: ['<all_urls>'] }, ['blocking'])
    chrome.webRequest.onBeforeRequest.addListener(told, { urls: ['<all_urls>'] })
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('asks to block')
    await settle()
    ask('onBeforeRequest', { url: 'https://x.example/ad.js', type: 'script', tabId: 4 }, 't1')
    ask('onBeforeRequest', { url: 'https://x.example/app.js', type: 'script', tabId: 4 }, 't2')
    // Told, not asked: nothing goes back.
    tell('onBeforeRequest', { url: 'https://x.example/ad.js', type: 'script', tabId: 4 })
    await settle()
    expect(calls('webRequest', 'answer')).toEqual([
      ['t1', [{ cancel: true }]],
      ['t2', []]
    ])
    // A listener that does not block is told every time, and answers nothing.
    expect(told).toHaveBeenCalledTimes(3)
  })

  it('an asyncBlocking listener answers through its callback, and a promise a listener returns is waited for', async () => {
    const { chrome, calls, ask } = await worker(['webRequest', 'webRequestBlocking'], { manifestVersion: 2 })
    let later: ((response: unknown) => void) | undefined
    chrome.webRequest.onAuthRequired.addListener((_details: unknown, callback: (response: unknown) => void) => void (later = callback), { urls: ['<all_urls>'] }, ['asyncBlocking'])
    chrome.webRequest.onBeforeSendHeaders.addListener(async () => ({ requestHeaders: [{ name: 'x-a', value: '1' }] }), { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders'])
    await settle()
    ask('onAuthRequired', { url: 'https://x.example/private', type: 'main_frame', tabId: 4 }, 'login')
    ask('onBeforeSendHeaders', { url: 'https://x.example/a.js', type: 'script', tabId: 4 }, 'headers')
    await settle()
    expect(calls('webRequest', 'answer')).toEqual([['headers', [{ requestHeaders: [{ name: 'x-a', value: '1' }] }]]])
    later?.({ authCredentials: { username: 'u', password: 'p' } })
    await settle()
    expect(calls('webRequest', 'answer').at(-1)).toEqual(['login', [{ authCredentials: { username: 'u', password: 'p' } }]])
  })

  it('a context that held a blocking listener always answers, so that the request never waits for it in vain; one that never held one stays silent', async () => {
    const { chrome, calls, ask } = await worker(['webRequest', 'webRequestBlocking'], { manifestVersion: 2 })
    const listener = () => ({ cancel: true })
    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: ['https://ads.example/*'] }, ['blocking'])
    await settle()
    // Its filter does not cover the request: an empty answer.
    ask('onBeforeRequest', { url: 'https://x.example/a.js', type: 'script', tabId: 4 }, 'a')
    chrome.webRequest.onBeforeRequest.removeListener(listener)
    // Removed since: an empty answer too.
    ask('onBeforeRequest', { url: 'https://ads.example/a.js', type: 'script', tabId: 4 }, 'b')
    // Never a blocking listener on this event: nothing.
    ask('onHeadersReceived', { url: 'https://ads.example/a.js', type: 'script', tabId: 4 }, 'c')
    await settle()
    expect(calls('webRequest', 'answer')).toEqual([
      ['a', []],
      ['b', []]
    ])
  })

  it('an answer that cannot be handed over goes as a word the main process refuses, and a listener that throws answers nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { chrome, calls, ask } = await worker(['webRequest', 'webRequestBlocking'], { manifestVersion: 2 })
    const looped: Record<string, unknown> = {}
    looped['self'] = looped
    chrome.webRequest.onBeforeRequest.addListener(() => looped, { urls: ['<all_urls>'] }, ['blocking'])
    chrome.webRequest.onBeforeRequest.addListener(() => {
      throw new Error('the listener broke')
    }, { urls: ['<all_urls>'] }, ['blocking'])
    await settle()
    ask('onBeforeRequest', { url: 'https://x.example/a.js', type: 'script', tabId: 4 }, 't')
    await settle()
    expect(calls('webRequest', 'answer')).toEqual([['t', ['unreadable']]])
    expect(error.mock.calls.flat().map(String).join(' ')).toContain('the listener broke')
  })

  it('says in the console of the extension that a listener the main process did not take will hear nothing', async () => {
    const { chrome, bridge } = await worker(['webRequest'])
    bridge.call.mockRejectedValueOnce(new Error('Too many webRequest listeners in this context.'))
    chrome.webRequest.onCompleted.addListener(() => undefined, { urls: ['<all_urls>'] })
    await settle()
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('the browser did not take the listener')
  })

  it('an extension without the permission keeps what it had', async () => {
    const { chrome, nativeEvent } = await worker(['storage'])
    expect(chrome.webRequest.onCompleted).toBe(nativeEvent)
  })
})

describe('chrome.scripting on a tab lent with a click', () => {
  const refusal = async () => {
    throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')
  }

  it('what the browser runs is left to the browser', async () => {
    const { chrome, calls } = await worker(['activeTab', 'scripting'])
    expect(await chrome.scripting.executeScript({ target: { tabId: 7 }, func: () => 1 })).toEqual([{ result: 'native' }])
    expect(calls('scripting', 'executeScript')).toEqual([])
  })

  it('what the browser refuses for want of a host permission is handed to the main process, the function as its text', async () => {
    const { chrome, bridge, calls } = await worker(['activeTab', 'scripting'], { scripting: refusal })
    bridge.call.mockResolvedValue([{ frameId: 0, result: 'the title' }])
    const func = (a: number) => a + 1
    expect(await chrome.scripting.executeScript({ target: { tabId: 7, allFrames: true }, func, args: [1], world: 'MAIN' })).toEqual([{ frameId: 0, result: 'the title' }])
    expect(calls('scripting', 'executeScript')).toEqual([[{ target: { tabId: 7 }, world: 'MAIN', func: String(func), args: [1], files: undefined, css: undefined, origin: undefined }]])
  })

  it('the refusal of the main process (the tab was not lent) reaches the extension', async () => {
    const { chrome, bridge } = await worker(['activeTab', 'scripting'], { scripting: refusal })
    bridge.call.mockRejectedValue(new Error("Error invoking remote method 'lucium-shim': Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host."))
    await expect(chrome.scripting.executeScript({ target: { tabId: 7 }, func: () => 1 })).rejects.toThrow(/^Cannot access contents of the page/)
  })

  it('any other failure of the browser is the extension\'s to read, and nothing is asked of the main process', async () => {
    const { chrome, calls } = await worker(['activeTab', 'scripting'], {
      scripting: async () => {
        throw new Error('No tab with id: 7.')
      }
    })
    await expect(chrome.scripting.executeScript({ target: { tabId: 7 }, func: () => 1 })).rejects.toThrow('No tab with id: 7.')
    expect(calls('scripting', 'executeScript')).toEqual([])
  })

  it('an extension without activeTab keeps the browser\'s own chrome.scripting', async () => {
    const { chrome, nativeScript } = await worker(['scripting'], { scripting: refusal })
    expect(chrome.scripting.executeScript).toBe(nativeScript)
  })
})

describe('chrome.tabs.sendMessage to the script an extension injected after a click', () => {
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
  const noReceiver = async (): Promise<never> => {
    throw new Error(NO_RECEIVER)
  }

  it('what the browser delivers is left to the browser, and nothing is asked of the main process', async () => {
    const { chrome, nativeSend, calls } = await worker(['activeTab', 'scripting'], { sendMessage: async () => ({ heard: 'by a content script' }) })
    expect(await chrome.tabs.sendMessage(7, { type: 'mount' })).toEqual({ heard: 'by a content script' })
    expect(nativeSend).toHaveBeenCalledWith(7, { type: 'mount' })
    expect(calls('lentTab', 'toTab')).toEqual([])
  })

  it('a message the browser cannot deliver (no receiver) is handed to the main process with the tab, the message, the options and the address of this context; what the script answers comes back', async () => {
    const { chrome, bridge, nativeSend, calls } = await worker(['activeTab', 'scripting'], { sendMessage: noReceiver })
    bridge.call.mockResolvedValue({ ok: true, title: 'page' })
    expect(await chrome.tabs.sendMessage(7, { type: 'mount' }, { frameId: 0 })).toEqual({ ok: true, title: 'page' })
    expect(nativeSend).toHaveBeenCalledWith(7, { type: 'mount' }, { frameId: 0 })
    // `location` is the address of the context: a worker has none in this test (plain Node), so none is given.
    expect(calls('lentTab', 'toTab')).toEqual([[7, { type: 'mount' }, { frameId: 0 }, typeof location === 'undefined' ? undefined : String(location.href)]])
  })

  it('hands the answer to a trailing callback, or sets chrome.runtime.lastError for the length of it', async () => {
    const { chrome, bridge } = await worker(['activeTab', 'scripting'], { sendMessage: noReceiver })
    bridge.call.mockResolvedValueOnce('answered')
    const seen: unknown[] = []
    chrome.tabs.sendMessage(7, 'hello', (reply: unknown) => seen.push([reply, chrome.runtime.lastError]))
    await settle()
    expect(seen).toEqual([['answered', undefined]])
    bridge.call.mockRejectedValueOnce(new Error(`Error invoking remote method 'lucium-shim': Error: ${NO_RECEIVER}`))
    chrome.tabs.sendMessage(7, 'hello', (reply: unknown) => seen.push([reply, chrome.runtime.lastError && chrome.runtime.lastError.message]))
    await settle()
    expect(seen[1]).toEqual([undefined, NO_RECEIVER])
    expect(chrome.runtime.lastError).toBeUndefined()
  })

  it('the refusal of the main process (no script of the extension runs there, or the tab was not lent) reaches the extension in the words of the browser', async () => {
    const { chrome, bridge } = await worker(['activeTab', 'scripting'], { sendMessage: noReceiver })
    bridge.call.mockRejectedValue(new Error(`Error invoking remote method 'lucium-shim': Error: ${NO_RECEIVER}`))
    await expect(chrome.tabs.sendMessage(7, 'hello')).rejects.toThrow(new RegExp(`^${NO_RECEIVER.replace(/[.]/g, '\\.')}$`))
  })

  it('any other failure of the browser is the extension\'s to read, and nothing is asked of the main process', async () => {
    const { chrome, calls } = await worker(['activeTab', 'scripting'], {
      sendMessage: async () => {
        throw new Error('No tab with id: 7.')
      }
    })
    await expect(chrome.tabs.sendMessage(7, 'hello')).rejects.toThrow('No tab with id: 7.')
    expect(calls('lentTab', 'toTab')).toEqual([])
  })

  it('an extension that cannot be lent a tab keeps the browser\'s own chrome.tabs.sendMessage', async () => {
    for (const permissions of [['activeTab'], ['scripting'], ['storage']]) {
      const { chrome, nativeSend } = await worker(permissions, { sendMessage: noReceiver })
      expect(chrome.tabs.sendMessage, permissions.join()).toBe(nativeSend)
    }
  })
})
