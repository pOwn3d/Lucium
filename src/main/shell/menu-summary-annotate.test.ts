// Two entries of the File menu: « Résumer la page » and its two lengths exist only once an engine is ready to receive the
// page (they used to ignore the setting and open a tab of error), and « Annoter cette page » binds ⌥⌘M itself unless the user asked for it
// system-wide. The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { DEFAULT_OLLAMA_CONFIG } from '@shared/ollama'
import { PAGE_TOGGLE_SHORTCUT } from '@shared/page-annotate'
import { t } from '@shared/i18n'
import type { Settings, SidebarState } from '@shared/model'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { buildMenu } from './menu'

interface Item {
  label?: string
  accelerator?: string
  registerAccelerator?: boolean
  visible?: boolean
  enabled?: boolean
  submenu?: Item[]
}

const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))
const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }

/** The entries of the menu built for a state with these settings (a tab on screen); `where`: a private window, or a private tab on screen. */
function entries(patch: Partial<Settings>, where: 'normal' | 'private-window' | 'private-tab' = 'normal'): Item[] {
  const base = createInitialState(ctx)
  const tab = { id: 'tab', spaceId: base.spaces[0]!.id, url: 'https://page.example/', title: 'Page', pinned: false, createdAt: 1, lastActiveAt: 1, ...(where === 'private-tab' ? { private: true } : {}) }
  const state: SidebarState = { ...base, tabs: [tab], activeTabBySpace: { [base.spaces[0]!.id]: tab.id }, settings: { ...base.settings, ...patch } }
  const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  return leaves(buildMenu(browser as never, { get: () => state } as never, actions as never, where === 'private-window' ? { private: true } : {}) as unknown as Item[])
}

const SUMMARY = ['menu.resumer-la-page', 'menu.resumer-court', 'menu.resumer-detaille'] as const
const summaryEnabled = (patch: Partial<Settings>, where: Parameters<typeof entries>[1] = 'normal'): boolean[] => SUMMARY.map((key) => entries(patch, where).find((item) => item.label === t(key))?.enabled !== false)
const summaryShown = (patch: Partial<Settings>, where: Parameters<typeof entries>[1] = 'normal'): boolean[] => SUMMARY.map((key) => entries(patch, where).find((item) => item.label === t(key))?.visible !== false)

describe('the entries « Résumer… » of the File menu', () => {
  // Guard: hidden on a new profile, and while the local model is not ready, even with the switch of the summary on.
  it('are hidden on a new profile, and while the local model is not ready', () => {
    expect(summaryShown({})).toEqual([false, false, false])
    expect(summaryShown({ aiSummary: true })).toEqual([false, false, false])
  })

  it('are shown with Ollama on, on this Mac', () => {
    expect(summaryShown({ aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } })).toEqual([true, true, true])
  })

  it('are hidden when the summary is switched off, whatever is ready', () => {
    expect(summaryShown({ aiSummary: false, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } })).toEqual([false, false, false])
  })

  // The page text stays on the Mac: a page of a private window, a guest window (built as a private one) or a private tab has the entries too.
  it('are shown in a private window and for a private tab, and never for the address of a public host', () => {
    const local = { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }
    const remote = { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'https://ollama.exemple.fr' } }
    for (const where of ['private-window', 'private-tab'] as const) {
      expect(summaryShown(local, where), where).toEqual([true, true, true])
      expect(summaryShown(remote, where), where).toEqual([false, false, false])
    }
    expect(summaryShown(remote)).toEqual([false, false, false])
  })

  // With Ollama on a computer of the local network the page text leaves the Mac: a private or a guest window has no entry for it.
  it('are shown with Ollama on a computer of the local network, and hidden there in a private window', () => {
    const network = { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: 'http://192.168.1.40:11434' } }
    expect(summaryShown(network)).toEqual([true, true, true])
    expect(summaryShown(network, 'private-window')).toEqual([false, false, false])
  })

  // The menu of a normal window is one for all its tabs: with a private tab on screen and Ollama on another computer, the entries stay and
  // are greyed out, instead of opening a tab that only says no (the summary itself still refuses, summary-private.test.ts).
  it('are greyed out for a private tab on screen with Ollama on another computer, and for nothing else', () => {
    const local = { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }
    for (const url of ['http://192.168.1.40:11434', 'http://mon-mac.local:11434', 'http://100.64.0.7:11434']) {
      const network = { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url } }
      expect(summaryShown(network, 'private-tab'), url).toEqual([true, true, true])
      expect(summaryEnabled(network, 'private-tab'), url).toEqual([false, false, false])
      expect(summaryEnabled(network), url).toEqual([true, true, true])
    }
    // Ollama on this Mac keeps the text here: a private tab is summarized like any other.
    expect(summaryEnabled(local, 'private-tab')).toEqual([true, true, true])
    expect(summaryEnabled(local)).toEqual([true, true, true])
  })

  it('are shown in a private window and for a private tab with Ollama on this Mac', () => {
    for (const where of ['private-window', 'private-tab'] as const) expect(summaryShown({ aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true } }, where), where).toEqual([true, true, true])
  })
})

describe('the entry « Annoter cette page »', () => {
  const annotate = (patch: Partial<Settings>) => entries(patch).find((item) => item.label === t('menu.annoter-cette-page'))

  // Guard: by default ⌥⌘M is the menu's shortcut, heard only while Lucium is in front.
  it('binds ⌥⌘M itself by default', () => {
    expect(annotate({})).toMatchObject({ accelerator: PAGE_TOGGLE_SHORTCUT, registerAccelerator: true })
  })

  // Guard: with the system-wide shortcut on, the menu only shows it; binding it as well would start the annotation twice.
  it('only shows ⌥⌘M when the shortcut is held system-wide', () => {
    expect(annotate({ annotateGlobalShortcut: true })).toMatchObject({ accelerator: PAGE_TOGGLE_SHORTCUT, registerAccelerator: false })
  })
})
