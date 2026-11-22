// The results of the command bar in groups, the size of the card, the genre chips and the preview of the highlighted line. The ranking itself (what
// comes first and why) is in command-bar.test.ts and command-bar-search.test.ts; here it is only checked that grouping leaves it alone.

import { describe, expect, it } from 'vitest'
import { bookmarkCandidates, BAR_WIDTH, PREVIEW_WIDTH, actionShortcut, actionToDispatch, barLayout, candidateGroup, candidatePreview, groupCandidates, groupStarts, groupTitle, inScope, rankCandidates, siteHomeFor, splitScope, type Candidate } from './command-bar'
import type { HistoryEntry, SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { frenchSpaces } from './french-typography'

let n = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** The current page (docs.example), two other tabs, a tab on agenda.local, and a few entries of the archive and the library. */
function world(settings: Partial<SidebarState['settings']> = {}): SidebarState {
  let s = createInitialState(ctx)
  for (const [url, title] of [
    ['https://docs.example/', 'Documentation'],
    ['https://agenda.local/semaine', 'Agenda partagé'],
    ['https://musique.local/', 'Musique']
  ] as const) {
    s = run(s, { type: 'tab/open', url })
    s = { ...s, tabs: s.tabs.map((t) => (t.url === url ? { ...t, title } : t)) }
  }
  s = run(s, { type: 'tab/select', id: s.tabs[0]!.id })
  const spaceId = s.spaces[0]!.id
  return { ...s, archive: [{ id: 'ar1', spaceId, url: 'https://old.example/agenda', title: 'Agenda 2025', archivedAt: 5 }], settings: { ...s.settings, ...settings } }
}
const history: HistoryEntry[] = [{ url: 'https://visite.local/agenda', title: 'Agenda visité', visitCount: 3, lastVisitAt: 900_000 }]
const kinds = (list: readonly Candidate[]) => list.map((c) => c.kind)

describe('the genres of the results', () => {
  it('gives each kind of result its genre: an address and a web search are two', () => {
    const list = rankCandidates('agenda.local', world(), history)
    const open = list.find((c) => c.kind === 'open')!
    expect(candidateGroup(open)).toBe('address')
    expect(candidateGroup(rankCandidates('agenda', world(), history, ['agenda partagé']).find((c) => c.kind === 'suggestion')!)).toBe('web')
    expect(candidateGroup(rankCandidates('agenda', world(), history).find((c) => c.kind === 'open')!)).toBe('web')
    expect(candidateGroup(rankCandidates('agenda', world(), history).find((c) => c.kind === 'tab')!)).toBe('tabs')
    expect(candidateGroup(rankCandidates('agenda', world(), history).find((c) => c.kind === 'archived')!)).toBe('archive')
    expect(candidateGroup(rankCandidates('agenda', world(), history).find((c) => c.kind === 'history')!)).toBe('history')
    expect(candidateGroup(rankCandidates('télécharg', world(), history).find((c) => c.kind === 'action')!)).toBe('commands')
  })

  it('runs a calculation as a genre of its own, and a site search as a web search', () => {
    expect(candidateGroup(rankCandidates('12*(3+4)', world(), history).find((c) => c.kind === 'calc')!)).toBe('calc')
    const settings = { siteSearches: [{ keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' }] }
    const searched = rankCandidates('yt lofi', world(settings), history).find((c) => c.id === 'open:site')!
    expect(candidateGroup(searched)).toBe('web')
  })
})

describe('grouping', () => {
  it('puts each genre in one run, in the order of its best result, and keeps the order inside a genre', () => {
    const ranked = rankCandidates('agenda', world(), history, ['agenda partagé famille', 'agenda semaine 44'])
    // As ranked, the web search, its suggestions and the tabs are interleaved with other genres.
    const grouped = groupCandidates(ranked)
    const runs = groupStarts(grouped).filter((g) => g !== null)
    expect(new Set(runs).size).toBe(runs.length)
    expect(grouped).toHaveLength(ranked.length)
    // The order inside a genre is the ranking's.
    for (const group of new Set(grouped.map(candidateGroup))) {
      expect(grouped.filter((c) => candidateGroup(c) === group)).toEqual(ranked.filter((c) => candidateGroup(c) === group))
    }
  })

  it('leaves the first line where the ranking put it: it is what Enter opens', () => {
    for (const query of ['agenda', 'agenda.local', 'docs', 'musique', 'https://example.org', '12*(3+4)', 'nouvel']) {
      const ranked = rankCandidates(query, world(), history, ['x suggéré'])
      expect(groupCandidates(ranked)[0], query).toBe(ranked[0])
    }
  })

  // Enter on an address that is already open does not take you to that tab; the tab is the next line, a keystroke away.
  it('keeps an address typed in full ahead of the tab that already is on it', () => {
    const state = world({ goToOpenTab: true })
    const grouped = groupCandidates(rankCandidates('agenda.local', state, history))
    expect(grouped[0]).toMatchObject({ kind: 'open', url: 'http://agenda.local' })
    expect(grouped[0]).not.toHaveProperty('search')
    expect(kinds(grouped).indexOf('tab')).toBeGreaterThan(0)
    expect(grouped.find((c) => c.kind === 'tab')).toMatchObject({ label: 'Agenda partagé' })
  })

  it('still lets a text that is not an address lead with the tab that answers it, in a bar that edits the current tab', () => {
    // `tabLeadsSearch`: in the bar of ⌘L the strong tab leads the search; in the bar of ⌘T it does not (setting goToOpenTab).
    const state = world()
    const edit = groupCandidates(rankCandidates('musique', state, history, [], [], { newTab: false }))
    expect(edit[0]).toMatchObject({ kind: 'tab', label: 'Musique' })
    const fresh = groupCandidates(rankCandidates('musique', state, history, [], [], { newTab: true }))
    expect(fresh[0]).toMatchObject({ kind: 'open', search: true })
  })

  it('keeps the keyword shortcut: the keyword alone opens the site, first', () => {
    const state = world({ siteSearches: [{ keyword: 'tw', name: 'Twitch', url: 'https://www.twitch.tv/search?term=%s' }] })
    expect(siteHomeFor('tw', state)).toEqual({ name: 'Twitch', url: 'https://www.twitch.tv/' })
    const grouped = groupCandidates(rankCandidates('tw', state, history))
    expect(grouped[0]).toMatchObject({ kind: 'open', id: 'open:site-home', url: 'https://www.twitch.tv/' })
  })

  it('marks the first line of each genre, and only that one', () => {
    const grouped = groupCandidates(rankCandidates('agenda', world(), history))
    const starts = groupStarts(grouped)
    expect(starts[0]).toBe(candidateGroup(grouped[0]!))
    grouped.forEach((c, i) => {
      if (i > 0 && candidateGroup(c) === candidateGroup(grouped[i - 1]!)) expect(starts[i]).toBeNull()
      else expect(starts[i]).toBe(candidateGroup(c))
    })
  })

  it('titles the genres, and says "recent" and "frequent" while nothing is typed', () => {
    expect(groupTitle('tabs', '')).toBe('Onglets récents')
    expect(groupTitle('tabs', 'doc')).toBe('Onglets ouverts')
    expect(groupTitle('commands', '')).toBe('Commandes fréquentes')
    expect(groupTitle('commands', 'doc')).toBe('Commandes')
    expect(groupTitle('web', 'doc')).toBe('Rechercher sur le web')
    expect(groupTitle('bookmarks', 'x')).toBe('Signets')
  })
})

describe('the size of the card', () => {
  it('is 640 px for the field alone, 720 px with lines to choose from and a column of preview, and none of its own in a Mini-fenêtre', () => {
    expect(barLayout(0, false)).toEqual({ width: 640, preview: false })
    expect(barLayout(1, false)).toEqual({ width: 720, preview: true })
    expect(barLayout(12, false)).toEqual({ width: 720, preview: true })
    expect(barLayout(12, true)).toEqual({ width: null, preview: false })
    expect(barLayout(0, true)).toEqual({ width: null, preview: false })
    expect([BAR_WIDTH.field, BAR_WIDTH.results, PREVIEW_WIDTH]).toEqual([640, 720, 250])
  })
})

describe('the genre chips and the letters that name them', () => {
  it('reads `>` as the commands and `@` as the open tabs, and the text after it as the search', () => {
    expect(splitScope('> thème')).toEqual({ scope: 'commands', text: 'thème' })
    expect(splitScope('>thème')).toEqual({ scope: 'commands', text: 'thème' })
    expect(splitScope('@agenda')).toEqual({ scope: 'tabs', text: 'agenda' })
    expect(splitScope('@')).toEqual({ scope: 'tabs', text: '' })
  })

  it('reads `*` as the bookmarks and `^` as the history, and the words `@bookmarks` and `@history` the same', () => {
    expect(splitScope('* recette')).toEqual({ scope: 'bookmarks', text: 'recette' })
    expect(splitScope('*')).toEqual({ scope: 'bookmarks', text: '' })
    expect(splitScope('^ météo')).toEqual({ scope: 'history', text: 'météo' })
    expect(splitScope('^')).toEqual({ scope: 'history', text: '' })
    expect(splitScope('@bookmarks recette')).toEqual({ scope: 'bookmarks', text: 'recette' })
    expect(splitScope('@Bookmarks')).toEqual({ scope: 'bookmarks', text: '' })
    expect(splitScope('@history  météo')).toEqual({ scope: 'history', text: 'météo' })
  })

  it('leaves `*` and `^` to ordinary searches unless alone or followed by a space, and to a site search keyword that starts with them', () => {
    for (const typed of ['*.example.com', '^2', '*foo', '^météo']) expect(splitScope(typed)).toEqual({ scope: null, text: typed })
    expect(splitScope('^ mot', ['^'])).toEqual({ scope: null, text: '^ mot' })
    expect(splitScope('* mot', ['*x'])).toEqual({ scope: null, text: '* mot' })
    expect(splitScope('* mot', ['^'])).toEqual({ scope: 'bookmarks', text: 'mot' })
  })

  it('keeps `@` followed by any other word as the open tabs', () => {
    expect(splitScope('@historyx')).toEqual({ scope: 'tabs', text: 'historyx' })
    expect(splitScope('@bookmark')).toEqual({ scope: 'tabs', text: 'bookmark' })
  })

  it('keeps only the bookmarks in the bookmarks genre', () => {
    const lines: Candidate[] = [
      { kind: 'bookmark', id: 'bookmark:1', label: 'Recette', detail: '', bookmarkId: '1' },
      { kind: 'history', id: 'history:u', label: 'u', detail: '', url: 'https://u.test/' },
      { kind: 'open', id: 'q', label: 'q', detail: '', url: 'https://q.test/', search: true }
    ]
    expect(inScope(lines, 'bookmarks').map((c) => c.kind)).toEqual(['bookmark'])
    expect(inScope(lines, 'history').map((c) => c.kind)).toEqual(['history'])
  })

  it('lists the bookmarks with nothing typed, up to the asked limit, and none in a private window or with the library off', () => {
    const marks = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, url: `https://m${i}.test/`, title: `Marque ${i}`, tags: [], addedAt: i }))
    const state = { ...world({ bookmarkManager: true }), bookmarks: marks }
    expect(bookmarkCandidates('', state, false)).toHaveLength(4)
    expect(bookmarkCandidates('', state, false, 12)).toHaveLength(6)
    expect(bookmarkCandidates('marque 3', state, false, 12).map((c) => c.id)).toEqual(['bookmark:b3'])
    expect(bookmarkCandidates('', state, true, 12)).toEqual([])
    expect(bookmarkCandidates('', { ...state, settings: { ...state.settings, bookmarkManager: false } }, false, 12)).toEqual([])
  })

  it('filters the bookmarks by tag with "#tag": the beginning of the tag is enough, case and accents do not count, tags add up, and a tag is not a word of the title', () => {
    const marks = [
      { id: 'b1', url: 'https://tarte.test/', title: 'Tarte', tags: ['Été', 'cuisine'], addedAt: 1 },
      { id: 'b2', url: 'https://doc.test/', title: 'Doc', tags: ['dev'], addedAt: 2 },
      { id: 'b3', url: 'https://sans.test/', title: 'Sans étiquette', tags: [], addedAt: 3 }
    ]
    const state = { ...world({ bookmarkManager: true }), bookmarks: marks }
    const ids = (query: string) => bookmarkCandidates(query, state, false, 12).map((c) => c.id).sort()
    expect(ids('#ete')).toEqual(['bookmark:b1'])
    expect(ids('#ÉT')).toEqual(['bookmark:b1'])
    expect(ids('#cui #ete')).toEqual(['bookmark:b1'])
    expect(ids('#cuisine #dev')).toEqual([])
    expect(ids('#dev')).toEqual(['bookmark:b2'])
    expect(ids('#tarte')).toEqual([])
    expect(ids('#etiquette')).toEqual([])
    expect(ids('tarte #cuisine')).toEqual(['bookmark:b1'])
    // The tags a bookmark carries are named in its line, with their "#".
    expect(bookmarkCandidates('#dev', state, false, 12)[0]!.detail).toContain('#dev')
  })

  it('leaves `#` to the tag of a bookmark, and any other text without a genre', () => {
    expect(splitScope('#dev')).toEqual({ scope: null, text: '#dev' })
    expect(splitScope('agenda > x')).toEqual({ scope: null, text: 'agenda > x' })
    expect(splitScope('')).toEqual({ scope: null, text: '' })
  })

  it('keeps the lines of the genre and nothing else: no web search inside "Commandes"', () => {
    const ranked = rankCandidates('agenda', world(), history, ['agenda semaine'])
    expect(kinds(inScope(ranked, 'tabs'))).toEqual(kinds(ranked).filter((k) => k === 'tab'))
    expect(inScope(ranked, 'tabs').length).toBeGreaterThan(0)
    expect(kinds(inScope(ranked, 'history'))).toEqual(['history'])
    const commands = inScope(rankCandidates('thème', world(), history), 'commands')
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((c) => ['action', 'pane', 'extension', 'extpage', 'internal', 'webpanel', 'container', 'session', 'space', 'move', 'window'].includes(c.kind))).toBe(true)
    expect(inScope(ranked, null)).toEqual(ranked)
  })
})

