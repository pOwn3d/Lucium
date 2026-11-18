// Space themes. The model: a blended gradient of base colours
// chosen on a colour wheel with a harmony rule, an intensity, a texture overlay with a noise amount, a
// translucency style, vibrancy and an appearance. All colours are sRGB hex strings.

import { clamp, clampOr } from './clamp'

export type Harmony = 'complementary' | 'analogous' | 'triadic' | 'monochrome' | 'custom'
export type Overlay = 'none' | 'grain' | 'fine' | 'coarse'
export type Appearance = 'auto' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'

export interface SpaceTheme {
  /** 1 to 3 colours of the gradient, in order. With a harmony other than `custom`, the first one drives the others. */
  baseColors: string[]
  harmony: Harmony
  /** Gradient direction in degrees (the dial). */
  angle: number
  /** How strongly the colours show, 0..1 (imported from `intensityFactor`). */
  intensity: number
  overlay: Overlay
  /** Amount of texture, 0..1 (imported from `noiseFactor`). */
  noise: number
  translucency: 'light' | 'dark'
  vibrant: boolean
  appearance: Appearance
}

export const HARMONIES: readonly Harmony[] = ['complementary', 'analogous', 'triadic', 'monochrome', 'custom']
export const OVERLAYS: readonly Overlay[] = ['none', 'grain', 'fine', 'coarse']
export const MAX_THEME_COLORS = 3

// ---------- colour maths ----------

export interface Rgb { r: number; g: number; b: number } // 0..255
export interface Hsl { h: number; s: number; l: number } // h 0..360, s and l 0..1

const HEX = /^#[0-9a-f]{6}$/i

export const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return { h: (h * 60 + 360) % 360, s, l }
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 }
}

export const hexToHsl = (hex: string): Hsl => rgbToHsl(hexToRgb(hex))
export const hslToHex = (hsl: Hsl): string => rgbToHex(hslToRgb(hsl))

/** Linear mix of two colours: 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, amount: number): string {
  const [ca, cb] = [hexToRgb(a), hexToRgb(b)]
  const t = clamp(amount, 0, 1)
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t })
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const withAlpha = (hex: string, alpha: number) => `${hex}${Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, '0')}`

// ---------- harmony ----------

/** Colours the harmony derives from the primary one: the primary first, then up to two companions. */
export function harmonize(primary: string, harmony: Harmony, count: number): string[] {
  const hsl = hexToHsl(primary)
  const turn = (deg: number, dl = 0): string => hslToHex({ ...hsl, h: hsl.h + deg, l: clamp(hsl.l + dl, 0.08, 0.92) })
  const companions: Record<Exclude<Harmony, 'custom'>, string[]> = {
    complementary: [turn(180), turn(180, 0.12)],
    analogous: [turn(35), turn(-35)],
    triadic: [turn(120), turn(240)],
    monochrome: [turn(0, 0.2), turn(0, -0.2)]
  }
  const rest = harmony === 'custom' ? [] : companions[harmony]
  return [primary, ...rest].slice(0, clamp(count, 1, MAX_THEME_COLORS))
}

// ---------- the theme ----------

export function defaultTheme(): SpaceTheme {
  return themeFromHue(250)
}

/** A theme built from a single hue: how spaces were themed before the colour wheel. */
export function themeFromHue(hue: number, saturation = 0.55): SpaceTheme {
  const primary = hslToHex({ h: ((hue % 360) + 360) % 360, s: clamp(saturation, 0.1, 0.95), l: 0.5 })
  return { baseColors: harmonize(primary, 'complementary', 2), harmony: 'complementary', angle: 155, intensity: 1, overlay: 'grain', noise: 0, translucency: 'light', vibrant: true, appearance: 'auto' }
}

/** The hue of the first colour: used for accents (buttons, focus rings). */
export function themeHue(theme: SpaceTheme): number {
  return Math.round(hexToHsl(theme.baseColors[0] ?? '#6666ff').h)
}

