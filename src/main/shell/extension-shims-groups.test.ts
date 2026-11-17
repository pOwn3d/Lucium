import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, persistableState, reduce, type Action } from '@shared/sidebar'

// The shims are written against Electron's main process; what they need of it here is a place for the data folder and a quit event.
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/lucium-test', once: () => {}, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null }
}))

const { ExtensionShims } = await import('./extension-shims')

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
let counter = 0
const ctx = () => ({ now: 1000, newId: () => `id${++counter}` })

/** The shims over a real store (the reducer) and an engine that numbers the tabs 10, 11, 12... in the order they are opened. */
function rig() {
  let state: SidebarState = createInitialState(ctx())
  const dispatched: Action[] = []
  let broken = false
  const closed: Array<(tabNumber: number) => void> = []
  const dispatch = (action: Action) => {
    if (broken) throw new Error('the store refused')
    dispatched.push(action)
    state = reduce(state, action, ctx())
  }
  const numbers = new Map<string, number>()
  const open = (url: string): { id: string; number: number } => {
    state = reduce(state, { type: 'tab/open', url }, ctx())
    const tab = state.tabs.at(-1)!
    const number = 10 + numbers.size
    numbers.set(tab.id, number)
    return { id: tab.id, number }
  }
  const emitted: Array<{ api: string; event: string; args: unknown[] }> = []
  const engine = {
    setTabFactsProvider: () => {},
    onTabClosed: (listener: (tabNumber: number) => void) => void closed.push(listener),
    onDownload: () => {},
    onContextGone: () => {},
    pageIdOfTabNumber: (n: number) => [...numbers.entries()].find(([, number]) => number === n)?.[0],
    profileOfTab: (n: number) => ([...numbers.values()].includes(n) ? 'default' : undefined),
    tabNumberOf: (pageId: string) => numbers.get(pageId),
    windowOfTab: () => 1,
    notifyTabChanged: () => {},
    listExtensions: () => [{ id: EXT }],
    emitShimEvent: (_id: string, api: string, event: string, args: unknown[]) => void emitted.push({ api, event, args })
  }
  const browser = { dispatch, windowId: () => 1, browserOfWindow: () => null }
  const store = { get: () => state }
  const shims = new ExtensionShims(browser as never, engine as never, store as never)
  const call = (api: string, method: string, ...args: unknown[]) => shims.handle({ extensionId: EXT, profileId: 'default', context: 'worker:1', api, method, args })
  return {
    shims,
    call,
    open,
    dispatched,
    emitted,
    breakStore: () => void (broken = true),
    get state() {
      return state
    },
    do: (action: Action) => void (state = reduce(state, action, ctx())),
    closeTab(id: string) {
      const number = numbers.get(id)!
      state = reduce(state, { type: 'tab/close', id }, ctx())
      numbers.delete(id)
      for (const listener of closed) listener(number)
    },
    tab: (id: string) => state.tabs.find((t) => t.id === id)!
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
  counter = 0
})

