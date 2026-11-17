import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_ICONS, DEFAULT_APP_ICON } from '@shared/icons'
import { BUNDLE_ICON_FILE, BUNDLE_ICON_SCRIPT } from './bundle-icon'
import { tempDir } from '../temp-dir'
import { onWindows, posix } from '../windows.test-support'

const repo = join(__dirname, '../../..')

// The bundle of the "built application" is a folder of a throw-away place; the icon files are the repository's own.
const place = { bundle: '', userData: '' }
const dock = { setIcon: vi.fn() }
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => repo,
    getPath: (name: string) => (name === 'exe' ? join(place.bundle, 'Contents/MacOS/Lucium') : place.userData),
    get dock() {
      return dock
    }
  },
  nativeImage: { createFromPath: (path: string) => ({ path, isEmpty: () => !existsSync(path), resize: () => ({ isEmpty: () => false }) }) }
}))

// The calls to the system: the one of the custom icon goes through execFile (promisified); no other may happen. The stand-in does to the bundle
// what the real script does (bundle-icon.test.ts runs the real one on macOS): an `Icon\r` file for a picture, none for an empty one.
const calls = { async: vi.fn(), sync: vi.fn() }
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = Object.assign((...args: unknown[]) => calls.async(...args), { [promisify.custom]: (...args: unknown[]) => calls.async(...args) })
  return { ...actual, execFile, execFileSync: (...args: unknown[]) => calls.sync(...args), spawn: (...args: unknown[]) => calls.async(...args), spawnSync: (...args: unknown[]) => calls.sync(...args) }
})
const scriptStandIn = async (_program: string, args: string[]) => {
  const [bundle, picture] = args.slice(-2) as [string, string]
  if (picture) writeFileSync(join(bundle, BUNDLE_ICON_FILE), '')
  else rmSync(join(bundle, BUNDLE_ICON_FILE), { force: true })
  return { stdout: 'true\n', stderr: '' }
}
const osascript = (bundle: string, picture: string) => ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', BUNDLE_ICON_SCRIPT, bundle, picture], { timeout: 5000, encoding: 'utf8' }]

// Windows: the stand-in of the script puts a file named "Icon" followed by a carriage return in the bundle, as the real one does on macOS, and Windows forbids that name.
const itOnTheBundle = it.skipIf(onWindows)

const { appIconsFolder, applyAppIcon, appIconIssue, followAppIcon, runningBundle, takeAppIconOffForUpdate } = await import('./app-icon')

// A built application keeps its icon files in its resources folder, which Electron tells through `process.resourcesPath`; its executable,
// `process.execPath`, is inside its bundle; the bundle is changed on macOS only. Each test starts on macOS, whatever system runs it.
const saved = {
  resourcesPath: Object.getOwnPropertyDescriptor(process, 'resourcesPath'),
  execPath: Object.getOwnPropertyDescriptor(process, 'execPath'),
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  defaultApp: Object.getOwnPropertyDescriptor(process, 'defaultApp')
}
const setProcess = (key: keyof typeof saved, value: unknown): void => void Object.defineProperty(process, key, { value, configurable: true, writable: true, enumerable: true })
const setResources = (path: string): void => setProcess('resourcesPath', path)
const restoreProcess = (): void => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(process, key, descriptor)
    else delete (process as unknown as Record<string, unknown>)[key]
  }
}
beforeEach(() => {
  setResources(join(repo, 'resources'))
  setProcess('platform', 'darwin')
})
afterEach(restoreProcess)

/** A throw-away bundle, the running application's (process.execPath is its executable), and a data folder. */
function runFrom(prefix: string): void {
  const root = tempDir(prefix)
  place.bundle = join(root, 'Lucium.app')
  place.userData = join(root, 'data')
  mkdirSync(join(place.bundle, 'Contents/MacOS'), { recursive: true })
  mkdirSync(place.userData)
  setProcess('execPath', join(place.bundle, 'Contents/MacOS/Lucium'))
}

describe('the application icon files', () => {
  it('are read from the resources of the application once it is built', () => {
    expect(appIconsFolder()).toBe(join(process.resourcesPath, 'app-icons'))
  })

  it('exist as PNG files of 512 x 512 pixels for every icon of the list, and no other file sits there', () => {
    const folder = join(repo, 'resources/app-icons')
    for (const icon of APP_ICONS) {
      const file = join(folder, `${icon.id}.png`)
      expect(existsSync(file), icon.id).toBe(true)
      const bytes = readFileSync(file)
      expect(bytes.subarray(1, 4).toString('latin1'), icon.id).toBe('PNG')
      expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, icon.id).toEqual({ width: 512, height: 512 })
    }
    expect(readdirSync(folder).sort()).toEqual(APP_ICONS.map((i) => `${i.id}.png`).sort())
  })
})

