// The update of a .deb from the menu and from the notice (app-update.ts, `offerDebUpdate`), on the readers the application really uses (a signed feed on a throw-away key,
// the real check of the system and of the packaging, the real boxes) and stand-ins for the download and the clipboard. A .deb is TOLD, never installed: nothing here may
// run a program, and nothing is downloaded before a click. No network, no window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { setLanguage, t } from '@shared/i18n'
import type { UpdateOffer } from '@shared/update-check'
import type { InstallerDownload } from '../update-installer-file'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn(), userData: '', built: true }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.5', getPath: () => electron.userData, isPackaged: false, on: vi.fn(), off: vi.fn() },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  clipboard: { writeText: vi.fn() },
  contentTracing: {},
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => null }
}))
vi.mock('../runtime', async (original) => ({ ...(await original<typeof import('../runtime')>()), isBuiltApp: () => electron.built }))
const spawned = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: spawned.spawn, exec: spawned.exec, execFile: spawned.execFile }))
const keys = await vi.hoisted(async () => {
  const { newFeedKeyPair } = await import('../update-feed-signature')
  return { ours: newFeedKeyPair(), theirs: newFeedKeyPair() }
})
vi.mock('../update-feed-keys', () => ({ UPDATE_FEED_PUBLIC_KEYS: [keys.ours.publicKey] }))

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { signFeedText } = await import('../update-feed-signature')
const { checkForUpdates } = await import('./menu-actions')
const { debAdviser, setDebAdviser, setUpdateInstaller, showUpdateNotice, updateInstaller } = await import('./app-update')

const BUILT_IN = 'https://lucium.app/updates/linux-x64/feed.json'
const FEED = 'https://lucium.app/updates/linux-x64/deb/feed.json'
const FILE_URL = 'https://lucium.app/updates/linux-x64/deb/Lucium-1.2.0-linux-amd64.deb'
const SUM = 'd'.repeat(64)
const COMMAND = 'sudo apt install ./Lucium-1.2.0-linux-amd64.deb'
const settings: Settings = { ...defaultSettings(), updateFeedUrl: '' }

const debFile = (over: Record<string, unknown> = {}, release: Record<string, unknown> = {}) => ({
  currentRelease: '1.2.0',
  platform: 'linux',
  arch: 'x64',
  kind: 'deb',
  releases: [{ version: '1.2.0', updateTo: { url: FILE_URL, notes: 'Notes.', sha256: SUM, size: 2_000_000, pub_date: '2026-11-24T09:00:00Z', ...release } }],
  ...over
})
const serve = (json: unknown, signedBy = keys.ours.privatePem) => async () => {
  const bytes = new TextEncoder().encode(signFeedText(`${JSON.stringify(json, null, 2)}\n`, [signedBy]))
  return { ok: true, status: 200, url: FEED, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
}

const real = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
  arch: Object.getOwnPropertyDescriptor(process, 'arch')!,
  execPath: Object.getOwnPropertyDescriptor(process, 'execPath')!
}
let record: { downloads: UpdateOffer[]; copied: string[]; outcome: InstallerDownload }
const advise = () => {
  record = { downloads: [], copied: [], outcome: { ok: true, file: '/home/ana/Téléchargements/Lucium-1.2.0-linux-amd64.deb', sha256: SUM } }
  setDebAdviser({
    arch: 'x64',
    downloads: () => '/home/ana/Téléchargements',
    download: async (offer) => {
      record.downloads.push(offer)
      return record.outcome
    },
    copy: async (text) => void record.copied.push(text)
  })
}

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'lucium-deb-flow-'))
  electron.built = true
  electron.fetch.mockReset().mockImplementation(serve(debFile()))
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 2 })
  electron.openExternal.mockReset().mockResolvedValue(undefined)
  spawned.spawn.mockReset()
  spawned.exec.mockReset()
  spawned.execFile.mockReset()
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
  vi.stubEnv('APPIMAGE', '')
  Object.defineProperty(process, 'platform', { value: 'linux' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  Object.defineProperty(process, 'execPath', { value: '/opt/Lucium/lucium', configurable: true })
  setUpdateInstaller(null)
  advise()
  setLanguage('fr')
})
afterEach(() => {
  setDebAdviser(null)
  setUpdateInstaller(null)
  Object.defineProperty(process, 'platform', real.platform)
  Object.defineProperty(process, 'arch', real.arch)
  Object.defineProperty(process, 'execPath', real.execPath)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(electron.userData, { recursive: true, force: true })
})

