// @vitest-environment happy-dom
// Settings › Vie privée et sécurité › Verrouillage, mounted in a document and used as the user uses it: buttons clicked, phrases typed, the answer of the main
// process arriving later. What is checked is what a static render cannot show: what is sent, what is refused before anything is sent, and that
// no phrase stays in a field once it was sent or given up.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { LOCK_PHRASE_MIN, type LockConfig, type LockReply } from '@shared/lock'
import { defaultSettings } from '@shared/model'
import { t } from '@shared/i18n'
import { LockSettings } from './LockSettings'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

const PHRASE = 'a phrase long enough to lock'

let lockConfigure: ReturnType<typeof vi.fn<(config: LockConfig) => Promise<LockReply>>>
let mounted: Mounted | null = null

/** The panel for a lock that is on or off, with two spaces of which one is locked. */
function panel(options: { on?: boolean; touchId?: boolean } = {}): Mounted {
  const on = options.on === true
  const snapshot = {
    state: {
      settings: { ...defaultSettings(), lockEnabled: on, lockApp: false, lockTouchId: false },
      spaces: [
        { id: 's1', name: 'Perso' },
        { id: 's2', name: 'Banque' }
      ]
    },
    lock: { active: on, appLocked: false, lockedSpaces: [], guardedSpaces: on ? ['s2'] : [], touchId: options.touchId === true, retryInMs: 0 }
  } as unknown as UiSnapshot
  mounted = mount(createElement(LockSettings, { snapshot }))
  return mounted
}

const fields = (container: Element): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')]
const alertOf = (container: Element): string | null => container.querySelector('[role="alert"]')?.textContent ?? null

