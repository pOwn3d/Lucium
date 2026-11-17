// The sessions the application asks the network with for itself (its own, and those of the icon lookups and the live folders) sign their requests
// with the header of Global Privacy Control while the option is on, and cost nothing while it is off. Run on a stand-in of a session; the real
// sessions are checked by `smokeMarket` (the header on a request of the application).

import { describe, expect, it, vi } from 'vitest'
import { OwnRequestSigning, type SignedSession } from './own-requests'
import { standIn } from '../stand-in.test-support'

const defaultSession = { setUserAgent: () => undefined, webRequest: { onHeadersReceived: () => undefined } }
vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ session: { defaultSession }, app: { getPath: () => '/nowhere', userAgentFallback: 'Lucium Electron/45' } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

type Details = { requestHeaders: Record<string, string>; resourceType?: string }
type Listener = (details: Details, callback: (answer: { requestHeaders: Record<string, string> }) => void) => void

function fakeSession() {
  const hook: { filter: { urls: string[]; types?: string[] } | null; listener: Listener | null; installs: number } = { filter: null, listener: null, installs: 0 }
  const ses = {
    webRequest: {
      onBeforeSendHeaders: (filter: { urls: string[]; types?: string[] } | null, listener?: Listener) => {
        hook.installs++
        hook.filter = filter
        hook.listener = listener ?? null
      }
    }
  } as unknown as SignedSession
  const send = (details: Details): Record<string, string> => {
    let sent: Record<string, string> | null = null
    hook.listener!(details, (answer) => void (sent = answer.requestHeaders))
    if (sent === null) throw new Error('the listener did not answer')
    return sent
  }
  return { ses, hook, send }
}

const WEB = ['http://*/*', 'https://*/*']