/** Repairs anything a saved or imported theme could get wrong, so rendering never has to check. */
export function cleanTheme(input: Partial<SpaceTheme> | null | undefined, fallback: SpaceTheme = defaultTheme()): SpaceTheme {
  const colors = (Array.isArray(input?.baseColors) ? input.baseColors : []).filter(isHex).slice(0, MAX_THEME_COLORS)
  const harmony = HARMONIES.includes(input?.harmony as Harmony) ? (input!.harmony as Harmony) : fallback.harmony
  const baseColors = colors.length > 0 ? colors : fallback.baseColors
  return {
    // A derived harmony always follows its primary colour, so saved companions can never drift out of it.
    baseColors: harmony === 'custom' ? baseColors : harmonize(baseColors[0]!, harmony, baseColors.length),
    harmony,
    angle: clampOr(input?.angle, 0, 360, fallback.angle),
    intensity: clampOr(input?.intensity, 0, 1, fallback.intensity),
    overlay: OVERLAYS.includes(input?.overlay as Overlay) ? (input!.overlay as Overlay) : fallback.overlay,
    noise: clampOr(input?.noise, 0, 1, fallback.noise),
    translucency: input?.translucency === 'dark' ? 'dark' : 'light',
    vibrant: typeof input?.vibrant === 'boolean' ? input.vibrant : fallback.vibrant,
    appearance: input?.appearance === 'light' || input?.appearance === 'dark' || input?.appearance === 'auto' ? input.appearance : fallback.appearance
  }
}

export const resolveAppearance = (theme: SpaceTheme, systemDark: boolean): ResolvedAppearance =>
  theme.appearance === 'auto' ? (systemDark ? 'dark' : 'light') : theme.appearance

// ---------- the two appearances of the settings (Lucium's, and the one asked of the websites) ----------

/**
 * What `nativeTheme.themeSource` is for the appearance of Lucium (`interfaceAppearance`): « Automatique » is the system's. That property is global in Electron: it
 * turns every window of the application and every page, so it belongs to the setting of Lucium alone, never to the one asked of the websites (`pageSchemeOf`).
 */
export const themeSourceOf = (interfaceAppearance: unknown): 'system' | 'light' | 'dark' => (interfaceAppearance === 'light' || interfaceAppearance === 'dark' ? interfaceAppearance : 'system')

/** What the web pages are asked to read of `prefers-color-scheme` for the setting `websiteAppearance`: null for « Automatique » (they follow Lucium, as ever). */
export const pageSchemeOf = (websiteAppearance: unknown): 'light' | 'dark' | null => (websiteAppearance === 'light' || websiteAppearance === 'dark' ? websiteAppearance : null)

// ---------- editing (what the colour wheel does) ----------
// Each helper returns a patch for `space/update`; `cleanTheme` then re-derives anything a harmony decides.

/** How many colours each harmony shows by default (a complementary pair, an analogous or triadic trio...). */
const HARMONY_COLORS: Record<Exclude<Harmony, 'custom'>, number> = { complementary: 2, analogous: 3, triadic: 3, monochrome: 2 }

/** Picks a harmony: the colours follow the primary one, except `custom` which keeps what is there. */
export function withHarmony(theme: SpaceTheme, harmony: Harmony): Pick<SpaceTheme, 'harmony' | 'baseColors'> {
  const primary = theme.baseColors[0]!
  return { harmony, baseColors: harmony === 'custom' ? theme.baseColors : harmonize(primary, harmony, HARMONY_COLORS[harmony]) }
}

/** Adds (+) or removes (-) a colour, one to three in all. */
export function withColorCount(theme: SpaceTheme, count: number): Pick<SpaceTheme, 'baseColors'> {
  const wanted = clamp(Math.round(count), 1, MAX_THEME_COLORS)
  const colors = theme.baseColors
  if (theme.harmony !== 'custom') return { baseColors: harmonize(colors[0]!, theme.harmony, wanted) }
  if (wanted <= colors.length) return { baseColors: colors.slice(0, wanted) }
  const last = hexToHsl(colors[colors.length - 1]!)
  const added = Array.from({ length: wanted - colors.length }, (_, i) => hslToHex({ ...last, h: last.h + 60 * (i + 1) }))
  return { baseColors: [...colors, ...added] }
}

/**
 * Moves one dot of the wheel. With a derived harmony only the primary colour is free (the others follow it);
 * dragging a companion would be lost on the next clean-up, so it is refused.
 */
