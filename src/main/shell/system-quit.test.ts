import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYSTEM_QUIT_DEADLINE_MS } from '@shared/quit-decision'
import { QUIT_SIGNALS, SystemQuit, quitAndExit } from './system-quit'

function setup(quit: () => void = () => {}) {
  const proc = new EventEmitter()
  const power = new EventEmitter()
  const deps = { proc, power, quit: vi.fn(quit), exit: vi.fn(), log: vi.fn() }
  return { proc, power, deps, watcher: new SystemQuit(deps) }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('SystemQuit', () => {
  it('listens to SIGTERM, SIGINT, SIGHUP and the shutdown of the system, and to nothing before start', () => {
    const { proc, power, watcher } = setup()
    expect(QUIT_SIGNALS.map((signal) => proc.listenerCount(signal))).toEqual([0, 0, 0])
    watcher.start()
    expect(QUIT_SIGNALS.map((signal) => proc.listenerCount(signal))).toEqual([1, 1, 1])
    expect(power.listenerCount('shutdown')).toBe(1)
    expect(watcher.isActive()).toBe(false)
  })

  it('quits without a question on SIGTERM: asked once, active at once', () => {
    const { proc, deps, watcher } = setup()
    watcher.start()
    proc.emit('SIGTERM')
    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(watcher.isActive()).toBe(true)
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it('is already active when the quit it asks for runs its `before-quit` listeners', () => {
    let activeDuringQuit: boolean | null = null
    const proc = new EventEmitter()
    const power = new EventEmitter()
    const watcher: SystemQuit = new SystemQuit({ proc, power, quit: () => void (activeDuringQuit = watcher.isActive()), exit: () => {} })
    watcher.start()
    proc.emit('SIGINT')
    expect(activeDuringQuit).toBe(true)
  })

  it.each(QUIT_SIGNALS)('treats %s the same way', (signal) => {
    const { proc, deps, watcher } = setup()
    watcher.start()
    proc.emit(signal)
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })

  it('quits on the shutdown, restart or logout the system announces', () => {
    const { power, deps, watcher } = setup()
    watcher.start()
    power.emit('shutdown')
    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(watcher.isActive()).toBe(true)
  })

  it('does not start the quit twice when the system insists (a second kill, a shutdown after SIGTERM) and says so in the log', () => {
    const { proc, power, deps, watcher } = setup()
    watcher.start()
    proc.emit('SIGTERM')
    proc.emit('SIGTERM')
    power.emit('shutdown')
    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(deps.log.mock.calls.filter(([line]) => String(line).includes('asked again'))).toHaveLength(2)
  })

  it('ends the process when the quit does not finish in time (a window or an erasure that holds it)', () => {
    const { proc, deps, watcher } = setup()
    watcher.start()
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(SYSTEM_QUIT_DEADLINE_MS - 1)
    expect(deps.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('ending the process now: the quit did not finish'))
  })

  it('ends the process at once when the quit cannot even start, and says why', () => {
    const { proc, deps, watcher } = setup(() => {
      throw new Error('state file locked')
    })
    watcher.start()
    expect(() => proc.emit('SIGTERM')).not.toThrow()
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('the quit could not start: state file locked'))
    // The deadline is gone with it: the process is not ended a second time.
    vi.advanceTimersByTime(SYSTEM_QUIT_DEADLINE_MS * 2)
    expect(deps.exit).toHaveBeenCalledTimes(1)
  })

  it('lets go of every listener and of the deadline when stopped (the application is quitting)', () => {
    const { proc, power, deps, watcher } = setup()
    watcher.start()
    proc.emit('SIGTERM')
    watcher.stop()
    expect(QUIT_SIGNALS.map((signal) => proc.listenerCount(signal))).toEqual([0, 0, 0])
    expect(power.listenerCount('shutdown')).toBe(0)
    vi.advanceTimersByTime(SYSTEM_QUIT_DEADLINE_MS * 2)
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it('does not add listeners again when started twice', () => {
    const { proc, power, watcher } = setup()
    watcher.start()
    watcher.start()
    expect(proc.listenerCount('SIGTERM')).toBe(1)
    expect(power.listenerCount('shutdown')).toBe(1)
  })
})

describe('quitAndExit: the quit and the forced exit of the application', () => {
  /** The saves and the application, as stand-ins that write in one journal the order of what is called. */
  function rig() {
    const journal: string[] = []
    const saves = { store: { flush: () => journal.push('state') }, history: { flush: () => journal.push('history') }, engine: { flushDownloadResume: () => journal.push('downloads'), flushStrictTransport: () => journal.push('strict hosts') } }
    const app = { quit: () => journal.push('quit'), exit: (code: number) => journal.push(`exit ${code}`) }
    return { journal, ...quitAndExit(saves, app) }
  }

  it('saves the state, the history and the downloads in progress, then asks the application to quit', () => {
    const { journal, quit } = rig()
    quit()
    expect(journal).toEqual(['state', 'history', 'downloads', 'strict hosts', 'quit'])
  })

  it('saves the same before a forced exit as before a quit, then ends the process with the code of a quit that went well', () => {
    const { journal, exit } = rig()
    exit()
    expect(journal).toEqual(['state', 'history', 'downloads', 'strict hosts', 'exit 0'])
  })

  it('makes the copy of the session before a forced exit, after the saves: the exit emits no will-quit, where the copy is made otherwise', () => {
    const journal: string[] = []
    const saves = { store: { flush: () => journal.push('state') }, history: { flush: () => journal.push('history') }, engine: { flushDownloadResume: () => journal.push('downloads'), flushStrictTransport: () => journal.push('strict hosts') } }
    const { quit, exit } = quitAndExit(saves, { quit: () => journal.push('quit'), exit: (code) => journal.push(`exit ${code}`) }, () => journal.push('copy'))
    exit()
    expect(journal).toEqual(['state', 'history', 'downloads', 'strict hosts', 'copy', 'exit 0'])
    // The quit that goes its normal way leaves the copy to will-quit.
    journal.length = 0
    quit()
    expect(journal).toEqual(['state', 'history', 'downloads', 'strict hosts', 'quit'])
  })

  it('ends the process all the same when that copy cannot be made, and says why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const journal: string[] = []
    const saves = { store: { flush: () => journal.push('state') }, history: { flush: () => undefined }, engine: { flushDownloadResume: () => undefined, flushStrictTransport: () => undefined } }
    quitAndExit(saves, { quit: () => undefined, exit: (code) => journal.push(`exit ${code}`) }, () => {
      throw new Error('disk full')
    }).exit()
    expect(journal).toEqual(['state', 'exit 0'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('copy of the session could not be made before the forced exit'), 'disk full')
    error.mockRestore()
  })

  it('is what the watcher calls: a SIGTERM saves and quits, a quit that does not finish saves again and ends the process', () => {
    const { journal, quit, exit } = rig()
    const proc = new EventEmitter()
    const watcher = new SystemQuit({ proc, power: new EventEmitter(), quit, exit })
    watcher.start()
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(SYSTEM_QUIT_DEADLINE_MS)
    expect(journal).toEqual(['state', 'history', 'downloads', 'strict hosts', 'quit', 'state', 'history', 'downloads', 'strict hosts', 'exit 0'])
    watcher.stop()
  })
})

// That main() gives the quit the real app, dialog, process and power monitor, and installs it after every other will-quit handler: main-wiring.test.ts, where main() is run.
