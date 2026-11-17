import { describe, expect, it } from 'vitest'
import { ALLOWED_DOMAINS, DENIED_DOMAINS, DebuggerGuard, debuggerTargetAllowed } from './debugger-policy'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

describe('debuggerTargetAllowed', () => {
  it('lets an extension attach to a web page, the blank page and its own pages', () => {
    for (const url of ['https://example.com/', 'http://localhost:3000/x', 'about:blank', '', `chrome-extension://${ID}/panel.html`]) expect(debuggerTargetAllowed(url, ID), url).toBe(true)
  })

  it('refuses the page of the Chrome Web Store, whatever the scheme or the case of the host: a debugger there could press its install button', () => {
    for (const url of ['https://chromewebstore.google.com/', 'https://chromewebstore.google.com/detail/outil/abcdefghijklmnopabcdefghijklmnop', 'http://chromewebstore.google.com/', 'https://ChromeWebStore.Google.com/search/x', 'https://chromewebstore.google.com:443/']) {
      expect(debuggerTargetAllowed(url, ID), url).toBe(false)
    }
    // Only that host: the rest of google.com, and a host that merely contains its name, are ordinary pages.
    for (const url of ['https://www.google.com/', 'https://chromewebstore.google.com.evil.example/', 'https://notchromewebstore.google.com/']) expect(debuggerTargetAllowed(url, ID), url).toBe(true)
  })

  it('refuses a local file, a page of another extension, a source view, a data document and the pages of the browser', () => {
    for (const url of ['file:///etc/passwd', `chrome-extension://${OTHER}/panel.html`, 'view-source:https://example.com/', 'data:text/html,hi', 'blob:https://a.example/x', 'chrome://settings', 'chrome-error://chromewebdata/', 'devtools://devtools/x', 'not a url', 'about:srcdoc']) {
      expect(debuggerTargetAllowed(url, ID), url).toBe(false)
    }
  })
})

