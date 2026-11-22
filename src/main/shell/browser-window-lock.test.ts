// A private window left alone holds a lock of its own (shared/private-lock.ts) and the real methods of the class Browser apply it: the interface is given the skeleton of the
// state and the lock screen (`snapshot`), the pages of the window do not exist (`isTabLocked`), what is open over the window goes (`onLockChange`), and nothing opens over the
// lock screen (`openOverlay`). Run on a stand-in of the window (browser-fake.test-support.ts), as saver-snapshot.test.ts and lock-wiring.test.ts do.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { LockView } from '@shared/lock'
import { fakeBrowser, methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
const { Browser } = await import('./browser')
const { setLockService } = await import('../lock-service')
const shell = methodsOf(Browser.prototype)

const SECRET = 'une-page-privee-secrete'

/** The lock of the application, on, with the application itself not locked: a private window left alone is covered by its own lock only. */
function applicationLockOn(): void {
  const view: LockView = { active: true, appLocked: false, lockedSpaces: [], guardedSpaces: [], touchId: false, retryInMs: 0 }
  setLockService({ isActive: () => true, isAppLocked: () => false, isSpaceLocked: () => false, lockedSpaces: () => [], view: () => view } as never)
}

/** A private window whose lock is locked or not, holding a tab that names a secret. */
function privateWindow(locked: boolean) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const state = { ...base, tabs: [{ id: 't1', spaceId: base.spaces[0]!.id, url: `https://${SECRET}.example/`, title: SECRET, pinned: false, private: true, createdAt: 1, lastActiveAt: 1 }] }
  const fake = fakeBrowser({
    store: { get: () => state },
    mediaPlayers: [],
    peek: null,
    sidePanel: null,
    webPanel: null,
    toast: null,
    floatVisible: false,
    overlayRequest: null,
    find: null,
    // The life of the tabs, as the window reads it before it hands it to the interface.
    runtimeOfGroup: () => ({ tabs: { t1: { loading: false } } }),
    withBackCloses: (runtime: unknown) => runtime,
    withReloadAt: (runtime: unknown) => runtime,
    withReloadMarks: (runtime: unknown) => runtime,
    isPrivate: () => true,
    isWindowLocked: () => locked,
    // The real answer of a window about its tabs: the lock decides.
    isTabLocked: shell['isTabLocked']
  })
  fake.self['isTabLocked'] = (tab: { spaceId: string }) => shell['isTabLocked']!.call(fake.self, tab)
  return { fake, state }
}

afterEach(() => setLockService(null))

describe('a private window covered by its own lock', () => {
  it('is given the skeleton of its state and the lock screen, with nothing of the page it held', () => {
    applicationLockOn()
    const snapshot = shell['snapshot']!.call(privateWindow(true).fake.self) as { state: { tabs: unknown[] }; lock?: LockView }
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(snapshot.state.tabs).toEqual([])
    expect(snapshot.lock).toMatchObject({ active: true, appLocked: true, lockedSpaces: [] })
  })

  it('is given its state as it is once it is open again (the check above is not empty)', () => {
    applicationLockOn()
    const snapshot = shell['snapshot']!.call(privateWindow(false).fake.self) as { state: { tabs: unknown[] }; lock?: LockView }
    expect(JSON.stringify(snapshot)).toContain(SECRET)
    expect(snapshot.lock).toMatchObject({ appLocked: false })
  })

  it('has no page for any of its tabs while it is locked, and has them once it is open', () => {
    applicationLockOn()
    expect(shell['isTabLocked']!.call(privateWindow(true).fake.self, { spaceId: 'any' })).toBe(true)
    expect(shell['isTabLocked']!.call(privateWindow(false).fake.self, { spaceId: 'any' })).toBe(false)
  })

  it('has no page to lock with no lock service at all, so a window that holds a lock of its own is still covered', () => {
    expect(shell['isTabLocked']!.call(privateWindow(true).fake.self, { spaceId: 'any' })).toBe(true)
    expect(shell['isTabLocked']!.call(privateWindow(false).fake.self, { spaceId: 'any' })).toBe(false)
  })

  it('opens no panel over its lock screen: the command bar, the history', () => {
    applicationLockOn()
    for (const request of [{ panel: 'commandbar', mode: 'new', initial: '' }, { panel: 'history' }]) {
      const fake = overlayHost({}, { isPrivate: () => false, isWindowLocked: () => true })
      shell['openOverlay']!.call(fake.self, request)
      expect(showedPanel(fake, request.panel), request.panel).toBe(false)
    }
  })

  it('opens the same panels once it is open again', () => {
    applicationLockOn()
    const fake = overlayHost({}, { isWindowLocked: () => false })
    shell['openOverlay']!.call(fake.self, { panel: 'commandbar', mode: 'new', initial: '' })
    expect(showedPanel(fake, 'commandbar')).toBe(true)
  })

  it('closes what is open over it when its lock comes down, and drops the pages of its tabs', () => {
    applicationLockOn()
    const { fake } = privateWindow(true)
    const destroyed: string[] = []
    Object.assign(fake.self, {
      engine: { reconsiderTabCaptures: () => {} },
      pages: new Map([['t1', {}]]),
      destroyPage: (id: string) => void destroyed.push(id),
      destroyWebPanel: () => {},
      destroyPeek: () => void destroyed.push('peek'),
      destroySidePanel: () => void destroyed.push('side-panel'),
      closeOverlay: () => void destroyed.push('overlay'),
      endFind: () => {},
      thumbnailSource: null,
      webPanel: null,
      privateLock: { follow: () => {} },
      sync: () => void destroyed.push('sync')
    })
    shell['onLockChange']!.call(fake.self)
    expect(destroyed).toEqual(['t1', 'overlay', 'peek', 'side-panel', 'sync'])
  })
})
