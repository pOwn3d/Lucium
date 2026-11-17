// What differs from one operating system to another, as data and pure functions (docs/plateformes.md). Lucium was written and measured
// on macOS only; this file is where the other two systems are prepared WITHOUT being tested (no Windows or Linux machine was available):
// every rule below that is not about macOS is an assumption written down so that a test can hold it, not a measurement.
//
// Nothing here reads the real platform: callers hand the platform in (the main process reads `process.platform` once, in
// main/platform/index.ts), so a test can play any system on any machine. A function called without a platform behaves as on macOS.
// Importable by the interface as well as the main process: no Node and no Electron types.

import { AUTOMATION_SCHEME } from './automation-url'
import { DISK_ACCESS_SETTINGS_URL } from './import-sources'
import { t } from './i18n'

export type PlatformId = 'darwin' | 'win32' | 'linux'

export const PLATFORM_IDS: readonly PlatformId[] = ['darwin', 'win32', 'linux']

/** The platform a `process.platform` value stands for: macOS and Windows are themselves, every other Unix is treated as Linux (X11, freedesktop). */
export function platformOf(value: unknown): PlatformId {
  return value === 'darwin' || value === 'win32' ? value : 'linux'
}

/** What a system offers. `true` means "the code path exists and was written for it", which for Windows and Linux is not "was tried". */
export interface PlatformFacts {
  /** Close, minimise and zoom buttons drawn by the system over a window whose title bar is hidden, placed by the application. */
  trafficLights: boolean
  /** The translucent material behind a window (`BrowserWindow.setVibrancy`). */
  vibrancy: boolean
  /** The Dock (`app.dock`): its icon can be changed. */
  dock: boolean
  /** Fingerprint unlock through the system (`systemPreferences.promptTouchID`). */
  touchId: boolean
  /** One menu bar for the whole application, outside the windows (the app menu, Services, Hide). Elsewhere each window carries its own bar. */
  globalMenuBar: boolean
  /** "Open with…" hands a file to an application bundle (`open -a`). */
  openWithBundle: boolean
  /** Links into the system settings (`x-apple.systempreferences:`). */
  settingsLinks: boolean
  /** The system share sheet (`role: 'shareMenu'`). */
  shareSheet: boolean
  /** Links from other applications arrive as an `open-url` event, before the window exists. Elsewhere they are in the command line. */
  openUrlEvent: boolean
  /** The system asks before an application may record the screen (`systemPreferences.getMediaAccessStatus('screen')`). */
  screenRecordingPermission: boolean
  /** The browsers whose data this system can import, besides the file-based ones. */
  importSafari: boolean
  importArc: boolean
  /** Where the charge of the battery can be read from: `pmset` (macOS), `/sys/class/power_supply` (Linux), nowhere known (Windows). */
  batteryPercent: 'pmset' | 'sysfs' | 'none'
  /** Ctrl+Alt is the AltGr key of many layouts (French, German, Spanish…): a Ctrl+Alt+letter shortcut fires while a character is typed. */
  ctrlAltIsAltGr: boolean
  /** The key that carries the shortcuts: ⌘ on macOS, Ctrl elsewhere. */
  commandKey: 'meta' | 'control'
  /** Native messaging hosts are found by manifests in folders (macOS, Linux) or by registry keys (Windows). */
  nativeHosts: 'folders' | 'registry'
  /** The separator of a list of paths in an environment variable. */
  pathDelimiter: ':' | ';'
  /** The spell checker is the system's own. Elsewhere Chromium downloads its dictionaries from its CDN (Google's) the first time it checks. */
  systemSpellChecker: boolean
}

export const PLATFORM_FACTS: Readonly<Record<PlatformId, PlatformFacts>> = {
  darwin: {
    trafficLights: true,
    vibrancy: true,
    dock: true,
    touchId: true,
    globalMenuBar: true,
    openWithBundle: true,
    settingsLinks: true,
    shareSheet: true,
    openUrlEvent: true,
    screenRecordingPermission: true,
    importSafari: true,
    importArc: true,
    batteryPercent: 'pmset',
    ctrlAltIsAltGr: false,
    commandKey: 'meta',
    nativeHosts: 'folders',
    pathDelimiter: ':',
    systemSpellChecker: true
  },
  win32: {
    trafficLights: false,
    vibrancy: false,
    dock: false,
    touchId: false,
    globalMenuBar: false,
    openWithBundle: false,
    settingsLinks: false,
    shareSheet: false,
    openUrlEvent: false,
    screenRecordingPermission: false,
    importSafari: false,
    // Where the data to import lives on Windows is not known here (and nobody may look at a user's installation to find out): the import is not offered.
    importArc: false,
    batteryPercent: 'none',
    ctrlAltIsAltGr: true,
    commandKey: 'control',
    nativeHosts: 'registry',
    pathDelimiter: ';',
    systemSpellChecker: false
  },
  linux: {
    trafficLights: false,
    vibrancy: false,
    dock: false,
    touchId: false,
    globalMenuBar: false,
    openWithBundle: false,
    settingsLinks: false,
    shareSheet: false,
    openUrlEvent: false,
    screenRecordingPermission: false,
    importSafari: false,
    importArc: false,
    batteryPercent: 'sysfs',
    ctrlAltIsAltGr: false,
    commandKey: 'control',
    nativeHosts: 'folders',
    pathDelimiter: ':',
    systemSpellChecker: false
  }
}