// The chosen icon is shown in the Dock at once, and put on the bundle of the running application so that the Dock, the Finder and the Launchpad keep
// it once Lucium is closed: only that bundle, found from process.execPath, on macOS, in the built application (bundle-icon.test.ts has the rest).
describe('the application icon in the Dock and on the bundle', () => {
  /** Every file under a folder, as relative paths. */
  const tree = (root: string): string[] => readdirSync(root, { recursive: true, encoding: 'utf8' }).map(posix).sort()
  const picture = (id: string): string => join(repo, `resources/app-icons/${id}.png`)

  beforeEach(() => {
    runFrom('lucium-icon-')
    calls.async.mockReset()
    calls.async.mockImplementation(scriptStandIn)
    calls.sync.mockReset()
    dock.setIcon.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  itOnTheBundle('shows the chosen icon in the Dock, with its own picture', async () => {
    expect(await applyAppIcon('cyber')).toBeNull()
    expect(dock.setIcon).toHaveBeenCalledTimes(1)
    expect((dock.setIcon.mock.calls[0]![0] as { path: string }).path).toBe(picture('cyber'))
    expect(await appIconIssue()).toBeNull()
  })

  itOnTheBundle('puts it on the bundle of the running application, by osascript without a shell and with the script as a constant, and records it in the data folder', async () => {
    expect(runningBundle()).toBe(place.bundle)
    expect(await applyAppIcon('sepia-or')).toBeNull()
    expect(calls.async.mock.calls).toEqual([osascript(place.bundle, picture('sepia-or'))])
    expect(tree(place.bundle)).toEqual(['Contents', 'Contents/MacOS', BUNDLE_ICON_FILE].sort())
    expect(JSON.parse(readFileSync(join(place.userData, 'bundle-icon.json'), 'utf8'))).toEqual({ bundle: place.bundle, icon: 'sepia-or' })
    expect(tree(place.userData)).toEqual(['bundle-icon.json'])
    expect(calls.sync).not.toHaveBeenCalled()
    // Chosen again: the bundle carries it, nothing is called.
    expect(await applyAppIcon('sepia-or')).toBeNull()
    expect(calls.async).toHaveBeenCalledTimes(1)
  })

  itOnTheBundle('takes it off the bundle when the default icon is chosen, and leaves a bundle without one as it is', async () => {
    await applyAppIcon('cyber')
    expect(await applyAppIcon(DEFAULT_APP_ICON)).toBeNull()
    expect(calls.async).toHaveBeenLastCalledWith(...osascript(place.bundle, ''))
    expect(tree(place.bundle)).toEqual(['Contents', 'Contents/MacOS'])
    expect(tree(place.userData)).toEqual([])
    calls.async.mockClear()
    await applyAppIcon(DEFAULT_APP_ICON)
    await applyAppIcon('inconnu')
    expect(calls.async).not.toHaveBeenCalled()
  })

  it('never changes a bundle while developing, off macOS, or when the executable is not in a bundle', async () => {
    const elsewhere: Array<() => void> = [() => setProcess('defaultApp', true), () => setProcess('platform', 'linux'), () => setProcess('execPath', '/usr/local/bin/lucium')]
    for (const move of elsewhere) {
      move()
      expect(runningBundle()).toBeNull()
      expect(await applyAppIcon('cyber')).toBeNull()
      expect(await appIconIssue()).toBeNull()
      restoreProcess()
      setResources(join(repo, 'resources'))
      setProcess('platform', 'darwin')
      setProcess('execPath', join(place.bundle, 'Contents/MacOS/Lucium'))
    }
    expect(calls.async).not.toHaveBeenCalled()
    expect(tree(place.bundle)).toEqual(['Contents', 'Contents/MacOS'])
    expect(dock.setIcon).toHaveBeenCalledTimes(3)
  })

  // As root, every folder can be written: the case cannot be made. Windows: chmod changes no bit there, and the stand-in cannot write its file anyway.
  it.skipIf(process.getuid?.() === 0 || onWindows)('says, and writes to the log, that the bundle cannot be written, while the Dock shows the icon', async () => {
    chmodSync(place.bundle, 0o555)
    expect(await applyAppIcon('solaire')).toEqual({ reason: 'bundle-not-writable' })
    expect(await appIconIssue()).toEqual({ reason: 'bundle-not-writable' })
    expect(dock.setIcon).toHaveBeenCalledTimes(1)
    expect(calls.async).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`cannot put the icon "solaire" on ${place.bundle}: EACCES`))
    chmodSync(place.bundle, 0o755)
    expect(await applyAppIcon('abysse')).toBeNull()
    expect(await appIconIssue()).toBeNull()
  })

  it('gives the default icon for an id it does not know', async () => {
    expect(await applyAppIcon('inconnu')).toBeNull()
    expect((dock.setIcon.mock.calls[0]![0] as { path: string }).path).toBe(picture(DEFAULT_APP_ICON))
  })

  itOnTheBundle('still shows Boréal for the id `lucium` a profile saved before the fan logo', async () => {
    expect(await applyAppIcon('boreal')).toBeNull()
    expect((dock.setIcon.mock.calls[0]![0] as { path: string }).path).toBe(picture('boreal'))
  })

  itOnTheBundle('says so, and leaves the Dock and the bundle as they are, when the picture of the icon is missing from the application', async () => {
    setResources(tempDir('lucium-no-icons-'))
    expect(await applyAppIcon('cyber')).toEqual({ reason: 'missing-picture' })
    expect(await appIconIssue()).toEqual({ reason: 'missing-picture' })
    expect(dock.setIcon).not.toHaveBeenCalled()
    expect(calls.async).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('missing'))
    // The next choice whose picture is there clears it.
    setResources(join(repo, 'resources'))
    expect(await applyAppIcon('cyber')).toBeNull()
    expect(await appIconIssue()).toBeNull()
  })
})

