// The Extensions page as a window holds it: which tabs have it, what the gate is told of a web contents, what the page is sent, and when the console of the extensions is listened to.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model-defaults'
import type { ExtensionInfo } from '@shared/ipc'
import type { InternalSnapshotSource } from '@shared/internal-snapshot'
import { InternalPages, type InternalPagesDeps } from './internal-pages'

const PAGE = 'lucium-ui://extensions/'

interface Tab {
  id: string
  url: string
  private?: boolean
  container?: string
}

function setup(initial: { tabs?: Tab[]; live?: string[]; isPrivate?: boolean } = {}) {
  const world = {
    tabs: initial.tabs ?? [{ id: 'ext', url: PAGE }, { id: 'web', url: 'https://example.org/' }],
    live: new Set(initial.live ?? ['ext', 'web']),
    isPrivate: initial.isPrivate === true,
    profileSession: new Set<number>([1, 2, 3])
  }
  const stops: Array<ReturnType<typeof vi.fn>> = []
  const watch = vi.fn(() => {
    const stop = vi.fn()
    stops.push(stop)
    return stop
  })
  const sends: Array<[number, string, unknown]> = []
  const destroyed = new Set<number>()
  const ids: Record<string, number> = { ext: 1, web: 2, ext2: 3 }
  const deps: InternalPagesDeps = {
    tabs: () => world.tabs,
    livePageIds: () => [...world.live],
    isPrivate: () => world.isPrivate,
    contentsIdOf: (pageId) => ids[pageId],
    inProfileSession: (id) => world.profileSession.has(id),
    send: (tabId, channel, payload) => {
      const id = ids[tabId]
      if (id === undefined || destroyed.has(id)) return false
      sends.push([id, channel, payload])
      return true
    },
    watchConsoles: watch
  }
  return { pages: new InternalPages(deps), world, watch, stops, sends, destroyed }
}

const source = (names: string[] = ['One']): InternalSnapshotSource => ({
  state: { settings: defaultSettings() },
  extensions: names.map((name, i) => ({ id: String.fromCharCode(97 + i).repeat(32), name, version: '1', profileId: 'default', source: 'store', enabled: true }) as ExtensionInfo),
  platform: 'darwin'
})

describe('the console of the extensions', () => {
  it('is listened to while a page of the extensions is open in the window, and not before or after', () => {
    const { pages, world, watch, stops } = setup({ tabs: [{ id: 'web', url: 'https://example.org/' }], live: ['web'] })
    pages.reconcile()
    expect(watch).not.toHaveBeenCalled()
    world.tabs = [...world.tabs, { id: 'ext', url: PAGE }]
    world.live.add('ext')
    pages.reconcile()
    pages.reconcile()
    expect(watch).toHaveBeenCalledTimes(1)
    expect(stops[0]).not.toHaveBeenCalled()
    // The tab sleeps (its page is let go), then wakes: the listening ends and starts again with the page.
    world.live.delete('ext')
    pages.reconcile()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    world.live.add('ext')
    pages.reconcile()
    expect(watch).toHaveBeenCalledTimes(2)
    // The tab closes.
    world.tabs = world.tabs.filter((tab) => tab.id !== 'ext')
    pages.reconcile()
    expect(stops[1]).toHaveBeenCalledTimes(1)
  })

  it('is listened to once for a window, ended by the window going, and not for a tab that only has the address', () => {
    const { pages, watch, stops, world } = setup({ tabs: [{ id: 'ext', url: PAGE }, { id: 'ext2', url: `${PAGE}shortcuts` }], live: ['ext', 'ext2'] })
    pages.reconcile()
    // One listening for each tab that has the page (the engine shares them: ExtensionConsoleWatch counts its callers).
    expect(watch).toHaveBeenCalledTimes(2)
    pages.dispose()
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
    pages.reconcile()
    expect(watch).toHaveBeenCalledTimes(4)
    world.live.clear()
    pages.reconcile()
    expect(stops.slice(2).every((stop) => stop.mock.calls.length === 1)).toBe(true)
  })

  it('is not listened to by a private or guest window, nor for a private tab or a tab in a container, nor for a tab that left the page', () => {
    for (const setupOptions of [{ isPrivate: true }, { tabs: [{ id: 'ext', url: PAGE, private: true }] }, { tabs: [{ id: 'ext', url: PAGE, container: 'c1' }] }, { tabs: [{ id: 'ext', url: 'https://example.org/' }] }, { tabs: [{ id: 'ext', url: 'lucium-ui://extensions@evil/' }] }]) {
      const { pages, watch } = setup({ live: ['ext'], ...setupOptions })
      pages.reconcile()
      expect(watch, JSON.stringify(setupOptions)).not.toHaveBeenCalled()
    }
  })
})

