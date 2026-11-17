// Where a summary goes (Ollama on this Mac, or nowhere), and what the configuration of Ollama may hold.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from './model'
import { DEFAULT_OLLAMA_CONFIG, OLLAMA_TOKENS_MAX, OLLAMA_TOKENS_MIN, cleanOllamaConfig, summarizeWithOllama, summaryAvailable, summaryDestination, type SummarySettings } from './ollama'
import { LENGTH_CHARS } from './summary-prompt'

afterEach(() => vi.restoreAllMocks())

const settings = (patch: Partial<SummarySettings> & { ollama?: Partial<typeof DEFAULT_OLLAMA_CONFIG> } = {}): SummarySettings => {
  const { ollama, ...rest } = patch
  return { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, ...ollama }, ...rest }
}

describe('where a summary goes', () => {
  // Guard: a new profile offers no summary: the switch is off, and the model is not ready.
  it('nowhere on a new profile', () => {
    expect(defaultSettings().aiSummary).toBe(false)
    expect(defaultSettings().ollamaConfig.enabled).toBe(false)
    expect(summaryDestination(defaultSettings())).toEqual({ kind: 'off' })
    expect(summaryAvailable(defaultSettings())).toBe(false)
    expect(summaryAvailable({ ...defaultSettings(), aiSummary: true })).toBe(false)
  })

  it('to this Mac with Ollama on at a local address', () => {
    expect(summaryDestination(settings({ ollama: { enabled: true } }))).toEqual({ kind: 'local' })
    expect(summaryAvailable(settings({ ollama: { enabled: true } }))).toBe(true)
    expect(summaryAvailable(settings({ ollama: { enabled: true, url: 'http://127.0.0.1:8080' } }))).toBe(true)
  })

  // Guard: a public host or a name of the internet is never a place the page goes to; the menus do not offer the summary.
  it('never to a public host or to a name that is not a .local one', () => {
    for (const url of ['http://8.8.8.8:11434', 'https://ollama.exemple.fr', 'http://localhost.evil.com:11434', 'http://box.lan:11434']) {
      expect(summaryDestination(settings({ ollama: { enabled: true, url } })), url).toEqual({ kind: 'none' })
      expect(summaryAvailable(settings({ ollama: { enabled: true, url } })), url).toBe(false)
    }
  })

  // A .local name is another computer, never this Mac: the sentence of the settings and the guard of the private pages follow from it.
  it('to a computer of the local network named by a .local name or by an address of the shared range, never taken for this Mac', () => {
    expect(summaryDestination(settings({ ollama: { enabled: true, url: 'http://mon-mac.local:11434' } }))).toEqual({ kind: 'network', host: 'mon-mac.local:11434', clear: true })
    expect(summaryDestination(settings({ ollama: { enabled: true, url: 'https://100.64.0.1' } }))).toEqual({ kind: 'network', host: '100.64.0.1', clear: false })
    expect(summaryAvailable(settings({ ollama: { enabled: true, url: 'http://mon-mac.local:11434' } }))).toBe(true)
    expect(summaryAvailable(settings({ ollama: { enabled: true, url: 'http://mon-mac.local:11434' } }), true)).toBe(false)
  })

  it('to a computer of the local network with its private address, which is named, and said to be reached in clear over http', () => {
    expect(summaryDestination(settings({ ollama: { enabled: true, url: 'http://192.168.1.20:11434' } }))).toEqual({ kind: 'network', host: '192.168.1.20:11434', clear: true })
    expect(summaryDestination(settings({ ollama: { enabled: true, url: 'https://10.0.0.5' } }))).toEqual({ kind: 'network', host: '10.0.0.5', clear: false })
    expect(summaryAvailable(settings({ ollama: { enabled: true, url: 'http://192.168.1.20:11434' } }))).toBe(true)
  })

  // Guard: the text of a private page never leaves the Mac.
  it('never to another computer for a private page, which Ollama on this Mac still summarizes', () => {
    expect(summaryAvailable(settings({ ollama: { enabled: true, url: 'http://192.168.1.20:11434' } }), true)).toBe(false)
    expect(summaryAvailable(settings({ ollama: { enabled: true } }), true)).toBe(true)
  })

  it('nowhere while the summary is switched off, whatever is ready', () => {
    expect(summaryAvailable(settings({ aiSummary: false, ollama: { enabled: true } }))).toBe(false)
  })
})

