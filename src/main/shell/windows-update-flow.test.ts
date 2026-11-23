// The update of Windows from the menu to the installer, on the readers the application really uses (a signed feed on a throw-away key, the real check of the system, of the
// date and of the version, the real boxes) and a stand-in for what runs the installer. Nothing reaches the network, no installer runs, no window opens.
// What it holds: a feed that is not for this system, not newer, replayed or unsigned offers nothing and downloads nothing; an installer is downloaded only after the first click,
// and run only after the second; a build that is not the installed application, or an address written by hand, never installs.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { setLanguage, t } from '@shared/i18n'
import type { InstallerDownload } from '../update-installer-file'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn(), userData: '', built: true }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.5', getPath: () => electron.userData, isPackaged: false, on: vi.fn(), off: vi.fn() },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  contentTracing: {},
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => null }
}))
vi.mock('../runtime', async (original) => ({ ...(await original<typeof import('../runtime')>()), isBuiltApp: () => electron.built }))
const keys = await vi.hoisted(async () => {
  const { newFeedKeyPair } = await import('../update-feed-signature')
  return { ours: newFeedKeyPair(), theirs: newFeedKeyPair() }
})
vi.mock('../update-feed-keys', () => ({ UPDATE_FEED_PUBLIC_KEYS: [keys.ours.publicKey] }))

const { signFeedText } = await import('../update-feed-signature')
const { checkForUpdates } = await import('./menu-actions')
const { WindowsUpdateInstaller } = await import('./windows-update')
const { UpdateInstaller, installerAtQuit, setUpdateInstaller, updateInstaller } = await import('./app-update')
const { createAutoUpdater } = await import('./auto-update')
const { currentUpdateSources } = await import('./update-source')

const WIN_FEED = 'https://lucium.app/updates/win32-x64/feed.json'
const SETUP_URL = 'https://lucium.app/updates/win32-x64/Lucium-Setup-1.2.0-x64.exe'
const SUM = 'c'.repeat(64)
const FILE = 'C:\\Temp\\lucium-update\\Lucium-Setup.exe'
const settings: Settings = { ...defaultSettings(), autoUpdate: true, updateFeedUrl: '' }

const windowsFile = (over: Record<string, unknown> = {}, release: Record<string, unknown> = {}) => ({
  currentRelease: '1.2.0',
  platform: 'win32',
  arch: 'x64',
  kind: 'nsis',
  releases: [{ version: '1.2.0', updateTo: { url: SETUP_URL, notes: 'Notes.', sha256: SUM, size: 1000, pub_date: '2026-11-24T09:00:00Z', ...release } }],
  ...over
})
const serve = (json: unknown, signedBy = keys.ours.privatePem) => async () => {
  const bytes = new TextEncoder().encode(signFeedText(`${JSON.stringify(json, null, 2)}\n`, [signedBy]))
  return { ok: true, status: 200, url: WIN_FEED, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
}

const real = { platform: Object.getOwnPropertyDescriptor(process, 'platform')!, arch: Object.getOwnPropertyDescriptor(process, 'arch')! }
let record: { downloads: unknown[]; launched: string[]; quit: number; prepared: number; verified: number }
const wire = () => {
  record = { downloads: [], launched: [], quit: 0, prepared: 0, verified: 0 }
  const installer = new WindowsUpdateInstaller({
    feed: () => currentUpdateSources(settings).install,
    download: async (offer): Promise<InstallerDownload> => {
      record.downloads.push(offer)
      return { ok: true, file: FILE, sha256: SUM }
    },
    verify: async () => {
      record.verified += 1
      return true
    },
    launch: async (file) => void record.launched.push(file),
    discard: async () => {},
    discardNow: () => {},
    withdrawn: async () => [],
    prepareQuit: () => void (record.prepared += 1),
    quit: () => void (record.quit += 1),
    report: () => {},
    log: () => {}
  })
  setUpdateInstaller(installer)
  return installer
}

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'lucium-windows-flow-'))
  electron.built = true
  electron.fetch.mockReset()
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
  electron.openExternal.mockReset().mockResolvedValue(undefined)
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED', WIN_FEED)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  setLanguage('fr')
})
afterEach(() => {
  setUpdateInstaller(null)
  Object.defineProperty(process, 'platform', real.platform)
  Object.defineProperty(process, 'arch', real.arch)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(electron.userData, { recursive: true, force: true })
})

