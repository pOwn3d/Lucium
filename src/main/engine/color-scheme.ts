// The appearance asked of the web pages (the setting `websiteAppearance`): « Clair » or « Sombre » is what a page reads of `prefers-color-scheme`, and nothing
// else changes: the interface of Lucium follows its own setting (`interfaceAppearance`, shell/appearance.ts), which is the only one that moves
// `nativeTheme.themeSource` (that one is global in Electron: it turns every window of the application, and every page, one way).
//
// Electron has no way to give one web contents its own preferred colour scheme, so it is done as DevTools does it: one protocol session on the page, with
// `Emulation.setEmulatedMedia`. Measured in headless Chrome over the raw protocol (2026-11-09): the emulation of the page's target is also the one of its
// frames, those of another site included, a frame that loads later and a document loaded by a navigation keep it, and it goes with the session when the session
// detaches. What it costs, and what it is kept from costing:
//  - nothing while the setting is « Automatique » (the default): no session is ever attached, and the one attached is detached when the setting goes back to it;
//  - a protocol session counts as a debugger on the page: the clicks and keys that reach a page do not count as the user's while one is attached
//    (`countsAsGesture`, which keeps an extension that debugs a page from pressing buttons for itself). Our own session is told apart (`holdsEmulation`), so
//    the user's input keeps counting; an extension's session (chrome.debugger) is never ours: ours steps aside when an extension attaches, and comes back
//    when its session ends (`stepAside`, `refresh`), so the extension API sees the page free, as before;
//  - the session is attached by a page only while it has something to say, and only if no one else's is on (a capture or a freeze under way, an extension's):
//    it tries again at the next document of the page (`refresh`) rather than fight for the page.
// Electron-free: the page hands in its debugger, so the rules are tested with a stand-in.

export type PageColorScheme = 'light' | 'dark'

/** The part of Electron's `Debugger` the emulation uses. */
export interface EmulationDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

export interface EmulationDeps {
  debugger: EmulationDebugger
  /** What identifies the page's web contents in `holdsEmulation`. */
  owner: object
  /** False once the page is gone: nothing is sent to it. */
  alive(): boolean
  /** A failure, with what was being done: logged by the page, never swallowed. */
  warn(what: string, error: unknown): void
}

/** The web contents whose protocol session is the emulation's own (not an extension's, not a capture's): their input is still the user's. */
const ownSessions = new WeakSet<object>()

/** Whether the protocol session attached to this web contents is the one that emulates the colour scheme. */
export const holdsEmulation = (owner: object): boolean => ownSessions.has(owner)

/** The command that gives a page its colour scheme, and the one that gives it back (the session detaching does the same). */
export const emulationCommand = (scheme: PageColorScheme | null): { method: 'Emulation.setEmulatedMedia'; params: { features: Array<{ name: 'prefers-color-scheme'; value: PageColorScheme }> } } => ({
  method: 'Emulation.setEmulatedMedia',
  params: { features: scheme === null ? [] : [{ name: 'prefers-color-scheme', value: scheme }] }
})

export class ColorSchemeEmulation {
  private wanted: PageColorScheme | null = null
  private held = false
  /** Our session was detached by someone else (DevTools, the page going): forgotten, not re-attached until the next document. */
  private readonly onDetach = (): void => {
    if (this.held) this.forget()
  }

  constructor(private readonly deps: EmulationDeps) {}

  /** What the page is asked now: `null` gives it back its own (the session goes). */
  set(scheme: PageColorScheme | null): void {
    this.wanted = scheme
    if (scheme === null) this.drop()
    else this.engage()
  }

  /** A new document, or a session that ended: what is asked is asked again, if it is not on. Nothing while nothing is asked. */
  refresh(): void {
    if (this.wanted !== null) this.engage()
  }

  /** An extension is about to attach its own session: ours leaves the page to it (what is asked stays asked, `refresh` brings it back). */
  stepAside(): void {
    this.drop()
  }

  private engage(): void {
    const { debugger: dbg } = this.deps
    if (this.wanted === null || !this.deps.alive()) return
    if (!this.held) {
      // Someone else's session (an extension's, a capture, a freeze): not ours to take, and not ours to disturb.
      if (dbg.isAttached()) return
      try {
        dbg.attach('1.3')
      } catch (error) {
        this.deps.warn('cannot attach the session that gives the page its colour scheme', error)
        return
      }
      this.held = true
      ownSessions.add(this.deps.owner)
      dbg.on('detach', this.onDetach)
    }
    const { method, params } = emulationCommand(this.wanted)
    dbg.sendCommand(method, params).catch((error: unknown) => {
      if (this.deps.alive()) this.deps.warn('cannot give the page its colour scheme', error)
    })
  }

  /** Gives the page back: the session is detached (the emulation goes with it). */
  private drop(): void {
    if (!this.held) return
    const { debugger: dbg } = this.deps
    this.forget()
    if (!this.deps.alive()) return
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch (error) {
      this.deps.warn('cannot detach the session that gave the page its colour scheme', error)
    }
  }

  private forget(): void {
    this.held = false
    ownSessions.delete(this.deps.owner)
    this.deps.debugger.removeListener('detach', this.onDetach)
  }
}

/**
 * The pages of the application that are given the colour scheme, whichever window or context they belong to (a private window's and a container's included: the
 * engine makes them all). A page made while a scheme is asked gets it at once, a page that goes is forgotten, and asking for what is already asked does nothing.
 */
export class ColorSchemePages<P extends { setColorScheme(scheme: PageColorScheme | null): void }> {
  private scheme: PageColorScheme | null = null
  private readonly pages = new Set<P>()

  /** The scheme every page is asked to read now (null: their own). */
  set(scheme: PageColorScheme | null): void {
    if (scheme === this.scheme) return
    this.scheme = scheme
    for (const page of this.pages) page.setColorScheme(scheme)
  }

  /** A page was made: it reads the scheme from its first document when one is asked. Not for a panel that hosts an extension's page: that one is not a web page. */
  add(page: P): void {
    this.pages.add(page)
    if (this.scheme !== null) page.setColorScheme(this.scheme)
  }

  remove(page: P): void {
    this.pages.delete(page)
  }

  get size(): number {
    return this.pages.size
  }
}
