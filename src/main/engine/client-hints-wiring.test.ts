// The three Client Hints of the navigations (shared/client-hints.ts) in the header hook of the sessions of pages (electron-engine-network.ts):
// on every session of pages (a profile's, a private window's, a container's) with every option off, for the navigations alone while nothing else
// needs the hook; added before the rules of the extensions, which may change or remove them as in Chrome, and before the Global Privacy Control
// signal, which stays last. Run on stand-ins of the engine and the session; in a real Electron: `LUCIUM_SMOKE_ONLY=client-hints` (smoke-client-hints.ts).

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { clientHintsOf } from '@shared/client-hints'
import type { GoogleSignInIdentity } from '@shared/google-sign-in'
import { SignInAgents } from './google-sign-in-agent'

type Answer = Record<string, unknown>
type Listener = (details: Record<string, unknown>, callback: (answer: Answer) => void) => void
type Hook = { filter: { urls: string[]; types?: string[] } | null; listener: Listener | null }

const holder = vi.hoisted(() => ({ partitions: new Map<string, unknown>() }))
vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => (name === 'home' ? '/Users/me' : `/tmp/lucium-test-${name}`) },
    session: { defaultSession: {}, fromPartition: (name: string) => holder.partitions.get(name) }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { PendingReads } = await import('./local-file-guard')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

// What a page of Chromium 156 on macOS read of navigator.userAgentData, and the headers Chromium put on its requests, measured on 13 November 2026.
const HINTS = clientHintsOf({ brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }], mobile: false, platform: 'macOS' })!
const MEASURED = { 'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' }
const WEB = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
const NAVIGATIONS_ONLY = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] }
const GPC_ON = { globalPrivacyControl: true, httpsUpgrade: false, stripTrackingParams: false }

const HOOKS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'] as const

/** A session that keeps the filter and the listener of each of its hooks. */
function fakeSession(persistent: boolean) {
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
  return { hooks, webRequest, protocol: { handle: () => undefined, unhandle: () => undefined }, isPersistent: () => persistent, getStoragePath: () => null }
}

/** An engine with no blocker, no privacy option and no extension, whose header hook adds `hints` (null: an engine with none to give). */
function engineWith(hints: typeof HINTS | null, privacy: Record<string, unknown> | null = null, signIn: SignInAgents | null = null): Record<string, unknown> {
  return Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    navigationHints: () => hints,
    signIn,
    signInSessions: new WeakSet(),
    requestBlocker: null,
    privacy,
    responsePolicy: null,
    pageByContents: new Map(),
    tabMeta: new Map([[7, {}]]),
    profiles: new Map(),
    scopes: new Map(),
    containerScopes: new Map(),
    scopeCounter: 0,
    proxyPlan: null,
    localPageSessions: new WeakSet(),
    headerHooks: new WeakMap(),
    requestHooks: new WeakMap(),
    extensionNets: new WeakMap(),
    netWakes: new Map(),
    localPageReads: new PendingReads(),
    standInSessions: new WeakSet(),
    standInWords: new WeakMap(),
    upgrades: { upgrade: (): string | null => null },
    installPermissions: () => undefined,
    installDisplayMedia: () => undefined,
    installDownloads: () => undefined,
    emitShimEvent: () => undefined,
    deliverToWorker: async () => undefined,
    manifests: new Map(),
    extensionFrames: new Set(),
    extensionLedger: () => ({ netChoices: () => undefined, keepNetChoices: () => undefined }),
    profileOfSession: () => 'default'
  })
}

const moment = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const page = (url: string) => ({ getURL: () => url, isDestroyed: () => false, id: 7 })
const ASKED = { 'Upgrade-Insecure-Requests': '1', 'User-Agent': 'Mozilla/5.0 Chrome/156.0.0.0', Accept: 'text/html' }
const navigation = (url: string, resourceType = 'mainFrame', requestHeaders: Record<string, string> = ASKED) => ({ id: 1, url, method: 'GET', resourceType, webContents: page('https://page.example/'), frame: null, timestamp: 5, requestHeaders })
const answer = (hook: Hook, asked: Record<string, unknown>): Promise<Answer> => new Promise((resolve) => hook.listener!(asked, resolve))

