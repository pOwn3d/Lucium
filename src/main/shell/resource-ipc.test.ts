// The two channels of the resource panel of the sidebar (resource-ipc.ts), over a fake scoped IPC, a fake window and the real watch: a panel opens
// only with the function on and through the guard, closes whatever happens, goes with its page, and its buttons reach the browser checked again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import type { RawProcess } from '@shared/processes'
import type { ReleaseOutcome, ReleasePreview, ResourceReport, ResourceTab } from '@shared/resources'
import type { ScopedIpc } from './ipc-scope'
import { ResourceWatch } from './resource-watch'
import { registerResourceIpc, setTaskManagerOpener, type ResourceHost } from './resource-ipc'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

/** A web contents of the interface: what it was sent, and its listeners (`fire` plays an event on it). */
function contents(id: number) {
  const listeners = new Map<string, () => void>()
  const sent: Array<{ channel: string; report: ResourceReport }> = []
  let destroyed = false
  return {
    id,
    sent,
    listeners,
    isDestroyed: () => destroyed,
    send: (channel: string, report: ResourceReport) => void sent.push({ channel, report }),
    once: (event: string, listener: () => void) => void listeners.set(event, listener),
    removeListener: (event: string) => void listeners.delete(event),
    fire: (event: string) => listeners.get(event)?.(),
    destroy: () => void (destroyed = true)
  }
}

const RAW: RawProcess[] = [
  { pid: 1, type: 'Browser', cpu: 2, memoryKb: 300 * 1024 },
  { pid: 9, type: 'Tab', cpu: 7.4, memoryKb: 584 * 1024 }
]
const LEVELS: ReleasePreview[] = [{ level: 'low', count: 1, memoryMb: 200, cpu: 0, siteTabs: 0 }, { level: 'medium', count: 2, memoryMb: 500, cpu: 1, siteTabs: 0 }, { level: 'high', count: 5, memoryMb: 2000, cpu: 2, siteTabs: 3 }]
const OUTCOME: ReleaseOutcome = { level: 'medium', slept: 2, refused: { unsent: 1, confirm: 0, other: 0 } }
const TAB: ResourceTab = { tabId: 't1', name: 'Twitch', url: 'https://twitch.example/', memoryMb: 584, cpu: 7.4 }

