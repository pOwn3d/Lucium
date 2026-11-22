// The bypass of tracking redirects and AMP wrappers in the request hook of a session of pages: a main-frame navigation to a wrapped link is
// sent to its destination, a subresource, a POST and a site of the exceptions are not, and with the option off the hook is not even installed
// for the web. Run on stand-ins of the engine and the session (the real network is checked by the engine run, which this suite does not start).

import { describe, expect, it, vi } from 'vitest'

type Listener = (details: Record<string, unknown>, callback: (answer: Record<string, unknown>) => void) => void
type Hook = { filter: { urls: string[] } | null; listener: Listener | null }

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
  const before: Hook = { filter: null, listener: null }
  const noop = () => undefined
  return {
    before,
    webRequest: {
      onBeforeRequest: (filter: Hook['filter'], listener?: Listener) => {
        before.filter = filter
        before.listener = listener ?? null
      },
      onBeforeSendHeaders: noop,
      onHeadersReceived: noop
    },
    protocol: { handle: noop, unhandle: noop },
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
    upgrades: { upgrade: () => null },
    ownRequests: { set: () => undefined },
    profiles: new Map(),
    siteIcons: { clear: () => undefined }
  })
}

const OFF = { httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [] as string[], unwrapRedirects: false, unwrapExceptions: [] as string[] }
const ON = { ...OFF, unwrapRedirects: true }
const WRAPPED = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexemple.fr%2Fa%3Futm_source%3Dfb'
const tab = { getURL: () => 'https://www.facebook.com/', isDestroyed: () => false, id: 7 }
const answer = (listener: Listener, details: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve) => listener(details, resolve))
const nav = (url: string, patch: Record<string, unknown> = {}) => ({ id: 1, url, method: 'GET', resourceType: 'mainFrame', webContents: tab, ...patch })

function sessionWith(options: typeof OFF | null) {
  const ses = fakeSession()
  methods['installRequestBlocker']!.call(idleEngine(), ses, () => null, '', () => options)
  return ses
}

describe('bypass of redirects and AMP in the request hook', () => {
  it('sends a navigation to a wrapped link to its destination', async () => {
    const ses = sessionWith(ON)
    expect(ses.before.filter?.urls).toEqual(expect.arrayContaining(['https://*/*']))
    expect(await answer(ses.before.listener!, nav(WRAPPED))).toEqual({ redirectURL: 'https://exemple.fr/a?utm_source=fb' })
  })

  it('then takes the tracking parameters off when that option is on too: one answer for the whole chain', async () => {
    const ses = sessionWith({ ...ON, stripTrackingParams: true })
    expect(await answer(ses.before.listener!, nav(WRAPPED))).toEqual({ redirectURL: 'https://exemple.fr/a' })
  })

  it('opens the publisher page for an AMP cache address', async () => {
    const ses = sessionWith(ON)
    expect(await answer(ses.before.listener!, nav('https://exemple-fr.cdn.ampproject.org/c/s/exemple.fr/a?amp_js_v=a6'))).toEqual({ redirectURL: 'https://exemple.fr/a' })
  })

  it('leaves a subresource, a POST and an address that is not wrapped alone', async () => {
    const ses = sessionWith(ON)
    expect(await answer(ses.before.listener!, nav(WRAPPED, { resourceType: 'image' }))).toEqual({ cancel: false })
    expect(await answer(ses.before.listener!, nav(WRAPPED, { method: 'POST' }))).toEqual({ cancel: false })
    expect(await answer(ses.before.listener!, nav('https://exemple.fr/a'))).toEqual({ cancel: false })
  })

  it('leaves the links of a site on the list of exceptions alone', async () => {
    const ses = sessionWith({ ...ON, unwrapExceptions: ['facebook.com'] })
    expect(await answer(ses.before.listener!, nav(WRAPPED))).toEqual({ cancel: false })
  })

  it('costs nothing while the option is off: the web is not listened to, and an answer, if asked, changes nothing', async () => {
    const ses = sessionWith(OFF)
    expect(ses.before.filter?.urls).not.toContain('https://*/*')
    expect(await answer(ses.before.listener!, nav(WRAPPED))).toEqual({ cancel: false })
  })
})
