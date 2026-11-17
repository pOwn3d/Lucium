// A layer of ElectronPage (electron-page.ts): where the page goes and what the user does with the whole of it (loading, history, keys,
// printing, reader mode, the Markdown export, the PDF viewer, the developer tools, focus, zoom, find). Cut out of electron-page.ts as it was.

import { foreignLanguageOf } from '@shared/translate-quick'
import { isPdfViewerUrl } from '@shared/pdf-viewer'
import { isInternalPageUrl, isInternalScheme } from '@shared/internal-page'
import { getLanguage } from '@shared/i18n'
import { FIND_HIGHLIGHT_CSS, type FindOptions } from '@shared/ipc'
import { physicalKey } from '@shared/keybindings'
import { isClosedPageUrl } from '@shared/closed-history'
import type { LoadFailure } from '@shared/dead-tabs'
import { inspectDevToolsAt, showDevTools } from './devtools-open'
import { restorableHistory } from './history-restore'
import type { ReaderOutcome } from './reader-mode'
import { REGEX_FIND_WORLD, RegexFinder } from './regex-find'
import { DECLARED_SEARCH_SCRIPT } from '@shared/opensearch'
import { downloadImages, type DownloadOptions, type ImageDownload } from './resource-fetch'
import type { Page, PageKey } from './types'
import { t } from '@shared/i18n'
import { devToolsFailureMessage, inspectPoint, type DevToolsOutcome, type DevToolsRequest } from '@shared/devtools-request'
import { pdfZoomScript, isNavigable, isShellNavigable, SEARCH_DISCOVERY_WORLD } from './electron-page-scripts'
import { ElectronPageBase } from './electron-page-base'
import { internalLoadHeaders } from './internal-pages'

export abstract class ElectronPageNavigation extends ElectronPageBase {
  /** The Back / Forward list as the page had it when its close started (`keepHistory`): null while the page is open or if it was not read. */
  private leftHistory: { entries: Array<{ title: string; url: string }>; index: number } | null = null
  /** Lets go of the session an extension holds on the page (ElectronPageContent): the page goes where it may not follow. */
  abstract debugDetach(): void
  /**
   * Tells the shell the language of the document, only when it is another one than the target of the translation (or no longer is): a page in the target
   * language, the common case, sends nothing (shared/translate-quick.ts `foreignLanguageOf`).
   */
  protected publishLanguage(): void {
    const language = foreignLanguageOf(this.pageLang, this.events.translateTarget?.() ?? getLanguage())
    if (language === this.publishedLang || this.gone) return
    this.publishedLang = language
    this.events.update({ pageLanguage: language })
  }

  loadURL(url: string): void {
    // View › Developer › View Source opens `view-source:` of a web page, and the shell opens the Extensions page; a page itself can never navigate to either
    // (will-navigate, will-redirect, will-frame-navigate and window.open still refuse them).
    if (!isShellNavigable(url)) throw new Error(`Refusing to load a non-web URL: ${url.split(':')[0]}:`)
    this.leave.intend(() => this.loadURL(url))
    // From this call on, not from the commit: a protocol session an extension holds ends now (the load may wait for the proxy, then for the old page's
    // `beforeunload`), and none starts until the page is where it goes (see HeadingNavigation).
    this.heading.queue(url)
    if (isInternalPageUrl(url)) this.debugDetach()
    const pending = this.networkSettled()
    // A request must not leave by a route the user did not choose: the page waits until its session has the proxy.
    if (pending) {
      void pending.then(() => {
        if (!this.gone) this.navigate(url)
      })
      return
    }
    this.navigate(url)
  }

