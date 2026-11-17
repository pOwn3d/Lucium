// The console of the extensions, recorded for the Extensions page: the messages of the service workers and of the pages of the extensions
// (popup, options, side panel). It listens only between `start()` and the function it returns, and only to what is an extension's: the
// workers of the sites that share a session, and the pages of the tabs, are never read. Electron's own objects come in through `env`.

import type { Session, WebContents } from 'electron'
import { ExtensionJournal, extensionIdOfUrl, pageLevel, whereOf, workerLevel } from '@shared/extension-journal'

export interface ConsoleSource {
  profileId: string
  session: Session
}

export interface ConsoleEnv {
  /** The session of each profile that exists. */
  sources(): ConsoleSource[]
  /** Calls the listener for each web contents made from now on; the function it returns stops that. */
  onContentsCreated(listener: (event: unknown, wc: WebContents) => void): () => void
  /** The web contents that exist now. */
  contents(): WebContents[]
}

/**
 * electron-chrome-extensions is published with its debug switch on: its preload prints every call an extension makes to its APIs with the
 * arguments (`tabs.query [object Object]`), and every answer and event with what it carries (`cookies.onChanged (result) …`), at the info
 * level. Those lines are the library's, not the extension's, and they carry the user's tabs and cookies: they are not kept. The call form is
 * recognised by the namespaces the library implements and a member that is a method (an event, `runtime.onInstalled`, is a name an extension
 * prints itself); the answer form by its `(result)`. The pnpm patch also switches the printing off at its source.
 */
const LIBRARY_CALL = /^(?:action|browserAction|commands|contextMenus|cookies|downloads|extension|notifications|permissions|runtime|tabs|topSites|webNavigation|webRequest|windows)\.(?!on[A-Z])[A-Za-z]+(?: |$)/
const LIBRARY_ANSWER = /^[a-z][A-Za-z]*\.[A-Za-z]+ \(result\)(?: |$)/

/**
 * The one warning the library gives about the page it is in, in every document of an extension that has no context isolation (an offscreen document, the background page
 * of a Manifest V2 extension, a page of the DevTools): `injectExtensionAPIs: context isolation disabled in chrome-extension://<id>/<page>`. The library goes on and gives the
 * page its APIs as it should; the line says nothing the extension can act on, and read in the journal it looks like a fault of the extension. It stays on the console of the page.
 */
const LIBRARY_NOTICE = /^injectExtensionAPIs: context isolation disabled in chrome-extension:\/\//

/** Whether a line of a console is the extension library's own trace of a call, or its notice about a page without context isolation (see above): neither is recorded. */
export function isLibraryTrace(level: string, message: string): boolean {
  return (level === 'info' && (LIBRARY_ANSWER.test(message) || LIBRARY_CALL.test(message))) || (level === 'warning' && LIBRARY_NOTICE.test(message))
}

const whereField = (url: string, line: number): { where?: string } => {
  const where = whereOf(url, line)
  return where === undefined ? {} : { where }
}

/** The console of the extensions, listened to while at least one window of the Extensions page is open. */
export class ExtensionConsoleWatch {
  private depth = 0
  private readonly off: Array<() => void> = []
  private readonly sessions = new Set<Session>()
  /** The pages listened to during this listening: a new one starts empty, or the pages left open would never be listened to again. */
  private pages = new WeakSet<WebContents>()

  constructor(
    private readonly journal: ExtensionJournal,
    private readonly env: ConsoleEnv
  ) {}

  isWatching(): boolean {
    return this.depth > 0
  }

  /** Starts listening (or joins the listening that goes on); the function it returns ends this caller's share, and the last one to end stops everything. */
  start(): () => void {
    if (this.depth++ === 0) this.begin()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      if (--this.depth === 0) this.end()
    }
  }

  /** A profile whose session was made while the page is open. */
  attach(source: ConsoleSource): void {
    if (this.depth > 0) this.watchSession(source)
  }

  private begin(): void {
    for (const source of this.env.sources()) this.watchSession(source)
    const created = (_event: unknown, wc: WebContents): void => {
      // A page of an extension is known by its first address; any other page of a tab is not listened to at all.
      const onStart = (details: { url: string; isMainFrame: boolean }): void => {
        if (details.isMainFrame && extensionIdOfUrl(details.url) !== undefined) this.watchPage(wc)
      }
      wc.on('did-start-navigation', onStart)
      this.off.push(() => (wc.isDestroyed() ? undefined : wc.off('did-start-navigation', onStart)))
    }
    this.off.push(this.env.onContentsCreated(created))
    // The pages that exist now: a popup or an options page left open.
    for (const wc of this.env.contents()) if (extensionIdOfUrl(wc.getURL()) !== undefined) this.watchPage(wc)
  }

  private end(): void {
    for (const stop of this.off.splice(0)) stop()
    this.sessions.clear()
    this.pages = new WeakSet()
  }

  private profileOf(session: Session): string | undefined {
    return this.env.sources().find((source) => source.session === session)?.profileId
  }

  private watchSession({ profileId, session }: ConsoleSource): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    const heard = (_event: unknown, details: { message: string; level: number; sourceUrl: string; lineNumber: number }): void => {
      const extensionId = extensionIdOfUrl(details.sourceUrl)
      const level = workerLevel(details.level)
      // The workers of the sites are on the same session: only the extensions' are the page's business.
      if (extensionId === undefined || level === null || isLibraryTrace(level, details.message)) return
      this.journal.add({ at: Date.now(), level, source: 'worker', extensionId, profileId, message: details.message, ...whereField(details.sourceUrl, details.lineNumber) })
    }
    session.serviceWorkers.on('console-message', heard)
    this.off.push(() => session.serviceWorkers.off('console-message', heard))
  }

  private watchPage(wc: WebContents): void {
    if (this.pages.has(wc) || wc.isDestroyed()) return
    this.pages.add(wc)
    const heard = (event: { message: string; level: string; lineNumber: number; sourceId: string }): void => {
      if (wc.isDestroyed()) return
      const extensionId = extensionIdOfUrl(wc.getURL())
      const level = pageLevel(event.level)
      const profileId = this.profileOf(wc.session)
      // The page has gone on to a site since it was an extension's: what it says is no longer one's business.
      if (extensionId === undefined || level === null || profileId === undefined || isLibraryTrace(level, event.message)) return
      this.journal.add({ at: Date.now(), level, source: 'page', extensionId, profileId, message: event.message, ...whereField(event.sourceId, event.lineNumber) })
    }
    wc.on('console-message', heard)
    this.off.push(() => (wc.isDestroyed() ? undefined : wc.off('console-message', heard)))
  }
}


