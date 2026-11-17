// A page of a private tab, of a private window or of a guest window is summarized by Ollama on this Mac like any other page, and by nothing
// else: with the address of another computer of the local network in the settings, the refusal comes before the page is read and before any
// request, and it says why.
// The real methods of the Browser run on a stand-in for the window: what is checked is what leaves the application.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { DEFAULT_OLLAMA_CONFIG } from '@shared/ollama'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

// Electron's net.fetch is where every request of the summary leaves from; browser.ts reaches Electron only when a method runs.
const electron = vi.hoisted(() => ({ fetch: vi.fn() }))
// The resolver of the system: a private page must never make a `.local` name be asked for.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
vi.mock('electron', () => new Proxy({ net: { fetch: electron.fetch } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  electron.fetch.mockReset()
  electron.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'mistral' }] })
    return json({ response: 'Résumé local', eval_count: 3 })
  })
})

/**
 * A window with one tab on screen; `settings` are the real defaults with the summary on, changed by `patch`. `windowIsPrivate`: a private or a
 * guest window, whose tabs are not marked private (privateAction takes the flag away).
 */
function windowWith(patch: Partial<Settings>, tabIsPrivate: boolean, windowIsPrivate = false) {
  const settings: Settings = { ...defaultSettings(), aiSummary: true, ...patch }
  const tab = { id: 'tab-1', url: 'https://page.example/article', title: 'Article', ...(tabIsPrivate ? { private: true } : {}) }
  const readText = vi.fn(async () => 'Le texte de la page')
  return { self: { store: { get: () => ({ settings, tabs: [tab] }) }, pages: new Map([[tab.id, { readText }]]), isPrivate: () => windowIsPrivate }, readText }
}

const LOCAL: Partial<Settings> = { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }
/** The address of another computer of the local network: accepted for a page that is not private. */
const REMOTE: Partial<Settings> = { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://192.168.1.40:11434' } }
const summarize = (w: ReturnType<typeof windowWith>) => methods['summarizeTab']!.call(w.self, 'tab-1', 'normal')
const LOCAL_HOST = new URL(DEFAULT_OLLAMA_CONFIG.url).host

/** Another computer named by a `.local` name, or by an address of the shared range: another computer all the same. */
const NAMED: Array<Partial<Settings>> = ['http://mon-mac.local:11434', 'http://100.64.0.7:11434'].map((url) => ({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url } }))

describe('the summary of a private page', () => {
  const PRIVATE: Array<[string, boolean, boolean]> = [
    ['a private tab', true, false],
    ['a private or a guest window, whose tab is not marked private', false, true]
  ]

  it.each(PRIVATE)('is made by Ollama on this Mac, which keeps the page here: %s', async (_name, tabIsPrivate, windowIsPrivate) => {
    const reply = await summarize(windowWith(LOCAL, tabIsPrivate, windowIsPrivate))
    expect(reply).toMatchObject({ ok: true, summary: 'Résumé local' })
    expect(electron.fetch).toHaveBeenCalledTimes(2)
    for (const [url] of electron.fetch.mock.calls) expect(new URL(String(url)).host).toBe(LOCAL_HOST)
  })

  it.each(PRIVATE)('is refused for another computer before the page is read and before any request: %s', async (_name, tabIsPrivate, windowIsPrivate) => {
    const w = windowWith(REMOTE, tabIsPrivate, windowIsPrivate)
    expect(await summarize(w)).toEqual({ ok: false, error: t('summary.reseau-prive', { settingsPath: settingsPath('summary') }) })
    expect(w.readText).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it.each(PRIVATE)('is refused for a computer named by a .local name or by an address of the shared range, before the name is even resolved: %s', async (_name, tabIsPrivate, windowIsPrivate) => {
    for (const settings of NAMED) {
      const w = windowWith(settings, tabIsPrivate, windowIsPrivate)
      expect(await summarize(w)).toEqual({ ok: false, error: t('summary.reseau-prive', { settingsPath: settingsPath('summary') }) })
      expect(w.readText).not.toHaveBeenCalled()
    }
    expect(dns.lookup).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
  })
})
