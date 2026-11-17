import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { setLanguage } from '@shared/i18n'
import { Channel } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { PROBLEM_SITE_URLS, reportFileName } from '@shared/problem-report'
import { createInitialState } from '@shared/sidebar'
import type { ScopedIpc } from './ipc-scope'

const electron = vi.hoisted(() => ({ showSaveDialog: vi.fn(), version: '0.2.12', components: undefined as unknown, owner: null as unknown }))
vi.mock('electron', () => ({
  dialog: { showSaveDialog: electron.showSaveDialog },
  app: { getVersion: () => electron.version },
  BrowserWindow: { fromWebContents: () => electron.owner },
  get components() {
    return electron.components
  }
}))

import { errorLog } from '../error-log'
import { problemReportEnv, problemReportOf, registerProblemReportIpc, saveProblemReport, type ProblemReportEnv, type ProblemReportSources } from './problem-report'
import { frenchSpaces } from '@shared/french-typography'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-report-'))
  electron.showSaveDialog.mockReset()
  electron.components = undefined
  electron.owner = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  errorLog.clear()
  setLanguage('fr')
  vi.restoreAllMocks()
})

const NOW = new Date(2026, 10, 7, 21, 49).getTime()
const sources = (over: Partial<ProblemReportSources> = {}): ProblemReportSources => ({
  now: NOW,
  appVersion: '0.2.12',
  versions: { electron: '45.0.0', chrome: '156.0.8078.48', node: '24.1.0', v8: '14.6' },
  platform: 'darwin',
  systemVersion: '15.1.0',
  arch: 'arm64',
  components: null,
  extensions: [{ name: 'uBlock Origin', version: '1.60.0', enabled: true }],
  settings: defaultSettings(),
  log: ['2026-11-07T10:00:00.000Z [state] cannot read state.json'],
  ...over
})

describe('the report as the process builds it', () => {
  it('is made from the sources: the version, the engine, the system, the extensions and the log', () => {
    const report = problemReportOf(sources())
    expect(report).toContain('Lucium 0.2.12 · Electron 45.0.0 · Chromium 156.0.8078.48 · variante Standard')
    expect(report).toContain('macOS 15.1.0 · arm64')
    expect(report).toContain('Extensions (1)\n  uBlock Origin 1.60.0')
    expect(report).toContain('cannot read state.json')
    // The node and V8 versions are the engine's own business: the report has the versions a person on the site can compare with.
    expect(report).not.toContain('24.1.0')
  })

  it('says DRM, and the version of Widevine, when the engine is the castLabs build, and standard without it', () => {
    const components = { whenReady: () => Promise.resolve(), status: () => ({ w: { title: 'Widevine Content Decryption Module', version: '4.10.2891.0' } }) }
    const drm = problemReportOf(sources({ components }))
    expect(drm).toContain('variante DRM (castLabs)')
    expect(drm).toContain(frenchSpaces('Widevine : Installé (4.10.2891.0)'))
    const standard = problemReportOf(sources())
    expect(standard).toContain('variante Standard')
    expect(standard).toContain(frenchSpaces('Widevine : Absent'))
  })

  it('is in the language of the process', () => {
    setLanguage('en')
    expect(problemReportOf(sources())).toContain('Lucium support report —')
  })
})

