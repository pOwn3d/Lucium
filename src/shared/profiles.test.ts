import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { setLanguage } from './i18n'
import {
  PROFILE_NAME_LIMIT, profileNameInvalid, profileNameTaken, archiveDelayLabel, archiveDelayNotice, archiveDelayPatch, cleanProfileOverrides, isProfileId, knownProfiles, newProfileId, planProfileCreation,
  cleanDisabledExtensions, profileArchiveHours, profileDownloadDir, profileLabel, profileLabels, profileOfSpace, profileRecordsHistory, profileSearch, profilesFollowingDefault, spaceOfProfile, validateProfileName, withExtensionEnabled, withExtensionTabCapture
} from './profiles'
import { PROFILE_NAME_MAX, createInitialState, normalize, reduce, type Action } from './sidebar'
import { frenchSpaces } from './french-typography'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('what a profile uses', () => {
  const settings = { ...defaultSettings(), searchUrlTemplate: 'https://default.example/?q=%s', searchSuggestions: true, autoArchiveHours: 12 }

  it('falls back to the top-level settings when a profile has no override', () => {
    expect(profileSearch(settings, 'work')).toEqual({ url: 'https://default.example/?q=%s', suggestions: true })
    expect(profileArchiveHours(settings, 'work')).toBe(12)
    expect(profileDownloadDir(settings, 'work')).toBeUndefined()
  })

  it('prefers the override, including a "never" (0) and a switched-off suggestion', () => {
    const own = { ...settings, profiles: { work: { searchUrlTemplate: 'https://work.example/?q=%s', searchSuggestions: false, autoArchiveHours: 0, downloadDir: '/tmp/work' } } }
    expect(profileSearch(own, 'work')).toEqual({ url: 'https://work.example/?q=%s', suggestions: false })
    expect(profileArchiveHours(own, 'work')).toBe(0)
    expect(profileDownloadDir(own, 'work')).toBe('/tmp/work')
    expect(profileArchiveHours(own, 'other')).toBe(12)
  })

  it('finds the profile of a space, and uses the default one for a space that is gone', () => {
    const state = run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileId: 'work' })
    expect(profileOfSpace(state, state.spaces[1]!.id)).toBe('work')
    expect(profileOfSpace(state, 'nope')).toBe('default')
  })
})

describe('cleanProfileOverrides', () => {
  it('keeps valid overrides and drops the rest', () => {
    expect(
      cleanProfileOverrides({
        work: { searchUrlTemplate: 'https://a.example/?q=%s', searchSuggestions: false, autoArchiveHours: 6, downloadDir: '/Users/x/Pro' },
        'bad id!': { autoArchiveHours: 1 },
        broken: { searchUrlTemplate: 'javascript:alert(%s)', autoArchiveHours: -4, downloadDir: 'relative/path', searchSuggestions: 'yes' },
        nothing: {},
        text: 'oops'
      })
    ).toEqual({ work: { searchUrlTemplate: 'https://a.example/?q=%s', searchSuggestions: false, autoArchiveHours: 6, downloadDir: '/Users/x/Pro' } })
  })

  it('refuses a search address without a place for the query, and a NaN delay', () => {
    expect(cleanProfileOverrides({ a: { searchUrlTemplate: 'https://a.example/' } })).toEqual({})
    expect(cleanProfileOverrides({ a: { autoArchiveHours: Number.NaN } })).toEqual({})
  })

  it('returns nothing for something that is not a record', () => {
    for (const bad of [null, undefined, 'x', 3, []]) expect(cleanProfileOverrides(bad)).toEqual({})
  })
})

describe('migration of the old per-profile archive delay', () => {
  it('folds autoArchiveHoursByProfile into the overrides and drops the old field', () => {
    const base = createInitialState(ctx)
    const old = { ...base, settings: { ...base.settings, autoArchiveHoursByProfile: { work: 6 }, profiles: undefined as never } }
    const migrated = normalize(old as never)
    expect(migrated.settings.profiles).toEqual({ work: { autoArchiveHours: 6 } })
    expect('autoArchiveHoursByProfile' in migrated.settings).toBe(false)
  })

  it('keeps the other overrides of a profile when folding', () => {
    const base = createInitialState(ctx)
    const old = { ...base, settings: { ...base.settings, autoArchiveHoursByProfile: { work: 6 }, profiles: { work: { searchSuggestions: false } } } }
    expect(normalize(old as never).settings.profiles).toEqual({ work: { searchSuggestions: false, autoArchiveHours: 6 } })
  })
})

