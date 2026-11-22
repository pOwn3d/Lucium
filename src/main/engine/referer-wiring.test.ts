// The Referer in the header hook of a session of pages: with the option on, a request to another site carries the origin of the page alone, a request
// inside the site keeps its whole Referer, and with the option off the hook reads nothing for it. Run on stand-ins of the engine and the session (the real
// network is checked by the engine run, which this suite does not start).

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

const OFF = { httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [] as string[], trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] as string[] }
const ON = { ...OFF, trimReferer: true }
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

const request = (url: string, referer: string | null, resourceType = 'image', headerName = 'Referer') => ({
  id: 1, url, method: 'GET', resourceType, webContents: tab('https://news.test/a/b?token=1'),
  requestHeaders: { Accept: '*/*', ...(referer === null ? {} : { [headerName]: referer }) }
})
const PAGE = 'https://news.test/a/b?token=1'

describe('the Referer in the header hook', () => {
  it('sends the origin of the page alone to another site, and keeps the other headers', async () => {
    const { ses } = sessionWith(ON)
    expect(ses.sending.filter).toEqual({ urls: WEB })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', PAGE))).toEqual({ requestHeaders: { Accept: '*/*', Referer: 'https://news.test/' } })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', PAGE, 'image', 'referer'))).toEqual({ requestHeaders: { Accept: '*/*', referer: 'https://news.test/' } })
  })

  it('trims the Referer of a navigation to another site too (a click on a link), and of a WebSocket handshake', async () => {
    const { ses } = sessionWith(ON)
    expect(await answer(ses.sending.listener!, request('https://other.test/', PAGE, 'mainFrame'))).toEqual({ requestHeaders: { Accept: '*/*', Referer: 'https://news.test/' } })
    expect(await answer(ses.sending.listener!, request('wss://tracker.test/socket', PAGE, 'webSocket'))).toEqual({ requestHeaders: { Accept: '*/*', Referer: 'https://news.test/' } })
  })

  it('leaves the Referer of a request inside the site, and a request with none, alone', async () => {
    const { ses } = sessionWith(ON)
    expect(await answer(ses.sending.listener!, request('https://cdn.news.test/app.js', PAGE))).toEqual({})
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', null))).toEqual({})
  })

  it('costs nothing while the option is off: only the navigations are looked at, and no Referer is touched', async () => {
    const { ses } = sessionWith(OFF)
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] })
    expect(await answer(ses.sending.listener!, request('https://other.test/', PAGE, 'subFrame'))).toEqual({})
  })

  it('is installed by the setPrivacy of a private window or a container, and again by a change of the options', async () => {
    const ses = fakeSession()
    const engine = idleEngine()
    const scope = { session: ses, blocker: null, prefix: '', privacy: null as typeof OFF | null, responsePolicy: null }
    methods['scopeSetPrivacy']!.call(engine, scope, ON)
    expect(ses.sending.filter).toEqual({ urls: WEB })
    expect(await answer(ses.sending.listener!, request('https://tracker.test/p.gif', PAGE))).toEqual({ requestHeaders: { Accept: '*/*', Referer: 'https://news.test/' } })
    methods['scopeSetPrivacy']!.call(engine, scope, null)
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] })
  })
})
