import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))
vi.mock('electron', () => electron)

const { dropDevelopmentEnv, isBuiltApp, isSmokeRun, isTestEnv, mayReadDevelopmentEnv, readDevelopmentEnv, refusalMessage, refusedSwitches, REFUSED_SWITCHES } = await import('./runtime')
const { annotateShareEnabled } = await import('@shared/window-share')
const { readdirSync, readFileSync } = await import('node:fs')
const { join } = await import('node:path')

describe('isBuiltApp', () => {
  const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
  afterEach(() => {
    delete (process as { defaultApp?: boolean }).defaultApp
  })

  it('is true for the built application: packaged, and not started from a folder of sources', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    expect(isBuiltApp()).toBe(true)
  })

  it('is false for a run from the sources with the plain Electron', () => {
    electron.app.isPackaged = false
    setDefaultApp(true)
    expect(isBuiltApp()).toBe(false)
  })

  it('is false for a run from the sources with an executable not called electron (the copy named Lucium)', () => {
    electron.app.isPackaged = true
    setDefaultApp(true)
    expect(isBuiltApp()).toBe(false)
  })
})

describe('mayReadDevelopmentEnv', () => {
  const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
  afterEach(() => {
    delete (process as { defaultApp?: boolean }).defaultApp
  })

  it('ignores the development variables in the built application (LUCIUM_EXTENSIONS loads no unpackaged code)', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    expect(mayReadDevelopmentEnv()).toBe(false)
  })

  it('reads them from the sources, in development', () => {
    electron.app.isPackaged = false
    setDefaultApp(true)
    expect(mayReadDevelopmentEnv()).toBe(true)
  })
})

describe('isSmokeRun: the engine test runs from the sources only', () => {
  const SMOKE = ['/Applications/Lucium.app/Contents/MacOS/Lucium', '--smoke', '--user-data-dir=/tmp/lucium-smoke-1']

  it('is the engine test for a run from the sources started with --smoke', () => {
    expect(isSmokeRun(['electron', '.', '--smoke', '--user-data-dir=/tmp/p'], false)).toBe(true)
    expect(isSmokeRun(['electron', '.', '--user-data-dir=/tmp/p'], false)).toBe(false)
  })

  it('is never the engine test in the built application, whatever the command line says', () => {
    expect(isSmokeRun(SMOKE, true)).toBe(false)
  })

  it('reads the build from the application when it is not given', () => {
    const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    expect(isSmokeRun(SMOKE)).toBe(false)
    setDefaultApp(true)
    expect(isSmokeRun(SMOKE)).toBe(true)
    delete (process as { defaultApp?: boolean }).defaultApp
  })
})

