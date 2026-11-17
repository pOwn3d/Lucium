// @vitest-environment happy-dom
// « Pour commencer » › Votre navigateur, mounted in a document: the row of the default browser, and its invitation when the request does not go
// through. A request that failed, or that the system refused, used to leave the button as it was with nothing said.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi } from '@shared/ipc'
import { t } from '@shared/i18n'
import { DefaultBrowserRow } from './GeneralSettings'
import { button, click, mount, settle, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let asked: Partial<LuciumApi>

/** The row over a bridge where only what the test sets answers: any other request stays pending, as an unanswered one does. */
async function pane(): Promise<HTMLElement> {
  const bridge = new Proxy(asked as Record<string, unknown>, { get: (target, name: string) => target[name] ?? (() => new Promise(() => undefined)) })
  ;(window as unknown as { lucium: unknown }).lucium = bridge
  mounted = mount(createElement(DefaultBrowserRow))
  await settle()
  return mounted.container
}
const note = (container: Element): string | null => container.querySelector('[data-role="default-browser-note"]')?.textContent ?? null

beforeEach(() => {
  asked = { defaultBrowser: async () => false }
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('« Définir comme navigateur par défaut »', () => {
  it('says the request failed, and logs why', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failure = new Error('no answer')
    asked.setDefaultBrowser = () => Promise.reject(failure)
    const container = await pane()
    expect(note(container)).toBeNull()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBe(t('general-settings.navigateur-par-defaut-echec'))
    expect(container.querySelector('[data-role="default-browser-note"]')!.getAttribute('role')).toBe('status')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[settings]'), failure)
  })

  it('says so when the system answers that nothing was changed', async () => {
    asked.setDefaultBrowser = async () => false
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBe(t('general-settings.navigateur-par-defaut-echec'))
  })

  it('says nothing and takes the invitation away once Lucium is the default browser', async () => {
    asked.setDefaultBrowser = async () => {
      asked.defaultBrowser = async () => true
      return true
    }
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBeNull()
    expect(container.textContent).not.toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
  })
})

describe('the question « is Lucium the default browser » that gets no answer', () => {
  it('draws no invitation and logs why', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('no answer')
    asked.defaultBrowser = () => Promise.reject(failure)
    const container = await pane()
    expect(container.textContent).not.toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('[settings]'), failure)
  })
})
