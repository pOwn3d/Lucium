// The password generator of the panel. Pure: the source of randomness is handed in (the main process gives it `crypto.randomInt`, a test gives
// a fixed one), so that nothing here can quietly fall back to `Math.random`.

export interface GeneratorOptions {
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
  /** Leaves out the characters that look alike (O 0 o, I l 1 |). */
  noAmbiguous: boolean
}

export const GENERATOR_LENGTH = { min: 8, max: 128, default: 20 } as const

export const DEFAULT_GENERATOR: GeneratorOptions = { length: GENERATOR_LENGTH.default, lower: true, upper: true, digits: true, symbols: true, noAmbiguous: false }

/**
 * The length a text typed in the field of the generator stands for: held to the bounds, the default's when the text is not a number. Read when
 * the field is left or the button pressed, never at each key: held at each key, « 3 » became 8 and « 32 » could not be typed.
 */
export function generatorLengthOf(text: string): number {
  const typed = Math.round(Number(text.trim()))
  if (text.trim() === '' || !Number.isFinite(typed)) return GENERATOR_LENGTH.default
  return Math.min(GENERATOR_LENGTH.max, Math.max(GENERATOR_LENGTH.min, typed))
}

const AMBIGUOUS = new Set('O0oIl1|`\'"')
const CLASSES = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&()*+,-./:;<=>?@[]^_{}~'
} as const

/** The options from anything a request carries: a missing or wrong field is the default's, the length is held to its bounds, and at least one class stays on. */
export function generatorOptionsOf(raw: unknown): GeneratorOptions {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof GeneratorOptions, fallback: boolean): boolean => (typeof r[key] === 'boolean' ? (r[key] as boolean) : fallback)
  const asked = r['length']
  const length = typeof asked === 'number' && Number.isInteger(asked) ? Math.min(GENERATOR_LENGTH.max, Math.max(GENERATOR_LENGTH.min, asked)) : GENERATOR_LENGTH.default
  const options: GeneratorOptions = {
    length,
    lower: flag('lower', true),
    upper: flag('upper', true),
    digits: flag('digits', true),
    symbols: flag('symbols', true),
    noAmbiguous: flag('noAmbiguous', false)
  }
  return options.lower || options.upper || options.digits || options.symbols ? options : { ...options, lower: true }
}

/** The characters of each class that is on, ambiguous ones taken out when asked. */
function pools(options: GeneratorOptions): string[] {
  const keep = (chars: string): string => (options.noAmbiguous ? [...chars].filter((c) => !AMBIGUOUS.has(c)).join('') : chars)
  return (['lower', 'upper', 'digits', 'symbols'] as const).filter((name) => options[name]).map((name) => keep(CLASSES[name]))
}

/** `randomInt(n)` gives an integer from 0 to n - 1, uniformly, from a cryptographic source. */
export type RandomInt = (below: number) => number

/** A password of the requested length with at least one character of every class that is on; the order is shuffled (Fisher-Yates) so the guaranteed ones are not at the front. */
export function generatePassword(raw: unknown, randomInt: RandomInt): string {
  const options = generatorOptionsOf(raw)
  const classes = pools(options)
  const all = classes.join('')
  const chars = classes.map((pool) => pool[randomInt(pool.length)]!)
  while (chars.length < options.length) chars.push(all[randomInt(all.length)]!)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const swap = chars[i]!
    chars[i] = chars[j]!
    chars[j] = swap
  }
  return chars.join('')
}
