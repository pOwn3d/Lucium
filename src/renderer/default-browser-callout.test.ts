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
    asked.setDefaultBrowser = async () => 'failed'
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBe(t('general-settings.navigateur-par-defaut-echec'))
  })

  it('says nothing and takes the invitation away once Lucium is the default browser', async () => {
    asked.setDefaultBrowser = async () => {
      asked.defaultBrowser = async () => true
      return 'done'
    }
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBeNull()
    expect(container.textContent).not.toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
  })
})

describe('when the system gives no answer', () => {
  it('says it cannot tell, claims neither a yes nor a no, and still offers the button', async () => {
    asked.defaultBrowser = async () => null
    const container = await pane()
    expect(container.textContent).toContain(t('settings.navigateur-par-defaut-inconnu'))
    expect(container.textContent).not.toContain(t('settings.home-lucium-est-par-defaut'))
    expect(container.textContent).not.toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
    expect(container.textContent).toContain(t('settings.definir-lucium-par-defaut'))
  })
})

describe('« Définir comme navigateur par défaut » on Windows, where the choice is made in the system Settings', () => {
  it('says that Settings is open, and keeps the invitation while Windows keeps another browser', async () => {
    asked.setDefaultBrowser = async () => 'system-settings'
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBe(t('general-settings.navigateur-par-defaut-parametres'))
    expect(note(container)).not.toBe(t('general-settings.navigateur-par-defaut-echec'))
    expect(container.textContent).toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
    expect(container.textContent).toContain(t('settings.definir-lucium-par-defaut'))
  })

  it('shows what Windows holds when the user comes back to the window, without a click, and drops the note about Settings', async () => {
    let chosen = false
    asked.defaultBrowser = async () => chosen
    asked.setDefaultBrowser = async () => 'system-settings'
    const container = await pane()
    expect(container.textContent).toContain(t('settings.lucium-n-est-pas-votre-navigateur-par'))
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    expect(note(container)).toBe(t('general-settings.navigateur-par-defaut-parametres'))
    chosen = true
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(container.textContent).toContain(t('settings.home-lucium-est-par-defaut'))
    expect(container.textContent).not.toContain(t('settings.definir-lucium-par-defaut'))
    expect(note(container)).toBeNull()
  })

  // Seen in the Windows VM: the sentence inside the control column squeezed the label of the row to a few letters per line.
  it('puts the note in a row of its own, under the row, never in the control column that holds the button', async () => {
    asked.setDefaultBrowser = async () => 'system-settings'
    const container = await pane()
    await click(button(container, t('settings.definir-lucium-par-defaut')))
    const message = container.querySelector('[data-role="default-browser-note"]')!
    expect(message.classList.contains('pref-message')).toBe(true)
    expect(message.closest('.pref-control')).toBeNull()
    expect(container.querySelector('.pref-control [data-role="default-browser-note"]')).toBeNull()
  })

  it('stops listening to the window once the row is gone', async () => {
    let asks = 0
    asked.defaultBrowser = async () => (asks++, false)
    await pane()
    mounted?.unmount()
    mounted = null
    const before = asks
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(asks).toBe(before)
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
