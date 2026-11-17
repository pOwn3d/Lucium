// The hook that keeps a local page from reading the disk (local-file-guard.ts) is on every session of pages, whatever the settings: a
// profile's, a private window's and a container's, with the blocker and the privacy options off. And once a local file opens in a session, the
// header hooks of that session keep a local page from reading the answer of a web site. Run on stand-ins of the engine and the session.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

type Listener = (details: Record<string, unknown>, callback: (answer: Record<string, unknown>) => void) => void

const holder = vi.hoisted(() => ({ partitions: new Map<string, unknown>(), interfaceSession: { clearData: async () => undefined } }))
vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => (name === 'home' ? '/Users/me' : `/tmp/lucium-test-${name}`) },
    session: { defaultSession: holder.interfaceSession, fromPartition: (name: string) => holder.partitions.get(name) }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { PendingReads } = await import('./local-file-guard')
const { strictTransportHosts } = await import('./strict-transport')
const { STRICT_TRANSPORT_FILE, strictTransportStore } = await import('./strict-transport-store')
const { certificateExceptions } = await import('./error-pages')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

type Hook = { filter: { urls: string[]; types?: string[] } | null; listener: Listener | null }

/** The folders of the sessions that keep their data: real ones, removed at the end (the hosts held to strict transport security are written there). */
const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})
function partitionFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lucium-wiring-'))
  folders.push(folder)
  return folder
}

/** A session that keeps the filter and the listener of its one `onBeforeRequest` hook, and of its two header hooks. `folder`: where an earlier session kept its data. */
function fakeSession(persistent: boolean, folder: string | null = persistent ? partitionFolder() : null) {
  const hook: Hook = { filter: null, listener: null }
  const sending: Hook = { filter: null, listener: null }
  const received: Hook = { filter: null, listener: null }
  const keep = (into: Hook) => (filter: Hook['filter'], listener?: Listener) => {
    into.filter = filter
    into.listener = listener ?? null
  }
  const ses = {
    hook,
    sending,
    received,
    webRequest: { onBeforeRequest: keep(hook), onBeforeSendHeaders: keep(sending), onHeadersReceived: keep(received) },
    protocol: { handle: () => undefined, unhandle: () => undefined },
    isPersistent: () => persistent,
    getStoragePath: () => folder
  }
  return ses
}

/** An engine with no blocker and no privacy option, with the methods the hook calls and none of what the constructor builds. */
function idleEngine(): Record<string, unknown> {
  return Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    requestBlocker: null,
    privacy: null,
    pageByContents: new Map(),
    scopes: new Map(),
    containerScopes: new Map(),
    scopeCounter: 0,
    proxyPlan: null,
    localPageSessions: new WeakSet(),
    headerHooks: new WeakMap(),
    // No identity for the sign-in pages of Google (client-hints-wiring.test.ts has them): the hook is what it is without it.
    signIn: null,
    signInSessions: new WeakSet(),
    requestHooks: new WeakMap(),
    extensionNets: new WeakMap(),
    localPageReads: new PendingReads(),
    standInSessions: new WeakSet(),
    standInWords: new WeakMap(),
    installPermissions: () => undefined,
    installDisplayMedia: () => undefined,
    installDownloads: () => undefined,
    siteIcons: { clear: () => undefined }
  })
}

const page = (url: string) => ({ getURL: () => url, isDestroyed: () => false, id: 7 })

async function answer(listener: Listener, details: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => listener(details, resolve))
}