export function withColorAt(theme: SpaceTheme, index: number, hex: string): Pick<SpaceTheme, 'baseColors'> | null {
  if (!isHex(hex) || index < 0 || index >= theme.baseColors.length) return null
  if (theme.harmony !== 'custom' && index !== 0) return null
  const colors = [...theme.baseColors]
  colors[index] = hex.toLowerCase()
  return { baseColors: theme.harmony === 'custom' ? colors : harmonize(hex.toLowerCase(), theme.harmony, colors.length) }
}

/** The next texture when the user cycles through them. */
export const nextOverlay = (overlay: Overlay): Overlay => OVERLAYS[(OVERLAYS.indexOf(overlay) + 1) % OVERLAYS.length]!

/** Lightness at the top and bottom of the colour pad: the pad runs from light (top) to dark (bottom). */
const PAD_TOP_L = 0.86
const PAD_BOTTOM_L = 0.14

/**
 * The colour pad of the theme editor (a square: hue along x, light at the top and dark at the bottom). Both functions take
 * and give positions as fractions of the pad, 0..1 from the top-left corner.
 */
export function colorAtPadPoint(x: number, y: number, saturation: number): string {
  const px = clamp(x, 0, 1)
  const py = clamp(y, 0, 1)
  return hslToHex({ h: px * 360, s: clamp(saturation, 0.05, 1), l: PAD_TOP_L - py * (PAD_TOP_L - PAD_BOTTOM_L) })
}

/** Where a colour sits on the pad: the inverse of `colorAtPadPoint` for hue and lightness (saturation is not shown). */
export function padPointOf(hex: string): { x: number; y: number } {
  const { h, l } = hexToHsl(hex)
  return { x: clamp((((h % 360) + 360) % 360) / 360, 0, 1), y: clamp((PAD_TOP_L - l) / (PAD_TOP_L - PAD_BOTTOM_L), 0, 1) }
}

// ---------- rendering ----------

const DARK_BASE = '#0d0d12'
const LIGHT_BASE = '#f2f2f6'

/** What a colour looks like as part of the window background: shaded in dark mode, tinted in light mode. */
function toBackground(color: string, theme: SpaceTheme, appearance: ResolvedAppearance): string {
  const hsl = hexToHsl(color)
  const boosted = theme.vibrant ? hslToHex({ ...hsl, s: clamp(hsl.s * 1.1, 0, 1) }) : color
  const toned = appearance === 'dark' ? mix(boosted, '#000000', 0.62) : mix(boosted, '#ffffff', 0.62)
  // Intensity fades the colour into a neutral base: 0 is plain, 1 is the full colour.
  return mix(appearance === 'dark' ? DARK_BASE : LIGHT_BASE, toned, theme.intensity)
}

export function backgroundColors(theme: SpaceTheme, appearance: ResolvedAppearance): string[] {
  const colors = theme.baseColors.length > 1 ? theme.baseColors : [theme.baseColors[0]!, theme.baseColors[0]!]
  return colors.map((c) => toBackground(c, theme, appearance))
}

const NOISE_FREQUENCY: Record<Exclude<Overlay, 'none'>, number> = { fine: 1.4, grain: 0.9, coarse: 0.45 }

/** An SVG noise tile as a data URI, or null when the texture is off. */
export function noiseImage(overlay: Overlay): string | null {
  if (overlay === 'none') return null
  // Black and white specks over a transparent tile: the raw noise is mid-grey, which a blend over a dark background hides (the texture then shows nothing).
  // The specks are white where the noise is high and black where it is low, and opaque where it is far from the middle: they show on a dark and on a light theme.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n' color-interpolation-filters='sRGB'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='${NOISE_FREQUENCY[overlay]}' numOctaves='2' stitchTiles='stitch'/>` +
    `<feColorMatrix type='matrix' values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0'/>` +
    `<feComponentTransfer><feFuncR type='discrete' tableValues='0 1'/><feFuncG type='discrete' tableValues='0 1'/><feFuncB type='discrete' tableValues='0 1'/>` +
    `<feFuncA type='table' tableValues='0.6 0 0.6'/></feComponentTransfer></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`
  return `url("data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}")`
}

