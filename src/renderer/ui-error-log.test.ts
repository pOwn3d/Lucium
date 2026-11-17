// The log of the errors nothing caught in a page of the interface: what an `error` event says when it carries no error. The engine hands `null`
// for an error it does not show (the loop of a `ResizeObserver`, a script of another origin); the log wrote « null » then, and the message was lost.

import { describe, expect, it, vi } from 'vitest'
import { describeErrorEvent, installUiErrorLog } from './ui-error-log'

/** An `error` event as the engine sends it: its message, its place, and what it carries as `error`. */
const errorEvent = (fields: { message?: string; filename?: string; lineno?: number; error?: unknown }): Event => Object.assign(new Event('error'), fields)

/** The detail of the one line the log wrote for each event sent to the page. */
function logged(...events: Event[]): string[] {
  const target = new EventTarget()
  const log = vi.fn()
  installUiErrorLog(target, log)
  for (const event of events) target.dispatchEvent(event)
  return log.mock.calls.map((call) => String(call[1]))
}

describe('an error event that carries no error', () => {
  it('keeps the message of the event and the place it names when the engine gives `null`', () => {
    const [loop, foreign] = logged(
      errorEvent({ message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', lineno: 0, error: null }),
      errorEvent({ message: 'Script error.', filename: 'https://cdn.example/widget.js', lineno: 3, error: null })
    )
    expect(loop).toBe('ResizeObserver loop completed with undelivered notifications. (?:0)')
    expect(foreign).toBe('Script error. (https://cdn.example/widget.js:3)')
  })

  it('keeps the message when the value thrown is not an error, and adds the value only when the message does not say it', () => {
    const [text, object] = logged(
      errorEvent({ message: 'Uncaught boom', filename: 'index.js', lineno: 9, error: 'boom' }),
      errorEvent({ message: 'Uncaught [object Object]', filename: 'index.js', lineno: 12, error: { code: 7 } })
    )
    expect(text).toBe('Uncaught boom (index.js:9)')
    expect(object).toBe('Uncaught [object Object] (index.js:12): {"code":7}')
  })

  it('still writes the stack of an error it carries, which says more than the message and the place', () => {
    const error = new Error('a click handler failed')
    const [line] = logged(errorEvent({ message: 'Uncaught Error: a click handler failed', filename: 'index.js', lineno: 4, error }))
    expect(line).toBe(error.stack)
  })
})

describe('an error event that cannot be read', () => {
  // A page cannot hand such an event to the listener of the interface; the log must not fail on one all the same: it is the last word of the page.
  const unreadable = (): Partial<ErrorEvent> =>
    Object.defineProperty({ error: null }, 'message', {
      get() {
        throw new Error('no message here')
      }
    }) as Partial<ErrorEvent>

  it('is written as an event that cannot be read, with why, and the log does not throw', () => {
    expect(() => describeErrorEvent(unreadable())).not.toThrow()
    expect(describeErrorEvent(unreadable())).toMatch(/^\(an error event that cannot be read: Error: no message here/)
    const listeners: Array<(event: Event) => void> = []
    const log = vi.fn()
    installUiErrorLog({ addEventListener: (type: string, listener: unknown) => void (type === 'error' && listeners.push(listener as (event: Event) => void)) }, log)
    expect(() => listeners[0]!(unreadable() as Event)).not.toThrow()
    expect(log).toHaveBeenCalledWith('[ui] an error was not caught:', expect.stringContaining('an error event that cannot be read'))
  })
})
