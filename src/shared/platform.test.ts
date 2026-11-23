import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { acceleratorFromKeyEvent, COMMANDS, effectiveAccelerator, formatAccelerator, isValidAccelerator } from './keybindings'
import { checkHostManifest, nativeHostDirs } from './native-messaging'
import {
  canonicalAccelerator,
  defaultAcceleratorFor,
  formatAcceleratorFor,
  isAbsolutePath,
  isClosedToOthers,
  LINUX_DEFAULTS,
  isOwnerOnlyMode,
  linksFromArgv,
  NON_MAC_DEFAULTS,
  PLATFORM_FACTS,
  PLATFORM_IDS,
  platformOf,
  revealLabel,
  settingsLink,
  splitPathList,
  autoUpdateKey,
  autoUpdateOn,
  updatesByHand,
  usesCtrlAlt,
  WINDOWS_DEFAULTS
} from './platform'
import { DISK_ACCESS_SETTINGS_URL } from './import-sources'
import { parseSysfsCapacity } from './battery-saver'
import { cleanProfileOverrides } from './profiles'

describe('platformOf', () => {
  it('knows macOS and Windows, and takes every other system for Linux', () => {
    expect(platformOf('darwin')).toBe('darwin')
    expect(platformOf('win32')).toBe('win32')
    expect(platformOf('linux')).toBe('linux')
    expect(platformOf('freebsd')).toBe('linux')
    expect(platformOf(undefined)).toBe('linux')
  })
})

describe('updatesByHand: which copies have no update path', () => {
  it('is false on macOS (Squirrel.Mac) and on Windows (the NSIS installer of the signed feed), and true on a Linux copy that is neither an AppImage nor a .deb', () => {
    expect(updatesByHand('darwin')).toBe(false)
    expect(updatesByHand('win32')).toBe(false)
    expect(updatesByHand('linux')).toBe(true)
    expect(updatesByHand('linux', null)).toBe(true)
  })

  it('is false on Linux for an AppImage (it replaces itself) and for a .deb (it is told the command), and the packaging means nothing elsewhere', () => {
    expect(updatesByHand('linux', 'appimage')).toBe(false)
    expect(updatesByHand('linux', 'deb')).toBe(false)
    expect(updatesByHand('darwin', null)).toBe(false)
    expect(updatesByHand('win32', null)).toBe(false)
  })

  it('counts any other Unix as Linux, and anything that is not a system name (a stand-in snapshot with no platform) as macOS', () => {
    expect(updatesByHand('freebsd')).toBe(true)
    expect(updatesByHand(undefined)).toBe(false)
    expect(updatesByHand(null)).toBe(false)
    expect(updatesByHand(42)).toBe(false)
  })
})

describe('autoUpdateKey and autoUpdateOn: which switch commands the look for an update by itself', () => {
  it('is the own switch of Windows and Linux (any other Unix counts as Linux); macOS, a non-system value included, reads autoUpdate', () => {
    expect(autoUpdateKey('win32')).toBe('windowsAutoUpdate')
    expect(autoUpdateKey('linux')).toBe('windowsAutoUpdate')
    expect(autoUpdateKey('freebsd')).toBe('windowsAutoUpdate')
    expect(autoUpdateKey('darwin')).toBe('autoUpdate')
    for (const value of [undefined, null, 42]) expect(autoUpdateKey(value)).toBe('autoUpdate')
  })

  it('reads on Windows and on Linux the own switch alone: the old autoUpdate, true without having been chosen, turns nothing on', () => {
    for (const platform of ['win32', 'linux']) {
      expect(autoUpdateOn({ autoUpdate: true, windowsAutoUpdate: false }, platform), platform).toBe(false)
      expect(autoUpdateOn({ autoUpdate: false, windowsAutoUpdate: true }, platform), platform).toBe(true)
      expect(autoUpdateOn({ autoUpdate: true, windowsAutoUpdate: true }, platform), platform).toBe(true)
    }
  })

  it('reads on macOS (and where no system is named) autoUpdate alone: the own switch of the others turns nothing on', () => {
    for (const platform of ['darwin', undefined]) {
      expect(autoUpdateOn({ autoUpdate: true, windowsAutoUpdate: false }, platform), String(platform)).toBe(true)
      expect(autoUpdateOn({ autoUpdate: false, windowsAutoUpdate: true }, platform), String(platform)).toBe(false)
    }
  })

  it('counts only a real true: a value that is not a boolean is off', () => {
    expect(autoUpdateOn({ autoUpdate: true, windowsAutoUpdate: 'true' as unknown as boolean }, 'win32')).toBe(false)
    expect(autoUpdateOn({ autoUpdate: 1 as unknown as boolean, windowsAutoUpdate: false }, 'darwin')).toBe(false)
  })
})

