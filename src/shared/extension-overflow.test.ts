import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_ICON_GAP, ACTION_ICON_WIDTH, EXTENSION_ID, actionIconsWidth, actionListKey, OVERFLOW_BUTTON_WIDTH, UNPINNED_MAX, cleanExtensionBarSettings, cleanUnpinned, planActionBar, rightGroupRoom, samePlan, withPinned } from './extension-overflow'

const id = (n: number): string => String.fromCharCode(97 + (n % 16)).repeat(32)
const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => id(i))

describe('planActionBar', () => {
  it('leaves the bar alone while everything pinned fits (no menu)', () => {
    const order = ids(5)
    expect(planActionBar(order, [], actionIconsWidth(5))).toEqual({ shown: order, overflow: [] })
    expect(planActionBar([], [], 0)).toEqual({ shown: [], overflow: [] })
  })

  it('sends the icons that do not fit to the menu, keeping the first ones, and makes room for the « button', () => {
    const order = ids(6)
    // 4 icons would fit, but the button takes one place: 3 stay.
    const plan = planActionBar(order, [], actionIconsWidth(4) + 4)
    expect(plan.shown).toEqual(order.slice(0, 3))
    expect(plan.overflow).toEqual(order.slice(3))
  })

  it('never shows more than the room allows, however narrow the bar is', () => {
    const order = ids(4)
    for (const room of [0, 10, OVERFLOW_BUTTON_WIDTH, OVERFLOW_BUTTON_WIDTH + ACTION_ICON_WIDTH - 1]) {
      expect(planActionBar(order, [], room)).toEqual({ shown: [], overflow: order })
    }
    expect(planActionBar(order, [], OVERFLOW_BUTTON_WIDTH + ACTION_ICON_WIDTH).shown).toEqual([order[0]])
  })

  it('puts an unpinned extension in the menu even when there is room, and keeps the order of the others', () => {
    const order = ids(4)
    const plan = planActionBar(order, [order[1]!], 10_000)
    expect(plan.shown).toEqual([order[0], order[2], order[3]])
    expect(plan.overflow).toEqual([order[1]])
  })

  it('ignores unpinned ids that are not loaded, and lists an unpinned one in the order of the extensions', () => {
    const order = ids(3)
    expect(planActionBar(order, [id(9)], 10_000)).toEqual({ shown: order, overflow: [] })
    const plan = planActionBar(order, [order[0]!], actionIconsWidth(1) + OVERFLOW_BUTTON_WIDTH)
    expect(plan.overflow).toEqual([order[0], order[2]])
  })

  it('every extension is either in the bar or in the menu, never both, never neither', () => {
    const order = ids(9)
    for (const room of [0, 30, 60, 100, 150, 400]) {
      for (const unpinned of [[], [order[2]!], order.slice(0, 5)]) {
        const plan = planActionBar(order, unpinned, room)
        expect([...plan.shown, ...plan.overflow].sort()).toEqual([...order].sort())
        expect(plan.shown.some((one) => plan.overflow.includes(one))).toBe(false)
        expect(plan.shown.every((one) => !unpinned.includes(one))).toBe(true)
      }
    }
  })

  it('counts the gap between two icons: what stays in the bar, with the « button, never takes more than the room', () => {
    const order = ids(14)
    for (let room = 0; room <= 500; room++) {
      const plan = planActionBar(order, [], room)
      const taken = actionIconsWidth(plan.shown.length) + (plan.overflow.length > 0 ? OVERFLOW_BUTTON_WIDTH : 0)
      if (plan.shown.length > 0) expect(taken, `room ${room}`).toBeLessThanOrEqual(room)
      // ...and no room for one more icon is left unused.
      if (plan.overflow.length > 0) expect(actionIconsWidth(plan.shown.length + 1) + OVERFLOW_BUTTON_WIDTH, `room ${room}`).toBeGreaterThan(room)
    }
    // Four icons and the button are 4 x 24 + 3 x 6 + 24 = 138 px: 137 px keep three.
    expect(planActionBar(order, [], 138).shown).toHaveLength(4)
    expect(planActionBar(order, [], 137).shown).toHaveLength(3)
  })

  it('plans with the sizes the style sheet of the toolbar gives the icons', () => {
    const css = readFileSync(join(__dirname, '../renderer/toolbar.css'), 'utf8')
    expect(/\.page-toolbar browser-action-list \{[^}]*\bgap: (\d+)px/.exec(css)?.[1]).toBe(String(ACTION_ICON_GAP))
    expect(/\.page-toolbar browser-action-list::part\(action\) \{[^}]*\bwidth: (\d+)px/.exec(css)?.[1]).toBe(String(ACTION_ICON_WIDTH))
    expect(/\.tb-overflow \{[^}]*\bwidth: (\d+)px/.exec(css)?.[1]).toBe(String(OVERFLOW_BUTTON_WIDTH))
  })
})

describe('rightGroupRoom', () => {
  it('lets the right group grow to the width of the left one for nothing, then takes half of what the address does not need', () => {
    expect(rightGroupRoom(400, 120)).toBe(120)
    // 1200 - 22 gutter - 180 minimum address = 998, half = 499.
    expect(rightGroupRoom(1200, 110)).toBe(499)
    expect(rightGroupRoom(1200, 600)).toBe(600)
  })

  it('does not go negative on a bar narrower than the address minimum', () => {
    expect(rightGroupRoom(100, 0)).toBeLessThanOrEqual(0)
    expect(Math.max(0, rightGroupRoom(100, 0))).toBe(0)
  })

  it('a default window shows ten icons without a menu, a narrow one does not', () => {
    // Left group: back, forward, reload (3 x 32 + 2 x 5) + 10 px of padding; right group: control centre and split button, 4 px gap.
    const fixed = 32 + 32 + 4 + 4 + 4
    const wide = rightGroupRoom(1100, 116) - fixed
    const narrow = rightGroupRoom(480, 116) - fixed
    expect(planActionBar(ids(10), [], wide).overflow).toEqual([])
    expect(planActionBar(ids(10), [], narrow).overflow.length).toBeGreaterThan(0)
  })
})

