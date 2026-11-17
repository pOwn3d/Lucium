// @vitest-environment happy-dom
// The box of a page's alert(), confirm() and prompt(), drawn in a real document: what it says, which button has the keyboard when it opens, and
// what each key and button answers. The main process gives the page what it returns (shared/page-dialog.ts, `answerReplyOf`).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import type { DialogRequest, PageDialogKind } from '@shared/page-dialog'
import { click, installBridge, mount, type Mounted } from './dom.test-support'
import { PromptDialog } from './Panels'

let mounted: Mounted | null = null
let answerDialog: ReturnType<typeof vi.fn>

const request = (kind: PageDialogKind, offerSuppress = false): DialogRequest => ({ id: `dialog-${kind}`, kind, host: 'boutique.example', message: 'Vider le panier ?', defaultValue: kind === 'prompt' ? 'défaut' : '', offerSuppress })
const open = (kind: PageDialogKind, offerSuppress = false): void => {
  mounted = mount(createElement(PromptDialog, { request: request(kind, offerSuppress) }))
}
const box = (): HTMLElement => mounted!.container.querySelector<HTMLElement>('.adlg-prompt')!
const buttons = (): string[] => [...box().querySelectorAll('.adlg-btn')].map((button) => button.textContent ?? '')
const okButton = (): HTMLButtonElement => box().querySelector<HTMLButtonElement>('.adlg-confirm')!
const key = (target: EventTarget, name: string): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))
/** Return held down: a repeat of the key. Answers whether the box kept its default (a button is pressed on what follows the key, unless it is prevented). */
const heldReturn = (target: EventTarget): boolean => {
  const event = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })
  act(() => void target.dispatchEvent(event))
  return !event.defaultPrevented
}

beforeEach(() => {
  setLanguage('fr')
  answerDialog = vi.fn()
  installBridge({ answerDialog })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the box of confirm()', () => {
  it('says which site tells, shows the message, and has Annuler and OK, with the keyboard on OK', () => {
    open('confirm')
    expect(box().querySelector('.adlg-title')?.textContent).toBe(frenchSpaces('boutique.example indique :'))
    expect(box().querySelector('.adlg-message')?.textContent).toBe('Vider le panier ?')
    expect(box().querySelector('input.adlg-field')).toBeNull()
    expect(buttons()).toEqual(['AnnulerESC', 'OK↩'])
    expect(document.activeElement).toBe(okButton())
    expect(box().getAttribute('role')).toBe('alertdialog')
  })

  it('answers OK (a string, which the page reads as true) from Return or from OK', async () => {
    open('confirm')
    key(box().querySelector('.adlg-message')!, 'Enter')
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-confirm', { value: '', suppress: false })
    await click(okButton())
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-confirm', { value: '', suppress: false })
  })

  it('answers a cancel (null, which the page reads as false) from Escape or from Annuler', async () => {
    open('confirm')
    key(window, 'Escape')
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-confirm', { value: null, suppress: false })
    await click(box().querySelector('.adlg-cancel')!)
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-confirm', { value: null, suppress: false })
    expect(answerDialog).toHaveBeenCalledTimes(2)
  })

  it('carries the box that stops the page, ticked, with either answer', async () => {
    open('confirm', true)
    await click(box().querySelector('.adlg-suppress input')!)
    key(window, 'Escape')
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-confirm', { value: null, suppress: true })
  })
})

describe('the box of alert()', () => {
  it('has OK alone, with the keyboard on it, and says which site tells', () => {
    open('alert')
    expect(buttons()).toEqual(['OK↩'])
    expect(box().querySelector('.adlg-cancel')).toBeNull()
    expect(document.activeElement).toBe(okButton())
    expect(box().querySelector('.adlg-title')?.textContent).toBe(frenchSpaces('boutique.example indique :'))
  })

  it('closes with Return, OK or Escape (the page gets nothing back either way)', async () => {
    open('alert')
    key(box().querySelector('.adlg-message')!, 'Enter')
    await click(okButton())
    key(window, 'Escape')
    expect(answerDialog.mock.calls).toEqual([
      ['dialog-alert', { value: '', suppress: false }],
      ['dialog-alert', { value: '', suppress: false }],
      ['dialog-alert', { value: null, suppress: false }]
    ])
  })
})

describe('the box of prompt()', () => {
  it('keeps its field, with the keyboard in it, and answers the text typed', () => {
    open('prompt')
    const field = box().querySelector<HTMLInputElement>('input.adlg-field')!
    expect(field.value).toBe('défaut')
    expect(document.activeElement).toBe(field)
    expect(box().querySelector('.adlg-title')?.textContent).toBe(frenchSpaces('boutique.example demande :'))
    expect(buttons()).toEqual(['AnnulerESC', 'OK↩'])
    key(field, 'Enter')
    expect(answerDialog).toHaveBeenLastCalledWith('dialog-prompt', { value: 'défaut', suppress: false })
  })
})

describe('Return held down', () => {
  it('answers none of the three boxes, on the button with the keyboard, in the field or elsewhere; a new press does', () => {
    for (const kind of ['alert', 'confirm', 'prompt'] as const) {
      open(kind)
      // Where the keyboard is when the box opens (OK, or the field of prompt()), and anywhere else in the box.
      const focused = document.activeElement!
      expect(heldReturn(focused), `${kind}: the button keeps its default`).toBe(false)
      expect(heldReturn(box().querySelector('.adlg-message')!)).toBe(false)
      expect(answerDialog, kind).not.toHaveBeenCalled()
      key(box().querySelector('.adlg-message')!, 'Enter')
      expect(answerDialog, kind).toHaveBeenCalledTimes(1)
      answerDialog.mockClear()
      mounted!.unmount()
      mounted = null
    }
  })
})

describe('in English', () => {
  it('reads « says » for the two boxes without a field, and « asks » for prompt()', () => {
    setLanguage('en')
    try {
      open('confirm')
      expect(box().querySelector('.adlg-title')?.textContent).toBe('boutique.example says:')
      expect(buttons()).toEqual(['CancelESC', 'OK↩'])
      mounted!.unmount()
      open('prompt')
      expect(box().querySelector('.adlg-title')?.textContent).toBe('boutique.example asks:')
    } finally {
      setLanguage('fr')
    }
  })
})
