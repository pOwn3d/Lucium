// `window.chrome.app` of the web pages: what a large sign-in service looks for, defined as Chromium-based browsers define it, and left alone where it is not ours (the pages of extensions, a page that has it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const contextBridge = { executeInMainWorld: vi.fn() }
vi.mock('electron', () => ({ contextBridge }))

const g = globalThis as Record<string, any>
const proc = process as unknown as { contextIsolated?: boolean }
const before = { isolated: proc.contextIsolated }

/** Loads the preload as a page would, and gives back the function it handed to the main world. */
async function load(): Promise<() => void> {
  vi.resetModules()
  contextBridge.executeInMainWorld.mockReset()
  await import('./chrome-app')
  return contextBridge.executeInMainWorld.mock.calls[0]![0].func
}

/** A page at this protocol, with this `chrome` (`null`: the page has none at all). */
const page = (protocol: string, chrome: unknown = {}): void => {
  g['location'] = { protocol }
  if (chrome === null) delete g['chrome']
  else g['chrome'] = chrome
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['location']
  vi.restoreAllMocks()
})

describe('window.chrome.app', () => {
  it('is defined on the empty `chrome` of a web page, with what the extension platform puts in it', async () => {
    const run = await load()
    page('https:')
    run()
    expect(g['chrome'].app).toMatchObject({
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
    })
    expect(Object.keys(g['chrome'])).toEqual(['app'])
  })

  it('answers as a page that is not an installed app: no details, not installed, cannot run', async () => {
    const run = await load()
    page('https:')
    run()
    const { app } = g['chrome']
    expect(app.getDetails()).toBeNull()
    expect(app.getIsInstalled()).toBe(false)
    expect(app.runningState()).toBe('cannot_run')
    const state = await new Promise((resolve) => app.installState(resolve))
    expect(state).toBe('not_installed')
    expect(() => app.installState()).not.toThrow()
  })

  it('is also given to a plain http page, and a page that has no `chrome` at all gets one', async () => {
    const run = await load()
    page('http:', null)
    run()
    expect(typeof g['chrome'].app.getDetails).toBe('function')
  })

  it('is not defined in the pages of extensions, whose `chrome` is the real one', async () => {
    const run = await load()
    const real = Object.freeze({ runtime: { id: 'abc' } })
    page('chrome-extension:', real)
    run()
    expect(g['chrome']).toBe(real)
    expect('app' in g['chrome']).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('leaves a `chrome.app` the page already has', async () => {
    const run = await load()
    const own = { isInstalled: true }
    page('https:', { app: own })
    run()
    expect(g['chrome'].app).toBe(own)
  })

  it('says why when `chrome` cannot take it, and does not stop the page', async () => {
    const run = await load()
    page('https:', Object.freeze({}))
    expect(() => run()).not.toThrow()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('window.chrome.app could not be set up'), expect.any(String))
  })

  it('hands the page, in the same preload, what it reads of a permission nobody answered (permission-state.ts)', async () => {
    await load()
    const { mainWorldPermissionState, undecided } = await import('./permission-state')
    expect(contextBridge.executeInMainWorld.mock.calls[1]![0]).toEqual({ func: mainWorldPermissionState, args: [undecided] })
  })

  it('says why when the main world cannot be reached', async () => {
    vi.resetModules()
    contextBridge.executeInMainWorld.mockReset()
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('no main world')
    })
    await expect(import('./chrome-app')).resolves.toBeDefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be reached in the page'), 'no main world')
  })
})

describe('a document without context isolation (an offscreen document of an extension)', () => {
  // Electron refuses `contextBridge` there, in these words: the preload used to say so on the console of the page, one line for each of its two calls.
  const refuse = (): void => {
    vi.resetModules()
    contextBridge.executeInMainWorld.mockReset()
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('contextBridge API can only be used when contextIsolation is enabled')
    })
  }

  it('stays out: no call to contextBridge for `chrome.app` nor for the state of the permissions, and no line on the console', async () => {
    proc.contextIsolated = false
    refuse()
    await import('./chrome-app')
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('keeps both in a page that has isolation, a tab', async () => {
    proc.contextIsolated = true
    await load()
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(2)
  })

  it('still tries where the renderer does not say (no `contextIsolated` at all), and says why when Electron refuses', async () => {
    proc.contextIsolated = undefined
    refuse()
    await import('./chrome-app')
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be reached in the page'), 'contextBridge API can only be used when contextIsolation is enabled')
  })
})
