import { describe, expect, it, vi } from 'vitest'
import type { ExtensionInfo } from '@shared/ipc'
import { ExtensionDev, ExtensionDevError, type ExtensionDevHost } from './extension-dev'
import { frenchSpaces } from '@shared/french-typography'
import type { GrantedFacts } from '@shared/optional-permissions'

// The engine reads Electron's app, picture and web contents only for what the page asks of an icon, and to listen: none of it runs here.
vi.mock('electron', () => ({ app: { on: vi.fn(), off: vi.fn() }, nativeImage: {}, webContents: { getAllWebContents: () => [] } }))

const A = 'a'.repeat(32)
const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: A, name: 'Dev', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true, ...over })

function setup(options: { entries?: Array<{ info: ExtensionInfo; path: string; manifest: unknown }>; loaded?: boolean; loadError?: Error; granted?: GrantedFacts } = {}) {
  const entries = options.entries ?? [{ info: info(), path: '/work/dev', manifest: { manifest_version: 3, name: 'Dev', version: '1.0', description: 'A dev tool' } }]
  const calls: string[] = []
  const host: ExtensionDevHost = {
    sources: () => [],
    known: () => entries,
    isLoaded: () => options.loaded !== false,
    workerRunning: (_profile, id) => id === A,
    unload: (profile, id) => void calls.push(`unload ${profile}:${id}`),
    load: async (profile, path) => {
      calls.push(`load ${profile}:${path}`)
      if (options.loadError) throw options.loadError
      return info()
    },
    forgetFolder: (path) => void calls.push(`forget ${path}`),
    grantedOf: () => options.granted ?? { permissions: [], origins: [] },
    revokeGranted: (profile, id, name) => {
      calls.push(`revoke ${profile}:${id}:${name}`)
      return name === 'history'
    }
  }
  return { dev: new ExtensionDev(host), calls, entries }
}