describe('the preview of the highlighted line', () => {
  const at = { now: 1_000_000 + 3 * 3_600_000, mode: 'new' as const, platform: 'darwin' as const }

  it('describes an open tab: its picture is asked for, its address, its space, when it was used, and the keys', () => {
    const state = world()
    const tab = rankCandidates('agenda', state, history).find((c) => c.kind === 'tab')!
    const preview = candidatePreview(tab, { state, history, ...at })
    expect(preview).toMatchObject({ glyph: 'page', title: 'Agenda partagé', address: 'agenda.local/semaine', thumbTabId: expect.any(String) })
    expect(preview.chips.some((c) => c.startsWith('Actif '))).toBe(true)
    expect(preview.keys.map((k) => k.keys)).toEqual(['↵', '⌘↵'])
    expect(preview.keys[0]!.label).toBe('Aller à l’onglet')
  })

  it('names the space of a tab only when there is more than one', () => {
    const one = world()
    const tab = rankCandidates('agenda', one, history).find((c) => c.kind === 'tab')!
    expect(candidatePreview(tab, { state: one, history, ...at }).chips.join('|')).not.toMatch(/Perso|Travail/)
    const two = run(one, { type: 'space/create', name: 'Études', emoji: '📚', hue: 20 })
    const found = rankCandidates('agenda', two, history).find((c) => c.kind === 'tab')!
    // The tab lives in the first space, whose name is the default one.
    expect(candidatePreview(found, { state: two, history, ...at }).chips[0]).toContain(two.spaces[0]!.name)
  })

  it('says where an address will open, and offers ⌘↵ only where ↵ does something else', () => {
    const state = world()
    const address = rankCandidates('exemple.org', state, history).find((c) => c.kind === 'open')!
    expect(candidatePreview(address, { state, history, ...at, mode: 'new' })).toMatchObject({ chips: ['Dans un nouvel onglet'], keys: [{ keys: '↵', label: 'Ouvrir la page' }] })
    expect(candidatePreview(address, { state, history, ...at, mode: 'current' })).toMatchObject({ chips: ['Dans cet onglet'] })
    expect(candidatePreview(address, { state, history, ...at, mode: 'current' }).keys.map((k) => k.keys)).toEqual(['↵', '⌘↵'])
    expect(candidatePreview(address, { state, history, ...at, mode: 'split' }).chips).toEqual(['Dans le volet de droite'])
  })

  it('describes a search by its text, a history page by its visits, and offers ⇧⌫ to forget it', () => {
    const state = world()
    const search = rankCandidates('quelque chose', state, history).find((c) => c.kind === 'open')!
    expect(candidatePreview(search, { state, history, ...at })).toMatchObject({ glyph: 'search', title: frenchSpaces('« quelque chose »') })
    const page = rankCandidates('agenda', state, history).find((c) => c.kind === 'history')!
    const preview = candidatePreview(page, { state, history, ...at })
    expect(preview.chips).toEqual(['Visité il y a 3 heures', '3 visites'])
    expect(preview.keys.map((k) => k.keys)).toEqual(['↵', '⇧⌫'])
    // A line the typing left highlighted, not chosen with the arrows: ⇧⌫ is the field's key there, and is not listed.
    expect(candidatePreview(page, { state, history, ...at, picked: false }).keys.map((k) => k.keys)).toEqual(['↵'])
    expect(candidatePreview(page, { state, history, ...at, picked: true }).keys.map((k) => k.keys)).toEqual(['↵', '⇧⌫'])
  })

  it('describes the answer of a calculation, an archived page, and a command with its shortcut as the user has it', () => {
    const state = world()
    const calc = rankCandidates('12*(3+4)', state, history).find((c) => c.kind === 'calc')!
    expect(candidatePreview(calc, { state, history, ...at })).toMatchObject({ glyph: 'calc', title: '= 84', keys: [{ keys: '↵', label: 'Copier le résultat' }] })
    const archived = rankCandidates('agenda', state, history).find((c) => c.kind === 'archived')!
    expect(candidatePreview(archived, { state, history, ...at })).toMatchObject({ glyph: 'archive', address: 'old.example/agenda' })
    const find = rankCandidates('rechercher dans', state, history).find((c) => c.kind === 'action' && c.action === 'find')!
    expect(candidatePreview(find, { state, history, ...at }).chips).toEqual(['Raccourci ⌘F'])
    const moved = { ...state, settings: { ...state.settings, keyBindings: { find: 'CmdOrCtrl+Alt+G' } } }
    expect(candidatePreview(find, { state: moved, history, ...at }).chips).toEqual(['Raccourci ⌥⌘G'])
    const unbound = { ...state, settings: { ...state.settings, keyBindings: { find: '' } } }
    expect(candidatePreview(find, { state: unbound, history, ...at }).chips).toEqual(['Sans raccourci'])
  })

  it('draws the shortcut of a command from the same bindings as the menus', () => {
    const state = world()
    expect(actionShortcut('settings', state, 'darwin')).toBe('⌘,')
    expect(actionShortcut('edit-space', state, 'darwin')).toBeNull()
  })
})