describe('knownProfiles', () => {
  it('lists the default profile, the ones spaces use and the ones created without a space', () => {
    let state = run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileId: 'work' })
    state = run(state, { type: 'settings/update', patch: { profileNames: { empty: 'Vide' }, profiles: { tuned: { autoArchiveHours: 1 } } } })
    expect(knownProfiles(state)).toEqual(['default', 'work', 'empty', 'tuned'])
  })
})

describe('newProfileId', () => {
  it('makes a plain id from a name, without accents or symbols', () => {
    expect(newProfileId('Travail & Co', [])).toBe('travail-co')
    expect(newProfileId('  École d’été ', [])).toBe('ecole-d-ete')
  })

  it('numbers an id that is taken, and never returns an empty one', () => {
    expect(newProfileId('Travail', ['travail', 'travail-2'])).toBe('travail-3')
    expect(newProfileId('???', [])).toBe('profil')
  })

  it('keeps the id within what a profile id may be', () => {
    const id = newProfileId('x'.repeat(100), [])
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(newProfileId('y'.repeat(100), ['y'.repeat(28)])).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})

describe('validateProfileName', () => {
  it('accepts a plain name and one that differs from the existing ones', () => {
    expect(validateProfileName('Travail', ['Profil par défaut', 'Perso'])).toBeNull()
    expect(validateProfileName('  École d’été ', [])).toBeNull()
  })

  it('refuses an empty name, one that is only spaces, one with control characters and one that is too long', () => {
    for (const bad of ['', '   ', 'a\tb', 'x'.repeat(PROFILE_NAME_LIMIT + 1)]) expect(validateProfileName(bad, [])).toBe(profileNameInvalid())
    expect(validateProfileName('x'.repeat(PROFILE_NAME_LIMIT), [])).toBeNull()
  })

  it('refuses a name that is taken, whatever its case or spacing', () => {
    expect(validateProfileName('travail', ['Travail'])).toBe(profileNameTaken())
    expect(validateProfileName('  Travail   Co ', ['travail co'])).toBe(profileNameTaken())
    expect(validateProfileName('École', ['Ecole'])).toBeNull()
  })

  it('reports an invalid name before a taken one', () => {
    expect(validateProfileName('', [''])).toBe(profileNameInvalid())
  })

  it('uses the same limit as the names the state keeps', () => {
    expect(PROFILE_NAME_LIMIT).toBe(PROFILE_NAME_MAX)
  })
})

describe('profile names in the state', () => {
  const state = () => {
    let s = run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileId: 'work' })
    s = run(s, { type: 'settings/update', patch: { profileNames: { work: 'Travail' } } })
    return s
  }

  it('names the default profile, a renamed one and an unnamed one', () => {
    const s = state()
    expect(profileLabel(s.settings, 'default')).toBe('Profil par défaut')
    expect(profileLabel(s.settings, 'work')).toBe('Travail')
    expect(profileLabel(s.settings, 'raw-id')).toBe('raw-id')
  })

  it('lists every name, leaving out the profile being renamed', () => {
    expect(profileLabels(state())).toEqual(['Profil par défaut', 'Travail'])
    expect(profileLabels(state(), 'work')).toEqual(['Profil par défaut'])
  })

  it('knows which ids are safe storage names', () => {
    expect(isProfileId('work-2_a')).toBe(true)
    for (const bad of ['', 'a b', '../x', 'x'.repeat(33), 3, null]) expect(isProfileId(bad)).toBe(false)
  })
})

