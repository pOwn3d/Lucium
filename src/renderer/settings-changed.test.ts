// @vitest-environment happy-dom
// What has changed shows and can be undone (Réglages): the dot and « Rétablir » on a row that is not at its default, and on it only; the dot on its
// category; « Réglages modifiés », which lists them all with their control and puts them all back. A row that shows the own value of a profile other
// than the default one is not "changed": its way back is « Comme le défaut », in Profils.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings, SEARCH_ENGINES, type Settings } from '@shared/model'
import { PROTECTION_OF_EARLIER_PROFILES } from '@shared/model-defaults'
import { allModifiedKeys, isResettable, modifiedKeys, resetPlanOf } from '@shared/settings-catalog'
import { createInitialState, type Action } from '@shared/sidebar'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

/** A snapshot whose settings are the defaults and `patch`; `profile`: the space on screen uses a second profile, « Perso », with these own values. */
function snapshotWith(patch: Partial<Settings> = {}, profile?: Record<string, unknown>): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'space' })
  const settings = { ...state.settings, ...patch }
  if (profile === undefined) return { state: { ...state, settings }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
  const spaces = state.spaces.map((space) => ({ ...space, profileId: 'perso' }))
  return { state: { ...state, spaces, settings: { ...settings, profileNames: { perso: 'Perso' }, profiles: { perso: profile } } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The window at an address, mounted once the change of address has been told (the document tells it later, as a browser does). */
async function open(hash: string, snapshot: UiSnapshot, view: 'page' | 'modified' = 'page'): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot, initialView: view }))
  return mounted.container
}

/** The row of a setting, where it lives (not a mirror). */
const rowOf = (window: HTMLElement, key: string): HTMLElement => window.querySelector<HTMLElement>(`main [data-setting~="${key}"]:not([data-mirror]):not(section)`)!

/** What the window asked to write, in order. */
const written = (): Array<Partial<Settings>> => dispatch.mock.calls.map(([action]) => (action as { patch: Partial<Settings> }).patch)

const OTHER_ENGINE = SEARCH_ENGINES.find((engine) => engine.url !== defaultSettings().searchUrlTemplate)!.url

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

describe('a row that is not at its default', () => {
  it('has the dot and « Rétablir », named for its setting; a row at its default has neither', async () => {
    const window = await open('#tabs', snapshotWith({ warnBeforeQuitting: false }))
    const moved = rowOf(window, 'warnBeforeQuitting')
    expect(moved.querySelector('.pref-changed .sr-only')?.textContent).toBe('Modifié')
    expect(moved.querySelector('.pref-reset')?.getAttribute('aria-label')).toBe(t('settings.retablir-name', { name: t('settings.avertir-avant-de-quitter') }))
    expect(moved.querySelector('.pref-reset')?.textContent).toBe('Rétablir')
    const quiet = rowOf(window, 'sleepAfterMinutes')
    expect(quiet.querySelector('.pref-changed')).toBeNull()
    expect(quiet.querySelector('.pref-reset')).toBeNull()
    expect(window.querySelectorAll('main .pref-reset')).toHaveLength(1)
  })

  it('goes back to its default with « Rétablir », and « Annuler » of the notice puts the value back', async () => {
    const window = await open('#tabs', snapshotWith({ warnBeforeQuitting: false }))
    await click(rowOf(window, 'warnBeforeQuitting').querySelector('.pref-reset')!)
    expect(written()).toEqual([{ warnBeforeQuitting: true }])
    const notice = window.querySelector('.settings-toast')!
    expect(notice.textContent).toContain(t('settings.retabli', { name: t('settings.avertir-avant-de-quitter') }))
    await click([...notice.querySelectorAll('button')].find((button) => button.textContent === t('settings.annuler'))!)
    expect(written()).toEqual([{ warnBeforeQuitting: true }, { warnBeforeQuitting: false }])
  })

  it('writes the alias with the setting whose switch writes both (the ads and the trackers)', async () => {
    const plan = resetPlanOf(['blockAds'], { ...defaultSettings(), blockAds: false, blockTrackers: false })
    expect(plan?.patch).toEqual({ blockAds: true, blockTrackers: true })
    expect(plan?.undo).toEqual({ blockAds: false, blockTrackers: false })
  })

  it('offers nothing to put back for what was typed or built (a list of sites, the shortcuts), as the reset of a category leaves it', async () => {
    const window = await open('#tabs', snapshotWith({ sleepExcludedHosts: ['exemple.fr'] }))
    expect(isResettable('sleepExcludedHosts')).toBe(false)
    expect(window.querySelector('main [data-setting~="sleepExcludedHosts"] .pref-reset')).toBeNull()
    expect(window.querySelectorAll('main .pref-reset')).toHaveLength(0)
  })
})

