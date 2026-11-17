// The preset of the sleep in Settings › Onglets et fenêtres (TabsSettings.tsx, `SleepSettings`): "Jamais" or one of the three levels, "Personnalisé"
// when the delay, the cap and the freeze delay were set one by one. Drawn with the real component (no window); what a choice writes is measured on
// the mounted control (preset-settings.test.ts).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { SLEEP_LEVELS } from '@shared/sleep'
import { SleepSettings } from './TabsSettings'

const snapshotWith = (patch: Partial<Settings>): UiSnapshot => ({ state: { settings: { ...defaultSettings(), ...patch } } }) as unknown as UiSnapshot
const drawn = (patch: Partial<Settings> = {}): string => renderToStaticMarkup(createElement(SleepSettings, { snapshot: snapshotWith(patch), update: () => undefined }))
const menu = (markup: string, label: string): string => new RegExp(`<select[^>]*aria-label="${label}"[^>]*>.*?</select>`).exec(markup)?.[0] ?? ''
const selected = (select: string): string | undefined => /<option value="([^"]*)"[^>]*selected=""/.exec(select)?.[1]
const LEVEL = 'Mettre en veille les onglets inactifs'
/** The buttons of the level, as `option: checked`. */
const levels = (markup: string): Record<string, boolean> => {
  const group = new RegExp(`<div class="preset-buttons" role="radiogroup" aria-label="${LEVEL}"[^>]*>(.*?)</div>`).exec(markup)?.[1] ?? ''
  return Object.fromEntries([...group.matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*data-option="([^"]+)"/g)].map((match) => [match[2]!, match[1] === 'true']))
}
const checked = (markup: string): string[] => Object.entries(levels(markup)).filter(([, on]) => on).map(([id]) => id)

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the preset of the sleep', () => {
  it('shows the level the settings make: Équilibré by default, each level, "Jamais" for the delay 0, with its line under the buttons', () => {
    expect(Object.keys(levels(drawn()))).toEqual(['jamais', 'modere', 'equilibre', 'maximal'])
    expect(checked(drawn())).toEqual(['equilibre'])
    for (const [option, values] of [['modere', SLEEP_LEVELS.moderate], ['equilibre', SLEEP_LEVELS.balanced], ['maximal', SLEEP_LEVELS.maximum]] as const) expect(checked(drawn(values)), option).toEqual([option])
    expect(checked(drawn({ sleepAfterMinutes: 0 }))).toEqual(['jamais'])
    expect(drawn()).toContain('Après 30 minutes ; 12 onglets éveillés au plus.'.replace(' ;', '\u202f;'))
    expect(drawn()).not.toContain('Personnalisé')
  })

  it('says "Personnalisé" when the values were set one by one, with no button checked', () => {
    const markup = drawn({ sleepAfterMinutes: 15 })
    expect(checked(markup)).toEqual([])
    expect(markup).toContain('<span class="preset-custom">Personnalisé</span>')
  })

  it('stays the row of the delay: the search, the anchor and the mark of a change find it under its setting', () => {
    expect(drawn()).toMatch(/<div class="pref-row preset-row"[^>]*data-setting="sleepAfterMinutes"/)
  })

  it('has the delay, the cap and the freezing as rows of their own, the last two off with the sleep', () => {
    const markup = drawn()
    expect(selected(menu(markup, 'Délai de mise en veille'))).toBe('30')
    expect(selected(menu(markup, 'Onglets éveillés en arrière-plan, au plus'))).toBe('12')
    expect(selected(menu(markup, 'Geler d’abord les onglets cachés'))).toBe('0')
    const off = drawn({ sleepAfterMinutes: 0 })
    expect(menu(off, 'Onglets éveillés en arrière-plan, au plus')).toContain('disabled=""')
    expect(menu(off, 'Geler d’abord les onglets cachés')).toContain('disabled=""')
    expect(menu(markup, 'Onglets éveillés en arrière-plan, au plus')).not.toContain('disabled=""')
  })
})
