import { afterEach, describe, expect, it } from 'vitest'
import { profileNameInvalid, profileNameTaken } from './profiles'
import { setLanguage, tIn } from './i18n'
import { createInitialState, reduce, type Action } from './sidebar'
import { ALL_EMOJIS, isSpaceEmoji } from './space-emoji'
import { LETTER_COLORS, type SpaceIconChoice } from './space-icon'
import {
  NEW_PROFILE,
  SUGGESTED_EMOJIS,
  canCreateSpace,
  createBlock,
  defaultSpaceEmoji,
  defaultSpaceHue,
  draftTheme,
  emojiForName,
  newDraft,
  newProfileProblem,
  presetTheme,
  spaceCreateAction,
  spaceNameTaken,
  suggestEmojis,
  suggestionRow,
  type SpaceDraft
} from './space-creation'
import { NAMED_COLORS, namedColorOf, themeColorName } from './theme-colors'
import { isHex, themeFromHue, themeHue } from './theme'

afterEach(() => setLanguage('fr'))

const ctx = (): { now: number; newId: () => string } => {
  let n = 0
  return { now: 1, newId: () => `id${++n}` }
}
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx()), state)

const emoji = (value: string): SpaceIconChoice => ({ kind: 'emoji', emoji: value, letter: '', color: LETTER_COLORS[0]!, round: false })
const draft = (patch: Partial<SpaceDraft> = {}): SpaceDraft => ({ name: 'Projets', icon: emoji('🚀'), color: null, profile: 'default', newProfileName: '', ...patch })

describe('the new space sheet', () => {
  const state = () => createInitialState(ctx())

  it('cannot be validated without a name, and says that is why', () => {
    expect(canCreateSpace(draft({ name: '' }), state())).toBe(false)
    expect(canCreateSpace(draft({ name: '   ' }), state())).toBe(false)
    expect(createBlock(draft({ name: '  ' }), state())).toBe('name')
    expect(spaceCreateAction(draft({ name: '  ' }), state())).toBeNull()
    expect(canCreateSpace(draft(), state())).toBe(true)
    expect(createBlock(draft(), state())).toBeNull()
  })

  it('refuses a name another space already has, whatever its case and accents, and says so', () => {
    const s = state()
    const first = s.spaces[0]!.name
    expect(spaceNameTaken(first, s)).toBe(first)
    expect(spaceNameTaken(` ${first.toUpperCase()} `, s)).toBe(first)
    const accented = run(s, { type: 'space/create', name: 'Études', emoji: '📚', hue: 100 })
    expect(spaceNameTaken('etudes', accented)).toBe('Études')
    expect(spaceNameTaken('ÉTUDES', accented)).toBe('Études')
    expect(createBlock(draft({ name: 'etudes' }), accented)).toBe('name-taken')
    expect(spaceCreateAction(draft({ name: 'etudes' }), accented)).toBeNull()
    expect(spaceNameTaken('Études 2', accented)).toBeNull()
    expect(spaceNameTaken('   ', accented)).toBeNull()
  })

  it('needs letters for a letter icon', () => {
    const letters = (letter: string): SpaceIconChoice => ({ kind: 'letter', emoji: '🚀', letter, color: LETTER_COLORS[2]!, round: true })
    expect(createBlock(draft({ icon: letters('') }), state())).toBe('letters')
    expect(createBlock(draft({ icon: letters('😀') }), state())).toBe('letters')
    expect(createBlock(draft({ icon: letters('ac') }), state())).toBeNull()
  })

  it('needs a valid, free name for a new profile, and says why not', () => {
    const s = run(state(), { type: 'settings/update', patch: { profileNames: { work: 'Travail' } } })
    const asks = (newProfileName: string) => draft({ profile: NEW_PROFILE, newProfileName })
    expect(canCreateSpace(asks(''), s)).toBe(false)
    expect(createBlock(asks(''), s)).toBe('profile-name')
    expect(newProfileProblem(asks('  '), s)).toBe(profileNameInvalid())
    expect(newProfileProblem(asks('travail'), s)).toBe(profileNameTaken())
    expect(createBlock(asks('travail'), s)).toBe('profile-problem')
    expect(spaceCreateAction(asks('travail'), s)).toBeNull()
    expect(canCreateSpace(asks('Clients'), s)).toBe(true)
  })

  it('does not check the new profile name while another profile is chosen', () => {
    expect(newProfileProblem(draft({ profile: 'default', newProfileName: '' }), state())).toBeNull()
  })

  it('refuses a profile that is not known', () => {
    expect(createBlock(draft({ profile: 'ghost' }), state())).toBe('profile-unknown')
    expect(canCreateSpace(draft({ profile: 'ghost' }), state())).toBe(false)
  })

  it('opens with no name, the next starting icon and the default profile', () => {
    expect(newDraft(0)).toMatchObject({ name: '', color: null, profile: 'default', newProfileName: '' })
    expect(newDraft(3).icon).toMatchObject({ kind: 'emoji', emoji: defaultSpaceEmoji(3) })
    expect(canCreateSpace(newDraft(1), state())).toBe(false)
  })
})

