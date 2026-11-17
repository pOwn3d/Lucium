// The switch of a feature (renderer/FeaturesSettings.tsx), drawn in the category it belongs to (settings-structure.test.ts finds it there). Drawn here with
// the real component and the registry of shared/features.ts (no window): what it shows comes from the registry, and what it writes is the registry's patch.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adsBlockingPatch } from '@shared/blocker'
import { setLanguage, t } from '@shared/i18n'
import { featureById, featurePatch, type FeatureId } from '@shared/features'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { elementsOf } from './render.test-support'
import { FeatureSwitch } from './FeaturesSettings'
import { frenchSpaces } from '@shared/french-typography'

const snapshotWith = (patch: Partial<Settings>): UiSnapshot => ({ state: { settings: { ...defaultSettings(), ...patch } } }) as unknown as UiSnapshot
const drawn = (id: FeatureId, patch: Partial<Settings> = {}): string => renderToStaticMarkup(createElement(FeatureSwitch, { id, snapshot: snapshotWith(patch), update: () => undefined }))
const input = (markup: string): string => /<input[^>]*role="switch"[^>]*>/.exec(markup)?.[0] ?? ''
/** What the switch writes when it is turned to `on`. */
function written(id: FeatureId, on: boolean, patch: Partial<Settings> = {}): Partial<Settings>[] {
  const updates: Partial<Settings>[] = []
  const field = elementsOf(createElement(FeatureSwitch, { id, snapshot: snapshotWith(patch), update: (change) => void updates.push(change) })).find((element) => element.type === 'input')
  ;(field!.props['onChange'] as (event: { target: { checked: boolean } }) => void)({ target: { checked: on } })
  return updates
}

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the switch of a feature', () => {
  // « Garder l’historique des pages visitées » names the feature that records nothing by its opposite: its switch showed off while the history was kept.
  it('shows the history feature as its label says it, on while the history is kept, and writes the stored setting turned around', () => {
    expect(input(drawn('history-off'))).toMatch(/checked/)
    expect(input(drawn('history-off', { historyOff: true }))).not.toMatch(/checked/)
    expect(written('history-off', false)).toEqual([{ historyOff: true }])
    expect(written('history-off', true, { historyOff: true })).toEqual([{ historyOff: false }])
  })

  it('writes the patch of the registry for a switch, so that it writes the same setting as the original pane of the feature', () => {
    expect(written('tab-tree', true)).toEqual([featurePatch('tab-tree', true)])
    expect(written('tab-tree', false, { tabTree: true })).toEqual([{ tabTree: false }])
    // A feature measured by a number writes its number, not a boolean.
    expect(written('sleep', false)).toEqual([{ sleepAfterMinutes: 0 }])
    expect(written('sleep', true, { sleepAfterMinutes: 0 })).toEqual([featurePatch('sleep', true)])
  })

  it('reads its state from the registry too, never from a setting named by hand', () => {
    expect(input(drawn('tab-tree', { tabTree: true }))).toMatch(/checked=""/)
    expect(input(drawn('tab-tree', { tabTree: false }))).not.toMatch(/checked=""/)
    expect(input(drawn('sleep', { sleepAfterMinutes: 30 }))).toMatch(/checked=""/)
    expect(input(drawn('sleep', { sleepAfterMinutes: 0 }))).not.toMatch(/checked=""/)
  })

  it('greys the switch of a feature that does nothing without another one, and says which, through the registry', () => {
    const alone = drawn('custom-filter-lists', { ...adsBlockingPatch(false), customFilterListsEnabled: false })
    expect(input(alone)).toMatch(/disabled=""/)
    const names = frenchSpaces(`« ${featureById('block-ads').label} »`)
    expect(alone).toContain(t('features-settings.sans-effet-tant-que-names-n-est-pas-active', { names }).replace(/'/g, '&#x27;'))
    // With what it needs on, it can be switched and says nothing more.
    const helped = drawn('custom-filter-lists', { blockAds: true, customFilterListsEnabled: false })
    expect(input(helped)).not.toMatch(/disabled=""/)
    expect(helped).not.toContain(names)
    // A feature already on can still be switched off.
    expect(input(drawn('custom-filter-lists', { ...adsBlockingPatch(false), customFilterListsEnabled: true }))).not.toMatch(/disabled=""/)
  })

  it('shows the lock as a switch it cannot write, with the place where it is set', () => {
    const lock = drawn('lock')
    expect(input(lock)).toMatch(/disabled=""/)
    expect(lock).toContain(t('features-settings.se-regle-dans-place', { place: featureById('lock').setIn! }).replace(/'/g, '&#x27;'))
  })

  it('draws its row with the setting of the registry as its key, so that the row is marked, costed and found like any other', () => {
    expect(drawn('tab-tree')).toMatch(/data-setting="tabTree"/)
    expect(drawn('sleep')).toMatch(/data-setting="sleepAfterMinutes"/)
  })
})
