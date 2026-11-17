import { app } from 'electron'

/**
 * Whether this is the built application (the .app that electron-builder makes), as opposed to a run from the sources.
 * `app.isPackaged` alone is not enough: Electron reports "packaged" for any executable that is not called `electron`, such as the copy named
 * Lucium that `pnpm start` and `pnpm dev` run (scripts/dev-electron.mjs). That one still starts from the sources, which `defaultApp` tells.
 */
export function isBuiltApp(): boolean {
  return app.isPackaged && !process.defaultApp
}

/** The switch of the engine test (`pnpm test:engine`, `pnpm perf`): it runs the suites of src/main/smoke*.ts in the application. */
const SMOKE_SWITCH = '--smoke'

/**
 * Whether this run is the engine test. Never in the built application: `--smoke` lifts the single-instance lock, swaps the keychain for a stand-in
 * and runs the suites, which the package does not carry. The engine test, `pnpm perf` and the end-to-end tests all start from the sources.
 */
export function isSmokeRun(argv: readonly string[], built: boolean = isBuiltApp()): boolean {
  return !built && argv.includes(SMOKE_SWITCH)
}

/**
 * The switches the built application refuses to start with. Each one hands the profile, or what the pages exchange, to whoever wrote the command
 * line, and the fuses of the package do not cover them (they close Node's own: RunAsNode, NODE_OPTIONS, --inspect):
 * - `smoke`: the engine test (see `isSmokeRun`);
 * - `remote-debugging-*`, `remote-allow-origins`: the DevTools protocol, which drives every page and reads the cookies of every site;
 * - `ignore-certificate-errors*`, `host-resolver-rules`, `host-rules`: any server may then answer for any site;
 * - `use-mock-keychain`: the cookies are encrypted with a key that is not the keychain's;
 * - `disable-web-security`, `no-sandbox`: the separation between sites, and between a page and the system.
 * A run from the sources accepts them all: the end-to-end tests, the engine test and the screenshots of the site are driven by them.
 */
export const REFUSED_SWITCHES: readonly string[] = [
  'smoke',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-debugging-targets',
  'remote-debugging-io-pipes',
  'remote-allow-origins',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'host-resolver-rules',
  'host-rules',
  'use-mock-keychain',
  'disable-web-security',
  'no-sandbox'
]

/**
 * The name of the switch an argument of the command line is, as Chromium reads it: `--name`, `--name=value`, and `-name` with one dash; on
 * Windows also `/name`, and the case does not count there. Undefined for anything else (an address, a path).
 */
function switchName(arg: string, windows: boolean): string | undefined {
  const prefix = arg.startsWith('--') ? 2 : arg.startsWith('-') || (windows && arg.startsWith('/')) ? 1 : 0
  if (prefix === 0) return undefined
  const name = arg.slice(prefix).split('=', 1)[0] ?? ''
  return windows ? name.toLowerCase() : name
}

/**
 * The switches of `REFUSED_SWITCHES` found in the command line of the built application, in the order they were written; none for a run from the
 * sources. What follows a bare `--` is not a switch for Chromium either. The caller (main/index.ts) says why and ends the launch.
 */
export function refusedSwitches(argv: readonly string[], built: boolean = isBuiltApp(), windows: boolean = process.platform === 'win32'): string[] {
  if (!built) return []
  const end = argv.indexOf('--')
  const found = (end === -1 ? argv : argv.slice(0, end)).map((arg) => switchName(arg, windows)).filter((name): name is string => name !== undefined && REFUSED_SWITCHES.includes(name))
  return [...new Set(found)]
}

/**
 * The line the launch writes when `refusedSwitches` found something, which ends the launch (main/index.ts). Whoever reads it is rarely the one who wrote
 * the switch: on Ubuntu 24.04 and later electron-builder's AppRun adds `--no-sandbox` by itself to an AppImage when the machine does not let an
 * unprivileged process create a user namespace (AppArmor restricts them: `kernel.apparmor_restrict_unprivileged_userns`), and the user typed nothing.
 * The line then says what that means and what to do, instead of calling it a development switch: Lucium never runs without the sandbox of Chromium.
 */