describe('refusedSwitches: what the built application does not start with', () => {
  const EXE = '/Applications/Lucium.app/Contents/MacOS/Lucium'

  it('refuses the engine test and the DevTools protocol, in every form Chromium reads', () => {
    expect(refusedSwitches([EXE, '--smoke', '--user-data-dir=/tmp/p'], true)).toEqual(['smoke'])
    expect(refusedSwitches([EXE, '--remote-debugging-port=9222', '--remote-allow-origins=*'], true)).toEqual(['remote-debugging-port', 'remote-allow-origins'])
    expect(refusedSwitches([EXE, '--remote-debugging-port', '9222'], true)).toEqual(['remote-debugging-port'])
    expect(refusedSwitches([EXE, '--remote-debugging-pipe'], true)).toEqual(['remote-debugging-pipe'])
    // Chromium takes a switch with one dash as well.
    expect(refusedSwitches([EXE, '-remote-debugging-port=0'], true)).toEqual(['remote-debugging-port'])
  })

  it('refuses the switches that weaken TLS, the resolution of names, the keychain and the separation of sites', () => {
    for (const name of ['ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'host-resolver-rules', 'host-rules', 'use-mock-keychain', 'disable-web-security', 'no-sandbox']) {
      expect(refusedSwitches([EXE, `--${name}=x`], true), name).toEqual([name])
    }
  })

  it('names each refused switch once, in the order of the command line', () => {
    expect(refusedSwitches([EXE, '--use-mock-keychain', '--smoke', '--use-mock-keychain'], true)).toEqual(['use-mock-keychain', 'smoke'])
  })

  it('lets an ordinary launch through: a data folder, a language, an address, a file', () => {
    expect(refusedSwitches([EXE], true)).toEqual([])
    expect(refusedSwitches([EXE, '--user-data-dir=/tmp/p', '--lang=fr-FR', 'https://example.com/?q=--smoke', '/Users/x/remote-debugging-port.html'], true)).toEqual([])
    // A longer name is another switch, and what follows a bare `--` is not a switch for Chromium.
    expect(refusedSwitches([EXE, '--smoke-test', '--no-sandbox-and-elevated'], true)).toEqual([])
    expect(refusedSwitches([EXE, '--', '--smoke'], true)).toEqual([])
  })

  it('reads the Windows forms on Windows only: a slash, any case', () => {
    expect(refusedSwitches(['Lucium.exe', '/Remote-Debugging-Port=9222', '--SMOKE'], true, true)).toEqual(['remote-debugging-port', 'smoke'])
    expect(refusedSwitches([EXE, '/remote-debugging-port=9222', '--SMOKE'], true, false)).toEqual([])
  })

  it('refuses nothing from the sources: the engine test, pnpm perf, the end-to-end tests and the screenshots of the site are driven by these switches', () => {
    for (const name of REFUSED_SWITCHES) expect(refusedSwitches(['electron', '.', `--${name}`], false), name).toEqual([])
  })

  it('reads the build from the application when it is not given', () => {
    const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    expect(refusedSwitches([EXE, '--remote-debugging-port=0'])).toEqual(['remote-debugging-port'])
    setDefaultApp(true)
    expect(refusedSwitches([EXE, '--remote-debugging-port=0'])).toEqual([])
    delete (process as { defaultApp?: boolean }).defaultApp
  })
})

describe('refusalMessage: what the launch says when it refuses a switch', () => {
  const BASE = '[launch] refused: this application does not start with'

  it('names each switch and keeps the line the launch check of verify:app looks for, on every system', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(refusalMessage(['smoke', 'remote-debugging-port'], platform)).toBe(`${BASE} --smoke, --remote-debugging-port (development and test switches, accepted only by a run from the sources)`)
    }
    // macOS and Windows have no AppRun that adds it: the same line as before, with no advice about Linux.
    expect(refusalMessage(['no-sandbox'], 'darwin')).toBe(`${BASE} --no-sandbox (development and test switches, accepted only by a run from the sources)`)
  })

  it('tells a Linux user whose AppImage added --no-sandbox by itself that the sandbox cannot start, and what to do (Ubuntu 24.04, AppArmor)', () => {
    const message = refusalMessage(['no-sandbox'], 'linux')
    expect(message.startsWith(`${BASE} --no-sandbox`)).toBe(true)
    expect(message).toContain('If you did not write --no-sandbox')
    expect(message).toContain('sandbox of the browser engine')
    expect(message).toContain('AppArmor')
    expect(message).toContain('.deb')
    expect(message).toContain('kernel.apparmor_restrict_unprivileged_userns=0')
    // It stays one line: the launch writes it with console.error and verify:app reads the first line.
    expect(message).not.toContain('\n')
  })

  it('gives that advice for --no-sandbox only: the other refused switches have nothing to do with the sandbox', () => {
    expect(refusalMessage(['smoke'], 'linux')).not.toContain('AppArmor')
    expect(refusalMessage(['use-mock-keychain', 'no-sandbox'], 'linux')).toContain('AppArmor')
  })
})

describe('dropDevelopmentEnv: LUCIUM_ANNOTATE, LUCIUM_UPDATE_FEED and the variables of the tests in the built application', () => {
  const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
  afterEach(() => {
    delete (process as { defaultApp?: boolean }).defaultApp
  })

  it('is taken out of the environment of the built application: the annotation keeps its default, on', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    const env: NodeJS.ProcessEnv = { LUCIUM_ANNOTATE: '0', HOME: '/Users/x' }
    dropDevelopmentEnv(env)
    expect(env).toEqual({ HOME: '/Users/x' })
    expect(annotateShareEnabled(env)).toBe(true)
  })

  it('takes LUCIUM_UPDATE_FEED out too: the built application never reads a feed another process named', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    const env: NodeJS.ProcessEnv = { LUCIUM_UPDATE_FEED: 'https://elsewhere.example/feed.json', HOME: '/Users/x' }
    dropDevelopmentEnv(env)
    expect(env).toEqual({ HOME: '/Users/x' })
  })

  it('takes the variables of the tests out: LUCIUM_E2E and every LUCIUM_SMOKE_*, so that the blocker of the built application downloads its lists', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    const env: NodeJS.ProcessEnv = { LUCIUM_E2E: '1', LUCIUM_SMOKE_ONLY: 'perf', LUCIUM_SMOKE_REPORT: '/tmp/r.json', LUCIUM_SMOKED: 'kept', HOME: '/Users/x' }
    dropDevelopmentEnv(env)
    expect(env).toEqual({ LUCIUM_SMOKED: 'kept', HOME: '/Users/x' })
    expect(isTestEnv('LUCIUM_E2E')).toBe(true)
    expect(isTestEnv('LUCIUM_SMOKE_ONLY')).toBe(true)
    expect(isTestEnv('LUCIUM_E2E_OTHER')).toBe(false)
    expect(isTestEnv('PATH')).toBe(false)
  })

  it('is kept from the sources, with the variables of the tests: the engine test and the end-to-end tests run there', () => {
    electron.app.isPackaged = false
    setDefaultApp(true)
    const devEnv: NodeJS.ProcessEnv = { LUCIUM_ANNOTATE: '0', LUCIUM_E2E: '1', LUCIUM_SMOKE_ONLY: 'perf' }
    dropDevelopmentEnv(devEnv)
    expect(annotateShareEnabled(devEnv)).toBe(false)
    expect(devEnv).toEqual({ LUCIUM_ANNOTATE: '0', LUCIUM_E2E: '1', LUCIUM_SMOKE_ONLY: 'perf' })
  })
})

