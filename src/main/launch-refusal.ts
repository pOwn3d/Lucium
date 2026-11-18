// What a refused launch tells a person who cannot read a terminal (index.ts, runtime.ts `refusedSwitches`).
//
// The case this is for: an AppImage started from the file manager on Ubuntu 24.04 or later. The AppRun of the AppImage (electron-builder) tries
// `unshare -Ur true`; AppArmor restricts unprivileged user namespaces there (`kernel.apparmor_restrict_unprivileged_userns=1`), so the probe fails and the
// AppRun adds `--no-sandbox` to the command line, which keeps Chromium from complaining about its sandbox. Lucium's code then runs first, and refuses that
// switch: the sandbox is never switched off. The line it writes goes to the standard error, which nobody sees after a double-click; and Electron's
// `dialog.showErrorBox`, called before `ready`, writes to the standard error on Linux and opens no window (Electron 45 documentation). So the person saw
// only the system's « the application quit unexpectedly ».
//
// The answer is to wait for `ready` and show an ordinary box of the system. Nothing else is made: no window, no page, no session, no read of the profile.
// The process carries the switch the launcher gave it and does nothing but show the box and end; it never runs a page. A launch that is refused for any other
// reason, on any other system, or with no screen to draw on, ends at once as before.

import { readFileSync } from 'node:fs'
import { app, dialog, shell } from 'electron'
import { languageOfLocale, setLanguage, t, getLanguage } from '@shared/i18n'
import { downloadPageUrl } from '@shared/update-check'

/** What the kernel says about the restriction of user namespaces by AppArmor (`1`: restricted, which Ubuntu 23.10 and later do by default). */
export const RESTRICTION_FILE = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/** Why the sandbox cannot start: the AppArmor restriction of Ubuntu (a .deb carries the rule that lifts it), or any other reason (nothing a package can fix). */
export type SandboxCause = 'apparmor' | 'other'

/** The cause the content of `RESTRICTION_FILE` points to; a file that is missing (a system without AppArmor) or says anything but `1` is not this one. */
export const sandboxCause = (restriction: string | null): SandboxCause => (restriction?.trim() === '1' ? 'apparmor' : 'other')

export interface RefusalBox {
  title: string
  message: string
  detail: string
  buttons: [string, string]
}

/** Whether a refused launch has a box to show: on Linux, the refusal of `--no-sandbox` (what an AppImage's AppRun adds). Any other refusal ends with its line alone. */
export const hasRefusalBox = (refused: readonly string[], platform: string): boolean => platform === 'linux' && refused.includes('no-sandbox')

/** The box for a launch refused because the sandbox cannot start, in the language of the process. */
export function refusalBox(cause: SandboxCause): RefusalBox {
  const apparmor = cause === 'apparmor'
  return {
    title: t('engine.lucium-ne-peut-pas-demarrer'),
    message: t('launch-refusal.message'),
    detail: [t(apparmor ? 'launch-refusal.cause-apparmor' : 'launch-refusal.cause-autre'), t(apparmor ? 'launch-refusal.conseil-apparmor' : 'launch-refusal.conseil-autre')].join('\n\n'),
    buttons: [t('menu-actions.ouvrir-la-page-telecharger'), t('app-update.fermer')]
  }
}

/** How long to wait for Electron to be ready before giving up on the box: a launch must always end, never stay as a process with no window. */
export const READY_TIMEOUT_MS = 15_000

/** What ending a refused launch needs from the system; `endRefusedLaunch` is tested with stand-ins for each. */
export interface LaunchEnd {
  platform: string
  env: NodeJS.ProcessEnv
  /** The content of `RESTRICTION_FILE`, or null when it cannot be read. */
  readRestriction: () => string | null
  whenReady: () => Promise<unknown>
  /** The locale of the system, readable once Electron is ready. */
  locale: () => string
  /** Shows the box; resolves with the index of the button chosen. */
  showBox: (box: RefusalBox) => Promise<number>
  openPage: (url: string) => Promise<void>
  exit: (code: number) => void
  log: (line: string, error?: unknown) => void
  readyTimeoutMs?: number
}

/**
 * Ends a launch `refusedSwitches` refused, with exit code 1: at once, unless the person can be told on a screen, which is when the box is shown first and
 * the launch ends when it is closed. The line for the standard error was written before (index.ts). The second button opens the download page of the site, in
 * the browser of the system, where the .deb package is.
 */
export function endRefusedLaunch(refused: readonly string[], deps: LaunchEnd): void {
  const screenHere = Boolean(deps.env['DISPLAY'] || deps.env['WAYLAND_DISPLAY'])
  if (!screenHere || !hasRefusalBox(refused, deps.platform)) {
    deps.exit(1)
    return
  }
  const cause = sandboxCause(deps.readRestriction())
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    deps.exit(1)
  }
  const giveUp = setTimeout(() => {
    deps.log('[launch] Electron was not ready in time to show why the launch was refused: ending without the box')
    end()
  }, deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
  void deps
    .whenReady()
    .then(async () => {
      clearTimeout(giveUp)
      // The system's language: the profile is not read for a launch that is refused (the interface's own setting, French by default, lives in it).
      setLanguage(languageOfLocale(deps.locale()))
      const chosen = await deps.showBox(refusalBox(cause))
      if (chosen === 0) await deps.openPage(downloadPageUrl(getLanguage()))
    })
    .catch((error: unknown) => deps.log('[launch] the box that says why the launch was refused could not be shown:', error))
    .finally(() => {
      clearTimeout(giveUp)
      end()
    })
}

/** The content of `RESTRICTION_FILE`; null when there is none (no AppArmor: the usual case elsewhere than Ubuntu) and, with a line in the log, when it cannot be read. */
export function readRestrictionFile(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | null {
  try {
    return read(RESTRICTION_FILE)
  } catch (error) {
    // The cause then reads « any other reason » in the box, which is true but vague: the line says why it could not be more precise.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[launch] the restriction of user namespaces could not be read; the box will not name it:', error)
    return null
  }
}

/** Ends the launch the built application refused, in this process (index.ts). */
export function refuseLaunch(refused: readonly string[]): void {
  endRefusedLaunch(refused, {
    platform: process.platform,
    env: process.env,
    readRestriction: () => readRestrictionFile(),
    whenReady: () => app.whenReady(),
    locale: () => app.getLocale(),
    showBox: async (box) => (await dialog.showMessageBox({ type: 'error', title: box.title, message: box.message, detail: box.detail, buttons: box.buttons, defaultId: 1, cancelId: 1 })).response,
    openPage: (url) => shell.openExternal(url),
    exit: (code) => app.exit(code),
    log: (line, error) => (error === undefined ? console.error(line) : console.error(line, error))
  })
}
