import { describe, expect, it } from 'vitest'
import { siteHomeFor, actionToDispatch, candidateDispatches, candidateHint, cardSurface, COMMAND_BAR_CARD, commandBarHeight, littleCandidates, pageColorBehind, popoverSurface, inlineCompletion, instantLinkUrls, matchScore, rankCandidates, settingsPaneLabel, type Candidate } from './command-bar'
import { SETTINGS_PAGES, type ExtensionInfo } from './ipc'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { LITTLE_TABS, littleGroupStarts, resultAtEdge } from './command-bar'
import { frenchSpaces } from './french-typography'

function stateWith(...urls: Array<[string, string]>) {
  let n = 0
  const ctx: Ctx = { now: 1000, newId: () => `id${++n}` }
  let s = createInitialState(ctx)
  const actions: Action[] = urls.map(([url]) => ({ type: 'tab/open', url }))
  for (const a of actions) {
    s = reduce(s, a, ctx)
    ctx.now += 10
  }
  s = { ...s, tabs: s.tabs.map((t, i) => ({ ...t, title: urls[i]![1] })) }
  return s
}

describe('matchScore', () => {
  it('ranks prefix > word start > substring > subsequence > none', () => {
    expect(matchScore('GitHub', 'git')).toBe(100)
    expect(matchScore('my github', 'git')).toBe(70)
    expect(matchScore('digital', 'git')).toBe(50)
    expect(matchScore('g i t', 'git')).toBe(20)
    expect(matchScore('zzz', 'git')).toBe(0)
  })

  it('ignores accents and the typographic apostrophe, so the keyboard\'s own characters match', () => {
    expect(matchScore('Déplacer vers', 'deplacer')).toBe(100)
    expect(matchScore('Épinglés', 'epingles')).toBe(100)
    expect(matchScore('Épingler l’onglet', "l'onglet")).toBe(70)
    expect(matchScore('Épingler l’onglet', 'onglet')).toBe(70)
  })
})

describe('rankCandidates', () => {
  const state = stateWith(['https://github.com/', 'GitHub'], ['https://news.ycombinator.com/', 'Hacker News'], ['https://example.org/', 'Example'])

  it('puts a typed URL first', () => {
    const [first] = rankCandidates('example.com', state)
    expect(first).toMatchObject({ kind: 'open', url: 'https://example.com' })
  })

  it('lets a strong open-tab match win over a web search', () => {
    const [first] = rankCandidates('hacker', state)
    expect(first).toMatchObject({ kind: 'tab', label: 'Hacker News' })
    // The start of a word of the title is strong enough; a piece inside a word is not, and the search leads.
    expect(rankCandidates('news', state)[0]).toMatchObject({ kind: 'tab', label: 'Hacker News' })
    expect(rankCandidates('acker', state)[0]).toMatchObject({ kind: 'open', search: true, label: 'acker' })
  })

  it('falls back to a web search when nothing matches', () => {
    const [first, ...rest] = rankCandidates('recette de crêpes', state)
    expect(first).toMatchObject({ kind: 'open', label: 'recette de crêpes', search: true })
    expect(rest.some((c) => c.kind === 'tab')).toBe(false)
  })

  it('shows recent tabs then actions on an empty query, excluding the active tab', () => {
    const list = rankCandidates('', state)
    const activeId = state.activeTabBySpace[state.activeSpaceId]
    expect(list.filter((c) => c.kind === 'tab').some((c) => c.kind === 'tab' && c.tabId === activeId)).toBe(false)
    expect(list.some((c) => c.kind === 'action')).toBe(true)
  })
})

describe('actionToDispatch', () => {
  it('toggles pin on the active tab and is a no-op without one', () => {
    const state = stateWith(['https://a.fr/', 'A'])
    expect(actionToDispatch('pin-toggle', state)).toMatchObject({ type: 'tab/pin' })
    expect(actionToDispatch('pin-toggle', createInitialState({ now: 0, newId: () => 'x' }))).toBeNull()
  })
})

describe('site search', () => {
  const state = stateWith(['https://a.fr/', 'A'])

  it('turns "yt lofi" into a YouTube search', () => {
    const [first] = rankCandidates('yt lofi beats', state)
    expect(first).toMatchObject({ kind: 'open', detail: 'Recherche sur le site' })
    expect(first && 'url' in first && first.url).toBe('https://www.youtube.com/results?search_query=lofi%20beats')
  })

  it('offers the keyword completion while typing it, and not for an unknown word', () => {
    expect(rankCandidates('yo', state).some((c) => c.kind === 'site-search' && c.keyword === 'yt')).toBe(true)
    expect(rankCandidates('zzzzz', state).some((c) => c.kind === 'site-search')).toBe(false)
  })
})

describe('history candidates', () => {
  const state = stateWith(['https://open.fr/', 'Déjà ouvert'])
  const history = [
    { url: 'https://open.fr/', title: 'Déjà ouvert', visitCount: 9, lastVisitAt: 5 },
    { url: 'https://old.example/page', title: 'Page d’exemple', visitCount: 2, lastVisitAt: 1 }
  ]

  it('suggests visited pages that are not already open', () => {
    const list = rankCandidates('exemple', state, history)
    expect(list.filter((c) => c.kind === 'history').map((c) => c.label)).toEqual(['Page d’exemple'])
    expect(rankCandidates('ouvert', state, history).some((c) => c.kind === 'history')).toBe(false)
  })
})

describe('web suggestions', () => {
  const state = stateWith(['https://a.fr/', 'Alpha'])

  it('lists suggestions after the typed query, without duplicating it, capped', () => {
    const list = rankCandidates('arc', state, [], ['arc', 'arc browser', 'Arc Browser', 'arc windows', 'arc linux', 'arc mac', 'arc reddit'])
    const suggestions = list.filter((c) => c.kind === 'suggestion').map((c) => c.label)
    expect(suggestions).toEqual(['arc browser', 'arc windows', 'arc linux', 'arc mac'])
  })

  it('offers none for a URL the user typed in full', () => {
    const list = rankCandidates('example.com', state, [], ['example.com login'])
    expect(list[0]).toMatchObject({ kind: 'open' })
  })
})

describe('usage learning', () => {
  // The last tab is the active one and is never suggested: two others compete for the same query.
  const base = stateWith(['https://docs.example/', 'Docs project'], ['https://dash.example/', 'Dashboard project'], ['https://other.example/', 'Other'])
  const labels = (state: typeof base) => rankCandidates('project', state).filter((c) => c.kind === 'tab').map((c) => c.label)

  it('puts the page that is picked more often first when two match equally', () => {
    // Both start with the same word: without usage the most recently active tab wins.
    const before = labels(base)
    expect(before).toHaveLength(2)
    const picked = before.at(-1)!
    const url = base.tabs.find((t) => t.title === picked)!.url
    const learned = { ...base, commandBarUsage: { default: { ['url:' + url]: 3 } } }
    expect(labels(learned)[0]).toBe(picked)
  })

  it('a bonus is capped and never makes a non-matching page appear', () => {
    const learned = { ...base, commandBarUsage: { default: { 'url:https://docs.example/': 999 } } }
    expect(rankCandidates('zzzzzz', learned).some((c) => c.kind === 'tab')).toBe(false)
    // Picked 999 times, a page whose title only contains the word still comes after one whose title starts with it (100 against 50 + 5 picks × 8).
    const often = stateWith(['https://alpha.example/', 'Projet alpha'], ['https://super.example/', 'Superprojet'], ['https://other.example/', 'Other'])
    const picked = { ...often, commandBarUsage: { default: { 'url:https://super.example/': 999 } } }
    expect(rankCandidates('projet', picked).filter((c) => c.kind === 'tab').map((c) => c.label)).toEqual(['Projet alpha', 'Superprojet'])
  })
})

