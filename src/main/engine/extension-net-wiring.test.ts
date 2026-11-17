// The request rules and the request listeners of extensions inside the hooks of a profile session (electron-engine-network.ts): they come after
// the application's own protections and never undo them, the hooks widen only while an extension needs them, and a failure of theirs leaves the
// request as the application decided. Run on stand-ins of the engine and the session; the same in a real Electron: `smokeProbesExt`.

import { afterEach, describe, expect, it, vi } from 'vitest'

type Answer = Record<string, unknown>
type Listener = (details: Record<string, unknown>, callback: (answer: Answer) => void) => void
type Hook = { filter: { urls: string[]; types?: string[] } | null; listener: Listener | null }

/** The web contents `webContents.fromId` finds: the pages of extensions a test puts there. */
const contentsById = new Map<number, unknown>()

vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => (name === 'home' ? '/Users/me' : `/tmp/lucium-test-${name}`) },
    session: { defaultSession: {} },
    webContents: { fromId: (id: number) => contentsById.get(id) }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { PendingReads } = await import('./local-file-guard')
const { listenerLogins } = await import('./extension-net')
const { BLOCKING_WAIT_MS } = await import('@shared/web-request-blocking')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const HOOKS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'] as const

function fakeSession() {
  const hooks = Object.fromEntries(HOOKS.map((name) => [name, { filter: null, listener: null } as Hook])) as Record<(typeof HOOKS)[number], Hook>
  const webRequest = Object.fromEntries(
    HOOKS.map((name) => [
      name,
      (filter: Hook['filter'], listener?: Listener) => {
        hooks[name].filter = filter
        hooks[name].listener = listener ?? null
      }
    ])
  )
  return { hooks, webRequest, protocol: { handle: () => undefined, unhandle: () => undefined }, getStoragePath: () => null }
}

interface Sent {
  extensionId: string
  event: string
  args: unknown[]
}

/** An engine with one profile session, its hooks installed, and one extension loaded in it. */
function profile(options: { blocker?: (request: { url: string }) => unknown; privacy?: Record<string, unknown>; policy?: () => string | null } = {}) {
  const ses = fakeSession()
  const sent: Sent[] = []
  const kept = new Map<string, string>()
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    requestBlocker: options.blocker ?? null,
    privacy: options.privacy ?? null,
    responsePolicy: options.policy ?? null,
    pageByContents: new Map(),
    tabMeta: new Map([[7, {}]]),
    profiles: new Map(),
    localPageSessions: new WeakSet(),
    headerHooks: new WeakMap(),
    // No identity for the sign-in pages of Google (client-hints-wiring.test.ts has them): the hook is what it is without it.
    signIn: null,
    signInSessions: new WeakSet(),
    requestHooks: new WeakMap(),
    extensionNets: new WeakMap(),
    netWakes: new Map(),
    localPageReads: new PendingReads(),
    standInSessions: new WeakSet(),
    standInWords: new WeakMap(),
    upgrades: { upgrade: (_id: number, _url: string): string | null => null },
    extensionLedger: () => ({ netChoices: (_profile: string, id: string) => kept.get(id), keepNetChoices: (_profile: string, id: string, value: string | undefined) => void (value === undefined ? kept.delete(id) : kept.set(id, value)) }),
    emitShimEvent: (extensionId: string, _api: string, event: string, args: unknown[]) => void sent.push({ extensionId, event, args }),
    deliverToWorker: async () => undefined,
    manifests: new Map(),
    extensionFrames: new Set(),
    profileOfSession: (of: unknown) => (of === ses ? 'default' : undefined)
  })
  const net = methods['extensionNetOf']!.call(engine, ses, 'default') as import('./extension-net').ExtensionNet
  methods['installRequestBlocker']!.call(engine, ses)
  methods['installResponsePolicy']!.call(engine, ses, () => (engine['responsePolicy'] as never) ?? null)
  net.add('ext', '/ext', { manifest_version: 3, permissions: ['declarativeNetRequest', 'webRequest'], host_permissions: ['<all_urls>'] })
  return { ses, engine, net, sent }
}

const page = (url: string) => ({ getURL: () => url, isDestroyed: () => false, id: 7 })

