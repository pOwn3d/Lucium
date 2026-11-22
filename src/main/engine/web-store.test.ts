import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, webContents, type Session } from 'electron'
import { t } from '@shared/i18n'
import { PRELUDE_FILE } from './content-prelude'
import { STAGING_DIR, STORE_DIR } from './web-store-files'
import { WebStore, type WebStoreHost } from './web-store'
import { expectMode, onWindows } from '../windows.test-support'

// The store talks to Electron only when it installs; here it is configured, and handed a library that behaves as electron-chrome-web-store.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, nativeImage: {}, net: {}, session: {}, webContents: {} }))

let userData: string
let warn: ReturnType<typeof vi.spyOn>
const staged = (): string => join(userData, STAGING_DIR, 'default', 'abcdefghijklmnopabcdefghijklmnop', '1.0_0')

const storeOn = (data: string): WebStore => new WebStore({ userData: () => data } as unknown as WebStoreHost)
const config = { install: false, updates: 'manual' as const }

beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'lucium-webstore-')))
  mkdirSync(staged(), { recursive: true })
  writeFileSync(join(staged(), 'manifest.json'), '{}')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('WebStore: what an install that never finished left behind', () => {
  it('is cleared as the first settings arrive, whatever they say (an unpacked extension that was never reviewed is of no use)', async () => {
    storeOn(userData).configure(config)
    await vi.waitFor(() => expect(existsSync(join(userData, STAGING_DIR))).toBe(false))
  })

  it('is cleared once only: a later change of settings must not remove the folder of an install under way', async () => {
    const store = storeOn(userData)
    store.configure(config)
    await vi.waitFor(() => expect(existsSync(join(userData, STAGING_DIR))).toBe(false))
    mkdirSync(staged(), { recursive: true })
    store.configure({ install: true, updates: 'manual' })
    store.configure(config)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(staged())).toBe(true)
  })

  it('closes the folder of the installed extensions that an earlier version left readable by the other accounts of the Mac', async () => {
    const installed = join(userData, STORE_DIR)
    mkdirSync(installed)
    chmodSync(installed, 0o755)
    storeOn(userData).configure(config)
    // The folder is closed after the staging one is cleared: waiting for that keeps the test from ending with the work under way (and gives Windows, where the mode is not read, something to wait for).
    await vi.waitFor(() => expect(existsSync(join(userData, STAGING_DIR))).toBe(false))
    await vi.waitFor(() => expectMode(installed, 0o700))
  })

  // Windows: a path under a file is reported as not found there (which `force` hides), not as ENOTDIR.
  it.skipIf(onWindows)('does not stop the application when the folder cannot be cleared: the reason is in the journal', async () => {
    // The folder of the data is a file: removing something under it fails with ENOTDIR, which `force` does not hide.
    const file = join(userData, 'not-a-folder')
    writeFileSync(file, 'x')
    expect(() => storeOn(file).configure(config)).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot clear the folders of installs that never finished'), expect.objectContaining({ code: 'ENOTDIR' })))
  })
})

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
/** The channels the library registers when it is set up (the store refuses a library that no longer does). */
const CHANNELS = ['chromeWebstore.beginInstall', 'chromeWebstore.getFullChromeVersion', 'chromeWebstore.getExtensionStatus', 'chrome.management.getAll', 'chrome.management.uninstall']
const withContentScript = (version: string, extra: object = {}) => ({ manifest_version: 3, name: 'Exemple', version, content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }], ...extra })

interface Loaded {
  id: string
  name: string
  version: string
  path: string
  manifest: Record<string, unknown>
}

type Gate = (channel: string, listener: unknown) => (...args: unknown[]) => Promise<unknown>

