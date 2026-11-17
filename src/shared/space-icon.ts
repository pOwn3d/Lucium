// What stands for a space (the unified picker): its emoji, a coloured letter, or a picture. Pure rules shared by the state cleaner, the reducer,
// the sidebar and the picker; nothing here reads a file or the DOM.
//
// A space keeps all three at once: choosing a letter does not forget the emoji, and switching back to the emoji does not delete the picture. `iconKind`
// says which one shows. Spaces saved before the choice existed have no `iconKind`: the picture shows if they have one, else the emoji.

import type { Space, SpaceIconKind } from './model'
import { isSpaceImageName } from './space-image'

export const SPACE_ICON_KINDS: readonly SpaceIconKind[] = ['emoji', 'letter', 'image']

export const isSpaceIconKind = (value: unknown): value is SpaceIconKind => typeof value === 'string' && (SPACE_ICON_KINDS as readonly string[]).includes(value)

/** The most letters an icon holds: "AC" fits the square of the sidebar, three do not. */
export const ICON_LETTER_MAX = 2

/** The colours a letter can sit on (the picker offers these; any `#rrggbb` is accepted when it comes from a file). Dark enough for white letters. */
export const LETTER_COLORS: readonly string[] = ['#4b6bd6', '#c43c3c', '#b3600f', '#1a7f48', '#8a5bd1', '#177a8f', '#c2428f', '#2b2f4a']

const HEX6 = /^#[0-9a-f]{6}$/i
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]\p{M}*$/u

const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)

/**
 * The letters of a letter icon: the first two letters or digits of what was typed, in capitals. Spaces, punctuation, emoji and control characters
 * are dropped (an emoji has its own tab). Null when nothing is left.
 */
export function cleanIconLetter(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const kept = graphemes(value.normalize('NFC').slice(0, 64).toUpperCase()).filter((part) => LETTER_OR_DIGIT.test(part))
  return kept.length > 0 ? kept.slice(0, ICON_LETTER_MAX).join('') : null
}

/** The colour behind the letters: a `#rrggbb` code, lower case. Null for anything else (it ends up in a style, so nothing else gets through). */
export function cleanIconColor(value: unknown): string | null {
  return typeof value === 'string' && HEX6.test(value) ? value.toLowerCase() : null
}

/** The letters a space would start with: the first letter of its first two words ("Client ACME" gives "CA", "Travail" gives "T"). */
export function initialsOf(name: string): string {
  const firsts = name.split(/[\s\-_.]+/u).map((word) => graphemes(cleanIconLetter(word) ?? '')[0] ?? '')
  return firsts.filter((letter) => letter !== '').slice(0, ICON_LETTER_MAX).join('')
}

type IconFields = Pick<Space, 'iconKind' | 'iconLetter' | 'image'>

/** Which icon shows for a space. A kind whose data is missing (a letter kind without letters) falls back to what is there. */
export function spaceIconKind(space: IconFields): SpaceIconKind {
  const kind = space.iconKind
  if (kind === 'letter' && cleanIconLetter(space.iconLetter) !== null) return 'letter'
  if (kind === 'image' && isSpaceImageName(space.image)) return 'image'
  if (kind === 'emoji') return 'emoji'
  // No choice recorded (an older file), or one that cannot be honoured: the picture was the only thing that ever replaced the emoji.
  return isSpaceImageName(space.image) ? 'image' : 'emoji'
}

/** The colour of the letter icon of a space, and its shape. */
export function letterStyle(space: Pick<Space, 'iconColor' | 'iconRound'>): { color: string; round: boolean } {
  return { color: cleanIconColor(space.iconColor) ?? LETTER_COLORS[0]!, round: space.iconRound === true }
}

/** The glyph of a space in plain text (a menu, a list that cannot draw a picture): its letters, or its emoji. A picture shows as the emoji. */
export function spaceGlyph(space: Pick<Space, 'emoji' | 'iconKind' | 'iconLetter' | 'image'>): string {
  return spaceIconKind(space) === 'letter' ? (cleanIconLetter(space.iconLetter) ?? space.emoji) : space.emoji
}

/** What the picker works on: the three choices side by side. */
export interface SpaceIconChoice {
  kind: SpaceIconKind
  emoji: string
  letter: string
  color: string
  round: boolean
}

/** The choice a space has now (the picker opens on it). */
export function choiceOf(space: Pick<Space, 'name' | 'emoji' | 'iconKind' | 'iconLetter' | 'iconColor' | 'iconRound' | 'image'>): SpaceIconChoice {
  const { color, round } = letterStyle(space)
  return { kind: spaceIconKind(space), emoji: space.emoji, letter: cleanIconLetter(space.iconLetter) ?? initialsOf(space.name), color, round }
}

/** The choice of a picker that offers the emoji alone (the icon of a folder): `emoji` is empty while nothing is chosen, the letters and the shape stay at their defaults. */
export const emojiOnlyChoice = (emoji: string): SpaceIconChoice => ({ kind: 'emoji', emoji, letter: '', color: LETTER_COLORS[0]!, round: false })

/**
 * The patch of `space/update` that makes the space wear a choice. Only what the choice is about travels: an emoji changes the emoji, letters change the letters
 * with their colour and shape, a picture changes the kind. What the space kept for the others (the letters it had, the emoji it had) is not overwritten by a
 * default the picker made up (the letters it proposes from the name).
 */
export function choicePatch(choice: SpaceIconChoice): Partial<Pick<Space, 'emoji' | 'iconKind' | 'iconLetter' | 'iconColor' | 'iconRound'>> {
  if (choice.kind === 'image') return { iconKind: 'image' }
  if (choice.kind === 'emoji') return { emoji: choice.emoji, iconKind: 'emoji' }
  const letter = cleanIconLetter(choice.letter)
  // Letters that are not letters cannot be worn: the space keeps its emoji rather than an empty icon.
  if (letter === null) return { iconKind: 'emoji' }
  return { iconKind: 'letter', iconLetter: letter, iconColor: cleanIconColor(choice.color) ?? LETTER_COLORS[0]!, iconRound: choice.round }
}

/** The recent emoji the picker lists first: newest first, no repeats, at most this many. */
export const RECENT_EMOJIS_MAX = 8

export function rememberEmoji(recent: readonly string[], emoji: string): string[] {
  return [emoji, ...recent.filter((other) => other !== emoji)].slice(0, RECENT_EMOJIS_MAX)
}

/**
 * The recent emoji read back from where the picker keeps them (a JSON list of strings). A list that cannot be read starts again empty, and says so in the
 * log; a value that is not an emoji is dropped, so that nothing the storage holds reaches the grid or a space.
 */
export function readRecentEmojis(raw: string | null, isEmoji: (value: unknown) => boolean): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn('[space icon] the list of recent emoji cannot be read, it starts again empty:', error)
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of parsed) {
    if (typeof value !== 'string' || !isEmoji(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length === RECENT_EMOJIS_MAX) break
  }
  return out
}

/** The kind ⌘1, ⌘2 and ⌘3 switch the picker to, or null for any other key. */
export function pickerModeOfKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): SpaceIconKind | null {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return null
  return event.key === '1' ? 'emoji' : event.key === '2' ? 'letter' : event.key === '3' ? 'image' : null
}
