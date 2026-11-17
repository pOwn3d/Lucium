import { describe, expect, it } from 'vitest'
import { acceleratorOf, littleBarBounds, littleExpandedBounds, littleKeyCommand, LITTLE_BAR, type KeyInput } from './little-bar'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, meta: false, shift: false, alt: false, control: false, ...mods })
const area = { x: 0, y: 25, width: 1680, height: 960 }

describe('littleBarBounds', () => {
  it('is 490 x 329, 20 px from the top and right edges of the work area', () => {
    expect(littleBarBounds(area)).toEqual({ x: 1680 - 490 - 20, y: 45, width: LITTLE_BAR.width, height: LITTLE_BAR.height })
  })
})

describe('littleExpandedBounds', () => {
  it('keeps the top and the right edge and grows toward the left and the bottom', () => {
    const bar = littleBarBounds(area)
    const next = littleExpandedBounds(bar, { width: 900, height: 650 }, area)
    expect(next.x + next.width).toBe(bar.x + bar.width)
    expect(next.y).toBe(bar.y)
    expect(next).toMatchObject({ width: 900, height: 650 })
  })

  it('stays inside the work area when the window was left near an edge', () => {
    expect(littleExpandedBounds({ x: 100, y: 40, width: 490, height: 329 }, { width: 900, height: 650 }, area).x).toBe(0)
    expect(littleExpandedBounds({ x: 1000, y: 800, width: 490, height: 329 }, { width: 900, height: 650 }, area).y).toBe(25 + 960 - 650)
    expect(littleExpandedBounds({ x: 0, y: 25, width: 490, height: 329 }, { width: 5000, height: 5000 }, area)).toMatchObject({ width: 1680, height: 960 })
  })
})

describe('acceleratorOf', () => {
  it('spells the key with its modifiers, and nothing without ⌘ or ⌃', () => {
    expect(acceleratorOf(key('r', { meta: true }))).toBe('CmdOrCtrl+R')
    expect(acceleratorOf(key('C', { meta: true, shift: true }))).toBe('CmdOrCtrl+Shift+C')
    expect(acceleratorOf(key('[', { meta: true }))).toBe('CmdOrCtrl+[')
    expect(acceleratorOf(key('r'))).toBeNull()
    expect(acceleratorOf(key('r', { shift: true }))).toBeNull()
  })
})

describe('littleKeyCommand', () => {
  it('maps ⌘O, ⇧⌘C, ⌘R, ⌘[ and ⌘] to the window commands', () => {
    expect(littleKeyCommand(key('o', { meta: true }), undefined)).toBe('open-in-main')
    expect(littleKeyCommand(key('c', { meta: true, shift: true }), undefined)).toBe('copy-url')
    expect(littleKeyCommand(key('r', { meta: true }), undefined)).toBe('reload')
    expect(littleKeyCommand(key('[', { meta: true }), undefined)).toBe('back')
    expect(littleKeyCommand(key(']', { meta: true }), undefined)).toBe('forward')
  })

  it('follows the shortcuts the user chose, and lets every other key go to the page', () => {
    expect(littleKeyCommand(key('j', { meta: true }), { reload: 'CmdOrCtrl+J' })).toBe('reload')
    expect(littleKeyCommand(key('r', { meta: true }), { reload: 'CmdOrCtrl+J' })).toBeNull()
    expect(littleKeyCommand(key('r', { meta: true }), { reload: '' })).toBeNull()
    expect(littleKeyCommand(key('a', { meta: true }), undefined)).toBeNull()
    expect(littleKeyCommand(key('r'), undefined)).toBeNull()
    // ⌘⌥O is not ⌘O.
    expect(littleKeyCommand(key('o', { meta: true, alt: true }), undefined)).toBeNull()
  })
})
