// A menu drawn by the interface is walked with the arrows, as the pattern of a menu says: the focus opens on the first entry that can be chosen,
// goes from entry to entry and round the ends, and skips the greyed ones.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusFirstEntry, menuEntries, moveInMenu } from './menu-keys'
import { elementsOf } from './render.test-support'

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => null }))

import { TitleMenu } from './BoostEditor'

afterEach(() => vi.unstubAllGlobals())

/** A menu with these entries (a `false` is a greyed one), as `querySelectorAll` answers it: the selector leaves the greyed entries out. */
function menu(enabled: boolean[]) {
  const focused: number[] = []
  const entries = enabled.map((on, index) => ({ index, on, focus: () => void focused.push(index) }))
  const selectors: string[] = []
  const root = {
    querySelectorAll: (selector: string) => {
      selectors.push(selector)
      return entries.filter((entry) => entry.on)
    }
  } as unknown as HTMLElement
  const move = (from: number | null, key: string): number | null => (moveInMenu(root, from === null ? null : (entries[from] as unknown as Element), key) as unknown as { index: number } | null)?.index ?? null
  return { root, entries, focused, selectors, move }
}

describe('the keys of a menu', () => {
  it('asks for the entries that are not greyed', () => {
    const { root, selectors } = menu([true, false, true])
    expect(menuEntries(root)).toHaveLength(2)
    expect(selectors).toEqual(['[role="menuitem"]:not(:disabled)'])
  })

  it('opens with the focus on the first entry that can be chosen', () => {
    const { root, focused } = menu([false, true, true])
    expect((focusFirstEntry(root) as unknown as { index: number }).index).toBe(1)
    expect(focused).toEqual([1])
    expect(focusFirstEntry(menu([false]).root)).toBeNull()
  })

  it('goes down and up from entry to entry, past the greyed ones and round the ends, and gives the focus for real', () => {
    const { move, focused } = menu([true, false, true, true])
    expect(move(0, 'ArrowDown')).toBe(2)
    expect(move(2, 'ArrowDown')).toBe(3)
    expect(move(3, 'ArrowDown')).toBe(0)
    expect(move(0, 'ArrowUp')).toBe(3)
    expect(move(2, 'ArrowUp')).toBe(0)
    expect(focused).toEqual([2, 3, 0, 3, 0])
  })

  it('goes to the first and the last entry with Home and End', () => {
    const { move } = menu([false, true, true, true, false])
    expect(move(2, 'Home')).toBe(1)
    expect(move(2, 'End')).toBe(3)
  })

  it('starts from the top (the bottom with ↑) when the focus is on no entry', () => {
    const { move } = menu([true, true, true])
    expect(move(null, 'ArrowDown')).toBe(0)
    expect(move(null, 'ArrowUp')).toBe(2)
  })

  it('leaves any other key alone', () => {
    const { move, focused } = menu([true, true])
    for (const key of ['Enter', ' ', 'a', 'Escape', 'Tab', 'ArrowLeft']) expect(move(0, key), key).toBeNull()
    expect(focused).toEqual([])
  })
})

describe('the menu of the title of the Tweak editor', () => {
  /** The card of the menu with three entries, the focus on the first, and what a key pressed in it does. */
  function card() {
    const focused: number[] = []
    const entries = [0, 1, 2].map((index) => ({ index, focus: () => void focused.push(index) }))
    vi.stubGlobal('document', { activeElement: entries[0] })
    let left = 0
    const element = elementsOf(createElement(TitleMenu, { onLeave: () => void left++, children: null })).find((one) => one.props['role'] === 'menu')!
    const press = (key: string): boolean => {
      let taken = false
      ;(element.props['onKeyDown'] as (event: unknown) => void)({ key, currentTarget: { querySelectorAll: () => entries }, preventDefault: () => void (taken = true) })
      return taken
    }
    return { element, press, focused, left: () => left }
  }

  it('is a named menu', () => {
    expect(card().element.props['aria-label']).toBeTruthy()
  })

  it('moves the focus with the arrows, Home and End, and takes those keys from the panel', () => {
    const { press, focused } = card()
    expect(press('ArrowDown')).toBe(true)
    expect(press('End')).toBe(true)
    expect(press('ArrowUp')).toBe(true)
    expect(focused).toEqual([1, 2, 2])
  })

  it('closes on Tab, which is taken: the focus does not run on through what is behind the menu', () => {
    const { press, left } = card()
    expect(press('Tab')).toBe(true)
    expect(left()).toBe(1)
  })

  it('leaves Return and Space to the entry that has the focus', () => {
    const { press, left } = card()
    expect(press('Enter')).toBe(false)
    expect(press(' ')).toBe(false)
    expect(left()).toBe(0)
  })
})
