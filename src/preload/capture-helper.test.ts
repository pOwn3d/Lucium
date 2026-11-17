// What the helper page of a capture of the sound of a tab is given (capture-helper.ts): one function, `send`, that hands bytes to the main process on one channel, and nothing else.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc-channels'

const contextBridge = { exposeInMainWorld: vi.fn() }
const ipcRenderer = { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), sendSync: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

async function loaded() {
  vi.resetModules()
  contextBridge.exposeInMainWorld.mockReset()
  ipcRenderer.send.mockReset()
  await import('./capture-helper')
  return contextBridge.exposeInMainWorld.mock.calls
}

describe('what the helper page is given', () => {
  it('is one object, under one name, with one function: no window.lucium, no other channel', async () => {
    const calls = await loaded()
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('luciumCapture')
    expect(Object.keys(calls[0]![1] as object)).toEqual(['send'])
  })

  it('sends bytes to the main process on its channel, and nothing else goes: not a string, a view, an object, a function, nothing', async () => {
    const calls = await loaded()
    const { send } = calls[0]![1] as { send: (chunk: unknown) => void }
    const bytes = new ArrayBuffer(24)
    send(bytes)
    expect(ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(Channel.capturePcm, bytes)
    ipcRenderer.send.mockClear()
    for (const other of ['abc', 12, null, undefined, {}, [1, 2], new Uint8Array(8), new Blob(['x']), () => 1, Symbol('x')]) send(other)
    expect(ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('has one channel, which the main process takes from the helper page of a capture and from no other page', () => {
    expect(Channel.capturePcm).toBe('lucium:capture-pcm')
  })

  it('answers nothing: the page learns nothing of what became of what it sent', async () => {
    const calls = await loaded()
    const { send } = calls[0]![1] as { send: (chunk: unknown) => unknown }
    expect(send(new ArrayBuffer(8))).toBeUndefined()
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
    expect(ipcRenderer.on).not.toHaveBeenCalled()
  })
})

beforeEach(() => vi.restoreAllMocks())
