// The channels of the Extensions page are registered with each window (`registerIpc`) and let go with it: a window that is gone no longer answers for the web contents it held.
// Run on the real `registerIpc` over a fake Electron (ipc-fake.test-support.ts), with a window that holds one web contents showing the page.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { InternalChannel } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { invokeFrom, ipcHost } from './ipc-fake.test-support'

vi.mock('electron', async () => {
  const { fakeElectron } = await import('./ipc-fake.test-support')
  return fakeElectron()
})

const { registerIpc } = await import('./ipc')
const { setLockService } = await import('../lock-service')

const PAGE_CONTENTS = 5
const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {}, root: () => store, dispatch: () => {} } as never
const browser = fakeBrowser({
  snapshot: () => ({ state, runtime: { tabs: {} }, extensions: [] }),
  isPrivate: () => false,
  internalPageTab: (id: number) => (id === PAGE_CONTENTS ? { url: 'lucium-ui://extensions/', private: false, container: false, profileSession: true } : null)
})

let warn: MockInstance<(...args: unknown[]) => void>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>
})
afterEach(() => vi.restoreAllMocks())

describe('the Extensions page channels of a window', () => {
  it('answer the web contents the window holds while it lives (the message reaches the gate of the page), and are let go with it', () => {
    const release = registerIpc(browser.self as never, store, {} as never, new Set([1]))
    const lines = (): string[] => warn.mock.calls.map((call) => String(call[0]))
    // The window holds that web contents: the message reaches the handler, whose gate says why it is not the page (this fake sender has no frame of the page).
    invokeFrom(PAGE_CONTENTS, InternalChannel.getSnapshot)
    expect(lines().some((line) => line.startsWith(`[internal-page] ${InternalChannel.getSnapshot} refused`))).toBe(true)
    expect(lines().some((line) => line.startsWith('[ipc] ignored'))).toBe(false)
    warn.mockClear()
    // Another web contents is nobody's here: the door says it is a stranger.
    invokeFrom(99, InternalChannel.getSnapshot)
    expect(lines().some((line) => line.startsWith(`[ipc] ignored ${InternalChannel.getSnapshot} from untrusted sender`))).toBe(true)
    warn.mockClear()
    // The window closes: its registration is let go, and the same web contents is a stranger.
    release()
    invokeFrom(PAGE_CONTENTS, InternalChannel.getSnapshot)
    expect(lines().some((line) => line.startsWith(`[ipc] ignored ${InternalChannel.getSnapshot} from untrusted sender`))).toBe(true)
    expect(lines().some((line) => line.startsWith('[internal-page]'))).toBe(false)
    expect(ipcHost.handle.has(InternalChannel.getSnapshot)).toBe(true)
  })
})

describe('what the window does for the page', () => {
  /** A message from the top frame of the page itself, which the gate lets through. */
  const fromPage = (channel: string, ...args: unknown[]): unknown => {
    const frame = { origin: 'lucium-ui://extensions', url: 'lucium-ui://extensions/', parent: null }
    const event = { sender: { id: PAGE_CONTENTS, mainFrame: frame, getURL: () => 'lucium-ui://extensions/' }, senderFrame: frame }
    const listener = ipcHost.handle.get(channel) ?? ipcHost.on.get(channel)!
    return listener(event, ...args)
  }
  const calls = (name: string) => browser.calls.filter((call) => call.name === name).map((call) => call.args)

  beforeEach(() => {
    browser.calls.length = 0
    registerIpc(browser.self as never, store, {} as never, new Set([1]))
  })

  it('opens Settings at the place the page names, through the window’s own panel request', () => {
    fromPage(InternalChannel.openSettings, { pane: 'tools', anchor: 'extensions' })
    expect(calls('openOverlay')).toEqual([[{ panel: 'settings', pane: 'tools', anchor: 'extensions' }]])
  })

  it('opens the Web Store, and looks for the updates of all the extensions or of one', () => {
    fromPage(InternalChannel.openWebStore)
    expect(calls('openWebStore')).toHaveLength(1)
    fromPage(InternalChannel.extensionUpdates)
    expect(calls('extensionControl.checkUpdates')).toHaveLength(1)
    fromPage(InternalChannel.extensionUpdates, { profileId: 'default', extensionId: 'a'.repeat(32) })
    expect(calls('extensionControl.reviewUpdate')).toEqual([['default', 'a'.repeat(32)]])
  })

  it('opens the files that were dropped in tabs of the window, the first in front, and says how many it left out', () => {
    fromPage(InternalChannel.openLocalFiles, ['/Users/jane/a.pdf', '/Users/jane/b.png', '/Users/jane/c.dmg'])
    expect(calls('dispatch')).toEqual([[{ type: 'tab/open', url: 'file:///Users/jane/a.pdf', background: false }], [{ type: 'tab/open', url: 'file:///Users/jane/b.png', background: true }]])
    expect(calls('showToast')).toHaveLength(1)
    browser.calls.length = 0
    fromPage(InternalChannel.openLocalFiles, ['/Users/jane/a.pdf'])
    expect(calls('showToast')).toEqual([])
  })

  it('answers the request of the page through the service, and the snapshot with the reduced one', async () => {
    const reply = (await fromPage(InternalChannel.extensionsPage, { op: 'nope' })) as { ok: boolean }
    // A request that is none is refused by the service's own door; the answer is a sentence, never nothing.
    expect(reply.ok).toBe(false)
    const snapshot = (await fromPage(InternalChannel.getSnapshot)) as { state: { tabs: unknown[] } }
    expect(snapshot.state.tabs).toEqual([])
  })

  it('tells nothing of the application while it is locked, as the lock service says it', async () => {
    const lock = fakeBrowser({ isAppLocked: () => true, lockedSpaces: () => [], view: () => undefined })
    setLockService(lock.self as never)
    try {
      expect(await fromPage(InternalChannel.getSnapshot)).toBeNull()
      expect(await fromPage(InternalChannel.extensionsPage, { op: 'details' })).toMatchObject({ ok: false })
    } finally {
      setLockService(null)
    }
    expect(await fromPage(InternalChannel.getSnapshot)).not.toBeNull()
  })
})