  private navigate(url: string): void {
    this.heading.handed(url)
    // The shell's own load of the Extensions page carries the secret that gets its document served (engine/internal-pages.ts). It is added here and nowhere
    // else: a page of the web cannot make a load that has it.
    const extraHeaders = isInternalPageUrl(url) ? internalLoadHeaders(this.webContents.session) : null
    void (extraHeaders === null ? this.webContents.loadURL(url) : this.webContents.loadURL(url, { extraHeaders })).catch((error: unknown) => {
      const code = (error as { code?: string }).code
      // A page closed or superseded mid-load fails with ERR_ABORTED/ERR_FAILED: not worth a log line. A network failure is shown to
      // the user as an error page (see PageErrors), not an engine fault.
      if (code !== 'ERR_ABORTED' && !code?.startsWith('ERR_') && !this.gone) console.error(`[engine] load failed for page ${this.id}:`, error)
    })
  }
  watchInput(listener: (key: PageKey) => void): () => void {
    const handler = (_event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      listener({ type: input.type, code: physicalKey(input), key: input.key, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift, isAutoRepeat: input.isAutoRepeat })
    }
    this.webContents.on('before-input-event', handler)
    return () => void this.webContents.off('before-input-event', handler)
  }
  watchKeys(listener: ((key: PageKey) => boolean) | null): void {
    if (this.keyListener) this.webContents.off('before-input-event', this.keyListener)
    this.keyListener = null
    if (!listener) return
    this.keyListener = (event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      const key: PageKey = { type: input.type, code: physicalKey(input), key: input.key, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift, isAutoRepeat: input.isAutoRepeat }
      if (listener(key)) event.preventDefault()
    }
    this.webContents.on('before-input-event', this.keyListener)
  }
  goBack(): void {
    this.leave.intend(() => this.goBack())
    this.headToEntry(this.webContents.navigationHistory.getActiveIndex() - 1)
    this.webContents.navigationHistory.goBack()
  }
  goForward(): void {
    this.leave.intend(() => this.goForward())
    this.headToEntry(this.webContents.navigationHistory.getActiveIndex() + 1)
    this.webContents.navigationHistory.goForward()
  }
  /** A move through the history is a navigation like a load: what it reaches, if it is the Extensions page, is known before Chromium announces it. */
  private headToEntry(index: number): void {
    const url = index >= 0 ? this.webContents.navigationHistory.getEntryAtIndex(index)?.url : undefined
    // No such entry: the move does nothing, and what was under way stays so.
    if (typeof url !== 'string' || url === '') return
    this.heading.handed(url)
    if (isInternalScheme(url)) this.debugDetach()
  }
  reload(): void {
    // The Extensions page is served to a load of the shell: a reload is one of its own making, not the replay of the entry.
    const here = this.webContents.getURL()
    if (isInternalPageUrl(here)) return this.loadURL(here)
    this.leave.intend(() => this.reload())
    this.webContents.reload()
  }
  navigationEntries(): { entries: Array<{ title: string; url: string }>; index: number } {
    if (!this.gone) return this.readHistory()
    // Electron takes `view.webContents` away when the close is over: a sleep keeps the list after `release()` (browser-sleep.ts), so what the page had
    // when it was let go is what it answers. A page that left nothing cannot answer, and the caller is told so.
    if (this.leftHistory) return this.leftHistory
    throw new Error(`page ${this.id} is gone and left no list of its pages`)
  }
  private readHistory(): { entries: Array<{ title: string; url: string }>; index: number } {
    const history = this.webContents.navigationHistory
    return { entries: history.getAllEntries().map((e) => ({ title: e.title, url: e.url })), index: history.getActiveIndex() }
  }
  /** Reads the list of pages just before the close starts (`release`, `destroy`), while the web contents is still there to be asked. */
  protected keepHistory(): void {
    if (this.gone) return
    try {
      this.leftHistory = this.readHistory()
    } catch (error) {
      // The close goes on without the list: the tab wakes at its address alone, as before the list was kept.
      console.warn(`[engine] the pages of page ${this.id} could not be read before it closed:`, (error as Error).message)
      this.leftHistory = null
    }
  }
  /** A close that did not happen (the page kept itself awake): the list is read live again, and the one kept would be out of date. */
  protected forgetKeptHistory(): void {
    this.leftHistory = null
  }
  goToIndex(index: number): void {
    this.leave.intend(() => this.goToIndex(index))
    this.headToEntry(index)
    this.webContents.navigationHistory.goToIndex(index)
  }
  restoreHistory(history: { entries: Array<{ title: string; url: string }>; index: number }): boolean {
    const kept = restorableHistory(history, isNavigable)
    if (!kept) return false
    this.webContents.navigationHistory.restore(kept).catch((error: unknown) => {
      // The pages behind are lost, not the one in front: the page the tab was on is loaded the plain way.
      console.error(`[engine] cannot restore the history of page ${this.id}; loading its address instead:`, error)
      if (!this.gone) this.loadURL(kept.entries[kept.index]!.url)
    })
    return true
  }
  restoreClosedHistory(entries: ReadonlyArray<{ url: string; title: string }>, index: number): Promise<void> {
    // Whatever the caller holds, only web pages (http and https) are replayed: a closed tab never brings a file or an extension page back.
    if (entries.length === 0 || !entries.every((entry) => isClosedPageUrl(entry.url)) || !Number.isInteger(index) || index < 0 || index >= entries.length) {
      return Promise.reject(new Error('the pages to restore are not a list of web addresses'))
    }
    return this.webContents.navigationHistory.restore({ entries: entries.map(({ url, title }) => ({ url, title })), index })
  }
  reloadIgnoringCache(): void {
    const here = this.webContents.getURL()
    if (isInternalPageUrl(here)) return this.loadURL(here)
    this.leave.intend(() => this.reloadIgnoringCache())
    this.webContents.reloadIgnoringCache()
  }
  stop(): void {
    this.webContents.stop()
  }
  pasteIntoFocus(): void {
    this.webContents.paste()
  }