// ---- words ----

/** "Show in the Finder" under another name: what shows a file in its folder is not called the same on each system. */
export function revealLabel(platform: PlatformId = 'darwin'): string {
  return platform === 'darwin' ? t('panels.afficher-dans-le-finder') : platform === 'win32' ? t('platform.afficher-dans-l-explorateur-de-fichiers') : t('platform.afficher-dans-le-dossier')
}

/**
 * The pane Language & Region of macOS, whose button « Langues de traduction… » installs the languages of the system's translation. The pane has no
 * documented anchor for that sheet: the address opens the pane (its extension, com.apple.Localization-Settings.extension, declares
 * `allowsXAppleSystemPreferencesURLScheme`), the person clicks the button.
 */
export const TRANSLATION_LANGUAGES_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Localization-Settings.extension'

export type SettingsPane = 'disk-access' | 'translation-languages'

/** The address of the pane of the system settings the application sends the user to, or null when this system has no such link. */
export function settingsLink(pane: SettingsPane, platform: PlatformId = 'darwin'): string | null {
  if (!PLATFORM_FACTS[platform].settingsLinks) return null
  if (pane === 'translation-languages') return TRANSLATION_LANGUAGES_SETTINGS_URL
  return DISK_ACCESS_SETTINGS_URL
}

// ---- paths and command lines ----

/** The entries of an environment variable holding a list of paths (`LUCIUM_EXTENSIONS`): Windows paths contain a colon, so they are separated by a semicolon. */
export function splitPathList(value: string, platform: PlatformId = 'darwin'): string[] {
  return value.split(PLATFORM_FACTS[platform].pathDelimiter).filter(Boolean)
}

/** Whether a path from a file (the manifest of a native messaging host) is absolute on this system. */
export function isAbsolutePath(path: string, platform: PlatformId = 'darwin'): boolean {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(path)
  return path.startsWith('/')
}

/**
 * The web addresses in a command line, and the commands by address (`lucium://open?url=…`, shared/automation-url.ts), which reach the application the
 * way a link does. Elsewhere than macOS, a link another application opens arrives there (a first launch, or the second instance that hands it over);
 * macOS delivers it through an event instead.
 */
export function linksFromArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => /^https?:\/\//i.test(arg) || arg.slice(0, AUTOMATION_SCHEME.length + 2).toLowerCase() === `${AUTOMATION_SCHEME}//`)
}

// ---- shortcuts ----

/**
 * What the default shortcut of a command becomes where the Command key does not exist (Ctrl is the command key there). On macOS the defaults
 * stand and nothing changes. The commands below have a macOS shortcut that, with ⌘ read as Ctrl, falls on another command's shortcut or on
 * the AltGr key; '' means "no default, the user can give one" (the rule for every command without a default shortcut). These are proposals,
 * not keys measured on Windows or Linux: `platform.test.ts` holds the one thing that can be checked here, that no two commands collide.
 */
export const NON_MAC_DEFAULTS: Readonly<Record<string, string>> = {
  // ⌃⌘N, ⇧⌃⌘C, ⌃⌘F and ⌃⌘S read Ctrl+Ctrl+…: the same as New window, Copy URL, Find and the sidebar shown or hidden.
  blankWindow: '',
  copyUrlQuote: '',
  dockSidebar: '',
  fullscreen: 'F11',
  // ⌃1…⌃9 (spaces) and ⌘1…⌘9 (items) are both Ctrl+1…9 once ⌘ is Ctrl: the items keep Ctrl (the browser habit), the spaces take Alt.
  space1: 'Alt+1',
  space2: 'Alt+2',
  space3: 'Alt+3',
  space4: 'Alt+4',
  space5: 'Alt+5',
  space6: 'Alt+6',
  space7: 'Alt+7',
  space8: 'Alt+8',
  space9: 'Alt+9',
  // ⌃D (developer mode) is Ctrl+D, the same as ⌘D (pin).
  developerMode: '',
  // ⌃⇧= and ⌃⇧- are Ctrl+Shift+= and Ctrl+Shift+-, which Chromium reads as zoom in and zoom out.
  addSplit: '',
  closeSplitPane: '',
  // ⌥⌘E (Nouvelle note) is Ctrl+Alt+E, AltGr+E: the € of most European layouts would open a note.
  newNote: ''
}

