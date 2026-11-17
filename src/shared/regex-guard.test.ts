import { describe, expect, it } from 'vitest'
import { REGEX_STEP_BUDGET, regexHazard, regexTextLimit } from './regex-guard'

describe('a regular expression that comes from an extension', () => {
  // Expressions of the kind request rules carry: none may be refused.
  it.each([
    '^https?://(www\\.)?example\\.com/',
    '^https://[a-z0-9-]+\\.example\\.com/ads?/[0-9]+',
    '^https?://([a-z0-9-]+\\.)*example\\.(com|net|org)/.*[?&]utm_[a-z]+=',
    '^http://a\\.example/(.*)$',
    '/ad[0-9]+\\.(?:js|gif|png)(?:\\?.*)?$',
    '(?:/[^/?#]+){2,}/pixel\\.gif',
    '^https://example\\.com/(?<lang>[a-z]{2})/watch\\?v=([\\w-]{11})',
    '(%20|\\+)+banner',
    '(?:\\d{1,3}\\.){3}\\d{1,3}',
    '^wss?://[^/]*\\.tracker\\.example(:[0-9]+)?/',
    '(\\w+=[^&]*&)*id=',
    '(ab)+c{2,5}\\{x',
    '[(+*]+x',
    'a\\(b+\\)+'
  ])('lets through %s', (source) => {
    expect(regexHazard(source)).toBeNull()
    // And the engine reads it.
    expect(() => new RegExp(source)).not.toThrow()
  })

  it.each([
    ['(a+)+$', 'a repetition inside a repetition'],
    ['^(.*a)*b', 'a repetition inside a repetition'],
    ['([a-z]+)*=', 'a repetition inside a repetition'],
    ['(?:x[a-z]*y*)+', 'a repetition inside a repetition'],
    ['((ab)+)+', 'a repetition inside a repetition'],
    ['(\\w+\\d)+', 'a repetition inside a repetition'],
    ['(a+){12}', 'a repetition inside a repetition'],
    ['(.+/)+$', 'a repetition inside a repetition'],
    ['(a?b?)+$', 'a repeated group whose parts are optional or of several lengths'],
    ['(a{1,2})*$', 'a repeated group whose parts are optional or of several lengths'],
    ['((ab))+', 'a repeated group whose parts are optional or of several lengths'],
    ['(a|aa)+$', 'a repeated choice between parts that can start the same way'],
    ['(\\w|\\d)*$', 'a repeated choice between parts that can start the same way'],
    ['(a|[a-c])*$', 'a repeated choice between parts that can start the same way'],
    ['(ab?|b)+$', 'a repeated choice between parts that are not of a fixed length'],
    ['(a|)+$', 'a repeated choice between parts that are not of a fixed length'],
    ['(a|b+)*$', 'a repeated choice between parts that are not of a fixed length'],
    ['^(?=.*ad)https://', 'a look-around'],
    ['^(?!https://ok\\.example)', 'a look-around'],
    ['(?<=/)ad', 'a look-around'],
    ['(?<!x)ad', 'a look-around'],
    ['(a)\\1', 'a back-reference'],
    ['(?<n>a)\\k<n>', 'a back-reference']
  ])('refuses %s: %s', (source, hazard) => {
    expect(regexHazard(source)).toBe(hazard)
  })

  it('finds the repetition however deep it is, and in a part of a choice', () => {
    expect(regexHazard('^https://(?:a|b(?:c|(d+)+))/')).toBe('a repetition inside a repetition')
    expect(regexHazard('x(?:(?:(?:a*)))*')).toBe('a repetition inside a repetition')
    // The same group, not repeated, is an ordinary one.
    expect(regexHazard('^https://(?:a|b(?:c|(d+)))/')).toBeNull()
    expect(regexHazard('(a+)?(b*)?')).toBeNull()
  })

  it('lets a run be repeated only when the character that closes or opens it cannot be in the run', () => {
    expect(regexHazard('([a-z0-9-]+\\.)*')).toBeNull()
    expect(regexHazard('(/[^/]*)+')).toBeNull()
    expect(regexHazard('(a+b)+')).toBeNull()
    // The dot is in the class, the slash is what `.` matches, the letter is the same in another case: the cut is not unique.
    expect(regexHazard('([a-z0-9.-]+\\.)*')).toBe('a repetition inside a repetition')
    expect(regexHazard('(/.*)+')).toBe('a repetition inside a repetition')
    expect(regexHazard('([a-z]+Z)+')).toBe('a repetition inside a repetition')
    expect(regexHazard('(\\w+_)+')).toBe('a repetition inside a repetition')
    // Several runs, each with its own closing character, and fixed parts between them.
    expect(regexHazard('(x[a-z]+\\.[0-9]{1,3};)+')).toBeNull()
    // A run closed by a part that may be missing, or by a class, is not closed.
    expect(regexHazard('(x[a-z]+\\.?)+')).toBe('a repetition inside a repetition')
    expect(regexHazard('([a-z]+[0-9])+')).toBe('a repetition inside a repetition')
    // A run alone is closed by nothing.
    expect(regexHazard('([a-z]+)+')).toBe('a repetition inside a repetition')
  })

  it('holds a class the engine cannot read as one that matches everything: the group is refused, not let through', () => {
    expect(() => new RegExp('[z-a]')).toThrow()
    expect(regexHazard('([z-a]+x)+')).toBe('a repetition inside a repetition')
  })

  it('does not judge what the engine cannot read at all: building it fails, and the caller says so', () => {
    for (const source of ['(unclosed', 'a)', '[abc', 'trailing\\']) {
      expect(regexHazard(source), source).toBeNull()
      expect(() => new RegExp(source), source).toThrow()
    }
  })

  it('what it lets through runs in no time on the text made to slow it down, where what it refuses would not come back', () => {
    // Each expression with the text that defeats a version of it whose cut is not unique: long, and failing at the very end.
    const cases: Array<[string, string]> = [
      ['^([a-z0-9-]+\\.)*$', `${'a.'.repeat(1500)}!`],
      ['^(/[^/]+)+$', `${'/a'.repeat(1500)}/`],
      ['^(%20|\\+)+$', `${'%20+'.repeat(800)}!`],
      ['^(ab)+$', `${'ab'.repeat(1500)}a`],
      ['^(\\w+=[^&]*&)*id=$', `${'k=v&'.repeat(800)}id=!`],
      ['^(?:\\d{1,3}\\.){3}\\d{1,3}$', `${'1.'.repeat(1500)}`]
    ]
    for (const [source, text] of cases) {
      expect(regexHazard(source), source).toBeNull()
      const started = performance.now()
      expect(new RegExp(source).test(text), source).toBe(false)
      expect(performance.now() - started, source).toBeLessThan(250)
    }
  })

  it('is itself read in a time that follows the length of the expression', () => {
    const long = `${'(a+b)+'.repeat(300)}${'('.repeat(100)}x${')'.repeat(100)}`
    const started = performance.now()
    expect(regexHazard(long)).toBeNull()
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('the longest text a regular expression may be run on', () => {
  const CAP = 4096

  it('an expression without a repetition, or with one the engine goes over once, may be run on any text up to the cap', () => {
    for (const source of [
      'a',
      '^https?://(www\\.)?example\\.com/',
      // Tied to the start, each run closed by a character it cannot hold.
      '^https://[a-z0-9-]+\\.example\\.com/ads?/[0-9]+',
      // What ends the expression never sends the engine back.
      '^http://a\\.example/(.*)$',
      '^https://x\\.example/.*',
      '(?i)^X.*'
    ]) {
      expect(regexTextLimit(source, CAP), source).toBe(CAP)
    }
  })

  it('each repetition the engine can come back to makes the text shorter, and so does an expression that may start anywhere', () => {
    const limits = ['^x.*y', 'x.*y', 'x.*x.*y', 'x.*x.*x.*y', 'x.*x.*x.*x.*y'].map((source) => regexTextLimit(source, 1_000_000))
    // One place to come back to: the work follows the length. Then its square, its cube, and so on.
    expect(limits[0]).toBe(1_000_000)
    expect(limits[1]).toBe(Math.floor(Math.sqrt(REGEX_STEP_BUDGET * 2)))
    expect(limits[2]).toBe(Math.floor(Math.cbrt(REGEX_STEP_BUDGET * 6)))
    expect(limits[3]).toBeLessThan(100)
    expect(limits[4]).toBeLessThan(64)
    expect(regexTextLimit('^x.*x.*y', CAP)).toBe(regexTextLimit('x.*y', CAP))
    // A leading (?i) is no part of the shape, and a wide bounded repetition is a run like another.
    expect(regexTextLimit('(?i)x.*x.*y', CAP)).toBe(regexTextLimit('x.*x.*y', CAP))
    expect(regexTextLimit('x.{0,40}x.{0,40}y', CAP)).toBe(regexTextLimit('x.*x.*y', CAP))
    // Runs inside a group that is not repeated count like the others; a repeated group is one run.
    expect(regexTextLimit('(x.*x.*y)z', CAP)).toBe(regexTextLimit('x.*x.*yz', CAP))
    expect(regexTextLimit('^([a-z0-9-]+\\.)*([a-z0-9-]+\\.)*x$', CAP)).toBe(regexTextLimit('^x.*x.*y', CAP))
  })

  it('short choices multiply: many optional parts in a row leave no text short enough', () => {
    expect(regexTextLimit(`^${'a?'.repeat(10)}b`, CAP)).toBe(CAP)
    expect(regexTextLimit(`^${'a?'.repeat(40)}b`, CAP)).toBe(0)
    expect(regexTextLimit(`${'a?'.repeat(22)}${'a'.repeat(22)}`, CAP)).toBeLessThan(8)
    // A choice between parts that start differently is settled at once; one between parts that can start the same way is tried part after part.
    expect(regexTextLimit('x.*\\.(jpg|png|gif)y', CAP)).toBe(regexTextLimit('x.*\\.jpgy', CAP))
    expect(regexTextLimit('x.*\\.(jpg|jpeg|j2k)y', CAP)).toBeLessThan(regexTextLimit('x.*\\.jpgy', CAP))
  })

  it('at its limit, an expression made to be slow answers in a time that is not felt', () => {
    // Each with the text that sends the engine back the most: it holds every part but the last.
    const cases: Array<[string, (length: number) => string]> = [
      ['x.*y', (length) => 'x'.repeat(length)],
      ['x.*x.*y', (length) => 'x'.repeat(length)],
      ['^x.*x.*x.*y', (length) => 'x'.repeat(length)],
      ['x.*x.*x.*y', (length) => 'x'.repeat(length)],
      ['[a-z]+[a-z]+[0-9]', (length) => 'a'.repeat(length)],
      ['x.{0,40}x.{0,40}y', (length) => 'x'.repeat(length)],
      ['^([a-z0-9-]+\\.)*([a-z0-9-]+\\.)*([a-z0-9-]+\\.)*x$', (length) => 'a.'.repeat(length / 2)],
      [`^${'a?'.repeat(20)}${'a'.repeat(20)}`, () => 'a'.repeat(19)]
    ]
    for (const [source, text] of cases) {
      expect(regexHazard(source), source).toBeNull()
      const limit = regexTextLimit(source, CAP)
      expect(limit, source).toBeGreaterThan(0)
      const started = performance.now()
      expect(new RegExp(source).test(text(limit)), source).toBe(false)
      // A wide bound: a few tens of milliseconds at most are expected, where the same expressions on 4096 characters would take minutes.
      expect(performance.now() - started, source).toBeLessThan(1000)
    }
  })
})