describe('the rows a profile keeps on its own', () => {
  it('with the default profile on screen, are changed like any other row, and « Rétablir » writes the default', async () => {
    const window = await open('#navigation', snapshotWith({ searchUrlTemplate: OTHER_ENGINE }))
    const row = rowOf(window, 'searchUrlTemplate')
    expect(row.querySelector('.pref-changed')).not.toBeNull()
    await click(row.querySelector('.pref-reset')!)
    expect(written()).toEqual([{ searchUrlTemplate: defaultSettings().searchUrlTemplate }])
  })

  it('with another profile on screen, show its own value: no dot, no « Rétablir », and nothing counted or put back for them in the category', async () => {
    const snapshot = snapshotWith({ searchUrlTemplate: OTHER_ENGINE }, { searchUrlTemplate: OTHER_ENGINE })
    const window = await open('#navigation', snapshot)
    const row = rowOf(window, 'searchUrlTemplate')
    expect(row.dataset['scope']).toBe('profile')
    expect(row.querySelector('.pref-changed')).toBeNull()
    expect(row.querySelector('.pref-reset')).toBeNull()
    const settings = snapshot.state.settings
    expect(modifiedKeys('navigation', settings, 'perso')).not.toContain('searchUrlTemplate')
    expect(modifiedKeys('navigation', settings, 'default')).toContain('searchUrlTemplate')
    expect(window.querySelector('#reset-info')?.textContent).toBe(t('settings.reset-none'))
  })
})

describe('the dot of a category', () => {
  it('is on the category that holds a setting not at its default, said with how many, and on no other', async () => {
    const window = await open('#general', snapshotWith({ sleepMode: 'freeze', sleepNotify: true }))
    const dots = [...window.querySelectorAll<HTMLElement>('.settings-cat .settings-cat-changed')].map((dot) => [dot.closest<HTMLElement>('.settings-cat')!.dataset['cat'], dot.textContent])
    expect(dots).toEqual([['tabs', '2 réglages modifiés']])
    mounted!.unmount()
    expect((await open('#general', snapshotWith())).querySelector('.settings-cat-changed')).toBeNull()
  })
})

describe('« Réglages modifiés »', () => {
  const link = (window: HTMLElement) => window.querySelector<HTMLButtonElement>('.settings-changed-link')!
  /** The rows the view shows, by the settings they stand for. */
  const shownKeys = (window: HTMLElement): string[] =>
    [...window.querySelectorAll<HTMLElement>('main .settings-changed :is(.pref-row, .pref-callout, .pref-buttons, .icon-grid)')]
      .filter((row) => !row.closest('[hidden]'))
      .flatMap((row) => (row.dataset['setting'] ?? row.closest<HTMLElement>('.pref-section')?.dataset['setting'] ?? '').split(' ').filter(Boolean))

  it('is greyed out while nothing has changed, and says so', async () => {
    const window = await open('#tabs', snapshotWith())
    expect(link(window).disabled).toBe(true)
    expect(link(window).textContent).toBe(t('settings.modifies-aucun-lien'))
  })

  it('opens from the link under the categories, and shows only the changed settings, each once, with its control and the way to where it lives', async () => {
    const window = await open('#general', snapshotWith({ sleepMode: 'freeze', restoreWindows: false, interfaceAppearance: 'dark' }))
    expect(link(window).textContent).toContain('3')
    await click(link(window))
    expect(link(window).getAttribute('aria-current')).toBe('page')
    expect(window.querySelector('#pane-heading')?.textContent).toBe(t('settings.modifies-titre'))
    expect(new Set(shownKeys(window))).toEqual(new Set(['sleepMode', 'restoreWindows', 'interfaceAppearance']))
    const shownCategories = [...window.querySelectorAll<HTMLElement>('main [data-category-label]')].filter((one) => !one.hidden).map((one) => one.dataset['categoryLabel'])
    expect(shownCategories).toEqual(['Apparence', 'Onglets et fenêtres'])
    expect(rowOf(window, 'sleepMode').querySelector('.pref-open')?.textContent).toBe(t('settings.open-in', { path: 'Onglets et fenêtres › Mise en veille' }))
    expect(rowOf(window, 'sleepMode').querySelector('select')).not.toBeNull()
  })

  it('puts everything back with « Tout rétablir », and « Annuler » puts it as it was', async () => {
    const settings = { ...defaultSettings(), sleepMode: 'freeze', restoreWindows: false } as Settings
    const window = await open('#general', snapshotWith(settings), 'modified')
    await click([...window.querySelectorAll<HTMLButtonElement>('main .reset-bar button')].find((button) => button.textContent === t('settings.tout-retablir'))!)
    expect(written()).toEqual([resetPlanOf(allModifiedKeys(settings), settings)!.patch])
    expect(written()[0]).toEqual({ sleepMode: defaultSettings().sleepMode, restoreWindows: true })
    await click([...window.querySelectorAll('.settings-toast button')].find((button) => button.textContent === t('settings.annuler'))!)
    expect(written()[1]).toEqual({ sleepMode: 'freeze', restoreWindows: false })
  })

  it('shows every setting that can be put back, wherever its row lives, when all of them have changed', async () => {
    // Every switch the other way, every menu on another choice it offers: each setting the reset can put back is then changed.
    const flipped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(defaultSettings())) if (typeof value === 'boolean') flipped[key] = !value
    const settings = { ...defaultSettings(), ...flipped, sleepMode: 'freeze', interfaceAppearance: 'dark', uiScale: 120, searchUrlTemplate: OTHER_ENGINE } as Settings
    const changed = allModifiedKeys(settings)
    expect(changed.length).toBeGreaterThan(100)
    const window = await open('#general', snapshotWith(settings), 'modified')
    const shown = new Set(shownKeys(window))
    // A row drawn only in a build that carries a test channel; a row drawn only while the local translation is on (the switches are all flipped here); the update
    // switch of Windows, drawn on Windows alone (this window is a Mac's).
    const drawnOnlyWhen = new Set(['updateChannel', 'translateSystemEngine', 'windowsAutoUpdate'])
    expect(changed.filter((key) => !shown.has(key) && !drawnOnlyWhen.has(key))).toEqual([])
  })

  it('leaves for the page that was shown when a category is chosen, and when a result is opened from it', async () => {
    const window = await open('#general', snapshotWith({ restoreWindows: false }), 'modified')
    await click(rowOf(window, 'restoreWindows').querySelector<HTMLButtonElement>('.pref-open')!)
    await settle(() => void globalThis.dispatchEvent(new HashChangeEvent('hashchange')))
    expect(window.querySelector('#pane-heading')?.textContent).toBe('Onglets et fenêtres')
    expect(link(window).getAttribute('aria-current')).toBeNull()
  })
})

