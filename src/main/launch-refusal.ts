// What a refused launch tells a person who cannot read a terminal (index.ts, runtime.ts `refusedSwitches`).
//
// The case this is for: an AppImage started from the file manager on Ubuntu 24.04 or later. The AppRun of the AppImage (electron-builder) tries
// `unshare -Ur true`; AppArmor restricts unprivileged user namespaces there (`kernel.apparmor_restrict_unprivileged_userns=1`), so the probe fails and the
// AppRun adds `--no-sandbox` to the command line, which keeps Chromium from complaining about its sandbox. Lucium's code then runs first, and refuses that
// switch: the sandbox is never switched off. The line it writes goes to the standard error, which nobody sees after a double-click; and Electron's
// `dialog.showErrorBox`, called before `ready`, writes to the standard error on Linux and opens no window (Electron 45 documentation). So the person saw
// only the system's « the application quit unexpectedly ».
//
// Keeping the process alive to show the box, by Electron or by a program it waits for, was tried and given up: Chromium starts its GPU process and its
// network service on its own, a few hundred milliseconds after the start and whatever Lucium does, and the launcher's `--no-sandbox` makes them run without a
// sandbox for as long as the process lives (seen with `ps` in an Ubuntu 24.04 machine, with an Electron box and with a box drawn by zenity that the process
// waited for; a refused launch that ends at once is gone before they exist). So the process does not wait: it starts the box in a program of the system, as the
// AppRun draws its own errors (`zenity`, or `kdialog`, by their absolute paths, with the library path of the AppImage taken off), **detached**, and ends at once
// with code 1, as it always did. The box outlives it, an ordinary program with nothing of Lucium in it, and its first button opens the download page (`xdg-open`,
// run by the same small shell command, once the box answered). Nothing of the interface is made (no window, no page, no session, no read of the profile).
// Without either program, or without a screen, or for any other refusal or system, the launch ends at once as before, with its line.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'
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
  /** The first opens the download page of the site, the second only closes the box. */
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

/** The programs of the system that draw a box, by the absolute paths the AppRun of the AppImage looks for them at: no search in the PATH. */
export const BOX_HELPERS = [
  { name: 'zenity', path: '/usr/bin/zenity' },
  { name: 'kdialog', path: '/usr/bin/kdialog' }
] as const
export type BoxHelper = (typeof BOX_HELPERS)[number]['name']

export const OPEN_PROGRAM = '/usr/bin/xdg-open'

/**
 * The arguments that make `helper` draw `box` with two buttons: its exit code is 0 for the first button, 1 for the second, anything else when the box was
 * closed another way. The text is shown as it is (zenity is told not to read it as markup; the texts hold none).
 */
export function helperArguments(helper: BoxHelper, box: RefusalBox): string[] {
  const text = `${box.message}\n\n${box.detail}`
  if (helper === 'zenity') return ['--question', '--no-markup', '--width=560', `--title=${box.title}`, `--text=${text}`, `--ok-label=${box.buttons[0]}`, `--cancel-label=${box.buttons[1]}`]
  return ['--title', box.title, '--yes-label', box.buttons[0], '--no-label', box.buttons[1], '--yesno', text]
}

/** The locale named by the environment, the way the system's programs read it: LANGUAGE (its first entry), then LC_ALL, LC_MESSAGES, LANG; `C` and `POSIX` name none. */
export function localeOfEnv(env: NodeJS.ProcessEnv): string {
  const candidates = [env['LANGUAGE']?.split(':')[0], env['LC_ALL'], env['LC_MESSAGES'], env['LANG']]
  return candidates.find((value): value is string => typeof value === 'string' && value !== '' && value !== 'C' && value !== 'POSIX') ?? ''
}

/** What ending a refused launch needs from the system; `endRefusedLaunch` is tested with stand-ins for each. */
export interface LaunchEnd {
  platform: string
  env: NodeJS.ProcessEnv
  /** The content of `RESTRICTION_FILE`, or null when it cannot be read. */
  readRestriction: () => string | null
  /** The program of the system that can draw the box, or null when there is none. */
  findHelper: () => BoxHelper | null
  /** Starts the box in that program, detached, with the page its first button opens: resolves once it is started; rejects when it cannot be. */
  startBox: (helper: BoxHelper, box: RefusalBox, page: string) => Promise<void>
  exit: (code: number) => void
  log: (line: string, error?: unknown) => void
}

/**
 * Ends a launch `refusedSwitches` refused, with exit code 1, at once: the person who can be told on a screen is told by a program of the system that is started first
 * and outlives the launch. The line for the standard error was written before (index.ts). The first button of the box opens the download page of the site, in
 * the browser of the system, where the .deb package is.
 */
export function endRefusedLaunch(refused: readonly string[], deps: LaunchEnd): void {
  const screenHere = Boolean(deps.env['DISPLAY'] || deps.env['WAYLAND_DISPLAY'])
  if (!screenHere || !hasRefusalBox(refused, deps.platform)) {
    deps.exit(1)
    return
  }
  const helper = deps.findHelper()
  if (helper === null) {
    deps.log('[launch] no program of the system (zenity, kdialog) is there to show why the launch was refused: the line above is all there is')
    deps.exit(1)
    return
  }
  // The system's language: the profile is not read for a launch that is refused (the interface's own setting, French by default, lives in it).
  setLanguage(languageOfLocale(localeOfEnv(deps.env)))
  const box = refusalBox(sandboxCause(deps.readRestriction()))
  void deps
    .startBox(helper, box, downloadPageUrl(getLanguage()))
    .catch((error: unknown) => deps.log(`[launch] ${helper} could not be started to show why the launch was refused:`, error))
    .finally(() => deps.exit(1))
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

/**
 * The environment of the programs started here: the library path of the AppImage taken off, as its AppRun does for its own boxes, so that they load the libraries
 * of the system and not the ones the AppImage carries for Electron.
 */
export const helperEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'LD_LIBRARY_PATH'))

/**
 * What the shell command that carries the box runs: the program of the box, then, when the first button was chosen (exit code 0), the opener of the browser on the
 * page. Its parameters are `program opener page arguments…`, never pasted into the text of the command: nothing in the texts or the address is read as shell.
 */
export const BOX_COMMAND = 'program="$1"; opener="$2"; page="$3"; shift 3; if "$program" "$@"; then exec "$opener" "$page"; fi'

/**
 * Starts the box in a program of the system, detached (a session of its own: it outlives this process, which ends at once) and with no input or output, and resolves
 * once it is started; a command that cannot be started rejects. `spawn` is not told to wait: the process is on its way out.
 */
export function startBox(helper: BoxHelper, box: RefusalBox, page: string): Promise<void> {
  const path = BOX_HELPERS.find((candidate) => candidate.name === helper)!.path
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', BOX_COMMAND, 'lucium-box', path, OPEN_PROGRAM, page, ...helperArguments(helper, box)], { stdio: 'ignore', detached: true, env: helperEnv(process.env) })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Ends the launch the built application refused, in this process (index.ts). */
export function refuseLaunch(refused: readonly string[]): void {
  endRefusedLaunch(refused, {
    platform: process.platform,
    env: process.env,
    readRestriction: () => readRestrictionFile(),
    findHelper: () => BOX_HELPERS.find((candidate) => existsSync(candidate.path))?.name ?? null,
    startBox,
    exit: (code) => app.exit(code),
    log: (line, error) => (error === undefined ? console.error(line) : console.error(line, error))
  })
}