describe('inlineCompletion', () => {
  const tab = (url: string, title = 'Page'): Candidate => ({ kind: 'tab', id: `tab:${url}`, label: title, detail: '', tabId: url, url })
  const search: Candidate = { kind: 'open', id: 'open', label: 'exam', detail: '', url: 'https://duckduckgo.com/?q=exam', search: true }

  it('completes the typed start of a host with the rest of it, keeping the typed letters', () => {
    expect(inlineCompletion('exam', [tab('https://www.example.com/page')])).toBe('example.com')
    expect(inlineCompletion('Git', [tab('https://github.com/x')])).toBe('Github.com')
    expect(inlineCompletion('www.exa', [tab('https://www.example.com/')])).toBe('www.example.com')
  })

  it('does not complete anything else', () => {
    expect(inlineCompletion('', [tab('https://example.com/')])).toBeNull()
    expect(inlineCompletion('example.com', [tab('https://example.com/')])).toBeNull()
    expect(inlineCompletion('xyz', [tab('https://example.com/')])).toBeNull()
    expect(inlineCompletion('exam ple', [tab('https://example.com/')])).toBeNull()
    expect(inlineCompletion('exam/', [tab('https://example.com/')])).toBeNull()
    expect(inlineCompletion('https:', [tab('https://example.com/')])).toBeNull()
    // Once a port is being typed the address is the user's: nothing is completed.
    expect(inlineCompletion('127.0.0.1:5', [tab('http://127.0.0.1:59094/')])).toBeNull()
  })

  it('looks past a plain search to the first page it can complete to, and never completes to a search', () => {
    expect(inlineCompletion('exam', [search, tab('https://example.com/')])).toBe('example.com')
    expect(inlineCompletion('exam', [search])).toBeNull()
  })
})

describe('instantLinkUrls', () => {
  const duck = 'https://duckduckgo.com/?q=%s'
  const google = 'https://www.google.com/search?q=%s'

  it('asks the engine for the first result when it can', () => {
    expect(instantLinkUrls('lucium navigateur', google)).toEqual(['https://www.google.com/search?q=lucium%20navigateur&btnI=1'])
    expect(instantLinkUrls('lucium', duck)).toEqual(['https://duckduckgo.com/?q=%5Clucium'])
  })

  it('gives the results page when the engine has no first-result shortcut', () => {
    expect(instantLinkUrls('lucium', 'https://www.bing.com/search?q=%s')).toEqual(['https://www.bing.com/search?q=lucium'])
  })

  it('opens one page for each comma-separated term, and keeps an address as it is', () => {
    expect(instantLinkUrls('github, example.com , ', google)).toEqual(['https://www.google.com/search?q=github&btnI=1', 'https://example.com'])
  })

  it('stops at five terms and returns nothing for an empty input', () => {
    expect(instantLinkUrls('a,b,c,d,e,f,g', google)).toHaveLength(5)
    expect(instantLinkUrls('  , ', google)).toEqual([])
  })
})

describe('candidateHint', () => {
  it('says what choosing a tab or an archived page does, and nothing for the rest', () => {
    const base = { id: 'x', label: 'x', detail: '' }
    expect(candidateHint({ ...base, kind: 'tab', tabId: 't', url: 'https://a.fr/' })).toBe('Aller à l’onglet')
    expect(candidateHint({ ...base, kind: 'archived', archivedId: 'a' })).toBe('Restaurer l’onglet')
    expect(candidateHint({ ...base, kind: 'open', url: 'https://a.fr/' })).toBe('')
  })
})

/**
 * Three spaces (Perso is the current one, Travail and Lecture are the others), an active tab, a plain tab and a split view.
 * Returns the state and the ids that the tests need.
 */
