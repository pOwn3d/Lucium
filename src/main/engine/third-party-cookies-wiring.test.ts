// Third-party cookies in the header hooks of a session of pages: the `Cookie` of a request to another site than the tab's is not sent, the
// `Set-Cookie` of its answer is not kept, a navigation and the site's own requests are left alone, and with the option off the hooks do
// nothing for it. Run on stand-ins of the engine and the session (the real network is checked by the engine run, which this suite does not start).

import { describe, expect, it, vi } from 'vitest'

type Listener = (details: Record<string, unknown>, callback: (answer: Record<string, unknown>) => void) => void
type Hook = { filter: { urls: string[]; types?: string[] } | null; listener: Listener | null }

vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: () => '/tmp/lucium-test' },
    session: { defaultSession: {}, fromPartition: () => undefined }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { PendingReads } = await import('./local-file-guard')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

function fakeSession() {
  const sending: Hook = { filter: null, listener: null }
  const received: Hook = { filter: null, listener: null }
  const keep = (into: Hook) => (filter: Hook['filter'], listener?: Listener) => {
    into.filter = filter
    into.listener = listener ?? null
  }
  return {
    sending,
    received,
    webRequest: { onBeforeRequest: () => undefined, onBeforeSendHeaders: keep(sending), onHeadersReceived: keep(received) },
    protocol: { handle: () => undefined, unhandle: () => undefined },
    isPersistent: () => false,
    getStoragePath: () => null
  }
}

function idleEngine(): Record<string, unknown> {
  return Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    requestBlocker: null,
    privacy: null,
    pageByContents: new Map(),
    scopes: new Map(),
    localPageSessions: new WeakSet(),
    headerHooks: new WeakMap(),
    signIn: null,
    signInSessions: new WeakSet(),
    requestHooks: new WeakMap(),
    extensionNets: new WeakMap(),
    localPageReads: new PendingReads(),
    standInSessions: new WeakSet(),
    standInWords: new WeakMap(),
    ownRequests: { set: () => undefined },
    profiles: new Map(),
    siteIcons: { clear: () => undefined }
  })
}

const OFF = { httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [] as string[] }
const ON = { ...OFF, blockThirdPartyCookies: true }
const WEB = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
const tab = (url: string) => ({ getURL: () => url, isDestroyed: () => false, id: 7 })
const answer = (listener: Listener, details: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve) => listener(details, resolve))

/** A session whose hooks were installed the way `setPrivacy` and the response policy do, with these privacy options. */
function sessionWith(options: typeof OFF | null) {
  const ses = fakeSession()
  const engine = idleEngine()
  const holder = { options }
  methods['installRequestBlocker']!.call(engine, ses, () => null, '', () => holder.options)
  methods['installResponsePolicy']!.call(engine, ses, () => null)
  return { ses, engine, holder }
}

