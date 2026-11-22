// One running Lucium per data folder. A launch that does not get the lock hands its links to the one that has it (see 'second-instance'
// in index.ts) and must do nothing else: its `main()` would load the state, install the quit handlers and write the state file on its way
// out, over what the first instance has been keeping up to date.

import { linksFromArgv } from '@shared/platform'
import { launchWindowsFromArgv, type LaunchWindow } from '@shared/launch-flags'

/** What the first instance does for a second launch (main() gives them: index.ts). */
export interface SecondLaunchDeps {
  /** Opens a web address, or runs a command by address (`lucium://`): the handler of the links of other applications, which decides what each is for. */
  openLink(url: string): void
  isAppLocked(): boolean
  /** A window of its own, with the command bar, as "Nouvelle fenêtre" of the Dock does. */
  newWindow(): void
  /** Brings the main window forward. */
  focusMain(): void
  /** The setting `urlAutomation`: `--new-window` and `--private-window` drive the application from outside, so they obey the switch of the commands by address. */
  windowSwitchesAllowed(): boolean
  /** A window the command line asked for: a new one with the command bar, or a private one. */
  openLaunchWindow(kind: LaunchWindow): void
}

/**
 * The switches of the very first launch: `--private-window` opens a private window beside the main one, under the same rules as for a second launch (the setting
 * on, the application not locked). `--new-window` asks for nothing more: the first window is the one that opens. Returns whether a window was opened.
 */
export function handleFirstLaunchSwitches(argv: readonly string[], deps: Pick<SecondLaunchDeps, 'isAppLocked' | 'windowSwitchesAllowed' | 'openLaunchWindow'>): boolean {
  const asked = launchWindowsFromArgv(argv, process.platform === 'win32')
  if (!asked.includes('private')) return false
  if (!deps.windowSwitchesAllowed()) {
    console.warn('[launch] --private-window ignored: it needs the setting « Commandes par adresse » (urlAutomation), which is off')
    return false
  }
  if (deps.isAppLocked()) {
    console.warn('[launch] --private-window ignored: the application is locked')
    return false
  }
  deps.openLaunchWindow('private')
  return true
}

/** A second launch of the program, in the instance that runs: `argv` is its command line. */
export function handleSecondLaunch(argv: readonly string[], deps: SecondLaunchDeps): void {
  // The web addresses and the commands by address (`lucium://`): what the system gives a link from another app, here in the command line.
  const addresses = linksFromArgv(argv)
  for (const arg of addresses) deps.openLink(arg)
  // `--new-window` and `--private-window`: only while the setting of the commands by address is on, and never while locked (a locked application opens no window of its own).
  const asked = launchWindowsFromArgv(argv, process.platform === 'win32')
  if (asked.length > 0 && !deps.windowSwitchesAllowed()) console.warn('[launch] --new-window and --private-window ignored: they need the setting « Commandes par adresse » (urlAutomation), which is off')
  else if (asked.length > 0 && !deps.isAppLocked()) {
    for (const kind of asked) deps.openLaunchWindow(kind)
    return
  }
  // A launch with no address (`open -n`, the program started again) asks for a window of its own, as "Nouvelle fenêtre" of the Dock does.
  if (addresses.length === 0) {
    // A locked application opens no window of its own: the one that is there shows the lock screen, and the launch only brings it forward.
    if (deps.isAppLocked()) return deps.focusMain()
    deps.newWindow()
    return
  }
  deps.focusMain()
}

/** The switch that gives a run a data folder of its own (Chromium's): every launcher of the engine test passes it. */
const USER_DATA_DIR = '--user-data-dir='

/** Whether the command line names a data folder (`--user-data-dir=<path>`, a path that is not empty). */
export function hasOwnDataFolder(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith(USER_DATA_DIR) && arg.length > USER_DATA_DIR.length)
}

/**
 * Whether this process is the instance that runs the browser. The engine test (`--smoke`) never asks for the lock: it runs in a data folder
 * of its own, beside the user's application. So it must have one: a smoke run without `--user-data-dir=` would open the user's real profile
 * without the lock, beside a running Lucium that writes the same files. It is refused, and says why. `requestLock` is
 * `app.requestSingleInstanceLock`; `argv` is the command line (`process.argv`).
 */
export function isPrimaryInstance(smoke: boolean, requestLock: () => boolean, argv: readonly string[] = []): boolean {
  if (!smoke) return requestLock()
  if (hasOwnDataFolder(argv)) return true
  console.error('[smoke] refused: the engine test runs only in a data folder of its own (--user-data-dir=<a new folder>), never in the profile of the application')
  return false
}