describe('the hook on local files of the sessions of pages', () => {
  it('is installed on a profile session with the blocker and the privacy options off, and refuses a local page reading another file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(idleEngine(), ses)
    expect(ses.hook.filter?.urls).toEqual(['file:///*'])
    const listener = ses.hook.listener!
    expect(await answer(listener, { url: 'file:///Users/me/.ssh/id_ed25519', resourceType: 'xhr', webContents: page('file:///Users/me/Downloads/page.html') })).toEqual({ cancel: true })
    expect(await answer(listener, { url: 'file:///Users/me/Downloads/page.html', resourceType: 'mainFrame', webContents: page('about:blank') })).toEqual({ cancel: false })
    warn.mockRestore()
  })

  it('keeps watching local files beside the web requests once the blocker is on', () => {
    const ses = fakeSession(true)
    methods['installRequestBlocker']!.call(Object.assign(idleEngine(), { requestBlocker: () => false }), ses)
    expect(ses.hook.filter?.urls).toEqual(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file:///*'])
  })

  it('hands out the stand-ins of the blocker under a word of its own in each session, the same from one request to the next', async () => {
    const engine = Object.assign(idleEngine(), { requestBlocker: () => ({ redirect: 'lucium-stand-in://resource/1x1.gif' }) })
    const target = async (ses: ReturnType<typeof fakeSession>) => {
      methods['installRequestBlocker']!.call(engine, ses)
      return (await answer(ses.hook.listener!, { url: 'https://ads.example/pixel.gif', resourceType: 'image', method: 'GET', webContents: page('https://site.example/') }))['redirectURL']
    }
    const profile = fakeSession(true)
    const privateWindow = fakeSession(false)
    const first = await target(profile)
    expect(first).toMatch(/^lucium-stand-in:\/\/[0-9a-f]{24}\/1x1\.gif$/)
    expect(await target(profile)).toBe(first)
    // Nothing a page could learn in a private window names the profile it was opened from.
    const other = await target(privateWindow)
    expect(other).toMatch(/^lucium-stand-in:\/\/[0-9a-f]{24}\/1x1\.gif$/)
    expect(other).not.toBe(first)
  })

  it('is installed on the session of a private window and of a container as soon as they open', () => {
    const engine = idleEngine()
    const privateSession = fakeSession(false)
    holder.partitions.set('ephemeral-1', privateSession)
    methods['openEphemeral']!.call(engine, 'w1')
    expect(privateSession.hook.filter?.urls).toEqual(['file:///*'])

    const containerSession = fakeSession(true)
    holder.partitions.set('persist:container-c1', containerSession)
    methods['openContainer']!.call(engine, 'c1', 'w1')
    expect(containerSession.hook.filter?.urls).toEqual(['file:///*'])
  })
})

