import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createSessionTransport, type TransportOptions, type TransportRequest } from './web-store-transport'

const DEFAULT_SESSION = vi.hoisted(() => ({ name: 'the session of the application' }))
const netRequest = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: {}, nativeImage: {}, net: { request: netRequest }, session: { defaultSession: DEFAULT_SESSION }, webContents: {} }))

/** Electron's `ClientRequest`, as far as the transport uses it. */
class FakeRequest extends EventEmitter implements TransportRequest {
  sent: Array<string | Buffer | undefined> = []
  aborted = false
  constructor(readonly options: TransportOptions) {
    super()
  }
  end(chunk?: string | Buffer): void {
    this.sent.push(chunk)
  }
  abort(): void {
    this.aborted = true
  }
  /** The server answers: the status, the headers, then the pieces of the body. */
  answer(statusCode: number, headers: Record<string, string | string[]> = {}, chunks: string[] = [], statusMessage = 'OK'): EventEmitter {
    const res = Object.assign(new EventEmitter(), { statusCode, statusMessage, headers })
    this.emit('response', res)
    for (const chunk of chunks) res.emit('data', Buffer.from(chunk))
    return res
  }
}

let requests: FakeRequest[]
let debug: MockInstance<typeof console.debug>
const transport = createSessionTransport((options) => {
  const request = new FakeRequest(options)
  requests.push(request)
  return request
})
const last = (): FakeRequest => requests.at(-1)!

beforeEach(() => {
  requests = []
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
})
afterEach(() => debug.mockRestore())

describe('createSessionTransport', () => {
  it('asks the network stack for a request with no cookie, no Referer and no cache, and not to follow a redirect', async () => {
    const pending = transport('https://clients2.google.com/service/update2/crx?x=1', { headers: { 'x-goog-update-appid': 'abc' } })
    expect(last().options).toEqual({
      url: 'https://clients2.google.com/service/update2/crx?x=1',
      method: 'GET',
      headers: { 'x-goog-update-appid': 'abc' },
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store'
    })
    last().answer(200, { 'content-type': 'text/plain' }, ['hel', 'lo']).emit('end')
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('hello')
    expect(last().sent).toEqual([undefined])
  })

  it('sends the method, the headers and the body of a request the library makes (the update check is a POST of JSON)', async () => {
    const pending = transport(new URL('https://update.googleapis.com/service/update2/json'), { method: 'post', headers: new Headers({ 'Content-Type': 'application/json' }), body: '{"a":1}' })
    expect(last().options).toMatchObject({ method: 'POST', url: 'https://update.googleapis.com/service/update2/json', headers: { 'content-type': 'application/json' } })
    expect(last().sent).toEqual(['{"a":1}'])
    last().answer(200, {}, []).emit('end')
    await pending
    // Bytes too, as a Buffer, whatever view they come in.
    void transport('https://clients2.google.com/x', { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    expect(last().sent[0]).toEqual(Buffer.from([1, 2, 3]))
    void transport('https://clients2.google.com/x', { method: 'POST', body: new Uint8Array([9, 1, 2, 3]).subarray(1) })
    expect(last().sent[0]).toEqual(Buffer.from([1, 2, 3]))
  })

  it('refuses a body it cannot send, without making a request', async () => {
    await expect(transport('https://clients2.google.com/x', { method: 'POST', body: new URLSearchParams({ a: '1' }) })).rejects.toThrow(TypeError)
    expect(requests).toEqual([])
  })

  it('gives a redirect back as an answer, with its address, and stops the transfer: the guard judges where it goes', async () => {
    const pending = transport('https://clients2.google.com/service/update2/crx')
    last().emit('redirect', 302, 'GET', 'https://clients2.googleusercontent.com/crx/blobs/AAA/x.crx')
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://clients2.googleusercontent.com/crx/blobs/AAA/x.crx')
    expect(last().aborted).toBe(true)
  })

  it('builds an answer without a body for the statuses that have none, and stops the transfer', async () => {
    for (const status of [204, 304]) {
      const pending = transport('https://clients2.google.com/x')
      last().answer(status, { etag: '"x"' }, [], 'No Content')
      const response = await pending
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(last().aborted).toBe(true)
    }
  })

  it('joins a header that comes in several values, and skips one the Fetch standard does not accept, saying so in the journal', async () => {
    const pending = transport('https://clients2.google.com/x')
    last().answer(200, { 'set-cookie': ['a=1', 'b=2'], 'x-fine': 'yes', 'bad name': 'x', 'x-bad-value': 'line\nbreak' }, []).emit('end')
    const response = await pending
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2')
    expect(response.headers.get('x-fine')).toBe('yes')
    expect(response.headers.get('x-bad-value')).toBeNull()
    expect(debug.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([expect.stringContaining('skipped the header bad name'), expect.stringContaining('skipped the header x-bad-value')]))
  })

  it('rejects with the error of the network when nothing came back, and ends the body with it when something had', async () => {
    const failed = transport('https://clients2.google.com/x')
    last().emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
    await expect(failed).rejects.toThrow('ERR_NAME_NOT_RESOLVED')

    const cut = transport('https://clients2.google.com/x')
    const res = last().answer(200, {}, ['par'])
    const response = await cut
    res.emit('aborted')
    await expect(response.text()).rejects.toThrow('the answer was cut')
  })

  it('writes down an error that comes after the body had already ended, and does not throw', async () => {
    const pending = transport('https://clients2.google.com/x')
    const res = last().answer(200, {}, ['ok'])
    const response = await pending
    res.emit('end')
    expect(await response.text()).toBe('ok')
    // The error of a connection that closes after the end: nothing to reject, nothing to end, but it is written down.
    expect(() => last().emit('error', new Error('socket closed'))).not.toThrow()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('an error came after the answer was complete'), 'socket closed')
  })

  it('writes down, and otherwise ignores, the error that an abort raises on a body its reader gave up', async () => {
    const pending = transport('https://clients2.google.com/x')
    const res = last().answer(200, {}, ['partial'])
    const response = await pending
    await response.body!.cancel()
    res.emit('aborted')
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('an error came after the answer was complete'), 'the answer was cut')
  })

  it('stops the transfer when the caller gives up on the body (the guard does so at its size limit)', async () => {
    const pending = transport('https://clients2.google.com/x')
    last().answer(200, {}, ['partial'])
    const response = await pending
    expect(last().aborted).toBe(false)
    await response.body!.cancel()
    expect(last().aborted).toBe(true)
  })

  it('aborts the request and rejects with the reason when the signal fires, before or after the answer', async () => {
    const early = AbortSignal.abort(new Error('too late'))
    await expect(transport('https://clients2.google.com/x', { signal: early })).rejects.toThrow('too late')
    expect(requests).toEqual([])

    const controller = new AbortController()
    const waiting = transport('https://clients2.google.com/x', { signal: controller.signal })
    controller.abort(new Error('timeout'))
    await expect(waiting).rejects.toThrow('timeout')
    expect(last().aborted).toBe(true)

    const reading = new AbortController()
    const started = transport('https://clients2.google.com/x', { signal: reading.signal })
    last().answer(200, {}, ['a'])
    const response = await started
    reading.abort(new Error('timeout while reading'))
    await expect(response.text()).rejects.toThrow('timeout while reading')
  })
})

