// The copies of the icons of sites the interface draws (site-icons.ts): downloaded once, in the profile that shows the icon, behind its blocker,
// bounded in size and in kind, and never for an icon nobody shows. Run against a fake session; the real path (the scheme, the session of the
// profile, what the interface asks) is in the engine check `smokeFavicons`.

import { describe, expect, it } from 'vitest'
import { FAVICON_FILE_MAX } from '@shared/favicon'
import { iconSource, type SiteIconOwner } from '@shared/site-icon'
import { SiteIconCopies, type SiteIconLimits } from './site-icons'

const ICON = 'https://journal.example/favicon.png'
const PAGE = 'https://journal.example/article'
const OWNER: SiteIconOwner = { profileId: 'travail', pageUrl: PAGE }

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(40).fill(7)])
const png = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes.set(PNG.subarray(0, 8))
  return bytes
}

const answer = (bytes: Uint8Array, type = 'image/png', status = 200): Response => new Response(new Uint8Array(bytes), { status, headers: { 'content-type': type } })
/** An answer that says nothing of its length and comes in pieces: the body has to be counted as it is read. */
const streamed = (chunks: Uint8Array[], type = 'image/png'): { response: Response; read: () => number } => {
  let read = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[read]
      if (next === undefined) return controller.close()
      read++
      controller.enqueue(next)
    }
  })
  return { response: new Response(body, { status: 200, headers: { 'content-type': type } }), read: () => read }
}

interface Asked {
  profileId: string
  url: string
}

function world(options: { answers?: (url: string) => Response | Promise<Response>; blocked?: (iconUrl: string, pageUrl: string) => boolean; owner?: (iconUrl: string) => SiteIconOwner | null; limits?: Partial<SiteIconLimits> } = {}) {
  const asked: Asked[] = []
  const warnings: string[] = []
  let now = 1_000_000
  const copies = new SiteIconCopies({
    fetch: async (profileId, url) => {
      asked.push({ profileId, url })
      return (options.answers ?? (() => answer(PNG)))(url)
    },
    blocked: options.blocked ?? (() => false),
    owner: options.owner ?? (() => null),
    warn: (line) => void warnings.push(line),
    now: () => now,
    ...(options.limits ? { limits: options.limits } : {})
  })
  const get = (icon: string): Promise<Response> => copies.serve(iconSource(icon) as string)
  return { copies, asked, warnings, get, later: (ms: number) => void (now += ms) }
}

const bytesOf = async (response: Response): Promise<number[]> => [...new Uint8Array(await response.arrayBuffer())]

describe('the copy of an icon the interface asks for', () => {
  it('is downloaded through the profile of the page that declared it, and served under the type its bytes are', async () => {
    const { copies, asked, get } = world({ answers: () => answer(PNG, 'application/octet-stream') })
    copies.declare(ICON, OWNER)
    const response = await get(ICON)
    expect(response.status).toBe(200)
    expect(asked).toEqual([{ profileId: 'travail', url: ICON }])
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await bytesOf(response)).toEqual([...PNG])
  })

  it('is downloaded once: the rows that ask together share one request, and those that ask later get the copy', async () => {
    const { copies, asked, get } = world()
    copies.declare(ICON, OWNER)
    const together = await Promise.all([get(ICON), get(ICON), get(ICON)])
    expect(together.map((response) => response.status)).toEqual([200, 200, 200])
    expect((await get(ICON)).status).toBe(200)
    expect(asked).toHaveLength(1)
  })

  it('is downloaded for an icon the state names (a tab restored and not loaded yet), in the profile the state gives', async () => {
    const { asked, get } = world({ owner: (iconUrl) => (iconUrl === ICON ? { profileId: 'default', pageUrl: PAGE } : null) })
    expect((await get(ICON)).status).toBe(200)
    expect(asked).toEqual([{ profileId: 'default', url: ICON }])
  })

  it('is not downloaded at all for an icon nobody shows: the interface cannot make the main process ask an address', async () => {
    const { asked, get, copies } = world()
    expect((await get('https://ailleurs.example/pixel.gif?id=42')).status).toBe(404)
    expect(asked).toEqual([])
    // Nothing is remembered of it either: once a page declares it, it is downloaded.
    copies.declare('https://ailleurs.example/pixel.gif?id=42', OWNER)
    expect((await get('https://ailleurs.example/pixel.gif?id=42')).status).toBe(200)
  })

  it('refuses a request that names no icon, without asking anyone', async () => {
    const { copies, asked } = world({ owner: () => OWNER })
    for (const request of ['lucium-icon://site/', 'lucium-icon://site/?u=file%3A%2F%2F%2Fetc%2Fpasswd', 'https://journal.example/favicon.png', 'lucium-icon://site/?u=data%3Aimage%2Fpng%3Bbase64%2CAAAA']) {
      expect((await copies.serve(request)).status, request).toBe(400)
    }
    expect(asked).toEqual([])
  })
})