/**
 * The ink of the text written on the background of a space, as tokens.css gives it (`--text-on-space`, and the opacity of `--text-on-space-2`,
 * the secondary text), and the plain ink it gives way to on a background where it does not read. theme.test.ts keeps the first two equal to the
 * stylesheet.
 */
export const SPACE_INK: Record<ResolvedAppearance, { soft: string; plain: string; secondary: number }> = {
  light: { soft: '#1a1d2b', plain: '#000000', secondary: 0.74 },
  dark: { soft: '#f1f2f6', plain: '#ffffff', secondary: 0.7 }
}
/** The glyphs of a quiet header written on the space (the mini window): half the ink, raised to 3:1 where that is not enough. */
const SPACE_GLYPH_OPACITY = 0.5
/**
 * The strongest wash a control at rest lays over the background of a space, under a text: a tile (7 % in light, 9 % in dark), the field of the
 * mini window (8 %), the layout bar of a split view (10 %). The colour is the one of the tiles of tokens.css (theme.test.ts keeps them equal).
 */
export const SPACE_WASH: Record<ResolvedAppearance, { color: string; amount: number }> = {
  light: { color: '#141828', amount: 0.1 },
  dark: { color: '#ffffff', amount: 0.1 }
}
/**
 * What a row lays over the background of a space while the pointer is on it (`--tile-hover` of tokens.css), and the opacity the secondary
 * text starts from there (`--text-on-tile-hover-2`). The wash is stronger than a tile at rest, so the title of a sleeping tab, written in the
 * secondary text, needs an ink of its own under the pointer. theme.test.ts keeps both equal to the stylesheet.
 */
export const SPACE_HOVER: Record<ResolvedAppearance, { color: string; amount: number; secondary: number }> = {
  light: { color: '#141828', amount: 0.11, secondary: 0.78 },
  dark: { color: '#ffffff', amount: 0.14, secondary: 0.8 }
}

/**
 * The inks of a space, measured on the colours its theme really paints. A person chooses any colour for a space (ten named ones, the pad, a
 * code, an import): the secondary text of the tokens reads at 4.5:1 on most of them and not on all (« Sable » and « Jaune » in the dark
 * appearance, the top and the bottom of the pad), and on fewer still once a tile is laid under it. So its opacity is raised just enough for
 * 4.5:1 on both ends of the gradient: once for the text written on the bare background (`secondary`), once for the text written on a tile
 * (`onTile`, which a tile makes a little harder to read); the glyphs are held at 3:1 on both. The ink itself becomes plain black or white on
 * the few backgrounds where the soft one cannot reach 4.5:1. A theme that already reads keeps the values of the tokens, to the digit.
 */
export function spaceInks(theme: SpaceTheme, appearance: ResolvedAppearance): { text: string; secondary: string; onTile: string; onHover: string; onHoverText: string; glyph: string } {
  const { soft, plain, secondary } = SPACE_INK[appearance]
  const wash = SPACE_WASH[appearance]
  const bare = backgroundColors(theme, appearance)
  const washed = bare.map((color) => mix(color, wash.color, wash.amount))
  const grounds = [...bare, ...washed]
  const text = grounds.every((ground) => contrastOf(soft, ground) >= BAR_TEXT_CONTRAST + BAR_CONTRAST_MARGIN) ? soft : plain
  const { r, g, b } = hexToRgb(text)
  const inked = (on: readonly string[], designed: number, needed: number): string => `rgb(${r} ${g} ${b} / ${Math.max(...on.map((ground) => inkOpacity(text, ground, designed, needed)))})`
  return {
    text,
    secondary: inked(bare, secondary, BAR_TEXT_CONTRAST),
    onTile: inked(grounds, secondary, BAR_TEXT_CONTRAST),
    onHover: hoverInk(bare, appearance),
    onHoverText: hoverText(bare, appearance, text),
    glyph: inked(grounds, SPACE_GLYPH_OPACITY, BAR_GLYPH_CONTRAST)
  }
}

