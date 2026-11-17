// The summary has a switch of its own, whatever the engine chosen: when it is off, nothing is read or sent.
// The real methods of the Browser run on a stand-in for the window: what is checked is what the page is asked and what leaves the application.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { DEFAULT_OLLAMA_CONFIG } from '@shared/ollama'
import { t } from '@shared/i18n'
import type { PageMenuOptions } from '../engine/types'
import { settingsPath } from '@shared/settings-path'

// Electron's net.fetch is where every request of the summary leaves from; browser.ts reaches Electron only when a method runs.
const electron = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => new Proxy({ net: { fetch: electron.fetch } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  electron.fetch.mockReset()
  electron.fetch.mockImplementation(async (url: string) => (url.endsWith('/api/tags') ? json({ models: [{ name: 'mistral' }] }) : json({ response: 'Résumé local', eval_count: 3 })))
})

/** A window with one tab on screen, whose page gives `readText`; `settings` are the real defaults with the local model on, changed by `patch`. */
function windowWith(patch: Partial<Settings>) {
  const settings: Settings = { ...defaultSettings(), ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true }, ...patch }
  const readText = vi.fn(async () => 'Le texte de la page')
  const tab = { id: 'tab-1', url: 'https://page.example/article', title: 'Article' }
  const self = { store: { get: () => ({ settings, tabs: [tab] }) }, pages: new Map([[tab.id, { readText }]]), isPrivate: () => false, runtime: { tabs: {} } }
  return { self, readText }
}

describe('the summary switch', () => {
  it('refuses the summary before reading the page or sending anything', async () => {
    const w = windowWith({ aiSummary: false })
    const reply = await methods['summarizeTab']!.call(w.self, 'tab-1', 'normal')
    expect(reply).toEqual({ ok: false, error: t('summary.desactive', { settingsPath: settingsPath('summary') }) })
    expect(w.readText).not.toHaveBeenCalled()
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('answers, once the switch is on, with the same window and the same page', async () => {
    const w = windowWith({ aiSummary: true })
    const reply = await methods['summarizeTab']!.call(w.self, 'tab-1', 'normal')
    expect(reply).toMatchObject({ ok: true, summary: 'Résumé local' })
    expect(w.readText).toHaveBeenCalledOnce()
  })

  it('shows the menu entry only when the switch is on', () => {
    const entry = (aiSummary: boolean) => (methods['menuOptionsFor']!.call(windowWith({ aiSummary }).self, 'tab-1') as PageMenuOptions).summary === true
    expect(entry(true)).toBe(true)
    expect(entry(false)).toBe(false)
  })
})