function world() {
  let n = 0
  const ctx: Ctx = { now: 1000, newId: () => `id${++n}` }
  const step = (s: SidebarState, a: Action): SidebarState => {
    const next = reduce(s, a, ctx)
    ctx.now += 10
    return next
  }
  let s = createInitialState(ctx)
  const persoId = s.activeSpaceId
  s = step(s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
  s = step(s, { type: 'space/create', name: 'Lecture', emoji: '📚', hue: 20 })
  s = step(s, { type: 'space/select', id: persoId })
  const open = (title: string, url: string) => {
    s = step(s, { type: 'tab/open', url })
    const id = s.tabs.at(-1)!.id
    s = step(s, { type: 'tab/update', id, patch: { title } })
    return id
  }
  const alpha1 = open('Alpha doc', 'https://alpha.example/doc')
  const alpha2 = open('Alpha notes', 'https://alpha.example/notes')
  s = step(s, { type: 'split/create', tabId: alpha1, withTabId: alpha2 })
  const beta = open('Beta', 'https://beta.example/')
  const current = open('Gamma', 'https://gamma.example/')
  const spaceNamed = (name: string) => s.spaces.find((sp) => sp.name === name)!
  return { state: s, ctx, persoId, alpha1, alpha2, beta, current, travail: spaceNamed('Travail'), lecture: spaceNamed('Lecture') }
}

const kinds = (list: Candidate[], kind: Candidate['kind']) => list.filter((c) => c.kind === kind)

describe('"Focus on <space>"', () => {
  const w = world()

  it('offers the other spaces whose name answers the query, in French, with their emoji', () => {
    const list = rankCandidates('travail', w.state)
    expect(kinds(list, 'space')).toEqual([{ kind: 'space', id: `space:${w.travail.id}`, label: 'Aller à l’espace Travail', detail: '', spaceId: w.travail.id, emoji: '💼' }])
    // Case, accents and the start of the name are enough.
    expect(kinds(rankCandidates('LECT', w.state), 'space').map((c) => c.id)).toEqual([`space:${w.lecture.id}`])
    expect(kinds(rankCandidates('aller travail', w.state), 'space')).toHaveLength(1)
  })

  it('never offers the space you are in', () => {
    expect(w.state.activeSpaceId).toBe(w.persoId)
    expect(kinds(rankCandidates('perso', w.state), 'space')).toEqual([])
    // Once in Travail, Perso is one of the others.
    const inTravail = reduce(w.state, { type: 'space/select', id: w.travail.id }, w.ctx)
    expect(kinds(rankCandidates('perso', inTravail), 'space').map((c) => c.label)).toEqual(['Aller à l’espace Perso'])
    expect(kinds(rankCandidates('travail', inTravail), 'space')).toEqual([])
  })

  it('offers nothing for a single letter, an empty bar or a name that is nowhere in the text', () => {
    expect(kinds(rankCandidates('t', w.state), 'space')).toEqual([])
    expect(kinds(rankCandidates('', w.state), 'space')).toEqual([])
    expect(kinds(rankCandidates('zzzz', w.state), 'space')).toEqual([])
    // Loose in-order letters count for tabs, never for names.
    expect(kinds(rankCandidates('trvl', w.state), 'space')).toEqual([])
  })

  it('puts a space typed in full first, but a part of its name only after the tabs', () => {
    expect(rankCandidates('travail', w.state)[0]).toMatchObject({ kind: 'space', spaceId: w.travail.id })
    expect(rankCandidates('Travail', w.state)[0]).toMatchObject({ kind: 'space' })
    const partial = rankCandidates('trav', w.state)
    expect(partial[0]).toMatchObject({ kind: 'open', search: true })
    expect(partial.findIndex((c) => c.kind === 'space')).toBeGreaterThan(0)
  })

  it('never leads ahead of an address typed in full, and follows a strong tab match', () => {
    const named = reduce(w.state, { type: 'space/update', id: w.travail.id, patch: { name: 'example.com' } }, w.ctx)
    expect(rankCandidates('example.com', named)[0]).toMatchObject({ kind: 'open', url: 'https://example.com' })
    const withTab = reduce(w.state, { type: 'tab/update', id: w.beta, patch: { title: 'Travail en cours' } }, w.ctx)
    const list = rankCandidates('travail', withTab)
    expect(list[0]).toMatchObject({ kind: 'tab', tabId: w.beta })
    expect(list[1]).toMatchObject({ kind: 'space', spaceId: w.travail.id })
  })

  it('lists four spaces at most', () => {
    let state = w.state
    for (let i = 1; i <= 6; i++) state = reduce(state, { type: 'space/create', name: `Projet ${i}`, emoji: '🚀', hue: 10 }, w.ctx)
    state = reduce(state, { type: 'space/select', id: w.persoId }, w.ctx)
    expect(kinds(rankCandidates('projet', state), 'space')).toHaveLength(4)
  })

  it('goes to the space when chosen', () => {
    const [space] = kinds(rankCandidates('travail', w.state), 'space')
    expect(candidateDispatches(space!)).toEqual([{ type: 'space/select', id: w.travail.id }])
    const after = candidateDispatches(space!).reduce((s, a) => reduce(s, a, w.ctx), w.state)
    expect(after.activeSpaceId).toBe(w.travail.id)
  })
})

describe('"Move to Today/Pinned in <space>"', () => {
  const w = world()
  const moves = (query: string, state = w.state) => kinds(rankCandidates(query, state), 'move') as Array<Candidate & { kind: 'move' }>

  it('proposes Today then Pinned of every other space when the text looks like "déplacer…"', () => {
    expect(moves('déplacer').map((c) => c.label)).toEqual([
      'Déplacer vers Aujourd’hui dans Travail',
      'Déplacer vers Épinglés dans Travail',
      'Déplacer vers Aujourd’hui dans Lecture',
      'Déplacer vers Épinglés dans Lecture'
    ])
    const row = moves('déplacer')[0]!
    expect(row).toMatchObject({ tabId: w.current, spaceId: w.travail.id, pinned: false, emoji: '💼', detail: 'Gamma' })
    expect(moves('deplacer')).toHaveLength(4)
    expect(moves("aujourd'hui")).toHaveLength(2)
  })

  it('narrows to a space when the text names it, the named space leading', () => {
    expect(moves('travail').map((c) => c.id)).toEqual([`move:${w.current}:${w.travail.id}:today`, `move:${w.current}:${w.travail.id}:pinned`])
    expect(moves('déplacer lecture').slice(0, 2).map((c) => c.spaceId)).toEqual([w.lecture.id, w.lecture.id])
  })

  it('never moves a tab to the space it is already in', () => {
    expect(moves('perso')).toEqual([])
    expect(moves('déplacer').some((c) => c.spaceId === w.persoId)).toBe(false)
  })

  it('needs a current tab, and stays out of an empty bar and of unrelated text', () => {
    const noTab = { ...w.state, activeTabBySpace: { ...w.state.activeTabBySpace, [w.persoId]: null } }
    expect(moves('déplacer', noTab)).toEqual([])
    expect(moves('')).toEqual([])
    expect(moves('zzzz')).toEqual([])
  })

  it('stops at six rows however many spaces there are', () => {
    let state = w.state
    for (const name of ['Un', 'Deux', 'Trois', 'Quatre']) state = reduce(state, { type: 'space/create', name, emoji: '🚀', hue: 10 }, w.ctx)
    state = reduce(state, { type: 'space/select', id: w.persoId }, w.ctx)
    expect(moves('déplacer', state)).toHaveLength(6)
  })

  it('moves the tab to Today of the other space, or moves it then pins it', () => {
    const [today, pinned] = moves('travail')
    expect(candidateDispatches(today!)).toEqual([{ type: 'tab/move-to-space', id: w.current, spaceId: w.travail.id }])
    expect(candidateDispatches(pinned!)).toEqual([
      { type: 'tab/move-to-space', id: w.current, spaceId: w.travail.id },
      { type: 'tab/pin', id: w.current }
    ])
    const run = (c: Candidate) => candidateDispatches(c).reduce((s, a) => reduce(s, a, w.ctx), w.state)
    expect(run(today!).tabs.find((t) => t.id === w.current)).toMatchObject({ spaceId: w.travail.id, pinned: false })
    expect(run(pinned!).tabs.find((t) => t.id === w.current)).toMatchObject({ spaceId: w.travail.id, pinned: true })
  })
})

describe('"Nouveau dossier"', () => {
  const state = world().state
  const folder = (query: string) => rankCandidates(query, state).filter((c) => c.kind === 'action' && c.action === 'new-folder')

  it('shows up when the text mentions a folder, and only then', () => {
    expect(folder('dossier')).toHaveLength(1)
    expect(folder('nouveau d')).toHaveLength(1)
    expect(folder('créer un dossier')).toHaveLength(1)
    expect(folder('zzzz')).toEqual([])
    expect(folder('')).toEqual([])
  })

  it('creates a folder in the current space', () => {
    const [c] = folder('dossier')
    const action = actionToDispatch((c as Candidate & { kind: 'action' }).action, state)
    expect(action).toEqual({ type: 'folder/create', name: 'Nouveau dossier' })
    const after = reduce(state, action!, { now: 5, newId: () => 'folder1' })
    expect(after.folders).toEqual([{ id: 'folder1', spaceId: state.activeSpaceId, name: 'Nouveau dossier', collapsed: false }])
  })
})

describe('"Modifier les raccourcis clavier" and the Settings panes', () => {
  const state = world().state
  const shortcuts = (query: string) => rankCandidates(query, state).filter((c) => c.kind === 'action' && c.action === 'edit-shortcuts')
  const panes = (query: string) => kinds(rankCandidates(query, state), 'pane') as Array<Candidate & { kind: 'pane' }>

  it('offers the shortcuts editor for "raccourcis" or "clavier", and opens an overlay rather than dispatching', () => {
    expect(shortcuts('raccourcis')).toHaveLength(1)
    expect(shortcuts('clavier')).toHaveLength(1)
    expect(shortcuts('modifier les')).toHaveLength(1)
    expect(shortcuts('zzzz')).toEqual([])
    expect(shortcuts('')).toEqual([])
    expect(actionToDispatch('edit-shortcuts', state)).toBeNull()
  })

  it('has a label for every pane, in the order of the window', () => {
    expect(SETTINGS_PAGES.map((p) => settingsPaneLabel(p))).toEqual(['Pour commencer', 'Apparence', 'Onglets et fenêtres', 'Navigation', 'Vie privée et sécurité', 'Téléchargements et fichiers', 'Extensions et outils', 'Clavier et souris', 'Profils', 'Fonctions en option', 'À propos et mises à jour'])
  })

  it('offers "Réglages › <volet>" for each pane its name answers to', () => {
    for (const pane of SETTINGS_PAGES) {
      expect(panes(settingsPaneLabel(pane)).map((c) => c.pane)).toContain(pane)
    }
    // The old categories that became a group of a larger one are still offered, by the name of the group, and lead to it.
    expect(panes('raccourcis')).toEqual([{ kind: 'pane', id: 'pane:keyboard/shortcuts', label: 'Réglages › Modifier les raccourcis clavier', detail: '', pane: 'keyboard', anchor: 'shortcuts' }])
    // No category is named after the lock any more ("Vie privée et sécurité" holds it): the group of that name is the one offered, and leads to the same place.
    expect(panes('verrouillage')).toEqual([{ kind: 'pane', id: 'pane:protection/lock', label: 'Réglages › Verrouillage', detail: '', pane: 'protection', anchor: 'lock' }])
    expect(panes('commencer').map((c) => c.label)).toEqual(['Réglages › Pour commencer'])
    expect(panes('clavier').map((c) => c.label)).toEqual(['Réglages › Clavier et souris', 'Réglages › Modifier les raccourcis clavier'])
    expect(panes('modifier les raccourcis').map((c) => c.pane)).toEqual(['keyboard'])
  })

  it('leads chrome://extensions to the Extensions page, first, and does not offer a web search for that text', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    for (const [typed, target] of [
      ['chrome://extensions', { view: 'list' }],
      [`chrome://extensions/?id=${id}`, { view: 'detail', extensionId: id }],
      ['chrome://extensions/shortcuts', { view: 'shortcuts' }],
      ['arc://extensions', { view: 'list' }]
    ] as const) {
      const found = rankCandidates(typed, state)
      expect(found[0], typed).toEqual({ kind: 'extpage', id: 'extpage', label: 'Ouvrir la page Extensions', detail: '', target })
      expect(found.some((c) => c.kind === 'open' || c.kind === 'pane'), typed).toBe(false)
    }
  })

  it('still searches for the other schemes that start like chrome, and for the word "extensions" (chrome://settings has its own row: chrome-pages.test.ts)', () => {
    expect(rankCandidates('chrome-untrusted://settings', state).some((c) => c.kind === 'open')).toBe(true)
    // The word offers the category and its group: "Réglages › Outils et extensions", "Réglages › Extensions" (the group), never the Extensions page.
    expect(panes('extensions').map((c) => c.id).sort()).toEqual(['pane:tools', 'pane:tools/extensions'])
  })

  it('stays quiet for "réglages" alone (the plain Settings command covers it), a single letter, an empty bar', () => {
    expect(panes('réglages')).toEqual([])
    expect(panes('g')).toEqual([])
    expect(panes('')).toEqual([])
    // Small words ("à", "la") are not names: "à" would otherwise start "À propos" and "Icône de l’application" would answer to "la".
    expect(panes('ouvrir à la maison')).toEqual([])
    expect(rankCandidates('réglages', state).some((c) => c.kind === 'action' && c.action === 'settings')).toBe(true)
  })
})

