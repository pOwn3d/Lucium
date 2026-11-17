// N4 · Recherche d'onglets (⌘⇧A): the list over every space, the filters and their counts, the duplicates (which close, which stay, how to take them back)
// and the keys. The state is built with the reducer, as the bar receives it.

import { describe, expect, it } from 'vitest'
import type { RuntimeState, SidebarState, TabRuntime } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import {
  ARCHIVE_ROWS,
  ARCHIVE_ROWS_ON_QUERY,
  NO_FILTERS,
  canArchiveRow,
  choiceActions,
  closeDuplicatesAction,
  hasFilters,
  isArchiveKey,
  normalizedAddress,
  planDuplicates,
  reopenActions,
  searchTabs,
  toggleSpaceFilter,
  toggleStateFilter
} from './tab-search'

let clock = 1_000
const ctx: Ctx = { now: 0, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, { ...ctx, now: (clock += 10) }), state)

/** Two spaces (Travail, Perso) of the default profile, and a third, Client, of another profile. The tabs are opened in the order given: [space, url, title]. */
function world(tabs: Array<[string, string, string]>) {
  let s = createInitialState({ ...ctx, now: clock })
  const home = s.spaces[0]!.id
  s = run(s, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 140 }, { type: 'space/create', name: 'Client', emoji: '💼', hue: 20, profileId: 'client' })
  const ids: Record<string, string> = { travail: home, perso: s.spaces[1]!.id, client: s.spaces[2]!.id }
  s = run(s, { type: 'space/update', id: home, patch: { name: 'Travail', emoji: '🛠️' } })
  for (const [space, url, title] of tabs) {
    s = run(s, { type: 'tab/open', url, background: true, spaceId: ids[space]! })
    const opened = s.tabs.at(-1)!
    s = { ...s, tabs: s.tabs.map((t) => (t.id === opened.id ? { ...t, title } : t)) }
  }
  s = { ...s, activeSpaceId: home, activeTabBySpace: {} }
  const tab = (title: string) => s.tabs.find((t) => t.title === title)!.id
  return { s, ids, tab }
}
const runtimeOf = (state: SidebarState, over: Record<string, Partial<TabRuntime>> = {}): RuntimeState => ({
  tabs: Object.fromEntries(state.tabs.map((t) => [t.id, { loading: false, audible: false, muted: false, awake: true, ...over[t.id] }])),
  canGoBack: false,
  canGoForward: false
})
const titles = (rows: ReadonlyArray<{ title: string }>) => rows.map((r) => r.title)

