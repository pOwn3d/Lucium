// The code of a space theme: a short text that holds a whole `SpaceTheme`, to copy from one space and paste into another (or into a chat).
//
//   luc1_bd93f9-8be9fd_complementary_155_85_grain_10_light_vivid_auto
//   |    |             |             |   |  |     |  |     |     '- appearance: auto | light | dark
//   |    |             |             |   |  |     |  |     '- vivid | muted (the "Couleurs vives" switch)
//   |    |             |             |   |  |     |  '- translucency: light | dark
//   |    |             |             |   |  |     '- amount of texture, 0..100
//   |    |             |             |   |  '- texture: none | grain | fine | coarse
//   |    |             |             |   '- intensity, 0..100
//   |    |             |             '- angle of the gradient, 0..360
//   |    |             '- harmony: complementary | analogous | triadic | monochrome | custom
//   |    '- one to three colours, hex without "#", joined by "-"
//   '- the version of the format
//
// The code is plain text a person can read and fix by hand. Underscores and hyphens keep a double click on a chat message on the whole code.
// A change of the format means a new prefix (`luc2`...): an older version of the application then says so instead of misreading the code.
//
// A pasted text is never trusted: it is read by a strict parser that accepts only the grammar above (or a single colour), bounded in length,
// with every value checked against its own type. What comes out is a `SpaceTheme` built field by field from those checked values and then
// passed through `cleanTheme`, so nothing of the pasted text itself reaches the state, the reducer or a stylesheet. Nothing is evaluated.

import { HARMONIES, OVERLAYS, cleanTheme, parseCssColor, withColorAt, type Appearance, type Harmony, type Overlay, type SpaceTheme } from './theme'
import { t } from './i18n'

export const THEME_CODE_VERSION = 'luc1'

/** Longest text the parser looks at. A code is at most 76 characters (three colours, the longest words); the rest is room for spaces and quotes. */
export const THEME_CODE_MAX_LENGTH = 240

/** Fields after the version: colours, harmony, angle, intensity, overlay, noise, translucency, vividness, appearance. */
const FIELD_COUNT = 9

const APPEARANCES: readonly Appearance[] = ['auto', 'light', 'dark']
const TRANSLUCENCIES = ['light', 'dark'] as const
const VIVIDNESS = ['vivid', 'muted'] as const

export type ThemeCodeError =
  /** Nothing but spaces. */
  | 'empty'
  /** Longer than any code can be: not looked at any further. */
  | 'too-long'
  /** Starts like a code of another version of the format. */
  | 'unknown-version'
  /** Starts like a code of this version but a field is missing, out of range or unknown. */
  | 'malformed'
  /** Neither a code nor a colour. */
  | 'not-a-theme'

export type ThemeCodeParse =
  | { ok: true; kind: 'theme'; theme: SpaceTheme }
  | { ok: true; kind: 'color'; color: string }
  | { ok: false; reason: ThemeCodeError }

const percent = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 100)

/**
 * The code of a theme. Numbers are written as whole degrees and whole percents, which is as fine as the editor's controls are felt:
 * `parseThemeCode(encodeThemeCode(t))` gives `cleanTheme(t)` up to that rounding, and the code of the result is the same code again.
 */
export function encodeThemeCode(theme: SpaceTheme): string {
  const clean = cleanTheme(theme)
  const colors = clean.baseColors.map((c) => c.slice(1).toLowerCase()).join('-')
  const fields = [
    colors,
    clean.harmony,
    String(Math.round(clean.angle)),
    String(percent(clean.intensity)),
    clean.overlay,
    String(percent(clean.noise)),
    clean.translucency,
    clean.vibrant ? 'vivid' : 'muted',
    clean.appearance
  ]
  return [THEME_CODE_VERSION, ...fields].join('_')
}

const inList = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value)

/** A whole number written with digits only, in [0, max]; anything else is null. */
function wholeNumber(text: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(text)) return null
  const value = Number(text)
  return value <= max ? value : null
}

