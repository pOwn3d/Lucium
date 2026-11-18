// The iOS application (ios/) re-implements the rules of the lists of a space in Swift: pinning, folders, Today, the archive, the automatic archive, the
// favourites, and how a typed text is compared with a name. The two sides are held by shared vectors (ios/Contracts/library-vectors.json and
// match-vectors.json): this suite plays them against the Mac's reducer, LuciumKit's tests play the same files against the Swift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { defaultSettings } from './model'
import { matchScore } from './command-bar-match'
import { reduce, type Action, type Ctx } from './sidebar'

interface VectorTab {
  id: string
  spaceId: string
  pinned?: boolean
  url?: string
  title?: string
  lastActiveAt?: number
  folderId?: string
  favoriteId?: string
}

interface VectorState {
  spaces: { id: string; profileId: string }[]
  activeSpaceId: string
  activeTabBySpace: Record<string, string | null>
  tabs: VectorTab[]
  folders?: { id: string; spaceId: string; parentId?: string }[]
  favorites?: { id: string; url: string; title: string; profileId?: string }[]
  archive?: { id: string; spaceId: string; url: string; title: string; archivedAt: number; pinned?: boolean; anchorUrl?: string; folderId?: string }[]
  settings?: { autoArchiveHours?: number; profiles?: Record<string, { autoArchiveHours?: number }> }
}

interface Expectation {
  /** The ids of the pinned tabs (the ones a list shows) of each space, in order. */
  pinned?: Record<string, string[]>
  /** The ids of the Today tabs of each space, in order. */
  today?: Record<string, string[]>
  /** The ids of the archive, newest first. */
  archive?: string[]
  /** The folders in order, each with the folder it sits in (null at the root). */
  folders?: { id: string; parentId: string | null }[]
  folderOf?: Record<string, string | null>
  anchorOf?: Record<string, string | null>
  favoriteOf?: Record<string, string | null>
  /** The favourites as `url@profile`, in order. */
  favorites?: string[]
  shown?: Record<string, string | null>
  /** The title a tab has. */
  titleOf?: Record<string, string>
}

interface Scenario {
  name: string
  now: number
  state: VectorState
  action: Record<string, unknown> & { type: string }
  expect: Expectation
}

const scenarios = (JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/library-vectors.json'), 'utf8')) as { scenarios: Scenario[] }).scenarios

/** A state of the Mac made of what a vector says, over the defaults of everything else. */
export function stateOf(vector: VectorState, now: number): SidebarState {
  const tab = (t: VectorTab): TabItem => ({
    id: t.id,
    spaceId: t.spaceId,
    url: t.url ?? `https://${t.id}.example/`,
    title: t.title ?? t.id,
    pinned: t.pinned === true,
    createdAt: now - 1000,
    lastActiveAt: t.lastActiveAt ?? now - 1000,
    ...(t.folderId ? { folderId: t.folderId } : {}),
    ...(t.pinned ? { anchorUrl: t.url ?? `https://${t.id}.example/` } : {}),
    ...(t.favoriteId ? { favoriteId: t.favoriteId } : {})
  })
  return {
    version: 1,
    revision: 2,
    spaces: vector.spaces.map((s) => ({ id: s.id, name: s.id, emoji: '🏠', profileId: s.profileId })),
    tabs: vector.tabs.map(tab),
    folders: (vector.folders ?? []).map((f) => ({ id: f.id, spaceId: f.spaceId, name: f.id, collapsed: false, ...(f.parentId ? { parentId: f.parentId } : {}) })),
    favorites: (vector.favorites ?? []).map((f) => ({ ...f })),
    archive: (vector.archive ?? []).map((a) => ({ ...a, ...(a.pinned ? { pinned: true as const } : {}) })),
    readLater: [],
    readLaterFolders: [],
    bookmarks: [],
    activeSpaceId: vector.activeSpaceId,
    activeTabBySpace: vector.activeTabBySpace,
    sitePermissions: {},
    commandBarUsage: {},
    sidePanelBehavior: {},
    splits: [],
    boosts: [],
    sessions: [],
    workViews: [],
    settings: { ...defaultSettings(), ...(vector.settings?.autoArchiveHours !== undefined ? { autoArchiveHours: vector.settings.autoArchiveHours } : {}), profiles: vector.settings?.profiles ?? {} }
  } as unknown as SidebarState
}

/** What the Mac makes of a scenario, in the terms of `Expectation`. */
export function observe(scenario: Scenario): Required<Expectation> {
  let n = 0
  const ctx: Ctx = { now: scenario.now, newId: () => `new-${++n}` }
  const after = reduce(stateOf(scenario.state, scenario.now), scenario.action as unknown as Action, ctx)
  const spaces = scenario.state.spaces.map((s) => s.id)
  const group = (pinned: boolean) =>
    Object.fromEntries(spaces.map((id) => [id, after.tabs.filter((t) => t.spaceId === id && t.favoriteId === undefined && t.pinned === pinned).map((t) => t.id)]))
  return {
    pinned: group(true),
    today: group(false),
    archive: after.archive.map((a) => a.id),
    folders: after.folders.map((f) => ({ id: f.id, parentId: f.parentId ?? null })),
    folderOf: Object.fromEntries(after.tabs.map((t) => [t.id, t.folderId ?? null])),
    anchorOf: Object.fromEntries(after.tabs.map((t) => [t.id, t.anchorUrl ?? null])),
    favoriteOf: Object.fromEntries(after.tabs.map((t) => [t.id, t.favoriteId ?? null])),
    favorites: after.favorites.map((f) => `${f.url}@${f.profileId ?? 'default'}`),
    shown: after.activeTabBySpace as Record<string, string | null>,
    titleOf: Object.fromEntries(after.tabs.map((t) => [t.id, t.title]))
  }
}

describe('iOS contract: library vectors against the Mac reducer', () => {
  it('has scenarios to run (an empty file would pass for nothing)', () => {
    expect(scenarios.length).toBeGreaterThan(15)
    expect(new Set(scenarios.map((s) => s.action.type)).size).toBeGreaterThanOrEqual(8)
  })

  it('names each scenario once, and every scenario asserts something', () => {
    expect(new Set(scenarios.map((s) => s.name)).size).toBe(scenarios.length)
    for (const s of scenarios) expect(Object.keys(s.expect).length, s.name).toBeGreaterThan(0)
  })

  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    const seen = observe(scenario)
    for (const [key, expected] of Object.entries(scenario.expect) as [keyof Expectation, unknown][]) {
      const actual = seen[key] as Record<string, unknown> | unknown[]
      // A map is compared on the keys the vector names (the other tabs are not its business); a list is compared whole.
      if (Array.isArray(expected)) expect(actual, `${scenario.name}: ${key}`).toEqual(expected)
      else for (const [id, value] of Object.entries(expected as Record<string, unknown>)) expect((actual as Record<string, unknown>)[id], `${scenario.name}: ${key}.${id}`).toEqual(value)
    }
  })
})

interface MatchVectors {
  score: { text: string; query: string; expect: number }[]
}

const matchVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/match-vectors.json'), 'utf8')) as MatchVectors

describe('iOS contract: match vectors against the Mac', () => {
  it('has vectors to run', () => {
    expect(matchVectors.score.length).toBeGreaterThan(15)
  })

  it.each(matchVectors.score)('matchScore("$text", "$query")', ({ text, query, expect: expected }) => {
    expect(matchScore(text, query)).toBe(expected)
  })
})
