// What a script an extension injected into a tab the user lent it finds in its world (lent-tab-runtime.ts): chrome.runtime, chrome.storage and the messages, made over the bridge of the
// tab. The function the preload serializes is run for real, as its text, in a context of its own with a made-up bridge: nothing of the test is in that world but the bridge.

import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { LENT_BRIDGE_KEY, LENT_RUNTIME_KEY, NO_RECEIVER, PORT_CLOSED } from '../shared/lent-tab-runtime'
import { installLentRuntime, type LentRuntimeInit } from './lent-tab-runtime'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Options {
  permissions?: string[]
  manifest?: unknown
  /** What the main process answers a call of the bridge (the JSON of an answer). */
  answer?: (op: string, payload: any) => unknown
  /** What the world holds before the runtime is made: the object `chrome` of an isolated world is there and empty. */
  before?: string
  withBridge?: boolean
}

function world(options: Options = {}) {
  const calls: Array<{ op: string; payload: any }> = []
  const bridge = {
    call: vi.fn(async (op: string, payload: string) => {
      const parsed = JSON.parse(payload)
      calls.push({ op, payload: parsed })
      const answer = options.answer ? options.answer(op, parsed) : { ok: true }
      if (answer instanceof Error) throw answer
      return JSON.stringify(answer)
    })
  }
  const errors: unknown[][] = []
  const sandbox: Record<string, unknown> = { console: { error: (...args: unknown[]) => errors.push(args) }, setTimeout }
  if (options.withBridge !== false) sandbox[LENT_BRIDGE_KEY] = bridge
  const context = vm.createContext(sandbox)
  vm.runInContext(options.before ?? 'globalThis.chrome = {}', context)
  const init: LentRuntimeInit = { extensionId: ID, manifest: options.manifest ?? { manifest_version: 3, name: 'Probe' }, permissions: options.permissions ?? ['storage'], bridgeKey: LENT_BRIDGE_KEY, runtimeKey: LENT_RUNTIME_KEY, noReceiver: NO_RECEIVER, portClosed: PORT_CLOSED }
  // As the preload hands it over: the text of the function, called with its arguments as JSON.
  const install = (): unknown => vm.runInContext(`(${installLentRuntime})(${JSON.stringify(init)})`, context)
  install()
  const run = (code: string): any => vm.runInContext(code, context)
  /** What the main process hands to the script, and what the script answers. */
  const deliver = async (payload: unknown): Promise<any> => JSON.parse(await run(`globalThis[${JSON.stringify(LENT_RUNTIME_KEY)}].deliver(${JSON.stringify(JSON.stringify(payload))})`))
  return { bridge, calls, errors, run, install, deliver, context }
}

describe('chrome.runtime in the world of a script of a lent tab', () => {
  it('is there with the id of the extension, its addresses and its manifest, on the `chrome` the world already has', () => {
    const { run } = world({ before: 'globalThis.chrome = { app: "kept" }', manifest: { manifest_version: 3, name: 'Probe', permissions: ['activeTab'] } })
    expect(run('chrome.runtime.id')).toBe(ID)
    expect(run('chrome.app')).toBe('kept')
    expect(run('chrome.runtime.getURL("/content/overlay.js")')).toBe(`chrome-extension://${ID}/content/overlay.js`)
    expect(run('chrome.runtime.getURL("a.png")')).toBe(`chrome-extension://${ID}/a.png`)
    expect(run('chrome.runtime.getManifest().name')).toBe('Probe')
    // A copy each time: a script that changes it changes nothing of what the next one reads.
    run('chrome.runtime.getManifest().name = "changed"')
    expect(run('chrome.runtime.getManifest().name')).toBe('Probe')
  })

  it('is made on a world that has no `chrome` at all', () => {
    const { run } = world({ before: '' })
    expect(run('typeof chrome.runtime.sendMessage')).toBe('function')
  })

  it('is made once for a document: a second script finds the listeners of the first where it left them', () => {
    const { run, install } = world()
    run('globalThis.heard = []; chrome.runtime.onMessage.addListener((m) => heard.push(m)); globalThis.first = chrome.runtime')
    install()
    expect(run('chrome.runtime === first && chrome.runtime.onMessage.hasListeners()')).toBe(true)
  })

  it('is not made where the page took no bridge: the world keeps what it had', () => {
    const { run } = world({ withBridge: false })
    expect(run('typeof chrome.runtime')).toBe('undefined')
  })

  it('has no ports: runtime.connect says why', () => {
    const { run } = world()
    expect(() => run('chrome.runtime.connect({ name: "x" })')).toThrow('runtime.connect is not provided')
  })
})

