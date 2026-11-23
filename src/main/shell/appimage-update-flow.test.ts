// The update of an AppImage from the menu to the swap, on the readers the application really uses (a signed feed on a throw-away key, the real check of the system, of the
// packaging, of the date and of the version, the real boxes, the real files in a throw-away folder) and a stand-in for the network of the download and for what starts
// Lucium again. Nothing reaches the network, no AppImage runs, no window opens.
// What it holds: a feed that is not the AppImage's (the .deb's, another system's, unsigned, replayed) offers nothing and downloads nothing; the AppImage is downloaded only
// after the first click, beside the one that runs, and swapped in only after the second; the running copy is kept until the new one has started; a copy that cannot be
// replaced, or that is no AppImage, installs nothing.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { setLanguage, t } from '@shared/i18n'
import { appImageFiles } from '@shared/linux-install'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn(), relaunch: vi.fn(), quit: vi.fn(), userData: '', built: true }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.5', getPath: () => electron.userData, isPackaged: false, on: vi.fn(), off: vi.fn(), relaunch: electron.relaunch, quit: electron.quit },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  clipboard: { writeText: vi.fn() },
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
const { createAppImageUpdateInstaller } = await import('./appimage-update')
const { installerAtQuit, setUpdateInstaller, updateInstaller } = await import('./app-update')
const { currentUpdateSources } = await import('./update-source')

const RUNNING_AS = '/opt/apps/Lucium.AppImage'
const BUILT_IN = 'https://lucium.app/updates/linux-x64/feed.json'
const FEED = 'https://lucium.app/updates/linux-x64/appimage/feed.json'
const FILE_URL = 'https://lucium.app/updates/linux-x64/appimage/Lucium-1.2.0-linux-x64.AppImage'
const NEW_BYTES = new TextEncoder().encode('\x7fELF-the-new-appimage-'.repeat(50))
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const settings: Settings = { ...defaultSettings(), updateFeedUrl: '' }

const linuxFile = (over: Record<string, unknown> = {}, release: Record<string, unknown> = {}) => ({
  currentRelease: '1.2.0',
  platform: 'linux',
  arch: 'x64',
  kind: 'appimage',
  releases: [{ version: '1.2.0', updateTo: { url: FILE_URL, notes: 'Notes.', sha256: sha(NEW_BYTES), size: NEW_BYTES.byteLength, pub_date: '2026-11-24T09:00:00Z', ...release } }],
  ...over
})

/** The network: the signed feed at the feed address, the AppImage at its own, and anything else is a failure the test sees. */
let feedJson: unknown
let downloads: number
const network = async (url: string) => {
  if (url === FEED) {
    const bytes = new TextEncoder().encode(signFeedText(`${JSON.stringify(feedJson, null, 2)}\n`, [keys.ours.privatePem]))
    return { ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
  }
  if (url === FILE_URL) {
    downloads += 1
    let sent = false
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.close()
          sent = true
          controller.enqueue(NEW_BYTES)
        }
      })
    }
  }
  throw new Error(`unexpected request: ${url}`)
}

