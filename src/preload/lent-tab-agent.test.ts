// What the worker of an extension does for the script the extension injected into a tab the user lent it (lent-tab-agent.ts): its real listeners of chrome.runtime.onMessage are called with
// the message and the real tab, its real storage is read and written, and the changes of the storage are told to the main process. The function the preload injects is run for real, against a
// made-up `chrome` and a made-up bridge of the shims.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LENT_PAYLOAD_MAX, NO_RECEIVER, PORT_CLOSED, TOO_LONG } from '../shared/lent-tab-runtime'
import { answerLentTabs } from './lent-tab-agent'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const g = globalThis as Record<string, any>
const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Listener = (message: unknown, sender: unknown, reply: (value?: unknown) => void) => unknown
type Heard = (api: string, name: string, args: unknown[]) => void

function fakeEvent() {
  const listeners = new Set<(...args: any[]) => void>()
  return { addListener: (listener: (...args: any[]) => void) => void listeners.add(listener), fire: (...args: unknown[]) => listeners.forEach((listener) => listener(...args)) }
}

/** A service worker of an extension with these permissions, the listeners it holds for chrome.runtime.onMessage, and the bridge of the shims. */
function worker(options: { permissions?: string[]; listeners?: Listener[]; tabs?: unknown } = {}) {
  const heard: Heard[] = []
  const listeners = options.listeners ?? []
  const stored: Record<string, Record<string, unknown>> = { local: { k: 'v' }, sync: {} }
  const area = (name: string) => ({
    get: vi.fn(async (keys: unknown) => (typeof keys === 'string' ? { [keys]: stored[name]![keys] } : { ...stored[name] })),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(stored[name]!, items)),
    remove: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    getBytesInUse: vi.fn(async () => 12),
    fail: vi.fn()
  })
  const storage = { local: area('local'), sync: area('sync'), session: area('session'), onChanged: fakeEvent() }
  const tabs: any = options.tabs ?? { get: vi.fn(async (id: number) => ({ id, windowId: 1, active: true, url: 'https://site.example/page' })) }
  g['chrome'] = { runtime: { id: ID, getManifest: () => ({ manifest_version: 3, permissions: options.permissions ?? ['activeTab', 'scripting', 'storage'] }) }, tabs, storage }
  const bridge = { call: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), onEvent: vi.fn((listener: Heard) => void heard.push(listener)) }
  g['__luciumShim'] = bridge
  g['__luciumMessageListeners'] = () => listeners
  const start = (): void => answerLentTabs(NO_RECEIVER, PORT_CLOSED, TOO_LONG, LENT_PAYLOAD_MAX)
  start()
  /** The main process asks the worker. */
  const ask = (id: string, op: string, payload: unknown): void => heard.forEach((listener) => listener('lentTab', 'ask', [id, op, payload]))
  const answers = (): Array<[string, unknown]> => bridge.call.mock.calls.filter((call) => call[1] === 'lentTab' && call[2] === 'answer').map((call) => (call[3] as [string, unknown]))
  const told = (method: string): unknown[][] => bridge.call.mock.calls.filter((call) => call[1] === 'lentTab' && call[2] === method).map((call) => call[3] as unknown[])
  return { bridge, chrome: g['chrome'], storage, tabs, stored, heard, listeners, start, ask, answers, told }
}

const MESSAGE = { tabId: 7, sender: { id: ID, url: 'https://site.example/page', origin: 'https://site.example', frameId: 0, documentLifecycle: 'active' }, message: { type: 'mount' } }

beforeEach(() => {
  delete g['__luciumLentAgent']
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  for (const name of ['chrome', '__luciumShim', '__luciumMessageListeners', '__luciumLentAgent', 'document']) delete g[name]
  vi.restoreAllMocks()
})

describe('the worker that answers for the scripts of lent tabs', () => {
  it('is there for an extension that can be lent a tab, once, and in a service worker only', () => {
    const lent = worker()
    expect(lent.bridge.onEvent).toHaveBeenCalledOnce()
    lent.start()
    expect(lent.bridge.onEvent).toHaveBeenCalledOnce()
    for (const permissions of [['activeTab'], ['scripting', 'storage'], []]) {
      delete g['__luciumLentAgent']
      expect(worker({ permissions }).bridge.onEvent, permissions.join()).not.toHaveBeenCalled()
    }
    delete g['__luciumLentAgent']
    g['document'] = {}
    const page = worker()
    expect(page.bridge.onEvent).not.toHaveBeenCalled()
  })

  it('is not there where the listeners of the messages were not reached (the shims did not finish)', () => {
    const lent = worker()
    delete g['__luciumLentAgent']
    delete g['__luciumMessageListeners']
    lent.bridge.onEvent.mockClear()
    lent.start()
    expect(lent.bridge.onEvent).not.toHaveBeenCalled()
  })
})

