import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadImages, refererFor, type FetchFn } from './resource-fetch'
import { frenchSpaces } from '@shared/french-typography'

const png = (size: number, type = 'image/png'): Response => new Response(new Uint8Array(size).fill(7), { headers: { 'content-type': type } })
const images = (count: number) => Array.from({ length: count }, (_, i) => ({ reference: `image-${i + 1}`, url: `https://img.example.com/${i + 1}` }))

afterEach(() => vi.restoreAllMocks())

describe('downloadImages', () => {
  it('keeps the images in order under numbered names with the extension of their type', async () => {
    const types = ['image/png', 'image/jpeg; charset=binary', 'IMAGE/WEBP']
    const fetchFn: FetchFn = async (url) => png(10, types[Number(url.slice(-1)) - 1])
    const { files, failures } = await downloadImages(fetchFn, images(3))
    expect(files.map((f) => [f.reference, f.name, f.data.length])).toEqual([
      ['image-1', 'images/image-001.png', 10],
      ['image-2', 'images/image-002.jpg', 10],
      ['image-3', 'images/image-003.webp', 10]
    ])
    expect(failures).toEqual([])
  })

  it('sends the cookies of the session and follows redirects; to another site it names the origin of the page, never its path or its parameters', async () => {
    const seen: unknown[] = []
    await downloadImages(async (_url, init) => (seen.push({ credentials: init.credentials, redirect: init.redirect, headers: init.headers }), png(1)), images(1), { referrer: 'https://page.example.com/secret?token=1' })
    expect(seen).toEqual([{ credentials: 'include', redirect: 'follow', headers: { Referer: 'https://page.example.com/' } }])
  })

  it('names the whole page to the page’s own site, and sends no referrer at all from an https page to an image in clear', async () => {
    const seen: Array<[string, unknown]> = []
    const list = [
      { reference: 'image-1', url: 'https://page.example.com/img/1.png' },
      { reference: 'image-2', url: 'http://page.example.com/img/2.png' },
      { reference: 'image-3', url: 'http://cdn.example.net/3.png' }
    ]
    await downloadImages(async (url, init) => (seen.push([url, init.headers]), png(1)), list, { referrer: 'https://user:pw@page.example.com/doc?token=1#part', limits: { parallel: 1 } })
    expect(seen).toEqual([
      ['https://page.example.com/img/1.png', { Referer: 'https://page.example.com/doc?token=1' }],
      ['http://page.example.com/img/2.png', undefined],
      ['http://cdn.example.net/3.png', undefined]
    ])
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('refuses the type %s, a name every object answers to and no image type', async (type) => {
    const { files, failures } = await downloadImages(async () => new Response(new Uint8Array(4), { headers: { 'content-type': type } }), images(1))
    expect(files).toEqual([])
    expect(failures).toEqual([frenchSpaces('https://img.example.com/1 : la réponse n’est pas une image prise en charge. Lien conservé.')])
  })

  it('reports an image it cannot keep, leaves it a link, and keeps numbering the others without a gap', async () => {
    const answers = [png(5), new Response('nope', { status: 404 }), new Response('<html>', { headers: { 'content-type': 'text/html' } }), png(0), png(5)]
    const { files, failures } = await downloadImages(async () => answers.shift()!, images(5), { limits: { parallel: 1 } })
    expect(files.map((f) => f.name)).toEqual(['images/image-001.png', 'images/image-002.png'])
    expect(files.map((f) => f.reference)).toEqual(['image-1', 'image-5'])
    expect(failures).toEqual([
      frenchSpaces('https://img.example.com/2 : HTTP 404. Lien conservé.'),
      frenchSpaces('https://img.example.com/3 : la réponse n’est pas une image prise en charge. Lien conservé.'),
      frenchSpaces('https://img.example.com/4 : image vide. Lien conservé.')
    ])
  })

  it('refuses an address that is not a web address without asking for it', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => png(1))
    const { files, failures } = await downloadImages(fetchFn, [{ reference: 'image-1', url: 'file:///etc/passwd' }, { reference: 'image-2', url: 'data:image/png;base64,AAAA' }, { reference: 'image-3', url: 'ftp://example.com/a.png' }])
    expect(fetchFn).not.toHaveBeenCalled()
    expect(files).toEqual([])
    expect(failures).toHaveLength(3)
    expect(failures[0]).toContain('adresse non prise en charge')
  })

  it('refuses an answer that a redirect took away from the web', async () => {
    const response = png(5)
    Object.defineProperty(response, 'url', { value: 'file:///etc/passwd' })
    const { files, failures } = await downloadImages(async () => response, images(1))
    expect(files).toEqual([])
    expect(failures[0]).toContain('redirection non prise en charge')
  })

  it('refuses an image that declares a size over the limit, and one that turns out bigger than it said', async () => {
    const declared = new Response(new Uint8Array(10), { headers: { 'content-type': 'image/png', 'content-length': '5000' } })
    const stream = new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/png' } })
    const answers = [declared, stream]
    const { files, failures } = await downloadImages(async () => answers.shift()!, images(2), { limits: { perImageBytes: 1000, parallel: 1 } })
    expect(files).toEqual([])
    expect(failures).toEqual([frenchSpaces('https://img.example.com/1 : image trop volumineuse. Lien conservé.'), frenchSpaces('https://img.example.com/2 : image trop volumineuse. Lien conservé.')])
  })

  it('does not read the rest of a body it refuses', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(400))
      }
    })
    const { failures } = await downloadImages(async () => new Response(body, { headers: { 'content-type': 'image/png' } }), images(1), { limits: { perImageBytes: 1000 } })
    expect(failures[0]).toContain('image trop volumineuse')
    expect(pulled).toBeLessThan(10)
  })

  it('stops keeping images once the total size is reached', async () => {
    const { files, failures } = await downloadImages(async () => png(400), images(5), { limits: { totalBytes: 1000, parallel: 1 } })
    expect(files).toHaveLength(2)
    expect(failures).toHaveLength(3)
    expect(failures.every((f) => f.includes('limite de taille totale atteinte'))).toBe(true)
  })

  it('does not even read the next image once the total size is spent', async () => {
    let pulled = 0
    // A queue of size zero: nothing is pulled from the source until someone reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++
          controller.enqueue(new Uint8Array(10))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const answers = [png(600), new Response(body, { headers: { 'content-type': 'image/png' } })]
    const { files, failures } = await downloadImages(async () => answers.shift()!, images(2), { limits: { totalBytes: 500, parallel: 1 } })
    expect(files).toEqual([])
    expect(failures).toHaveLength(2)
    expect(pulled).toBe(0)
  })

  it('downloads no more images than the count limit, and says so', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => png(1))
    const { files, failures } = await downloadImages(fetchFn, images(7), { limits: { count: 3 } })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(files).toHaveLength(3)
    expect(failures).toEqual([frenchSpaces('Limite de 3 images : les 4 autres restent des liens vers le site.')])
  })

  it('gives up on an image that does not answer in time and goes on with the others', async () => {
    const fetchFn: FetchFn = (url, init) =>
      url.endsWith('/1')
        ? new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
        : Promise.resolve(png(3))
    const { files, failures } = await downloadImages(fetchFn, images(2), { limits: { timeoutMs: 30 } })
    expect(files.map((f) => f.reference)).toEqual(['image-2'])
    expect(failures).toEqual([frenchSpaces('https://img.example.com/1 : délai dépassé. Lien conservé.')])
  })

  it('starts no new image once the overall time is spent', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => png(1))
    const { files, failures } = await downloadImages(fetchFn, images(3), { limits: { deadlineMs: 0 } })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(files).toEqual([])
    expect(failures).toEqual([frenchSpaces('Délai de récupération des images atteint : les autres restent des liens vers le site.')])
  })

  it('never runs more downloads together than allowed', async () => {
    let running = 0
    let peak = 0
    const fetchFn: FetchFn = async () => {
      peak = Math.max(peak, ++running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return png(1)
    }
    const { files } = await downloadImages(fetchFn, images(12), { limits: { parallel: 3 } })
    expect(files).toHaveLength(12)
    expect(peak).toBe(3)
  })

  it('stops when told to, and reports the progress of the images it did', async () => {
    const controller = new AbortController()
    const progress: Array<[number, number]> = []
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/2')) controller.abort()
      return png(1)
    }
    const { files } = await downloadImages(fetchFn, images(6), { limits: { parallel: 1 }, signal: controller.signal, progress: (done, total) => progress.push([done, total]) })
    expect(files.map((f) => f.reference)).toEqual(['image-1', 'image-2'])
    expect(progress).toEqual([[1, 6], [2, 6]])
  })

  it('logs a body that cannot be cancelled instead of hiding it', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const response = png(4)
    const reader = { read: vi.fn().mockResolvedValueOnce({ value: new Uint8Array(4), done: false }).mockResolvedValueOnce({ done: true }), cancel: vi.fn().mockRejectedValue(new Error('locked')) }
    Object.defineProperty(response, 'body', { value: { getReader: () => reader } })
    const { files } = await downloadImages(async () => response, images(1))
    expect(files).toHaveLength(1)
    expect(debug).toHaveBeenCalledWith('[markdown] cannot cancel the body of an image:', 'locked')
  })
})

