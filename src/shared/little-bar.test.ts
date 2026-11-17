import { describe, expect, it } from 'vitest'
import { acceleratorOf, littleBarBounds, littleExpandedBounds, littleKeyCommand, LITTLE_BAR, type KeyInput } from './little-bar'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, meta: false, shift: false, alt: false, control: false, ...mods })
const area = { x: 0, y: 25, width: 1680, height: 960 }

describe('littleBarBounds', () => {
  it('is 490 x 329, in the middle of the work area', () => {
    expect(littleBarBounds(area)).toEqual({ x: 595, y: 341, width: LITTLE_BAR.width, height: LITTLE_BAR.height })
  })
})

describe('littleExpandedBounds', () => {
  it('grows around its centre: a bar in the middle of the screen becomes a window in the middle of the screen', () => {
    const bar = littleBarBounds(area)
    const next = littleExpandedBounds(bar, { width: 900, height: 650 }, area)
    expect(next).toEqual({ x: 390, y: 181, width: 900, height: 650 })
    expect(next.x + next.width / 2).toBe(bar.x + bar.width / 2)
    // Within a pixel: the half pixels of an odd height are rounded.
    expect(Math.abs(next.y + next.height / 2 - (bar.y + bar.height / 2))).toBeLessThanOrEqual(1)
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
