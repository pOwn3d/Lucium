import { describe, expect, it } from 'vitest'
import { USED_PROFILES_MAX, cleanUsedProfiles, markUsed, missingProfileDialog, missingProfiles, revertMissing, spacesOf } from './profile-recovery'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `p${++n}` })() }
let state = createInitialState(ctx)
state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 10, profileName: 'Pro' }, ctx)
state = reduce(state, { type: 'space/create', name: 'Jeux', emoji: '🎮', hue: 20 }, ctx)
const pro = state.spaces[1]!.profileId

describe('markUsed and the profile/used action', () => {
  it('marks a profile once, never the default one or something that is not a profile id', () => {
    expect(markUsed([], 'work')).toEqual(['work'])
    const used = ['work']
    expect(markUsed(used, 'work')).toBe(used)
    expect(markUsed(used, 'default')).toBe(used)
    expect(markUsed(used, '../escape')).toBe(used)
    expect(markUsed(used, '')).toBe(used)
  })

  it('stops at the bound, and a state keeps the same object when nothing is marked', () => {
    const full = Array.from({ length: USED_PROFILES_MAX }, (_, i) => `p${i}`)
    expect(markUsed(full, 'one-more')).toBe(full)
    expect(reduce(state, { type: 'profile/used', id: 'default' }, ctx)).toBe(state)
    expect(reduce(state, { type: 'profile/used', id: pro }, ctx).settings.usedProfiles).toEqual([pro])
  })

  it('are cleaned when read from a saved file', () => {
    expect(cleanUsedProfiles(['work', 'work', 'default', 7, '../x', 'ok-2'])).toEqual(['work', 'ok-2'])
    expect(cleanUsedProfiles('nope')).toEqual([])
    expect(normalize({ ...state, settings: { ...state.settings, usedProfiles: ['a', 'a', 5] as unknown as string[] } }).settings.usedProfiles).toEqual(['a'])
  })
})

describe('missingProfiles', () => {
  const used = reduce(state, { type: 'profile/used', id: pro }, ctx)

  it('names a used profile that a space points at and whose storage is gone', () => {
    expect(missingProfiles(used, [])).toEqual([pro])
    expect(missingProfiles(used, [pro])).toEqual([])
  })

  it('does not call missing a profile that was never used (it has no folder yet), the default one, or one no space uses', () => {
    expect(missingProfiles(state, [])).toEqual([])
    const orphan = reduce(used, { type: 'space/delete', id: state.spaces[1]!.id }, ctx)
    expect(missingProfiles(orphan, [])).toEqual([])
  })
})

describe('revertMissing', () => {
  const used = reduce(state, { type: 'profile/used', id: pro }, ctx)

  it('puts the spaces of a lost profile back on the default profile and forgets the profile, leaving the others alone', () => {
    const next = reduce(used, { type: 'profile/revert-missing', ids: [pro] }, ctx)
    expect(next.spaces.map((s) => s.profileId)).toEqual(['default', 'default', 'default'])
    expect(next.settings.usedProfiles).toEqual([])
    expect(spacesOf(used, [pro]).map((s) => s.name)).toEqual(['Travail'])
  })

  it('drops the command bar ranking of a lost profile that has no name, and keeps the default one', () => {
    // A profile that has neither a name nor a setting exists only through its spaces: once they leave it, nothing else keeps its ranking.
    const bare = { ...state, spaces: state.spaces.map((sp, i) => (i === 1 ? { ...sp, profileId: 'lost' } : sp)), commandBarUsage: { lost: { 'url:https://a.example/': 1 }, default: { 'url:https://b.example/': 2 } } }
    expect(reduce(bare, { type: 'profile/revert-missing', ids: ['lost'] }, ctx).commandBarUsage).toEqual({ default: { 'url:https://b.example/': 2 } })
  })

  it('does nothing for a profile no space uses, or for ids that are not a list', () => {
    expect(revertMissing(state, ['nobody'])).toBe(state)
    expect(reduce(state, { type: 'profile/revert-missing', ids: 'x' as unknown as string[] }, ctx)).toBe(state)
  })
})

describe('missingProfileDialog', () => {
  it('lists the spaces, in the singular or the plural', () => {
    expect(missingProfileDialog([state.spaces[1]!]).detail).toContain('pour l’espace')
    expect(missingProfileDialog(state.spaces).detail).toContain('pour les espaces')
    expect(missingProfileDialog([state.spaces[1]!]).detail).toContain('💼 Travail')
    expect(missingProfileDialog([state.spaces[1]!])).toEqual({
      message: frenchSpaces('Profil manquant'),
      detail: frenchSpaces('Il semble qu’un ou plusieurs de vos profils soient introuvables sur cet ordinateur. Lucium utilise de nouveau votre profil par défaut pour l’espace :\n\n💼 Travail')
    })
  })

  it('says it in English with English chosen, the names of the spaces as they are', () => {
    setLanguage('en')
    try {
      const dialog = missingProfileDialog([state.spaces[1]!, state.spaces[2]!])
      expect(dialog.message).toBe('Missing profile')
      expect(dialog.detail).toBe('One or more of your profiles can’t be found on this computer. Lucium uses your default profile again for the Spaces:\n\n💼 Travail\n🎮 Jeux')
    } finally {
      setLanguage('fr')
    }
  })
})