describe('DebuggerGuard commands', () => {
  const guard = () => new DebuggerGuard(ID)
  const page = 'https://shop.example/cart'

  it('lets through what drives a web page', () => {
    for (const [method, params] of [
      ['Runtime.evaluate', { expression: '1+1' }],
      ['Page.captureScreenshot', {}],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }],
      ['DOM.getDocument', {}],
      ['Page.navigate', { url: 'https://example.com/' }],
      ['Page.navigate', { url: 'about:blank' }],
      ['Network.enable', {}],
      ['Network.getCookies', {}]
    ] as const) {
      expect(guard().command(method, params, page), method).toBeNull()
    }
  })

  it('refuses the domains that reach beyond the tab', () => {
    for (const method of ['Browser.close', 'Browser.setDownloadBehavior', 'Target.createTarget', 'Target.attachToTarget', 'Storage.getCookies', 'SystemInfo.getInfo', 'IO.read', 'Security.setIgnoreCertificateErrors', 'Extensions.loadUnpacked']) {
      expect(guard().command(method, {}, page), method).toBe('Not allowed')
    }
  })

  it('refuses the service worker and background service domains, which act on the whole storage and not on the tab', () => {
    for (const method of ['ServiceWorker.enable', 'ServiceWorker.unregister', 'ServiceWorker.startWorker', 'ServiceWorker.stopAllWorkers', 'ServiceWorker.deliverPushMessage', 'ServiceWorker.updateRegistration', 'BackgroundService.startObserving', 'BackgroundService.setRecording']) {
      expect(guard().command(method, { scopeURL: 'https://bank.example/' }, page), method).toBe('Not allowed')
    }
  })

  // These passed, and read or rewrote the scripts of another extension's content scripts on the page, the heap of every world,
  // and the storage of a site the page frames (the cookies of which are kept apart).
  it('refuses the domains that reach the other worlds of the page and the storage of the origins it frames', () => {
    for (const [method, params] of [
      ['Debugger.enable', {}],
      ['Debugger.getScriptSource', { scriptId: '42' }],
      ['Debugger.setScriptSource', { scriptId: '42', scriptSource: 'evil()' }],
      ['Debugger.setBreakpointByUrl', { lineNumber: 1, url: `chrome-extension://${OTHER}/content.js` }],
      ['Debugger.evaluateOnCallFrame', { callFrameId: 'c', expression: 'secret' }],
      ['DOMDebugger.getEventListeners', { objectId: 'o' }],
      ['HeapProfiler.takeHeapSnapshot', {}],
      ['Memory.getBrowserSamplingProfile', {}],
      ['DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'https://bank.example', isLocalStorage: true } }],
      ['IndexedDB.requestDatabaseNames', { securityOrigin: 'https://bank.example' }],
      ['CacheStorage.requestCacheNames', { securityOrigin: 'https://bank.example' }],
      ['Database.executeSQL', { databaseId: '1', query: 'select 1' }]
    ] as const) {
      expect(guard().command(method, params, page), method).toBe('Not allowed')
    }
  })

  // The refused domains were a list, so a domain a later Chromium adds would have gone through unread.
  it('refuses a domain it does not know, and those that act for the browser rather than the tab', () => {
    for (const method of ['Future.enable', 'Future.readEverything', 'PWA.install', 'PWA.launch', 'Tethering.bind', 'Database.executeSQL']) {
      expect(guard().command(method, {}, page), method).toBe('Not allowed')
    }
  })

  it('never lists a refused domain among the allowed ones', () => {
    expect([...DENIED_DOMAINS].filter((domain) => ALLOWED_DOMAINS.has(domain))).toEqual([])
    for (const domain of DENIED_DOMAINS) expect(guard().command(`${domain}.enable`, {}, page), domain).toBe('Not allowed')
  })

  it('still lets an extension use the other domains of the protocol of Chromium 156 it could use before the list of allowed domains', () => {
    const before = ['Accessibility', 'Ads', 'Animation', 'Audits', 'Console', 'CrashReportContext', 'CSS', 'DeviceOrientation', 'DOM', 'DOMSnapshot', 'Emulation', 'EventBreakpoints', 'Fetch', 'FindInPage', 'HeadlessExperimental', 'Input', 'Inspector', 'LayerTree', 'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance', 'PerformanceTimeline', 'Preload', 'Profiler', 'Runtime', 'Schema', 'WebAudio']
    for (const domain of before) expect(guard().command(`${domain}.enable`, {}, page), domain).toBeNull()
  })

  // These passed: an extension could pick the account of a federated sign-in, the device of a Bluetooth or USB prompt, or fill a form with a
  // saved card, in place of the user. Chrome serves none of them to chrome.debugger.
  it('refuses the domains that answer a question of the browser in place of the user, or stand in for a device', () => {
    for (const [method, params] of [
      ['FedCm.enable', {}],
      ['FedCm.selectAccount', { dialogId: 'd', accountIndex: 0 }],
      ['FedCm.dismissDialog', { dialogId: 'd' }],
      ['DeviceAccess.enable', {}],
      ['DeviceAccess.selectPrompt', { id: 'p', deviceId: 'x' }],
      ['DigitalCredentials.enable', {}],
      ['Autofill.trigger', { fieldId: 1, card: { number: '4111111111111111' } }],
      ['Autofill.setAddresses', { addresses: [] }],
      ['BluetoothEmulation.enable', { state: 'powered-on', leSupported: true }],
      ['SmartCardEmulation.enable', {}],
      ['WebMCP.enable', {}]
    ] as const) {
      expect(guard().command(method, params, page), method).toBe('Not allowed')
    }
  })

  // Chrome serves this one to chrome.debugger. A virtual authenticator answers the passkey ceremony of the page in place of the person and of their
  // key, and hands back the private keys it made: it is refused here, with the events of the domain.
  it('refuses the virtual authenticator of WebAuthn, its credentials and its events', () => {
    for (const [method, params] of [
      ['WebAuthn.enable', { enableUI: false }],
      ['WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', automaticPresenceSimulation: true } }],
      ['WebAuthn.addCredential', { authenticatorId: 'a', credential: { credentialId: 'AA==', isResidentCredential: true, privateKey: 'AA==', signCount: 0 } }],
      ['WebAuthn.getCredentials', { authenticatorId: 'a' }],
      ['WebAuthn.setUserVerified', { authenticatorId: 'a', isUserVerified: true }]
    ] as const) {
      expect(guard().command(method, params, page), method).toBe('Not allowed')
    }
    expect(DENIED_DOMAINS.has('WebAuthn')).toBe(true)
    expect(guard().event('WebAuthn.credentialAsserted', { authenticatorId: 'a', credential: { privateKey: 'AA==' } })).toBe(false)
  })

  it('refuses a download to a path, browser-wide cookies, and a local file given to a file field', () => {
    for (const method of ['Page.setDownloadBehavior', 'Network.getAllCookies', 'Network.clearBrowserCookies', 'DOM.setFileInputFiles', 'Page.setInterceptFileChooserDialog', 'Network.loadNetworkResource', 'Anything.setDownloadBehavior']) {
      expect(guard().command(method, {}, page), method).toBe('Not allowed')
    }
  })

  it('refuses a simulated drag that carries files of the disk, which the page that gets the drop would read', () => {
    const drag = (data: unknown, type = 'drop') => guard().command('Input.dispatchDragEvent', { type, x: 10, y: 10, data }, page)
    for (const type of ['dragEnter', 'dragOver', 'drop']) expect(drag({ items: [], files: ['/Users/me/.ssh/id_ed25519'], dragOperationsMask: 1 }, type), type).toBe('Not allowed')
    // What is not a list of names is not sorted out: it is refused.
    expect(drag({ items: [], files: '/Users/me/.ssh/id_ed25519', dragOperationsMask: 1 })).toBe('Not allowed')
    expect(drag({ items: [], files: { 0: '/etc/hosts' }, dragOperationsMask: 1 })).toBe('Not allowed')
    // A drag of text or of a link, the use an extension that tests pages has for it, still goes.
    expect(drag({ items: [{ mimeType: 'text/plain', data: 'hello' }], dragOperationsMask: 1 })).toBeNull()
    expect(drag({ items: [{ mimeType: 'text/uri-list', data: 'https://example.com/' }], files: [], dragOperationsMask: 1 })).toBeNull()
    expect(guard().command('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0 }, page)).toBeNull()
  })

  it('refuses a simulated key that pastes: the clipboard of the user would land in the page without the question the page must ask', () => {
    const key = (commands: unknown) => guard().command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', modifiers: 4, commands }, page)
    for (const command of ['paste', 'Paste', 'pasteAndMatchStyle', 'PasteGlobalSelection', 'yank', 'yankAndSelect']) expect(key(['selectAll', command]), command).toBe('Not allowed')
    expect(key('paste')).toBe('Not allowed')
    expect(key([{ name: 'paste' }])).toBe('Not allowed')
    // The other editing commands, and a key with none, still go.
    expect(key(['selectAll', 'copy', 'moveToEndOfLine'])).toBeNull()
    expect(key([])).toBeNull()
    expect(guard().command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, page)).toBeNull()
  })

  it('refuses a navigation to something an extension could not attach to', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', `chrome-extension://${OTHER}/x.html`, 'view-source:https://a.example/', '']) {
      expect(guard().command('Page.navigate', { url }, page), url).toBe('Not allowed')
    }
    expect(guard().command('Page.navigate', {}, page)).toBe('Not allowed')
    expect(guard().command('Page.navigate', { url: `chrome-extension://${ID}/p.html` }, page)).toBeNull()
  })

  it('reads and writes the cookies of the site of the tab only', () => {
    expect(guard().command('Network.getCookies', { urls: ['https://bank.example/'] }, page)).toBe('Not allowed')
    expect(guard().command('Network.setCookie', { name: 'a', value: 'b', url: 'https://bank.example/' }, page)).toBe('Not allowed')
    expect(guard().command('Network.setCookie', { name: 'a', value: 'b', url: 'https://shop.example/' }, page)).toBeNull()
    expect(guard().command('Network.setCookie', { name: 'a', value: 'b', domain: '.shop.example' }, page)).toBeNull()
    expect(guard().command('Network.setCookie', { name: 'a', value: 'b', domain: 'bank.example' }, page)).toBe('Not allowed')
    expect(guard().command('Network.deleteCookies', { name: 'a', domain: 'bank.example' }, page)).toBe('Not allowed')
    expect(guard().command('Network.setCookies', { cookies: [{ name: 'a', value: 'b', url: 'https://shop.example/' }, { name: 'c', value: 'd', url: 'https://bank.example/' }] }, page)).toBe('Not allowed')
  })

  it('refuses a method that is not the name of a command', () => {
    for (const method of [undefined, 42, '', 'Runtime', 'Runtime.', '.evaluate', 'Runtime.evaluate; Browser.close', 'a.b.c']) expect(guard().command(method, {}, page), String(method)).toBe('Invalid method name')
  })
})

