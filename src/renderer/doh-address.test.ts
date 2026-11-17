// @vitest-environment happy-dom
// Réglages › Réseau › DNS chiffré, « Autre adresse ». What is saved reconfigures the resolver at once, and the field used to save at every
// keystroke that made a valid https address: typing `https://dns.exemple.org/dns-query` went through `https://d/`, `https://dn/`… and
// `https://dns.exemple.or/`, another domain, each one in service for a moment. The address is now saved once it is finished, and a refusal says why.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { mount, type, type Mounted } from './dom.test-support'

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => null }))

import { DohAddress } from './PrivacyExtraSettings'

let mounted: Mounted | null = null
function row(value: string, saved: string[]): HTMLInputElement {
  mounted = mount(createElement(DohAddress, { value, onValid: (template: string) => void saved.push(template) }))
  return mounted.container.querySelector('input')!
}
const typeEachKey = (field: HTMLInputElement, text: string): void => {
  for (let length = 1; length <= text.length; length++) type(field, text.slice(0, length))
}
const leave = (field: HTMLInputElement): void => act(() => void field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
const enter = (field: HTMLInputElement): void => act(() => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the address of an encrypted DNS server of one’s own', () => {
  it('is not saved while it is typed: no address made on the way is ever put in service', () => {
    const saved: string[] = []
    const field = row('', saved)
    typeEachKey(field, 'https://dns.exemple.org/dns-query')
    expect(saved).toEqual([])
    leave(field)
    expect(saved).toEqual(['https://dns.exemple.org/dns-query'])
  })

  it('is saved on Return too, once, and not again when nothing changed', () => {
    const saved: string[] = []
    const field = row('https://dns.exemple.org/dns-query', saved)
    enter(field)
    leave(field)
    expect(saved).toEqual([])
    type(field, 'https://autre.exemple.net/dns-query')
    enter(field)
    expect(saved).toEqual(['https://autre.exemple.net/dns-query'])
  })

  it('says why an address is refused, tied to the field, and saves nothing: the one before stays in use', () => {
    const saved: string[] = []
    const field = row('https://dns.exemple.org/dns-query', saved)
    type(field, 'http://dns.exemple.org/dns-query')
    leave(field)
    expect(saved).toEqual([])
    const message = mounted!.container.querySelector('[role="alert"]')!
    expect(message.textContent).toContain('Adresse non valide')
    expect(message.textContent).toContain('L’adresse précédente reste utilisée.')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe(message.id)
  })

  it('shows no message for a valid address, nor for an empty field', () => {
    const field = row('https://dns.exemple.org/dns-query', [])
    expect(mounted!.container.querySelector('[role="alert"]')).toBeNull()
    type(field, '')
    expect(mounted!.container.querySelector('[role="alert"]')).toBeNull()
  })
})
