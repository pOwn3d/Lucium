// A space locked alone (its own lock, or the sleep of the Mac while the application is not locked as a whole): what is open over the window goes
// with its pages. The real `onLockChange` of the shell runs on a stand-in for the window (browser-fake.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const { setLockService } = await import('../lock-service')
const shell = methodsOf(Browser.prototype)

const state = createInitialState({ now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() })

/** A window on the first space, with a preview, a side panel and a search open, and `panel` over it. */
function windowWith(panel: string | null, lock: { app?: boolean; spaces?: string[] }) {
  setLockService({ isAppLocked: () => lock.app === true, isSpaceLocked: (id: string) => (lock.spaces ?? []).includes(id) } as never)
  const fake = fakeBrowser({
    store: { get: () => state },
    pages: new Map(),
    webPanel: null,
    find: { text: 'mot' },
    overlayRequest: panel === null ? null : { panel },
    isTabLocked: shell['isTabLocked']
  })
  shell['onLockChange']!.call(fake.self)
  return fake.names()
}

afterEach(() => setLockService(null))

describe('what is open over the window when a lock changes', () => {
  it('goes when the space on screen is locked alone: the panel, the preview, the side panel and the search', () => {
    const calls = windowWith('commandbar', { spaces: [state.activeSpaceId] })
    expect(calls).toEqual(expect.arrayContaining(['closeOverlay', 'destroyPeek', 'destroySidePanel', 'endFind']))
    expect(calls.at(-1)).toBe('sync')
  })

  it('leaves a question that has to be answered where it is, and still ends the preview', () => {
    for (const panel of ['passphrase', 'dialog', 'permission', 'auth']) {
      const calls = windowWith(panel, { spaces: [state.activeSpaceId] })
      expect(calls, panel).not.toContain('closeOverlay')
      expect(calls, panel).toEqual(expect.arrayContaining(['destroyPeek', 'destroySidePanel']))
    }
  })

  it('stays when another space is locked, or none', () => {
    for (const lock of [{ spaces: ['another-space'] }, {}]) {
      const calls = windowWith('commandbar', lock)
      expect(calls).not.toContain('closeOverlay')
      expect(calls).not.toContain('destroyPeek')
      expect(calls).not.toContain('destroySidePanel')
      expect(calls).not.toContain('endFind')
      expect(calls).toContain('sync')
    }
  })

  it('goes whole when the application is locked, a question included', () => {
    const calls = windowWith('passphrase', { app: true })
    expect(calls).toEqual(expect.arrayContaining(['closeOverlay', 'destroyPeek', 'destroySidePanel', 'endFind']))
  })
})
