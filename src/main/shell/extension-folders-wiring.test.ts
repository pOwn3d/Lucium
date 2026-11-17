// The folders of Settings › Extensions are followed by the main window's browser each time it applies the settings (`configureExtensions`, run at
// its start and at every change of the state): the « Retirer » of Settings only shortens the list, and the extension leaves the engine at once.
// The method runs on a stand-in (browser-fake.test-support.ts) with a real follower (extension-folders.ts) and an engine that records.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { defaultSettings, type SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const A = 'a'.repeat(32)

function windowOf(kind: 'main' | 'private' | 'secondary') {
  let state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), extensionPaths: ['/work/dev'] } }
  const removeFolderAt = vi.fn((_path: string) => null)
  const engine = {
    configureExtensions: vi.fn(),
    listAllExtensions: () => [{ id: A, name: 'Dev', version: '1', profileId: 'default', source: 'unpacked' as const, enabled: true }],
    extensionTools: { folderOf: () => ({ path: '/work/dev', name: 'Dev', version: '1', source: 'unpacked' as const }), removeFolderAt }
  }
  const loadExtensionFolder = vi.fn(async (_folder: string) => null)
  const fake = fakeBrowser({
    isPrivate: () => kind === 'private',
    isSecondary: () => kind === 'secondary',
    store: { get: () => state },
    engine,
    extensionsKey: '',
    extensionFolders: null,
    loadExtensionFolder
  })
  const apply = (extensionPaths: string[]): void => {
    state = { ...state, settings: { ...state.settings, extensionPaths } }
    shell['configureExtensions']!.call(fake.self)
  }
  // The start of the window: the list is taken note of.
  shell['configureExtensions']!.call(fake.self)
  return { apply, removeFolderAt, loadExtensionFolder }
}

describe('the folders of Settings › Extensions, as the main window applies the settings', () => {
  it('unload a folder the list no longer has, at once', () => {
    const w = windowOf('main')
    w.apply([])
    expect(w.removeFolderAt).toHaveBeenCalledWith('/work/dev')
  })

  it('load a folder the list has gained', () => {
    const w = windowOf('main')
    w.apply(['/work/dev', '/work/new'])
    expect(w.loadExtensionFolder).toHaveBeenCalledWith('/work/new')
    expect(w.removeFolderAt).not.toHaveBeenCalled()
  })

  it('are left to the main window: a private window or a second window over the same tabs does nothing with them', () => {
    for (const kind of ['private', 'secondary'] as const) {
      const w = windowOf(kind)
      w.apply([])
      w.apply(['/work/new'])
      expect(w.removeFolderAt).not.toHaveBeenCalled()
      expect(w.loadExtensionFolder).not.toHaveBeenCalled()
    }
  })
})
