// @vitest-environment happy-dom
// The filter « Toutes / Allumées / Coupées » of « Fonctions en option », in the window mounted in a document: each choice keeps the lines of the features in
// one state, in the order of the themes, and says how many it shows; the arrows choose; a search, « Réglages modifiés » and a result that leads to a line
// it hides are never filtered.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { featureById, isFeatureOn, type FeatureId } from '@shared/features'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { CATALOGUE_FEATURES } from '@shared/settings-catalog'
import { createInitialState } from '@shared/sidebar'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null

/** A few features on, the others at their default (off). */
const ON: Partial<Settings> = { notes: true, tabTree: true, qrCode: true }

const snapshotWith = (patch: Partial<Settings>): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

async function open(hash: string, patch: Partial<Settings> = ON, query = ''): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: query }))
  await settle()
  return mounted.container
}

/** The address changes as a browser changes it, and tells it. */
async function goTo(hash: string): Promise<void> {
  location.hash = hash
  await settle(() => void globalThis.dispatchEvent(new HashChangeEvent('hashchange')))
}

const radios = (window: HTMLElement) => [...window.querySelectorAll<HTMLButtonElement>('main .features-filter [role="radio"]')]
const radio = (window: HTMLElement, filter: string) => window.querySelector<HTMLButtonElement>(`main .features-filter [data-filter="${filter}"]`)!
const checked = (window: HTMLElement) => radios(window).find((one) => one.getAttribute('aria-checked') === 'true')?.dataset['filter']
const told = (window: HTMLElement) => window.querySelector('main [aria-live="polite"]')?.textContent

/** The catalogue features whose line the page draws, in the order drawn. */
function linesShown(window: HTMLElement): FeatureId[] {
  const keys = [...window.querySelectorAll<HTMLElement>('main .pref-row[data-setting]')].map((row) => row.dataset['setting'])
  return CATALOGUE_FEATURES.filter((id) => keys.includes(featureById(id).key)).sort((a, b) => keys.indexOf(featureById(a).key) - keys.indexOf(featureById(b).key))
}

const settings = { ...defaultSettings(), ...ON } as Settings
const onIds = CATALOGUE_FEATURES.filter((id) => isFeatureOn(settings, id))
const offIds = CATALOGUE_FEATURES.filter((id) => !isFeatureOn(settings, id))

