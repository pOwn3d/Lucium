// A quit the system asks for (SIGTERM from `kill` or a service manager, SIGINT and SIGHUP from a terminal, the Mac shutting down, restarting or logging
// the user out) is not ⌘Q: nobody is there to answer "Quitter Lucium ?", and a window of that question open on a shutdown keeps the Mac from
// shutting down (macOS ends by showing "Lucium empêche l'arrêt"). This module tells the rest of the application that the system is the one asking,
// saves what must survive, and makes sure the process ends: after SYSTEM_QUIT_DEADLINE_MS it is ended whatever holds the quit (a stuck window, an erasure).
// Only Node's signal and timer types are used here: Electron's `powerMonitor` and `app` are handed in.

import { SYSTEM_QUIT_DEADLINE_MS } from '@shared/quit-decision'

/** The signals that mean "end now" for a program the system or its user wants gone. */
export const QUIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export interface SystemQuitDeps {
  /** `process`: its signal handlers replace Chromium's, which would call `app.quit()` and wait for the question. */
  proc: { on(signal: NodeJS.Signals, listener: () => void): unknown; off(signal: NodeJS.Signals, listener: () => void): unknown }
  /** `powerMonitor`: its `shutdown` event is the Mac's (and Linux's) announcement of a shutdown, a restart or a logout. */
  power: { on(event: 'shutdown', listener: () => void): unknown; off(event: 'shutdown', listener: () => void): unknown }
  /** Saves what is kept in memory (state, history, downloads) and asks the application to quit. */
  quit: () => void
  /** Ends the process at once (`app.exit`), after saving again: the quit did not finish in time or could not start. */
  exit: () => void
  /** Says what happened (the log): a signal that arrived tells the user nothing, a quit that had to be forced is what is worth a line. */
  log?: (line: string) => void
}

/** What a quit writes before the process ends: the state, the history, the records of the downloads in progress, the hosts held to strict transport security. */
export interface QuitSaves {
  store: { flush(): void }
  history: { flush(): void }
  engine: { flushDownloadResume(): void; flushStrictTransport(): void }
}

/** Writes what is kept in memory: the state, the history, the records of the downloads in progress, then the hosts held to strict transport security. */
export function saveBeforeQuit({ store, history, engine }: QuitSaves): void {
  store.flush()
  history.flush()
  engine.flushDownloadResume()
  engine.flushStrictTransport()
}

/**
 * The `quit` and `exit` of the watcher in the application: both save the same, then ask the application to quit, or end the process.
 * `app.exit` emits no `will-quit`, where the copy of the session "À la fermeture" is made: `copyOnExit` makes it before the process ends,
 * after the saves (what matters most is written first). A copy that fails is said in the journal and never keeps the process alive.
 */
export function quitAndExit(saves: QuitSaves, app: { quit(): void; exit(code: number): void }, copyOnExit: () => void = () => {}): Pick<SystemQuitDeps, 'quit' | 'exit'> {
  return {
    quit: () => {
      saveBeforeQuit(saves)
      app.quit()
    },
    exit: () => {
      saveBeforeQuit(saves)
      try {
        copyOnExit()
      } catch (error) {
        console.error('[quit] the copy of the session could not be made before the forced exit:', error instanceof Error ? error.message : error)
      }
      app.exit(0)
    }
  }
}

export class SystemQuit {
  private asked = false
  private deadline: NodeJS.Timeout | null = null
  private readonly onSignal = new Map<NodeJS.Signals, () => void>()
  private readonly onShutdown = () => this.request('the system is shutting down')

  constructor(private readonly deps: SystemQuitDeps) {}

  /** Whether the system has asked to quit: the quit that follows must not wait for any answer. */
  isActive(): boolean {
    return this.asked
  }

  /** Starts listening. Called once; a second call does nothing. */
  start(): void {
    if (this.onSignal.size > 0) return
    for (const signal of QUIT_SIGNALS) {
      const listener = () => this.request(signal)
      this.onSignal.set(signal, listener)
      this.deps.proc.on(signal, listener)
    }
    this.deps.power.on('shutdown', this.onShutdown)
  }

  /** Lets go of the signals and of the power event (the engine test and the tests do not keep the process listening). */
  stop(): void {
    for (const [signal, listener] of this.onSignal) this.deps.proc.off(signal, listener)
    this.onSignal.clear()
    this.deps.power.off('shutdown', this.onShutdown)
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
  }

  /** The system asks to quit. The first request saves, quits and arms the deadline; the next ones (a second `kill`) only say so. */
  request(reason: string): void {
    if (this.asked) {
      this.deps.log?.(`[quit] asked again by the system (${reason}); the quit is already under way`)
      return
    }
    this.asked = true
    this.deps.log?.(`[quit] asked by the system (${reason}): no question, the state is saved`)
    this.deadline = setTimeout(() => this.force('the quit did not finish'), SYSTEM_QUIT_DEADLINE_MS)
    this.deadline.unref()
    try {
      this.deps.quit()
    } catch (error) {
      // The application ends all the same: a shutdown must not wait for a quit that cannot start.
      this.force(`the quit could not start: ${String((error as Error).message ?? error)}`)
    }
  }

  private force(why: string): void {
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    this.deps.log?.(`[quit] ending the process now: ${why}`)
    this.deps.exit()
  }
}
