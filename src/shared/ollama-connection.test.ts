// The connection test of Ollama goes out by the fetcher it is given (Electron's net.fetch in the application), never by the global fetch of
// Node, and only to an address of this Mac.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOllamaModels, OllamaNameRefused, resolveOllamaModel, testOllamaConnection } from './ollama'

afterEach(() => vi.restoreAllMocks())

const tags = () => new Response(JSON.stringify({ models: [{ name: 'mistral:latest' }] }), { status: 200 })

describe('the connection test of Ollama', () => {
  it('asks the address it is given through the fetcher it is given, and lists the models', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const fetcher = vi.fn(async () => tags())
    const result = await testOllamaConnection('http://127.0.0.1:11434/', fetcher)
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.anything())
    expect(globalFetch).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, models: ['mistral'] })
  })

  it('reports an error when the fetcher fails', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('refused')
    })
    expect(await testOllamaConnection('http://localhost:11434', fetcher)).toEqual({ ok: false, error: 'refused' })
  })
})

// Even called directly, with no check before it, no function of the file asks a public host or a name of the internet anything.
describe('a public host', () => {
  const REMOTE = ['http://8.8.8.8:11434', 'https://ollama.exemple.fr', 'http://localhost.evil.com:11434', 'http://box.lan:11434']

  it('is not asked for a connection test, a list of models or the model of a summary: the failure is said, and no request leaves', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const fetcher = vi.fn(async () => tags())
    for (const url of REMOTE) {
      expect(await testOllamaConnection(url, fetcher), url).toMatchObject({ ok: false, error: expect.stringContaining('neither one of this Mac nor one of the local network') })
      expect(await listOllamaModels(url, fetcher), url).toMatchObject({ ok: false, error: expect.stringContaining('neither one of this Mac nor one of the local network') })
      expect(await resolveOllamaModel(url, 'mistral', fetcher), url).toEqual({ ok: false, reason: 'unreachable' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })
})

// A computer of the local network is asked like this Mac, at its private address and nowhere else.
describe('a computer of the local network', () => {
  it('is asked for its models at the address given', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => tags())
    expect(await testOllamaConnection('http://192.168.1.50:11434', fetcher)).toMatchObject({ ok: true })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://192.168.1.50:11434/api/tags'])
    // A redirect would send the page text where the user did not say: it is an error there too.
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe('error')
  })
})

// A .local name is asked through the fetcher, which resolves it (main/shell/ollama-fetch.ts). A name that leads to a public address is not a
// server that is down: each function says so in its own way, and none takes it for silence.
describe('a .local name that does not lead to a private address', () => {
  const refusing = () =>
    vi.fn(async (): Promise<Response> => {
      throw new OllamaNameRefused('the name leads elsewhere')
    })

  it('is told apart from a server that does not answer when the model of a summary is looked for', async () => {
    expect(await resolveOllamaModel('http://mon-mac.local:11434', 'mistral', refusing())).toEqual({ ok: false, reason: 'refused' })
    const down = vi.fn(async (): Promise<Response> => {
      throw new Error('ECONNREFUSED')
    })
    expect(await resolveOllamaModel('http://mon-mac.local:11434', 'mistral', down)).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('gives its sentence to the connection test and to the list of models', async () => {
    expect(await testOllamaConnection('http://mon-mac.local:11434', refusing())).toEqual({ ok: false, error: 'the name leads elsewhere' })
    expect(await listOllamaModels('http://mon-mac.local:11434', refusing())).toEqual({ ok: false, error: 'the name leads elsewhere' })
  })
})

// A program answering on the port could answer with a redirect to another computer: it is an error, never followed.
describe('a redirect', () => {
  it('is refused by every request to Ollama', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => tags())
    await testOllamaConnection('http://localhost:11434', fetcher)
    await listOllamaModels('http://localhost:11434', fetcher)
    await resolveOllamaModel('http://localhost:11434', 'mistral', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const [, init] of fetcher.mock.calls) expect(init?.redirect).toBe('error')
  })
})