describe('chrome.runtime.sendMessage from the script of a lent tab', () => {
  it('asks the worker of the extension over the bridge, and gives the script what the worker answered', async () => {
    const { run, calls } = world({ answer: () => ({ ok: true, value: { pong: 1 } }) })
    expect(await run('chrome.runtime.sendMessage({ type: "ping", n: [1, 2] })')).toEqual({ pong: 1 })
    expect(calls).toEqual([{ op: 'send', payload: { message: { type: 'ping', n: [1, 2] } } }])
  })

  it('rejects with the words of the other side when it answers an error, and with the words of the platform when the bridge itself fails', async () => {
    const refusing = world({ answer: () => ({ ok: false, error: NO_RECEIVER }) })
    await expect(refusing.run('chrome.runtime.sendMessage("hello")')).rejects.toThrow(NO_RECEIVER)
    const gone = world({ answer: () => new Error("Error invoking remote method 'lucium:lent-tab-call': Error: Extension context invalidated.") })
    await expect(gone.run('chrome.runtime.sendMessage("hello")')).rejects.toThrow(/^Extension context invalidated\.$/)
  })

  it('hands the answer to a trailing callback, or sets chrome.runtime.lastError for the length of it', async () => {
    const good = world({ answer: () => ({ ok: true, value: 'yes' }) })
    good.run('globalThis.seen = []; chrome.runtime.sendMessage({ a: 1 }, (reply) => seen.push([reply, chrome.runtime.lastError]))')
    await settle()
    expect(good.run('seen')).toEqual([['yes', undefined]])
    const bad = world({ answer: () => ({ ok: false, error: PORT_CLOSED }) })
    bad.run('globalThis.seen = []; chrome.runtime.sendMessage({ a: 1 }, (reply) => seen.push([reply, chrome.runtime.lastError && chrome.runtime.lastError.message]))')
    await settle()
    expect(bad.run('seen')).toEqual([[undefined, PORT_CLOSED]])
    expect(bad.run('chrome.runtime.lastError')).toBeUndefined()
  })

  it('speaks to its own extension only: a message to another one is refused here and never leaves the page', async () => {
    const { run, calls } = world()
    await expect(run('chrome.runtime.sendMessage("ponmlkjihgfedcbaponmlkjihgfedcba", { a: 1 })')).rejects.toThrow('can only write to its own extension')
    expect(calls).toEqual([])
    await run(`chrome.runtime.sendMessage("${ID}", { a: 1 })`)
    expect(calls).toHaveLength(1)
  })

  it('refuses a call with no message, as the platform does', () => {
    const { run, calls } = world()
    expect(() => run('chrome.runtime.sendMessage()')).toThrow('No matching signature')
    expect(() => run('chrome.runtime.sendMessage(() => {})')).toThrow('No matching signature')
    expect(calls).toEqual([])
  })
})

describe('chrome.storage in the world of a script of a lent tab', () => {
  it('is there for an extension that holds the permission: local and sync, each call asked of the worker, with its argument', async () => {
    const { run, calls } = world({ answer: (_op, payload) => ({ ok: true, value: payload.method === 'get' ? { k: 'v' } : undefined }) })
    expect(run('typeof chrome.storage')).toBe('object')
    expect(await run('chrome.storage.local.get("k")')).toEqual({ k: 'v' })
    await run('chrome.storage.sync.set({ a: 1 })')
    await run('chrome.storage.local.remove(["a", "b"])')
    await run('chrome.storage.local.clear()')
    await run('chrome.storage.local.getBytesInUse(null)')
    expect(calls).toEqual([
      { op: 'storage', payload: { area: 'local', method: 'get', args: ['k'] } },
      { op: 'storage', payload: { area: 'sync', method: 'set', args: [{ a: 1 }] } },
      { op: 'storage', payload: { area: 'local', method: 'remove', args: [['a', 'b']] } },
      { op: 'storage', payload: { area: 'local', method: 'clear', args: [] } },
      { op: 'storage', payload: { area: 'local', method: 'getBytesInUse', args: [null] } }
    ])
  })

  it('takes a callback, and has no session or managed area (a content script has none)', async () => {
    const { run, calls } = world({ answer: () => ({ ok: true, value: { k: 1 } }) })
    run('globalThis.seen = []; chrome.storage.local.get(["k"], (items) => seen.push(items))')
    await settle()
    expect(run('seen')).toEqual([{ k: 1 }])
    expect(calls[0]?.payload.args).toEqual([['k']])
    expect(run('[typeof chrome.storage.session, typeof chrome.storage.managed]')).toEqual(['undefined', 'undefined'])
  })

  it('is not there for an extension that did not declare the storage permission', () => {
    const { run } = world({ permissions: ['activeTab', 'scripting'] })
    expect(run('typeof chrome.storage')).toBe('undefined')
    expect(run('typeof chrome.runtime')).toBe('object')
  })

  it('rejects with the words of the worker when it fails', async () => {
    const { run } = world({ answer: () => ({ ok: false, error: 'QUOTA_BYTES quota exceeded' }) })
    await expect(run('chrome.storage.local.set({ big: 1 })')).rejects.toThrow('QUOTA_BYTES quota exceeded')
  })
})

