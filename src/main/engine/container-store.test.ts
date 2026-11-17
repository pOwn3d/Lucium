import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { containerFolderLastWrite, removeContainerFolders, wipeFailure, wipeSession, type WipableSession } from './container-store'
import { frenchSpaces } from '@shared/french-typography'
import { CertificateExceptions } from '@shared/error-pages'

/** A session that records what it was asked, and fails the steps named in `failing`. */
function fakeSession(failing: readonly string[] = []): { ses: WipableSession; calls: string[] } {
  const calls: string[] = []
  const step = (name: string) => async () => {
    calls.push(name)
    if (failing.includes(name)) throw new Error(`${name} refused`)
  }
  const ses: WipableSession = {
    getStoragePath: () => null,
    clearData: step('clearData'),
    clearStorageData: step('clearStorageData'),
    clearCache: step('clearCache'),
    clearCodeCaches: step('clearCodeCaches'),
    clearAuthCache: step('clearAuthCache'),
    clearHostResolverCache: step('clearHostResolverCache'),
    clearSharedDictionaryCache: step('clearSharedDictionaryCache'),
    closeAllConnections: step('closeAllConnections'),
    flushStorageData: () => {
      calls.push('flushStorageData')
      if (failing.includes('flushStorageData')) throw new Error('flush refused')
    }
  }
  return { ses, calls }
}

afterEach(() => vi.restoreAllMocks())

describe('erasing the session of a container', () => {
  it('erases cookies, storage, cache, logins and connections, then flushes the disk', async () => {
    const { ses, calls } = fakeSession()
    expect(await wipeSession(ses, 'container x', { forget: () => {} })).toEqual([])
    expect(calls).toEqual(['clearData', 'clearStorageData', 'clearCache', 'clearCodeCaches', 'clearAuthCache', 'clearHostResolverCache', 'clearSharedDictionaryCache', 'closeAllConnections', 'flushStorageData'])
  })

  it('tries every step when one fails, names what failed, and logs it with the container', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, calls } = fakeSession(['clearData', 'closeAllConnections'])
    const failed = await wipeSession(ses, 'container travail-3fa9c', { forget: () => {} })
    expect(failed).toEqual(['site-data', 'connections'])
    // The others ran all the same, and the flush came last.
    expect(calls).toHaveLength(9)
    expect(calls.at(-1)).toBe('flushStorageData')
    expect(error).toHaveBeenCalledTimes(2)
    expect(String(error.mock.calls[0]![0])).toContain('container travail-3fa9c')
  })

  // The session of a container is the same object when the container is opened again: an invalid certificate accepted before must be asked about again.
  it('forgets the invalid certificates let through in the session, even when a step failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exceptions = new CertificateExceptions()
    const { ses } = fakeSession(['clearCache'])
    exceptions.allow(ses, 'intranet.example', 'sha256/AAAA')
    exceptions.markUntrusted(ses, 'intranet.example')
    exceptions.markLetThrough(ses, 'intranet.example')
    const other = {}
    exceptions.allow(other, 'intranet.example', 'sha256/AAAA')
    await wipeSession(ses, 'container x', exceptions)
    expect(exceptions.isAllowed(ses, 'intranet.example', 'sha256/AAAA')).toBe(false)
    expect(exceptions.isUntrusted(ses, 'intranet.example')).toBe(false)
    expect(exceptions.wasLetThrough(ses, 'intranet.example')).toBe(false)
    // Another session keeps its own.
    expect(exceptions.isAllowed(other, 'intranet.example', 'sha256/AAAA')).toBe(true)
  })

  it('reports as a failure of the disk what was decided for the session and could not be forgotten, with the container in the journal, and still flushes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, calls } = fakeSession()
    const refused = new Error('EACCES: permission denied')
    const failed = await wipeSession(ses, 'container travail-3fa9c', { forget: () => { throw refused } })
    expect(failed).toEqual(['disk'])
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('cannot forget what was decided for container travail-3fa9c'), refused)
    expect(calls.at(-1)).toBe('flushStorageData')
  })

  it('reports a flush that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses } = fakeSession(['flushStorageData'])
    expect(await wipeSession(ses, 'container x', { forget: () => {} })).toEqual(['disk'])
  })

  it('says, in the error thrown to the user, what the container kept', () => {
    expect(wipeFailure('Travail', ['cache', 'connections']).message).toBe(frenchSpaces('Impossible d’effacer le cache, les connexions du conteneur « Travail ».'))
    expect(wipeFailure('Travail', ['disk']).message).toBe(frenchSpaces('Impossible d’effacer l’écriture sur le disque du conteneur « Travail ».'))
  })

  it('says it in the language of the interface, every step named in it', () => {
    setLanguage('en')
    try {
      expect(wipeFailure('Work', ['site-data', 'dns-cache']).message).toBe('Couldn’t clear the site data, the DNS cache of the container “Work”.')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('removing the folders of deleted containers', () => {
  const dirs: string[] = []
  const partitions = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lucium-containers-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('removes the folder of each container, and only that folder', () => {
    const root = partitions()
    for (const name of ['container-vieux-0', 'container-autre-1', 'profile-default', 'container-garde-2']) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, 'Cookies'), 'x')
    }
    const result = removeContainerFolders(root, ['vieux-0', 'autre-1'])
    expect(result).toEqual({ removed: ['vieux-0', 'autre-1'], failed: [] })
    expect(existsSync(join(root, 'container-vieux-0'))).toBe(false)
    expect(existsSync(join(root, 'container-autre-1'))).toBe(false)
    expect(existsSync(join(root, 'profile-default', 'Cookies'))).toBe(true)
    expect(existsSync(join(root, 'container-garde-2', 'Cookies'))).toBe(true)
  })

  it('refuses an id that could name a path outside the folder, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = partitions()
    mkdirSync(join(root, 'profile-default'))
    const removed: string[] = []
    const result = removeContainerFolders(root, ['../profile-default', 'a/b', '', '..', 'A-1'], (path) => void removed.push(path))
    expect(result).toEqual({ removed: [], failed: ['../profile-default', 'a/b', '', '..', 'A-1'] })
    expect(removed).toEqual([])
    expect(existsSync(join(root, 'profile-default'))).toBe(true)
    expect(error).toHaveBeenCalledTimes(5)
  })

  it('goes on after a folder that cannot be removed, and names it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = partitions()
    const result = removeContainerFolders(root, ['a-1', 'b-2', 'c-3'], (path) => {
      if (path.endsWith('container-b-2')) throw new Error('EBUSY')
    })
    expect(result).toEqual({ removed: ['a-1', 'c-3'], failed: ['b-2'] })
    expect(String(error.mock.calls[0]![0])).toContain('b-2')
  })
})

