// @vitest-environment happy-dom
// The presets in their pages (Réglages): the level of protection at the top of Vie privée et sécurité, « Quand vous ouvrez Lucium » at the top of
// Onglets et fenêtres › Au lancement, « Liens venus d’autres applications » at the top of Navigation › Liens, the sleep in its group, and the four again
// on « Pour commencer »; the settings they write wait in « Plus de réglages », each with its own switch and its own marks, but four switches of the
// protection, drawn under it. A preset row shows a change and « Rétablir » for every setting it writes, and the notice of a choice counts the rows the
// page folds.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { PROTECTION_OF_EARLIER_PROFILES, PROTECTION_OF_NEW_PROFILES } from '@shared/model-defaults'
import { createInitialState, type Action } from '@shared/sidebar'
import { click, installBridge, mount, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'space' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The window at an address, mounted once the change of address has been told. */
async function open(hash: string, patch: Partial<Settings> = {}): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch) }))
  return mounted.container
}

const written = (): Array<Partial<Settings>> => dispatch.mock.calls.map(([action]) => (action as { patch: Partial<Settings> }).patch)
/** The row of a preset where it lives (not its mirror), by what it stands for: its setting or its search id. */
const presetRow = (window: HTMLElement, mark: string): HTMLElement => window.querySelector<HTMLElement>(`main .preset-row:is([data-setting="${mark}"], [data-search="${mark}"]):not([data-mirror])`)!
/** Whether an element waits in « Plus de réglages ». */
const folded = (element: Element | null): boolean => element?.closest('.more-settings-body') !== null && element !== null
/** The title of the group an element is drawn in. */
const groupOf = (element: Element): string => element.closest('.pref-section')?.querySelector('h3 .pref-title')?.textContent ?? ''
const switchOf = (window: HTMLElement, label: string): HTMLInputElement => [...window.querySelectorAll<HTMLInputElement>('main input[role="switch"]')].find((one) => one.getAttribute('aria-label') === label)!
const notice = (row: HTMLElement): string => row.querySelector('.preset-notice')?.textContent ?? ''

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

