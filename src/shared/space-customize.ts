// "Personnaliser l'espace": what the panel remembers when it opens, whether anything has changed since, and the patch of "Rétablir" that puts it back.
// Every change the panel makes is applied at once (the sidebar behind it is the preview), so "Rétablir" is the way back, not a "Cancel".

import type { Appearance } from './theme'
import type { Space, SpaceIconKind } from './model'
import type { SpaceBackground } from './space-media'
import type { SpaceImageReply } from './space-image'
import { LETTER_COLORS, spaceIconKind } from './space-icon'
import { cleanTheme, type SpaceTheme } from './theme'
import { encodeThemeCode } from './theme-code'
import { t } from './i18n'
import { themeColorName } from './theme-colors'

/**
 * What "Rétablir" brings back: the name, the icon (its three parts and which one shows), the profile, the theme and the background (the picture
 * or the video behind the sidebar, with its veil and its text colour). A picture of the icon that was replaced or removed is a file that is gone:
 * it is not here.
 */
export interface CustomizeSnapshot {
  name: string
  emoji: string
  kind: SpaceIconKind
  iconLetter?: string
  iconColor?: string
  iconRound?: boolean
  profileId: string
  theme: SpaceTheme
  background?: SpaceBackground
}

export function snapshotOf(space: Space): CustomizeSnapshot {
  return {
    name: space.name,
    emoji: space.emoji,
    kind: spaceIconKind(space),
    ...(space.iconLetter !== undefined ? { iconLetter: space.iconLetter } : {}),
    ...(space.iconColor !== undefined ? { iconColor: space.iconColor } : {}),
    ...(space.iconRound !== undefined ? { iconRound: space.iconRound } : {}),
    profileId: space.profileId,
    theme: space.theme,
    ...(space.background !== undefined ? { background: space.background } : {})
  }
}

/** What of the icon a person can see: the emoji for an emoji, the letters with their colour and shape for letters, nothing more for a picture (a file is the picture). */
function shownIcon(snapshot: CustomizeSnapshot): string {
  if (snapshot.kind === 'emoji') return snapshot.emoji
  if (snapshot.kind === 'letter') return `${snapshot.iconLetter ?? ''}|${snapshot.iconColor ?? LETTER_COLORS[0]}|${snapshot.iconRound === true}`
  return ''
}

/**
 * Whether anything "Rétablir" would bring back is different now. Only what shows counts: letters that were chosen and then put aside for the emoji are kept
 * for later, but they are not a change. The theme is compared by its code (the same colours, texture and appearance).
 */
export function changedSince(original: CustomizeSnapshot, space: Space): boolean {
  const now = snapshotOf(space)
  return (
    now.name !== original.name ||
    now.kind !== original.kind ||
    shownIcon(now) !== shownIcon(original) ||
    now.profileId !== original.profileId ||
    encodeThemeCode(now.theme) !== encodeThemeCode(original.theme) ||
    JSON.stringify(now.background ?? null) !== JSON.stringify(original.background ?? null)
  )
}

/**
 * The patch of `space/update` that puts the space back as it was when the panel opened. The background is always in it: `undefined` takes away one
 * that was added to a space that had none.
 */
export function revertPatch(original: CustomizeSnapshot): Pick<Space, 'name' | 'emoji' | 'iconKind' | 'profileId'> & Partial<Pick<Space, 'iconLetter' | 'iconColor' | 'iconRound'>> & { theme: SpaceTheme; background: SpaceBackground | undefined } {
  return {
    name: original.name,
    emoji: original.emoji,
    iconKind: original.kind,
    ...(original.iconLetter !== undefined ? { iconLetter: original.iconLetter } : {}),
    ...(original.iconColor !== undefined ? { iconColor: original.iconColor } : {}),
    ...(original.iconRound !== undefined ? { iconRound: original.iconRound } : {}),
    profileId: original.profileId,
    theme: cleanTheme(original.theme),
    background: original.background
  }
}

/**
 * What to tell a person about a request for a picture (the main process makes the file): nothing when it worked or when they closed the dialog, the sentence
 * the main process gave when it refused, and `failure` when the request itself did not get through (the error goes to the log, with what was asked).
 */
export async function pictureNote(request: Promise<SpaceImageReply>, failure: string): Promise<string> {
  try {
    const reply = await request
    return reply.ok ? '' : reply.message
  } catch (error) {
    console.warn('[space image] the request failed:', error)
    return failure
  }
}

const APPEARANCE: Record<Appearance, () => string> = {
  auto: () => t('menu.automatique'),
  light: () => t('menu.clair'),
  dark: () => t('menu.sombre')
}

export const appearanceLabel = (appearance: Appearance): string => APPEARANCE[appearance]()

/** The line a collapsed section shows on its right: where the space stands. */
export const colorSummary = (theme: SpaceTheme): string => `${themeColorName(theme)} · ${appearanceLabel(theme.appearance).toLowerCase()}`

export const iconSummary = (kind: SpaceIconKind): string => (kind === 'letter' ? t('icon-picker.lettre') : kind === 'image' ? t('space-image-picker.image') : t('icon-picker.emoji'))

/** The names of the fixed colours of the veil and of the tab text (VEIL_COLORS, TEXT_COLORS), by their hex code. */
const SWATCH_NAMES: Readonly<Record<string, () => string>> = {
  '#0b0c12': () => t('space-media.swatch-black'),
  '#14213d': () => t('space-media.swatch-navy'),
  '#1e4fa3': () => t('space-media.swatch-blue'),
  '#5b6170': () => t('space-media.swatch-gray'),
  '#f4f4f6': () => t('space-media.swatch-light-gray'),
  '#f2ead8': () => t('space-media.swatch-cream'),
  '#ffffff': () => t('space-media.swatch-white')
}

/** What a screen reader says for a colour swatch: the name of the colour, where its code was spelled out character by character. An unknown colour keeps its code. */
export function swatchName(hex: string): string {
  return SWATCH_NAMES[hex.toLowerCase()]?.() ?? hex
}
