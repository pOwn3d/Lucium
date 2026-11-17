import { NEUTRAL_TINT, type Boost, type BoostInput, type BoostTextCase, type BoostTint } from './model'
import { t } from './i18n'
import { clamp01 } from './clamp'
import { SELECTOR_FOR } from './element-selector'
import { unreadableCode } from './boost-css'
import { unreadableCodeMessage } from './userscript'

/**
 * True when the Tweak's script is allowed to run: it has one, it was not stored switched off (an imported script waits for its owner), and
 * it shows what it runs (a script kept by an earlier version with a character that reorders a line, or a line end that is not drawn, runs nowhere).
 * Only `js` is looked at: the script being typed (`jsDraft`) is never run by a page on its own.
 */
export const boostRunsScript = (boost: Pick<Boost, 'js' | 'jsEnabled'>): boolean => boost.js.trim() !== '' && boost.jsEnabled !== false && unreadableCode(boost.js) === null

/** What the shell answers to the preview of the editor: whether the script was given to the page, and the sentence to show. */
export interface ScriptPreviewReply {
  ok: boolean
  message: string
}

export type ScriptPreview = { ok: true; js: string } | { ok: false; reason: 'no-tweak' | 'no-script' | 'waiting' | 'unreadable' | 'no-page' }

/**
 * The script the preview of the editor runs, once, in the page the person is looking at: the one being typed, or the saved one when nothing
 * is being typed. Refused where a Tweak runs nothing (a private tab, the Tweaks switched off, a page of another site), for a script that
 * still waits to be read and switched on, and for one that does not show what it runs.
 */
export function scriptPreview(boost: Pick<Boost, 'host' | 'js' | 'jsDraft' | 'jsEnabled'> | undefined, page: { matches: boolean; private: boolean } | undefined, boostsEnabled: boolean): ScriptPreview {
  if (!boost) return { ok: false, reason: 'no-tweak' }
  const js = boost.jsDraft ?? boost.js
  if (js.trim() === '') return { ok: false, reason: 'no-script' }
  if (boost.jsEnabled === false) return { ok: false, reason: 'waiting' }
  if (unreadableCode(js)) return { ok: false, reason: 'unreadable' }
  if (!page || !page.matches || page.private || !boostsEnabled) return { ok: false, reason: 'no-page' }
  return { ok: true, js }
}

/** The sentence of a preview: that it was started, or why it was not. */
export function scriptPreviewMessage(preview: ScriptPreview, boost: Pick<Boost, 'js' | 'jsDraft'> | undefined): string {
  if (preview.ok) return t('boost-editor.apercu-lance-dans-la-page-affichee')
  const unreadable = preview.reason === 'unreadable' && boost ? unreadableCode(boost.jsDraft ?? boost.js) : null
  if (unreadable) return unreadableCodeMessage(unreadable)
  if (preview.reason === 'waiting') return t('boost-editor.ce-script-n-est-pas-execute')
  if (preview.reason === 'no-page') return t('boost-editor.l-apercu-ne-peut-pas-etre-lance-ici')
  return t('boost-editor.il-n-y-a-aucun-script-a-lancer')
}

/**
 * True when a save has just switched a running script off: the page that is running it has to be reloaded to stop it (a script that
 * only waits, and is edited, runs nowhere and needs no reload).
 */
export const scriptSwitchedOff = (before: Pick<Boost, 'js' | 'jsEnabled'> | undefined, after: Pick<Boost, 'js' | 'jsEnabled'> | undefined): boolean =>
  before !== undefined && boostRunsScript(before) && after !== undefined && after.jsEnabled === false

/** True when the colour filter would change nothing. */
export const isNeutralTint = (t: BoostTint) => t.hue === NEUTRAL_TINT.hue && t.saturation === NEUTRAL_TINT.saturation && t.brightness === NEUTRAL_TINT.brightness && t.contrast === NEUTRAL_TINT.contrast

// ---------- Fonts and case ----------

export interface BoostFont {
  id: string
  /** Shown as the tooltip of the font's cell. */
  label: string
  /** A fixed CSS font stack: the page never receives anything the user typed. */
  family: string
  /**
   * Set for a font Lucium carries (resources/fonts/<file>.woff2, listed in resources/fonts/LICENSES.md). The page gets the bytes of
   * the file as a FontFace named `Lucium <label>` (the first name of `family`): a font fetched from a URL is refused by the strict
   * content security policy of many sites, a font built from bytes is not.
   */
  file?: string
}

