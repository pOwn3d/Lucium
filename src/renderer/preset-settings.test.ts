// @vitest-environment happy-dom
// The preset control, mounted (PresetSettings.tsx): what a click, the arrows and the menu write, « Personnalisé », the notice of a choice with its
// count and its « Annuler » for 8 s (it waits while the pointer or the focus is on it), and the rows it lights. The settings come back from the « main process » when the test draws them again, as a
// snapshot does; until then the control works from what it wrote.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings } from '@shared/model'
import { PROTECTION_OF_EARLIER_PROFILES } from '@shared/model-defaults'
import { clampSettings } from '@shared/sidebar-state'
import { SLEEP_LEVELS } from '@shared/sleep'
import type { PresetId } from '@shared/settings-presets'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { PresetControl, PresetRow } from './PresetSettings'
import { FLASH_MS } from './settings-anchor'
import { button, click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'
import settingsCss from './settings.css?raw'

let mounted: Mounted | null = null
let settings: Settings
let written: Partial<Settings>[]

/** Mounts the control of a preset over `start`; `isFolded` says which rows the page keeps out of sight. */
function draw(preset: PresetId, start: Settings, isFolded?: (key: keyof Settings) => boolean): HTMLElement {
  settings = start
  written = []
  const element = () => createElement(PresetControl, { preset, settings, update: (patch: Partial<Settings>) => void written.push(patch), isFolded })
  mounted = mount(element())
  redraw = () => mounted!.rerender(element())
  return mounted.container
}
let redraw = (): void => undefined
/** The main process answers: what was written is in the settings, and the control is drawn with them. */
function answer(): void {
  settings = clampSettings(written.reduce<Settings>((all, patch) => ({ ...all, ...patch }), settings))
  written = []
  redraw()
}

const radio = (root: Element, option: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>(`[role="radio"][data-option="${option}"]`)!
const checkedOptions = (root: Element): string[] => [...root.querySelectorAll('[role="radio"][aria-checked="true"]')].map((element) => element.getAttribute('data-option')!)
const effect = (root: Element): string => root.querySelector('.preset-effect')!.textContent ?? ''
const notice = (root: Element): string => root.querySelector('.preset-notice')!.textContent ?? ''
const key = (target: Element, name: string): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))
const merged = (): Partial<Settings> => Object.assign({}, ...written) as Partial<Settings>

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('a choice', () => {
  it('writes the values of the option, shows it checked at once with its line, before the settings come back', async () => {
    const root = draw('veille', defaultSettings())
    expect(checkedOptions(root)).toEqual(['equilibre'])
    await click(radio(root, 'maximal'))
    expect(written).toEqual([SLEEP_LEVELS.maximum])
    expect(checkedOptions(root)).toEqual(['maximal'])
    expect(effect(root)).toBe(frenchSpaces('Après 10 minutes ; 6 éveillés au plus, gelés dès 5 minutes.'))
    await click(radio(root, 'jamais'))
    expect(written[1]).toEqual({ sleepAfterMinutes: 0 })
  })

  it('writes nothing for the option the settings already are', async () => {
    const root = draw('liens', defaultSettings())
    await click(radio(root, 'mini'))
    expect(written).toEqual([])
    expect(notice(root)).toBe('')
  })

  it('reads « Personnalisé » when the settings are none of the options: no button checked, the first one reached by Tab, the line says why', () => {
    const root = draw('protection', clampSettings({ ...defaultSettings(), blockScriptlets: true }))
    expect(checkedOptions(root)).toEqual([])
    expect([...root.querySelectorAll('[role="radio"]')].map((element) => element.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(effect(root)).toBe(frenchSpaces('Personnalisé Vos réglages ne correspondent à aucun niveau : ils restent tels que vous les avez choisis.'))
    expect(root.querySelector('[role="radiogroup"]')!.getAttribute('aria-describedby')).toBe(root.querySelector('.preset-effect')!.id)
  })

  it('is a menu for the launch, « Personnalisé » shown but not offered, and a choice writes its two settings', () => {
    const root = draw('lancement', clampSettings({ ...defaultSettings(), restoreWindows: false, loadAllTabsAtLaunch: true }))
    const menu = root.querySelector<HTMLSelectElement>('select.preset-menu')!
    expect(menu.value).toBe('custom')
    expect(menu.querySelector('option[value="custom"]')!.hasAttribute('disabled')).toBe(true)
    act(() => {
      menu.value = 'tous'
      menu.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(written).toEqual([{ restoreWindows: true }])
    answer()
    expect(menu.value).toBe('tous')
    expect(menu.querySelector('option[value="custom"]')).toBeNull()
  })
})

describe('the keyboard', () => {
  it('moves through the options with the arrows, Home and End, and chooses as it moves, the focus on the option chosen', () => {
    const root = draw('veille', defaultSettings())
    radio(root, 'equilibre').focus()
    key(radio(root, 'equilibre'), 'ArrowRight')
    expect(checkedOptions(root)).toEqual(['maximal'])
    expect(document.activeElement).toBe(radio(root, 'maximal'))
    key(radio(root, 'maximal'), 'ArrowRight')
    expect(checkedOptions(root)).toEqual(['jamais'])
    key(radio(root, 'jamais'), 'End')
    expect(checkedOptions(root)).toEqual(['maximal'])
    key(radio(root, 'maximal'), 'Home')
    expect(checkedOptions(root)).toEqual(['jamais'])
    expect([...root.querySelectorAll('[role="radio"]')].map((element) => element.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
  })

  it('builds each choice on the one before when the settings have not come back yet: back where it started, nothing is left changed', () => {
    const start = defaultSettings()
    const root = draw('protection', start)
    radio(root, 'renforcee').focus()
    key(radio(root, 'renforcee'), 'ArrowRight')
    key(radio(root, 'stricte'), 'ArrowLeft')
    expect(clampSettings({ ...start, ...merged() })).toEqual(start)
    expect(notice(root)).toBe('')
  })
})

describe('the notice of a choice', () => {
  it('says how many settings changed and how many are folded, and « Annuler » puts back exactly the settings there were', async () => {
    const start = defaultSettings()
    const root = draw('protection', start, (setting) => setting === 'stripCopiedLinks')
    await click(radio(root, 'standard'))
    expect(written).toEqual([{ ...PROTECTION_OF_EARLIER_PROFILES }])
    expect(root.querySelector('.preset-notice')!.getAttribute('role')).toBe('status')
    expect(notice(root)).toBe(frenchSpaces('4 réglages ont changé, dont 1 dans « Plus de réglages ».Annuler'))
    answer()
    await click(button(root, 'Annuler'))
    answer()
    expect(settings).toEqual(start)
    expect(notice(root)).toBe('Réglages remis comme avant.')
    expect(root.querySelector('.preset-notice button')).toBeNull()
  })

  it('undoes every choice made while it showed, back to before the first', async () => {
    const start = clampSettings({ ...defaultSettings(), ...PROTECTION_OF_EARLIER_PROFILES })
    const root = draw('protection', start)
    await click(radio(root, 'renforcee'))
    answer()
    await click(radio(root, 'stricte'))
    answer()
    expect(notice(root)).toContain('7 réglages ont changé.')
    await click(button(root, 'Annuler'))
    answer()
    expect(settings).toEqual(start)
  })

  it('goes after 8 s, and with it the « Annuler » of that choice: the next one starts afresh', async () => {
    vi.useFakeTimers()
    const root = draw('liens', defaultSettings())
    await click(radio(root, 'onglet'))
    answer()
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 1))
    expect(notice(root)).toContain('2 réglages ont changé.')
    act(() => void vi.advanceTimersByTime(1))
    expect(notice(root)).toBe('')
    await click(radio(root, 'mini'))
    answer()
    await click(button(root, 'Annuler'))
    expect(written).toEqual([{ externalLinksInLittleArc: false, littleArcNewTabLinks: false }])
  })

  it('waits while the focus is on « Annuler », and goes with the time it had left when the focus leaves', async () => {
    vi.useFakeTimers()
    const root = draw('liens', defaultSettings())
    await click(radio(root, 'onglet'))
    act(() => void vi.advanceTimersByTime(3000))
    button(root, 'Annuler').focus()
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 4))
    expect(notice(root)).toContain('Annuler')
    act(() => radio(root, 'onglet').focus())
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 3000 - 1))
    expect(notice(root)).toContain('Annuler')
    act(() => void vi.advanceTimersByTime(1))
    expect(notice(root)).toBe('')
  })

  it('waits while the pointer is on it, and the pointer leaving a notice that still has the focus lets nothing go', async () => {
    vi.useFakeTimers()
    const root = draw('liens', defaultSettings())
    await click(radio(root, 'onglet'))
    const bubble = root.querySelector<HTMLElement>('.preset-notice')!
    pointerOver(bubble)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 4))
    expect(notice(root)).toContain('Annuler')
    button(root, 'Annuler').focus()
    pointerOut(bubble)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 4))
    expect(notice(root)).toContain('Annuler')
    act(() => radio(root, 'onglet').focus())
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS))
    expect(notice(root)).toBe('')
  })
})

