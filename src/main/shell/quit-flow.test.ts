// The quit installed by main() (shell/quit-flow.ts), run on a stand-in of Electron's `app` that calls the handlers in the order they were
// registered, as Electron does: the order is the point.

import { SYSTEM_QUIT_DEADLINE_MS } from '@shared/quit-decision'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { QUIT_CLEAR_TIMEOUT_MS, installQuitFlow, prepareQuitForUpdate, type QuitFlowDeps } from './quit-flow'
import { UpdateInstaller } from './app-update'

vi.mock('electron', () => ({ autoUpdater: {}, BrowserWindow: {}, dialog: {}, shell: {} }))

type Handler = (event: { preventDefault(): void; defaultPrevented: boolean }) => void

function setup(options: { warn?: boolean; clearOnQuit?: boolean; smoke?: boolean; answer?: { response: number; checkboxChecked?: boolean }; clear?: () => Promise<string[]> } = {}) {
  const calls: string[] = []
  const handlers: Record<string, Handler[]> = { 'before-quit': [], 'will-quit': [] }
  const app = {
    on: (name: string, handler: Handler) => handlers[name]!.push(handler),
    quit: () => calls.push('app.quit'),
    exit: (code: number) => calls.push(`app.exit ${code}`)
  }
  /** Emits an event as Electron does: one event object, every handler in order; answers whether one of them held the quit. */
  const emit = (name: 'before-quit' | 'will-quit'): boolean => {
    const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) }
    for (const handler of handlers[name]!) handler(event)
    return event.defaultPrevented
  }
  const signals = new Map<string, () => void>()
  const proc = { on: (signal: string, listener: () => void) => signals.set(signal, listener), off: (signal: string) => signals.delete(signal) }
  const power = { on: vi.fn(), off: vi.fn() }
  let state: SidebarState = createInitialState({ now: 1, newId: () => 'x' })
  state = { ...state, settings: { ...state.settings, warnBeforeQuitting: options.warn ?? true, siteDataClearOnCloseEnabled: true, siteDataClearOnClose: options.clearOnQuit ? ['shop.example'] : [], siteDataClearOnQuit: options.clearOnQuit ?? false } }
  const store = { get: () => state, flush: () => calls.push('store.flush'), dispatch: vi.fn() }
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }
  const windowManager = {
    list: () => [{ id: 'main', win, browser: { snapshot: () => ({ downloads: [] }) } }],
    privateWindows: () => [],
    focused: () => ({ id: 'main' }),
    markQuitting: () => calls.push('markQuitting')
  }
  const dialog = { showMessageBox: vi.fn(async () => options.answer ?? { response: 1, checkboxChecked: false }) }
  let confirmed = false
  const marker = join(mkdtempSync(join(tmpdir(), 'quit-flow-')), 'clear-on-quit.pending')
  const clear = vi.fn(options.clear ?? (async () => []))
  const deps = {
    app,
    dialog,
    proc,
    power,
    store,
    history: { flush: () => calls.push('history.flush') },
    engine: { flushDownloadResume: () => calls.push('engine.flushDownloadResume'), flushStrictTransport: () => calls.push('engine.flushStrictTransport') },
    windowManager,
    browser: { clearSitesOnQuit: clear },
    smoke: options.smoke ?? false,
    quitClearMarker: marker,
    copyOnExit: () => calls.push('copyOnExit'),
    confirmed: () => confirmed,
    confirm: () => {
      confirmed = true
      calls.push('confirm')
    }
  } as unknown as QuitFlowDeps
  const systemQuit = installQuitFlow(deps)
  return { calls, handlers, emit, signals, power, store, dialog, marker, clear, systemQuit, deps, isConfirmed: () => confirmed }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the quit main() installs', () => {
  it('starts the watch of a quit the system asks for on the real signals and the shutdown of the system, and lets go of them on will-quit', () => {
    const t = setup()
    expect([...t.signals.keys()]).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP'])
    expect(t.power.on).toHaveBeenCalledWith('shutdown', expect.any(Function))
    t.emit('will-quit')
    expect(t.signals.size).toBe(0)
    expect(t.power.off).toHaveBeenCalledWith('shutdown', expect.any(Function))
  })

  it('writes the state, the history and the hosts held to strict transport security once more on will-quit, after the watch is let go', () => {
    const t = setup()
    expect(t.handlers['will-quit']).toHaveLength(2)
    t.emit('will-quit')
    expect(t.calls).toEqual(['store.flush', 'history.flush', 'engine.flushStrictTransport'])
  })

  it('a quit of the system that does not finish in time saves again, makes the copy of the session, and ends the process', () => {
    vi.useFakeTimers()
    const t = setup()
    t.signals.get('SIGTERM')!()
    t.calls.length = 0
    vi.advanceTimersByTime(SYSTEM_QUIT_DEADLINE_MS)
    expect(t.calls).toEqual(['store.flush', 'history.flush', 'engine.flushDownloadResume', 'engine.flushStrictTransport', 'copyOnExit', 'app.exit 0'])
    t.systemQuit.stop()
  })

  it('a signal of the system saves everything and quits without any question', () => {
    const t = setup()
    t.signals.get('SIGTERM')!()
    expect(t.calls).toEqual(['store.flush', 'history.flush', 'engine.flushDownloadResume', 'engine.flushStrictTransport', 'app.quit'])
    expect(t.emit('before-quit')).toBe(false)
    expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(t.calls.at(-1)).toBe('markQuitting')
    t.systemQuit.stop()
  })

  it('asks "Quitter Lucium ?" once, holds the quit meanwhile, and quits on the answer Quitter', async () => {
    const t = setup({ answer: { response: 0, checkboxChecked: true } })
    expect(t.emit('before-quit')).toBe(true)
    // A second ⌘Q while the question is open asks nothing more.
    expect(t.emit('before-quit')).toBe(true)
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(t.calls).toContain('app.quit'))
    expect(t.calls).toEqual(['confirm', 'app.quit'])
    expect(t.store.dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { warnBeforeQuitting: false } })
    // The quit that follows goes ahead.
    expect(t.emit('before-quit')).toBe(false)
    expect(t.calls.at(-1)).toBe('markQuitting')
  })

  it('stays open on the answer Annuler, and asks again at the next quit', async () => {
    const t = setup({ answer: { response: 1 } })
    t.emit('before-quit')
    await vi.waitFor(() => expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.calls).toEqual([])
    t.emit('before-quit')
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('does not erase the sites while the question holds the quit: the erasure handler comes after it and sees the quit held', () => {
    const t = setup({ clearOnQuit: true })
    t.emit('before-quit')
    expect(t.clear).not.toHaveBeenCalled()
    expect(existsSync(t.marker)).toBe(false)
  })

  it('erases the listed sites before quitting, with a marker that stays until the erasure is whole', async () => {
    let finish: (failed: string[]) => void = () => undefined
    const t = setup({ warn: false, clearOnQuit: true, clear: () => new Promise((resolve) => (finish = resolve)) })
    expect(t.emit('before-quit')).toBe(true)
    expect(t.clear).toHaveBeenCalledTimes(1)
    expect(existsSync(t.marker)).toBe(true)
    finish([])
    await vi.waitFor(() => expect(t.calls).toContain('app.quit'))
    expect(existsSync(t.marker)).toBe(false)
    expect(t.isConfirmed()).toBe(true)
    // The quit that follows is not held again.
    expect(t.emit('before-quit')).toBe(false)
    expect(t.clear).toHaveBeenCalledTimes(1)
  })

  it('quits all the same when the erasure fails, says so, and leaves the marker for the next launch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ warn: false, clearOnQuit: true, clear: async () => Promise.reject(new Error('boom')) })
    t.emit('before-quit')
    await vi.waitFor(() => expect(t.calls).toContain('app.quit'))
    expect(error).toHaveBeenCalledWith('[quit] cannot erase the data of the listed sites:', expect.any(Error))
    expect(existsSync(t.marker)).toBe(true)
  })

  it(`does not wait more than ${QUIT_CLEAR_TIMEOUT_MS / 1000} s for a site that does not answer`, async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ warn: false, clearOnQuit: true, clear: () => new Promise(() => undefined) })
    t.emit('before-quit')
    await vi.advanceTimersByTimeAsync(QUIT_CLEAR_TIMEOUT_MS - 1)
    expect(t.calls).not.toContain('app.quit')
    await vi.advanceTimersByTimeAsync(1)
    expect(t.calls).toContain('app.quit')
    expect(error).toHaveBeenCalledWith('[quit] the data of some sites was not erased before quitting:', '(délai dépassé)')
  })

  it('does not hold a quit the system asks for to erase the sites: the marker is written and the next launch erases', () => {
    const t = setup({ clearOnQuit: true })
    t.signals.get('SIGTERM')!()
    expect(t.emit('before-quit')).toBe(false)
    expect(t.clear).not.toHaveBeenCalled()
    expect(existsSync(t.marker)).toBe(true)
    t.systemQuit.stop()
  })

  it('erases nothing in an engine test run', () => {
    const t = setup({ warn: false, clearOnQuit: true, smoke: true })
    expect(t.emit('before-quit')).toBe(false)
    expect(t.clear).not.toHaveBeenCalled()
  })
})

