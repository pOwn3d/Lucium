// The check of the feed before the quit installs a downloaded update (update-quit-check.ts), with the quit, the installer and the feed given by
// the test: when the quit is held, what is dropped and kept for the next launch, and that the quit always goes on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DropOutcome } from '@shared/auto-update'
import { installPrepareBeforeQuit, installUpdateQuitCheck, UPDATE_QUIT_CHECK_MS, type UpdateQuitCheckDeps } from './update-quit-check'

afterEach(() => vi.useRealTimers())

type QuitEvent = { defaultPrevented: boolean; preventDefault(): void }

/** The application as the check sees it: the handlers of `before-quit`, and the quits asked. */
function application(over: Partial<UpdateQuitCheckDeps> & { ready?: boolean; installing?: boolean; drop?: (withdrawn: readonly string[]) => Promise<DropOutcome> } = {}) {
  const handlers: Array<(event: QuitEvent) => void> = []
  const quits = vi.fn()
  const remembered: string[] = []
  const logs: string[] = []
  const confirm = vi.fn()
  const drop = vi.fn(over.drop ?? (async (withdrawn: readonly string[]): Promise<DropOutcome> => (withdrawn.includes('0.2.2') ? { kind: 'dropped', version: '0.2.2' } : { kind: 'kept' })))
  installUpdateQuitCheck({
    app: { on: ((name: string, handler: (event: QuitEvent) => void) => (name === 'before-quit' && handlers.push(handler), undefined)) as never, quit: quits },
    installer: () => ({ isReady: () => over.ready ?? true, isInstalling: () => over.installing ?? false, dropWithdrawn: drop }),
    allowed: over.allowed ?? (() => true),
    withdrawn: over.withdrawn ?? (async () => ['0.2.2']),
    remember: (version) => void remembered.push(version),
    system: over.system ?? (() => false),
    confirm,
    log: (line) => void logs.push(line),
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {})
  })
  /** One `before-quit`; `held` by a handler of the quit flow before this one. */
  const quit = (held = false): QuitEvent => {
    const event = { defaultPrevented: held, preventDefault: () => void (event.defaultPrevented = true) }
    for (const handler of handlers) handler(event)
    return event
  }
  const settled = () => vi.waitFor(() => expect(quits).toHaveBeenCalled())
  return { quit, quits, remembered, logs, confirm, drop, settled }
}

describe('the quit with a downloaded update that waits', () => {
  it('is held while the feed is read, drops the update the feed now lists as withdrawn, keeps it for the next launch to tell, and quits', async () => {
    const app = application()
    expect(app.quit().defaultPrevented).toBe(true)
    await app.settled()
    expect(app.drop).toHaveBeenCalledWith(['0.2.2'])
    expect(app.remembered).toEqual(['0.2.2'])
    // The quit starts again without its question, and this time goes through.
    expect(app.confirm).toHaveBeenCalledOnce()
    expect(app.quit().defaultPrevented).toBe(false)
    expect(app.drop).toHaveBeenCalledOnce()
  })

  it('quits with the update in place when the feed does not list it', async () => {
    const app = application({ withdrawn: async () => ['0.2.0'] })
    app.quit()
    await app.settled()
    expect(app.remembered).toEqual([])
  })

  it('quits with the update in place, and says why in the log, when the feed cannot be read, does not answer in time, or the check fails', async () => {
    const unread = application({ withdrawn: async () => null })
    unread.quit()
    await unread.settled()
    expect(unread.drop).not.toHaveBeenCalled()
    expect(unread.logs).toEqual([expect.stringContaining('no valid answer')])

    vi.useFakeTimers()
    const late = application({ withdrawn: () => new Promise(() => undefined) })
    late.quit()
    await vi.advanceTimersByTimeAsync(UPDATE_QUIT_CHECK_MS)
    expect(late.quits).toHaveBeenCalledOnce()
    expect(late.logs).toEqual([expect.stringContaining('no answer in time')])
    vi.useRealTimers()

    const broken = application({ drop: () => Promise.reject(new Error('the disk is gone')) })
    broken.quit()
    await broken.settled()
    expect(broken.logs).toEqual([expect.stringContaining('could not be checked before quitting: the disk is gone')])
    expect(broken.remembered).toEqual([])
  })

  it('does not tell the next launch of a drop that failed: Squirrel may install it, and the running version is then told it was withdrawn', async () => {
    const app = application({ drop: async () => ({ kind: 'failed', version: '0.2.2' }) })
    app.quit()
    await app.settled()
    expect(app.remembered).toEqual([])
  })

  it('holds nothing without an update that waits, for « Installer et relancer », for a quit the system asks, with the automatic check off, or while the quit flow holds it', () => {
    for (const app of [application({ ready: false }), application({ installing: true }), application({ system: () => true })]) {
      expect(app.quit().defaultPrevented).toBe(false)
      expect(app.quits).not.toHaveBeenCalled()
    }
    // « Rechercher les mises à jour automatiquement » off: no request by itself, this one included, and the log says so.
    const off = application({ allowed: () => false })
    expect(off.quit().defaultPrevented).toBe(false)
    expect(off.drop).not.toHaveBeenCalled()
    expect(off.logs).toEqual([expect.stringContaining('is off')])
    // Held by the question or the erasure of the quit flow: the check waits for the quit that follows.
    const held = application()
    held.quit(true)
    expect(held.drop).not.toHaveBeenCalled()
    expect(held.quit().defaultPrevented).toBe(true)
  })
})