describe('DebuggerGuard events', () => {
  const created = (id: number, origin: string, uniqueId = `u${id}`) => ({ context: { id, origin, name: '', uniqueId } })

  it('holds back the execution contexts of another extension, and refuses to run code in them', () => {
    const guard = new DebuggerGuard(ID)
    expect(guard.event('Runtime.executionContextCreated', created(1, 'https://shop.example'))).toBe(true)
    expect(guard.event('Runtime.executionContextCreated', created(2, `chrome-extension://${ID}`))).toBe(true)
    expect(guard.event('Runtime.executionContextCreated', created(3, `chrome-extension://${OTHER}`))).toBe(false)
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 3 }, 'https://shop.example/')).toBe('Not allowed')
    expect(guard.command('Runtime.callFunctionOn', { functionDeclaration: 'x', executionContextId: 3 }, 'https://shop.example/')).toBe('Not allowed')
    expect(guard.command('Runtime.evaluate', { expression: '1', uniqueContextId: 'u3' }, 'https://shop.example/')).toBe('Not allowed')
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 1 }, 'https://shop.example/')).toBeNull()
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 2 }, 'https://shop.example/')).toBeNull()
  })

  it('lets a command name only a context the page reported, never one it has not yet reported or one that is gone', () => {
    const guard = new DebuggerGuard(ID)
    const evaluate = (params: Record<string, unknown>) => guard.command('Runtime.evaluate', { expression: '1', ...params }, 'https://shop.example/')
    // A number nobody reported yet: it could be the context of another extension in the page, which the event has not announced.
    expect(evaluate({ contextId: 7 })).toBe('Not allowed')
    expect(evaluate({ uniqueContextId: 'u7' })).toBe('Not allowed')
    expect(guard.command('Runtime.callFunctionOn', { functionDeclaration: 'x', executionContextId: 7 }, 'https://shop.example/')).toBe('Not allowed')
    guard.event('Runtime.executionContextCreated', created(7, 'https://shop.example'))
    expect(evaluate({ contextId: 7 })).toBeNull()
    expect(evaluate({ uniqueContextId: 'u7' })).toBeNull()
    expect(guard.command('Runtime.callFunctionOn', { functionDeclaration: 'x', executionContextId: 7 }, 'https://shop.example/')).toBeNull()
    // The wrong kind of value is not a context either; no context at all is an ordinary call.
    expect(evaluate({ contextId: '7' })).toBe('Not allowed')
    expect(evaluate({ uniqueContextId: 7 })).toBe('Not allowed')
    expect(evaluate({})).toBeNull()
    expect(evaluate({ contextId: null })).toBeNull()
    // A context that is gone, or all of them after a navigation, can no longer be named.
    guard.event('Runtime.executionContextDestroyed', { executionContextId: 7, executionContextUniqueId: 'u7' })
    expect(evaluate({ contextId: 7 })).toBe('Not allowed')
    expect(evaluate({ uniqueContextId: 'u7' })).toBe('Not allowed')
    guard.event('Runtime.executionContextCreated', created(8, 'https://shop.example'))
    guard.event('Runtime.executionContextsCleared', {})
    expect(evaluate({ contextId: 8 })).toBe('Not allowed')
  })

  it('does not let a context of another extension become nameable', () => {
    const guard = new DebuggerGuard(ID)
    guard.event('Runtime.executionContextCreated', created(3, `chrome-extension://${OTHER}`))
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 3 }, 'https://shop.example/')).toBe('Not allowed')
    expect(guard.command('Runtime.evaluate', { expression: '1', uniqueContextId: 'u3' }, 'https://shop.example/')).toBe('Not allowed')
  })

  it('refuses a world with universal access, and lets the world it created without be named', () => {
    const guard = new DebuggerGuard(ID)
    const page = 'https://shop.example/'
    expect(guard.command('Page.createIsolatedWorld', { frameId: 'f', worldName: 'w', grantUniveralAccess: true }, page)).toBe('Not allowed')
    expect(guard.command('Page.createIsolatedWorld', { frameId: 'f', worldName: 'w', grantUniversalAccess: true }, page)).toBe('Not allowed')
    expect(guard.command('Page.createIsolatedWorld', { frameId: 'f', worldName: 'w' }, page)).toBeNull()
    expect(guard.command('Page.createIsolatedWorld', { frameId: 'f', grantUniveralAccess: false }, page)).toBeNull()
    // The answer names the world; a command can use it from then on, and an answer of another kind teaches nothing.
    guard.result('Runtime.evaluate', { executionContextId: 31 })
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 31 }, page)).toBe('Not allowed')
    guard.result('Page.createIsolatedWorld', { executionContextId: 31 })
    expect(guard.command('Runtime.evaluate', { expression: '1', contextId: 31 }, page)).toBeNull()
    guard.result('Page.createIsolatedWorld', undefined)
  })

  it('holds back every event of a domain the extension may not use, whoever turned it on', () => {
    const guard = new DebuggerGuard(ID)
    expect(guard.event('Debugger.scriptParsed', { scriptId: '42', url: `chrome-extension://${OTHER}/content.js`, executionContextId: 1 })).toBe(false)
    expect(guard.event('Debugger.paused', { callFrames: [] })).toBe(false)
    expect(guard.event('HeapProfiler.addHeapSnapshotChunk', { chunk: '{}' })).toBe(false)
    expect(guard.event('DOMStorage.domStorageItemAdded', { key: 'token' })).toBe(false)
    // A domain it does not know is one it may not use: its events stay back too.
    expect(guard.event('Future.somethingHappened', { secret: 'x' })).toBe(false)
  })

  it('holds back what happens in a context of another extension: its console messages and its exceptions', () => {
    const guard = new DebuggerGuard(ID)
    guard.event('Runtime.executionContextCreated', created(1, 'https://shop.example'))
    guard.event('Runtime.executionContextCreated', created(3, `chrome-extension://${OTHER}`))
    expect(guard.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'object', objectId: 'o3' }], executionContextId: 3, timestamp: 1 })).toBe(false)
    expect(guard.event('Runtime.exceptionThrown', { timestamp: 1, exceptionDetails: { exceptionId: 1, text: 'x', lineNumber: 0, columnNumber: 0, executionContextId: 3 } })).toBe(false)
    expect(guard.event('Runtime.consoleAPICalled', { type: 'log', args: [], executionContextId: 1, timestamp: 1 })).toBe(true)
    expect(guard.event('Runtime.exceptionThrown', { timestamp: 1, exceptionDetails: { exceptionId: 2, text: 'y', lineNumber: 0, columnNumber: 0, executionContextId: 1 } })).toBe(true)
  })

  it('lets every other event through', () => {
    const guard = new DebuggerGuard(ID)
    expect(guard.event('Page.loadEventFired', { timestamp: 1 })).toBe(true)
    expect(guard.event('Runtime.executionContextCreated', undefined)).toBe(true)
    expect(guard.event('Runtime.executionContextDestroyed', { executionContextId: 9 })).toBe(true)
  })

  it('does not tell the extension that a context it never heard of is gone', () => {
    const guard = new DebuggerGuard(ID)
    guard.event('Runtime.executionContextCreated', created(3, `chrome-extension://${OTHER}`))
    expect(guard.event('Runtime.executionContextDestroyed', { executionContextId: 3 })).toBe(false)
  })
})
