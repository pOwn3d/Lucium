// The "new space" sheet: everything it asks for, checked and turned into one `space/create` action.

import { knownProfiles, profileLabels, validateProfileName } from './profiles'
import type { Action } from './sidebar'
import type { SidebarState } from './model'
import { ICON_LETTER_MAX, LETTER_COLORS, cleanIconLetter, type SpaceIconChoice } from './space-icon'
import { normalizeWord, searchEmojis } from './space-emoji'
import { cleanTheme, themeFromHue, themeHue, withColorAt, type SpaceTheme } from './theme'

/** The value of the profile choice that means "a profile to create". */
export const NEW_PROFILE = '__new__'

/** What the sheet holds while it is open. */
export interface SpaceDraft {
  name: string
  /** The icon: an emoji, or coloured letters. (A picture needs a space to exist, so the sheet does not offer it.) */
  icon: SpaceIconChoice
  /** One of `NAMED_COLORS`, or null to keep the colour the space would get by default. */
  color: string | null
  /** A known profile id, or `NEW_PROFILE`. */
  profile: string
  /** The name of the profile to create (only read with `NEW_PROFILE`). */
  newProfileName: string
}

/** The icons a new space starts with, one after the other (all of them are in the sheet's row). */
const STARTER_EMOJIS = ['🚀', '🎨', '📚', '🛠️', '🌱', '🎧', '💡', '🧪']
export const defaultSpaceEmoji = (spaceCount: number): string => STARTER_EMOJIS[spaceCount % STARTER_EMOJIS.length]!

/** The hue spaces got before the sheet existed: each new space is a step further round the wheel. */
export const defaultSpaceHue = (spaceCount: number): number => (250 + spaceCount * 47) % 360

/** The sheet as it opens: no name, the next starting icon, the colour a fresh space would get, the default profile. */
export function newDraft(spaceCount: number): SpaceDraft {
  return { name: '', icon: { kind: 'emoji', emoji: defaultSpaceEmoji(spaceCount), letter: '', color: LETTER_COLORS[0]!, round: false }, color: null, profile: 'default', newProfileName: '' }
}

/** The theme a preset colour gives: the colour leads, and the complementary harmony of a fresh space follows it. */
export function presetTheme(color: string, fallbackHue = 250): SpaceTheme {
  const base = themeFromHue(fallbackHue)
  return cleanTheme({ ...base, ...withColorAt(base, 0, color) }, base)
}

/** The theme the sheet previews and the space will get. */
export const draftTheme = (draft: SpaceDraft, spaceCount: number): SpaceTheme =>
  draft.color ? presetTheme(draft.color, defaultSpaceHue(spaceCount)) : themeFromHue(defaultSpaceHue(spaceCount))

// ---------- the icons the name suggests ----------

/** Words (their beginnings), French and English, and the emoji they bring to mind, most likely first. The catalogue's own search adds to these, and the starters fill up. */
const NAME_HINTS: ReadonlyArray<readonly [stems: readonly string[], emoji: readonly string[]]> = [
  [['vacance', 'voyage', 'plage', 'ete', 'conge', 'vacation', 'holiday', 'travel', 'trip', 'beach', 'summer'], ['🏖️', '✈️', '🧳', '🌴']],
  [['client', 'travail', 'boulot', 'bureau', 'profession', 'job', 'work', 'office', 'business'], ['💼', '🏢', '📈', '🤝']],
  [['code', 'dev', 'projet', 'project', 'tech'], ['🧑‍💻', '💻', '🛠️', '🚀']],
  [['etude', 'cours', 'ecole', 'fac', 'universit', 'class', 'study', 'studies', 'school', 'learn'], ['📚', '🎓', '✏️', '🧠']],
  [['veille', 'lecture', 'news', 'actu', 'press', 'reading'], ['👀', '📰', '🔖', '📡']],
  [['perso', 'maison', 'famille', 'home', 'family', 'house'], ['🏡', '🪴', '❤️', '🧸']],
  [['musique', 'son', 'audio', 'music', 'sound'], ['🎧', '🎹', '🎸', '🎼']],
  [['sport', 'velo', 'course', 'foot', 'muscu', 'bike', 'running', 'gym', 'fitness'], ['🚴', '⚽', '🏋️', '🏃']],
  [['cuisine', 'recette', 'manger', 'repas', 'cook', 'recipe', 'kitchen', 'food', 'meal'], ['👨‍🍳', '🍳', '🥐', '🍝']],
  [['jeu', 'game', 'video', 'gaming'], ['🎮', '🕹️', '🎲', '🧩']]
]

/** How many emoji the sheet proposes. */
export const SUGGESTED_EMOJIS = 8

/** A word of the name is looked for in the catalogue only from this length on ("a" or "de" would find half of it). */
const WORD_MIN_CHARS = 3