/** A profile with the store switched on: its session, the engine around it, and a library whose updater does what the real one does. */
function world() {
  vi.mocked(ipcMain.handle).mockClear()
  const root = join(userData, STORE_DIR, 'default')
  const partition = join(userData, 'Partitions', 'default')
  const loaded = new Map<string, Loaded>()
  const known = new Map<string, Loaded>()
  /** Each manifest as the session read it when it loaded the folder. */
  const readAtLoad: Array<Record<string, unknown>> = []
  const extensions = {
    getAllExtensions: () => [...loaded.values()],
    getExtension: (id: string) => loaded.get(id) ?? null,
    removeExtension: (id: string) => void loaded.delete(id),
    loadExtension: async (path: string) => {
      const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Record<string, unknown>
      readAtLoad.push(manifest)
      if (manifest['broken']) throw new Error('Manifest file is invalid')
      const entry = { id: basename(dirname(path)), name: String(manifest['name']), version: String(manifest['version']), path, manifest }
      loaded.set(entry.id, entry)
      known.set(entry.id, entry)
      return entry
    }
  }
  const session = { extensions, getStoragePath: () => partition, clearStorageData: vi.fn(async () => {}), registerPreloadScript: vi.fn(), unregisterPreloadScript: vi.fn() }
  const notify = vi.fn()
  const host = {
    userData: () => userData,
    ledger: () => ({ recordUpdateCheck: () => {}, forget: () => {}, lastUpdateCheck: () => 0 }),
    profileOfSession: () => 'default',
    pageIdOf: () => 'page-1',
    lastUserInput: () => Date.now(),
    installed: () => [...known.values()].map((e) => ({ id: e.id, name: e.name, version: e.version, manifest: e.manifest, path: e.path })),
    isInstalled: (_profileId: string, id: string) => known.has(id),
    unload: (_profileId: string, id: string) => extensions.removeExtension(id),
    prepareLoad: vi.fn(),
    ask: async () => true,
    notify,
    requestUninstall: vi.fn()
  }
  const write = (id: string, manifest: object & { version: string }): string => {
    const path = join(root, id, `${manifest.version}_0`)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'manifest.json'), JSON.stringify(manifest))
    return path
  }
  /** What the store's server answers to the update check. */
  const updates: Array<{ id: string; manifest: object & { version: string } }> = []
  /** The channels on which the library's own listener ran: a call the gate let through. */
  const libraryCalls: string[] = []
  const library = {
    installChromeWebStore: async () => {
      for (const channel of CHANNELS) ipcMain.handle(channel, () => (libraryCalls.push(channel), `library:${channel}`))
    },
    // electron-chrome-web-store's `updateExtensions`: the loaded extensions only; the new version is downloaded next to the old one,
    // `removeExtension` then `loadExtension` on the session it is given, and the old folder removed; a failure is logged and skipped.
    updateExtensions: vi.fn(async (given: { extensions: typeof extensions }) => {
      for (const update of updates) {
        const old = given.extensions.getAllExtensions().find((e) => e.id === update.id)
        if (!old) continue
        try {
          const updatePath = write(update.id, update.manifest)
          if (given.extensions.getExtension(update.id)) {
            given.extensions.removeExtension(update.id)
            await given.extensions.loadExtension(updatePath)
          }
          rmSync(old.path, { recursive: true, force: true })
        } catch {
          // The library prints the error and goes on with the next update.
        }
      }
    })
  }
  const store = new WebStore(host as unknown as WebStoreHost)
  ;(store as unknown as { library_: unknown }).library_ = library
  store.addProfile('default', session as unknown as Session)
  store.configure({ install: true, updates: 'manual' })
  const install = (id: string, manifest: object & { version: string }) => extensions.loadExtension(write(id, manifest))
  const gate = (channel: string, listener: unknown) => (store as unknown as { gate: Gate }).gate.call(store, channel, listener)
  return { store, session, loaded, known, readAtLoad, notify, write, install, updates, library, partition, root, gate, host, libraryCalls }
}