const real = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
  arch: Object.getOwnPropertyDescriptor(process, 'arch')!,
  execPath: Object.getOwnPropertyDescriptor(process, 'execPath')!
}
let folder: string
let appImage: string
let files: ReturnType<typeof appImageFiles>
let record: { prepared: number; quit: number; reported: string[] }
const wire = () => {
  record = { prepared: 0, quit: 0, reported: [] }
  const installer = createAppImageUpdateInstaller(appImage, () => currentUpdateSources(settings).install, () => void (record.prepared += 1), () => false, async () => [])
  setUpdateInstaller(installer)
  electron.quit.mockImplementation(() => void (record.quit += 1))
  return installer
}

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'lucium-appimage-flow-'))
  folder = mkdtempSync(join(tmpdir(), 'lucium-appimage-flow-app-'))
  appImage = join(folder, 'Lucium.AppImage')
  files = appImageFiles(appImage)
  writeFileSync(appImage, 'the appimage that runs')
  electron.built = true
  feedJson = linuxFile()
  downloads = 0
  electron.fetch.mockReset().mockImplementation(network)
  electron.relaunch.mockReset()
  electron.quit.mockReset()
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
  electron.openExternal.mockReset().mockResolvedValue(undefined)
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
  // The environment of a Linux copy names a POSIX path (that is all the detection accepts); the folder of the test is a real one of this machine, which on Windows is
  // `C:\\…`. So the variable is the fixed POSIX name and the installer is handed the real file, as `wire` does: the two never have to be the same string.
  vi.stubEnv('APPIMAGE', RUNNING_AS)
  Object.defineProperty(process, 'platform', { value: 'linux' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  Object.defineProperty(process, 'execPath', { value: '/tmp/.mount_Lucium1x2/lucium', configurable: true })
  setLanguage('fr')
})
afterEach(() => {
  setUpdateInstaller(null)
  Object.defineProperty(process, 'platform', real.platform)
  Object.defineProperty(process, 'arch', real.arch)
  Object.defineProperty(process, 'execPath', real.execPath)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  chmodSync(folder, 0o755)
  rmSync(electron.userData, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
})

const menu = () => checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], settings, { searching: false })
const box = (at: number) => electron.showMessageBox.mock.calls[at]!.at(-1) as { message: string; detail: string; buttons?: string[] }
const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const untilBoxes = (count: number) => vi.waitFor(() => expect(electron.showMessageBox.mock.calls.length).toBeGreaterThanOrEqual(count))

