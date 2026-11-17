import { describe, expect, it, vi } from 'vitest'
import type { ExtensionInfo } from '@shared/ipc'
import { ExtensionFolderSync, folderChanges, type ExtensionFoldersEnv } from './extension-folders'
import { frenchSpaces } from '@shared/french-typography'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const S = 's'.repeat(32)

/**
 * An engine with what it knows: an extension of a folder in two profiles, another folder in one, and an extension of the Web Store. `removeFolderAt`
 * forgets a folder the way the engine does (every profile at once), so a second call for it finds nothing.
 */
function setup(options: { loadFailure?: string; loadThrows?: Error; removeThrows?: Error } = {}) {
  const known: Array<{ info: ExtensionInfo; path: string }> = [
    { info: { id: A, name: 'Dev', version: '1', profileId: 'default', source: 'unpacked', enabled: true }, path: '/work/dev' },
    { info: { id: A, name: 'Dev', version: '1', profileId: 'work', source: 'unpacked', enabled: false }, path: '/work/dev' },
    { info: { id: B, name: 'Other', version: '1', profileId: 'default', source: 'unpacked', enabled: true }, path: '/work/other' },
    { info: { id: S, name: 'Store', version: '1', profileId: 'default', source: 'store', enabled: true }, path: '/data/Extensions/s' }
  ]
  const unloaded: string[] = []
  let release: () => void = () => undefined
  const tools = {
    folderOf: vi.fn((profileId: string, id: string) => {
      const entry = known.find((e) => e.info.profileId === profileId && e.info.id === id)
      return entry ? { path: entry.path, name: entry.info.name, version: entry.info.version, source: entry.info.source } : null
    }),
    removeFolderAt: vi.fn((path: string) => {
      if (options.removeThrows) throw options.removeThrows
      const entry = known.find((e) => e.path === path && e.info.source === 'unpacked')
      if (!entry) return null
      for (let i = known.length - 1; i >= 0; i--) if (known[i]!.path === path) unloaded.push(`${known.splice(i, 1)[0]!.info.profileId}:${path}`)
      return { path, name: entry.info.name }
    })
  }
  const env = {
    engine: { listAllExtensions: () => known.map((e) => e.info), extensionTools: tools },
    loadFolder: vi.fn(async (folder: string) => {
      await new Promise<void>((resolve) => (release = resolve))
      if (options.loadThrows) throw options.loadThrows
      if (options.loadFailure !== undefined) return options.loadFailure
      known.push({ info: { id: 'n'.repeat(32), name: 'New', version: '1', profileId: 'default', source: 'unpacked', enabled: true }, path: folder })
      return null
    }),
    notice: vi.fn((_message: string) => undefined)
  }
  const sync = new ExtensionFolderSync(env as unknown as ExtensionFoldersEnv)
  return { sync, env, tools, known, unloaded, release: () => release() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the folders a new list of Settings drops and brings', () => {
  it('names each folder once, in the order of the lists', () => {
    expect(folderChanges(['/a', '/b', '/c'], ['/c', '/d', '/d'])).toEqual({ removed: ['/a', '/b'], added: ['/d'] })
    expect(folderChanges(['/a'], ['/a'])).toEqual({ removed: [], added: [] })
  })
})

