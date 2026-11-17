// What a link to a group of Réglages does once the category is drawn (settings-anchor.ts), with a group made of the few things it reads.

import { describe, expect, it } from 'vitest'
import { FLASH_MS, FOLD_BODY, inClosedFold, landOnGroup, type LandingGroup, type LandingTimers } from './settings-anchor'

/** A clock the test winds by hand. */
function clock() {
  const pending = new Map<number, () => void>()
  let next = 0
  const timers: LandingTimers = {
    set: (run) => (pending.set(++next, run), next),
    clear: (timer) => void pending.delete(timer as number)
  }
  return { timers, wind: () => [...pending.values()].forEach((run) => run()), count: () => pending.size }
}

/** A group at `offsetTop`, that writes what is done to it in `log`. */
function group(offsetTop: number) {
  const classes = new Set<string>()
  const log: string[] = []
  const element: LandingGroup = {
    offsetTop,
    get offsetWidth() {
      log.push('reflow')
      return 100
    },
    classList: {
      add: (name) => (classes.add(name), void log.push(`add ${name}`)),
      remove: (name) => (classes.delete(name), void log.push(`remove ${name}`))
    }
  }
  return { element, classes, log }
}

describe('the landing of a link on a group of Réglages', () => {
  it('scrolls to the group, 20 px under the top of the category, and lights it', () => {
    const content = { scrollTop: 400 }
    const { element, classes } = group(620)
    landOnGroup(content, element, clock().timers)
    expect(content.scrollTop).toBe(600)
    expect(classes.has('pref-flash')).toBe(true)
  })

  it('tells a group that waits in a closed « Plus de réglages » (the window opens the fold first), and only that one', () => {
    const asked: string[] = []
    const inside = (hidden: boolean | null) => ({ closest: (selector: string) => (asked.push(selector), hidden === null ? null : { hidden }) })
    expect(inClosedFold(inside(true))).toBe(true)
    expect(inClosedFold(inside(false))).toBe(false)
    expect(inClosedFold(inside(null))).toBe(false)
    expect(new Set(asked)).toEqual(new Set([FOLD_BODY]))
  })

  it('lights it for FLASH_MS only', () => {
    const { timers, wind, count } = clock()
    const { element, classes } = group(100)
    landOnGroup({ scrollTop: 0 }, element, timers)
    expect(count()).toBe(1)
    wind()
    expect(classes.has('pref-flash')).toBe(false)
    expect(FLASH_MS).toBeGreaterThan(1000)
  })

  it('lights it again at a second arrival: the class is taken off, the page reflowed, then put back', () => {
    const { element, log } = group(100)
    landOnGroup({ scrollTop: 0 }, element, clock().timers)
    landOnGroup({ scrollTop: 0 }, element, clock().timers)
    expect(log).toEqual(['remove pref-flash', 'reflow', 'add pref-flash', 'remove pref-flash', 'reflow', 'add pref-flash'])
  })

  it('gives back what ends the lighting: the timer is cleared and the group is left as it was', () => {
    const { timers, count } = clock()
    const { element, classes } = group(100)
    const end = landOnGroup({ scrollTop: 0 }, element, timers)
    end()
    expect(count()).toBe(0)
    expect(classes.has('pref-flash')).toBe(false)
  })

  it('starts the category from its top when no group is named or the one named is not there, and lights nothing', () => {
    const content = { scrollTop: 500 }
    const { timers, count } = clock()
    const end = landOnGroup(content, null, timers)
    expect(content.scrollTop).toBe(0)
    expect(count()).toBe(0)
    expect(() => end()).not.toThrow()
  })
})
