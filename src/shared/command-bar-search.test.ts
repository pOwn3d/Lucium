// The search features of the command bar: the sources of the proposals, "!" keywords and the calculator. The rest of the bar is in command-bar.test.ts.

import { describe, expect, it } from 'vitest'
import { candidateHint, littleCandidates, rankCandidates, scopeSiteFor, type Candidate } from './command-bar'
import type { HistoryEntry, SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { frenchSpaces } from './french-typography'

function build(settings: Partial<SidebarState['settings']> = {}): SidebarState {
  let n = 0
  const ctx: Ctx = { now: 1000, newId: () => `id${++n}` }
  let s = createInitialState(ctx)
  for (const url of ['https://current.example/', 'https://zebra.example/', 'https://cedre.example/']) {
    s = reduce(s, { type: 'tab/open', url } satisfies Action, ctx)
    ctx.now += 10
  }
  s = { ...s, tabs: s.tabs.map((t, i) => ({ ...t, title: ['Courant', 'Zèbre ouvert', 'Cèdre ouvert'][i]! })) }
  const spaceId = s.spaces[0]!.id
  return {
    ...s,
    archive: [{ id: 'ar1', spaceId, url: 'https://old.example/zebre', title: 'Zèbre archivé', archivedAt: 5 }],
    readLater: [{ id: 'rl1', url: 'https://lire.example/zebre', title: 'Zèbre à lire', savedAt: 6 }],
    settings: { ...s.settings, searchSuggestions: true, ...settings }
  }
}

const history: HistoryEntry[] = [{ url: 'https://visite.example/zebre', title: 'Zèbre visité', visitCount: 3, lastVisitAt: 7 }]
const kinds = (list: Candidate[]) => list.map((c) => c.kind)
const rank = (query: string, state: SidebarState, suggestions: string[] = ['zèbre suggéré']) => rankCandidates(query, state, history, suggestions)

describe('the sources of the proposals (n° 45)', () => {
  it('offers all of them by default, as before', () => {
    const list = rank('zèbre', build())
    expect(kinds(list)).toEqual(expect.arrayContaining(['tab', 'archived', 'readlater', 'history', 'suggestion']))
  })

  it.each([
    ['suggestHistory', 'history'],
    ['suggestTabs', 'tab'],
    ['suggestArchive', 'archived'],
    ['suggestReadLater', 'readlater']
  ] as const)('leaves out one source when %s is off, and only that one', (key, kind) => {
    const all = kinds(rank('zèbre', build()))
    const off = kinds(rank('zèbre', build({ [key]: false })))
    expect(off).not.toContain(kind)
    for (const other of ['tab', 'archived', 'readlater', 'history', 'suggestion', 'open'] as const) {
      if (other !== kind) expect(off, other).toContain(other)
    }
    expect(off.length).toBeLessThan(all.length)
  })

  it('keeps the web suggestions the caller passes in (their own switch is searchSuggestions, per profile)', () => {
    const list = rank('zèbre', build({ suggestHistory: false, suggestTabs: false, suggestArchive: false, suggestReadLater: false }))
    expect(kinds(list)).toContain('suggestion')
    expect(kinds(list)).toContain('open')
    expect(kinds(list)).not.toEqual(expect.arrayContaining(['tab']))
  })

  it('offers no tab on an empty bar when tabs are off (the commands stay)', () => {
    expect(kinds(rankCandidates('', build())).filter((k) => k === 'tab').length).toBeGreaterThan(0)
    const list = rankCandidates('', build({ suggestTabs: false }))
    expect(kinds(list)).not.toContain('tab')
    expect(kinds(list)).toContain('action')
  })

  it('shows a page of the history that is also open once tabs are off, since the tab is not offered', () => {
    const open = build()
    const state = build({ suggestTabs: false })
    const opened: HistoryEntry[] = [{ url: open.tabs[1]!.url, title: 'Zèbre ouvert', visitCount: 1, lastVisitAt: 1 }]
    expect(kinds(rankCandidates('zèbre', open, opened))).not.toContain('history')
    expect(rankCandidates('zèbre', state, opened).map((c) => c.id)).toContain(`history:${open.tabs[1]!.url}`)
  })

  it('gives the bar of a mini window no recent page when the history is off', () => {
    // The open tabs lead the list now ("Onglets ouverts"); the recent pages are the rows of history.
    expect(littleCandidates('', build(), history, []).filter((c) => c.kind === 'history')).toHaveLength(1)
    expect(kinds(littleCandidates('', build({ suggestHistory: false }), history, []))).not.toContain('history')
    expect(littleCandidates('', build({ suggestHistory: false, suggestTabs: false }), history, [])).toEqual([])
    expect(kinds(littleCandidates('zèbre', build({ suggestHistory: false }), history, []))).not.toContain('history')
  })
})

describe('"!" keywords (n° 52)', () => {
  it('turns "!w foo" into the Wikipédia search, in the place of the web search, with the same row as a site search', () => {
    const list = rankCandidates('!w planète', build())
    expect(list[0]).toMatchObject({ kind: 'open', id: 'open:bang', label: frenchSpaces('Wikipédia : « planète »'), detail: 'Recherche sur le site', url: 'https://fr.wikipedia.org/w/index.php?search=plan%C3%A8te' })
    expect(list.some((c) => c.kind === 'open' && c.search)).toBe(false)
  })

  it('also reads the keyword at the end', () => {
    expect(rankCandidates('planète !wen', build())[0]).toMatchObject({ id: 'open:bang', url: 'https://en.wikipedia.org/w/index.php?search=plan%C3%A8te' })
  })

  it('opens the site when only the keyword is typed, and offers to complete it with Tab', () => {
    const list = rankCandidates('!wen', build())
    expect(list[0]).toMatchObject({ kind: 'open', label: 'Wikipedia (anglais)', detail: 'Ouvrir le site', url: 'https://en.wikipedia.org/' })
    expect(list.find((c) => c.kind === 'site-search')).toMatchObject({ label: 'Rechercher sur Wikipedia (anglais)', keyword: '!wen', detail: 'Tab ⇥' })
  })

  it('lists the keywords while the "!" is being typed', () => {
    const list = rankCandidates('!', build())
    const completions = list.filter((c) => c.kind === 'site-search')
    expect(completions).toHaveLength(5)
    expect(completions.every((c) => c.kind === 'site-search' && c.keyword.startsWith('!'))).toBe(true)
    expect(rankCandidates('!wi', build()).filter((c) => c.kind === 'site-search').map((c) => c.kind === 'site-search' && c.keyword)).toEqual(['!w', '!wen', '!wikt'])
  })

  it('keeps "yt lofi" as it was, and does not read "yt" as a keyword without its "!"', () => {
    expect(rankCandidates('yt lofi', build())[0]).toMatchObject({ id: 'open:site' })
    expect(rankCandidates('wen planète', build())[0]).toMatchObject({ id: 'open', search: true })
  })

  it('searches the engine for an unknown keyword, as any text', () => {
    expect(rankCandidates('!nope foo', build())[0]).toMatchObject({ kind: 'open', id: 'open', search: true })
    expect(kinds(rankCandidates('!nope', build()))).not.toContain('site-search')
  })

  it('does nothing with a "!" when the setting is off', () => {
    const state = build({ searchBangs: false })
    expect(rankCandidates('!w planète', state)[0]).toMatchObject({ id: 'open', search: true })
    expect(kinds(rankCandidates('!', state))).not.toContain('site-search')
    expect(scopeSiteFor('!w', state)).toBeUndefined()
    // Not even before a keyword of the user's: « !yt » is text, « yt » keeps its pill.
    expect(scopeSiteFor('!yt', state)).toBeUndefined()
    expect(scopeSiteFor('yt', state)?.name).toBe('YouTube')
  })

  it('opens a keyword as a pill: the user\'s own search, or "!" and any keyword of the list', () => {
    const state = build()
    expect(scopeSiteFor('yt', state)?.name).toBe('YouTube')
    expect(scopeSiteFor('!yt', state)?.name).toBe('YouTube')
    expect(scopeSiteFor('!hn', state)?.name).toBe('Hacker News')
    expect(scopeSiteFor('hn', state)).toBeUndefined()
    expect(scopeSiteFor('!nope', state)).toBeUndefined()
    expect(scopeSiteFor('!constructor', state)).toBeUndefined()
  })

  it('is offered in the bar of a mini window, which has the same open and Tab rows', () => {
    const list = littleCandidates('!w planète', build(), [], [])
    expect(list[0]).toMatchObject({ id: 'open:bang' })
  })
})

// A « Rechercher sur … · Tab » row whose Tab opens no pill (scopeSiteFor) was a dead key.
describe('the rows « Rechercher sur … · Tab » are all alive', () => {
  const TYPED = ['g', 'gh', 'gm', 'y', 'yo', 'tw', 'git', 'so', 'wi', 'npm', '!', '!g', '!gh', '!w']
  const siteRows = (query: string, state: SidebarState) => rankCandidates(query, state).filter((c): c is Extract<Candidate, { kind: 'site-search' }> => c.kind === 'site-search')

  it('offers no row for a keyword of the default list that Tab would not open (GitHub: only « !gh » and the user’s own searches do)', () => {
    const state = build()
    expect(scopeSiteFor('gh', state)).toBeUndefined()
    expect(siteRows('gh', state).map((c) => c.keyword)).toEqual([])
    expect(siteRows('git', state).map((c) => c.keyword)).toEqual([])
    // The keyword with its « ! » is the way in, and it is offered.
    expect(siteRows('!gh', state).map((c) => c.keyword)).toEqual(['!gh'])
  })

  it('keeps the row of « yt », which Tab opens as a pill', () => {
    expect(siteRows('yo', build()).map((c) => c.keyword)).toEqual(['yt'])
  })

  it('keeps the row of a search of the user’s own, even with the keyword of a default one', () => {
    const own = { keyword: 'gh', name: 'Mon dépôt', url: 'https://depot.example/search?q=%s' }
    const state = build({ siteSearches: [...build().settings.siteSearches, own] })
    expect(siteRows('gh', state).map((c) => c.keyword)).toEqual(['gh'])
    expect(scopeSiteFor('gh', state)?.name).toBe('Mon dépôt')
  })

  it('never lists a row Tab cannot open, whatever is typed and whether the « ! » keywords are on or off', () => {
    for (const searchBangs of [true, false]) {
      const state = build({ searchBangs })
      for (const query of TYPED) {
        for (const row of siteRows(query, state)) expect(scopeSiteFor(row.keyword, state), `${query} → ${row.keyword} (bangs ${searchBangs})`).toBeDefined()
      }
    }
    // « yt » stays a bare keyword with the « ! » keywords off (it is the user's own search then), and the other defaults have no row at all.
    expect(siteRows('yo', build({ searchBangs: false })).map((c) => c.keyword)).toEqual(['yt'])
    expect(siteRows('g', build({ searchBangs: false }))).toEqual([])
  })
})

describe('the calculator (n° 67)', () => {
  it('leads the list with the answer, copy text apart', () => {
    const list = rankCandidates('12*(3+4)', build())
    expect(list[0]).toEqual({ kind: 'calc', id: 'calc', label: '= 84', detail: '12*(3+4)', copy: '84' })
    expect(list[1]).toMatchObject({ kind: 'open', search: true })
  })

  it('stays first even when a tab matches the text strongly', () => {
    const state = build()
    state.tabs[1]!.title = '2+2 en détail'
    expect(rankCandidates('2+2', state)[0]).toMatchObject({ kind: 'calc', copy: '4' })
  })

  it('says what Enter does', () => {
    expect(candidateHint({ kind: 'calc', id: 'calc', label: '= 4', detail: '2+2', copy: '4' })).toBe('Copier le résultat')
  })

  it('offers nothing for what is not a calculation', () => {
    for (const text of ['zèbre', '42', '2026-10-24', '1/0', 'github.com/a-b', 'http://localhost:3000/a+b', '(5)']) {
      expect(kinds(rank(text, build())), text).not.toContain('calc')
    }
  })

  it('never reads the text when it is switched off', () => {
    expect(kinds(rankCandidates('12*(3+4)', build({ commandBarCalc: false })))).not.toContain('calc')
    expect(rankCandidates('12*(3+4)', build({ commandBarCalc: false }))[0]).toMatchObject({ kind: 'open', search: true })
  })

  it('does not appear in the bar of a mini window, which cannot copy', () => {
    expect(kinds(littleCandidates('12*(3+4)', build(), [], []))).not.toContain('calc')
  })

  it('keeps the other rows of a text that is also a calculation, like a tab named after it', () => {
    const state = build()
    // The last tab opened is the one on screen, which the bar never offers.
    state.tabs[1]!.title = '12*(3+4)'
    expect(kinds(rankCandidates('12*(3+4)', state))).toEqual(expect.arrayContaining(['calc', 'tab']))
  })
})