describe('a host that asks for strict transport security, in the hook of the answers', () => {
  const HSTS = { 'Strict-Transport-Security': ['max-age=600'], 'Content-Type': ['text/html'] }

  function idleSession() {
    const ses = fakeSession(true)
    const engine = idleEngine()
    methods['installRequestBlocker']!.call(engine, ses)
    methods['installResponsePolicy']!.call(engine, ses, () => null)
    return ses
  }

  it('is held as strict in its session from the answer of a document, with the blocker off and no extension, and the answer is left as it is', async () => {
    const ses = idleSession()
    expect(strictTransportHosts.isStrict(ses, 'banque.exemple.fr')).toBe(false)
    expect(await answer(ses.received.listener!, { id: 1, url: 'https://banque.exemple.fr/compte', resourceType: 'mainFrame', responseHeaders: HSTS })).toEqual({})
    expect(strictTransportHosts.isStrict(ses, 'banque.exemple.fr')).toBe(true)
    expect(strictTransportHosts.isStrict(fakeSession(true), 'banque.exemple.fr')).toBe(false)
  })

  it('is written when the engine is told the application quits, without waiting for the write that was a second away', async () => {
    const ses = idleSession()
    await answer(ses.received.listener!, { id: 1, url: 'https://banque.exemple.fr/compte', resourceType: 'mainFrame', responseHeaders: HSTS })
    const file = join(ses.getStoragePath()!, STRICT_TRANSPORT_FILE)
    expect(existsSync(file)).toBe(false)
    methods['flushStrictTransport']!.call(idleEngine())
    expect((JSON.parse(readFileSync(file, 'utf8')) as { hosts: unknown[] }).hosts).toHaveLength(1)
  })

  it('is still held as strict after a restart, in the session that keeps the same data, and no longer once the data of the profile is cleared', async () => {
    const ses = idleSession()
    await answer(ses.received.listener!, { id: 1, url: 'https://banque.exemple.fr/compte', resourceType: 'mainFrame', responseHeaders: HSTS })
    strictTransportStore.flush(ses)
    // The next run: another session object on the same folder, set up the same way, before any answer.
    const folder = ses.getStoragePath()
    const restarted = fakeSession(true, folder)
    expect(strictTransportHosts.isStrict(restarted, 'banque.exemple.fr')).toBe(false)
    methods['installResponsePolicy']!.call(idleEngine(), restarted, () => null)
    expect(strictTransportHosts.isStrict(restarted, 'banque.exemple.fr')).toBe(true)
    // A private window opened in that run learns nothing of it.
    const privateWindow = fakeSession(false)
    methods['installResponsePolicy']!.call(idleEngine(), privateWindow, () => null)
    expect(strictTransportHosts.isStrict(privateWindow, 'banque.exemple.fr')).toBe(false)

    // « Effacer les données » of the profile: the hosts go with the rest, for this run and for the next.
    const cleared = Object.assign(restarted, { clearData: async () => undefined, clearAuthCache: async () => undefined })
    holder.partitions.set('persist:profile-p1', cleared)
    await methods['clearProfileData']!.call(Object.assign(idleEngine(), { loaded: new Map(), resume: null }), 'p1')
    expect(strictTransportHosts.isStrict(restarted, 'banque.exemple.fr')).toBe(false)
    const afterClearing = fakeSession(true, folder)
    methods['installResponsePolicy']!.call(idleEngine(), afterClearing, () => null)
    expect(strictTransportHosts.isStrict(afterClearing, 'banque.exemple.fr')).toBe(false)
  })

  it('goes with a deleted profile, and with a container erased while it is closed', async () => {
    const nothing = async () => undefined
    const wipable = { clearData: nothing, clearStorageData: nothing, clearCache: nothing, clearCodeCaches: nothing, clearAuthCache: nothing, clearHostResolverCache: nothing, clearSharedDictionaryCache: nothing, closeAllConnections: nothing, flushStorageData: () => undefined }
    /** A session that held a host as strict in an earlier run, and whether a later run still holds it. */
    const held = async () => {
      const ses = idleSession()
      await answer(ses.received.listener!, { id: 1, url: 'https://banque.exemple.fr/compte', resourceType: 'mainFrame', responseHeaders: HSTS })
      strictTransportStore.flush(ses)
      const folder = ses.getStoragePath()
      const stillHeld = () => {
        const later = fakeSession(true, folder)
        methods['installResponsePolicy']!.call(idleEngine(), later, () => null)
        return strictTransportHosts.isStrict(later, 'banque.exemple.fr')
      }
      expect(stillHeld()).toBe(true)
      // The session Electron hands back for the partition in this run: nothing was read for it yet.
      return { closed: Object.assign(fakeSession(true, folder), wipable), stillHeld }
    }

    const profile = await held()
    holder.partitions.set('persist:profile-p2', profile.closed)
    await methods['deleteProfileData']!.call(Object.assign(idleEngine(), { known: new Map(), resume: null }), 'p2')
    expect(profile.stillHeld()).toBe(false)

    const container = await held()
    holder.partitions.set('persist:container-c2', container.closed)
    await methods['eraseContainer']!.call(idleEngine(), 'c2', 'Travail')
    expect(container.stillHeld()).toBe(false)
  })

  it('is not believed when its certificate was let through in this session', async () => {
    const ses = idleSession()
    certificateExceptions.markLetThrough(ses, 'nas.exemple.fr')
    await answer(ses.received.listener!, { id: 1, url: 'https://nas.exemple.fr/', resourceType: 'mainFrame', responseHeaders: HSTS })
    expect(strictTransportHosts.isStrict(ses, 'nas.exemple.fr')).toBe(false)
    // Another session, where nothing was let through, believes the same answer.
    const other = idleSession()
    await answer(other.received.listener!, { id: 1, url: 'https://nas.exemple.fr/', resourceType: 'mainFrame', responseHeaders: HSTS })
    expect(strictTransportHosts.isStrict(other, 'nas.exemple.fr')).toBe(true)
  })
})

