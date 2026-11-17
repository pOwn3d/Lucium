// @vitest-environment happy-dom
// The welcome of the first launch asks the system whether Lucium is the default browser, and asks again when the user comes back to the window: on
// Windows the choice is made in the system Settings, which the button opens, so the sheet must follow it without a click.

import { act } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, bridge: {} as Record<string, (...args: unknown[]) => unknown> }))
vi.mock('./root', () => ({ mountRoot: () => undefined }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => holder.snapshot }))

import { WelcomeSheet } from './WelcomeSheet'

let mounted: Mounted | null = null

beforeEach(() => {
  setLanguage('fr')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the default browser of the welcome', () => {
  it('shows Lucium as the default browser once Windows holds it, when the user comes back to the window', async () => {
    let chosen = false
    holder.snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), runtime: { tabs: {} }, extensions: [], platform: 'win32' }
    holder.bridge = { importSources: () => Promise.resolve([]), defaultBrowser: () => Promise.resolve(chosen), setDefaultBrowser: () => Promise.resolve('system-settings'), openOverlay: () => undefined, closeOverlay: () => undefined, dispatch: () => Promise.resolve() }
    mounted = mount(createElement(WelcomeSheet))
    await act(async () => {})
    const { container } = mounted
    expect(container.textContent).toContain(t('settings.definir-lucium-par-defaut'))
    chosen = true
    await act(async () => void window.dispatchEvent(new Event('focus')))
    expect(container.textContent).toContain(t('welcome.lucium-est-votre-navigateur-par-defaut'))
    expect(container.textContent).not.toContain(t('settings.definir-lucium-par-defaut'))
  })
})