describe('readDevelopmentEnv: the variables main() reads', () => {
  const setDefaultApp = (value: boolean | undefined) => Object.defineProperty(process, 'defaultApp', { value, configurable: true, writable: true })
  afterEach(() => {
    delete (process as { defaultApp?: boolean }).defaultApp
  })
  const env: NodeJS.ProcessEnv = { LUCIUM_EXTENSIONS: '/tmp/a:/tmp/b', LUCIUM_DEBUG_APPEARANCE: 'dark', LUCIUM_DEBUG_PANEL: 'settings:privacy' }
  const split = (value: string): string[] => (value === '' ? [] : value.split(':'))

  it('reads no extension and no debug aid in the built application: another process may set them', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    const splitter = vi.fn(split)
    expect(readDevelopmentEnv(splitter, env)).toEqual({ extensions: [], appearance: undefined, panel: undefined })
    expect(splitter).not.toHaveBeenCalled()
  })

  it('reads them from the sources', () => {
    const read = { extensions: ['/tmp/a', '/tmp/b'], appearance: 'dark', panel: 'settings:privacy' }
    electron.app.isPackaged = false
    setDefaultApp(true)
    expect(readDevelopmentEnv(split, env)).toEqual(read)
    expect(readDevelopmentEnv(split, {})).toEqual({ extensions: [], appearance: undefined, panel: undefined })
  })

  it('reads the folders that name the browsers of the import sheet only outside the built application: empty is none, absent is the usual ones', () => {
    electron.app.isPackaged = true
    setDefaultApp(undefined)
    // In the built application the variable changes nothing: the import sheet reads /Applications as always.
    expect(readDevelopmentEnv(split, { LUCIUM_IMPORT_APP_FOLDERS: '' }).importAppFolders).toBeUndefined()
    electron.app.isPackaged = false
    setDefaultApp(true)
    expect(readDevelopmentEnv(split, { LUCIUM_IMPORT_APP_FOLDERS: '' }).importAppFolders).toEqual([])
    expect(readDevelopmentEnv(split, { LUCIUM_IMPORT_APP_FOLDERS: '/tmp/apps' }).importAppFolders).toEqual(['/tmp/apps'])
    expect(readDevelopmentEnv(split, {}).importAppFolders).toBeUndefined()
  })
})

// What the main process does with the development variables and with a refused launch: main-wiring.test.ts, where main() is run; the folders of the import service:
// shell/import-wiring.test.ts. What no run can show is that nothing else reads them.
describe('the development variables are read through it', () => {
  it('reads LUCIUM_EXTENSIONS and the debug aids nowhere in the application but in runtime.ts (the engine tests, which only a smoke run loads, may)', () => {
    const readers = (readdirSync(__dirname, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('test-support') && !/(^|\/)smoke[^/]*\.ts$/.test(file))
      .filter((file) => /process\.env\[['"]LUCIUM_(EXTENSIONS|DEBUG_APPEARANCE|DEBUG_PANEL|IMPORT_APP_FOLDERS)['"]\]|process\.env\.LUCIUM_(EXTENSIONS|DEBUG_APPEARANCE|DEBUG_PANEL|IMPORT_APP_FOLDERS)\b/.test(readFileSync(join(__dirname, file), 'utf8')))
    expect(readers).toEqual([])
  })
})
