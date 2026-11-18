import { describe, expect, it } from 'vitest'
import { buildNumber, isBuildNumber } from './build-number'

describe('buildNumber: a number that grows with every send, kept nowhere', () => {
  it('is a whole number App Store Connect takes', () => {
    const number = buildNumber(new Date('2026-11-18T07:30:00Z'))
    expect(number).toMatch(/^[1-9]\d*$/)
    expect(isBuildNumber(number)).toBe(true)
  })

  it('counts the minutes since 1 January 2026, UTC', () => {
    expect(buildNumber(new Date('2026-01-01T00:01:00Z'))).toBe('1')
    expect(buildNumber(new Date('2026-01-02T00:00:00Z'))).toBe('1440')
  })

  it('is larger at every send, down to the minute (two sends in the same day must differ)', () => {
    const first = Number(buildNumber(new Date('2026-11-18T07:30:00Z')))
    expect(Number(buildNumber(new Date('2026-11-18T07:31:00Z')))).toBeGreaterThan(first)
    expect(Number(buildNumber(new Date('2026-11-18T09:00:00Z')))).toBeGreaterThan(first)
    expect(Number(buildNumber(new Date('2027-01-01T00:00:00Z')))).toBeGreaterThan(Number(buildNumber(new Date('2026-12-31T23:59:00Z'))))
  })

  it('is larger than the 1 the project file starts with', () => {
    expect(Number(buildNumber(new Date('2026-01-01T00:01:00Z')))).toBeGreaterThanOrEqual(1)
  })

  it('refuses a clock set before 2026 instead of making a number lower than the real ones', () => {
    expect(() => buildNumber(new Date('2025-12-31T23:59:00Z'))).toThrow(/before 1 January 2026/)
    expect(() => buildNumber(new Date('invalid'))).toThrow(/before 1 January 2026/)
  })
})

describe('isBuildNumber', () => {
  it('takes whole numbers of one to nine digits without a leading zero', () => {
    for (const ok of ['1', '465123', '999999999']) expect(isBuildNumber(ok)).toBe(true)
    for (const no of ['', '0', '007', '1.2', '-3', '1000000000', 'abc', '12 ']) expect(isBuildNumber(no)).toBe(false)
  })
})
