import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALWAYS_ON_TOP_LEVEL, isKeptOnTop, toggleKeptOnTop, type OnTopWindow } from './always-on-top'

/** A window that records the calls it gets. */
function fakeWindow(destroyed = false) {
  const calls: unknown[][] = []
  let on = false
  const win: OnTopWindow = {
    isDestroyed: () => destroyed,
    isAlwaysOnTop: () => on,
    setAlwaysOnTop: (flag: boolean, level?: string) => {
      on = flag
      calls.push([flag, level])
    }
  }
  return { win, calls }
}

describe('always on top', () => {
  it('keeps a window in front at the level of the mini window, then lets it go', () => {
    const { win, calls } = fakeWindow()
    expect(toggleKeptOnTop(win)).toBe(true)
    expect(isKeptOnTop(win)).toBe(true)
    expect(toggleKeptOnTop(win)).toBe(false)
    expect(isKeptOnTop(win)).toBe(false)
    expect(calls).toEqual([[true, 'floating'], [false, undefined]])
  })

  it('leaves a window that is gone alone', () => {
    const { win, calls } = fakeWindow(true)
    expect(toggleKeptOnTop(win)).toBe(false)
    expect(isKeptOnTop(win)).toBe(false)
    expect(calls).toEqual([])
  })

  it('uses the level the mini window sits at (little.ts), so the floating windows keep their order among themselves', () => {
    const little = readFileSync(new URL('./little.ts', import.meta.url), 'utf8')
    expect(little).toContain(`setAlwaysOnTop(true, '${ALWAYS_ON_TOP_LEVEL}')`)
  })
})
