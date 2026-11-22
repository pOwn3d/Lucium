import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/lucium-test', once: () => {}, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null }
}))

const { ExtensionShims } = await import('./extension-shims')

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

function rig() {
  const engine = {
    setTabFactsProvider: () => {},
    onTabClosed: () => {},
    onDownload: () => {},
    onContextGone: () => {},
    listAllExtensions: () => [
      { id: EXT, name: 'Me', version: '1', profileId: 'default', source: 'store', enabled: true },
      { id: 'b'.repeat(32), name: 'Other', version: '2', profileId: 'work', source: 'unpacked', enabled: false }
    ]
  }
  const shims = new ExtensionShims({} as never, engine as never, { get: () => ({ settings: {} }) } as never)
  return (method: string, args: unknown[] = [], profileId = 'default') => shims.handle({ extensionId: EXT, profileId, context: 'worker:1', api: 'management', method, args })
}

describe('chrome.management in the main process', () => {
  it('answers getAll with the extensions of the profile of the caller only', async () => {
    const call = rig()
    expect(((await call('getAll')) as Array<{ id: string }>).map((item) => item.id)).toEqual([EXT])
    expect(((await call('getAll', [], 'work')) as Array<{ name: string }>).map((item) => item.name)).toEqual(['Other'])
  })

  it('says a method it does not provide', async () => {
    await expect(rig()('uninstall', [EXT])).rejects.toThrow('chrome.management.uninstall is not provided')
  })
})
