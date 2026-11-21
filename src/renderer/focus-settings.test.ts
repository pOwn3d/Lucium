// @vitest-environment happy-dom
// The subpage « Mode concentration » (FocusSettings.tsx) in the Settings window: it exists only while the feature is on, its Start button writes the timer,
// and its Stop button ends it.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState, type Action } from '@shared/sidebar'
import { button, click, installBridge, mount, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings>): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

async function open(patch: Partial<Settings>): Promise<HTMLElement> {
  location.hash = '#features/focus'
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: '' }))
  return mounted.container
}
const patches = (): unknown[] => dispatch.mock.calls.map(([action]) => (action as { patch?: unknown }).patch)

beforeEach(() => {
  setLanguage('en')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  setLanguage('fr')
})

describe('the subpage of the focus mode', () => {
  it('starts the timer of the chosen length: the feature on, the end in minutes, no pause left', async () => {
    const window = await open({ focusMode: true, focusSites: ['news.example.com'], focusMinutes: 45 })
    await click(button(window, 'Start focusing'))
    expect(patches()).toContainEqual({ focusMode: true, focusUntil: 1_800_000_000_000 + 45 * 60_000, focusSnoozeUntil: 0 })
  })

  it('cannot start with no site to close', async () => {
    const window = await open({ focusMode: true, focusSites: [] })
    expect(button(window, 'Start focusing').disabled).toBe(true)
  })

  it('shows Stop while a timer runs, and Stop ends the timer and the pause', async () => {
    const window = await open({ focusMode: true, focusSites: ['news.example.com'], focusUntil: 1_800_000_000_000 + 60_000 })
    expect(() => button(window, 'Start focusing')).toThrow()
    await click(button(window, 'Stop focusing'))
    expect(patches()).toContainEqual({ focusUntil: 0, focusSnoozeUntil: 0 })
  })

  it('is not drawn while the feature is off', async () => {
    const window = await open({ focusMode: false, focusSites: ['news.example.com'] })
    expect(window.querySelector('[data-subpage="focus"]')).toBeNull()
  })
})