describe('the application icon, as the main process follows the setting', () => {
  /** A store whose setting can be changed, and whose listeners are called as the real one calls them. */
  function store(appIcon: string) {
    const listeners = new Set<() => void>()
    const state = { settings: { appIcon } }
    return {
      get: () => state,
      subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      choose: (id: string) => {
        state.settings = { appIcon: id }
        for (const listener of listeners) listener()
      },
      listeners
    }
  }

  it('is shown at launch and at each choice, and not again while the choice stays the same', () => {
    const settings = store('cyber')
    const apply = vi.fn()
    followAppIcon(settings, apply)
    expect(apply.mock.calls).toEqual([['cyber']])
    settings.choose('cyber')
    settings.choose('solaire')
    settings.choose('solaire')
    settings.choose('boreal')
    expect(apply.mock.calls).toEqual([['cyber'], ['solaire'], ['boreal']])
  })

  it('goes on when the icon cannot be shown, with a line in the log', () => {
    const settings = store('cyber')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const apply = vi.fn(() => {
      throw new Error('no dock')
    })
    expect(() => followAppIcon(settings, apply)).not.toThrow()
    expect(() => settings.choose('solaire')).not.toThrow()
    expect(apply).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith('[icon] cannot show the application icon:', expect.any(Error))
    error.mockRestore()
  })

  it('writes to the log a choice whose icon fails later on, and goes on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    followAppIcon(store('cyber'), () => Promise.reject(new Error('the bundle is gone')))
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[icon] cannot show the application icon:', expect.objectContaining({ message: 'the bundle is gone' })))
    error.mockRestore()
  })

  it('stops following when asked', () => {
    const settings = store('cyber')
    const apply = vi.fn()
    followAppIcon(settings, apply)()
    settings.choose('solaire')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(settings.listeners.size).toBe(0)
  })

  itOnTheBundle('shows the icon through the Dock and the bundle by default', async () => {
    dock.setIcon.mockClear()
    runFrom('lucium-icon-follow-')
    calls.async.mockReset()
    calls.async.mockImplementation(scriptStandIn)
    followAppIcon(store('cyber'))
    expect((dock.setIcon.mock.calls[0]![0] as { path: string }).path).toBe(join(repo, 'resources/app-icons/cyber.png'))
    expect(await appIconIssue()).toBeNull()
    expect(existsSync(join(place.bundle, BUNDLE_ICON_FILE))).toBe(true)
  })
})

// Last: once the icon came off for an update, nothing is put on the bundle again in this run (the module keeps one keeper per run).
describe('the application icon, before an update is installed', () => {
  itOnTheBundle('comes off the bundle of the running application, and is not put back in this run', async () => {
    runFrom('lucium-icon-update-')
    calls.async.mockReset()
    calls.async.mockImplementation(scriptStandIn)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await applyAppIcon('nebula')
    expect(existsSync(join(place.bundle, BUNDLE_ICON_FILE))).toBe(true)
    await takeAppIconOffForUpdate()
    expect(existsSync(join(place.bundle, BUNDLE_ICON_FILE))).toBe(false)
    expect(calls.async).toHaveBeenLastCalledWith(...osascript(place.bundle, ''))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('before the update is installed; the next launch puts it back'))
    await applyAppIcon('cyber')
    expect(existsSync(join(place.bundle, BUNDLE_ICON_FILE))).toBe(false)
    expect(calls.async).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