describe('the sessions the application asks the network with for itself', () => {
  it('have no listener at all while Global Privacy Control is off', () => {
    const signing = new OwnRequestSigning()
    const { ses, hook } = fakeSession()
    signing.add(ses)
    expect(hook.listener).toBeNull()
    expect(hook.filter).toBeNull()
  })

  it('send Sec-GPC: 1 with every web request once the option is on, and stop when it goes off', () => {
    const signing = new OwnRequestSigning()
    const { ses, hook, send } = fakeSession()
    signing.add(ses)
    signing.set(true)
    expect(hook.filter).toEqual({ urls: WEB })
    expect(send({ requestHeaders: { Accept: 'application/json' } })).toEqual({ Accept: 'application/json', 'Sec-GPC': '1' })
    signing.set(false)
    expect(hook.listener).toBeNull()
  })

  it('sign a session that joins while the option is already on', () => {
    const signing = new OwnRequestSigning()
    signing.set(true)
    const { ses, send } = fakeSession()
    signing.add(ses)
    expect(send({ requestHeaders: {} })).toEqual({ 'Sec-GPC': '1' })
  })

  it('leave a session alone once it is removed, and do not touch it again when the option changes', () => {
    const signing = new OwnRequestSigning()
    signing.set(true)
    const { ses, hook } = fakeSession()
    signing.add(ses)
    signing.remove(ses)
    expect(hook.listener).toBeNull()
    const installs = hook.installs
    signing.set(false)
    signing.set(true)
    expect(hook.installs).toBe(installs)
  })

  it('does not install the same listener again when the option is set to what it already is', () => {
    const signing = new OwnRequestSigning()
    const { ses, hook } = fakeSession()
    signing.add(ses)
    signing.set(true)
    const installs = hook.installs
    signing.set(true)
    expect(hook.installs).toBe(installs)
  })

  describe('a session with a rule of its own on some requests (the pictures of the interface)', () => {
    const base = { types: ['image'], headers: (headers: Record<string, string>) => ({ ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie')), 'User-Agent': 'pages' }) }

    it('keeps that rule alone, on those requests alone, while the option is off', () => {
      const signing = new OwnRequestSigning()
      const { ses, hook, send } = fakeSession()
      signing.add(ses, base)
      expect(hook.filter).toEqual({ urls: WEB, types: ['image'] })
      expect(send({ requestHeaders: { Cookie: 'id=1' }, resourceType: 'image' })).toEqual({ 'User-Agent': 'pages' })
    })

    it('applies the rule to those requests and the header to all of them once the option is on', () => {
      const signing = new OwnRequestSigning()
      const { ses, hook, send } = fakeSession()
      signing.add(ses, base)
      signing.set(true)
      expect(hook.filter).toEqual({ urls: WEB })
      expect(send({ requestHeaders: { Cookie: 'id=1' }, resourceType: 'image' })).toEqual({ 'User-Agent': 'pages', 'Sec-GPC': '1' })
      // A request of the application itself (the feed of the versions) keeps its own headers, and gets the signal.
      expect(send({ requestHeaders: { Cookie: 'id=1', 'User-Agent': 'Lucium' }, resourceType: 'other' })).toEqual({ Cookie: 'id=1', 'User-Agent': 'Lucium', 'Sec-GPC': '1' })
      expect(send({ requestHeaders: { Accept: '*/*' } })).toEqual({ Accept: '*/*', 'Sec-GPC': '1' })
    })
  })
})

// The engine: which sessions it signs, and when. The methods run on stand-ins of the engine and of Electron's default session.
describe('the engine', () => {
  const signing = () => {
    const calls: Array<[string, ...unknown[]]> = []
    return { calls, ownRequests: { add: (...args: unknown[]) => void calls.push(['add', ...args]), remove: (...args: unknown[]) => void calls.push(['remove', ...args]), set: (...args: unknown[]) => void calls.push(['set', ...args]) } }
  }

  it('follows the option at every change of the privacy settings', () => {
    const { calls, ownRequests } = signing()
    const engine = standIn('engine', { privacy: null as unknown, ownRequests, profiles: new Map() })
    methods['setPrivacy']!.call(engine, { globalPrivacyControl: true, httpsUpgrade: false, stripTrackingParams: false })
    methods['setPrivacy']!.call(engine, { globalPrivacyControl: false, httpsUpgrade: true, stripTrackingParams: false })
    methods['setPrivacy']!.call(engine, null)
    expect(calls).toEqual([
      ['set', true],
      ['set', false],
      ['set', false]
    ])
  })

  it('signs a session the shell makes its lookups with (the icons, the live folders), until it is released', () => {
    const { calls, ownRequests } = signing()
    const released: string[] = []
    const settled = () => undefined
    const engine = standIn('engine', { ownRequests, ownSessions: { follow: () => ({ settled, release: () => void released.push('proxy') }) } })
    const { ses } = fakeSession()
    const follow = methods['followProxy']!.call(engine, ses, 'the favicon lookups') as { settled: unknown; release(): void }
    expect(calls).toEqual([['add', ses]])
    expect(follow.settled).toBe(settled)
    follow.release()
    expect(calls).toEqual([
      ['add', ses],
      ['remove', ses]
    ])
    expect(released).toEqual(['proxy'])
  })

  it('follows the proxy alone for a session that has no request hooks', () => {
    const { calls, ownRequests } = signing()
    const engine = standIn('engine', { ownRequests, ownSessions: { follow: () => ({ settled: () => undefined, release: () => undefined }) } })
    const follow = methods['followProxy']!.call(engine, { setProxy: async () => undefined, closeAllConnections: async () => undefined }, 'a stand-in') as { release(): void }
    follow.release()
    expect(calls).toEqual([])
  })

  describe('for its own session', () => {
    const present = (chromium: string | undefined) => {
      const { calls, ownRequests } = signing()
      const before = Object.getOwnPropertyDescriptor(process.versions, 'chrome')
      Object.defineProperty(process.versions, 'chrome', { value: chromium, configurable: true })
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        methods['presentPagesAsChrome']!.call(standIn('engine', { ownRequests }))
      } finally {
        quiet.mockRestore()
        if (before) Object.defineProperty(process.versions, 'chrome', before)
        else delete (process.versions as Record<string, unknown>)['chrome']
      }
      return calls
    }

    it('signs it with the rule of the pictures of the interface as its base: no cookie, the user agent of the pages, for images only', () => {
      const calls = present('156.0.7000.1')
      expect(calls).toHaveLength(1)
      const [name, ses, base] = calls[0] as [string, unknown, { types: string[]; headers(headers: Record<string, string>): Record<string, string> }]
      expect(name).toBe('add')
      expect(ses).toBe(defaultSession)
      expect(base.types).toEqual(['image'])
      const sent = base.headers({ Cookie: 'id=1', 'User-Agent': 'Lucium Electron/45', Accept: 'image/*' })
      expect(Object.keys(sent).map((header) => header.toLowerCase()).sort()).toEqual(['accept', 'user-agent'])
      expect(sent['User-Agent']).toMatch(/Chrome\/156\./)
      expect(sent['User-Agent']).not.toMatch(/Electron|Lucium/)
    })

    it('signs it all the same when the version of Chromium is not one it knows, and the pages keep their user agent', () => {
      const calls = present('nightly')
      expect(calls).toEqual([['add', defaultSession]])
    })
  })
})
