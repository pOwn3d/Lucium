import { describe, expect, it } from 'vitest'
import { arcDialogKey, arcDialogKeyHandler, confirmButtons, type DialogFocus } from './confirm-box'

describe('confirmButtons', () => {
  it('makes Cancel the default button of a box that destroys something, and the way out of Escape', () => {
    const box = confirmButtons('Effacer', 'Annuler', true)
    expect(box.buttons).toEqual(['Effacer', 'Annuler'])
    expect(box.defaultId).toBe(1)
    expect(box.cancelId).toBe(1)
    expect(box.buttons[box.defaultId]).toBe('Annuler')
  })

  it('keeps the confirmation as the default of a question that costs nothing', () => {
    const box = confirmButtons('Exporter', 'Annuler', false)
    expect(box.defaultId).toBe(0)
    expect(box.cancelId).toBe(1)
  })
})

describe('arcDialogKey', () => {
  const focuses: DialogFocus[] = ['cancel', 'confirm', 'other']
  const press = (key: string, focus: DialogFocus, danger: boolean, repeat = false) => arcDialogKey({ key, repeat, focus, danger })

  it('lets Escape cancel whatever has the focus, repeated or not', () => {
    for (const danger of [true, false]) for (const focus of focuses) expect(press('Escape', focus, danger)).toBe('cancel')
    expect(press('Escape', 'confirm', true, true)).toBe('cancel')
  })

  it('does not let Return confirm a box that erases, unless the red button itself was reached', () => {
    expect(press('Enter', 'other', true)).toBe('cancel')
    expect(press('Enter', 'cancel', true)).toBe('cancel')
    expect(press('Enter', 'confirm', true)).toBe('confirm')
  })

  it('lets Return confirm a question that costs nothing, but keeps a Cancel that was reached', () => {
    expect(press('Enter', 'other', false)).toBe('confirm')
    expect(press('Enter', 'confirm', false)).toBe('confirm')
    expect(press('Enter', 'cancel', false)).toBe('cancel')
  })

  it('ignores a Return that repeats (a held key), whatever the box and the focus', () => {
    for (const danger of [true, false]) for (const focus of focuses) expect(press('Enter', focus, danger, true)).toBe('ignore')
  })

  it('leaves every other key to the page', () => {
    for (const key of ['a', ' ', 'Tab', 'Backspace', 'ArrowDown']) expect(press(key, 'other', true)).toBeNull()
  })
})

describe('arcDialogKeyHandler', () => {
  const setup = (danger: boolean, focus: DialogFocus = 'other') => {
    const calls: string[] = []
    const handler = arcDialogKeyHandler({ danger, focus: () => focus, onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm'), onTab: (backwards) => calls.push(backwards ? 'tab back' : 'tab') })
    const press = (key: string, repeat = false, shiftKey = false) => {
      const taken: string[] = []
      handler({ key, repeat, shiftKey, preventDefault: () => taken.push('default'), stopImmediatePropagation: () => taken.push('propagation') })
      return taken
    }
    return { calls, press }
  }

  it('cancels, not confirms, on a Return in a box that erases; and takes the key from the page and from the button under the focus', () => {
    const { calls, press } = setup(true)
    expect(press('Enter')).toEqual(['default', 'propagation'])
    expect(calls).toEqual(['cancel'])
  })

  it('keeps Tab and Shift+Tab for the box, which moves the focus itself: the key never reaches a control under the dimmed layer', () => {
    const { calls, press } = setup(true)
    expect(press('Tab')).toEqual(['default', 'propagation'])
    expect(press('Tab', false, true)).toEqual(['default', 'propagation'])
    expect(calls).toEqual(['tab', 'tab back'])
  })

  it('confirms on the Return of the red button that was reached on purpose', () => {
    const { calls, press } = setup(true, 'confirm')
    press('Enter')
    expect(calls).toEqual(['confirm'])
  })

  it('answers nothing to a held Return, yet takes it, so that no click follows on the button that has the focus', () => {
    const { calls, press } = setup(true, 'confirm')
    expect(press('Enter', true)).toEqual(['default', 'propagation'])
    expect(calls).toEqual([])
  })

  it('confirms on Return only in a box that costs nothing', () => {
    const { calls, press } = setup(false)
    press('Enter')
    expect(calls).toEqual(['confirm'])
  })

  it('cancels on Escape, and leaves any other key alone', () => {
    const { calls, press } = setup(true)
    expect(press('Escape')).toEqual(['default', 'propagation'])
    expect(press('a')).toEqual([])
    expect(press(' ')).toEqual([])
    expect(calls).toEqual(['cancel'])
  })
})