/**
 * The thirty families of the font grid. The first twenty are system fonts of macOS with generic fallbacks, so nothing is downloaded.
 * The last ten are the typefaces Lucium carries (open fonts under the SIL OFL, chosen for 2026 from guides that keep recommending
 * them: the most-installed UI sans, three more text and geometric sans, a technical grotesque, a soft and a reading serif, a
 * high-contrast display serif, the reference code font and the most legible face for low vision).
 */
export const BOOST_FONTS: readonly BoostFont[] = [
  { id: 'system', get label() { return t('boost.systeme') }, family: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  { id: 'helvetica', label: 'Helvetica Neue', family: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'avenir', label: 'Avenir Next', family: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif' },
  { id: 'futura', label: 'Futura', family: 'Futura, "Trebuchet MS", sans-serif' },
  { id: 'gill', label: 'Gill Sans', family: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { id: 'optima', label: 'Optima', family: 'Optima, Candara, "Segoe UI", sans-serif' },
  { id: 'verdana', label: 'Verdana', family: 'Verdana, Geneva, sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet MS', family: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  { id: 'georgia', label: 'Georgia', family: 'Georgia, "Times New Roman", serif' },
  { id: 'palatino', label: 'Palatino', family: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { id: 'baskerville', label: 'Baskerville', family: 'Baskerville, "Baskerville Old Face", Georgia, serif' },
  { id: 'didot', label: 'Didot', family: 'Didot, "Bodoni MT", "Times New Roman", serif' },
  { id: 'times', label: 'Times', family: '"Times New Roman", Times, serif' },
  { id: 'menlo', label: 'Menlo', family: 'Menlo, Monaco, Consolas, monospace' },
  { id: 'courier', label: 'Courier New', family: '"Courier New", Courier, monospace' },
  { id: 'sfmono', label: 'SF Mono', family: 'ui-monospace, "SF Mono", SFMono-Regular, monospace' },
  { id: 'rounded', get label() { return t('boost.arrondie') }, family: '"Arial Rounded MT Bold", "Varela Round", ui-rounded, sans-serif' },
  { id: 'marker', label: 'Marker Felt', family: '"Marker Felt", "Comic Sans MS", cursive' },
  { id: 'snell', label: 'Snell Roundhand', family: '"Snell Roundhand", "Apple Chancery", cursive' },
  { id: 'impact', label: 'Impact', family: 'Impact, "Arial Black", sans-serif' },
  { id: 'inter', label: 'Inter', family: '"Lucium Inter", Inter, system-ui, sans-serif', file: 'inter' },
  { id: 'hanken', label: 'Hanken Grotesk', family: '"Lucium Hanken Grotesk", "Hanken Grotesk", system-ui, sans-serif', file: 'hanken-grotesk' },
  { id: 'manrope', label: 'Manrope', family: '"Lucium Manrope", Manrope, system-ui, sans-serif', file: 'manrope' },
  { id: 'figtree', label: 'Figtree', family: '"Lucium Figtree", Figtree, system-ui, sans-serif', file: 'figtree' },
  { id: 'spacegrotesk', label: 'Space Grotesk', family: '"Lucium Space Grotesk", "Space Grotesk", system-ui, sans-serif', file: 'space-grotesk' },
  { id: 'fraunces', label: 'Fraunces', family: '"Lucium Fraunces", Fraunces, Georgia, serif', file: 'fraunces' },
  { id: 'literata', label: 'Literata', family: '"Lucium Literata", Literata, Georgia, serif', file: 'literata' },
  { id: 'bodoni', label: 'Bodoni Moda', family: '"Lucium Bodoni Moda", "Bodoni Moda", Didot, "Bodoni MT", Georgia, serif', file: 'bodoni-moda' },
  { id: 'jetbrains', label: 'JetBrains Mono', family: '"Lucium JetBrains Mono", "JetBrains Mono", ui-monospace, Menlo, monospace', file: 'jetbrains-mono' },
  { id: 'atkinson', label: 'Atkinson Hyperlegible Next', family: '"Lucium Atkinson Hyperlegible Next", "Atkinson Hyperlegible Next", system-ui, sans-serif', file: 'atkinson-hyperlegible-next' }
]

export const fontById = (id: unknown): BoostFont | undefined => BOOST_FONTS.find((font) => font.id === id)

/** The name of the FontFace a page receives for a bundled font ("Lucium Inter"); undefined for a system font. */
export const bundledFaceName = (font: BoostFont): string | undefined => (font.file ? `Lucium ${font.label}` : undefined)

/** The bundled fonts the given Tweaks ask for, each once, in the order of the grid. */
export function bundledFontsOf(boosts: ReadonlyArray<{ fontFamily?: string }>): BoostFont[] {
  const wanted = new Set(boosts.map((b) => b.fontFamily))
  return BOOST_FONTS.filter((font) => font.file !== undefined && wanted.has(font.id))
}

/**
 * The script that tells which of these faces the document does not have yet (a navigation gives a page a new document: the faces
 * are added again). The names are fixed ones, never typed text.
 */
export function missingFacesScript(faces: readonly string[]): string {
  return `(() => { const have = new Set([...document.fonts].map((f) => f.family.replace(/^"|"$/g, ''))); return ${JSON.stringify(faces)}.filter((face) => !have.has(face)) })()`
}

/** The script that gives the page a bundled font: a FontFace built from the bytes of the file (base64), added to the document. */
export function fontFaceScript(face: string, base64: string): string {
  return `(async () => { try { const text = atob(${JSON.stringify(base64)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); const font = new FontFace(${JSON.stringify(face)}, bytes.buffer, { weight: '100 900', style: 'normal', display: 'swap' }); await font.load(); document.fonts.add(font); return true } catch (error) { console.warn('[lucium] the font ${face.replace(/[^\w .-]/g, '')} could not be added:', error); return false } })()`
}

/** The order the Case button goes through; after the last one the page gets its own case back. */
export const BOOST_TEXT_CASES: readonly BoostTextCase[] = ['upper', 'lower', 'capitalize']

const CSS_TEXT_TRANSFORM: Record<BoostTextCase, string> = { upper: 'uppercase', lower: 'lowercase', capitalize: 'capitalize' }

export function nextTextCase(current: BoostTextCase | undefined): BoostTextCase | undefined {
  if (!current) return BOOST_TEXT_CASES[0]
  return BOOST_TEXT_CASES[BOOST_TEXT_CASES.indexOf(current) + 1]
}

/** What the Case button says: the sample of the case it applies, or its name while nothing is applied. */
export function textCaseLabel(current: BoostTextCase | undefined): string {
  return current === 'upper' ? 'AA' : current === 'lower' ? 'aa' : current === 'capitalize' ? 'Aa' : t('boost.casse')
}

/**
 * The optional fields a Tweak carries beyond the original ones, reduced to what is safe to keep: a known font id, a known
 * case, a true flag, and the one value of `jsEnabled` that means something (`false`: the script waits). Anything else is dropped
 * (the result has no `undefined` keys, so the saved JSON stays clean).
 */
export function cleanBoostExtras(input: { fontFamily?: unknown; textCase?: unknown; invert?: unknown; jsEnabled?: unknown }): Pick<Boost, 'fontFamily' | 'textCase' | 'invert' | 'jsEnabled'> {
  return {
    ...(fontById(input.fontFamily) ? { fontFamily: input.fontFamily as string } : {}),
    ...(BOOST_TEXT_CASES.includes(input.textCase as BoostTextCase) ? { textCase: input.textCase as BoostTextCase } : {}),
    ...(input.invert === true ? { invert: true } : {}),
    ...(input.jsEnabled === false ? { jsEnabled: false } : {})
  }
}

// ---------- Stylesheet ----------

const MEDIA = 'img, video, picture, canvas, svg image'
const REINVERT = 'invert(1) hue-rotate(180deg)'
// Icon fonts and code keep their own glyphs.
const TEXT_ELEMENTS = 'html, body, body *:not(pre):not(code):not(kbd):not(samp):not(i):not([class*="icon" i]):not([class*="fa-" i])'

type Composable = Pick<Boost, 'css' | 'zap'> & Partial<Pick<Boost, 'fontFamily' | 'textCase' | 'invert'>> & { tint?: BoostTint }

/** The stylesheet one Tweak injects: its CSS, one rule per erased element, its font and case, and its colour filter. */
export function composeBoostCss(boost: Composable): string {
  const zapped = boost.zap.map((selector) => `${selector} { display: none !important; }`)
  const font = fontById(boost.fontFamily)
  const fontRule = font ? `${TEXT_ELEMENTS} { font-family: ${font.family} !important; }` : ''
  const transform = BOOST_TEXT_CASES.includes(boost.textCase as BoostTextCase) ? CSS_TEXT_TRANSFORM[boost.textCase as BoostTextCase] : ''
  const caseRule = transform ? `body, body * { text-transform: ${transform} !important; }` : ''
  const tint = boost.tint && !isNeutralTint(boost.tint) ? `hue-rotate(${boost.tint.hue}deg) saturate(${boost.tint.saturation}) brightness(${boost.tint.brightness}) contrast(${boost.tint.contrast})` : ''
  const invert = boost.invert === true
  const filters = [invert ? REINVERT : '', tint].filter(Boolean).join(' ')
  const filterRules = filters ? [`html { filter: ${filters}; }`, ...(invert ? [`${MEDIA} { filter: ${REINVERT}; }`] : [])] : []
  return [boost.css, ...zapped, fontRule, caseRule, ...filterRules].filter((part) => part.trim() !== '').join('\n')
}

/**
 * Several Tweaks can match one page: their CSS stacks in order, every script runs, and the zoom is the last one
 * that is not 100 % (a later Tweak wins, an untouched zoom never resets an earlier one).
 */
export function combineBoosts(boosts: Boost[]): { css: string; scripts: string[]; zoom: number } {
  return {
    css: boosts.map(composeBoostCss).filter((c) => c !== '').join('\n'),
    scripts: boosts.filter(boostRunsScript).map((b) => b.js),
    zoom: boosts.reduce((zoom, b) => (b.zoom !== 1 ? b.zoom : zoom), 1)
  }
}

// ---------- Editor logic ----------

/** What the editor edits: a Tweak without its host. */
export type BoostDraft = Pick<Boost, 'name' | 'enabled' | 'css' | 'js' | 'zoom' | 'zap' | 'tint'> & Partial<Pick<Boost, 'fontFamily' | 'textCase' | 'invert' | 'jsEnabled'>>

/** True when the Tweak changes anything about the page: the title menu offers "Réinitialiser" and "Mélanger" only then. */
export function boostIsModified(draft: Pick<BoostDraft, 'css' | 'js' | 'zoom' | 'zap' | 'tint' | 'fontFamily' | 'textCase' | 'invert'>): boolean {
  return !isNeutralTint(draft.tint) || draft.zoom !== 1 || draft.zap.length > 0 || draft.css.trim() !== '' || draft.js.trim() !== '' || !!draft.fontFamily || !!draft.textCase || draft.invert === true
}

/** Takes away everything the Tweak does to the page, keeping its name and whether it is on. */
export function resetBoost(draft: BoostDraft): BoostDraft {
  // The optional fields are named with `undefined` so that merging the result over a draft clears them.
  return { name: draft.name, enabled: draft.enabled, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, fontFamily: undefined, textCase: undefined, invert: undefined }
}

/** Zoom steps of the Size button: 100 % first, then 110 % to 150 %. */
export const BOOST_SIZE_STEPS: readonly number[] = [1, 1.1, 1.2, 1.3, 1.4, 1.5]

/** The next zoom of the Size button; a zoom below 100 % goes back to 100 %, and the last step goes round to 100 %. */
export function nextZoom(zoom: number): number {
  return BOOST_SIZE_STEPS.find((step) => step >= 1 && step > zoom + 1e-6) ?? 1
}

export function sizeLabel(zoom: number): string {
  return zoom === 1 ? t('boost.taille') : t('resources.pourcent', { n: Math.round(zoom * 100) })
}

const ORANGE = [255, 159, 26]
const RED = [245, 32, 15]

/** Background of the Size button: orange at 110 % turning red at 150 %; null at 100 % and below (the neutral grey). */
export function sizeColor(zoom: number): string | null {
  if (zoom <= 1) return null
  const t = Math.min(1, Math.max(0, (zoom - 1.1) / 0.4))
  const channel = (i: number) => Math.round(ORANGE[i]! + (RED[i]! - ORANGE[i]!) * t)
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`
}

/** "Ma Retouche", then "Ma Retouche 2", "Ma Retouche 3"… the first name the site does not use yet. */
export function nextBoostName(taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()))
  for (let n = 1; ; n++) {
    const name = n === 1 ? t('boost.ma-retouche') : `${t('boost.ma-retouche')} ${n}`
    if (!used.has(name.toLowerCase())) return name
  }
}

/** A random but moderate look: any hue and saturation, a little brightness and contrast. `random` returns values in [0, 1). */
export function shuffleTint(random: () => number): BoostTint {
  const between = (min: number, max: number, step: number) => Math.round((min + random() * (max - min)) / step) * step
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    hue: between(-180, 180, 5),
    saturation: round(between(0.6, 1.6, 0.05)),
    brightness: round(between(0.9, 1.1, 0.05)),
    contrast: round(between(0.9, 1.1, 0.05))
  }
}

// ---------- Colour pad and sliders ----------

export interface PadPoint {
  x: number
  y: number
}

/** Where the handles sit while the page is untouched (fractions of the pad). */
export const PRIMARY_REST: PadPoint = { x: 0.8, y: 0.5 }
export const SECONDARY_REST: PadPoint = { x: 0.71, y: 0.71 }

/** A position along one axis (0..1) to a value: `min` at 0, `neutral` at `rest`, `max` at 1, straight lines in between. */
function axisValue(t: number, min: number, neutral: number, max: number, rest: number): number {
  const p = clamp01(t)
  return p <= rest ? min + ((neutral - min) * p) / rest : neutral + ((max - neutral) * (p - rest)) / (1 - rest)
}

function axisPosition(value: number, min: number, neutral: number, max: number, rest: number): number {
  const v = Math.min(max, Math.max(min, value))
  return v <= neutral ? (rest * (v - min)) / (neutral - min) : rest + ((1 - rest) * (v - neutral)) / (max - neutral)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The main handle: hue along x (−180° to 180°), saturation up the y axis (vivid at the top, grey at the bottom). */
export function primaryToTint(tint: BoostTint, point: PadPoint): BoostTint {
  return {
    ...tint,
    hue: Math.round(axisValue(point.x, -180, 0, 180, PRIMARY_REST.x)),
    saturation: round2(axisValue(1 - point.y, 0, 1, 2, 1 - PRIMARY_REST.y))
  }
}

export function primaryPoint(tint: BoostTint): PadPoint {
  return { x: axisPosition(tint.hue, -180, 0, 180, PRIMARY_REST.x), y: 1 - axisPosition(tint.saturation, 0, 1, 2, 1 - PRIMARY_REST.y) }
}

/** The small handle: contrast along x, brightness up the y axis (brighter at the top). */
export function secondaryToTint(tint: BoostTint, point: PadPoint): BoostTint {
  return {
    ...tint,
    contrast: round2(axisValue(point.x, 0.5, 1, 1.5, SECONDARY_REST.x)),
    brightness: round2(axisValue(1 - point.y, 0.5, 1, 1.5, 1 - SECONDARY_REST.y))
  }
}

export function secondaryPoint(tint: BoostTint): PadPoint {
  return { x: axisPosition(tint.contrast, 0.5, 1, 1.5, SECONDARY_REST.x), y: 1 - axisPosition(tint.brightness, 0.5, 1, 1.5, 1 - SECONDARY_REST.y) }
}

export type TintKey = keyof BoostTint

const TINT_RANGE: Record<TintKey, [min: number, max: number]> = { hue: [-180, 180], saturation: [0, 2], brightness: [0.5, 1.5], contrast: [0.5, 1.5] }

/** The advanced sliders run from 0 to 100 with the untouched value (hue 0°, others 1) in the middle. */
export function sliderOf(key: TintKey, tint: BoostTint): number {
  const [min, max] = TINT_RANGE[key]
  return Math.round(((tint[key] - min) / (max - min)) * 100)
}

export function tintWithSlider(tint: BoostTint, key: TintKey, slider: number): BoostTint {
  const [min, max] = TINT_RANGE[key]
  const value = min + (clamp01(slider / 100) * (max - min))
  return { ...tint, [key]: key === 'hue' ? Math.round(value) : round2(value) }
}

/** Colours of the pad's ring: grey while the page is untouched, otherwise light to dark in the chosen hue. */
export function ringColors(tint: BoostTint): [string, string] {
  if (isNeutralTint(tint)) return ['#373737', '#dcdcdc']
  const saturation = Math.round(Math.min(1, Math.max(0.15, tint.saturation / 1.4)) * 100)
  const hue = (((tint.hue + 180) % 360) + 360) % 360
  return [`hsl(${hue} ${saturation}% 22%)`, `hsl(${hue} ${saturation}% 86%)`]
}

/** Keeps the history the Undo button walks back through bounded. */
export const HISTORY_LIMIT = 60

export function pushHistory<T>(history: readonly T[], entry: T): T[] {
  return [...history, entry].slice(-HISTORY_LIMIT)
}

/**
 * What the editor hands to `boost/save`: the draft plus the Tweak's identity. The script of the field goes as the script being typed
 * (`jsDraft`), and `savedJs`, the last one the person saved, stays the one the pages run: typing never changes what runs.
 */
export function draftToInput(id: string, host: string, draft: Omit<BoostDraft, 'zap'> & Partial<Pick<BoostDraft, 'zap'>>, savedJs: string): BoostInput {
  return { id, host, ...draft, js: savedJs, jsDraft: draft.js }
}

// ---------- Eraser ----------

/**
 * The page in Eraser mode: a 3 px blue frame on the edges of the page card, a hint at the bottom and a "Terminé" button. The editor panel
 * stays on screen (its layer shrinks to the panel, so the page can be clicked).
 */
export const ZAP_FRAME = { color: '#2f39ff', width: 3 } as const
/** Where the editor panel sits in its layer while the Eraser is on: the layer is the panel plus a margin that keeps its shadow. */
export const ZAP_PANEL = { shadow: 24, right: 44, width: 400, height: 400 } as const
export const zapHint = (): string => t('boost.cliquez-sur-des-elements-de-la-page-pour-les-gommer')
export const zapDone = (): string => t('boost.termine')
/** A sentence as the text of a single-quoted string of the script (a translation may carry an apostrophe or a backslash). */
const inScriptString = (text: string): string => text.replace(/[\\']/g, '\\$&')

/** What `zapStopName` gives: an underscore and 24 hexadecimal digits, safe to write between quotes in a script. */
const ZAP_STOP_NAME = /^_[0-9a-f]{24}$/

/** A name for the page global that ends one use of the Eraser, from 12 random bytes (`crypto.randomBytes` in the application). */
export const zapStopName = (random: (bytes: number) => Uint8Array): string => `_${[...random(12)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`

/** Ends, from outside the page, the use of the Eraser that was started with this name; does nothing when it is over already. */
export function zapStopScript(stop: string): string {
  if (!ZAP_STOP_NAME.test(stop)) throw new Error('The Eraser is ended by the name it was started with')
  return `window['${stop}'] && window['${stop}']()`
}

/**
 * Runs in the page while the user erases: every click on an element hides it (at once, to show the effect) and remembers a CSS selector
 * for it; Escape or the "Terminé" button ends the mode. Resolves with the selectors, in click order, once the page is back as it was
 * (the Tweak's own CSS hides the elements from then on). The interface is drawn in a closed shadow root, so the page's own styles
 * cannot reach it and its scripts cannot see it.
 *
 * The script runs with the page's own scripts, so the function that ends the mode from outside (`zapStopScript`) is a global the page can
 * see. Its name is `stop`, drawn by the caller for each use (`zapStopName`): a fixed name would tell the page which browser erases.
 */
export function zapScript(stop: string): string {
  if (!ZAP_STOP_NAME.test(stop)) throw new Error('The Eraser needs a name drawn by zapStopName for the function that ends it')
  return `new Promise((resolve) => {
  const STOP = '${stop}'
  const host = document.createElement('div')
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const ui = host.attachShadow({ mode: 'closed' })
  ui.innerHTML = '<style>' +
    '*{box-sizing:border-box}' +
    '.frame{position:fixed;inset:0;border:${ZAP_FRAME.width}px solid ${ZAP_FRAME.color};border-radius:10px;pointer-events:none}' +
    '.box{position:fixed;display:none;border:2px solid ${ZAP_FRAME.color};background:rgba(47,57,255,.14);border-radius:3px;pointer-events:none}' +
    '.bar{position:fixed;left:0;right:0;bottom:10px;display:flex;align-items:center;justify-content:center;gap:12px;pointer-events:none;font:400 13px/16px -apple-system,system-ui,sans-serif}' +
    '.hint{padding:11px 14px;border-radius:8px;background:rgba(16,18,46,.82);color:#dedfff}' +
    '.hint b{font-weight:700}' +
    '.done{position:fixed;right:10px;bottom:10px;min-width:59px;height:38px;padding:0 14px;border:0;border-radius:8px;background:#edeeff;color:#2f3033;font:500 14px/1 -apple-system,system-ui,sans-serif;pointer-events:auto;cursor:default}' +
    '.done:hover{background:#fff}' +
    '</style><div class="frame"></div><div class="box"></div><div class="bar"><div class="hint">${inScriptString(zapHint()).replace(/gommer|\berase\b/, '<b>$&</b>')}</div></div><button class="done" type="button">${inScriptString(zapDone())}</button>'
  const box = ui.querySelector('.box')
  const picked = []
  const hidden = []
  ${SELECTOR_FOR}
  const ours = (e) => e.composedPath().includes(host)
  const swallow = (e) => { if (ours(e)) return; e.preventDefault(); e.stopPropagation() }
  const move = (e) => {
    if (ours(e) || !(e.target instanceof Element)) { box.style.display = 'none'; return }
    const r = e.target.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
  }
  const click = (e) => {
    if (ours(e)) return
    e.preventDefault(); e.stopPropagation()
    if (!(e.target instanceof Element) || e.target === document.documentElement || e.target === document.body) return
    const selector = selectorFor(e.target)
    if (!selector) return
    if (!picked.includes(selector)) picked.push(selector)
    e.target.style.setProperty('display', 'none', 'important')
    hidden.push(e.target)
    box.style.display = 'none'
  }
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish() } }
  const events = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu', 'dblclick', 'submit']
  let done = false
  function finish() {
    if (done) return
    done = true
    delete window[STOP]
    removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true)
    for (const name of events) removeEventListener(name, swallow, true)
    for (const el of hidden) el.style.removeProperty('display')
    host.remove()
    resolve(picked)
  }
  window[STOP] = finish
  ui.querySelector('.done').addEventListener('click', (e) => { e.stopPropagation(); finish() })
  addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true)
  for (const name of events) addEventListener(name, swallow, true)
  document.documentElement.appendChild(host)
})`
}

/**
 * An Eraser selector as the picker writes it (`zapScript`): at most four parts joined by `>`, each an id, or a tag with up to two
 * classes and an `:nth-of-type()`. Anything else would be a rule of the Tweak in disguise, and the CSS field is the place for rules.
 */
const ZAP_PART = String.raw`(?:#[A-Za-z][\w-]*|[a-z][a-z0-9_-]*(?:\.[A-Za-z_][\w-]*){0,2}(?::nth-of-type\(\d{1,4}\))?)`
export const ZAP_SELECTOR = new RegExp(`^${ZAP_PART}(?: > ${ZAP_PART}){0,3}$`)

/**
 * The selectors of a Tweak after the Eraser: the new ones join the list, an element chosen twice stays once, and what the page gave back
 * is not trusted (selectors in the form the picker writes only, of a sane length, a bounded number): the page runs the picker's script,
 * and could answer with a rule such as `@import url(x)` that the Tweak would then keep as its own.
 */
export function zapSelectors(existing: readonly string[], picked: unknown): string[] {
  const clean = Array.isArray(picked) ? picked.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 400 && ZAP_SELECTOR.test(s)).slice(0, 200) : []
  return [...new Set([...existing.filter((s) => !clean.includes(s)), ...clean])]
}
