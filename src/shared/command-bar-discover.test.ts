// « Découvrir Lucium » in the command bar: typing « découvrir » (or « discover ») offers the panel, an empty bar does not list it (it would bury the rest),
// and choosing it asks for no change of state (the bar opens the panel).

import { afterEach, describe, expect, it } from 'vitest'
import { actionToDispatch, rankCandidates } from './command-bar'
import { setLanguage } from './i18n'
import { createInitialState, type Ctx } from './sidebar'

let n = 0
const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
const state = createInitialState(ctx)
const actions = (query: string) => rankCandidates(query, state, [], [], [], { platform: 'darwin' }).flatMap((c) => (c.kind === 'action' ? [c.action] : []))

afterEach(() => setLanguage('fr'))

describe('the command « Découvrir Lucium » of the command bar', () => {
  it('is offered by « découvrir », « decouvrir » and « découvrir lucium », in French', () => {
    expect(actions('découvrir')).toContain('discover')
    expect(actions('decouvrir')).toContain('discover')
    expect(actions('découvrir lucium')).toContain('discover')
  })

  it('is offered by « discover » when the interface is in English', () => {
    setLanguage('en')
    expect(actions('discover')).toContain('discover')
    expect(actions('discover lucium')).toContain('discover')
  })

  it('stays out of an empty bar and of a search that has nothing to do with it', () => {
    expect(actions('')).not.toContain('discover')
    expect(actions('recette de cuisine')).not.toContain('discover')
  })

  it('is not offered in a private window, which does not open the panel (the entry of the Aide menu is greyed out for the same reason)', () => {
    const inPrivate = (query: string) => rankCandidates(query, state, [], [], [], { platform: 'darwin', private: true }).flatMap((c) => (c.kind === 'action' ? [c.action] : []))
    expect(inPrivate('découvrir')).not.toContain('discover')
    expect(inPrivate('découvrir lucium')).not.toContain('discover')
    expect(actions('découvrir')).toContain('discover')
  })

  it('changes no state: the bar opens the panel', () => {
    expect(actionToDispatch('discover', state)).toBeNull()
  })
})