describe('the engine following the folders of Settings › Extensions', () => {
  it('only takes note of the list the first time: the launch loads its folders itself (and has said why one of them did not load)', () => {
    const t = setup()
    t.sync.follow(['/work/dev', '/work/other', '/work/gone'])
    expect(t.tools.removeFolderAt).not.toHaveBeenCalled()
    expect(t.env.loadFolder).not.toHaveBeenCalled()
  })

  it('unloads a folder taken out of the list from every profile at once, and leaves the other folders and the Web Store alone', () => {
    const t = setup()
    t.sync.follow(['/work/dev', '/work/other'])
    t.sync.follow(['/work/other'])
    expect(t.tools.removeFolderAt).toHaveBeenCalledTimes(1)
    expect(t.tools.removeFolderAt).toHaveBeenCalledWith('/work/dev')
    expect(t.unloaded.sort()).toEqual(['default:/work/dev', 'work:/work/dev'])
    expect(t.known.map((e) => e.info.id).sort()).toEqual([B, S])
    expect(t.env.notice).not.toHaveBeenCalled()
  })

  it('does not unload twice: the same list seen again, or a folder the Extensions page has already removed, changes nothing', () => {
    const t = setup()
    t.sync.follow(['/work/dev', '/work/other'])
    const after = ['/work/other']
    t.sync.follow(after)
    t.sync.follow(after)
    t.sync.follow(['/work/other'])
    expect(t.tools.removeFolderAt).toHaveBeenCalledTimes(1)
    // The Extensions page took /work/other out of the engine first, then out of the list: the engine has nothing more to unload, and nothing is said.
    t.tools.removeFolderAt('/work/other')
    t.sync.follow([])
    expect(t.unloaded.filter((line) => line.endsWith('/work/other'))).toEqual(['default:/work/other'])
    expect(t.env.notice).not.toHaveBeenCalled()
  })

  it('takes out of the list a folder that never loaded (gone from the disk at launch) without an error', () => {
    const t = setup()
    t.sync.follow(['/work/gone'])
    expect(() => t.sync.follow([])).not.toThrow()
    expect(t.tools.removeFolderAt).toHaveBeenCalledWith('/work/gone')
    expect(t.unloaded).toEqual([])
    expect(t.env.notice).not.toHaveBeenCalled()
  })

  it('loads a folder that comes into the list when no profile knows it', async () => {
    const t = setup()
    t.sync.follow([])
    t.sync.follow(['/work/new'])
    expect(t.env.loadFolder).toHaveBeenCalledWith('/work/new')
    t.release()
    await settle()
    expect(t.known.some((e) => e.path === '/work/new')).toBe(true)
    expect(t.env.notice).not.toHaveBeenCalled()
  })

  it('does not load again a folder that is already loaded (the dialog and the Extensions page load it before they write it in the list)', async () => {
    const t = setup()
    t.sync.follow([])
    t.sync.follow(['/work/dev'])
    await settle()
    expect(t.env.loadFolder).not.toHaveBeenCalled()
  })

  it('does not start a second load of a folder that is loading: taken out and put back meanwhile, it is loaded once and stays', async () => {
    const t = setup()
    t.sync.follow([])
    t.sync.follow(['/work/new'])
    t.sync.follow([])
    t.sync.follow(['/work/new'])
    expect(t.env.loadFolder).toHaveBeenCalledTimes(1)
    t.release()
    await settle()
    expect(t.known.filter((e) => e.path === '/work/new')).toHaveLength(1)
    expect(t.unloaded).toEqual([])
  })

  it('unloads a folder taken out of the list again while it was loading', async () => {
    const t = setup()
    t.sync.follow([])
    t.sync.follow(['/work/new'])
    t.sync.follow([])
    t.release()
    await settle()
    expect(t.known.some((e) => e.path === '/work/new')).toBe(false)
    expect(t.unloaded).toEqual(['default:/work/new'])
  })

  it('says when a folder that came back does not load (its folder is gone), with the folder and the reason', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ loadFailure: 'Le dossier ne contient pas de manifest.json lisible.' })
    t.sync.follow([])
    t.sync.follow(['/work/gone'])
    t.release()
    await settle()
    expect(t.env.notice).toHaveBeenCalledTimes(1)
    expect(t.env.notice.mock.calls[0]![0]).toBe(frenchSpaces('L’extension du dossier « gone » n’a pas été chargée. Le dossier ne contient pas de manifest.json lisible.'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/work/gone'))
    error.mockRestore()
  })

  it('says it too when the load itself throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ loadThrows: new Error('Loading extension at /work/gone failed with: Manifest file is missing or unreadable') })
    t.sync.follow([])
    t.sync.follow(['/work/gone'])
    t.release()
    await settle()
    expect(t.env.notice).toHaveBeenCalledTimes(1)
    expect(t.env.notice.mock.calls[0]![0]).toContain('gone')
    error.mockRestore()
  })

  it('says when the engine could not unload the extension, and logs it with its folder', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ removeThrows: new Error('session gone') })
    t.sync.follow(['/work/dev'])
    expect(() => t.sync.follow([])).not.toThrow()
    expect(t.env.notice).toHaveBeenCalledWith(frenchSpaces('L’extension du dossier « dev » n’a pas pu être déchargée. session gone'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/work/dev'), expect.any(Error))
    error.mockRestore()
  })
})
