// The models the settings offer for the local summary come from the Ollama server itself (its /api/tags), no longer from a fixed list.
// The request goes out by the fetcher it is given (Electron's net.fetch in the application, a fake one here).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOllamaModels, ollamaModelField, ollamaModelOptions, readOllamaModels, resolveOllamaModel, sameOllamaModel, type OllamaModelsRead } from './ollama'

afterEach(() => vi.restoreAllMocks())

const answer = (body: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))

describe('the list of the server', () => {
  it('asks /api/tags of the address it is given, through the fetcher it is given, and keeps the full names, sorted, once each', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const fetcher = answer({ models: [{ name: 'qwen3.5:9b' }, { name: 'llama3.2:3b' }, { name: 'llama3.2:3b' }, { name: 'mistral:latest' }] })
    expect(await listOllamaModels('http://127.0.0.1:11434/', fetcher)).toEqual({ ok: true, models: ['llama3.2:3b', 'mistral:latest', 'qwen3.5:9b'] })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.objectContaining({ signal: expect.anything() }))
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('leaves out what is not a name: an entry without one, a blank, a name too long', async () => {
    const fetcher = answer({ models: [{ name: 'phi4' }, { size: 3 }, null, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 42 }] })
    expect(await listOllamaModels('http://localhost:11434', fetcher)).toEqual({ ok: true, models: ['phi4'] })
  })

  it('says why when the server does not answer, answers an error, or answers something else than a list', async () => {
    const refused = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    })
    expect(await listOllamaModels('http://localhost:11434', refused)).toEqual({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:11434' })
    expect(await listOllamaModels('http://localhost:11434', answer({}, 500))).toEqual({ ok: false, error: 'HTTP 500' })
    expect(await listOllamaModels('http://localhost:11434', answer({ models: 'all' }))).toEqual({ ok: false, error: 'unexpected answer' })
    expect(await listOllamaModels('http://localhost:11434', answer(null))).toEqual({ ok: false, error: 'unexpected answer' })
  })

  it('gives an empty list for a server with no model (the row then says so and lets the name be typed)', async () => {
    expect(await listOllamaModels('http://localhost:11434', answer({ models: [] }))).toEqual({ ok: true, models: [] })
  })
})

describe('the field of the model row', () => {
  const url = 'http://localhost:11434'
  const ok = (models: string[], at = url): OllamaModelsRead => ({ url: at, status: 'ok', models })

  it('is the server list once it is read for this address and holds a model', () => {
    expect(ollamaModelField(ok(['llama3.2:3b']), url)).toBe('list')
  })

  it('falls back to typing the name: nothing read, reading, no answer, an empty server, a list of another address', () => {
    expect(ollamaModelField(null, url)).toBe('text')
    expect(ollamaModelField({ url, status: 'loading' }, url)).toBe('text')
    expect(ollamaModelField({ url, status: 'failed', error: 'HTTP 500' }, url)).toBe('text')
    expect(ollamaModelField(ok([]), url)).toBe('text')
    expect(ollamaModelField(ok(['llama3.2:3b'], 'http://127.0.0.1:11434'), url)).toBe('text')
  })

  it('reads through the request it is given, and turns a request that fails into a failed read, said in the log, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await readOllamaModels(url, async () => ({ ok: true, models: ['phi4'] }))).toEqual({ url, status: 'ok', models: ['phi4'] })
    expect(await readOllamaModels(url, async () => ({ ok: false, error: 'invalid address' }))).toEqual({ url, status: 'failed', error: 'invalid address' })
    const broken = await readOllamaModels(url, async () => {
      throw new Error('the main process did not answer')
    })
    expect(broken).toEqual({ url, status: 'failed', error: 'the main process did not answer' })
    expect(ollamaModelField(broken, url)).toBe('text')
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('the models offered', () => {
  it('are the installed ones, plus the current choice when it is not installed, so that the list never changes the setting by itself', () => {
    expect(ollamaModelOptions(['gemma3:4b', 'llama3.2:3b'], 'phi4')).toEqual(['gemma3:4b', 'llama3.2:3b', 'phi4'])
    expect(ollamaModelOptions(['gemma3:4b'], '')).toEqual(['gemma3:4b'])
  })

  it('no longer carry the old fixed list', () => {
    expect(ollamaModelOptions(['gemma3:4b'], 'gemma3:4b')).toEqual(['gemma3:4b'])
    expect(ollamaModelOptions([], 'mistral')).toEqual(['mistral'])
  })

  it('take a name without a tag for its :latest, as Ollama does', () => {
    expect(sameOllamaModel('mistral', 'mistral:latest')).toBe(true)
    expect(sameOllamaModel('mistral:latest', 'mistral')).toBe(true)
    expect(sameOllamaModel('llama3.2', 'llama3.2:3b')).toBe(false)
    expect(ollamaModelOptions(['mistral:latest'], 'mistral')).toEqual(['mistral:latest'])
  })
})

describe('the model a summary runs with', () => {
  it('is the chosen one when the server has it under its :latest, not the smallest installed', async () => {
    const fetcher = answer({ models: [{ name: 'tinyllama:latest', size: 1 }, { name: 'mistral:latest', size: 4 }] })
    expect(await resolveOllamaModel('http://localhost:11434', 'mistral', fetcher)).toEqual({ ok: true, model: 'mistral:latest' })
    expect(await resolveOllamaModel('http://localhost:11434', 'phi4', fetcher)).toEqual({ ok: true, model: 'tinyllama:latest' })
  })
})
