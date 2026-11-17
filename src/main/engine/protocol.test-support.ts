// A stand-in for Electron's `Debugger`, for the tests of the protocol sessions Lucium keeps on a page (own-session.ts, inner-guard.ts).

import type { ProtocolDebugger } from './own-session'

export interface SentCommand {
  method: string
  params: unknown
  sessionId: string | undefined
}

export interface FakeDebugger extends ProtocolDebugger {
  readonly sent: SentCommand[]
  readonly calls: string[]
  /** Someone else attaches a session (an extension, a capture). */
  attachForeign(): void
  /** The session is detached from outside (DevTools, the page going). */
  lose(reason?: string): void
  /** An event of the protocol reaches the listeners. */
  emit(method: string, params: unknown, sessionId?: string): void
  /** What a command answers; the default is `{}`. Throwing rejects the command. */
  answer: (command: SentCommand) => unknown
  attachFails: Error | null
  listeners(event: 'detach' | 'message'): number
}

export function fakeDebugger(): FakeDebugger {
  let attached = false
  const heard = { detach: new Set<(...args: never[]) => void>(), message: new Set<(...args: never[]) => void>() }
  let scripts = 0
  const fake: FakeDebugger = {
    sent: [],
    calls: [],
    attachFails: null,
    answer: (command) => (command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(++scripts) } : {}),
    isAttached: () => attached,
    attach: () => {
      fake.calls.push('attach')
      if (fake.attachFails) throw fake.attachFails
      if (attached) throw new Error('Debugger is already attached to the target')
      attached = true
    },
    detach: () => {
      fake.calls.push('detach')
      attached = false
    },
    sendCommand: (method, params, sessionId) => {
      const command = { method, params, sessionId }
      fake.sent.push(command)
      if (!attached) return Promise.reject(new Error('No target available'))
      try {
        return Promise.resolve(fake.answer(command))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    on: (event: 'detach' | 'message', listener: (...args: never[]) => void) => void heard[event].add(listener),
    removeListener: (event: 'detach' | 'message', listener: (...args: never[]) => void) => void heard[event].delete(listener),
    attachForeign: () => {
      attached = true
    },
    lose: (reason = 'target closed') => {
      attached = false
      for (const listener of [...heard.detach]) (listener as (event: unknown, reason: string) => void)({}, reason)
    },
    emit: (method, params, sessionId = '') => {
      for (const listener of [...heard.message]) (listener as (event: unknown, method: string, params: unknown, sessionId: string) => void)({}, method, params, sessionId)
    },
    listeners: (event) => heard[event].size
  }
  return fake
}

/** Lets the promises already resolved run their continuations, and those these resolve in turn. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