describe('the quit that installs a downloaded update: what must be done before Squirrel replaces the application', () => {
  /** The quit with the look at the feed, then the preparation, installed in this order as main() does. */
  function quitting(over: { ready?: boolean; installing?: boolean; system?: () => boolean; allowed?: () => boolean; withdrawn?: () => Promise<readonly string[] | null>; prepare?: () => Promise<void> } = {}) {
    const handlers: Array<(event: QuitEvent) => void> = []
    const quits = vi.fn()
    const logs: string[] = []
    const order: string[] = []
    let ready = over.ready ?? true
    const prepare = vi.fn(over.prepare ?? (async () => void order.push('prepare')))
    const installer = {
      isReady: () => ready,
      isInstalling: () => over.installing ?? false,
      dropWithdrawn: async (withdrawn: readonly string[]): Promise<DropOutcome> => {
        order.push('look')
        if (!withdrawn.includes('1.0.2')) return { kind: 'kept' }
        ready = false
        return { kind: 'dropped', version: '1.0.2' }
      },
      prepareInstall: prepare
    }
    const app = { on: ((name: string, handler: (event: QuitEvent) => void) => (name === 'before-quit' && handlers.push(handler), undefined)) as never, quit: quits }
    const common = { app, installer: () => installer, system: over.system ?? (() => false), confirm: vi.fn(), log: (line: string) => void logs.push(line) }
    installUpdateQuitCheck({ ...common, allowed: over.allowed ?? (() => true), withdrawn: over.withdrawn ?? (async () => ['0.9.0']), remember: () => undefined })
    installPrepareBeforeQuit(common)
    /** One `before-quit` through every handler, as Electron emits it; a quit a handler asks starts over, as app.quit() does. */
    const quit = (): QuitEvent => {
      const event = { defaultPrevented: false, preventDefault: () => void (event.defaultPrevented = true) }
      for (const handler of handlers) handler(event)
      return event
    }
    quits.mockImplementation(() => void quit())
    return { quit, quits, prepare, logs, order, confirm: common.confirm }
  }

  it('is done after the look at the feed, before the process ends, and the quit goes on', async () => {
    const q = quitting()
    expect(q.quit().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(q.quits).toHaveBeenCalledTimes(2))
    expect(q.order).toEqual(['look', 'prepare'])
    expect(q.prepare).toHaveBeenCalledOnce()
    expect(q.confirm).toHaveBeenCalledTimes(2)
  })

  it('is done too with the automatic check off, which reads no feed', async () => {
    const q = quitting({ allowed: () => false })
    expect(q.quit().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(q.quits).toHaveBeenCalledOnce())
    expect(q.order).toEqual(['prepare'])
  })

  it('is not done for an update the feed withdrew meanwhile, which is not installed', async () => {
    const q = quitting({ withdrawn: async () => ['1.0.2'] })
    q.quit()
    await vi.waitFor(() => expect(q.quits).toHaveBeenCalledOnce())
    expect(q.order).toEqual(['look'])
    expect(q.prepare).not.toHaveBeenCalled()
  })

  it('holds nothing without an update that waits, for « Installer et relancer » (it did it before quitting), or for a quit the system asks', () => {
    for (const q of [quitting({ ready: false }), quitting({ installing: true }), quitting({ system: () => true })]) {
      expect(q.quit().defaultPrevented).toBe(false)
      expect(q.prepare).not.toHaveBeenCalled()
    }
  })

  it('lets the quit go on, with a line in the log, when the preparation fails', async () => {
    const q = quitting({ allowed: () => false, prepare: () => Promise.reject(new Error('the bundle is gone')) })
    q.quit()
    await vi.waitFor(() => expect(q.quits).toHaveBeenCalledOnce())
    expect(q.logs).toContain('[update] the application could not be prepared for the installation before quitting: the bundle is gone')
  })
})
