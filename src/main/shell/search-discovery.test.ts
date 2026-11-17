import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENSEARCH_FETCH_TIMEOUT_MS, OPENSEARCH_FILE_MAX } from '@shared/opensearch'
import { defaultSettings, type SidebarState, type SiteSearch } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { SITE_SEARCHES_MAX } from '@shared/state-clean'
import { DISCOVERY_NOTICE_MS, SearchDiscovery, fetchDescription, type DescriptionFetcher, type DiscoveryHost, type FetchedResponse } from './search-discovery'
import { frenchSpaces } from '@shared/french-typography'

const PAGE = 'https://www.example.org/docs'
const FILE = '<OpenSearchDescription><ShortName>Exemple</ShortName><Url type="text/html" template="https://www.example.org/search?q={searchTerms}"/></OpenSearchDescription>'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

interface Rig {
  host: DiscoveryHost
  discovery: SearchDiscovery
  check(url: string): Promise<void>
  state: SidebarState
  declared: ReturnType<typeof vi.fn>
  fetched: ReturnType<typeof vi.fn>
  notices: Array<{ message: string; action?: { label: string; run: () => void }; durationMs?: number }>
  added: SiteSearch[]
}

function rig(settings: Partial<ReturnType<typeof defaultSettings>> = {}, declaredReply: unknown = [{ title: 'Exemple', href: 'https://www.example.org/opensearch.xml' }], fileReply: string | Error = FILE): Rig {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const r = { state: { ...base, settings: { ...base.settings, searchDiscovery: true, ...settings } } } as Rig
  r.notices = []
  r.added = []
  r.declared = vi.fn(async () => {
    if (declaredReply instanceof Error) throw declaredReply
    return declaredReply
  })
  r.fetched = vi.fn(async () => {
    if (fileReply instanceof Error) throw fileReply
    return fileReply
  })
  r.host = {
    state: () => r.state,
    remember: (seen) => void (r.state = { ...r.state, settings: { ...r.state.settings, searchDiscoverySeen: seen } }),
    addSearch: (site) => {
      r.added.push(site)
      r.state = { ...r.state, settings: { ...r.state.settings, siteSearches: [...r.state.settings.siteSearches, site] } }
    },
    notice: (message, action, durationMs) => void r.notices.push({ message, action, durationMs }),
    fetchDescription: r.fetched as unknown as DiscoveryHost['fetchDescription']
  }
  r.discovery = new SearchDiscovery(r.host)
  r.check = (url) => r.discovery.check(url, r.declared as unknown as () => Promise<unknown>)
  return r
}

describe('SearchDiscovery.check', () => {
  it('offers the search of a site once, with a button, and asks the network for nothing', async () => {
    const r = rig()
    await r.check(PAGE)
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]).toMatchObject({ message: frenchSpaces('Ajouter la recherche dans « Exemple » ?'), durationMs: DISCOVERY_NOTICE_MS })
    expect(r.notices[0]!.action?.label).toBe('Ajouter')
    expect(r.state.settings.searchDiscoverySeen).toEqual(['www.example.org'])
    expect(r.fetched).not.toHaveBeenCalled()
    expect(r.added).toEqual([])
  })

  it('does not even read the page when the setting is off', async () => {
    const r = rig({ searchDiscovery: false })
    await r.check(PAGE)
    expect(r.declared).not.toHaveBeenCalled()
    expect(r.notices).toEqual([])
    expect(r.state.settings.searchDiscoverySeen).toEqual([])
  })

  it('offers a site once: not on its next page, nor in another session once it is recorded', async () => {
    const r = rig()
    await r.check(PAGE)
    await r.check(`${PAGE}/other`)
    expect(r.declared).toHaveBeenCalledTimes(1)
    expect(r.notices).toHaveLength(1)
    const later = rig({ searchDiscoverySeen: ['www.example.org'] })
    await later.check(PAGE)
    expect(later.declared).not.toHaveBeenCalled()
  })

  it('looks at a site that declared nothing only once in the session', async () => {
    const r = rig({}, [])
    await r.check(PAGE)
    await r.check(`${PAGE}/b`)
    expect(r.declared).toHaveBeenCalledTimes(1)
    expect(r.notices).toEqual([])
    expect(r.state.settings.searchDiscoverySeen).toEqual([])
  })

  it('does not look at a page it cannot offer (http, another scheme)', async () => {
    const r = rig()
    for (const url of ['http://www.example.org/', 'about:blank', 'file:///tmp/a.html', 'chrome-error://chromewebdata/']) await r.check(url)
    expect(r.declared).not.toHaveBeenCalled()
  })

  it('offers nothing for what a page declares that is not a search of its own site', async () => {
    for (const reply of [[{ title: 'Autre', href: 'https://evil.example/os.xml' }], [{ title: 'Http', href: 'http://www.example.org/os.xml' }], 'texte', null, [{}], [{ href: 'javascript:alert(1)' }]]) {
      const r = rig({}, reply)
      await r.check(PAGE)
      expect(r.notices, JSON.stringify(reply)).toEqual([])
      expect(r.state.settings.searchDiscoverySeen).toEqual([])
    }
  })

  it('logs a page that could not be read, and looks again at the next page of the site', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const r = rig({}, new Error('Render frame was disposed'))
    await r.check(PAGE)
    expect(debug).toHaveBeenCalledWith('[search] cannot read what www.example.org declares:', 'Render frame was disposed')
    expect(r.notices).toEqual([])
    await r.check(PAGE)
    expect(r.declared).toHaveBeenCalledTimes(2)
  })
})

