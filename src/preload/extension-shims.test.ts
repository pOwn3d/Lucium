import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The preload runs in Electron's preload context, which a service worker shares with no `location`; here that is plain Node: there is none either.
const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }

/** Loads the preload the way a worker does. `extension` is what the main world answers when asked whether `chrome.runtime.id` is there. */
async function loadInWorker(extension: boolean): Promise<void> {
  vi.resetModules()
  ;(globalThis as { __luciumBridged?: boolean }).__luciumBridged = undefined
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? extension : undefined))
  proc.type = 'service-worker'
  proc.contextIsolated = true
  await import('./extension-shims')
}

beforeEach(() => {
  contextBridge.exposeInMainWorld.mockClear()
  contextBridge.executeInMainWorld.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  vi.restoreAllMocks()
})

describe('the shims preload in a service worker', () => {
  it('starts without reading a location the worker does not have, and sets the shims up for an extension', async () => {
    expect(typeof location).toBe('undefined')
    await expect(loadInWorker(true)).resolves.toBeUndefined()
    expect(console.error).not.toHaveBeenCalled()
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('__luciumShim', expect.objectContaining({ call: expect.any(Function), onEvent: expect.any(Function) }))
    const shimsRun = contextBridge.executeInMainWorld.mock.calls.filter(([script]) => script.args !== undefined)
    // The shims, then what answers in the worker for the scripts the extension injects into the tabs the user lent it (lent-tab-agent.ts).
    expect(shimsRun.map(([script]) => script.func.name)).toEqual(['mainWorldShims', 'answerLentTabs'])
    expect(contextBridge.executeInMainWorld.mock.calls.map(([script]) => script.func.name)).toContain('fixSenderTabs')
  })

  it('hands nothing to the service worker of a web site: no bridge, no shims', async () => {
    await loadInWorker(false)
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
    expect(contextBridge.executeInMainWorld.mock.calls.filter(([script]) => script.args !== undefined)).toHaveLength(0)
    expect(console.error).not.toHaveBeenCalled()
  })
})
