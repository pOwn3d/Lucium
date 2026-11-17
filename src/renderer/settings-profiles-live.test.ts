// @vitest-environment happy-dom
// Parts of the Settings mounted in a document, for what a static render cannot show: where the focus goes when a box opens, what the list of the
// profiles is for a screen reader, and what is said when a request of a row fails (a profile to create, a folder to choose, the icon to check).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState, type Action } from '@shared/sidebar'
import { DownloadDirRow } from './CurrentProfileSettings'
import { IconSettings } from './IconSettings'
import { ProfilesPane } from './SettingsProfiles'
import { dialogFirstFocus } from './settings-parts'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let warn: ReturnType<typeof vi.spyOn>
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

function snapshotWith(settings: Partial<Settings> = {}): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...settings } }, extensions: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The bridge of the window: these functions, and nothing for the rest. */
function bridge(own: Partial<LuciumApi>): void {
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
}

const choose = (select: HTMLSelectElement, value: string): void =>
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

beforeEach(() => {
  setLanguage('fr')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  dispatch = vi.fn(async () => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the focus of a box of the Settings when it opens', () => {
  const box = (html: string): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  it('goes to the first field, even when buttons come before it', () => {
    const root = box('<button class="link-button">Retirer</button><input class="field"><div class="dialog-actions"><button class="button primary">Terminé</button></div>')
    expect(dialogFirstFocus(root)).toBe(root.querySelector('input'))
  })

  it('goes to the first button of the foot in a box with no field, not to a button of its rows', () => {
    const root = box('<button class="link-button">Retirer</button><div class="dialog-actions"><button class="button">Annuler</button><button class="button primary">Tous les profils</button></div>')
    expect(dialogFirstFocus(root)?.textContent).toBe('Annuler')
    expect(dialogFirstFocus(box('<button disabled>Retirer</button>'))).toBeNull()
  })
})

describe('the list of the profiles', () => {
  const pane = (): HTMLElement => {
    bridge({ dispatch })
    mounted = mount(createElement(ProfilesPane, { snapshot: snapshotWith({ profileNames: { work: 'Travail' } }), update: () => undefined }))
    return mounted.container
  }

  it('is a group of buttons that say which one is shown, each reached with Tab: not a list of options without its arrows', async () => {
    const container = pane()
    const list = container.querySelector('.profile-list')!
    expect(list.getAttribute('role')).toBe('group')
    expect(container.querySelector('[role="listbox"], [role="option"]')).toBeNull()
    const rows = [...list.querySelectorAll('button')]
    expect(rows.map((row) => row.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    await click(rows[1]!)
    expect([...list.querySelectorAll('button')].map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })

  it('names the details of the profile shown: the name is on a group, where it is read', () => {
    const details = pane().querySelector('.profile-details')!
    expect(details.getAttribute('role')).toBe('group')
    expect(details.getAttribute('aria-label')).toBe(t('settings-profiles.profil-label', { label: t('menu.profil-par-defaut') }))
  })

  it('names the field of a new name by its label, without the technical identifier of the profile', async () => {
    const container = pane()
    await click(container.querySelectorAll('.profile-list button')[1]!)
    await click(button(container, t('settings-profiles.renommer-le-profil')))
    const field = container.querySelector<HTMLInputElement>('.dialog input.field')!
    expect(field.getAttribute('aria-label')).toBeNull()
    expect(field.closest('label')?.textContent).toBe(t('settings-profiles.nom-du-profil'))
  })

  it('says that a profile could not be created, keeps its box open and writes the error; done, the box closes on the new profile', async () => {
    const container = pane()
    await click(button(container, t('settings-profiles.ajouter-un-profil')))
    type(container.querySelector<HTMLInputElement>('.dialog input.field')!, 'Projet')
    await click(button(container, t('settings-profiles.continuer')))
    dispatch.mockRejectedValueOnce(new Error('the store is closed'))
    await click(button(container, t('settings-profiles.creer-le-profil')))
    expect(container.querySelector('.dialog [role="alert"]')?.textContent).toBe(t('settings-profiles.profil-non-cree'))
    expect(warn).toHaveBeenCalledWith('[profiles] the profile could not be created:', expect.any(Error))

    await click(button(container, t('settings-profiles.creer-le-profil')))
    expect(container.querySelector('.dialog')).toBeNull()
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'settings/update', patch: { profileNames: { work: 'Travail', projet: 'Projet' } } })
  })
})

describe('the history of a profile, said in the affirmative', () => {
  // The same setting as « Garder l’historique des pages visitées » of Vie privée et sécurité, said the same way: on while the history is kept, which is the
  // stored setting `historyOff` turned around, for the default profile (the general setting) and for another one (its own, or the default's).
  const pane = (settings: Partial<Settings>, update: (patch: Partial<Settings>) => void): HTMLElement => {
    bridge({ dispatch })
    mounted = mount(createElement(ProfilesPane, { snapshot: snapshotWith({ profileNames: { work: 'Travail' }, ...settings }), update }))
    return mounted.container
  }
  const historySwitch = (container: HTMLElement): HTMLInputElement => container.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${t('settings-profiles.garder-l-historique-de-ce-profil')}"]`)!

  it('is named « Garder l’historique de ce profil » in French and « Keep this profile’s history » in English, never in the negative', () => {
    expect(historySwitch(pane({}, () => undefined))).not.toBeNull()
    expect(t('settings-profiles.garder-l-historique-de-ce-profil')).toBe('Garder l’historique de ce profil')
    setLanguage('en')
    expect(t('settings-profiles.garder-l-historique-de-ce-profil')).toBe('Keep this profile’s history')
  })

  it('is on while the history of the default profile is kept, and writes the stored setting the other way round', async () => {
    const update = vi.fn()
    const kept = historySwitch(pane({ historyOff: false }, update))
    expect(kept.checked).toBe(true)
    await click(kept)
    expect(update).toHaveBeenLastCalledWith({ historyOff: true })
    mounted!.unmount()
    mounted = null
    const dropped = historySwitch(pane({ historyOff: true }, update))
    expect(dropped.checked).toBe(false)
    await click(dropped)
    expect(update).toHaveBeenLastCalledWith({ historyOff: false })
  })

  it('shows another profile\'s own choice and the default it follows, and keeps « Comme le défaut »', async () => {
    const update = vi.fn()
    const container = pane({ historyOff: true }, update)
    await click(container.querySelectorAll('.profile-list button')[1]!)
    // Following the default profile, whose history is not kept: off, and said to be the default's.
    expect(historySwitch(container).checked).toBe(false)
    expect(container.querySelector('.profile-details')?.textContent).toContain(t('settings-profiles.comme-le-profil-par-defaut'))
    expect([...container.querySelectorAll('.pref-inherit')]).toHaveLength(0)
    await click(historySwitch(container))
    expect(update).toHaveBeenLastCalledWith({ profiles: { work: { historyOff: false } } })
    mounted!.unmount()
    mounted = null
    // Its own choice to keep the history, against a default that does not: on, with the way back to the default.
    const own = pane({ historyOff: true, profiles: { work: { historyOff: false } } }, update)
    await click(own.querySelectorAll('.profile-list button')[1]!)
    expect(historySwitch(own).checked).toBe(true)
    await click(historySwitch(own))
    expect(update).toHaveBeenLastCalledWith({ profiles: { work: { historyOff: true } } })
    await click(button(own, t('settings-profiles.comme-le-defaut')))
    expect(update).toHaveBeenLastCalledWith({ profiles: {} })
  })
})

describe('the folder of the downloads of a profile', () => {
  it('says that the folder could not be chosen when its box cannot be opened, and writes the error', async () => {
    bridge({ chooseFolder: () => Promise.reject(new Error('no window')) })
    mounted = mount(createElement(DownloadDirRow, { snapshot: snapshotWith(), update: () => undefined, profileId: 'default', place: 'profiles' }))
    const { container } = mounted
    expect(container.querySelector('[role="alert"]')).toBeNull()
    choose(container.querySelector('select')!, 'other')
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('settings-profiles.dossier-non-choisi'))
    expect(warn).toHaveBeenCalledWith('[settings] the folder of the downloads could not be chosen:', expect.any(Error))
  })

  it('records the folder chosen, and says nothing', async () => {
    const update = vi.fn()
    bridge({ chooseFolder: async () => '/Users/moi/Documents' })
    mounted = mount(createElement(DownloadDirRow, { snapshot: snapshotWith(), update, profileId: 'default', place: 'profiles' }))
    choose(mounted.container.querySelector('select')!, 'other')
    await settle()
    expect(update).toHaveBeenCalledWith({ profiles: { default: { downloadDir: '/Users/moi/Documents' } } })
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('the icon of the application', () => {
  it('writes to the console that the icon of the Dock could not be checked', async () => {
    bridge({ appIconIssue: () => Promise.reject(new Error('no Dock')) })
    mounted = mount(createElement(IconSettings, { snapshot: snapshotWith(), update: () => undefined }))
    await settle()
    expect(warn).toHaveBeenCalledWith('[settings] the icon of the Dock could not be checked:', expect.any(Error))
    expect(mounted.container.querySelector('.pref-callout')).toBeNull()
  })

  it('says why the icon is not kept once Lucium is closed, or why the Dock could not show it, and that the application file is changed', async () => {
    bridge({ appIconIssue: () => Promise.resolve({ reason: 'bundle-not-writable' }) })
    mounted = mount(createElement(IconSettings, { snapshot: snapshotWith({ appIcon: 'sepia-or' }), update: () => undefined }))
    await settle()
    expect(mounted.container.querySelector('.pref-callout')?.textContent).toBe(t('settings.icone-paquet-non-modifiable'))
    expect(mounted.container.textContent).toContain(t('settings.icone-gardee-a-la-fermeture'))
    mounted.unmount()
    bridge({ appIconIssue: () => Promise.resolve({ reason: 'missing-picture' }) })
    mounted = mount(createElement(IconSettings, { snapshot: snapshotWith({ appIcon: 'sepia-or' }), update: () => undefined }))
    await settle()
    expect(mounted.container.querySelector('.pref-callout')?.textContent).toBe(t('settings.icone-image-introuvable-dock'))
  })
})
