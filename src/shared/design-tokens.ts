// What the design tokens (src/renderer/tokens.css) come to for a given scheme, hue and preference, worked out from the stylesheet itself, and the
// pairs of tokens that must stay readable. The stylesheet stays the one source: nothing here repeats a value.
//
//   const values = tokenValues(css, { scheme: 'dark', hue: 140 })
//   pairRatio(values, { fg: 'var(--text-2)', bg: 'var(--surface)' })   -> 8.4
//
// Only what tokens.css uses is understood: `var()`, `light-dark()`, `calc()` of sums, `color-mix(in srgb, ...)` and the colours contrast.ts reads.

import { AA_CONTROL, AA_TEXT, compositeOver, contrastRatio, parseColor, type Rgba } from './contrast'

export type Scheme = 'light' | 'dark'
/** A preference of the system is on either because the system says so (`true`, a media query) or because Réglages forces it (`'forced'`, an attribute of the root). */
export type Preference = boolean | 'forced'

export interface TokenContext {
  scheme: Scheme
  /** The hue of the space, 0..359. */
  hue: number
  /** "Increase contrast": `true` when the system asks for it (the media query), `'forced'` when the setting forces it (the `data-contrast` attribute). */
  contrast?: Preference
  /** "Reduce transparency", the same two ways. */
  transparency?: Preference
}

// ---------- reading the stylesheet ----------

interface Rule {
  /** The conditions of the `@media` it sits in, if any. */
  media: string | null
  selectors: string[]
  declarations: Array<[name: string, value: string]>
}

/** The rules already read, by the text of their sheet. A test asks for the same sheets at hundreds of hues: reading one is most of the cost of a context. */
const parsedSheets = new Map<string, readonly Rule[]>()
/** The cache keeps the sheets of the tests that run, not every variant a long file ever made. */
const PARSED_SHEETS_MAX = 64

/** The rules of a stylesheet, read once for a given text. Nothing may change what it returns. */
function rulesOf(css: string): readonly Rule[] {
  const known = parsedSheets.get(css)
  if (known) return known
  const rules = parseRules(css)
  if (parsedSheets.size >= PARSED_SHEETS_MAX) parsedSheets.delete(parsedSheets.keys().next().value!)
  parsedSheets.set(css, rules)
  return rules
}

/** The rules of a stylesheet, one level of `@media` deep (all tokens.css needs). */
function parseRules(css: string): Rule[] {
  // An `@import` is a statement without a block: left in, it would be read as the start of the selector of the rule that follows it.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\b[^;]*;/g, '')
  const rules: Rule[] = []
  const read = (source: string, media: string | null): void => {
    let i = 0
    while (i < source.length) {
      const open = source.indexOf('{', i)
      if (open < 0) return
      const head = source.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < source.length && depth > 0) {
        depth += source[j] === '{' ? 1 : source[j] === '}' ? -1 : 0
        j++
      }
      const body = source.slice(open + 1, j - 1)
      if (head.startsWith('@media')) read(body, head.slice('@media'.length).trim())
      else {
        const declarations: Array<[string, string]> = []
        for (const declaration of splitTopLevel(body, ';')) {
          const colon = declaration.indexOf(':')
          if (colon > 0) declarations.push([declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()])
        }
        rules.push({ media, selectors: head.split(',').map((s) => s.trim()), declarations })
      }
      i = j
    }
  }
  read(text, null)
  return rules
}

/** `text` cut at the `separator`s that are not inside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Whether a rule applies to an element that is the root of the context (the tokens are measured there). */
function applies(rule: Rule, context: TokenContext): boolean {
  if (rule.media !== null) {
    const wanted = rule.media.replace(/\s+/g, ' ')
    if (wanted === '(prefers-contrast: more)' && context.contrast !== true) return false
    if (wanted === '(prefers-reduced-transparency: reduce)' && context.transparency !== true) return false
    if (!/^\(prefers-(contrast: more|reduced-transparency: reduce)\)$/.test(wanted)) return false
  }
  return rule.selectors.some((selector) => {
    if (selector === ':root' || selector === '.tk-hue' || selector === '.shell' || selector === '.la') return true
    if (selector === ":root[data-contrast='more']") return context.contrast === 'forced'
    // The same variant written by a sheet for the shell of a window (sidebar.css), inside the root that carries the attribute.
    if (selector === ":root[data-contrast='more'] .shell" || selector === ":root[data-contrast='more'] .la") return context.contrast === 'forced'
    if (selector === ":root[data-transparency='reduce']") return context.transparency === 'forced'
    return false
  })
}