describe('refererFor', () => {
  it('gives an http page the same rule, with its origin to another site in clear', () => {
    expect(refererFor('http://page.example.com/a?b=1', 'http://img.example.net/1.png')).toBe('http://page.example.com/')
    expect(refererFor('http://page.example.com/a?b=1', 'https://img.example.net/1.png')).toBe('http://page.example.com/')
    expect(refererFor('http://page.example.com/a?b=1', 'http://page.example.com/1.png')).toBe('http://page.example.com/a?b=1')
  })

  it('takes another port or another scheme of the same host for another site', () => {
    expect(refererFor('https://page.example.com/a?b=1', 'https://page.example.com:8443/1.png')).toBe('https://page.example.com/')
  })

  it('says nothing for a page that is not on the web, for no page, or for an address that cannot be read', () => {
    expect(refererFor('file:///Users/me/secret.html', 'https://img.example.net/1.png')).toBeUndefined()
    expect(refererFor('lucium://settings', 'https://img.example.net/1.png')).toBeUndefined()
    expect(refererFor(undefined, 'https://img.example.net/1.png')).toBeUndefined()
    expect(refererFor('', 'https://img.example.net/1.png')).toBeUndefined()
    expect(refererFor('not an address', 'https://img.example.net/1.png')).toBeUndefined()
    expect(refererFor('https://page.example.com/a', 'not an address')).toBeUndefined()
  })
})