describe('where the presets are drawn', () => {
  it('puts the level of protection at the top of Vie privée et sécurité, four of its switches under it, and the five others in « Plus de réglages »', async () => {
    const window = await open('#protection')
    const row = presetRow(window, 'protectionLevel')
    expect(folded(row)).toBe(false)
    expect(groupOf(row)).toBe('Protection')
    expect(row.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Niveau de protection')
    // The first group of the page.
    expect(window.querySelector('main .pref-section')?.contains(row)).toBe(true)
    for (const key of ['blockAds', 'blockCookieBanners', 'stripTrackingParams', 'reduceFingerprint']) {
      const own = window.querySelector(`main [data-setting="${key}"]`)!
      expect(folded(own), key).toBe(false)
      expect(own.querySelector('input[role="switch"]'), key).not.toBeNull()
      expect(row.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING, key).toBeTruthy()
    }
    for (const key of ['blockMode', 'blockCosmetic', 'blockScriptlets', 'sendGpc', 'stripCopiedLinks']) {
      expect(folded(window.querySelector(`main [data-setting~="${key}"]`)), key).toBe(true)
    }
  })

  it('puts « Quand vous ouvrez Lucium » first in Onglets et fenêtres, and the switches of the windows and of the tabs at the launch in the fold', async () => {
    const window = await open('#tabs')
    const row = presetRow(window, 'restoreWindows')
    expect(folded(row)).toBe(false)
    expect(groupOf(row)).toBe('Au lancement')
    expect(window.querySelector('main .pref-section')?.contains(row)).toBe(true)
    expect(row.querySelector<HTMLSelectElement>('select.preset-menu')?.getAttribute('aria-label')).toBe('Quand vous ouvrez Lucium')
    for (const label of ['Rouvrir les fenêtres de la session précédente', 'Charger tous les onglets au lancement']) {
      expect(folded(switchOf(window, label)), label).toBe(true)
      expect(groupOf(switchOf(window, label)), label).toBe('Au lancement')
    }
    // The sleep keeps its preset at the top of its group, its delay in the fold.
    expect(folded(presetRow(window, 'sleepAfterMinutes'))).toBe(false)
    expect(folded(window.querySelector('main select[aria-label="Délai de mise en veille"]'))).toBe(true)
  })

  it('puts « Liens venus d’autres applications » at the top of Navigation › Liens, and its two switches in the fold', async () => {
    const window = await open('#navigation')
    const row = presetRow(window, 'externalLinksInLittleArc')
    expect(folded(row)).toBe(false)
    expect(groupOf(row)).toBe('Liens')
    // The switch of the links of other apps waits under the same title; the one of the links that open a new tab is the first option of the mini window.
    expect(folded(switchOf(window, 'Ouvrir les liens d’autres applications dans une mini-fenêtre'))).toBe(true)
    expect(groupOf(switchOf(window, 'Ouvrir les liens d’autres applications dans une mini-fenêtre'))).toBe('Liens')
    expect(folded(window.querySelector('main [data-setting="littleArcNewTabLinks"]'))).toBe(true)
  })

  it('draws the four again on « Pour commencer », as mirrors, where the switches of the ads, of the windows and of the links were', async () => {
    const window = await open('#home')
    const mirrors = [...window.querySelectorAll<HTMLElement>('main .preset-row[data-mirror]')].map((row) => row.dataset['search'] ?? row.dataset['setting'])
    expect(mirrors).toEqual(['protectionLevel', 'externalLinksInLittleArc', 'restoreWindows', 'sleepAfterMinutes'])
    for (const label of ['Bloquer les publicités et les traqueurs', 'Rouvrir les fenêtres de la session précédente', 'Ouvrir les liens d’autres applications dans une mini-fenêtre']) {
      expect(switchOf(window, label), label).toBeUndefined()
    }
  })
})

describe('the notice of a choice', () => {
  it('counts the rows the page keeps in « Plus de réglages »: two of four for the protection « Standard », GPC and the copied links', async () => {
    const window = await open('#protection')
    const row = presetRow(window, 'protectionLevel')
    await click(row.querySelector('[role="radio"][data-option="standard"]')!)
    expect(written()).toEqual([PROTECTION_OF_EARLIER_PROFILES])
    expect(notice(row)).toBe(frenchSpaces('4 réglages ont changé, dont 2 dans « Plus de réglages ».Annuler'))
  })

  it('counts two of three for « Stricte »: the mode and the extended rules wait, the fingerprint is under the level', async () => {
    const window = await open('#protection')
    const row = presetRow(window, 'protectionLevel')
    await click(row.querySelector('[role="radio"][data-option="stricte"]')!)
    expect(written()).toEqual([{ blockMode: 'strict', blockScriptlets: true, reduceFingerprint: true }])
    expect(notice(row)).toBe(frenchSpaces('3 réglages ont changé, dont 2 dans « Plus de réglages ».Annuler'))
  })

  it('counts the one switch that waits in the fold, and not the row the preset stands for, which it shows itself', async () => {
    const window = await open('#tabs')
    const row = presetRow(window, 'restoreWindows')
    const menu = row.querySelector<HTMLSelectElement>('select.preset-menu')!
    const choose = (value: string) =>
      act(() => {
        menu.value = value
        menu.dispatchEvent(new Event('change', { bubbles: true }))
      })
    choose('tous')
    expect(written()).toEqual([{ loadAllTabsAtLaunch: true }])
    expect(notice(row)).toBe(frenchSpaces('1 réglage a changé, dans « Plus de réglages ».Annuler'))
  })
})

describe('what has changed', () => {
  it('shows nothing on a preset of a new profile, in its page and on « Pour commencer »', async () => {
    for (const hash of ['#protection', '#tabs', '#navigation', '#home']) {
      const window = await open(hash)
      const rows = [...window.querySelectorAll('main .preset-row')]
      expect(rows.length, hash).toBeGreaterThan(0)
      expect(rows.filter((row) => row.querySelector('.pref-changed, .pref-reset')), hash).toEqual([])
      mounted!.unmount()
      mounted = null
    }
  })

  it('marks the level of a profile made since « Renforcée » that chose Standard, and « Rétablir » gives it the level of a new profile, which « Annuler » takes back', async () => {
    const window = await open('#protection', PROTECTION_OF_EARLIER_PROFILES)
    const row = presetRow(window, 'protectionLevel')
    expect(row.querySelector('.pref-changed .sr-only')?.textContent).toBe('Modifié')
    const reset = row.querySelector<HTMLButtonElement>('.pref-reset')!
    expect(reset.getAttribute('aria-label')).toBe(t('settings.retablir-name', { name: 'Niveau de protection' }))
    await click(reset)
    expect(written()).toEqual([PROTECTION_OF_NEW_PROFILES])
    const toast = window.querySelector('.settings-toast')!
    expect(toast.textContent).toContain(t('settings.retabli', { name: 'Niveau de protection' }))
    await click([...toast.querySelectorAll('button')].find((button) => button.textContent === t('settings.annuler'))!)
    expect(written()[1]).toEqual(PROTECTION_OF_EARLIER_PROFILES)
  })

  it('shows no change on the level of a profile made before « Renforcée », which Standard is the level it began with, and gives it back Standard after a choice of « Renforcée »', async () => {
    const earlier = { ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: 'standard' } as const
    for (const hash of ['#protection', '#home']) {
      const window = await open(hash, earlier)
      const row = window.querySelector<HTMLElement>('main .preset-row[data-search="protectionLevel"]')!
      expect(row.querySelector('.pref-changed, .pref-reset'), hash).toBeNull()
      mounted!.unmount()
      mounted = null
    }
    // It chose « Renforcée » by hand: that is a change from where it began, and « Rétablir » goes back to Standard.
    const window = await open('#protection', { ...PROTECTION_OF_NEW_PROFILES, protectionBaseline: 'standard' })
    const row = presetRow(window, 'protectionLevel')
    expect(row.querySelector('.pref-changed .sr-only')?.textContent).toBe('Modifié')
    await click(row.querySelector('.pref-reset')!)
    expect(written()).toEqual([PROTECTION_OF_EARLIER_PROFILES])
  })

  it('marks a preset set by hand (« Personnalisé ») though the setting its row stands for is at its default, and puts back the one that moved', async () => {
    const window = await open('#tabs', { sleepAwakeMax: 20 })
    const row = presetRow(window, 'sleepAfterMinutes')
    expect(row.querySelector('.preset-custom')).not.toBeNull()
    expect(row.querySelector('.pref-changed')).not.toBeNull()
    await click(row.querySelector('.pref-reset')!)
    expect(written()).toEqual([{ sleepAwakeMax: 12 }])
  })

  it('keeps the dot and « Rétablir » on the switch a preset row stands for, in the fold, for that setting alone', async () => {
    const window = await open('#tabs', { restoreWindows: false, loadAllTabsAtLaunch: true })
    const own = switchOf(window, 'Rouvrir les fenêtres de la session précédente').closest<HTMLElement>('.pref-row')!
    expect(own.querySelector('.pref-changed')).not.toBeNull()
    await click(own.querySelector('.pref-reset')!)
    expect(written()).toEqual([{ restoreWindows: true }])
    // The preset row puts back both.
    await click(presetRow(window, 'restoreWindows').querySelector('.pref-reset')!)
    expect(written()[1]).toEqual({ restoreWindows: true, loadAllTabsAtLaunch: false })
  })

  it('keeps them on the menu of the delay of the sleep and on the switch of the links of other apps as well', async () => {
    const tabs = await open('#tabs', { sleepAfterMinutes: 15 })
    const delay = tabs.querySelector('main select[aria-label="Délai de mise en veille"]')!.closest<HTMLElement>('.pref-row')!
    expect(delay.querySelector('.pref-changed')).not.toBeNull()
    await click(delay.querySelector('.pref-reset')!)
    expect(written()).toEqual([{ sleepAfterMinutes: 30 }])
    mounted!.unmount()
    mounted = null
    const navigation = await open('#navigation', { externalLinksInLittleArc: false })
    const links = switchOf(navigation, 'Ouvrir les liens d’autres applications dans une mini-fenêtre').closest<HTMLElement>('.pref-row')!
    expect(links.querySelector('.pref-changed')).not.toBeNull()
    await click(links.querySelector('.pref-reset')!)
    expect(written()[1]).toEqual({ externalLinksInLittleArc: true })
  })
})
