// The tabs woken at the launch are looked for in the order of the sidebar, space by space, the pages of the favourites first. Those pages were
// found with a pass over all the tabs for each favourite of each space; they are now grouped in one pass. This file keeps the earlier
// computation as it was and checks, on random states (favourites of other profiles, pages whose favourite is gone, folders that are not to be
// woken, sites never put to sleep, tabs on screen, locked ones), that the same tabs wake, in the same order.

import { describe, expect, it } from 'vitest'
import type { Favorite, Folder, SidebarState, TabItem } from './model'
import { createInitialState, sidebarOrder } from './sidebar'
import { noWakeTabIds } from './folders'
import { excludedSitesOf, tabsToWakeAtLaunch, wakesAtLaunch, type LaunchScreen } from './sleep'

// ---------- the computation as it was (reference) ----------

function referenceLaunchOrder(state: Pick<SidebarState, 'tabs' | 'folders' | 'favorites' | 'spaces'>, first: readonly string[]): TabItem[] {
  const spaceIds = [...new Set([...first, ...state.spaces.map((space) => space.id)])]
  const ordered = spaceIds.flatMap((spaceId) => [...state.favorites.flatMap((favorite) => state.tabs.filter((tab) => tab.spaceId === spaceId && tab.favoriteId === favorite.id)), ...sidebarOrder(state, spaceId)])
  const seen = new Set<string>()
  return [...ordered, ...state.tabs].filter((tab) => {
    if (seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
}

function referenceTabsToWake(state: Pick<SidebarState, 'tabs' | 'folders' | 'favorites' | 'spaces' | 'settings'>, screen: LaunchScreen): TabItem[] {
  const hosts = state.settings.sleepExcludedHosts
  const never = noWakeTabIds(state)
  const candidates = referenceLaunchOrder(state, screen.spaces).filter((tab) => !screen.shown.has(tab.id) && screen.locked?.(tab) !== true && !never.has(tab.id))
  const why = new Map(candidates.map((tab) => [tab.id, wakesAtLaunch(tab, state.settings)]))
  const woken = new Set(candidates.filter((tab) => why.get(tab.id) === 'all-tabs' || why.get(tab.id) === 'keep-awake' || why.get(tab.id) === 'auto-reload').map((tab) => tab.id))
  const onScreen = state.tabs.filter((tab) => screen.shown.has(tab.id) && tab.private !== true)
  const covered = new Set([...onScreen, ...candidates.filter((tab) => woken.has(tab.id))].flatMap((tab) => excludedSitesOf(tab.url, hosts)))
  for (const tab of candidates) {
    if (why.get(tab.id) !== 'excluded-site') continue
    const sites = excludedSitesOf(tab.url, hosts)
    if (sites.every((site) => covered.has(site))) continue
    woken.add(tab.id)
    for (const site of sites) covered.add(site)
  }
  return candidates.filter((tab) => woken.has(tab.id))
}

// ---------- random states ----------

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

const HOSTS = ['chat.example', 'mail.example', 'news.example', 'sub.chat.example', 'other.example']

function randomCase(rand: () => number): { state: SidebarState; screen: LaunchScreen } {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const base = createInitialState({ now: 1, newId: () => 'space-0' })
  const spaceIds = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => `space-${i}`)
  const folders: Folder[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => ({
    id: `folder-${i}`,
    spaceId: pick(spaceIds),
    name: `F${i}`,
    collapsed: rand() < 0.5,
    ...(rand() < 0.25 ? { noWake: true as const } : {}),
    ...(rand() < 0.2 ? { atBottom: true as const } : {})
  }))
  // A favourite id may name nothing (its favourite is gone), and the same favourite may come twice.
  const favorites: Favorite[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => ({ id: `fav-${i % 4}`, url: `https://${pick(HOSTS)}/`, title: `F${i}`, profileId: 'default' }))
  const tabs: TabItem[] = Array.from({ length: Math.floor(rand() * 50) }, (_, i) => {
    const pinned = rand() < 0.3
    const folder = pinned && folders.length > 0 && rand() < 0.6 ? pick(folders) : undefined
    return {
      id: `tab-${i}`,
      spaceId: folder?.spaceId ?? (rand() < 0.03 ? 'no-such-space' : pick(spaceIds)),
      url: `https://${pick(HOSTS)}/${i}`,
      title: `t${i}`,
      pinned,
      ...(folder ? { folderId: folder.id } : {}),
      ...(rand() < 0.3 ? { favoriteId: `fav-${Math.floor(rand() * 6)}` } : {}),
      ...(rand() < 0.15 ? { keepAwake: true } : {}),
      ...(rand() < 0.1 ? { autoReload: { seconds: 60 } } : {}),
      ...(rand() < 0.05 ? { private: true } : {}),
      createdAt: 1,
      lastActiveAt: 1
    }
  })
  const state: SidebarState = {
    ...base,
    spaces: spaceIds.map((id) => ({ ...base.spaces[0]!, id })),
    tabs,
    folders,
    favorites,
    settings: { ...base.settings, loadAllTabsAtLaunch: rand() < 0.15, sleepExcludedHosts: HOSTS.filter(() => rand() < 0.4) },
    activeSpaceId: spaceIds[0]!
  }
  const ids = tabs.map((t) => t.id)
  const lockedSpace = rand() < 0.3 ? pick(spaceIds) : null
  const screen: LaunchScreen = {
    shown: new Set(ids.filter(() => rand() < 0.1)),
    spaces: spaceIds.filter(() => rand() < 0.4).reverse(),
    ...(lockedSpace !== null ? { locked: (tab: TabItem) => tab.spaceId === lockedSpace } : {})
  }
  return { state, screen }
}

describe('the order the launch wakes tabs in, with the pages of the favourites grouped in one pass', () => {
  it('wakes the tabs the per-favourite passes woke, in the same order, on random states', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const { state, screen } = randomCase(mulberry32(seed))
      expect(tabsToWakeAtLaunch(state, screen).map((tab) => tab.id), `seed ${seed}`).toEqual(referenceTabsToWake(state, screen).map((tab) => tab.id))
    }
  })

  it('puts the pages of the favourites of a space in the order of the favourites, before its rows', () => {
    const base = createInitialState({ now: 1, newId: () => 'space-0' })
    const tab = (id: string, favoriteId?: string): TabItem => ({ id, spaceId: 'space-0', url: `https://chat.example/${id}`, title: id, pinned: false, ...(favoriteId ? { favoriteId } : {}), createdAt: 1, lastActiveAt: 1 })
    const state: SidebarState = {
      ...base,
      spaces: [{ ...base.spaces[0]!, id: 'space-0' }],
      activeSpaceId: 'space-0',
      favorites: [
        { id: 'b', url: 'https://chat.example/b', title: 'B', profileId: 'default' },
        { id: 'a', url: 'https://chat.example/a', title: 'A', profileId: 'default' }
      ],
      tabs: [tab('row-1'), tab('page-a', 'a'), tab('row-2'), tab('page-b', 'b')],
      settings: { ...base.settings, loadAllTabsAtLaunch: true }
    }
    expect(tabsToWakeAtLaunch(state, { shown: new Set(), spaces: [] }).map((t) => t.id)).toEqual(['page-b', 'page-a', 'row-1', 'row-2'])
  })
})
