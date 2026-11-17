// The command bar ranks every tab at each keystroke, and lists them all before anything is typed. Two costs grew with the square of the number
// of tabs or with the number of lines: the split view of each tab was found by looking for the tab on screen again for each line, and the query
// was folded again for each line and each field. This file keeps the earlier computations as they were and checks, on random states, that the
// lines of the bar are the ones they gave, in the same order.

import { describe, expect, it } from 'vitest'
import { tabName, type ArchivedTab, type HistoryEntry, type SidebarState, type SplitView, type TabItem } from './model'
import { createInitialState } from './sidebar'
import { activeTab, splitFor } from './sidebar'
import { MAX_ARCHIVED, MAX_HISTORY, MAX_TABS, onePerSplit } from './command-bar-sources'
import { matchScore } from './command-bar-match'
import { usageOnScreen } from './command-bar-usage'
import { rankCandidates, usageKey } from './command-bar'

// ---------- the computations as they were (reference) ----------

function referenceOtherSplit(state: SidebarState, tabId: string): SplitView | undefined {
  const split = splitFor(state, tabId)
  const shown = activeTab(state)
  return split && !(shown && split.tabIds.includes(shown.id)) ? split : undefined
}

function referenceOnePerSplit<T>(items: T[], tabOf: (item: T) => TabItem, state: SidebarState): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const split = referenceOtherSplit(state, tabOf(item).id)
    if (!split) return true
    if (seen.has(split.id)) return false
    seen.add(split.id)
    return true
  })
}

// What a pick adds to a line, and the most picks counted (command-bar.ts), as they were when this reference was written.
const USAGE_BONUS_PER_PICK = 8
const USAGE_BONUS_CAP = 5
const referenceBonus = (state: SidebarState, url: string) => Math.min(USAGE_BONUS_CAP, usageOnScreen(state)[usageKey(url)] ?? 0) * USAGE_BONUS_PER_PICK

/** The ids of the tab, archive and history lines of the bar, in their order, as the ranking computed them with `matchScore` and a bonus read per line. */
function referenceLines(query: string, state: SidebarState, history: HistoryEntry[]): { tabs: string[]; archived: string[]; history: string[] } {
  const q = query.trim()
  const { suggestHistory, suggestTabs, suggestArchive } = state.settings
  const activeId = state.activeTabBySpace[state.activeSpaceId]
  const tabs = suggestTabs ? [...state.tabs].filter((t) => t.id !== activeId) : []
  if (!q) {
    const recent = referenceOnePerSplit(tabs.sort((a, b) => referenceBonus(state, b.url) - referenceBonus(state, a.url) || b.lastActiveAt - a.lastActiveAt), (t) => t, state).slice(0, MAX_TABS + 2)
    return { tabs: recent.map((t) => t.id), archived: [], history: [] }
  }
  const matched = referenceOnePerSplit(
    tabs
      .map((t) => ({ t, score: Math.max(Math.max(matchScore(tabName(t), q), matchScore(t.title, q)), matchScore(t.url, q)) }))
      .filter((m) => m.score > 0)
      .map((m) => ({ ...m, score: m.score + referenceBonus(state, m.t.url) }))
      .sort((a, b) => b.score - a.score || b.t.lastActiveAt - a.t.lastActiveAt),
    (m) => m.t,
    state
  ).slice(0, MAX_TABS)
  const archived = (suggestArchive ? state.archive : [])
    .map((a) => ({ a, score: Math.max(matchScore(a.title, q), matchScore(a.url, q)) }))
    .filter((m) => m.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_ARCHIVED)
  const openUrls = new Set(suggestTabs ? state.tabs.map((t) => t.url) : [])
  const visited = (suggestHistory ? history : [])
    .filter((h) => !openUrls.has(h.url))
    .map((h) => ({ h, score: Math.max(matchScore(h.title, q), matchScore(h.url, q)) }))
    .filter((m) => m.score > 0)
    .map((m) => ({ ...m, score: m.score + referenceBonus(state, m.h.url) }))
    .sort((x, y) => y.score - x.score || y.h.visitCount - x.h.visitCount || y.h.lastVisitAt - x.h.lastVisitAt)
    .slice(0, MAX_HISTORY)
  return { tabs: matched.map((m) => m.t.id), archived: archived.map((m) => m.a.id), history: visited.map((m) => m.h.url) }
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

const QUERIES = ['', '  ', 'e', 'é', 'E', 'ete', 'Été', "l'ete", 'l’été', 'git', 'GitHub', 'hub', 'docs ', 'café crème', 'café\u00a0crème', 'xyz', 'nouvel', 'dpl', 'news 3', 'a b']
const WORDS = ['Été', 'été', 'L’Été', 'l’ete', 'GitHub', 'github', 'Café crème', 'docs', 'Déplacer', 'news', 'Nouvel onglet', 'a', 'e', 'é']

function randomState(rand: () => number): SidebarState {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const base = createInitialState({ now: 1, newId: () => 'space-0' })
  const spaceIds = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => `space-${i}`)
  const tabs: TabItem[] = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => ({
    id: `tab-${i}`,
    spaceId: pick(spaceIds),
    url: `https://${pick(['github.com', 'ete.example', 'news.example', 'docs.example'])}/${pick(WORDS)}/${i}`,
    title: `${pick(WORDS)} ${pick(WORDS)} ${i}`,
    ...(rand() < 0.2 ? { customTitle: `${pick(WORDS)}` } : {}),
    pinned: rand() < 0.2,
    createdAt: 1,
    lastActiveAt: Math.floor(rand() * 5)
  }))
  const ids = tabs.map((t) => t.id)
  // Split views of two to four tabs, a tab sometimes in two of them (a damaged file), sometimes holding the tab on screen.
  const splits: SplitView[] = ids.length < 2 ? [] : Array.from({ length: Math.floor(rand() * 5) }, (_, i) => {
    const tabIds = [...new Set(Array.from({ length: 2 + Math.floor(rand() * 3) }, () => pick(ids)))]
    return { id: `split-${i}`, spaceId: pick(spaceIds), tabIds, orientation: 'horizontal' as const, ratios: tabIds.map(() => 1 / tabIds.length) }
  })
  // Pages picked in the bar before, in the ranking of each profile: the bonus of a line comes from the profile of the space on screen.
  const urls = [...tabs.map((t) => t.url), ...Array.from({ length: 5 }, (_, i) => `https://visited.example/${pick(WORDS)}/${i}`)]
  const commandBarUsage = Object.fromEntries(['default', 'work'].map((profile) => [profile, Object.fromEntries(urls.filter(() => rand() < 0.3).map((url) => [usageKey(url), 1 + Math.floor(rand() * 8)]))]))
  const archive: ArchivedTab[] = Array.from({ length: Math.floor(rand() * 12) }, (_, i) => ({ id: `archived-${i}`, spaceId: pick(spaceIds), url: `https://old.example/${pick(WORDS)}`, title: `${pick(WORDS)} ${i}`, archivedAt: i }))
  return {
    ...base,
    spaces: spaceIds.map((id, i) => ({ ...base.spaces[0]!, id, profileId: i % 2 === 0 ? 'default' : 'work' })),
    tabs,
    archive,
    commandBarUsage,
    settings: { ...base.settings, suggestTabs: rand() < 0.85, suggestArchive: rand() < 0.85, suggestHistory: rand() < 0.85 },
    splits,
    activeSpaceId: pick(spaceIds),
    activeTabBySpace: Object.fromEntries(spaceIds.map((id) => [id, ids.length > 0 && rand() < 0.8 ? pick(ids) : null]))
  }
}

