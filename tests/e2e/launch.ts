// Starts the application built by `electron-vite build`, with a data folder of its own that is removed after the test.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const ROOT = resolve(__dirname, '../..')

/** How long a clean quit may take before the application is killed. */
const CLOSE_LIMIT_MS = 10_000

/**
 * Host names of the tests that are not this machine's own (`site.e2e.test`, `thirdparty.e2e.test`…): Chromium resolves them to 127.0.0.1, so a page
 * of the local server can be reached under a name that the application treats as an ordinary site of the Internet (third party, HTTPS first).
 * No request leaves the machine: the names exist nowhere else.
 */
export const TEST_DOMAIN = 'e2e.test'

/**
 * The names Chromium may resolve under the tests: the test domain (to this machine) and this machine itself. Every other name is not found, without
 * a question to the DNS: whatever the application would ask of the Internet by itself (a filter list, an icon, an update feed, a suggestion) fails
 * at once instead of leaving the machine. The first rule that matches a name wins, and an `EXCLUDE` keeps a name out of the catch-all.
 * A page asked through a proxy is not resolved here (the proxy is given its name): the tests of the proxy use the local server as the proxy.
 */
export const HOST_RULES = `--host-resolver-rules=MAP *.${TEST_DOMAIN} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`

/** How long the window of the interface may take to come. */
const WINDOW_LIMIT_MS = 30_000

/**
 * The page of the interface (index.html) of the first window. The application makes several pages at its launch (the interface, the layer of the
 * panels, the tooltip…) and Playwright lists them in the order it learns of them, which is not always the order they were made in: "the first
 * window" can be the layer of the panels, whose bridge answers like the interface's but which draws no sidebar. A test then fails on an element
 * of the interface that never comes: the likely cause of the nightly failures that moved from one test to another (the bridge answered, the
 * sidebar was never found). When a launch brings several windows back, the first one made is the main one: the smallest window id.
 */
async function interfacePage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + WINDOW_LIMIT_MS
  for (;;) {
    const found = app.windows().filter((page) => page.url().endsWith('/index.html'))
    if (found.length === 1) return found[0]!
    if (found.length > 1) {
      const ids = await Promise.all(found.map(async (page) => (await app.browserWindow(page)).evaluate((window) => (window as unknown as { id: number }).id)))
      return found[ids.indexOf(Math.min(...ids))]!
    }
    if (Date.now() > deadline) throw new Error(`the window of the interface did not come in time; pages seen: ${app.windows().map((page) => page.url()).join(', ') || 'none'}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export interface Running {
  app: ElectronApplication
  page: Page
  /** The data folder of this run (state.json, history.json…): removed by `close`. */
  dataDir: string
  /** Quits the application; the data folder is removed unless `keepData` (to launch again on the same folder). */
  close: (options?: { keepData?: boolean }) => Promise<void>
}

export interface LaunchOptions {
  /** Unpacked folders loaded at launch (the same list as LUCIUM_EXTENSIONS). */
  extensions?: string[]
  /** A data folder kept from an earlier run (`close({ keepData: true })`), to launch again on what it wrote. */
  dataDir?: string
  /** More switches for Chromium (for example `--ignore-certificate-errors`, for the certificate of the tests' https:// server). */
  args?: string[]
  /**
   * Playwright makes every page it drives see `prefers-color-scheme: light` unless told otherwise; `null` lets the pages see the scheme the
   * application gives them (View › Appearance). The screenshots of the Settings are made with the default, light.
   */
  colorScheme?: 'light' | 'dark' | null
}

/** Starts the application. An array is the list of unpacked extensions (the first form of this helper). */
export async function launchLucium(options: string[] | LaunchOptions = {}): Promise<Running> {
  const { extensions = [], dataDir, args = [], colorScheme } = Array.isArray(options) ? { extensions: options } : options
  const userData = dataDir ?? mkdtempSync(join(tmpdir(), 'lucium-e2e-'))
  // LUCIUM_E2E=1: the blocker downloads no list (src/main/blocking/index.ts); the lists of a test are given as text.
  const env = { ...process.env, LUCIUM_E2E: '1', ...(extensions.length > 0 ? { LUCIUM_EXTENSIONS: extensions.join(':') } : {}) }
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, HOST_RULES, ...args], cwd: ROOT, env, ...(colorScheme !== undefined ? { colorScheme } : {}) })
  // Main-process output (the extension library's debug lines with DEBUG set) goes to the test log.
  app.process().stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`))
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[app] ${chunk}`))
  // Kept from the start: once a quit has begun, Playwright no longer hands the process out.
  const child = app.process()
  const page = await interfacePage(app)
  await page.waitForLoadState('domcontentloaded')
  return {
    app,
    page,
    dataDir: userData,
    close: async ({ keepData = false } = {}) => {
      // "Avertir avant de quitter" is on by default: the quit would wait for the answer to its question (a sheet on the window) until the
      // process is killed below, and nothing that runs at a clean quit would run. The test does not answer it: the setting is switched off first.
      if (child.exitCode === null && child.signalCode === null) {
        await page
          .evaluate(() => (globalThis as unknown as { lucium: { dispatch(action: unknown): Promise<void> } }).lucium.dispatch({ type: 'settings/update', patch: { warnBeforeQuitting: false } }))
          .catch((error: unknown) => console.warn('[e2e] the quit question could not be switched off before the quit:', (error as Error).message))
      }
      // A clean quit first; an application that does not quit within the limit is killed (a stuck close held every test for 90 s).
      // An application that already quit (a test may quit it) has nothing to close: that is said, and the steps below see the process gone.
      const quit = app.close().catch((error: unknown) => console.warn('[e2e] the application did not close cleanly:', (error as Error).message))
      const timedOut = await Promise.race([quit.then(() => false), new Promise<boolean>((done) => setTimeout(() => done(true), CLOSE_LIMIT_MS))])
      if (timedOut && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      // The folder is removed once the process is gone: a process still writing into it makes the removal fail (ENOTEMPTY).
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((done) => { child.once('exit', () => done()); setTimeout(done, CLOSE_LIMIT_MS) })
      if (!keepData) rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}