describe('facts', () => {
  it('give macOS everything that was written for it, and the other systems none of the macOS-only ones', () => {
    for (const key of ['trafficLights', 'vibrancy', 'dock', 'touchId', 'globalMenuBar', 'openWithBundle', 'settingsLinks', 'shareSheet', 'openUrlEvent', 'screenRecordingPermission', 'importSafari', 'importArc'] as const) {
      expect(PLATFORM_FACTS.darwin[key], `darwin ${key}`).toBe(true)
      expect(PLATFORM_FACTS.win32[key], `win32 ${key}`).toBe(false)
      expect(PLATFORM_FACTS.linux[key], `linux ${key}`).toBe(false)
    }
  })

  it('leave the spell checker off by default where it would download dictionaries from Chromium’s CDN', () => {
    expect(PLATFORM_IDS.map((id) => PLATFORM_FACTS[id].systemSpellChecker)).toEqual([true, false, false])
  })

  it('separate paths with a semicolon on Windows only, and carry shortcuts on Ctrl elsewhere than macOS', () => {
    expect(PLATFORM_IDS.map((id) => PLATFORM_FACTS[id].pathDelimiter)).toEqual([':', ';', ':'])
    expect(PLATFORM_IDS.map((id) => PLATFORM_FACTS[id].commandKey)).toEqual(['meta', 'control', 'control'])
  })
})

describe('words', () => {
  it('names the place where a file is shown after the system', () => {
    expect(revealLabel('darwin')).toBe('Afficher dans le Finder')
    expect(revealLabel()).toBe('Afficher dans le Finder')
    expect(revealLabel('win32')).not.toContain('Finder')
    expect(revealLabel('linux')).not.toContain('Finder')
  })

  it('links into the system settings on macOS only', () => {
    expect(settingsLink('disk-access')).toBe(DISK_ACCESS_SETTINGS_URL)
    expect(settingsLink('disk-access', 'win32')).toBeNull()
    // The pane Language & Region, whose button installs the languages of the system's translation; no such link elsewhere.
    expect(settingsLink('translation-languages', 'darwin')).toBe('x-apple.systempreferences:com.apple.Localization-Settings.extension')
    expect(settingsLink('translation-languages', 'win32')).toBeNull()
    expect(settingsLink('translation-languages', 'linux')).toBeNull()
  })
})

describe('file modes', () => {
  it('asks for 0600 on macOS and Linux, and refuses a file others can read', () => {
    for (const id of ['darwin', 'linux'] as const) {
      expect(isOwnerOnlyMode(0o100600, id)).toBe(true)
      expect(isOwnerOnlyMode(0o100644, id)).toBe(false)
      expect(isOwnerOnlyMode(0o100666, id)).toBe(false)
    }
    // Without a platform it is macOS.
    expect(isOwnerOnlyMode(0o100666)).toBe(false)
  })

  it('accepts every mode on Windows, which reports 0666 for each file and has no bits to read: refusing it would leave the vault unwritable', () => {
    expect(isOwnerOnlyMode(0o100666, 'win32')).toBe(true)
    expect(isOwnerOnlyMode(0o100444, 'win32')).toBe(true)
  })

  it('tells a file or a folder open to the group or the others on macOS and Linux only: Windows has no bits to read', () => {
    for (const id of ['darwin', 'linux'] as const) {
      expect(isClosedToOthers(0o100600, id)).toBe(true)
      expect(isClosedToOthers(0o040700, id)).toBe(true)
      expect(isClosedToOthers(0o100640, id)).toBe(false)
      expect(isClosedToOthers(0o040755, id)).toBe(false)
    }
    expect(isClosedToOthers(0o100644)).toBe(false)
    expect(isClosedToOthers(0o100666, 'win32')).toBe(true)
    expect(isClosedToOthers(0o040777, 'win32')).toBe(true)
  })
})