describe('"Rechercher un onglet…", the way into the "Onglets" mode from the bar', () => {
  const offered = (state: SidebarState, query: string) => rankCandidates(query, state, history).find((c) => c.kind === 'action' && c.action === 'search-tabs')

  it('is offered when typed, while the function is on, and never listed on the empty bar', () => {
    expect(offered(world(), 'rechercher un onglet')).toMatchObject({ label: 'Rechercher un onglet…' })
    expect(offered(world(), 'onglet')).toBeDefined()
    expect(rankCandidates('', world(), history).some((c) => c.kind === 'action' && c.action === 'search-tabs')).toBe(false)
  })

  it('is not offered when the function is off', () => {
    expect(offered(world({ tabSearch: false }), 'rechercher un onglet')).toBeUndefined()
  })

  it('changes the mode of the bar and dispatches nothing', () => {
    expect(actionToDispatch('search-tabs', world())).toBeNull()
  })

  it('shows the key the user has for the mode, in the preview', () => {
    const state = world({ keyBindings: { tabSearch: 'CmdOrCtrl+Alt+J' } })
    const found = offered(state, 'rechercher un onglet')!
    expect(candidatePreview(found, { state, history, now: 1_000_000, mode: 'new', platform: 'darwin' }).chips).toEqual(['Raccourci ⌥⌘J'])
    expect(candidatePreview(found, { state: world(), history, now: 1_000_000, mode: 'new', platform: 'darwin' }).chips).toEqual(['Raccourci ⇧⌘A'])
  })
})
