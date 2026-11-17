// The keyboard and the menu move a tab one place: the step is the `tab/move` the reducer already applies to a drop. These tests apply the step
// through the reducer, so that what they check is the order the sidebar shows.

import { describe, expect, it } from 'vitest'
import { isListedTab, type SidebarState } from './model'
import { createInitialState, reduce, type Action } from './sidebar'
import { tabStep } from './tab-step'

let counter = 0
const ctx = { now: 1_000, newId: () => `step${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

const urlOf = (name: string) => `https://${name}.example/`
const idOf = (state: SidebarState, name: string): string => state.tabs.find((t) => t.url === urlOf(name))!.id

/** The urls of the Today tabs of the active space, in the order the sidebar draws them. */
const today = (state: SidebarState): string[] => state.tabs.filter((t) => t.spaceId === state.activeSpaceId && isListedTab(t) && !t.pinned).map((t) => t.url)

/** The state after one step of the tab `name` (the same state when there is no step). */
function stepped(state: SidebarState, name: string, direction: -1 | 1): SidebarState {
  const step = tabStep(state, idOf(state, name), direction)
  return step ? run(state, { type: 'tab/move', id: idOf(state, name), ...step }) : state
}

/** Four Today tabs: one, two, three, four. */
function four(): SidebarState {
  return run(createInitialState(ctx), ...['one', 'two', 'three', 'four'].map((name): Action => ({ type: 'tab/open', url: urlOf(name) })))
}

describe('tabStep', () => {
  it('moves a tab one place up or down, as a drop does', () => {
    const state = four()
    const [one, two, three, last] = ['one', 'two', 'three', 'four'].map(urlOf)
    expect(today(stepped(state, 'two', -1))).toEqual([two, one, three, last])
    expect(today(stepped(state, 'two', 1))).toEqual([one, three, two, last])
    expect(today(stepped(state, 'three', -1))).toEqual([one, three, two, last])
    expect(today(stepped(state, 'one', 1))).toEqual([two, one, three, last])
  })

  it('has no step past the ends of the group', () => {
    const state = four()
    expect(tabStep(state, idOf(state, 'one'), -1)).toBeNull()
    expect(tabStep(state, idOf(state, 'four'), 1)).toBeNull()
    expect(tabStep(state, idOf(state, 'two'), -1)).not.toBeNull()
  })

  it('keeps a pinned tab among the pinned ones: a step never crosses the Today tabs', () => {
    const base = four()
    let state = run(base, { type: 'tab/pin', id: idOf(base, 'one') })
    state = run(state, { type: 'tab/pin', id: idOf(state, 'two') })
    const pinned = (s: SidebarState) => s.tabs.filter((t) => t.spaceId === s.activeSpaceId && t.pinned).map((t) => t.url)
    const [first, second] = pinned(state)
    expect(tabStep(state, idOf(state, 'one'), -1)).toBeNull()
    const down = stepped(state, 'one', 1)
    expect(pinned(down)).toEqual([second, first])
    expect(down.tabs.find((t) => t.url === urlOf('one'))!.pinned).toBe(true)
    expect(tabStep(state, idOf(state, 'two'), 1)).toBeNull()
  })

  it('keeps the folder of a pinned tab when it moves', () => {
    const base = four()
    let state = run(base, { type: 'tab/pin', id: idOf(base, 'one') }, { type: 'tab/pin', id: idOf(base, 'two') }, { type: 'folder/create', name: 'Dossier' })
    const folderId = state.folders[0]!.id
    state = { ...state, tabs: state.tabs.map((t) => (t.url === urlOf('one') ? { ...t, folderId } : t)) }
    const down = stepped(state, 'one', 1)
    expect(down.tabs.find((t) => t.url === urlOf('one'))!.folderId).toBe(folderId)
  })

  it('with the tree on, a branch moves with its parent, and a child cannot step above its parent', () => {
    const base = four()
    // "two" hangs under "one": the branch of "one" is one and two, and its places are three and four.
    const tree: SidebarState = { ...base, settings: { ...base.settings, tabTree: true }, tabs: base.tabs.map((t) => (t.url === urlOf('two') ? { ...t, parentId: idOf(base, 'one') } : t)) }
    const down = stepped(tree, 'one', 1)
    expect(today(down)).toEqual([urlOf('three'), urlOf('one'), urlOf('two'), urlOf('four')])
    expect(down.tabs.find((t) => t.url === urlOf('two'))!.parentId).toBe(idOf(tree, 'one'))
    expect(tabStep(tree, idOf(tree, 'two'), -1)).toBeNull()
    // Its branch is all there is below "one": no place to step to, so the menu entry is off (not on, for a move that changes nothing).
    const alone = { ...tree, tabs: tree.tabs.filter((t) => t.url === urlOf('one') || t.url === urlOf('two')) }
    expect(tabStep(alone, idOf(alone, 'one'), 1)).toBeNull()
  })
})
