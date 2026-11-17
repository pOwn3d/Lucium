// The identity on the sign-in pages of Google (shared/google-sign-in.ts), on the side of Electron: which tabs are on the sign-in hosts, and the user agent each of them has while it is.
// A tab is made to say the same thing in `navigator.userAgent` and in the header from the moment its main frame is sent to the hosts, and gets the identity of the pages back the moment
// the main frame is sent anywhere else.
//
// The user agent of a tab is changed from `did-start-navigation` ONLY. `webContents.setUserAgent` makes Chromium reload the tab when it is called while a navigation is loading
// (WebContentsImpl::SetUserAgentOverride → NavigationControllerImpl::Reload), and the reload is of the last entry the tab committed, not of the navigation under way: called from
// `will-redirect` or `did-redirect-navigation` it threw the navigation away (a blank page, a wheel that never stops). `did-start-navigation` is the one event where Chromium does not
// reload (`ua_change_requires_reload` is false while it is announced).
//
// A redirect cannot wait for that event: it does not announce itself again. So a redirect of the main frame that goes onto the hosts or leaves them is cancelled and the tab is sent
// to where the redirect went, a moment later (`loadURL`): the new navigation starts with `did-start-navigation`, which gives the tab its user agent before the request leaves.
//
// The limits, on purpose:
//  - only a redirect that follows a GET is taken over. Electron does not say what the method and the status of a redirected request were, and a 307/308 redirect of a POST must stay a
//    POST: the engine tells this module the method of every main-frame request (`noteRequest`), and a redirect that follows anything but a GET, or a request this module was not told
//    of, is left alone. The tab then keeps the identity it had until its next navigation (the header hook still gives the request itself the right user agent);
//  - the new navigation carries no referrer: Electron does not give the one of the cancelled navigation, and one worked out from the page the tab is on could send what the page asked
//    not to send. It sends less, never more; the redirect of a sign-in does not read it.

import { signInAgentChange, type GoogleSignInIdentity } from '@shared/google-sign-in'

/** What a main-frame navigation event carries (Electron gives it as the first argument of the events used here; `will-redirect` is the only one that can be cancelled with `preventDefault`). */
interface NavigationDetails {
  url?: unknown
  isMainFrame?: unknown
  isSameDocument?: unknown
  preventDefault?: unknown
}

