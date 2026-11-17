import { describe, expect, it } from 'vitest'
import { GENERATOR_LENGTH, generatePassword, generatorOptionsOf } from './password-generator'

/** A cryptographic source for the tests (rejection sampling, so every value is as likely as any other). */
function randomInt(below: number): number {
  const word = new Uint32Array(1)
  const limit = Math.floor(2 ** 32 / below) * below
  do crypto.getRandomValues(word)
  while (word[0]! >= limit)
  return word[0]! % below
}

describe('the options', () => {
  it('fall back to the defaults, hold the length to its bounds and keep a class on', () => {
    expect(generatorOptionsOf(undefined)).toEqual({ length: 20, lower: true, upper: true, digits: true, symbols: true, noAmbiguous: false })
    expect(generatorOptionsOf({ length: 3 }).length).toBe(GENERATOR_LENGTH.min)
    expect(generatorOptionsOf({ length: 5000 }).length).toBe(GENERATOR_LENGTH.max)
    expect(generatorOptionsOf({ length: 12.5 }).length).toBe(GENERATOR_LENGTH.default)
    expect(generatorOptionsOf({ length: '30' }).length).toBe(GENERATOR_LENGTH.default)
    // A flag that is not a boolean is the default's, not read as true or false: on for a class, off for the look-alikes.
    expect(generatorOptionsOf({ lower: 'yes' }).lower).toBe(true)
    expect(generatorOptionsOf({ lower: 0, upper: '', noAmbiguous: 'yes' })).toMatchObject({ lower: true, upper: true, noAmbiguous: false })
    const none = generatorOptionsOf({ lower: false, upper: false, digits: false, symbols: false })
    expect([none.lower, none.upper, none.digits, none.symbols].filter(Boolean).length).toBe(1)
  })
})

describe('the password', () => {
  it('has the length asked for and at least one character of every class that is on', () => {
    for (let n = 0; n < 200; n++) {
      const text = generatePassword({ length: 8 }, randomInt)
      expect(text).toHaveLength(8)
      expect(text).toMatch(/[a-z]/)
      expect(text).toMatch(/[A-Z]/)
      expect(text).toMatch(/[0-9]/)
      expect(text).toMatch(/[^a-zA-Z0-9]/)
    }
  })

  it('only uses the classes that are on', () => {
    expect(generatePassword({ length: 40, lower: false, upper: false, digits: true, symbols: false }, randomInt)).toMatch(/^[0-9]{40}$/)
    expect(generatePassword({ length: 40, lower: true, upper: false, digits: false, symbols: false }, randomInt)).toMatch(/^[a-z]{40}$/)
  })

  it('leaves out the characters that look alike when asked', () => {
    for (let n = 0; n < 100; n++) expect(generatePassword({ length: 64, noAmbiguous: true }, randomInt)).not.toMatch(/[O0oIl1|`'"]/)
  })

  it('asks the source for every character, and only the source', () => {
    const asked: number[] = []
    const text = generatePassword({ length: 10, lower: true, upper: false, digits: false, symbols: false }, (below) => {
      asked.push(below)
      return 0
    })
    expect(text).toBe('aaaaaaaaaa')
    // 1 guaranteed + 9 filled + 9 for the shuffle.
    expect(asked).toHaveLength(19)
    expect(asked.every((n) => n >= 1)).toBe(true)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword({}, randomInt)))
    expect(seen.size).toBe(200)
  })
})
