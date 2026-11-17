// The preload of the tabs of a profile that makes the bridge of a lent tab (lent-tab.ts): it does nothing until the main process asks, it makes the bridge in one isolated world of an extension
// and never in the world of the page or its own, and it tells the main process what became of the request.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '../shared/ipc-channels'
import { LENT_BRIDGE_KEY, LENT_BUDGET_CHARACTERS, LENT_CALL_MAX, LENT_RUNTIME_KEY, NO_RECEIVER, PORT_CLOSED, SCRIPT_WORLDS_FROM } from '../shared/lent-tab-runtime'

const contextBridge = { exposeInIsolatedWorld: vi.fn(), exposeInMainWorld: vi.fn() }
const ipcRenderer = { on: vi.fn(), send: vi.fn(), invoke: vi.fn() }
const webFrame = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: unknown[]): Promise<unknown> => undefined) }
vi.mock('electron', () => ({ contextBridge, ipcRenderer, webFrame }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const WORLD = SCRIPT_WORLDS_FROM + 3
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

/** The preload, loaded as a document loads it, and the function it listens to the main process with. */
async function loaded(): Promise<(nonce: unknown, world: unknown, init: unknown) => void> {
  vi.resetModules()
  ipcRenderer.on.mockClear()
  await import('./lent-tab')
  const listen = ipcRenderer.on.mock.calls.find(([channel]) => channel === Channel.lentTabAttach)
  expect(listen, 'the preload listens to the main process').toBeDefined()
  return (nonce, world, init) => (listen![1] as (...args: unknown[]) => void)({}, nonce, world, init)
}

// Invented for this test: the token of no document.
const TOKEN = '6f1d1a1e-0c0f-4d7e-9a53-2f0a7a4d9b11' // gitleaks:allow (invented for this test, the token of no document)
const SECOND_TOKEN = 'ffffffff-0c0f-4d7e-9a53-2f0a7a4d9b11' // gitleaks:allow (invented for this test, the token of no document)
const THIRD_TOKEN = 'eeeeeeee-0c0f-4d7e-9a53-2f0a7a4d9b11' // gitleaks:allow (invented for this test, the token of no document)
const init = { extensionId: ID, manifest: { manifest_version: 3, name: 'Probe' }, permissions: ['activeTab', 'scripting', 'storage', 5], token: TOKEN }
const answers = (): unknown[][] => ipcRenderer.send.mock.calls.filter(([channel]) => channel === Channel.lentTabAttached).map(([, ...rest]) => rest)

beforeEach(() => {
  contextBridge.exposeInIsolatedWorld.mockReset()
  contextBridge.exposeInMainWorld.mockReset()
  ipcRenderer.send.mockReset()
  ipcRenderer.invoke.mockReset()
  webFrame.executeJavaScriptInIsolatedWorld.mockReset()
  webFrame.executeJavaScriptInIsolatedWorld.mockResolvedValue(undefined)
})

describe('the preload of a lent tab', () => {
  it('does nothing of its own: it listens to the main process and makes no bridge until it is asked', async () => {
    await loaded()
    expect(contextBridge.exposeInIsolatedWorld).not.toHaveBeenCalled()
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
    expect(webFrame.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('makes the bridge in the world it is asked for, runs the runtime there with what the extension is, and says it is done', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    await settle()
    expect(contextBridge.exposeInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(WORLD, LENT_BRIDGE_KEY, { call: expect.any(Function) })
    const [world, scripts] = webFrame.executeJavaScriptInIsolatedWorld.mock.calls[0]!
    expect(world).toBe(WORLD)
    const code = (scripts as Array<{ code: string }>)[0]!.code
    // The text of the function, called with the extension, the keys, and the words of the two refusals: nothing else is handed to the world.
    expect(code).toContain('globalThis')
    expect(code).toContain(JSON.stringify({ extensionId: ID, manifest: init.manifest, permissions: ['activeTab', 'scripting', 'storage'], bridgeKey: LENT_BRIDGE_KEY, runtimeKey: LENT_RUNTIME_KEY, noReceiver: NO_RECEIVER, portClosed: PORT_CLOSED }))
    // The token of the calls stays in the preload: the world of the script, which is the extension's own code, is not given it.
    expect(code).not.toContain(TOKEN)
    expect(JSON.stringify(contextBridge.exposeInIsolatedWorld.mock.calls[0]![2])).not.toContain(TOKEN)
    expect(answers()).toEqual([['n1', true, undefined]])
    // And never in the world of the page, which would give it the bridge.
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })

  it('has a bridge with one call, which asks the main process with the world it was made for and the token of the document, whatever the script gives', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    expect(Object.keys(api)).toEqual(['call'])
    ipcRenderer.invoke.mockResolvedValue('{"ok":true}')
    expect(await api.call('send', '{"message":1}')).toBe('{"ok":true}')
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(Channel.lentTabCall, WORLD, TOKEN, 'send', '{"message":1}')
  })

  it('carries the token the main process gave last for the world: the same bridge, asked for again with another token, calls with that one', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    attach('n2', WORLD, { ...init, token: SECOND_TOKEN })
    attach('n3', WORLD + 1, { ...init, token: THIRD_TOKEN })
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    ipcRenderer.invoke.mockResolvedValue('{"ok":true}')
    await api.call('send', '{"message":1}')
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(Channel.lentTabCall, WORLD, SECOND_TOKEN, 'send', '{"message":1}')
    const [, , other] = contextBridge.exposeInIsolatedWorld.mock.calls[1]!
    await other.call('send', '{"message":1}')
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(Channel.lentTabCall, WORLD + 1, THIRD_TOKEN, 'send', '{"message":1}')
  })

  it('does not send a text longer than a call may be (it would be received and read before it could be refused), and says so to the script', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    await expect(api.call('send', 'x'.repeat(LENT_CALL_MAX + 1))).rejects.toThrow('too long')
    await expect(api.call('storage', '['.repeat(5 * 1024 * 1024))).rejects.toThrow('too long')
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    ipcRenderer.invoke.mockResolvedValue('{"ok":true}')
    await api.call('send', 'x'.repeat(LENT_CALL_MAX))
    expect(ipcRenderer.invoke).toHaveBeenCalledOnce()
  })

  it('does not send what would pass the budget of what a world may have on its way: it answers with a closed port, as the main process does for an ask it cannot keep, and the room comes back as answers do', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    attach('n2', WORLD + 1, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    const [, , another] = contextBridge.exposeInIsolatedWorld.mock.calls[1]!
    const settles: Array<(value: string) => void> = []
    ipcRenderer.invoke.mockImplementation(() => new Promise((resolve) => settles.push(resolve)))
    const big = 'x'.repeat(LENT_CALL_MAX)
    const fits = LENT_BUDGET_CHARACTERS / LENT_CALL_MAX
    const pending = Array.from({ length: fits }, () => api.call('send', big))
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(fits)
    // One more would pass the budget: it is answered at once, and nothing is sent.
    expect(JSON.parse(await api.call('send', 'x'))).toEqual({ ok: false, error: PORT_CLOSED })
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(fits)
    // Another world has its own budget.
    void another.call('send', big)
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(fits + 1)
    // The room comes back with an answer.
    settles[0]!('{"ok":true}')
    expect(await pending[0]).toBe('{"ok":true}')
    void api.call('send', 'x')
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(fits + 2)
    for (const settle of settles.slice(1)) settle('{"ok":true}')
    await Promise.all(pending)
  })

  it('gives the room back when the main process refuses the call or does not answer it', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    ipcRenderer.invoke.mockRejectedValue(new Error('Extension context invalidated.'))
    const big = 'x'.repeat(LENT_CALL_MAX)
    for (let i = 0; i < 9; i++) await expect(api.call('send', big)).rejects.toThrow('Extension context invalidated.')
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(9)
  })

  // Whatever is handed to the bridge reaches the main process before it can be read: a text as the operation, or an object, is as heavy there as one as the payload.
  it('does not send a call whose operation is not one the bridge offers, whatever it is made of: a long text, an array, an object, anything but send and storage', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    for (const op of ['x'.repeat(1e6), 'connect', 'SEND', '', undefined, null, 5, ['send'], new Array(1000).fill(1), { toString: () => 'send' }]) await expect(api.call(op, '{}'), String(op).slice(0, 20)).rejects.toThrow('not offered')
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    ipcRenderer.invoke.mockResolvedValue('{"ok":true}')
    await api.call('send', '{"message":1}')
    await api.call('storage', '{}')
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not send what is not a text', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    const [, , api] = contextBridge.exposeInIsolatedWorld.mock.calls[0]!
    for (const payload of [{ message: 1 }, undefined, null, 5, ['a'], new Uint8Array(4)]) await expect(api.call('send', payload), String(payload)).rejects.toThrow('no text')
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('refuses a world that is not one handed to an extension (the page\'s own, the preload\'s own, any other) and an extension that is not one: nothing is exposed, and it says so', async () => {
    const attach = await loaded()
    for (const world of [0, 1, 999, 1000, SCRIPT_WORLDS_FROM - 1, SCRIPT_WORLDS_FROM + 4096, '4300000', null]) attach('n', world, init)
    attach('n', WORLD, { ...init, extensionId: 'not-an-extension-id' })
    attach('n', WORLD, { ...init, extensionId: 'A'.repeat(32) })
    attach('n', WORLD, { ...init, permissions: 'storage' })
    for (const token of [undefined, 7, '', 'short', 'x'.repeat(129)]) attach('n', WORLD, { ...init, token })
    attach('n', WORLD, null)
    attach('n', WORLD, 'text')
    expect(contextBridge.exposeInIsolatedWorld).not.toHaveBeenCalled()
    expect(webFrame.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(answers()).toHaveLength(18)
    for (const answer of answers()) expect(answer).toEqual(['n', false, expect.stringContaining('does not take')])
  })

  it('says nothing to a request with no nonce: there is no one to answer', async () => {
    const attach = await loaded()
    attach(undefined, WORLD, init)
    attach(7, WORLD, init)
    expect(ipcRenderer.send).not.toHaveBeenCalled()
    expect(contextBridge.exposeInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('makes the bridge of a world once for a document, and runs the runtime again each time it is asked (it is made once there)', async () => {
    const attach = await loaded()
    attach('n1', WORLD, init)
    attach('n2', WORLD, init)
    attach('n3', WORLD + 1, init)
    await settle()
    expect(contextBridge.exposeInIsolatedWorld.mock.calls.map(([world]) => world)).toEqual([WORLD, WORLD + 1])
    expect(webFrame.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(3)
    expect(answers().map(([nonce, ok]) => [nonce, ok])).toEqual([['n1', true], ['n2', true], ['n3', true]])
    // A new document is a new preload: its worlds are empty, and are given a bridge again.
    const again = await loaded()
    again('n4', WORLD, init)
    expect(contextBridge.exposeInIsolatedWorld).toHaveBeenCalledTimes(3)
  })

  it('says why when the world does not take the bridge or the runtime, instead of leaving the main process waiting', async () => {
    const attach = await loaded()
    contextBridge.exposeInIsolatedWorld.mockImplementationOnce(() => {
      throw new Error('no such world')
    })
    attach('n1', WORLD, init)
    expect(answers()).toEqual([['n1', false, 'no such world']])
    webFrame.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('the script failed'))
    attach('n2', WORLD, init)
    await settle()
    expect(answers().at(-1)).toEqual(['n2', false, 'the script failed'])
  })
})