describe('"Use an extension\'s action"', () => {
  const state = world().state
  const darkReader: ExtensionInfo = { id: 'a'.repeat(32), name: 'Dark Reader', version: '4', profileId: 'default', source: 'store', enabled: true }
  const ublock: ExtensionInfo = { id: 'b'.repeat(32), name: 'uBlock Origin', version: '1', profileId: 'default', source: 'unpacked', enabled: true }
  const found = (query: string, extensions: readonly ExtensionInfo[]) => kinds(rankCandidates(query, state, [], [], extensions), 'extension') as Array<Candidate & { kind: 'extension' }>

  it('offers a loaded extension by its name, to click its icon', () => {
    expect(found('dark', [darkReader, ublock])).toEqual([{ kind: 'extension', id: `extension:${darkReader.id}`, label: 'Dark Reader', detail: 'Extension', extensionId: darkReader.id }])
    expect(found('ublock', [darkReader, ublock]).map((c) => c.label)).toEqual(['uBlock Origin'])
  })

  it('only offers the extensions that are loaded', () => {
    expect(found('dark', [])).toEqual([])
    expect(found('dark', [ublock])).toEqual([])
    expect(kinds(rankCandidates('dark', state), 'extension')).toEqual([])
  })

  it('offers only what runs in the profile of the space the user is in: not another profile\'s extension, not one switched off here', () => {
    expect(found('dark', [{ ...darkReader, profileId: 'work' }, ublock])).toEqual([])
    expect(found('dark', [{ ...darkReader, enabled: false }, ublock])).toEqual([])
    expect(found('extension', [{ ...darkReader, profileId: 'work' }, { ...ublock, enabled: false }])).toEqual([])
    expect(found('dark', [{ ...darkReader, profileId: 'work' }, darkReader]).map((c) => c.extensionId)).toEqual([darkReader.id])
  })

  it('lists an extension once although it is loaded into each profile', () => {
    expect(found('dark', [darkReader, { ...darkReader }, ublock, { ...ublock }])).toHaveLength(1)
    expect(found('extension', [darkReader, { ...darkReader }, ublock, { ...ublock }]).map((c) => c.label)).toEqual(['Dark Reader', 'uBlock Origin'])
  })

  it('lists them all for the word "extension", but not for its first letters, an empty bar or unrelated text', () => {
    expect(found('extensions', [darkReader, ublock])).toHaveLength(2)
    expect(found('ext', [darkReader, ublock])).toHaveLength(2)
    expect(found('ex', [darkReader, ublock])).toEqual([])
    expect(found('', [darkReader, ublock])).toEqual([])
    expect(found('zzzz', [darkReader, ublock])).toEqual([])
  })

  it('stops at six', () => {
    const many = Array.from({ length: 9 }, (_, i): ExtensionInfo => ({ id: String(i).repeat(32), name: `Outil ${i}`, version: '1', profileId: 'default', source: 'unpacked', enabled: true }))
    expect(found('outil', many)).toHaveLength(6)
  })
})

