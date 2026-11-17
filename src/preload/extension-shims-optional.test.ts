// The APIs of the permissions a manifest lists as facultative. The person may grant one while the extension runs, and a context cannot be given a
// namespace once the library froze `chrome`: the API is defined from the start, and every call goes to the main process, which decides. The function
// the preload injects is run for real, against a made-up `chrome`, in its two passes.

import { afterEach, describe, expect, it, vi } from 'vitest'

const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }
const g = globalThis as Record<string, any>

/** The library's `chrome.permissions`: its preload drops the error of a call, so every call answers `undefined`, refused or not. */
const libraryPermissions = () => Object.fromEntries(['request', 'contains', 'getAll', 'remove'].map((name) => [name, async () => undefined]))

async function shimmed(manifest: Record<string, unknown>, bridgeCall: (...args: unknown[]) => Promise<unknown> = async () => []) {
  vi.resetModules()
  g['__luciumBridged'] = undefined
  contextBridge.executeInMainWorld.mockReset()
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
  proc.type = 'service-worker'
  proc.contextIsolated = true
  await import('./extension-shims')
  const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
  const chrome: Record<string, any> = { runtime: { id: ID, getManifest: () => manifest, onConnect: { addListener: vi.fn() } }, tabs: {}, storage: {} }
  const bridge = { call: vi.fn(bridgeCall), onEvent: vi.fn() }
  g['chrome'] = chrome
  g['__luciumShim'] = bridge
  // Before the library's script (chrome open): the library then defines its namespaces, and freezes `chrome`.
  call.func(...call.args)
  Object.defineProperty(chrome, 'cookies', { value: { get: () => 'the library' }, configurable: true, enumerable: true })
  Object.defineProperty(chrome, 'permissions', { value: libraryPermissions(), configurable: true, enumerable: true })
  Object.freeze(chrome)
  call.func(...call.args)
  return { chrome, bridge }
}

afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['__luciumShim']
})

describe('an API whose permission the manifest lists as facultative', () => {
  it('is defined from the start, and its calls are the main process\'s to answer', async () => {
    const { chrome, bridge } = await shimmed({ manifest_version: 3, permissions: ['storage'], optional_permissions: ['history', 'cookies'] })
    expect(typeof chrome['history']?.search).toBe('function')
    await chrome['history'].search({ text: '' })
    expect(bridge.call).toHaveBeenCalledWith(ID, 'history', 'search', [{ text: '' }])
    // A namespace of the library is not held back either: the person may grant it while this context lives.
    expect(chrome['cookies']).toBeDefined()
  })

  it('is not defined for a manifest that names it nowhere, as before', async () => {
    const { chrome } = await shimmed({ manifest_version: 3, permissions: ['storage'], optional_permissions: ['bookmarks', 7, null] })
    expect(chrome['history']).toBeUndefined()
    expect(chrome['cookies']).toBeUndefined()
    expect(typeof chrome['bookmarks']?.getTree).toBe('function')
  })
})

describe('chrome.permissions', () => {
  // What the IPC layer makes of an error thrown in the main process.
  const refusal = (message: string) => async (): Promise<unknown> => {
    throw new Error(`Error invoking remote method 'lucium-shim': Error: ${message}`)
  }

  it('hands the extension the reason a request is refused, where the library answered `undefined`', async () => {
    const { chrome, bridge } = await shimmed({ manifest_version: 3, permissions: [], optional_permissions: ['bookmarks'] }, refusal('This function must be called during a user gesture'))
    await expect(chrome['permissions'].request({ permissions: ['bookmarks'] })).rejects.toThrow(/^This function must be called during a user gesture$/)
    expect(bridge.call).toHaveBeenCalledWith(ID, 'permissions', 'request', [{ permissions: ['bookmarks'] }])
    // The callback form reads it in chrome.runtime.lastError, which is gone once the callback has run.
    const heard = await new Promise<{ value: unknown; error: unknown }>((done) => chrome['permissions'].request({ permissions: ['history'] }, (value: unknown) => done({ value, error: chrome['runtime'].lastError?.message })))
    expect(heard).toEqual({ value: undefined, error: 'This function must be called during a user gesture' })
    expect(chrome['runtime'].lastError).toBeUndefined()
  })

  it('asks the main process for what is held, and answers what it answers', async () => {
    const { chrome, bridge } = await shimmed({ manifest_version: 3, permissions: ['storage'] }, async (_id, _api, method) => (method === 'getAll' ? { permissions: ['storage'], origins: [] } : true))
    expect(await chrome['permissions'].contains({ permissions: ['storage'] })).toBe(true)
    expect(await chrome['permissions'].getAll()).toEqual({ permissions: ['storage'], origins: [] })
    expect(await chrome['permissions'].remove({ permissions: ['storage'] })).toBe(true)
    expect(bridge.call.mock.calls.map((call) => call[2])).toEqual(['contains', 'getAll', 'remove'])
  })
})
