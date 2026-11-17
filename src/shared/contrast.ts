// WCAG 2.x contrast of CSS colours given as text: what the design tokens (src/renderer/tokens.css) are measured with. The colour maths (relative
// luminance, laying a translucent colour over another) is the one of a11y-audit.ts, which the engine tests use on the real pixels; this file adds what
// the tokens need: `hsl()`, a few names, text on either side of the ratio, and a background that is translucent too.
//
//   contrastRatio('#16181f', '#ffffff')                -> 17.7
//   contrastRatio('rgb(26 29 43 / 0.74)', '#c7d6f6')   -> the translucent text is first laid over its background, then measured
//
// The thresholds are those of WCAG 2.2 AA: 4.5 for text, 3 for large text and for the parts of a control (1.4.3 and 1.4.11).

import { composite, parseColor as parseRgbOrHex, relativeLuminance, type Rgba } from './a11y-audit'
import { hslToRgb } from './theme'
import { clamp } from './clamp'

export { relativeLuminance, type Rgba }
/** `top` laid over `bottom` (the "over" operator): what the eye gets from a translucent colour on a surface. */
export const compositeOver = composite

export const AA_TEXT = 4.5
export const AA_CONTROL = 3

const NAMED: Readonly<Record<string, Rgba>> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 }
}

/** `0.5`, `50%` or `120` (of `scale`) as a number; null for anything else. */
function amount(text: string, scale: number): number | null {
  const value = text.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)%?$/.test(value)) return null
  return value.endsWith('%') ? (parseFloat(value) / 100) * scale : parseFloat(value)
}

/**
 * A CSS colour as a number: hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` (space or comma form, alpha after a slash or as a fourth value), `transparent`,
 * `white`, `black`. Anything else (a `var()`, a gradient, `color-mix()`) gives null: work it out first, so that nothing is measured on a guess.
 */
export function parseColor(css: string): Rgba | null {
  const text = css.trim().toLowerCase()
  const named = NAMED[text]
  if (named) return { ...named }
  const hsl = /^hsla?\(([^()]*)\)$/.exec(text)
  if (!hsl) return parseRgbOrHex(text)
  const parts = hsl[1]!.replace(/\s*\/\s*/g, ' ').split(/[\s,]+/).filter((part) => part !== '')
  if (parts.length < 3 || parts.length > 4) return null
  const hue = parseFloat(parts[0]!.replace(/deg$/, ''))
  const [s, l] = [amount(parts[1]!, 1), amount(parts[2]!, 1)]
  const alpha = parts[3] === undefined ? 1 : amount(parts[3], 1)
  if (!Number.isFinite(hue) || s === null || l === null || alpha === null) return null
  const rgb = hslToRgb({ h: hue, s: clamp(s, 0, 1), l: clamp(l, 0, 1) })
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: clamp(alpha, 0, 1) }
}

const asColor = (value: string | Rgba): Rgba => {
  if (typeof value !== 'string') return value
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`contrast: not a colour: ${value}`)
  return parsed
}

/**
 * The WCAG contrast ratio of a foreground on a background, 1 to 21. A translucent foreground is laid over the background first, and a
 * translucent background over `page` (white by default): the ratio is what the person sees, not what the declaration says.
 */
export function contrastRatio(foreground: string | Rgba, background: string | Rgba, page: string | Rgba = '#ffffff'): number {
  const bg = composite(asColor(background), asColor(page))
  const fg = composite(asColor(foreground), bg)
  const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
