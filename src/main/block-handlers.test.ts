// The block-exception handlers: one per open tab, registered once and cleared when the tab closes.
import { describe, expect, it } from 'vitest'
import { createInitialState, reduce } from '@shared/sidebar'
import { createBlockHandlerFollower, createBlockHandlerSync } from './block-handlers'

/** A sync whose registrations and clearings are recorded, in order. */
function setup() {
  const calls: string[] = []
  const sync = createBlockHandlerSync(
    (id) => void calls.push(`set ${id}`),
    (id) => void calls.push(`clear ${id}`)
  )
  return { calls, sync }
}

describe('the block-exception handlers', () => {
  it('are registered for the tabs that have none yet, and only once while a tab stays open', () => {
    const { calls, sync } = setup()
    sync(new Set(['a', 'b']))
    expect(calls).toEqual(['set a', 'set b'])
    // The store notifies on every state change: a tab already handled is not registered again.
    sync(new Set(['a', 'b']))
    sync(new Set(['a', 'b', 'c']))
    expect(calls).toEqual(['set a', 'set b', 'set c'])
  })

  it('are cleared for the tabs that closed, once, and not for the ones that stay', () => {
    const { calls, sync } = setup()
    sync(new Set(['a', 'b']))
    calls.length = 0
    sync(new Set(['b']))
    expect(calls).toEqual(['clear a'])
    sync(new Set(['b']))
    expect(calls).toEqual(['clear a'])
  })

  it('are registered again for a tab that comes back after it was cleared', () => {
    const { calls, sync } = setup()
    sync(new Set(['a']))
    sync(new Set())
    sync(new Set(['a']))
    expect(calls).toEqual(['set a', 'clear a', 'set a'])
  })
})

describe('the handlers following the tabs of the state', () => {
  /** Tabs that count each time one of their ids is read. */
  function counted(ids: string[]) {
    const reads = { count: 0 }
    const tabs = ids.map((id) => ({
      get id() {
        reads.count++
        return id
      }
    }))
    return { tabs, reads }
  }

  it('look at nothing when the state changed without its tabs: the same array is the same tabs', () => {
    const calls: string[] = []
    const follow = createBlockHandlerFollower((id) => void calls.push(`set ${id}`), (id) => void calls.push(`clear ${id}`))
    const first = counted(['a', 'b'])
    follow(first.tabs)
    expect(calls).toEqual(['set a', 'set b'])
    const readsAfterFirst = first.reads.count
    follow(first.tabs)
    follow(first.tabs)
    expect(first.reads.count).toBe(readsAfterFirst)
    expect(calls).toEqual(['set a', 'set b'])
  })

  it('register and clear when the tabs are another array: a tab opened, a tab closed', () => {
    const calls: string[] = []
    const follow = createBlockHandlerFollower((id) => void calls.push(`set ${id}`), (id) => void calls.push(`clear ${id}`))
    follow(counted(['a', 'b']).tabs)
    follow(counted(['b', 'c']).tabs)
    expect(calls).toEqual(['set a', 'set b', 'set c', 'clear a'])
    // The same tabs in a new array (a title changed): nothing is registered twice.
    follow(counted(['b', 'c']).tabs)
    expect(calls).toHaveLength(4)
  })
})

describe('the handlers at each change of the state', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

  it('are brought in line when the list of the tabs is another one, down to no tab at all', () => {
    const calls: string[] = []
    const follow = createBlockHandlerFollower((id) => void calls.push(`set ${id}`), (id) => void calls.push(`clear ${id}`))
    let tabs: Array<{ id: string }> = [{ id: 'a' }]
    follow(tabs)
    follow(tabs)
    expect(calls).toEqual(['set a'])
    tabs = [...tabs, { id: 'b' }]
    follow(tabs)
    follow(tabs)
    expect(calls).toEqual(['set a', 'set b'])
    follow([])
    expect(calls).toEqual(['set a', 'set b', 'clear a', 'clear b'])
  })

  // What the saving rests on: the reducer hands the same list back while no tab changes, and another one as soon as one comes or goes.
  it('cost nothing for a change that touches no tab: the state keeps its list of tabs through a setting, and makes another one for a new tab', () => {
    let state = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/', spaceId: state.spaces[0]!.id }, ctx)
    const calls: string[] = []
    const follow = createBlockHandlerFollower((id) => void calls.push(`set ${id}`), (id) => void calls.push(`clear ${id}`))
    follow(state.tabs)
    expect(calls).toHaveLength(1)
    const before = state.tabs
    state = reduce(state, { type: 'settings/update', patch: { showToolbar: !state.settings.showToolbar } }, ctx)
    expect(state.tabs).toBe(before)
    follow(state.tabs)
    state = reduce(state, { type: 'tab/open', url: 'https://exemple.org/', spaceId: state.spaces[0]!.id }, ctx)
    expect(state.tabs).not.toBe(before)
    follow(state.tabs)
    expect(calls).toHaveLength(2)
  })
})