// ---------- evaluating a value ----------

/** The first call of `name(` in `text`: where it starts, where it ends (after the closing parenthesis) and its arguments. */
function findCall(text: string, name: string): { start: number; end: number; args: string[] } | null {
  const marker = `${name}(`
  let from = 0
  for (;;) {
    const start = text.indexOf(marker, from)
    if (start < 0) return null
    // `light-dark(` must not be found inside `xlight-dark(`.
    if (start > 0 && /[\w-]/.test(text[start - 1]!)) {
      from = start + 1
      continue
    }
    let depth = 1
    let i = start + marker.length
    while (i < text.length && depth > 0) {
      depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0
      i++
    }
    return { start, end: i, args: splitTopLevel(text.slice(start + marker.length, i - 1), ',') }
  }
}

/** Replaces every `name(...)` of the text, innermost last, by what `replace` makes of its arguments. */
function replaceCalls(text: string, name: string, replace: (args: string[]) => string): string {
  let current = text
  for (let guard = 0; guard < 50; guard++) {
    const call = findCall(current, name)
    if (!call) return current
    current = current.slice(0, call.start) + replace(call.args) + current.slice(call.end)
  }
  throw new Error(`design tokens: too many ${name}() in ${text}`)
}

interface Quantity {
  n: number
  /** `%`, `px`... or '' for a plain number. */
  unit: string
}

/**
 * The value of a math expression of CSS (`calc()`, `min()`, `max()`, `clamp()`, `abs()`, with `+ - * /` and parentheses) on numbers with a
 * unit or none. A sum needs one unit; a product needs a plain number on one side: what the tokens use, and a refusal for anything else.
 */
