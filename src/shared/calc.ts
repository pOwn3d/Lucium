// The calculator of the command bar ("12*(3+4)" gives 84). Written by hand on purpose: what is typed in the bar is hostile text until
// proven otherwise, so it is read by a small tokenizer and a recursive-descent parser over a white list of operators, constants and
// functions. Nothing here evaluates text as code (no eval, no Function, no property lookup on a plain object by a typed name).
//
// Syntax: numbers with a point or a comma ("3,5"), + - × ÷ * / ^ (or **) and %, parentheses, the constants and functions of the lists
// below. "%" after a number is a percentage (50% = 0.5); between two operands it is the remainder ("10 % 3"). Inside the parentheses
// of a function call the comma separates arguments ("max(1, 2)"), unless the call separates them with ";" as a French spreadsheet does:
// then the commas are decimal marks ("max(1,5; 2)" is the larger of 1.5 and 2). Everywhere else the comma is the decimal mark. There is no implicit multiplication ("2(3)" and "2pi" are refused) and trigonometry is in radians.

/** Longest text the calculator looks at. */
export const CALC_INPUT_MAX = 200
const TOKENS_MAX = 120
/** Nested parentheses the tokenizer accepts, and levels of recursion the parser accepts (a pair of parentheses costs about three levels). */
const PAREN_DEPTH_MAX = 40
const PARSE_DEPTH_MAX = 80
const ARGS_MAX = 16
const FACTORIAL_MAX = 170

export type CalcFailure =
  | 'empty'
  | 'too-long'
  | 'too-many-tokens'
  | 'too-deep'
  | 'unexpected-character'
  | 'unexpected-token'
  | 'unbalanced'
  | 'leading-zero'
  | 'unknown-name'
  | 'arity'
  | 'division-by-zero'
  | 'not-finite'
  | 'not-a-calculation'

export type CalcOutcome =
  | {
      ok: true
      value: number
      /** The text used the comma as its decimal mark: the answer follows. */
      comma: boolean
      /** An operator, a percentage or a function was applied (a bare "42" or "-5" is no calculation). */
      operations: number
    }
  | { ok: false; reason: CalcFailure }

type Token = { t: 'num'; v: number; comma: boolean } | { t: 'id'; v: string } | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' | '%' } | { t: '(' } | { t: ')' } | { t: 'sep' }

class Refusal extends Error {
  constructor(readonly reason: CalcFailure) {
    super(reason)
  }
}

const CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['π', Math.PI],
  ['tau', Math.PI * 2],
  ['e', Math.E]
])

interface FunctionSpec {
  min: number
  max: number
  run(args: readonly number[]): number
}
const one = (f: (x: number) => number): FunctionSpec => ({ min: 1, max: 1, run: (a) => f(a[0]!) })
const two = (f: (x: number, y: number) => number): FunctionSpec => ({ min: 2, max: 2, run: (a) => f(a[0]!, a[1]!) })
const many = (f: (...values: number[]) => number): FunctionSpec => ({ min: 1, max: ARGS_MAX, run: (a) => f(...a) })

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > FACTORIAL_MAX) throw new Refusal('not-finite')
  let out = 1
  for (let i = 2; i <= n; i++) out *= i
  return out
}

