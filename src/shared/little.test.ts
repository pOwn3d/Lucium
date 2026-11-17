import { describe, expect, it } from 'vitest'
import { littleArcExpired, littleDelayParts, littleStrip, littleStripText } from './little'
import { gotoTabCommand, gotoTabTarget, openInCommand, openInTarget } from './little-picker'
import { frenchSpaces } from './french-typography'

describe('littleArcExpired', () => {
  const hour = 3_600_000
  it('expires a window once it has been without activity for the delay, not before', () => {
    expect(littleArcExpired(0, 12 * hour - 1, 12)).toBe(false)
    expect(littleArcExpired(0, 12 * hour, 12)).toBe(true)
  })

  it('never expires with a delay of 0, whatever the age', () => {
    expect(littleArcExpired(0, 1000 * hour, 0)).toBe(false)
  })

  it('never expires a window the pin "Garder ouvert" keeps, however old and whatever the delay', () => {
    expect(littleArcExpired(0, 1000 * hour, 12, true)).toBe(false)
    expect(littleArcExpired(0, 12 * hour, 12, true)).toBe(false)
    // The pin taken off, the window is the forgotten kind again.
    expect(littleArcExpired(0, 12 * hour, 12, false)).toBe(true)
  })
})

describe('the banner of the window', () => {
  it('says the delay while the window can be archived, and that it is kept once the pin is on', () => {
    expect(littleStrip(false, 12)).toEqual({ kind: 'after', hours: 12 })
    expect(littleStrip(true, 12)).toEqual({ kind: 'kept' })
    // The pin wins whatever the delay is.
    expect(littleStrip(true, 0)).toEqual({ kind: 'kept' })
  })

  it('says it is never archived when there is no delay, even for a delay that is not a number', () => {
    expect(littleStrip(false, 0)).toEqual({ kind: 'never' })
    expect(littleStrip(false, Number.NaN)).toEqual({ kind: 'never' })
    expect(littleStrip(false, -3)).toEqual({ kind: 'never' })
  })

  it('writes the delay in hours, and in whole days from 24 h on', () => {
    expect(littleDelayParts(1)).toEqual({ unit: 'hours', n: 1 })
    expect(littleDelayParts(12)).toEqual({ unit: 'hours', n: 12 })
    expect(littleDelayParts(24)).toEqual({ unit: 'days', n: 1 })
    expect(littleDelayParts(168)).toEqual({ unit: 'days', n: 7 })
    expect(littleDelayParts(36)).toEqual({ unit: 'hours', n: 36 })
  })

  it('reads as the design says: "Fermée et archivée après 12 h sans activité"', () => {
    expect(littleStripText(littleStrip(false, 12))).toBe(frenchSpaces('Fermée et archivée après 12 h sans activité'))
    expect(littleStripText(littleStrip(false, 168))).toBe(frenchSpaces('Fermée et archivée après 7 j sans activité'))
    expect(littleStripText(littleStrip(true, 12))).toBe(frenchSpaces('Gardée ouverte : pas d’archivage automatique'))
    expect(littleStripText(littleStrip(false, 0))).toBe('Jamais archivée automatiquement')
  })
})

describe('the commands of the bar that name something', () => {
  it('goto-tab: names the tab the main window goes to, and nothing else is one', () => {
    expect(gotoTabCommand('t1')).toBe('goto-tab:t1')
    expect(gotoTabTarget(gotoTabCommand('t1'))).toBe('t1')
    expect(gotoTabTarget('goto-tab:')).toBeNull()
    expect(gotoTabTarget('open-in:t1')).toBeNull()
    expect(gotoTabTarget('go:goto-tab:t1')).toBeNull()
    expect(openInTarget(gotoTabCommand('t1'))).toBeNull()
    expect(gotoTabTarget(openInCommand('s1'))).toBeNull()
  })
})