describe('what a local page reads of the web, in the header hooks of its session', () => {
  const LOCAL = 'file:///Users/me/Downloads/page.html'
  const SECRET = 'http://127.0.0.1:8384/rest/config'
  const localFrame = { origin: 'file://' }

  /** A session of an engine with these options, in which a local file was (or was not) just opened in a tab. */
  async function session(options: { opened?: boolean; engine?: Record<string, unknown> } = {}) {
    const ses = fakeSession(true)
    const engine = Object.assign(idleEngine(), options.engine ?? {})
    methods['installRequestBlocker']!.call(engine, ses)
    methods['installResponsePolicy']!.call(engine, ses, () => (engine['responsePolicy'] as never) ?? null)
    if (options.opened !== false) await answer(ses.hook.listener!, { url: LOCAL, resourceType: 'mainFrame', webContents: page('about:blank') })
    return { ses, engine }
  }

  /** One request of a page, from its headers leaving to its answer: what each hook answered (`left` false: the request was stopped before it left). */
  async function exchange(ses: ReturnType<typeof fakeSession>, request: Record<string, unknown>, responseHeaders: Record<string, string[]> = {}) {
    const details = { id: 1, url: SECRET, resourceType: 'xhr', frame: localFrame, webContents: page(LOCAL), requestHeaders: { 'Sec-Fetch-Mode': 'cors' }, ...request }
    const sent = await answer(ses.sending.listener!, details)
    if (sent['cancel'] === true) return { left: false, sent, got: null }
    return { left: true, sent, got: await answer(ses.received.listener!, { id: details.id, url: details.url, resourceType: details.resourceType, responseHeaders }) }
  }

  it('costs a session nothing until a local file opens in it: what leaves is seen for the navigations alone (their Client Hints), and the answers of https documents alone are looked at', async () => {
    const { ses } = await session({ opened: false })
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] })
    // The one thing read there: a host that asks for strict transport security (strict-transport.ts).
    expect(ses.received.filter).toEqual({ urls: ['https://*/*'], types: ['mainFrame'] })
  })

  it('watches every web request of the session from the moment a local file opens in a tab, before the document is let through', async () => {
    const { ses } = await session()
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'] })
    expect(ses.received.filter).toEqual({ urls: ['http://*/*', 'https://*/*'] })
    // What a local page loads beside it (an image) starts no watch by itself: only a document does. Here it is on already, and stays.
    expect(ses.sending.listener).not.toBeNull()
  })

  it('keeps from a local page the answer of a site that does not share it: fetch and XMLHttpRequest get nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session()
    const { left, got } = await exchange(ses, {}, { 'Content-Type': ['application/json'] })
    expect(left).toBe(true)
    expect(got).toEqual({ cancel: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept the answer of a web site from a local page'))
    warn.mockRestore()
  })

  it('puts the Global Privacy Control header on the handshake of a WebSocket too, and asks the session for those requests', async () => {
    const ses = fakeSession(true)
    const engine = Object.assign(idleEngine(), { privacy: { globalPrivacyControl: true, httpsUpgrade: false, stripTrackingParams: false } })
    methods['installRequestBlocker']!.call(engine, ses)
    expect(ses.sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] })
    const socket = await answer(ses.sending.listener!, { id: 1, url: 'wss://site.example/live', resourceType: 'webSocket', webContents: page('https://site.example/'), requestHeaders: { Upgrade: 'websocket' } })
    expect(socket).toEqual({ requestHeaders: { Upgrade: 'websocket', 'Sec-GPC': '1' } })
  })

  it('lets a local page read what a server shares with everyone, and show what it does not read (a page saved from the web)', async () => {
    const { ses } = await session()
    expect((await exchange(ses, {}, { 'Access-Control-Allow-Origin': ['*'] })).got).toEqual({})
    expect((await exchange(ses, { id: 2, url: 'http://cdn.example/pixel.gif', resourceType: 'image', requestHeaders: { 'Sec-Fetch-Mode': 'no-cors' } })).got).toEqual({})
    expect((await exchange(ses, { id: 3, url: 'http://cdn.example/app.js', resourceType: 'script', requestHeaders: { 'Sec-Fetch-Mode': 'no-cors' } })).got).toEqual({})
  })

  it('does not judge a frame of a web site inside a local page, nor a page of the web in the same session', async () => {
    const { ses } = await session()
    expect((await exchange(ses, { frame: { origin: 'https://player.example' } })).got).toEqual({})
    expect((await exchange(ses, { id: 2, frame: { origin: 'https://site.example' }, webContents: page('https://site.example/') })).got).toEqual({})
  })

  it('keeps it too from a fetch that says `same-origin` or `no-cors`: the mode the page chooses exempts nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session()
    for (const mode of ['same-origin', 'no-cors']) {
      const { left, got } = await exchange(ses, { requestHeaders: { 'Sec-Fetch-Mode': mode, Cookie: 'sid=1' } }, { 'Content-Type': ['application/json'] })
      expect(left, mode).toBe(true)
      expect(got, mode).toEqual({ cancel: true })
    }
    // What a saved page shows still loads: an image of a site, asked for without reading it.
    expect((await exchange(ses, { resourceType: 'image', requestHeaders: { 'Sec-Fetch-Mode': 'no-cors' } }, { 'Content-Type': ['image/gif'] })).got).toEqual({})
    warn.mockRestore()
  })

  it('stops, before it leaves, a request of the web that a local file makes with no page behind it (a shared worker), and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session()
    const worker = { frame: null, webContents: undefined, initiatorOrigin: 'file://' }
    expect((await exchange(ses, worker)).left).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a local file made with no page behind it'))
    // The worker of a site in the same session is left alone.
    const site = await exchange(ses, { ...worker, initiatorOrigin: 'https://site.example' }, { 'Content-Type': ['application/json'] })
    expect(site.left).toBe(true)
    expect(site.got).toEqual({})
    warn.mockRestore()
  })

  it('judges a redirect again: the request under the same id is a read for each answer it gets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session()
    // The first answer is shared; the request is sent again to where it was redirected, and that answer is not.
    expect((await exchange(ses, {}, { 'Access-Control-Allow-Origin': ['*'], Location: ['http://127.0.0.1:8384/private'] })).got).toEqual({})
    expect((await exchange(ses, { url: 'http://127.0.0.1:8384/private' })).got).toEqual({ cancel: true })
    warn.mockRestore()
  })

  it('judges on the top document a request whose frame cannot be read any more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session()
    const gone = Object.defineProperty({}, 'origin', { get: () => { throw new Error('Render frame was disposed') } })
    expect((await exchange(ses, { frame: gone })).got).toEqual({ cancel: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read the frame behind a web request'), 'Render frame was disposed')
    warn.mockRestore()
  })

  it('stops a read before it leaves when too many reads of local pages wait for their answer, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = await session({ engine: { localPageReads: new PendingReads(1) } })
    expect(await answer(ses.sending.listener!, { id: 1, url: SECRET, resourceType: 'xhr', frame: localFrame, webContents: page(LOCAL), requestHeaders: { 'Sec-Fetch-Mode': 'cors' } })).toEqual({})
    expect((await exchange(ses, { id: 2 })).left).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too many of its reads are still waiting'))
    warn.mockRestore()
  })

  it('lets a request through unjudged, with the reason in the journal, when the page that asks cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses } = await session()
    const broken = { isDestroyed: () => false, getURL: () => { throw new Error('contents gone') }, id: 9 }
    const { left, got } = await exchange(ses, { webContents: broken })
    expect(left).toBe(true)
    expect(got).toEqual({})
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot tell whether a local page is reading the web'), 'contents gone')
    error.mockRestore()
  })

  it('shares the two hooks with what was there: the Global Privacy Control header and the policy of the main documents', async () => {
    const csp = "script-src 'none'"
    const { ses } = await session({ engine: { privacy: { globalPrivacyControl: true, httpsUpgrade: false, stripTrackingParams: false }, responsePolicy: () => csp } })
    // Before the local file opened, the policy looked at main documents only.
    const before = await session({ opened: false, engine: { responsePolicy: () => csp } })
    expect(before.ses.received.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] })
    const { sent, got } = await exchange(ses, {})
    expect(sent).toEqual({ requestHeaders: { 'Sec-Fetch-Mode': 'cors', 'Sec-GPC': '1' } })
    expect(got).toEqual({ cancel: true })
    const document = await answer(ses.received.listener!, { id: 5, url: 'https://site.example/', resourceType: 'mainFrame', responseHeaders: {} })
    expect(JSON.stringify(document)).toContain(csp)
    // A resource of a web page is not given the policy of a main document.
    expect(await answer(ses.received.listener!, { id: 6, url: 'https://site.example/a.js', resourceType: 'script', responseHeaders: {} })).toEqual({})
  })

  it('keeps the watch when the blocker or the privacy options change later (the hooks are installed again)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ses, engine } = await session()
    methods['installRequestBlocker']!.call(engine, ses)
    methods['installResponsePolicy']!.call(engine, ses, () => null)
    expect((await exchange(ses, {})).got).toEqual({ cancel: true })
    warn.mockRestore()
  })
})