describe('"Switch to Split View"', () => {
  const w = world()
  const tabsFor = (query: string, state = w.state) => kinds(rankCandidates(query, state), 'tab') as Array<Candidate & { kind: 'tab' }>

  it('says so for a tab of a split view that is not on screen, once for the whole split view', () => {
    const list = tabsFor('alpha')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ split: true })
    expect(candidateHint(list[0]!)).toBe('Aller à la vue scindée')
    // The tab it leads to is the best ranked of the two: they match alike, so the most recently used one.
    const recentFirst = [w.alpha1, w.alpha2].sort((a, b) => w.state.tabs.find((t) => t.id === b)!.lastActiveAt - w.state.tabs.find((t) => t.id === a)!.lastActiveAt)
    expect(list[0]!.tabId).toBe(recentFirst[0])
  })

  it('leaves a plain tab as it was', () => {
    const [beta] = tabsFor('beta')
    expect(beta).toMatchObject({ tabId: w.beta })
    expect(beta!.split).toBeUndefined()
    expect(candidateHint(beta!)).toBe('Aller à l’onglet')
  })

  it('treats the panes of the split view on screen as plain tabs, both listed', () => {
    const inside = reduce(w.state, { type: 'tab/select', id: w.alpha1 }, w.ctx)
    const list = tabsFor('alpha', inside)
    expect(list.map((c) => c.tabId)).toEqual([w.alpha2])
    expect(list[0]!.split).toBeUndefined()
    const both = tabsFor('', inside)
    expect(both.some((c) => c.tabId === w.alpha2 && c.split === undefined)).toBe(true)
  })

  it('also groups a split view in the list of an empty bar', () => {
    const recent = tabsFor('')
    expect(recent.filter((c) => c.split)).toHaveLength(1)
    expect(recent.map((c) => c.tabId)).not.toContain(w.current)
  })
})

describe('empty bar', () => {
  it('lists none of the commands that only appear when typed for', () => {
    const w = world()
    const kindsSeen = new Set(rankCandidates('', w.state, [], [], [{ id: 'c'.repeat(32), name: 'Dark Reader', version: '1', profileId: 'default', source: 'unpacked', enabled: true }]).map((c) => (c.kind === 'action' ? c.action : c.kind)))
    for (const hidden of ['space', 'move', 'pane', 'extension', 'new-folder', 'edit-shortcuts', 'clear-site-data', 'clear-site-now']) expect(kindsSeen.has(hidden as never)).toBe(false)
  })
})

describe('"Effacer les données du site"', () => {
  const state = world().state
  const clearing = (query: string) => rankCandidates(query, state).filter((c) => c.kind === 'action' && c.action === 'clear-site-data')

  it('shows up when the text asks to erase, or names the data of a site, and only then', () => {
    expect(clearing('effacer')).toHaveLength(1)
    expect(clearing('efface les données')).toHaveLength(1)
    expect(clearing('données du site')).toHaveLength(1)
    expect(clearing('zzzz')).toEqual([])
    expect(clearing('')).toEqual([])
  })

  it('opens the panel rather than dispatching an action', () => {
    expect(actionToDispatch('clear-site-data', state)).toBeNull()
  })
})

describe('"Effacer les données du site maintenant"', () => {
  const state = world().state
  const now = (query: string) => rankCandidates(query, state).filter((c) => c.kind === 'action' && c.action === 'clear-site-now')

  it('shows up when the text asks to erase the data of a site, and only then', () => {
    expect(now('effacer')).toHaveLength(1)
    expect(now('données du site')).toHaveLength(1)
    expect(now('zzzz')).toEqual([])
    expect(now('')).toEqual([])
  })

  it('says which shortcut it has and runs without a panel or an action of the reducer', () => {
    expect(now('effacer')[0]).toMatchObject({ label: 'Effacer les données du site maintenant', detail: 'Action · ⌥⇧⌘X' })
    expect(actionToDispatch('clear-site-now', state)).toBeNull()
  })
})

describe('"Actualiser tous les onglets"', () => {
  const state = world().state
  const all = (query: string) => rankCandidates(query, state).filter((c) => c.kind === 'action' && c.action === 'reload-all')

  it('shows up when the text asks to reload the tabs, and only then', () => {
    expect(all('actualiser tous')).toHaveLength(1)
    expect(all('onglets')).toHaveLength(1)
    expect(all('zzzz')).toEqual([])
    expect(all('')).toEqual([])
  })

  it('runs without a panel or an action of the reducer: the main process reloads the pages', () => {
    expect(all('actualiser tous')[0]).toMatchObject({ label: 'Actualiser tous les onglets', detail: 'Action' })
    expect(actionToDispatch('reload-all', state)).toBeNull()
  })
})

describe('"Ouvrir le Chrome Web Store"', () => {
  const state = world().state
  const store = (query: string, s = state, options: { private?: boolean } = {}) => rankCandidates(query, s, [], [], [], options).filter((c) => c.kind === 'action' && c.action === 'web-store')
  const off = { ...state, settings: { ...state.settings, webStoreInstall: false } }

  it('shows up when the text asks for it, and only then', () => {
    expect(store('chrome web store')).toHaveLength(1)
    expect(store('web store')).toHaveLength(1)
    expect(store('zzzz')).toEqual([])
    expect(store('')).toEqual([])
    expect(store('chrome web store')[0]).toMatchObject({ label: 'Ouvrir le Chrome Web Store', detail: 'Action' })
  })

  it('is not offered while installing from the store is switched off, nor in a private window', () => {
    expect(state.settings.webStoreInstall).toBe(true)
    expect(store('chrome web store', off)).toEqual([])
    expect(store('chrome web store', state, { private: true })).toEqual([])
  })

  it('runs without a panel or an action of the reducer: the main process opens the tab', () => {
    expect(actionToDispatch('web-store', state)).toBeNull()
  })
})

describe('sharing Tweaks and themes', () => {
  const state = world().state
  const share = (query: string, options: { private?: boolean } = {}) => rankCandidates(query, state, [], [], [], options).filter((c) => c.kind === 'action' && ['import-boost', 'paste-boost', 'import-theme', 'export-theme'].includes(c.action))
  const labels = (query: string, options: { private?: boolean } = {}) => share(query, options).map((c) => c.label)

  it('shows up when the text asks for it, and only then', () => {
    // A word of the text that starts a word of the label is enough (as for the other commands of ours): the command asked for is among those offered.
    expect(labels('importer une retouche')).toContain('Importer une Retouche…')
    expect(labels('coller une retouche')).toContain('Coller une Retouche copiée')
    expect(labels('importer un thème')).toContain('Importer un thème depuis un fichier…')
    expect(labels('exporter le thème')).toContain('Exporter le thème de l’espace dans un fichier…')
    expect(labels('exporter le thème')).not.toContain('Importer une Retouche…')
    expect(labels('fichier').sort()).toEqual(['Exporter le thème de l’espace dans un fichier…', 'Importer un thème depuis un fichier…'])
    expect(labels('zzzz')).toEqual([])
    expect(labels('')).toEqual([])
  })

  it('runs without a panel or an action of the reducer: the main process shows the dialogs', () => {
    for (const action of ['import-boost', 'paste-boost', 'import-theme', 'export-theme'] as const) expect(actionToDispatch(action, state)).toBeNull()
    expect(share('importer une retouche')[0]).toMatchObject({ kind: 'action', action: 'import-boost', detail: 'Action' })
  })

  it('is not offered when sharing is switched off', () => {
    const off = { ...state, settings: { ...state.settings, boostSharing: false } }
    expect(rankCandidates('retouche', off).filter((c) => c.kind === 'action' && ['import-boost', 'paste-boost', 'import-theme', 'export-theme'].includes(c.action))).toEqual([])
    expect(rankCandidates('thème fichier', off).filter((c) => c.kind === 'action' && ['import-theme', 'export-theme'].includes(c.action))).toEqual([])
    expect(labels('importer une retouche')).toContain('Importer une Retouche…')
  })

  it('is not offered in a private window, which keeps no Tweak, space or theme', () => {
    expect(labels('retouche', { private: true })).toEqual([])
    expect(labels('thème', { private: true })).toEqual([])
    expect(labels('importer', { private: true })).toEqual([])
  })
})

