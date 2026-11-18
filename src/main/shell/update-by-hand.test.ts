// Lucium › Rechercher les mises à jour… on Windows and Linux (carte 469). Those builds carry no update address and no installer (the beta of 1.1.4 published
// on 18 November 2026): the box used to say « La vérification des mises à jour n’est pas configurée » and name the `updateFeedUrl` setting to a person who
// had configured nothing. It now says that updates are made by hand and offers the download page of the site, in the language of the interface. macOS keeps
// its box, which the tests of update-feed.test.ts and update-source.test.ts hold: the one test of it here only proves the rule does not reach it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.4', getPath: () => '/nonexistent', isPackaged: false, on: vi.fn(), off: vi.fn() },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  contentTracing: {},
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => null }
}))

const { checkForUpdates } = await import('./menu-actions')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const system = (platform: NodeJS.Platform): void => void Object.defineProperty(process, 'platform', { value: platform })
/** The settings of a profile that wrote no address: what a person of the beta has. */
const settings: Settings = { ...defaultSettings(), updateFeedUrl: '' }
const target = () => ({ win: { isDestroyed: () => false }, browser: { showToast: vi.fn() } }) as unknown as Parameters<typeof checkForUpdates>[0]
const shown = () => electron.showMessageBox.mock.calls[0]![1] as { type: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

beforeEach(() => {
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
  electron.fetch.mockReset().mockRejectedValue(new Error('no network in this test'))
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
  electron.openExternal.mockReset().mockResolvedValue(undefined)
  setLanguage('fr')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  vi.unstubAllEnvs()
  setLanguage('fr')
})

describe.each<NodeJS.Platform>(['win32', 'linux'])('Rechercher les mises à jour… on %s, with no update address', (platform) => {
  beforeEach(() => system(platform))

  it('says in French that updates are made by hand, with the version in use, and offers the page; it names no setting and reads no feed', async () => {
    await checkForUpdates(target(), settings)
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    const box = shown()
    expect(box.message).toBe('Les mises à jour se font à la main')
    expect(box.detail).toBe(frenchSpaces('Vous utilisez Lucium 1.1.4. Cette version ne cherche pas les mises à jour d’elle-même : pour avoir la dernière, téléchargez-la sur lucium.app.'))
    expect(box.buttons).toEqual(['Ouvrir la page Télécharger', 'Fermer'])
    expect(box.cancelId).toBe(1)
    // Nothing of the old box: a setting nobody wrote, a variable of the sources.
    expect(box.message + box.detail).not.toMatch(/updateFeedUrl|LUCIUM_UPDATE_FEED|configur|adresse/i)
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('says it in English, and opens the English download page from its first button', async () => {
    setLanguage('en')
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await checkForUpdates(target(), settings)
    const box = shown()
    expect(box.message).toBe('Updates are done by hand')
    expect(box.detail).toBe('You’re using Lucium 1.1.4. This version doesn’t look for updates by itself: to get the latest one, download it from lucium.app.')
    expect(box.buttons).toEqual(['Open the Download Page', 'Close'])
    expect(electron.openExternal).toHaveBeenCalledOnce()
    expect(electron.openExternal).toHaveBeenCalledWith('https://lucium.app/en/download/')
  })

  it('opens the French page from the first button, and nothing from the second', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await checkForUpdates(target(), settings)
    expect(electron.openExternal).toHaveBeenCalledWith('https://lucium.app/telecharger/')
    electron.openExternal.mockClear()
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    await checkForUpdates(target(), settings)
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('still reads an address a person wrote in the setting (a build of their own): the by-hand box is for a build that has none', async () => {
    electron.fetch.mockResolvedValue({ ok: false, status: 404, url: 'https://feed.example/latest', arrayBuffer: async () => new ArrayBuffer(0) })
    await checkForUpdates(target(), { ...settings, updateFeedUrl: 'https://feed.example/latest' })
    expect(electron.fetch).toHaveBeenCalledOnce()
    expect(shown().message).not.toBe('Les mises à jour se font à la main')
  })
})

describe('Rechercher les mises à jour… on macOS, with no update address', () => {
  it('keeps its box: the setting is named, and no page is offered by this rule', async () => {
    system('darwin')
    await checkForUpdates(target(), settings)
    const box = shown()
    expect(box.message).toBe('La vérification des mises à jour n’est pas configurée')
    expect(box.detail).toContain('Cette version ne porte pas d’adresse de mises à jour.')
    expect(box.detail).toContain('updateFeedUrl')
    expect(box.buttons).toBeUndefined()
    expect(electron.openExternal).not.toHaveBeenCalled()
  })
})