/** Both ends of the gradient of a space once the wash of a row under the pointer is laid over them. */
const hoverGrounds = (bare: readonly string[], appearance: ResolvedAppearance): string[] => bare.map((color) => mix(color, SPACE_HOVER[appearance].color, SPACE_HOVER[appearance].amount))
/** Whether an ink reads at 4.5:1 on every one of these grounds, with the margin the engine's rounding costs. */
const readsOn = (grounds: readonly string[]) => (ink: string): boolean => grounds.every((ground) => contrastOf(ink, ground) >= BAR_TEXT_CONTRAST + BAR_CONTRAST_MARGIN)

/**
 * The secondary text of a row under the pointer, on the colours of a space: 4.5:1 on both ends of the gradient once the hover wash is laid.
 * The wash takes more contrast than a tile does, so the soft ink can fall short where it reads at rest: the plain one is then taken for this
 * text alone, and the text of the rest of the space keeps its ink. On a mid grey that the wash brings to the middle (white chosen for a
 * space, in the dark appearance) neither reads, and the plain ink of the other appearance does.
 */
function hoverInk(bare: readonly string[], appearance: ResolvedAppearance): string {
  const { soft, plain } = SPACE_INK[appearance]
  const hover = SPACE_HOVER[appearance]
  const grounds = hoverGrounds(bare, appearance)
  const ink = [soft, plain].find(readsOn(grounds)) ?? SPACE_INK[appearance === 'dark' ? 'light' : 'dark'].plain
  const { r, g, b } = hexToRgb(ink)
  return `rgb(${r} ${g} ${b} / ${Math.max(...grounds.map((ground) => inkOpacity(ink, ground, hover.secondary, BAR_TEXT_CONTRAST)))})`
}

/**
 * The text of a row under the pointer (the title of an awake tab), on the colours of a space: the text of the space wherever it still reads at
 * 4.5:1 once the hover wash is laid, which is most themes; else the plain ink, a step brighter or darker (« Sable » in the dark appearance gave
 * 4.46:1 with the soft one); else, on the grey the wash brings to the middle, the plain ink of the other appearance. The ground is not changed,
 * and the text of the row at rest keeps its ink.
 */
function hoverText(bare: readonly string[], appearance: ResolvedAppearance, text: string): string {
  return [text, SPACE_INK[appearance].plain].find(readsOn(hoverGrounds(bare, appearance))) ?? SPACE_INK[appearance === 'dark' ? 'light' : 'dark'].plain
}

/** CSS custom properties the sidebar UI is styled with. */
export function themeVars(theme: SpaceTheme, appearance: ResolvedAppearance): Record<string, string> {
  const colors = backgroundColors(theme, appearance)
  const dark = appearance === 'dark'
  const noise = noiseImage(theme.overlay)
  const inks = spaceInks(theme, appearance)
  return {
    '--bg-gradient': `linear-gradient(${Math.round(theme.angle)}deg, ${colors.join(', ')})`,
    '--hue': String(themeHue(theme)),
    '--text': dark ? '#f1f1f5' : '#1c1c22',
    // The text written on the space itself (the sidebar, the empty page, the mini window): the roles of tokens.css, measured on this theme.
    '--text-on-space': inks.text,
    '--text-on-space-2': inks.secondary,
    '--text-on-tile-2': inks.onTile,
    '--text-on-tile-hover-2': inks.onHover,
    '--text-on-tile-hover': inks.onHoverText,
    '--glyph-on-space': inks.glyph,
    '--muted': inks.secondary,
    '--hover': dark ? 'rgb(255 255 255 / 0.10)' : 'rgb(0 0 0 / 0.07)',
    '--active': dark ? 'rgb(255 255 255 / 0.195)' : 'rgb(0 0 0 / 0.13)',
    '--grain-image': noise ?? 'none',
    // Texture shows through at most 45 % so text stays readable.
    '--grain-opacity': String(noise ? +(theme.noise * 0.45).toFixed(3) : 0)
  }
}

/**
 * What web pages are given when they may read the theme data: the palette as CSS variables.
 * The names are the `--arc-palette-*` ones that existing pages and Tweaks read, so they keep working.
 */
