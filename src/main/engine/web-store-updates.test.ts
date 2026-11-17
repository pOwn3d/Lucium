// The session the library's updater is handed: what it does when the library replaces an installed version, in the order the library
// calls it (electron-chrome-web-store, `updateExtension`: `removeExtension(id)`, then `loadExtension(newPath)`, then the old folder removed).

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updaterSession, type LoadedExtension, type UpdaterExtensions, type UpdateSteps } from './web-store-updates'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
let root: string
let calls: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lucium-updates-')))
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function folder(version: string): string {
  const path = join(root, ID, `${version}_0`)
  mkdirSync(path, { recursive: true })
  return path
}

/** The session's extensions: one installed version, and new versions that load or not. */
function extensionsWith(installedPath: string, refuse: Set<string> = new Set()) {
  let loaded: LoadedExtension | null = { id: ID, path: installedPath }
  const extensions: UpdaterExtensions = {
    getAllExtensions: () => (loaded ? [loaded] : []),
    getExtension: (id) => (loaded && loaded.id === id ? loaded : null),
    removeExtension: () => {
      calls.push('remove')
      loaded = null
    },
    loadExtension: async (path) => {
      calls.push(`load ${path}`)
      if (refuse.has(path)) throw new Error('Manifest file is missing or unreadable')
      loaded = { id: ID, path }
      return loaded
    }
  }
  return { extensions, loaded: () => loaded }
}

function steps(over: Partial<UpdateSteps> = {}): UpdateSteps & { failures: Array<{ restored: boolean }> } {
  const failures: Array<{ restored: boolean }> = []
  return {
    failures,
    prepare: async (path) => void calls.push(`prepare ${path}`),
    unload: (id) => {
      calls.push(`unload ${id}`)
    },
    failed: (_id, _error, restored) => void failures.push({ restored }),
    ...over
  }
}

/** What the library does for one update. */
async function libraryUpdates(session: { extensions: UpdaterExtensions }, newPath: string, oldPath: string): Promise<void> {
  if (session.extensions.getExtension(ID)) {
    session.extensions.removeExtension(ID)
    await session.extensions.loadExtension(newPath)
  }
  rmSync(oldPath, { recursive: true, force: true })
}

describe('an update applied by the library', () => {
  it('keeps the installed version until the new one is prepared, then takes it out and loads the new one', async () => {
    const oldPath = folder('1.0')
    const newPath = folder('2.0')
    const { extensions, loaded } = extensionsWith(oldPath)
    // The engine's own unload takes the installed version out of the session.
    const s = steps({ unload: (id) => void (calls.push(`unload ${id}`), extensions.removeExtension(id)) })
    await libraryUpdates(updaterSession(extensions, s, root), newPath, oldPath)
    expect(calls).toEqual([`prepare ${newPath}`, `unload ${ID}`, 'remove', `load ${newPath}`])
    expect(loaded()?.path).toBe(newPath)
    expect(s.failures).toEqual([])
  })

  it('gives its place back to the installed version when the new one does not load, removes the new folder, and keeps the old one', async () => {
    const oldPath = folder('1.0')
    const newPath = folder('2.0')
    const { extensions, loaded } = extensionsWith(oldPath, new Set([newPath]))
    const s = steps({ unload: (id) => void (calls.push(`unload ${id}`), extensions.removeExtension(id)) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The library hears the failure: it does not remove the installed folder.
    await expect(libraryUpdates(updaterSession(extensions, s, root), newPath, oldPath)).rejects.toThrow('Manifest file is missing')
    expect(loaded()?.path).toBe(oldPath)
    expect(existsSync(oldPath)).toBe(true)
    expect(existsSync(newPath)).toBe(false)
    expect(s.failures).toEqual([{ restored: true }])
    vi.restoreAllMocks()
  })

  it('says so when the installed version cannot come back either, and still keeps its folder', async () => {
    const oldPath = folder('1.0')
    const newPath = folder('2.0')
    const { extensions } = extensionsWith(oldPath, new Set([newPath, oldPath]))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = steps()
    await expect(libraryUpdates(updaterSession(extensions, s, root), newPath, oldPath)).rejects.toThrow()
    expect(s.failures).toEqual([{ restored: false }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be loaded again either'), expect.any(Error))
    expect(existsSync(oldPath)).toBe(true)
    vi.restoreAllMocks()
  })

  it('leaves the installed version running when the new one cannot be prepared', async () => {
    const oldPath = folder('1.0')
    const newPath = folder('2.0')
    const { extensions, loaded } = extensionsWith(oldPath)
    const s = steps({
      prepare: async () => {
        throw new Error('disk full')
      }
    })
    await expect(libraryUpdates(updaterSession(extensions, s, root), newPath, oldPath)).rejects.toThrow('disk full')
    expect(calls).toEqual([])
    expect(loaded()?.path).toBe(oldPath)
    expect(existsSync(newPath)).toBe(false)
    expect(s.failures).toEqual([{ restored: true }])
  })

  it('never removes a folder outside the profile\'s own', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lucium-elsewhere-')))
    try {
      const newPath = join(outside, ID, '2.0_0')
      mkdirSync(newPath, { recursive: true })
      const { extensions } = extensionsWith(folder('1.0'), new Set([newPath]))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(updaterSession(extensions, steps(), root).extensions.loadExtension(newPath)).rejects.toThrow()
      expect(existsSync(newPath)).toBe(true)
      vi.restoreAllMocks()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
