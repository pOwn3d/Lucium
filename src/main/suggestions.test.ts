import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SEARCH_URL } from '@shared/model'
import { fetchSuggestions, parseSuggestions, SUGGEST_FETCH_INIT, suggestEndpoint } from './suggestions'

afterEach(() => vi.restoreAllMocks())

const answering = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }))

describe('parseSuggestions', () => {
  it('reads the OpenSearch format and drops junk', () => {
    expect(parseSuggestions(['arc', ['arc browser', '', 3, 'arcade'], []])).toEqual(['arc browser', 'arcade'])
  })

  it('answers nothing for unexpected payloads', () => {
    for (const bad of [null, {}, 'x', [], ['q'], ['q', 'not an array']]) expect(parseSuggestions(bad)).toEqual([])
  })
})

describe('fetchSuggestions', () => {
  it('queries the endpoint of the configured engine with the encoded text', async () => {
    const fetcher = answering(['arc', ['arc browser']])
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'arc & co', fetcher)).toEqual(['arc browser'])
    expect(fetcher).toHaveBeenCalledWith('https://duckduckgo.com/ac/?type=list&q=arc%20%26%20co', expect.anything())
  })

  it('asks without credentials and without letting the answer be cached: the session is shared with the private windows', async () => {
    const fetcher = answering(['arc', ['arc browser']])
    await fetchSuggestions(DEFAULT_SEARCH_URL, 'arc', fetcher)
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) }))
    expect(SUGGEST_FETCH_INIT).toEqual({ cache: 'no-store', credentials: 'omit' })
  })

  it('does not ask for one-letter input or for an engine without suggestions', async () => {
    const fetcher = answering(['a', ['x']])
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'a', fetcher)).toEqual([])
    expect(await fetchSuggestions('https://www.qwant.com/?q=%s', 'arc', fetcher)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(suggestEndpoint('https://www.qwant.com/?q=%s')).toBeUndefined()
  })

  it('never sends an address to the engine, with or without a scheme; words, even with a dot, still go', async () => {
    const fetcher = answering(['q', ['x']])
    for (const typed of ['intranet.corp/page', 'localhost:3000', '192.168.1.20', '192.168.1.20:8080/admin', 'github.com/user/repo', 'https://example.com/a', 'ftp://files.example.org/x', ' about:blank ', '[::1]:8080']) {
      expect(await fetchSuggestions(DEFAULT_SEARCH_URL, typed, fetcher), typed).toEqual([])
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'planète médiévale', fetcher)).toEqual(['x'])
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'javascript: void', fetcher)).toEqual(['x'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('logs and answers nothing when the engine fails or errors out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'arc', answering([], false))).toEqual([])
    expect(await fetchSuggestions(DEFAULT_SEARCH_URL, 'arc', vi.fn(async () => { throw new Error('offline') }))).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duckduckgo.com'), 'HTTP 503')
  })
})
