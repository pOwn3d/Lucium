// A panel of the overlay keeps a focus for as long as it is open. Escape is heard on the backdrop and on the panel, so only while something inside
// has the focus: when the row that had it is removed (« Supprimer » then « Confirmer » in the bookmarks), the panel takes it back.

import { describe, expect, it } from 'vitest'
import { keepPanelFocus, takePanelFocus, type FocusHolder } from './overlay-focus'

/** A backdrop with one panel (or none yet), and a document whose focus the panel takes when it is focused. */
function scene(drawn = true) {
  const body = { name: 'body' } as unknown as Element
  const holder: FocusHolder = { activeElement: body, body }
  const attributes = new Set<string>()
  const panel = {
    tabIndex: 0,
    focused: 0,
    hasAttribute: (name: string) => attributes.has(name),
    focus() {
      this.focused++
      holder.activeElement = this as unknown as Element
    }
  }
  const state = { drawn }
  const root = { querySelector: () => (state.drawn ? panel : null) } as unknown as HTMLElement
  let changed: (() => void) | null = null
  const watch = (callback: () => void) => {
    changed = callback
    return () => void (changed = null)
  }
  return { body, holder, panel, attributes, state, root, watch, change: () => changed?.(), watching: () => changed !== null }
}

describe('the focus of a panel of the overlay', () => {
  it('goes to the panel when it opens with nothing focused, and the panel is made focusable for that', () => {
    const { holder, panel, root } = scene()
    expect(takePanelFocus(root, holder)).toBe(true)
    expect(panel.focused).toBe(1)
    expect(panel.tabIndex).toBe(-1)
  })

  it('stays where it is when a part of the panel has it (a field with autofocus), and a tabindex the panel chose is kept', () => {
    const { holder, panel, root, attributes } = scene()
    holder.activeElement = { name: 'field' } as unknown as Element
    expect(takePanelFocus(root, holder)).toBe(true)
    expect(panel.focused).toBe(0)
    holder.activeElement = null
    attributes.add('tabindex')
    takePanelFocus(root, holder)
    expect(panel.tabIndex).toBe(0)
    expect(panel.focused).toBe(1)
  })

  it('waits for a panel that is drawn after the first snapshot', () => {
    const { holder, panel, root, state, watch, change } = scene(false)
    keepPanelFocus(root, holder, watch)
    expect(panel.focused).toBe(0)
    state.drawn = true
    change()
    expect(panel.focused).toBe(1)
  })

  it('comes back to the panel when the row that had it is removed, so that Escape still closes the panel', () => {
    const { body, holder, panel, root, watch, change } = scene()
    const stop = keepPanelFocus(root, holder, watch)
    expect(panel.focused).toBe(1)
    // The person tabs to « Supprimer » and confirms: the row goes, and the focus with it.
    holder.activeElement = { name: 'the button Confirmer of a row' } as unknown as Element
    change()
    expect(panel.focused).toBe(1)
    holder.activeElement = body
    change()
    expect(panel.focused).toBe(2)
    expect(holder.activeElement).toBe(panel)
    stop()
  })

  it('stops watching when the panel closes', () => {
    const { holder, root, watch, watching } = scene()
    const stop = keepPanelFocus(root, holder, watch)
    expect(watching()).toBe(true)
    stop()
    expect(watching()).toBe(false)
  })
})
