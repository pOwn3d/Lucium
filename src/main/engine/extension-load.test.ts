import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MANIFEST_LIST_MAX } from '@shared/chrome-compat'
import { ManifestRefusal, describeLoadError } from '@shared/extension-page'
import { setLanguage } from '@shared/i18n'
import { loadChecked } from './extension-load'

beforeEach(() => setLanguage('fr'))

const sites = (count: number): string[] => Array.from({ length: count }, (_v, i) => `https://site${i}.example/*`)

describe('a folder of an extension that is about to be loaded', () => {
  it('is handed to the engine when its manifest stays within what is read of it', async () => {
    const load = vi.fn(async (folder: string) => `loaded ${folder}`)
    const manifest = { manifest_version: 3, permissions: ['tabs'], host_permissions: sites(MANIFEST_LIST_MAX) }
    expect(await loadChecked('/work/ext', { readManifest: () => manifest, load })).toBe('loaded /work/ext')
    expect(load).toHaveBeenCalledExactlyOnceWith('/work/ext')
  })

  it('is refused, and never reaches the engine, when a list of its manifest goes past the bound of the review sheet', async () => {
    const wide = [
      { manifest_version: 3, host_permissions: sites(MANIFEST_LIST_MAX + 1) },
      { manifest_version: 3, permissions: Array.from({ length: MANIFEST_LIST_MAX + 1 }, (_v, i) => `p${i}`) },
      // The pages of all its content scripts together: the engine injects into every one of them, read or not.
      { manifest_version: 3, content_scripts: [{ matches: sites(300) }, { matches: sites(300) }] }
    ]
    for (const manifest of wide) {
      const load = vi.fn(async () => 'loaded')
      const refused = loadChecked('/work/ext', { readManifest: () => manifest, load })
      await expect(refused).rejects.toBeInstanceOf(ManifestRefusal)
      await expect(refused).rejects.toThrow('plus de 512 dans une liste')
      expect(load).not.toHaveBeenCalled()
    }
  })

  it('is refused with a sentence the Extensions page shows as it is', async () => {
    const error = await loadChecked('/work/ext', { readManifest: () => ({ host_permissions: sites(MANIFEST_LIST_MAX + 1) }), load: async () => 'loaded' }).catch((caught: unknown) => caught)
    expect(describeLoadError(error, '/work/ext')).toBe((error as Error).message)
    expect((error as Error).message).toContain('n’est donc pas chargée')
  })

  it('leaves a manifest that cannot be read to the engine, which says why itself', async () => {
    const load = vi.fn(async () => {
      throw new Error('Manifest file is missing or unreadable')
    })
    await expect(loadChecked('/work/ext', { readManifest: () => null, load })).rejects.toThrow('Manifest file is missing')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
