import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_BODY_MAX, LIVE_REDIRECTS_MAX, type LiveSource } from '@shared/live-folders'
import { decodeBody, lookAt } from './live-fetch'
import type { FetchLike } from './favicon-resolver'

const FEED: LiveSource = { kind: 'feed', url: 'https://blog.example/feed.xml' }
const REPO: LiveSource = { kind: 'github', repo: 'owner/repo', what: 'releases' }
const NOW = Date.parse('2026-10-24T12:00:00Z')
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><item><title>Un</title><link>https://blog.example/1</link></item></channel></rss>'
const RELEASES = JSON.stringify([{ name: 'v2', html_url: 'https://github.com/owner/repo/releases/tag/v2', published_at: '2026-10-20T00:00:00Z' }])

type Answer = { status?: number; body?: string | Uint8Array | ReadableStream<Uint8Array>; headers?: Record<string, string> }
/** A network that answers by address, and remembers what it was asked. */
function network(answers: Record<string, Answer | Error>, fallback: Answer | Error = { status: 404 }) {
  const asked: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchLike: FetchLike = async (url, init) => {
    asked.push({ url, headers: init.headers })
    const answer = answers[url] ?? fallback
    if (answer instanceof Error) throw answer
    return new Response((answer.body ?? '') as BodyInit, { status: answer.status ?? 200, headers: answer.headers })
  }
  return { fetchLike, asked }
}
const redirect = (to: string, status = 302): Answer => ({ status, headers: { location: to } })

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('a look at a feed', () => {
  it('asks for the address with no cookie, no login and no referrer, and reads the items and the title', async () => {
    const net = network({ [FEED.url]: { body: RSS, headers: { 'content-type': 'application/rss+xml' } } })
    const out = await lookAt(net.fetchLike, FEED, { now: () => NOW })
    expect(out).toEqual({ ok: true, title: 'Blog', items: [{ title: 'Un', url: 'https://blog.example/1' }] })
    expect(net.asked).toHaveLength(1)
    const names = Object.keys(net.asked[0]!.headers).map((h) => h.toLowerCase())
    expect(names).toEqual(['accept'])
  })

  it('follows a few redirects, resolving a relative one, and reads relative links against the final address', async () => {
    const net = network({ [FEED.url]: redirect('/nouveau/flux.xml', 301), 'https://blog.example/nouveau/flux.xml': { body: RSS.replace('https://blog.example/1', '/billet/1') } })
    const out = await lookAt(net.fetchLike, FEED, { now: () => NOW })
    expect(out.ok && out.items[0]!.url).toBe('https://blog.example/billet/1')
  })

  it('refuses a redirect to the local network, to another scheme, from https to http, and after too many', async () => {
    const targets = ['http://127.0.0.1:8080/x', 'http://localhost/x', 'https://192.168.1.10/x', 'https://[::1]/x', 'file:///etc/passwd', 'ftp://blog.example/x', 'https://user:pass@blog.example/x', 'http://blog.example/clair']
    for (const target of targets) {
      const net = network({ [FEED.url]: redirect(target) })
      const out = await lookAt(net.fetchLike, FEED, { now: () => NOW })
      expect(out.ok, target).toBe(false)
      expect(net.asked.map((a) => a.url), target).toEqual([FEED.url])
    }
    const loop = network({}, redirect(FEED.url))
    const out = await lookAt(loop.fetchLike, FEED)
    expect(out).toEqual({ ok: false, error: 'Trop de redirections.' })
    expect(loop.asked).toHaveLength(LIVE_REDIRECTS_MAX + 1)
  })

  it('does not ask the local network at all, unless the test says that host may be asked', async () => {
    for (const url of ['http://localhost:8123/feed', 'http://127.0.0.1/feed', 'http://192.168.0.5/feed', 'http://10.0.0.1/feed', 'https://intranet/feed', 'http://[::1]/feed', 'https://user:pass@blog.example/feed']) {
      const net = network({ [url]: { body: RSS } })
      const out = await lookAt(net.fetchLike, { kind: 'feed', url }, { now: () => NOW })
      expect(out, url).toMatchObject({ ok: false })
      expect(net.asked, url).toEqual([])
    }
    const net = network({ 'http://localhost:8123/feed': { body: RSS } })
    expect((await lookAt(net.fetchLike, { kind: 'feed', url: 'http://localhost:8123/feed' }, { allowHost: (host) => host === 'localhost:8123', now: () => NOW })).ok).toBe(true)
  })

  it('says why in French for a status, a rate limit, a page that is no feed, and a server that is down', async () => {
    const say = async (answer: Answer | Error, source: LiveSource = FEED) => {
      const out = await lookAt(network({}, answer).fetchLike, source, { now: () => NOW })
      return out.ok ? 'ok' : out.error
    }
    expect(await say({ status: 404 })).toContain('introuvable')
    expect(await say({ status: 410 })).toContain('n’existe plus')
    expect(await say({ status: 500 })).toBe('Le serveur a répondu HTTP 500.')
    expect(await say({ status: 403 })).toContain('Accès refusé')
    expect(await say({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }, REPO)).toContain('Limite de requêtes de GitHub')
    expect(await say({ status: 404 }, REPO)).toContain('Dépôt introuvable')
    expect(await say({ body: '<html><body>Bonjour</body></html>', headers: { 'content-type': 'text/html' } })).toContain('n’est pas un flux')
    expect(await say(new Error('getaddrinfo ENOTFOUND blog.example'))).toBe('Le serveur ne répond pas.')
    expect(console.warn).toHaveBeenCalledWith('[live-folders] a look failed:', expect.stringContaining('ENOTFOUND'))
  })

  it('accepts a feed with no item, and a feed in another charset', async () => {
    const empty = await lookAt(network({ [FEED.url]: { body: '<rss version="2.0"><channel><title>Vide</title></channel></rss>' } }).fetchLike, FEED, { now: () => NOW })
    expect(empty).toEqual({ ok: true, title: 'Vide', items: [] })
    const latin1 = Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Été à Paris</title><link>https://blog.example/ete</link></item></channel></rss>', 'latin1'))
    const out = await lookAt(network({ [FEED.url]: { body: latin1 } }).fetchLike, FEED, { now: () => NOW })
    expect(out.ok && out.items[0]!.title).toBe('Été à Paris')
    expect(decodeBody(Uint8Array.from(Buffer.from('é', 'latin1')), 'text/xml; charset=iso-8859-1')).toBe('é')
    expect(decodeBody(Uint8Array.from(Buffer.from('é')), 'text/xml; charset=pas-un-jeu')).toBe('é')
  })
})

