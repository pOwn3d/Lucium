// A deleted profile: a profile made again under the same name starts empty, in a folder of its own, and the ids of deleted profiles are
// freed only once the next launch removed their folders. The engine and the window: src/main/shell/profile-delete.test.ts.

import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Ctx } from './sidebar'
import type { SidebarState } from './model'
import { planProfileCreation } from './profiles'
import { cleanRetiredProfiles, profileDeletionRefusal, RETIRED_PROFILES_MAX, retiredSettings, retiredToSweep } from './profile-retire'
import { interfaceMayDispatch } from './ipc-policy'

const ctx = (): Ctx => {
  let n = 0
  return { now: 5, newId: () => `n${++n}` }
}

/** A state with a profile « Travail » (id `travail`) no space uses, used once, with a setting of its own. */
function withWork(): SidebarState {
  const state = createInitialState(ctx())
  return { ...state, settings: { ...state.settings, profileNames: { travail: 'Travail' }, profiles: { travail: { historyOff: true } }, usedProfiles: ['travail'] } }
}

const deleted = (state: SidebarState, id: string): SidebarState => ({ ...state, settings: { ...state.settings, ...retiredSettings(state.settings, id) } })

describe('a deleted profile', () => {
  it('loses its name, its own settings and its mark of use, and its id is retired once', () => {
    const after = deleted(deleted(withWork(), 'travail'), 'travail')
    expect(after.settings.profileNames).toEqual({})
    expect(after.settings.profiles).toEqual({})
    expect(after.settings.usedProfiles).toEqual([])
    expect(after.settings.retiredProfileIds).toEqual(['travail'])
  })

  it('does not hand its id to a profile made again under the same name, from the window or with a new space', () => {
    const after = deleted(withWork(), 'travail')
    const planned = planProfileCreation(after, 'Travail', [])
    expect(planned.ok && planned.id).toBe('travail-2')
    const space = reduce(after, { type: 'space/create', name: 'Bureau', emoji: '💼', hue: 200, profileName: 'Travail' }, ctx())
    expect(space.spaces.at(-1)?.profileId).toBe('travail-2')
  })

  it('cannot be the default profile, nor a profile a space uses, even a space put aside', () => {
    const state = withWork()
    expect(profileDeletionRefusal(state, 'default')).toBe('default')
    expect(profileDeletionRefusal(state, '../x')).toBe('invalid')
    expect(profileDeletionRefusal(state, 'travail')).toBeNull()
    const used = { ...state, spaces: [...state.spaces, { ...state.spaces[0]!, id: 'w', profileId: 'travail' }] }
    expect(profileDeletionRefusal(used, 'travail')).toBe('in-use')
    const aside = { ...state, sessions: [{ id: 's', name: 'x', savedAt: 1, tabs: [], space: { space: { ...state.spaces[0]!, profileId: 'travail' } } }] } as unknown as SidebarState
    expect(profileDeletionRefusal(aside, 'travail')).toBe('in-use')
  })
})

describe('the folders of the retired profiles at launch', () => {
  it('are removed only when the state was read, and never for a profile that exists again', () => {
    const after = deleted(withWork(), 'travail')
    expect(retiredToSweep(after, false)).toEqual([])
    expect(retiredToSweep(after, true)).toEqual(['travail'])
    const again = { ...after, settings: { ...after.settings, profileNames: { travail: 'Travail' } } }
    expect(retiredToSweep(again, true)).toEqual([])
  })
})

describe('the list of the retired profiles', () => {
  it('holds valid profile ids only, each once, never the default one, within a bound', () => {
    expect(cleanRetiredProfiles(['a', 'a', 'default', '../x', 7, '__proto__', 'b'])).toEqual(['a', 'b'])
    expect(cleanRetiredProfiles('a')).toEqual([])
    expect(cleanRetiredProfiles(Array.from({ length: 1000 }, (_, i) => `p${i}`))).toHaveLength(RETIRED_PROFILES_MAX)
  })

  it('is written by the main process only: the interface could free an id whose folder is still on disk', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { retiredProfileIds: [] } }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { profileNames: {} } }, [])).toBe(true)
  })

  it('survives the restore of a file, which may add ids and never frees one', () => {
    const here = deleted(withWork(), 'travail')
    const file = { ...createInitialState(ctx()), settings: { ...createInitialState(ctx()).settings, retiredProfileIds: ['ancien'] } }
    const restored = reduce(here, { type: 'state/restore', state: file }, ctx())
    expect(restored.settings.retiredProfileIds).toEqual(['travail', 'ancien'])
  })
})
