// @vitest-environment happy-dom
// The search in the Settings window, mounted in a document: above the results, the answer for what is not a setting and the best result; Enter in the
// field opens the best result where it lives.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { installBridge, mount, type, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'
import { BEST_ATTRIBUTE } from './settings-filter'

let mounted: Mounted | null = null

function open(patch: Partial<Settings> = {}): HTMLElement {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const snapshot = { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
  mounted = mount(createElement(SettingsView, { snapshot }))
  return mounted.container
}

const field = (root: HTMLElement): HTMLInputElement => root.querySelector<HTMLInputElement>('.settings-search')!

beforeEach(() => {
  setLanguage('fr')
  location.hash = '#general'
  installBridge({})
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

// Each check opens the whole window and searches it: seconds when the whole suite shares the machine.
describe('the head of the results', { timeout: 30_000 }, () => {
  it('says where a command is when the query names one, and shows no « Rien ne correspond » under it', () => {
    const root = open()
    type(field(root), 'importer')
    const note = root.querySelector('.search-answer')
    expect(note?.getAttribute('role')).toBe('note')
    expect(note?.textContent).toContain(frenchSpaces('« Lucium › Importer depuis un autre navigateur… »'))
    type(field(root), 'page d’accueil')
    expect(root.querySelector('.search-answer')?.textContent).toContain('Lucium n’a pas de page d’accueil')
    expect(root.querySelector('.settings-empty')).toBeNull()
    // The row of the icons, whose help says « sa page d'accueil », is not shown beside the answer.
    expect(root.querySelector('.settings-results h2')?.textContent).toBe(frenchSpaces('Aucun réglage pour « page d’accueil »'))
    // A query that names nothing at all still offers words to try.
    type(field(root), 'zzqxwv')
    expect(root.querySelector('.search-answer')).toBeNull()
    expect(root.querySelector('.settings-empty')).not.toBeNull()
  })

  it('names the best result above the others, with its place', () => {
    const root = open()
    type(field(root), 'raccourci')
    const best = root.querySelector('.search-best')
    expect(best?.querySelector('.results-cat-title')?.textContent).toBe('Meilleur résultat')
    expect(best?.querySelector('.search-best-label')?.textContent).toBe('Modifier les raccourcis clavier')
    // The editor of the shortcuts is on its subpage: its place says it.
    expect(best?.querySelector('.search-best-path')?.textContent).toBe('Clavier et souris › Raccourcis clavier')
    expect(root.querySelector(`[${BEST_ATTRIBUTE}]`)?.getAttribute('data-setting')).toBe('keyBindings')
  })

  it('opens the best result with Enter: the category where it lives is shown, and the subpage it is on', () => {
    const root = open()
    type(field(root), 'proxy')
    expect(root.querySelector('.settings-results')).not.toBeNull()
    expect(root.querySelector('.search-best-path')?.textContent).toBe('Vie privée et sécurité › DNS chiffré et proxy › Proxy')
    act(() => {
      field(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(location.hash).toBe('#protection/network')
  })
})
