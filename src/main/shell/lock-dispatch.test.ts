// What `Browser.dispatch` does with an action while a space is locked: the real method runs on a stand-in for the window (browser-fake.test-support.ts),
// over a store that applies the real reducer.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const { setLockService } = await import('../lock-service')
const shell = methodsOf(Browser.prototype)

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

/** Two spaces (the second one is « work »), a Today tab and an archived tab in each. */
function twoSpaces(): { state: SidebarState; home: string; work: string } {
  let state = reduce(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
  const [home, work] = state.spaces.map((space) => space.id) as [string, string]
  for (const spaceId of [home, work]) {
    state = reduce(state, { type: 'archive/add', url: `https://archive.example/${spaceId}`, title: 'Archived', spaceId, source: 'manual' }, ctx)
    state = reduce(state, { type: 'tab/open', url: `https://today.example/${spaceId}/1`, spaceId, background: true } as Action, ctx)
    state = reduce(state, { type: 'tab/open', url: `https://today.example/${spaceId}/2`, spaceId, background: true } as Action, ctx)
  }
  return { state: reduce(state, { type: 'space/select', id: home }, ctx), home, work }
}

/** A window over `state` with `locked` spaces; `send` runs the real dispatch, `state()` reads the result, `toasts` what the user was told. */
function windowOver(initial: SidebarState, locked: string[]) {
  let state = initial
  const toasts: unknown[] = []
  setLockService({ lockedSpaces: () => locked, isAppLocked: () => false, isSpaceLocked: (id: string) => locked.includes(id), view: () => ({ appLocked: false, lockedSpaces: locked }) } as never)
  const store = { get: () => state, dispatch: (action: Action) => void (state = reduce(state, action, ctx)), root: () => store }
  const fake = fakeBrowser({ store, pages: new Map(), group: new Set(), showToast: (text: unknown) => void toasts.push(text) })
  return { send: (action: Action) => shell['dispatch']!.call(fake.self, action), state: () => state, toasts }
}

afterEach(() => setLockService(null))

describe('Browser.dispatch while a space is locked', () => {
  it('empties the archive that shows and keeps the entries of the locked space', () => {
    const { state, work } = twoSpaces()
    const win = windowOver(state, [work])
    win.send({ type: 'archive/clear' })
    expect(win.state().archive.map((entry) => entry.spaceId)).toEqual([work])
  })

  it('empties the whole archive when nothing is locked, whatever the sender asked to keep', () => {
    const { state, work } = twoSpaces()
    const win = windowOver(state, [])
    win.send({ type: 'archive/clear', keepSpaces: [work] })
    expect(win.state().archive).toEqual([])
  })

  it('does not send the Today tabs of a locked space to the archive, and says why', () => {
    const { state, work } = twoSpaces()
    const win = windowOver(state, [work])
    win.send({ type: 'today/clear', spaceId: work })
    expect(win.state()).toBe(state)
    expect(win.toasts).toHaveLength(1)
  })

  it('makes no folder in a locked space, not even inside one of its folders named from another space, and says why', () => {
    const { state, home, work } = twoSpaces()
    const withFolder = reduce(state, { type: 'folder/create', name: 'Dossier', spaceId: work }, ctx)
    const inside = withFolder.folders.at(-1)!.id
    const win = windowOver(withFolder, [work])
    win.send({ type: 'folder/create', name: 'Nouveau', spaceId: work })
    win.send({ type: 'folder/create', name: 'Dedans', spaceId: home, parentId: inside })
    win.send({ type: 'livefolder/create', source: { kind: 'feed', url: 'https://feed.example/rss' }, spaceId: work } as Action)
    expect(win.state()).toBe(withFolder)
    expect(win.toasts).toHaveLength(3)
    win.send({ type: 'folder/create', name: 'Ailleurs', spaceId: home })
    expect(win.state().folders.map((folder) => [folder.name, folder.spaceId])).toEqual([['Dossier', work], ['Ailleurs', home]])
  })

  it('still empties Today in a space that is not locked', () => {
    const { state, home, work } = twoSpaces()
    const win = windowOver(state, [work])
    win.send({ type: 'today/clear', spaceId: home })
    expect(win.state().tabs.filter((tab) => tab.spaceId === home).length).toBeLessThan(state.tabs.filter((tab) => tab.spaceId === home).length)
    expect(win.state().tabs.filter((tab) => tab.spaceId === work)).toHaveLength(2)
  })
})