  print(): void {
    this.webContents.print({}, (success, reason) => {
      // Cancelling the dialog is a normal outcome; anything else is worth a line.
      if (!success && reason && reason !== 'cancelled' && reason !== 'Print job canceled') console.error(`[engine] print failed on page ${this.id}: ${reason}`)
    })
  }
  savePage(path: string): Promise<void> {
    return this.webContents.savePage(path, 'HTMLComplete')
  }
  printToPdf(options: Parameters<Page['printToPdf']>[0]): Promise<Uint8Array> {
    return this.webContents.printToPDF({ ...options, pageSize: 'A4', preferCSSPageSize: false })
  }
  toggleReader(): Promise<ReaderOutcome> {
    return this.gone ? Promise.resolve('unavailable') : this.reader.toggle()
  }
  markdownSelection(): Promise<string | null> {
    return this.gone ? Promise.resolve(null) : this.markdown.selection()
  }
  pickMarkdown(): Promise<string | null> {
    return this.gone ? Promise.resolve(null) : this.markdown.pick()
  }
  endMarkdownPick(): void {
    if (!this.gone) this.markdown.stop()
  }
  downloadImages(images: ReadonlyArray<{ reference: string; url: string }>, options?: DownloadOptions): Promise<ImageDownload> {
    if (this.gone) return Promise.resolve({ files: [], failures: [t('engine.la-page-est-fermee')] })
    // The session of the tab: its cookies go along, as they do for the images the page shows, and the request is the one of its profile.
    const ses = this.webContents.session
    return downloadImages((url, init) => ses.fetch(url, init), images, options)
  }
  showsPdfViewer(): boolean {
    const wc = this.liveContents()
    if (!wc) return false
    try {
      return wc.mainFrame.framesInSubtree.some((frame) => isPdfViewerUrl(frame.url))
    } catch (error) {
      // A frame disposed while the list was read (the page navigated): it is not a viewer for this look, and the next one asks again.
      console.warn(`[engine] the frames of page ${this.id} could not be read to tell a PDF viewer:`, (error as Error).message)
      return false
    }
  }
  async viewerZoom(step: -1 | 0 | 1): Promise<boolean> {
    if (this.gone) return false
    // While reading, the text of the article is what the zoom entries change.
    if (this.reader.zoom(step)) return true
    // The viewer is a page of an extension inside the tab: the browser's zoom does not reach it, its own toolbar does.
    const viewer = this.webContents.mainFrame.framesInSubtree.find((frame) => isPdfViewerUrl(frame.url))
    if (!viewer) return false
    try {
      return (await viewer.executeJavaScript(pdfZoomScript(step))) === true
    } catch (error) {
      // The viewer was navigated away or closed while the script ran: nothing was zoomed, and the page is not a viewer any more.
      if (this.gone || /disposed|destroyed/i.test(String(error))) return false
      throw error
    }
  }
  openDevTools(request: DevToolsRequest): Promise<DevToolsOutcome> {
    if (this.gone) return Promise.resolve({ ok: false, reason: 'closed', detail: 'the page is gone' })
    return showDevTools(this.webContents, request)
  }