/**
 * What the default shortcut of a command becomes on Linux, over `NON_MAC_DEFAULTS`. GNOME (Ubuntu's desktop) binds Ctrl+Alt+arrows to the
 * workspaces and Ctrl+Alt+Shift+arrows to « move the window to the workspace »: the window manager takes them before the application, so
 * the six shortcuts that went from tab to tab, from space to space and moved a tab (⌥⌘ and ⌥⇧⌘ arrows on macOS) never arrived (trial of
 * 17 November 2026, docs/plateformes.md §8). GNOME 46 itself binds Super+Page Up and Super+Page Down for the workspaces, and nothing with Ctrl
 * and the Page keys, nor with Alt and the Page keys (gsettings-desktop-schemas 46.0; `platform.test.ts` holds the list).
 *  - Tabs: Ctrl+Page Down / Ctrl+Page Up are the keys every browser has for the next and previous tab. Ctrl+Shift with them moves the tab, as in
 *    Chrome and Firefox; the tabs are a list down the sidebar, so « down » is the tab after.
 *  - Spaces: Alt is already what picks a space off macOS (Alt+1…9, above), so Alt+Page Down / Alt+Page Up go to the next and previous one. Not
 *    Alt+arrows: those are Back and Forward in the browsers.
 * Windows keeps the macOS shortcuts for these six: its Ctrl+Alt question (the AltGr key) is open, docs/plateformes.md §9.
 */
export const LINUX_DEFAULTS: Readonly<Record<string, string>> = {
  nextTab: 'CmdOrCtrl+PageDown',
  previousTab: 'CmdOrCtrl+PageUp',
  moveTabDown: 'CmdOrCtrl+Shift+PageDown',
  moveTabUp: 'CmdOrCtrl+Shift+PageUp',
  nextSpace: 'Alt+PageDown',
  previousSpace: 'Alt+PageUp'
}

/** The default shortcut of a command on this system, given the macOS one (`standard`, '' for none). */
export function defaultAcceleratorFor(platform: PlatformId, commandId: string, standard: string): string {
  if (platform === 'darwin') return standard
  if (platform === 'linux' && Object.hasOwn(LINUX_DEFAULTS, commandId)) return LINUX_DEFAULTS[commandId]!
  return Object.hasOwn(NON_MAC_DEFAULTS, commandId) ? NON_MAC_DEFAULTS[commandId]! : standard
}

/**
 * The accelerator in one spelling per meaning: where the Command key does not exist `CmdOrCtrl` is `Ctrl`, so a key pressed (which reads
 * Ctrl) and a default (which reads CmdOrCtrl) can be compared. Modifiers come out sorted, the key last. `Cmd` alone is not an accelerator there:
 * null.
 */
export function canonicalAccelerator(accelerator: string, platform: PlatformId = 'darwin'): string | null {
  const parts = accelerator.split('+')
  const key = parts.at(-1)
  if (!key) return null
  const modifiers: string[] = []
  for (const part of parts.slice(0, -1)) {
    if (part === 'CmdOrCtrl') modifiers.push(platform === 'darwin' ? 'Cmd' : 'Ctrl')
    else if (part === 'Cmd' && platform !== 'darwin') return null
    else modifiers.push(part)
  }
  return [...new Set(modifiers)].sort().concat(key).join('+')
}

/** The shortcut as the interface shows it: ⇧⌘J on macOS, "Ctrl+Maj+J" elsewhere in French (the Shift key of a French keyboard is "Maj"), "Ctrl+Shift+J" in English. */
export function formatAcceleratorFor(accelerator: string, platform: PlatformId): string {
  const parts = accelerator.split('+')
  const key = parts.at(-1)!
  const has = (m: string) => parts.includes(m)
  const arrows: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' }
  if (platform === 'darwin') {
    const symbols = `${has('Ctrl') ? '⌃' : ''}${has('Alt') ? '⌥' : ''}${has('Shift') ? '⇧' : ''}${has('CmdOrCtrl') || has('Cmd') ? '⌘' : ''}`
    const shown: Record<string, string> = { ...arrows, Return: '↩', Backspace: '⌫', Delete: '⌦', Space: '␣', Tab: '⇥', PageUp: '⇞', PageDown: '⇟', Plus: '+' }
    return symbols + (shown[key] ?? key)
  }
  const words = [has('Ctrl') || has('CmdOrCtrl') ? 'Ctrl' : '', has('Alt') ? 'Alt' : '', has('Shift') ? t('platform.maj') : '']
  const shown: Record<string, string> = { ...arrows, Return: t('platform.entree'), Backspace: t('platform.retour-arriere'), Delete: t('platform.suppr'), Space: t('platform.espace'), PageUp: t('platform.page-prec'), PageDown: t('platform.page-suiv'), Plus: '+' }
  return [...words.filter(Boolean), shown[key] ?? key].join('+')
}

/** Whether an accelerator holds Ctrl and Alt together: where that is AltGr, it fires while a character is being typed. */
export function usesCtrlAlt(accelerator: string, platform: PlatformId): boolean {
  if (!PLATFORM_FACTS[platform].ctrlAltIsAltGr) return false
  const canonical = canonicalAccelerator(accelerator, platform)
  if (canonical === null) return false
  const parts = canonical.split('+')
  return parts.includes('Alt') && parts.includes('Ctrl')
}