describe('WebStore: the folders an install writes', () => {
  it('are behind folders of ours that only the owner can enter, staging and installed alike', async () => {
    const w = world()
    ;(webContents as unknown as { fromFrame: () => null }).fromFrame = () => null
    const modes: number[] = []
    // The library makes its folders with the rights of the umask, as the real one does.
    ;(w.library as unknown as { downloadExtension: (id: string, into: string) => Promise<void> }).downloadExtension = async (id, into) => {
      modes.push(statSync(join(userData, STAGING_DIR)).mode & 0o777)
      const folder = join(into, id, '1.0_0')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Exemple', version: '1.0' }))
    }
    const before = process.umask(0o022)
    try {
      rmSync(join(userData, STAGING_DIR), { recursive: true, force: true })
      const beforeInstall = (w.store as unknown as { beforeInstall: (profileId: string, details: unknown) => Promise<{ action: string }> }).beforeInstall
      const answer = await beforeInstall.call(w.store, 'default', { id: EXT, frame: { origin: 'https://chromewebstore.google.com' } })
      expect(answer).toEqual({ action: 'allow' })
    } finally {
      process.umask(before)
    }
    expect(modes).toHaveLength(1)
    // Windows reports 0777 for a folder whatever its access list: only the other systems can say it is closed.
    if (!onWindows) expect(modes).toEqual([0o700])
    expectMode(join(userData, STORE_DIR), 0o700)
    expectMode(join(userData, STORE_DIR, 'default'), 0o700)
    expect(existsSync(join(userData, STORE_DIR, 'default', EXT, '1.0_0', 'manifest.json'))).toBe(true)
  })
})

describe('WebStore: the block list', () => {
  const beforeInstall = (w: ReturnType<typeof world>, id: string, localizedName = 'Evil Tool') =>
    (w.store as unknown as { beforeInstall: (profileId: string, details: unknown) => Promise<{ action: string }> }).beforeInstall.call(w.store, 'default', { id, localizedName, frame: { origin: 'https://chromewebstore.google.com' } })

  it('refuses a listed extension before anything is downloaded, and says so, with its name and the reason', async () => {
    const w = world()
    ;(w.host as unknown as { blocked: (id: string) => unknown }).blocked = (id) => (id === EXT ? { id, reason: 'malware' } : undefined)
    const downloads = vi.fn(async () => {})
    ;(w.library as unknown as { downloadExtension: unknown }).downloadExtension = downloads
    expect(await beforeInstall(w, EXT)).toEqual({ action: 'deny' })
    expect(downloads).not.toHaveBeenCalled()
    expect(w.notify).toHaveBeenCalledTimes(1)
    expect(String(w.notify.mock.calls[0]![0])).toContain('Evil Tool')
    expect(String(w.notify.mock.calls[0]![0])).toContain('liste de blocage')
  })

  it('does not stand in the way of another extension', async () => {
    const w = world()
    ;(w.host as unknown as { blocked: (id: string) => unknown }).blocked = () => undefined
    ;(webContents as unknown as { fromFrame: () => null }).fromFrame = () => null
    rmSync(join(userData, STAGING_DIR), { recursive: true, force: true })
    ;(w.library as unknown as { downloadExtension: (id: string, into: string) => Promise<void> }).downloadExtension = async (id, into) => {
      const folder = join(into, id, '1.0_0')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fine', version: '1.0' }))
    }
    expect(await beforeInstall(w, EXT)).toEqual({ action: 'allow' })
  })
})