describe('a message of the worker, handed to the script', () => {
  const message = { kind: 'message', message: { type: 'mount' }, sender: { id: ID, url: `chrome-extension://${ID}/background.js`, origin: `chrome-extension://${ID}` } }

  it('is given to the listeners of chrome.runtime.onMessage with the message, the sender and a function to answer with; what is answered comes back', async () => {
    const { run, deliver } = world()
    run('globalThis.args = []; chrome.runtime.onMessage.addListener((m, s, reply) => { args.push([m, s, typeof reply]); reply({ ok: true, title: "t" }) })')
    expect(await deliver(message)).toEqual({ ok: true, value: { ok: true, title: 't' } })
    expect(run('args')).toEqual([[message.message, message.sender, 'function']])
  })

  it('waits for an answer that comes later when a listener returns true, and takes the first answer of several listeners', async () => {
    const { run, deliver } = world()
    run('chrome.runtime.onMessage.addListener((m, s, reply) => { setTimeout(() => reply("late"), 5); return true })')
    expect(await deliver(message)).toEqual({ ok: true, value: 'late' })
    run('chrome.runtime.onMessage.addListener((m, s, reply) => { reply("first") })')
    // The second listener answers at once, the first one later: the first answer is the one that counts.
    expect((await deliver(message)).value).toBe('first')
  })

  it('says there is no receiver when nothing listens, and that the port closed when listeners had nothing to say', async () => {
    const { run, deliver } = world()
    expect(await deliver(message)).toEqual({ ok: false, error: NO_RECEIVER })
    run('globalThis.quiet = () => {}; chrome.runtime.onMessage.addListener(quiet)')
    expect(await deliver(message)).toEqual({ ok: false, error: PORT_CLOSED })
    run('chrome.runtime.onMessage.removeListener(quiet)')
    expect(await deliver(message)).toEqual({ ok: false, error: NO_RECEIVER })
  })

  it('runs the other listeners when one throws, and the error is logged in the console of the page', async () => {
    const { run, deliver, errors } = world()
    run('chrome.runtime.onMessage.addListener(() => { throw new Error("boom") }); chrome.runtime.onMessage.addListener((m, s, reply) => { reply(1) })')
    expect(await deliver(message)).toEqual({ ok: true, value: 1 })
    expect(errors.flat().map(String).join(' ')).toContain('boom')
  })

  it('tells an answer it cannot carry (a circular one) instead of hanging', async () => {
    const { run, deliver } = world()
    run('chrome.runtime.onMessage.addListener((m, s, reply) => { const a = {}; a.a = a; reply(a) })')
    expect(await deliver(message)).toEqual({ ok: false, error: expect.stringContaining('cannot be sent') })
  })

  it('refuses what is not a message or a change, and text that is not JSON', async () => {
    const { run } = world()
    expect(await world().deliver({ kind: 'eval', code: 'x' })).toEqual({ ok: false, error: expect.stringContaining('cannot take') })
    const answer = JSON.parse(await run(`globalThis[${JSON.stringify(LENT_RUNTIME_KEY)}].deliver("{not json")`))
    expect(answer).toEqual({ ok: false, error: expect.stringContaining('not JSON') })
  })
})

describe('a change of the storage, handed to the script', () => {
  it('is told to the listeners of chrome.storage.onChanged (with the area) and of the area itself, for the areas the script has', async () => {
    const { run, deliver } = world()
    run('globalThis.heard = []; chrome.storage.onChanged.addListener((c, area) => heard.push(["all", c, area])); chrome.storage.local.onChanged.addListener((c) => heard.push(["local", c])); chrome.storage.sync.onChanged.addListener((c) => heard.push(["sync", c]))')
    expect(await deliver({ kind: 'changed', area: 'local', changes: { k: { newValue: 1 } } })).toEqual({ ok: true })
    expect(run('heard')).toEqual([['all', { k: { newValue: 1 } }, 'local'], ['local', { k: { newValue: 1 } }]])
    // An area the script does not have (session, managed) is no one's.
    await deliver({ kind: 'changed', area: 'session', changes: { k: { newValue: 2 } } })
    expect(run('heard')).toHaveLength(2)
  })

  it('is told to no one in a world that has no storage', async () => {
    const { deliver } = world({ permissions: ['activeTab'] })
    expect(await deliver({ kind: 'changed', area: 'local', changes: {} })).toEqual({ ok: true })
  })
})
