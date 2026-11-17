import { describe, expect, it } from 'vitest'
import { actionBarStateFor, type ActionBarState } from './action-state'

const state = (): ActionBarState => ({
  // The library's own answer: the tab of the window that last had the focus (tab 10), whoever asks.
  activeTabId: 10,
  actions: [
    { id: 'aaa', title: 'Probe', text: 'G', color: '#f00', tabs: { '10': { text: '1' }, '20': { text: 'b', title: 'Second window' } } },
    { id: 'bbb', title: 'Other', tabs: {} }
  ]
})

describe('actionBarStateFor', () => {
  it('draws the tab on screen in the window, not the one of the window that had the focus last', () => {
    expect(actionBarStateFor(state(), 20).activeTabId).toBe(20)
    expect(actionBarStateFor(state(), 10).activeTabId).toBe(10)
  })

  it('shows what was set for that tab, and nothing of what was set for the tab of another window', () => {
    const [first] = actionBarStateFor(state(), 20).actions
    expect(first).toMatchObject({ id: 'aaa', text: 'b', title: 'Second window', color: '#f00' })
    expect(actionBarStateFor(state(), 10).actions[0]).toMatchObject({ text: '1', title: 'Probe' })
  })

  it('lets what was set for a tab beat what was set for every tab (the rule of the chrome.action API), instead of the other way round', () => {
    expect(actionBarStateFor(state(), 10).actions[0]!.text).toBe('1')
    // A tab that set nothing shows the default.
    expect(actionBarStateFor(state(), 30).actions[0]).toMatchObject({ text: 'G', title: 'Probe' })
  })

  it('shows the defaults when the window has no tab of the profile, and leaves no tab to be taken for the active one', () => {
    const none = actionBarStateFor(state(), undefined)
    expect(none.activeTabId).toBeUndefined()
    expect(none.actions[0]).toMatchObject({ text: 'G' })
  })

  it('keeps the other fields of an action and does not change what it was given', () => {
    const given = state()
    const result = actionBarStateFor(given, 20)
    expect(result.actions[1]).toEqual({ id: 'bbb', title: 'Other', tabs: {} })
    expect(given.actions[0]!.text).toBe('G')
    expect(given.activeTabId).toBe(10)
  })

  it('returns what is not a state as it came', () => {
    expect(actionBarStateFor(undefined, 1)).toBeUndefined()
    expect(actionBarStateFor('x', 1)).toBe('x')
    expect(actionBarStateFor({ activeTabId: 1 }, 1)).toEqual({ activeTabId: 1 })
  })
})
