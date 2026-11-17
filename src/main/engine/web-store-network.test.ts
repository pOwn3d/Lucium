import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CrxRejected, STORE_PUBLISHER_KEY_SHA256 } from './crx-scan'
import { crxOf, newTestKey, packageOf, testPublisherKeys, zipOf } from './crx-test-support'
import { ASSET_MAX_BYTES, JSON_MAX_BYTES, MAX_REDIRECTS, StoreNetworkError, assertStoreUrl, capFor, createStoreFetch, releaseUpdateBody, type StoreRequestInfo } from './web-store-network'

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'Exemple', version: '1.0' })
const GOOD_CRX = crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }]))

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let server: Server
let base: string
let handler: Handler = (_req, res) => res.end()
const seen: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())))

const rewrite = (url: URL) => new URL(`${url.pathname}${url.search}`, base)

function store(extra: Partial<Parameters<typeof createStoreFetch>[0]> = {}) {
  const requests: StoreRequestInfo[] = []
  const transport = vi.fn(fetch)
  return { requests, transport, fetch: createStoreFetch({ transport, rewrite, onRequest: (info) => requests.push(info), publisherKeys: testPublisherKeys(), ...extra }) }
}

describe('assertStoreUrl', () => {
  it('lets Google\'s hosts through over https', () => {
    expect(() => assertStoreUrl(new URL('https://clients2.google.com/service/update2/crx?x=1'))).not.toThrow()
    expect(() => assertStoreUrl(new URL('https://lh3.googleusercontent.com/abc'))).not.toThrow()
  })
  it('refuses another host, another scheme, another port and credentials', () => {
    for (const bad of ['https://evil.example/x', 'http://clients2.google.com/', 'https://clients2.google.com:8443/', 'https://user:pw@clients2.google.com/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://google.com.evil.example/']) {
      expect(() => assertStoreUrl(new URL(bad)), bad).toThrow(StoreNetworkError)
    }
  })
  it('accepts plain http only when the engine check asks for it, and only for the hosts of the list', () => {
    expect(() => assertStoreUrl(new URL('http://clients2.google.com/'), true)).not.toThrow()
    expect(() => assertStoreUrl(new URL('http://evil.example/'), true)).toThrow(StoreNetworkError)
  })
})

