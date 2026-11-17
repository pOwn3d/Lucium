// A view of ours laid over a page, exactly on it: the page of a tab that crashed (error-pages.ts) and the reader (reader-mode.ts).
// The page underneath is left as it is — the same document, scroll position and history — and shows again when the cover goes.

import { WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { Bounds } from './types'

/** The longest address Chromium loads (url::kMaxURLChars, 2 MiB): a longer one fails the load without a word of why. */
export const MAX_COVER_URL_CHARS = 2 * 1024 * 1024

/**
 * The address of a document of the cover. In base64: a third longer than the text in UTF-8, where the percent-encoding made each mark of
 * the markup and each accented letter three to six times longer, so that an article of a few hundred kilobytes already passed the limit.
 * A document that still does not fit throws, with its size: the reader then says it is unavailable, and the log says why.
 */
export function coverUrl(html: string): string {
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`
  if (url.length > MAX_COVER_URL_CHARS) throw new Error(`the document is too large to be shown (${Math.round(url.length / 1024)} KB as an address, ${MAX_COVER_URL_CHARS / 1024} KB at most)`)
  return url
}

export class PageCover {
  private readonly view: WebContentsView
  private attached = false
  private closed = false

  constructor(
    private readonly win: BrowserWindow,
    session: Session,
    private radius: number,
    /** The user clicked or typed in the cover: for the page under it, as a press in the page itself (`PageEvents.focused`: the pane of a split view). */
    pressed?: () => void
  ) {
    // Same session as the page: a private window's cover keeps nothing on disk, and the pictures of an article load as the page's own.
    this.view = new WebContentsView({ webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } })
    this.view.setBorderRadius(radius)
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A document of ours, with no frame of another site: every click and key of the user in it is heard here.
    if (pressed) {
      this.view.webContents.on('input-event', (_event, input) => {
        if (input.type === 'mouseDown' || input.type === 'rawKeyDown' || input.type === 'keyDown') pressed()
      })
    }
  }

  get webContents(): WebContents {
    return this.view.webContents
  }

  /** Shows `html` (a complete document) in the cover. Rejects, saying why, a document too large for an address (see coverUrl). */
  load(html: string): Promise<void> {
    return this.view.webContents.loadURL(coverUrl(html))
  }

  /** Where the page is on screen (null: hidden). The cover follows it, and so do its corners (`radius`, when the page's changed). */
  place(bounds: Bounds | null, radius = this.radius): void {
    if (radius !== this.radius) {
      this.radius = radius
      this.view.setBorderRadius(radius)
    }
    if (this.closed || this.win.isDestroyed()) return
    if (!bounds) {
      if (this.attached) this.win.contentView.removeChildView(this.view)
      this.attached = false
      return
    }
    this.view.setBounds(bounds)
    // Added once, after the page: re-adding it at every layout would lift it above the panels that were put on top of the page.
    if (!this.attached) this.win.contentView.addChildView(this.view)
    this.attached = true
  }

  /** The page was brought above the other views: so is its cover. */
  raise(): void {
    if (this.attached && !this.closed && !this.win.isDestroyed()) this.win.contentView.addChildView(this.view)
  }

  focus(): void {
    if (!this.closed && !this.view.webContents.isDestroyed()) this.view.webContents.focus()
  }

  /** Whether the keyboard is in the cover (the page under it has the keyboard then, as far as its pane is concerned). */
  hasFocus(): boolean {
    return !this.closed && !this.view.webContents.isDestroyed() && this.view.webContents.isFocused()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.attached && !this.win.isDestroyed()) this.win.contentView.removeChildView(this.view)
    this.attached = false
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }
}