describe('the address of a page, for telling copies apart', () => {
  it('ignores www., the fragment, a bare trailing slash and the case of the host', () => {
    const base = normalizedAddress('https://example.org/a/b')
    expect(normalizedAddress('https://www.EXAMPLE.org/a/b/')).toBe(base)
    expect(normalizedAddress('https://example.org/a/b#section')).toBe(base)
    expect(normalizedAddress('https://example.org/')).toBe(normalizedAddress('https://example.org'))
  })

  it('keeps what makes two pages different: the path, the query, the scheme', () => {
    const base = normalizedAddress('https://example.org/a')
    expect(normalizedAddress('https://example.org/b')).not.toBe(base)
    expect(normalizedAddress('https://example.org/a?x=1')).not.toBe(base)
    expect(normalizedAddress('http://example.org/a')).not.toBe(base)
  })

  it('is null for what is not a web page', () => {
    for (const url of ['about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'file:///tmp/a.html', 'not an address', '']) expect(normalizedAddress(url), url).toBeNull()
  })
})

describe('the duplicates', () => {
  it('closes the newer copy and keeps the oldest, wherever it is (any space of the same profile)', () => {
    const { s, tab } = world([
      ['travail', 'https://docs.example/a', 'Doc A (Travail)'],
      ['perso', 'https://docs.example/a', 'Doc A (Perso)'],
      ['travail', 'https://docs.example/b', 'Doc B']
    ])
    const plan = planDuplicates(s)
    expect(plan.closeIds).toEqual([tab('Doc A (Perso)')])
    expect(plan.groups[0]).toMatchObject({ keep: tab('Doc A (Travail)'), reason: 'oldest', close: [tab('Doc A (Perso)')] })
  })

  it('does not call the same page in two profiles a copy: they are two accounts', () => {
    const { s } = world([
      ['travail', 'https://mail.example/inbox', 'Mail'],
      ['client', 'https://mail.example/inbox', 'Mail client']
    ])
    expect(planDuplicates(s).closeIds).toEqual([])
  })

  it('does not call the same page in two containers a copy', () => {
    const { s, tab } = world([
      ['travail', 'https://mail.example/inbox', 'Mail'],
      ['travail', 'https://mail.example/inbox', 'Mail (conteneur)']
    ])
    const separated = { ...s, tabs: s.tabs.map((t) => (t.id === tab('Mail (conteneur)') ? { ...t, container: 'pro' } : t)) }
    expect(planDuplicates(separated).closeIds).toEqual([])
  })

  it('never closes a pinned tab, the page of a favourite, a tab of a split view, nor the tab a space is on: those stay, and the others of the group close', () => {
    const { s, tab } = world([
      ['travail', 'https://x.example/', 'Pinned'],
      ['travail', 'https://x.example/', 'Copy 1'],
      ['travail', 'https://x.example/', 'Copy 2']
    ])
    const pinned = run(s, { type: 'tab/pin', id: tab('Pinned') })
    expect(planDuplicates(pinned).groups[0]).toMatchObject({ keep: tab('Pinned'), reason: 'pinned', close: [tab('Copy 1'), tab('Copy 2')] })

    const favourite = { ...s, tabs: s.tabs.map((t) => (t.title === 'Copy 2' ? { ...t, favoriteId: 'fav' } : t)) }
    expect(planDuplicates(favourite).groups[0]).toMatchObject({ keep: tab('Copy 2'), reason: 'favorite', close: [tab('Pinned'), tab('Copy 1')] })

    const onScreen = { ...s, activeTabBySpace: { [s.activeSpaceId]: tab('Copy 1') } }
    expect(planDuplicates(onScreen).groups[0]).toMatchObject({ keep: tab('Copy 1'), reason: 'current', close: [tab('Pinned'), tab('Copy 2')] })

    const other = run(s, { type: 'tab/open', url: 'https://other.example/', background: true })
    const split = run(other, { type: 'split/create', tabId: tab('Copy 1'), withTabId: other.tabs.at(-1)!.id })
    expect(planDuplicates(split).groups[0]).toMatchObject({ keep: tab('Copy 1'), reason: 'split', close: [tab('Pinned'), tab('Copy 2')] })
  })

  it('keeps every protected copy, and has nothing to close when all of them are', () => {
    const { s, tab } = world([
      ['travail', 'https://x.example/', 'P1'],
      ['perso', 'https://x.example/', 'P2']
    ])
    const both = run(s, { type: 'tab/pin', id: tab('P1') }, { type: 'tab/pin', id: tab('P2') })
    expect(planDuplicates(both)).toEqual({ groups: [], closeIds: [] })
    expect(closeDuplicatesAction(planDuplicates(both))).toBeNull()
  })

  it('leaves a private tab alone: the archive never hears of it, so it could not be taken back', () => {
    const { s, tab } = world([
      ['travail', 'https://x.example/', 'Public'],
      ['travail', 'https://x.example/', 'Private']
    ])
    const withPrivate = { ...s, tabs: s.tabs.map((t) => (t.title === 'Private' ? { ...t, private: true as const } : t)) }
    expect(planDuplicates(withPrivate).closeIds).toEqual([])
    expect(tab('Public')).toBeTruthy()
  })

  it('closes into the archive, and "Annuler" brings each tab back to its own space', () => {
    const { s, ids, tab } = world([
      ['travail', 'https://docs.example/a', 'A1'],
      ['perso', 'https://docs.example/a', 'A2'],
      ['travail', 'https://docs.example/a#top', 'A3']
    ])
    const plan = planDuplicates(s)
    expect(plan.closeIds).toEqual([tab('A2'), tab('A3')])
    const closed = run(s, closeDuplicatesAction(plan)!)
    expect(closed.tabs.map((t) => t.title)).toEqual(['A1'])
    expect(closed.archive.map((a) => a.id).sort()).toEqual([tab('A2'), tab('A3')].sort())

    const back = run(closed, ...reopenActions(plan.closeIds, closed.archive))
    expect(back.tabs.map((t) => t.url).sort()).toEqual(['https://docs.example/a', 'https://docs.example/a', 'https://docs.example/a#top'])
    expect(back.tabs.find((t) => t.url === 'https://docs.example/a' && t.spaceId === ids['perso'])).toBeTruthy()
    expect(back.archive).toEqual([])
  })

  it('has nothing to take back for a tab that is no longer in the archive (it was emptied meanwhile)', () => {
    expect(reopenActions(['a', 'b'], [{ id: 'b' }])).toEqual([{ type: 'archive/restore', id: 'b' }])
    expect(reopenActions(['a'], [])).toEqual([])
  })
})

describe('the list of the bar in "Onglets" mode', () => {
  const tabs: Array<[string, string, string]> = [
    ['travail', 'https://agenda.example/semaine', 'Agenda partagé'],
    ['travail', 'https://docs.example/projet', 'Documentation du projet'],
    ['perso', 'https://musique.example/playlists', 'Musique'],
    ['perso', 'https://galerie.example/albums', 'Galerie photo'],
    ['client', 'https://suivi.example/', 'Suivi client']
  ]

  it('lists the tabs of every space, grouped by space in the order of the sidebar', () => {
    const { s, ids } = world(tabs)
    const found = searchTabs(s, runtimeOf(s), '', NO_FILTERS)
    expect(found.groups.map((g) => [g.id, g.kind, g.total])).toEqual([
      [ids['travail'], 'space', 2],
      [ids['perso'], 'space', 2],
      [ids['client'], 'space', 1]
    ])
    expect(titles(found.rows)).toEqual(['Agenda partagé', 'Documentation du projet', 'Musique', 'Galerie photo', 'Suivi client'])
    expect(found.open).toBe(5)
  })

  it('finds by title or by address, accents ignored, the best answer first within a space', () => {
    // A title that starts with the text (100), one that has it at a word start (70), one that has it inside a word (50); the opening order is the reverse.
    const { s } = world([...tabs, ['travail', 'https://c.example/', 'Superprojet'], ['travail', 'https://b.example/', 'Mon projet'], ['travail', 'https://a.example/', 'Projet alpha']])
    const found = searchTabs(s, runtimeOf(s), 'PROJET', NO_FILTERS)
    expect(titles(found.rows)).toEqual(['Projet alpha', 'Mon projet', 'Documentation du projet', 'Superprojet'])
    expect(titles(searchTabs(s, runtimeOf(s), 'GALERIE', NO_FILTERS).rows)).toEqual(['Galerie photo'])
    // The address answers too.
    expect(titles(searchTabs(s, runtimeOf(s), 'musique.example', NO_FILTERS).rows)).toEqual(['Musique'])
  })

  it('does not match an address by loose letters, which would match every address', () => {
    const { s } = world([['travail', 'https://docs.example/documentation', 'Zzz']])
    expect(titles(searchTabs(s, runtimeOf(s), 'dcs', NO_FILTERS).rows)).toEqual([])
    expect(titles(searchTabs(s, runtimeOf(s), 'docs', NO_FILTERS).rows)).toEqual(['Zzz'])
  })

  it('narrows to one space, and says for each space how many lines it holds', () => {
    const { s, ids } = world(tabs)
    const found = searchTabs(s, runtimeOf(s), '', toggleSpaceFilter(NO_FILTERS, ids['perso']!))
    expect(titles(found.rows)).toEqual(['Musique', 'Galerie photo'])
    expect(found.spaceCounts).toEqual({ [ids['travail']!]: 2, [ids['perso']!]: 2, [ids['client']!]: 1 })
  })

  it('shows the states of a tab: asleep, sound, pinned, in a split view', () => {
    const { s, tab } = world(tabs)
    const state = run(s, { type: 'tab/pin', id: tab('Agenda partagé') }, { type: 'split/create', tabId: tab('Musique'), withTabId: tab('Galerie photo') })
    const runtime = runtimeOf(state, { [tab('Documentation du projet')]: { awake: false }, [tab('Suivi client')]: { audible: true, muted: true } })
    const rows = Object.fromEntries(searchTabs(state, runtime, '', NO_FILTERS).rows.map((r) => [r.title, r]))
    expect(rows['Agenda partagé']).toMatchObject({ pinned: true, asleep: false })
    expect(rows['Documentation du projet']).toMatchObject({ asleep: true })
    expect(rows['Suivi client']).toMatchObject({ audible: true, muted: true })
    expect(rows['Musique']).toMatchObject({ split: true })
    expect(rows['Galerie photo']).toMatchObject({ split: true })
  })

  it('filters by state (all the states asked for at once), and each chip counts the lines it would leave', () => {
    const { s, ids, tab } = world(tabs)
    const state = run(s, { type: 'tab/pin', id: tab('Agenda partagé') }, { type: 'tab/pin', id: tab('Musique') })
    const runtime = runtimeOf(state, { [tab('Agenda partagé')]: { awake: false }, [tab('Documentation du projet')]: { awake: false }, [tab('Musique')]: { audible: true } })
    const none = searchTabs(state, runtime, '', NO_FILTERS)
    expect(none.stateCounts).toMatchObject({ asleep: 2, audio: 1, pinned: 2, split: 0 })

    const asleep = toggleStateFilter(NO_FILTERS, 'asleep')
    expect(titles(searchTabs(state, runtime, '', asleep).rows)).toEqual(['Agenda partagé', 'Documentation du projet'])
    // With "En veille" on, "Épinglés" counts the pinned tabs that are also asleep: that is what clicking it would leave.
    expect(searchTabs(state, runtime, '', asleep).stateCounts).toMatchObject({ asleep: 2, pinned: 1, audio: 0 })
    const both = toggleStateFilter(asleep, 'pinned')
    expect(titles(searchTabs(state, runtime, '', both).rows)).toEqual(['Agenda partagé'])
    // A space chip counts under the states asked for.
    expect(searchTabs(state, runtime, '', both).spaceCounts).toMatchObject({ [ids['travail']!]: 1, [ids['perso']!]: 0 })
  })

  it('counts under the text typed: a chip never promises lines the text has taken away', () => {
    const { s, ids } = world(tabs)
    const found = searchTabs(s, runtimeOf(s), 'musique', NO_FILTERS)
    expect(found.spaceCounts).toMatchObject({ [ids['perso']!]: 1, [ids['travail']!]: 0, [ids['client']!]: 0 })
    expect(found.allSpacesCount).toBe(1)
  })

  it('flags the tab on screen and the tabs that "Fermer les doublons" would close', () => {
    const { s, tab } = world([...tabs, ['perso', 'https://agenda.example/semaine', 'Agenda (copie)']])
    const state = { ...s, activeTabBySpace: { [s.activeSpaceId]: tab('Agenda partagé') } }
    const rows = Object.fromEntries(searchTabs(state, runtimeOf(state), '', NO_FILTERS).rows.map((r) => [r.title, r]))
    expect(rows['Agenda partagé']).toMatchObject({ current: true, duplicate: false })
    expect(rows['Agenda (copie)']).toMatchObject({ current: false, duplicate: true })
  })

  it('does not list the archive unless asked: with the "Archivés" chip, or with a text and no state', () => {
    const { s, tab } = world(tabs)
    const state = run(s, { type: 'tab/archive', id: tab('Galerie photo') }, { type: 'tab/archive', id: tab('Musique') })
    expect(searchTabs(state, runtimeOf(state), '', NO_FILTERS).groups.map((g) => g.kind)).toEqual(['space', 'space'])
    const typed = searchTabs(state, runtimeOf(state), 'galerie', NO_FILTERS)
    expect(typed.groups.map((g) => g.kind)).toEqual(['archive'])
    expect(titles(typed.rows)).toEqual(['Galerie photo'])
    // A state asked for leaves the archive out (it has no sleeping or split tab).
    expect(searchTabs(state, runtimeOf(state), 'galerie', toggleStateFilter(NO_FILTERS, 'pinned')).groups).toEqual([])
    const chip = searchTabs(state, runtimeOf(state), '', toggleStateFilter(NO_FILTERS, 'archived'))
    expect(chip.groups.map((g) => g.kind)).toEqual(['archive'])
    expect(chip.archived).toBe(2)
    expect(chip.stateCounts.archived).toBe(2)
  })

  it('cuts the archive to its most recent lines and says how many there are in all', () => {
    const { s } = world([['travail', 'https://x.example/', 'X']])
    const archive = Array.from({ length: 80 }, (_, i) => ({ id: `old${i}`, spaceId: s.spaces[0]!.id, url: `https://old.example/${i}`, title: `Ancien ${i}`, archivedAt: i }))
    const state = { ...s, archive }
    const chip = searchTabs(state, runtimeOf(state), '', toggleStateFilter(NO_FILTERS, 'archived'))
    expect(chip.groups[0]).toMatchObject({ kind: 'archive', total: 80 })
    expect(chip.groups[0]!.rows).toHaveLength(ARCHIVE_ROWS)
    const typed = searchTabs(state, runtimeOf(state), 'ancien', NO_FILTERS)
    expect(typed.groups.find((g) => g.kind === 'archive')!.rows).toHaveLength(ARCHIVE_ROWS_ON_QUERY)
  })

  it('says so when nothing answers, and the filters are the way out', () => {
    const { s } = world(tabs)
    const found = searchTabs(s, runtimeOf(s), 'zzzz', toggleStateFilter(NO_FILTERS, 'pinned'))
    expect(found.rows).toEqual([])
    expect(hasFilters(toggleStateFilter(NO_FILTERS, 'pinned'))).toBe(true)
    expect(hasFilters(NO_FILTERS)).toBe(false)
  })
})

describe('the filters', () => {
  it('"Archivés" stands alone: it lets go of the other states, and they let go of it', () => {
    const asleepAndPinned = toggleStateFilter(toggleStateFilter(NO_FILTERS, 'asleep'), 'pinned')
    expect(toggleStateFilter(asleepAndPinned, 'archived').states).toEqual(['archived'])
    expect(toggleStateFilter(toggleStateFilter(NO_FILTERS, 'archived'), 'audio').states).toEqual(['audio'])
  })

  it('lets go of a state or a space pressed a second time', () => {
    expect(toggleStateFilter(toggleStateFilter(NO_FILTERS, 'split'), 'split').states).toEqual([])
    expect(toggleSpaceFilter(toggleSpaceFilter(NO_FILTERS, 's1'), 's1').space).toBeNull()
    expect(toggleSpaceFilter(toggleSpaceFilter(NO_FILTERS, 's1'), null).space).toBeNull()
  })
})

describe('what a line does', () => {
  it('goes to the tab; its space comes with it (tab/select shows the space of the tab)', () => {
    const { s, tab } = world([['perso', 'https://musique.example/', 'Musique']])
    const row = searchTabs(s, runtimeOf(s), '', NO_FILTERS).rows[0]!
    expect(choiceActions(s, row, 'go')).toEqual([{ type: 'tab/select', id: tab('Musique') }])
    const after = run(s, ...choiceActions(s, row, 'go'))
    expect(after.activeSpaceId).toBe(s.spaces[1]!.id)
  })

  it('brings a page back from the archive', () => {
    const { s, tab } = world([['travail', 'https://x.example/', 'X']])
    const archived = run(s, { type: 'tab/archive', id: tab('X') })
    const row = searchTabs(archived, runtimeOf(archived), 'x', NO_FILTERS).rows[0]!
    expect(row.kind).toBe('archived')
    expect(choiceActions(archived, row, 'go')).toEqual([{ type: 'archive/restore', id: tab('X') }])
  })

  it('puts a tab beside the one on screen with ⌘↵, only inside one space (a split view joins two tabs of one space)', () => {
    const { s, tab } = world([
      ['travail', 'https://a.example/', 'A'],
      ['travail', 'https://b.example/', 'B'],
      ['travail', 'https://d.example/', 'D'],
      ['perso', 'https://c.example/', 'C']
    ])
    const state = { ...s, activeTabBySpace: { [s.activeSpaceId]: tab('A') } }
    const row = (title: string) => searchTabs(state, runtimeOf(state), '', NO_FILTERS).rows.find((r) => r.title === title)!
    expect(choiceActions(state, row('B'), 'beside')).toEqual([{ type: 'split/create', tabId: tab('A'), withTabId: tab('B') }])
    // Another space, or the tab on screen itself: a plain "go".
    expect(choiceActions(state, row('C'), 'beside')).toEqual([{ type: 'tab/select', id: tab('C') }])
    expect(choiceActions(state, row('A'), 'beside')).toEqual([{ type: 'tab/select', id: tab('A') }])
    // A tab that is already in a split view (with D) is not put into a second one, while A is on screen.
    const joined = { ...run(state, { type: 'split/create', tabId: tab('B'), withTabId: tab('D') }), activeTabBySpace: { [s.activeSpaceId]: tab('A') } }
    expect(choiceActions(joined, row('B'), 'beside')).toEqual([{ type: 'tab/select', id: tab('B') }])
  })

  it('archives a tab with ⌫, not a pinned one, a private one, nor a line of the archive', () => {
    const { s, tab } = world([
      ['travail', 'https://a.example/', 'A'],
      ['travail', 'https://b.example/', 'B'],
      ['travail', 'https://c.example/', 'C']
    ])
    const state = run(s, { type: 'tab/pin', id: tab('A') })
    const priv = { ...state, tabs: state.tabs.map((t) => (t.title === 'C' ? { ...t, private: true as const } : t)) }
    const row = (title: string) => searchTabs(priv, runtimeOf(priv), '', NO_FILTERS).rows.find((r) => r.title === title)!
    expect(canArchiveRow(row('B'), priv)).toBe(true)
    expect(canArchiveRow(row('A'), priv)).toBe(false)
    expect(canArchiveRow(row('C'), priv)).toBe(false)
    expect(canArchiveRow({ ...row('B'), kind: 'archived' }, priv)).toBe(false)
  })

  it('reads ⌫ as "archive" on an empty field, ⌘⌫ with a text, and never from a key held down', () => {
    const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; repeat: boolean }> = {}) => ({ key: 'Backspace', metaKey: false, ctrlKey: false, repeat: false, ...over })
    expect(isArchiveKey(key(), '', 'darwin')).toBe(true)
    expect(isArchiveKey(key(), 'doc', 'darwin')).toBe(false)
    expect(isArchiveKey(key({ metaKey: true }), 'doc', 'darwin')).toBe(true)
    // Holding ⌫ to clear a long text must stop at the empty field.
    expect(isArchiveKey(key({ repeat: true }), '', 'darwin')).toBe(false)
    expect(isArchiveKey(key({ repeat: true, metaKey: true }), 'doc', 'darwin')).toBe(false)
    expect(isArchiveKey(key({ key: 'Delete' }), '', 'darwin')).toBe(false)
  })
})