/** The only names a call may use: a typed name that is not here is refused, whatever it looks like. */
const FUNCTIONS = new Map<string, FunctionSpec>([
  ['sqrt', one(Math.sqrt)],
  ['racine', one(Math.sqrt)],
  ['cbrt', one(Math.cbrt)],
  ['abs', one(Math.abs)],
  ['sin', one(Math.sin)],
  ['cos', one(Math.cos)],
  ['tan', one(Math.tan)],
  ['asin', one(Math.asin)],
  ['acos', one(Math.acos)],
  ['atan', one(Math.atan)],
  ['atan2', two(Math.atan2)],
  ['sinh', one(Math.sinh)],
  ['cosh', one(Math.cosh)],
  ['tanh', one(Math.tanh)],
  ['ln', one(Math.log)],
  ['log', one(Math.log10)],
  ['log2', one(Math.log2)],
  ['exp', one(Math.exp)],
  ['floor', one(Math.floor)],
  ['ceil', one(Math.ceil)],
  ['round', one(Math.round)],
  ['trunc', one(Math.trunc)],
  ['sign', one(Math.sign)],
  ['deg', one((x) => (x * 180) / Math.PI)],
  ['rad', one((x) => (x * Math.PI) / 180)],
  ['fact', one(factorial)],
  ['pow', two(Math.pow)],
  ['min', many(Math.min)],
  ['max', many(Math.max)],
  ['hypot', many(Math.hypot)]
])

/** The names the calculator knows, for the documentation and the tests. */
export const CALC_FUNCTIONS: readonly string[] = [...FUNCTIONS.keys()]
export const CALC_CONSTANTS: readonly string[] = [...CONSTANTS.keys()]

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
// Latin letters with accents; × (U+00D7) and ÷ (U+00F7) sit inside that block and are operators.
const isLetter = (c: string | undefined): boolean => c !== undefined && (/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(c) || c === 'π')
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === ' ' || c === ' ' || c === ' '

/** Whether the call whose parenthesis was just read (`from` is the position after it) has a ";" among its own arguments. */
function separatesWithSemicolons(input: string, from: number): boolean {
  let depth = 0
  for (let i = from; i < input.length; i++) {
    const c = input[i]
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return false
      depth--
    } else if (c === ';' && depth === 0) return true
  }
  return false
}