const menu = () => checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], settings, { searching: false })
const box = (at: number) => electron.showMessageBox.mock.calls[at]!.at(-1) as { message: string; detail: string; buttons?: string[]; cancelId?: number }
const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the update of a .deb from the menu: told, with the command, never installed', () => {
  it('reads the feed of .deb (its folder, not the AppImage’s) and gives the version, the sum, the size and the exact command, without downloading or running anything', async () => {
    await menu()
    await later()
    expect(electron.fetch.mock.calls[0]![0]).toBe(FEED)
    expect(electron.fetch).toHaveBeenCalledOnce()
    expect(box(0).message).toBe(t('app-update.la-version-version-est-disponible', { version: '1.2.0' }))
    expect(box(0).detail).toContain(COMMAND)
    expect(box(0).detail).toContain(SUM)
    expect(box(0).detail).toContain(t('deb-update.avis-intro', { current: '1.1.5' }))
    expect(box(0).buttons).toEqual([t('deb-update.telecharger-le-paquet'), t('deb-update.copier-la-commande'), t('menu-actions.plus-tard')])
    expect(box(0).cancelId).toBe(2)
    expect(record.downloads).toEqual([])
    expect(record.copied).toEqual([])
    expect(spawned.spawn).not.toHaveBeenCalled()
    expect(spawned.exec).not.toHaveBeenCalled()
    expect(spawned.execFile).not.toHaveBeenCalled()
  })

  it('has no installer at all: nothing installs it, at a click or at a quit', async () => {
    await menu()
    expect(updateInstaller()).toBeNull()
    expect(debAdviser()).not.toBeNull()
  })

  it('downloads after « Télécharger le paquet », then gives the folder, the checked sum and the command, and installs nothing', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await vi.waitFor(() => expect(electron.showMessageBox.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(record.downloads).toHaveLength(1)
    expect(record.downloads[0]).toMatchObject({ version: '1.2.0', archive: FILE_URL, sha256: SUM, size: 2_000_000, kind: 'deb' })
    expect(box(1).message).toBe(t('deb-update.paquet-telecharge', { version: '1.2.0' }))
    expect(box(1).detail).toContain('/home/ana/Téléchargements')
    expect(box(1).detail).toContain(COMMAND)
    expect(box(1).detail).toContain(t('deb-update.paquet-pas-installe'))
    expect(box(1).buttons).toEqual([t('deb-update.copier-la-commande'), t('app-update.fermer')])
    expect(spawned.spawn).not.toHaveBeenCalled()
    expect(spawned.exec).not.toHaveBeenCalled()
    expect(spawned.execFile).not.toHaveBeenCalled()
  })

  it('copies the command from the first box without downloading, and from the second after the download', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await menu()
    await later()
    expect(record.copied).toEqual([COMMAND])
    expect(record.downloads).toEqual([])
    electron.showMessageBox.mockReset().mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await menu()
    await vi.waitFor(() => expect(record.copied).toEqual([COMMAND, COMMAND]))
    expect(record.downloads).toHaveLength(1)
  })

  it('downloads nothing and copies nothing on « Plus tard »', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 2 })
    await menu()
    await later()
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(record.downloads).toEqual([])
    expect(record.copied).toEqual([])
  })

  it('says a download that failed, with its cause, and offers the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    record.outcome = { ok: false, kind: 'mismatch', detail: 'the SHA-256 differs' }
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await menu()
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledWith(FILE_URL))
    expect(box(1).message).toBe(t('app-update.la-mise-a-jour-n-a-pas-pu-etre-telechargee'))
    expect(box(1).detail).toContain(t('windows-update.le-fichier-telecharge-ne-correspond-pas'))
    expect(box(1).detail).toContain('the SHA-256 differs')
    expect(record.copied).toEqual([])
  })

  it('says a download that cannot be saved in Downloads with that folder', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    record.outcome = { ok: false, kind: 'disk', detail: 'a file of that name is there' }
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await menu()
    await vi.waitFor(() => expect(electron.showMessageBox.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(box(1).detail).toContain(t('deb-update.le-fichier-n-a-pas-pu-etre-enregistre', { folder: '/home/ana/Téléchargements' }))
    expect(box(1).detail).toContain('a file of that name is there')
  })

  it('logs a clipboard that refuses, and the box has shown the command already', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setDebAdviser({ ...debAdviser()!, copy: async () => Promise.reject(new Error('no clipboard')) })
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await menu()
    await vi.waitFor(() => expect(failures).toHaveBeenCalled())
    expect(String(failures.mock.calls[0]![0])).toContain('could not be copied')
  })
})