describe('the card of the bar', () => {
  it('is 329 px tall with five rows: field and rule 64, list 4 + 250 + 9, borders 2', () => {
    expect(commandBarHeight(5)).toBe(329)
    expect(COMMAND_BAR_CARD.width).toBe(766)
  })

  it('follows the rows down to the field alone, and stops at five rows', () => {
    expect(commandBarHeight(0)).toBe(66)
    expect(commandBarHeight(1)).toBe(66 + 4 + 50 + 9)
    expect(commandBarHeight(14)).toBe(commandBarHeight(5))
    expect(commandBarHeight(-3)).toBe(commandBarHeight(0))
  })

  it('is #191919 over a dark page and #303030 over a white one, with its edges', () => {
    expect(cardSurface('#212225')).toMatchObject({ fill: '#191919', edge: '#3d3d3d' })
    expect(cardSurface('#ffffff')).toMatchObject({ fill: '#303030', edge: '#606060' })
  })

  it('draws a dark ring only over a light page (#050505 on white, almost nothing on a dark page)', () => {
    expect(cardSurface('#ffffff').ring).toBe('rgb(0 0 0 / 0.98)')
    expect(cardSurface('#212225').ring).toBe('rgb(0 0 0 / 0.06)')
    expect(Number(/\/ ([\d.]+)\)/.exec(cardSurface('#808080').ring)![1])).toBeGreaterThan(0.3)
  })

  it('falls back to the dark page for a colour it cannot read', () => {
    expect(cardSurface(undefined)).toEqual(cardSurface('#212225'))
    expect(cardSurface('rebeccapurple')).toEqual(cardSurface('#212225'))
  })
})

describe('the site control center material', () => {
  it('is #383838 with #121212 buttons over a white page', () => {
    expect(popoverSurface('#ffffff')).toEqual({ fill: '#383838', tile: '#121212' })
  })

  it('is much darker over a dark page, and never reads a colour it cannot parse', () => {
    expect(popoverSurface('#212225').fill).toBe('#070708')
    expect(popoverSurface('nonsense')).toEqual(popoverSurface('#212225'))
  })
})

describe('the colour behind a panel', () => {
  it('is the colour the tab reports, white when the page reports none, and the dark window when there is no tab', () => {
    expect(pageColorBehind('#336699')).toBe('#336699')
    expect(pageColorBehind(null)).toBe('#ffffff')
    expect(pageColorBehind('transparent')).toBe('#ffffff')
    expect(pageColorBehind(undefined)).toBeUndefined()
  })
})

describe('littleCandidates (the bar of a mini window)', () => {
  const state = () => stateWith(['https://news.example.com/', 'News'], ['https://docs.example.org/', 'Docs'])
  const visit = (url: string, title: string) => ({ url, title, visitCount: 1, lastVisitAt: 1 })

  it('lists the open tabs, then the recent visits (five at most), while nothing is typed', () => {
    const history = Array.from({ length: 8 }, (_, i) => visit(`https://site${i}.example/`, `Site ${i}`))
    const rows = littleCandidates('', state(), history, [])
    expect(rows.filter((c) => c.kind === 'tab').map((c) => c.label)).toEqual(['Docs', 'News'])
    expect(rows.filter((c) => c.kind === 'history')).toHaveLength(5)
    expect(rows.map((c) => c.kind)).toEqual(['tab', 'tab', 'history', 'history', 'history', 'history', 'history'])
    expect(rows[2]).toMatchObject({ label: 'Site 0', detail: 'site0.example' })
    expect(littleCandidates('  ', state(), [], []).map((c) => c.kind)).toEqual(['tab', 'tab'])
  })

  it('lists the tab shown in the main window too: it is the way to bring it back to the front', () => {
    const s = state()
    const shown = s.tabs.find((t) => t.id === s.activeTabBySpace[s.activeSpaceId])!
    expect(littleCandidates('', s, [], []).some((c) => c.kind === 'tab' && c.tabId === shown.id)).toBe(true)
  })

  it('offers what was typed, the history, and the open tabs: never the actions or the spaces of the main window', () => {
    const rows = littleCandidates('news', state(), [visit('https://news.ycombinator.com/', 'Hacker News')], ['news today'])
    expect(rows.map((c) => c.kind)).toEqual(expect.arrayContaining(['tab', 'open', 'history', 'suggestion']))
    expect(rows.some((c) => c.kind === 'action' || c.kind === 'space' || c.kind === 'move' || c.kind === 'archived' || c.kind === 'pane' || c.kind === 'extension')).toBe(false)
  })

  it('puts the open tabs first, three at most', () => {
    const many = stateWith(...Array.from({ length: 6 }, (_, i): [string, string] => [`https://n${i}.example/`, `Note ${i}`]))
    const rows = littleCandidates('note', many, [], [])
    expect(rows.slice(0, LITTLE_TABS).every((c) => c.kind === 'tab')).toBe(true)
    expect(rows.filter((c) => c.kind === 'tab')).toHaveLength(LITTLE_TABS)
    expect(rows[LITTLE_TABS]!.kind).not.toBe('tab')
  })

  it('lets a web address typed in full lead, so that Enter opens it and not a tab that only resembles it', () => {
    const rows = littleCandidates('news.example.com', state(), [], [])
    expect(rows[0]).toMatchObject({ kind: 'open', url: 'https://news.example.com' })
    expect(rows.some((c) => c.kind === 'tab')).toBe(true)
    // Text that is a search, not an address, leaves the tab first.
    expect(littleCandidates('news', state(), [], [])[0]!.kind).toBe('tab')
  })

  it('never lists a private tab, and lists no tab at all while the bar does not offer tabs', () => {
    const s = state()
    const withPrivate = { ...s, tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, private: true } : t)) }
    expect(littleCandidates('news', withPrivate, [], []).some((c) => c.kind === 'tab' && c.label === 'News')).toBe(false)
    expect(littleCandidates('', withPrivate, [], []).filter((c) => c.kind === 'tab').map((c) => c.label)).toEqual(['Docs'])
    expect(littleCandidates('news', { ...s, settings: { ...s.settings, suggestTabs: false } }, [], []).some((c) => c.kind === 'tab')).toBe(false)
  })

  it('titles the groups where they start: "Onglets ouverts" before the tabs, "Suggestions" before the other pages', () => {
    const rows = littleCandidates('news', state(), [visit('https://news.ycombinator.com/', 'Hacker News')], [])
    expect(littleGroupStarts(rows).filter((g) => g !== null)).toEqual(['tabs', 'suggestions'])
    expect(littleGroupStarts(rows)[0]).toBe('tabs')
    expect(littleGroupStarts([])).toEqual([])
  })

  it('titles each run of a group that is cut in two, and nothing between rows of the same group', () => {
    const rows = littleCandidates('news.example.com', state(), [visit('https://news.ycombinator.com/', 'Hacker News')], [])
    const starts = littleGroupStarts(rows)
    expect(starts[0]).toBe('suggestions')
    expect(starts.filter((g) => g === 'tabs')).toHaveLength(1)
    expect(starts.filter((g) => g !== null).length).toBeLessThanOrEqual(2)
  })
})

