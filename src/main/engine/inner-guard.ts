// The fingerprint protection of what is inside a page: its frames and its dedicated workers. Electron loads the preload of the page guard into
// the main frame only and has no preload for a dedicated worker, so they are reached as DevTools reaches them, through the protocol session
// Lucium keeps on the page (own-session.ts):
//
//  - `Page.addScriptToEvaluateOnNewDocument` registers the guard for every document of the page's process (a frame of the same site, an
//    `about:blank` or `srcdoc` one); the script does nothing in the page itself, which the preload serves (shared/inner-guard.ts). Chromium
//    runs these scripts only while the Page domain is on (`Page.enable`): without it they are registered, answered, and never run;
//  - `Target.setAutoAttach` with `waitForDebuggerOnStart` hands over each frame of another site (it lives in another process) and each
//    dedicated worker before it runs a line: a frame is given the same script, a worker evaluates the guard, and both are then let go.
//
// What it costs, and what it is kept from costing:
//  - nothing while the protection is off: no session is attached, and the one attached is detached when the protection goes off;
//  - one round trip to this process at the start of each frame of another site and of each worker; whatever fails here, they are always let go;
//  - the events of the Page domain (a frame that loads, navigates, stops), which reach this process and are not read;
//  - a session that is someone else's (an extension that debugs the page) is never taken: ours steps aside for it and comes back afterwards
//    (`stepAside`, `refresh`). While it is away the frames and the workers of that page are not protected; the page itself still is.
// Service workers are not served here (the engine registers the preload for them) and shared workers cannot be (the guard takes their
// constructor away from a protected document). Electron-free: the page hands in its debugger, so the rules are tested with a stand-in.

import { frameGuardSource, workerConfig, workerGuardSource, type InnerTable } from '@shared/inner-guard'
import type { OwnSession, ProtocolDebugger } from './own-session'

export interface InnerGuardDeps {
  debugger: ProtocolDebugger
  session: OwnSession
  /** The text of the guard function (src/preload/guard-world.ts), as it is run in a document. */
  guardText: string
  /** False once the page is gone: nothing is sent to it. */
  alive(): boolean
  /** A failure, with what was being done: logged by the engine, never swallowed. */
  warn(what: string, error: unknown): void
}

const USER = 'inner-guard'

/** Frames of another site and workers are held at their start; service workers are left out (an attached session would keep one alive for ever). */
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'service_worker', exclude: true }, { type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}]
} as const

/** The script of one protocol session (the page's own is ''): the one registered, its identifier once the session answered, and the one asked for meanwhile. */
interface Registered {
  source: string | null
  identifier: string | null
  /** An add the session has not answered yet: the identifier of the script it replaces is not known before. */
  adding: boolean
  /** The script asked for while an add was under way: put in once that add is answered. */
  next: string | null
}

export class InnerGuard {
  private table: InnerTable | null = null
  private engaged = false
  private readonly registered = new Map<string, Registered>()
  /** The sessions of the frames and workers handed over and not gone yet: a command that fails in one of them is worth a line, in one that went it is not. */
  private readonly children = new Set<string>()

  private readonly onMessage = (_event: unknown, method: string, params: unknown, sessionId: string): void => {
    if (method === 'Target.attachedToTarget') this.attached(params, sessionId)
    else if (method === 'Target.detachedFromTarget') {
      const gone = String((params as { sessionId?: unknown } | null)?.sessionId ?? '')
      this.registered.delete(gone)
      this.children.delete(gone)
    }
  }

  /** Our session was detached from outside (DevTools, the page going): forgotten, and attached again at the next document of the page. */
  private readonly onDetach = (): void => {
    if (this.engaged) this.forget()
  }

  constructor(private readonly deps: InnerGuardDeps) {}

  /** What the frames and the workers of the page get from now on; `null` when they get nothing (the session goes). */
  set(table: InnerTable | null): void {
    this.table = table
    if (table === null) this.drop()
    else this.engage()
  }

  /** A session that was not free earlier is tried again. Nothing while nothing is asked. */
  refresh(): void {
    if (this.table !== null) this.engage()
  }

  /** An extension is about to attach its own session: ours leaves the page to it (what is asked stays asked, `refresh` brings it back). */
  stepAside(): void {
    this.drop()
  }

  /** Whether the session is on (the engine test reads it). */
  get on(): boolean {
    return this.engaged
  }

  private engage(): void {
    if (this.table === null || !this.deps.alive()) return
    if (!this.engaged) {
      try {
        // Someone else's session (an extension's, a capture): not ours to take. Tried again at the next document.
        if (!this.deps.session.acquire(USER)) return
      } catch (error) {
        this.deps.warn('cannot attach the session that protects the frames and the workers of the page', error)
        return
      }
      this.engaged = true
      this.deps.debugger.on('message', this.onMessage)
      this.deps.debugger.on('detach', this.onDetach)
      this.registered.set('', { source: null, identifier: null, adding: false, next: null })
      void this.send('', 'Target.setAutoAttach', AUTO_ATTACH)
      // The scripts to run in each new document are run only while the Page domain is on: without it they are registered and never run.
      void this.send('', 'Page.enable')
    }
    for (const sessionId of this.registered.keys()) this.register(sessionId)
  }

  /**
   * Puts the script of the moment in a session. Nothing while no page is known yet: the main frame asks for its plan before any script of its
   * document runs, and the script of that page is registered then (a script registered earlier would still be there when the frames start).
   */
  private register(sessionId: string): void {
    const entry = this.registered.get(sessionId)
    if (!entry || this.table === null || this.table.current === null) return
    const source = frameGuardSource(this.deps.guardText, this.table)
    if (entry.adding) {
      entry.next = source === entry.source ? null : source
      return
    }
    // Most documents change nothing (the same page, the same strength): nothing is sent then.
    if (entry.source !== source) this.replace(sessionId, entry, source)
  }

