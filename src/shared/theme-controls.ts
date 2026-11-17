// What the controls of the theme panel change: each returns the patch of `space/update`'s `theme` that the control stands for. Pure: the panel
// sends the patch, the main process saves it, and `cleanTheme` has the last word.

import { hexToHsl, hslToHex, withColorAt, type Overlay, type SpaceTheme } from './theme'

/** How much texture a space gets when a texture is chosen and it had none: visible, not heavy. */
export const DEFAULT_TEXTURE_AMOUNT = 0.5

/** The texture select. A texture chosen on a theme with no amount of it would show nothing, so it comes with a visible amount; "Aucune" keeps the amount for later. */
export function overlayPatch(theme: Pick<SpaceTheme, 'noise'>, overlay: Overlay): Partial<SpaceTheme> {
  return overlay === 'none' || theme.noise > 0 ? { overlay } : { overlay, noise: DEFAULT_TEXTURE_AMOUNT }
}

/** The amount of texture: more than none on a theme without texture switches the grain on (an amount of nothing would show nothing). */
export function noisePatch(theme: Pick<SpaceTheme, 'overlay'>, noise: number): Partial<SpaceTheme> {
  return theme.overlay === 'none' && noise > 0 ? { noise, overlay: 'grain' } : { noise }
}

/** The lowest saturation the hue slider gives a colour: a grey has no hue to move, and the slider must show something. */
export const HUE_MIN_SATURATION = 0.35

/** The hue of the first colour, moved to `hue` (0..359) with its saturation (at least `HUE_MIN_SATURATION`) and its lightness. Null when the theme has no colour to move. */
export function huePatch(theme: SpaceTheme, hue: number): Pick<SpaceTheme, 'baseColors'> | null {
  const first = theme.baseColors[0]
  if (!first || !Number.isFinite(hue)) return null
  const { s, l } = hexToHsl(first)
  return withColorAt(theme, 0, hslToHex({ h: ((Math.round(hue) % 360) + 360) % 360, s: Math.max(HUE_MIN_SATURATION, s), l }))
}

/** The hue the slider shows for a theme: that of its first colour. */
export const hueOfTheme = (theme: SpaceTheme): number => Math.round(hexToHsl(theme.baseColors[0] ?? '#6666ff').h) % 360
