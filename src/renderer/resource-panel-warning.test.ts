// @vitest-environment happy-dom
// « Libérer maintenant »: the warning of « Fort » (it costs notifications) must be on screen before the button can be used by any path, replayed here
// in a document: keyboard focus, pointer, a mouse click that leaves the focus on the button, a finger. A static render cannot tell that the pointer
// leaving hid the warning of a button that still had the focus.

import { act, createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ReleasePreview } from '@shared/resources'
import { mount, type Mounted } from './dom.test-support'

vi.mock('./api', () => ({ api: () => ({}) }))

import { ReleaseLevels } from './ResourcePanel'

const levels: ReleasePreview[] = [
  { level: 'low', count: 4, memoryMb: 600, cpu: 1, siteTabs: 0 },
  { level: 'medium', count: 12, memoryMb: 2150, cpu: 3, siteTabs: 0 },
  { level: 'high', count: 35, memoryMb: 4900, cpu: 5, siteTabs: 20 }
]

let mounted: Mounted | null = null
let draw: (open: boolean) => ReactElement = () => createElement('div')
const render = (props: Partial<Parameters<typeof ReleaseLevels>[0]> = {}): HTMLElement => {
  draw = (open) => createElement(ReleaseLevels, { levels, running: null, onRelease: () => undefined, open, ...props })
  mounted = mount(draw(true))
  return mounted.container
}
const strong = (container: Element): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-level="high"]')!
const medium = (container: Element): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-level="medium"]')!
const warning = (container: Element): HTMLElement => container.querySelector<HTMLElement>('#rp-release-warn')!
const fire = (target: Element, type: string, init: Record<string, unknown> = {}): void => {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: null })
  for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value })
  act(() => void target.dispatchEvent(event))
}
const pointerEnter = (target: Element, pointerType = 'mouse'): void => fire(target, 'pointerover', { pointerType })
const pointerLeave = (target: Element, pointerType = 'mouse'): void => fire(target, 'pointerout', { pointerType })
const focus = (target: HTMLElement): void => act(() => target.focus())
const blur = (target: HTMLElement): void => act(() => target.blur())

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the warning of « Fort » on screen before it can be used', () => {
  it('is hidden at rest, and told to a screen reader by aria-describedby', () => {
    const container = render()
    expect(warning(container).hidden).toBe(true)
    expect(strong(container).getAttribute('aria-describedby')).toBe(warning(container).id)
  })

  it('stays visible when the pointer passes over Fort and leaves while Fort keeps the keyboard focus', () => {
    const container = render()
    focus(strong(container))
    expect(warning(container).hidden).toBe(false)
    pointerEnter(strong(container))
    pointerLeave(strong(container))
    expect(document.activeElement).toBe(strong(container))
    expect(warning(container).hidden).toBe(false)
  })

  it('stays visible after a mouse click (which leaves the focus on the button) and the pointer going away', () => {
    const container = render()
    pointerEnter(strong(container))
    focus(strong(container))
    pointerLeave(strong(container))
    expect(warning(container).hidden).toBe(false)
  })

  it('stays visible when the focus leaves while the pointer is still on Fort, and hides when neither is there', () => {
    const container = render()
    pointerEnter(strong(container))
    focus(strong(container))
    blur(strong(container))
    expect(warning(container).hidden).toBe(false)
    pointerLeave(strong(container))
    expect(warning(container).hidden).toBe(true)
  })

  it('hides on blur when the pointer is not on Fort, and the other strengths do not show it', () => {
    const container = render()
    focus(strong(container))
    blur(strong(container))
    expect(warning(container).hidden).toBe(true)
    focus(medium(container))
    pointerEnter(medium(container))
    expect(warning(container).hidden).toBe(true)
  })

  it('keeps it for a finger: its « leave » comes before the click, and the tap is the only thing that engaged Fort', () => {
    const container = render()
    pointerEnter(strong(container), 'touch')
    pointerLeave(strong(container), 'touch')
    expect(warning(container).hidden).toBe(false)
  })

  it('shows while Fort runs, wherever the pointer and the focus are', () => {
    const container = render({ running: { level: 'high' } })
    expect(warning(container).hidden).toBe(false)
  })

  it('forgets the pointer and the focus when the section folds, so that nothing stale is left on reopening', () => {
    const container = render()
    focus(strong(container))
    pointerEnter(strong(container))
    expect(warning(container).hidden).toBe(false)
    mounted!.rerender(draw(false))
    mounted!.rerender(draw(true))
    expect(warning(container).hidden).toBe(true)
  })
})