describe('what a .deb does not take', () => {
  it.each<[string, Record<string, unknown>]>([
    ['the feed of AppImages', { kind: 'appimage' }],
    ['a feed of Windows', { platform: 'win32', arch: 'x64', kind: 'nsis' }],
    ['a feed of macOS (no system named)', { platform: undefined, arch: undefined, kind: undefined }],
    ['a feed of Linux for another architecture', { arch: 'arm64' }]
  ])('is not read: %s offers nothing', async (_name, over) => {
    electron.fetch.mockImplementation(serve(debFile(over)))
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(box(0).detail).toBe(t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible'))
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(record.downloads).toEqual([])
  })

  it('refuses a feed that no key of the application signed', async () => {
    electron.fetch.mockImplementation(serve(debFile(), keys.theirs.privatePem))
    await menu()
    await later()
    expect(box(0).detail).toBe(t('update-check.le-flux-de-mises-a-jour-n-a-pas-de-signature-valide'))
    expect(record.downloads).toEqual([])
  })

  it('offers nothing from a version that is not newer', async () => {
    electron.fetch.mockImplementation(serve(debFile({ currentRelease: '1.1.5', releases: [{ version: '1.1.5', updateTo: { url: FILE_URL, notes: '', sha256: SUM, size: 2_000_000, pub_date: '2026-11-24T09:00:00Z' } }] })))
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.lucium-est-a-jour'))
  })

  it('does not read a feed whose version is not digits and dots: no package could be named from it', async () => {
    electron.fetch.mockImplementation(serve(debFile({ currentRelease: '1.2.0-beta', releases: [{ version: '1.2.0-beta', updateTo: { url: FILE_URL, notes: '', sha256: SUM, size: 2_000_000, pub_date: '2026-11-24T09:00:00Z' } }] })))
    await menu()
    await later()
    expect(box(0).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(record.downloads).toEqual([])
  })

  it('sends a run that has no adviser (the application is not a .deb) to the download page, as any run that installs nothing', async () => {
    setDebAdviser(null)
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await menu()
    await later()
    expect(box(0).buttons).toEqual([t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')])
    expect(electron.openExternal).toHaveBeenCalledWith(FILE_URL)
  })
})

describe('the notice of the background look, for a .deb', () => {
  const offer: UpdateOffer = { version: '1.2.0', url: FILE_URL, notes: '', archive: FILE_URL, size: 2_000_000, sha256: SUM, kind: 'deb' }
  const notice = (over: Partial<UpdateOffer> = {}) => ({ kind: 'page' as const, version: '1.2.0', offer: { ...offer, ...over }, current: '1.1.5', accepted: vi.fn() })

  it('says « Voir la commande » and leads to the box with the command, not to a page', async () => {
    const showToast = vi.fn()
    const n = notice()
    showUpdateNotice({ win: {} as never, browser: { showToast } }, n, null)
    const action = showToast.mock.calls[0]![1] as { label: string; run: () => void }
    expect(action.label).toBe(t('deb-update.voir-la-commande'))
    action.run()
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledOnce())
    expect(box(0).detail).toContain(COMMAND)
    expect(electron.openExternal).not.toHaveBeenCalled()
    expect(n.accepted).toHaveBeenCalledOnce()
    expect(record.downloads).toEqual([])
  })

  it('keeps the download page for a copy that is not a .deb (no adviser), and for an offer that is not a .deb’s', () => {
    for (const [adviser, over] of [[false, {}], [true, { kind: 'appimage' as const }]] as const) {
      if (!adviser) setDebAdviser(null)
      else advise()
      const showToast = vi.fn()
      showUpdateNotice({ win: {} as never, browser: { showToast } }, notice(over), null)
      const action = showToast.mock.calls[0]![1] as { label: string; run: () => void }
      expect(action.label).toBe(t('auto-update.page-de-telechargement'))
      action.run()
      expect(electron.openExternal).toHaveBeenCalledWith(FILE_URL)
      electron.openExternal.mockClear()
    }
  })
})