describe('the extensions pinned to the bar', () => {
  it('unpins and pins back, each extension once', () => {
    const a = id(0)
    const b = id(1)
    expect(withPinned([], a, false)).toEqual([a])
    expect(withPinned([a], a, false)).toEqual([a])
    expect(withPinned([a, b], a, true)).toEqual([b])
    expect(withPinned([], a, true)).toEqual([])
  })

  it('refuses what is not an extension id', () => {
    expect(withPinned([id(0)], '../etc', false)).toEqual([id(0)])
    expect(withPinned([], '__proto__', false)).toEqual([])
    expect(EXTENSION_ID.test(id(3))).toBe(true)
    expect(EXTENSION_ID.test('A'.repeat(32))).toBe(false)
  })

  it('cleans a saved list: only ids, each once, bounded', () => {
    expect(cleanUnpinned([id(0), id(0), 'nope', 3, null, id(1)])).toEqual([id(0), id(1)])
    expect(cleanUnpinned('not a list')).toEqual([])
    expect(cleanUnpinned({ length: 3 })).toEqual([])
    const many = Array.from({ length: UNPINNED_MAX + 50 }, (_, i) => `${String.fromCharCode(97 + (i % 16))}${String.fromCharCode(97 + Math.floor(i / 16) % 16)}`.padEnd(32, 'a'))
    expect(cleanUnpinned(many)).toHaveLength(UNPINNED_MAX)
  })

  it('keeps the list within its bound when the user keeps unpinning', () => {
    const idAt = (i: number) => `${String.fromCharCode(97 + (i % 16))}${String.fromCharCode(97 + Math.floor(i / 16) % 16)}`.padEnd(32, 'b')
    let list: string[] = []
    for (let i = 0; i < UNPINNED_MAX + 10; i++) list = withPinned(list, idAt(i), false)
    // The oldest go: the extension the user has just unpinned is always in the list, or unpinning it would do nothing.
    expect(list).toHaveLength(UNPINNED_MAX)
    expect(list[0]).toBe(idAt(10))
    expect(list.at(-1)).toBe(idAt(UNPINNED_MAX + 9))
  })
})

describe('the settings of the extensions bar', () => {
  it('defaults: the menu on (every icon shows until they do not fit), the data APIs on, the user scripts off', () => {
    const d = defaultSettings()
    expect([d.extensionOverflow, d.unpinnedExtensions, d.extensionDataApis, d.userScripts]).toEqual([true, [], true, false])
  })

  it('repairs what a damaged file holds', () => {
    const clean = cleanExtensionBarSettings({ extensionOverflow: 3 as unknown as boolean, unpinnedExtensions: 'x' as unknown as string[], extensionDataApis: null as unknown as boolean, userScripts: 'yes' as unknown as boolean })
    expect(clean).toEqual({ extensionOverflow: true, unpinnedExtensions: [], extensionDataApis: true, userScripts: false })
    expect(cleanExtensionBarSettings({ extensionOverflow: false, unpinnedExtensions: [id(2)], extensionDataApis: false, userScripts: true })).toEqual({ extensionOverflow: false, unpinnedExtensions: [id(2)], extensionDataApis: false, userScripts: true })
  })
})

describe('samePlan', () => {
  it('tells whether the toolbar has anything to rewrite', () => {
    const plan = { shown: ['a'], overflow: ['b'] }
    expect(samePlan(null, plan)).toBe(false)
    expect(samePlan({ shown: ['a'], overflow: ['b'] }, plan)).toBe(true)
    expect(samePlan({ shown: ['a'], overflow: [] }, plan)).toBe(false)
    expect(samePlan({ shown: ['b'], overflow: ['a'] }, plan)).toBe(false)
  })
})

describe('actionListKey', () => {
  const partition = 'persist:profile-work'
  const mine = { profileId: 'work', enabled: true }

  it('changes when the first extension of the profile is loaded, so that the list registers with a runtime that now exists', () => {
    expect(actionListKey(partition, 'work', [])).not.toBe(actionListKey(partition, 'work', [mine]))
    // Switched off or listed in another profile: the profile has nothing loaded.
    expect(actionListKey(partition, 'work', [{ profileId: 'work', enabled: false }])).toBe(actionListKey(partition, 'work', []))
    expect(actionListKey(partition, 'work', [{ profileId: 'home', enabled: true }])).toBe(actionListKey(partition, 'work', []))
  })

  it('stays the same while the profile keeps at least one extension (no list made again for each install or update)', () => {
    expect(actionListKey(partition, 'work', [mine])).toBe(actionListKey(partition, 'work', [mine, { profileId: 'work', enabled: true }, { profileId: 'home', enabled: true }]))
  })

  it('is not shared by two profiles', () => {
    expect(actionListKey('persist:profile-a', 'a', [{ profileId: 'a', enabled: true }])).not.toBe(actionListKey('persist:profile-b', 'b', [{ profileId: 'a', enabled: true }]))
  })
})
