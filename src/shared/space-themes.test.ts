import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { cleanTheme, defaultTheme, harmonize, type SpaceTheme } from './theme'

const ctx = (): Ctx => {
  let n = 0
  return { now: 1, newId: () => `id${++n}` }
}
const run = (state: SidebarState, ...actions: Action[]) => {
  const c = ctx()
  return actions.reduce((s, a) => reduce(s, a, c), state)
}

const NORD: SpaceTheme = { baseColors: ['#788aa8'], harmony: 'custom', angle: 155, intensity: 1, overlay: 'grain', noise: 0, translucency: 'dark', vibrant: false, appearance: 'dark' }

/** Three spaces with a theme each. */
function threeSpaces(): SidebarState {
  const c = ctx()
  const initial = createInitialState(c)
  return [{ type: 'space/create', name: 'Travail', emoji: '💼', hue: 30 } as const, { type: 'space/create', name: 'Lecture', emoji: '📖', hue: 140 } as const].reduce((s, a) => reduce(s, a, c), initial)
}

describe('space/apply-themes', () => {
  it('gives each listed space its theme in one step and leaves the others alone', () => {
    const s = threeSpaces()
    const [a, b, c] = s.spaces
    const next = run(s, { type: 'space/apply-themes', entries: [{ id: a!.id, theme: NORD }, { id: c!.id, theme: NORD }] })
    expect(next.spaces[0]!.theme).toEqual(NORD)
    expect(next.spaces[2]!.theme).toEqual(NORD)
    expect(next.spaces[1]).toBe(s.spaces[1])
    expect(next.spaces[1]!.theme).toEqual(b!.theme)
    expect(next.spaces.map((x) => x.name)).toEqual(s.spaces.map((x) => x.name))
  })

  it('puts the previous themes back with the same action (what the Annuler button of the toast does)', () => {
    const s = threeSpaces()
    const previous = s.spaces.map((sp) => ({ id: sp.id, theme: sp.theme }))
    const applied = run(s, { type: 'space/apply-themes', entries: s.spaces.map((sp) => ({ id: sp.id, theme: NORD })) })
    expect(applied.spaces.every((sp) => sp.theme.baseColors[0] === '#788aa8')).toBe(true)
    const undone = run(applied, { type: 'space/apply-themes', entries: previous })
    expect(undone.spaces.map((sp) => sp.theme)).toEqual(s.spaces.map((sp) => sp.theme))
  })

  it('repairs every theme like any saved one: a derived harmony follows its first colour, numbers are bounded', () => {
    const s = threeSpaces()
    const next = run(s, { type: 'space/apply-themes', entries: [{ id: s.spaces[0]!.id, theme: { baseColors: ['#ff0000', '#00ff00'], harmony: 'complementary', intensity: 9, angle: -3, noise: Number.NaN } }] })
    const theme = next.spaces[0]!.theme
    expect(theme.baseColors).toEqual(harmonize('#ff0000', 'complementary', 2))
    expect(theme).toMatchObject({ intensity: 1, angle: 0 })
    expect(theme).toEqual(cleanTheme(theme))
  })

  it('keeps what a partial theme does not say', () => {
    const s = threeSpaces()
    const before = s.spaces[1]!.theme
    const next = run(s, { type: 'space/apply-themes', entries: [{ id: s.spaces[1]!.id, theme: { intensity: 0.25 } }] })
    expect(next.spaces[1]!.theme).toEqual({ ...before, intensity: 0.25 })
  })

  it('skips a space that is gone (an undo after the space was deleted) and changes nothing when none is left', () => {
    const s = threeSpaces()
    const next = run(s, { type: 'space/apply-themes', entries: [{ id: 'gone', theme: NORD }, { id: s.spaces[0]!.id, theme: NORD }] })
    expect(next.spaces).toHaveLength(3)
    expect(next.spaces[0]!.theme).toEqual(NORD)
    expect(run(s, { type: 'space/apply-themes', entries: [{ id: 'gone', theme: NORD }] })).toBe(s)
    expect(run(s, { type: 'space/apply-themes', entries: [] })).toBe(s)
  })

  it('ignores anything that is not a list of { id, theme } from the interface, without throwing', () => {
    const s = threeSpaces()
    const id = s.spaces[0]!.id
    const hostile = [
      undefined, null, 'x', 7, {}, [null], [undefined], ['x'], [[]], [{ id }], [{ theme: NORD }], [{ id: 7, theme: NORD }], [{ id, theme: null }], [{ id, theme: 'red' }], [{ id, theme: [NORD] }],
      { length: 1, 0: { id, theme: NORD } }
    ]
    for (const entries of hostile) expect(run(s, { type: 'space/apply-themes', entries } as unknown as Action), JSON.stringify(entries)).toBe(s)
  })

  it('takes the first theme of a space listed twice, and reads no more than a bounded number of entries', () => {
    const s = threeSpaces()
    const id = s.spaces[0]!.id
    const twice = run(s, { type: 'space/apply-themes', entries: [{ id, theme: NORD }, { id, theme: { ...NORD, baseColors: ['#112233'] } }] })
    expect(twice.spaces[0]!.theme.baseColors).toEqual(['#788aa8'])
    const flood = [...Array.from({ length: 200 }, (_, i) => ({ id: `none${i}`, theme: NORD })), { id, theme: NORD }]
    expect(run(s, { type: 'space/apply-themes', entries: flood })).toBe(s)
  })

  it('does not let a forged id or theme key reach the prototype or the other fields of a space', () => {
    const s = threeSpaces()
    const id = s.spaces[0]!.id
    const forged = JSON.parse(`{ "id": "${id}", "theme": { "__proto__": { "polluted": true }, "baseColors": ["#aabbcc"], "name": "evil", "harmony": "custom" } }`)
    const next = run(s, { type: 'space/apply-themes', entries: [forged] })
    expect(next.spaces[0]!.name).toBe(s.spaces[0]!.name)
    expect(Object.keys(next.spaces[0]!.theme).sort()).toEqual(Object.keys(defaultTheme()).sort())
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(next.spaces[0]!.theme.baseColors).toEqual(['#aabbcc'])
  })

  it('is refused by a private window, which keeps no space', () => {
    expect(privateAction({ type: 'space/apply-themes', entries: [] })).toBeNull()
  })
})
