// A profile whose folder is gone: its spaces go back to the default profile, after the state was copied, and the dialog says where the copy is.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { StateStore } from '../store'
import { recoverMissingProfiles } from './recover-profiles'

const shown = vi.hoisted(() => ({ boxes: [] as Array<{ message: string; detail: string }> }))
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: async (_win: unknown, options: { message: string; detail: string }) => {
      shown.boxes.push(options)
      return { response: 0 }
    }
  }
}))

let n = 0
const ctx = () => ({ now: 1_700_000_000_000, newId: () => `id${++n}` })
const win = {} as BrowserWindow

/** A store over a state with a space on the profile of its own, which the state says was used. `order` records what happened, in order. */
function world() {
  let state: SidebarState = createInitialState(ctx())
  const apply = (action: Action): void => void (state = reduce(state, action, ctx()))
  apply({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileName: 'Pro' })
  const pro = state.spaces.at(-1)!.profileId
  apply({ type: 'profile/used', id: pro })
  const order: string[] = []
  const store = {
    get: () => state,
    dispatch: (action: Action) => {
      order.push(action.type)
      apply(action)
    }
  } as unknown as StateStore
  const profileOfWork = (): string => state.spaces.find((space) => space.name === 'Travail')!.profileId
  return { store, order, profileOfWork, pro }
}

beforeEach(() => {
  shown.boxes.length = 0
})

describe('a profile that lost its folder', () => {
  it('copies the state before its spaces go back to the default profile, and the dialog names the copy', async () => {
    const w = world()
    const keepCopy = vi.fn(() => (w.order.push(`copy while on ${w.profileOfWork()}`), '/data/Lucium/state.json.avant-restauration-2026-11-11T08-00-00'))
    const reverted = await recoverMissingProfiles(w.store, { storedProfileIds: () => [] }, win, keepCopy)
    expect(reverted).toHaveLength(1)
    expect(w.order).toEqual([`copy while on ${w.pro}`, 'profile/revert-missing'])
    expect(w.profileOfWork()).toBe('default')
    expect(shown.boxes).toHaveLength(1)
    expect(shown.boxes[0]!.detail).toContain('💼 Travail')
    expect(shown.boxes[0]!.detail).toContain('state.json.avant-restauration-2026-11-11T08-00-00')
    expect(shown.boxes[0]!.detail).toContain('Restaurer les données')
    // The name of the file only: the dialog does not spell the path of the data folder.
    expect(shown.boxes[0]!.detail).not.toContain('/data/Lucium')
  })

  it('still puts the spaces back on the default profile when the copy fails, says why in the journal, and promises no copy', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const w = world()
    const reverted = await recoverMissingProfiles(w.store, { storedProfileIds: () => [] }, win, () => {
      throw new Error('forced: the disk is full')
    })
    expect(reverted).toHaveLength(1)
    expect(w.profileOfWork()).toBe('default')
    expect(error.mock.calls.some(([line, cause]) => String(line).includes('could not be copied before its spaces go back') && String(cause).includes('the disk is full'))).toBe(true)
    expect(shown.boxes[0]!.detail).not.toContain('avant-restauration')
    expect(shown.boxes[0]!.detail).not.toContain('Restaurer les données')
    error.mockRestore()
  })

  it('copies nothing and shows nothing when every profile is there', async () => {
    const w = world()
    const keepCopy = vi.fn(() => 'unused')
    expect(await recoverMissingProfiles(w.store, { storedProfileIds: () => [w.pro] }, win, keepCopy)).toEqual([])
    expect(keepCopy).not.toHaveBeenCalled()
    expect(w.order).toEqual([])
    expect(shown.boxes).toEqual([])
  })
})