describe('planProfileCreation', () => {
  const state = () => run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10 })

  it('names the profile, then moves the chosen spaces to it', () => {
    const s = state()
    const [first, second] = s.spaces
    const plan = planProfileCreation(s, ' Clients ', [first!.id, second!.id])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.id).toBe('clients')
    const next = run(s, ...plan.actions)
    expect(next.settings.profileNames['clients']).toBe('Clients')
    expect(next.spaces.map((sp) => sp.profileId)).toEqual(['clients', 'clients'])
    expect(knownProfiles(next)).toContain('clients')
  })

  it('never gives a profile the id of the private window: « Private » is another profile, from the panel and from a new space', () => {
    const s = state()
    const plan = planProfileCreation(s, 'Private', [])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.id).toBe('private-2')
    expect(planProfileCreation(s, 'Privé', []).ok && planProfileCreation(s, 'Privé', [])).toMatchObject({ id: 'prive' })
    const spaced = run(s, { type: 'space/create', name: 'Perso', emoji: '🔒', hue: 10, profileName: 'PRIVATE' })
    expect(spaced.spaces.at(-1)!.profileId).toBe('private-2')
    expect(spaced.settings.profileNames).toEqual({ 'private-2': 'PRIVATE' })
  })

  it('creates an empty profile when no space is chosen', () => {
    const s = state()
    const plan = planProfileCreation(s, 'Vide', [])
    if (!plan.ok) throw new Error(plan.error)
    const next = run(s, ...plan.actions)
    expect(next.spaces.map((sp) => sp.profileId)).toEqual(['default', 'default'])
    expect(knownProfiles(next)).toContain('vide')
  })

  it('ignores a space that does not exist', () => {
    const plan = planProfileCreation(state(), 'Autre', ['nope'])
    expect(plan.ok && plan.actions).toHaveLength(1)
  })

  it('refuses an invalid or duplicate name with its message and plans nothing', () => {
    const s = state()
    expect(planProfileCreation(s, '  ', [])).toEqual({ ok: false, error: profileNameInvalid() })
    expect(planProfileCreation(s, 'profil PAR défaut', [])).toEqual({ ok: false, error: profileNameTaken() })
  })

  it('gives an id that no other profile has even when two names look alike', () => {
    let s = state()
    const first = planProfileCreation(s, 'Travail!', [])
    if (!first.ok) throw new Error(first.error)
    s = run(s, ...first.actions)
    const second = planProfileCreation(s, 'Travail?', [])
    if (!second.ok) throw new Error(second.error)
    expect(second.id).not.toBe(first.id)
  })
})

describe('applying an archive delay to all profiles or to one', () => {
  // Default: 12 h. "work" follows it, "calm" has its own 7 days and a search setting, "solo" only its own 6 h, "free" follows it too.
  const state = () => {
    let s = run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileId: 'work' })
    s = run(s, { type: 'settings/update', patch: { autoArchiveHours: 12, profileNames: { free: 'Libre', solo: 'Seul' }, profiles: { calm: { autoArchiveHours: 168, searchSuggestions: false }, solo: { autoArchiveHours: 6 } } } })
    return s
  }
  const hoursOf = (s: ReturnType<typeof state>) => Object.fromEntries(knownProfiles(s).map((id) => [id, profileArchiveHours(s.settings, id)]))

  it('finds the profiles that follow the default one', () => {
    expect(profilesFollowingDefault(state())).toEqual(['work', 'free'])
  })

  it('"all" gives every profile the new delay and drops their own, keeping their other settings', () => {
    const s = state()
    const next = run(s, { type: 'settings/update', patch: archiveDelayPatch(s, 6, 'all') })
    expect(hoursOf(next)).toEqual({ default: 6, work: 6, calm: 6, solo: 6, free: 6 })
    expect(next.settings.profiles).toEqual({ calm: { searchSuggestions: false } })
    // The patch itself carries no empty override for the profiles that only had a delay.
    expect(archiveDelayPatch(s, 6, 'all').profiles).toEqual({ calm: { searchSuggestions: false } })
  })

  it('"only" changes the default profile and keeps what the others use now', () => {
    const s = state()
    const next = run(s, { type: 'settings/update', patch: archiveDelayPatch(s, 0, 'only') })
    expect(hoursOf(next)).toEqual({ default: 0, work: 12, calm: 168, solo: 6, free: 12 })
    expect(next.settings.profiles['calm']).toEqual({ autoArchiveHours: 168, searchSuggestions: false })
  })

  it('does not touch the state it is given', () => {
    const s = state()
    const before = JSON.stringify(s.settings)
    archiveDelayPatch(s, 6, 'only')
    archiveDelayPatch(s, 6, 'all')
    expect(JSON.stringify(s.settings)).toBe(before)
  })

  it('has nothing to keep when no profile follows the default one', () => {
    const s = createInitialState(ctx)
    expect(archiveDelayPatch(s, 24, 'only')).toEqual({ autoArchiveHours: 24, profiles: {} })
  })
})