describe('the quit of « Installer et relancer » (autoUpdater.quitAndInstall)', () => {
  it('confirms the quit, marks the windows as closing for it and writes the state, before the windows close', () => {
    const t = setup({ warn: true })
    prepareQuitForUpdate(t.deps)
    expect(t.calls).toEqual(['confirm', 'markQuitting', 'store.flush', 'history.flush', 'engine.flushDownloadResume', 'engine.flushStrictTransport'])
    // `before-quit` comes after the windows closed: "Avertir avant de quitter" no longer holds it, and no box is hung from a window that is gone.
    expect(t.emit('before-quit')).toBe(false)
    expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('is what Electron’s before-quit-for-update runs, through the installer: the restart is not held by any question', () => {
    const t = setup({ warn: true })
    const updater = Object.assign(new EventEmitter(), {
      setFeedURL: () => undefined,
      checkForUpdates: () => undefined,
      quitAndInstall: () => void updater.emit('before-quit-for-update')
    })
    const installer = new UpdateInstaller({ feed: () => 'https://test.lucium.app/updates/darwin-arm64/feed.json', updater: () => updater, prepareQuit: () => prepareQuitForUpdate(t.deps), report: vi.fn() })
    void installer.download()
    updater.emit('update-downloaded')
    expect(t.isConfirmed()).toBe(false)
    installer.restart()
    expect(t.isConfirmed()).toBe(true)
    expect(t.emit('before-quit')).toBe(false)
  })

  it('still erases the sites listed for the quit, then quits by itself', async () => {
    vi.useFakeTimers()
    const t = setup({ warn: true, clearOnQuit: true })
    prepareQuitForUpdate(t.deps)
    expect(t.emit('before-quit')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.clear).toHaveBeenCalledOnce()
    expect(t.calls).toContain('app.quit')
  })
})