describe('the blocker of the profile', () => {
  it('is asked first, with the page the icon is shown for, and an icon it stops is not downloaded', async () => {
    const judged: string[][] = []
    const { copies, asked, get } = world({
      blocked: (iconUrl, pageUrl) => {
        judged.push([iconUrl, pageUrl])
        return iconUrl.includes('traqueur')
      }
    })
    copies.declare('https://traqueur.example/p.gif', OWNER)
    copies.declare(ICON, OWNER)
    expect((await get('https://traqueur.example/p.gif')).status).toBe(404)
    expect((await get(ICON)).status).toBe(200)
    expect(judged).toEqual([
      ['https://traqueur.example/p.gif', PAGE],
      [ICON, PAGE]
    ])
    expect(asked).toEqual([{ profileId: 'travail', url: ICON }])
  })

  it('stops the icon when it fails, and the log says so without naming the address', async () => {
    const { copies, asked, warnings, get } = world({
      blocked: () => {
        throw new TypeError('the lists are not loaded')
      }
    })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
    expect(asked).toEqual([])
    expect(warnings).toEqual(['[icons] the blocker failed on an icon, so it is not downloaded (TypeError)'])
  })
})

describe('what comes back for an icon', () => {
  it('must be a picture: the error page a site sends with a 200 is not served', async () => {
    const { copies, get } = world({ answers: () => answer(new TextEncoder().encode('<!doctype html><html><body>Introuvable</body></html>'), 'text/html') })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
  })

  it('must be a picture whatever type the site gives it: markup sent as image/png is not served', async () => {
    const { copies, get } = world({ answers: () => answer(new TextEncoder().encode('<script>alert(1)</script>'.padEnd(64, ' ')), 'image/png') })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
  })

  it('must not be contradicted by the type the site gives: a picture sent as a page, or a vector picture sent as text, is not served', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>')
    const sent: Record<string, Response> = { 'https://a.example/i': answer(PNG, 'text/html'), 'https://b.example/i': answer(svg, 'text/plain'), 'https://c.example/i': answer(svg, 'image/svg+xml') }
    const { copies, get } = world({ answers: (url) => sent[url]! })
    for (const address of Object.keys(sent)) copies.declare(address, { profileId: 'travail', pageUrl: address })
    expect((await get('https://a.example/i')).status).toBe(404)
    expect((await get('https://b.example/i')).status).toBe(404)
    const vector = await get('https://c.example/i')
    expect(vector.status).toBe(200)
    expect(vector.headers.get('content-type')).toBe('image/svg+xml')
  })

  it('must answer with a success: a 404 or a 500 with a picture in it is not an icon', async () => {
    const { copies, get } = world({ answers: () => answer(PNG, 'image/png', 404) })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
  })

  it('is refused past the size an icon may have, by the length the server declares', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const { copies, get } = world({ answers: () => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(FAVICON_FILE_MAX + 1) } }) })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
    // Nothing of the body was read.
    expect(cancelled).toBe(true)
  })

  it('is refused past that size when the server declares no length, and the rest of the body is not read', async () => {
    const chunk = png(100_000)
    const big = streamed([chunk, chunk, chunk, chunk, chunk, chunk])
    const { copies, get } = world({ answers: () => big.response })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
    // 262 144 bytes are passed within the third chunk. A stream holds one chunk ahead of its reader, so the fourth was made; the last two never are.
    expect(big.read()).toBe(4)
  })

  it('is served at exactly the largest size', async () => {
    const { copies, get } = world({ answers: () => answer(png(FAVICON_FILE_MAX)) })
    copies.declare(ICON, OWNER)
    const response = await get(ICON)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(FAVICON_FILE_MAX))
  })

  it('may not be an http picture for an https page, whoever named it', async () => {
    const { copies, asked, get } = world()
    copies.declare('http://journal.example/favicon.png', OWNER)
    expect((await get('http://journal.example/favicon.png')).status).toBe(404)
    expect(asked).toEqual([])
  })
})

describe('an icon that gives nothing', () => {
  it('is left alone for a while, then asked again', async () => {
    let ready = false
    const { copies, asked, get, later } = world({ answers: () => (ready ? answer(PNG) : answer(PNG, 'image/png', 503)), limits: { retryAfterMs: 60_000 } })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
    expect((await get(ICON)).status).toBe(404)
    expect(asked).toHaveLength(1)
    ready = true
    later(59_000)
    expect((await get(ICON)).status).toBe(404)
    later(2000)
    expect((await get(ICON)).status).toBe(200)
    expect(asked).toHaveLength(2)
  })

  it('costs the row its picture when the site cannot be reached, and the log names the kind of failure only', async () => {
    const { copies, warnings, get } = world({
      answers: () => {
        throw new TypeError('net::ERR_NAME_NOT_RESOLVED https://journal.example/favicon.png')
      }
    })
    copies.declare(ICON, OWNER)
    expect((await get(ICON)).status).toBe(404)
    expect(warnings).toEqual(['[icons] an icon could not be downloaded (TypeError)'])
    expect(warnings.join(' ')).not.toContain('journal.example')
  })

  it('is not downloaded when the state cannot be asked who shows it, and the log says so', async () => {
    const { asked, warnings, get } = world({
      owner: () => {
        throw new RangeError('the state is being replaced')
      }
    })
    expect((await get(ICON)).status).toBe(404)
    expect(asked).toEqual([])
    expect(warnings).toEqual(['[icons] the state could not be asked who shows an icon, so it is not downloaded (RangeError)'])
  })
})

