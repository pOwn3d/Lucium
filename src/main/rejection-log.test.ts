import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { EXCEPTIONS_LOGGED_MAX, REJECTIONS_LOGGED_MAX, describeReason, logUncaughtExceptions, logUnhandledRejections } from './rejection-log'

function rig() {
  const source = new EventEmitter()
  const log = vi.fn()
  const seen = logUnhandledRejections(source, log, () => 12.4)
  return { reject: (reason: unknown) => source.emit('unhandledRejection', reason), log, seen, source }
}

describe('the net for a promise nobody handles', () => {
  it('writes the failure with its stack and the time since launch, and does not throw', () => {
    const { reject, log, seen } = rig()
    const error = new Error('the disk is gone')
    // A stack of its own: the real one holds the paths of the test runner, whose length is not this test's to depend on (a long reason is cut, see below).
    error.stack = 'Error: the disk is gone\n    at save (/app/store.js:12:3)\n    at flush (/app/store.js:40:5)'
    expect(() => reject(error)).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    const [line, detail] = log.mock.calls[0]!
    expect(line).toContain('[main]')
    expect(line).toContain('12 s after launch')
    expect(detail).toContain('the disk is gone')
    expect(detail).toBe(error.stack)
    expect(seen()).toBe(1)
  })

  it('takes whatever was thrown: a text, an object, nothing, an object that cannot be written', () => {
    const { reject, log } = rig()
    reject('plain text')
    reject({ code: 'EACCES' })
    reject(undefined)
    reject(Object.create(null))
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    reject(cycle)
    const details = log.mock.calls.map((call) => call[1] as string)
    expect(details[0]).toBe('plain text')
    expect(details[1]).toBe('{"code":"EACCES"}')
    expect(details[2]).toBe('undefined')
    expect(details[3]).toBe('{}')
    expect(details[4]).toContain('cannot be written')
  })

  it('writes the first ones, then says once that it stops, and goes on counting', () => {
    const { reject, log, seen } = rig()
    for (let i = 0; i < REJECTIONS_LOGGED_MAX + 50; i++) reject(new Error(`n${i}`))
    expect(log).toHaveBeenCalledTimes(REJECTIONS_LOGGED_MAX + 1)
    expect(log.mock.calls.at(-1)![0]).toContain('are not written')
    expect(seen()).toBe(REJECTIONS_LOGGED_MAX + 50)
  })

  it('keeps a huge reason to a few lines', () => {
    expect(describeReason('x'.repeat(100_000)).length).toBeLessThan(2100)
  })

  it('is what Node calls on the real process for a rejection left alone', () => {
    // The runner of the tests listens too: it is set aside while the real process is told, so that it does not count this one as a failure.
    const runner = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    try {
      const log = vi.fn()
      const seen = logUnhandledRejections(process, log)
      process.emit('unhandledRejection', new Error('left alone'), Promise.resolve())
      expect(log).toHaveBeenCalledTimes(1)
      expect(seen()).toBe(1)
    } finally {
      process.removeAllListeners('unhandledRejection')
      for (const listener of runner) process.on('unhandledRejection', listener)
    }
  })
})

describe('the net for an exception nothing caught', () => {
  function rig() {
    const source = new EventEmitter()
    const log = vi.fn()
    const first = vi.fn()
    const seen = logUncaughtExceptions(source, log, () => 30.2, first)
    return { raise: (error: unknown) => source.emit('uncaughtException', error), log, first, seen }
  }

  it('writes the exception with its stack and goes on: nothing is thrown again, the application is not quit', () => {
    const { raise, log, seen } = rig()
    const error = new TypeError('Object has been destroyed')
    error.stack = 'TypeError: Object has been destroyed\n    at send (/app/window.js:7:9)'
    expect(() => raise(error)).not.toThrow()
    const [line, detail] = log.mock.calls[0]!
    expect(line).toContain('[main] an exception was not caught')
    expect(line).toContain('30 s after launch')
    expect(detail).toBe(error.stack)
    expect(seen()).toBe(1)
  })

  it('writes through the console as it is at the time of the line, so that the log of État de Lucium (which wraps it later) gets it', () => {
    const source = new EventEmitter()
    logUncaughtExceptions(source)
    const wrapped = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    source.emit('uncaughtException', new Error('late console'))
    expect(wrapped).toHaveBeenCalledTimes(1)
  })

  it('tells the user once, at the first one, and writes a notice that fails instead of throwing it', () => {
    const { raise, log, first } = rig()
    first.mockImplementationOnce(() => {
      throw new Error('no window yet')
    })
    raise(new Error('one'))
    raise(new Error('two'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining('n° 1'), '[main] the notice of an uncaught exception could not be shown:', expect.stringContaining('n° 2')])
  })

  it('writes the first ones, then says once that it stops, and goes on counting', () => {
    const { raise, log, seen } = rig()
    for (let i = 0; i < EXCEPTIONS_LOGGED_MAX + 20; i++) raise(new Error(`n${i}`))
    expect(log).toHaveBeenCalledTimes(EXCEPTIONS_LOGGED_MAX + 1)
    expect(log.mock.calls.at(-1)![0]).toContain('are not written')
    expect(seen()).toBe(EXCEPTIONS_LOGGED_MAX + 20)
  })
})

// That the main process installs the net outside the engine test only (and keeps ending on the first exception inside it): main-wiring.test.ts, where main() is run.