describe('a message of the script of a tab', () => {
  it('is given to the listeners of the extension with the message, the sender with the real tab, and a function to answer with; the answer goes back to the main process', async () => {
    const seen: unknown[][] = []
    const { ask, answers, tabs } = worker({
      listeners: [
        (message, sender, reply) => {
          seen.push([message, sender, typeof reply])
          reply({ ok: true, title: 't' })
        }
      ]
    })
    ask('one', 'message', MESSAGE)
    await settle()
    expect(seen).toEqual([[{ type: 'mount' }, { ...MESSAGE.sender, tab: { id: 7, windowId: 1, active: true, url: 'https://site.example/page' } }, 'function']])
    expect(tabs.get).toHaveBeenCalledWith(7)
    expect(answers()).toEqual([['one', { ok: true, value: { ok: true, title: 't' } }]])
  })

  it('waits for the answer of a listener that returns true, and leaves the port closed when the listeners had nothing to say', async () => {
    const late = worker({ listeners: [(_m, _s, reply) => (setTimeout(() => reply('late'), 5), true)] })
    late.ask('a', 'message', MESSAGE)
    await settle(30)
    expect(late.answers()).toEqual([['a', { ok: true, value: 'late' }]])
    delete g['__luciumLentAgent']
    const silent = worker({ listeners: [() => undefined] })
    silent.ask('b', 'message', MESSAGE)
    await settle()
    expect(silent.answers()).toEqual([['b', { ok: false, error: PORT_CLOSED }]])
  })

  it('goes on to the other listeners when one throws, and says so in the console of the worker', async () => {
    const { ask, answers } = worker({
      listeners: [
        () => {
          throw new Error('boom')
        },
        (_m, _s, reply) => reply(1)
      ]
    })
    ask('a', 'message', MESSAGE)
    await settle()
    expect(answers()).toEqual([['a', { ok: true, value: 1 }]])
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(' ')).toContain('boom')
  })

  it('waits for a worker that was just started to register its listeners, then says there is no receiver when none comes', async () => {
    vi.useFakeTimers()
    const { ask, answers, listeners } = worker()
    ask('a', 'message', MESSAGE)
    await vi.advanceTimersByTimeAsync(2000)
    expect(answers()).toEqual([])
    await vi.advanceTimersByTimeAsync(1500)
    expect(answers()).toEqual([['a', { ok: false, error: NO_RECEIVER }]])
    ask('b', 'message', MESSAGE)
    await vi.advanceTimersByTimeAsync(300)
    listeners.push((_m, _s, reply) => reply('now'))
    await vi.advanceTimersByTimeAsync(100)
    expect(answers().at(-1)).toEqual(['b', { ok: true, value: 'now' }])
  })

  it('reaches the listeners with no tab when the tab cannot be read, and says so', async () => {
    const seen: unknown[] = []
    const { ask, answers } = worker({
      listeners: [(_m, sender, reply) => (seen.push(sender), reply(true))],
      tabs: {
        get: async () => {
          throw new Error('No tab with id: 7.')
        }
      }
    })
    ask('a', 'message', MESSAGE)
    await settle()
    expect(seen).toEqual([MESSAGE.sender])
    expect(answers()).toEqual([['a', { ok: true, value: true }]])
    expect(vi.mocked(console.warn).mock.calls.flat().map(String).join(' ')).toContain('No tab with id: 7.')
  })
})

// What a worker answers is received by the main process whole, then written out and copied to the page: the worker, which is the extension's own process, holds it to the size that is handed over.
describe('what the worker answers, which can be of any size', () => {
  it('is an error, and not the value, when it is longer than is handed over: for a message and for a call of the storage', async () => {
    const { ask, answers, storage } = worker({ listeners: [(_m, _s, reply) => reply({ big: 'x'.repeat(LENT_PAYLOAD_MAX + 1) })] })
    storage.local.get.mockResolvedValueOnce({ k: 'y'.repeat(LENT_PAYLOAD_MAX + 1) })
    ask('a', 'message', MESSAGE)
    ask('b', 'storage', { area: 'local', method: 'get', args: [null] })
    await settle(30)
    expect(Object.fromEntries(answers())).toEqual({ a: { ok: false, error: TOO_LONG }, b: { ok: false, error: TOO_LONG } })
  })

  it('goes as it is when it is not longer, and when it is an error', async () => {
    const { ask, answers } = worker({ listeners: [(_m, _s, reply) => reply({ ok: true, list: ['x'.repeat(LENT_PAYLOAD_MAX - 1000)] })] })
    ask('a', 'message', MESSAGE)
    ask('b', 'storage', { area: 'session', method: 'get', args: [] })
    await settle(30)
    const given = Object.fromEntries(answers())
    expect(given['a']).toEqual({ ok: true, value: { ok: true, list: ['x'.repeat(LENT_PAYLOAD_MAX - 1000)] } })
    expect(given['b']).toMatchObject({ ok: false })
    expect((given['b'] as { error: string }).error).not.toBe(TOO_LONG)
  })

  it('is an error that says why, and not nothing, when it cannot be written out (a cycle)', async () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    const { ask, answers } = worker({ listeners: [(_m, _s, reply) => reply(cycle)] })
    ask('a', 'message', MESSAGE)
    await settle(10)
    expect(answers()).toEqual([['a', { ok: false, error: expect.stringMatching(/circular/i) }]])
  })
})

