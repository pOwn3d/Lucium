import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_IDS } from '@shared/platform'
import { NO_TOUCH_ID } from '../lock-service'
import { createPlatform, currentPlatform, type TouchIdSource } from './index'
import { browserDataDir, browserDataDirs, importAvailable } from './paths'

afterEach(() => vi.restoreAllMocks())

const LIGHTS = { x: 16, y: 17 }

describe('window frame', () => {
  it('keeps the three buttons of macOS at the given place, exactly as the windows were made before the layer', () => {
    expect(createPlatform('darwin').windowFrame(LIGHTS)).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: LIGHTS })
    expect(createPlatform('darwin').windowFrame(LIGHTS, { color: '#000', symbolColor: '#fff', height: 40 })).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: LIGHTS })
  })

  it('leaves the system title bar alone elsewhere, unless the buttons are asked for over the page', () => {
    for (const id of ['win32', 'linux'] as const) expect(createPlatform(id).windowFrame(LIGHTS)).toEqual({})
  })

  it('lays the three buttons of Windows over the page when they are asked for, in the colours and the height given', () => {
    const overlay = { color: 'rgba(0, 0, 0, 0)', symbolColor: '#f1f2f6', height: 42 }
    expect(createPlatform('win32').windowFrame(LIGHTS, overlay)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: overlay })
  })

  it('keeps the system title bar on Linux even when the buttons are asked for: nobody has seen them there (the side of the buttons follows the desktop)', () => {
    expect(createPlatform('linux').windowFrame(LIGHTS, { color: '#17171c', symbolColor: '#fff', height: 40 })).toEqual({})
  })
})

describe('the buttons laid over a window', () => {
  const overlay = { color: 'rgba(0, 0, 0, 0)', symbolColor: '#1a1d2b', height: 42 }

  it('are given new colours or a new height on Windows', () => {
    const win = { setTitleBarOverlay: vi.fn() }
    expect(createPlatform('win32').syncControlsOverlay(win, overlay)).toBe(true)
    expect(win.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith(overlay)
  })

  it('are never touched elsewhere: nothing is called, and the result says so', () => {
    for (const id of ['darwin', 'linux'] as const) {
      const win = { setTitleBarOverlay: vi.fn() }
      expect(createPlatform(id).syncControlsOverlay(win, overlay)).toBe(false)
      expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
    }
  })
})

describe('calls that exist on macOS only', () => {
  const windowSpy = () => ({ setVibrancy: vi.fn(), setWindowButtonVisibility: vi.fn(), setWindowButtonPosition: vi.fn(), removeMenu: vi.fn() })

  it('set the material behind the window on macOS, and take it away for "none"', () => {
    const win = windowSpy()
    expect(createPlatform('darwin').applyVibrancy(win, 'sidebar')).toBe(true)
    expect(createPlatform('darwin').applyVibrancy(win, 'none')).toBe(true)
    expect(win.setVibrancy.mock.calls).toEqual([['sidebar'], [null]])
  })

  it('place the traffic lights on macOS: visibility first, then position', () => {
    const win = windowSpy()
    const order: string[] = []
    win.setWindowButtonVisibility.mockImplementation(() => order.push('visibility'))
    win.setWindowButtonPosition.mockImplementation(() => order.push('position'))
    expect(createPlatform('darwin').syncTrafficLights(win, { visible: false, position: LIGHTS })).toBe(true)
    expect(order).toEqual(['visibility', 'position'])
    expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(false)
    expect(win.setWindowButtonPosition).toHaveBeenCalledWith(LIGHTS)
    expect(createPlatform('darwin').setWindowButtonVisibility(win, true)).toBe(true)
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true)
  })

  it('do not exist elsewhere: nothing is called on the window, and the result says so', () => {
    for (const id of ['win32', 'linux'] as const) {
      const win = windowSpy()
      const platform = createPlatform(id)
      expect(platform.applyVibrancy(win, 'sidebar')).toBe(false)
      expect(platform.syncTrafficLights(win, { visible: true, position: LIGHTS })).toBe(false)
      expect(platform.setWindowButtonVisibility(win, false)).toBe(false)
      expect(win.setVibrancy).not.toHaveBeenCalled()
      expect(win.setWindowButtonVisibility).not.toHaveBeenCalled()
      expect(win.setWindowButtonPosition).not.toHaveBeenCalled()
    }
  })

  it('take the menu bar off a window elsewhere, and never on macOS where the menu belongs to the application', () => {
    const mac = windowSpy()
    expect(createPlatform('darwin').removeWindowMenu(mac)).toBe(false)
    expect(mac.removeMenu).not.toHaveBeenCalled()
    for (const id of ['win32', 'linux'] as const) {
      const win = windowSpy()
      expect(createPlatform(id).removeWindowMenu(win)).toBe(true)
      expect(win.removeMenu).toHaveBeenCalledTimes(1)
    }
  })
})

