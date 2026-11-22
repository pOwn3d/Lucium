import { describe, expect, it } from 'vitest'
import { FIND_TEXT_MAX, REGEX_ERROR_DETAILS, REGEX_ERROR_LABELS, REGEX_PATTERN_MAX, NO_FIND_TOGGLES, allowedFindOptions, findCounterText, findPanelFor, findPattern, findRequest, parseFindOptions, usesOwnEngine } from './regex-find'
import { FIND_PANEL, FIND_PANEL_WIDE } from './ipc'

describe('parseFindOptions', () => {
  it('keeps the booleans of the find bar and nothing else', () => {
    expect(parseFindOptions({ forward: false, next: true, matchCase: true, regex: true, wholeWord: true, accents: false })).toEqual({ forward: false, next: true, matchCase: true, regex: true, wholeWord: true, accents: false })
    expect(parseFindOptions({ regex: 'yes', wholeWord: 'yes', accents: 1, next: 1, forward: null, extra: true, __proto__: { regex: true } })).toEqual({})
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

describe('allowedFindOptions', () => {
  const asked = { forward: true, next: true, matchCase: true, regex: true, wholeWord: true, accents: true }

  it('lets everything through when the setting is on', () => {
    expect(allowedFindOptions(asked, { findRegex: true })).toEqual(asked)
  })

  it('drops the expression, the whole words and the accents when the setting is off, and keeps the rest (the case is Chromium\'s own)', () => {
    expect(allowedFindOptions(asked, { findRegex: false })).toEqual({ forward: true, next: true, matchCase: true })
    expect(usesOwnEngine(allowedFindOptions(asked, { findRegex: false }))).toBe(false)
  })
})

describe('usesOwnEngine', () => {
  it('is for the expression, the whole words and the accents, each alone, and not for a plain or case-sensitive search', () => {
    expect(usesOwnEngine({ regex: true })).toBe(true)
    expect(usesOwnEngine({ wholeWord: true })).toBe(true)
    expect(usesOwnEngine({ accents: true })).toBe(true)
    expect(usesOwnEngine({})).toBe(false)
    expect(usesOwnEngine({ matchCase: true, next: true, forward: false })).toBe(false)
    expect(usesOwnEngine({ regex: false, wholeWord: false, accents: false })).toBe(false)
  })
})

describe('findPattern', () => {
  it('leaves an expression as typed', () => {
    expect(findPattern('a.+b|c', { regex: true })).toBe('a.+b|c')
  })

  it('takes a text literally: every character that means something in an expression is escaped, and the result matches that text and no other', () => {
    for (const text of ['a.b', '(x)', '[a-z]+', 'C++', 'a|b', '^$', '\\d', '{2}', '1*2?']) {
      const pattern = findPattern(text, {})
      expect(new RegExp(pattern, 'u').test(text), text).toBe(true)
      expect(new RegExp(`^${pattern}$`, 'u').test(`${text}x`), text).toBe(false)
    }
    expect(new RegExp(findPattern('a.b', { wholeWord: true }), 'u').test('axb')).toBe(false)
  })

  it('leaves what is not special alone, accents and hyphens included (an escaped hyphen is an error in Unicode mode)', () => {
    expect(findPattern('été-à', {})).toBe('été-à')
  })
})

describe('findPanelFor', () => {
  it('is wider with the buttons of the setting, and the plain panel otherwise', () => {
    expect(findPanelFor({ findRegex: false })).toBe(FIND_PANEL)
    expect(findPanelFor({ findRegex: true })).toBe(FIND_PANEL_WIDE)
    expect(FIND_PANEL_WIDE.width).toBeGreaterThan(FIND_PANEL.width)
    expect(FIND_PANEL_WIDE.height).toBe(FIND_PANEL.height)
  })
})

describe('findRequest', () => {
  it('sends the step alone when the setting is off, whatever the buttons say', () => {
    expect(findRequest({ regex: true, matchCase: true, wholeWord: true, accents: true }, false, { next: true })).toEqual({ next: true })
  })

  it('adds each pressed button and none of the others', () => {
    expect(findRequest(NO_FIND_TOGGLES, true, { next: true, forward: false })).toEqual({ next: true, forward: false })
    expect(findRequest({ ...NO_FIND_TOGGLES, wholeWord: true }, true)).toEqual({ wholeWord: true })
    expect(findRequest({ regex: false, matchCase: true, wholeWord: false, accents: true }, true, { next: true })).toEqual({ next: true, matchCase: true, accents: true })
  })
})
