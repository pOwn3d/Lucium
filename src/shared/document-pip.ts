// Document Picture-in-Picture (`documentPictureInPicture.requestWindow()`): the small window a page writes a document of its own into and that stays above
// the other windows, the one Google Meet opens for a call with its buttons. Electron 45 never shows it (electron/electron#39633): Chromium makes the window,
// then Electron's handling of new windows destroys it, because it only knows tabs and popups. With the feature `document-pip` on, the engine takes that
// window before Electron destroys it and shows it in a window of Lucium (main/engine/document-pip-windows.ts). What is decided, as functions of what they
// read: which request is one, whether it may open, which window handed over is the one that was allowed, where it goes, how big it is, and what ends it.
// Nothing here knows Electron.

import { clamp } from './clamp'
import { popupKey, POPUP_FRAME_HEIGHT, type Rect, type Size } from './popup'

/**
 * What Electron calls the disposition of a document Picture-in-Picture window (Chromium's `NEW_PICTURE_IN_PICTURE`): `other`, its catch-all for the
 * dispositions it does not handle. Electron's own documentation of `setWindowOpenHandler` lists it.
 */
export const DOCUMENT_PIP_DISPOSITION = 'other'

/** How long a yes of the handler waits for the window it allowed: past it, a window Chromium hands over is not taken for that one. */
export const DOCUMENT_PIP_TICKET_MS = 10_000

/** The size of a window whose page asks for none (`requestWindow()` without a width or a height). */
export const DOCUMENT_PIP_DEFAULT_SIZE: Size = { width: 400, height: 300 }
/** The smallest the window may be made, by the page or by the user: a window of a few pixels that stays above the others is one nobody sees. */
export const DOCUMENT_PIP_MIN_SIZE: Size = { width: 240, height: 120 }
/** At most this share of the work area of the screen, each way: a page cannot cover the screen with a window that stays above the others. */
export const DOCUMENT_PIP_MAX_SHARE = 0.8
/** The window keeps this far from the edges of the work area when it opens in its corner. */
export const DOCUMENT_PIP_EDGE = 16

