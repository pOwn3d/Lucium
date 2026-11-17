// @vitest-environment happy-dom
// The notice at the foot of the sidebar: its time is the main process's, and the window tells it when the pointer or the focus is on the notice (the same rule as
// every notice with an action, renderer/notice-hold.ts). The two are kept apart: the pointer leaving a notice that still has the focus does not start the time again.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { ToastState } from '@shared/ipc'
import { click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => null }))

import { SidebarToast } from './Sidebar'

let mounted: Mounted | null = null
const TOAST: ToastState = { id: 7, message: 'Onglet archivé', action: 'Annuler', secondAction: 'Voir', durationMs: 8000 }

function draw(toast: ToastState = TOAST) {
  const calls = { hold: vi.fn<(id: number, held: boolean) => void>(), dismiss: vi.fn<(id: number) => void>(), action: vi.fn<(id: number, second?: boolean) => void>() }
  const element = (value: ToastState) => createElement(SidebarToast, { toast: value, act: { toastHold: calls.hold, toastDismiss: calls.dismiss, toastAction: calls.action } })
  mounted = mount(element(toast))
  return { calls, rerender: (value: ToastState) => mounted!.rerender(element(value)) }
}
const bubble = (): HTMLElement => document.querySelector<HTMLElement>('.toast')!
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.toast button')]

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.replaceChildren()
})

describe('the notice of the sidebar', () => {
  it('draws its words, its buttons and the line of its time, which runs as long as the main process says', () => {
    draw()
    expect(bubble().textContent).toContain('Onglet archivé')
    expect(buttons().map((one) => one.textContent || one.getAttribute('aria-label'))).toEqual(['Annuler', 'Voir', t('translate.close')])
    expect(bubble().style.getPropertyValue('--toast-ms')).toBe('8000ms')
    expect(bubble().classList.contains('has-second')).toBe(true)
    expect(document.querySelector('.toast-timer')).not.toBeNull()
  })

  it('asks the main process to wait while the pointer is on it, and to go on when it leaves', () => {
    const { calls } = draw()
    pointerOver(bubble())
    expect(calls.hold).toHaveBeenLastCalledWith(7, true)
    pointerOut(bubble())
    expect(calls.hold).toHaveBeenLastCalledWith(7, false)
  })

  it('does the same for the focus, moving between its buttons is not leaving it', () => {
    const { calls } = draw()
    act(() => buttons()[0]!.focus())
    act(() => buttons()[1]!.focus())
    expect(calls.hold.mock.calls).toEqual([[7, true]])
    act(() => buttons()[1]!.blur())
    expect(calls.hold).toHaveBeenLastCalledWith(7, false)
  })

  // Guard: the pointer and the focus are kept apart. Without it, the pointer leaving a notice whose button has the focus would let the time run again, and the
  // person at the keyboard would lose the button.
  it('keeps waiting while either still holds it: the pointer leaving does not let go of the focus', () => {
    const { calls } = draw()
    pointerOver(bubble())
    act(() => buttons()[0]!.focus())
    pointerOut(bubble())
    expect(calls.hold.mock.calls).toEqual([[7, true]])
    act(() => buttons()[0]!.blur())
    expect(calls.hold.mock.calls).toEqual([[7, true], [7, false]])
  })

  it('lets go of its time when it goes while it was held, and a notice that replaces it is not held by what held this one', () => {
    const { calls, rerender } = draw()
    pointerOver(bubble())
    mounted!.unmount()
    mounted = null
    expect(calls.hold).toHaveBeenLastCalledWith(7, false)
    const next = draw({ ...TOAST, id: 8 })
    pointerOver(bubble())
    expect(next.calls.hold.mock.calls).toEqual([[8, true]])
    rerender({ ...TOAST, id: 8, message: 'Autre' })
    expect(bubble().textContent).toContain('Autre')
  })

  it('runs its buttons and closes with its cross and with Escape', async () => {
    const { calls } = draw()
    await click(buttons()[0]!)
    await click(buttons()[1]!)
    expect(calls.action.mock.calls).toEqual([[7], [7, true]])
    await click(buttons()[2]!)
    expect(calls.dismiss).toHaveBeenLastCalledWith(7)
    act(() => void bubble().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(calls.dismiss).toHaveBeenCalledTimes(2)
  })

  it('shows the bar of a job that goes on in place of the time line', () => {
    draw({ ...TOAST, progress: { done: 1, total: 4 } })
    expect(document.querySelector('.toast-timer')).toBeNull()
    expect(document.querySelector<HTMLElement>('.toast-progress')!.style.getPropertyValue('--toast-progress')).toBe('0.25')
  })
})
