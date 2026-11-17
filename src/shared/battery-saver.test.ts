import { describe, expect, it } from 'vitest'
import { SAVER_CSS, SAVER_SLEEP_MINUTES, SAVER_THRESHOLD_PERCENT, parsePmsetPercent, saverActive, saverNotice, saverSleepMinutes } from './battery-saver'

describe('when the mode is on', () => {
  const low = { onBattery: true, percent: SAVER_THRESHOLD_PERCENT }

  it('is never on while the setting is off, whatever the charge and whatever was asked', () => {
    expect(saverActive(false, true, low)).toBe(false)
    expect(saverActive(false, false, { onBattery: true, percent: 1 })).toBe(false)
  })

  it('is on when the user asked for it, whatever the charge, on mains power too', () => {
    expect(saverActive(true, true, { onBattery: false, percent: 100 })).toBe(true)
    expect(saverActive(true, true, { onBattery: true, percent: null })).toBe(true)
  })

  it('comes on by itself on battery at the threshold or below, and not above', () => {
    expect(saverActive(true, false, low)).toBe(true)
    expect(saverActive(true, false, { onBattery: true, percent: 5 })).toBe(true)
    expect(saverActive(true, false, { onBattery: true, percent: SAVER_THRESHOLD_PERCENT + 1 })).toBe(false)
  })

  it('does not come on by itself on mains power, however low the charge reads', () => {
    expect(saverActive(true, false, { onBattery: false, percent: 3 })).toBe(false)
  })

  it('does not come on by itself when the charge cannot be read', () => {
    expect(saverActive(true, false, { onBattery: true, percent: null })).toBe(false)
  })
})

describe('the charge in the text of pmset', () => {
  it('is read from the battery line', () => {
    expect(parsePmsetPercent("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t17%; discharging; 1:30 remaining present: true\n")).toBe(17)
    expect(parsePmsetPercent("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true")).toBe(100)
    expect(parsePmsetPercent('\t0%; discharging;')).toBe(0)
  })

  it('is nothing when there is no battery (a desktop) or the text is something else', () => {
    expect(parsePmsetPercent("Now drawing from 'AC Power'\n")).toBeNull()
    expect(parsePmsetPercent('')).toBeNull()
    expect(parsePmsetPercent('150%; weird')).toBeNull()
    expect(parsePmsetPercent('discharging')).toBeNull()
  })
})

describe('what the mode changes', () => {
  it('shortens the delay of the sleep of tabs: the user\'s own if it is shorter, the mode\'s otherwise, and a sleep that was off is switched on', () => {
    expect(saverSleepMinutes(30)).toBe(SAVER_SLEEP_MINUTES)
    expect(saverSleepMinutes(60)).toBe(SAVER_SLEEP_MINUTES)
    expect(saverSleepMinutes(2)).toBe(2)
    expect(saverSleepMinutes(SAVER_SLEEP_MINUTES)).toBe(SAVER_SLEEP_MINUTES)
    expect(saverSleepMinutes(0)).toBe(SAVER_SLEEP_MINUTES)
  })

  it('stops the animations of the pages with a stylesheet that the page cannot override', () => {
    expect(SAVER_CSS).toContain('animation-iteration-count:1!important')
    expect(SAVER_CSS).toContain('animation-duration:.001s!important')
    expect(SAVER_CSS).toContain('transition-duration:.001s!important')
    // Nothing in it can leave the stylesheet.
    expect(SAVER_CSS).not.toMatch(/[<>@{]\s*import|url\(/i)
  })

  it('says it in a notice', () => {
    expect(saverNotice(true)).toBe('Mode économie de batterie activé')
    expect(saverNotice(false)).toBe('Mode économie de batterie désactivé')
  })
})
