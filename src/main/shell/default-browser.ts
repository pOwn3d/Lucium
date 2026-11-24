// "Is Lucium the default browser" and "make it so", for each system. No Electron here: the main process hands in the calls (ports), a test hands in others.
// macOS and Linux take the request (`app.setAsDefaultProtocolClient`) and answer from the same API. Windows 10 and 11 do neither: the choice is the user's,
// recorded under `UserChoice`, so Lucium reads that key and sends the user to Settings (shared/default-browser.ts says why).

import { win32 } from 'node:path'
import {
  WEB_SCHEMES,
  WINDOWS_DEFAULT_APPS_URL,
  parseUserChoiceProgId,
  schemesToRegister,
  userChoiceKeys,
  windowsChoiceIsLucium,
  type DefaultBrowserOutcome
} from '@shared/default-browser'
import { t } from '@shared/i18n'
import type { PlatformId } from '@shared/platform'

/** The desktop entry the .deb installs (`/usr/share/applications/lucium.desktop`): what `xdg-settings` names once Lucium is the browser. */
const LINUX_DESKTOP_ENTRY = 'lucium.desktop'

export interface DefaultBrowserPorts {
  platform: PlatformId
  /** The packaged application: a development copy of Electron never takes the web links (shared/default-browser.ts). */
  built: boolean
  /** `app.isDefaultProtocolClient`. */
  isClient(scheme: string): boolean
  /** `app.setAsDefaultProtocolClient`. */
  setClient(scheme: string): boolean
  /** What `reg query <key> /v ProgId` printed, null when the key does not exist; rejects when the program could not be run. */
  queryRegistry(key: string): Promise<string | null>
  /** Linux: what `xdg-settings get default-web-browser` printed (a desktop entry, `lucium.desktop`), null when it printed nothing; rejects when the program could not be run. */
  linuxWebBrowser(): Promise<string | null>
  /** `shell.openExternal`. */
  openSettings(url: string): Promise<void>
}

/** How a program is run: `child_process.execFile`, as far as this file needs it. */
export type RunProgram = (file: string, args: string[], done: (error: (Error & { code?: unknown }) | null, stdout: string) => void) => void

/** The reader of the registry the main process hands in: `reg.exe` of the system folder, no shell, no console window. */
export function registryReader(run: RunProgram, systemRoot: string = 'C:\\Windows'): (key: string) => Promise<string | null> {
  const reg = win32.join(systemRoot, 'System32', 'reg.exe')
  return (key) =>
    new Promise((resolve, reject) => {
      run(reg, ['query', key, '/v', 'ProgId'], (error, stdout) => {
        // reg.exe exits with 1 when the key or the value is missing: a user who never chose a browser has no UserChoice, which is an answer, not a failure.
        if (error?.code === 1) return resolve(null)
        if (error) return reject(error)
        resolve(stdout)
      })
    })
}

/**
 * Whether Lucium is the default browser of the system: yes, no, or `null` when the system gave no answer to trust (the Settings say so instead of claiming a yes or a no).
 * Windows: what Windows holds for http and https, read from the registry. Linux: Electron's answer, confirmed by the desktop entry `xdg-settings` names, since
 * Electron's own check can say yes from a state the desktop does not follow (reported on the .deb of Ubuntu 24.04, 23 November 2026; not reproduced here).
 */
export async function isDefaultBrowser(ports: DefaultBrowserPorts): Promise<boolean | null> {
  if (ports.platform === 'linux') {
    if (!WEB_SCHEMES.every((scheme) => ports.isClient(scheme))) return false
    try {
      const entry = await ports.linuxWebBrowser()
      return entry === null ? null : entry.trim().toLowerCase() === LINUX_DESKTOP_ENTRY
    } catch (error) {
      console.warn('[default-browser] cannot read the default browser of the desktop:', error instanceof Error ? error.message : String(error))
      return null
    }
  }
  if (ports.platform !== 'win32') return WEB_SCHEMES.every((scheme) => ports.isClient(scheme))
  const progIds: Record<string, string | null> = {}
  for (const scheme of WEB_SCHEMES) {
    try {
      // The first key that holds a ProgID decides: UserChoiceLatest (recent Windows 11), else UserChoice, which Windows then no longer updates.
      progIds[scheme] = null
      for (const key of userChoiceKeys(scheme)) {
        const printed = await ports.queryRegistry(key)
        progIds[scheme] = printed === null ? null : parseUserChoiceProgId(printed)
        if (progIds[scheme] !== null) break
      }
    } catch (error) {
      // Not knowing is neither a yes nor a no: the window says it could not tell, and still offers the button, which only opens Settings.
      console.warn(`[default-browser] cannot read the choice Windows holds for ${scheme}:`, error instanceof Error ? error.message : String(error))
      return null
    }
  }
  return windowsChoiceIsLucium(progIds)
}

/**
 * The same, for the menu, which is built without waiting: Windows and Linux cannot be read at once (the registry, `xdg-settings`), so the entry is never dimmed
 * there (it only opens Settings, or registers again, whatever the state).
 */
export function isDefaultBrowserNow(ports: DefaultBrowserPorts): boolean {
  return ports.platform === 'win32' || ports.platform === 'linux' ? false : WEB_SCHEMES.every((scheme) => ports.isClient(scheme))
}

/** Asks the system to make Lucium the default browser. Windows: opens Settings on Lucium (an application cannot choose for the user there). */
export async function makeDefaultBrowser(ports: DefaultBrowserPorts): Promise<DefaultBrowserOutcome> {
  if (ports.platform === 'win32') {
    // A development copy of Electron is not registered with Windows: there is no Lucium entry to show.
    if (!ports.built) return 'failed'
    try {
      await ports.openSettings(WINDOWS_DEFAULT_APPS_URL)
      return 'system-settings'
    } catch (error) {
      console.warn('[default-browser] cannot open the default apps of Windows:', error instanceof Error ? error.message : String(error))
      return 'failed'
    }
  }
  // A development copy of Electron never registers (shared/default-browser.ts): the answer is "not done", which the window says.
  const schemes = schemesToRegister(ports.built)
  return schemes.length > 0 && schemes.map((scheme) => ports.setClient(scheme)).every(Boolean) ? 'done' : 'failed'
}

/** What the menu entry tells the user once the request is answered. */
export function defaultBrowserNotice(outcome: DefaultBrowserOutcome): { type: 'info' | 'warning'; message: string; detail: string } {
  if (outcome === 'system-settings') return { type: 'info', message: t('app.les-parametres-de-windows-sont-ouverts'), detail: t('app.choisissez-lucium-pour-http-et-https') }
  if (outcome === 'done') return { type: 'info', message: t('app.lucium-est-propose-comme-navigateur-par'), detail: t('app.macos-peut-demander-une-confirmation') }
  return { type: 'warning', message: t('app.impossible-de-s-enregistrer-comme-navigateur'), detail: t('app.ouvrez-l-application-installee-puis-reessayez') }
}
