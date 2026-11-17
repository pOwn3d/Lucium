// « Rouvrir le dernier onglet fermé » (archive/restore-last) and a restore from the archive open the tab again, then look for the tab that came
// back: the one the state before did not have. That search went through all the tabs before for each tab after (7 ms with 2,000 tabs, 44 ms with
// 5,000, at each ⇧⌘T); it now uses a set of them (`tabOpenedSince`). This file keeps the case of the reducer as it was and checks, on random
// states (addresses a tab refuses, pages of extensions, entries of a space or a folder that is gone, pinned entries, containers, the tree on or
// off), that both restores give the same state.

import { describe, expect, it } from 'vitest'
import type { ArchivedTab, Folder, SidebarState, TabItem } from './model'
import { createInitialState, pruneFavoriteTabs, pruneOrigins, reduce, type Action, type Ctx } from './sidebar'
import { pruneSplits } from './sidebar-state'
import { pruneFavoriteProfiles } from './favorite-scope'
import { settleTree } from './tab-tree'
import { moveTabs, replaceTab } from './sidebar-helpers'
import { CONTAINER_COLORS, containerById } from './containers'
import { isExtensionPageUrl } from './url'

// ---------- the case as it was (reference) ----------

/** `archive/restore` as the reducer's family did it, with the search of the tabs before for each tab after. */
function referenceRestoreCore(state: SidebarState, id: string, ctx: Ctx): SidebarState {
  const entry = state.archive.find((a) => a.id === id)
  if (!entry) return state
  const left = { ...state, archive: state.archive.filter((a) => a.id !== entry.id) }
  if (isExtensionPageUrl(entry.url)) return left
  const spaceId = state.spaces.some((s) => s.id === entry.spaceId) ? entry.spaceId : state.activeSpaceId
  const opened = reduce(left, { type: 'tab/open', url: entry.url, spaceId, ...(entry.container !== undefined && containerById(state.settings, entry.container) ? { container: entry.container } : {}) }, ctx)
  const restored = opened.tabs.find((t) => !state.tabs.some((other) => other.id === t.id))
  if (!restored) return state
  const titled = replaceTab(opened, restored.id, (t) => ({ ...t, title: entry.title }))
  return entry.pinned === true
    ? replaceTab(moveTabs(titled, [restored.id], Number.MAX_SAFE_INTEGER, true, entry.folderId), restored.id, (t) => ({ ...t, anchorUrl: entry.anchorUrl ?? t.anchorUrl }))
    : titled
}

/** What `reduce` does after the family of an action (sidebar.ts), the comparison that keeps the same object aside. */
const settled = (prev: SidebarState, next: SidebarState): SidebarState => (next === prev ? prev : pruneFavoriteTabs(pruneFavoriteProfiles(pruneSplits(pruneOrigins(settleTree(prev, next))))))

function referenceReduce(state: SidebarState, action: Extract<Action, { type: 'archive/restore' | 'archive/restore-last' }>, ctx: Ctx): SidebarState {
  if (action.type === 'archive/restore') return settled(state, referenceRestoreCore(state, action.id, ctx))
  const count = Math.min(Math.max(1, Math.floor(Number(action.count)) || 1), state.archive.length)
  const entries = state.archive.slice(0, count)
  if (entries.length === 0) return state
  return settled(state, entries.reverse().reduce((s, entry) => referenceRestoreCore(s, entry.id, ctx), state))
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

const URLS = ['https://a.example/', 'https://b.example/page', 'http://c.example/', 'file:///tmp/a.html', 'javascript:alert(1)', 'chrome-extension://' + 'a'.repeat(32) + '/page.html', 'not a url', '']

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_800_000_000_000, newId: () => `made-${++n}` }
}

function randomState(rand: () => number): SidebarState {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const base = createInitialState({ now: 1, newId: () => 'space-0' })
  const spaceIds = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `space-${i}`)
  const folders: Folder[] = Array.from({ length: Math.floor(rand() * 3) }, (_, i) => ({ id: `folder-${i}`, spaceId: pick(spaceIds), name: `F${i}`, collapsed: false }))
  const tabs: TabItem[] = Array.from({ length: Math.floor(rand() * 30) }, (_, i) => {
    const pinned = rand() < 0.3
    return {
      id: `tab-${i}`,
      spaceId: pick(spaceIds),
      url: pick(URLS.slice(0, 4)),
      title: `t${i}`,
      pinned,
      ...(pinned && folders.length > 0 && rand() < 0.5 ? { folderId: pick(folders).id } : {}),
      ...(!pinned && i > 0 && rand() < 0.3 ? { parentId: `tab-${Math.floor(rand() * i)}` } : {}),
      createdAt: 1,
      lastActiveAt: 1
    }
  })
  const archive: ArchivedTab[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => ({
    id: `archived-${i}`,
    spaceId: rand() < 0.8 ? pick(spaceIds) : 'space-gone',
    url: pick(URLS),
    title: `Archived ${i}`,
    archivedAt: 1000 - i,
    ...(rand() < 0.3 ? { pinned: true as const, ...(rand() < 0.5 ? { anchorUrl: 'https://anchor.example/' } : {}), ...(rand() < 0.6 ? { folderId: folders.length > 0 && rand() < 0.7 ? pick(folders).id : 'folder-gone' } : {}) } : {}),
    ...(rand() < 0.2 ? { container: rand() < 0.5 ? 'work' : 'gone' } : {})
  }))
  return {
    ...base,
    spaces: spaceIds.map((id) => ({ ...base.spaces[0]!, id })),
    folders,
    tabs,
    archive,
    settings: { ...base.settings, tabTree: rand() < 0.5, tabContainers: rand() < 0.5, containers: [{ id: 'work', name: 'Work', color: CONTAINER_COLORS[0].id }] },
    activeSpaceId: spaceIds[0]!,
    activeTabBySpace: Object.fromEntries(spaceIds.map((id) => [id, null]))
  }
}

describe('a restore from the archive, the tab that came back found with a set of the tabs before', () => {
  it('gives the state the search of every tab gave, for one entry and for the last ones, on random states', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rand = mulberry32(seed)
      const state = randomState(rand)
      const ids = [...state.archive.map((a) => a.id), 'archived-gone']
      const action: Extract<Action, { type: 'archive/restore' | 'archive/restore-last' }> = rand() < 0.6 ? { type: 'archive/restore', id: ids[Math.floor(rand() * ids.length)]! } : { type: 'archive/restore-last', count: Math.floor(rand() * 5) }
      expect(reduce(state, action, makeCtx()), `seed ${seed}, ${JSON.stringify(action)}`).toEqual(referenceReduce(state, action, makeCtx()))
    }
  })
})
