import { describe, expect, it } from 'vitest'
import { afterLook, cleanPrivateIdle, freshPrivateLock, idleLockDue, locked, lockedWindowView, PRIVATE_IDLE_CHOICES, unlocked } from './private-lock'
import { redactForLock } from './lock'
import { createInitialState } from './sidebar'
import type { SidebarState } from './model'
import { createPrivateState } from './private-window'

const MIN = 60_000

describe('the delays', () => {
  it('are the choices of the setting, « never » first; anything else reads as « never »', () => {
    expect(PRIVATE_IDLE_CHOICES[0]).toBe(0)
    for (const choice of PRIVATE_IDLE_CHOICES) expect(cleanPrivateIdle(choice)).toBe(choice)
    for (const raw of [-1, 2, 60, '5', null, undefined, Number.NaN, {}, true]) expect(cleanPrivateIdle(raw), String(raw)).toBe(0)
  })
})

describe('when a private window locks', () => {
  const start = freshPrivateLock(0)

  it('locks once it was left alone for the delay, and not before', () => {
    expect(idleLockDue(start, 5, 5 * MIN - 1, true)).toBe(false)
    expect(idleLockDue(start, 5, 5 * MIN, true)).toBe(true)
  })

  it('never locks with the delay « never », nor while the lock of the application is off (no phrase to open it with)', () => {
    expect(idleLockDue(start, 0, 999 * MIN, true)).toBe(false)
    expect(idleLockDue(start, 5, 999 * MIN, false)).toBe(false)
  })

  it('does not lock a window that is locked already', () => {
    expect(idleLockDue(locked(start), 5, 999 * MIN, true)).toBe(false)
  })

  it('moves the delay up on a click or a key while the window has the focus, and on coming back to it', () => {
    const used = afterLook(start, { now: 4 * MIN, focused: true, lastInputAt: 3 * MIN })
    expect(used.lastActiveAt).toBe(3 * MIN)
    expect(idleLockDue(used, 5, 7 * MIN, true)).toBe(false)
    expect(idleLockDue(used, 5, 8 * MIN, true)).toBe(true)
    expect(afterLook(start, { now: 4 * MIN, focused: false, lastInputAt: 4 * MIN }, true).lastActiveAt).toBe(4 * MIN)
  })

  it('does not count an input made while another window had the focus, nor an input older than the last activity', () => {
    expect(afterLook(start, { now: 4 * MIN, focused: false, lastInputAt: 3 * MIN })).toBe(start)
    const later = afterLook(start, { now: 9 * MIN, focused: true, lastInputAt: 6 * MIN })
    expect(afterLook(later, { now: 9 * MIN, focused: true, lastInputAt: 2 * MIN })).toBe(later)
  })

  it('does not take an input that is in the future of the look', () => {
    expect(afterLook(start, { now: 4 * MIN, focused: true, lastInputAt: 9 * MIN }).lastActiveAt).toBe(4 * MIN)
  })

  it('stays locked whatever is seen, and starts over from the moment it is unlocked', () => {
    const closed = locked(start)
    expect(afterLook(closed, { now: 1 * MIN, focused: true, lastInputAt: 1 * MIN }, true)).toBe(closed)
    const open = unlocked(10 * MIN)
    expect(open).toEqual({ lastActiveAt: 10 * MIN, locked: false })
    expect(idleLockDue(open, 5, 14 * MIN, true)).toBe(false)
    expect(idleLockDue(open, 5, 15 * MIN, true)).toBe(true)
  })
})

describe('what the interface of a locked private window is told', () => {
  const app = { active: true, appLocked: false, lockedSpaces: ['s1'], guardedSpaces: ['s1', 's2'], touchId: true, retryInMs: 3000 }

  it('is the lock of the application covering the window: no space is named, the way in is the one of the lock', () => {
    expect(lockedWindowView(app)).toEqual({ active: true, appLocked: true, lockedSpaces: [], guardedSpaces: [], touchId: true, retryInMs: 3000 })
  })

  it('is nothing while the lock of the application is off', () => {
    expect(lockedWindowView(undefined)).toBeUndefined()
  })

  // The state a private window holds is its own (private-window.ts): once the window is locked the interface is given the skeleton of it, like the application's.
  it('hides the whole state of the private window: no tab, no title, no address', () => {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    const base = createInitialState(ctx)
    const state = createPrivateState({ ...base, tabs: [] }, ctx)
    const withTabs = { ...state, tabs: [{ id: 't1', spaceId: state.spaces[0]!.id, url: 'https://secret.example/private-page', title: 'Une page très privée', pinned: false, private: true }] }
    const shown = redactForLock(withTabs as SidebarState, lockedWindowView(app)!)
    expect(JSON.stringify(shown)).not.toContain('secret.example')
    expect(JSON.stringify(shown)).not.toContain('très privée')
    expect(shown.tabs).toEqual([])
    // The same state, with no lock on the window, shows what it holds.
    expect(JSON.stringify(redactForLock(withTabs as SidebarState, { appLocked: false, lockedSpaces: [] }))).toContain('secret.example')
  })
})
