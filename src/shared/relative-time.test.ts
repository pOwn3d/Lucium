import { describe, expect, it } from 'vitest'
import { relativeAgo } from './relative-time'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = 10_000_000_000

describe('how long ago', () => {
  it('uses the largest unit that holds the whole span, in French', () => {
    expect(relativeAgo(now - 20_000, now, 'fr')).toBe('maintenant')
    expect(relativeAgo(now - 5 * MIN, now, 'fr')).toBe('il y a 5 minutes')
    expect(relativeAgo(now - 3 * HOUR, now, 'fr')).toBe('il y a 3 heures')
    expect(relativeAgo(now - 25 * HOUR, now, 'fr')).toBe('hier')
    expect(relativeAgo(now - 5 * DAY, now, 'fr')).toBe('il y a 5 jours')
    expect(relativeAgo(now - 21 * DAY, now, 'fr')).toBe('il y a 3 semaines')
    expect(relativeAgo(now - 90 * DAY, now, 'fr')).toBe('il y a 3 mois')
    expect(relativeAgo(now - 800 * DAY, now, 'fr')).toBe('il y a 2 ans')
  })

  it('speaks the language it is given', () => {
    expect(relativeAgo(now - 3 * HOUR, now, 'en')).toBe('3 hours ago')
    expect(relativeAgo(now - 25 * HOUR, now, 'en')).toBe('yesterday')
  })

  it('reads a date in the future (the clock moved) as now, never as a negative span', () => {
    expect(relativeAgo(now + 5 * HOUR, now, 'fr')).toBe('maintenant')
    expect(relativeAgo(now + 5 * HOUR, now, 'en')).toBe('now')
  })
})
