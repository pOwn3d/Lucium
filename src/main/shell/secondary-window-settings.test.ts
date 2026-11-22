import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The engine-wide settings are applied by the main window's Browser; a second window hands its changes to it (without it, a privacy
// option turned on from a second window sent `Sec-GPC: 1` only after the main window changed a setting).
// The methods run here on a stand-in (browser-fake.test-support.ts): the shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const state = createInitialState({ now: 0, newId: () => 'x' })
const leaderOf = () => ({ configureBlocker: vi.fn(), configureAutoplay: vi.fn(), configureMinimumFontSize: vi.fn(), configureMediaBridge: vi.fn() })

/** A second window over the same tabs, whose main window is `leader` (itself when it is its own leader). */
function secondWindow(leader: ReturnType<typeof leaderOf> | 'itself') {
  const own: Record<string, unknown> = { isSecondary: () => true, isPrivate: () => false, store: { get: () => state }, extraBlockedHosts: [] }
  const fake = fakeBrowser(own)
  own['leader'] = leader === 'itself' ? fake.self : leader
  return fake
}

describe('the engine-wide settings changed from a second window', () => {
  it('reach the engine: the blocker, privacy, DNS, proxy and fingerprint options are applied by the main window\'s Browser', () => {
    const leader = leaderOf()
    const second = secondWindow(leader)
    shell['configureBlocker']!.call(second.self)
    expect(leader.configureBlocker).toHaveBeenCalledTimes(1)
    // The second window keeps its own pages up to date, and gives the engine nothing itself.
    expect(second.names()).toEqual(['guard.refreshPages', 'refreshBlockerCss'])
  })

  it('reach the engine: the autoplay choice and the media player switch too', () => {
    const leader = leaderOf()
    const second = secondWindow(leader)
    shell['configureAutoplay']!.call(second.self)
    shell['configureMediaBridge']!.call(second.self)
    shell['configureMinimumFontSize']!.call(second.self)
    expect(leader.configureMinimumFontSize).toHaveBeenCalledTimes(1)
    expect(leader.configureAutoplay).toHaveBeenCalledTimes(1)
    expect(leader.configureMediaBridge).toHaveBeenCalledTimes(1)
    expect(second.names()).toEqual([])
  })

  it('never loops: a window that is its own leader does not hand its change to itself', () => {
    const alone = secondWindow('itself')
    expect(() => shell['configureBlocker']!.call(alone.self)).not.toThrow()
    expect(alone.names()).toEqual(['guard.refreshPages', 'refreshBlockerCss'])
  })

  it('a window is a second one when it has a window id and is not private, and takes the main window of its group as its leader', () => {
    expect(shell['isSecondary']!.call({ options: { windowId: 'w2' }, isPrivate: () => false })).toBe(true)
    expect(shell['isSecondary']!.call({ options: { windowId: 'w2' }, isPrivate: () => true })).toBe(false)
    expect(shell['isSecondary']!.call({ options: {}, isPrivate: () => false })).toBe(false)
    const group = new Set<unknown>()
    const main = {}
    const second: Record<string, unknown> = {}
    shell['joinGroup']!.call(second, group, main)
    expect(second['leader']).toBe(main)
    expect(group.has(second)).toBe(true)
  })
})
