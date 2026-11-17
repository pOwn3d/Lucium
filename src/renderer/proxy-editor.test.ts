// @vitest-environment happy-dom
// The editor of a proxy (Settings), mounted in a document and typed in as the user types: what is saved, and when. An address is saved once the
// field is left or Return is pressed, never while it is typed, and the editor says so while the manual proxy it shows is not the one that applies.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi } from '@shared/ipc'
import { SYSTEM_PROXY, type ProxySetting } from '@shared/proxy'
import { t } from '@shared/i18n'
import { ProxyEditor } from './ProxyEditor'
import { button, click, mount, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let saved: ProxySetting[] = []

const editor = (value: ProxySetting) => createElement(ProxyEditor, { value, name: 'Perso', onChange: (next: ProxySetting) => void saved.push(next) })
function open(value: ProxySetting = SYSTEM_PROXY): HTMLElement {
  mounted = mount(editor(value))
  return mounted.container
}

/** Chooses a mode in the list, as a click on one of its lines does. */
function choose(container: Element, mode: string): void {
  const list = container.querySelector('select')!
  act(() => {
    list.value = mode
    list.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const addressField = (container: Element): HTMLInputElement => container.querySelector<HTMLInputElement>('input[aria-invalid]')!
const unsaved = (container: Element): string | null => container.querySelector('[data-role="proxy-unsaved"]')?.textContent ?? null
// React listens for `focusout` to call `onBlur`.
const leave = (field: Element): void => act(() => void field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
const press = (field: Element, key: string): void => act(() => void field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

beforeEach(() => {
  saved = []
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the address of a manual proxy', () => {
  it('is not saved while it is typed: the valid addresses on the way to the whole one are sent nowhere', () => {
    const container = open()
    choose(container, 'manual')
    for (const text of ['proxy.test:8', 'proxy.test:80', 'proxy.test:808', 'proxy.test:8080']) type(addressField(container), text)
    expect(saved).toEqual([])
  })

  it('is saved when the field is left, once, as the whole address', () => {
    const container = open()
    choose(container, 'manual')
    type(addressField(container), 'proxy.test:80')
    type(addressField(container), 'proxy.test:8080')
    leave(addressField(container))
    expect(saved).toEqual([{ mode: 'manual', address: 'http://proxy.test:8080', bypass: '' }])
  })

  it('is saved on Return, and on no other key', () => {
    const container = open()
    choose(container, 'manual')
    type(addressField(container), 'socks5://127.0.0.1:1080')
    press(addressField(container), 'a')
    expect(saved).toEqual([])
    press(addressField(container), 'Enter')
    expect(saved).toEqual([{ mode: 'manual', address: 'socks5://127.0.0.1:1080', bypass: '' }])
  })

  it('saves nothing for an address that is not valid, whatever ends the typing', () => {
    const container = open()
    choose(container, 'manual')
    type(addressField(container), 'user:secret@proxy.test:8080')
    press(addressField(container), 'Enter')
    leave(addressField(container))
    expect(saved).toEqual([])
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t('proxy-editor.adresse-non-valide-schema-facultatif'))
  })
})

describe('what the editor says of a manual proxy that is not saved', () => {
  it('says the setting before still applies from the moment « manuel » is chosen until a valid address is saved', () => {
    const container = open()
    expect(unsaved(container)).toBeNull()
    choose(container, 'manual')
    // The list shows « manuel », and nothing was saved: the notice is what keeps the two apart.
    expect(saved).toEqual([])
    expect(unsaved(container)).toBe(t('proxy-editor.pas-encore-enregistre'))
    expect(container.querySelector('[data-role="proxy-unsaved"]')!.getAttribute('role')).toBe('status')
    type(addressField(container), 'proxy.test:8080')
    expect(unsaved(container)).toBe(t('proxy-editor.pas-encore-enregistre'))
    leave(addressField(container))
    // The setting comes back saved, as the window draws it after the change.
    mounted!.rerender(editor(saved[0]!))
    expect(unsaved(container)).toBeNull()
  })

  it('says nothing for a saved manual proxy, and says it again once its address is changed', () => {
    const container = open({ mode: 'manual', address: 'http://proxy.test:8080', bypass: '' })
    expect(unsaved(container)).toBeNull()
    type(addressField(container), 'proxy.test:3128')
    expect(unsaved(container)).toBe(t('proxy-editor.pas-encore-enregistre'))
  })

  it('saves the other modes at once and says nothing', () => {
    const container = open({ mode: 'manual', address: 'http://proxy.test:8080', bypass: '' })
    choose(container, 'direct')
    expect(saved).toEqual([{ mode: 'direct', address: '', bypass: '' }])
    expect(unsaved(container)).toBeNull()
  })
})

describe('a connection test that could not be asked', () => {
  it('says so in a sentence of its own and logs the error, without showing its text', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error("Error invoking remote method 'lucium:test-proxy'")
    ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { testProxy: () => Promise.reject(failure) }
    const container = open({ mode: 'manual', address: 'http://proxy.test:8080', bypass: '' })
    await click(button(container, t('proxy-editor.tester')))
    const said = [...container.querySelectorAll('[role="status"]')].map((one) => one.textContent)
    expect(said).toEqual([t('proxy-editor.le-test-n-a-pas-pu-etre-lance')])
    expect(container.textContent).not.toContain('remote method')
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('[proxy]'), failure)
  })
})