const details = (url: string, more: Record<string, unknown> = {}) => ({ id: 1, url, method: 'GET', resourceType: 'script', webContents: page('https://page.example/'), frame: { url: 'https://page.example/', parent: null, frameTreeNodeId: 3 }, timestamp: 5, ...more })

const answer = (hook: Hook, asked: Record<string, unknown>): Promise<Answer> => new Promise((resolve) => hook.listener!(asked, resolve))

const WEB = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
/** What the hook of the answers looks at while no extension, no policy and no local page needs it. */
const IDLE_ANSWERS = { urls: ['https://*/*'], types: ['mainFrame'] }
/** What the hook of the request headers looks at while nothing else needs it: the navigations, for the Client Hints of the engine. */
const NAVIGATIONS_ONLY = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] }

describe('the request rules of extensions in the hooks of a profile session', () => {
  it('cost the session nothing while no extension has a rule or a listener: the hooks are as without extensions', () => {
    const { ses } = profile()
    expect(ses.hooks.onBeforeRequest.filter?.urls).toEqual(['file:///*'])
    for (const name of ['onSendHeaders', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'] as const) expect(ses.hooks[name].listener, name).toBeNull()
    // The headers of the navigations are seen whatever the extensions do, for the Client Hints of the engine (shared/client-hints.ts).
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    // The answers of https documents are read whatever the extensions do, for the hosts that ask for strict transport security.
    expect(ses.hooks.onHeadersReceived.filter).toEqual(IDLE_ANSWERS)
  })

  it('widen the request hook as soon as an extension registers a rule, and stop the request the rule covers', async () => {
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/' } }], dynamic: [] })
    expect(ses.hooks.onBeforeRequest.filter?.urls).toEqual([...WEB, 'file:///*'])
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/ads/a.js'))).toEqual({ cancel: true })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/news/a.js'))).toEqual({ cancel: false })
    // The rules gone, the hook is back to the local files alone.
    net.mirror('ext', { session: [], dynamic: [] })
    expect(ses.hooks.onBeforeRequest.filter?.urls).toEqual(['file:///*'])
  })

  it('send a request where a redirect rule says', async () => {
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, action: { type: 'redirect', redirect: { url: 'https://elsewhere.example/b.js' } }, condition: { urlFilter: '/a.js' } }], dynamic: [] })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/a.js'))).toEqual({ redirectURL: 'https://elsewhere.example/b.js' })
  })

  it('never let through what the blocker of the application stops, whatever an allow rule says', async () => {
    const { ses, net } = profile({ blocker: (request) => request.url.includes('/tracker') })
    net.mirror('ext', { session: [{ id: 1, priority: 9, action: { type: 'allow' }, condition: { urlFilter: '/tracker' } }], dynamic: [] })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/tracker.js'))).toEqual({ cancel: true })
  })

  it('never replace a redirect of the application (HTTPS first) by one of their own', async () => {
    const { ses, net, engine } = profile({ privacy: { httpsUpgrade: true, stripTrackingParams: false, globalPrivacyControl: false } })
    engine['upgrades'] = { upgrade: (_id: number, url: string) => url.replace('http:', 'https:') }
    net.mirror('ext', { session: [{ id: 1, action: { type: 'redirect', redirect: { url: 'https://elsewhere.example/' } }, condition: { urlFilter: 'x.example', resourceTypes: ['main_frame'] } }], dynamic: [] })
    const asked = await answer(ses.hooks.onBeforeRequest, details('http://x.example/', { resourceType: 'mainFrame' }))
    expect(asked).toEqual({ redirectURL: 'https://x.example/' })
  })

  it('leave the guard of local files as it is: a local page still cannot read another file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, priority: 9, action: { type: 'allow' }, condition: { resourceTypes: ['xmlhttprequest', 'script'] } }], dynamic: [] })
    const asked = await answer(ses.hooks.onBeforeRequest, { id: 2, url: 'file:///Users/me/.ssh/id_rsa', method: 'GET', resourceType: 'xhr', webContents: page('file:///Users/me/Downloads/page.html') })
    expect(asked).toEqual({ cancel: true })
    warn.mockRestore()
  })

  it('keep the pages of the Chrome Web Store, and what they ask for, out of reach of the rules', async () => {
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, action: { type: 'block' }, condition: { resourceTypes: ['script', 'main_frame'] } }], dynamic: [] })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://chromewebstore.google.com/detail/x', { resourceType: 'mainFrame' }))).toEqual({ cancel: false })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://cdn.example/store.js', { webContents: page('https://chromewebstore.google.com/detail/x') }))).toEqual({ cancel: false })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://cdn.example/store.js'))).toEqual({ cancel: true })
  })

  it('let the request go as the application decided, with a line in the journal, when the rules fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/' } }], dynamic: [] })
    net.beforeRequest = () => {
      throw new Error('the rules broke')
    }
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/ads/a.js'))).toEqual({ cancel: false })
    expect(error.mock.calls.flat().join(' ')).toContain('the request rules of the extensions failed')
    error.mockRestore()
  })

  it('judge a request of a frame with the documents above it, and one of the worker of an extension as that extension asking', async () => {
    const { ses, net } = profile()
    net.mirror('ext', {
      session: [
        { id: 1, action: { type: 'block' }, condition: { urlFilter: '/asset' } },
        { id: 2, priority: 2, action: { type: 'allowAllRequests' }, condition: { urlFilter: '/trusted-frame', resourceTypes: ['sub_frame'] } },
        { id: 3, action: { type: 'block' }, condition: { urlFilter: '/own-api', initiatorDomains: ['ext'] } }
      ],
      dynamic: []
    })
    const top = { url: 'https://page.example/', parent: null, frameTreeNodeId: 3 }
    const inFrame = { url: 'https://x.example/trusted-frame', parent: top, frameTreeNodeId: 9 }
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/asset', { frame: inFrame }))).toEqual({ cancel: false })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/asset'))).toEqual({ cancel: true })
    expect(await answer(ses.hooks.onBeforeRequest, { id: 4, url: 'https://x.example/own-api', method: 'GET', resourceType: 'xhr', initiatorOrigin: 'chrome-extension://ext' })).toEqual({ cancel: true })
    expect(await answer(ses.hooks.onBeforeRequest, { id: 5, url: 'https://x.example/own-api', method: 'GET', resourceType: 'xhr', initiatorOrigin: 'https://page.example' })).toEqual({ cancel: false })
  })
})

