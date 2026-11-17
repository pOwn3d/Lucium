// The requests of the page summary leave through Electron's net.fetch, never the bare fetch of Node, to Ollama on this Mac; to Ollama on a
// computer of the local network they leave through a session that uses no proxy; and they leave to nothing else.
// The real methods of the Browser run on a stand-in for the window, with the bare fetch of Node replaced by one that fails the test if it is called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { DEFAULT_OLLAMA_CONFIG } from '@shared/ollama'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

// Electron's net.fetch is where every request of the summary leaves from; browser.ts reaches Electron only when a method runs.
// `direct` is the fetch of the session without a proxy (shell/ollama-fetch.ts), `setProxy` what that session is told before its first request.
const electron = vi.hoisted(() => ({ fetch: vi.fn(), direct: vi.fn(), setProxy: vi.fn(async () => undefined), partitions: [] as string[] }))
// What the resolver of the system answers for a `.local` name.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
vi.mock('electron', () => {
  const session = { fromPartition: (name: string) => (electron.partitions.push(name), { setProxy: electron.setProxy, fetch: electron.direct }) }
  return new Proxy({ net: { fetch: electron.fetch }, session } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) })
})

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const bareFetch = vi.fn(async () => {
  throw new Error('the bare fetch of Node was used')
})

beforeEach(() => {
  vi.stubGlobal('fetch', bareFetch)
  bareFetch.mockClear()
  electron.fetch.mockReset()
  readText.mockClear()
  electron.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'mistral' }] })
    return json({ response: 'Résumé local', eval_count: 3 })
  })
  electron.direct.mockReset()
  electron.direct.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'mistral' }] })
    return json({ response: 'Résumé du réseau', eval_count: 3 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const readText = vi.fn(async () => 'Le texte de la page')

function windowWith(patch: Partial<Settings>, url = 'https://page.example/article') {
  const settings: Settings = { ...defaultSettings(), aiSummary: true, ...patch }
  const tab = { id: 'tab-1', url, title: 'Article' }
  return { store: { get: () => ({ settings, tabs: [tab] }) }, pages: new Map([[tab.id, { readText }]]), isPrivate: () => false }
}

describe('the requests of the page summary', () => {
  it('to the local model (the search for its model, then the summary) go through net.fetch, not the bare fetch of Node', async () => {
    const reply = await methods['summarizeTab']!.call(windowWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }), 'tab-1', 'normal')
    expect(reply).toMatchObject({ ok: true, summary: 'Résumé local' })
    expect(electron.fetch.mock.calls.map(([url]) => url)).toEqual([`${DEFAULT_OLLAMA_CONFIG.url}/api/tags`, `${DEFAULT_OLLAMA_CONFIG.url}/api/generate`])
    expect(bareFetch).not.toHaveBeenCalled()
  })

  // net.fetch sends the cookies and the HTTP credentials of the application's session unless told not to, and follows a redirect unless told not to.
  it('carry no cookie or credential of the session, and follow no redirect', async () => {
    await methods['summarizeTab']!.call(windowWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }), 'tab-1', 'normal')
    expect(electron.fetch).toHaveBeenCalledTimes(2)
    for (const [url, init] of electron.fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials, url).toBe('omit')
      expect(init.redirect, url).toBe('error')
    }
  })

  it('are not made while the summary or the local model is switched off', async () => {
    expect(await methods['summarizeTab']!.call(windowWith({ aiSummary: false, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }), 'tab-1', 'normal')).toEqual({ ok: false, error: t('summary.desactive', { settingsPath: settingsPath('summary') }) })
    expect(await methods['summarizeTab']!.call(windowWith({}), 'tab-1', 'normal')).toEqual({ ok: false, error: t('summary.desactive', { settingsPath: settingsPath('summary') }) })
    expect(readText).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
  })
})

