// Links that leave the browser. A mail or telephone link goes to the system on a click, without a question (`externalLinkOf`). A link to
// another application (`zoommtg:`, `msteams:`, `slack:`, `vscode:`…) goes only after the user said yes to a question that names the scheme
// (`appLinkOf`), asked each time unless the user ticked « Toujours ouvrir les liens de ce type depuis ce site » (kept for the site and the
// scheme, shared/permissions.ts). Some schemes never leave, whatever the user would answer (`NEVER_APP_SCHEMES`): no `file:`, no `x-apple…`.

/** The whole list: mail and telephone. A scheme joins it only with a reason and a test. */
export const EXTERNAL_SCHEMES = ['mailto:', 'tel:'] as const

/** A link is not an essay: longer than this is not something the user clicked. */
export const EXTERNAL_LINK_MAX = 2048

/**
 * How long a click stays valid for opening another application: a click and the navigation it starts are one moment, so this is
 * short (Chromium's own "transient activation" lasts five seconds).
 */
export const GESTURE_WINDOW_MS = 1500

/**
 * How long a click stays valid for a page to open a window or a tab (`window.open`, a `target=_blank` link). Chromium's own transient
 * activation lasts the same five seconds. One click opens one window: the click is used up by it (see `ElectronPage`).
 */
export const OPEN_GESTURE_WINDOW_MS = 5000

/**
 * Whether a page may open this address in a new tab, a Glance or a mini window. Only what a page can show anyway: a web address, or
 * a blank page. `file:` (a page of the web has no business with the user's files), `chrome-extension:` and `devtools:` are for the
 * browser alone; `javascript:` and `data:` never.
 */
export function isPageOpenUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  if (url === 'about:blank') return true
  return URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)
}

/**
 * Whether the address of an image of a page may be downloaded by "Enregistrer l’image sous…": the web, an image written in the page (`data:`) and
 * an object of the page (`blob:`). The address is the page's own text, so `file:` and the schemes of other applications are never fetched.
 */
export function isSavableImageUrl(url: unknown): url is string {
  return typeof url === 'string' && /^(https?|data|blob):/i.test(url)
}

/** The address to hand to the system, or null when it is not a well-formed link of an allowed scheme. */
export function externalLinkOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > EXTERNAL_LINK_MAX) return null
  // Control characters and spaces around the address: nothing a link carries on its own.
  if (/[\u0000-\u001f\u007f]/.test(url) || url !== url.trim()) return null
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (!(EXTERNAL_SCHEMES as readonly string[]).includes(parsed.protocol)) return null
  // `mailto:` and `tel:` have no host: something that has one (`mailto://host/…`) is not what those links look like.
  if (parsed.host !== '' || parsed.username !== '') return null
  return parsed.href
}

/**
 * The schemes a page never hands to another application, question or not. What the browser itself reads or refuses (the web, a file, a
 * script, the pages of the browser and of its extensions, Lucium's own links); what Chromium refuses to pass on for what the application
 * behind it does with an address (`afp`, `disk`, `hcp`, `ms-help`, `nntp`, `shell`, `vbscript`…); and what mounts a volume, opens a remote
 * session or installs something on a Mac (`smb`, `nfs`, `cifs`, `ssh`, `telnet`, `vnc`, `itms-services`). The panes of System Settings and
 * the other `x-apple…` schemes are refused by their prefix.
 */
const NEVER_APP_SCHEMES: ReadonlySet<string> = new Set([
  ...['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:', 'filesystem:', 'blob:', 'data:', 'javascript:', 'about:', 'view-source:'],
  ...['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'chrome-error:', 'devtools:', 'lucium:', 'lucium-error:', 'lucium-stand-in:', 'lucium-ui:'],
  ...['afp:', 'disk:', 'disks:', 'hcp:', 'ie.http:', 'mk:', 'ms-help:', 'ms-msdt:', 'search-ms:', 'nntp:', 'popup:', 'res:', 'shell:', 'vbscript:', 'vnd.ms.radio:'],
  ...['smb:', 'nfs:', 'cifs:', 'ssh:', 'sftp:', 'telnet:', 'vnc:', 'itms-services:', 'x-man-page:']
])

/** The longest scheme taken for the name of an application's: it is printed in a question. */
export const APP_SCHEME_MAX = 40

/**
 * Whether a scheme (`zoommtg:`, with its colon) is one of another application's, which a page may be let open after a question: well formed,
 * short enough to be printed, not mail or telephone (they need no question), and not one that never leaves (`NEVER_APP_SCHEMES`).
 */
export function isAppScheme(scheme: string): boolean {
  if (scheme.length > APP_SCHEME_MAX || !/^[a-z][a-z0-9+.-]*:$/.test(scheme)) return false
  if ((EXTERNAL_SCHEMES as readonly string[]).includes(scheme)) return false
  return !NEVER_APP_SCHEMES.has(scheme) && !scheme.startsWith('x-apple')
}

/**
 * The address of a link to another application, to hand to the system once the user said yes, or null when it is not one: a mail or
 * telephone link (they need no question), a scheme that never leaves (`NEVER_APP_SCHEMES`), or something that is not a well-formed link.
 */
export function appLinkOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > EXTERNAL_LINK_MAX) return null
  if (/[\u0000-\u001f\u007f]/.test(url) || url !== url.trim()) return null
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  return isAppScheme(parsed.protocol) ? parsed.href : null
}