describe('archive delay wording', () => {
  it('speaks in hours below a day and in days from a day', () => {
    expect(archiveDelayLabel(1)).toBe('1 heure')
    expect(archiveDelayLabel(6)).toBe('6 heures')
    expect(archiveDelayLabel(24)).toBe('1 jour')
    expect(archiveDelayLabel(168)).toBe('7 jours')
    expect(archiveDelayLabel(30)).toBe('30 heures')
  })

  it('says when tabs will never be archived, and for which profile when it is not all of them', () => {
    expect(archiveDelayNotice(12)).toBe('Lucium archivera désormais vos onglets après 12 heures sans être ouverts.')
    expect(archiveDelayNotice(0)).toBe('Lucium n’archivera jamais vos onglets automatiquement.')
    expect(archiveDelayNotice(24, 'Travail')).toBe(frenchSpaces('Lucium archivera désormais les onglets du profil « Travail » après 1 jour sans être ouverts.'))
  })

  it('says it in English, with the English plural', () => {
    try {
      setLanguage('en')
      expect(archiveDelayNotice(12)).toBe('Lucium will now archive your tabs after 12 hours without being opened.')
      expect(archiveDelayNotice(1)).toBe('Lucium will now archive your tabs after 1 hour without being opened.')
      expect(archiveDelayNotice(168, 'Travail')).toBe('Lucium will now archive the tabs of the profile “Travail” after 7 days without being opened.')
      expect(archiveDelayNotice(0)).toBe('Lucium will never archive your tabs automatically.')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('spaceOfProfile', () => {
  it('opens in the space the user is in when it is of the profile, else in the first space of that profile, else nowhere', () => {
    let state = run(createInitialState(ctx), { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileId: 'work' }, { type: 'space/create', name: 'Pro 2', emoji: '💼', hue: 20, profileId: 'work' })
    const [home, pro1, pro2] = state.spaces.map((sp) => sp.id)
    state = { ...state, activeSpaceId: home! }
    expect(spaceOfProfile(state, 'default')).toBe(home)
    expect(spaceOfProfile(state, 'work')).toBe(pro1)
    expect(spaceOfProfile({ ...state, activeSpaceId: pro2! }, 'work')).toBe(pro2)
    expect(spaceOfProfile({ ...state, activeSpaceId: pro2! }, 'default')).toBe(home)
    expect(spaceOfProfile(state, 'ghost')).toBeUndefined()
  })
})

describe('the extensions switched off in a profile', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)
  const ids = [A, B]

  it('switches an extension off and on for one profile, leaving the other profiles and the other overrides as they are', () => {
    const profiles = { work: { autoArchiveHours: 2 }, home: { disabledExtensions: [B] } }
    const off = withExtensionEnabled(profiles, 'work', A, false)
    expect(off).toEqual({ work: { autoArchiveHours: 2, disabledExtensions: [A] }, home: { disabledExtensions: [B] } })
    expect(withExtensionEnabled(off, 'work', A, true)).toEqual(profiles)
    // The last switched-off extension takes the profile's entry with it when nothing else is in it.
    expect(withExtensionEnabled({ home: { disabledExtensions: [B] } }, 'home', B, true)).toEqual({})
  })

  it('returns the same object when nothing changes, and when the profile or the extension is not well formed', () => {
    const profiles = { work: { disabledExtensions: [A] } }
    expect(withExtensionEnabled(profiles, 'work', A, false)).toBe(profiles)
    expect(withExtensionEnabled(profiles, 'work', B, true)).toBe(profiles)
    for (const [profile, extension] of [['__proto__', A], ['a/b', A], ['', A], ['work', 'nope'], ['work', 'A'.repeat(32)], ['work', `${A}x`]] as const) {
      expect(withExtensionEnabled(profiles, profile, extension, false), `${profile} ${extension}`).toBe(profiles)
    }
  })

  it('keeps well-formed ids only, once each, and no more than the limit', () => {
    expect(cleanDisabledExtensions([A, A, 'x', 3, null, B])).toEqual(ids)
    expect(cleanDisabledExtensions('abc')).toEqual([])
    const many = Array.from({ length: 300 }, (_, i) => `${'a'.repeat(30)}${String.fromCharCode(97 + (i % 16))}${String.fromCharCode(97 + Math.floor(i / 16) % 16)}`)
    expect(cleanDisabledExtensions(many)).toHaveLength(200)
  })

  it('goes through the reducer as an action of the interface, which a bad id does not change', () => {
    const state = createInitialState(ctx)
    const off = run(state, { type: 'extension/set-enabled', profileId: 'work', extensionId: A, enabled: false })
    expect(off.settings.profiles).toEqual({ work: { disabledExtensions: [A] } })
    expect(run(off, { type: 'extension/set-enabled', profileId: 'work', extensionId: A, enabled: true }).settings.profiles).toEqual({})
    expect(run(state, { type: 'extension/set-enabled', profileId: '__proto__', extensionId: A, enabled: false })).toBe(state)
    expect(run(state, { type: 'extension/set-enabled', profileId: 'work', extensionId: 'nope', enabled: false })).toBe(state)
    // Only a real `true` switches an extension on: a value of another kind from the interface is a no.
    expect(run(off, { type: 'extension/set-enabled', profileId: 'work', extensionId: A, enabled: 'yes' as unknown as boolean })).toBe(off)
  })
})

describe('the extensions allowed to capture the sound of a tab in a profile', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)

  it('allows an extension and takes the permission back, for one profile, leaving the other profiles and the other overrides as they are', () => {
    const profiles = { work: { autoArchiveHours: 2 }, home: { tabCaptureExtensions: [B] } }
    const on = withExtensionTabCapture(profiles, 'work', A, true)
    expect(on).toEqual({ work: { autoArchiveHours: 2, tabCaptureExtensions: [A] }, home: { tabCaptureExtensions: [B] } })
    expect(withExtensionTabCapture(on, 'work', A, false)).toEqual(profiles)
    // The last extension allowed takes the profile's entry with it when nothing else is in it.
    expect(withExtensionTabCapture({ home: { tabCaptureExtensions: [B] } }, 'home', B, false)).toEqual({})
  })

  it('keeps the list of the extensions switched off apart from it', () => {
    const profiles = { work: { disabledExtensions: [A] } }
    const on = withExtensionTabCapture(profiles, 'work', A, true)
    expect(on).toEqual({ work: { disabledExtensions: [A], tabCaptureExtensions: [A] } })
    expect(withExtensionEnabled(on, 'work', A, true)).toEqual({ work: { tabCaptureExtensions: [A] } })
  })

  it('returns the same object when nothing changes, and when the profile or the extension is not well formed', () => {
    const profiles = { work: { tabCaptureExtensions: [A] } }
    expect(withExtensionTabCapture(profiles, 'work', A, true)).toBe(profiles)
    expect(withExtensionTabCapture(profiles, 'work', B, false)).toBe(profiles)
    for (const [profile, extension] of [['__proto__', A], ['a/b', A], ['', A], ['work', 'nope'], ['work', 'A'.repeat(32)], ['work', `${A}x`]] as const) {
      expect(withExtensionTabCapture(profiles, profile, extension, true), `${profile} ${extension}`).toBe(profiles)
    }
  })

  it('holds no more than the limit of extensions in a profile', () => {
    const many = Array.from({ length: 200 }, (_, i) => `${'a'.repeat(30)}${String.fromCharCode(97 + (i % 16))}${String.fromCharCode(97 + Math.floor(i / 16) % 16)}`)
    const full = { work: { tabCaptureExtensions: many } }
    expect(withExtensionTabCapture(full, 'work', B, true).work?.tabCaptureExtensions).toHaveLength(200)
  })

  it('is read from a saved file as well-formed ids only, once each', () => {
    expect(cleanProfileOverrides({ work: { tabCaptureExtensions: [A, A, 'x', 3, null, B] }, home: { tabCaptureExtensions: 'abc' }, calm: { tabCaptureExtensions: [] } })).toEqual({ work: { tabCaptureExtensions: [A, B] } })
  })

  it('goes through the reducer as an action of the interface, which a bad id does not change, and which only a real `true` allows', () => {
    const state = createInitialState(ctx)
    const on = run(state, { type: 'extension/set-tab-capture', profileId: 'work', extensionId: A, allowed: true })
    expect(on.settings.profiles).toEqual({ work: { tabCaptureExtensions: [A] } })
    expect(run(on, { type: 'extension/set-tab-capture', profileId: 'work', extensionId: A, allowed: false }).settings.profiles).toEqual({})
    expect(run(state, { type: 'extension/set-tab-capture', profileId: '__proto__', extensionId: A, allowed: true })).toBe(state)
    expect(run(state, { type: 'extension/set-tab-capture', profileId: 'work', extensionId: 'nope', allowed: true })).toBe(state)
    expect(run(state, { type: 'extension/set-tab-capture', profileId: 'work', extensionId: A, allowed: 'yes' as unknown as boolean })).toBe(state)
  })
})

describe('the history of a profile', () => {
  it('follows the global setting unless the profile says otherwise', () => {
    const base = { ...defaultSettings(), profiles: cleanProfileOverrides({ work: { historyOff: true }, calm: { historyOff: false } }) }
    expect(profileRecordsHistory(base, 'default')).toBe(true)
    expect(profileRecordsHistory(base, 'work')).toBe(false)
    expect(profileRecordsHistory({ ...base, historyOff: true }, 'default')).toBe(false)
    expect(profileRecordsHistory({ ...base, historyOff: true }, 'calm')).toBe(true)
    expect(profileRecordsHistory({ ...base, historyOff: true }, 'unknown')).toBe(false)
  })

  it('keeps only a real boolean of a file', () => {
    expect(cleanProfileOverrides({ work: { historyOff: 'yes' } })).toEqual({})
    expect(cleanProfileOverrides({ work: { historyOff: true } })).toEqual({ work: { historyOff: true } })
  })
})
