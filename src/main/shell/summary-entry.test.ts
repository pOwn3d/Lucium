// The « Résumer la page » entry of the page menu is offered once Ollama is switched on, at an address of this Mac or at a private one of the
// local network; a private page has it with Ollama on this Mac only.
// The real method of the Browser that builds the options of the menu runs on a stand-in for the window, with real settings.
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { DEFAULT_OLLAMA_CONFIG, summaryAvailable } from '@shared/ollama'
import type { PageMenuOptions } from '../engine/types'

// browser.ts reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

const { Browser } = await import('./browser')
const menuOptionsFor = (Browser.prototype as unknown as Record<string, (this: unknown, tabId: string) => PageMenuOptions>)['menuOptionsFor']!

/** What the menu of a page offers with these settings; `where`: a private (or guest) window, or a private tab of a normal one. */
function offered(patch: Partial<Settings>, where: 'normal' | 'private-window' | 'private-tab' = 'normal'): boolean {
  const settings = { ...defaultSettings(), aiSummary: true, ...patch }
  const tabs = [{ id: 'tab-1', url: 'https://page.example/', ...(where === 'private-tab' ? { private: true } : {}) }]
  const self = { store: { get: () => ({ settings, tabs }) }, isPrivate: () => where === 'private-window', runtime: { tabs: {} } }
  return menuOptionsFor.call(self, 'tab-1').summary === true
}

const local = (enabled: boolean) => ({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled } })
const NETWORK = { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://192.168.1.20:11434' } }
const REMOTE = { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'https://ollama.exemple.fr' } }

describe('the summary entry of the page menu', () => {
  it('is offered for the local model once it is switched on', () => {
    expect(offered(local(true))).toBe(true)
  })

  it('is not offered while the local model is switched off, or the summary is', () => {
    expect(offered(local(false))).toBe(false)
    expect(offered({ aiSummary: false, ...local(true) })).toBe(false)
  })

  // The page text stays on the Mac: a private page (private or guest window, private tab) is summarized like any other.
  it('is offered for a private page too, with Ollama on this Mac', () => {
    for (const where of ['private-window', 'private-tab'] as const) expect(offered(local(true), where), where).toBe(true)
  })

  it('is never offered for the address of a public host, in any window', () => {
    for (const where of ['normal', 'private-window', 'private-tab'] as const) expect(offered(REMOTE, where), where).toBe(false)
  })

  // Guard: the text of a private page never leaves the Mac, so the entry that would send it to another computer is not there.
  it('is offered with Ollama on a computer of the local network, except for a private page', () => {
    expect(offered(NETWORK)).toBe(true)
    for (const where of ['private-window', 'private-tab'] as const) expect(offered(NETWORK, where), where).toBe(false)
  })

  it('follows the same rule as the File menu, whatever the settings', () => {
    const cases: Array<Partial<Settings>> = [{ aiSummary: false, ...local(true) }, local(true), local(false), REMOTE, NETWORK]
    for (const patch of cases) expect(offered(patch), JSON.stringify(patch)).toBe(summaryAvailable({ ...defaultSettings(), aiSummary: true, ...patch }))
  })
})
