// What Lucium says of itself on the sign-in pages of Google. Everywhere else a page meets a plain Chromium (shared/user-agent.ts: `Chrome/<major>.0.0.0`, `window.chrome.app`, the
// three Client Hints of the navigations). On these two hosts it meets Electron as it is, because Google refused some accounts at the password step of a browser that
// says it is Chrome while the rest of its signals are Electron's: a mix no real Chrome has. A browser that is plainly Electron was let in (the same finding as the Orca browser,
// pull request 36519; a test on a real account of the maintainer, 16 November 2026), and Google's own rule for its sign-in is not to borrow another browser's user agent there.
//
// On these hosts, and in the tab that is on them only:
//  - `navigator.userAgent` and the header of every request of the tab are the user agent Electron gives (the name of the application, `Chrome/x`, `Electron/x`),
//    `webContents.setUserAgent` for the page and the header hook of the sessions for the request;
//  - Lucium adds no Client Hint of its own to those requests;
//  - none of its preloads that write into the page runs there (`excludeMatches`: no `window.chrome.app`, no replaced `alert()`, nothing).
// Leaving the hosts gives the tab the identity of every other tab again, exactly.
//
// Everything here is pure: the engine (engine/google-sign-in-agent.ts, electron-engine-*.ts) does the calls to Electron.

/**
 * The hosts that serve the sign-in of Google, by their exact name: `accounts.google.com` (the form, the passkeys, "Sign in with Google") and `accounts.youtube.com` (where the
 * sign-in of Google hands its cookies over and where a YouTube sign-in passes: the same two hosts the Orca browser treats). A subdomain, a look-alike
 * (`accounts.google.com.example`) and the other Google hosts (`mail.google.com`, `myaccount.google.com`, `www.google.com`) are other sites.
 */
export const GOOGLE_SIGN_IN_HOSTS: readonly string[] = ['accounts.google.com', 'accounts.youtube.com']

/** Whether an address is a page of those hosts: https only (Google's sign-in is never served over http), the default port, the name without case or final dot. Anything that is not an address is not. */
export function isGoogleSignInUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !URL.canParse(url)) return false
  const { protocol, hostname, port } = new URL(url)
  return protocol === 'https:' && (port === '' || port === '443') && GOOGLE_SIGN_IN_HOSTS.includes(hostname.replace(/\.$/, ''))
}

/** The two identities a tab goes between. */
export interface GoogleSignInIdentity {
  /** The user agent of the tabs that are on the sign-in hosts: Electron's own, with the name of the application. */
  agent: string
  /** The user agent of every other tab: what `app.userAgentFallback` is (the plain Chrome of shared/user-agent.ts). */
  pageAgent: string
}

/**
 * The identity for the user agent Electron gave before Lucium rewrote it (`applicationAgent`, undefined when it was not rewritten) and the one the pages have now. Null when
 * there is nothing to change: the pages were not made a Chrome, or are one already that says what Electron says.
 */
export function googleSignInIdentity(applicationAgent: string | undefined, pageAgent: string): GoogleSignInIdentity | null {
  return applicationAgent === undefined || applicationAgent === '' || applicationAgent === pageAgent ? null : { agent: applicationAgent, pageAgent }
}

/**
 * What to do with the user agent of a tab that is about to load `url` in its main frame: the agent to give it, or null to leave it. The sign-in hosts give it Electron's,
 * once (a tab that has it already is left alone: changing it makes Chromium reload what is loading); anything else gives the tab's own back, but only to a tab that
 * this took it from.
 */
export function signInAgentChange(identity: GoogleSignInIdentity, url: string, inSignIn: boolean): { agent: string; inSignIn: boolean } | null {
  const onHost = isGoogleSignInUrl(url)
  if (onHost && !inSignIn) return { agent: identity.agent, inSignIn: true }
  if (!onHost && inSignIn) return { agent: identity.pageAgent, inSignIn: false }
  return null
}

/** The part of an `onBeforeSendHeaders` request this reads. */
export interface SignInRequest {
  url: string
  resourceType: string
}

/**
 * Whether a request is one of the sign-in: the navigation of a tab to the hosts, or any request of a tab that is on them already (its frames, its scripts, its
 * fetches, whatever host they go to: the document that makes them says what it is). A frame of Google inside another site's page, or a script of another site that
 * asks the hosts for something, is not: the page around it keeps its identity, and a header of ours there would contradict `navigator.userAgent`.
 */
export function isSignInRequest(request: SignInRequest, tabInSignIn: boolean): boolean {
  return request.resourceType === 'mainFrame' ? isGoogleSignInUrl(request.url) : tabInSignIn
}

const isUserAgent = (name: string): boolean => name.toLowerCase() === 'user-agent'

/**
 * The headers of a request with the identity where it belongs, the same object when nothing changes:
 *  - a request of the sign-in carries Electron's user agent; the hints Chromium put on it stay as they are (Lucium adds none: the engine keeps its own off these requests);
 *  - a navigation of the main frame to anywhere else that still carries Electron's user agent (a redirect out of the hosts, followed before the tab got its own back)
 *    gets the page's user agent again;
 *  - every other request is left as it is.
 */
export function signInRequestHeaders(identity: GoogleSignInIdentity, request: SignInRequest, headers: Record<string, string>, tabInSignIn: boolean): Record<string, string> {
  const carried = Object.entries(headers).filter(([name]) => isUserAgent(name))
  if (!isSignInRequest(request, tabInSignIn)) {
    if (request.resourceType !== 'mainFrame') return headers
    return carried.some(([, value]) => value === identity.agent) ? withAgent(headers, identity.pageAgent) : headers
  }
  if (carried.length === 1 && carried[0]![0] === 'User-Agent' && carried[0]![1] === identity.agent) return headers
  return withAgent(headers, identity.agent)
}

/** The headers with `agent` as the only user agent, whatever case the name was in. */
function withAgent(headers: Record<string, string>, agent: string): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(headers).filter(([name]) => !isUserAgent(name))), 'User-Agent': agent }
}

/**
 * Where the preloads of Lucium that write into the page (`window.chrome.app`, the replaced `alert()`, the media functions, the page guard) must not run: the sign-in hosts,
 * over https. The preload that stays in the isolated world of the page (the password bridge) is not one of them and keeps its registration.
 */
export const SIGN_IN_PRELOAD_EXCLUDES: readonly string[] = GOOGLE_SIGN_IN_HOSTS.map((host) => `https://${host}/*`)
