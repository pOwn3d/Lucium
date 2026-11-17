// Reader mode for one page: the article is extracted from the page by Mozilla's Readability (Apache-2.0, see docs/licences-tierces.md),
// run in an isolated world of the page, and shown in a cover laid over it (page-cover.ts). The page underneath is left as it is:
// leaving the reader (Escape) shows it again exactly where it was, and the tab's address and history never changed.
// The cover is a document of ours that runs no script (see shared/reader.ts); the links in it open in the tab.

import type { BrowserWindow, Input, WebContents } from 'electron'
// The library's own file, as text: it runs inside the page (it needs the page's DOM), not in this process.
import readabilitySource from '@mozilla/readability/Readability.js?raw'
import { randomBytes } from 'node:crypto'
import { canRead, cleanArticle, readerDocument } from '@shared/reader'
import { DEFAULT_READER_PREFS, readerMessage, type ReaderPrefs } from '@shared/reader-pill'
import { stepZoom } from '@shared/site-zoom'
import { PageCover } from './page-cover'
import type { Bounds } from './types'

/** An isolated world of its own: the page cannot see the library or tamper with it. Any number outside the ones Chromium hands to extensions would do. */
const READER_WORLD = 4_200_018
const EXTRACT_TIMEOUT_MS = 8000

const EXTRACT = `
${readabilitySource}
;(() => {
  try {
    const article = new Readability(document.cloneNode(true)).parse()
    if (!article) return null
    return { title: article.title, content: article.content, byline: article.byline, siteName: article.siteName, lang: article.lang, dir: article.dir, textLength: (article.textContent || '').length }
  } catch (error) {
    return { error: String(error) }
  }
})()`

/** The pill's choices (font, size, column, background), kept from one article to the next for as long as the application runs: they are not saved. */
let remembered: ReaderPrefs = DEFAULT_READER_PREFS

export type ReaderOutcome = 'opened' | 'closed' | 'unavailable'

export interface ReaderHost {
  win: BrowserWindow
  radius: number
  /** Opens a link of the article in the tab. */
  navigate(url: string): void
  /** Whether the reader carries the buttons that read the article aloud (a setting; asked each time the reader opens). */
  readAloud?(): boolean
  /** The user clicked or typed in the reader: a press in the page, for its pane (`PageEvents.focused`). */
  focused?(): void
}

export class ReaderMode {
  private cover: PageCover | null = null
  private bounds: Bounds | null = null
  /** The page's corner radius now: a cover made after a change must start with it. */
  private radius: number
  private factor = 1
  /** Entering the reader takes a moment (the extraction): a second request meanwhile is the same request. */
  private opening = false
  /** Counts the documents the page showed: an article extracted from one is never laid over the next. */
  private documents = 0

  constructor(
    private readonly wc: WebContents,
    private readonly host: ReaderHost
  ) {
    this.radius = host.radius
    // The page is left (a link, the address bar, back): what the reader showed is not what it shows any more.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.close()
    })
    // Another document arrived. A navigation that had started before the reader was opened (a slow server, a redirect that takes its
    // time) gives no other sign: without this the article of the page before would stay over the new one, under the new address.
    wc.on('did-navigate', () => {
      this.documents++
      this.close()
    })
  }

  isOpen(): boolean {
    return this.cover !== null
  }

  /** Whether the keyboard is in the reader laid over the page. */
  hasFocus(): boolean {
    return this.cover?.hasFocus() === true
  }

  async toggle(): Promise<ReaderOutcome> {
    if (this.cover) {
      this.close()
      return 'closed'
    }
    return this.open()
  }

  async open(): Promise<ReaderOutcome> {
    if (this.cover) return 'opened'
    if (this.opening) return 'unavailable'
    if (this.wc.isDestroyed() || !canRead(this.wc.getURL())) return 'unavailable'
    this.opening = true
    const shown = this.documents
    try {
      const article = cleanArticle(await this.extract())
      // The page may have been left, or the reader opened by another path, while the article was extracted.
      if (!article || this.wc.isDestroyed() || shown !== this.documents) return 'unavailable'
      if (this.cover) return 'opened'
      const url = this.wc.getURL()
      const cover = new PageCover(this.host.win, this.wc.session, this.radius, this.host.focused)
      const ui = cover.webContents
      // Every navigation of the cover is a link of the article: it opens in the tab, and the reader gives way to it.
      ui.on('will-navigate', (event, target) => {
        event.preventDefault()
        if (/^https?:\/\//i.test(target)) this.host.navigate(target)
      })
      ui.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:\/\//i.test(target)) this.host.navigate(target)
        return { action: 'deny' }
      })
      ui.on('before-input-event', (event, input) => this.onKey(event, input))
      // The pill tells what was chosen, or that the person wants out, by the title of its page; the nonce of the document keeps any other title (the article's) out.
      const nonce = randomBytes(18).toString('base64')
      ui.on('page-title-updated', (_event, title) => {
        const message = readerMessage(title, nonce)
        if (message?.kind === 'quit') this.close()
        else if (message) remembered = message.prefs
      })
      this.cover = cover
      this.factor = 1
      // The scripts a reader may have: the pill, and the buttons that read aloud while that is switched on. One nonce, drawn for this document, names them.
      await cover.load(readerDocument(article, url, this.host.readAloud?.() === true ? nonce : undefined, { nonce, prefs: remembered }))
      // Closed while its document loaded (the page went elsewhere, Escape): it is gone, and is not said to be open.
      if (this.cover !== cover) return 'unavailable'
      cover.place(this.bounds)
      cover.focus()
      return 'opened'
    } catch (error) {
      console.error('[reader] cannot open the reader:', error)
      this.close()
      return 'unavailable'
    } finally {
      this.opening = false
    }
  }

  /** Leaves the reader: the page under it shows again, and has the keyboard. */
  close(): void {
    const cover = this.cover
    if (!cover) return
    this.cover = null
    // A zoom in the reader must not stay on what the next cover (a crashed tab, another article) shows: they share the data: scheme.
    if (this.factor !== 1 && !cover.webContents.isDestroyed()) cover.webContents.setZoomFactor(1)
    cover.dispose()
    if (!this.wc.isDestroyed()) this.wc.focus()
  }

  /** ⌘+ ⌘− ⌘0 while reading: the text of the article gets bigger or smaller, for as long as the reader is open. */
  zoom(step: -1 | 0 | 1): boolean {
    const cover = this.cover
    if (!cover || cover.webContents.isDestroyed()) return false
    this.factor = step === 0 ? 1 : stepZoom(this.factor, step)
    cover.webContents.setZoomFactor(this.factor)
    return true
  }

  place(bounds: Bounds | null, radius?: number): void {
    this.bounds = bounds
    if (radius !== undefined) this.radius = radius
    this.cover?.place(bounds, radius)
  }

  raise(): void {
    this.cover?.raise()
  }

  dispose(): void {
    this.close()
  }

  private onKey(event: { preventDefault(): void }, input: Input): void {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  /** What Readability makes of the page, or null when it finds no article (or the page does not answer in time). */
  private async extract(): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        this.wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: EXTRACT }]) as Promise<unknown>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), EXTRACT_TIMEOUT_MS)
        })
      ])
      if (typeof result === 'object' && result !== null && 'error' in result) {
        console.warn('[reader] the extraction failed:', (result as { error: unknown }).error)
        return null
      }
      return result
    } catch (error) {
      // The page was navigated away or closed while the script ran: there is nothing to read.
      if (!this.wc.isDestroyed()) console.warn('[reader] the page could not be read:', (error as Error).message)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
