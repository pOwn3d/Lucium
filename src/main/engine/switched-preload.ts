// A preload script that the sessions have only while the feature behind it is on. A preload runs in the main frame of every page of a session
// (and in service workers), so a feature that needs one must not leave it there when it is off: the script is registered when the first page
// of a session is made while the feature is on, and taken out of every session when the feature goes off. Pages that were loaded keep what
// the script did until they load a new document; Electron applies the preloads of a session at each navigation.

export interface PreloadScriptRegistration {
  id: string
  type: 'frame' | 'service-worker'
  filePath: string
  /** The addresses of the documents the script runs in (Electron's match patterns); absent, every document. */
  matches?: string[]
  /** The addresses of the documents it does not run in (Electron's match patterns); absent, none. */
  excludeMatches?: string[]
}

/** The part of Electron's `Session` this needs. */
export interface PreloadTarget {
  registerPreloadScript(script: PreloadScriptRegistration): string
  unregisterPreloadScript(id: string): void
}

export class SwitchedPreload<S extends PreloadTarget> {
  private on: boolean
  /** The sessions that carry the script now (weakly: a closed private window's session must not be kept alive by this). */
  private readonly installed = new WeakSet<S>()

  /**
   * `path` is read when a script is registered, not now: where a packaged build keeps the file is known when the application is ready. `excludeMatches`, when there are some,
   * go into every registration: the documents the script must stay out of (the sign-in hosts of Google: shared/google-sign-in.ts).
   * `report` is told of a session that would not take the script or let it go, with the session's name.
   */
  constructor(
    private readonly script: { id: string; type: PreloadScriptRegistration['type']; path: () => string; excludeMatches?: readonly string[] },
    initial: boolean,
    private readonly report: (message: string, error: unknown) => void = (message, error) => console.error(message, error)
  ) {
    this.on = initial
  }

  get enabled(): boolean {
    return this.on
  }

  /** Whether the script is registered in this session now (the engine test reads it). */
  has(session: S): boolean {
    return this.installed.has(session)
  }

  /** A page is about to be made in this session: it gets the script, once, if the feature is on. */
  ensure(session: S): void {
    if (!this.on || this.installed.has(session)) return
    session.registerPreloadScript({ id: this.script.id, type: this.script.type, filePath: this.script.path(), ...(this.script.excludeMatches ? { excludeMatches: [...this.script.excludeMatches] } : {}) })
    this.installed.add(session)
  }

  /** The feature is switched on or off; `sessions` are all the live ones. Off: the script leaves every session that has it. On: it is put in the live ones. */
  set(on: boolean, sessions: Iterable<S>): void {
    if (on === this.on) return
    this.on = on
    for (const session of sessions) {
      try {
        if (on) this.ensure(session)
        else if (this.installed.has(session)) {
          session.unregisterPreloadScript(this.script.id)
          this.installed.delete(session)
        }
      } catch (error) {
        this.report(`[preload] the script ${this.script.id} could not be ${on ? 'registered in' : 'taken out of'} a session; pages of that session may keep ${on ? 'lacking' : 'running'} it until they are closed:`, error)
      }
    }
  }
}
