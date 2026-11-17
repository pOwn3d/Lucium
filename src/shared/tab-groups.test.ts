import { describe, expect, it } from 'vitest'
import { emptyGroups, forgetTab, getGroup, groupOf, groupTabs, MAX_GROUP_TITLE, membersOf, queryGroups, TAB_GROUP_ID_NONE, ungroupTabs, updateGroup } from './tab-groups'

// Tabs 1-3 live in window 10, tab 4 in window 20.
const windows: Record<number, number> = { 1: 10, 2: 10, 3: 10, 4: 20 }
const windowOf = (tab: number) => windows[tab]

describe('groupTabs', () => {
  it('creates a group in the window of the tabs when no group is given, and returns its id', () => {
    const { state, value, change } = groupTabs(emptyGroups(), [1, 2], {}, windowOf)
    expect(membersOf(state, value).sort()).toEqual([1, 2])
    expect(state.groups[value]).toMatchObject({ windowId: 10, title: '', color: 'grey', collapsed: false })
    expect(change.created).toHaveLength(1)
    expect(change.tabs.sort()).toEqual([1, 2])
  })

  it('adds tabs to an existing group', () => {
    const first = groupTabs(emptyGroups(), [1], {}, windowOf)
    const next = groupTabs(first.state, [2], { groupId: first.value }, windowOf)
    expect(next.value).toBe(first.value)
    expect(membersOf(next.state, first.value).sort()).toEqual([1, 2])
    expect(next.change.created).toEqual([])
  })

  it('reports no tab change for a tab that is already in the group', () => {
    const first = groupTabs(emptyGroups(), [1], {}, windowOf)
    expect(groupTabs(first.state, [1], { groupId: first.value }, windowOf).change.tabs).toEqual([])
  })

  it('moves a tab out of its previous group, and drops that group when it ends up empty', () => {
    const a = groupTabs(emptyGroups(), [1], {}, windowOf)
    const b = groupTabs(a.state, [2], {}, windowOf)
    const moved = groupTabs(b.state, [1], { groupId: b.value }, windowOf)
    expect(groupOf(moved.state, 1)).toBe(b.value)
    expect(moved.state.groups[a.value]).toBeUndefined()
    expect(moved.change.removed.map((g) => g.id)).toEqual([a.value])
  })

  it('refuses an unknown group, no tabs, an unknown tab, and tabs of another window than the group', () => {
    const a = groupTabs(emptyGroups(), [1], {}, windowOf)
    expect(() => groupTabs(a.state, [2], { groupId: 99 }, windowOf)).toThrow('No group with id: 99.')
    expect(() => groupTabs(a.state, [], {}, windowOf)).toThrow('No tabs specified.')
    expect(() => groupTabs(a.state, [77], {}, windowOf)).toThrow('No tab with id: 77.')
    expect(() => groupTabs(a.state, [4], { groupId: a.value }, windowOf)).toThrow('same window')
    expect(() => groupTabs(a.state, [1, 4], {}, windowOf)).toThrow('same window')
  })

  it('does not change the state it was given', () => {
    const before = emptyGroups()
    groupTabs(before, [1], {}, windowOf)
    expect(before).toEqual(emptyGroups())
  })
})

describe('ungroupTabs and forgetTab', () => {
  it('takes tabs out, keeps a group that still has tabs, and drops an empty one', () => {
    const made = groupTabs(emptyGroups(), [1, 2], {}, windowOf)
    const one = ungroupTabs(made.state, [1])
    expect(groupOf(one.state, 1)).toBe(TAB_GROUP_ID_NONE)
    expect(one.state.groups[made.value]).toBeDefined()
    const both = ungroupTabs(one.state, [2])
    expect(both.state.groups[made.value]).toBeUndefined()
    expect(both.change.removed.map((g) => g.id)).toEqual([made.value])
  })

  it('ignores a tab that is in no group', () => {
    expect(ungroupTabs(emptyGroups(), [3]).change.tabs).toEqual([])
  })

  it('a closed tab leaves its group like an ungrouped one', () => {
    const made = groupTabs(emptyGroups(), [1], {}, windowOf)
    expect(forgetTab(made.state, 1).state.groups[made.value]).toBeUndefined()
  })
})

describe('updateGroup and queryGroups', () => {
  const made = groupTabs(emptyGroups(), [1], {}, windowOf)
  const id = made.value

  it('sets title, color and collapsed, and reports the update only when something changed', () => {
    const updated = updateGroup(made.state, id, { title: 'Claude', color: 'orange', collapsed: true })
    expect(updated.value).toMatchObject({ title: 'Claude', color: 'orange', collapsed: true })
    expect(updated.change.updated).toHaveLength(1)
    expect(updateGroup(updated.state, id, { title: 'Claude' }).change.updated).toEqual([])
  })

  it('refuses an unknown group and a color the API does not have', () => {
    expect(() => updateGroup(made.state, 99, { title: 'x' })).toThrow('No group with id: 99.')
    expect(() => updateGroup(made.state, id, { color: 'mauve' })).toThrow('Invalid color')
    expect(() => getGroup(made.state, 99)).toThrow('No group with id: 99.')
  })

  it('queries by title (with a wildcard), color, collapsed and window', () => {
    let state = updateGroup(made.state, id, { title: 'Claude (work)', color: 'orange' }).state
    expect(queryGroups(state, { title: 'Claude*' })).toHaveLength(1)
    expect(queryGroups(state, { title: 'Claude' })).toHaveLength(0)
    expect(queryGroups(state, { color: 'orange', collapsed: false })).toHaveLength(1)
    expect(queryGroups(state, { color: 'blue' })).toHaveLength(0)
    expect(queryGroups(state, { windowId: 10 })).toHaveLength(1)
    expect(queryGroups(state, { windowId: 20 })).toHaveLength(0)
    expect(queryGroups(state, { windowId: -2 }, 10)).toHaveLength(1)
    state = groupTabs(state, [4], {}, windowOf).state
    expect(queryGroups(state, {})).toHaveLength(2)
  })

  it('treats regular-expression characters in a title pattern literally', () => {
    const state = updateGroup(made.state, id, { title: 'a.b' }).state
    expect(queryGroups(state, { title: 'a.b' })).toHaveLength(1)
    expect(queryGroups(state, { title: 'axb' })).toHaveLength(0)
  })
})

describe('tab group titles', () => {
  it('matches a query by title with a glob that cannot be made to run for long', () => {
    const { state, value } = groupTabs(emptyGroups(), [1], {}, windowOf)
    const named = updateGroup(state, value, { title: 'a'.repeat(32) }).state
    const start = performance.now()
    expect(queryGroups(named, { title: '*a'.repeat(14) + '*b' })).toEqual([])
    expect(performance.now() - start).toBeLessThan(50)
    expect(queryGroups(named, { title: 'a*' })).toHaveLength(1)
  })

  it('keeps a title to a few words', () => {
    const { state, value } = groupTabs(emptyGroups(), [1], {}, windowOf)
    expect(updateGroup(state, value, { title: 'x'.repeat(100_000) }).value.title).toHaveLength(MAX_GROUP_TITLE)
  })
})
