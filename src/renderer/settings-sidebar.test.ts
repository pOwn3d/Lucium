// @vitest-environment happy-dom
// The sidebar of the Settings and « Pour commencer », in the window mounted in a document: the keyboard from end to end (one stop of Tab for the list,
// the arrows inside it, Escape out of « Réglages modifiés »), the rows « Pour commencer » draws again (the very settings of their category, never copies),
// the page of the optional features, and the addresses of before, led to the page that holds their place now.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { featureById } from '@shared/features'
import { setLanguage, t, tp } from '@shared/i18n'
import { SETTINGS_PAGES, type UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { HOME_MIRROR_KEYS } from '@shared/settings-catalog'
import { createInitialState, type Action } from '@shared/sidebar'
import { guidePlan, guideQuestionsOf } from '@shared/settings-guide'
import { defaultSettings } from '@shared/model'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { catalogueFeatures, featuresOn } from './FeaturesPage'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'space' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The window at an address, mounted once the change of address has been told (the document tells it later, as a browser does). */
async function open(hash: string, patch: Partial<Settings> = {}, query = ''): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: query }))
  return mounted.container
}

/** A key pressed where the focus is, and the change of address it makes told to the window. */
async function press(key: string): Promise<void> {
  await settle(() => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle(() => void globalThis.dispatchEvent(new HashChangeEvent('hashchange')))
  // The window gives the focus to the entry it opened on the next frame.
  await settle(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

const current = (window: HTMLElement): string | undefined => window.querySelector<HTMLElement>('.settings-cat[aria-current="page"]')?.dataset['cat']
const written = (): Array<Partial<Settings>> => dispatch.mock.calls.map(([action]) => (action as { patch: Partial<Settings> }).patch)

beforeEach(() => {
  setLanguage('fr')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the keyboard in the sidebar', () => {
  it('stops Tab once on the list, on the page shown', async () => {
    const window = await open('#tabs')
    const stops = [...window.querySelectorAll<HTMLElement>('.settings-cat')].filter((entry) => entry.tabIndex === 0).map((entry) => entry.dataset['cat'])
    expect(stops).toEqual(['tabs'])
  })

  it('goes down and up the pages with the arrows, round the ends, and to the first and the last with Home and End, opening each and keeping the focus on it', async () => {
    const window = await open('#home')
    window.querySelector<HTMLElement>('[data-cat="home"]')!.focus()
    await press('ArrowDown')
    expect(current(window)).toBe('appearance')
    expect((document.activeElement as HTMLElement).dataset['cat']).toBe('appearance')
    await press('ArrowUp')
    expect(current(window)).toBe('home')
    await press('ArrowUp')
    expect(current(window)).toBe('about')
    await press('Home')
    expect(current(window)).toBe('home')
    await press('End')
    expect(current(window)).toBe(SETTINGS_PAGES[SETTINGS_PAGES.length - 1])
    expect((document.activeElement as HTMLElement).dataset['cat']).toBe('about')
  })

  it('leaves « Réglages modifiés » with Escape, back to the page it was opened over, the focus on that page in the sidebar', async () => {
    const window = await open('#tabs', { restoreWindows: false })
    await click(window.querySelector<HTMLButtonElement>('.settings-changed-link')!)
    expect(window.querySelector('#pane-heading')?.textContent).toBe(t('settings.modifies-titre'))
    await press('Escape')
    expect(window.querySelector('#pane-heading')?.textContent).toBe('Onglets et fenêtres')
    expect((document.activeElement as HTMLElement).dataset['cat']).toBe('tabs')
  })
})

describe('« Pour commencer »', () => {
  it('draws again the rows of the first minutes, marked as mirrors, each with the value of its setting', async () => {
    const window = await open('#home', { restoreWindows: false, interfaceAppearance: 'dark' })
    const mirrors = [...window.querySelectorAll<HTMLElement>('main [data-mirror][data-setting]')].map((row) => row.dataset['setting'])
    expect(new Set(mirrors)).toEqual(new Set(HOME_MIRROR_KEYS))
    // The folder of the downloads, kept by each profile (no key of `Settings`), and the level of protection, a preset that stands for no setting of
    // its own, are drawn again too, under their search id.
    expect(window.querySelector('main [data-mirror][data-search="downloadFolder"]')).not.toBeNull()
    expect(window.querySelector('main [data-mirror][data-search="protectionLevel"] [role="radiogroup"]')).not.toBeNull()
    // The launch is a preset: its menu shows the option the windows of the last session make with the loading of the tabs.
    expect(window.querySelector<HTMLSelectElement>('main [data-setting="restoreWindows"][data-mirror] select')!.value).toBe('une-fenetre')
    expect(window.querySelector<HTMLSelectElement>('main [data-setting="interfaceAppearance"][data-mirror] select')!.value).toBe('dark')
    // The language, the default browser and the import are the page's own.
    expect(window.querySelector('main [data-setting~="language"]:not([data-mirror])')).not.toBeNull()
    expect(window.querySelector('main [data-search="defaultBrowser"]')).not.toBeNull()
    expect(window.textContent).toContain(t('import-sheet.importer-depuis-un-autre-navigateur'))
  })

  it('writes the very setting of the category: a mirror is no copy', async () => {
    const window = await open('#home')
    const side = window.querySelector<HTMLSelectElement>('main [data-setting="sidebarRight"][data-mirror] select')!
    await settle(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(side, 'true')
      side.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(written()).toEqual([{ sidebarRight: true }])
    // A preset drawn again writes the settings of its option, as in its category.
    await click(window.querySelector<HTMLButtonElement>('main [data-setting="externalLinksInLittleArc"][data-mirror] [role="radio"][data-option="onglet"]')!)
    expect(written()[1]).toEqual({ externalLinksInLittleArc: false, littleArcNewTabLinks: false })
  })

  it('has the one entry of the guide, which opens the questions in place of the page', async () => {
    const window = await open('#home')
    expect(window.querySelectorAll('.guide-card')).toHaveLength(1)
    await click(window.querySelector<HTMLButtonElement>('.guide-start')!)
    expect(window.querySelector('.guide-flow')).not.toBeNull()
  })

  it('leads from each section to its category', async () => {
    const window = await open('#home')
    const links = [...window.querySelectorAll<HTMLButtonElement>('main .home-open')].map((link) => link.textContent)
    expect(links).toEqual(['Apparence', 'Vie privée et sécurité', 'Navigation', 'Onglets et fenêtres', 'Téléchargements et fichiers'].map((name) => t('settings.home-ouvrir', { name })))
  })
})

describe('the results of a search and « Réglages modifiés »', () => {
  it('draw each setting once, where it lives: not the rows « Pour commencer » draws again', async () => {
    const window = await open('#home', {}, 'apparence')
    const rows = [...window.querySelectorAll<HTMLElement>('main [data-setting="interfaceAppearance"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hasAttribute('data-mirror')).toBe(false)
  })

  // It opens the window once per query: seconds when the whole suite shares the machine.
  it('find a feature to add by its name, once, under « Fonctions en option », where its line lives', { timeout: 30_000 }, async () => {
    for (const [query, key] of [['arbre d’onglets', 'tabTree'], ['volets web', 'webPanels'], ['code QR', 'qrCode'], ['expression régulière', 'findRegex']] as const) {
      const window = await open('#home', {}, query)
      const rows = [...window.querySelectorAll<HTMLElement>(`main [data-setting="${key}"]`)]
      expect(rows, query).toHaveLength(1)
      expect(rows[0]!.closest<HTMLElement>('[data-category-label]')?.dataset['categoryLabel'], query).toBe('Fonctions en option')
      expect(rows[0]!.hidden, query).toBe(false)
      expect(window.querySelector<HTMLElement>('main [data-search-best]')?.dataset['setting'], query).toBe(key)
      mounted!.unmount()
      mounted = null
    }
  })

  it('show a feature switched on in « Réglages modifiés », under « Fonctions en option », with a dot on the page in the sidebar', async () => {
    const window = await open('#home', { tabTree: true })
    expect(window.querySelector('[data-cat="features"] .settings-cat-changed')).not.toBeNull()
    await click(window.querySelector<HTMLButtonElement>('.settings-changed-link')!)
    const row = window.querySelector<HTMLElement>('main [data-category-label="Fonctions en option"] [data-setting="tabTree"]')
    expect(row).not.toBeNull()
    expect(row!.hidden).toBe(false)
    expect(row!.querySelector('.pref-changed')).not.toBeNull()
  })
})

describe('« Fonctions en option »', () => {
  it('lists the features to add, one line each in the order of the catalogue, says how many are on, and has no fold', async () => {
    const window = await open('#features', { tabTree: true })
    const lines = [...window.querySelectorAll<HTMLElement>('main .pref-feature')].map((row) => row.dataset['setting'])
    expect(lines).toEqual(catalogueFeatures().map((feature) => feature.key))
    expect(window.querySelector('main [data-mirror]')).toBeNull()
    // Each switch shows its setting: the tree of tabs switched on, the web panels off as a new profile has them.
    expect(window.querySelector<HTMLInputElement>('main .pref-feature[data-setting="tabTree"] input[role="switch"]')!.checked).toBe(true)
    expect(window.querySelector<HTMLInputElement>('main .pref-feature[data-setting="webPanels"] input[role="switch"]')!.checked).toBe(false)
    // Seven are on in a new profile (the work views and the tab reminders among them); the tree of tabs makes eight.
    expect(featuresOn(snapshotWith({ tabTree: true }).state.settings)).toBe(8)
    expect(window.querySelector('main .pref-intro')?.textContent).toBe(tp('settings.fonctions-allumees', 8, { all: 30 }))
    expect(window.querySelector('main .more-settings')?.hasAttribute('data-empty')).toBe(true)
  })

  it('writes the setting of the feature with its switch', async () => {
    const window = await open('#features')
    await click(window.querySelector<HTMLInputElement>('main .pref-feature[data-setting="webPanels"] input[role="switch"]')!)
    expect(written()).toEqual([{ webPanels: true }])
  })

  it('unfolds the whole description with « En savoir plus », and folds it again, without touching the switch', async () => {
    const window = await open('#features')
    const row = window.querySelector<HTMLElement>('main .pref-feature[data-setting="tabTree"]')!
    const toggle = row.querySelector<HTMLButtonElement>('button.pref-more-toggle')!
    const text = row.querySelector<HTMLElement>('.pref-more-text')!
    expect(toggle.getAttribute('aria-controls')).toBe(text.id)
    expect([toggle.getAttribute('aria-expanded'), text.hidden]).toEqual(['false', true])
    await click(toggle)
    expect([toggle.getAttribute('aria-expanded'), text.hidden]).toEqual(['true', false])
    expect(text.textContent).toBe(featureById('tab-tree').description)
    await click(toggle)
    expect([toggle.getAttribute('aria-expanded'), text.hidden]).toEqual(['false', true])
    expect(written()).toEqual([])
  })

  it('is reached from « Pour commencer », whose line counts the features on, and from Profils for the containers, the private tabs and the guest window', async () => {
    for (const [hash, selector] of [['#home', 'main .home-features button'], ['#profiles', 'main .profiles-features button']] as const) {
      const window = await open(hash)
      if (hash === '#home') expect(window.querySelector('main .home-features span')?.textContent).toBe(tp('settings.home-fonctions', 7, { all: 30 }))
      await click(window.querySelector<HTMLButtonElement>(selector)!)
      await settle(() => void globalThis.dispatchEvent(new HashChangeEvent('hashchange')))
      expect(current(window), hash).toBe('features')
      mounted!.unmount()
      mounted = null
    }
  })
})

describe('the addresses of before', () => {
  it('open the page that holds their place now, at the group they name', async () => {
    for (const [hash, page] of [['#general', 'home'], ['#general/about', 'about'], ['#navigation/shortcuts', 'keyboard'], ['#keyboard', 'keyboard'], ['#advanced', 'home']] as const) {
      const window = await open(hash)
      expect(current(window), hash).toBe(page)
      mounted!.unmount()
      mounted = null
    }
    const window = await open('#general/about')
    await settle()
    expect(window.querySelector('#about')?.classList.contains('pref-flash')).toBe(true)
  })
})

// « Côté de la barre latérale »: a menu of its two sides (« À gauche », « À droite ») in place of a switch « à droite », writing the same setting.
describe('the side of the sidebar', () => {
  const side = (window: HTMLElement) => window.querySelector<HTMLSelectElement>('main [data-setting="sidebarRight"]:not([data-mirror]) select')!
  const choose = (select: HTMLSelectElement, value: string) =>
    settle(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

  it('is a menu of its two sides in Apparence, on the side the setting says', async () => {
    const left = await open('#appearance')
    expect([...side(left).options].map((option) => [option.value, option.textContent])).toEqual([['false', 'À gauche'], ['true', 'À droite']])
    expect(side(left).value).toBe('false')
    expect(side(left).getAttribute('aria-label')).toBe('Côté de la barre latérale')
    expect(left.querySelector('main [data-setting="sidebarRight"] input[role="switch"]')).toBeNull()
    mounted!.unmount()
    mounted = null
    expect(side(await open('#appearance', { sidebarRight: true })).value).toBe('true')
  })

  it('writes the same setting, true on the right and false on the left', async () => {
    const window = await open('#appearance', { sidebarRight: true })
    await choose(side(window), 'false')
    expect(written()).toEqual([{ sidebarRight: false }])
  })

  it('is said by its sides in the recap of the guide', () => {
    const questions = guideQuestionsOf('all')
    const change = guidePlan(questions, defaultSettings(), { 'cote-barre': 'droite' }).items[0]!.changes[0]!
    expect([change.label, change.before, change.after]).toEqual(['Côté de la barre latérale', 'À gauche', 'À droite'])
  })
})

