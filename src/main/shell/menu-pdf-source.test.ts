// « Enregistrer en PDF avec l'adresse… » (pdf-with-source): the entry of the File menu exists only with the setting on, and only a web page can be printed to it;
// the step behind it (`Browser.savePdfWithSource`) does nothing at all with the setting off. The menu is the real one, with Electron's `Menu` replaced by a
// function that hands the template back (as menu-summary-annotate.test.ts does); the shell step runs on a stand-in for the browser.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

vi.mock('electron', async () => {
  const { electronStub } = await import('../engine/electron-page.test-support')
  const base = electronStub({ Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } })
  return base
})
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

const { buildMenu } = await import('./menu')
const { Browser } = await import('./browser')

interface Item {
  label?: string
  enabled?: boolean
  submenu?: Item[]
}
const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))
const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const LABEL = t('menu.enregistrer-en-pdf-avec-l-adresse')

/** The entries of the menu built for a state with these settings and a tab on `url` on screen. */
function entries(patch: Partial<Settings>, url = 'https://page.example/'): Item[] {
  const base = createInitialState(ctx)
  const tab = { id: 'tab', spaceId: base.spaces[0]!.id, url, title: 'Page', pinned: false, createdAt: 1, lastActiveAt: 1 }
  const state: SidebarState = { ...base, tabs: [tab], activeTabBySpace: { [base.spaces[0]!.id]: tab.id }, settings: { ...base.settings, ...patch } }
  const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  return leaves(buildMenu(browser as never, { get: () => state } as never, actions as never, {}) as unknown as Item[])
}

describe('the entry « Enregistrer en PDF avec l’adresse… » of the File menu', () => {
  it('is not in the menu while the setting is off, and is there with it on', () => {
    expect(entries({ pdfWithSource: false }).find((item) => item.label === LABEL)).toBeUndefined()
    expect(entries({ pdfWithSource: true }).find((item) => item.label === LABEL)).toBeDefined()
  })

  it('is available for a web page and greyed for a page that is not on the web', () => {
    expect(entries({ pdfWithSource: true }).find((item) => item.label === LABEL)?.enabled).toBe(true)
    expect(entries({ pdfWithSource: true }, 'file:///Users/moi/page.html').find((item) => item.label === LABEL)?.enabled).toBe(false)
  })
})

describe('the step behind the entry (Browser.savePdfWithSource)', () => {
  const savePdf = Browser.prototype.savePdfWithSource as unknown as (this: unknown) => Promise<void>

  /** A stand-in for the browser: a store with the setting and a tab on `url`, and spies on what the step would touch. */
  function standIn(pdfWithSource: boolean, url: string) {
    const base = createInitialState(ctx)
    const tab = { id: 'tab', spaceId: base.spaces[0]!.id, url, title: 'Page', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const state = { ...base, tabs: [tab], activeTabBySpace: { [base.spaces[0]!.id]: tab.id }, settings: { ...base.settings, pdfWithSource } }
    return { store: { get: () => state }, followPaneFocus: vi.fn(), activePage: vi.fn(() => ({ printToPdf: vi.fn() })), showToast: vi.fn() }
  }

  it('does nothing at all while the setting is off', async () => {
    const browser = standIn(false, 'https://page.example/')
    await savePdf.call(browser)
    expect(browser.followPaneFocus).not.toHaveBeenCalled()
    expect(browser.activePage).not.toHaveBeenCalled()
    expect(browser.showToast).not.toHaveBeenCalled()
  })

  it('says that only a web page can be saved, for the page of Lucium, with the setting on', async () => {
    const browser = standIn(true, 'about:blank')
    await savePdf.call(browser)
    expect(browser.followPaneFocus).toHaveBeenCalledTimes(1)
    expect(browser.showToast).toHaveBeenCalledWith(t('browser.seules-les-pages-web-peuvent-etre-enregistrees'))
  })
})
