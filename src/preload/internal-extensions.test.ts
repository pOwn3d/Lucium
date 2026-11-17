// The preload of the Extensions page: what it gives, to which document, and what it sends where.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InternalChannel } from '../shared/ipc-channels'

const exposed: Array<{ name: string; api: Record<string, (...args: any[]) => any> }> = []
const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
const webUtils = { getPathForFile: vi.fn() }
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (...args: any[]) => any>) => exposed.push({ name, api }) },
  ipcRenderer,
  webUtils
}))

const g = globalThis as Record<string, unknown>

/** Loads the preload in a document with this origin; `frame`: whether it is the top frame of its page. */
async function load(origin: string, frame: 'top' | 'inner' = 'top'): Promise<Record<string, (...args: any[]) => any> | undefined> {
  vi.resetModules()
  exposed.length = 0
  g['location'] = { origin }
  const win: Record<string, unknown> = {}
  win['top'] = frame === 'top' ? win : {}
  g['window'] = win
  await import('./internal-extensions')
  expect(exposed.length).toBeLessThanOrEqual(1)
  return exposed[0]?.api
}

beforeEach(() => {
  for (const fn of [ipcRenderer.invoke, ipcRenderer.send, ipcRenderer.on, ipcRenderer.removeListener, webUtils.getPathForFile]) fn.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  delete g['location']
  delete g['window']
  vi.restoreAllMocks()
})

describe('the preload of the Extensions page', () => {
  it('gives window.lucium to the page at its exact origin, in the top frame', async () => {
    const api = await load('lucium-ui://extensions')
    expect(api).toBeDefined()
    expect(exposed[0]?.name).toBe('lucium')
  })

  it('gives eight calls and nothing else', async () => {
    const api = await load('lucium-ui://extensions')
    expect(Object.keys(api!).sort()).toEqual(['extensionUpdates', 'extensionsPage', 'getSnapshot', 'onSnapshot', 'openLocalFiles', 'openOverlay', 'openWebStore', 'pathOfDroppedFile'])
  })

  it('gives nothing to another origin, a prefix of the page’s, another scheme, or a frame inside the page', async () => {
    for (const origin of ['https://example.org', 'https://extensions', 'lucium-ui://extensions.evil.com', 'lucium-ui://extensions@evil', 'lucium-ui://extensions/', 'lucium-ui://evil', 'LUCIUM-UI://EXTENSIONS', 'chrome://extensions', 'null', '', 'file://']) {
      expect(await load(origin), origin).toBeUndefined()
    }
    expect(await load('lucium-ui://extensions', 'inner')).toBeUndefined()
  })

  it('speaks over the channels of its own, never over a channel of the interface', async () => {
    const api = (await load('lucium-ui://extensions'))!
    api['getSnapshot']!()
    api['extensionsPage']!({ op: 'details' })
    api['extensionUpdates']!()
    api['openWebStore']!()
    api['openLocalFiles']!(['/Users/jane/a.pdf'])
    const channels = [...ipcRenderer.invoke.mock.calls, ...ipcRenderer.send.mock.calls].map((call) => call[0] as string)
    expect(channels).toEqual([InternalChannel.getSnapshot, InternalChannel.extensionsPage, InternalChannel.extensionUpdates, InternalChannel.openWebStore, InternalChannel.openLocalFiles])
    for (const channel of channels) expect(channel).toMatch(/^lucium-ui:/)
    expect(ipcRenderer.send).toHaveBeenCalledWith(InternalChannel.openLocalFiles, ['/Users/jane/a.pdf'])
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(InternalChannel.extensionsPage, { op: 'details' })
  })

  it('opens Settings and no other panel: any other request goes nowhere', async () => {
    const api = (await load('lucium-ui://extensions'))!
    api['openOverlay']!({ panel: 'settings', pane: 'tools', anchor: 'extensions' })
    expect(ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(InternalChannel.openSettings, { pane: 'tools', anchor: 'extensions' })
    ipcRenderer.send.mockClear()
    for (const request of [{ panel: 'history' }, { panel: 'passwords' }, { panel: 'commandbar', mode: 'new', initial: '' }, { panel: 'extensions' }, { panel: 'downloads' }]) api['openOverlay']!(request)
    expect(ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('listens to the snapshots of its own channel, and lets go of them', async () => {
    const api = (await load('lucium-ui://extensions'))!
    const listener = vi.fn()
    const stop = api['onSnapshot']!(listener)
    expect(ipcRenderer.on).toHaveBeenCalledWith(InternalChannel.snapshot, expect.any(Function))
    const handler = ipcRenderer.on.mock.calls[0]![1] as (event: unknown, snapshot: unknown) => void
    handler({}, { extensions: [] })
    expect(listener).toHaveBeenCalledWith({ extensions: [] })
    stop()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(InternalChannel.snapshot, handler)
  })

  it('reads the path of a dropped file, and says why when there is none', async () => {
    const api = (await load('lucium-ui://extensions'))!
    webUtils.getPathForFile.mockReturnValueOnce('/Users/jane/a.pdf')
    expect(api['pathOfDroppedFile']!({})).toBe('/Users/jane/a.pdf')
    webUtils.getPathForFile.mockImplementationOnce(() => {
      throw new Error('not a file of the disk')
    })
    expect(api['pathOfDroppedFile']!({})).toBe('')
    expect(console.warn).toHaveBeenCalledWith('[drop] no path for the dropped item:', 'not a file of the disk')
  })
})
