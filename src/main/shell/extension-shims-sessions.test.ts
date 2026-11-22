import { describe, expect, it, vi } from 'vitest'
import { shimAllowed } from '@shared/chrome-compat'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/lucium-test', once: () => {}, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null }
}))

const { ExtensionShims } = await import('./extension-shims')

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

/** The archive of two profiles; `restore` is what the reducer does to it, made small: the entry leaves and a tab with its address comes. */
function rig(refuseRestore = false) {
  const state = {
    settings: {},
    spaces: [
      { id: 's-default', profileId: 'default' },
      { id: 's-work', profileId: 'work' }
    ],
    tabs: [] as Array<{ id: string; url: string }>,
    archive: [
      { id: 'a1', spaceId: 's-default', url: 'https://one.example/', title: 'One', archivedAt: 1000, source: 'manual' },
      { id: 'a2', spaceId: 's-default', url: 'https://two.example/', title: 'Two', archivedAt: 2000, source: 'manual' },
      { id: 'a3', spaceId: 's-default', url: 'https://idle.example/', title: 'Idle', archivedAt: 3000, source: 'auto' },
      { id: 'w1', spaceId: 's-work', url: 'https://work.example/', title: 'Work', archivedAt: 4000, source: 'manual' }
    ]
  }
  const dispatch = vi.fn((action: { type: string; id: string }) => {
    if (refuseRestore) return
    const entry = state.archive.find((a) => a.id === action.id)
    if (!entry) return
    state.archive = state.archive.filter((a) => a !== entry)
    state.tabs = [...state.tabs, { id: `tab-${entry.id}`, url: entry.url }]
  })
  const engine = {
    setTabFactsProvider: () => {},
    onTabClosed: () => {},
    onDownload: () => {},
    onContextGone: () => {},
    tabNumberOf: (pageId: string) => (pageId === 'tab-a2' ? 42 : undefined)
  }
  const shims = new ExtensionShims({ dispatch } as never, engine as never, { get: () => state } as never)
  const call = (method: string, args: unknown[] = [], profileId = 'default') => shims.handle({ extensionId: EXT, profileId, context: 'worker:1', api: 'sessions', method, args })
  return { call, dispatch, state }
}

describe('chrome.sessions in the main process', () => {
  it('lists the closed tabs of the profile of the caller, newest first, and honours maxResults', async () => {
    const r = rig()
    const all = (await r.call('getRecentlyClosed')) as Array<{ tab: { sessionId: string } }>
    expect(all.map((s) => s.tab.sessionId)).toEqual(['a2', 'a1'])
    expect(((await r.call('getRecentlyClosed', [{ maxResults: 1 }])) as unknown[]).length).toBe(1)
    expect(((await r.call('getRecentlyClosed', [], 'work')) as Array<{ tab: { sessionId: string } }>).map((s) => s.tab.sessionId)).toEqual(['w1'])
  })

  it('refuses a maxResults the platform refuses', async () => {
    await expect(rig().call('getRecentlyClosed', [{ maxResults: 26 }])).rejects.toThrow('maxResults')
  })

  it('restores the latest closed tab, or the one named, and says which tab it is', async () => {
    const r = rig()
    const latest = (await r.call('restore')) as { tab: { sessionId?: string; id?: number; url: string } }
    expect(r.dispatch).toHaveBeenCalledWith({ type: 'archive/restore', id: 'a2' })
    expect(latest.tab).toMatchObject({ id: 42, url: 'https://two.example/' })
    await r.call('restore', ['a1'])
    expect(r.dispatch).toHaveBeenLastCalledWith({ type: 'archive/restore', id: 'a1' })
  })

  it('does not restore what another profile closed, what was swept idle, or what is not there', async () => {
    const r = rig()
    for (const id of ['w1', 'a3', 'nothing']) await expect(r.call('restore', [id])).rejects.toThrow('Invalid session id')
    expect(r.dispatch).not.toHaveBeenCalled()
  })

  it('says so when the tab did not come back', async () => {
    await expect(rig(true).call('restore', ['a1'])).rejects.toThrow('could not be restored')
  })

  it('has no other device', async () => {
    expect(await rig().call('getDevices')).toEqual([])
  })

  it('does not provide the rest', async () => {
    await expect(rig().call('setFoo')).rejects.toThrow('chrome.sessions.setFoo is not provided')
  })
})

describe('chrome.sessions, the permission', () => {
  it('is for an extension that declared "sessions", for each method it provides', () => {
    for (const method of ['getRecentlyClosed', 'restore', 'getDevices']) {
      expect(shimAllowed({ permissions: ['sessions'] }, 'sessions', method)).toBe(true)
      expect(shimAllowed({ permissions: ['storage', 'tabs'] }, 'sessions', method)).toBe(false)
    }
    expect(shimAllowed({ permissions: ['sessions'] }, 'sessions', 'setFoo')).toBe(false)
  })
})

