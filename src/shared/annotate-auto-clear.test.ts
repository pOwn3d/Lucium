// The setting of the automatic clearing of the page annotation (annotate-auto-clear.ts): its choices, its cleaning, the cycle of the bar's timer button,
// and what the state keeps through the reducer. The clock itself is the layer's: page-annotate-layer.test.ts drives it with a simulated clock.

import { describe, expect, it } from 'vitest'
import { AUTO_CLEAR_SECONDS, DEFAULT_AUTO_CLEAR_SECONDS, autoClearOf, autoClearPatch, cleanAutoClearSeconds, isAutoClear, nextAutoClear } from './annotate-auto-clear'
import { defaultSettings } from './model'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'

const ctx: Ctx = { now: 1_700_000_000_000, newId: (() => {
  let n = 0
  return () => `id${++n}`
})() }

describe('the setting of the automatic clearing', () => {
  it('is off by default, with 5 s kept for when it is switched on', () => {
    expect(defaultSettings()).toMatchObject({ annotateAutoClear: false, annotateAutoClearSeconds: 5 })
    expect(DEFAULT_AUTO_CLEAR_SECONDS).toBe(5)
    expect(AUTO_CLEAR_SECONDS).toEqual([3, 5, 10, 20, 30])
    expect(autoClearOf(defaultSettings())).toBe(0)
  })

  // Guard: a delay is one of the choices. Without the bound, a file could clear every mark the moment it is drawn, or keep a timer past what a timer can wait.
  it('brings a number to the nearest choice, and anything else to the default', () => {
    expect(cleanAutoClearSeconds(0)).toBe(3)
    expect(cleanAutoClearSeconds(-40)).toBe(3)
    expect(cleanAutoClearSeconds(0.001)).toBe(3)
    expect(cleanAutoClearSeconds(4)).toBe(3)
    expect(cleanAutoClearSeconds(7)).toBe(5)
    expect(cleanAutoClearSeconds(12)).toBe(10)
    expect(cleanAutoClearSeconds(1e9)).toBe(30)
    for (const seconds of AUTO_CLEAR_SECONDS) expect(cleanAutoClearSeconds(seconds)).toBe(seconds)
    for (const bad of [null, undefined, '10', [], {}, Number.NaN, Infinity, -Infinity, true]) expect(cleanAutoClearSeconds(bad), String(bad)).toBe(5)
  })

  it('reads as the bar shows it: 0 while off, the cleaned delay while on', () => {
    expect(autoClearOf({ annotateAutoClear: false, annotateAutoClearSeconds: 20 })).toBe(0)
    expect(autoClearOf({ annotateAutoClear: true, annotateAutoClearSeconds: 20 })).toBe(20)
    expect(autoClearOf({ annotateAutoClear: true, annotateAutoClearSeconds: 999 })).toBe(30)
    expect(autoClearOf({ annotateAutoClear: 'yes', annotateAutoClearSeconds: 20 })).toBe(0)
  })

  // Guard: the timer button sends 0 or one of the delays, and main takes nothing else (an IPC message is checked again in main).
  it('takes from the bar off or one of the delays, exactly', () => {
    for (const value of [0, ...AUTO_CLEAR_SECONDS]) expect(isAutoClear(value), String(value)).toBe(true)
    for (const bad of [1, 4, 3.5, 60, -3, '5', null, undefined, Number.NaN, {}]) expect(isAutoClear(bad), String(bad)).toBe(false)
  })

  it('cycles on the button: off, 3, 5, 10, 20, 30 s, and off again', () => {
    const seen: number[] = []
    let value = 0
    for (let i = 0; i < 6; i++) seen.push((value = nextAutoClear(value)))
    expect(seen).toEqual([3, 5, 10, 20, 30, 0])
    // A value the cycle does not know goes back to off.
    expect(nextAutoClear(7)).toBe(0)
  })

  // Guard: off keeps the delay, so that switching on again in the Settings finds the one chosen; a delay switches the clearing on.
  it('writes off without forgetting the delay, and a delay with the switch on', () => {
    expect(autoClearPatch(0)).toEqual({ annotateAutoClear: false })
    expect(autoClearPatch(20)).toEqual({ annotateAutoClear: true, annotateAutoClearSeconds: 20 })
  })

  // Guard: the reducer cleans what any window sends (a stale Settings window, a hand-edited file): the delay is one of the choices once in the state.
  it('is bounded by the reducer and on load', () => {
    const state = createInitialState(ctx)
    const set = reduce(state, { type: 'settings/update', patch: { annotateAutoClear: true, annotateAutoClearSeconds: 1 } }, ctx)
    expect(set.settings).toMatchObject({ annotateAutoClear: true, annotateAutoClearSeconds: 3 })
    const far = reduce(state, { type: 'settings/update', patch: { annotateAutoClearSeconds: 86_400 } }, ctx)
    expect(far.settings.annotateAutoClearSeconds).toBe(30)
    const bar = reduce(set, { type: 'settings/update', patch: autoClearPatch(0) }, ctx)
    expect(bar.settings).toMatchObject({ annotateAutoClear: false, annotateAutoClearSeconds: 3 })
    const loaded = normalize({ ...state, settings: { ...state.settings, annotateAutoClear: 'oui', annotateAutoClearSeconds: -1 } } as never)
    expect(loaded.settings).toMatchObject({ annotateAutoClear: false, annotateAutoClearSeconds: 3 })
  })
})
