// @vitest-environment happy-dom
// « Mots de passe… » mounted in a document and used as the user uses it. What is checked is what a static render cannot show: a length typed
// key after key, the wait after too many phrases counted down, what is left of a text typed once the vault is locked, and what a field says
// of the reason its button is off.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi } from '@shared/ipc'
import { setLanguage, t } from '@shared/i18n'
import { GENERATOR_LENGTH, generatorLengthOf } from '@shared/password-generator'
import { NO_PASSWORDS_VIEW, PASSWORD_LIMITS, type PasswordReply, type PasswordRequest, type PasswordsView } from '@shared/passwords'
import { PasswordsPanel } from './PasswordsPanel'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

const view = (patch: Partial<PasswordsView>): PasswordsView => ({ ...NO_PASSWORDS_VIEW, enabled: true, ...patch })

let passwords: ReturnType<typeof vi.fn<(request: PasswordRequest) => Promise<PasswordReply>>>
let mounted: Mounted | null = null
/** What the main process holds: each request is answered with it. */
let held: PasswordsView

/** The panel, drawn once its first answer came. */
async function panel(first: PasswordsView): Promise<HTMLElement> {
  held = first
  mounted = mount(createElement(PasswordsPanel))
  await settle()
  return mounted.container
}

const field = (container: Element, id: string): HTMLInputElement => {
  const found = container.querySelector<HTMLInputElement>(`#${id}`)
  if (!found) throw new Error(`no field #${id}`)
  return found
}
const blur = (target: Element): void => act(() => void target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

beforeEach(() => {
  setLanguage('fr')
  passwords = vi.fn(async (request: PasswordRequest) => {
    if (request.kind === 'lock') held = view({ vault: 'locked' })
    return { ok: true, view: held, ...(request.kind === 'generate' ? { password: 'x'.repeat(request.options?.length ?? 0) } : {}) } as PasswordReply
  })
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { passwords, closeOverlay: () => undefined }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('the length of the generator', () => {
  it('is the number typed, held to the bounds, and the default for what is not a number', () => {
    expect(generatorLengthOf('32')).toBe(32)
    expect(generatorLengthOf('3')).toBe(GENERATOR_LENGTH.min)
    expect(generatorLengthOf('4000')).toBe(GENERATOR_LENGTH.max)
    expect(generatorLengthOf('31.6')).toBe(32)
    expect(generatorLengthOf('')).toBe(GENERATOR_LENGTH.default)
    expect(generatorLengthOf('abc')).toBe(GENERATOR_LENGTH.default)
  })

  it('can be typed key after key: the field keeps what is typed, and the bounds come when it is left', async () => {
    const container = await panel(view({ vault: 'unlocked' }))
    await click(button(container, t('passwords-panel.ajouter')))
    const length = field(container, 'pw-length')
    type(length, '3')
    expect(length.value).toBe('3')
    type(length, '32')
    expect(length.value).toBe('32')
    type(length, '3')
    blur(length)
    expect(length.value).toBe(String(GENERATOR_LENGTH.min))
  })

  it('is held to the bounds when « Générer » is pressed, in the request and in the field', async () => {
    const container = await panel(view({ vault: 'unlocked' }))
    await click(button(container, t('passwords-panel.ajouter')))
    type(field(container, 'pw-length'), '500')
    await click(button(container, t('passwords-panel.generer')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'generate', options: expect.objectContaining({ length: GENERATOR_LENGTH.max }) })
    expect(field(container, 'pw-length').value).toBe(String(GENERATOR_LENGTH.max))
  })
})

describe('the wait after too many phrases', () => {
  it('counts down, keeps « Déverrouiller » off meanwhile, and goes away when the time has passed', async () => {
    vi.useFakeTimers()
    const container = await panel(view({ vault: 'locked', retryInMs: 3000 }))
    type(field(container, 'pw-phrase'), 'a phrase that is long enough')
    const wait = (seconds: number): string => t('passwords-panel.trop-d-essais-patientez-seconds-s', { seconds })
    expect(container.textContent).toContain(wait(3))
    expect(button(container, t('passwords-panel.deverrouiller')).disabled).toBe(true)
    // The button says why it is off to a screen reader.
    const described = button(container, t('passwords-panel.deverrouiller')).getAttribute('aria-describedby')
    expect(described && container.querySelector(`[id="${described}"]`)?.textContent).toBe(wait(3))

    await settle(() => void vi.advanceTimersByTime(1100))
    expect(container.textContent).toContain(wait(2))

    await settle(() => void vi.advanceTimersByTime(2100))
    expect(container.textContent).not.toContain(wait(1).slice(0, 12))
    expect(button(container, t('passwords-panel.deverrouiller')).disabled).toBe(false)
  })
})

describe('what was typed while the vault was open', () => {
  it('is gone once the vault is locked, even when it is found open again without a phrase typed here', async () => {
    const container = await panel(view({ vault: 'unlocked' }))
    await click(button(container, t('passwords-panel.coffre')))
    type(field(container, 'pw-current'), 'the phrase of the vault')
    type(field(container, 'pw-destroy'), 'the phrase of the vault')
    await click(button(container, t('passwords-panel.verrouiller-maintenant')))
    expect(container.querySelector('#pw-current')).toBeNull()

    // The vault is opened elsewhere (another window): this panel learns it when the window takes the focus back.
    held = view({ vault: 'unlocked' })
    await settle(() => void window.dispatchEvent(new Event('focus')))
    expect(field(container, 'pw-current').value).toBe('')
    expect(field(container, 'pw-destroy').value).toBe('')
  })
})

describe('the form that creates the vault', () => {
  it('ties the reason the button is off to the field and to the button', async () => {
    const container = await panel(view({ vault: 'none' }))
    const phrase = field(container, 'pw-phrase')
    expect(phrase.getAttribute('aria-describedby')).toBeNull()
    type(phrase, 'short')
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe(t('passwords.la-phrase-doit-faire-au-moins-phrasemin', { phraseMin: PASSWORD_LIMITS.phraseMin }))
    expect(phrase.getAttribute('aria-invalid')).toBe('true')
    expect(phrase.getAttribute('aria-describedby')).toBe(alert?.id)
    expect(button(container, t('passwords-panel.creer-le-coffre')).getAttribute('aria-describedby')).toBe(alert?.id)
  })

  it('says that the two phrases differ once the second one is typed', async () => {
    const container = await panel(view({ vault: 'none' }))
    type(field(container, 'pw-phrase'), 'a phrase that is long enough')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    type(field(container, 'pw-again'), 'a phrase that is long enoug')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('passwords-panel.les-deux-phrases-ne-sont-pas-identiques'))
    expect(button(container, t('passwords-panel.creer-le-coffre')).disabled).toBe(true)
  })
})