describe('the copies kept', () => {
  const icon = (n: number): string => `https://site${n}.example/favicon.png`

  it('are bounded in number: the one asked least lately goes first, and is downloaded again if a row shows it', async () => {
    const { copies, asked, get } = world({ limits: { copies: 2 } })
    for (const n of [1, 2, 3]) copies.declare(icon(n), OWNER)
    await get(icon(1))
    await get(icon(2))
    // The first is asked again: the second is now the oldest.
    await get(icon(1))
    await get(icon(3))
    expect(copies.stats().copies).toBe(2)
    await get(icon(1))
    expect(asked.map((request) => request.url)).toEqual([icon(1), icon(2), icon(3)])
    await get(icon(2))
    expect(asked).toHaveLength(4)
  })

  it('are bounded in bytes', async () => {
    const { copies, get } = world({ answers: () => answer(png(1000)), limits: { bytes: 2500 } })
    for (const n of [1, 2, 3]) copies.declare(icon(n), OWNER)
    for (const n of [1, 2, 3]) await get(icon(n))
    expect(copies.stats()).toMatchObject({ copies: 2, bytes: 2000 })
  })

  it('are all forgotten when the data of a profile are erased, with what was remembered of the pages', async () => {
    const { copies, asked, get } = world()
    copies.declare(ICON, OWNER)
    await get(ICON)
    copies.clear()
    expect(copies.stats()).toMatchObject({ copies: 0, bytes: 0, declared: 0, failed: 0 })
    // The page that declared it is forgotten too: the copy is not made again until a page or the state names the icon.
    expect((await get(ICON)).status).toBe(404)
    expect(asked).toHaveLength(1)
  })

  it('take the bytes a lookup of the application already read, and ask the site nothing more', async () => {
    const { copies, asked, get } = world()
    expect(copies.keep(ICON, PNG, 'image/png')).toBe(true)
    const response = await get(ICON)
    expect(response.status).toBe(200)
    expect(await bytesOf(response)).toEqual([...PNG])
    expect(asked).toEqual([])
    // Not bytes that are no picture, nor an address an icon cannot have.
    expect(copies.keep('https://autre.example/a.png', new TextEncoder().encode('<html>'.padEnd(40, ' ')), 'image/png')).toBe(false)
    expect(copies.keep('file:///tmp/a.png', PNG, 'image/png')).toBe(false)
    expect(copies.stats().copies).toBe(1)
  })

  it('are a copy indeed: the bytes handed over can change afterwards without changing what is served', async () => {
    const { copies, get } = world()
    const handed = new Uint8Array(PNG)
    copies.keep(ICON, handed, 'image/png')
    handed.fill(0)
    expect(await bytesOf(await get(ICON))).toEqual([...PNG])
  })
})

describe('many icons asked at once (a window restored with its tabs)', () => {
  it('are downloaded a few at a time, and all of them in the end', async () => {
    let active = 0
    let most = 0
    const { copies, get } = world({
      limits: { concurrency: 2 },
      answers: async () => {
        active++
        most = Math.max(most, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
        return answer(PNG)
      }
    })
    const icons = Array.from({ length: 9 }, (_, n) => `https://site${n}.example/favicon.png`)
    for (const address of icons) copies.declare(address, OWNER)
    const statuses = (await Promise.all(icons.map(get))).map((response) => response.status)
    expect(statuses).toEqual(new Array(9).fill(200))
    expect(most).toBe(2)
  })

  it('past the icons that may wait, an icon is not drawn this time and is asked again at the next demand', async () => {
    const gates: Array<() => void> = []
    const { copies, asked, get } = world({ limits: { concurrency: 1, waiting: 1 }, answers: () => new Promise<Response>((resolve) => gates.push(() => resolve(answer(PNG)))) })
    const icons = [0, 1, 2].map((n) => `https://site${n}.example/favicon.png`)
    for (const address of icons) copies.declare(address, OWNER)
    const pending = icons.map(get)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The third found no place to wait.
    expect((await pending[2]!).status).toBe(404)
    gates.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates.shift()!()
    expect((await Promise.all(pending.slice(0, 2))).map((response) => response.status)).toEqual([200, 200])
    const again = get(icons[2]!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates.shift()!()
    expect((await again).status).toBe(200)
    expect(asked).toHaveLength(3)
  })
})
