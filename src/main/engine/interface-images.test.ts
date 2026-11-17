// The icons the interface draws went out with the cookies of the application's session, which nothing erases, and
// without the Global Privacy Control header the pages send.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { interfaceImageRequestHeaders, interfaceImageResponseHeaders } from '@shared/interface-images'
import { OwnRequestSigning } from './own-requests'

type Listener = (details: { requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string[]>; resourceType?: string }, callback: (answer: Record<string, unknown>) => void) => void
type Filter = { urls: string[]; types?: string[] } | null

// The default session of Electron, as the engine finds it when it presents the pages as Chrome: what is registered on its web requests is kept.
const holder = vi.hoisted(() => ({
  defaultSession: {
    setUserAgent: (_agent: string): void => undefined,
    webRequest: {
      onBeforeSendHeaders: (_filter: unknown, _listener?: unknown): void => undefined,
      onHeadersReceived: (_filter: unknown, _listener?: unknown): void => undefined
    }
  }
}))
vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ session: { defaultSession: holder.defaultSession }, app: { getPath: () => '/nowhere', userAgentFallback: 'Lucium Electron/45' } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const presentPagesAsChrome = (ElectronEngine.prototype as unknown as Record<string, (this: unknown) => void>)['presentPagesAsChrome']!

const AGENT = 'Mozilla/5.0 (Macintosh) Chrome/156.0.0.0'
const PAGES_AGENT = /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/156\.0\.0\.0 Safari\/537\.36$/

describe('the request of a picture of the interface', () => {
  it('carries no cookie, whatever the case of its name', () => {
    const headers = interfaceImageRequestHeaders({ Cookie: 'id=1', cookie: 'id=2', COOKIE: 'id=3', Accept: 'image/*' }, AGENT, false)
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('cookie')
    expect(headers['Accept']).toBe('image/*')
  })

  it('carries the user agent of the pages', () => {
    expect(interfaceImageRequestHeaders({ 'user-agent': 'Lucium Electron/45' }, AGENT, false)).toEqual({ 'User-Agent': AGENT })
  })

  it('carries Sec-GPC: 1 while Global Privacy Control is on, and nothing of it while it is off', () => {
    expect(interfaceImageRequestHeaders({}, AGENT, true)['Sec-GPC']).toBe('1')
    expect(Object.keys(interfaceImageRequestHeaders({ 'sec-gpc': '1' }, AGENT, false)).map((name) => name.toLowerCase())).not.toContain('sec-gpc')
  })
})

describe('the answer to a picture of the interface', () => {
  it('sets no cookie, and keeps the rest', () => {
    expect(interfaceImageResponseHeaders({ 'Set-Cookie': ['id=1; SameSite=None; Secure'], 'set-cookie': ['b=2'], 'Content-Type': ['image/png'] })).toEqual({ 'Content-Type': ['image/png'] })
    expect(interfaceImageResponseHeaders(undefined)).toEqual({})
  })
})

describe('the session of the interface, once the engine has presented the pages as Chrome', () => {
  const registered: { sending: Array<{ filter: Filter; listener: Listener | null }>; receiving: Array<{ filter: Filter; listener: Listener }> } = { sending: [], receiving: [] }
  const ownRequests = new OwnRequestSigning()
  const original = Object.getOwnPropertyDescriptor(process.versions, 'chrome')

  beforeEach(() => {
    registered.sending.length = 0
    registered.receiving.length = 0
    holder.defaultSession.webRequest.onBeforeSendHeaders = (filter, listener) => void registered.sending.push({ filter: filter as Filter, listener: (listener as Listener | undefined) ?? null })
    holder.defaultSession.webRequest.onHeadersReceived = (filter, listener) => void registered.receiving.push({ filter: filter as Filter, listener: listener as Listener })
    Object.defineProperty(process.versions, 'chrome', { value: '156.0.8078.48', configurable: true, enumerable: true })
    presentPagesAsChrome.call({ ownRequests })
  })
  afterEach(() => {
    if (original) Object.defineProperty(process.versions, 'chrome', original)
    else delete (process.versions as Record<string, unknown>)['chrome']
  })

  it('sends its pictures without a cookie, under the user agent of the pages, and with the option of the moment (Global Privacy Control off here)', () => {
    const sending = registered.sending.at(-1)!
    expect(sending.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['image'] })
    let sent: Record<string, string> | undefined
    sending.listener!({ requestHeaders: { Cookie: 'id=1', 'User-Agent': 'Lucium Electron/45', Accept: 'image/*' }, resourceType: 'image' }, (answer) => void (sent = answer['requestHeaders'] as Record<string, string>))
    expect(Object.keys(sent!).map((name) => name.toLowerCase())).not.toContain('cookie')
    expect(sent!['User-Agent']).toMatch(PAGES_AGENT)
    expect(sent!['Accept']).toBe('image/*')
    expect(Object.keys(sent!)).not.toContain('Sec-GPC')
  })

  it('leaves the other requests of the session alone: the application keeps its own name for what it fetches for itself', () => {
    let sent: Record<string, string> | undefined
    registered.sending.at(-1)!.listener!({ requestHeaders: { Cookie: 'id=1', 'User-Agent': 'Lucium Electron/45' }, resourceType: 'xhr' }, (answer) => void (sent = answer['requestHeaders'] as Record<string, string>))
    expect(sent).toEqual({ Cookie: 'id=1', 'User-Agent': 'Lucium Electron/45' })
  })

  it('reads the answer to a picture through the rule that drops its cookies, for the pictures of the web only', () => {
    const receiving = registered.receiving.at(-1)!
    expect(receiving.filter).toEqual({ urls: ['http://*/*', 'https://*/*'], types: ['image'] })
    let answered: Record<string, unknown> | undefined
    receiving.listener({ responseHeaders: { 'Set-Cookie': ['id=1; SameSite=None; Secure'], 'Content-Type': ['image/png'] } }, (answer) => void (answered = answer))
    expect(answered).toEqual({ responseHeaders: { 'Content-Type': ['image/png'] } })
  })
})