describe('Touch ID', () => {
  const source = (): TouchIdSource & { canPromptTouchID: ReturnType<typeof vi.fn>; promptTouchID: ReturnType<typeof vi.fn> } => ({ canPromptTouchID: vi.fn(() => true), promptTouchID: vi.fn(() => Promise.resolve()) })

  it('asks the system on macOS, whenever it is asked', async () => {
    const touch = source()
    const port = createPlatform('darwin').touchId(touch)
    expect(port.available()).toBe(true)
    await port.prompt('déverrouiller')
    expect(touch.canPromptTouchID).toHaveBeenCalledTimes(1)
    expect(touch.promptTouchID).toHaveBeenCalledWith('déverrouiller')
    touch.canPromptTouchID.mockReturnValue(false)
    expect(port.available()).toBe(false)
  })

  it('is never offered elsewhere, and the system is not asked even if it claims to be able', async () => {
    for (const id of ['win32', 'linux'] as const) {
      const touch = source()
      const port = createPlatform(id).touchId(touch)
      expect(port).toBe(NO_TOUCH_ID)
      expect(port.available()).toBe(false)
      await expect(port.prompt('x')).rejects.toThrow('Touch ID is not available')
      expect(touch.canPromptTouchID).not.toHaveBeenCalled()
      expect(touch.promptTouchID).not.toHaveBeenCalled()
    }
  })
})

