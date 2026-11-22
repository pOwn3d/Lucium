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
import { PasswordsPanel, groupedCode } from './PasswordsPanel'
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

describe('the one-time codes of an entry', () => {
  const row = (patch: Partial<PasswordsView['entries'][number]> = {}) => ({ id: 'a'.repeat(32), origin: 'https://example.com', host: 'example.com', username: 'ana', totp: true, weak: false, reused: false, updatedAt: 1, ...patch })
  const unlocked = (entries = [row()]): PasswordsView => view({ vault: 'unlocked', entries })
  /** The main process answers a request for a code with these digits and the seconds they last. */
  const answersCode = (code: string, secondsLeft: number, msLeft = secondsLeft * 1000): void => {
    passwords.mockImplementation(async (request: PasswordRequest) => {
      if (request.kind === 'lock') held = view({ vault: 'locked' })
      return { ok: true, view: held, ...(request.kind === 'totp-code' ? { totp: { id: request.id, code, secondsLeft, msLeft, period: 30 } } : {}) } as PasswordReply
    })
  }

  it('is read in two halves', () => {
    expect(groupedCode('123456')).toBe('123 456')
    expect(groupedCode('12345678')).toBe('1234 5678')
    expect(groupedCode('1234567')).toBe('123 4567')
  })

  it('is asked for when « Code » is pressed, shown with the seconds it lasts, copied by the main process and hidden again', async () => {
    answersCode('654321', 20)
    const container = await panel(unlocked())
    expect(container.textContent).not.toContain('654 321')
    await click(button(container, t('passwords-panel.totp-code')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'totp-code', id: 'a'.repeat(32) })
    expect(container.querySelector('.passwords-code')?.textContent).toBe('654 321')
    expect(container.textContent).toContain(t('passwords-panel.totp-valable-seconds-s', { seconds: 20 }))
    // Copying names the entry and nothing else: the digits are not sent back.
    await click(button(container, t('passwords-panel.totp-copier')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'totp-copy', id: 'a'.repeat(32) })
    await click(button(container, t('passwords-panel.totp-cacher-le-code')))
    expect(container.querySelector('.passwords-code')).toBeNull()
  })

  it('is asked for again when its time is over: the digits on screen are the ones of now', async () => {
    vi.useFakeTimers()
    answersCode('111111', 2)
    const container = await panel(unlocked())
    await click(button(container, t('passwords-panel.totp-code')))
    expect(container.querySelector('.passwords-code')?.textContent).toBe('111 111')
    answersCode('222222', 30)
    await settle(() => void vi.advanceTimersByTime(2600))
    expect(container.querySelector('.passwords-code')?.textContent).toBe('222 222')
    expect(passwords.mock.calls.filter(([request]) => request.kind === 'totp-code')).toHaveLength(2)
  })

  it('does not keep a code on screen after its end: it counts down by the milliseconds, and asks again by itself (auto)', async () => {
    vi.useFakeTimers()
    answersCode('111111', 1, 100)
    const container = await panel(unlocked())
    await click(button(container, t('passwords-panel.totp-code')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'totp-code', id: 'a'.repeat(32) })
    answersCode('222222', 30)
    await settle(() => void vi.advanceTimersByTime(500))
    expect(container.querySelector('.passwords-code')?.textContent).toBe('222 222')
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'totp-code', id: 'a'.repeat(32), auto: true })
  })

  it('names the code for a reader by its digits, not by a label on a plain span', async () => {
    answersCode('654321', 20)
    const container = await panel(unlocked())
    await click(button(container, t('passwords-panel.totp-code')))
    expect(container.querySelector('.passwords-code')?.hasAttribute('aria-label')).toBe(false)
  })

  it('goes from the screen when the main process has no code to give, and is not asked for again in a loop', async () => {
    vi.useFakeTimers()
    passwords.mockImplementation(async () => ({ ok: false, message: 'no key', view: held }) as PasswordReply)
    const container = await panel(unlocked())
    await click(button(container, t('passwords-panel.totp-code')))
    expect(container.querySelector('.passwords-code')).toBeNull()
    await settle(() => void vi.advanceTimersByTime(5000))
    expect(passwords.mock.calls.filter(([request]) => request.kind === 'totp-code')).toHaveLength(1)
  })

  it('has its key added from a field that hides what is typed: sent as typed, then gone from the field', async () => {
    const container = await panel(unlocked([row({ totp: false })]))
    await click(button(container, t('passwords-panel.totp-ajouter')))
    const key = field(container, `pw-totp-${'a'.repeat(32)}`)
    expect(key.type).toBe('password')
    expect(button(container, t('passwords-panel.totp-enregistrer-la-cle')).disabled).toBe(true)
    type(key, 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq')
    await click(button(container, t('passwords-panel.totp-enregistrer-la-cle')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'totp-set', id: 'a'.repeat(32), secret: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq' })
    expect(container.querySelector(`#pw-totp-${'a'.repeat(32)}`)).toBeNull()
    // The key is gone from the state too, not only from the screen: opening the field again starts empty.
    await click(button(container, t('passwords-panel.totp-ajouter')))
    expect(field(container, `pw-totp-${'a'.repeat(32)}`).value).toBe('')
  })

  it('keeps what was typed when the key is refused, so that it can be corrected, and drops it on « Annuler »', async () => {
    passwords.mockImplementation(async () => ({ ok: false, message: 'refused', view: held }) as PasswordReply)
    const container = await panel(unlocked([row({ totp: false })]))
    await click(button(container, t('passwords-panel.totp-ajouter')))
    type(field(container, `pw-totp-${'a'.repeat(32)}`), 'GEZDGNBVGY3TQOJ')
    await click(button(container, t('passwords-panel.totp-enregistrer-la-cle')))
    expect(field(container, `pw-totp-${'a'.repeat(32)}`).value).toBe('GEZDGNBVGY3TQOJ')
    await click(button(container, t('passwords-panel.annuler')))
    await click(button(container, t('passwords-panel.totp-ajouter')))
    expect(field(container, `pw-totp-${'a'.repeat(32)}`).value).toBe('')
  })

  it('has its key removed only after a second click', async () => {
    answersCode('654321', 20)
    const container = await panel(unlocked())
    await click(button(container, t('passwords-panel.totp-code')))
    await click(button(container, t('passwords-panel.totp-retirer')))
    expect(passwords.mock.calls.some(([request]) => request.kind === 'totp-remove')).toBe(false)
    await click(button(container, t('passwords-panel.annuler')))
    expect(passwords.mock.calls.some(([request]) => request.kind === 'totp-remove')).toBe(false)
    await click(button(container, t('passwords-panel.totp-retirer')))
    await click(button(container, t('passwords-panel.totp-retirer')))
    expect(passwords).toHaveBeenCalledWith({ kind: 'totp-remove', id: 'a'.repeat(32) })
  })

  it('leaves nothing on the screen once the vault is locked: not the digits, not a key that was being typed', async () => {
    answersCode('654321', 20)
    const container = await panel(unlocked([row(), row({ id: 'b'.repeat(32), username: 'bob', totp: false })]))
    await click(button(container, t('passwords-panel.totp-code')))
    await click(button(container, t('passwords-panel.totp-ajouter')))
    type(field(container, `pw-totp-${'b'.repeat(32)}`), 'GEZDGNBVGY3TQOJQ')
    expect(container.textContent).toContain('654 321')
    await click(button(container, t('passwords-panel.verrouiller')))
    expect(container.textContent).not.toContain('654 321')
    expect(container.querySelector('.passwords-code')).toBeNull()
    held = unlocked([row(), row({ id: 'b'.repeat(32), username: 'bob', totp: false })])
    await settle(() => void window.dispatchEvent(new Event('focus')))
    expect(container.querySelector('.passwords-code')).toBeNull()
    expect(container.querySelector(`#pw-totp-${'b'.repeat(32)}`)).toBeNull()
    await click(button(container, t('passwords-panel.totp-ajouter')))
    expect(field(container, `pw-totp-${'b'.repeat(32)}`).value).toBe('')
  })
})

describe('the verdicts of a row', () => {
  const row = (patch: Partial<PasswordsView['entries'][number]>) => ({ id: 'a'.repeat(32), origin: 'https://example.com', host: 'example.com', username: 'ana', totp: false, weak: false, reused: false, updatedAt: 1, ...patch })

  it('are written in words on the rows that have them, and nowhere else', async () => {
    const container = await panel(view({ vault: 'unlocked', entries: [row({}), row({ id: 'b'.repeat(32), username: 'bob', weak: true }), row({ id: 'c'.repeat(32), username: 'cat', weak: true, reused: true })] }))
    const flags = [...container.querySelectorAll('.passwords-row')].map((li) => [...li.querySelectorAll('.passwords-flag')].map((flag) => flag.textContent))
    expect(flags).toEqual([[], [t('passwords-panel.faible')], [t('passwords-panel.faible'), t('passwords-panel.reutilise')]])
  })
})

describe('« Copier » on a row', () => {
  it('asks the main process to copy that entry, and shows only what it answers, never a password', async () => {
    const id = 'a'.repeat(32)
    const entry = { id, origin: 'https://example.com', host: 'example.com', username: 'ana', totp: false, weak: false, reused: false, updatedAt: 1 }
    passwords.mockImplementation(async (request: PasswordRequest) => ({ ok: true, message: request.kind === 'copy-password' ? 'copié' : undefined, view: held }) as PasswordReply)
    const container = await panel(view({ vault: 'unlocked', entries: [entry] }))
    await click(button(container, t('passwords-panel.copier-mdp')))
    expect(passwords).toHaveBeenCalledWith({ kind: 'copy-password', id })
    expect(container.textContent).toContain('copié')
  })
})

describe('« Ne plus proposer pour ce site » on an offer', () => {
  it('answers the offer that is on screen with « never », and nothing else', async () => {
    const capture = { kind: 'new' as const, host: 'example.com', username: 'ana', offer: 7 }
    passwords.mockImplementation(async () => ({ ok: true, view: held }) as PasswordReply)
    const container = await panel(view({ vault: 'unlocked', capture }))
    await click(button(container, t('passwords-panel.ne-plus-proposer')))
    expect(passwords).toHaveBeenLastCalledWith({ kind: 'capture', op: 'never', offer: 7 })
  })
})