describe('the configuration of a saved file', () => {
  it('bounds the numbers (a NaN or an Infinity would reach the request as null)', () => {
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, maxTokens: 1e9, temperature: -3 })).toMatchObject({ maxTokens: OLLAMA_TOKENS_MAX, temperature: 0 })
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, maxTokens: 5, temperature: 9 })).toMatchObject({ maxTokens: OLLAMA_TOKENS_MIN, temperature: 2 })
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, maxTokens: Number.NaN, temperature: Infinity })).toMatchObject({ maxTokens: DEFAULT_OLLAMA_CONFIG.maxTokens, temperature: DEFAULT_OLLAMA_CONFIG.temperature })
  })

  it('keeps an address of this Mac and its switch', () => {
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://127.0.0.1:8080' })).toMatchObject({ enabled: true, url: 'http://127.0.0.1:8080' })
    // A file from before the address existed: the switch is kept, the address is the default one.
    expect(cleanOllamaConfig({ enabled: true, model: 'phi4' })).toMatchObject({ enabled: true, url: DEFAULT_OLLAMA_CONFIG.url, model: 'phi4' })
  })

  it('keeps a private address of the local network and its switch', () => {
    const network = 'http://192.168.1.20:11434'
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: network })).toEqual({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: network })
  })

  // A file that names a public host (written by hand, or by a version that let any computer be named): its address is not kept, and Ollama is off until the user turns it on.
  it('drops the address of a public host, even one that was confirmed, and switches Ollama off', () => {
    const remote = 'https://ollama.exemple.fr'
    const cleaned = cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: remote, remoteConfirmed: remote })
    expect(cleaned).toEqual({ ...DEFAULT_OLLAMA_CONFIG, enabled: false })
    expect(Object.keys(cleaned)).not.toContain('remoteConfirmed')
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'file:///etc/passwd' })).toEqual({ ...DEFAULT_OLLAMA_CONFIG, enabled: false })
    expect(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 42 })).toEqual({ ...DEFAULT_OLLAMA_CONFIG, enabled: false })
  })

  it('leaves out the fields it does not know', () => {
    expect(Object.keys(cleanOllamaConfig({ ...DEFAULT_OLLAMA_CONFIG, autoDetect: true }))).not.toContain('autoDetect')
  })

  it('gives the defaults for anything that is not a record', () => {
    for (const bad of [null, 'x', 3, []]) expect(cleanOllamaConfig(bad)).toEqual(DEFAULT_OLLAMA_CONFIG)
  })
})

describe('the request of the summary', () => {
  const answer = () => new Response(JSON.stringify({ response: 'ok', eval_count: 1 }), { status: 200 })
  const reply = () => vi.fn(async (_url: string, _init?: RequestInit) => answer())
  const sent = (fetcher: ReturnType<typeof reply>) => fetcher.mock.calls[0]!

  it('sends the token ceiling and a temperature within bounds', async () => {
    const fetcher = reply()
    await summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, maxTokens: Number.NaN, temperature: 7 }, { content: 'texte', url: 'https://a.example/' }, fetcher)
    const body = JSON.parse(String(sent(fetcher)[1]!.body)) as { options: Record<string, unknown> }
    expect(body.options).toMatchObject({ num_predict: DEFAULT_OLLAMA_CONFIG.maxTokens, temperature: 2 })
  })

  it('gives the model no more of the page than the length allows', async () => {
    const fetcher = reply()
    await summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true }, { content: '§'.repeat(50_000), url: 'https://a.example/', length: 'short' }, fetcher)
    const body = JSON.parse(String(sent(fetcher)[1]!.body)) as { prompt: string }
    expect(body.prompt.split('§').length - 1).toBe(LENGTH_CHARS.short)
  })

  it('goes to /api/generate of the address of this Mac, and a redirect is an error', async () => {
    const fetcher = reply()
    expect(await summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://127.0.0.1:11434/' }, { content: 'texte', url: 'https://a.example/' }, fetcher)).toMatchObject({ summary: 'ok' })
    expect(sent(fetcher)[0]).toBe('http://127.0.0.1:11434/api/generate')
    expect(sent(fetcher)[1]!.redirect).toBe('error')
  })

  // Guard: even called directly, with Ollama on and the settings saying so, the page text is not sent to a public host or to a name of the internet.
  it('is never sent to a public host or to a name that is not a .local one', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetcher = reply()
    for (const url of ['http://8.8.8.8:11434', 'https://ollama.exemple.fr', 'http://localhost.evil.com:11434', 'http://localhost@evil.com:11434', 'http://box.lan:11434']) {
      expect(await summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url }, { content: 'texte', url: 'https://a.example/' }, fetcher), url).toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
    // Refused before the request is even built: not a request that failed.
    expect(logged).not.toHaveBeenCalled()
  })

  // The failure of the request is said in the log, with its cause, and the caller gets no summary.
  it('logs a request that fails and gives no summary', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = vi.fn(async () => {
      throw new Error('refused')
    })
    expect(await summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true }, { content: 'texte', url: 'https://a.example/' }, failing)).toBeNull()
    expect(logged).toHaveBeenCalledWith('[ai] the summary by Ollama failed:', expect.objectContaining({ message: 'refused' }))
  })
})