describe('battery charge', () => {
  it('reads pmset on macOS', async () => {
    const pmset = vi.fn(() => Promise.resolve("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 1:05 remaining present: true\n"))
    expect(await createPlatform('darwin', { pmset }).batteryPercent()).toBe(17)
    expect(pmset).toHaveBeenCalledTimes(1)
  })

  it('says unknown and logs when pmset fails, so the saver does not guess', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await createPlatform('darwin', { pmset: () => Promise.reject(new Error('spawn pmset ENOENT')) }).batteryPercent()).toBeNull()
    expect(warn).toHaveBeenCalledWith('[battery] cannot read the charge:', 'spawn pmset ENOENT')
  })

  it('reads the files of the batteries on Linux and ignores the other power supplies', async () => {
    const files: Record<string, string> = { '/sys/class/power_supply/BAT0/capacity': '64\n', '/sys/class/power_supply/BAT1/capacity': '12\n' }
    const readText = vi.fn((path: string) => (path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no ${path}`))))
    const linux = createPlatform('linux', { powerSupplies: () => Promise.resolve(['AC', 'BAT1', 'BAT0', 'hid-0003-battery']), readText })
    expect(await linux.batteryPercent()).toBe(64)
    expect(readText.mock.calls.map(([path]) => path)).toEqual(['/sys/class/power_supply/BAT0/capacity', '/sys/class/power_supply/BAT1/capacity'])
  })

  it('says unknown on a Linux computer without a battery, and logs a read that fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await createPlatform('linux', { powerSupplies: () => Promise.resolve(['AC']), readText: () => Promise.reject(new Error('unused')) }).batteryPercent()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    const broken = createPlatform('linux', { powerSupplies: () => Promise.reject(new Error('ENOENT: no such directory')) })
    expect(await broken.batteryPercent()).toBeNull()
    expect(warn).toHaveBeenCalledWith('[battery] cannot read the charge:', 'ENOENT: no such directory')
  })

  it('has no way to read it on Windows and runs nothing to try', async () => {
    const pmset = vi.fn(() => Promise.resolve('99%;'))
    const powerSupplies = vi.fn(() => Promise.resolve(['BAT0']))
    expect(await createPlatform('win32', { pmset, powerSupplies }).batteryPercent()).toBeNull()
    expect(pmset).not.toHaveBeenCalled()
    expect(powerSupplies).not.toHaveBeenCalled()
  })

  it('never runs pmset on Linux', async () => {
    const pmset = vi.fn(() => Promise.resolve('50%;'))
    await createPlatform('linux', { pmset, powerSupplies: () => Promise.resolve([]) }).batteryPercent()
    expect(pmset).not.toHaveBeenCalled()
  })
})

describe('menu, shortcuts and words', () => {
  it('hands the menu of macOS back untouched', () => {
    const template = [{ label: 'a', submenu: [{ role: 'hide' as const }] }]
    expect(createPlatform('darwin').adaptMenu(template)).toBe(template)
    expect(createPlatform('linux').adaptMenu(template)).toEqual([])
  })

  it('gives each system its own defaults to the shortcuts', () => {
    expect(createPlatform('darwin').accelerator('fullscreen', undefined)).toBe('Ctrl+CmdOrCtrl+F')
    expect(createPlatform('win32').accelerator('fullscreen', undefined)).toBe('F11')
    expect(createPlatform('win32').accelerator('fullscreen', { fullscreen: 'F10' })).toBe('F10')
  })

  it('names the file manager and the settings link of its system', () => {
    expect(createPlatform('darwin').revealLabel).toBe('Afficher dans le Finder')
    expect(createPlatform('win32').revealLabel).toBe('Afficher dans l’Explorateur de fichiers')
    expect(createPlatform('linux').settingsLink('disk-access')).toBeNull()
    expect(createPlatform('darwin').settingsLink('disk-access')).toContain('x-apple.systempreferences')
  })

  it('takes the links of the command line only where the system has no event for them', () => {
    const argv = ['lucium', 'https://example.org/', '--flag']
    expect(createPlatform('darwin').commandLineLinks(argv)).toEqual([])
    expect(createPlatform('win32').commandLineLinks(argv)).toEqual(['https://example.org/'])
    expect(createPlatform('linux').commandLineLinks(argv)).toEqual(['https://example.org/'])
    // A command by address (`lucium://`) given to the first launch is a link too, as on macOS, where the event brings it.
    expect(createPlatform('linux').commandLineLinks(['lucium', 'lucium://new-tab'])).toEqual(['lucium://new-tab'])
    expect(createPlatform('darwin').commandLineLinks(['lucium', 'lucium://new-tab'])).toEqual([])
  })

  it('splits a list of paths with the delimiter of its system', () => {
    expect(createPlatform('win32').splitPathList('C:\\a;D:\\b')).toEqual(['C:\\a', 'D:\\b'])
    expect(createPlatform('linux').splitPathList('/a:/b')).toEqual(['/a', '/b'])
  })
})