describe('the rows a choice changed', () => {
  it('are lit once, for as long as a row found by the search is', async () => {
    vi.useFakeTimers()
    const rows = ['sendGpc', 'stripTrackingParams', 'blockMode'].map((setting) => {
      const row = document.createElement('div')
      row.className = 'pref-row'
      row.dataset['setting'] = setting
      document.body.append(row)
      return row
    })
    const root = draw('protection', defaultSettings())
    await click(radio(root, 'standard'))
    expect(rows.map((row) => row.classList.contains('pref-flash'))).toEqual([true, true, false])
    act(() => void vi.advanceTimersByTime(FLASH_MS))
    expect(rows.map((row) => row.classList.contains('pref-flash'))).toEqual([false, false, false])
  })

  it('are lit without motion when the system asks for less: the light of a row stands still', () => {
    expect(settingsCss.replace(/\s+/g, ' ')).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.pref-flash \{ animation: none;/)
  })
})

describe('the whole row', () => {
  it('names the preset above its control, and marks a copy of a row of another category', () => {
    mounted = mount(createElement(PresetRow, { preset: 'protection', settings: defaultSettings(), update: () => undefined, mirror: true }))
    const row = mounted.container.querySelector('.pref-row.preset-row')!
    expect(row.querySelector('.pref-label')!.textContent).toBe('Niveau de protection')
    expect(row.hasAttribute('data-mirror')).toBe(true)
    expect(row.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Niveau de protection')
    expect(checkedOptions(row)).toEqual(['renforcee'])
  })
})
