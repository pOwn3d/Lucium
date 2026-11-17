import { isInternalScheme } from '@shared/internal-page'

/**
 * Whether the main frame of a page is on its way to the Extensions page (`lucium-ui:`), from the moment the shell asks for it and not from the moment
 * the document commits. The DevTools protocol of an extension is judged on the address the page is on; between the ask and the commit that address is
 * the previous one (or none), and a session attached there could register a script (`Page.addScriptToEvaluateOnNewDocument`) that runs in the new
 * document, where the channels of the page exist. So the debugger asks this too (electron-page-content.ts `debugTargetAllowed`).
 *
 * Three moments are told: the shell asks (`queue`: the load may still wait for the proxy of the session), the load is handed to Chromium (`handed`),
 * Chromium announces a navigation of the main frame (`announced`: a link, a script, a history move). It ends when the load of the page fails, or when
 * nothing loads any more (`ended`); a document that commits ends nothing here, as the address the page is on then says where it is, and one that
 * commits late (the previous load) says nothing of the navigation under way. It only ever fails closed: a navigation that never ends keeps the debugger
 * away from the page until the next one.
 */
export class HeadingNavigation {
  private queued = ''
  private under = false

  /** The shell asks to load `url`: the next load of the page, even while it waits to start. A later ask replaces it. */
  queue(url: string): void {
    this.queued = url
  }

  /** The load of `url` is handed to Chromium (it may announce itself later, after the page's own `beforeunload`). */
  handed(url: string): void {
    if (this.queued === url) this.queued = ''
    this.under = isInternalScheme(url)
  }

  /** Chromium announces a navigation of the main frame to `url` (`did-start-navigation`): the latest one is the one that counts. */
  announced(url: string): void {
    if (this.queued === url) this.queued = ''
    this.under = isInternalScheme(url)
  }

  /** The navigation is over: the load of `url` failed, or nothing loads any more (`url` omitted). The failure of another one says nothing. */
  ended(url?: string): void {
    if (url === undefined || isInternalScheme(url)) this.under = false
  }

  /** Whether the page is going, or about to go, to the Extensions page. */
  internal(): boolean {
    return this.under || isInternalScheme(this.queued)
  }
}