  /** "Inspecter l'élément": the tools open on the element under the pointer; when they cannot, the user is told (the page's menu has no other way to answer). */
  protected async inspectAt(params: Electron.ContextMenuParams): Promise<void> {
    if (this.gone) return
    const wc = this.webContents
    const outcome = await inspectDevToolsAt(wc, inspectPoint(params, wc.getZoomFactor()))
    if (outcome.ok) return
    console.error(`[engine] "Inspect element" failed for page ${this.id} (${outcome.reason}):`, outcome.detail ?? '')
    this.events.devToolsFailed?.(devToolsFailureMessage(outcome.reason, 'inspect'), () => void this.inspectAt(params))
  }
  focus(): void {
    // A view lent to the floating window is not the tab's to focus: that would bring the other window to the front.
    if (this.loan) return
    this.webContents.focus()
  }
  hasFocus(): boolean {
    if (this.gone) return false
    // The web contents has the keyboard whichever of its frames holds it; the reader and the page of a crash are views of their own, laid over it.
    return this.webContents.isFocused() || this.reader.hasFocus() || this.errors.hasFocus()
  }
  processId(): number {
    return this.webContents.getOSProcessId()
  }
  frameProcessIds(): number[] {
    const wc = this.liveContents()
    if (!wc) return []
    const own = wc.getOSProcessId()
    const pids = new Set<number>()
    try {
      for (const frame of wc.mainFrame.framesInSubtree) if (frame.osProcessId > 0 && frame.osProcessId !== own) pids.add(frame.osProcessId)
    } catch (error) {
      // A frame disposed while the list was read (the page navigated): what was read so far is kept, and the next refresh reads it again.
      console.warn(`[engine] the frames of page ${this.id} could not all be read for the task manager:`, (error as Error).message)
    }
    return [...pids]
  }
  setMuted(muted: boolean): void {
    this.webContents.setAudioMuted(muted)
  }

  setZoom(factor: number): void {
    if (!this.gone) this.webContents.setZoomFactor(factor)
  }
  loadFailure(): LoadFailure | null {
    return this.errors.loadFailure()
  }
  showsError(): boolean {
    return this.errors.showsErrorPage()
  }
  find(text: string, options: FindOptions): void {
    if (!text) return this.stopFind()
    if (options.regex) {
      // Chromium's own search paints a selection of its own: end it before the regular expression takes over.
      if (!this.regexFinder?.active) this.webContents.stopFindInPage('clearSelection')
      this.regexFinder ??= new RegexFinder({
        run: (code) => this.webContents.executeJavaScriptInIsolatedWorld(REGEX_FIND_WORLD, [{ code }]),
        setCss: (css) => this.applyCss(css, 'find'),
        report: (result) => this.events.found(result)
      })
      this.regexFinder.find(text, { next: options.next, forward: options.forward, matchCase: options.matchCase })
      return
    }
    this.regexFinder?.stop()
    this.applyCss(FIND_HIGHLIGHT_CSS, 'find')
    this.webContents.findInPage(text, {
      forward: options.forward ?? true,
      findNext: options.next ?? false,
      matchCase: options.matchCase ?? false
    })
  }
  declaredSearches(): Promise<unknown> {
    return this.webContents.executeJavaScriptInIsolatedWorld(SEARCH_DISCOVERY_WORLD, [{ code: DECLARED_SEARCH_SCRIPT }])
  }
  stopFind(): void {
    if (this.gone) return
    this.regexFinder?.stop()
    this.webContents.stopFindInPage('clearSelection')
    this.applyCss('', 'find')
  }
}