describe('the folders of the other browsers', () => {
  const chrome = { id: 'chrome', support: 'Google/Chrome' }
  const arc = { id: 'arc', support: 'Arc' }
  const firefox = { id: 'firefox', support: 'Firefox/Profiles' }

  it('are the Application Support folders of macOS, as the importers always built them', () => {
    const env = { home: '/Users/u' }
    expect(browserDataDir(chrome, 'darwin', env)).toBe('/Users/u/Library/Application Support/Google/Chrome')
    expect(browserDataDir(arc, 'darwin', env)).toBe('/Users/u/Library/Application Support/Arc')
    expect(browserDataDir(firefox, 'darwin', env)).toBe('/Users/u/Library/Application Support/Firefox/Profiles')
    expect(browserDataDir({ id: 'edge', support: 'Microsoft Edge' }, 'darwin', env)).toBe('/Users/u/Library/Application Support/Microsoft Edge')
  })

  it('follow LOCALAPPDATA and APPDATA on Windows, and the home folder when they are not set', () => {
    const env = { home: 'C:\\Users\\u', localAppData: 'D:\\Local', appData: 'D:\\Roaming' }
    expect(browserDataDir(chrome, 'win32', env)).toBe('D:\\Local\\Google\\Chrome\\User Data')
    expect(browserDataDir({ id: 'edge' }, 'win32', env)).toBe('D:\\Local\\Microsoft\\Edge\\User Data')
    expect(browserDataDir({ id: 'brave' }, 'win32', env)).toBe('D:\\Local\\BraveSoftware\\Brave-Browser\\User Data')
    expect(browserDataDir(firefox, 'win32', env)).toBe('D:\\Roaming\\Mozilla\\Firefox\\Profiles')
    expect(browserDataDir(chrome, 'win32', { home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data')
    expect(browserDataDir(firefox, 'win32', { home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles')
  })

  it('follow XDG_CONFIG_HOME on Linux, and ~/.config when it is not set', () => {
    expect(browserDataDir(chrome, 'linux', { home: '/home/u' })).toBe('/home/u/.config/google-chrome')
    expect(browserDataDir(chrome, 'linux', { home: '/home/u', xdgConfigHome: '/data/cfg' })).toBe('/data/cfg/google-chrome')
    expect(browserDataDir({ id: 'brave' }, 'linux', { home: '/home/u' })).toBe('/home/u/.config/BraveSoftware/Brave-Browser')
    expect(browserDataDir({ id: 'vivaldi' }, 'linux', { home: '/home/u' })).toBe('/home/u/.config/vivaldi')
    expect(browserDataDir(firefox, 'linux', { home: '/home/u', xdgConfigHome: '/data/cfg' })).toBe('/home/u/.mozilla/firefox')
  })

  it('know the snap and flatpak folders of Linux browsers, after the ordinary one', () => {
    const home = '/home/u'
    expect(browserDataDirs(firefox, 'linux', { home })).toEqual([
      '/home/u/.mozilla/firefox',
      '/home/u/snap/firefox/common/.mozilla/firefox',
      '/home/u/.var/app/org.mozilla.firefox/.mozilla/firefox'
    ])
    expect(browserDataDirs({ id: 'chromium' }, 'linux', { home })).toEqual([
      '/home/u/.config/chromium',
      '/home/u/snap/chromium/common/chromium',
      '/home/u/.var/app/org.chromium.Chromium/config/chromium'
    ])
    expect(browserDataDirs({ id: 'brave' }, 'linux', { home })).toEqual(['/home/u/.config/BraveSoftware/Brave-Browser', '/home/u/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'])
    expect(browserDataDirs(chrome, 'linux', { home })).toEqual(['/home/u/.config/google-chrome'])
  })

  it('pick the folder that exists, the ordinary one first, and the first one when none exists', () => {
    const snap = '/home/u/snap/firefox/common/.mozilla/firefox'
    const onlySnap = (dir: string) => dir === snap
    expect(browserDataDir(firefox, 'linux', { home: '/home/u' }, onlySnap)).toBe(snap)
    expect(browserDataDir(firefox, 'linux', { home: '/home/u' }, (dir) => dir === snap || dir === '/home/u/.mozilla/firefox')).toBe('/home/u/.mozilla/firefox')
    expect(browserDataDir(firefox, 'linux', { home: '/home/u' })).toBe('/home/u/.mozilla/firefox')
  })

  it('do not exist for Safari and Arc away from macOS, and for a browser the table does not know', () => {
    for (const id of ['win32', 'linux'] as const) {
      expect(importAvailable('safari', id)).toBe(false)
      expect(importAvailable('arc', id)).toBe(false)
      expect(browserDataDir(arc, id, { home: '/h' })).toBeNull()
      expect(importAvailable('chrome', id)).toBe(true)
      expect(browserDataDir({ id: 'unheard-of' }, id, { home: '/h' })).toBeNull()
    }
    expect(importAvailable('safari', 'darwin')).toBe(true)
    expect(importAvailable('arc')).toBe(true)
  })
})

describe('the platform of this process', () => {
  it('is the one process.platform names', () => {
    expect(PLATFORM_IDS).toContain(currentPlatform().id)
    expect(currentPlatform()).toBe(currentPlatform())
    if (process.platform === 'darwin' || process.platform === 'win32') expect(currentPlatform().id).toBe(process.platform)
  })
})
