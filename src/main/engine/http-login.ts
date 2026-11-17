// Which HTTP authentication requests of a page may put the login panel in front of the user. The rule: the page itself (the navigation of its
// main frame under way, wherever it leads) and a proxy are asked for; a frame or a subresource only when it comes from the origin of the page. A
// frame of another site, a picture, a script or a fetch of another origin answering 401 would otherwise show a login panel in the tab, with a
// realm that origin writes as it likes (« Connexion à votre banque »).

export interface LoginRequest {
  /** The address that answered 401 or 407. */
  url: string
  isRequestForNavigation: boolean
  isProxy: boolean
}

const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null)
const hostnameOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).hostname.toLowerCase() : null)

/**
 * Whether the login panel may be shown for this request of the page at `pageUrl`; refused, the request fails as without an answer.
 * `mainNavigation` is the address the main frame is navigating to (after its redirects), null when it is not navigating: Electron says a request
 * is a navigation, not whose. A navigation to that host is the page's own (its scheme may have changed on the way: HTTPS first); any other one is
 * a frame's, judged as a subresource is.
 */
export function mayAskLogin(request: LoginRequest, pageUrl: string, mainNavigation: string | null = null): boolean {
  if (request.isProxy) return true
  if (request.isRequestForNavigation && mainNavigation !== null) {
    const host = hostnameOf(request.url)
    if (host !== null && host !== '' && host === hostnameOf(mainNavigation)) return true
  }
  const own = originOf(request.url)
  return own !== null && own !== 'null' && own === originOf(pageUrl)
}

/** The address the main frame of a page is navigating to, from its navigation events: what `mayAskLogin` calls the page's own navigation. */
export class MainNavigation {
  private url: string | null = null

  /** A navigation of the main frame starts (`did-start-navigation`), or is redirected (`did-redirect-navigation`). */
  started(url: string): void {
    this.url = url
  }

  /** The main frame committed a document, or its load failed: it is not navigating any more. */
  ended(): void {
    this.url = null
  }

  current(): string | null {
    return this.url
  }
}