describe('sessions in the command bar', () => {
  /** Two tabs, saved as "Projet X" and "Veille tech". */
  const withSessions = () => {
    let n = 0
    const ctx: Ctx = { now: 5000, newId: () => `id${++n}` }
    let s = stateWith(['https://a.example/', 'A'], ['https://b.example/', 'B'])
    s = reduce(s, { type: 'session/save', name: 'Projet X' }, ctx)
    return reduce(s, { type: 'session/save', name: 'Veille tech' }, ctx)
  }

  it('offers "Restaurer la session <nom>" for the sessions the query names, and nothing for an empty bar', () => {
    const s = withSessions()
    const labels = (q: string) => rankCandidates(q, s).filter((c) => c.kind === 'session').map((c) => c.label)
    expect(labels('')).toEqual([])
    expect(labels('projet')).toEqual(['Restaurer la session Projet X'])
    expect(labels('veille')).toEqual(['Restaurer la session Veille tech'])
    expect(labels('restaurer')).toEqual(['Restaurer la session Veille tech', 'Restaurer la session Projet X'])
    expect(labels('zzzz')).toEqual([])
    expect(rankCandidates('projet', s).find((c) => c.kind === 'session')).toMatchObject({ detail: 'Session · 2 onglets', sessionId: s.sessions[1]!.id })
  })

  it('restores a session with the reducer action of the session, in the current space', () => {
    const s = withSessions()
    const candidate = rankCandidates('projet', s).find((c) => c.kind === 'session')!
    expect(candidateDispatches(candidate)).toEqual([{ type: 'session/restore', id: s.sessions[1]!.id }])
  })

  it('offers the commands that save a session and show the list when typed, not on an empty bar', () => {
    const s = withSessions()
    const actions = (q: string) => rankCandidates(q, s).filter((c): c is Extract<Candidate, { kind: 'action' }> => c.kind === 'action').map((c) => c.action)
    expect(actions('enregistrer la session')).toContain('save-session')
    expect(actions('afficher les sessions')).toContain('sessions')
    expect(actions('session')).toEqual(expect.arrayContaining(['save-session', 'sessions']))
    expect(actions('').some((a) => a === 'save-session' || a === 'sessions')).toBe(false)
    // They open the panel (handled by the caller), they are not reducer actions.
    expect(actionToDispatch('save-session', s)).toBeNull()
    expect(actionToDispatch('sessions', s)).toBeNull()
  })

  it('offers none of it in a private window, which keeps no session', () => {
    const s = withSessions()
    const rows = rankCandidates('session', s, [], [], [], { private: true })
    expect(rows.some((c) => c.kind === 'session' || (c.kind === 'action' && (c.action === 'save-session' || c.action === 'sessions')))).toBe(false)
    expect(rankCandidates('projet', s, [], [], [], { private: true }).some((c) => c.kind === 'session')).toBe(false)
  })

  it('keeps the sessions out of the bar of a mini window', () => {
    expect(littleCandidates('projet', withSessions(), [], []).some((c) => c.kind === 'session')).toBe(false)
  })
})

describe('putting a space aside from the command bar', () => {
  let n = 0
  const ctx: Ctx = { now: 5000, newId: () => `id${++n}` }
  const twoSpaces = () => {
    let s = stateWith(['https://a.example/', 'A'], ['https://b.example/', 'B'])
    s = reduce(s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    return reduce(s, { type: 'tab/open', url: 'https://w.example/' }, ctx)
  }
  const asideOf = (s: ReturnType<typeof twoSpaces>, spaceId: string) => reduce(s, { type: 'space/aside', id: spaceId }, ctx)
  const actionsOf = (q: string, s: ReturnType<typeof twoSpaces>, options = {}) => rankCandidates(q, s, [], [], [], options).filter((c): c is Extract<Candidate, { kind: 'action' }> => c.kind === 'action').map((c) => c.action)

  it('offers "Mettre l’espace de côté" when typed, not on an empty bar', () => {
    const s = twoSpaces()
    expect(actionsOf('mettre de côté', s)).toContain('aside-space')
    expect(actionsOf('espace de côté', s)).toContain('aside-space')
    expect(actionsOf('', s)).not.toContain('aside-space')
    expect(rankCandidates('mettre', s).find((c) => c.kind === 'action' && c.action === 'aside-space')).toMatchObject({ label: 'Mettre l’espace de côté' })
    // It asks first, in the main process: not a reducer action.
    expect(actionToDispatch('aside-space', s)).toBeNull()
  })

  it('does not offer it for the only space, in a private window, or past the limit of sessions', () => {
    expect(actionsOf('mettre de côté', stateWith(['https://a.example/', 'A']))).not.toContain('aside-space')
    expect(actionsOf('mettre de côté', twoSpaces(), { private: true })).not.toContain('aside-space')
    const full = { ...twoSpaces(), sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: i, tabs: [{ url: 'https://s.example/', title: 's' }] })) }
    expect(actionsOf('mettre de côté', full)).not.toContain('aside-space')
  })

  it('offers "Rouvrir l’espace <nom>" for a space put aside, which reopens it with the reducer’s action', () => {
    const s = twoSpaces()
    const work = s.activeSpaceId
    const aside = reduce(asideOf(s, work), { type: 'space/select', id: s.spaces[0]!.id }, ctx)
    const rows = rankCandidates('travail', aside).filter((c) => c.kind === 'session')
    expect(rows.map((c) => c.label)).toEqual(['Rouvrir l’espace Travail'])
    expect(rows[0]).toMatchObject({ detail: 'Espace mis de côté · 1 onglet', aside: true })
    expect(candidateDispatches(rows[0]!)).toEqual([{ type: 'space/reopen', id: aside.sessions[0]!.id }])
    // An ordinary session keeps its own words and action.
    const plain = reduce(aside, { type: 'session/save', name: 'Projet X' }, ctx)
    const projet = rankCandidates('projet', plain).find((c) => c.kind === 'session')!
    expect(projet.label).toBe('Restaurer la session Projet X')
    expect(candidateDispatches(projet)).toEqual([{ type: 'session/restore', id: plain.sessions[0]!.id }])
  })

  it('keeps a space put aside out of the spaces the bar goes to, and out of private windows', () => {
    const s = twoSpaces()
    const aside = reduce(asideOf(s, s.activeSpaceId), { type: 'space/select', id: s.spaces[0]!.id }, ctx)
    expect(rankCandidates('travail', aside).some((c) => c.kind === 'space')).toBe(false)
    expect(rankCandidates('travail', aside, [], [], [], { private: true }).some((c) => c.kind === 'session')).toBe(false)
  })
})