const menu = () => checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], settings, { searching: false })
/** The options of the nth box (a box hung from no window takes its options first). */
const box = (at: number) => electron.showMessageBox.mock.calls[at]!.at(-1) as { message: string; detail: string; buttons?: string[] }
const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const untilBoxes = (count: number) => vi.waitFor(() => expect(electron.showMessageBox.mock.calls.length).toBeGreaterThanOrEqual(count))

describe('the update from the menu, on Windows', () => {
  it('downloads after the first click, runs nothing until the second, and quits only once the installer is running', async () => {
    const installer = wire()
    electron.fetch.mockImplementation(serve(windowsFile()))
    // « Télécharger et installer » (0), then « Plus tard » (1) at « Lucium 1.2.0 est prêt ».
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    await later()
    expect(box(0).message).toBe(t('app-update.la-version-version-est-disponible', { version: '1.2.0' }))
    expect(box(0).buttons).toEqual([t('app-update.telecharger-et-installer'), t('menu-actions.plus-tard')])
    // One download, of the offer the signed feed made: its address, its sum and its size.
    expect(record.downloads).toHaveLength(1)
    expect(record.downloads[0]).toMatchObject({ version: '1.2.0', archive: SETUP_URL, sha256: SUM, size: 1000, kind: 'nsis' })
    expect(box(1).message).toBe(t('app-update.lucium-version-est-pret', { version: '1.2.0' }))
    expect(box(1).detail).toBe(t('windows-update.lucium-se-ferme-l-installeur-le-remplace', { version: '1.2.0' }))
    // « Plus tard » at the second box, not « À la prochaine fermeture »: a quit installs nothing here.
    expect(box(1).buttons).toEqual([t('app-update.installer-et-relancer'), t('menu-actions.plus-tard')])
    expect(record.launched).toEqual([])
    expect(record.quit).toBe(0)
    expect(installer.isReady()).toBe(true)
    // The second click.
    expect(installer.restart()).toBe(true)
    await vi.waitFor(() => expect(record.quit).toBe(1))
    expect(record.verified).toBe(1)
    expect(record.launched).toEqual([FILE])
    expect(record.prepared).toBe(1)
  })

  it('runs the installer from « Installer et relancer » in the box, and not from « Plus tard »', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile()))
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await menu()
    await vi.waitFor(() => expect(record.quit).toBe(1))
    expect(record.launched).toEqual([FILE])
  })

  it('downloads nothing when the person answers « Plus tard » to the offer', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile()))
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    await menu()
    await later()
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(record.downloads).toEqual([])
    expect(record.launched).toEqual([])
  })

  it('offers nothing and downloads nothing from a version that is not newer', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile({ currentRelease: '1.1.5', releases: [{ version: '1.1.5', updateTo: { url: SETUP_URL, notes: '', sha256: SUM, size: 1000, pub_date: '2026-11-24T09:00:00Z' } }] })))
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.lucium-est-a-jour'))
    expect(record.downloads).toEqual([])
  })

  describe.each<[string, Record<string, unknown>]>([
    ['a feed of macOS (no system named)', { platform: undefined, arch: undefined, kind: undefined }],
    ['a feed of macOS that names its system', { platform: 'darwin', arch: 'arm64', kind: 'zip' }],
    ['a feed of Linux', { platform: 'linux', arch: 'x64', kind: 'appimage' }],
    ['a feed of Windows for another architecture', { arch: 'arm64' }],
    ['a feed of Windows that names a zip', { kind: 'zip' }],
    ['a feed of Windows that names an AppImage', { kind: 'appimage' }],
    ['a feed of Windows that names no installer kind', { kind: undefined }]
  ])('a feed that is not for this system: %s', (_name, over) => {
    it('is not read: nothing is offered, nothing is downloaded, nothing is run', async () => {
      wire()
      electron.fetch.mockImplementation(serve(windowsFile(over)))
      await menu()
      await later()
      expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
      expect(box(0).detail).toBe(t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible'))
      expect(electron.showMessageBox).toHaveBeenCalledOnce()
      expect(record.downloads).toEqual([])
      expect(record.launched).toEqual([])
    })
  })

  describe.each<[string, Record<string, unknown>]>([
    ['no sum', { sha256: undefined }],
    ['a sum that is not 64 digits', { sha256: 'abc' }],
    ['no size', { size: undefined }],
    ['a size of zero', { size: 0 }]
  ])('a feed of Windows that gives %s', (_name, release) => {
    it('is not read: no installer can be checked, so none is downloaded', async () => {
      wire()
      electron.fetch.mockImplementation(serve(windowsFile({}, release)))
      await menu()
      await later()
      expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
      expect(record.downloads).toEqual([])
    })
  })

  it('refuses a feed that no key of the application signed, whatever it offers', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile(), keys.theirs.privatePem))
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(box(0).detail).toBe(t('update-check.le-flux-de-mises-a-jour-n-a-pas-de-signature-valide'))
    expect(record.downloads).toEqual([])
  })

  it('refuses a feed older than the last one accepted: a signed feed that is replayed offers nothing', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile({ currentRelease: '1.2.1', releases: [{ version: '1.2.1', updateTo: { url: SETUP_URL, notes: '', sha256: SUM, size: 1000, pub_date: '2026-11-25T09:00:00Z' } }] })))
    await menu()
    await later()
    expect(box(0).message).toBe(t('app-update.la-version-version-est-disponible', { version: '1.2.1' }))
    electron.fetch.mockImplementation(serve(windowsFile()))
    await menu()
    await later()
    expect(box(1).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(box(1).detail).toBe(t('update-check.le-flux-de-mises-a-jour-est-plus-ancien-que-le-dernier-lu'))
    expect(record.downloads).toEqual([])
  })

  it('does not install from a run that is not the installed application: the page is offered instead', async () => {
    wire()
    electron.built = false
    electron.fetch.mockImplementation(serve(windowsFile()))
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await menu()
    await later()
    expect(box(0).buttons).toEqual([t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')])
    expect(record.downloads).toEqual([])
    expect(electron.openExternal).toHaveBeenCalledWith(windowsFile().releases[0]!.updateTo.url)
  })

  it('does not install from an address written by hand, in a build that carries none: the page is offered, nothing is downloaded', async () => {
    wire()
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
    electron.fetch.mockImplementation(serve(windowsFile()))
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    await checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], { ...settings, updateFeedUrl: WIN_FEED }, { searching: false })
    await later()
    expect(box(0).buttons).toEqual([t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')])
    expect(record.downloads).toEqual([])
  })

  it('installs the version that replaces a withdrawn running one, through the same installer', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile({ withdrawn: ['1.1.5'] })))
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    expect(box(0).message).toBe(t('app-update.cette-version-a-ete-retiree'))
    expect(box(0).buttons?.[0]).toBe(t('app-update.telecharger-et-installer'))
    expect(record.downloads).toHaveLength(1)
    expect(record.launched).toEqual([])
  })

  it('reads the feed of the Windows address, and nothing else of the network', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile({ currentRelease: '1.1.5', releases: [{ version: '1.1.5', updateTo: { url: SETUP_URL, notes: '', sha256: SUM, size: 1000, pub_date: '2026-11-24T09:00:00Z' } }] })))
    await menu()
    expect(electron.fetch).toHaveBeenCalledOnce()
    expect(electron.fetch.mock.calls[0]![0]).toBe(WIN_FEED)
    expect(electron.fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', cache: 'no-store' })
  })
})

describe('what Windows does not do by itself', () => {
  it('looks for nothing in the background, whatever « Rechercher les mises à jour automatiquement » says: no feed is read', async () => {
    wire()
    electron.fetch.mockImplementation(serve(windowsFile()))
    const updater = createAutoUpdater({ settings: () => ({ ...settings, autoUpdate: true }), update: vi.fn(), noticeWindow: () => null })
    expect(await updater.check()).toBeNull()
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(record.downloads).toEqual([])
  })

  it('has no quit that installs: the handlers that read the feed and prepare an installation at a quit do not see the installer of Windows', () => {
    const windows = wire()
    expect(updateInstaller()).toBe(windows)
    expect(installerAtQuit()).toBeNull()
    // The installer of macOS (Squirrel installs a downloaded update as the application ends) is the one they see.
    const squirrel = new UpdateInstaller({ feed: () => null, updater: () => ({}) as never, prepareQuit: () => {}, report: () => {} })
    setUpdateInstaller(squirrel)
    expect(installerAtQuit()).toBe(squirrel)
    setUpdateInstaller(null)
    expect(installerAtQuit()).toBeNull()
  })
})