export function refusalMessage(refused: readonly string[], platform: string = process.platform): string {
  const switches = refused.map((name) => `--${name}`).join(', ')
  const base = `[launch] refused: this application does not start with ${switches} (development and test switches, accepted only by a run from the sources)`
  if (platform !== 'linux' || !refused.includes('no-sandbox')) return base
  return (
    `${base}. If you did not write --no-sandbox, the launcher added it because the sandbox of the browser engine cannot start on this machine, and Lucium does not run without it. ` +
    'On Ubuntu 24.04 and later AppArmor restricts the user namespaces the sandbox is made of, and an AppImage cannot carry the profile that allows them: ' +
    'install the .deb package (it carries the profile), or allow the user namespaces on this machine, for example ' +
    '`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (until the next restart).'
  )
}

/**
 * Whether the development variables (LUCIUM_EXTENSIONS, LUCIUM_DEBUG_*, LUCIUM_ANNOTATE, LUCIUM_IMPORT_APP_FOLDERS) may change the run. Never in the
 * built application: another process can set them, and LUCIUM_EXTENSIONS would load unpackaged code with the permissions of the profile.
 */
export function mayReadDevelopmentEnv(): boolean {
  return !isBuiltApp()
}

/**
 * The development variables read where no gate is at hand: LUCIUM_ANNOTATE is read by main/index.ts and by the state of every window
 * (shell/browser.ts, the toolbar's « Annoter »); LUCIUM_UPDATE_FEED by the check for updates, from the menu and in the background
 * (shell/update-source.ts, shell/auto-update.ts): in the built application a feed comes from the build or from the profile, never from another process.
 * They are not gated at each reader but taken out of the environment once, at start-up.
 */
export const DROPPED_DEVELOPMENT_ENV = ['LUCIUM_ANNOTATE', 'LUCIUM_UPDATE_FEED'] as const

/**
 * Whether a variable belongs to the tests: LUCIUM_SMOKE_* choose and tune the suites of the engine test, LUCIUM_E2E=1 (tests/e2e/launch.ts) keeps the
 * blocker from downloading its lists (blocking/index.ts). Neither may change what the built application does.
 */
export function isTestEnv(name: string): boolean {
  return name === 'LUCIUM_E2E' || name.startsWith('LUCIUM_SMOKE_')
}

/**
 * In the built application, removes `DROPPED_DEVELOPMENT_ENV` and the variables of the tests (`isTestEnv`) from `env` before anything reads them:
 * every reader then sees the default, as if the variable had not been set (for LUCIUM_ANNOTATE, the annotation stays on: `annotateShareEnabled`;
 * for LUCIUM_UPDATE_FEED, the feed of the build or of the setting; for LUCIUM_E2E, the blocker downloads its lists). Elsewhere `env` is left alone.
 */
export function dropDevelopmentEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (mayReadDevelopmentEnv()) return
  for (const name of DROPPED_DEVELOPMENT_ENV) delete env[name]
  for (const name of Object.keys(env)) if (isTestEnv(name)) delete env[name]
}

/** The development variables `main()` reads, each one empty where they may not change the run. */
export interface DevelopmentEnv {
  /** LUCIUM_EXTENSIONS: folders of unpackaged extensions to load. */
  extensions: string[]
  /** LUCIUM_DEBUG_APPEARANCE: dark or light, to check an appearance without touching the system setting. */
  appearance: string | undefined
  /** LUCIUM_DEBUG_PANEL: a panel to open shortly after start. */
  panel: string | undefined
  /**
   * LUCIUM_IMPORT_APP_FOLDERS: the folders of applications whose bundles name the browsers of the import sheet, in place of `/Applications` and
   * `~/Applications`; empty, none, and every browser keeps its generic label (the screenshots of the site, which show no other browser's name).
   * Undefined when the variable is not set: the usual folders.
   */
  importAppFolders: string[] | undefined
}

/**
 * Reads the development variables of `main()`, through `mayReadDevelopmentEnv`: in the built application none of them is read (no extension
 * from the environment, no debug aid). `splitPathList` is the platform's reading of a list of paths.
 */
export function readDevelopmentEnv(splitPathList: (value: string) => string[], env: NodeJS.ProcessEnv = process.env): DevelopmentEnv {
  if (!mayReadDevelopmentEnv()) return { extensions: [], appearance: undefined, panel: undefined, importAppFolders: undefined }
  const appFolders = env['LUCIUM_IMPORT_APP_FOLDERS']
  return {
    extensions: splitPathList(env['LUCIUM_EXTENSIONS'] ?? ''),
    appearance: env['LUCIUM_DEBUG_APPEARANCE'],
    panel: env['LUCIUM_DEBUG_PANEL'],
    importAppFolders: appFolders === undefined ? undefined : splitPathList(appFolders)
  }
}