/** True when the last real input (a click, a key) is recent enough for the navigation that follows to be the user's. */
export function isFreshGesture(lastInputAt: number | null, now: number, windowMs: number = GESTURE_WINDOW_MS): boolean {
  return lastInputAt !== null && now >= lastInputAt && now - lastInputAt <= windowMs
}

/**
 * The last real input (a click, a key) in a page, and what it has been used for. An input lets one thing happen, once: the link it
 * clicked leaves the browser, or the window it asked for opens. A script that asks again without a new input is not the user.
 */
export class GestureLedger {
  private at: number | null = null

  /** A real input happened at `now`. */
  note(now: number): void {
    this.at = now
  }

  /** Whether the last input is recent enough (`windowMs`), without using it up: for a question that does not spend the click (a page asking to use a device). */
  fresh(now: number, windowMs: number): boolean {
    return isFreshGesture(this.at, now, windowMs)
  }

  /** True, and the input is used up, when it is recent enough (`windowMs`); false otherwise. */
  take(now: number, windowMs: number): boolean {
    if (!isFreshGesture(this.at, now, windowMs)) return false
    this.at = null
    return true
  }
}

/** The frame of a page that holds the keyboard focus, as the engine reads it when a window is asked for. */
export interface FocusedFrame {
  /** The origin of its document (`http://site.example:8080`). */
  origin: string
  /** True for the top document of the page. */
  top: boolean
}

/**
 * Whether a click in a frame of another site is the click behind a window that is being asked for. Chromium draws such a frame in a process of
 * its own, and the engine hears of the click without being told which frame took it. Two witnesses name the frame: the click gave it the focus,
 * and the request for the window carries the address of the document that makes it (`referrer`). The window is the frame's when both name the
 * same site. Refused: a request that names no document (a frame that hides its referrer cannot be told from another one), a request from
 * another site than the frame that was clicked (an advertisement beside a payment button), and a page whose own document has the focus (a click
 * there is heard another way, see `ElectronPage`).
 */
export function clickedFrameOpens(referrer: string, focused: FocusedFrame | null): boolean {
  if (focused === null || focused.top) return false
  if (!URL.canParse(referrer)) return false
  const asker = new URL(referrer)
  if (asker.protocol !== 'http:' && asker.protocol !== 'https:') return false
  return asker.origin === focused.origin
}

/**
 * Which click explains a `mailto:` or `tel:` link a frame of the page goes to. A frame of the page's own site speaks for the page: the click
 * in the page counts (`'page'`). A frame of another site (an advertisement, a widget) does not: only a click in that very frame counts
 * (`'frame'`), named the way `clickedFrameOpens` names it, by the focus the click gave. Null: no click of the user is behind this link, as when
 * a frame of another site sends to the telephone after a click on something else in the page.
 */
export function frameLinkClick(frameOrigin: string | null, pageOrigin: string | null, focused: FocusedFrame | null): 'page' | 'frame' | null {
  const isWeb = (origin: string | null): origin is string => origin !== null && /^https?:\/\//.test(origin)
  if (!isWeb(frameOrigin) || !isWeb(pageOrigin)) return null
  if (frameOrigin === pageOrigin) return 'page'
  return focused !== null && !focused.top && focused.origin === frameOrigin ? 'frame' : null
}

/**
 * Who asks for a link that leaves the browser (`mailto:`, `tel:`, another application's), as far as the engine can tell. `page`: the page's own
 * document, or a frame of its own site, which speak for the page. `frame`: a frame of another site (an advertisement, a widget), named by its
 * origin. `unsure`: nobody is named, or a document without a web origin, in a page that holds a frame of another site.
 */
export type LinkAsker = { kind: 'page' } | { kind: 'frame'; origin: string } | { kind: 'unsure' }

/**
 * Who asks, from the origin of the document that asks (null when the request does not say, as for a `window.open`) and the origin of the page.
 * Only the page may be answered by what the user kept for its site (« Toujours ouvrir les liens de ce type depuis ce site »), and only the page
 * is offered that box: a frame of another site must not use the yes the user gave the page, and the question it gets names it, not the page.
 * When nobody is named, the page is the asker only if it holds no frame of another site (`otherSiteFrames`): otherwise any of them could be.
 */
export function linkAsker(askerOrigin: string | null, pageOrigin: string | null, otherSiteFrames: boolean): LinkAsker {
  if (askerOrigin === null) return otherSiteFrames ? { kind: 'unsure' } : { kind: 'page' }
  if (askerOrigin === pageOrigin) return { kind: 'page' }
  return /^https?:\/\/[^/\s]+$/.test(askerOrigin) ? { kind: 'frame', origin: askerOrigin } : { kind: 'unsure' }
}

/**
 * The origin of the document of a frame, or null when there is no frame or it cannot be read (a frame that is going away throws when it
 * is asked): the caller then treats the frame as one of another site, and the log says why.
 */
export function originOfFrame(frame: { origin: string } | null | undefined): string | null {
  try {
    return frame ? frame.origin : null
  } catch (error) {
    console.warn('[engine] cannot read the origin of a frame, so it is taken for a frame of another site:', error instanceof Error ? error.message : String(error))
    return null
  }
}

/** What is said of a link in a log or a notice: its scheme, never the address (an e-mail address is personal). */
export const schemeOf = (url: string): string => (URL.canParse(url) ? new URL(url).protocol : 'unknown:')