describe('the bounds of a look', () => {
  it('refuses an answer that says it is too big, and one that turns out to be, without reading the rest', async () => {
    const declared = await lookAt(network({ [FEED.url]: { body: RSS, headers: { 'content-length': String(LIVE_BODY_MAX + 1) } } }).fetchLike, FEED)
    expect(declared).toEqual({ ok: false, error: 'Réponse trop volumineuse.' })
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20))
      }
    })
    const streamed = await lookAt(network({ [FEED.url]: { body: endless } }).fetchLike, FEED)
    expect(streamed).toEqual({ ok: false, error: 'Réponse trop volumineuse.' })
    expect(pulled).toBeLessThanOrEqual(LIVE_BODY_MAX + 4 * 64 * 1024)
    const small = await lookAt(network({ [FEED.url]: { body: RSS } }).fetchLike, FEED, { bodyMax: 20 })
    expect(small).toEqual({ ok: false, error: 'Réponse trop volumineuse.' })
  })

  it('gives up on a server that does not answer, and on a look that is cancelled', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await lookAt(hang, FEED, { timeoutMs: 20 })).toEqual({ ok: false, error: 'Le serveur n’a pas répondu à temps.' })
    const controller = new AbortController()
    const pending = lookAt(hang, FEED, { timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'Lecture annulée.' })
  })
})

describe('a look at a GitHub repository', () => {
  it('asks the public API of that repository only, with no login, and keeps the addresses on the repository', async () => {
    const url = 'https://api.github.com/repos/owner/repo/releases?per_page=15'
    const net = network({ [url]: { body: RELEASES } })
    const out = await lookAt(net.fetchLike, REPO, { now: () => NOW })
    expect(out).toEqual({ ok: true, title: '', items: [{ title: 'v2', url: 'https://github.com/owner/repo/releases/tag/v2', at: Date.parse('2026-10-20T00:00:00Z') }] })
    expect(net.asked.map((a) => a.url)).toEqual([url])
    expect(Object.keys(net.asked[0]!.headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'x-github-api-version'])
  })

  it('follows a redirect inside the API (a renamed repository) and refuses one that leaves it', async () => {
    const url = 'https://api.github.com/repos/owner/repo/releases?per_page=15'
    const inside = network({ [url]: redirect('https://api.github.com/repositories/42/releases?per_page=15', 301), 'https://api.github.com/repositories/42/releases?per_page=15': { body: RELEASES } })
    expect((await lookAt(inside.fetchLike, REPO, { now: () => NOW })).ok).toBe(true)
    for (const target of ['https://evil.example/x', 'https://github.com/owner/repo', 'http://api.github.com/x']) {
      const net = network({ [url]: redirect(target), [target]: { body: RELEASES } })
      const out = await lookAt(net.fetchLike, REPO, { now: () => NOW })
      expect(out.ok, target).toBe(false)
      expect(net.asked.map((a) => a.url), target).toEqual([url])
    }
  })

  it('does not let the test host list open the API to another host', async () => {
    const url = 'https://api.github.com/repos/owner/repo/releases?per_page=15'
    const net = network({ [url]: redirect('http://localhost:8123/feed') })
    const out = await lookAt(net.fetchLike, REPO, { allowHost: () => true })
    expect(out.ok).toBe(false)
    expect(net.asked.map((a) => a.url)).toEqual([url])
  })
})