describe('when the folder of a container was last written', () => {
  const day = 24 * 3_600_000
  const base = Date.UTC(2026, 10, 11)
  let dir = ''
  const touch = (path: string, at: number): void => utimesSync(path, new Date(at), new Date(at))
  const folder = (id: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'lucium-container-age-'))
    const path = join(dir, `container-${id}`)
    mkdirSync(join(path, 'Network'), { recursive: true })
    writeFileSync(join(path, 'Network', 'Cookies'), 'x')
    writeFileSync(join(path, 'Preferences'), 'x')
    return path
  }
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
    vi.restoreAllMocks()
  })

  it('is the newest write among the folder and what it holds, a file two levels down included (this fails if only the folder itself is read)', () => {
    const path = folder('vieux-00000')
    touch(join(path, 'Preferences'), base - 60 * day)
    touch(join(path, 'Network', 'Cookies'), base - 3 * day)
    touch(join(path, 'Network'), base - 60 * day)
    touch(path, base - 60 * day)
    expect(containerFolderLastWrite(dir, 'vieux-00000')).toBe(base - 3 * day)
    touch(join(path, 'Network', 'Cookies'), base - 45 * day)
    expect(containerFolderLastWrite(dir, 'vieux-00000')).toBe(base - 45 * day)
  })

  it('is unknown, and said in the journal with the container, when the folder is missing or cannot be read', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dir = mkdtempSync(join(tmpdir(), 'lucium-container-age-'))
    expect(containerFolderLastWrite(dir, 'absent-00000')).toBeNull()
    expect(String(logged.mock.calls[0]![0])).toContain('absent-00000')
    const path = folder('ferme-00000')
    const refusing = { statSync: (() => ({ isDirectory: () => true, mtimeMs: 1 })) as never, readdirSync: (() => { throw new Error('EACCES') }) as never }
    expect(containerFolderLastWrite(dir, 'ferme-00000', refusing)).toBeNull()
    expect(String(logged.mock.calls.at(-1)![0])).toContain('ferme-00000')
    expect(existsSync(path)).toBe(true)
  })

  it('never looks outside the folder of containers for an id that is not a plain slug', () => {
    const statSync = vi.fn()
    expect(containerFolderLastWrite('/nowhere', '../../etc', { statSync: statSync as never, readdirSync: vi.fn() as never })).toBeNull()
    expect(statSync).not.toHaveBeenCalled()
  })
})