describe('the groups of extensions as folders, through the shims', () => {
  it('shows nothing while the function is off: a group is made, the sidebar is untouched and nothing is even queued', async () => {
    const queued = vi.spyOn(globalThis, 'queueMicrotask')
    const r = rig()
    const a = r.open('https://a.example/')
    const b = r.open('https://b.example/')
    const id = await r.call('tabs', 'group', { tabIds: [a.number, b.number] })
    await r.call('tabGroups', 'update', id, { title: 'Veille' })
    await tick()
    expect(r.state.folders).toEqual([])
    expect(r.dispatched).toEqual([])
    expect(r.tab(a.id).pinned).toBe(false)
    expect(queued).not.toHaveBeenCalled()
  })

  it('builds the folder for a group when the function comes on, and follows the group', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    const b = r.open('https://b.example/')
    const id = (await r.call('tabs', 'group', { tabIds: [a.number, b.number] })) as number
    await r.call('tabGroups', 'update', id, { title: 'Veille' })
    const stop = r.shims.mirrorGroups()
    await tick()
    expect(r.state.folders.map((f) => f.name)).toEqual(['Veille'])
    expect(r.tab(a.id)).toMatchObject({ pinned: true, folderId: r.state.folders[0]!.id })
    await r.call('tabGroups', 'update', id, { title: 'Autre', collapsed: true })
    await tick()
    expect(r.state.folders[0]).toMatchObject({ name: 'Autre', collapsed: true })
    await r.call('tabs', 'ungroup', [a.number])
    await tick()
    expect(r.tab(a.id)).toMatchObject({ pinned: false })
    expect(r.state.folders).toHaveLength(1)
    stop()
    await tick()
    expect(r.state.folders).toEqual([])
    expect(r.tab(b.id)).toMatchObject({ pinned: false })
  })

  it('does not touch the state inside the call that changes a group: the sidebar changes on the next turn', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    r.shims.mirrorGroups()
    await tick()
    const before = r.dispatched.length
    // The call runs to its end before anything else does: the sidebar has not been asked for anything yet.
    const pending = r.call('tabs', 'group', { tabIds: [a.number] })
    expect(r.dispatched).toHaveLength(before)
    await pending
    await tick()
    expect(r.dispatched.length).toBeGreaterThan(before)
  })

  it('joins several changes made in one turn into one pass over the groups', async () => {
    const r = rig()
    const [a, b, c] = [r.open('https://a.example/'), r.open('https://b.example/'), r.open('https://c.example/')]
    r.shims.mirrorGroups()
    const id = (await r.call('tabs', 'group', { tabIds: [a.number] })) as number
    await r.call('tabs', 'group', { tabIds: [b.number, c.number], groupId: id })
    await r.call('tabGroups', 'update', id, { title: 'Trois' })
    await tick()
    expect(r.state.folders).toHaveLength(1)
    expect(r.state.folders[0]!.name).toBe('Trois')
    expect(r.state.tabs.filter((t) => t.folderId === r.state.folders[0]!.id)).toHaveLength(3)
  })

  it('forgets a tab the engine reports closed, and removes the folder with the last', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    r.shims.mirrorGroups()
    await r.call('tabs', 'group', { tabIds: [a.number] })
    await tick()
    expect(r.state.folders).toHaveLength(1)
    r.do({ type: 'tab/unpin', id: a.id })
    r.closeTab(a.id)
    await tick()
    expect(r.state.folders).toEqual([])
  })

  it('writes no folder of a group to the files, and none is left once the function is off', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    const stop = r.shims.mirrorGroups()
    await r.call('tabs', 'group', { tabIds: [a.number] })
    await tick()
    expect(r.state.folders).toHaveLength(1)
    expect(persistableState(r.state).folders).toEqual([])
    stop()
    await tick()
    expect(persistableState(r.state)).toBe(r.state)
  })

  it('answers the extension as before, with the function on or off: the group, its title, its tabs', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    r.shims.mirrorGroups()
    const id = (await r.call('tabs', 'group', { tabIds: [a.number] })) as number
    const group = (await r.call('tabGroups', 'update', id, { title: 'Veille', color: 'blue' })) as { title: string; color: string }
    expect(group).toMatchObject({ title: 'Veille', color: 'blue' })
    expect(await r.call('tabGroups', 'query', {})).toHaveLength(1)
    expect(r.emitted.map((e) => e.event)).toContain('onCreated')
  })

  it('says so when it cannot change the sidebar, and the extension is not told anything is wrong', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    const a = r.open('https://a.example/')
    r.shims.mirrorGroups()
    await tick()
    r.breakStore()
    await expect(r.call('tabs', 'group', { tabIds: [a.number] })).resolves.toEqual(expect.any(Number))
    await tick()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[tab-groups]'), expect.any(Error))
  })

  it('says so when the tabs cannot be put back, and the files still do not hold the folder', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    const a = r.open('https://a.example/')
    const stop = r.shims.mirrorGroups()
    await r.call('tabs', 'group', { tabIds: [a.number] })
    await tick()
    expect(persistableState(r.state).folders).toEqual([])
    r.breakStore()
    stop()
    await tick()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[tab-groups]'), expect.any(Error))
    // The folder is still in the sidebar (the store refused), and the files still do not hold it.
    expect(r.state.folders).toHaveLength(1)
    expect(persistableState(r.state).folders).toEqual([])
  })

  it('leaves the next start alone: stopping twice, or after a restart of the function, builds on a clean table', async () => {
    const r = rig()
    const a = r.open('https://a.example/')
    const first = r.shims.mirrorGroups()
    await r.call('tabs', 'group', { tabIds: [a.number] })
    await tick()
    first()
    const second = r.shims.mirrorGroups()
    await tick()
    expect(r.state.folders).toHaveLength(1)
    second()
    first()
    await tick()
    expect(r.state.folders).toEqual([])
  })
})
