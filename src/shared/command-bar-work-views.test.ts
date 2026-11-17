// The work views in the command bar: a view of the profile on screen is found by its name (or by « vue de travail »), under its own title, and choosing it
// opens the view. None in a private window, none of another profile, none with the function off.

import { describe, expect, it } from 'vitest'
import { candidateDispatches, candidateGroup, candidatePreview, groupTitle, inScope, rankCandidates, type Candidate } from './command-bar'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action } from './sidebar'

let n = 0
const ctx = { now: 1_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A space with a work view « Client Dupont » of three sites, in a grid. */
function withView(): SidebarState {
  let state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://dupont.example/' }, { type: 'tab/open', url: 'https://admin.dupont.example/' }, { type: 'tab/open', url: 'https://docs.example/dupont' })
  const [a, b, c] = state.tabs.map((t) => t.id)
  state = run(state, { type: 'split/create', tabId: a!, withTabId: b! }, { type: 'split/create', tabId: a!, withTabId: c! })
  state = run(state, { type: 'split/layout', id: state.splits[0]!.id, layout: 'grid' }, { type: 'view/save', splitId: state.splits[0]!.id, name: 'Client Dupont', emoji: '🪚' })
  return state
}

const views = (list: Candidate[]) => list.filter((c): c is Extract<Candidate, { kind: 'workview' }> => c.kind === 'workview')

describe('the work views in the command bar', () => {
  it('finds a view by its name, says what it is and how many sites it opens, and opens it when chosen', () => {
    const state = withView()
    const [found] = views(rankCandidates('dupont', state))
    expect(found).toMatchObject({ label: 'Client Dupont', detail: 'Vue de travail · 3 sites', emoji: '🪚', viewId: state.workViews[0]!.id })
    expect(candidateDispatches(found!)).toEqual([{ type: 'view/open', id: state.workViews[0]!.id }])
    expect(groupTitle(candidateGroup(found!), 'dupont')).toBe('Vues de travail')
    // « > » keeps the commands and the places to go to: a view is one.
    expect(inScope([found!], 'commands')).toEqual([found])
  })

  it('lists every view of the profile for « vue de travail »', () => {
    expect(views(rankCandidates('vue de travail', withView())).map((c) => c.label)).toEqual(['Client Dupont'])
  })

  it('shows in its preview the layout, the sites and where it opens', () => {
    const state = withView()
    const [found] = views(rankCandidates('dupont', state))
    const preview = candidatePreview(found!, { state, now: 1_000, mode: 'new' })
    expect(preview.note).toBe('dupont.example · admin.dupont.example · docs.example')
    expect(preview.chips).toEqual(['3 sites, en grille, 50 / 50 en largeur, 50 / 50 en hauteur', 'S’ouvre dans l’espace affiché'])
  })

  it('offers none in a private window, none of another profile, none with the function off', () => {
    const state = withView()
    expect(views(rankCandidates('dupont', state, [], [], [], { private: true }))).toEqual([])
    const work = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    expect(views(rankCandidates('dupont', work))).toEqual([])
    expect(views(rankCandidates('dupont', run(state, { type: 'settings/update', patch: { workViewsEnabled: false } })))).toEqual([])
  })
})