describe('« Enregistrer… »', () => {
  const report = { text: 'Rapport\nligne 2\n', at: NOW }

  it('writes the text at the path the user chose, and only there, for the user alone, with the name of the day proposed', async () => {
    const chosen = join(dir, 'mon-rapport.txt')
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    const window = {} as BrowserWindow
    expect(await saveProblemReport(window, report)).toEqual({ status: 'saved', file: 'mon-rapport.txt' })
    expect(readFileSync(chosen, 'utf8')).toBe(report.text)
    expect(statSync(chosen).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['mon-rapport.txt'])
    const [owner, options] = electron.showSaveDialog.mock.calls[0]!
    expect(owner).toBe(window)
    expect(options).toMatchObject({ defaultPath: 'lucium-rapport-2026-11-07.txt', filters: [{ extensions: ['txt'] }] })
    expect(options.defaultPath).toBe(reportFileName(NOW))
  })

  it('shows the dialog on no window when there is none to put it on', async () => {
    electron.showSaveDialog.mockResolvedValue({ canceled: true })
    await saveProblemReport(null, report)
    expect(electron.showSaveDialog.mock.calls[0]).toHaveLength(1)
  })

  it('writes nothing and says nothing when the user gives up the dialog', async () => {
    electron.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await saveProblemReport(null, report)).toEqual({ status: 'canceled' })
    electron.showSaveDialog.mockResolvedValue({ canceled: false })
    expect(await saveProblemReport(null, report)).toEqual({ status: 'canceled' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('says why it could not write, with the name of the file and not its path, and logs it', async () => {
    const missing = join(dir, 'inconnu', 'rapport.txt')
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: missing })
    const answer = await saveProblemReport(null, report)
    expect(answer).toEqual({ status: 'failed', message: expect.stringContaining('Enregistrement impossible dans rapport.txt') })
    expect(JSON.stringify(answer)).not.toContain(dir)
    expect(console.error).toHaveBeenCalledWith('[report] cannot write rapport.txt:', expect.objectContaining({ code: 'ENOENT' }))
    // The folder does not exist: nothing was made.
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('the three channels', () => {
  function setup(options: { trusted?: boolean; env?: Partial<ProblemReportEnv> } = {}) {
    const handlers = new Map<string, (event: { sender: object }, ...args: unknown[]) => unknown>()
    const ipc: ScopedIpc = {
      on: (channel, listener) => void handlers.set(channel, listener as never),
      handle: (channel, listener) => void handlers.set(channel, listener as never)
    }
    let trusted = options.trusted !== false
    const guard = vi.fn(() => trusted)
    const log = ['first line']
    const env: ProblemReportEnv = {
      sources: vi.fn(() => sources({ log: [...log] })),
      owner: vi.fn(() => null),
      openSite: vi.fn(),
      ...options.env
    }
    registerProblemReportIpc(ipc, guard, env)
    const call = (channel: string) => handlers.get(channel)!({ sender: {} as WebContents })
    return { env, guard, log, call, trust: (value: boolean) => void (trusted = value), channels: () => [...handlers.keys()].sort() }
  }

  it('are the report, the save and the link, and no other', () => {
    expect(setup().channels()).toEqual([Channel.problemReport, Channel.saveProblemReport, Channel.openProblemSite].sort())
  })

  it('gives the report to a page of the application, and nothing to another sender (the sources are not even read)', async () => {
    const trusted = setup()
    expect(await trusted.call(Channel.problemReport)).toContain('first line')
    const stranger = setup({ trusted: false })
    expect(await stranger.call(Channel.problemReport)).toBeNull()
    expect(stranger.env.sources).not.toHaveBeenCalled()
    expect(stranger.guard).toHaveBeenCalledWith(expect.anything(), Channel.problemReport)
  })

  it('says it could not prepare the report, and logs why, when a source fails', async () => {
    const t = setup({ env: { sources: () => { throw new Error('the engine is gone') } } })
    expect(await t.call(Channel.problemReport)).toBeNull()
    expect(console.error).toHaveBeenCalledWith('[report] cannot prepare the report:', expect.objectContaining({ message: 'the engine is gone' }))
    expect(await t.call(Channel.saveProblemReport)).toEqual({ status: 'failed', message: 'Le rapport n’a pas pu être préparé.' })
    expect(electron.showSaveDialog).not.toHaveBeenCalled()
  })

  it('forgets the report of an earlier reading when the next one fails: what is not on screen is not saved', async () => {
    let fails = false
    const t = setup({
      env: {
        sources: () => {
          if (fails) throw new Error('the engine is gone')
          return sources()
        }
      }
    })
    expect(await t.call(Channel.problemReport)).toContain('Rapport pour le support')
    fails = true
    expect(await t.call(Channel.problemReport)).toBeNull()
    expect(await t.call(Channel.saveProblemReport)).toMatchObject({ status: 'failed' })
    expect(electron.showSaveDialog).not.toHaveBeenCalled()
  })

  it('saves the report the sheet showed, not a new reading of the log', async () => {
    const t = setup()
    const shown = (await t.call(Channel.problemReport)) as string
    t.log.push('a line that came after the sheet was opened')
    const chosen = join(dir, 'vu.txt')
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    expect(await t.call(Channel.saveProblemReport)).toEqual({ status: 'saved', file: 'vu.txt' })
    expect(readFileSync(chosen, 'utf8')).toBe(shown)
    expect(readFileSync(chosen, 'utf8')).not.toContain('a line that came after')
    expect(t.env.owner).toHaveBeenCalled()
  })

  it('saves nothing before a report was given, and for a sender that is not one of the application’s own pages', async () => {
    const none = setup()
    expect(await none.call(Channel.saveProblemReport)).toMatchObject({ status: 'failed' })
    // A report was given, then the sender is no longer one of the application's pages: the dialog does not open.
    const stranger = setup()
    await stranger.call(Channel.problemReport)
    stranger.trust(false)
    expect(await stranger.call(Channel.saveProblemReport)).toMatchObject({ status: 'failed' })
    expect(stranger.guard).toHaveBeenLastCalledWith(expect.anything(), Channel.saveProblemReport)
    expect(electron.showSaveDialog).not.toHaveBeenCalled()
  })

  it('opens the page of the site for a page of the application only', () => {
    const trusted = setup()
    trusted.call(Channel.openProblemSite)
    expect(trusted.env.openSite).toHaveBeenCalledTimes(1)
    const stranger = setup({ trusted: false })
    stranger.call(Channel.openProblemSite)
    expect(stranger.env.openSite).not.toHaveBeenCalled()
  })
})

describe('the environment of a window group', () => {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), passwordManager: true } }
  const store = { get: () => state } as never

  function windowOf(over: Record<string, unknown> = {}) {
    return { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), ...over }
  }

  it('reads the version of the application, the extensions of the engine of its browser, its settings and the lines of the error log', () => {
    errorLog.add(['[state] cannot read /Users/jane/Library/Application Support/Lucium/state.json'])
    const extensions = [{ name: 'Dark Reader', version: '4.9', enabled: true }]
    const browser = { extensionEngine: { listAllExtensions: () => extensions } }
    const read = problemReportEnv(browser as never, store, windowOf() as never).sources()
    expect(read).toMatchObject({ appVersion: '0.2.12', platform: process.platform, arch: process.arch, extensions, settings: state.settings, components: null })
    expect(read.versions).toBe(process.versions)
    expect(read.log).toHaveLength(1)
    expect(read.log[0]).toMatch(/\[state\] cannot read state\.json$/)
  })

  it('knows the castLabs build by the components module of Electron', () => {
    electron.components = { whenReady: () => Promise.resolve(), status: () => ({}) }
    const read = problemReportEnv({ extensionEngine: { listAllExtensions: () => [] } } as never, store, windowOf() as never).sources()
    expect(read.components).toBe(electron.components)
  })

  it('puts the save dialog on the window of the sender, else on the window of the group, else on none', () => {
    const env = problemReportEnv({} as never, store, windowOf() as never)
    const own = {} as BrowserWindow
    electron.owner = own
    expect(env.owner({} as WebContents)).toBe(own)
    electron.owner = null
    expect(env.owner({} as WebContents)).not.toBeNull()
    expect(problemReportEnv({} as never, store, windowOf({ isDestroyed: () => true }) as never).owner({} as WebContents)).toBeNull()
  })

  it('opens the community page of the site in a tab, in the language of the interface, and brings the window forward', () => {
    const dispatch = vi.fn()
    const win = windowOf({ isMinimized: () => true })
    const env = problemReportEnv({ dispatch } as never, store, win as never)
    env.openSite()
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'tab/open', url: PROBLEM_SITE_URLS.fr })
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    setLanguage('en')
    env.openSite()
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'tab/open', url: PROBLEM_SITE_URLS.en })
  })

  it('opens the tab and touches no window that is gone', () => {
    const dispatch = vi.fn()
    const win = windowOf({ isDestroyed: () => true })
    problemReportEnv({ dispatch } as never, store, win as never).openSite()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })
})