describe('a call of the storage by the script of a tab', () => {
  it('is made on the storage of the extension, and its value goes back', async () => {
    const { ask, answers, storage } = worker()
    ask('a', 'storage', { area: 'local', method: 'get', args: ['k'] })
    ask('b', 'storage', { area: 'sync', method: 'set', args: [{ s: 1 }] })
    ask('c', 'storage', { area: 'local', method: 'clear', args: [] })
    await settle()
    expect(storage.local.get).toHaveBeenCalledWith('k')
    expect(storage.sync.set).toHaveBeenCalledWith({ s: 1 })
    expect(storage.local.clear).toHaveBeenCalledWith()
    expect(answers()).toEqual([['a', { ok: true, value: { k: 'v' } }], ['b', { ok: true, value: undefined }], ['c', { ok: true, value: undefined }]])
  })

  it('goes back as an error with the words of the browser when it fails', async () => {
    const { ask, answers, storage } = worker()
    storage.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))
    ask('a', 'storage', { area: 'local', method: 'set', args: [{ big: 1 }] })
    await settle()
    expect(answers()).toEqual([['a', { ok: false, error: 'QUOTA_BYTES quota exceeded' }]])
  })

  it('is refused for what a script of a tab is not given: another area, another name of the storage, or one of the prototype', async () => {
    const { ask, answers, storage } = worker()
    for (const [id, area, method] of [['a', 'session', 'get'], ['b', 'managed', 'get'], ['c', 'local', 'constructor'], ['d', 'local', '__proto__'], ['e', 'local', 'fail'], ['f', '__proto__', 'get'], ['g', 'local', undefined]] as const) ask(id, 'storage', { area, method, args: [] })
    await settle()
    expect(answers().map(([id, answer]) => [id, (answer as { ok: boolean }).ok])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => [id, false]))
    expect(storage.session.get).not.toHaveBeenCalled()
    expect(storage.local.fail).not.toHaveBeenCalled()
  })
})

describe('what the main process asks that the worker does not answer', () => {
  it('is told so, and an event of another API or without an id is let alone', async () => {
    const { ask, answers, heard } = worker()
    ask('a', 'eval', { code: 'x' })
    heard.forEach((listener) => {
      listener('other', 'ask', ['b', 'message', MESSAGE])
      listener('lentTab', 'ask', [5, 'message', MESSAGE])
      listener('lentTab', 'done', ['c', 'message', MESSAGE])
    })
    await settle()
    expect(answers()).toEqual([['a', { ok: false, error: 'This request is not one the worker answers.' }]])
  })

  it('does not stop on an answer the main process does not take: it is said in the console of the worker', async () => {
    const { ask, bridge } = worker({ listeners: [(_m, _s, reply) => reply(1)] })
    bridge.call.mockRejectedValue(new Error('the main process is busy'))
    ask('a', 'message', MESSAGE)
    await settle()
    expect(vi.mocked(console.warn).mock.calls.flat().map(String).join(' ')).toContain('the main process is busy')
  })
})

describe('the changes of the storage', () => {
  it('are told to the main process for the local and the sync areas, which tell the scripts that listen; the other areas stay where they are', () => {
    const { storage, told } = worker()
    storage.onChanged.fire({ k: { newValue: 1 } }, 'local')
    storage.onChanged.fire({ s: { newValue: 2 } }, 'sync')
    storage.onChanged.fire({ t: { newValue: 3 } }, 'session')
    storage.onChanged.fire({ m: { newValue: 4 } }, 'managed')
    expect(told('changed')).toEqual([[{ k: { newValue: 1 } }, 'local'], [{ s: { newValue: 2 } }, 'sync']])
  })

  it('are not listened to for an extension that has no storage permission', () => {
    const { storage, told } = worker({ permissions: ['activeTab', 'scripting'] })
    storage.onChanged.fire({ k: { newValue: 1 } }, 'local')
    expect(told('changed')).toEqual([])
  })
})
