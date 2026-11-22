// The two switches of the command line that ask for a window: `--new-window` and `--private-window`. They are read by the instance that runs (a second launch
// of the program, shell/single-instance.ts) and by a first launch (shell/external-links-wiring.ts), and obeyed only while the setting `urlAutomation` is on:
// they drive the application from outside, as the commands by address do (shared/automation-url.ts), so they have the same switch, off by default.
// They open an empty window, never a page: an address on the command line goes the way a link from another application does.

export type LaunchWindow = 'new' | 'private'

const SWITCHES: Readonly<Record<string, LaunchWindow>> = { '--new-window': 'new', '--private-window': 'private' }

/**
 * The windows the command line asks for, in the order written, each once. Exactly the two switches (no value, no abbreviation); on Windows the case does not
 * count, as for Chromium's own switches (runtime.ts). What follows a bare `--` is not a switch.
 */
export function launchWindowsFromArgv(argv: readonly string[], windows: boolean = false): LaunchWindow[] {
  const end = argv.indexOf('--')
  const asked: LaunchWindow[] = []
  for (const arg of end === -1 ? argv : argv.slice(0, end)) {
    const kind = SWITCHES[windows ? arg.toLowerCase() : arg]
    if (kind !== undefined && !asked.includes(kind)) asked.push(kind)
  }
  return asked
}
