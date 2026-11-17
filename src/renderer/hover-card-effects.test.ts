// @vitest-environment happy-dom
// The card of a tab under a resting pointer (HoverCard.tsx, `useHoverCard`), mounted in a document: its timers, the listeners it puts on the
// window and what it leaves behind when the sidebar goes. A static render shows none of this: effects do not run in it.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOVER_DELAY_MS, useHoverCard } from './HoverCard'
import { mount, type Mounted } from './dom.test-support'

type Card = ReturnType<typeof useHoverCard>

let card: Card
let mounted: Mounted | null = null

/** A sidebar reduced to the hook: it says which tab the card is for, and where. */
function Probe() {
  card = useHoverCard()
  return createElement('output', null, card.anchor ? `${card.anchor.tabId}@${card.anchor.x}` : 'none')
}

const shown = (): string => mounted!.container.textContent ?? ''
const row = (): HTMLElement => {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => ({ top: 40, bottom: 68 }) as DOMRect
  return element
}
const wait = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const fire = (event: Event, target: EventTarget = window): void => act(() => void target.dispatchEvent(event))

beforeEach(() => {
  vi.useFakeTimers({ now: 100_000 })
  mounted = mount(createElement(Probe))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the card of a tab', () => {
  it('appears once the pointer has rested a second and a half on the row, not before, and where the pointer is by then', () => {
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS - 1)
    expect(shown()).toBe('none')
    fire(new MouseEvent('mousemove', { clientX: 85 }))
    wait(1)
    expect(shown()).toBe('t1@85')
  })

  it('never appears for a pointer that left before the delay', () => {
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS - 1)
    act(() => card.leave())
    wait(HOVER_DELAY_MS)
    expect(shown()).toBe('none')
  })

  it('goes as soon as the user does something elsewhere: a click, a key, the wheel, a scroll, a drag, a menu, another window', () => {
    for (const event of [new MouseEvent('mousedown'), new KeyboardEvent('keydown'), new Event('wheel'), new Event('scroll'), new Event('dragstart'), new MouseEvent('contextmenu'), new Event('blur')]) {
      act(() => card.start('t1', row(), 30))
      wait(HOVER_DELAY_MS)
      expect(shown(), event.type).toBe('t1@30')
      fire(event)
      expect(shown(), event.type).toBe('none')
      // Past the moment the next card would still come at once.
      wait(1000)
    }
  })

  it('stays when the click or the wheel is on the card itself', () => {
    const inside = document.createElement('button')
    const cardElement = document.createElement('div')
    cardElement.className = 'hover-card'
    cardElement.append(inside)
    document.body.append(cardElement)
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS)
    fire(new MouseEvent('mousedown', { bubbles: true }), inside)
    fire(new Event('wheel', { bubbles: true }), inside)
    expect(shown()).toBe('t1@30')
    cardElement.remove()
  })

  it('comes almost at once for the next tab when a card has just gone, and waits the whole delay again later', () => {
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS)
    act(() => card.hide())
    act(() => card.start('t2', row(), 30))
    wait(120)
    expect(shown()).toBe('t2@30')

    act(() => card.hide())
    wait(451)
    act(() => card.start('t3', row(), 30))
    wait(120)
    expect(shown()).toBe('none')
    wait(HOVER_DELAY_MS - 120)
    expect(shown()).toBe('t3@30')
  })

  it('stays a moment after the pointer left the row, and for good once the pointer is on it', () => {
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS)
    act(() => card.leave())
    wait(219)
    expect(shown()).toBe('t1@30')
    wait(1)
    expect(shown()).toBe('none')

    wait(1000)
    act(() => card.start('t1', row(), 30))
    wait(HOVER_DELAY_MS)
    act(() => card.leave())
    wait(100)
    act(() => card.keep())
    wait(5000)
    expect(shown()).toBe('t1@30')
  })
})

describe('a sidebar that goes away', () => {
  it('takes back every listener it put on the window', () => {
    mounted!.unmount()
    const added: [string, unknown, unknown][] = []
    const removed: [string, unknown, unknown][] = []
    vi.spyOn(window, 'addEventListener').mockImplementation((...args: unknown[]) => void added.push(args as [string, unknown, unknown]))
    vi.spyOn(window, 'removeEventListener').mockImplementation((...args: unknown[]) => void removed.push(args as [string, unknown, unknown]))
    mounted = mount(createElement(Probe))
    expect(added.map(([name]) => name).sort()).toEqual(['blur', 'contextmenu', 'dragstart', 'keydown', 'mousedown', 'mousemove', 'scroll', 'wheel'])
    mounted.unmount()
    mounted = null
    // The same function, the same phase: anything else leaves the listener in place.
    expect(removed).toEqual(added)
  })

  it('leaves no card to come: the timer of a pointer that was resting is cancelled', () => {
    act(() => card.start('t1', row(), 30))
    expect(vi.getTimerCount()).toBe(1)
    mounted!.unmount()
    mounted = null
    expect(vi.getTimerCount()).toBe(0)
  })
})