describe('the update of an AppImage from the menu', () => {
  it('reads the feed of AppImages (its folder, not the .deb’s), downloads after the first click beside the running file, and swaps nothing until the second', async () => {
    const installer = wire()
    // « Télécharger et installer » (0), then « Plus tard » (1) at « Lucium 1.2.0 est prêt ».
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    await later()
    expect(electron.fetch.mock.calls[0]![0]).toBe(FEED)
    expect(electron.fetch.mock.calls[1]![0]).toBe(FILE_URL)
    expect(box(0).message).toBe(t('app-update.la-version-version-est-disponible', { version: '1.2.0' }))
    expect(box(0).buttons).toEqual([t('app-update.telecharger-et-installer'), t('menu-actions.plus-tard')])
    expect(box(1).message).toBe(t('app-update.lucium-version-est-pret', { version: '1.2.0' }))
    expect(box(1).detail).toBe(t('appimage-update.lucium-se-ferme-l-appimage-est-remplace', { version: '1.2.0' }))
    expect(box(1).buttons).toEqual([t('app-update.installer-et-relancer'), t('menu-actions.plus-tard')])
    // The download waits beside the AppImage; the running file is the one it was, and nothing was asked to start.
    expect(downloads).toBe(1)
    expect(readdirSync(folder).sort()).toEqual(['Lucium.AppImage', 'Lucium.AppImage.update'])
    expect(readFileSync(appImage, 'utf8')).toBe('the appimage that runs')
    expect(electron.relaunch).not.toHaveBeenCalled()
    expect(record.quit).toBe(0)
    expect(installer.isReady()).toBe(true)
  })

  it('swaps on the second click, keeps the copy that ran, asks for the new one to start when this one ends, and only then quits', async () => {
    const installer = wire()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    await later()
    expect(installer.restart()).toBe(true)
    await vi.waitFor(() => expect(record.quit).toBe(1))
    expect(readFileSync(appImage)).toEqual(Buffer.from(NEW_BYTES))
    expect(readFileSync(files.previous, 'utf8')).toBe('the appimage that runs')
    expect(existsSync(files.staged)).toBe(false)
    expect(electron.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: appImage })
    expect(record.prepared).toBe(1)
    // The relaunch is asked before the quit, and the state is written before both.
    expect(electron.relaunch.mock.invocationCallOrder[0]!).toBeLessThan(electron.quit.mock.invocationCallOrder[0]!)
  })

  it('runs the swap from « Installer et relancer » in the box, and not from « Plus tard »', async () => {
    wire()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await menu()
    await vi.waitFor(() => expect(record.quit).toBe(1))
    expect(readFileSync(appImage)).toEqual(Buffer.from(NEW_BYTES))
  })

  it('downloads nothing when the person answers « Plus tard » to the offer', async () => {
    wire()
    await menu()
    await later()
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(downloads).toBe(0)
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
  })

  it('puts the AppImage that ran back when Lucium cannot be asked to start the new one, and tells the person', async () => {
    const installer = wire()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    await later()
    electron.relaunch.mockImplementation(() => {
      throw new Error('cannot spawn')
    })
    const failures = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(installer.restart()).toBe(true)
    await vi.waitFor(() => expect(electron.showMessageBox.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(readFileSync(appImage, 'utf8')).toBe('the appimage that runs')
    expect(existsSync(files.previous)).toBe(false)
    expect(record.quit).toBe(0)
    expect(box(2).message).toBe(t('app-update.la-mise-a-jour-n-a-pas-pu-etre-installee'))
    expect(box(2).detail).toContain(t('appimage-update.la-nouvelle-version-n-a-pas-pu-etre-mise-en-place'))
    expect(failures).toHaveBeenCalled()
  })

  it('removes the download that waited when the application ends without the swap, and leaves the running file alone', async () => {
    const installer = wire()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await untilBoxes(2)
    await later()
    expect(existsSync(files.staged)).toBe(true)
    installer.leave()
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
  })

  it('has no quit that installs: the handlers that read the feed and prepare an installation at a quit do not see the AppImage’s installer', () => {
    const installer = wire()
    expect(updateInstaller()).toBe(installer)
    expect(installerAtQuit()).toBeNull()
  })
})

describe('what an AppImage does not take', () => {
  it.each<[string, Record<string, unknown>]>([
    ['the feed of .deb', { kind: 'deb' }],
    ['a feed of Windows', { platform: 'win32', arch: 'x64', kind: 'nsis' }],
    ['a feed of macOS (no system named)', { platform: undefined, arch: undefined, kind: undefined }],
    ['a feed of Linux for another architecture', { arch: 'arm64' }],
    ['a feed of Linux that names no kind', { kind: undefined }]
  ])('is not read: %s offers nothing, downloads nothing and swaps nothing', async (_name, over) => {
    wire()
    feedJson = linuxFile(over)
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(box(0).detail).toBe(t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible'))
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(downloads).toBe(0)
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
  })

  it.each<[string, Record<string, unknown>]>([['no sum', { sha256: undefined }], ['a sum that is not 64 digits', { sha256: 'abc' }], ['no size', { size: undefined }]])('is not read: a feed that gives %s', async (_name, release) => {
    wire()
    feedJson = linuxFile({}, release)
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(downloads).toBe(0)
  })

  it('offers nothing from a version that is not newer', async () => {
    wire()
    feedJson = linuxFile({ currentRelease: '1.1.5', releases: [{ version: '1.1.5', updateTo: { url: FILE_URL, notes: '', sha256: sha(NEW_BYTES), size: NEW_BYTES.byteLength, pub_date: '2026-11-24T09:00:00Z' } }] })
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.lucium-est-a-jour'))
    expect(downloads).toBe(0)
  })

  it('tells a copy whose folder cannot be written the page instead of an update that could not be put in place', async () => {
    // process.platform is faked as linux by beforeEach, so the real one decides: chmod cannot make a folder read-only on Windows.
    if (real.platform.value === 'win32' || process.getuid?.() === 0) return
    wire()
    chmodSync(folder, 0o555)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await menu()
    await later()
    expect(box(0).buttons).toEqual([t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')])
    expect(downloads).toBe(0)
    // The feed names no page of its own, so the address it gives for the file is the one opened (as on Windows).
    expect(electron.openExternal).toHaveBeenCalledWith(FILE_URL)
  })

  it('says the check is not configured for an AppImage built with no address, and not that updates are made by hand (which is the box of a copy that is neither)', async () => {
    wire()
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-n-est-pas'))
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('does not install from a run that is not the installed application: the page is offered', async () => {
    wire()
    electron.built = false
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await menu()
    await later()
    expect(box(0).buttons).toEqual([t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')])
    expect(downloads).toBe(0)
  })
})
