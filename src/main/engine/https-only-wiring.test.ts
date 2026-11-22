// « HTTPS seul » in the request hook of a session of pages: an http navigation of a page the engine knows (a tab, a popup, the mini window: all attach to the
// same memory of upgrades) goes to https, an address that cannot be upgraded is cancelled, the local network and the excepted sites are left alone, and with
// the option off the hook does what it did. Run on stand-ins of the engine and the session (the real network is checked by the engine run, which this suite
// does not start).

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
const { HttpsUpgrades } = await import('./https-upgrade')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

function fakeSession() {
  const sending: Hook = { filter: null, listener: null }
  const received: Hook = { filter: null, listener: null }
  const requests: Hook = { filter: null, listener: null }
  const keep = (into: Hook) => (filter: Hook['filter'], listener?: Listener) => {
    into.filter = filter
    into.listener = listener ?? null
  }
  return {
    sending,
    received,
    requests,
    webRequest: { onBeforeRequest: keep(requests), onBeforeSendHeaders: keep(sending), onHeadersReceived: keep(received) },
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
    siteIcons: { clear: () => undefined },
    upgrades: new HttpsUpgrades()
  })
}

const OFF = { httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [] as string[], trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] as string[] }
const ON = { ...OFF, httpsOnly: true }
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

const PAGE_ID = 7
const attach = (engine: Record<string, unknown>) =>
  (engine['upgrades'] as InstanceType<typeof HttpsUpgrades>).attach(PAGE_ID, { navigate: () => undefined, isLoading: () => true, stop: () => undefined, fellBack: () => undefined })
const nav = (url: string, method = 'GET', resourceType = 'mainFrame') => ({ id: 1, url, method, resourceType, webContents: tab('https://news.test/') })

function hooked(options: typeof OFF | null) {
  const { ses, engine } = sessionWith(options)
  attach(engine)
  return { ses, engine }
}

describe('« HTTPS seul » in the request hook', () => {
  it('sends an http navigation to https, with HTTPS first off', async () => {
    const { ses } = hooked(ON)
    expect(ses.requests.filter?.urls).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']))
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr/a?b=1'))).toEqual({ redirectURL: 'https://exemple.fr/a?b=1' })
  })

  it('strips the tracking parameters on the way when that option is on too', async () => {
    const { ses } = hooked({ ...ON, stripTrackingParams: true })
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr/a?utm_source=x&b=1'))).toEqual({ redirectURL: 'https://exemple.fr/a?b=1' })
  })

  it('cancels an http address that cannot be upgraded, and a second visit of a site that sends its https visitors back to http', async () => {
    const { ses } = hooked(ON)
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr:8080/a'))).toEqual({ cancel: true })
    expect(await answer(ses.requests.listener!, nav('http://autre.fr/a'))).toEqual({ redirectURL: 'https://autre.fr/a' })
    expect(await answer(ses.requests.listener!, nav('http://autre.fr/a'))).toEqual({ cancel: true })
  })

  it('leaves alone the local network, an excepted site, an https address, and what is not a navigation of the tab', async () => {
    const { ses } = hooked({ ...ON, httpsOnlyExceptions: ['vieux.fr'] })
    expect(await answer(ses.requests.listener!, nav('http://localhost:3000/'))).toEqual({ cancel: false })
    expect(await answer(ses.requests.listener!, nav('http://www.vieux.fr/a'))).toEqual({ cancel: false })
    expect(await answer(ses.requests.listener!, nav('https://exemple.fr/'))).toEqual({ cancel: false })
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr/a.png', 'GET', 'image'))).toEqual({ cancel: false })
    expect(await answer(ses.requests.listener!, { ...nav('http://exemple.fr/a'), webContents: tab('https://news.test/'), id: 3 })).toEqual({ redirectURL: 'https://exemple.fr/a' })
  })

  it('does not touch a page the engine does not know (a worker, an extension)', async () => {
    const { ses } = sessionWith(ON)
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr:8080/a'))).toEqual({ cancel: false })
  })

  it('opens an address on the click of « Continuer en HTTP »: the refused address goes through once', async () => {
    const { ses, engine } = hooked(ON)
    const upgrades = engine['upgrades'] as InstanceType<typeof HttpsUpgrades>
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr:8080/a'))).toEqual({ cancel: true })
    upgrades.failed(PAGE_ID, 'http://exemple.fr:8080/a', -20)
    upgrades.continueOverHttp(PAGE_ID, 'http://exemple.fr:8080/a')
    expect(await answer(ses.requests.listener!, nav('http://exemple.fr:8080/a'))).toEqual({ cancel: false })
  })

  it('does nothing of it with the option off, and HTTPS first alone keeps its timer and its fall back', async () => {
    const { ses } = hooked(OFF)
    expect(ses.requests.filter?.urls).toEqual(['file:///*'])
    const first = hooked({ ...OFF, httpsUpgrade: true })
    expect(await answer(first.ses.requests.listener!, nav('http://exemple.fr:8080/a'))).toEqual({ cancel: false })
    expect(await answer(first.ses.requests.listener!, nav('http://exemple.fr/a'))).toEqual({ redirectURL: 'https://exemple.fr/a' })
  })
})