function mathValue(source: string): Quantity {
  const tokens = source.match(/[a-z-]+\(|\d*\.?\d+(?:[a-z%]+)?|[-+*/(),]/gi) ?? []
  let at = 0
  const fail = (): never => {
    throw new Error(`design tokens: the expression ${source} is not understood`)
  }
  const number = (token: string): Quantity => {
    const parts = /^(\d*\.?\d+)([a-z%]*)$/i.exec(token)
    return parts ? { n: Number(parts[1]), unit: parts[2]! } : fail()
  }
  const add = (a: Quantity, b: Quantity, sign: 1 | -1): Quantity => (a.unit === b.unit ? { n: a.n + sign * b.n, unit: a.unit } : fail())
  const sum = (): Quantity => {
    let value = product()
    while (tokens[at] === '+' || tokens[at] === '-') {
      const sign = tokens[at++] === '+' ? 1 : -1
      value = add(value, product(), sign)
    }
    return value
  }
  const product = (): Quantity => {
    let value = unary()
    while (tokens[at] === '*' || tokens[at] === '/') {
      const times = tokens[at++] === '*'
      const other = unary()
      if (times) value = value.unit === '' ? { n: value.n * other.n, unit: other.unit } : other.unit === '' ? { n: value.n * other.n, unit: value.unit } : fail()
      else value = other.unit === '' && other.n !== 0 ? { n: value.n / other.n, unit: value.unit } : fail()
    }
    return value
  }
  const unary = (): Quantity => {
    if (tokens[at] === '-') {
      at++
      const value = unary()
      return { n: -value.n, unit: value.unit }
    }
    return atom()
  }
  const atom = (): Quantity => {
    const token = tokens[at++]
    if (token === undefined) return fail()
    if (token === '(') {
      const value = sum()
      return tokens[at++] === ')' ? value : fail()
    }
    if (token.endsWith('(')) {
      const args = [sum()]
      while (tokens[at] === ',') {
        at++
        args.push(sum())
      }
      if (tokens[at++] !== ')') fail()
      const unit = args[0]!.unit
      if (args.some((arg) => arg.unit !== unit)) fail()
      const [first, second, third] = args.map((arg) => arg.n) as [number, number, number]
      switch (token.slice(0, -1).toLowerCase()) {
        case 'calc':
          return args.length === 1 ? args[0]! : fail()
        case 'min':
          return { n: Math.min(...args.map((arg) => arg.n)), unit }
        case 'max':
          return { n: Math.max(...args.map((arg) => arg.n)), unit }
        case 'abs':
          return args.length === 1 ? { n: Math.abs(first), unit } : fail()
        case 'clamp':
          return args.length === 3 ? { n: Math.max(first, Math.min(second, third)), unit } : fail()
      }
      return fail()
    }
    return number(token)
  }
  const value = sum()
  return at === tokens.length ? value : fail()
}

/** Every math function of the text (`calc()`, `min()`, `max()`, `clamp()`, `abs()`), outermost first, replaced by its value. */
function evaluateMath(text: string): string {
  let current = text
  for (let guard = 0; guard < 50; guard++) {
    const found = ['calc', 'min', 'max', 'clamp', 'abs'].map((name) => ({ name, call: findCall(current, name) })).filter((entry) => entry.call !== null)
    if (found.length === 0) return current
    const first = found.reduce((a, b) => (b.call!.start < a.call!.start ? b : a))
    const { start, end } = first.call!
    const value = mathValue(current.slice(start, end))
    current = current.slice(0, start) + `${value.n}${value.unit}` + current.slice(end)
  }
  throw new Error(`design tokens: too many math functions in ${text}`)
}

/** `color-mix(in srgb, A p%, B q%)`: mixed premultiplied, as CSS Color 5 does. */
function colorMix(args: string[]): string {
  if (args[0] !== 'in srgb' || args.length !== 3) throw new Error(`design tokens: color-mix(${args.join(', ')}) is not understood`)
  const operands = args.slice(1).map((operand) => {
    const share = /^(.*?)(?:\s+(\d*\.?\d+)%)?$/.exec(operand)!
    const color = parseColor(share[1]!)
    if (!color) throw new Error(`design tokens: color-mix operand ${operand} is not a colour`)
    return { color, share: share[2] === undefined ? null : Number(share[2]) / 100 }
  })
  const [first, second] = operands as [(typeof operands)[number], (typeof operands)[number]]
  const p1 = first.share ?? (second.share === null ? 0.5 : 1 - second.share)
  const p2 = second.share ?? 1 - p1
  const total = p1 + p2
  const [w1, w2] = [p1 / total, p2 / total]
  const alpha = first.color.a * w1 + second.color.a * w2
  const channel = (a: number, b: number): number => (alpha === 0 ? 0 : (a * first.color.a * w1 + b * second.color.a * w2) / alpha)
  const result: Rgba = { r: channel(first.color.r, second.color.r), g: channel(first.color.g, second.color.g), b: channel(first.color.b, second.color.b), a: alpha * (total < 1 ? total : 1) }
  const round = (n: number): number => Math.round(n * 1e6) / 1e6
  return `rgb(${round(result.r)} ${round(result.g)} ${round(result.b)} / ${round(result.a)})`
}

/** The text of a value with every `var()`, `light-dark()`, `calc()` and `color-mix()` worked out for the context. */
function evaluate(value: string, raw: ReadonlyMap<string, string>, scheme: Scheme, depth = 0, resolved?: Map<string, string>): string {
  if (depth > 20) throw new Error(`design tokens: a variable refers to itself in ${value}`)
  let text = replaceCalls(value, 'var', (args) => {
    const name = args[0]!
    const known = resolved?.get(name)
    if (known !== undefined) return known
    const found = raw.get(name)
    if (found !== undefined) {
      const worked = evaluate(found, raw, scheme, depth + 1, resolved)
      resolved?.set(name, worked)
      return worked
    }
    if (args[1] !== undefined) return evaluate(args[1], raw, scheme, depth + 1, resolved)
    throw new Error(`design tokens: ${name} is not defined`)
  })
  text = replaceCalls(text, 'light-dark', (args) => (scheme === 'light' ? args[0]! : args[1]!))
  text = evaluateMath(text)
  text = replaceCalls(text, 'color-mix', colorMix)
  return text
}

// ---------- the tokens of a context ----------

/**
 * Every custom property of tokens.css for a context, as text (colours worked out, `light-dark()` resolved), keyed `--name`.
 * Several sheets are read in the order given, as one sheet made of them end to end would be: each must be whole (no rule or comment cut between two).
 */
export function tokenValues(css: string | readonly string[], context: TokenContext): Map<string, string> {
  const raw = new Map<string, string>()
  for (const sheet of typeof css === 'string' ? [css] : css) {
    for (const rule of rulesOf(sheet)) {
      if (!applies(rule, context)) continue
      for (const [name, value] of rule.declarations) if (name.startsWith('--')) raw.set(name, value)
    }
  }
  raw.set('--hue', String(context.hue))
  // A property is worked out once, however many others refer to it.
  const resolved = new Map<string, string>()
  return new Map([...raw.keys()].map((name) => [name, evaluate(`var(${name})`, raw, context.scheme, 0, resolved)] as const))
}

/** A CSS value (`var(--text)`, `color-mix(in srgb, var(--ok) 16%, transparent)`, `#fff`) as a colour, for the tokens of a context. */
export function colorOf(values: ReadonlyMap<string, string>, expression: string, scheme: Scheme): Rgba {
  const text = evaluate(expression, values, scheme)
  const color = parseColor(text)
  if (!color) throw new Error(`design tokens: ${expression} is not a colour (${text})`)
  return color
}

// ---------- the pairs that must stay readable ----------

export interface TokenPair {
  /** CSS expressions: `var(--text)`, `color-mix(in srgb, var(--ok) 16%, transparent)`. */
  fg: string
  bg: string
  /** What a translucent background lies on; the surface by default. */
  over?: string
  /** 4.5 for text, 3 for large text, icons and the parts of a control. */
  min: number
  /** Where the pair is met, for the message of a failure. */
  use: string
}

const text = (fg: string, bg: string, use: string, over?: string): TokenPair => ({ fg: `var(--${fg})`, bg: `var(--${bg})`, min: AA_TEXT, use, ...(over ? { over: `var(--${over})` } : {}) })
const control = (fg: string, bg: string, use: string): TokenPair => ({ fg: `var(--${fg})`, bg: `var(--${bg})`, min: AA_CONTROL, use })
const tint = (name: string): string => `color-mix(in srgb, var(--${name}) 16%, transparent)`

export const TOKEN_PAIRS: readonly TokenPair[] = [
  // text on the surfaces
  text('text', 'surface', 'body text'),
  text('text', 'surface-2', 'body text on a window background'),
  text('text', 'surface-3', 'text of a button on hover'),
  text('text', 'accent-soft', 'selected row'),
  text('text', 'tile', 'row at rest', 'surface'),
  text('text', 'tile-hover', 'row on hover', 'surface'),
  text('text', 'tile-active', 'pressed or selected tile', 'surface'),
  text('text-2', 'surface', 'secondary text'),
  text('text-2', 'surface-2', 'secondary text on a window background'),
  text('text-2', 'surface-3', 'secondary text on a hovered button'),
  text('text-2', 'tile', 'secondary text of a row', 'surface'),
  text('text-2', 'tile-hover', 'secondary text of a row on hover', 'surface'),
  text('text-3', 'surface', 'help and meta text'),
  text('text-3', 'surface-2', 'help and meta text on a window background'),
  // text on the background of the space
  text('text-on-space', 'space-a', 'sidebar text'),
  text('text-on-space', 'space-b', 'sidebar text'),
  text('text-on-space-2', 'space-a', 'sidebar secondary text'),
  text('text-on-space-2', 'space-b', 'sidebar secondary text'),
  // accent, as text and behind text
  { fg: 'var(--on-accent)', bg: 'var(--accent)', min: AA_TEXT, use: 'primary button' },
  { fg: 'var(--on-accent)', bg: 'var(--accent-strong)', min: AA_TEXT, use: 'primary button on hover' },
  text('accent-text', 'surface', 'link, accent as text'),
  text('accent-text', 'surface-2', 'link on a window background'),
  text('accent-text', 'accent-soft', 'link on a selected row'),
  // meaning, as text
  text('ok', 'surface', 'success text'),
  text('warn', 'surface', 'warning text'),
  text('danger', 'surface', 'error text'),
  text('info', 'surface', 'information text'),
  text('ok', 'surface-2', 'success text on a window background'),
  text('warn', 'surface-2', 'warning text on a window background'),
  text('danger', 'surface-2', 'error text on a window background'),
  text('info', 'surface-2', 'information text on a window background'),
  ...(['ok', 'warn', 'danger', 'info'] as const).map((name): TokenPair => ({ fg: `var(--${name}-ink)`, bg: tint(name), min: AA_TEXT, use: `${name} chip` })),
  // controls and icons: the accent against what it sits on, the glyphs of meaning, the grey of a glyph
  control('accent', 'surface', 'switch on, focus ring, primary button edge'),
  control('accent', 'surface-2', 'switch on, focus ring on a window background'),
  control('danger', 'surface', 'destructive icon'),
  control('ok', 'surface', 'success icon'),
  control('warn', 'surface', 'warning icon'),
  control('info', 'surface', 'information icon'),
  control('text-3', 'surface', 'icon of a button')
]

/** The contrast of a pair for the tokens of a context. */
export function pairRatio(values: ReadonlyMap<string, string>, pair: TokenPair, scheme: Scheme): number {
  const page = colorOf(values, pair.over ?? 'var(--surface)', scheme)
  const bg = colorOf(values, pair.bg, scheme)
  const fg = colorOf(values, pair.fg, scheme)
  return contrastRatio(fg, compositeOver(bg, page), page)
}
