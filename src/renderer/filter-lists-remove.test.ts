// @vitest-environment happy-dom
// The custom filter lists of the Settings, mounted and used. « Retirer » deletes the list with its rules, and rules that were pasted are kept
// nowhere else: it asks first. And a request the main process fails (removing a list, refreshing the lists) is said in the pane, with its cause
// in the console, instead of a button that does nothing.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { FilterListsSettings } from './BlockingSettings'
import { button, click, mount, settle, type Mounted } from './dom.test-support'

const LIST = { id: 'custom-0a1b2c3d', title: 'Mes règles', source: 'paste' as const, sourceName: 'Règles collées', enabled: true, addedAt: 1 }

let mounted: Mounted | null = null
let removeFilterList: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
let updateFilterLists: ReturnType<typeof vi.fn<() => Promise<void>>>

function pane(): HTMLElement {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const snapshot = { state: { ...state, settings: { ...state.settings, blockAds: true, customFilterListsEnabled: true, customFilterLists: [LIST] } } } as unknown as UiSnapshot
  mounted = mount(createElement(FilterListsSettings, { snapshot, update: () => undefined }))
  return mounted.container
}

const alerts = (container: Element): string[] => [...container.querySelectorAll('.pref-error[role="alert"]')].map((one) => one.textContent ?? '')

beforeEach(() => {
  removeFilterList = vi.fn(async () => undefined)
  updateFilterLists = vi.fn(async () => undefined)
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { removeFilterList, updateFilterLists }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('« Retirer » on a custom list', () => {
  it('asks before anything is removed, naming the list; « Annuler » leaves it', async () => {
    const container = pane()
    await click(button(container, t('settings.retirer')))
    expect(removeFilterList).not.toHaveBeenCalled()
    const box = container.querySelector('[role="alertdialog"]')!
    expect(box.getAttribute('aria-label')).toBe(t('blocking-settings.retirer-la-liste-name-question', { name: LIST.title }))
    expect(box.textContent).toContain(t('blocking-settings.retirer-la-liste-message'))

    await click(box.querySelector('.adlg-cancel')!)
    expect(removeFilterList).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('removes the list once the answer is yes', async () => {
    const container = pane()
    await click(button(container, t('settings.retirer')))
    const box = container.querySelector('[role="alertdialog"]')!
    await click([...box.querySelectorAll('button')].find((one) => !one.classList.contains('adlg-cancel'))!)
    expect(removeFilterList).toHaveBeenCalledWith(LIST.id)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(alerts(container)).toEqual([])
  })

  it('says that the list could not be removed when the main process fails, and writes why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('disk')
    removeFilterList.mockRejectedValue(failure)
    const container = pane()
    await click(button(container, t('settings.retirer')))
    await click([...container.querySelectorAll('[role="alertdialog"] button')].find((one) => !one.classList.contains('adlg-cancel'))!)
    await settle()
    expect(alerts(container)).toEqual([t('blocking-settings.la-liste-n-a-pas-pu-etre-retiree')])
    expect(warn).toHaveBeenCalledWith('[blocking] the custom list could not be removed:', failure)
  })
})

describe('« Mettre à jour maintenant »', () => {
  it('says that the lists could not be updated when the main process fails, and the button comes back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('offline')
    updateFilterLists.mockRejectedValue(failure)
    const container = pane()
    await click(button(container, t('blocking-settings.mettre-a-jour-maintenant')))
    await settle()
    expect(alerts(container)).toEqual([t('blocking-settings.les-listes-n-ont-pas-pu-etre-mises-a-jour')])
    expect(warn).toHaveBeenCalledWith('[blocking] the filter lists could not be updated:', failure)
    expect(button(container, t('blocking-settings.mettre-a-jour-maintenant')).disabled).toBe(false)
  })
})
