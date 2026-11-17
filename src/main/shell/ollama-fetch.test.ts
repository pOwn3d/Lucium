// The way out of a request of the page summary: Electron's net.fetch for Ollama on this Mac, a session that is told to use no proxy for
// Ollama on a computer of the local network, and nothing at all when that session cannot be told. A computer named by a `.local` name is
// asked at the private address its name leads to when the request leaves, and not at all when the name leads to no private address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { OllamaNameRefused } from '@shared/ollama'

const electron = vi.hoisted(() => ({ net: vi.fn(), direct: vi.fn(), setProxy: vi.fn(), partitions: [] as string[] }))
vi.mock('electron', () => ({
  net: { fetch: electron.net },
  session: { fromPartition: (name: string) => (electron.partitions.push(name), { setProxy: electron.setProxy, fetch: electron.direct }) }
}))

// The resolver of the system (getaddrinfo, which answers for the `.local` names too).
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))

const NETWORK = 'http://192.168.1.20:11434/api/tags'
// The module under test is loaded anew for each test, and its classes with it: the refusal is told by its name.
const REFUSED = new OllamaNameRefused('').name
const NAMED = 'http://mon-mac.local:11434/api/generate'
const answers = (...addresses: string[]) => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

/** The module anew: it keeps the session it made. */
async function fresh() {
  vi.resetModules()
  return import('./ollama-fetch')
}