describe('paths and command lines', () => {
  it('splits a list of paths on the delimiter of the system, so that a Windows drive letter survives', () => {
    expect(splitPathList('/a/one:/b/two::/c')).toEqual(['/a/one', '/b/two', '/c'])
    expect(splitPathList('C:\\ext\\one;D:\\ext\\two', 'win32')).toEqual(['C:\\ext\\one', 'D:\\ext\\two'])
    expect(splitPathList('C:\\ext\\one;D:\\ext\\two', 'darwin')).toEqual(['C', '\\ext\\one;D', '\\ext\\two'])
  })

  it('tells an absolute path of each system', () => {
    expect(isAbsolutePath('/usr/bin/host')).toBe(true)
    expect(isAbsolutePath('host')).toBe(false)
    expect(isAbsolutePath('C:\\Program Files\\host.exe', 'win32')).toBe(true)
    expect(isAbsolutePath('c:/host.exe', 'win32')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\host.exe', 'win32')).toBe(true)
    expect(isAbsolutePath('\\host.exe', 'win32')).toBe(false)
    expect(isAbsolutePath('host.exe', 'win32')).toBe(false)
    expect(isAbsolutePath('/usr/bin/host', 'win32')).toBe(false)
    expect(isAbsolutePath('C:\\host.exe', 'linux')).toBe(false)
  })

  it('keeps the web addresses of a command line and nothing else', () => {
    expect(linksFromArgv(['/opt/Lucium/lucium', '--no-sandbox', 'https://example.org/a', 'HTTP://example.net', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c'])).toEqual(['https://example.org/a', 'HTTP://example.net'])
  })

  it('keeps the commands by address too: lucium://, with its two slashes, and no other scheme', () => {
    expect(linksFromArgv(['lucium', 'lucium://new-tab', 'LUCIUM://open?url=x', 'lucium://search?q=a', 'browser://search?q=a', 'lucium:new-tab', 'lucium//x', 'notlucium://x'])).toEqual(['lucium://new-tab', 'LUCIUM://open?url=x', 'lucium://search?q=a'])
  })

  it('reads the charge of a battery from the files of Linux', () => {
    expect(parseSysfsCapacity(['87\n'])).toBe(87)
    expect(parseSysfsCapacity(['', 'nope', '42'])).toBe(42)
    expect(parseSysfsCapacity(['101', '-3', '1.5'])).toBeNull()
    expect(parseSysfsCapacity([])).toBeNull()
  })
})

describe('a download folder saved in the profiles', () => {
  const kept = (dir: string) => cleanProfileOverrides({ work: { downloadDir: dir, historyOff: true } })['work']?.downloadDir
  it('is kept when it is absolute on macOS, Linux or Windows, and dropped when it is not', () => {
    expect(kept('/Users/x/Pro')).toBe('/Users/x/Pro')
    expect(kept('C:\\Users\\x\\Downloads')).toBe('C:\\Users\\x\\Downloads')
    expect(kept('\\\\nas\\share\\dl')).toBe('\\\\nas\\share\\dl')
    expect(kept('relative/path')).toBeUndefined()
    expect(kept('C:relative')).toBeUndefined()
  })
})

describe('native messaging hosts', () => {
  it('looks in the folders of each system, and in none on Windows (the registry holds them there)', () => {
    expect(nativeHostDirs('/ud', '/home/u', false, 'linux')).toEqual(['/ud/NativeMessagingHosts'])
    expect(nativeHostDirs('/ud', '/Users/u', true)).toEqual(['/ud/NativeMessagingHosts', '/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts', '/Library/Google/Chrome/NativeMessagingHosts'])
    expect(nativeHostDirs('/ud', '/home/u', true, 'linux')).toEqual(['/ud/NativeMessagingHosts', '/home/u/.config/google-chrome/NativeMessagingHosts', '/etc/opt/chrome/native-messaging-hosts'])
    expect(nativeHostDirs('C:\\ud', 'C:\\Users\\u', true, 'win32')).toEqual(['C:\\ud/NativeMessagingHosts'])
  })

  it('accepts the absolute path of the system in a manifest, and refuses the other systems’', () => {
    const manifest = (path: string) => JSON.stringify({ name: 'com.x.host', type: 'stdio', path, allowed_origins: ['chrome-extension://abc/'] })
    expect(checkHostManifest(manifest('/usr/bin/host'), 'com.x.host', 'abc').ok).toBe(true)
    expect(checkHostManifest(manifest('C:\\host.exe'), 'com.x.host', 'abc').ok).toBe(false)
    expect(checkHostManifest(manifest('C:\\host.exe'), 'com.x.host', 'abc', 'win32').ok).toBe(true)
    expect(checkHostManifest(manifest('host.exe'), 'com.x.host', 'abc', 'win32').ok).toBe(false)
    expect(checkHostManifest(manifest('/usr/bin/host'), 'com.x.host', 'abc', 'win32').ok).toBe(false)
  })
})

describe('shortcuts', () => {
  it('leave every default shortcut of macOS untouched', () => {
    for (const command of COMMANDS) {
      expect(defaultAcceleratorFor('darwin', command.id, command.accelerator), command.id).toBe(command.accelerator)
      expect(effectiveAccelerator(command.id, undefined, 'darwin'), command.id).toBe(effectiveAccelerator(command.id, undefined))
    }
  })

  it('do not propose a Ctrl+Alt shortcut where that is the AltGr key', () => {
    for (const [id, accelerator] of Object.entries(NON_MAC_DEFAULTS)) expect(usesCtrlAlt(accelerator, 'win32'), `${id} ${accelerator}`).toBe(false)
  })

  it('only rewrite commands that exist', () => {
    const known = new Set(COMMANDS.map((c) => c.id))
    for (const id of Object.keys(NON_MAC_DEFAULTS)) expect(known.has(id), id).toBe(true)
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`give no two commands the same default on ${platform}, with ⌘ read as Ctrl`, () => {
      const seen = new Map<string, string>()
      for (const command of COMMANDS) {
        const accelerator = defaultAcceleratorFor(platform, command.id, command.accelerator)
        if (!accelerator) continue
        expect(isValidAccelerator(accelerator), `${command.id} ${accelerator}`).toBe(true)
        const canonical = canonicalAccelerator(accelerator, platform)
        expect(canonical, `${command.id} ${accelerator}`).not.toBeNull()
        expect(seen.get(canonical!), `${command.id} and ${seen.get(canonical!)} are both ${canonical}`).toBeUndefined()
        seen.set(canonical!, command.id)
      }
    })

    it(`read the same key on ${platform} whether it is written Ctrl or CmdOrCtrl`, () => {
      expect(canonicalAccelerator('CmdOrCtrl+Shift+J', platform)).toBe('Ctrl+Shift+J')
      expect(canonicalAccelerator('Shift+CmdOrCtrl+J', platform)).toBe(canonicalAccelerator('Ctrl+Shift+J', platform))
      expect(canonicalAccelerator('Ctrl+CmdOrCtrl+N', platform)).toBe('Ctrl+N')
      expect(canonicalAccelerator('Cmd+T', platform)).toBeNull()
    })
  }

  // What GNOME 46 binds by default, read in gsettings-desktop-schemas 46.0 (org.gnome.desktop.wm.keybindings, org.gnome.mutter.wayland) and in
  // the GNOME 46 user help « Useful keyboard shortcuts » / « Keyboard navigation ». Ubuntu 24.04 keeps them. Super shortcuts are left out: no Lucium
  // accelerator can name Super. The window manager takes these before the application sees them.
  const GNOME_46_RESERVED: readonly string[] = [
    // Workspaces: switch (Ctrl+Alt+arrows) and move the window along (with Shift).
    ...['Left', 'Right', 'Up', 'Down'].flatMap((arrow) => [`Ctrl+Alt+${arrow}`, `Ctrl+Alt+Shift+${arrow}`]),
    'Ctrl+Alt+Tab', 'Ctrl+Alt+Shift+Tab', 'Ctrl+Alt+Escape', 'Ctrl+Alt+Shift+Escape', 'Ctrl+Alt+Delete', 'Ctrl+Alt+Shift+R',
    ...Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+F${i + 1}`),
    'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Escape', 'Alt+Shift+Escape', 'Alt+Space', 'Alt+F2', 'Alt+F4', 'Alt+F5', 'Alt+F6', 'Alt+Shift+F6', 'Alt+F7', 'Alt+F8', 'Alt+F10'
  ]

  it('gives no default on Linux to a shortcut GNOME 46 reserves, which the application would never receive', () => {
    const reserved = new Set(GNOME_46_RESERVED.map((accelerator) => canonicalAccelerator(accelerator, 'linux')))
    const taken = COMMANDS.flatMap((command) => {
      const accelerator = defaultAcceleratorFor('linux', command.id, command.accelerator)
      return accelerator && reserved.has(canonicalAccelerator(accelerator, 'linux')) ? [`${command.id} ${accelerator}`] : []
    })
    expect(taken).toEqual([])
  })

  it('has a witness: the macOS defaults of tabs and spaces are the keys GNOME 46 takes', () => {
    const reserved = new Set(GNOME_46_RESERVED.map((accelerator) => canonicalAccelerator(accelerator, 'linux')))
    const clashing = ['nextSpace', 'previousSpace', 'nextTab', 'previousTab', 'moveTabUp', 'moveTabDown'].filter((id) => reserved.has(canonicalAccelerator(COMMANDS.find((c) => c.id === id)!.accelerator, 'linux')!))
    expect(clashing).toEqual(['nextSpace', 'previousSpace', 'nextTab', 'previousTab', 'moveTabUp', 'moveTabDown'])
  })

  it('moves the tabs with the keys of the other browsers on Linux, and the spaces with Alt and the same keys', () => {
    expect(effectiveAccelerator('nextTab', undefined, 'linux')).toBe('CmdOrCtrl+PageDown')
    expect(effectiveAccelerator('previousTab', undefined, 'linux')).toBe('CmdOrCtrl+PageUp')
    expect(effectiveAccelerator('moveTabDown', undefined, 'linux')).toBe('CmdOrCtrl+Shift+PageDown')
    expect(effectiveAccelerator('moveTabUp', undefined, 'linux')).toBe('CmdOrCtrl+Shift+PageUp')
    expect(effectiveAccelerator('nextSpace', undefined, 'linux')).toBe('Alt+PageDown')
    expect(effectiveAccelerator('previousSpace', undefined, 'linux')).toBe('Alt+PageUp')
    for (const [id, accelerator] of Object.entries(LINUX_DEFAULTS)) expect(isValidAccelerator(accelerator), `${id} ${accelerator}`).toBe(true)
  })

  it('leaves the macOS defaults of tabs and spaces alone', () => {
    expect(effectiveAccelerator('nextTab', undefined, 'darwin')).toBe('CmdOrCtrl+Alt+Down')
    expect(effectiveAccelerator('previousSpace', undefined, 'darwin')).toBe('CmdOrCtrl+Alt+Left')
    expect(effectiveAccelerator('moveTabUp', undefined, 'darwin')).toBe('CmdOrCtrl+Alt+Shift+Up')
    expect(Object.keys(LINUX_DEFAULTS).filter((id) => !COMMANDS.some((c) => c.id === id))).toEqual([])
  })

  // The key of an accelerator as a person types it: a letter, a digit or a punctuation mark, which AltGr turns into a character on many layouts.
  const typesACharacter = (accelerator: string): boolean => /^[A-Za-z0-9;,./=\-[\]`']$/.test(accelerator.split('+').at(-1)!)
  /** Ctrl+Alt without Shift on a key that types: where Ctrl+Alt is AltGr, the press types a character instead of running the command. */
  const bareAltGrPress = (accelerator: string): boolean => usesCtrlAlt(accelerator, 'win32') && !canonicalAccelerator(accelerator, 'win32')!.split('+').includes('Shift') && typesACharacter(accelerator)

  it('gives no default on Windows that AltGr would type: Ctrl+Alt with no Shift on a letter or a digit', () => {
    const typed = COMMANDS.flatMap((command) => {
      const accelerator = defaultAcceleratorFor('win32', command.id, command.accelerator)
      return accelerator && bareAltGrPress(accelerator) ? [`${command.id} ${accelerator}`] : []
    })
    expect(typed).toEqual([])
  })

  it('has a witness: the macOS defaults of 9 commands are such a press, which is what Windows replaces', () => {
    const typed = COMMANDS.filter((command) => command.accelerator && bareAltGrPress(command.accelerator)).map((command) => command.id)
    expect(typed.sort()).toEqual(['archive', 'captureVisible', 'devTools', 'findReplace', 'inspectElement', 'jsConsole', 'newLittleArc', 'newNote', 'viewSource'].sort())
  })

  it('adds Shift to the Ctrl+Alt+letter shortcuts on Windows, and leaves macOS and Linux with Ctrl+Alt', () => {
    expect(effectiveAccelerator('newLittleArc', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+N')
    expect(effectiveAccelerator('findReplace', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+F')
    expect(effectiveAccelerator('viewSource', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+U')
    expect(effectiveAccelerator('devTools', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+I')
    expect(effectiveAccelerator('jsConsole', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+J')
    expect(effectiveAccelerator('archive', undefined, 'win32')).toBe('CmdOrCtrl+Alt+Shift+A')
    for (const platform of ['darwin', 'linux'] as const) {
      expect(effectiveAccelerator('newLittleArc', undefined, platform), platform).toBe('CmdOrCtrl+Alt+N')
      expect(effectiveAccelerator('devTools', undefined, platform), platform).toBe('CmdOrCtrl+Alt+I')
      expect(effectiveAccelerator('archive', undefined, platform), platform).toBe('CmdOrCtrl+Alt+A')
    }
  })

  it('leaves the shortcuts that already carry Shift, and the arrows, as they were on Windows', () => {
    for (const id of ['captureFull', 'copyUrlMarkdown', 'clearSiteDataNow', 'nextTab', 'previousTab', 'nextSpace', 'previousSpace', 'moveTabUp', 'moveTabDown']) {
      expect(effectiveAccelerator(id, undefined, 'win32'), id).toBe(COMMANDS.find((c) => c.id === id)!.accelerator)
    }
  })

  it('gives no default on Windows to the two commands whose Ctrl+Shift+Alt press another command already holds', () => {
    // Capture the visible part (S) and Inspect (C) would become Ctrl+Shift+Alt+S and +C, which Capture the whole page and Copy as Markdown keep.
    expect(effectiveAccelerator('captureVisible', undefined, 'win32')).toBeUndefined()
    expect(effectiveAccelerator('inspectElement', undefined, 'win32')).toBeUndefined()
    expect(canonicalAccelerator(effectiveAccelerator('captureFull', undefined, 'win32')!, 'win32')).toBe('Alt+Ctrl+Shift+S')
    expect(canonicalAccelerator(effectiveAccelerator('copyUrlMarkdown', undefined, 'win32')!, 'win32')).toBe('Alt+Ctrl+Shift+C')
    expect(Object.entries(WINDOWS_DEFAULTS).filter(([, accelerator]) => accelerator === '').map(([id]) => id)).toEqual(['captureVisible', 'inspectElement'])
  })

  it('only rewrites commands that exist on Windows, and keeps a choice of the user over them', () => {
    expect(Object.keys(WINDOWS_DEFAULTS).filter((id) => !COMMANDS.some((c) => c.id === id))).toEqual([])
    expect(effectiveAccelerator('newLittleArc', { newLittleArc: 'CmdOrCtrl+Alt+N' }, 'win32')).toBe('CmdOrCtrl+Alt+N')
    expect(effectiveAccelerator('captureVisible', { captureVisible: 'CmdOrCtrl+Shift+Alt+V' }, 'win32')).toBe('CmdOrCtrl+Shift+Alt+V')
  })

  it('lets a choice of the user win over the Linux defaults', () => {
    expect(effectiveAccelerator('nextTab', { nextTab: 'CmdOrCtrl+Alt+Down' }, 'linux')).toBe('CmdOrCtrl+Alt+Down')
    expect(effectiveAccelerator('nextTab', { nextTab: '' }, 'linux')).toBeUndefined()
  })

  it('shows the defaults of macOS for what the other systems did not change, and F11 for the full screen', () => {
    expect(effectiveAccelerator('newTab', undefined, 'win32')).toBe('CmdOrCtrl+T')
    expect(effectiveAccelerator('fullscreen', undefined, 'win32')).toBe('F11')
    expect(effectiveAccelerator('fullscreen', undefined, 'darwin')).toBe('Ctrl+CmdOrCtrl+F')
    expect(effectiveAccelerator('blankWindow', undefined, 'linux')).toBeUndefined()
    expect(effectiveAccelerator('space3', undefined, 'linux')).toBe('Alt+3')
    expect(effectiveAccelerator('space3', undefined)).toBe('Ctrl+3')
  })

  it('lets a choice of the user win over any default', () => {
    expect(effectiveAccelerator('fullscreen', { fullscreen: 'CmdOrCtrl+Shift+F' }, 'win32')).toBe('CmdOrCtrl+Shift+F')
    expect(effectiveAccelerator('fullscreen', { fullscreen: '' }, 'win32')).toBeUndefined()
  })

  it('writes a shortcut with the symbols of macOS, and with words elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    expect(formatAccelerator('Ctrl+Alt+Left', 'darwin')).toBe('⌃⌥←')
    expect(formatAcceleratorFor('CmdOrCtrl+Shift+J', 'win32')).toBe('Ctrl+Maj+J')
    expect(formatAccelerator('CmdOrCtrl+Alt+Left', 'linux')).toBe('Ctrl+Alt+←')
    expect(formatAccelerator('F11', 'win32')).toBe('F11')
    expect(formatAccelerator('CmdOrCtrl+Backspace', 'win32')).toBe('Ctrl+Retour arrière')
    expect(formatAcceleratorFor('Shift+Delete', 'win32')).toBe('Maj+Suppr')
    expect(formatAcceleratorFor('Ctrl+Space', 'linux')).toBe('Ctrl+Espace')
    expect(formatAcceleratorFor('CmdOrCtrl+PageDown', 'linux')).toBe('Ctrl+Page suiv.')
    expect(formatAcceleratorFor('CmdOrCtrl+Shift+PageUp', 'linux')).toBe('Ctrl+Maj+Page préc.')
    expect(formatAcceleratorFor('Alt+PageDown', 'win32')).toBe('Alt+Page suiv.')
    expect(formatAcceleratorFor('CmdOrCtrl+PageDown', 'darwin')).toBe('⌘⇟')
  })

  it('names the keys in words of the language of the interface elsewhere than on macOS', () => {
    try {
      setLanguage('en')
      expect(formatAcceleratorFor('CmdOrCtrl+Shift+J', 'win32')).toBe('Ctrl+Shift+J')
      expect(formatAcceleratorFor('Shift+Delete', 'win32')).toBe('Shift+Del')
      expect(formatAcceleratorFor('Ctrl+Space', 'linux')).toBe('Ctrl+Space')
      expect(formatAcceleratorFor('CmdOrCtrl+PageDown', 'linux')).toBe('Ctrl+Page Down')
      expect(formatAcceleratorFor('Alt+PageUp', 'linux')).toBe('Alt+Page Up')
      expect(formatAcceleratorFor('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    } finally {
      setLanguage('fr')
    }
  })

  it('records a key press as the shortcut of the system: Ctrl is the command key there, the Windows key is nothing', () => {
    const press = (over: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>) => ({ code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })
    expect(acceleratorFromKeyEvent(press({ metaKey: true, shiftKey: true }))).toBe('CmdOrCtrl+Shift+J')
    expect(acceleratorFromKeyEvent(press({ ctrlKey: true }))).toBe('Ctrl+J')
    expect(acceleratorFromKeyEvent(press({ ctrlKey: true, shiftKey: true }), 'win32')).toBe('CmdOrCtrl+Shift+J')
    expect(acceleratorFromKeyEvent(press({ ctrlKey: true, altKey: true }), 'linux')).toBe('CmdOrCtrl+Alt+J')
    expect(acceleratorFromKeyEvent(press({ metaKey: true }), 'win32')).toBeNull()
    expect(acceleratorFromKeyEvent(press({ metaKey: true, ctrlKey: true }), 'linux')).toBeNull()
    expect(acceleratorFromKeyEvent(press({}), 'win32')).toBeNull()
    expect(acceleratorFromKeyEvent({ ...press({ ctrlKey: true }), code: 'PageDown' }, 'linux')).toBe('CmdOrCtrl+PageDown')
    expect(acceleratorFromKeyEvent({ ...press({ altKey: true }), code: 'PageUp' }, 'linux')).toBe('Alt+PageUp')
  })

  it('flags the Ctrl+Alt shortcuts only where Ctrl+Alt is the AltGr key (Windows)', () => {
    expect(usesCtrlAlt('CmdOrCtrl+Alt+N', 'win32')).toBe(true)
    expect(usesCtrlAlt('Ctrl+Alt+Right', 'win32')).toBe(true)
    expect(usesCtrlAlt('CmdOrCtrl+Alt+N', 'linux')).toBe(false)
    expect(usesCtrlAlt('CmdOrCtrl+Alt+N', 'darwin')).toBe(false)
    expect(usesCtrlAlt('CmdOrCtrl+Shift+N', 'win32')).toBe(false)
    expect(usesCtrlAlt('Alt+3', 'win32')).toBe(false)
  })
})
