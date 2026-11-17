// The capsule of a control and the card of a sidebar row come to a focus the keyboard gave, as they come to a pointer that rests; a focus a click
// gave (not `:focus-visible`) brings neither.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLTIP } from '@shared/ipc'

const shown = vi.hoisted(() => ({ requests: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ tooltip: (request: unknown) => void shown.requests.push(request) }) }))

import { dismissTooltipOnEscape, hideTooltip, tipProps } from './tooltip'
import { focusCard, middleOf } from './SidebarRows'

/** A control as the focus event hands it: whether the focus is a visible one, and where it is. */
const control = (visible: boolean) => ({ matches: (selector: string) => selector === ':focus-visible' && visible, getBoundingClientRect: () => ({ left: 100, width: 40, bottom: 60, right: 140, top: 30, height: 30 }) })

beforeEach(() => {
  vi.useFakeTimers()
  shown.requests.length = 0
})
afterEach(() => {
  hideTooltip()
  vi.useRealTimers()
})

describe('the capsule of a control', () => {
  it('shows after the wait when the keyboard brings the focus, under the middle of the control', () => {
    const props = tipProps('Infos et réglages du site', ['⇧', '⌘', 'I'])
    props.onFocus({ currentTarget: control(true) } as never)
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    expect(shown.requests).toEqual([{ text: 'Infos et réglages du site', keys: ['⇧', '⌘', 'I'], x: 120, y: 60 }])
  })

  it('does not show for a focus a click gave, and the blur takes it away', () => {
    const props = tipProps('Retour')
    props.onFocus({ currentTarget: control(false) } as never)
    vi.advanceTimersByTime(TOOLTIP.delayMs * 2)
    expect(shown.requests).toEqual([])
    props.onFocus({ currentTarget: control(true) } as never)
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    props.onBlur()
    expect(shown.requests).toEqual([expect.objectContaining({ text: 'Retour' }), null])
  })
})

// The capsule is drawn by the main process, so each request is a message to it. A pointer that moves
// sends nothing; one that rests sends one request, and leaving one more.
describe('the capsule and a moving pointer', () => {
  const move = (x: number) => ({ clientX: x, clientY: 10 }) as never

  it('sends nothing while the pointer moves over the controls, and one request once it rests, however much it moves inside the control after', () => {
    const controls = Array.from({ length: 50 }, (_, index) => tipProps(`Bouton ${index}`))
    for (const [index, props] of controls.entries()) {
      props.onMouseEnter(move(index))
      for (let step = 0; step < 10; step++) {
        props.onMouseMove(move(index + step))
        vi.advanceTimersByTime(TOOLTIP.delayMs / 20)
      }
      props.onMouseLeave()
    }
    expect(shown.requests).toEqual([])
    const props = tipProps('Retour')
    props.onMouseEnter(move(10))
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    for (let step = 0; step < 500; step++) props.onMouseMove(move(10 + (step % 20)))
    vi.advanceTimersByTime(TOOLTIP.delayMs * 3)
    props.onMouseLeave()
    expect(shown.requests).toEqual([{ text: 'Retour', x: 10, y: 10 }, null])
  })
})

describe('Escape while a capsule is shown or waits', () => {
  const move = (x: number) => ({ clientX: x, clientY: 10 }) as never

  it('puts the shown capsule away without the pointer moving, and a move inside the control does not bring it back', () => {
    const props = tipProps('Retour')
    props.onMouseEnter(move(10))
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    dismissTooltipOnEscape({ key: 'Escape' })
    expect(shown.requests).toEqual([{ text: 'Retour', x: 10, y: 10 }, null])
    props.onMouseMove(move(12))
    vi.advanceTimersByTime(TOOLTIP.delayMs * 3)
    expect(shown.requests).toHaveLength(2)
    // Leaving the control and coming back is a new rest: the capsule shows again.
    props.onMouseLeave()
    props.onMouseEnter(move(14))
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    expect(shown.requests).toHaveLength(3)
  })

  it('keeps a capsule that waits from showing, and no other key does either', () => {
    const props = tipProps('Retour')
    props.onMouseEnter(move(10))
    dismissTooltipOnEscape({ key: 'a' })
    vi.advanceTimersByTime(TOOLTIP.delayMs / 2)
    dismissTooltipOnEscape({ key: 'Escape' })
    vi.advanceTimersByTime(TOOLTIP.delayMs * 2)
    expect(shown.requests).toEqual([])
    props.onMouseLeave()
    const other = tipProps('Suivant')
    other.onMouseEnter(move(10))
    dismissTooltipOnEscape({ key: 'Enter' })
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    expect(shown.requests).toEqual([{ text: 'Suivant', x: 10, y: 10 }])
  })

  it('is listened for on the whole window, once, from the first capsule armed', () => {
    const added: Array<[string, unknown, unknown]> = []
    vi.stubGlobal('document', { addEventListener: (type: string, listener: unknown, capture: unknown) => void added.push([type, listener, capture]) })
    try {
      tipProps('Un').onMouseEnter(move(1))
      hideTooltip()
      tipProps('Deux').onMouseEnter(move(2))
      expect(added).toEqual([['keydown', dismissTooltipOnEscape, true]])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the card of a sidebar row', () => {
  // The tests run without a document: an element is a stand-in of the global `Element`.
  class FakeElement {}
  beforeEach(() => vi.stubGlobal('Element', FakeElement))
  afterEach(() => vi.unstubAllGlobals())

  it('opens for a visible focus only, at the middle of the row', () => {
    const open = vi.fn()
    focusCard({ target: Object.assign(new FakeElement(), control(false)) as never }, open)
    expect(open).not.toHaveBeenCalled()
    focusCard({ target: Object.assign(new FakeElement(), control(true)) as never }, open)
    expect(open).toHaveBeenCalledOnce()
    expect(middleOf(control(true) as never)).toEqual({ clientX: 120 })
  })
})
