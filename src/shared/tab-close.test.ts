import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { menuCloseAction, splitCloseActions, tabCloseAction } from './tab-close'

describe('splitCloseActions', () => {
  const awake = () => false

  it('archives the Today tabs of a split view together, so that one "Annuler" brings them all back', () => {
    expect(splitCloseActions([{ id: 'a' }, { id: 'b' }, { id: 'c' }], awake)).toEqual([{ type: 'tabs/archive-many', ids: ['a', 'b', 'c'] }])
  })

  it('lets each pinned tab do what its own cross does: an open one goes back to sleep, a sleeping one leaves the pinned ones', () => {
    expect(splitCloseActions([{ id: 'a', pinned: true }, { id: 'b', pinned: true }], (id) => id === 'b')).toEqual([
      { type: 'tab/close', id: 'a' },
      { type: 'tab/remove-pinned', id: 'b' }
    ])
  })

  it('archives the tabs of a private window one by one, since a private window keeps no shared archive', () => {
    expect(splitCloseActions([{ id: 'a', private: true }, { id: 'b', private: true }], awake)).toEqual([
      { type: 'tab/archive', id: 'a' },
      { type: 'tab/archive', id: 'b' }
    ])
  })

  it('does nothing for an empty view', () => {
    expect(splitCloseActions([], awake)).toEqual([])
  })
})

describe('tabCloseAction', () => {
  it('archives a Today tab, asleep or not', () => {
    expect(tabCloseAction({}, false)).toBe('tab/archive')
    expect(tabCloseAction({ pinned: false }, true)).toBe('tab/archive')
  })

  it('only puts an open pinned tab back to sleep, and takes a sleeping one out of the pinned ones', () => {
    expect(tabCloseAction({ pinned: true }, false)).toBe('tab/close')
    expect(tabCloseAction({ pinned: true }, true)).toBe('tab/remove-pinned')
  })

  it('never removes the pinned entry of a tab opened from a favourite: it only closes', () => {
    expect(tabCloseAction({ pinned: true, favoriteId: 'f1' }, true)).toBe('tab/close')
    expect(tabCloseAction({ pinned: true, favoriteId: 'f1' }, false)).toBe('tab/close')
  })
})

describe('menuCloseAction', () => {
  it('archives a Today tab, as ⌘W and the cross of its row do: « Rouvrir le dernier onglet fermé » finds it', () => {
    expect(menuCloseAction({ id: 'a' })).toEqual({ type: 'tab/archive', id: 'a' })
    expect(menuCloseAction({ id: 'a', pinned: false })).toEqual({ type: 'tab/archive', id: 'a' })
  })

  it('puts a pinned tab back to sleep on its anchor', () => {
    expect(menuCloseAction({ id: 'p', pinned: true })).toEqual({ type: 'tab/close', id: 'p' })
  })
})

describe('the card over a row of the sidebar', () => {
  it('closes through the same rule as the menu of the tab', () => {
    const source = readFileSync(fileURLToPath(new URL('../renderer/Sidebar.tsx', import.meta.url)), 'utf8')
    expect(source).toContain("action === 'close') void act.dispatch(menuCloseAction(tab))")
  })
})