/** The text as tokens. The parenthesis stack lives here because the comma means two things: a decimal mark, or an argument separator. */
function tokenize(input: string): Token[] {
  const out: Token[] = []
  // 'call': the commas separate arguments; 'call;': the call separates them with ";", so the commas are decimal marks; 'group': plain parentheses.
  const contexts: Array<'call' | 'call;' | 'group'> = []
  const push = (token: Token) => {
    if (out.length >= TOKENS_MAX) throw new Refusal('too-many-tokens')
    out.push(token)
  }
  let i = 0
  while (i < input.length) {
    const c = input[i]!
    if (isSpace(c)) {
      i++
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      let j = i
      while (isDigit(input[j])) j++
      if (j - i > 1 && input[i] === '0') throw new Refusal('leading-zero')
      let comma = false
      const mark = input[j]
      // A comma inside the arguments of a call separates them; anywhere else it is the decimal mark.
      if ((mark === '.' || (mark === ',' && contexts.at(-1) !== 'call')) && isDigit(input[j + 1])) {
        comma = mark === ','
        j++
        while (isDigit(input[j])) j++
      }
      if ((input[j] === 'e' || input[j] === 'E') && (isDigit(input[j + 1]) || ((input[j + 1] === '+' || input[j + 1] === '-') && isDigit(input[j + 2])))) {
        j += 2
        while (isDigit(input[j])) j++
      }
      const value = Number(input.slice(i, j).replace(',', '.'))
      if (!Number.isFinite(value)) throw new Refusal('not-finite')
      push({ t: 'num', v: value, comma })
      i = j
      continue
    }
    if (isLetter(c)) {
      let j = i + 1
      while (isLetter(input[j]) || isDigit(input[j])) j++
      push({ t: 'id', v: input.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    i++
    switch (c) {
      case '+':
        push({ t: 'op', v: '+' })
        break
      case '-':
      case '−':
      case '–':
        push({ t: 'op', v: '-' })
        break
      case '*':
        // "**" is the power, as in many languages.
        if (input[i] === '*') {
          i++
          push({ t: 'op', v: '^' })
        } else push({ t: 'op', v: '*' })
        break
      case '×':
        push({ t: 'op', v: '*' })
        break
      case '/':
      case '÷':
        push({ t: 'op', v: '/' })
        break
      case '^':
        push({ t: 'op', v: '^' })
        break
      case '%':
        push({ t: 'op', v: '%' })
        break
      case '(': {
        if (contexts.length >= PAREN_DEPTH_MAX) throw new Refusal('too-deep')
        // A name right before the parenthesis makes it a call; the parser refuses a name that is not a function.
        contexts.push(out.at(-1)?.t !== 'id' ? 'group' : separatesWithSemicolons(input, i) ? 'call;' : 'call')
        push({ t: '(' })
        break
      }
      case ')':
        // A ")" with nothing to close is left to the parser, which refuses it as unbalanced.
        contexts.pop()
        push({ t: ')' })
        break
      case ',':
      case ';': {
        const inside = contexts.at(-1)
        if (inside !== 'call' && !(c === ';' && inside === 'call;')) throw new Refusal('unexpected-character')
        push({ t: 'sep' })
        break
      }
      default:
        throw new Refusal('unexpected-character')
    }
  }
  if (contexts.length > 0) throw new Refusal('unbalanced')
  return out
}

const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new Refusal('not-finite')
  return value
}

class Parser {
  private pos = 0
  private depth = 0
  operations = 0
  comma = false

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const value = this.expression()
    if (this.pos < this.tokens.length) throw new Refusal(this.tokens[this.pos]!.t === ')' ? 'unbalanced' : 'unexpected-token')
    return value
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private operator(...ops: string[]): string | undefined {
    const token = this.peek()
    return token?.t === 'op' && ops.includes(token.v) ? token.v : undefined
  }

  private enter(): void {
    if (++this.depth > PARSE_DEPTH_MAX) throw new Refusal('too-deep')
  }

  private expression(): number {
    let value = this.term()
    for (let op = this.operator('+', '-'); op; op = this.operator('+', '-')) {
      this.pos++
      this.operations++
      const right = this.term()
      value = finite(op === '+' ? value + right : value - right)
    }
    return value
  }

  /** Whether the token after a "%" starts an operand: then the "%" is the remainder, otherwise it is a percentage. */
  private startsOperand(token: Token | undefined): boolean {
    return token?.t === 'num' || token?.t === 'id' || token?.t === '('
  }

  private term(): number {
    let value = this.unary()
    for (;;) {
      const op = this.operator('*', '/') ?? (this.operator('%') && this.startsOperand(this.peek(1)) ? '%' : undefined)
      if (!op) return value
      this.pos++
      this.operations++
      const right = this.unary()
      if ((op === '/' || op === '%') && right === 0) throw new Refusal('division-by-zero')
      value = finite(op === '*' ? value * right : op === '/' ? value / right : value % right)
    }
  }

  private unary(): number {
    this.enter()
    try {
      const sign = this.operator('+', '-')
      if (!sign) return this.power()
      this.pos++
      const value = this.unary()
      return sign === '-' ? -value : value
    } finally {
      this.depth--
    }
  }

  /** "^" binds tighter than the sign on its left ("-2^2" is -4) and groups to the right ("2^3^2" is 2^9). */
  private power(): number {
    const base = this.postfix()
    if (!this.operator('^')) return base
    this.pos++
    this.operations++
    return finite(Math.pow(base, this.unary()))
  }

  private postfix(): number {
    let value = this.primary()
    while (this.operator('%') && !this.startsOperand(this.peek(1))) {
      this.pos++
      this.operations++
      value /= 100
    }
    return value
  }

  private primary(): number {
    const token = this.peek()
    if (!token) throw new Refusal('unexpected-token')
    this.pos++
    switch (token.t) {
      case 'num':
        this.comma ||= token.comma
        return token.v
      case '(': {
        this.enter()
        try {
          const value = this.expression()
          this.close()
          return value
        } finally {
          this.depth--
        }
      }
      case 'id': {
        const spec = FUNCTIONS.get(token.v)
        if (this.peek()?.t !== '(') {
          // A name that is not followed by a parenthesis can only be a constant.
          const constant = CONSTANTS.get(token.v)
          if (constant === undefined) throw new Refusal(spec ? 'unexpected-token' : 'unknown-name')
          return constant
        }
        if (!spec) throw new Refusal('unknown-name')
        this.pos++
        return this.call(spec)
      }
      default:
        throw new Refusal('unexpected-token')
    }
  }

  private close(): void {
    if (this.peek()?.t !== ')') throw new Refusal('unexpected-token')
    this.pos++
  }

  private call(spec: FunctionSpec): number {
    this.enter()
    try {
      const args: number[] = []
      if (this.peek()?.t !== ')') {
        for (;;) {
          args.push(this.expression())
          if (this.peek()?.t !== 'sep') break
          this.pos++
        }
      }
      this.close()
      if (args.length < spec.min || args.length > spec.max) throw new Refusal('arity')
      this.operations++
      return finite(spec.run(args))
    } finally {
      this.depth--
    }
  }
}

/** Reads and computes a text. Never throws: a refusal says why in `reason`. */
export function evaluateExpression(input: string): CalcOutcome {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' }
  if (input.length > CALC_INPUT_MAX) return { ok: false, reason: 'too-long' }
  if (input.trim() === '') return { ok: false, reason: 'empty' }
  try {
    const parser = new Parser(tokenize(input))
    const value = parser.parse()
    // -0 would print as "0" anyway, but a negative zero must not reach the clipboard as "-0".
    return { ok: true, value: value === 0 ? 0 : value, comma: parser.comma, operations: parser.operations }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason }
    // Not a refusal of ours (for instance a stack overflow): the text is refused all the same, and the cause is reported.
    console.warn('[calc] the expression could not be evaluated:', error instanceof Error ? error.message : String(error))
    return { ok: false, reason: 'not-finite' }
  }
}

const NARROW_NO_BREAK_SPACE = ' '

/** The number as it is shown or copied: twelve significant digits (0.1 + 0.2 is 0.3), the decimal mark the user typed, optionally grouped by thousands. */
export function formatCalcNumber(value: number, comma: boolean, group: boolean): string {
  const rounded = Number(value.toPrecision(12))
  const abs = Math.abs(rounded)
  let text = abs >= 1e15 ? rounded.toExponential().replace('e+', 'e') : String(rounded)
  if (group && !text.includes('e')) {
    const [whole = '', fraction] = text.replace('-', '').split('.')
    const grouped = whole.length >= 5 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_NO_BREAK_SPACE) : whole
    text = `${text.startsWith('-') ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
  }
  return comma ? text.replace('.', ',') : text
}

/** What the command bar shows for a text that is a calculation. */
export interface CalcRow {
  /** The answer, for the row. */
  display: string
  /** The answer, for the clipboard: no grouping. */
  copy: string
  /** What was typed, tidied. */
  expression: string
}

/** "2026-10-24", "24/10/2026": dates are not subtractions. */
const DATE_LIKE = /^\d{1,4}([-/.])\d{1,2}\1\d{1,4}$/

/** The row for a text, or null when it is not a calculation: a bare number, a sign and a number, a date, anything refused. */
export function calculatorRow(input: string): CalcRow | null {
  const expression = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : ''
  if (!expression || DATE_LIKE.test(expression)) return null
  const outcome = evaluateExpression(expression)
  if (!outcome.ok || outcome.operations === 0) return null
  return { display: formatCalcNumber(outcome.value, outcome.comma, true), copy: formatCalcNumber(outcome.value, outcome.comma, false), expression }
}

/** What may be put on the clipboard as the answer of a calculation: a number as `formatCalcNumber` writes it, nothing else. */
export const isCalcCopy = (text: unknown): text is string => typeof text === 'string' && text.length <= 40 && /^-?\d+(?:[.,]\d+)?(?:e-?\d+)?$/.test(text)