describe('a profile made before « Renforcée »', () => {
  // Its file names no baseline, so it reads as Standard: the protection it has is the one it began with, and nothing in the window says it changed.
  const earlier = { ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: 'standard' } as Partial<Settings>
  const link = (window: HTMLElement) => window.querySelector<HTMLButtonElement>('.settings-changed-link')!
  const dotsOf = (window: HTMLElement) => [...window.querySelectorAll<HTMLElement>('.settings-cat .settings-cat-changed')].map((dot) => [dot.closest<HTMLElement>('.settings-cat')!.dataset['cat'], dot.textContent])

  it('shows no change on the protection it never touched: no dot on a category, none on the level, none on a switch, nothing to put back', async () => {
    const window = await open('#protection', snapshotWith(earlier))
    expect(dotsOf(window)).toEqual([])
    expect(window.querySelectorAll('main .pref-changed, main .pref-reset')).toHaveLength(0)
    expect(link(window).disabled).toBe(true)
  })

  it('counts, and puts back, what it changed beside the protection, and leaves the protection as it is', async () => {
    const settings = { ...defaultSettings(), ...earlier, sleepMode: 'freeze' } as Settings
    const window = await open('#general', snapshotWith(settings), 'modified')
    expect(dotsOf(window)).toEqual([['tabs', '1 réglage modifié']])
    await click([...window.querySelectorAll<HTMLButtonElement>('main .reset-bar button')].find((button) => button.textContent === t('settings.tout-retablir'))!)
    expect(written()).toEqual([{ sleepMode: defaultSettings().sleepMode }])
  })

  it('gives back Standard, not « Renforcée », to the protection it switched on', async () => {
    const window = await open('#protection', snapshotWith({ ...earlier, blockCookieBanners: true }))
    const row = rowOf(window, 'blockCookieBanners')
    expect(row.querySelector('.pref-changed')).not.toBeNull()
    await click(row.querySelector('.pref-reset')!)
    expect(written()).toEqual([{ blockCookieBanners: false }])
  })

  it('is told apart from a profile made since, which began at « Renforcée » and shows the Standard it chose as changed', async () => {
    const window = await open('#protection', snapshotWith({ ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: 'renforcee' }))
    expect(rowOf(window, 'blockCookieBanners').querySelector('.pref-changed')).not.toBeNull()
    expect(dotsOf(window)).toEqual([['protection', '4 réglages modifiés']])
  })
})