describe('createStoreFetch', () => {
  it('sends nothing for an address that is not allowed, and says why', async () => {
    const { fetch: guarded, transport, requests } = store()
    for (const bad of ['https://evil.example/icon.png', 'http://127.0.0.1:1/x', 'https://clients2.google.com:9999/x']) {
      await expect(guarded(bad), bad).rejects.toThrow(StoreNetworkError)
    }
    expect(transport).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('reports an address it refuses, with the reason, and a redirect it refuses', async () => {
    const refused: string[] = []
    handler = (_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'https://evil.example/steal')
      res.end()
    }
    const { fetch: guarded } = store({ onRefused: (url, reason) => refused.push(`${url.hostname}: ${reason}`) })
    await expect(guarded('https://nonexistent.invalid/icon.png')).rejects.toThrow(StoreNetworkError)
    await expect(guarded('https://clients2.google.com/hop')).rejects.toThrow(StoreNetworkError)
    expect(refused).toEqual(['nonexistent.invalid: host not allowed: nonexistent.invalid', 'evil.example: host not allowed: evil.example'])
  })

  it('answers an allowed request, reporting the host and the path but not the query', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'image/png')
      res.end('PNG')
    }
    const { fetch: guarded, requests } = store()
    const response = await guarded('https://lh3.googleusercontent.com/icon?size=128')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('PNG')
    expect(requests).toEqual([{ method: 'GET', host: 'lh3.googleusercontent.com', path: '/icon' }])
  })

  it('sends the method, headers and body of a request the library makes (the update check is a POST)', async () => {
    let received = ''
    handler = (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        received = `${req.method} ${req.headers['content-type']} ${body}`
        res.end(')]}\'\n{}')
      })
    }
    const { fetch: guarded } = store()
    await guarded('https://update.googleapis.com/service/update2/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(received).toBe('POST application/json {"a":1}')
  })

  it('follows a redirect to an allowed host, and refuses one that goes elsewhere before sending it', async () => {
    handler = (req, res) => {
      if (req.url === '/hop') {
        res.statusCode = 302
        res.setHeader('location', 'https://clients2.googleusercontent.com/crx/blobs/abc/x.crx')
        return res.end()
      }
      if (req.url === '/evil') {
        res.statusCode = 302
        res.setHeader('location', 'https://evil.example/steal')
        return res.end()
      }
      if (req.url === '/local') {
        res.statusCode = 302
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data')
        return res.end()
      }
      res.end(req.url === '/crx/blobs/abc/x.crx' ? GOOD_CRX : 'other')
    }
    const { fetch: guarded, requests } = store()
    const ok = await guarded('https://clients2.google.com/hop')
    expect(Buffer.from(await ok.arrayBuffer()).equals(GOOD_CRX)).toBe(true)
    expect(requests.map((r) => r.host)).toEqual(['clients2.google.com', 'clients2.googleusercontent.com'])

    const second = store()
    await expect(second.fetch('https://clients2.google.com/evil')).rejects.toThrow(/host not allowed: evil.example/)
    expect(second.requests.map((r) => r.host)).toEqual(['clients2.google.com'])
    await expect(second.fetch('https://clients2.google.com/local')).rejects.toThrow(StoreNetworkError)
  })

  it('refuses a redirect to an address that cannot be read as an answer of the store, not as a TypeError', async () => {
    handler = (_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'https://[::1')
      res.end()
    }
    const { fetch: guarded } = store()
    const failure = await guarded('https://clients2.google.com/broken').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StoreNetworkError)
    expect(String((failure as Error).message)).toContain('cannot be read')
  })

  it('gives up after too many redirects', async () => {
    handler = (_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'https://clients2.google.com/again')
      res.end()
    }
    const { fetch: guarded, requests } = store()
    await expect(guarded('https://clients2.google.com/again')).rejects.toThrow(/redirects/)
    expect(requests).toHaveLength(MAX_REDIRECTS + 1)
  })

  it('turns a POST into a GET after a 303, and keeps a 307 as it was', async () => {
    const methods: string[] = []
    handler = (req, res) => {
      methods.push(`${req.method} ${req.url}`)
      if (req.url === '/see-other' || req.url === '/temporary') {
        res.statusCode = req.url === '/see-other' ? 303 : 307
        res.setHeader('location', '/landed')
        return res.end()
      }
      res.end('done')
    }
    const { fetch: guarded } = store()
    await guarded('https://update.googleapis.com/see-other', { method: 'POST', body: 'x' })
    await guarded('https://update.googleapis.com/temporary', { method: 'POST', body: 'x' })
    expect(methods).toEqual(['POST /see-other', 'GET /landed', 'POST /temporary', 'POST /landed'])
  })

  it('refuses an answer larger than its limit, declared or not, and keeps the cause when the body cannot be closed', async () => {
    handler = (_req, res) => {
      res.setHeader('content-length', String(ASSET_MAX_BYTES + 1))
      res.end(Buffer.alloc(ASSET_MAX_BYTES + 1))
    }
    const { fetch: guarded } = store()
    await expect(guarded('https://lh3.googleusercontent.com/big')).rejects.toThrow(/larger than/)
    // No content-length: the size is counted as the body arrives.
    handler = (_req, res) => {
      res.write(Buffer.alloc(ASSET_MAX_BYTES / 2))
      res.write(Buffer.alloc(ASSET_MAX_BYTES / 2))
      res.end(Buffer.alloc(10))
    }
    await expect(guarded('https://lh3.googleusercontent.com/chunked')).rejects.toThrow(/larger than/)
    // The update answer has a smaller limit than a picture, a package a larger one.
    expect(capFor(new URL('https://update.googleapis.com/service/update2/json'))).toBe(JSON_MAX_BYTES)
    expect(capFor(new URL('https://clients2.google.com/service/update2/crx'))).toBeGreaterThan(ASSET_MAX_BYTES)
    expect(capFor(new URL('https://clients2.googleusercontent.com/crx/blobs/x'))).toBeGreaterThan(ASSET_MAX_BYTES)

    // A size that is declared too large is refused without reading a byte of the body.
    let pulled = 0
    const declared = vi.fn(async () => new Response(new ReadableStream({ pull: (controller) => (pulled++, controller.enqueue(new Uint8Array(8))) }), { headers: { 'content-length': String(ASSET_MAX_BYTES + 1) } })) as unknown as typeof fetch
    await expect(createStoreFetch({ transport: declared, rewrite })('https://lh3.googleusercontent.com/declared')).rejects.toThrow(/larger than/)
    expect(pulled).toBeLessThanOrEqual(1)

    const stuck = vi.fn(async () => {
      const body = new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1024)), cancel: () => Promise.reject(new Error('close failed')) })
      return new Response(body)
    }) as unknown as typeof fetch
    const cause = await createStoreFetch({ transport: stuck, rewrite }).call(undefined, 'https://lh3.googleusercontent.com/endless').catch((error: unknown) => error)
    expect(cause).toBeInstanceOf(StoreNetworkError)
    expect((cause as StoreNetworkError).cause).toMatchObject({ message: 'close failed' })
  })

  it('looks into a package before handing it over, and refuses one that is not safe', async () => {
    const inspected: string[] = []
    handler = (_req, res) => res.end(GOOD_CRX)
    const { fetch: guarded } = store({ inspectPackage: (scan, url) => inspected.push(`${(scan.manifest as { name: string }).name} ${url.pathname}`) })
    const good = await guarded('https://clients2.google.com/service/update2/crx?x=id%3Dabc')
    expect(Buffer.from(await good.arrayBuffer()).equals(GOOD_CRX)).toBe(true)
    expect(inspected).toEqual(['Exemple /service/update2/crx'])

    handler = (_req, res) => res.end(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }, { name: '../evil.js', data: 'x' }])))
    await expect(guarded('https://clients2.google.com/service/update2/crx')).rejects.toBeInstanceOf(CrxRejected)
  })

  it('refuses a package whose archive was changed on the way, or that nobody signed, before the library unpacks anything', async () => {
    const { fetch: guarded } = store({ inspectPackage: () => undefined })
    // One byte of a stored file, not of the directory or the manifest: the structure still reads, only the signature knows.
    const swapped = Buffer.from(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }, { name: 'background.js', data: Buffer.from('console.log(1)'), method: 0 }])))
    const code = swapped.indexOf(Buffer.from('console.log(1)'))
    swapped[code + 8] = swapped[code + 8]! ^ 1
    for (const [crx, reason] of [[swapped, 'bad-signature'], [crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }]), Buffer.alloc(8)), 'unsigned']] as const) {
      handler = (_req, res) => res.end(crx)
      await expect(guarded('https://clients2.google.com/service/update2/crx'), reason).rejects.toMatchObject({ name: 'CrxRejected', code: reason })
    }
  })

  it('refuses a package the store did not publish, however well its own key signed it: the publisher\'s proof is asked for, as Chromium asks for it', async () => {
    const key = newTestKey()
    const unpublished = packageOf({ key, manifest: { manifest_version: 3, name: 'Exemple', version: '1.0' }, published: false })
    const published = packageOf({ key, manifest: { manifest_version: 3, name: 'Exemple', version: '1.0' } })
    // The fake store's publisher key stands for the store's: a package without its proof is refused, one with it goes through.
    const { fetch: guarded } = store()
    handler = (_req, res) => res.end(unpublished.crx)
    await expect(guarded('https://clients2.google.com/service/update2/crx')).rejects.toMatchObject({ name: 'CrxRejected', code: 'not-from-store' })
    handler = (_req, res) => res.end(published.crx)
    expect((await guarded('https://clients2.google.com/service/update2/crx')).status).toBe(200)
    // Without a key named by the caller, the one asked for is the Chrome Web Store's: the publisher of the tests is not it.
    const { fetch: real } = store({ publisherKeys: undefined })
    await expect(real('https://clients2.google.com/service/update2/crx')).rejects.toMatchObject({ name: 'CrxRejected', code: 'not-from-store' })
    expect(STORE_PUBLISHER_KEY_SHA256).toBe('61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf')
  })

  it('lets the hook of the caller refuse a package (an update that asks for more)', async () => {
    handler = (_req, res) => res.end(GOOD_CRX)
    const { fetch: guarded } = store({
      inspectPackage: () => {
        throw new Error('wider permissions')
      }
    })
    await expect(guarded('https://clients2.google.com/service/update2/crx')).rejects.toThrow('wider permissions')
  })

  it('leaves an error page alone: only an answer that is a package is scanned', async () => {
    handler = (_req, res) => {
      res.statusCode = 404
      res.end('Cr24 but not ok')
    }
    const { fetch: guarded } = store()
    const response = await guarded('https://clients2.google.com/service/update2/crx')
    expect(response.status).toBe(404)
    handler = (_req, res) => res.end('<html>maintenance</html>')
    expect((await (await guarded('https://clients2.google.com/service/update2/crx')).text()).startsWith('<html>')).toBe(true)
  })

  it('passes a network failure of the transport on as it is', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(createStoreFetch({ transport: down, rewrite })('https://clients2.google.com/x')).rejects.toThrow('fetch failed')
  })

  it('builds an answer without a body for the statuses that have none', async () => {
    handler = (_req, res) => {
      res.statusCode = 204
      res.end()
    }
    const { fetch: guarded } = store()
    const response = await guarded('https://update.googleapis.com/service/update2/json')
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })
})

