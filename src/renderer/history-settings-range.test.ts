// @vitest-environment happy-dom
// The history rows of the Settings, mounted: « Garder l'historique » writes its delay, and « Effacer une période de l'historique » clears the span
// chosen (nothing happens on the choice alone), says how many pages went, and says so when it fails.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model-defaults'
import { t, tp } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { activeProfileId } from '@shared/profiles'
import { createInitialState } from '@shared/sidebar'
import { HistorySettings } from './PrivacyExtraSettings'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'

const state = createInitialState({ now: 0, newId: () => 'x' })
const snapshot = { state: { ...state, settings: { ...defaultSettings(), ...state.settings } } } as unknown as UiSnapshot
let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

function draw(forgetHistoryRange: (...args: unknown[]) => Promise<number>) {
  const update = vi.fn()
  installBridge({ forgetHistoryRange })
  mounted = mount(createElement(HistorySettings, { snapshot, update }))
  const container = mounted.container
  const selects = (): HTMLSelectElement[] => [...container.querySelectorAll('select')]
  const named = (label: string): HTMLSelectElement => selects().find((one) => one.getAttribute('aria-label') === label)!
  const choose = (select: HTMLSelectElement, value: string) =>
    settle(() => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  const status = (): string => container.querySelector('[role="status"]')?.textContent ?? ''
  return { container, update, named, choose, status }
}

describe('the history rows of the Settings', () => {
  it('writes the delay « Garder l’historique » is given, and shows « Toujours » by default', async () => {
    const { update, named, choose } = draw(async () => 0)
    const keep = named(t('history-days.garder-l-historique'))
    expect(keep.value).toBe('0')
    expect(keep.selectedOptions[0]?.textContent).toBe(t('history-days.garder-toujours'))
    await choose(keep, '90')
    expect(update).toHaveBeenCalledWith({ historyKeepDays: 90 })
  })

  it('clears nothing on the choice alone, and the span chosen, in the profile on screen, when the button is pressed', async () => {
    const forget = vi.fn(async (..._args: unknown[]) => 12)
    const { container, named, choose, status } = draw(forget)
    await choose(named(t('history-days.effacer-periode-reglages')), 'week')
    expect(forget).not.toHaveBeenCalled()
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === t('history-days.effacer-periode-bouton'))!)
    expect(forget).toHaveBeenCalledWith('week', activeProfileId(state))
    expect(status()).toBe(tp('history-days.periode-oubliee-comptee', 12))
  })

  it('says so, and logs it, when the span could not be cleared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { container, status } = draw(async () => Promise.reject(new Error('disk')))
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === t('history-days.effacer-periode-bouton'))!)
    expect(status()).toBe(t('history-days.periode-echec'))
    expect(warn).toHaveBeenCalledWith('[history] the period could not be forgotten:', expect.any(Error))
    warn.mockRestore()
  })
})