describe('the header rules of extensions in the header hooks', () => {
  const headerRule = { id: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-probe', operation: 'set', value: '1' }, { header: 'sec-gpc', operation: 'set', value: '0' }], responseHeaders: [{ header: 'x-answer', operation: 'set', value: '2' }, { header: 'content-security-policy', operation: 'remove' }] }, condition: { urlFilter: 'x.example', resourceTypes: ['main_frame', 'script'] } }

  it('widen the two header hooks only while a header rule exists', () => {
    const { ses, net } = profile()
    net.mirror('ext', { session: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/' } }], dynamic: [] })
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    expect(ses.hooks.onHeadersReceived.filter).toEqual(IDLE_ANSWERS)
    net.mirror('ext', { session: [headerRule], dynamic: [] })
    expect(ses.hooks.onBeforeSendHeaders.filter?.urls).toEqual(WEB)
    expect(ses.hooks.onHeadersReceived.filter).toEqual({ urls: WEB })
    net.mirror('ext', { session: [], dynamic: [] })
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    expect(ses.hooks.onHeadersReceived.filter).toEqual(IDLE_ANSWERS)
  })

  it('rewrite the headers of a request, and leave the Global Privacy Control signal of the application: it is added last', async () => {
    const { ses, net } = profile({ privacy: { httpsUpgrade: false, stripTrackingParams: false, globalPrivacyControl: true } })
    net.mirror('ext', { session: [headerRule], dynamic: [] })
    const asked = await answer(ses.hooks.onBeforeSendHeaders, { ...details('https://x.example/a.js'), requestHeaders: { Accept: '*/*' } })
    expect(asked).toEqual({ requestHeaders: { Accept: '*/*', 'x-probe': '1', 'Sec-GPC': '1' } })
    expect(await answer(ses.hooks.onBeforeSendHeaders, { ...details('https://other.example/a.js'), requestHeaders: { Accept: '*/*' } })).toEqual({ requestHeaders: { Accept: '*/*', 'Sec-GPC': '1' } })
  })

  it('rewrite the headers of an answer, and leave the policy the blocker adds to a document: it is added last', async () => {
    const { ses, net } = profile({ policy: () => "script-src 'self'" })
    net.mirror('ext', { session: [headerRule], dynamic: [] })
    const asked = await answer(ses.hooks.onHeadersReceived, { ...details('https://x.example/', { resourceType: 'mainFrame' }), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Content-Security-Policy': ["img-src 'none'"], 'Content-Type': ['text/html'] } })
    const headers = (asked['responseHeaders'] ?? {}) as Record<string, string[]>
    expect(headers['x-answer']).toEqual(['2'])
    const policies = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'content-security-policy').flatMap(([, value]) => value)
    expect(policies).toEqual(["script-src 'self'"])
    // A script the rule covers gets the header, and no policy: the policy is for documents.
    expect(await answer(ses.hooks.onHeadersReceived, { ...details('https://x.example/a.js'), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Content-Type': ['text/javascript'] } })).toEqual({ responseHeaders: { 'Content-Type': ['text/javascript'], 'x-answer': ['2'] } })
    expect(await answer(ses.hooks.onHeadersReceived, { ...details('https://other.example/a.js'), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Content-Type': ['text/javascript'] } })).toEqual({})
  })

  it('leave the headers as they are, with a line in the journal, when the rules fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, net } = profile()
    net.mirror('ext', { session: [headerRule], dynamic: [] })
    net.headers = () => {
      throw new Error('the rules broke')
    }
    expect(await answer(ses.hooks.onBeforeSendHeaders, { ...details('https://x.example/a.js'), requestHeaders: { Accept: '*/*' } })).toEqual({})
    expect(await answer(ses.hooks.onHeadersReceived, { ...details('https://x.example/a.js'), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: {} })).toEqual({})
    expect(error.mock.calls.flat().join(' ')).toContain('the header rules of the extensions failed on a request')
    expect(error.mock.calls.flat().join(' ')).toContain('the header rules of the extensions failed on an answer')
    error.mockRestore()
  })
})

describe('the listeners of chrome.webRequest in the hooks', () => {
  it('each watching hook is on the session exactly while an extension listens to its event', () => {
    const { ses, net } = profile()
    net.listen('ext', 'frame:1', 'onCompleted', { urls: ['<all_urls>'] }, [], true)
    expect(ses.hooks.onCompleted.filter?.urls).toEqual(WEB)
    expect(ses.hooks.onErrorOccurred.listener).toBeNull()
    expect(ses.hooks.onBeforeRequest.filter?.urls).toEqual(['file:///*'])
    net.contextGone('frame:1')
    expect(ses.hooks.onCompleted.listener).toBeNull()
  })

  it('an extension is told each step of a request, in the shape of the extension platform, and a server that asks for a login too', async () => {
    const { ses, net, sent } = profile()
    for (const event of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred']) net.listen('ext', 'frame:1', event, { urls: ['<all_urls>'] }, ['requestHeaders', 'responseHeaders'], false)
    const asked = details('https://x.example/a.js')
    await answer(ses.hooks.onBeforeRequest, asked)
    await answer(ses.hooks.onBeforeSendHeaders, { ...asked, requestHeaders: { Accept: '*/*' } })
    ses.hooks.onSendHeaders.listener!({ ...asked, requestHeaders: { Accept: '*/*' } }, () => undefined)
    await answer(ses.hooks.onHeadersReceived, { ...asked, statusCode: 401, statusLine: 'HTTP/1.1 401 Unauthorized', responseHeaders: { 'WWW-Authenticate': ['Basic realm="r"'] } })
    ses.hooks.onBeforeRedirect.listener!({ ...asked, statusCode: 302, redirectURL: 'https://x.example/b.js' }, () => undefined)
    ses.hooks.onResponseStarted.listener!({ ...asked, statusCode: 200, fromCache: false }, () => undefined)
    ses.hooks.onCompleted.listener!({ ...asked, statusCode: 200 }, () => undefined)
    ses.hooks.onErrorOccurred.listener!({ ...asked, error: 'net::ERR_FAILED' }, () => undefined)
    expect(sent.map((each) => each.event)).toEqual(['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'])
    const told = Object.fromEntries(sent.map((each) => [each.event, each.args[0] as Record<string, unknown>]))
    expect(told['onBeforeRequest']).toMatchObject({ requestId: '1', url: 'https://x.example/a.js', method: 'GET', type: 'script', tabId: 7, frameId: 0, parentFrameId: -1, initiator: 'https://page.example', timeStamp: 5 })
    expect(told['onSendHeaders']?.['requestHeaders']).toEqual([{ name: 'Accept', value: '*/*' }])
    expect(told['onAuthRequired']).toMatchObject({ scheme: 'basic', realm: 'r', isProxy: false, statusCode: 401 })
    expect(told['onBeforeRedirect']).toMatchObject({ redirectUrl: 'https://x.example/b.js', statusCode: 302 })
    expect(told['onErrorOccurred']).toMatchObject({ error: 'net::ERR_FAILED' })
  })

  it('a request that is not of a tab says so (tabId -1), and a request of a frame names the frame and the one above', async () => {
    const { ses, net, sent } = profile()
    net.listen('ext', 'frame:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], true)
    const top = { url: 'https://page.example/', parent: null, frameTreeNodeId: 3 }
    await answer(ses.hooks.onBeforeRequest, details('https://x.example/a.js', { webContents: { ...page('https://page.example/'), id: 99 }, frame: { url: 'https://page.example/inner', parent: top, frameTreeNodeId: 12 } }))
    expect(sent[0]?.args[0]).toMatchObject({ tabId: -1, frameId: 12, parentFrameId: 0 })
  })

  it('the pages of the Chrome Web Store are not reported to the listeners', async () => {
    const { ses, net, sent } = profile()
    net.listen('ext', 'frame:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], true)
    net.listen('ext', 'frame:1', 'onCompleted', { urls: ['<all_urls>'] }, [], false)
    await answer(ses.hooks.onBeforeRequest, details('https://chromewebstore.google.com/detail/x', { resourceType: 'mainFrame' }))
    ses.hooks.onCompleted.listener!(details('https://chromewebstore.google.com/detail/x', { resourceType: 'mainFrame' }), () => undefined)
    expect(sent).toEqual([])
  })

  it('a request the application makes itself (no page, no frame, no origin that asks) is neither judged by the rules nor reported to the listeners', async () => {
    const { ses, net, sent } = profile()
    net.mirror('ext', {
      session: [
        { id: 1, action: { type: 'block' }, condition: { urlFilter: '/photo', resourceTypes: ['other', 'image', 'xmlhttprequest', 'main_frame'] } },
        { id: 2, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-probe', operation: 'set', value: '1' }], responseHeaders: [{ header: 'x-answer', operation: 'set', value: '2' }] }, condition: { urlFilter: 'x.example', resourceTypes: ['other', 'image', 'xmlhttprequest'] } }
      ],
      dynamic: []
    })
    for (const event of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted']) net.listen('ext', 'frame:1', event, { urls: ['<all_urls>'] }, ['requestHeaders', 'responseHeaders'], false)
    // What `session.fetch` hands the hooks: the application asks, for the images of a page being saved or the probe of a download.
    const own = { id: 8, url: 'https://x.example/photo.png', method: 'GET', resourceType: 'other', timestamp: 5 }
    expect(await answer(ses.hooks.onBeforeRequest, own)).toEqual({ cancel: false })
    expect(await answer(ses.hooks.onBeforeSendHeaders, { ...own, requestHeaders: { Accept: '*/*' } })).toEqual({})
    expect(await answer(ses.hooks.onHeadersReceived, { ...own, statusCode: 200, statusLine: 'HTTP/1.1 200', responseHeaders: { 'content-type': ['image/png'] } })).toEqual({})
    ses.hooks.onCompleted.listener!({ ...own, statusCode: 200 }, () => undefined)
    expect(sent).toEqual([])
    // The same address asked by a page, by a worker of a site (an origin, no frame) or by the extension itself is theirs to judge and to hear.
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/photo.png', { resourceType: 'image' }))).toEqual({ cancel: true })
    expect(await answer(ses.hooks.onBeforeRequest, { ...own, resourceType: 'xhr', initiatorOrigin: 'https://page.example' })).toEqual({ cancel: true })
    expect(await answer(ses.hooks.onBeforeRequest, { ...own, resourceType: 'xhr', initiatorOrigin: 'chrome-extension://ext' })).toEqual({ cancel: true })
    // A navigation is the user's even when its page cannot be read any more.
    expect(await answer(ses.hooks.onBeforeRequest, { ...own, resourceType: 'mainFrame' })).toEqual({ cancel: true })
    expect(sent.map((each) => each.event)).toEqual(['onBeforeRequest', 'onBeforeRequest', 'onBeforeRequest', 'onBeforeRequest'])
  })
})

// The Extensions page shows the journal of an extension. A rule its budget kept from a request left no line there.
describe('a rule of an extension given up for its budget, in the journal of that extension', () => {
  it('gets one line under the extension, in the profile of the session, however many requests it is given up on', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses, net, engine } = profile()
    const notes: Array<{ profileId: string; extensionId: string; message: string }> = []
    engine['extensionTools'] = { note: (profileId: string, extensionId: string, message: string) => void notes.push({ profileId, extensionId, message }) }
    net.mirror('ext', { session: [{ id: 12, action: { type: 'block' }, condition: { urlFilter: `x*${'a'.repeat(200)}b` } }], dynamic: [] })
    const slow = `https://x.example/x${'a'.repeat(20_000)}`
    expect(await answer(ses.hooks.onBeforeRequest, details(slow))).toEqual({ cancel: false })
    expect(await answer(ses.hooks.onBeforeRequest, details(slow))).toEqual({ cancel: false })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ profileId: 'default', extensionId: 'ext' })
    expect(notes[0]?.message).toContain('12')
    expect(notes[0]?.message).not.toContain('x.example')
    quiet.mockRestore()
  })
})


describe('the blocking listeners of a Manifest V2 extension in the hooks', () => {
  const CLASSIC = { manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'] }

  /** A profile with a Manifest V2 extension `mv2` whose background page (`frame:40`) holds a blocking listener on `event`. */
  const classic = (event: string, options: Parameters<typeof profile>[0] = {}) => {
    const made = profile(options)
    made.net.add('mv2', '/mv2', CLASSIC)
    made.net.listen('mv2', 'frame:40', event, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders', 'responseHeaders'], true)
    const askOf = (): unknown => (made.sent.at(-1)?.args[1] as { ask?: unknown } | undefined)?.ask
    return { ...made, askOf }
  }

  afterEach(() => {
    vi.useRealTimers()
    contentsById.clear()
  })

  it('a request waits for the answer of the blocking listener: a cancel stops it, a redirect sends it elsewhere', async () => {
    const { ses, net, askOf } = classic('onBeforeRequest')
    const first = answer(ses.hooks.onBeforeRequest, details('https://x.example/ad.js'))
    let answered = false
    void first.then(() => void (answered = true))
    await Promise.resolve()
    expect(answered).toBe(false)
    net.answer('mv2', 'frame:40', askOf(), [{ cancel: true }])
    expect(await first).toEqual({ cancel: true })
    const second = answer(ses.hooks.onBeforeRequest, details('https://x.example/lib.js'))
    net.answer('mv2', 'frame:40', askOf(), [{ redirectUrl: 'https://cdn.example/lib.js' }])
    expect(await second).toEqual({ redirectURL: 'https://cdn.example/lib.js' })
  })

  it('a request the application or a declarative rule already stops is told to the listener, and never waited for', async () => {
    const { ses, net, sent } = classic('onBeforeRequest', { blocker: (request) => request.url.includes('/tracker') })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/tracker.js'))).toEqual({ cancel: true })
    net.mirror('ext', { session: [{ id: 1, action: { type: 'redirect', redirect: { url: 'https://rule.example/' } }, condition: { urlFilter: '/ruled' } }], dynamic: [] })
    expect(await answer(ses.hooks.onBeforeRequest, details('https://x.example/ruled.js'))).toEqual({ redirectURL: 'https://rule.example/' })
    expect(sent.map((each) => [each.extensionId, each.args.length])).toEqual([
      ['mv2', 1],
      ['mv2', 1]
    ])
  })

  it('past the time it is given, the request goes on as the application decided', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = classic('onBeforeRequest')
    const asked = answer(ses.hooks.onBeforeRequest, details('https://x.example/slow.js'))
    await vi.advanceTimersByTimeAsync(BLOCKING_WAIT_MS)
    expect(await asked).toEqual({ cancel: false })
    expect(warn.mock.calls.flat().join(' ')).toContain('did not answer chrome.webRequest.onBeforeRequest')
    warn.mockRestore()
  })

  it('the headers a listener adds and removes reach the request; the signal of the application is still added last', async () => {
    const { ses, net, askOf } = classic('onBeforeSendHeaders', { privacy: { httpsUpgrade: false, stripTrackingParams: false, globalPrivacyControl: true } })
    const asked = answer(ses.hooks.onBeforeSendHeaders, { ...details('https://x.example/a.js'), requestHeaders: { Accept: '*/*', Cookie: 'a=1' } })
    net.answer('mv2', 'frame:40', askOf(), [{ requestHeaders: [{ name: 'Accept', value: '*/*' }, { name: 'X-Added', value: '1' }, { name: 'Sec-GPC', value: '0' }] }])
    expect(await asked).toEqual({ requestHeaders: { Accept: '*/*', 'X-Added': '1', 'Sec-GPC': '1' } })
    const cancelled = answer(ses.hooks.onBeforeSendHeaders, { ...details('https://x.example/b.js'), requestHeaders: { Accept: '*/*' } })
    net.answer('mv2', 'frame:40', askOf(), [{ cancel: true }])
    expect(await cancelled).toEqual({ cancel: true })
  })

  it('the headers of an answer a listener changes, and a redirect it asks for there: a 302 to its target', async () => {
    const { ses, net, askOf } = classic('onHeadersReceived')
    const changed = answer(ses.hooks.onHeadersReceived, { ...details('https://x.example/a.js'), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Content-Type': ['text/javascript'], 'X-Drop': ['1'] } })
    net.answer('mv2', 'frame:40', askOf(), [{ responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'X-Added', value: '2' }] }])
    expect(await changed).toEqual({ responseHeaders: { 'Content-Type': ['text/javascript'], 'X-Added': ['2'] } })
    const redirected = answer(ses.hooks.onHeadersReceived, { ...details('https://x.example/b.js'), statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Content-Type': ['text/javascript'] } })
    net.answer('mv2', 'frame:40', askOf(), [{ redirectUrl: 'https://cdn.example/b.js' }])
    expect(await redirected).toEqual({ responseHeaders: { 'Content-Type': ['text/javascript'], Location: ['https://cdn.example/b.js'] }, statusLine: 'HTTP/1.1 302 Found' })
  })

  it('what a listener of onAuthRequired answers waits for the question of the page, in the session of its profile only', async () => {
    const { ses, net, askOf } = classic('onAuthRequired')
    const url = 'https://x.example/private'
    const asked = answer(ses.hooks.onHeadersReceived, { ...details(url, { resourceType: 'mainFrame' }), statusCode: 401, statusLine: 'HTTP/1.1 401 Unauthorized', responseHeaders: { 'WWW-Authenticate': ['Basic realm="r"'] } })
    await Promise.resolve()
    net.answer('mv2', 'frame:40', askOf(), [{ authCredentials: { username: 'u', password: 'p' } }])
    expect(await asked).toEqual({})
    expect(listenerLogins.take({}, url, Date.now())).toBeNull()
    expect(listenerLogins.take(ses, url, Date.now())).toEqual({ credentials: { username: 'u', password: 'p' } })
  })

  it('the background page of the extension, which is not a panel, is sent the event by its id; a page of another extension or profile is not', async () => {
    const { ses, net, engine, askOf } = classic('onBeforeRequest')
    ;(engine['manifests'] as Map<string, unknown>).set('default:mv2', CLASSIC)
    const background = { isDestroyed: () => false, getURL: () => 'chrome-extension://mv2/_generated_background_page.html', session: ses, send: vi.fn() }
    contentsById.set(40, background)
    const asked = answer(ses.hooks.onBeforeRequest, details('https://x.example/a.js'))
    expect(background.send).toHaveBeenCalledWith('lucium-shim-event', 'webRequest', 'onBeforeRequest', [expect.objectContaining({ url: 'https://x.example/a.js' }), { ask: askOf() }])
    net.answer('mv2', 'frame:40', askOf(), [])
    await asked
    // The same id, once it shows a page of another extension, or lives in another profile, is sent nothing.
    for (const other of [{ ...background, getURL: () => 'chrome-extension://other/page.html', send: vi.fn() }, { ...background, session: {}, send: vi.fn() }]) {
      contentsById.set(40, other)
      const again = answer(ses.hooks.onBeforeRequest, details('https://x.example/a.js'))
      net.answer('mv2', 'frame:40', askOf(), [])
      await again
      expect(other.send).not.toHaveBeenCalled()
    }
  })
})
