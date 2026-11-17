import { describe, expect, it } from 'vitest'
import { FAVICON_FILE_MAX, FAVICON_HTML_MAX, type IconJob } from '@shared/favicon'
import { FaviconResolver, type FetchLike, type ResolverDeps, type ResolverLimits } from './favicon-resolver'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1])
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0])

interface Reply {
  status?: number
  type?: string
  body?: string | Uint8Array
  location?: string
  /** Never answers before the request is aborted. */
  hang?: boolean
  /** Streams for ever, in chunks of this many bytes, counting what is pulled. */
  endless?: number
  /** Answers after this many milliseconds, abort or not. */
  delay?: number
}

const html = (head: string): Reply => ({ type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>Site</title>${head}</head><body>x</body></html>` })
const png = (): Reply => ({ type: 'image/png', body: PNG })
const ico = (): Reply => ({ type: 'image/x-icon', body: ICO })
const redirect = (location: string, status = 302): Reply => ({ status, location })

/** A fake web: the replies by address, every request noted. Anything not listed is a 404. */
function fakeWeb(sites: Record<string, Reply | ((url: string) => Reply)>) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  let active = 0
  let peak = 0
  const pulled = { bytes: 0 }
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    active++
    peak = Math.max(peak, active)
    try {
      const entry = sites[url]
      const reply: Reply = typeof entry === 'function' ? entry(url) : (entry ?? { status: 404, type: 'text/html', body: 'introuvable' })
      if (reply.hang) {
        await new Promise<void>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true }))
      }
      if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay))
      await Promise.resolve()
      const headers: Record<string, string> = {}
      if (reply.type) headers['content-type'] = reply.type
      if (reply.location) headers['location'] = reply.location
      if (reply.endless) {
        const size = reply.endless
        let first = true
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled.bytes += size
            const chunk = new Uint8Array(size).fill(0x20)
            // The answer starts like a real picture: only its size gives it away.
            if (first && reply.type?.startsWith('image/')) chunk.set(PNG)
            first = false
            controller.enqueue(chunk)
          }
        })
        return new Response(body, { status: reply.status ?? 200, headers })
      }
      return new Response(reply.status !== undefined && reply.status >= 300 && reply.status < 400 ? null : ((reply.body ?? null) as BodyInit | null), { status: reply.status ?? (reply.location ? 302 : 200), headers })
    } finally {
      active--
    }
  }
  return { fetch, calls, urls: () => calls.map((c) => c.url), peak: () => peak, pulled }
}

interface Delivery {
  ids: string[]
  origin: string
  icon: string
}

function resolverFor(web: { fetch: FetchLike }, over: Partial<ResolverDeps> = {}, limits: Partial<ResolverLimits> = {}) {
  const delivered: Delivery[] = []
  let enabled = true
  const resolver = new FaviconResolver({
    fetch: web.fetch,
    enabled: () => enabled,
    deliver: (ids, origin, icon) => delivered.push({ ids, origin, icon }),
    limits,
    ...over
  })
  return { resolver, delivered, setEnabled: (value: boolean) => (enabled = value) }
}

const job = (id: string, url: string, rank = 0): IconJob => ({ id, url, rank })

async function lookupOne(sites: Record<string, Reply | ((url: string) => Reply)>, url = 'https://exemple.fr/profond/chemin?x=1', over: Partial<ResolverDeps> = {}, limits: Partial<ResolverLimits> = {}) {
  const web = fakeWeb(sites)
  const run = resolverFor(web, over, limits)
  run.resolver.enqueue([job('favorite:1', url)])
  await run.resolver.idle()
  return { ...run, web }
}

describe('finding the icon of a site', () => {
  it('reads the home page of the site (not the page that was saved) and takes the icon it declares', async () => {
    const { delivered, web } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/img/logo.png" type="image/png">'), 'https://exemple.fr/img/logo.png': png() })
    expect(delivered).toEqual([{ ids: ['favorite:1'], origin: 'https://exemple.fr', icon: 'https://exemple.fr/img/logo.png' }])
    expect(web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/img/logo.png'])
  })

  it('falls back to /favicon.ico when the page declares nothing', async () => {
    const { delivered, web } = await lookupOne({ 'https://exemple.fr/': html(''), 'https://exemple.fr/favicon.ico': ico() })
    expect(delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
    expect(web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/favicon.ico'])
  })

  it('takes an apple-touch-icon when it is all the page has, and /favicon.ico only after it', async () => {
    const found = await lookupOne({ 'https://exemple.fr/': html('<link rel="apple-touch-icon" href="/apple.png">'), 'https://exemple.fr/apple.png': png(), 'https://exemple.fr/favicon.ico': ico() })
    expect(found.delivered[0]?.icon).toBe('https://exemple.fr/apple.png')
    expect(found.web.urls()).not.toContain('https://exemple.fr/favicon.ico')
  })

  it('tries the next address when the best one does not answer: the other declared icons, then /favicon.ico', async () => {
    const sites = { 'https://exemple.fr/': html('<link rel="icon" sizes="32x32" href="/a.png"><link rel="icon" sizes="16x16" href="/b.png">'), 'https://exemple.fr/favicon.ico': ico() }
    const found = await lookupOne(sites)
    expect(found.delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
    expect(found.web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/a.png', 'https://exemple.fr/b.png', 'https://exemple.fr/favicon.ico'])
  })

  it('leaves the site without an icon when nothing answers as a picture, and says why', async () => {
    const { delivered, resolver } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/a.png">') })
    expect(delivered).toEqual([])
    expect(resolver.stats()).toMatchObject({ attempted: 1, found: 0, failed: 1, reasons: { 'no-icon': 1, refused: 0, timeout: 0, network: 0 } })
  })

  it('says where the lookup stopped for the sites that gave no icon, without naming them', async () => {
    const web = fakeWeb({
      'https://sans-lien.example/': html(''),
      'https://erreur.example/': { ...html(''), status: 404 },
      'https://ailleurs.example/': redirect('https://autre.example/'),
      'https://autre.example/': html(''),
      'https://json.example/': { type: 'application/json', body: '{}' },
      'https://declare.example/': html('<link rel="icon" href="/x.png">')
    })
    const run = resolverFor(web)
    run.resolver.enqueue(['sans-lien', 'erreur', 'ailleurs', 'json', 'declare'].map((name) => job(name, `https://${name}.example/`)))
    await run.resolver.idle()
    expect(run.resolver.stats().causes).toEqual({
      'page 2xx, html, 1 to try': 1,
      'page 4xx, html, 1 to try': 1,
      'page 2xx, left the site, 1 to try': 1,
      'page 2xx, no html, 1 to try': 1,
      'page 2xx, html, 2 to try': 1
    })
    expect(JSON.stringify(run.resolver.stats().causes)).not.toMatch(/example/)
  })

  it('does not take for an icon what is not a picture: the HTML error page sent with a 200, a wrong status, an empty body', async () => {
    const page = html('<link rel="icon" href="/a.png"><link rel="icon" href="/b.png"><link rel="icon" href="/c.png">')
    const { delivered, web } = await lookupOne({
      'https://exemple.fr/': page,
      'https://exemple.fr/a.png': { type: 'image/png', body: '<!doctype html><html><body>Page introuvable sur ce site</body></html>' },
      'https://exemple.fr/b.png': { status: 500, type: 'image/png', body: PNG },
      'https://exemple.fr/c.png': { type: 'image/png', body: new Uint8Array(0) },
      'https://exemple.fr/favicon.ico': { type: 'text/html', body: '<html>pas une icône</html>' }
    })
    expect(delivered).toEqual([])
    expect(web.urls()).toHaveLength(5)
  })

  it('refuses an icon larger than 256 KB without reading it all', async () => {
    const big = fakeWeb({ 'https://exemple.fr/': html('<link rel="icon" href="/grosse.png">'), 'https://exemple.fr/grosse.png': { type: 'image/png', endless: 64 * 1024 } })
    const run = resolverFor(big)
    run.resolver.enqueue([job('favorite:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    expect(run.delivered).toEqual([])
    expect(big.pulled.bytes).toBeLessThanOrEqual(FAVICON_FILE_MAX + 2 * 64 * 1024)
    expect(big.pulled.bytes).toBeGreaterThan(0)
  })

  it('reads no more than 64 KB of a page, and still finds an icon declared in them', async () => {
    const web = fakeWeb({
      'https://exemple.fr/': () => ({ type: 'text/html', body: `<link rel="icon" href="/ici.png">${' '.repeat(FAVICON_HTML_MAX * 3)}<link rel="icon" href="/trop-loin.png">` }),
      'https://exemple.fr/ici.png': png(),
      'https://exemple.fr/trop-loin.png': png()
    })
    const run = resolverFor(web)
    run.resolver.enqueue([job('favorite:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    expect(run.delivered[0]?.icon).toBe('https://exemple.fr/ici.png')
    const endless = fakeWeb({ 'https://exemple.fr/': { type: 'text/html', endless: 16 * 1024 }, 'https://exemple.fr/favicon.ico': ico() })
    const second = resolverFor(endless)
    second.resolver.enqueue([job('favorite:1', 'https://exemple.fr/')])
    await second.resolver.idle()
    expect(endless.pulled.bytes).toBeLessThanOrEqual(FAVICON_HTML_MAX + 2 * 16 * 1024)
    expect(second.delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
  })

  it('does not read a home page that is not HTML, but still tries /favicon.ico', async () => {
    const { delivered, web } = await lookupOne({ 'https://exemple.fr/': { type: 'application/json', body: '{"link":"<link rel=\\"icon\\" href=\\"/x.png\\">"}' }, 'https://exemple.fr/x.png': png(), 'https://exemple.fr/favicon.ico': ico() })
    expect(delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
    expect(web.urls()).not.toContain('https://exemple.fr/x.png')
  })

  it('reads the markup of an error page (404 or 403), but not of a server that is down (5xx)', async () => {
    const declared = '<link rel="icon" href="/x.png">'
    const notFound = await lookupOne({ 'https://exemple.fr/': { ...html(declared), status: 404 }, 'https://exemple.fr/x.png': png() })
    expect(notFound.delivered[0]?.icon).toBe('https://exemple.fr/x.png')
    const down = await lookupOne({ 'https://exemple.fr/': { ...html(declared), status: 503 }, 'https://exemple.fr/x.png': png(), 'https://exemple.fr/favicon.ico': ico() })
    expect(down.delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
  })

  it('resolves a relative icon against <base href> and against the page after a redirect to www', async () => {
    const based = await lookupOne({ 'https://exemple.fr/': html('<base href="https://static.exemple.fr/v2/"><link rel="icon" href="i.png">'), 'https://static.exemple.fr/v2/i.png': png() })
    expect(based.delivered[0]?.icon).toBe('https://static.exemple.fr/v2/i.png')
    const moved = await lookupOne({ 'https://exemple.fr/': redirect('https://www.exemple.fr/accueil/'), 'https://www.exemple.fr/accueil/': html('<link rel="icon" href="i.png">'), 'https://www.exemple.fr/accueil/i.png': png() })
    expect(moved.delivered[0]?.icon).toBe('https://www.exemple.fr/accueil/i.png')
  })

  it('looks for /favicon.ico at the site the page ended on, after a redirect inside the same site', async () => {
    const { delivered } = await lookupOne({ 'https://exemple.fr/': redirect('/fr/', 301), 'https://exemple.fr/fr/': html(''), 'https://exemple.fr/favicon.ico': ico() })
    expect(delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
    const www = await lookupOne({ 'https://exemple.fr/': redirect('https://www.exemple.fr/'), 'https://www.exemple.fr/': html(''), 'https://www.exemple.fr/favicon.ico': ico() })
    expect(www.delivered[0]?.icon).toBe('https://www.exemple.fr/favicon.ico')
  })

  it('does not take the icon of another site when the home page sends the visitor there (a sign-in service): only /favicon.ico of the site is tried', async () => {
    const { delivered, web } = await lookupOne({
      'https://app.exemple.fr/': redirect('https://connexion.autre.example/login'),
      'https://connexion.autre.example/login': html('<link rel="icon" href="/leur-logo.png">'),
      'https://connexion.autre.example/leur-logo.png': png(),
      'https://app.exemple.fr/favicon.ico': ico()
    }, 'https://app.exemple.fr/inbox')
    expect(delivered[0]?.icon).toBe('https://app.exemple.fr/favicon.ico')
    expect(web.urls()).not.toContain('https://connexion.autre.example/leur-logo.png')
  })

  it('follows the redirects of an icon, and keeps the address the page declared', async () => {
    const { delivered } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/logo">'), 'https://exemple.fr/logo': redirect('https://cdn.exemple.fr/logo.png'), 'https://cdn.exemple.fr/logo.png': png() })
    expect(delivered[0]?.icon).toBe('https://exemple.fr/logo')
  })

  it('accepts an icon on another host, as the page itself would load it', async () => {
    const { delivered } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="https://cdn.autre.example/i.png">'), 'https://cdn.autre.example/i.png': png() })
    expect(delivered[0]?.icon).toBe('https://cdn.autre.example/i.png')
  })
})

describe('what a request may be', () => {
  it('sends nothing but an Accept header: no cookie, no Referer, no authorization, no extra request option', async () => {
    const { web } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': png() })
    expect(web.calls.length).toBe(2)
    for (const { init } of web.calls) {
      expect(Object.keys(init).sort()).toEqual(['headers', 'signal'])
      expect(Object.keys(init.headers)).toEqual(['accept'])
    }
  })

  it('never goes to this machine or to the local network: no request for a loopback, private, link-local, .local or bare-name host, nor for a non-web address', async () => {
    const web = fakeWeb({})
    const run = resolverFor(web)
    const hosts = ['http://127.0.0.1/', 'http://127.0.0.1:3000/app', 'http://localhost:8080/', 'http://10.1.2.3/', 'http://172.20.0.5/', 'http://192.168.1.10/admin', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://imprimante.local/', 'http://nas/', 'http://wiki.corp/', 'http://2130706433/', 'http://0x7f.1/']
    const notWeb = ['file:///etc/passwd', 'about:blank', 'data:text/html,x', 'javascript:1', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'ftp://exemple.fr/', 'https://moi:secret@exemple.fr/', 'x', '']
    run.resolver.enqueue([...hosts, ...notWeb].map((url, i) => job(`tab:${i}`, url)))
    await run.resolver.idle()
    expect(web.calls).toEqual([])
    expect(run.resolver.stats()).toMatchObject({ attempted: 0, requests: 0 })
  })

  it('goes to a local host only when the engine test names it, exactly (host and port)', async () => {
    const web = fakeWeb({ 'http://127.0.0.1:4000/': html(''), 'http://127.0.0.1:4000/favicon.ico': ico(), 'http://127.0.0.1:4001/': html(''), 'http://127.0.0.1:4001/favicon.ico': ico() })
    const run = resolverFor(web, { allowHost: (host) => host === '127.0.0.1:4000' })
    run.resolver.enqueue([job('favorite:a', 'http://127.0.0.1:4000/x'), job('favorite:b', 'http://127.0.0.1:4001/x')])
    await run.resolver.idle()
    expect(run.delivered.map((d) => d.origin)).toEqual(['http://127.0.0.1:4000'])
    expect(web.urls().every((u) => u.startsWith('http://127.0.0.1:4000/'))).toBe(true)
  })

  it('refuses a redirect from https to http, and does not send the request', async () => {
    const { delivered, web, resolver } = await lookupOne({ 'https://exemple.fr/': redirect('http://exemple.fr/'), 'http://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'http://exemple.fr/favicon.ico': ico() })
    expect(delivered).toEqual([])
    expect(web.urls()).toEqual(['https://exemple.fr/'])
    expect(resolver.stats().reasons.refused).toBe(1)
  })

  it('refuses a downgrade in the middle of a chain, and the redirect of an icon to http', async () => {
    const chain = await lookupOne({ 'https://exemple.fr/': redirect('https://www.exemple.fr/'), 'https://www.exemple.fr/': redirect('http://www.exemple.fr/'), 'http://www.exemple.fr/': html('') })
    expect(chain.web.urls()).toEqual(['https://exemple.fr/', 'https://www.exemple.fr/'])
    const icon = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': redirect('http://exemple.fr/i.png'), 'http://exemple.fr/i.png': png(), 'https://exemple.fr/favicon.ico': ico() })
    expect(icon.web.urls()).not.toContain('http://exemple.fr/i.png')
    expect(icon.delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
  })

  it('lets an http site use http, and go to https', async () => {
    const http = await lookupOne({ 'http://vieux.example/': html('<link rel="icon" href="/i.png">'), 'http://vieux.example/i.png': png() }, 'http://vieux.example/page')
    expect(http.delivered[0]?.icon).toBe('http://vieux.example/i.png')
    const up = await lookupOne({ 'http://vieux.example/': redirect('https://vieux.example/'), 'https://vieux.example/': html('<link rel="icon" href="/i.png">'), 'https://vieux.example/i.png': png() }, 'http://vieux.example/page')
    expect(up.delivered[0]?.icon).toBe('https://vieux.example/i.png')
  })

  it('refuses a redirect to this machine, to the local network or to an address with a login, at any step', async () => {
    for (const target of ['http://127.0.0.1/', 'https://127.0.0.1:8443/', 'https://192.168.0.1/', 'https://10.0.0.5/x', 'https://localhost/', 'https://nas.local/', 'https://[::1]/', 'https://moi:secret@exemple.fr/', 'file:///etc/passwd', 'ftp://exemple.fr/', 'javascript:1']) {
      const home = await lookupOne({ 'https://exemple.fr/': redirect(target) })
      expect(home.web.urls(), target).toEqual(['https://exemple.fr/'])
      expect(home.resolver.stats().reasons.refused, target).toBe(1)
      const icon = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': redirect(target), 'https://exemple.fr/favicon.ico': redirect(target) })
      expect(icon.web.urls().filter((u) => u !== 'https://exemple.fr/' && !u.startsWith('https://exemple.fr/')), target).toEqual([])
    }
  })

  it('does not ask for an icon on a local host that the page declares', async () => {
    const { web, delivered } = await lookupOne({
      'https://exemple.fr/': html('<link rel="icon" href="https://192.168.1.1/admin/logo.png"><link rel="icon" href="https://localhost:9000/x.png"><link rel="icon" href="https://box.local/x.png"><link rel="icon" href="/ok.png">'),
      'https://exemple.fr/ok.png': png()
    })
    expect(delivered[0]?.icon).toBe('https://exemple.fr/ok.png')
    expect(web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/ok.png'])
  })

  it('gives up after four redirects, and on a redirect with no destination', async () => {
    const hops = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i): [string, Reply] => [i === 0 ? 'https://exemple.fr/' : `https://exemple.fr/h${i}`, redirect(`/h${i + 1}`)]))
    const four = await lookupOne({ ...hops(4), 'https://exemple.fr/h4': html(''), 'https://exemple.fr/favicon.ico': ico() })
    expect(four.delivered).toHaveLength(1)
    const five = await lookupOne({ ...hops(5), 'https://exemple.fr/h5': html(''), 'https://exemple.fr/favicon.ico': ico() })
    expect(five.delivered).toEqual([])
    expect(five.resolver.stats().reasons.refused).toBe(1)
    const none = await lookupOne({ 'https://exemple.fr/': { status: 302 } })
    expect(none.resolver.stats().reasons.refused).toBe(1)
    const loop = await lookupOne({ 'https://exemple.fr/': redirect('/') })
    expect(loop.web.urls().length).toBeLessThanOrEqual(5)
  })

  it('refuses a redirect to an address too long to store', async () => {
    const target = `https://cdn.exemple.fr/${'a'.repeat(2100)}`
    const { delivered, web } = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': redirect(target), [target]: png() })
    expect(delivered).toEqual([])
    expect(web.urls()).not.toContain(target)
  })

  it('does not ask the blocker about the home page, and drops the icons it would cancel in a page', async () => {
    const asked: string[] = []
    const { delivered, web } = await lookupOne(
      {
        'https://exemple.fr/': html('<link rel="icon" sizes="32x32" href="https://pistage.example/pixel.png"><link rel="icon" sizes="16x16" href="/ok.png">'),
        'https://pistage.example/pixel.png': png(),
        'https://exemple.fr/ok.png': png()
      },
      'https://exemple.fr/',
      { blocked: (icon, page) => (asked.push(`${icon} < ${page}`), icon.includes('pistage')) }
    )
    expect(delivered[0]?.icon).toBe('https://exemple.fr/ok.png')
    expect(web.urls()).not.toContain('https://pistage.example/pixel.png')
    expect(asked).toEqual(['https://pistage.example/pixel.png < https://exemple.fr/', 'https://exemple.fr/ok.png < https://exemple.fr/'])
  })
})

describe('time', () => {
  it('gives up on a request that takes longer than the delay, counts the site as slow, and does not try the others', async () => {
    const { delivered, web, resolver } = await lookupOne({ 'https://exemple.fr/': { hang: true } }, 'https://exemple.fr/', {}, { timeoutMs: 30 })
    expect(delivered).toEqual([])
    expect(web.urls()).toEqual(['https://exemple.fr/'])
    expect(resolver.stats().reasons.timeout).toBe(1)
  })

  it('cuts a site that is slow request after request at its total time', async () => {
    const started = Date.now()
    const { delivered, resolver } = await lookupOne(
      { 'https://exemple.fr/': html('<link rel="icon" href="/a.png"><link rel="icon" href="/b.png"><link rel="icon" href="/c.png">'), 'https://exemple.fr/a.png': { hang: true }, 'https://exemple.fr/b.png': { hang: true }, 'https://exemple.fr/c.png': { hang: true } },
      'https://exemple.fr/',
      {},
      { timeoutMs: 200, budgetMs: 250 }
    )
    expect(delivered).toEqual([])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(resolver.stats().reasons.timeout).toBe(1)
  })

  it('a site that cannot be reached is a failure of the network, not a refusal', async () => {
    const web = fakeWeb({})
    const refusing: FetchLike = () => Promise.reject(new TypeError('net::ERR_CONNECTION_REFUSED'))
    const run = resolverFor({ fetch: refusing })
    run.resolver.enqueue([job('favorite:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    expect(run.resolver.stats().reasons).toEqual({ refused: 0, timeout: 0, network: 1, 'no-icon': 0 })
    expect(web.calls).toEqual([])
  })
})

describe('the queue', () => {
  /** `count` sites, each with an empty home page and a /favicon.ico. */
  const sites = (count: number): Record<string, Reply> => {
    const out: Record<string, Reply> = {}
    for (let i = 0; i < count; i++) {
      out[`https://site${i}.example/`] = html('')
      out[`https://site${i}.example/favicon.ico`] = ico()
    }
    return out
  }
  const jobsFor = (count: number): IconJob[] => Array.from({ length: count }, (_, i) => job(`tab:${i}`, `https://site${i}.example/page`, 2))

  it('looks up three sites at a time, no more', async () => {
    const web = fakeWeb(sites(12))
    const run = resolverFor(web)
    run.resolver.enqueue(jobsFor(12))
    await run.resolver.idle()
    expect(run.delivered).toHaveLength(12)
    expect(web.peak()).toBe(3)
  })

  it('starts the favourites before the pinned tabs, and these before Today, whatever the order they were given in', async () => {
    const web = fakeWeb(sites(6))
    const run = resolverFor(web, {}, { concurrency: 1 })
    run.resolver.enqueue([job('tab:5', 'https://site5.example/', 2), job('tab:4', 'https://site4.example/', 2), job('tab:3', 'https://site3.example/', 1), job('favorite:2', 'https://site2.example/', 0), job('tab:1', 'https://site1.example/', 1), job('favorite:0', 'https://site0.example/', 0)])
    await run.resolver.idle()
    const order = web.urls().filter((u) => u.endsWith('/')).map((u) => u.slice('https://site'.length, -'.example/'.length))
    expect(order).toEqual(['2', '0', '3', '1', '5', '4'])
  })

  it('moves a site up when a more urgent item for it comes in while it waits', async () => {
    const web = fakeWeb(sites(4))
    const run = resolverFor(web, {}, { concurrency: 1 })
    run.resolver.enqueue([job('tab:0', 'https://site0.example/', 2), job('tab:1', 'https://site1.example/', 2), job('tab:2', 'https://site2.example/', 2), job('tab:3', 'https://site3.example/', 2)])
    run.resolver.enqueue([job('favorite:3', 'https://site3.example/', 0)])
    await run.resolver.idle()
    const order = web.urls().filter((u) => u.endsWith('/')).map((u) => u.slice('https://site'.length, -'.example/'.length))
    // site0 had already started when the favourite came in; site3 then goes before the rest.
    expect(order).toEqual(['0', '3', '1', '2'])
    expect(run.delivered.find((d) => d.origin === 'https://site3.example')?.ids.sort()).toEqual(['favorite:3', 'tab:3'])
  })

  it('asks a site once for all the items that stand on it, and hands the icon to each of them', async () => {
    const web = fakeWeb({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': png() })
    const run = resolverFor(web)
    run.resolver.enqueue([job('tab:1', 'https://exemple.fr/a'), job('tab:2', 'https://exemple.fr/b?c=1'), job('favorite:3', 'https://exemple.fr/'), job('tab:4', 'https://exemple.fr:8443/autre')])
    await run.resolver.idle()
    const mine = run.delivered.find((d) => d.origin === 'https://exemple.fr')
    expect(mine?.ids.sort()).toEqual(['favorite:3', 'tab:1', 'tab:2'])
    // Another port is another site.
    expect(web.urls().filter((u) => u === 'https://exemple.fr/')).toHaveLength(1)
    expect(web.urls().some((u) => u.startsWith('https://exemple.fr:8443/'))).toBe(true)
  })

  it('hands an item that comes in while its site is being looked up the icon when it is found', async () => {
    const web = fakeWeb({ 'https://exemple.fr/': html('<link rel="icon" href="/i.png">'), 'https://exemple.fr/i.png': png() })
    const run = resolverFor(web)
    run.resolver.enqueue([job('tab:1', 'https://exemple.fr/a')])
    run.resolver.enqueue([job('tab:2', 'https://exemple.fr/b')])
    await run.resolver.idle()
    expect(run.delivered.flatMap((d) => d.ids).sort()).toEqual(['tab:1', 'tab:2'])
    expect(web.urls()).toHaveLength(2)
  })

  it('asks a site once per session: a site found answers from memory, a site that failed is not asked again', async () => {
    const web = fakeWeb({ 'https://trouve.example/': html(''), 'https://trouve.example/favicon.ico': ico() })
    const run = resolverFor(web)
    run.resolver.enqueue([job('tab:1', 'https://trouve.example/a'), job('tab:2', 'https://absent.example/a')])
    await run.resolver.idle()
    const before = web.urls().length
    run.resolver.enqueue([job('tab:3', 'https://trouve.example/b'), job('tab:4', 'https://absent.example/b')])
    await run.resolver.idle()
    expect(web.urls()).toHaveLength(before)
    expect(run.delivered.at(-1)).toEqual({ ids: ['tab:3'], origin: 'https://trouve.example', icon: 'https://trouve.example/favicon.ico' })
    expect(run.resolver.known('https://trouve.example/zzz')).toBe('https://trouve.example/favicon.ico')
    expect(run.resolver.known('https://absent.example/')).toBeUndefined()
  })

  it('asks a site that failed again after 24 hours, and not before', async () => {
    let now = 1_000_000
    const sitesNow: Record<string, Reply> = {}
    const web = fakeWeb(sitesNow)
    const run = resolverFor(web, { now: () => now })
    run.resolver.enqueue([job('tab:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    const first = web.urls().length
    Object.assign(sitesNow, { 'https://exemple.fr/': html(''), 'https://exemple.fr/favicon.ico': ico() })
    now += 24 * 3_600_000 - 1
    run.resolver.enqueue([job('tab:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    expect(web.urls()).toHaveLength(first)
    now += 1
    run.resolver.enqueue([job('tab:1', 'https://exemple.fr/')])
    await run.resolver.idle()
    expect(run.delivered).toEqual([{ ids: ['tab:1'], origin: 'https://exemple.fr', icon: 'https://exemple.fr/favicon.ico' }])
    expect(run.resolver.stats().attempted).toBe(1)
  })

  it('asks no more than a set number of sites in a session', async () => {
    const web = fakeWeb(sites(12))
    const run = resolverFor(web, {}, { hosts: 5 })
    run.resolver.enqueue(jobsFor(12))
    await run.resolver.idle()
    expect(run.resolver.stats().attempted).toBe(5)
    expect(run.delivered).toHaveLength(5)
    // The sites found stay served from memory once the cap is reached.
    run.resolver.enqueue([job('tab:x', 'https://site0.example/zzz')])
    expect(run.delivered.at(-1)?.ids).toEqual(['tab:x'])
    run.resolver.enqueue([job('tab:y', 'https://site9.example/zzz')])
    await run.resolver.idle()
    expect(run.resolver.stats().attempted).toBe(5)
  })

  it('does nothing while the setting is off: no request, nothing kept to do later', async () => {
    const web = fakeWeb(sites(3))
    const run = resolverFor(web)
    run.setEnabled(false)
    run.resolver.enqueue(jobsFor(3))
    await run.resolver.idle()
    expect(web.calls).toEqual([])
    run.setEnabled(true)
    await run.resolver.idle()
    expect(web.calls).toEqual([])
  })

  it('does not hand out what it knows while the setting is off', async () => {
    const web = fakeWeb(sites(1))
    const run = resolverFor(web)
    run.resolver.enqueue([job('tab:1', 'https://site0.example/a')])
    await run.resolver.idle()
    expect(run.delivered).toHaveLength(1)
    run.setEnabled(false)
    run.resolver.enqueue([job('tab:2', 'https://site0.example/b')])
    expect(run.delivered).toHaveLength(1)
  })

  it('delivers nothing from a lookup that ends after the setting was turned off, or after stop()', async () => {
    for (const end of ['setting', 'stop'] as const) {
      const web = fakeWeb({ ...sites(1), 'https://site0.example/': { ...html(''), delay: 60 } })
      const run = resolverFor(web)
      run.resolver.enqueue([job('tab:1', 'https://site0.example/a')])
      await new Promise((resolve) => setTimeout(resolve, 15))
      if (end === 'setting') run.setEnabled(false)
      else run.resolver.stop()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(run.delivered, end).toEqual([])
      expect(run.resolver.stats().active, end).toBe(0)
    }
  })

  it('stops what waits when the setting is turned off, and delivers nothing from a lookup that was under way', async () => {
    const web = fakeWeb({ ...sites(6), 'https://site0.example/': { hang: true } })
    const run = resolverFor(web, {}, { concurrency: 1, timeoutMs: 100 })
    run.resolver.enqueue(jobsFor(6))
    await new Promise((resolve) => setTimeout(resolve, 10))
    run.setEnabled(false)
    await run.resolver.idle()
    expect(web.urls()).toEqual(['https://site0.example/'])
    expect(run.delivered).toEqual([])
  })

  it('stop() cuts what is under way and starts nothing again', async () => {
    const web = fakeWeb({ ...sites(3), 'https://site0.example/': { hang: true } })
    const run = resolverFor(web, {}, { concurrency: 1 })
    run.resolver.enqueue(jobsFor(3))
    await new Promise((resolve) => setTimeout(resolve, 10))
    run.resolver.stop()
    await run.resolver.idle()
    expect(web.urls()).toEqual(['https://site0.example/'])
    run.resolver.enqueue(jobsFor(3))
    expect(web.urls()).toHaveLength(1)
    expect(run.delivered).toEqual([])
  })

  it('clear() forgets what waits and leaves what runs', async () => {
    const web = fakeWeb(sites(5))
    const run = resolverFor(web, {}, { concurrency: 1 })
    run.resolver.enqueue(jobsFor(5))
    run.resolver.clear()
    await run.resolver.idle()
    expect(web.urls().filter((u) => u.endsWith('/'))).toEqual(['https://site0.example/'])
  })
})

// The interface draws the copy the main process keeps of an icon. The bytes the lookup read to check the icon are that copy: without them
// the icon would be asked a second time, by the session of the profile, a moment after the lookup found it.
describe('the bytes of the icon that was found', () => {
  const sites = { 'https://exemple.fr/': html('<link rel="icon" href="/img/logo.png" type="image/png">'), 'https://exemple.fr/img/logo.png': png() }

  it('are handed over with the address and the type the site gave, before the icon is delivered', async () => {
    const order: string[] = []
    const kept: Array<{ icon: string; bytes: number[]; type: string | null }> = []
    const web = fakeWeb(sites)
    const resolver = new FaviconResolver({
      fetch: web.fetch,
      enabled: () => true,
      deliver: (_ids, _origin, icon) => void order.push(`deliver ${icon}`),
      keep: (icon, bytes, type) => {
        order.push(`keep ${icon}`)
        kept.push({ icon, bytes: [...bytes], type })
      }
    })
    resolver.enqueue([job('favorite:1', 'https://exemple.fr/page')])
    await resolver.idle()
    expect(order).toEqual(['keep https://exemple.fr/img/logo.png', 'deliver https://exemple.fr/img/logo.png'])
    expect(kept).toEqual([{ icon: 'https://exemple.fr/img/logo.png', bytes: [...PNG], type: 'image/png' }])
    // One request for the page and one for the icon: nothing more.
    expect(web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/img/logo.png'])
  })

  it('are not handed over for an address that gave no icon', async () => {
    const kept: string[] = []
    const found = await lookupOne({ 'https://exemple.fr/': html('<link rel="icon" href="/a.png">'), 'https://exemple.fr/a.png': { type: 'text/html', body: '<html>introuvable</html>' }, 'https://exemple.fr/favicon.ico': ico() }, undefined, { keep: (icon) => void kept.push(icon) })
    expect(kept).toEqual(['https://exemple.fr/favicon.ico'])
    expect(found.delivered[0]?.icon).toBe('https://exemple.fr/favicon.ico')
  })

  it('a keeper that fails is a failure of the lookup, counted as one: the icon is not delivered, and the next address is not tried in its place', async () => {
    const found = await lookupOne({ ...sites, 'https://exemple.fr/favicon.ico': ico() }, undefined, {
      keep: () => {
        throw new Error('no room')
      }
    })
    expect(found.delivered).toEqual([])
    expect(found.web.urls()).toEqual(['https://exemple.fr/', 'https://exemple.fr/img/logo.png'])
    expect(found.resolver.stats()).toMatchObject({ found: 0, failed: 1, reasons: { network: 1 } })
  })
})

