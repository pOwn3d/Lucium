import { describe, expect, it } from 'vitest'
import { CLEAR_ALL_KEEP_MAX, CLEAR_ALL_STORAGE_TYPES, clearAllChoices, clearAllPrompt, identityActions, cleanClearAllKeep, keptOrigins, profilesToClear, spareKept } from './clear-all'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'
import { createInitialState, reduce, type Action } from './sidebar'
import type { CookieEntry } from './cookies'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)
const cookie = (domain: string, name = 'sid'): CookieEntry => ({ domain, name, path: '/', secure: true, session: false, hostOnly: !domain.startsWith('.'), size: 10 })

describe('the sites « tout effacer » spares', () => {
  it('keeps valid hosts only, each once and without « www. », and no more than the bound', () => {
    expect(cleanClearAllKeep(['https://www.Exemple.org/page', 'exemple.org', 'banque.fr', 42, '', 'not a host'])).toEqual(['exemple.org', 'banque.fr'])
    expect(cleanClearAllKeep('exemple.org')).toEqual([])
    expect(cleanClearAllKeep(Array.from({ length: CLEAR_ALL_KEEP_MAX + 20 }, (_, i) => `site${i}.org`))).toHaveLength(CLEAR_ALL_KEEP_MAX)
  })

  it('turns each host into the origins of its storage, over both schemes, with and without www', () => {
    expect(keptOrigins(['exemple.org'])).toEqual(['https://exemple.org', 'http://exemple.org', 'https://www.exemple.org', 'http://www.exemple.org'])
    expect(keptOrigins([])).toEqual([])
  })

  it('never lists the cookies in the types the engine wipes by origin: they are spared by their own rule', () => {
    expect(CLEAR_ALL_STORAGE_TYPES).not.toContain('cookies')
    expect(CLEAR_ALL_STORAGE_TYPES).toContain('localStorage')
    expect(CLEAR_ALL_STORAGE_TYPES).toContain('indexedDB')
    expect(CLEAR_ALL_STORAGE_TYPES).toContain('cache')
  })

  it('removes every cookie but those of a spared site, its subdomains and the parent domains it sends to', () => {
    const jar = [cookie('.exemple.org'), cookie('app.exemple.org'), cookie('.autre.net'), cookie('banque.fr'), cookie('exemple.org.evil.net')]
    // Mutation: a list that is ignored (`spareKept` returning the whole jar) makes the cookies of exemple.org go too.
    expect(spareKept(jar, ['exemple.org']).map((c) => c.domain)).toEqual(['.autre.net', 'banque.fr', 'exemple.org.evil.net'])
    expect(spareKept(jar, [])).toHaveLength(5)
  })
})

describe('which profiles are erased', () => {
  const single = createInitialState(ctx)
  const several = run(single, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileName: 'Travail' })

  it('is the current profile alone, or every profile a space uses', () => {
    expect(profilesToClear(several, 'travail', 'profile')).toEqual(['travail'])
    expect([...profilesToClear(several, 'travail', 'all')].sort()).toEqual(['default', 'travail'])
    expect(profilesToClear(single, 'default', 'all')).toEqual(['default'])
  })

  it('offers the whole-set choice in the confirmation only when there are several profiles, and cancel last', () => {
    expect(clearAllChoices(single).map((c) => c.scope)).toEqual(['profile', null])
    expect(clearAllChoices(several).map((c) => c.scope)).toEqual(['profile', 'all', null])
  })

  it('words the buttons in both languages', () => {
    try {
      setLanguage('en')
      expect(clearAllChoices(several).map((c) => c.label)).toEqual(['Clear all', 'Clear every profile', 'Cancel'])
    } finally {
      setLanguage('fr')
    }
    expect(clearAllChoices(several).map((c) => c.label)).toEqual(['Tout effacer', 'Effacer tous les profils', 'Annuler'])
  })
})

describe('the confirmation', () => {
  const single = createInitialState(ctx)
  const several = run(single, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileName: 'Travail' })
  const sparing = (state: typeof single, hosts: string[]) => run(state, { type: 'settings/update', patch: { clearAllKeepHosts: hosts } })

  it('says what goes and what the tabs do, and names the profile only when there are several', () => {
    const one = clearAllPrompt(single, 'default', 'everything')
    expect(one.message).toBe(frenchSpaces('Tout effacer ?'))
    expect(one.detail).toContain('Les onglets ouverts se rechargent.')
    expect(one.detail).not.toContain('tous les profils')
    expect(clearAllPrompt(several, 'travail', 'everything').message).toBe(frenchSpaces('Tout effacer dans le profil « Travail » ?'))
    expect(clearAllPrompt(several, 'travail', 'everything').detail).toContain('Effacer tous les profils')
  })

  it('counts the spared sites, in the singular and the plural', () => {
    expect(clearAllPrompt(sparing(single, ['exemple.org']), 'default', 'everything').detail).toContain('sauf ceux d’1 site')
    expect(clearAllPrompt(sparing(single, ['a.org', 'b.org']), 'default', 'everything').detail).toContain('sauf ceux de 2 sites')
    expect(clearAllPrompt(single, 'default', 'everything').detail).not.toContain('sauf')
  })

  it('tells the identity from the plain erasure: the tabs close and a window opens', () => {
    const identity = clearAllPrompt(single, 'default', 'identity')
    expect(identity.message).toBe(frenchSpaces('Nouvelle identité ?'))
    expect(identity.detail).toContain('se ferment')
    expect(identity.detail).not.toContain('se rechargent')
  })
})

describe('a new identity', () => {
  const base = createInitialState(ctx)
  const home = base.activeSpaceId
  const withWork = run(base, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileName: 'Travail' })
  const work = withWork.spaces.find((space) => space.profileId === 'travail')!.id
  const state = { ...withWork, tabs: [{ ...withWork.tabs[0]!, id: 'h1', spaceId: home }, { ...withWork.tabs[0]!, id: 'w1', spaceId: work }, { ...withWork.tabs[0]!, id: 'w2', spaceId: work }, { ...withWork.tabs[0]!, id: 'p1', spaceId: work, private: true }] }

  it('closes the tabs of the erased profile only, and empties the archive of its spaces only', () => {
    const actions = identityActions(state, ['travail'])
    expect(actions).toEqual([{ type: 'tab/close', id: 'w1' }, { type: 'tab/close', id: 'w2' }, { type: 'archive/clear', keepSpaces: [home] }])
  })

  it('reaches every space when every profile is erased', () => {
    const actions = identityActions(state, ['default', 'travail'])
    expect(actions.filter((a) => a.type === 'tab/close')).toHaveLength(3)
    expect(actions.at(-1)).toEqual({ type: 'archive/clear', keepSpaces: [] })
  })
})
