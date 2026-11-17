import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { StateStore } from '../store'
import type { Browser } from './browser'

const { SHOT_DELAYS_MS, Thumbnails } = await import('./thumbnails')

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

/** Two spaces, a tab in each; `work` is the one a lock can hold shut. */
function twoSpaces(): SidebarState {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://home.example/' }, ctx)
  state = reduce(state, { type: 'space/create', name: 'Travail', emoji: 'w', hue: 10 }, ctx)
  return reduce(state, { type: 'tab/open', url: 'https://secret.example/' }, ctx)
}

let shots = 0

function setup() {
  shots = 0
  let state = twoSpaces()
  const listeners = new Set<() => void>()
  const store = { get: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) } as unknown as StateStore
  const locked = new Set<string>()
  const browser = {
    isTabLocked: (tab: { spaceId: string }) => locked.has(tab.spaceId),
    powerSaving: () => false,
    captureThumbnail: async () => {
      shots++
      return Buffer.from('jpeg')
    }
  } as unknown as Browser
  const thumbnails = new Thumbnails(browser, store)
  const select = (id: string) => {
    state = reduce(state, { type: 'tab/select', id }, ctx)
    for (const l of listeners) l()
  }
  return { thumbnails, state: () => state, select, locked }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A picture is taken 3 s after a tab is shown. */
async function shoot(t: ReturnType<typeof setup>, tabId: string): Promise<void> {
  t.select(tabId)
  await vi.advanceTimersByTimeAsync(3100)
}

describe('when the picture of a tab is taken', () => {
  it('once, about 3 s after the tab is shown, as a JPEG made by the engine', async () => {
    expect(SHOT_DELAYS_MS).toEqual([3000])
    const t = setup()
    const [home] = t.state().tabs
    t.select(home!.id)
    await vi.advanceTimersByTimeAsync(2900)
    expect(shots).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(shots).toBe(1)
    expect(t.thumbnails.get(home!.id)).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`)
  })

  it('not for a tab left while its picture was being taken: the capture is of the page now on screen', async () => {
    let state = twoSpaces()
    const listeners = new Set<() => void>()
    const store = { get: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) } as unknown as StateStore
    let finish: (jpeg: Buffer) => void = () => undefined
    const browser = { isTabLocked: () => false, powerSaving: () => false, captureThumbnail: () => new Promise<Buffer>((resolve) => (finish = resolve)) } as unknown as Browser
    const thumbnails = new Thumbnails(browser, store)
    const [home, work] = state.tabs
    const select = (id: string) => {
      state = reduce(state, { type: 'tab/select', id }, ctx)
      for (const l of listeners) l()
    }
    select(home!.id)
    await vi.advanceTimersByTimeAsync(3100)
    select(work!.id)
    finish(Buffer.from('jpeg'))
    await vi.advanceTimersByTimeAsync(0)
    expect(thumbnails.get(home!.id)).toBeNull()
    expect(thumbnails.get(work!.id)).toBeNull()
  })

  it('not for a tab left before its picture was due', async () => {
    const t = setup()
    const [home, work] = t.state().tabs
    t.select(home!.id)
    await vi.advanceTimersByTimeAsync(1000)
    t.select(work!.id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(shots).toBe(1)
    expect(t.thumbnails.get(home!.id)).toBeNull()
  })
})

describe('the pictures of the tabs and the lock', () => {
  it('gives the picture of a tab that was on screen', async () => {
    const t = setup()
    const [home, work] = t.state().tabs
    await shoot(t, home!.id)
    await shoot(t, work!.id)
    expect(t.thumbnails.get(home!.id)).toMatch(/^data:image\/jpeg;base64,/)
    expect(t.thumbnails.get(work!.id)).toMatch(/^data:image\/jpeg;base64,/)
    expect(t.thumbnails.get('ghost')).toBeNull()
  })

  it('gives none for a tab the lock hides, and gives it back when the lock is lifted (this fails if the lock is not asked)', async () => {
    const t = setup()
    const [home, work] = t.state().tabs
    await shoot(t, work!.id)
    await shoot(t, home!.id)
    t.locked.add(work!.spaceId)
    expect(t.thumbnails.get(work!.id)).toBeNull()
    expect(t.thumbnails.get(home!.id)).not.toBeNull()
    t.locked.delete(work!.spaceId)
    expect(t.thumbnails.get(work!.id)).not.toBeNull()
  })

  it('forgets the pictures of the tabs the lock hides, and only those (this fails if forgetLocked does nothing)', async () => {
    const t = setup()
    const [home, work] = t.state().tabs
    await shoot(t, work!.id)
    await shoot(t, home!.id)
    t.locked.add(work!.spaceId)
    t.thumbnails.forgetLocked()
    t.locked.delete(work!.spaceId)
    // Not read through the lock any more: it is the picture that is gone.
    expect(t.thumbnails.get(work!.id)).toBeNull()
    expect(t.thumbnails.get(home!.id)).not.toBeNull()
  })
})