describe('WebStore: the script the store\'s pages run', () => {
  // The library's script only looks at the start of the address: https://chromewebstore.google.com.evil.example/ was handed its objects too.
  it('is registered for the pages of the store only, not for every page of the profile', () => {
    const w = world()
    const registered = w.session.registerPreloadScript.mock.calls.map(([script]) => script as { id: string; type: string; matches?: string[] })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ id: 'electron-chrome-web-store', type: 'frame', matches: ['https://chromewebstore.google.com/*'] })
  })

  it('is registered for every page, as before, by an engine that refuses the limit, and the journal says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = world()
      w.store.configure({ install: false, updates: 'manual' })
      w.session.registerPreloadScript.mockReset()
      w.session.registerPreloadScript.mockImplementation((script: { matches?: string[] }) => {
        if (script.matches) throw new Error('matches is not supported')
      })
      w.store.configure({ install: true, updates: 'manual' })
      const registered = w.session.registerPreloadScript.mock.calls.map(([script]) => script as { matches?: string[] })
      expect(registered.map((script) => 'matches' in script)).toEqual([true, false])
      expect(warn.mock.calls.some(([line]) => String(line).includes('could not be limited to the pages of the store'))).toBe(true)
      expect(w.notify).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('WebStore: an update the library finds and applies by itself (a scheduled or asked check)', () => {
  it('loads with the content prelude in its manifest, and replaces the installed version', async () => {
    const w = world()
    const installed = await w.install(EXT, withContentScript('1.0'))
    w.updates.push({ id: EXT, manifest: withContentScript('2.0') })
    const report = await w.store.checkUpdates()
    expect(w.loaded.get(EXT)?.version).toBe('2.0')
    // The manifest the session read when it loaded the new version lists the prelude first.
    expect((w.readAtLoad.at(-1)!['content_scripts'] as Array<{ js: string[] }>)[0]!.js).toEqual([PRELUDE_FILE, 'content.js'])
    expect(existsSync(join(w.loaded.get(EXT)!.path, PRELUDE_FILE))).toBe(true)
    expect(existsSync(installed.path)).toBe(false)
    expect(report.updated).toEqual(['Exemple'])
  })

  it('gives its place back to the installed version when the new one does not load, and says so', async () => {
    const w = world()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const installed = await w.install(EXT, withContentScript('1.0'))
    w.updates.push({ id: EXT, manifest: withContentScript('2.0', { broken: true }) })
    const report = await w.store.checkUpdates()
    expect(w.loaded.get(EXT)?.path).toBe(installed.path)
    expect(existsSync(installed.path)).toBe(true)
    expect(existsSync(join(w.root, EXT, '2.0_0'))).toBe(false)
    expect(report.updated).toEqual([])
    expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('Exemple'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`the update of ${EXT} in profile default did not load`), expect.any(Error))
    error.mockRestore()
  })

  it('counts as checked only the extensions the library looks at (the loaded ones), and asks nothing when none is', async () => {
    const w = world()
    await w.install(EXT, withContentScript('1.0'))
    await w.install(OTHER, withContentScript('3.0'))
    // Switched off in this profile: installed, not loaded.
    w.loaded.delete(OTHER)
    expect((await w.store.checkUpdates()).checked).toBe(1)
    w.loaded.delete(EXT)
    w.library.updateExtensions.mockClear()
    expect((await w.store.checkUpdates()).checked).toBe(0)
    expect(w.library.updateExtensions).not.toHaveBeenCalled()
  })
})

describe('WebStore: an update that waited for the user, once they accept it', () => {
  /** The profile with version 1.0 installed, and version 2.0 held back until the user has seen what it adds. */
  async function waitingUpdate() {
    const w = world()
    // What an install that never finished left behind is cleared as the store is configured: the download below comes after.
    await vi.waitFor(() => expect(existsSync(join(userData, STAGING_DIR))).toBe(false))
    const installed = await w.install(EXT, withContentScript('1.0'))
    ;(w.store as unknown as { waiting: Map<string, { version: string; name: string }> }).waiting.set(`default:${EXT}`, { version: '2.0', name: 'Exemple' })
    ;(w.library as unknown as { downloadExtension: (id: string, into: string) => Promise<void> }).downloadExtension = async (id, into) => {
      const folder = join(into, id, '2.0_0')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify(withContentScript('2.0')))
    }
    return { w, installed }
  }

  it('takes the place of the installed version', async () => {
    const { w, installed } = await waitingUpdate()
    expect(await w.store.reviewUpdate('default', EXT)).toBe('updated')
    expect(w.loaded.get(EXT)?.version).toBe('2.0')
    expect(existsSync(installed.path)).toBe(false)
    expect(w.store.pendingUpdate('default', EXT)).toBeUndefined()
  })

  // Windows: `chmod 500` does not make a folder refuse a new folder there (it only sets the read-only flag, which a folder's contents ignore).
  it.skipIf(onWindows)('leaves the installed version loaded when the new one cannot be put in place, says so, and keeps waiting', async () => {
    const { w, installed } = await waitingUpdate()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The folder of the extension cannot be written: the new version cannot be moved into it.
    const folder = join(w.root, EXT)
    chmodSync(folder, 0o500)
    try {
      expect(await w.store.reviewUpdate('default', EXT)).toBe('declined')
    } finally {
      chmodSync(folder, 0o700)
    }
    // The installed version was unloaded to make room: it runs again, not only after the next launch.
    expect(w.loaded.get(EXT)?.path).toBe(installed.path)
    expect(w.loaded.get(EXT)?.version).toBe('1.0')
    expect(existsSync(join(folder, '2.0_0'))).toBe(false)
    expect(w.notify).toHaveBeenCalledExactlyOnceWith(t('web-store.la-mise-a-jour-n-a-pas-pu-etre-chargee-la-version'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`the update of ${EXT} in profile default could not be put in place`), expect.objectContaining({ code: 'EACCES' }))
    expect(w.store.pendingUpdate('default', EXT)).toEqual({ version: '2.0' })
    error.mockRestore()
  })
})

