import { describe, expect, it } from 'vitest'
import { createInitialState, reduce } from './sidebar'
import { offerableTabCount, RESTORE_ROWS_MAX, restoreRows, shouldOfferRestore } from './session-restore'

const ctx = (() => {
  let n = 0
  return { now: 1, newId: () => `id${++n}` }
})()

/** A state with the tabs asked for: pinned ones and private ones are marked after they are opened. */
function stateWith(urls: string[], options: { pinned?: number[]; private?: number[]; spaces?: boolean } = {}) {
  let state = createInitialState(ctx)
  if (options.spaces) state = reduce(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, ctx)
  const spaceId = state.spaces.at(-1)!.id
  for (const url of urls) state = reduce(state, { type: 'tab/open', url, background: true, spaceId }, ctx)
  return { ...state, tabs: state.tabs.map((tab, i) => ({ ...tab, title: `Page ${i}`, ...(options.pinned?.includes(i) ? { pinned: true } : {}), ...(options.private?.includes(i) ? { private: true } : {}) })) }
}

describe('the rows of the restore sheet', () => {
  it('lists the tabs of the day with their name and address, and leaves out the pinned and the private ones', () => {
    const state = stateWith(['https://a.example/x', 'https://b.example/', 'https://c.example/', 'https://d.example/'], { pinned: [0], private: [2] })
    const { rows, hidden } = restoreRows(state)
    expect(rows.map((row) => [row.name, row.address])).toEqual([['Page 1', 'b.example'], ['Page 3', 'd.example']])
    expect(hidden).toBe(0)
    expect(offerableTabCount(state)).toBe(2)
  })

  it('names the space of each tab only when there are several', () => {
    expect(restoreRows(stateWith(['https://a.example/'])).rows[0]!.space).toBeUndefined()
    expect(restoreRows(stateWith(['https://a.example/'], { spaces: true })).rows[0]!.space).toContain('Perso')
  })

  it('is bounded: a long list shows the first rows and counts the others, which stay open', () => {
    const urls = Array.from({ length: RESTORE_ROWS_MAX + 7 }, (_, i) => `https://site${i}.example/`)
    const { rows, hidden } = restoreRows(stateWith(urls))
    expect(rows).toHaveLength(RESTORE_ROWS_MAX)
    expect(hidden).toBe(7)
  })
})

describe('when the sheet opens by itself', () => {
  const facts = { abnormal: true, newProfile: false, appLocked: false, offerable: 3 }

  it('opens after an abnormal exit, over a used profile, with something to choose among', () => {
    expect(shouldOfferRestore(facts)).toBe(true)
  })

  it('does not open after a clean exit', () => {
    expect(shouldOfferRestore({ ...facts, abnormal: false })).toBe(false)
  })

  it('does not open over a new profile, nor over the lock screen', () => {
    expect(shouldOfferRestore({ ...facts, newProfile: true })).toBe(false)
    expect(shouldOfferRestore({ ...facts, appLocked: true })).toBe(false)
  })

  it('does not open with fewer than two tabs to choose among', () => {
    expect(shouldOfferRestore({ ...facts, offerable: 1 })).toBe(false)
    expect(shouldOfferRestore({ ...facts, offerable: 0 })).toBe(false)
    expect(shouldOfferRestore({ ...facts, offerable: 2 })).toBe(true)
  })
})
