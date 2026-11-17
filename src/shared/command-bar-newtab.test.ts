// In the command bar opened by "Nouvel onglet", typing the site of a page that is already open (a tab, or the page of a favourite) went
// straight to that page instead of opening a new tab. Reproduced on a throw-away instance before the change: "exam" showed "example.com" in the field, the first row was
// "Example Domain — Aller à l'onglet" (the page of a favourite) and Enter selected it, the number of tabs unchanged.

import { describe, expect, it } from 'vitest'
import { candidateHint, completedRow, inlineCompletion, rankCandidates, tabLeadsSearch, type Candidate } from './command-bar'
import { defaultSettings, type SidebarState } from './model'
import { createInitialState, reduce, type Action } from './sidebar'

let n = 0
const ctx = { now: 1_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A space with a few open tabs, the page of a favourite among them (a tab no list shows). */
function opened(): SidebarState {
  let s = createInitialState(ctx)
  s = run(s, { type: 'tab/open', url: 'https://github.com/' }, { type: 'tab/open', url: 'https://news.ycombinator.com/' })
  s = run(s, { type: 'favorite/add', url: 'https://example.com/', title: 'Example Domain' })
  s = run(s, { type: 'favorite/open', id: s.favorites[0]!.id })
  // Another tab is on screen, as when the user presses ⌘T.
  s = run(s, { type: 'tab/open', url: 'https://other.example/' })
  return { ...s, tabs: s.tabs.map((t) => (t.url === 'https://github.com/' ? { ...t, title: 'GitHub' } : t.url === 'https://news.ycombinator.com/' ? { ...t, title: 'Hacker News' } : t.favoriteId !== undefined ? { ...t, title: 'Example Domain' } : t)) }
}
const withSetting = (s: SidebarState, patch: Partial<SidebarState['settings']>): SidebarState => ({ ...s, settings: { ...s.settings, ...patch } })

const kinds = (list: readonly Candidate[]) => list.map((c) => c.kind)
const first = (query: string, state: SidebarState, newTab: boolean | undefined) => rankCandidates(query, state, [], [], [], { newTab })[0]

describe('the bar opened for a new tab', () => {
  it('opens a new tab with the text typed when a tab answers it: the plain search leads, not the tab', () => {
    const s = opened()
    expect(first('hacker', s, true)).toMatchObject({ kind: 'open', search: true, label: 'hacker' })
    expect(first('git', s, true)).toMatchObject({ kind: 'open', search: true })
  })

  it('keeps the open tabs in the list, one arrow down (the page of a favourite included)', () => {
    const s = opened()
    const list = rankCandidates('exam', s, [], [], [], { newTab: true })
    expect(list.find((c) => c.kind === 'tab' && c.label === 'Example Domain')).toBeDefined()
    expect(list.findIndex((c) => c.kind === 'tab')).toBeGreaterThan(0)
    const hacker = rankCandidates('hacker', s, [], [], [], { newTab: true })
    expect(hacker.some((c) => c.kind === 'tab' && c.label === 'Hacker News')).toBe(true)
  })

  it('still leads with an address typed in full, as before', () => {
    const s = opened()
    expect(first('example.com', s, true)).toMatchObject({ kind: 'open', url: 'https://example.com' })
    expect(first('example.com', s, true)).not.toHaveProperty('search')
  })

  it('goes to the open tab again when the setting "Aller à l\'onglet déjà ouvert" is on', () => {
    const s = withSetting(opened(), { goToOpenTab: true })
    expect(first('hacker', s, true)).toMatchObject({ kind: 'tab', label: 'Hacker News' })
    expect(candidateHint(first('hacker', s, true)!)).toBe('Aller à l’onglet')
  })

  it('has that setting off by default: a new tab is a new tab', () => {
    expect(defaultSettings().goToOpenTab).toBe(false)
    expect(tabLeadsSearch(opened(), true)).toBe(false)
  })
})

describe('the bar that changes the address of the current tab', () => {
  it('offers the open tab first, as before, whatever the setting says', () => {
    const s = opened()
    expect(first('hacker', s, false)).toMatchObject({ kind: 'tab', label: 'Hacker News' })
    expect(first('hacker', s, undefined)).toMatchObject({ kind: 'tab', label: 'Hacker News' })
    expect(first('hacker', withSetting(s, { goToOpenTab: true }), false)).toMatchObject({ kind: 'tab' })
    expect(tabLeadsSearch(s, false)).toBe(true)
  })
})

describe('the address the field shows once the bar completed it', () => {
  it('is what Enter opens: a row for it leads, the search stays below it', () => {
    const s = opened()
    const ranked = rankCandidates('exam', s, [], [], [], { newTab: true })
    const completion = inlineCompletion('exam', ranked)
    expect(completion).toBe('example.com')
    const row = completedRow(ranked, completion)
    expect(row).toMatchObject({ kind: 'open', url: 'https://example.com', label: 'example.com' })
    expect(row).not.toHaveProperty('search')
    // The shown list is the row, then what the ranking gave: the search for the letters, then the tab.
    const shown = [row!, ...ranked]
    expect(kinds(shown).slice(0, 3)).toEqual(['open', 'open', 'tab'])
    expect(shown[1]).toMatchObject({ search: true })
    expect(candidateHint(shown[0]!)).toBe('')
  })

  it('keeps the letters the user typed, in their case', () => {
    const s = opened()
    const ranked = rankCandidates('Exam', s, [], [], [], { newTab: true })
    const row = completedRow(ranked, inlineCompletion('Exam', ranked))
    expect(row).toMatchObject({ url: 'https://Example.com' })
  })

  it('does not replace a first row the ranking chose on purpose: a tab, a page, an address, a command', () => {
    const s = withSetting(opened(), { goToOpenTab: true })
    const ranked = rankCandidates('exam', s, [], [], [], { newTab: true })
    expect(ranked[0]).toMatchObject({ kind: 'tab' })
    expect(completedRow(ranked, inlineCompletion('exam', ranked))).toBeNull()
    const address = rankCandidates('example.com', opened(), [], [], [], { newTab: true })
    expect(completedRow(address, 'example.com')).toBeNull()
  })

  it('needs a completion on screen, and an address to complete to', () => {
    const ranked = rankCandidates('exam', opened(), [], [], [], { newTab: true })
    expect(completedRow(ranked, null)).toBeNull()
    expect(completedRow(ranked, 'two words')).toBeNull()
    expect(completedRow([], 'example.com')).toBeNull()
  })

  it('is no row at all when nothing was completed: the letters are searched for', () => {
    const s = opened()
    const ranked = rankCandidates('hacker', s, [], [], [], { newTab: true })
    // "hacker" does not start the host of any tab ("news.ycombinator.com"): the field is not completed.
    expect(inlineCompletion('hacker', ranked)).toBeNull()
    expect(ranked[0]).toMatchObject({ kind: 'open', search: true })
  })
})
