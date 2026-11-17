// At each snapshot, the window flags the tabs that Back would close (`withBackCloses`, browser-commands.ts). It asked `backClosesTab` for every tab,
// which searches the tab and then its origin among all the tabs: milliseconds with a few thousand tabs, as soon as one tab had an origin (the setting is
// on by default). `backClosesLookup` answers the same question from a map made once. This file checks, on random states, that both answer alike for
// every tab and for ids that name nothing. The time is measured by `pnpm test:state-bench`, not here.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { backClosesLookup, backClosesTab, createInitialState } from './sidebar'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomState(rand: () => number): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'space-0' })
  const count = Math.floor(rand() * 40)
  // Ids repeated now and then (a damaged file): the first tab of an id is the one a search finds.
  const ids = Array.from({ length: count }, (_, i) => (rand() < 0.1 && i > 0 ? `tab-${Math.floor(rand() * i)}` : `tab-${i}`))
  const tabs: TabItem[] = ids.map((id) => {
    const roll = rand()
    // An origin of every kind: none, a tab that exists, itself, a tab that is gone.
    const openerId = roll < 0.5 ? undefined : roll < 0.8 && ids.length > 0 ? ids[Math.floor(rand() * ids.length)]! : roll < 0.9 ? id : `gone-${Math.floor(rand() * 3)}`
    return { id, spaceId: 'space-0', url: `https://${id}.example/`, title: id, pinned: rand() < 0.2, ...(openerId !== undefined ? { openerId } : {}), createdAt: 1, lastActiveAt: 1 }
  })
  return { ...base, tabs, settings: { ...base.settings, backClosesOpenedTab: rand() < 0.8 } }
}

describe('the tabs Back would close, looked up from a map', () => {
  it('answers as backClosesTab for every tab and every page history, on random states', () => {
    const histories = [undefined, false, true] as const
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = mulberry32(seed)
      const state = randomState(rand)
      const closes = backClosesLookup(state)
      for (const id of [...state.tabs.map((t) => t.id), 'gone-0', 'gone-1', '__proto__']) {
        for (const canGoBack of histories) expect(closes(id, canGoBack), `seed ${seed}, ${id}, ${String(canGoBack)}`).toBe(backClosesTab(state, id, canGoBack))
      }
    }
  })

  it('flags the one tab with an origin among 5,000, as backClosesTab does', () => {
    const base = createInitialState({ now: 1, newId: () => 'space-0' })
    const tabs: TabItem[] = Array.from({ length: 5000 }, (_, i) => ({ id: `tab-${i}`, spaceId: 'space-0', url: `https://t${i}.example/`, title: `t${i}`, pinned: false, ...(i === 4999 ? { openerId: 'tab-3' } : {}), createdAt: 1, lastActiveAt: 1 }))
    const state: SidebarState = { ...base, tabs, settings: { ...base.settings, backClosesOpenedTab: true } }
    const closes = backClosesLookup(state)
    expect(state.tabs.filter((t) => closes(t.id, undefined)).map((t) => t.id)).toEqual(['tab-4999'])
    expect(state.tabs.filter((t) => backClosesTab(state, t.id, undefined)).map((t) => t.id)).toEqual(['tab-4999'])
  })
})
