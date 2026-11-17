// What the blocking listeners of chrome.webRequest answer, read and combined (web-request-blocking.ts): which answers are taken, where a redirect
// may lead, how the answers of several extensions combine, how long an extension is waited for, and what a login gets of them.

import { describe, expect, it } from 'vitest'
import {
  AUTH_ANSWER_TTL_MS,
  AuthAnswers,
  isBlockableEvent,
  listenerRedirect,
  loginOfListeners,
  mayBlockRequests,
  mergeAuth,
  mergeBeforeRequest,
  mergeRequestHeaders,
  mergeResponseHeaders,
  readBlockingResponse,
  SLOW_PAUSE_MS,
  SLOW_STRIKES,
  SlowListeners,
  touchedHeaders,
  type BlockingResponse,
  type ExtensionResponses
} from './web-request-blocking'

const said = (extensionId: string, ...responses: BlockingResponse[]): ExtensionResponses => ({ extensionId, responses })

describe('which extension is asked', () => {
  it('a Manifest V2 extension that holds webRequestBlocking in its manifest, and no other', () => {
    expect(mayBlockRequests({ manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'] })).toBe(true)
    // Manifest V3 does not let an extension block from its code (Chromium refuses the permission).
    expect(mayBlockRequests({ manifest_version: 3, permissions: ['webRequest', 'webRequestBlocking'] })).toBe(false)
    expect(mayBlockRequests({ manifest_version: 2, permissions: ['webRequest'], optional_permissions: ['webRequestBlocking'] })).toBe(false)
    for (const raw of [null, 'text', [], {}, { manifest_version: '2', permissions: ['webRequestBlocking'] }, { manifest_version: 2, permissions: 'webRequestBlocking' }]) expect(mayBlockRequests(raw), JSON.stringify(raw)).toBe(false)
  })

  it('on the four events that take an answer', () => {
    expect(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onAuthRequired'].every(isBlockableEvent)).toBe(true)
    expect(['onSendHeaders', 'onCompleted', 'onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred'].some(isBlockableEvent)).toBe(false)
  })
})

describe('an answer, read', () => {
  it('nothing is an answer that changes nothing; a cancel is taken on every event that takes an answer', () => {
    expect(readBlockingResponse('onBeforeRequest', undefined)).toEqual({})
    expect(readBlockingResponse('onBeforeRequest', {})).toEqual({})
    expect(readBlockingResponse('onBeforeRequest', { cancel: false })).toEqual({})
    for (const event of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onAuthRequired'] as const) expect(readBlockingResponse(event, { cancel: true })).toEqual({ cancel: true })
  })

  it('a field the event does not take is left out', () => {
    expect(readBlockingResponse('onBeforeSendHeaders', { redirectUrl: 'https://x.example/', requestHeaders: [] })).toEqual({ requestHeaders: [] })
    expect(readBlockingResponse('onBeforeRequest', { requestHeaders: [{ name: 'a', value: 'b' }], authCredentials: { username: 'u', password: 'p' } })).toEqual({})
    expect(readBlockingResponse('onHeadersReceived', { redirectUrl: 'https://x.example/', responseHeaders: [{ name: 'a', value: 'b' }] })).toEqual({ redirectUrl: 'https://x.example/', responseHeaders: [{ name: 'a', value: 'b' }] })
    expect(readBlockingResponse('onAuthRequired', { authCredentials: { username: 'u', password: 'p' } })).toEqual({ authCredentials: { username: 'u', password: 'p' } })
  })

  it('refuses as a whole what is not of the documented shape', () => {
    const refused: Array<[Parameters<typeof readBlockingResponse>[0], unknown]> = [
      ['onBeforeRequest', 'cancel'],
      ['onBeforeRequest', [true]],
      ['onBeforeRequest', { cancel: 'yes' }],
      ['onBeforeRequest', { redirectUrl: 7 }],
      ['onBeforeRequest', { redirectUrl: '' }],
      ['onBeforeRequest', { redirectUrl: 'https://x.example/\r\nSet-Cookie: a=b' }],
      ['onBeforeSendHeaders', { requestHeaders: 'a: b' }],
      ['onBeforeSendHeaders', { requestHeaders: [{ name: 'bad name', value: 'x' }] }],
      // A line break in a value would write a header of its own choosing.
      ['onBeforeSendHeaders', { requestHeaders: [{ name: 'x-a', value: 'one\r\nx-b: two' }] }],
      ['onBeforeSendHeaders', { requestHeaders: Array.from({ length: 257 }, (_, i) => ({ name: `x-${i}`, value: '1' })) }],
      ['onHeadersReceived', { responseHeaders: [{ name: 'x-a' }] }],
      ['onAuthRequired', { authCredentials: { username: 'u' } }],
      ['onAuthRequired', { authCredentials: { username: 'u', password: 'p'.repeat(1025) } }]
    ]
    for (const [event, raw] of refused) expect(readBlockingResponse(event, raw), JSON.stringify(raw).slice(0, 80)).toBeNull()
  })

  it('takes a header value given as bytes', () => {
    expect(readBlockingResponse('onBeforeSendHeaders', { requestHeaders: [{ name: 'x-a', binaryValue: [104, 105] }] })).toEqual({ requestHeaders: [{ name: 'x-a', value: 'hi' }] })
    expect(readBlockingResponse('onBeforeSendHeaders', { requestHeaders: [{ name: 'x-a', binaryValue: [13, 10] }] })).toBeNull()
  })
})

describe('where a listener may redirect a request', () => {
  const from = 'https://site.example/a.js'

  it('to the web, and from the first hook to the files of the extension itself', () => {
    expect(listenerRedirect('https://cdn.example/b.js', from, 'ext', 'onBeforeRequest')).toEqual({ kind: 'redirect', url: 'https://cdn.example/b.js' })
    expect(listenerRedirect('http://cdn.example/b.js', from, 'ext', 'onHeadersReceived')).toEqual({ kind: 'redirect', url: 'http://cdn.example/b.js' })
    expect(listenerRedirect('chrome-extension://ext/noop.js', from, 'ext', 'onBeforeRequest')).toEqual({ kind: 'redirect', url: 'chrome-extension://ext/noop.js' })
  })

  it('never to a local file, a page of the browser or of the application, a script, another extension', () => {
    for (const target of ['file:///etc/passwd', 'chrome://settings/', 'chrome-extension://other/page.html', 'javascript:alert(1)', 'lucium://open?url=x', 'lucium-error:retry', 'devtools://devtools/', 'blob:https://site.example/1', 'view-source:https://site.example/', 'not an address'])
      expect(listenerRedirect(target, from, 'ext', 'onBeforeRequest'), target).toEqual({ kind: 'refused' })
    // A 302 made from the headers of an answer does not reach the files of an extension.
    expect(listenerRedirect('chrome-extension://ext/noop.js', from, 'ext', 'onHeadersReceived')).toEqual({ kind: 'refused' })
    // A WebSocket address only for the handshake of a WebSocket.
    expect(listenerRedirect('wss://socket.example/', from, 'ext', 'onBeforeRequest')).toEqual({ kind: 'refused' })
    expect(listenerRedirect('wss://socket.example/', 'wss://site.example/live', 'ext', 'onBeforeRequest')).toEqual({ kind: 'redirect', url: 'wss://socket.example/' })
  })

  it('a redirect to data: or about:blank is a cancel, and one to the address itself changes nothing', () => {
    expect(listenerRedirect('data:text/javascript,', from, 'ext', 'onBeforeRequest')).toEqual({ kind: 'cancel' })
    expect(listenerRedirect('about:blank', from, 'ext', 'onHeadersReceived')).toEqual({ kind: 'cancel' })
    expect(listenerRedirect(from, from, 'ext', 'onBeforeRequest')).toEqual({ kind: 'same' })
  })
})

describe('the answers of several extensions to a request before it leaves', () => {
  const url = 'https://site.example/ad.js'

  it('a cancel wins over a redirect, whoever speaks first', () => {
    expect(mergeBeforeRequest([said('late', { redirectUrl: 'https://other.example/' }), said('early', { cancel: true })], url)).toMatchObject({ cancel: true, redirectUrl: null })
    expect(mergeBeforeRequest([said('late', { cancel: true }), said('early', { redirectUrl: 'https://other.example/' })], url)).toMatchObject({ cancel: true, redirectUrl: null })
    // A redirect to data: is how an extension cancels.
    expect(mergeBeforeRequest([said('late', { redirectUrl: 'https://other.example/' }), said('early', { redirectUrl: 'data:,' })], url)).toMatchObject({ cancel: true })
  })

  it('the first redirect in the order of precedence wins, and a different one after it is ignored and named', () => {
    const verdict = mergeBeforeRequest([said('late', { redirectUrl: 'https://one.example/' }), said('early', { redirectUrl: 'https://two.example/' })], url)
    expect(verdict).toEqual({ cancel: false, redirectUrl: 'https://one.example/', ignored: [{ extensionId: 'early', why: 'redirect-conflict' }] })
    expect(mergeBeforeRequest([said('late', { redirectUrl: 'https://one.example/' }), said('early', { redirectUrl: 'https://one.example/' })], url).ignored).toEqual([])
  })

  it('a redirect to a target refused is ignored, named, and the request goes on (or takes the next redirect)', () => {
    expect(mergeBeforeRequest([said('late', { redirectUrl: 'file:///etc/passwd' })], url)).toEqual({ cancel: false, redirectUrl: null, ignored: [{ extensionId: 'late', why: 'target' }] })
    expect(mergeBeforeRequest([said('late', { redirectUrl: 'file:///etc/passwd' }), said('early', { redirectUrl: 'https://ok.example/' })], url).redirectUrl).toBe('https://ok.example/')
  })

  it('no answer, no change', () => {
    expect(mergeBeforeRequest([], url)).toEqual({ cancel: false, redirectUrl: null, ignored: [] })
  })
})

describe('the answers to the headers of a request', () => {
  const told = { Accept: '*/*', Cookie: 'a=1', 'X-Old': 'x' }

  it('what a listener adds, changes and removes is done on the headers the declarative rules left', () => {
    const base = { ...told, 'X-Rule': '1' }
    const verdict = mergeRequestHeaders([said('a', { requestHeaders: [{ name: 'Accept', value: 'text/html' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-New', value: 'n' }] })], told, base)
    expect(verdict).toEqual({ cancel: false, headers: { Cookie: 'a=1', 'X-Rule': '1', Accept: 'text/html', 'X-New': 'n' }, ignored: [] })
  })

  it('an answer that changes nothing leaves the very same headers', () => {
    const base = { ...told }
    expect(mergeRequestHeaders([said('a', { requestHeaders: [{ name: 'accept', value: '*/*' }, { name: 'cookie', value: 'a=1' }, { name: 'x-old', value: 'x' }] }), said('b', {})], told, base).headers).toBe(base)
  })

  it('a header a declarative rule changed is not changed again: the whole answer is ignored, as in Chromium', () => {
    const base = { ...told, Cookie: 'by-rule' }
    const verdict = mergeRequestHeaders([said('a', { requestHeaders: [{ name: 'Accept', value: 'text/html' }, { name: 'Cookie', value: 'mine' }, { name: 'X-Old', value: 'x' }] })], told, base)
    expect(verdict.headers).toBe(base)
    expect(verdict.ignored).toEqual([{ extensionId: 'a', why: 'header-conflict' }])
  })

  it('the extension that speaks first keeps a header; one after it that changes it otherwise is ignored as a whole', () => {
    const verdict = mergeRequestHeaders(
      [said('first', { requestHeaders: [{ name: 'Accept', value: 'one' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-Old', value: 'x' }] }), said('second', { requestHeaders: [{ name: 'Accept', value: 'two' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-Old', value: 'x' }, { name: 'X-Second', value: 's' }] })],
      told,
      told
    )
    expect(verdict.headers).toEqual({ Cookie: 'a=1', 'X-Old': 'x', Accept: 'one' })
    expect(verdict.ignored).toEqual([{ extensionId: 'second', why: 'header-conflict' }])
    // Removing what another one set is a conflict too.
    expect(mergeRequestHeaders([said('first', { requestHeaders: [{ name: 'Accept', value: 'one' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-Old', value: 'x' }] }), said('second', { requestHeaders: [{ name: 'Cookie', value: 'a=1' }, { name: 'X-Old', value: 'x' }] })], told, told).ignored).toEqual([{ extensionId: 'second', why: 'header-conflict' }])
  })

  it('a header the browser writes itself is never changed; the rest of the answer is', () => {
    const verdict = mergeRequestHeaders([said('a', { requestHeaders: [{ name: 'Accept', value: '*/*' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-Old', value: 'x' }, { name: 'Host', value: 'evil.example' }, { name: 'Proxy-Authorization', value: 'Basic x' }, { name: 'X-Ok', value: '1' }] })], told, told)
    expect(verdict.headers).toEqual({ ...told, 'X-Ok': '1' })
    expect(verdict.ignored).toEqual([{ extensionId: 'a', why: 'forbidden-header' }])
  })

  it('a cancel wins', () => {
    expect(mergeRequestHeaders([said('a', { requestHeaders: [] }), said('b', { cancel: true })], told, told)).toMatchObject({ cancel: true })
  })
})

describe('the answers to the headers of an answer', () => {
  const url = 'https://site.example/page'
  const told = { 'Content-Type': ['text/html'], 'Set-Cookie': ['a=1', 'b=2'], 'Content-Security-Policy': ["script-src 'self'"] }

  it('lines added and removed, a header that comes several times included', () => {
    const verdict = mergeResponseHeaders([said('a', { responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'X-Added', value: '1' }] })], told, told, url)
    expect(verdict).toEqual({ cancel: false, headers: { 'Content-Type': ['text/html'], 'Set-Cookie': ['a=1'], 'X-Added': ['1'] }, statusLine: null, redirectUrl: null, ignored: [] })
    // Nothing changed: the very same headers.
    expect(mergeResponseHeaders([said('a', { responseHeaders: [{ name: 'content-security-policy', value: "script-src 'self'" }, { name: 'set-cookie', value: 'b=2' }, { name: 'set-cookie', value: 'a=1' }, { name: 'content-type', value: 'text/html' }] })], told, told, url).headers).toBe(told)
  })

  it('an answer that removes a line another one removed, or touches a header a declarative rule changed, is ignored as a whole', () => {
    const dropCsp = { responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }] }
    const twice = mergeResponseHeaders([said('first', dropCsp), said('second', { responseHeaders: [...dropCsp.responseHeaders, { name: 'X-Second', value: '2' }] })], told, told, url)
    expect(twice.headers).toEqual({ 'Content-Type': ['text/html'], 'Set-Cookie': ['a=1', 'b=2'] })
    expect(twice.ignored).toEqual([{ extensionId: 'second', why: 'header-conflict' }])
    const base = { ...told, 'Content-Security-Policy': ["default-src 'none'"] }
    const ruled = mergeResponseHeaders([said('a', dropCsp)], told, base, url)
    expect(ruled.headers).toBe(base)
    expect(ruled.ignored).toEqual([{ extensionId: 'a', why: 'header-conflict' }])
  })

  it('Location is never written by hand: a redirect goes through redirectUrl, whose target is checked', () => {
    const verdict = mergeResponseHeaders([said('a', { responseHeaders: [...Object.entries(told).flatMap(([name, values]) => values.map((value) => ({ name, value }))), { name: 'Location', value: 'file:///etc/passwd' }] })], told, told, url)
    expect(verdict.headers).toBe(told)
    expect(verdict.ignored).toEqual([{ extensionId: 'a', why: 'forbidden-header' }])
  })

  it('a redirect makes the answer a 302 to its target, the changes of the headers kept', () => {
    const verdict = mergeResponseHeaders([said('a', { redirectUrl: 'https://elsewhere.example/', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] })], { ...told, location: ['https://server.example/'] }, { ...told, location: ['https://server.example/'] }, url)
    expect(verdict.statusLine).toBe('HTTP/1.1 302 Found')
    expect(verdict.redirectUrl).toBe('https://elsewhere.example/')
    expect(verdict.headers).toEqual({ 'Content-Type': ['text/html'], Location: ['https://elsewhere.example/'] })
  })

  it('a redirect to a page of the application or a local file is ignored; a cancel wins', () => {
    const refused = mergeResponseHeaders([said('a', { redirectUrl: 'file:///Users/me/secret.txt' })], told, told, url)
    expect(refused).toMatchObject({ cancel: false, statusLine: null, redirectUrl: null, ignored: [{ extensionId: 'a', why: 'target' }] })
    expect(refused.headers).toBe(told)
    expect(mergeResponseHeaders([said('a', { redirectUrl: 'https://x.example/' }), said('b', { cancel: true })], told, told, url).cancel).toBe(true)
  })
})

describe('a login', () => {
  it('a cancel wins; the first credentials are given, other ones named', () => {
    expect(mergeAuth([said('a', { authCredentials: { username: 'u', password: 'p' } }), said('b', { cancel: true })]).answer).toEqual({ cancel: true })
    const verdict = mergeAuth([said('a', { authCredentials: { username: 'u', password: 'p' } }), said('b', { authCredentials: { username: 'v', password: 'q' } })])
    expect(verdict).toEqual({ answer: { credentials: { username: 'u', password: 'p' } }, ignored: [{ extensionId: 'b', why: 'credentials-conflict' }] })
    expect(mergeAuth([said('a', {})]).answer).toBeNull()
  })

  it('the question of the page gets the credentials at the first attempt only, a cancel at any; nothing kept, the user is asked', () => {
    const credentials = { username: 'u', password: 'p' }
    expect(loginOfListeners({ credentials }, true)).toEqual(credentials)
    // A second challenge means they were wrong: given again, they would be refused for ever.
    expect(loginOfListeners({ credentials }, false)).toBeNull()
    expect(loginOfListeners({ cancel: true }, false)).toBe('cancel')
    expect(loginOfListeners(null, true)).toBeNull()
  })

  it('what the listeners answered is taken once, for the session and the address it was kept for, and not after its time', () => {
    const answers = new AuthAnswers<object>()
    const profile = {}
    const other = {}
    answers.keep(profile, 'https://site.example/private', { cancel: true }, 1000)
    expect(answers.take(other, 'https://site.example/private', 1001)).toBeNull()
    expect(answers.take(profile, 'https://site.example/other', 1001)).toBeNull()
    expect(answers.take(profile, 'https://site.example/private', 1001)).toEqual({ cancel: true })
    expect(answers.take(profile, 'https://site.example/private', 1002)).toBeNull()
    answers.keep(profile, 'https://site.example/private', { cancel: true }, 1000)
    expect(answers.take(profile, 'https://site.example/private', 1000 + AUTH_ANSWER_TTL_MS + 1)).toBeNull()
  })
})

describe('the time an extension is given', () => {
  it('late too many times in a row, it is not waited for during a pause; then it is again', () => {
    const slow = new SlowListeners()
    for (let strike = 1; strike < SLOW_STRIKES; strike++) {
      expect(slow.late('a', 0)).toBe('late')
      expect(slow.waits('a', 0)).toBe(true)
    }
    expect(slow.late('a', 0)).toBe('paused')
    expect(slow.waits('a', SLOW_PAUSE_MS - 1)).toBe(false)
    expect(slow.waits('b', 1)).toBe(true)
    expect(slow.waits('a', SLOW_PAUSE_MS)).toBe(true)
  })

  it('an answer in time wipes the strikes; an extension that leaves is forgotten', () => {
    const slow = new SlowListeners()
    for (let strike = 1; strike < SLOW_STRIKES; strike++) slow.late('a', 0)
    slow.answered('a')
    expect(slow.late('a', 0)).toBe('late')
    for (let strike = 1; strike < SLOW_STRIKES; strike++) slow.late('a', 0)
    slow.forget('a')
    expect(slow.waits('a', 1)).toBe(true)
  })
})

describe('what a declarative rule changed', () => {
  it('the names whose values differ, whatever their case', () => {
    expect([...touchedHeaders({ Accept: 'a', Cookie: 'c' }, { accept: 'a', Cookie: 'd', 'X-New': '1' })].sort()).toEqual(['cookie', 'x-new'])
    const same = { a: '1' }
    expect(touchedHeaders(same, same).size).toBe(0)
  })
})