function readColors(text: string): string[] | null {
  const parts = text.split('-')
  if (parts.length > 3) return null
  const colors = parts.map((p) => `#${p}`)
  return colors.every((c) => /^#[0-9a-f]{6}$/.test(c)) ? colors : null
}

function readFields(fields: string[]): SpaceTheme | null {
  const [colorsText, harmony, angle, intensity, overlay, noise, translucency, vividness, appearance] = fields as [string, string, string, string, string, string, string, string, string]
  const baseColors = readColors(colorsText)
  const angleValue = wholeNumber(angle, 360)
  const intensityValue = wholeNumber(intensity, 100)
  const noiseValue = wholeNumber(noise, 100)
  if (!baseColors || angleValue === null || intensityValue === null || noiseValue === null) return null
  if (!inList<Harmony>(HARMONIES, harmony) || !inList<Overlay>(OVERLAYS, overlay)) return null
  if (!inList(TRANSLUCENCIES, translucency) || !inList(VIVIDNESS, vividness) || !inList<Appearance>(APPEARANCES, appearance)) return null
  return cleanTheme({
    baseColors,
    harmony,
    angle: angleValue,
    intensity: intensityValue / 100,
    overlay,
    noise: noiseValue / 100,
    translucency,
    vibrant: vividness === 'vivid',
    appearance
  })
}

/** What a person copies around a code: a pair of quotes or backticks, or spaces and line breaks. */
function unwrap(text: string): string {
  const trimmed = text.trim()
  const first = trimmed[0]
  if (trimmed.length >= 2 && (first === '"' || first === "'" || first === '`') && trimmed.endsWith(first)) return trimmed.slice(1, -1).trim()
  return trimmed
}

/** A single colour: `#rrggbb`, `rrggbb`, `#rgb` or `rgb(r, g, b)`. Not a bare `abc`, which is a word as much as a colour. */
function readColor(text: string): string | null {
  if (/^#?[0-9a-f]{6}$/.test(text)) return `#${text.replace('#', '')}`
  if (/^#[0-9a-f]{3}$/.test(text) || /^rgba?\(/.test(text)) return parseCssColor(text)
  return null
}

/** Reads what the user pasted: a theme code, or a colour (which the caller sets as the base colour of a theme). */
export function parseThemeCode(input: unknown): ThemeCodeParse {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-theme' }
  // Bounded before anything else is done to it: a huge text is not trimmed, lowercased or split.
  if (input.length > THEME_CODE_MAX_LENGTH * 2) return { ok: false, reason: 'too-long' }
  const text = unwrap(input).toLowerCase()
  if (text.length === 0) return { ok: false, reason: 'empty' }
  if (text.length > THEME_CODE_MAX_LENGTH) return { ok: false, reason: 'too-long' }

  const color = readColor(text)
  if (color) return { ok: true, kind: 'color', color }

  const match = /^(luc)(\d{1,3})_/.exec(text)
  if (!match) return { ok: false, reason: 'not-a-theme' }
  if (`luc${match[2]}` !== THEME_CODE_VERSION) return { ok: false, reason: 'unknown-version' }
  const fields = text.split('_').slice(1)
  if (fields.length !== FIELD_COUNT) return { ok: false, reason: 'malformed' }
  const theme = readFields(fields)
  return theme ? { ok: true, kind: 'theme', theme } : { ok: false, reason: 'malformed' }
}

/** The sentence the interface shows when a paste is refused. */
export function themeCodeMessage(reason: ThemeCodeError): string {
  switch (reason) {
    case 'empty':
      return t('theme-code.rien-a-coller-collez-un-code-de-theme-ou-une-couleur')
    case 'too-long':
      return t('theme-code.ce-texte-est-trop-long-pour-etre-un-code-de')
    case 'unknown-version':
      return t('theme-code.ce-code-vient-d-une-autre-version-de-lucium')
    case 'malformed':
      return t('theme-code.ce-code-de-theme-est-incomplet-ou-abime')
    case 'not-a-theme':
      return t('theme-code.ce-texte-n-est-ni-un-code-de-theme-ni-une-couleur')
  }
}

/**
 * What to change in `current` so that it becomes what was pasted: the whole theme for a code, only the base colour for a colour
 * (its harmony still derives the other colours). The result is a patch for `space/update`.
 */
export function pastedThemePatch(parse: Extract<ThemeCodeParse, { ok: true }>, current: SpaceTheme): Partial<SpaceTheme> {
  if (parse.kind === 'theme') return parse.theme
  return withColorAt(current, 0, parse.color) ?? {}
}

// ---- what the interface asks of the shell ----

/** The longest text a request carries (a code is at most `THEME_CODE_MAX_LENGTH`; the rest is a pasted text the parser will refuse). */
const REQUEST_TEXT_MAX = 2000

/**
 * The theme editor's buttons. `copy` puts a code or a colour on the clipboard (nothing else: the text must parse), `paste` applies what
 * the field holds, or the clipboard when there is no text, to a space, and `apply-all` gives a theme (the space's own when none is sent,
 * which is the draft the editor is showing) to every space.
 */
export type ThemeRequest =
  | { kind: 'copy'; text: string }
  | { kind: 'paste'; spaceId: string; text?: string }
  | { kind: 'apply-all'; spaceId: string; theme?: SpaceTheme }
  | ThemeFileRequest

/**
 * The theme as a file (shared/boost-share.ts): `export-file` saves the theme of a space, `import-file` applies the one in a file the
 * person chooses to a space. The interface sends no path and no text: the shell shows the dialogs and reads the file itself.
 */
export type ThemeFileRequest = { kind: 'export-file'; spaceId: string } | { kind: 'import-file'; spaceId: string }

/** What the shell answers: the sentence to show next to the button, and whether it worked. */
export interface ThemeReply {
  ok: boolean
  message: string
}

/** Reads a request from the interface; the shell does not trust it, so anything that is not exactly one of the three is refused. */
export function parseThemeRequest(raw: unknown): ThemeRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as { kind?: unknown; text?: unknown; spaceId?: unknown; theme?: unknown }
  const text = typeof r.text === 'string' && r.text.length <= REQUEST_TEXT_MAX ? r.text : undefined
  if (r.text !== undefined && text === undefined) return null
  const spaceId = typeof r.spaceId === 'string' && r.spaceId.length > 0 && r.spaceId.length <= 200 ? r.spaceId : null
  if (r.kind === 'export-file' || r.kind === 'import-file') return spaceId && text === undefined && r.theme === undefined ? { kind: r.kind, spaceId } : null
  if (r.kind === 'copy') return text === undefined ? null : { kind: 'copy', text }
  if (r.kind === 'paste') return spaceId ? { kind: 'paste', spaceId, ...(text === undefined ? {} : { text }) } : null
  if (r.kind === 'apply-all') {
    if (!spaceId) return null
    if (r.theme === undefined) return { kind: 'apply-all', spaceId }
    if (typeof r.theme !== 'object' || r.theme === null || Array.isArray(r.theme)) return null
    return { kind: 'apply-all', spaceId, theme: cleanTheme(r.theme as Partial<SpaceTheme>) }
  }
  return null
}
