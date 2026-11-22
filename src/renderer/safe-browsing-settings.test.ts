// @vitest-environment happy-dom
// The settings of safe browsing (PrivacySettings.tsx): the switch in Protection writes `safeBrowsing`, and the list of sites on the subpage of the exceptions
// adds, removes and refuses a site.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState, type Action } from '@shared/sidebar'
import { button, click, installBridge, mount, settle, type, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings>, extra: Partial<UiSnapshot> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin', ...extra } as unknown as UiSnapshot
}

async function open(hash: string, patch: Partial<Settings>, extra: Partial<UiSnapshot> = {}): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch, extra), initialQuery: '' }))
  return mounted.container
}
const patches = (): unknown[] => dispatch.mock.calls.map(([action]) => (action as { patch?: unknown }).patch)

beforeEach(() => {
  setLanguage('en')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  setLanguage('fr')
})

describe('the switch of safe browsing', () => {
  it('is off by default, and turning it on writes the setting', async () => {
    const window = await open('#protection', {})
    const row = window.querySelector('[data-setting="safeBrowsing"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Warn before opening a dangerous site')
    const box = row!.querySelector('input[type="checkbox"], [role="switch"]') as HTMLElement
    expect((box as HTMLInputElement).checked ?? box.getAttribute('aria-checked') === 'true').toBe(false)
    await click(box)
    expect(patches()).toContainEqual({ safeBrowsing: true })
  })
})

describe('the lists of safe browsing missing or unreadable', () => {
  it('says « List unavailable » (a status) while the switch is on and the lists are not there, and nothing otherwise', async () => {
    const window = await open('#protection', { safeBrowsing: true }, { safeLists: 'unavailable' })
    const status = [...window.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes('List unavailable'))
    expect(status).toBeDefined()
  })

  it('says nothing when the lists are read, when the switch is off, and when nothing is known', async () => {
    for (const [patch, extra] of [[{ safeBrowsing: true }, { safeLists: 'ready' }], [{ safeBrowsing: false }, { safeLists: 'unavailable' }], [{ safeBrowsing: true }, {}]] as const) {
      const window = await open('#protection', patch, extra as Partial<UiSnapshot>)
      expect(window.textContent).not.toContain('List unavailable')
      mounted?.unmount()
      mounted = null
    }
  })
})

describe('the sites safe browsing does not warn about', () => {
  it('lists them, adds a valid one, refuses a bad one and removes one', async () => {
    const window = await open('#protection/exceptions', { safeBrowsingExceptions: ['old.example'] })
    const group = window.querySelector('[data-setting="safeBrowsingExceptions"]') as HTMLElement
    expect(group.textContent).toContain('old.example')
    const field = group.querySelector('input') as HTMLInputElement
    type(field, 'new.example')
    await settle()
    await click(button(group, 'Add'))
    expect(patches()).toContainEqual({ safeBrowsingExceptions: ['old.example', 'new.example'] })
    await click(button(group, 'Remove'))
    expect(patches()).toContainEqual({ safeBrowsingExceptions: [] })
  })

  it('does not add an address that is not a site', async () => {
    const window = await open('#protection/exceptions', {})
    const group = window.querySelector('[data-setting="safeBrowsingExceptions"]') as HTMLElement
    type(group.querySelector('input') as HTMLInputElement, 'not a site')
    await settle()
    expect(button(group, 'Add').disabled).toBe(true)
  })
})
