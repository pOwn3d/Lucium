// chrome.tabCapture in the contexts of an extension: the sound of a tab, through the channels of its own. The function the preload injects is run for
// real, against a made-up `chrome` and bridge, in its two passes; and the bridge it hands the contexts is read from what it sends over IPC.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc-channels'

const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }
const g = globalThis as Record<string, any>

/** What the IPC layer makes of an error thrown in the main process. */
const refused = (message: string) => async (): Promise<unknown> => {
  throw new Error(`Error invoking remote method 'lucium:ext-tab-capture-id': Error: ${message}`)
}

async function shimmed(manifest: Record<string, unknown>, tabCapture: Record<string, unknown> | null = { id: async () => 'an-identifier', list: async () => [] }) {
  vi.resetModules()
  g['__luciumBridged'] = undefined
  contextBridge.executeInMainWorld.mockReset()
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
  proc.type = 'service-worker'
  proc.contextIsolated = true
  await import('./extension-shims')
  const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
  const chrome: Record<string, any> = { runtime: { id: ID, getManifest: () => manifest, onConnect: { addListener: vi.fn() } }, tabs: {}, storage: {} }
  g['chrome'] = chrome
  g['__luciumShim'] = { call: vi.fn(async () => undefined), onEvent: vi.fn(), ...(tabCapture ? { tabCapture } : {}) }
  call.func(...call.args)
  Object.freeze(chrome)
  call.func(...call.args)
  return chrome
}

beforeEach(() => {
  ipcRenderer.invoke.mockReset()
  ipcRenderer.on.mockReset()
})
afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['__luciumShim']
})

describe('chrome.tabCapture', () => {
  it('is defined for an extension that declared tabCapture, with getMediaStreamId and getCapturedTabs and nothing of the picture or the screen', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] })
    expect(Object.keys(chrome['tabCapture']).sort()).toEqual(['getCapturedTabs', 'getMediaStreamId', 'onStatusChanged'])
    expect(chrome['tabCapture'].capture).toBeUndefined()
    expect(chrome['desktopCapture']).toBeUndefined()
  })

  it('is not defined for an extension that did not declare it', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: ['activeTab', 'tabs'] })
    expect(chrome['tabCapture']).toBeUndefined()
  })

  it('is defined from the start for a permission the manifest lists as facultative: the main process decides each call', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: [], optional_permissions: ['tabCapture'] })
    expect(typeof chrome['tabCapture']?.getMediaStreamId).toBe('function')
  })

  it('is not defined where the context has no channel for it', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] }, null)
    expect(chrome['tabCapture']).toBeUndefined()
  })

  it('asks the main process for an identifier, with what it was given, and answers with it (a promise)', async () => {
    const id = vi.fn(async () => 'an-identifier')
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] }, { id, list: async () => [] })
    expect(await chrome['tabCapture'].getMediaStreamId({ targetTabId: 7 })).toBe('an-identifier')
    expect(id).toHaveBeenCalledWith({ targetTabId: 7 })
    await chrome['tabCapture'].getMediaStreamId()
    expect(id).toHaveBeenLastCalledWith(undefined)
  })

  it('answers a callback as well, with the options before it or alone', async () => {
    const id = vi.fn(async () => 'an-identifier')
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] }, { id, list: async () => [] })
    const answers = await Promise.all([
      new Promise((done) => chrome['tabCapture'].getMediaStreamId({ targetTabId: 7 }, done)),
      new Promise((done) => chrome['tabCapture'].getMediaStreamId(done))
    ])
    expect(answers).toEqual(['an-identifier', 'an-identifier'])
    expect(id.mock.calls).toEqual([[{ targetTabId: 7 }], [undefined]])
  })

  it('hands the extension the reason of a refusal, without the words of the IPC layer: a rejected promise, or lastError for a callback', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] }, { id: refused("Lucium: the capture of a tab's sound is switched off for this extension (Extensions › Details)"), list: async () => [] })
    await expect(chrome['tabCapture'].getMediaStreamId({ targetTabId: 7 })).rejects.toThrow(/^Lucium: the capture of a tab's sound is switched off for this extension \(Extensions › Details\)$/)
    const heard = await new Promise<{ value: unknown; error: unknown }>((done) => chrome['tabCapture'].getMediaStreamId({ targetTabId: 7 }, (value: unknown) => done({ value, error: chrome['runtime'].lastError?.message })))
    expect(heard.value).toBeUndefined()
    expect(String(heard.error)).toMatch(/^Lucium: the capture of a tab's sound is switched off/)
    expect(chrome['runtime'].lastError).toBeUndefined()
  })

  it('lists what it captures', async () => {
    const list = vi.fn(async () => [{ tabId: 7, status: 'active', fullscreen: false }])
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] }, { id: async () => 'x', list })
    expect(await chrome['tabCapture'].getCapturedTabs()).toEqual([{ tabId: 7, status: 'active', fullscreen: false }])
  })

  it('has an event to listen to that says nothing', async () => {
    const chrome = await shimmed({ manifest_version: 3, permissions: ['tabCapture'] })
    const listener = vi.fn()
    chrome['tabCapture'].onStatusChanged.addListener(listener)
    expect(chrome['tabCapture'].onStatusChanged.hasListener(listener)).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the bridge a context of an extension is handed for the sound of a tab', () => {
  async function exposed() {
    contextBridge.exposeInMainWorld.mockClear()
    vi.resetModules()
    g['__luciumBridged'] = undefined
    contextBridge.executeInMainWorld.mockReset()
    contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
    proc.type = 'service-worker'
    proc.contextIsolated = true
    await import('./extension-shims')
    return contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === '__luciumShim')![1].tabCapture as Record<string, (...args: unknown[]) => unknown>
  }

  it('sends each call on a channel of its own, with what it was given and nothing of who is asking', async () => {
    const bridge = await exposed()
    await bridge['id']!({ targetTabId: 7 })
    await bridge['listen']!('an-identifier')
    await bridge['end']!('an-identifier')
    await bridge['list']!()
    expect(ipcRenderer.invoke.mock.calls).toEqual([[Channel.extTabCaptureId, { targetTabId: 7 }], [Channel.extTabCaptureListen, 'an-identifier'], [Channel.extTabCaptureEnd, 'an-identifier'], [Channel.extTabCaptureList]])
  })

  it('hears the sound the main process hands the page, for an identifier, and for nothing else', async () => {
    const bridge = await exposed()
    const heard = vi.fn()
    bridge['onPcm']!(heard)
    const [channel, deliver] = ipcRenderer.on.mock.calls.find(([name]) => name === Channel.extTabCapturePcm)!
    expect(channel).toBe(Channel.extTabCapturePcm)
    const sound = new ArrayBuffer(24)
    deliver({}, 'an-identifier', sound)
    deliver({}, 12, sound)
    deliver({}, { id: 'an-identifier' }, sound)
    expect(heard.mock.calls).toEqual([['an-identifier', sound]])
  })

  it('hears the main process ask the page to end its stream, for an identifier, and for nothing else', async () => {
    const bridge = await exposed()
    const heard = vi.fn()
    bridge['onStop']!(heard)
    const [channel, deliver] = ipcRenderer.on.mock.calls.find(([name]) => name === Channel.extTabCaptureStop)!
    expect(channel).toBe(Channel.extTabCaptureStop)
    deliver({}, 'an-identifier')
    deliver({}, 12)
    deliver({}, { id: 'an-identifier' })
    expect(heard.mock.calls).toEqual([['an-identifier']])
  })
})