beforeEach(() => {
  setLanguage('fr')
  installBridge({})
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the filter of « Fonctions en option »', () => {
  it('is a group of three radio buttons above the catalogue, on « Toutes », one stop of Tab', async () => {
    const window = await open('#features')
    const group = window.querySelector('main .features-filter')!
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe('Afficher les fonctions')
    expect(radios(window).map((one) => one.textContent)).toEqual(['Toutes', 'Allumées', 'Coupées'])
    expect(checked(window)).toBe('all')
    expect(radios(window).map((one) => one.tabIndex)).toEqual([0, -1, -1])
    // Above the catalogue: before the first group of a theme.
    expect(group.compareDocumentPosition(window.querySelector('main .pref-section')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(linesShown(window)).toEqual([...CATALOGUE_FEATURES])
  })

  it('« Allumées » keeps the lines of the features on, in the order of the themes, and says how many', async () => {
    expect(onIds.length).toBeGreaterThan(1)
    const window = await open('#features')
    await click(radio(window, 'on'))
    expect(checked(window)).toBe('on')
    expect(linesShown(window)).toEqual(onIds)
    expect(told(window)).toBe(`${onIds.length} fonctions affichées sur ${CATALOGUE_FEATURES.length}.`)
  })

  it('« Coupées » keeps the lines of the features off, and a theme with none left is not drawn', async () => {
    const window = await open('#features')
    await click(radio(window, 'off'))
    expect(linesShown(window)).toEqual(offIds)
    expect(told(window)).toBe(`${offIds.length} fonctions affichées sur ${CATALOGUE_FEATURES.length}.`)
    expect([...window.querySelectorAll('main .pref-section')].every((section) => section.querySelector('.pref-row'))).toBe(true)
    await click(radio(window, 'all'))
    expect(linesShown(window)).toEqual([...CATALOGUE_FEATURES])
    expect(told(window)).toBe(`${CATALOGUE_FEATURES.length} fonctions affichées sur ${CATALOGUE_FEATURES.length}.`)
  })

  it('is driven by the arrows, Home and End: the focus and the choice move together', async () => {
    const window = await open('#features')
    const press = async (key: string) => {
      const at = document.activeElement as HTMLElement
      await act(async () => void at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
    }
    radio(window, 'all').focus()
    await press('ArrowRight')
    expect(checked(window)).toBe('on')
    expect((document.activeElement as HTMLElement).dataset['filter']).toBe('on')
    expect(linesShown(window)).toEqual(onIds)
    await press('End')
    expect(checked(window)).toBe('off')
    expect(linesShown(window)).toEqual(offIds)
    await press('Home')
    expect(checked(window)).toBe('all')
    expect(radios(window).map((one) => one.tabIndex)).toEqual([0, -1, -1])
  })

  it('goes back to « Toutes » when a result leads to a line it hides, which is then shown and lit', async () => {
    const window = await open('#features')
    await click(radio(window, 'on'))
    const hidden = offIds[0]!
    const key = featureById(hidden).key
    expect(window.querySelector(`main [data-setting~="${key}"]`)).toBeNull()
    // A search for its name, then its result.
    const field = window.querySelector<HTMLInputElement>('.settings-search')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, featureById(hidden).label)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const result = [...window.querySelectorAll<HTMLButtonElement>('main .pref-open')].find((button) => button.closest(`[data-setting~="${key}"]`))
    expect(result).toBeDefined()
    await click(result!)
    await settle()
    expect(checked(window)).toBe('all')
    expect(window.querySelector(`main [data-setting~="${key}"]`)?.classList.contains('pref-flash')).toBe(true)
  })

  it('goes back to « Toutes » on another page and back, and stays as chosen on the way to a subpage of the catalogue and back', async () => {
    const window = await open('#features', { ...ON, tabContainers: true })
    await click(radio(window, 'on'))
    await goTo('#features/containers')
    await goTo('#features')
    expect(checked(window)).toBe('on')
    await goTo('#tabs')
    await goTo('#features')
    expect(checked(window)).toBe('all')
  })

  it('keeps the line of a feature turned off under « Allumées », with the focus on its switch, until the filter changes', async () => {
    const window = await open('#features')
    await click(radio(window, 'on'))
    const key = featureById('notes').key
    const toggle = window.querySelector<HTMLInputElement>(`main .pref-row[data-setting~="${key}"] input[type="checkbox"]`)!
    toggle.focus()
    // The switch writes the setting; the window is drawn again when it arrives.
    mounted!.rerender(createElement(SettingsView, { snapshot: snapshotWith({ ...ON, notes: false }) }))
    expect(linesShown(window)).toContain('notes')
    expect(document.activeElement).toBe(toggle)
    expect(told(window)).toBe(`${onIds.length} fonctions affichées sur ${CATALOGUE_FEATURES.length}.`)
    // Chosen again, the filter keeps what is on now.
    await click(radio(window, 'off'))
    await click(radio(window, 'on'))
    expect(linesShown(window)).not.toContain('notes')
  })

  it('keeps under « Coupées » the line of a feature turned on, and under « Allumées » the summary turned off', async () => {
    const window = await open('#features', { ...ON, aiSummary: true })
    await click(radio(window, 'off'))
    const off = offIds.find((id) => featureById(id).key !== 'aiSummary')!
    mounted!.rerender(createElement(SettingsView, { snapshot: snapshotWith({ ...ON, aiSummary: true, [featureById(off).key]: true }) }))
    expect(linesShown(window)).toContain(off)
    await click(radio(window, 'on'))
    const summary = () => window.querySelector('main .pref-section[data-setting~="aiSummary"]')
    expect(summary()).not.toBeNull()
    mounted!.rerender(createElement(SettingsView, { snapshot: snapshotWith({ ...ON, aiSummary: false }) }))
    expect(summary()).not.toBeNull()
  })

  it('is not drawn in a search nor in « Réglages modifiés », which show every line', async () => {
    const searching = await open('#features', ON, 'notes')
    expect(searching.querySelector('.features-filter')).toBeNull()
    mounted!.unmount()
    mounted = null
    const window = await open('#features')
    await click(radio(window, 'off'))
    await click(window.querySelector<HTMLButtonElement>('.settings-changed-link')!)
    expect(window.querySelector('.features-filter')).toBeNull()
    for (const id of onIds) expect(window.querySelector(`main [data-setting~="${featureById(id).key}"]`), id).not.toBeNull()
  })
})