describe('what the engine keeps for the Extensions page', () => {
  it('starts with nothing: no entry, no listening', () => {
    const { dev } = setup()
    expect(dev.readJournal()).toEqual([])
    expect(dev.lastJournalId()).toBe(0)
    expect(dev.isWatching()).toBe(false)
  })

  describe('a line of the browser about an extension', () => {
    it('is a warning in the journal of that extension in that profile, and the same sentence said again is one line, the newest', () => {
      const { dev } = setup()
      dev.note('default', A, 'asked for cookies: refused')
      dev.note('work', A, 'asked for cookies: refused')
      dev.note('default', A, 'asked for history: refused')
      dev.note('default', A, 'asked for cookies: refused')
      expect(dev.readJournal({ profileId: 'default', extensionId: A }).map((entry) => entry.message)).toEqual(['asked for history: refused', 'asked for cookies: refused'])
      expect(dev.readJournal({ profileId: 'work', extensionId: A })).toMatchObject([{ level: 'warning', source: 'browser', message: 'asked for cookies: refused' }])
    })
  })

  describe('a load that failed', () => {
    it('is put in words, written in the journal with the folder, and kept as the state of that folder in that profile', () => {
      const { dev } = setup()
      const sentence = dev.failed('default', '/work/dev', A, new Error('Manifest file is missing or unreadable'))
      expect(sentence).toMatch(/manifest\.json/)
      expect(dev.readJournal()).toMatchObject([{ level: 'error', source: 'load', profileId: 'default', extensionId: A, message: sentence, where: '/work/dev' }])
      expect(dev.failure('default', '/work/dev')).toBe(sentence)
      expect(dev.failure('work', '/work/dev')).toBeUndefined()
    })

    it('keeps a sentence of ours as it is', () => {
      const { dev } = setup()
      expect(dev.failed('default', '/work/dev', undefined, frenchSpaces('manifest.json : « name » manque ou est vide.'))).toBe(frenchSpaces('manifest.json : « name » manque ou est vide.'))
    })

    it('is forgotten once the folder loads', () => {
      const { dev } = setup()
      dev.failed('default', '/work/dev', A, new Error('x'))
      dev.loaded('default', '/work/dev')
      expect(dev.failure('default', '/work/dev')).toBeUndefined()
    })

    it('shows in the details of the extension that has that folder, as the reason it is not loaded', async () => {
      const { dev } = setup({ entries: [{ info: info({ enabled: false }), path: '/work/dev', manifest: { manifest_version: 3 } }] })
      dev.failed('default', '/work/dev', A, new Error('Invalid value'))
      const [detail] = await dev.details()
      expect(detail?.failure).toBe(frenchSpaces('Le moteur a refusé l’extension : Invalid value'))
    })
  })

  describe('details', () => {
    it('gives the manifest facts, the folder and the state of the worker of each extension', async () => {
      const { dev } = setup()
      const [detail] = await dev.details()
      expect(detail).toMatchObject({ profileId: 'default', id: A, path: '/work/dev', workerRunning: true, facts: { description: 'A dev tool', manifestVersion: 3 } })
    })

    it('lists what the person granted the extension on its request, and says nothing of it when there is nothing', async () => {
      const granted: GrantedFacts = { permissions: [{ id: 'history', label: 'Lire', level: 'broad' }], origins: ['https://a.example/*'] }
      expect((await setup({ granted }).dev.details())[0]?.granted).toEqual(granted)
      expect((await setup().dev.details())[0]).not.toHaveProperty('granted')
    })

    it('takes a granted permission back through the engine, and answers whether it was held', () => {
      const { dev, calls } = setup()
      expect(dev.revokeGranted('default', A, 'history')).toBe(true)
      expect(dev.revokeGranted('default', A, 'cookies')).toBe(false)
      expect(calls).toEqual([`revoke default:${A}:history`, `revoke default:${A}:cookies`])
    })

    it('says "no facts" for an extension whose manifest could not be read, instead of failing the whole list', async () => {
      const { dev } = setup({ entries: [{ info: info(), path: '/work/dev', manifest: null }, { info: info({ id: 'b'.repeat(32) }), path: '/work/two', manifest: { manifest_version: 3 } }] })
      const details = await dev.details()
      expect(details.map((d) => d.facts === null)).toEqual([true, false])
    })
  })

  describe('reload', () => {
    it('unloads the extension from the profile, then loads its folder again', async () => {
      const { dev, calls } = setup()
      await dev.reload('default', A)
      expect(calls).toEqual([`unload default:${A}`, 'load default:/work/dev'])
    })

    it('only loads an extension that is not loaded because its last load failed (nothing to unload)', async () => {
      const { dev, calls } = setup({ loaded: false })
      dev.failed('default', '/work/dev', A, new Error('Invalid value'))
      expect(dev.failureOf('default', A)).toMatch(/Invalid value/)
      await dev.reload('default', A)
      expect(calls).toEqual(['load default:/work/dev'])
    })

    it('has no failure to tell for an extension that is loaded, or one nobody knows', () => {
      const { dev } = setup()
      dev.failed('default', '/work/dev', A, new Error('old'))
      expect(dev.failureOf('default', A)).toBeUndefined()
      expect(dev.failureOf('work', A)).toBeUndefined()
    })

    it('refuses, with a sentence, an extension that is not there or is switched off, and unloads nothing', async () => {
      const gone = setup({ entries: [] })
      await expect(gone.dev.reload('default', A)).rejects.toThrow(ExtensionDevError)
      expect(gone.calls).toEqual([])
      const off = setup({ loaded: false })
      await expect(off.dev.reload('default', A)).rejects.toThrow(/Activez/)
      expect(off.calls).toEqual([])
    })

    it('passes on what the engine rejects with when the folder will not load', async () => {
      const { dev } = setup({ loadError: new Error('Invalid manifest') })
      await expect(dev.reload('default', A)).rejects.toThrow('Invalid manifest')
    })
  })

  describe('removing a folder', () => {
    it('forgets the folder of an extension that came from one, and answers it', () => {
      const { dev, calls } = setup()
      expect(dev.removeFolder(A)).toEqual({ path: '/work/dev', name: 'Dev' })
      expect(calls).toEqual(['forget /work/dev'])
    })

    it('leaves the extension of the Web Store alone', () => {
      const { dev, calls } = setup({ entries: [{ info: info({ source: 'store' }), path: '/store/a', manifest: {} }] })
      expect(dev.removeFolder(A)).toBeNull()
      expect(calls).toEqual([])
    })

    it('forgets a folder named by its path (taken out of Settings), and only a folder some extension comes from', () => {
      const { dev, calls } = setup({ entries: [{ info: info(), path: '/work/dev', manifest: {} }, { info: info({ id: 'b'.repeat(32), source: 'store' }), path: '/store/b', manifest: {} }] })
      expect(dev.removeFolderAt('/work/elsewhere')).toBeNull()
      expect(dev.removeFolderAt('/store/b')).toBeNull()
      expect(calls).toEqual([])
      expect(dev.removeFolderAt('/work/dev')).toEqual({ path: '/work/dev', name: 'Dev' })
      expect(calls).toEqual(['forget /work/dev'])
    })
  })

  it('finds the folder of an extension in a profile, with where it came from', () => {
    const { dev } = setup()
    expect(dev.folderOf('default', A)).toEqual({ path: '/work/dev', name: 'Dev', version: '1.0', source: 'unpacked' })
    expect(dev.folderOf('work', A)).toBeNull()
  })
})