describe('the privacy actions', () => {
  const state = stateWith(['https://example.org/', 'Example'])
  const labels = (query: string, over: Partial<SidebarState['settings']> = {}, options: { private?: boolean } = {}) =>
    rankCandidates(query, { ...state, settings: { ...state.settings, ...over } }, [], [], [], options).filter((c) => c.kind === 'action').map((c) => c.label)

  it('are offered when typed, never on an empty bar', () => {
    expect(labels('onglet privé')).toContain('Nouvel onglet privé')
    expect(labels('cookies')).toContain('Cookies par site')
    expect(labels('')).not.toContain('Nouvel onglet privé')
    expect(labels('')).not.toContain('Cookies par site')
  })

  it('follow their switches', () => {
    expect(labels('onglet privé', { privateTabs: false })).not.toContain('Nouvel onglet privé')
    expect(labels('cookies', { cookieManager: false })).not.toContain('Cookies par site')
  })

  it('are not offered in a private window, which has no such tab and no profile to list', () => {
    expect(labels('onglet privé', {}, { private: true })).not.toContain('Nouvel onglet privé')
    expect(labels('cookies', {}, { private: true })).not.toContain('Cookies par site')
  })

  it('open a panel or a tab through the interface, not through the reducer', () => {
    expect(actionToDispatch('new-private-tab', state)).toBeNull()
    expect(actionToDispatch('cookie-manager', state)).toBeNull()
  })
})

describe('named windows in the command bar', () => {
  const state = stateWith(['https://a.example/', 'A'])
  const windows = [{ id: 'window-1', name: 'Travail' }, { id: 'window-2', name: 'Vidéos' }]

  it('offers "Aller à la fenêtre" for a window whose name is typed, and "Nommer la fenêtre…" when the word is', () => {
    const found = rankCandidates('travail', state, [], [], [], { windows })
    expect(found.filter((c) => c.kind === 'window')).toEqual([{ kind: 'window', id: 'window:window-1', label: frenchSpaces('Aller à la fenêtre « Travail »'), detail: 'Fenêtre', windowId: 'window-1' }])
    const word = rankCandidates('fenêtre', state, [], [], [], { windows })
    expect(word.filter((c) => c.kind === 'window')).toHaveLength(2)
    expect(word.some((c) => c.kind === 'action' && c.action === 'name-window')).toBe(true)
  })

  it('offers nothing about windows while windows cannot be named: no action, no window', () => {
    for (const query of ['travail', 'fenêtre', 'nommer']) {
      const found = rankCandidates(query, state, [], [], [], {})
      expect(found.some((c) => c.kind === 'window' || (c.kind === 'action' && c.action === 'name-window')), query).toBe(false)
    }
  })

  it('does not list windows on an empty bar, and the name-window action opens a panel instead of changing the state', () => {
    expect(rankCandidates('', state, [], [], [], { windows }).some((c) => c.kind === 'window')).toBe(false)
    expect(actionToDispatch('name-window', state)).toBeNull()
  })

  it('has no candidate for a window that nobody named (they are not in the list the shell sends)', () => {
    expect(rankCandidates('fenêtre 2', state, [], [], [], { windows: [] }).some((c) => c.kind === 'window')).toBe(false)
  })
})

describe('the keyword of a site search typed alone opens the site', () => {
  const base = world().state
  const state = { ...base, settings: { ...base.settings, siteSearches: [...base.settings.siteSearches, { keyword: 'tw', name: 'Twitch', url: 'https://www.twitch.tv/search?term=%s' }] } }

  it('offers the home page of the site first: "tw" opens Twitch', () => {
    expect(siteHomeFor('tw', state)).toEqual({ name: 'Twitch', url: 'https://www.twitch.tv/' })
    expect(siteHomeFor('  TW ', state)).toEqual({ name: 'Twitch', url: 'https://www.twitch.tv/' })
    expect(rankCandidates('tw', state)[0]).toEqual({ kind: 'open', id: 'open:site-home', label: 'Twitch', detail: 'Ouvrir le site', url: 'https://www.twitch.tv/' })
  })

  it('keeps "tw loup" a search in the site, and says nothing for a word that is no keyword or a keyword with text', () => {
    expect(siteHomeFor('tw loup', state)).toBeNull()
    expect(rankCandidates('tw loup', state)[0]).toMatchObject({ id: 'open:site', label: expect.stringContaining('Twitch') })
    expect(siteHomeFor('twi', state)).toBeNull()
    expect(siteHomeFor('', state)).toBeNull()
  })
})

describe('a shortcut without %s opens the site as it is written', () => {
  const base = world().state
  const state = { ...base, settings: { ...base.settings, siteSearches: [{ keyword: 'tw', name: 'Twitch', url: 'https://www.twitch.tv/directory' }] } }

  it('opens the address of the shortcut, path included', () => {
    expect(siteHomeFor('tw', state)).toEqual({ name: 'Twitch', url: 'https://www.twitch.tv/directory' })
    expect(rankCandidates('tw', state)[0]).toMatchObject({ kind: 'open', id: 'open:site-home', url: 'https://www.twitch.tv/directory' })
  })

  it('is never offered as a search: there is no place for the text in its address', () => {
    expect(rankCandidates('tw loup', state).some((c) => c.kind === 'open' && c.id === 'open:site')).toBe(false)
    expect(rankCandidates('tw', state).some((c) => c.kind === 'site-search' && c.keyword === 'tw')).toBe(false)
  })
})

describe('Home and End in the field (resultAtEdge)', () => {
  const none = { shiftKey: false, metaKey: false, altKey: false, ctrlKey: false }
  const caret = (value: string, at: number, to = at) => ({ value, selectionStart: at, selectionEnd: to })

  it('gives the last line for End with the caret at the end of the text, and the first for Home with it at the start', () => {
    expect(resultAtEdge('End', none, caret('abc', 3), 5)).toBe(4)
    expect(resultAtEdge('Home', none, caret('abc', 0), 5)).toBe(0)
    // An empty field has its caret at both ends.
    expect(resultAtEdge('End', none, caret('', 0), 5)).toBe(4)
    expect(resultAtEdge('Home', none, caret('', 0), 5)).toBe(0)
  })

  it('leaves the key to the field while its caret has somewhere to go, or some text is selected', () => {
    expect(resultAtEdge('End', none, caret('abc', 1), 5)).toBeNull()
    expect(resultAtEdge('End', none, caret('abc', 0), 5)).toBeNull()
    expect(resultAtEdge('Home', none, caret('abc', 3), 5)).toBeNull()
    expect(resultAtEdge('Home', none, caret('abc', 1), 5)).toBeNull()
    // The completed part of an address is selected: End first accepts it.
    expect(resultAtEdge('End', none, caret('exemple.org', 7, 11), 5)).toBeNull()
    expect(resultAtEdge('Home', none, caret('abc', 0, 3), 5)).toBeNull()
  })

  it('leaves a key with a modifier to the field, and every other key', () => {
    for (const modifier of ['shiftKey', 'metaKey', 'altKey', 'ctrlKey'] as const) expect(resultAtEdge('End', { ...none, [modifier]: true }, caret('abc', 3), 5), modifier).toBeNull()
    for (const key of ['ArrowDown', 'Enter', 'PageDown', 'a']) expect(resultAtEdge(key, none, caret('', 0), 5), key).toBeNull()
  })

  it('gives nothing when there is no line to go to', () => {
    expect(resultAtEdge('End', none, caret('abc', 3), 0)).toBeNull()
    expect(resultAtEdge('Home', none, caret('abc', 0), 0)).toBeNull()
  })
})
