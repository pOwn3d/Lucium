// "Ouvrir avec…" remembered per type of file, and the rule that decides what may be opened without being saved first.
// Everything that reaches this module comes from a page (the name and the MIME type of a download) or from a file on disk (the saved
// list), so each input is checked and none of it is ever run: a type that can execute is never opened by a remembered application
// or from the temporary folder, whatever the name says.

import { isRecord } from './state-clean'

/** The applications kept: one per type, and a type is an extension, so the list cannot grow past the extensions people meet. */
export const OPEN_WITH_MAX = 100
export const OPEN_WITH_PATH_MAX = 1024

/** The extension of a file name, lower case, when it is a plain run of letters and digits (what a page can make a name hold is hostile). */
export function fileTypeOf(filename: unknown): string | null {
  if (typeof filename !== 'string') return null
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return null
  const extension = filename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : null
}

/**
 * Types that can run code when opened (applications and installers, shell and script files, shortcuts, disk images that mount an
 * application, Java and Office files with macros). Opening one is a decision of the system and the user, never of a setting.
 */
export const EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
  'app', 'command', 'tool', 'action', 'workflow', 'service', 'terminal', 'pkg', 'mpkg', 'dmg', 'iso', 'jar', 'class',
  'sh', 'bash', 'zsh', 'csh', 'tcsh', 'ksh', 'fish', 'run', 'bin', 'out', 'elf', 'appimage',
  'scpt', 'scptd', 'applescript', 'osa', 'osax', 'js', 'jse', 'mjs', 'cjs', 'py', 'pyc', 'pyw', 'pl', 'rb', 'php', 'lua', 'swift', 'wsf', 'vbs', 'vbe', 'vb', 'ps1', 'psm1',
  'exe', 'msi', 'msp', 'mst', 'dll', 'scr', 'com', 'bat', 'cmd', 'pif', 'cpl', 'gadget', 'hta', 'reg', 'lnk', 'inf', 'sys', 'drv', 'ocx',
  'desktop', 'url', 'webloc', 'inetloc', 'fileloc', 'ftploc', 'mobileconfig', 'configprofile', 'xpi', 'crx', 'apk', 'ipa',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'ppam', 'xlam', 'xlsb',
  // Windows shortcuts, disk images that mount, a Java web launcher, and what changes the system's trust or provisioning when opened (certificates, keys, profiles).
  'shortcut', 'sparseimage', 'sparsebundle', 'cdr', 'jnlp', 'cer', 'p12', 'pfx', 'mobileprovision',
  // macOS: what mounts a network volume or connects to a server when opened, what installs code into the system or an application (panes, screen
  // savers, plug-ins, Quick Look and Spotlight importers), a saved page that Safari opens with the scripts and the origin of the site it names,
  // signed archives and other images that expand or mount, and loadable code.
  'afploc', 'nfsloc', 'smbloc', 'vncloc', 'mailloc', 'prefpane', 'saver', 'qlgenerator', 'mdimporter', 'plugin', 'bundle', 'component', 'colorpicker', 'wdgt', 'kext', 'appex', 'xpc',
  'webarchive', 'safariextz', 'xip', 'img', 'toast', 'vhd', 'vhdx', 'dylib', 'so', 'framework', 'jxa'
])

const EXECUTABLE_MIME = /^(?:application\/(?:x-(?:sh|csh|shellscript|executable|msdownload|msdos-program|apple-diskimage|mach-binary|java-archive|python-code|perl|ruby|php)|java-archive|vnd\.microsoft\.portable-executable|x-dosexec)|text\/x-(?:shellscript|python|perl|ruby|php))\b/i

/**
 * Whether a download must not be opened by an application of the user's remembering, nor straight from the temporary folder: a type
 * that can run, a server that says so (`application/x-sh`), and a name with no type at all (a program has none, and nothing says what
 * opens the rest).
 */
export function isExecutableDownload(filename: unknown, mimeType?: unknown): boolean {
  const type = fileTypeOf(filename)
  if (type === null || EXECUTABLE_TYPES.has(type)) return true
  return typeof mimeType === 'string' && EXECUTABLE_MIME.test(mimeType.trim())
}

/** A type worth keeping an application for: a plain extension that is not one of the executable ones. */
export const isRememberableType = (type: unknown): type is string => typeof type === 'string' && /^[a-z0-9]{1,12}$/.test(type) && !EXECUTABLE_TYPES.has(type)

/** An application a file is opened with: an absolute path to a bundle named `….app`, without a `..` step or a control character. */
export function isApplicationPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > OPEN_WITH_PATH_MAX) return false
  if (!path.startsWith('/') || /\p{Cc}/u.test(path)) return false
  if (path.split('/').some((part) => part === '..' || part === '.')) return false
  return /\/[^/]+\.app$/i.test(path)
}

/** The list of a file: types that may be remembered, each with an application path that is one; at most `OPEN_WITH_MAX`. */
export function cleanOpenWithApps(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(raw)) return out
  let count = 0
  for (const [type, app] of Object.entries(raw)) {
    if (count >= OPEN_WITH_MAX) break
    if (!isRememberableType(type) || !isApplicationPath(app)) continue
    out[type] = app
    count++
  }
  return out
}

/** "/Applications/Aperçu.app" → "Aperçu". */
export const applicationName = (path: string): string => path.replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '')

/** The list with a type given an application; the list as it was when the type or the application is not acceptable or the list is full. */
export function rememberApplication(list: Readonly<Record<string, string>>, type: string | null, app: unknown): Record<string, string> {
  if (!isRememberableType(type) || !isApplicationPath(app)) return { ...list }
  if (!Object.hasOwn(list, type) && Object.keys(list).length >= OPEN_WITH_MAX) return { ...list }
  return { ...list, [type]: app }
}

/**
 * Whether `next` is a list the interface may ask for: the saved list with some entries taken away. The interface can forget an
 * application, never name one (a path typed in a page of the interface would make the application start a program of its choice):
 * choosing goes through the system dialog of the main process.
 */
export function mayOnlyForget(current: Readonly<Record<string, string>>, next: unknown): boolean {
  if (!isRecord(next) || Object.hasOwn(next, '__proto__')) return false
  return Object.entries(next).every(([type, app]) => Object.hasOwn(current, type) && current[type] === app)
}

/** What "Ouvrir" does with a finished download. */
export type OpenPlan = { kind: 'system' } | { kind: 'application'; app: string }

/** The remembered application for this file, when the setting is on and the file may be handed to one; else the system's own way. */
export function openPlan(settings: { openWithMemory: boolean; openWithApps: Readonly<Record<string, string>> }, filename: string, mimeType?: string): OpenPlan {
  if (!settings.openWithMemory || isExecutableDownload(filename, mimeType)) return { kind: 'system' }
  const type = fileTypeOf(filename)
  const app = type !== null && Object.hasOwn(settings.openWithApps, type) ? settings.openWithApps[type] : undefined
  return isApplicationPath(app) ? { kind: 'application', app } : { kind: 'system' }
}