beforeEach(() => {
  lockConfigure = vi.fn(async () => ({ ok: true }) as LockReply)
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { lockConfigure }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('choosing a phrase', () => {
  it('shows one button until the user asks for the form, then two fields that hide what is typed', async () => {
    const { container } = panel()
    expect(fields(container)).toHaveLength(0)
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    expect(fields(container)).toHaveLength(2)
    expect(fields(container).every((field) => field.type === 'password' && field.autocomplete === 'off')).toBe(true)
  })

  it('sends the phrase once both fields agree, and empties the fields when the main process took it', async () => {
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const [phrase, again] = fields(container)
    type(phrase!, PHRASE)
    type(again!, PHRASE)
    await click(button(container, t('lock-settings.activer')))
    expect(lockConfigure).toHaveBeenCalledTimes(1)
    expect(lockConfigure).toHaveBeenCalledWith({ op: 'set-phrase', phrase: PHRASE })
    expect(alertOf(container)).toBeNull()
    // Back to the single button: the form is gone, and with it what was typed.
    expect(fields(container)).toHaveLength(0)
  })

  it('sends nothing for a phrase that is too short or typed differently twice, and says which', async () => {
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const [phrase, again] = fields(container)
    type(phrase!, 'x'.repeat(LOCK_PHRASE_MIN - 1))
    type(again!, 'x'.repeat(LOCK_PHRASE_MIN - 1))
    await click(button(container, t('lock-settings.activer')))
    expect(alertOf(container)).toBe(t('lock-settings.la-phrase-doit-faire-au-moins-lock-phrase-min', { LOCK_PHRASE_MIN }))

    type(phrase!, PHRASE)
    type(again!, `${PHRASE}.`)
    await click(button(container, t('lock-settings.activer')))
    expect(alertOf(container)).toBe(t('lock-settings.les-deux-phrases-ne-sont-pas-identiques'))
    expect(lockConfigure).not.toHaveBeenCalled()
  })

  it('shows the refusal of the main process, keeps the form open and still empties the fields', async () => {
    lockConfigure.mockResolvedValue({ ok: false, message: 'La phrase est refusée.' })
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const [phrase, again] = fields(container)
    type(phrase!, PHRASE)
    type(again!, PHRASE)
    await click(button(container, t('lock-settings.activer')))
    expect(alertOf(container)).toBe('La phrase est refusée.')
    expect(fields(container).map((field) => field.value)).toEqual(['', ''])
  })

  it('shows the error when the request itself fails, and lets the user try again', async () => {
    lockConfigure.mockRejectedValue(new Error('the main process did not answer'))
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const [phrase, again] = fields(container)
    type(phrase!, PHRASE)
    type(again!, PHRASE)
    await click(button(container, t('lock-settings.activer')))
    expect(alertOf(container)).toBe('the main process did not answer')
    expect(button(container, t('lock-settings.activer')).disabled).toBe(false)
    expect(fields(container).map((field) => field.value)).toEqual(['', ''])
  })

  it('shows what the main process said without the name of the channel it came through, a sentence of the catalogue when it said nothing, and keeps the error for the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    lockConfigure.mockRejectedValueOnce(new Error("Error invoking remote method 'lucium:lock-configure': Error: The lock file cannot be written"))
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const send = async (): Promise<void> => {
      const [phrase, again] = fields(container)
      type(phrase!, PHRASE)
      type(again!, PHRASE)
      await click(button(container, t('lock-settings.activer')))
    }
    await send()
    expect(alertOf(container)).toBe('The lock file cannot be written')
    expect(warn).toHaveBeenCalledWith('[lock] the settings of the lock could not be changed:', expect.any(Error))
    lockConfigure.mockRejectedValueOnce(new Error(''))
    await send()
    expect(alertOf(container)).toBe(t('errors.erreur-inattendue'))
    warn.mockRestore()
  })

  it('cannot be sent twice while the first request is under way', async () => {
    let answer: (reply: LockReply) => void = () => undefined
    lockConfigure.mockImplementation(() => new Promise<LockReply>((resolve) => (answer = resolve)))
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    const [phrase, again] = fields(container)
    type(phrase!, PHRASE)
    type(again!, PHRASE)
    await click(button(container, t('lock-settings.activer')))
    expect(button(container, t('lock-settings.activer')).disabled).toBe(true)
    await settle(() => answer({ ok: true }))
    expect(lockConfigure).toHaveBeenCalledTimes(1)
    expect(fields(container)).toHaveLength(0)
  })

  it('forgets what was typed, and the message, when the user gives up', async () => {
    const { container } = panel()
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    type(fields(container)[0]!, 'short')
    await click(button(container, t('lock-settings.activer')))
    expect(alertOf(container)).not.toBeNull()
    await click(button(container, t('settings.annuler')))
    expect(alertOf(container)).toBeNull()
    expect(fields(container)).toHaveLength(0)
    await click(button(container, t('lock-settings.choisir-une-phrase')))
    expect(fields(container).map((field) => field.value)).toEqual(['', ''])
    expect(lockConfigure).not.toHaveBeenCalled()
  })
})

describe('a lock that is on', () => {
  it('names the locked spaces, and says whether this Mac has Touch ID', () => {
    const without = panel({ on: true })
    expect(without.container.textContent).toContain('Banque')
    expect(without.container.textContent).not.toContain('Perso')
    expect(without.container.textContent).toContain(t('lock-settings.touch-id-n-est-pas-disponible-sur-ce-mac'))
    without.unmount()
    expect(panel({ on: true, touchId: true }).container.textContent).toContain(t('lock-settings.la-phrase-reste-le-recours-si-touch-id-echoue'))
  })

  it('asks for the current phrase to switch the lock off, and sends that phrase alone', async () => {
    const { container } = panel({ on: true })
    await click(button(container, t('lock-settings.desactiver-le-verrouillage')))
    expect(fields(container)).toHaveLength(1)
    type(fields(container)[0]!, PHRASE)
    await click(button(container, t('lock-settings.desactiver')))
    expect(lockConfigure).toHaveBeenCalledWith({ op: 'disable', current: PHRASE })
  })

  it('sends the current phrase with the new one to change it, after the same checks as a first phrase', async () => {
    const { container } = panel({ on: true })
    await click(button(container, t('settings.changer')))
    const [current, phrase, again] = fields(container)
    type(current!, PHRASE)
    type(phrase!, 'another phrase, long enough')
    type(again!, 'another phrase, not the same')
    await click(button(container, t('lock-settings.changer')))
    expect(lockConfigure).not.toHaveBeenCalled()
    type(again!, 'another phrase, long enough')
    await click(button(container, t('lock-settings.changer')))
    expect(lockConfigure).toHaveBeenCalledWith({ op: 'set-phrase', phrase: 'another phrase, long enough', current: PHRASE })
  })

  it('locks now, and turns the lock at launch and Touch ID on with what the boxes say', async () => {
    const { container } = panel({ on: true, touchId: true })
    await click(button(container, t('lock-settings.verrouiller')))
    expect(lockConfigure).toHaveBeenLastCalledWith({ op: 'lock-now' })
    const [app, touch] = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    await click(app!)
    expect(lockConfigure).toHaveBeenLastCalledWith({ op: 'app', value: true })
    await click(touch!)
    expect(lockConfigure).toHaveBeenLastCalledWith({ op: 'touch-id', value: true })
  })

  it('offers the delay of the lock of a private window, « Jamais » at first, and sends the choice with the other changes of the lock', async () => {
    const { container } = panel({ on: true })
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${t('lock-settings.verrouiller-les-fenetres-privees-apres')}"]`)!
    expect([...select.options].map((option) => option.textContent)).toEqual([t('lock-settings.jamais'), '1 minute', '5 minutes', '15 minutes', '30 minutes'])
    expect(select.value).toBe('0')
    await settle(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      set.call(select, '15')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(lockConfigure).toHaveBeenLastCalledWith({ op: 'private-idle', minutes: 15 })
  })

  it('shows no such row while the lock is off (a phrase comes first)', () => {
    const off = panel()
    expect(off.container.querySelector('select')).toBeNull()
    off.unmount()
    mounted = null
  })
})