describe('the Client Hints of the navigations in the sessions of pages', () => {
  it('a profile session with every option off: a hook on the navigations alone, which carry the three hints in front, the other requests untouched', async () => {
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(engineWith(HINTS), ses)
    const hook = ses.hooks.onBeforeSendHeaders
    expect(hook.filter).toEqual(NAVIGATIONS_ONLY)
    const tab = await answer(hook, navigation('https://site.example/'))
    expect(tab).toEqual({ requestHeaders: { ...MEASURED, ...ASKED } })
    expect(Object.keys(tab['requestHeaders'] as object)).toEqual([...Object.keys(MEASURED), ...Object.keys(ASKED)])
    expect(await answer(hook, navigation('https://frame.example/', 'subFrame'))).toEqual({ requestHeaders: { ...MEASURED, ...ASKED } })
    expect(await answer(hook, navigation('http://localhost:5173/'))).toEqual({ requestHeaders: { ...MEASURED, ...ASKED } })
  })

  it('never to plain http of another machine, never in place of a hint already there, never on a subresource', async () => {
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(engineWith(HINTS), ses)
    const hook = ses.hooks.onBeforeSendHeaders
    expect(await answer(hook, navigation('http://site.example/'))).toEqual({})
    expect(await answer(hook, navigation('https://site.example/', 'mainFrame', { ...ASKED, 'Sec-CH-UA': '"Other";v="1"' }))).toEqual({})
    // Should the hook see one (it is widened for another reason), an image keeps what Chromium gave it.
    expect(await answer(hook, navigation('https://site.example/a.gif', 'image', { Accept: 'image/*' }))).toEqual({})
  })

  it('while the hints of the engine are not read: the hook is there for the navigations, which leave as Chromium sends them, with nothing guessed', async () => {
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(engineWith(null), ses)
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/'))).toEqual({})
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://frame.example/', 'subFrame'))).toEqual({})
  })

  it('are on the session of a private window and of a container as soon as they open', async () => {
    const engine = engineWith(HINTS)
    const privateSession = fakeSession(false)
    holder.partitions.set('ephemeral-1', privateSession)
    methods['openEphemeral']!.call(engine, 'w1')
    const containerSession = fakeSession(true)
    holder.partitions.set('persist:container-c1', containerSession)
    methods['openContainer']!.call(engine, 'c1', 'w1')
    for (const ses of [privateSession, containerSession]) {
      expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
      expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/'))).toEqual({ requestHeaders: { ...MEASURED, ...ASKED } })
    }
  })

  it('with Global Privacy Control on: the hook sees every web request, the navigations carry the hints and the signal last, the rest the signal alone', async () => {
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(engineWith(HINTS, GPC_ON), ses)
    const hook = ses.hooks.onBeforeSendHeaders
    expect(hook.filter).toEqual({ urls: WEB })
    const tab = await answer(hook, navigation('https://site.example/'))
    expect(Object.keys(tab['requestHeaders'] as object)).toEqual([...Object.keys(MEASURED), ...Object.keys(ASKED), 'Sec-GPC'])
    expect(await answer(hook, navigation('https://site.example/a.js', 'script', { Accept: '*/*' }))).toEqual({ requestHeaders: { Accept: '*/*', 'Sec-GPC': '1' } })
    expect(await answer(hook, { ...navigation('wss://site.example/live', 'webSocket', { Upgrade: 'websocket' }) })).toEqual({ requestHeaders: { Upgrade: 'websocket', 'Sec-GPC': '1' } })
  })

  it('reach the rules of the extensions as Chromium hands its hints to them: a rule may remove one or set it, and the signal of the application stays last', async () => {
    const ses = fakeSession(true)
    const engine = engineWith(HINTS, GPC_ON)
    const net = methods['extensionNetOf']!.call(engine, ses, 'default') as import('./extension-net').ExtensionNet
    methods['installRequestBlocker']!.call(engine, ses)
    net.add('ext', '/ext', { manifest_version: 3, permissions: ['declarativeNetRequest'], host_permissions: ['<all_urls>'] })
    const rule = {
      id: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'sec-ch-ua-platform', operation: 'remove' }, { header: 'sec-ch-ua', operation: 'set', value: '"Other";v="1"' }, { header: 'sec-gpc', operation: 'set', value: '0' }] },
      condition: { urlFilter: 'x.example', resourceTypes: ['main_frame'] }
    }
    net.mirror('ext', { session: [rule], dynamic: [] })
    const sent = (await answer(ses.hooks.onBeforeSendHeaders, navigation('https://x.example/')))['requestHeaders'] as Record<string, string>
    const lower = Object.fromEntries(Object.entries(sent).map(([name, value]) => [name.toLowerCase(), value]))
    expect(lower['sec-ch-ua']).toBe('"Other";v="1"')
    expect(lower).not.toHaveProperty('sec-ch-ua-platform')
    expect(lower['sec-ch-ua-mobile']).toBe('?0')
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'sec-gpc')).toEqual([['Sec-GPC', '1']])
    // A navigation the rule does not cover carries the three as they are.
    const other = (await answer(ses.hooks.onBeforeSendHeaders, navigation('https://other.example/')))['requestHeaders'] as Record<string, string>
    expect(other).toMatchObject(MEASURED)
  })

  it('are read from the page of the main window, which hands its web contents to the engine before that page loads and before any tab is restored', () => {
    const main = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const handed = main.indexOf('engine.learnClientHints(win.webContents)')
    expect(handed).toBeGreaterThan(-1)
    expect(handed).toBeLessThan(main.indexOf("load(win.webContents, { page: 'index' })"))
    expect(handed).toBeLessThan(main.indexOf('browser.start()'))
  })

  it('make a navigation wait while the hints are awaited, and send it on with them, or as Chromium sends it when the wait ends without them', async () => {
    const pending: Array<(hints: typeof HINTS | null) => void> = []
    const ses = fakeSession(true)
    const engine = Object.assign(engineWith(HINTS), { navigationHints: () => new Promise((resolve) => pending.push(resolve)) })
    methods['installRequestBlocker']!.call(engine, ses)
    let first: Answer | null = null
    const firstAnswered = answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/')).then((given) => (first = given))
    // A subresource never waits: Chromium has put the hints on it already.
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/a.js', 'script', { Accept: '*/*' }))).toEqual({})
    await Promise.resolve()
    expect(first).toBeNull()
    pending.shift()!(HINTS)
    await firstAnswered
    expect(first).toEqual({ requestHeaders: { ...MEASURED, ...ASKED } })
    const second = answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/b'))
    pending.shift()!(null)
    expect(await second).toEqual({})
  })
})

// The identity of the sign-in pages of Google (shared/google-sign-in.ts, engine/google-sign-in-agent.ts) in the same hook: nothing while the engine has none (`signIn` null: the pages were not made
// a Chrome); with one, the sign-in requests carry Electron's user agent and none of the hints of Lucium, and the hook sees every request of a session only after a tab of it was on the hosts.
// Run on stand-ins; the answer of Google is for a person with a window.
describe('the identity of the sign-in pages of Google in the header hook of the sessions of pages', () => {
  const PAGE_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  const ELECTRON_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lucium/1.1.0 Chrome/156.0.8078.48 Electron/45.2.1 Safari/537.36'
  const identity: GoogleSignInIdentity = { agent: ELECTRON_AGENT, pageAgent: PAGE_AGENT }
  const PAGE_ASKED = { ...ASKED, 'User-Agent': PAGE_AGENT }
  const SIGN_IN = 'https://accounts.google.com/v3/signin/identifier'
  const WEB_ONLY = { urls: ['http://*/*', 'https://*/*'] }

  /** A tab (the web contents 7 of `navigation`) of `ses`, followed by `agents`, that is on the sign-in host already, or not. */
  function tab(agents: SignInAgents, ses: unknown, onHost: boolean) {
    const loaded: string[] = []
    const contents = Object.assign(new EventEmitter(), { id: 7, session: ses, loaded, isDestroyed: () => false, setUserAgent: () => undefined, loadURL: (url: string): Promise<void> => (loaded.push(url), Promise.resolve()) })
    agents.watch(contents)
    if (onHost) contents.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    return contents
  }

  /** The hook of a session, in an engine whose sign-in identity is `agents`; a tab that goes onto the hosts widens it as the engine does. */
  async function hookOf(agents: SignInAgents | null, privacy: Record<string, unknown> | null = null) {
    const ses = fakeSession(true)
    const engine = engineWith(HINTS, privacy, agents)
    methods['installRequestBlocker']!.call(engine, ses)
    return { ses, engine, hook: ses.hooks.onBeforeSendHeaders }
  }

  /** The identity the way the engine builds it: its `onEnter` is `watchSignInPages` of the engine the session belongs to. */
  function agentsFor(engineRef: { engine: Record<string, unknown> | null }): SignInAgents {
    return new SignInAgents(identity, (ses) => methods['watchSignInPages']!.call(engineRef.engine, ses))
  }

  it('without an identity: the hook is what it was, and the sign-in hosts are served like any other site, hints of Lucium included', async () => {
    const { hook } = await hookOf(null)
    expect(hook.filter).toEqual(NAVIGATIONS_ONLY)
    expect(await answer(hook, navigation(SIGN_IN, 'mainFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
    expect(await answer(hook, navigation('https://accounts.youtube.com/accounts/SetSID', 'subFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
  })

  it('the navigation to a sign-in host carries Electron’s user agent and none of the hints of Lucium; the other sites keep the hints and the user agent of the pages', async () => {
    const { hook } = await hookOf(new SignInAgents(identity))
    expect(hook.filter).toEqual(NAVIGATIONS_ONLY)
    expect(await answer(hook, navigation(SIGN_IN, 'mainFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...ASKED, 'User-Agent': ELECTRON_AGENT } })
    expect(await answer(hook, navigation('https://accounts.youtube.com/accounts/SetSID', 'mainFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...ASKED, 'User-Agent': ELECTRON_AGENT } })
    expect(await answer(hook, navigation('https://mail.google.com/mail/', 'mainFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
    expect(await answer(hook, navigation('https://accounts.google.com.example/', 'mainFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
    expect(await answer(hook, navigation('http://accounts.google.com/', 'mainFrame', PAGE_ASKED))).toEqual({})
  })

  it('a frame of Google inside the page of another site keeps the identity of the page around it, hints of Lucium included', async () => {
    const { hook } = await hookOf(new SignInAgents(identity))
    expect(await answer(hook, navigation('https://accounts.google.com/gsi/iframe/select', 'subFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
  })

  it('the hook sees the navigations alone until a tab of the session goes onto a sign-in host, then every request of the web, and it stays so for the rest of the run', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const ses = fakeSession(true)
    ref.engine = engineWith(HINTS, null, agents)
    methods['installRequestBlocker']!.call(ref.engine, ses)
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    // A tab of the session that goes elsewhere widens nothing.
    const contents = tab(agents, ses, false)
    contents.emit('did-start-navigation', { url: 'https://mail.google.com/', isMainFrame: true, isSameDocument: false })
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
    contents.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(WEB_ONLY)
    contents.emit('did-start-navigation', { url: 'https://site.example/', isMainFrame: true, isSameDocument: false })
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual(WEB_ONLY)
    // The widened hook still leaves what is not the tab's alone: a script of a tab that is not on the host, no change.
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/a.js', 'script', { ...MEASURED, Accept: '*/*', 'User-Agent': PAGE_AGENT }))).toEqual({})
    // And it is installed once: the tab coming back to the host does not make a new one.
    const listener = ses.hooks.onBeforeSendHeaders.listener
    contents.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    expect(ses.hooks.onBeforeSendHeaders.listener).toBe(listener)
  })

  it('widening keeps what the session already did: with Global Privacy Control on, the requests still carry the signal and the hook still sees the sockets', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const ses = fakeSession(true)
    ref.engine = engineWith(HINTS, GPC_ON, agents)
    methods['installRequestBlocker']!.call(ref.engine, ses)
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual({ urls: WEB })
    // Another tab of the session (not the one the requests below are of) goes to the host.
    methods['watchSignInPages']!.call(ref.engine, ses)
    expect(ses.hooks.onBeforeSendHeaders.filter).toEqual({ urls: WEB })
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('https://site.example/a.js', 'script', { Accept: '*/*' }))).toEqual({ requestHeaders: { Accept: '*/*', 'Sec-GPC': '1' } })
    expect(await answer(ses.hooks.onBeforeSendHeaders, navigation('wss://site.example/live', 'webSocket', { Upgrade: 'websocket' }))).toEqual({ requestHeaders: { Upgrade: 'websocket', 'Sec-GPC': '1' } })
  })

  it('only the session of the tab is widened: another session of pages keeps the hook on the navigations', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const [first, second] = [fakeSession(true), fakeSession(false)]
    ref.engine = engineWith(HINTS, null, agents)
    methods['installRequestBlocker']!.call(ref.engine, first)
    methods['installRequestBlocker']!.call(ref.engine, second)
    tab(agents, first, true)
    expect(first.hooks.onBeforeSendHeaders.filter).toEqual(WEB_ONLY)
    expect(second.hooks.onBeforeSendHeaders.filter).toEqual(NAVIGATIONS_ONLY)
  })

  it('a session that has no hook of the pages is left alone: nothing is installed in it, and the tab still has the user agent', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const foreign = fakeSession(true)
    ref.engine = engineWith(HINTS, null, agents)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    tab(agents, foreign, true)
    expect(foreign.hooks.onBeforeSendHeaders.listener).toBeNull()
    expect(agents.has(7)).toBe(true)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('the requests of a tab that is on the host carry its identity, to any host: a frame without the hints of Lucium, a script with the hints Chromium put on it', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const ses = fakeSession(true)
    ref.engine = engineWith(HINTS, null, agents)
    methods['installRequestBlocker']!.call(ref.engine, ses)
    tab(agents, ses, true)
    const hook = ses.hooks.onBeforeSendHeaders
    const script = { ...MEASURED, Accept: '*/*', 'User-Agent': PAGE_AGENT }
    expect(await answer(hook, navigation('https://www.google.com/recaptcha/enterprise/anchor', 'subFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...ASKED, 'User-Agent': ELECTRON_AGENT } })
    expect(await answer(hook, navigation('https://ssl.gstatic.com/a.js', 'script', script))).toEqual({ requestHeaders: { ...MEASURED, Accept: '*/*', 'User-Agent': ELECTRON_AGENT } })
  })

  it('a tab that is not on the host keeps everything, even for a frame or a request to the sign-in hosts inside its page', async () => {
    const ref: { engine: Record<string, unknown> | null } = { engine: null }
    const agents = agentsFor(ref)
    const ses = fakeSession(true)
    ref.engine = engineWith(HINTS, null, agents)
    methods['installRequestBlocker']!.call(ref.engine, ses)
    tab(agents, ses, false)
    // Widened by another tab of the session that went to the host: the first is still not on it.
    methods['watchSignInPages']!.call(ref.engine, ses)
    const hook = ses.hooks.onBeforeSendHeaders
    expect(await answer(hook, navigation('https://accounts.google.com/gsi/iframe/select', 'subFrame', PAGE_ASKED))).toEqual({ requestHeaders: { ...MEASURED, ...PAGE_ASKED } })
    expect(await answer(hook, navigation('https://accounts.google.com/_/signin/x', 'xhr', { ...MEASURED, Accept: '*/*', 'User-Agent': PAGE_AGENT }))).toEqual({})
    expect(await answer(hook, navigation('https://ssl.gstatic.com/a.js', 'script', { ...MEASURED, Accept: '*/*', 'User-Agent': PAGE_AGENT }))).toEqual({})
  })

  it('tells the identity the method of each main-frame request of a tab, and of those alone: the redirect that follows a POST is left alone, the one that follows a GET is taken over', async () => {
    const agents = new SignInAgents(identity)
    const { hook } = await hookOf(agents)
    const contents = tab(agents, fakeSession(true), false)
    let prevented = 0
    const redirect = { url: SIGN_IN, isMainFrame: true, isSameDocument: false, preventDefault: () => void prevented++ }
    contents.emit('did-start-navigation', { url: 'https://site.example/form', isMainFrame: true, isSameDocument: false })
    await answer(hook, { ...navigation('https://site.example/form'), method: 'POST' })
    contents.emit('will-redirect', redirect)
    await moment()
    expect(prevented).toBe(0)
    expect(contents.loaded).toEqual([])
    // The request the redirect leads to is a GET: the redirect that follows it is taken over. The frames of the page, and what is not a document, say nothing of it.
    await answer(hook, navigation('https://site.example/hop'))
    await answer(hook, { ...navigation('https://site.example/frame', 'subFrame'), method: 'POST' })
    await answer(hook, { ...navigation('https://site.example/api', 'xhr'), method: 'POST' })
    contents.emit('will-redirect', redirect)
    await moment()
    expect(prevented).toBe(1)
    expect(contents.loaded).toEqual([SIGN_IN])
  })

  it('leaving the host: a navigation elsewhere that still carries Electron’s agent (a redirect followed before the tab changed) gets the agent of the pages and the hints of Lucium back', async () => {
    const { hook } = await hookOf(new SignInAgents(identity))
    expect(await answer(hook, navigation('https://mail.google.com/mail/u/0/', 'mainFrame', { ...ASKED, 'User-Agent': ELECTRON_AGENT }))).toEqual({ requestHeaders: { ...MEASURED, ...ASKED, 'User-Agent': PAGE_AGENT } })
  })

  it('the signal of Global Privacy Control still goes last, on a sign-in request too', async () => {
    const { hook } = await hookOf(new SignInAgents(identity), GPC_ON)
    const sent = (await answer(hook, navigation(SIGN_IN, 'mainFrame', PAGE_ASKED)))['requestHeaders'] as Record<string, string>
    expect(sent).toEqual({ ...ASKED, 'User-Agent': ELECTRON_AGENT, 'Sec-GPC': '1' })
    expect(Object.keys(sent).at(-1)).toBe('Sec-GPC')
  })
})
