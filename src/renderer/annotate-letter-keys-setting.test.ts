// @vitest-environment happy-dom
// The switch of the keys of one letter of the page annotation, where the annotation settings live (Réglages › Fonctions en option): on by default, so that
// nothing changes for a person who never touches it; one click writes the setting, and it says in both languages what it does.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { clampSettings } from '@shared/sidebar-state'
import { createInitialState, type Action } from '@shared/sidebar'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

async function open(patch: Partial<Settings> = {}): Promise<HTMLElement> {
  location.hash = '#features'
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch) }))
  await settle()
  return mounted.container
}
const row = (window: HTMLElement): HTMLElement | null => window.querySelector<HTMLElement>('.pref-row[data-setting="annotateLetterKeys"]')
const switchOf = (window: HTMLElement): HTMLInputElement => row(window)!.querySelector<HTMLInputElement>('input')!

beforeEach(() => {
  setLanguage('fr')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the keys of one letter of the annotation', () => {
  it('are on by default, in a settings file that does not know the key as in a new profile', () => {
    expect(defaultSettings().annotateLetterKeys).toBe(true)
    expect(clampSettings({ ...defaultSettings(), annotateLetterKeys: undefined as never }).annotateLetterKeys).toBe(true)
    expect(clampSettings({ ...defaultSettings(), annotateLetterKeys: false }).annotateLetterKeys).toBe(false)
  })

  it('have their switch on the page of the annotation, on, and one click writes the setting', async () => {
    const window = await open()
    expect(row(window)?.textContent).toContain(t('settings.touches-d-une-lettre-pour-annoter'))
    expect(switchOf(window).checked).toBe(true)
    await click(switchOf(window))
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { annotateLetterKeys: false } })
  })

  it('show off when the setting is off, and write it back on', async () => {
    const window = await open({ annotateLetterKeys: false })
    expect(switchOf(window).checked).toBe(false)
    await click(switchOf(window))
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { annotateLetterKeys: true } })
  })

  it('say what they do in whole sentences, in French and in English, the letters of the tools and E and X included', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      expect(getLanguage()).toBe(language)
      const help = t('settings.touches-d-une-lettre-pour-annoter-aide')
      for (const letter of ['P', 'H', 'R', 'D', 'O', 'A', 'L', 'K', 'Q', 'E', 'X']) expect(help, `${language} ${letter}`).toContain(letter)
      expect(t('settings.touches-d-une-lettre-pour-annoter')).not.toBe('')
      expect(t('settings.les-lettres-choisissent-un-outil-e-et-x')).not.toBe('')
    }
    expect(t('settings.touches-d-une-lettre-pour-annoter')).toBe('One-letter keys for annotating')
  })
})