export function pagePaletteVars(theme: SpaceTheme, appearance: ResolvedAppearance): Record<string, string> {
  const [c0, c1] = backgroundColors(theme, appearance)
  const dark = appearance === 'dark'
  const base = c0!
  const foreground = luminance(base) > 0.4 ? '#101014' : '#f5f5f8'
  return {
    '--arc-palette-title': foreground,
    '--arc-palette-subtitle': mix(foreground, base, 0.3),
    '--arc-palette-background': base,
    '--arc-palette-backgroundExtra': c1!,
    '--arc-palette-focus': withAlpha(mix(base, foreground, 0.55), 0.8),
    '--arc-palette-hover': withAlpha(foreground, dark ? 0.1 : 0.08),
    '--arc-palette-foregroundPrimary': foreground,
    '--arc-palette-foregroundSecondary': mix(foreground, base, 0.35),
    '--arc-palette-foregroundTertiary': mix(foreground, base, 0.6),
    '--arc-palette-cutoutColor': mix(base, dark ? '#000000' : '#ffffff', 0.4),
    '--arc-palette-maxContrastColor': dark ? '#ffffff' : '#000000',
    '--arc-palette-minContrastColor': base,
    '--arc-background-simple-color': base,
    '--arc-background-gradient-color': `linear-gradient(${Math.round(theme.angle)}deg, ${c0}, ${c1})`
  }
}

/** A `:root` rule with the palette, ready to inject into a page. */
export function pagePaletteCss(theme: SpaceTheme, appearance: ResolvedAppearance): string {
  const body = Object.entries(pagePaletteVars(theme, appearance)).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  return `:root {\n${body}\n}`
}