describe('SearchDiscovery: the button', () => {
  it('reads the description file once, adds the search with a keyword of its own and says how to use it', async () => {
    const r = rig()
    await r.check(PAGE)
    r.notices[0]!.action!.run()
    await vi.waitFor(() => expect(r.added).toHaveLength(1))
    expect(r.fetched).toHaveBeenCalledTimes(1)
    expect(r.fetched).toHaveBeenCalledWith('https://www.example.org/opensearch.xml')
    expect(r.added[0]).toEqual({ keyword: 'example', name: 'Exemple', url: 'https://www.example.org/search?q=%s' })
    expect(r.notices.at(-1)?.message).toBe(frenchSpaces('Recherche ajoutée : tapez « example » puis Tab dans la barre de commandes'))
  })

  it('says it could not, and logs why, when the file cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig({}, undefined, new Error('HTTP 404'))
    await r.check(PAGE)
    r.notices[0]!.action!.run()
    await vi.waitFor(() => expect(r.notices).toHaveLength(2))
    expect(r.notices[1]!.message).toBe('Cette recherche n’a pas pu être ajoutée.')
    expect(warn).toHaveBeenCalledWith('[search] cannot add the search of www.example.org:', 'HTTP 404')
    expect(r.added).toEqual([])
  })

  it('says it could not when the file has no search of the site', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const file of ['', 'texte', '<OpenSearchDescription><Url type="text/html" template="https://evil.example/s?q={searchTerms}"/></OpenSearchDescription>']) {
      const r = rig({}, undefined, file)
      await r.check(PAGE)
      r.notices[0]!.action!.run()
      await vi.waitFor(() => expect(r.notices).toHaveLength(2))
      expect(r.notices[1]!.message, file).toBe('Cette recherche n’a pas pu être ajoutée.')
      expect(r.added).toEqual([])
    }
    expect(warn).toHaveBeenCalledWith('[search] cannot add the search of www.example.org:', 'the file declares no web search it can keep')
  })

  it('does not exceed the list of searches', async () => {
    const r = rig()
    await r.check(PAGE)
    const full = Array.from({ length: SITE_SEARCHES_MAX }, (_, i) => ({ keyword: `k${i}`, name: `N${i}`, url: `https://s${i}.test/?q=%s` }))
    r.state = { ...r.state, settings: { ...r.state.settings, siteSearches: full } }
    r.notices[0]!.action!.run()
    await vi.waitFor(() => expect(r.notices).toHaveLength(2))
    expect(r.notices[1]!.message).toBe('La liste des recherches dans un site est pleine.')
    expect(r.added).toEqual([])
  })
})

function response(body: Uint8Array[] | null, init: { ok?: boolean; status?: number; length?: string } = {}): FetchedResponse & { cancelled: ReturnType<typeof vi.fn> } {
  const cancelled = vi.fn()
  const chunks = [...(body ?? [])]
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? (init.length ?? null) : null) },
    body: body
      ? ({ getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift()! } : { done: true, value: undefined }), cancel: async () => void cancelled() }) } as unknown as ReadableStream<Uint8Array>)
      : null,
    cancelled
  }
}
const bytes = (text: string) => new TextEncoder().encode(text)

describe('fetchDescription', () => {
  it('asks for the file without cache, cookie or redirect, and reads it', async () => {
    const fetcher = vi.fn<DescriptionFetcher>(async () => response([bytes('<a>é'), bytes('</a>')]))
    expect(await fetchDescription('https://www.example.org/os.xml', fetcher)).toBe('<a>é</a>')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('https://www.example.org/os.xml')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' })
  })

  it('refuses an answer that is not a success', async () => {
    await expect(fetchDescription('https://x.test/', async () => response([bytes('x')], { ok: false, status: 404 }))).rejects.toThrow('HTTP 404')
  })

  it('refuses a file announced as too big without reading it', async () => {
    const big = response([bytes('x')], { length: String(OPENSEARCH_FILE_MAX + 1) })
    await expect(fetchDescription('https://x.test/', async () => big)).rejects.toThrow('file too large')
  })

  it('reads a file up to the size it allows, and stops reading one that turns out bigger, whatever it announced', async () => {
    await expect(fetchDescription('https://x.test/', async () => response([new Uint8Array(OPENSEARCH_FILE_MAX)]))).resolves.toHaveLength(OPENSEARCH_FILE_MAX)
    const bigger = response([new Uint8Array(OPENSEARCH_FILE_MAX - 5), new Uint8Array(10)], { length: '12' })
    await expect(fetchDescription('https://x.test/', async () => bigger)).rejects.toThrow('file too large')
    expect(bigger.cancelled).toHaveBeenCalled()
  })

  it('refuses an answer without a body', async () => {
    await expect(fetchDescription('https://x.test/', async () => response(null))).rejects.toThrow('empty answer')
  })

  it('gives up after a few seconds', async () => {
    vi.useFakeTimers()
    const fetcher: DescriptionFetcher = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const outcome = expect(fetchDescription('https://x.test/', fetcher)).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(OPENSEARCH_FETCH_TIMEOUT_MS + 10)
    await outcome
  })
})