describe('what the gate is told of a web contents', () => {
  it('is its tab in the state, at the address the state has, and whether it is in the session of a profile', () => {
    const { pages, world } = setup()
    expect(pages.tabOf(1)).toEqual({ url: PAGE, private: false, container: false, profileSession: true })
    expect(pages.tabOf(2)).toEqual({ url: 'https://example.org/', private: false, container: false, profileSession: true })
    world.profileSession.delete(1)
    expect(pages.tabOf(1)?.profileSession).toBe(false)
  })

  it('says a private tab and a tab in a container are such', () => {
    const { pages } = setup({ tabs: [{ id: 'ext', url: PAGE, private: true }, { id: 'web', url: 'https://example.org/', container: 'c1' }] })
    expect(pages.tabOf(1)).toMatchObject({ private: true })
    expect(pages.tabOf(2)).toMatchObject({ container: true })
  })

  it('is nothing for a web contents the window holds no live page of, and for a page whose tab is gone', () => {
    const { pages, world } = setup()
    expect(pages.tabOf(99)).toBeNull()
    world.live.delete('ext')
    expect(pages.tabOf(1)).toBeNull()
    world.live.add('ext')
    world.tabs = world.tabs.filter((tab) => tab.id !== 'ext')
    expect(pages.tabOf(1)).toBeNull()
  })
})

describe('the snapshot the page is sent', () => {
  it('goes to the pages of the window that have the Extensions page, and to no other page', () => {
    const { pages, sends } = setup()
    pages.publish(source(), false)
    expect(sends).toHaveLength(1)
    expect(sends[0]![0]).toBe(1)
    expect(sends[0]![1]).toBe('lucium-ui:snapshot')
    const snapshot = sends[0]![2] as { extensions: unknown[]; state: { tabs: unknown[] } }
    expect(snapshot.extensions).toHaveLength(1)
    expect(snapshot.state.tabs).toEqual([])
  })

  it('is not sent again while nothing of it changed, and is when the extensions or a setting it carries change', () => {
    const { pages, sends } = setup()
    pages.publish(source(), false)
    pages.publish(source(), false)
    expect(sends).toHaveLength(1)
    pages.publish(source(['One', 'Two']), false)
    expect(sends).toHaveLength(2)
    const other = source()
    other.state.settings.webStoreInstall = !other.state.settings.webStoreInstall
    pages.publish(other, false)
    expect(sends).toHaveLength(3)
  })

  it('leaves the list of the extensions out while the application is locked', () => {
    const { pages, sends } = setup()
    pages.publish(source(), true)
    expect((sends[0]![2] as { extensions: unknown[] }).extensions).toEqual([])
  })

  it('goes to nothing in a window that holds no such page, in a private window, or to a web contents that is gone', () => {
    const none = setup({ tabs: [{ id: 'web', url: 'https://example.org/' }], live: ['web'] })
    none.pages.publish(source(), false)
    expect(none.sends).toEqual([])
    const away = setup({ isPrivate: true })
    away.pages.publish(source(), false)
    expect(away.sends).toEqual([])
    const gone = setup()
    gone.destroyed.add(1)
    gone.pages.publish(source(), false)
    expect(gone.sends).toEqual([])
  })

  it('does not take for sent a snapshot that could not be delivered: the next publication sends it', () => {
    const { pages, sends, destroyed } = setup()
    destroyed.add(1)
    pages.publish(source(), false)
    expect(sends).toEqual([])
    destroyed.delete(1)
    pages.publish(source(), false)
    expect(sends.map((send) => send[0])).toEqual([1])
  })

  it('is sent again to the page of a tab that went and came back while another stayed, and the record of the one that went is not kept', () => {
    const { pages, sends, world } = setup({ tabs: [{ id: 'ext', url: PAGE }, { id: 'ext2', url: `${PAGE}shortcuts` }], live: ['ext', 'ext2'] })
    pages.publish(source(), false)
    expect(sends.map((send) => send[0]).sort()).toEqual([1, 3])
    world.live.delete('ext2')
    pages.publish(source(), false)
    world.live.add('ext2')
    pages.publish(source(), false)
    expect(sends.map((send) => send[0]).sort()).toEqual([1, 3, 3])
  })

  it('is sent again to a page that comes back after the window held none (it asks for the state itself, and would be sent the last one)', () => {
    const { pages, sends, world } = setup()
    pages.publish(source(), false)
    world.live.delete('ext')
    pages.publish(source(), false)
    world.live.add('ext')
    pages.publish(source(), false)
    expect(sends).toHaveLength(2)
  })
})