/** The WCAG contrast of two opaque colours. */
export const contrastOf = (a: string, b: string): number => {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** What WCAG 2.2 AA asks of the bar: 4.5:1 for its text, 3:1 for its glyphs (1.4.3 and 1.4.11). */
const BAR_TEXT_CONTRAST = 4.5
const BAR_GLYPH_CONTRAST = 3
/** Kept above the minimum: the engine rounds a blended colour to a whole channel, which can cost a hundredth of the ratio. */
const BAR_CONTRAST_MARGIN = 0.05

/**
 * The opacity an ink needs on a bar to reach a contrast: the opacity of the design when it is enough, else the next hundredth that is,
 * up to the plain ink. Measured on the colour the eye gets (the ink laid over the bar), not on the declaration.
 */
function inkOpacity(ink: string, bar: string, designed: number, needed: number): number {
  const enough = (opacity: number): boolean => contrastOf(mix(bar, ink, opacity), bar) >= needed + BAR_CONTRAST_MARGIN
  if (enough(designed)) return designed
  for (let step = Math.floor(designed * 100) + 1; step < 100; step++) if (enough(step / 100)) return step / 100
  return 1
}

/**
 * The toolbar above a page takes the page's colour, and glyphs, text and highlight that stay readable
 * on it. The opacities of the design (read off the pixels): on a dark bar the glyphs are white at 67 %
 * (disabled 25 %), the host white at 75 % and the rest of the address at 62 %; on a light bar they are black at 55 % (25 %),
 * 60 % and 50 %. The line under a light bar is black at 5 % (#f2f2f2 on white); a dark bar has none.
 *
 * A page can declare any colour, so the ink is chosen by measure: white or black, whichever contrasts more with the bar (a mid-tone
 * such as a brand blue, red or green carries black, on which white would stay under 3:1), and each opacity is raised just enough for
 * 3:1 (glyphs) or 4.5:1 (host, rest of the address, text). The bar itself keeps the colour of the page. A glyph that cannot act is
 * exempt (WCAG 1.4.3) and keeps its 25 %.
 */
export function toolbarTint(color: string): Record<string, string> {
  // The line and the row it takes follow `toolbarIsLight` (shared/toolbar.ts), which the main process places the page with.
  const light = luminance(color) > 0.5
  const darkInk = contrastOf('#000000', color) >= contrastOf('#ffffff', color)
  const ink = darkInk ? '#000000' : '#ffffff'
  const channels = darkInk ? '0 0 0' : '255 255 255'
  const inked = (designed: number, needed: number): string => `rgb(${channels} / ${inkOpacity(ink, color, designed, needed)})`
  // The text of the roles: the soft black or white of the themes where it reads, else the plain one.
  const soft = darkInk ? '#1c1c22' : '#f1f1f5'
  const text = contrastOf(soft, color) >= BAR_TEXT_CONTRAST + BAR_CONTRAST_MARGIN ? soft : ink
  const { r, g, b } = hexToRgb(text)
  return {
    '--toolbar-bg': color,
    // The window's texture (private window) is for a bar that has no colour of its own.
    '--toolbar-texture': 'none',
    '--toolbar-line': light ? 'rgb(0 0 0 / 0.05)' : 'transparent',
    '--tb-icon': inked(darkInk ? 0.55 : 0.67, BAR_GLYPH_CONTRAST),
    '--tb-icon-off': `rgb(${channels} / 0.25)`,
    '--tb-text': inked(darkInk ? 0.6 : 0.75, BAR_TEXT_CONTRAST),
    '--tb-rest': inked(darkInk ? 0.5 : 0.625, BAR_TEXT_CONTRAST),
    '--tb-hover': darkInk ? 'rgb(0 0 0 / 0.05)' : 'rgb(255 255 255 / 0.08)',
    '--text': text,
    '--muted': `rgb(${r} ${g} ${b} / ${inkOpacity(text, color, darkInk ? 0.62 : 0.6, BAR_TEXT_CONTRAST)})`,
    '--hover': darkInk ? 'rgb(0 0 0 / 0.07)' : 'rgb(255 255 255 / 0.1)'
  }
}

// ---------- import from Arc ----------

interface ArcColor { red?: number; green?: number; blue?: number }

const toHex = (c: unknown): string | null => {
  const color = c as ArcColor | null
  if (!color || typeof color.red !== 'number' || typeof color.green !== 'number' || typeof color.blue !== 'number') return null
  return rgbToHex({ r: color.red * 255, g: color.green * 255, b: color.blue * 255 })
}

/**
 * Reads the `windowTheme` Arc saves for a space (`background.single._0.style.color._0.blendedGradient._0`).
 * Returns null for anything that is not a blended gradient (no guess is made).
 */
export function themeFromArc(windowTheme: unknown): SpaceTheme | null {
  const get = (obj: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
  const blended = get(windowTheme, 'background', 'single', '_0', 'style', 'color', '_0', 'blendedGradient', '_0') as Record<string, unknown> | undefined
  if (!blended || !Array.isArray(blended.baseColors)) return null
  const colors = blended.baseColors.map(toHex).filter((c): c is string => c !== null)
  if (colors.length === 0) return null
  const modifiers = (blended.modifiers ?? {}) as Record<string, unknown>
  const wheel = blended.wheel && typeof blended.wheel === 'object' ? Object.keys(blended.wheel)[0] : undefined
  // Arc spells it "complimentary".
  const harmony: Harmony = wheel === 'complimentary' || wheel === 'complementary' ? 'complementary' : wheel === 'analogous' ? 'analogous' : wheel === 'triadic' ? 'triadic' : wheel === 'monochrome' ? 'monochrome' : 'custom'
  const over = get(windowTheme, 'background', 'single', '_0', 'contentOverBackgroundAppearance')
  return cleanTheme({
    baseColors: colors,
    harmony,
    intensity: typeof modifiers.intensityFactor === 'number' ? modifiers.intensityFactor : 1,
    overlay: modifiers.overlay === 'grain' ? 'grain' : 'none',
    noise: typeof modifiers.noiseFactor === 'number' ? modifiers.noiseFactor : 0,
    translucency: blended.translucencyStyle === 'dark' ? 'dark' : 'light',
    vibrant: get(windowTheme, 'background', 'single', '_0', 'isVibrant') !== false,
    appearance: over === 'light' ? 'light' : over === 'dark' ? 'dark' : 'auto'
  })
}

/**
 * A CSS colour as a page reports it (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`) to a hex string.
 * Fully transparent colours and anything else give null: a page with no colour must not recolour the space.
 */
export function parseCssColor(css: unknown): string | null {
  if (typeof css !== 'string') return null
  const text = css.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  if (HEX.test(text)) return text
  const fn = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text)
  if (!fn) return null
  const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
  if (!(alpha > 0)) return null
  return rgbToHex({ r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) })
}