describe('the Web Store does not use the fetch of Node', () => {
  it('sends its requests with Electron\'s network stack in the session of the application, not with globalThis.fetch', async () => {
    const { WebStore } = await import('./web-store')
    const own = (WebStore.prototype as unknown as { ownTransport(this: unknown): typeof fetch }).ownTransport
    const store = {}
    const send = own.call(store)
    // One transport per store, made the first time it is asked for.
    expect(own.call(store)).toBe(send)
    netRequest.mockImplementation((options: TransportOptions) => {
      const request = new FakeRequest(options)
      requests.push(request)
      return request
    })
    const fetchOfNode = vi.spyOn(globalThis, 'fetch')
    const pending = send('https://update.googleapis.com/service/update2/json', { method: 'POST', body: '{}' })
    expect(netRequest).toHaveBeenCalledTimes(1)
    expect(netRequest.mock.calls[0]![0]).toMatchObject({ url: 'https://update.googleapis.com/service/update2/json', method: 'POST', session: DEFAULT_SESSION })
    last().answer(200, {}, ['{}']).emit('end')
    expect((await pending).status).toBe(200)
    expect(fetchOfNode).not.toHaveBeenCalled()
    fetchOfNode.mockRestore()
  })

  // Contract: the library keeps the `fetch` of the moment it is evaluated, and loading it needs a real Electron; these are the only lines that touch the
  // fetch of Node (the guard put in its place while the library is evaluated, and put back), and the guard sends with the transport above.
  it('puts its guard in the place of the fetch of Node only while the library is evaluated', () => {
    const source = readFileSync(new URL('./web-store.ts', import.meta.url), 'utf8')
    const uses = source.split('\n').filter((line) => /globalThis\.fetch/.test(line) && !/^\s*(\/\/|\*)/.test(line))
    expect(uses.map((line) => line.trim())).toEqual(['const original = globalThis.fetch', 'globalThis.fetch = guarded', 'globalThis.fetch = original'])
    expect(source).toMatch(/store\.test\?\.transport \?\? store\.ownTransport\(\)/)
  })
})