beforeEach(() => {
  electron.partitions.length = 0
  electron.net.mockReset().mockImplementation(async () => new Response('local'))
  electron.direct.mockReset().mockImplementation(async () => new Response('network'))
  electron.setProxy.mockReset().mockImplementation(async () => undefined)
  dns.lookup.mockReset().mockImplementation(async () => answers('192.168.1.77'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a request to Ollama on this Mac', () => {
  it('leaves by net.fetch, without the cookies of the session, and makes no session', async () => {
    const { ollamaFetch } = await fresh()
    for (const url of ['http://localhost:11434/api/tags', 'http://127.0.0.1:11434/api/generate', 'http://[::1]:11434/api/tags']) expect(await (await ollamaFetch(url, { redirect: 'error' })).text(), url).toBe('local')
    expect(electron.net).toHaveBeenCalledTimes(3)
    expect(dns.lookup).not.toHaveBeenCalled()
    for (const [, init] of electron.net.mock.calls as Array<[string, RequestInit]>) expect(init).toEqual({ redirect: 'error', credentials: 'omit' })
    expect(electron.partitions).toEqual([])
    expect(electron.direct).not.toHaveBeenCalled()
  })
})

describe('a request to Ollama on a computer of the local network', () => {
  it('leaves by a session of its own, told to use no proxy before the request, and never by net.fetch', async () => {
    const { ollamaFetch, NETWORK_MODEL_PARTITION } = await fresh()
    expect(await (await ollamaFetch(NETWORK, { redirect: 'error' })).text()).toBe('network')
    expect(electron.partitions).toEqual([NETWORK_MODEL_PARTITION])
    // In memory: a partition whose name starts with `persist:` would keep a cache on the disk.
    expect(NETWORK_MODEL_PARTITION).not.toMatch(/^persist:/)
    expect(electron.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' })
    expect(electron.setProxy.mock.invocationCallOrder[0]!).toBeLessThan(electron.direct.mock.invocationCallOrder[0]!)
    expect(electron.direct).toHaveBeenCalledExactlyOnceWith(NETWORK, { redirect: 'error', credentials: 'omit' })
    expect(electron.net).not.toHaveBeenCalled()
  })

  it('makes the session once for all the requests', async () => {
    const { ollamaFetch } = await fresh()
    await ollamaFetch(NETWORK)
    await ollamaFetch('http://10.0.0.5:11434/api/generate', { method: 'POST' })
    expect(electron.partitions).toHaveLength(1)
    expect(electron.setProxy).toHaveBeenCalledTimes(1)
    expect(electron.direct).toHaveBeenCalledTimes(2)
    // An IP address is what it is: no resolver is asked.
    expect(dns.lookup).not.toHaveBeenCalled()
  })

  // Guard: the caller forgetting it changes nothing, a redirect to another computer is never followed.
  it('follows no redirect, whatever the caller asked', async () => {
    const { ollamaFetch } = await fresh()
    await ollamaFetch(NETWORK)
    await ollamaFetch(NETWORK, { redirect: 'follow' })
    await ollamaFetch(NAMED, { redirect: 'follow' })
    expect(electron.direct).toHaveBeenCalledTimes(3)
    for (const [url, init] of electron.direct.mock.calls as Array<[string, RequestInit]>) expect(init.redirect, url).toBe('error')
  })

  it('sends nothing when the session cannot be told to use no proxy: the request fails, the journal says why, and the next one tries again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ollamaFetch } = await fresh()
    electron.setProxy.mockRejectedValueOnce(new Error('proxy service gone'))
    await expect(ollamaFetch(NETWORK)).rejects.toThrow('proxy service gone')
    expect(electron.direct).not.toHaveBeenCalled()
    expect(electron.net).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledExactlyOnceWith('[ai] the session of the local network model cannot be set to use no proxy, so nothing is sent:', expect.objectContaining({ message: 'proxy service gone' }))
    expect(await (await ollamaFetch(NETWORK)).text()).toBe('network')
    expect(electron.setProxy).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})

describe('a request to a computer named by a .local name', () => {
  it('leaves for the private address the name leads to, same port and same path, by the session without a proxy', async () => {
    const { ollamaFetch } = await fresh()
    expect(await (await ollamaFetch(NAMED, { method: 'POST', body: 'texte' })).text()).toBe('network')
    expect(dns.lookup).toHaveBeenCalledExactlyOnceWith('mon-mac.local', { all: true })
    // The address that was checked, never the name: the connection cannot be made to what a second resolution would answer.
    expect(electron.direct).toHaveBeenCalledExactlyOnceWith('http://192.168.1.77:11434/api/generate', { method: 'POST', body: 'texte', credentials: 'omit', redirect: 'error' })
    expect(electron.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' })
    expect(electron.net).not.toHaveBeenCalled()
  })

  it('takes the private address among the answers: a home network also answers with a public IPv6 address and a link-local one', async () => {
    const { ollamaFetch } = await fresh()
    dns.lookup.mockResolvedValueOnce(answers('fe80::1c2d:3e4f:5a6b:7c8d%en0', '2a01:e0a:1:2::3', '10.0.0.8'))
    await ollamaFetch('https://nas.local/api/tags')
    dns.lookup.mockResolvedValueOnce(answers('2a01:e0a:1:2::3', 'FD12:3456:789A::1'))
    await ollamaFetch('http://nas.local:11434/api/tags')
    dns.lookup.mockResolvedValueOnce(answers('100.101.102.103'))
    await ollamaFetch('http://nas.local:11434/api/tags')
    expect(electron.direct.mock.calls.map(([url]) => url)).toEqual(['https://10.0.0.8/api/tags', 'http://[fd12:3456:789a::1]:11434/api/tags', 'http://100.101.102.103:11434/api/tags'])
  })

  // Guard: the name is whatever the resolver answers at that moment. An answer that changes between two requests is checked again.
  it('is resolved and checked again for each request: a name that turns public after a first answer gets nothing more', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ollamaFetch } = await fresh()
    await ollamaFetch(NAMED)
    dns.lookup.mockResolvedValueOnce(answers('203.0.113.9'))
    await expect(ollamaFetch(NAMED)).rejects.toMatchObject({ name: REFUSED })
    expect(dns.lookup).toHaveBeenCalledTimes(2)
    expect(electron.direct).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a public address', answers('203.0.113.9', '2a01:e0a:1:2::3')],
    ['this Mac', answers('127.0.0.1', '::1')],
    ['a link-local address alone', answers('169.254.10.2', 'fe80::1%en0')],
    ['every interface', answers('0.0.0.0')],
    ['a private address written inside an IPv6 one', answers('::ffff:192.168.1.50')],
    ['no address at all', answers()]
  ])('sends nothing when the name leads to %s: the request fails with the sentence for the user, and the journal names the name and the answers', async (_what, found) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ollamaFetch } = await fresh()
    dns.lookup.mockResolvedValueOnce(found)
    const failure = await ollamaFetch(NAMED).catch((reason: unknown) => reason)
    expect(failure).toMatchObject({ name: REFUSED })
    expect((failure as Error).message).toBe(t('summary.nom-sans-adresse-privee', { host: 'mon-mac.local' }))
    expect(electron.direct).not.toHaveBeenCalled()
    expect(electron.net).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    const line = String(error.mock.calls[0]![0])
    expect(line).toContain('mon-mac.local')
    for (const { address } of found) expect(line).toContain(address)
  })

  it('sends nothing when the name cannot be resolved: the failure of the resolver is passed on', async () => {
    const { ollamaFetch } = await fresh()
    dns.lookup.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND mon-mac.local'), { code: 'ENOTFOUND' }))
    await expect(ollamaFetch(NAMED)).rejects.toThrow('ENOTFOUND')
    expect(electron.direct).not.toHaveBeenCalled()
  })

  it('does not wait for ever for a name nobody answers to', async () => {
    vi.useFakeTimers()
    const { ollamaFetch, RESOLVE_TIMEOUT_MS } = await fresh()
    dns.lookup.mockImplementationOnce(() => new Promise(() => undefined))
    const asked = ollamaFetch(NAMED).catch((reason: unknown) => reason)
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS)
    expect(await asked).toMatchObject({ message: expect.stringContaining('mon-mac.local did not resolve') })
    expect(electron.direct).not.toHaveBeenCalled()
  })
})