function setup(options: { on?: boolean; trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  const watch = new ResourceWatch({ measure: () => RAW, totalMb: 16_384, pressure: () => Promise.resolve(1), onGauge: () => undefined })
  const host = {
    resources: vi.fn(() => (options.on === false ? null : watch)),
    resourceTabs: vi.fn(() => ({ tabs: [TAB], levels: LEVELS })),
    sleepTabAnywhere: vi.fn(() => Promise.resolve(true)),
    closeTabAnywhere: vi.fn(() => true),
    showTabAnywhere: vi.fn(() => true),
    releaseLevel: vi.fn((): Promise<ReleaseOutcome> => Promise.resolve(OUTCOME)),
    undoRelease: vi.fn(() => Promise.resolve(2))
  } satisfies ResourceHost
  const guard = vi.fn(() => options.trusted !== false)
  const release = registerResourceIpc(ipc, guard, host)
  const panel = (sender: ReturnType<typeof contents>, open: unknown) => handlers.get(Channel.resourcePanel)!({ sender }, open)
  const act = (sender: ReturnType<typeof contents>, action: unknown) => handlers.get(Channel.resourceAction)!({ sender }, action) as Promise<unknown>
  return { watch, host, guard, release, panel, act, registered: () => [...handlers.keys()].sort() }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  setTaskManagerOpener(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the resource panel IPC', () => {
  it('registers the channel of the panel and the channel of its buttons, and no other', () => {
    expect(setup().registered()).toEqual([Channel.resourceAction, Channel.resourcePanel].sort())
  })

  it('sends an open panel the report of its window at once, then every 2 s, and stops when it closes', async () => {
    const t = setup()
    const sidebar = contents(11)
    t.panel(sidebar, true)
    expect(sidebar.sent).toHaveLength(1)
    expect(sidebar.sent[0]!.channel).toBe(Channel.resources)
    expect(sidebar.sent[0]!.report).toMatchObject({ memoryMb: 884, cpu: 9.4, levels: LEVELS, tabs: [TAB] })
    expect(t.host.resourceTabs).toHaveBeenCalledWith(RAW)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sidebar.sent.length).toBeGreaterThanOrEqual(2)
    t.panel(sidebar, false)
    expect(t.watch.running()).toBe(false)
    const count = sidebar.sent.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sidebar.sent).toHaveLength(count)
    // Its listeners on the page go with it.
    expect(sidebar.listeners.size).toBe(0)
  })

  it('opens nothing while the function is off, or for a sender the guard refuses', () => {
    for (const options of [{ on: false }, { trusted: false }]) {
      const t = setup(options)
      const sidebar = contents(12)
      t.panel(sidebar, true)
      expect(sidebar.sent, JSON.stringify(options)).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('closes a panel even when the guard would refuse the sender now (the application was locked meanwhile)', () => {
    const t = setup()
    const sidebar = contents(13)
    t.panel(sidebar, true)
    t.guard.mockReturnValue(false)
    t.panel(sidebar, false)
    expect(t.watch.running()).toBe(false)
  })

  it('lets a panel go with its page: the page reloads, or the web contents is destroyed', () => {
    for (const event of ['did-start-loading', 'destroyed']) {
      const t = setup()
      const sidebar = contents(14)
      t.panel(sidebar, true)
      sidebar.fire(event)
      expect(t.watch.running(), event).toBe(false)
    }
  })

  it('forgets a panel whose web contents is gone at the next refresh', async () => {
    const t = setup()
    const sidebar = contents(15)
    t.panel(sidebar, true)
    sidebar.destroy()
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.watch.openCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets go of the panels of a window that closes', () => {
    const t = setup()
    t.panel(contents(16), true)
    t.panel(contents(17), true)
    expect(t.watch.openCount()).toBe(2)
    t.release()
    expect(t.watch.openCount()).toBe(0)
    expect(t.watch.running()).toBe(false)
  })

  it('opens a panel once: a second opening of the same page draws it again', () => {
    const t = setup()
    const sidebar = contents(18)
    t.panel(sidebar, true)
    t.panel(sidebar, true)
    expect(t.watch.openCount()).toBe(1)
    expect(sidebar.sent).toHaveLength(2)
  })
})

describe('the buttons of the panel', () => {
  it('put a tab to sleep, close it or show it in the window that holds it, then draw the panels again', async () => {
    const t = setup()
    const sidebar = contents(21)
    t.panel(sidebar, true)
    // The pressure read for this opening is drawn as it comes: settled first.
    await vi.advanceTimersByTimeAsync(0)
    const before = sidebar.sent.length
    expect(await t.act(sidebar, { kind: 'sleep', tabId: 't1' })).toEqual({ done: true })
    expect(t.host.sleepTabAnywhere).toHaveBeenCalledWith('t1')
    expect(sidebar.sent.length).toBe(before + 1)
    expect(await t.act(sidebar, { kind: 'close', tabId: 't1' })).toEqual({ done: true })
    expect(t.host.closeTabAnywhere).toHaveBeenCalledWith('t1')
    expect(sidebar.sent.length).toBe(before + 2)
    await t.act(sidebar, { kind: 'show', tabId: 't1' })
    expect(t.host.showTabAnywhere).toHaveBeenCalledWith('t1')
  })

  it('answer that nothing was done for a tab the window group refuses (hidden by a lock, gone meanwhile): the panel must not say it was', async () => {
    const t = setup()
    t.host.sleepTabAnywhere.mockResolvedValue(false)
    t.host.closeTabAnywhere.mockReturnValue(false)
    expect(await t.act(contents(25), { kind: 'sleep', tabId: 'gone' })).toEqual({ done: false })
    expect(await t.act(contents(25), { kind: 'close', tabId: 'gone' })).toEqual({ done: false })
  })

  it('free the tabs of a strength of « Libérer maintenant » and say how it ended, then draw the panels again', async () => {
    const t = setup()
    const sidebar = contents(22)
    t.panel(sidebar, true)
    await vi.advanceTimersByTimeAsync(0)
    const before = sidebar.sent.length
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(await t.act(sidebar, { kind: 'sleep-level', level })).toEqual({ released: OUTCOME })
      expect(t.host.releaseLevel).toHaveBeenLastCalledWith(level)
    }
    expect(t.host.releaseLevel).toHaveBeenCalledTimes(3)
    expect(sidebar.sent.length).toBe(before + 3)
  })

  it('wake the tabs of the last run for « Annuler » and say how many', async () => {
    const t = setup()
    expect(await t.act(contents(26), { kind: 'undo-level' })).toEqual({ woken: 2 })
    expect(t.host.undoRelease).toHaveBeenCalledTimes(1)
  })

  it('read the strength again: a level that is not one never reaches the browser', async () => {
    const t = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const level of ['extreme', '', 3, null, undefined, 'LOW', { toString: () => 'low' }]) {
      expect(await t.act(contents(27), { kind: 'sleep-level', level }), String(level)).toBeNull()
    }
    expect(await t.act(contents(27), { kind: 'sleep-hidden' })).toBeNull()
    expect(t.host.releaseLevel).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(8)
  })

  it('refuse the strengths for a sender the guard refuses, and with the function off', async () => {
    for (const options of [{ trusted: false }, { on: false }]) {
      const t = setup(options)
      expect(await t.act(contents(28), { kind: 'sleep-level', level: 'high' }), JSON.stringify(options)).toBeNull()
      expect(await t.act(contents(28), { kind: 'undo-level' }), JSON.stringify(options)).toBeNull()
      expect(t.host.releaseLevel).not.toHaveBeenCalled()
      expect(t.host.undoRelease).not.toHaveBeenCalled()
    }
  })

  it('log a run or an undo that fails, with its level and no title or address, and answer that it could not be done', async () => {
    const t = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    t.host.releaseLevel.mockRejectedValue(new Error('engine gone'))
    t.host.undoRelease.mockRejectedValue(new Error('window gone'))
    expect(await t.act(contents(29), { kind: 'sleep-level', level: 'high' })).toBeNull()
    expect(await t.act(contents(29), { kind: 'undo-level' })).toBeNull()
    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([expect.stringContaining('level high failed: engine gone'), expect.stringContaining('failed: window gone')])
  })

  it('open the task manager the application gave', async () => {
    const t = setup()
    const open = vi.fn()
    setTaskManagerOpener(open)
    await t.act(contents(23), { kind: 'task-manager' })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('do nothing for an action that is not one, with the function off, or for a sender the guard refuses', async () => {
    for (const [options, action] of [
      [{}, { kind: 'kill', tabId: 't1' }],
      [{}, { kind: 'sleep' }],
      [{ on: false }, { kind: 'sleep', tabId: 't1' }],
      [{ trusted: false }, { kind: 'close', tabId: 't1' }]
    ] as const) {
      const t = setup(options)
      expect(await t.act(contents(24), action)).toBeNull()
      expect(t.host.sleepTabAnywhere).not.toHaveBeenCalled()
      expect(t.host.closeTabAnywhere).not.toHaveBeenCalled()
    }
  })
})