/**
 * The emoji the sheet proposes for a name: the ones its words bring to mind ("vacances" gives 🏖️ ✈️ 🧳…), then what the catalogue finds for them, then the
 * starting icons. Eight, no repeats; a blank name gets the starting icons.
 */
export function suggestEmojis(name: string, limit = SUGGESTED_EMOJIS): string[] {
  return [...new Set([...emojiMatches(name), ...STARTER_EMOJIS])].slice(0, limit)
}

/** The emoji the words of a name bring to mind (the hints, then the catalogue's finds), best first; none for a name that says nothing. */
function emojiMatches(name: string): string[] {
  const words = normalizeWord(name).split(/[^a-z0-9]+/).filter((word) => word.length >= WORD_MIN_CHARS)
  const hinted = NAME_HINTS.filter(([stems]) => words.some((word) => stems.some((stem) => word.startsWith(stem)))).flatMap(([, emoji]) => emoji)
  const found = words.flatMap((word) => searchEmojis(word, 4).map((entry) => entry.emoji))
  return [...new Set([...hinted, ...found])]
}

/** The emoji row of the sheet: the suggestions, with the emoji that is chosen always in it (one picked from the whole catalogue replaces the last suggestion). */
export function suggestionRow(name: string, chosen: string): string[] {
  const list = suggestEmojis(name)
  return list.includes(chosen) ? list : [chosen, ...list.slice(0, SUGGESTED_EMOJIS - 1)]
}

/**
 * The emoji the sheet wears while the name is typed: it follows what the name brings to mind (typing "vacances" puts 🏖️ first) until a person has chosen an
 * icon, and never changes a choice. Among what the name brings to mind the current one stays, so that typing more of the same word does not make it jump; a
 * name that brings nothing to mind gives back the starting icon `fallback`.
 */
export function emojiForName(name: string, current: string, chosenByPerson: boolean, fallback: string): string {
  if (chosenByPerson) return current
  const matches = emojiMatches(name)
  if (matches.length === 0) return fallback
  return matches.includes(current) ? current : matches[0]!
}

// ---------- what the sheet checks ----------

/** The name of the space that already has this name (case and accents ignored), or null: a second "Travail" next to "travail" is not offered. */
export function spaceNameTaken(name: string, state: Pick<SidebarState, 'spaces'>): string | null {
  const wanted = normalizeWord(name.trim())
  if (wanted === '') return null
  return state.spaces.find((space) => normalizeWord(space.name.trim()) === wanted)?.name ?? null
}

/** Why the new profile name cannot be used, or null; null too while another profile is chosen. */
export function newProfileProblem(draft: SpaceDraft, state: SidebarState): string | null {
  return draft.profile === NEW_PROFILE ? validateProfileName(draft.newProfileName, profileLabels(state)) : null
}

/** What stops "Créer l'espace", the first thing to fix; the foot of the sheet says it. */
export type CreateBlock = 'name' | 'name-taken' | 'letters' | 'profile-name' | 'profile-problem' | 'profile-unknown'

export function createBlock(draft: SpaceDraft, state: SidebarState): CreateBlock | null {
  if (draft.name.trim() === '') return 'name'
  if (spaceNameTaken(draft.name, state) !== null) return 'name-taken'
  if (draft.icon.kind === 'letter' && cleanIconLetter(draft.icon.letter) === null) return 'letters'
  if (draft.profile === NEW_PROFILE) {
    if (draft.newProfileName.trim() === '') return 'profile-name'
    return newProfileProblem(draft, state) === null ? null : 'profile-problem'
  }
  return knownProfiles(state).includes(draft.profile) ? null : 'profile-unknown'
}

/** Whether "Créer l'espace" can be pressed: a free name, an icon that shows, and a usable profile. */
export const canCreateSpace = (draft: SpaceDraft, state: SidebarState): boolean => createBlock(draft, state) === null

/** The single action that creates the space with its icon, colours and profile; null while the sheet cannot be validated. */
export function spaceCreateAction(draft: SpaceDraft, state: SidebarState): Action | null {
  if (!canCreateSpace(draft, state)) return null
  const count = state.spaces.length
  const theme = draftTheme(draft, count)
  const letters = draft.icon.kind === 'letter' ? cleanIconLetter(draft.icon.letter) : null
  return {
    type: 'space/create',
    name: draft.name.trim(),
    emoji: draft.icon.emoji,
    hue: draft.color ? themeHue(theme) : defaultSpaceHue(count),
    ...(draft.color ? { theme } : {}),
    ...(letters !== null ? { letterIcon: { letter: letters.slice(0, ICON_LETTER_MAX), color: draft.icon.color, round: draft.icon.round } } : {}),
    ...(draft.profile === NEW_PROFILE ? { profileName: draft.newProfileName.trim() } : { profileId: draft.profile })
  }
}
