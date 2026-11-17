// The ten named colours a space starts from (R4 and the new space sheet): each has a name a person can say ("Bleu"), a colour that leads the theme,
// and nothing else. A colour that is not one of them is "Personnalisée".

import { t } from './i18n'
import type { SpaceTheme } from './theme'

export interface NamedColor {
  readonly id: string
  /** The colour that leads the theme: the first of its base colours. */
  readonly hex: string
  /** The name, in the language of the interface (read when asked: the language can change). */
  readonly name: () => string
}

export const NAMED_COLORS: readonly NamedColor[] = [
  { id: 'sand', hex: '#ece7df', name: () => t('theme-colors.sable') },
  { id: 'pink', hex: '#f4a7bb', name: () => t('theme-colors.rose') },
  { id: 'lavender', hex: '#b48bc9', name: () => t('theme-colors.lavande') },
  { id: 'coral', hex: '#e05d5d', name: () => t('theme-colors.corail') },
  { id: 'orange', hex: '#f39c4a', name: () => t('theme-colors.orange') },
  { id: 'yellow', hex: '#f3c84a', name: () => t('theme-colors.jaune') },
  { id: 'green', hex: '#5fbe72', name: () => t('theme-colors.vert') },
  { id: 'turquoise', hex: '#4ab7c9', name: () => t('theme-colors.turquoise') },
  { id: 'blue', hex: '#4b6bd6', name: () => t('theme-colors.bleu') },
  { id: 'night', hex: '#2b2f4a', name: () => t('theme-colors.nuit') }
]

/** The named colour a hex code is exactly, or null. */
export const namedColorOf = (hex: string | undefined): NamedColor | null => NAMED_COLORS.find((color) => color.hex === hex?.toLowerCase()) ?? null

/** The name of the colour that leads a theme: "Bleu", or "Personnalisée" when it is none of the ten. */
export const themeColorName = (theme: Pick<SpaceTheme, 'baseColors'>): string => namedColorOf(theme.baseColors[0])?.name() ?? t('theme-colors.personnalisee')