describe('the update check the library sends', () => {
  const omaha = (testsource: unknown) => JSON.stringify({ request: { '@updater': 'electron-chrome-web-store', app: [{ appid: 'a'.repeat(32), updatecheck: {} }], protocol: '3.1', testsource } })

  it('does not say it comes from a development build: the mark the library sets without NODE_ENV=production is emptied', async () => {
    let received = ''
    handler = (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        received = body
        res.end(')]}\'\n{}')
      })
    }
    const { fetch: guarded } = store()
    await guarded('https://update.googleapis.com/service/update2/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: omaha('electron_dev') })
    expect(JSON.parse(received)).toEqual(JSON.parse(omaha('')))
  })

  it('leaves alone a body that is already right, or that is not the JSON expected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(releaseUpdateBody(omaha(''))).toBe(omaha(''))
    expect(releaseUpdateBody('{"request":{}}')).toBe('{"request":{}}')
    expect(releaseUpdateBody('not json')).toBe('not json')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the update check is not JSON'), expect.any(String))
    warn.mockRestore()
  })
})

describe('an answer the caller gives itself', () => {
  it('is returned without anything going out, for the first address only, and after the address was judged', async () => {
    const picture = new Response('png', { status: 200 })
    const asked: string[] = []
    const { fetch: guarded, transport, requests } = store({ answerLocally: (url, method) => (asked.push(`${method} ${url.hostname}`), url.pathname === '/icon.png' ? picture : undefined) })
    expect(await guarded('https://lh3.googleusercontent.com/icon.png')).toBe(picture)
    expect(transport).not.toHaveBeenCalled()
    expect(requests).toEqual([])
    // A host that is not Google's is refused before the caller is asked.
    await expect(guarded('https://nonexistent.invalid/icon.png')).rejects.toThrow(StoreNetworkError)
    expect(asked).toEqual(['GET lh3.googleusercontent.com'])
    // A redirect is never answered by the caller: the hop goes out as before.
    handler = (req, res) => {
      if (req.url === '/hop') {
        res.statusCode = 302
        res.setHeader('location', 'https://lh3.googleusercontent.com/icon.png')
        res.end()
      } else res.end('from the network')
    }
    expect(await (await guarded('https://clients2.google.com/hop')).text()).toBe('from the network')
  })
})