describe('WebStore: uninstalling an extension', () => {
  it('removes its chrome.storage areas from the profile\'s partition, and nothing of another extension\'s', async () => {
    const w = world()
    await w.install(EXT, withContentScript('1.0'))
    const own = ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings'].map((folder) => join(w.partition, folder, EXT))
    for (const folder of own) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, '000003.log'), 'token')
    }
    const other = join(w.partition, 'Local Extension Settings', OTHER)
    const shared = join(w.partition, 'Extension State')
    for (const folder of [other, shared]) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'LOG'), 'x')
    }
    await w.store.uninstall('default', EXT)
    for (const folder of own) expect(existsSync(folder), folder).toBe(false)
    expect(existsSync(join(other, 'LOG'))).toBe(true)
    expect(existsSync(join(shared, 'LOG'))).toBe(true)
    expect(w.session.clearStorageData).toHaveBeenCalledWith({ origin: `chrome-extension://${EXT}` })
  })
})

describe('WebStore: the picture a store page names for its install dialog', () => {
  it('is answered locally only while the library\'s beginInstall runs its first part, not by any request that comes later', async () => {
    const w = world()
    const seen: Array<Response | undefined> = []
    // The library's listener, as the gate calls it: the picture is fetched synchronously, the package after something was awaited.
    const listener = () => {
      seen.push(w.store.pictureOfPage('GET'), w.store.pictureOfPage('POST'))
      return Promise.resolve().then(() => void seen.push(w.store.pictureOfPage('GET')))
    }
    await w.gate('chromeWebstore.beginInstall', listener)({ senderFrame: { origin: 'https://chromewebstore.google.com', parent: null }, sender: { session: w.session } })
    expect(seen[0]).toBeInstanceOf(Response)
    expect(seen[0]!.headers.get('content-type')).toBe('image/png')
    expect(seen.slice(1)).toEqual([undefined, undefined])
    expect(w.store.pictureOfPage('GET')).toBeUndefined()
    // Another channel of the library never gets it.
    const other: Array<Response | undefined> = []
    await w.gate('chromeWebstore.getExtensionStatus', () => void other.push(w.store.pictureOfPage('GET')))({ senderFrame: { origin: 'https://chromewebstore.google.com', parent: null }, sender: { session: w.session } })
    expect(other).toEqual([undefined])
  })
})


