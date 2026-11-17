import { describe, expect, it } from 'vitest'
import { FIND_TEXT_MAX, REGEX_ERROR_DETAILS, REGEX_ERROR_LABELS, REGEX_PATTERN_MAX, findCounterText, parseFindOptions, regexSearchAllowed } from './regex-find'

describe('parseFindOptions', () => {
  it('keeps the booleans of the find bar and nothing else', () => {
    expect(parseFindOptions({ forward: false, next: true, matchCase: true, regex: true })).toEqual({ forward: false, next: true, matchCase: true, regex: true })
    expect(parseFindOptions({ regex: 'yes', next: 1, forward: null, extra: true, __proto__: { regex: true } })).toEqual({})
  })

  it('is empty for anything that is not an object', () => {
    for (const raw of [undefined, null, 'regex', 3, true, [], [true]]) expect(parseFindOptions(raw), String(raw)).toEqual({})
  })

  it('does not take a flag from the prototype', () => {
    const inherited = Object.create({ regex: true }) as unknown
    expect(parseFindOptions(inherited)).toEqual({})
  })
})

describe('findCounterText', () => {
  it('says ordinal and count, with a "+" when the count stopped', () => {
    expect(findCounterText({ matches: 12, ordinal: 3 })).toBe('3/12')
    expect(findCounterText({ matches: 2000, ordinal: 1, more: true })).toBe('1/2000+')
    expect(findCounterText(null)).toBe('0/0')
    expect(findCounterText(undefined)).toBe('0/0')
  })

  it('says why there is no count, for each reason', () => {
    for (const error of Object.keys(REGEX_ERROR_LABELS) as Array<keyof typeof REGEX_ERROR_LABELS>) {
      expect(findCounterText({ matches: 0, ordinal: 0, error })).toBe(REGEX_ERROR_LABELS[error])
      expect(REGEX_ERROR_DETAILS[error].length).toBeGreaterThan(10)
    }
  })
})

describe('limits', () => {
  it('leave room for an expression in the text the bar sends', () => {
    expect(REGEX_PATTERN_MAX).toBeLessThanOrEqual(FIND_TEXT_MAX)
  })
})

describe('regexSearchAllowed', () => {
  it('needs the request of the bar and the setting', () => {
    expect(regexSearchAllowed({ regex: true }, { findRegex: true })).toBe(true)
    expect(regexSearchAllowed({ regex: true }, { findRegex: false })).toBe(false)
    expect(regexSearchAllowed({}, { findRegex: true })).toBe(false)
    expect(regexSearchAllowed({ regex: false }, { findRegex: true })).toBe(false)
  })
})