describe('the split view of each line, found once for the whole list', () => {
  it('keeps the lines the per-line search kept, on random states', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = mulberry32(seed)
      const state = randomState(rand)
      // The lines in any order, a tab sometimes twice (the bar ranks tabs and other things that name a tab).
      const items = state.tabs.filter(() => rand() < 0.8).sort(() => rand() - 0.5)
      if (items.length > 0 && rand() < 0.3) items.push(items[0]!)
      expect(onePerSplit(items, (t) => t, state).map((t) => t.id), `seed ${seed}`).toEqual(referenceOnePerSplit(items, (t) => t, state).map((t) => t.id))
    }
  })
})

describe('the query folded once and the ranking of picks read once, for the long lists', () => {
  it('gives the tab, archive and history lines that matchScore and a bonus read per line gave, on random states and queries', () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const rand = mulberry32(seed)
      const state = randomState(rand)
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
      const history: HistoryEntry[] = Array.from({ length: Math.floor(rand() * 12) }, (_, i) => ({
        url: rand() < 0.2 && state.tabs.length > 0 ? pick(state.tabs).url : `https://visited.example/${pick(WORDS)}/${i % 5}`,
        title: `${pick(WORDS)} ${i}`,
        visitCount: Math.floor(rand() * 4),
        lastVisitAt: Math.floor(rand() * 4)
      }))
      const query = rand() < 0.2 ? pick(WORDS) : pick(QUERIES)
      const lines = rankCandidates(query, state, history)
      const ids = (kind: string) => lines.flatMap((c) => (c.kind !== kind ? [] : c.kind === 'tab' ? [c.tabId] : c.kind === 'archived' ? [c.archivedId] : c.kind === 'history' ? [c.url] : []))
      expect({ tabs: ids('tab'), archived: ids('archived'), history: ids('history') }, `seed ${seed}, query ${JSON.stringify(query)}`).toEqual(referenceLines(query, state, history))
    }
  })
})
