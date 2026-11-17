// Test support (nothing of the application imports it): a React tree mounted in a real document, for what a static render cannot show: state
// that changes, effects and their clean-up, listeners, timers. A test file asks for the document with `// @vitest-environment happy-dom` on its
// first line; the other tests keep running in plain Node.

import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

// React warns about a state change outside `act` unless the environment says tests run here.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Mounted {
  container: HTMLElement
  /** Draws another tree in place of the first (new props for the same component). */
  rerender(element: ReactElement): void
  /** Removes the tree: its effects are cleaned up. */
  unmount(): void
}

/** Mounts a tree in the document, its effects run. */
export function mount(element: ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount() {
      act(() => root.unmount())
      container.remove()
    }
  }
}

/**
 * Puts a bridge to the main process on the window (`window.lucium`): `own` is what the test answers. Anything else a component asks is harmless: a
 * subscription (`on…`) answers a way to stop, any other call is a request that never gets its answer. Answers the bridge.
 */
export function installBridge(own: object): Record<string, unknown> {
  const given = own as Record<string, unknown>
  const bridge = new Proxy(given, {
    get: (target, prop) => {
      if (typeof prop !== 'string') return undefined
      if (prop in target) return target[prop]
      return prop.startsWith('on') ? () => () => undefined : () => new Promise(() => undefined)
    }
  })
  ;(window as unknown as { lucium: unknown }).lucium = bridge
  return bridge
}

/** A click, as the pointer makes it, and whatever it starts (a promise that settles at once included). */
export async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The pointer comes onto `target` from outside the window (what `onMouseEnter` listens to), or leaves it. */
export function pointerOver(target: Element): void {
  act(() => void target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })))
}
export function pointerOut(target: Element): void {
  act(() => void target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })))
}

/** Types a text in a field React controls: the value is set as the browser sets it, then the field says it changed. */
export function type(field: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field) as object, 'value')?.set
  if (!set) throw new Error('this element has no value to type in')
  act(() => {
    set.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Lets what is pending settle (a reply that arrives later), the tree drawn again. */
export async function settle(run: () => void | Promise<void> = () => undefined): Promise<void> {
  await act(async () => {
    await run()
  })
}

/** The button with exactly this label, or an error that lists the buttons there are. */
export function button(container: Element, label: string): HTMLButtonElement {
  const all = [...container.querySelectorAll('button')]
  const found = all.find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}" among: ${all.map((one) => one.textContent?.trim()).join(' | ')}`)
  return found
}
