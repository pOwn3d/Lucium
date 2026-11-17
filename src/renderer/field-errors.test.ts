// A field that refuses what was typed points at the message that says why (`aria-describedby`): the message is an alert, heard once when it
// comes, and a screen reader that comes back to the field heard « invalid » with no reason. The real forms are drawn with no window; something
// wrong is typed in their field (its own `onChange`), and the next render is read.

import { createElement, type ReactElement } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { expandedElements, rendersOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { BlockingSettings } from './BlockingSettings'
import { CookieManager } from './CookieManager'
import { CustomEngineAddress } from './CurrentProfileSettings'
import { fieldError } from './field-error'
import { GuardSettings } from './GuardSettings'
import { VimKeysSettings } from './KeyExtSettings'
import { FoldPassContext } from './settings-context'

const noop = (): void => undefined
const underLevel = (probe: ReactElement): ReactElement => createElement(FoldPassContext.Provider, { value: 'all' as const }, probe)

function snapshot(): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, vimKeys: true } }, extensions: [], downloads: [], runtime: { tabs: {} } } as unknown as UiSnapshot
}

/** The field named `label` and the alerts of a form, before anything is typed and after `typed` was typed in the field. */
function typedIn(form: ReactElement, label: string, typed: string): Array<{ field: Element | undefined; alerts: Element[] }> {
  return rendersOf(
    2,
    (pass) => {
      const elements = expandedElements(form)
      const field = elements.find((element) => element.type === 'input' && element.props['aria-label'] === label)
      if (pass === 0) (field?.props['onChange'] as (event: unknown) => void)({ target: { value: typed }, currentTarget: { value: typed } })
      return { field, alerts: elements.filter((element) => element.props['role'] === 'alert') }
    },
    underLevel
  )
}

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.snapshot = snapshot()
})
afterAll(() => vi.unstubAllGlobals())

describe('the tie between a field and its error', () => {
  it('is there only while the message is: a field never points at an element that is not drawn', () => {
    expect(fieldError('id', true)).toEqual({ field: { 'aria-invalid': true, 'aria-describedby': 'id' }, message: { id: 'id', role: 'alert' } })
    expect(fieldError('id', false).field).toEqual({ 'aria-invalid': false })
  })

  const forms = (): Array<[name: string, form: () => ReactElement, label: string]> => [
    ['the sites never blocked', () => createElement(BlockingSettings, { snapshot: snapshot(), update: noop }), 'Site à ne jamais bloquer'],
    ['the sites left out of the protection against fingerprinting', () => createElement(GuardSettings, { snapshot: snapshot(), update: noop }), 'Site à exclure de la protection contre l’empreinte'],
    ['the sites without keyboard navigation', () => createElement(VimKeysSettings, { snapshot: snapshot(), update: noop }), t('key-ext-settings.site-sans-touches-de-type-vim')],
    ['the sites whose cookies are kept', () => createElement(CookieManager), 'Ajouter un site à garder'],
    ['the address of a search engine of one’s own', () => createElement(CustomEngineAddress, { value: '', onValid: noop }), 'Adresse de recherche']
  ]

  it.each(['the sites never blocked', 'the sites left out of the protection against fingerprinting', 'the sites without keyboard navigation', 'the sites whose cookies are kept', 'the address of a search engine of one’s own'])(
    '%s: the field points at the alert once something wrong is typed, and at nothing before',
    (wanted) => {
      const [, form, label] = forms().find(([name]) => name === wanted)!
      const [before, after] = typedIn(form(), label, 'pas une adresse !')
      expect(before!.field, 'the field is drawn').toBeDefined()
      expect(before!.field!.props['aria-describedby']).toBeUndefined()
      expect(before!.field!.props['aria-invalid']).toBe(false)
      expect(after!.field!.props['aria-invalid']).toBe(true)
      const pointed = after!.field!.props['aria-describedby']
      expect(typeof pointed).toBe('string')
      expect(after!.alerts.filter((alert) => alert.props['id'] === pointed)).toHaveLength(1)
    }
  )
})
