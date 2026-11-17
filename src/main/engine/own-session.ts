// The one protocol session Lucium itself keeps on a page. Electron gives a web contents a single debugger, and two things of ours need it: the colour
// scheme asked of the pages (color-scheme.ts) and the fingerprint protection of the frames and workers (inner-guard.ts). They share the session
// here: the first that needs it attaches it, the last that leaves detaches it, and neither ever takes a session that is someone else's (an
// extension's `chrome.debugger`, a capture). Electron-free: the page hands in its debugger, so the rules are tested with a stand-in.

/** The part of Electron's `Debugger` our sessions use. */
export interface ProtocolDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): unknown
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): unknown
}

/** What became of the session when a user left it: it went with them, others still hold it, or they did not hold it. */
export type Release = 'detached' | 'shared' | 'none'

export class OwnSession {
  private readonly users = new Set<string>()
  private attached = false
  /** The session was detached from outside (DevTools, the page going): nobody holds it any more. Each user hears the same event and forgets on its side. */
  private readonly onDetach = (): void => {
    this.attached = false
    this.users.clear()
    this.dbg.removeListener('detach', this.onDetach)
  }

  constructor(private readonly dbg: ProtocolDebugger) {}

  /** Whether the session attached to the page is ours. */
  get held(): boolean {
    return this.attached
  }

  holds(user: string): boolean {
    return this.attached && this.users.has(user)
  }

  /**
   * `user` joins the session, which is attached if nobody of ours held it. False when someone else's session is on the page: it is not ours to
   * take. Throws what Electron throws when the session cannot be attached.
   */
  acquire(user: string): boolean {
    if (!this.attached) {
      if (this.dbg.isAttached()) return false
      this.dbg.attach('1.3')
      this.attached = true
      this.dbg.on('detach', this.onDetach)
    }
    this.users.add(user)
    return true
  }

  /** `user` leaves. The session is detached with its last user; while another one stays, what `user` had asked of the page is its own to take back. */
  release(user: string): Release {
    if (!this.attached || !this.users.delete(user)) return 'none'
    if (this.users.size > 0) return 'shared'
    this.attached = false
    this.dbg.removeListener('detach', this.onDetach)
    if (this.dbg.isAttached()) this.dbg.detach()
    return 'detached'
  }
}

const sessions = new WeakMap<object, OwnSession>()

/** The session of a web contents (`owner`), made the first time it is asked for. */
export function ownSessionOf(owner: object, dbg: ProtocolDebugger): OwnSession {
  let session = sessions.get(owner)
  if (!session) {
    session = new OwnSession(dbg)
    sessions.set(owner, session)
  }
  return session
}

/** Whether the protocol session attached to this web contents is Lucium's own: it sends no input, so the user's clicks and keys still count as the user's. */
export const holdsOwnSession = (owner: object): boolean => sessions.get(owner)?.held === true

/**
 * The debugger as one user of the shared session sees it: attached means "by someone who is not us, or by me", attaching joins the session and
 * detaching leaves it. `onShared` is called when the user leaves a session that stays for another one: it takes back what it had asked of the
 * page, which a real detach would have taken back by itself.
 */
export function sharedDebugger(session: OwnSession, dbg: ProtocolDebugger, user: string, onShared: () => void): ProtocolDebugger {
  return {
    isAttached: () => dbg.isAttached() && (!session.held || session.holds(user)),
    attach: () => {
      if (!session.acquire(user)) throw new Error('another protocol session is attached to the page')
    },
    detach: () => {
      if (session.release(user) === 'shared') onShared()
    },
    sendCommand: (method, params, sessionId) => dbg.sendCommand(method, params, sessionId),
    on: (event: 'detach' | 'message', listener: (...args: never[]) => void) => dbg.on(event as 'detach', listener as (event: unknown, reason: string) => void),
    removeListener: (event: 'detach' | 'message', listener: (...args: never[]) => void) => dbg.removeListener(event as 'detach', listener as (event: unknown, reason: string) => void)
  }
}