describe('WebStore: the gate in front of the library\'s IPC channels', () => {
  const STORE = 'https://chromewebstore.google.com'
  type Registered = (event: unknown, ...args: unknown[]) => Promise<unknown>

  /** The store switched on, and what `ipcMain.handle` was really given for each channel of the library: the listener a page reaches. */
  function gated() {
    const w = world()
    const registered = new Map(vi.mocked(ipcMain.handle).mock.calls.map(([channel, listener]) => [channel, listener as unknown as Registered]))
    /** A call from the top frame of a store page in a tab of the profile, unless `over` says otherwise. */
    const event = (over: { origin?: string; parent?: object | null; frame?: null; session?: unknown } = {}) => ({
      senderFrame: over.frame === null ? null : { origin: over.origin ?? STORE, parent: over.parent ?? null },
      sender: { session: over.session ?? w.session }
    })
    const call = (channel: string, over?: Parameters<typeof event>[0], ...args: unknown[]) => registered.get(channel)!(event(over), ...args)
    return { ...w, registered, event, call }
  }

  it('is what every channel of the library is registered with: a call that passes reaches the library, with its answer', async () => {
    const w = gated()
    expect([...w.registered.keys()].sort()).toEqual([...CHANNELS].sort())
    expect(await w.call('chromeWebstore.getExtensionStatus')).toBe('library:chromeWebstore.getExtensionStatus')
    expect(await w.call('chromeWebstore.beginInstall')).toBe('library:chromeWebstore.beginInstall')
    expect(w.libraryCalls).toEqual(['chromeWebstore.getExtensionStatus', 'chromeWebstore.beginInstall'])
    expect(w.store.refusal('chromeWebstore.beginInstall', w.event() as never)).toBeNull()
  })

  it.each([
    ['a host that only starts like the store', { origin: 'https://chromewebstore.google.com.evil.example' }, 'is not the store'],
    ['the store over http', { origin: 'http://chromewebstore.google.com' }, 'is not the store'],
    ['another page of Google', { origin: 'https://chrome.google.com' }, 'is not the store'],
    ['a frame of the store inside another page', { parent: { origin: 'https://evil.example' } }, 'not the top frame of the page'],
    ['a sender whose frame is gone', { frame: null }, 'no sender frame']
  ] as const)('refuses %s, on every channel: the library hears nothing', async (_name, over, why) => {
    const w = gated()
    for (const channel of CHANNELS) {
      expect(await w.call(channel, over, EXT), channel).toBeUndefined()
      expect(w.store.refusal(channel, w.event(over) as never), channel).toContain(why)
    }
    expect(w.libraryCalls).toEqual([])
    expect(w.host.requestUninstall).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(why))
  })

  it('refuses a session that is not a profile of ours, and a profile the store is not set up for', async () => {
    const w = gated()
    w.host.profileOfSession = () => undefined as never
    expect(await w.call('chromeWebstore.beginInstall')).toBeUndefined()
    expect(w.store.refusal('chromeWebstore.beginInstall', w.event() as never)).toBe('not a profile with the store enabled')
    w.host.profileOfSession = () => 'another-profile'
    expect(await w.call('chromeWebstore.beginInstall')).toBeUndefined()
    expect(w.store.refusal('chromeWebstore.getExtensionStatus', w.event() as never)).toBe('not a profile with the store enabled')
    expect(w.libraryCalls).toEqual([])
  })

  it('refuses a web contents that is not a tab (a popup, the page of an extension, a hidden view)', async () => {
    const w = gated()
    w.host.pageIdOf = () => undefined as never
    for (const channel of CHANNELS) expect(await w.call(channel, {}, EXT), channel).toBeUndefined()
    expect(w.store.refusal('chromeWebstore.beginInstall', w.event() as never)).toBe('not a tab')
    expect(w.libraryCalls).toEqual([])
    expect(w.host.requestUninstall).not.toHaveBeenCalled()
  })

  it('refuses to install or to uninstall without a click or a key just before, and still answers what a page reads', async () => {
    const w = gated()
    w.host.lastUserInput = () => Date.now() - 60_000
    expect(await w.call('chromeWebstore.beginInstall')).toBeUndefined()
    expect(await w.call('chrome.management.uninstall', {}, EXT)).toBeUndefined()
    expect(w.store.refusal('chromeWebstore.beginInstall', w.event() as never)).toBe('no click or key press just before')
    expect(w.host.requestUninstall).not.toHaveBeenCalled()
    expect(w.libraryCalls).toEqual([])
    expect(await w.call('chromeWebstore.getExtensionStatus')).toBe('library:chromeWebstore.getExtensionStatus')
  })

  it('refuses everything once installing from the store is switched off in the settings', async () => {
    const w = gated()
    w.store.configure({ install: false, updates: 'manual' })
    for (const channel of CHANNELS) expect(await w.call(channel, {}, EXT), channel).toBeUndefined()
    expect(w.store.refusal('chromeWebstore.getExtensionStatus', w.event() as never)).toBe('installing from the Chrome Web Store is switched off')
    expect(w.libraryCalls).toEqual([])
  })

  it('never lets the library uninstall: the shell is asked, for a real extension id only, and the page is told the user cancelled', async () => {
    const w = gated()
    expect(await w.call('chrome.management.uninstall', {}, EXT)).toBe('user_cancelled')
    expect(w.host.requestUninstall).toHaveBeenCalledWith('default', EXT)
    expect(await w.call('chrome.management.uninstall', {}, '../../etc')).toBe('user_cancelled')
    expect(w.host.requestUninstall).toHaveBeenCalledTimes(1)
    expect(w.libraryCalls).toEqual([])
  })
})