describe('the icons the name suggests', () => {
  it('proposes eight icons, the ones a word brings to mind first: "vacances" gives 🏖️ ✈️ 🧳', () => {
    const list = suggestEmojis('vacances')
    expect(list).toHaveLength(SUGGESTED_EMOJIS)
    expect(list.slice(0, 3)).toEqual(['🏖️', '✈️', '🧳'])
    expect(suggestEmojis('Mes Vacances 2026').slice(0, 3)).toEqual(['🏖️', '✈️', '🧳'])
    expect(suggestEmojis('code').slice(0, 2)).toEqual(['🧑‍💻', '💻'])
  })

  it('knows the English words too: the English help says « try “vacation” », and the example of a name is « Vacation »', () => {
    expect(tIn('en', 'space-create.icones-proposees')).toContain('“vacation”')
    expect(suggestEmojis('vacation').slice(0, 3)).toEqual(['🏖️', '✈️', '🧳'])
    expect(suggestEmojis('Vacation').slice(0, 3)).toEqual(suggestEmojis('Vacances').slice(0, 3))
    expect(suggestEmojis('Holiday trip').slice(0, 3)).toEqual(['🏖️', '✈️', '🧳'])
    expect(suggestEmojis('Work')[0]).toBe('💼')
    expect(suggestEmojis('School')[0]).toBe('📚')
    expect(suggestEmojis('Family')[0]).toBe('🏡')
    expect(suggestEmojis('Recipes')[0]).toBe('👨‍🍳')
  })

  it('matches the beginning of a word, accents and case ignored, and not a letter inside a longer word', () => {
    expect(suggestEmojis('ÉTUDES')[0]).toBe('📚')
    expect(suggestEmojis('Travail')[0]).toBe('💼')
    expect(suggestEmojis('projets perso').slice(0, 2)).toEqual(['🧑‍💻', '💻'])
    // "ete" is a stem, "tête" is not a word that starts with it.
    expect(suggestEmojis('tête')[0]).not.toBe('🏖️')
  })

  it('adds what the catalogue finds for the words, then the starting icons, with no repeats', () => {
    const list = suggestEmojis('fusée')
    expect(list[0]).toBe('🚀')
    expect(new Set(list).size).toBe(list.length)
    expect(list).toHaveLength(SUGGESTED_EMOJIS)
  })

  it('gives the starting icons for a blank name, and for words too short to mean anything', () => {
    const starters = suggestEmojis('')
    expect(starters).toHaveLength(SUGGESTED_EMOJIS)
    expect(starters[0]).toBe(defaultSpaceEmoji(0))
    expect(suggestEmojis('  a  de ')).toEqual(starters)
  })

  it('only ever proposes icons that a space can wear', () => {
    for (const name of ['', 'vacances', 'client', 'code', 'études', 'veille', 'perso', 'musique', 'sport', 'cuisine', 'jeu', 'cat', 'zzz']) {
      for (const emoji of suggestEmojis(name)) expect(isSpaceEmoji(emoji), `${name}: ${emoji}`).toBe(true)
    }
    for (const [, emoji] of [[0, '🏖️'], [1, '🧑‍💻'], [2, '👨‍🍳']] as const) expect(ALL_EMOJIS.some((entry) => entry.emoji === emoji) || isSpaceEmoji(emoji)).toBe(true)
  })

  it('follows the name until a person chooses an icon, and never moves a choice', () => {
    expect(emojiForName('vacances', '🚀', false, '🚀')).toBe('🏖️')
    expect(emojiForName('vacances', '🦄', true, '🚀')).toBe('🦄')
    // Typing more of the same word does not make the icon jump: the current one is still something the name brings to mind.
    expect(emojiForName('vacances d’été', '🏖️', false, '🚀')).toBe('🏖️')
    expect(emojiForName('vacances d’été', '✈️', false, '🚀')).toBe('✈️')
    // A name that says nothing gives back the starting icon, so that deleting the name undoes what it suggested.
    expect(emojiForName('', '🏖️', false, '🚀')).toBe('🚀')
    expect(emojiForName('qxqxq', '🏖️', false, '🎨')).toBe('🎨')
  })

  it('always shows the icon that is chosen, even one picked from the whole catalogue', () => {
    expect(suggestionRow('vacances', '🏖️')).toEqual(suggestEmojis('vacances'))
    const row = suggestionRow('vacances', '🦄')
    expect(row[0]).toBe('🦄')
    expect(row).toHaveLength(SUGGESTED_EMOJIS)
    expect(new Set(row).size).toBe(row.length)
  })
})