describe('what Ollama receives', () => {
  const local = (patch: Partial<typeof DEFAULT_OLLAMA_CONFIG> = {}) => ({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, ...patch } })
  const sentBody = (): Record<string, unknown> => {
    const call = electron.fetch.mock.calls.find(([url]) => String(url).endsWith('/api/generate'))
    expect(call, 'the request of the summary').toBeDefined()
    return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>
  }

  // Guard: the origin and path only. Without `addressForSummary`, the query and the fragment (a token, a search) went along.
  it('gets the origin and path of the page, never its query, its fragment or its title', async () => {
    const reply = await methods['summarizeTab']!.call(windowWith(local(), 'https://page.example/article?token=s3cr3t#compte'), 'tab-1', 'normal')
    expect(reply).toMatchObject({ ok: true })
    const prompt = String(sentBody()['prompt'])
    expect(prompt).toContain('https://page.example/article')
    expect(prompt).not.toContain('s3cr3t')
    expect(prompt).not.toContain('#compte')
    expect(prompt).not.toContain('Article')
  })

  // Guard: a public host or a name of the internet gets nothing, not even the question of its models: the page is not read, and the reason is said.
  it('sends nothing to a public host or to a name that is not a .local one, whatever the settings hold', async () => {
    for (const url of ['http://8.8.8.8:11434', 'https://ollama.exemple.fr', 'http://localhost.evil.com:11434', 'http://box.lan:11434']) {
      const stale = { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url, remoteConfirmed: url }
      expect(await methods['summarizeTab']!.call(windowWith({ ollamaConfig: stale }), 'tab-1', 'normal'), url).toEqual({ ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) })
    }
    expect(readText).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(electron.direct).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
  })

  // With a proxy in the settings or in the system, net.fetch would hand a request for a private address to that proxy: the page text would
  // reach a host the user did not name. The session of these requests is told to use none, before its first request.
  it('reaches a computer of the local network without any proxy, without a cookie, and follows no redirect', async () => {
    const network = 'http://192.168.1.20:11434'
    const reply = await methods['summarizeTab']!.call(windowWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: network } }), 'tab-1', 'normal')
    expect(reply).toMatchObject({ ok: true, summary: 'Résumé du réseau' })
    expect(electron.direct.mock.calls.map(([url]) => url)).toEqual([`${network}/api/tags`, `${network}/api/generate`])
    for (const [url, init] of electron.direct.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials, url).toBe('omit')
      expect(init.redirect, url).toBe('error')
    }
    expect(electron.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
    expect(electron.setProxy.mock.invocationCallOrder[0]!).toBeLessThan(electron.direct.mock.invocationCallOrder[0]!)
    expect(new Set(electron.partitions)).toEqual(new Set(['lucium-network-model']))
    // Nothing by the application's own way out, which follows the proxy of the settings.
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
  })

  // A `.local` name is whatever the resolver answers when the text leaves: each request goes to the private address the name led to, by the
  // session without a proxy, and never to the name itself, which a second resolution could point elsewhere.
  it('reaches a computer named by a .local name at the private address the name leads to, checked for each request', async () => {
    dns.lookup.mockReset().mockImplementation(async () => [{ address: '192.168.1.77', family: 4 }])
    const reply = await methods['summarizeTab']!.call(windowWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://mon-mac.local:11434' } }), 'tab-1', 'normal')
    expect(reply).toMatchObject({ ok: true, summary: 'Résumé du réseau' })
    expect(dns.lookup.mock.calls.map(([name]) => name)).toEqual(['mon-mac.local', 'mon-mac.local'])
    expect(electron.direct.mock.calls.map(([url]) => url)).toEqual(['http://192.168.1.77:11434/api/tags', 'http://192.168.1.77:11434/api/generate'])
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
  })

  // Guard: a `.local` name that leads to a public address gets nothing, and the tab of the summary says why (not "check that Ollama runs").
  it('sends nothing to a .local name that leads to a public address, and says so', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dns.lookup.mockReset().mockImplementation(async () => [{ address: '203.0.113.9', family: 4 }])
    const reply = await methods['summarizeTab']!.call(windowWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://mon-mac.local:11434' } }), 'tab-1', 'normal')
    expect(reply).toEqual({ ok: false, error: t('summary.nom-sans-adresse-privee', { host: 'mon-mac.local' }) })
    expect(electron.direct).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('mon-mac.local'))
    logged.mockRestore()
  })

  // The ceiling of tokens is sent (it once was not), within its bounds, and under the one of the length asked for.
  it('asks for at most the tokens of the length, lowered by the ceiling of the settings', async () => {
    await methods['summarizeTab']!.call(windowWith(local({ maxTokens: 500 })), 'tab-1', 'long')
    expect((sentBody()['options'] as Record<string, unknown>)['num_predict']).toBe(500)
    electron.fetch.mockClear()
    await methods['summarizeTab']!.call(windowWith(local({ maxTokens: 2048 })), 'tab-1', 'short')
    expect((sentBody()['options'] as Record<string, unknown>)['num_predict']).toBe(300)
  })
})