/** The address a new window starts from before its page writes anything into it: empty, `about:blank`, or `about:blank` with a fragment. */
export function isBlankWindowUrl(url: unknown): boolean {
  if (url === '') return true
  if (typeof url !== 'string' || !URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.protocol === 'about:' && parsed.pathname === 'blank'
}

/**
 * Whether a request the handler of new windows receives is a document Picture-in-Picture window: the disposition Electron gives no other request a
 * page can make, and a window that starts blank (the page writes its document into it; it never loads an address).
 */
export function isDocumentPipRequest(details: { disposition: unknown; url: unknown }): boolean {
  return details.disposition === DOCUMENT_PIP_DISPOSITION && isBlankWindowUrl(details.url)
}

/** Why a request is refused: the feature is off, the page that asks is not a page of the web, or no click of the user explains it. */
export type DocumentPipRefusal = 'switched-off' | 'not-a-web-page' | 'no-gesture'

export type DocumentPipVerdict = { kind: 'allow' } | { kind: 'refuse'; reason: DocumentPipRefusal }

/**
 * Whether a page may have its document Picture-in-Picture window. `opener` is the address of the page that asks; `gesture` says whether a click or a
 * key of the user explains the request, and uses it up: it is asked last, so that a refusal for another reason leaves the click to what it was for.
 * A refusal opens nothing, and never a tab.
 */
export function documentPipVerdict(input: { on: boolean; opener: string; gesture: () => boolean }): DocumentPipVerdict {
  if (!input.on) return { kind: 'refuse', reason: 'switched-off' }
  // `documentPictureInPicture` exists in the secure pages of the web only; an extension's page or one of Lucium's own never floats a document.
  if (!URL.canParse(input.opener) || !['http:', 'https:'].includes(new URL(input.opener).protocol)) return { kind: 'refuse', reason: 'not-a-web-page' }
  if (!input.gesture()) return { kind: 'refuse', reason: 'no-gesture' }
  return { kind: 'allow' }
}

/** The yes of the handler, for the window Chromium is to hand over next: one window per yes, within DOCUMENT_PIP_TICKET_MS. */
export class DocumentPipTicket {
  private issued: { at: number; key: string } | null = null

  /** The handler said yes at `now`, for the tab `key`. */
  issue(now: number, key: string): void {
    this.issued = { at: now, key }
  }

  /** The tab of the yes, and the yes used up, when one is waiting and recent enough; null otherwise. */
  take(now: number): string | null {
    const issued = this.issued
    this.issued = null
    if (!issued || now < issued.at || now - issued.at > DOCUMENT_PIP_TICKET_MS) return null
    return issued.key
  }
}

/** Why a window Chromium hands over is left to Electron (which destroys a document Picture-in-Picture window, as it always did). */
export type DocumentPipLeftOver = 'not-picture-in-picture' | 'not-allowed' | 'no-contents' | 'other-session'

/**
 * Whether the engine takes a window Chromium hands over. Only a document Picture-in-Picture window, only the one the handler allowed (`allowed`: the
 * yes was taken), only a real page (`contents`) and only one in the session of the page that asked: a private page's window stays in its private
 * session, or it is not shown at all.
 */
export function adoptionVerdict(input: { disposition: unknown; allowed: boolean; contents: boolean; sameSession: boolean }): { adopt: true } | { adopt: false; why: DocumentPipLeftOver } {
  if (input.disposition !== DOCUMENT_PIP_DISPOSITION) return { adopt: false, why: 'not-picture-in-picture' }
  if (!input.allowed) return { adopt: false, why: 'not-allowed' }
  if (!input.contents) return { adopt: false, why: 'no-contents' }
  if (!input.sameSession) return { adopt: false, why: 'other-session' }
  return { adopt: true }
}

/** The largest content the window may have on a work area of this size. */
const largest = (workArea: Size): Size => ({
  width: Math.max(DOCUMENT_PIP_MIN_SIZE.width, Math.floor(workArea.width * DOCUMENT_PIP_MAX_SHARE)),
  height: Math.max(DOCUMENT_PIP_MIN_SIZE.height, Math.floor((workArea.height - POPUP_FRAME_HEIGHT) * DOCUMENT_PIP_MAX_SHARE))
})

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0

/** The content size of the window: what the page asked for (or the default), between the minimum and its share of the screen. */
export function documentPipSize(asked: Partial<Size>, workArea: Size): Size {
  const most = largest(workArea)
  return {
    width: Math.round(clamp(positive(asked.width) ? asked.width : DOCUMENT_PIP_DEFAULT_SIZE.width, DOCUMENT_PIP_MIN_SIZE.width, most.width)),
    height: Math.round(clamp(positive(asked.height) ? asked.height : DOCUMENT_PIP_DEFAULT_SIZE.height, DOCUMENT_PIP_MIN_SIZE.height, most.height))
  }
}

/**
 * Where the window opens (its content): in the bottom right corner of the work area, DOCUMENT_PIP_EDGE from its edges, at the size handed over with it
 * (the page's, when Electron passes it on: Electron 45 hands none, and the window has the default size); after the first one, where the user last
 * left one (`remembered`), at that size, kept inside the work area.
 */
export function documentPipBounds(asked: Partial<Size>, workArea: Rect, remembered: Rect | null): Rect {
  const size = documentPipSize(asked, workArea)
  const right = workArea.x + workArea.width - size.width
  const bottom = workArea.y + workArea.height - size.height
  const x = remembered ? remembered.x : right - DOCUMENT_PIP_EDGE
  const y = remembered ? remembered.y : bottom - DOCUMENT_PIP_EDGE
  return { x: Math.round(clamp(x, workArea.x, right)), y: Math.round(clamp(y, workArea.y + POPUP_FRAME_HEIGHT, bottom)), ...size }
}

/** Where the content may be after the page called `resizeTo` / `moveTo` (`requested`): the same bounds as when it opened, wholly inside the work area. */
export function documentPipContentBounds(requested: Rect, workArea: Rect): Rect {
  const size = documentPipSize(requested, workArea)
  const x = Number.isFinite(requested.x) ? requested.x : workArea.x
  const y = Number.isFinite(requested.y) ? requested.y : workArea.y
  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(y, workArea.y + POPUP_FRAME_HEIGHT, workArea.y + workArea.height - size.height)),
    ...size
  }
}

/** A navigation as Electron tells of it (`did-start-navigation`). */
export interface NavigationFacts {
  isMainFrame: boolean
  isSameDocument: boolean
  url: string
}

/**
 * Whether a navigation of the floating document ends its window. The window shows the one document its page writes into it, as in Chromium, which closes it
 * when it navigates: a link or a script that sends it to an address (another origin included) closes it. A change of fragment, a frame inside it, and the
 * blank document it started from do not.
 */
export function pipNavigationEnds(navigation: NavigationFacts): boolean {
  return navigation.isMainFrame && !navigation.isSameDocument && !isBlankWindowUrl(navigation.url)
}

/** Whether a navigation of the page that opened the window ends it: the page goes to another document (the window belonged to the one before). */
export function openerNavigationEnds(navigation: Pick<NavigationFacts, 'isMainFrame' | 'isSameDocument'>): boolean {
  return navigation.isMainFrame && !navigation.isSameDocument
}

/**
 * What a key does in the floating window. ⌘W closes it (left to the menu bar, it would close the tab of the window behind); the commands of the menu
 * that act on tabs are kept from it, reloading included: a reload is a navigation, which would close the window.
 */
export function documentPipKey(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }, platform: string): 'close' | 'block' | 'pass' {
  const key = popupKey(input, platform)
  return key === 'reload' ? 'block' : key
}
