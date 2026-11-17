// The list of themes of the theme panel: the ready themes by light and dark, and "Mes thèmes". Pure: the panel draws what this returns.

import type { Space } from './model'
import { encodeThemeCode } from './theme-code'
import { READY_THEMES, readyThemePreview } from './theme-presets'
import type { SpaceTheme } from './theme'

export type ThemeGroupId = 'dark' | 'light' | 'mine'

export interface ThemeChoice {
  /** `ready:<id>` for a ready theme, `space:<id>` for the theme of a space of the user. */
  id: string
  name: string
  theme: SpaceTheme
  /** The pastille: the background of the theme and, in a corner, its accent (ready themes), or the first colours of the gradient. */
  swatch: string
  /** Shown under the name. */
  appearance: 'dark' | 'light' | 'auto'
}

export interface ThemeGroup {
  id: ThemeGroupId
  choices: ThemeChoice[]
}

const swatchOfColors = (colors: readonly string[]): string => `linear-gradient(135deg, ${colors[0] ?? '#808080'} 0 50%, ${colors[1] ?? colors[0] ?? '#808080'} 50% 100%)`

/**
 * The ready themes by their appearance, dark ones first, then "Mes thèmes": the themes of the user's other spaces that are not a ready theme and not
 * the same as another one listed (named after their space). Empty groups are left out, so that nothing shows a title over nothing.
 */
export function themeGroups(spaces: readonly Pick<Space, 'id' | 'name' | 'theme'>[], currentSpaceId: string): ThemeGroup[] {
  const ready = (appearance: 'dark' | 'light'): ThemeChoice[] =>
    READY_THEMES.filter((entry) => entry.theme.appearance === appearance).map((entry) => ({ id: `ready:${entry.id}`, name: entry.name, theme: entry.theme, swatch: readyThemePreview(entry), appearance }))
  const readyCodes = new Set(READY_THEMES.map((entry) => encodeThemeCode(entry.theme)))
  const seen = new Set<string>()
  const mine: ThemeChoice[] = []
  for (const space of spaces) {
    if (space.id === currentSpaceId) continue
    const code = encodeThemeCode(space.theme)
    if (readyCodes.has(code) || seen.has(code)) continue
    seen.add(code)
    mine.push({ id: `space:${space.id}`, name: space.name, theme: space.theme, swatch: swatchOfColors(space.theme.baseColors), appearance: space.theme.appearance })
  }
  return ([{ id: 'dark', choices: ready('dark') }, { id: 'light', choices: ready('light') }, { id: 'mine', choices: mine }] satisfies ThemeGroup[]).filter((group) => group.choices.length > 0)
}

/** Every choice in the order the panel lists them (the order the arrow keys walk). */
export const flatChoices = (groups: readonly ThemeGroup[]): ThemeChoice[] => groups.flatMap((group) => group.choices)

/** The theme the preview shows: the one under the pointer or the focus, else the theme of the space as it is now. */
export const previewedTheme = (hovered: ThemeChoice | null, current: SpaceTheme): SpaceTheme => hovered?.theme ?? current

/** Which choice is the theme of the space now (the same colours, texture and appearance), if it is one of them. */
export const currentChoice = (groups: readonly ThemeGroup[], theme: SpaceTheme): ThemeChoice | null => {
  const code = encodeThemeCode(theme)
  return flatChoices(groups).find((choice) => encodeThemeCode(choice.theme) === code) ?? null
}