describe('the theme of the sheet', () => {
  it('follows the named colour: it leads the gradient', () => {
    for (const { hex } of NAMED_COLORS) {
      const theme = presetTheme(hex)
      expect(theme.baseColors[0]).toBe(hex)
      expect(theme.baseColors.every(isHex)).toBe(true)
    }
  })

  it('keeps the colour a fresh space would get while no colour is chosen', () => {
    expect(draftTheme(draft(), 3)).toEqual(themeFromHue(defaultSpaceHue(3)))
    expect(draftTheme(draft({ color: NAMED_COLORS[3]!.hex }), 3)).not.toEqual(draftTheme(draft(), 3))
    expect(defaultSpaceHue(0)).toBe(250)
    expect(defaultSpaceHue(1)).toBe(297)
    expect(defaultSpaceHue(2)).toBe(344)
    expect(defaultSpaceHue(3)).toBe(31)
  })
})

describe('the named colours', () => {
  it('are ten, each with its own colour and its own name in both languages', () => {
    expect(NAMED_COLORS).toHaveLength(10)
    expect(new Set(NAMED_COLORS.map((color) => color.hex)).size).toBe(10)
    expect(NAMED_COLORS.every((color) => isHex(color.hex))).toBe(true)
    const french = NAMED_COLORS.map((color) => color.name())
    setLanguage('en')
    const english = NAMED_COLORS.map((color) => color.name())
    expect(new Set(french).size).toBe(10)
    expect(french).toContain('Bleu')
    expect(english).toContain('Blue')
    expect(english).not.toContain('Bleu')
  })

  it('name the colour that leads a theme, and say "Personnalisée" for any other', () => {
    expect(themeColorName(presetTheme('#4b6bd6'))).toBe('Bleu')
    expect(namedColorOf('#4B6BD6')?.id).toBe('blue')
    expect(themeColorName(presetTheme('#123456'))).toBe('Personnalisée')
    expect(namedColorOf(undefined)).toBeNull()
  })
})

describe('creating a space from the sheet, end to end', () => {
  const state = () => createInitialState(ctx())

  it('makes one space with its name, icon, named colours and the chosen profile, and selects it', () => {
    const s = run(state(), { type: 'settings/update', patch: { profileNames: { work: 'Travail' } } })
    const color = NAMED_COLORS[3]!.hex
    const action = spaceCreateAction(draft({ name: ' Projets ', icon: emoji('🎨'), color, profile: 'work' }), s)
    expect(action).not.toBeNull()
    const next = run(s, action!)
    expect(next.spaces).toHaveLength(2)
    const made = next.spaces[1]!
    expect(made).toMatchObject({ name: 'Projets', emoji: '🎨', profileId: 'work' })
    expect(made.iconKind).toBeUndefined()
    expect(made.theme.baseColors[0]).toBe(color)
    expect(next.activeSpaceId).toBe(made.id)
  })

  it('makes a space that wears coloured letters when the icon is letters, keeping the emoji as the second choice', () => {
    const s = state()
    const icon: SpaceIconChoice = { kind: 'letter', emoji: '🚀', letter: 'ac', color: LETTER_COLORS[3]!, round: true }
    const made = run(s, spaceCreateAction(draft({ name: 'Client ACME', icon }), s)!).spaces[1]!
    expect(made).toMatchObject({ name: 'Client ACME', emoji: '🚀', iconKind: 'letter', iconLetter: 'AC', iconColor: LETTER_COLORS[3], iconRound: true })
  })

  it('creates the new profile in the same action', () => {
    const s = state()
    const action = spaceCreateAction(draft({ profile: NEW_PROFILE, newProfileName: 'Clients' }), s)
    const next = run(s, action!)
    expect(next.spaces[1]!.profileId).toBe('clients')
    expect(next.settings.profileNames['clients']).toBe('Clients')
  })

  it('keeps the default colour of the next space when no colour is chosen', () => {
    const s = state()
    const next = run(s, spaceCreateAction(draft(), s)!)
    expect(themeHue(next.spaces[1]!.theme)).toBe(themeHue(run(s, { type: 'space/create', name: 'x', emoji: 'x', hue: defaultSpaceHue(1) }).spaces[1]!.theme))
  })

  it('does not put a space in the wrong profile if the profile cannot be had', () => {
    const s = run(state(), { type: 'settings/update', patch: { profileNames: { work: 'Travail' } } })
    // The sheet checked the name, but the state moved on: the reducer still refuses, so nothing is created.
    const action = spaceCreateAction(draft({ profile: NEW_PROFILE, newProfileName: 'Clients' }), s)!
    const taken = run(s, { type: 'settings/update', patch: { profileNames: { work: 'Travail', other: 'Clients' } } })
    expect(run(taken, action)).toBe(taken)
  })
})

describe('what a new space starts with', () => {
  it('takes its icon from a short rotation that wraps around', () => {
    expect(defaultSpaceEmoji(0)).toBe('🚀')
    expect(defaultSpaceEmoji(1)).toBe('🎨')
    expect(defaultSpaceEmoji(8)).toBe('🚀')
  })
})