  /**
   * Adds `source` and takes the script it replaces out with the very next command: the renderer reads the two in order, so a document starts with one
   * of them, never with neither and never with both (with both, the guard would be installed twice, and a stale table would protect the frames of a
   * site left out). The identifier of the script replaced must be known for that: a change that comes before the session answered waits for it.
   */
  private replace(sessionId: string, entry: Registered, source: string): void {
    const previous = entry.identifier
    entry.source = source
    entry.identifier = null
    entry.adding = true
    // Sent now: a frame held at its start is let go by a command sent after this one, and must find its script registered.
    const adding = this.send(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source })
    if (previous !== null) void this.send(sessionId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: previous })
    void adding.then((added) => {
      if (this.registered.get(sessionId) !== entry) return
      entry.adding = false
      const identifier = (added as { identifier?: unknown } | undefined)?.identifier
      if (typeof identifier === 'string') entry.identifier = identifier
      // Not registered: the next document asks again instead of believing it is there.
      else entry.source = null
      const next = entry.next
      entry.next = null
      if (next !== null && next !== entry.source) this.replace(sessionId, entry, next)
    })
  }

  /** A frame of another site or a worker is waiting at its start: it is given the guard, then let go, whatever happened before. */
  private attached(params: unknown, parent: string): void {
    const p = (params ?? {}) as { sessionId?: unknown; targetInfo?: { type?: unknown } }
    if (typeof p.sessionId !== 'string') return
    const child = p.sessionId
    const type = p.targetInfo?.type
    let kept = false
    this.children.add(child)
    try {
      if (type === 'iframe') {
        this.registered.set(child, { source: null, identifier: null, adding: false, next: null })
        void this.send(child, 'Page.enable')
        this.register(child)
        void this.send(child, 'Target.setAutoAttach', AUTO_ATTACH)
        kept = true
      } else if (type === 'worker' && this.table !== null) {
        const config = workerConfig(this.table)
        if (config) {
          void this.send(child, 'Runtime.evaluate', { expression: workerGuardSource(this.deps.guardText, config) }).then((result) => {
            const thrown = (result as { exceptionDetails?: { text?: unknown } } | undefined)?.exceptionDetails
            if (thrown) this.deps.warn('the guard threw in a worker, which runs unprotected', String(thrown.text ?? 'exception'))
          })
        }
        // A worker starts workers of its own.
        void this.send(child, 'Target.setAutoAttach', AUTO_ATTACH)
        kept = true
      }
    } catch (error) {
      this.deps.warn(`cannot protect a ${String(type)} of the page`, error)
    } finally {
      // Electron hands this event over from inside the call that attaches the target, and the browser holds the navigation of a frame only once that
      // call is over: a resume sent from here arrives first, finds nothing to let go and is spent, and the frame then waits for ever. It is sent
      // once the event is over (a worker, which waits in its own thread, is let go the same way). The commands of a session are run in the order
      // they were sent: the guard is in place when this one is read.
      setImmediate(() => {
        void this.send(child, 'Runtime.runIfWaitingForDebugger')
        // A target that is not ours to protect is not kept either: an attached session keeps a service worker running.
        if (!kept) void this.send(parent, 'Target.detachFromTarget', { sessionId: child })
      })
    }
  }

  /** Sends a command; a failure is told (unless the page or the session is gone, which is how most commands end) and answers `undefined`. */
  private send(sessionId: string, method: string, params?: object): Promise<unknown> {
    let sent: Promise<unknown>
    try {
      sent = this.deps.debugger.sendCommand(method, params, sessionId === '' ? undefined : sessionId)
    } catch (error) {
      sent = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return sent.catch((error: unknown) => {
      if (this.engaged && this.deps.alive() && (sessionId === '' || this.children.has(sessionId))) this.deps.warn(`the command ${method} failed`, error)
      return undefined
    })
  }

  /** Gives the page back: the session is left (and detached if it was ours alone). */
  private drop(): void {
    if (!this.engaged) return
    const own = this.registered.get('')?.identifier ?? null
    const { debugger: dbg } = this.deps
    this.forget()
    if (!this.deps.alive()) return
    try {
      if (this.deps.session.release(USER) !== 'shared') return
      // The session stays for the colour scheme: what we asked of the page is taken back by hand.
      const undo = (method: string, params: object): void => {
        dbg.sendCommand(method, params).catch((error: unknown) => {
          if (this.deps.alive()) this.deps.warn(`the command ${method} failed while the protection of the frames was taken away`, error)
        })
      }
      undo('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
      if (own !== null) undo('Page.removeScriptToEvaluateOnNewDocument', { identifier: own })
      undo('Page.disable', {})
    } catch (error) {
      this.deps.warn('cannot detach the session that protected the frames and the workers of the page', error)
    }
  }

  private forget(): void {
    this.engaged = false
    this.registered.clear()
    this.children.clear()
    this.deps.debugger.removeListener('message', this.onMessage)
    this.deps.debugger.removeListener('detach', this.onDetach)
  }
}

const guards = new WeakMap<object, InnerGuard>()

/** The guard of a web contents (`owner`), if one was ever made for it. */
export const innerGuardOf = (owner: object): InnerGuard | undefined => guards.get(owner)

/** The guard of a web contents, made the first time it is asked for. */
export function innerGuardFor(owner: object, make: () => InnerGuard): InnerGuard {
  let guard = guards.get(owner)
  if (!guard) {
    guard = make()
    guards.set(owner, guard)
  }
  return guard
}