const request = (url: string, top: string, resourceType = 'image') => ({ id: 1, url, method: 'GET', resourceType, webContents: tab(top), requestHeaders: { Cookie: 'id=42', Accept: '*/*' } })
const reply = (url: string, top: string, resourceType = 'image') => ({ id: 1, url, method: 'GET', resourceType, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', webContents: tab(top), responseHeaders: { 'Set-Cookie': ['id=42'], 'Content-Type': ['image/gif'] } })

describe('third-party cookies in the header hooks', () => {
  it('does not send the cookie of a request to another site, and sends the site\'s own', async () => {
    const { ses } = sessionWith(ON)
    expect(ses.sending.filter).toEqual({ urls: WEB })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', 'https://news.test/a'))).toEqual({ requestHeaders: { Accept: '*/*' } })
    expect(await answer(ses.sending.listener!, request('https://cdn.news.test/p.gif', 'https://news.test/a'))).toEqual({})
  })

  it('leaves the navigation of the tab and a request with no page known alone', async () => {
    const { ses } = sessionWith(ON)
    expect(await answer(ses.sending.listener!, request('https://other.test/', 'https://news.test/a', 'mainFrame'))).toEqual({})
    expect(await answer(ses.sending.listener!, { id: 2, url: 'https://tracker.test/p.gif', method: 'GET', resourceType: 'image', requestHeaders: { Cookie: 'id=42' } })).toEqual({})
  })

  it('keeps the cookie on a site of the list of exceptions', async () => {
    const { ses } = sessionWith({ ...ON, thirdPartyCookieExceptions: ['news.test'] })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', 'https://www.news.test/a'))).toEqual({})
  })

  it('does not keep the Set-Cookie of the answer to a request to another site, and keeps the site\'s own', async () => {
    const { ses } = sessionWith(ON)
    expect(ses.received.filter?.urls).toEqual(WEB)
    expect(await answer(ses.received.listener!, reply('https://tracker.test/p.gif', 'https://news.test/a'))).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } })
    expect(await answer(ses.received.listener!, reply('https://news.test/p.gif', 'https://news.test/a'))).toEqual({})
    expect(await answer(ses.received.listener!, reply('https://tracker.test/', 'https://news.test/a', 'mainFrame'))).toEqual({})
  })

  it('cuts the cookies of the handshake of a WebSocket to another site, with the option alone: the filters take the ws and wss addresses', async () => {
    const { ses } = sessionWith(ON)
    expect(ses.sending.filter?.urls).toEqual(expect.arrayContaining(['ws://*/*', 'wss://*/*']))
    expect(ses.received.filter?.urls).toEqual(expect.arrayContaining(['ws://*/*', 'wss://*/*']))
    expect(await answer(ses.sending.listener!, request('wss://tracker.test/socket', 'https://news.test/a', 'webSocket'))).toEqual({ requestHeaders: { Accept: '*/*' } })
    expect(await answer(ses.sending.listener!, request('wss://news.test/socket', 'https://news.test/a', 'webSocket'))).toEqual({})
    const upgrade = { ...reply('wss://tracker.test/socket', 'https://news.test/a', 'webSocket'), statusCode: 101, statusLine: 'HTTP/1.1 101 Switching Protocols' }
    expect(await answer(ses.received.listener!, upgrade)).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } })
    expect(await answer(ses.received.listener!, { ...upgrade, url: 'wss://news.test/socket' })).toEqual({})
  })

  it('installs the cookie cut of a private window or a container by the setPrivacy of its scope, on the request side and on the answer side', async () => {
    const ses = fakeSession()
    const engine = idleEngine()
    const scope = { session: ses, blocker: null, prefix: '', privacy: null as typeof OFF | null, responsePolicy: null }
    methods['scopeSetPrivacy']!.call(engine, scope, ON)
    expect(ses.sending.filter?.urls).toEqual(WEB)
    expect(ses.received.filter?.urls).toEqual(WEB)
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', 'https://news.test/a'))).toEqual({ requestHeaders: { Accept: '*/*' } })
    expect(await answer(ses.received.listener!, reply('https://tracker.test/p.gif', 'https://news.test/a'))).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } })
    methods['scopeSetPrivacy']!.call(engine, scope, null)
    expect(ses.received.filter).toEqual({ urls: ['https://*/*'], types: ['mainFrame'] })
  })

  it('costs nothing while the option is off: only the navigations are looked at, and no header is touched', async () => {
    const { ses } = sessionWith(null)
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] })
    expect(ses.received.filter).toEqual({ urls: ['https://*/*'], types: ['mainFrame'] })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', 'https://news.test/a', 'subFrame'))).toEqual({})
  })

  it('is installed again by a change of the privacy options, on the request side and on the answer side', async () => {
    const ses = fakeSession()
    const engine = Object.assign(idleEngine(), { profiles: new Map([['p1', { session: ses }]]) })
    methods['installRequestBlocker']!.call(engine, ses)
    methods['installResponsePolicy']!.call(engine, ses, () => null)
    expect(ses.received.filter).toEqual({ urls: ['https://*/*'], types: ['mainFrame'] })
    methods['setPrivacy']!.call(engine, ON)
    expect(ses.sending.filter).toEqual({ urls: WEB })
    expect(ses.received.filter).toEqual({ urls: WEB })
    expect(await answer(ses.received.listener!, reply('https://tracker.test/p.gif', 'https://news.test/a'))).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } })
    methods['setPrivacy']!.call(engine, null)
    expect(ses.received.filter).toEqual({ urls: ['https://*/*'], types: ['mainFrame'] })
  })

  it('leaves the cookies alone, and says why, when the page of the tab cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses } = sessionWith(ON)
    const broken = { ...request('https://tracker.test/p.gif', 'https://news.test/a'), webContents: { isDestroyed: () => false, getURL: () => { throw new Error('gone') } } }
    expect(await answer(ses.sending.listener!, broken)).toEqual({})
    expect(error).toHaveBeenCalledWith(expect.stringContaining('its cookies are left alone'), 'gone')
    error.mockRestore()
  })
})