/** The part of a `WebContents` this reads and calls. */
export interface SignInContents {
  id: number
  /** The session the tab loads its pages in: what `onEnter` is told. */
  session: unknown
  isDestroyed(): boolean
  setUserAgent(agent: string): void
  /** The navigation that takes over from a redirect this cancelled. */
  loadURL(url: string): Promise<void>
  on(event: string, listener: (details: NavigationDetails | undefined) => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * How many redirects in a row the same tab may have taken over without a navigation committing in between. A redirect taken over starts a new navigation that sets the
 * user agent first, so the next redirect of the chain finds the tab as it should be and is left alone; this is the stop for the case where it cannot be (the user agent
 * refused by Chromium, a server that bounces between the hosts and elsewhere): a tab never relaunches for ever.
 */
export const MAX_TAKEN_OVER = 5

/** The code of a failed `loadURL` (`ERR_ABORTED`…), and nothing else: the message of the error holds the address. */
function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

export class SignInAgents {
  /** The tabs (by `webContents.id`) that have Electron's user agent now. */
  private readonly inSignIn = new Set<number>()
  /** The tabs this follows. */
  private readonly followed = new Set<number>()
  /** The method of the last main-frame request of each tab, as the engine told it: what the redirect that comes next follows. */
  private readonly lastMethod = new Map<number, string>()
  /** The redirects each tab had taken over since its last commit. */
  private readonly takenOver = new Map<number, number>()

  /**
   * `onEnter` is told the session of a tab each time the tab goes onto the sign-in hosts (after it got the user agent), so that the engine can widen what it watches in that
   * session: the requests of such a tab all carry the user agent (electron-engine-network.ts, `watchSignInPages`).
   */
  constructor(
    readonly identity: GoogleSignInIdentity,
    private readonly onEnter: (session: unknown) => void = () => undefined
  ) {}

  /** Whether the tab is on the sign-in hosts now: what the header hook of the sessions reads (`shared/google-sign-in.ts` `isSignInRequest`). */
  has(contentsId: number | undefined): boolean {
    return contentsId !== undefined && this.inSignIn.has(contentsId)
  }

  /**
   * The main frame of a tab sends a request (the header hook of its session calls this for every one, redirects included: the redirect that follows is of the request this is told of).
   * A tab this does not follow is not remembered.
   */
  noteRequest(contentsId: number | undefined, method: string): void {
    if (contentsId !== undefined && this.followed.has(contentsId)) this.lastMethod.set(contentsId, method)
  }

  /** Follows a web contents for as long as it lives. Every web contents the application makes is given here: the sign-in popups of a site and of an extension are not tabs. */
  watch(contents: SignInContents): void {
    this.followed.add(contents.id)
    // The address of a navigation of the main frame to a new document, null for the frames inside it and for a move inside the same document: they do not change what a tab is.
    const mainFrameUrl = (details: NavigationDetails | undefined): string | null =>
      details?.isMainFrame !== true || details.isSameDocument === true || typeof details.url !== 'string' || contents.isDestroyed() ? null : details.url

    const follow = (details: NavigationDetails | undefined): void => {
      const url = mainFrameUrl(details)
      if (url === null) return
      const change = signInAgentChange(this.identity, url, this.inSignIn.has(contents.id))
      if (change === null) return
      try {
        // Chromium does not reload a tab whose user agent changes while `did-start-navigation` is announced, and only then: this is the one place it is done.
        contents.setUserAgent(change.agent)
      } catch (error) {
        // The tab keeps the identity it had; the next navigation tries again.
        console.warn(`[google-sign-in] the user agent of tab ${contents.id} could not be changed:`, error instanceof Error ? error.message : String(error))
        return
      }
      if (!change.inSignIn) return void this.inSignIn.delete(contents.id)
      this.inSignIn.add(contents.id)
      try {
        this.onEnter(contents.session)
      } catch (error) {
        // The tab has the user agent for its page and for the requests of its frames; only its other requests keep what Chromium gives them.
        console.error(`[google-sign-in] the requests of tab ${contents.id} could not all be given the user agent:`, error instanceof Error ? error.message : String(error))
      }
    }

    // A redirect of the main frame that would change the identity of the tab: cancelled, and the tab is sent where the redirect went, by a navigation of its own that `follow` sees begin.
    const takeOver = (details: NavigationDetails | undefined): void => {
      const url = mainFrameUrl(details)
      if (url === null || signInAgentChange(this.identity, url, this.inSignIn.has(contents.id)) === null) return
      // The method is not the redirect's own to know: a redirect that does not follow a GET (a POST that a 307/308 keeps a POST, or a request the engine did not tell of) is not touched.
      if (this.lastMethod.get(contents.id) !== 'GET' || typeof details?.preventDefault !== 'function') return
      const taken = this.takenOver.get(contents.id) ?? 0
      if (taken >= MAX_TAKEN_OVER) {
        console.warn(`[google-sign-in] tab ${contents.id}: ${MAX_TAKEN_OVER} redirects in a row were taken over, the next one is left to Chromium`)
        return
      }
      this.takenOver.set(contents.id, taken + 1)
      // Cancels the navigation, not the redirect alone (Electron). `loadURL` is refused while a redirect is held (crbug 347742): the new navigation starts once the event is over.
      details.preventDefault()
      setImmediate(() => void this.sendOn(contents, url))
    }

    contents.on('did-start-navigation', follow)
    contents.on('will-redirect', takeOver)
    // A navigation that commits ends the chain of redirects: the next one counts from zero.
    contents.on('did-navigate', () => void this.takenOver.delete(contents.id))
    contents.once('destroyed', () => {
      this.inSignIn.delete(contents.id)
      this.followed.delete(contents.id)
      this.lastMethod.delete(contents.id)
      this.takenOver.delete(contents.id)
    })
  }

  /** The navigation that takes over from a redirect this cancelled. */
  private async sendOn(contents: SignInContents, url: string): Promise<void> {
    if (contents.isDestroyed()) return
    try {
      await contents.loadURL(url)
    } catch (error) {
      const code = failureCode(error)
      // A load replaced by another one (the user went elsewhere, the next redirect of the chain was taken over too) is not a fault: the page shown is the one that replaced it. A failure
      // of the network has its error page as well as this line. Neither writes an address or an account.
      if (code === 'ERR_ABORTED') return console.info(`[google-sign-in] tab ${contents.id}: the navigation that took over from a redirect was replaced by another one`)
      console.warn(`[google-sign-in] tab ${contents.id} could not be sent on after a redirect (${code})`)
    }
  }
}
