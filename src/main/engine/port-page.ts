// The engine port (types.ts), the page: one interface per capability (its navigation, what is made of its document, what runs in it, its developer
// tools, its keys, its life), joined into `Page` with its media (port-media.ts) and its place in the windows (port-windows.ts). Re-exported by
// types.ts, which the rest of Lucium imports.

import type { FormFieldHint } from '@shared/fake-fill'
import type { FindOptions } from '@shared/ipc'
import type { PageProbe } from '@shared/sleep'
import type { LoadFailure } from '@shared/dead-tabs'
import type { DevToolsOutcome, DevToolsRequest } from '@shared/devtools-request'
import type { WebRtcPolicy } from '@shared/fingerprint'
import type { PageTools, ToolCommand } from '@shared/page-tools'
import type { FillPlan } from '@shared/login-form'
import type { DownloadOptions, ImageDownload } from './resource-fetch'
import type { PageMedia } from './port-media'
import type { Bounds, PageView } from './port-windows'

/** A key press in a page, as the shell's switcher reads it (before the page or the menu bar sees it). */
export interface PageKey {
  type: 'keyDown' | 'keyUp'
  /** The physical key (`Tab`, `KeyA`, `Escape`…): what accelerators are made of. */
  code: string
  /** The character of the key (`Control` for the key of that name). */
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
}

/** Independent stylesheets a page can carry: each is replaced without touching the others. */
export type CssSlot = 'boost' | 'theme' | 'blocker' | 'find' | 'saver' | 'dark'

/** Where the page goes, where it has been, how its last load ended, and what is searched or zoomed in it. */
export interface PageNavigation {
  loadURL(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
  /**
   * The pages this tab went through, oldest first, and the one it is on. Still answers once `release()` or `destroy()` has closed the page, with the
   * list it had when the close started (a sleep keeps it after the close); a page that never had one to give throws.
   */
  navigationEntries(): { entries: Array<{ title: string; url: string }>; index: number }
  goToIndex(index: number): void
  /**
   * Gives a new page the history of the one it replaces (`navigationEntries()` of the old page) and loads the entry the index names. Only
   * the pages that can be loaded again are kept. Answers false when none is, and nothing was started.
   */
  restoreHistory(history: { entries: Array<{ title: string; url: string }>; index: number }): boolean
  /**
   * Puts a list of pages back as this tab's Back / Forward list and loads the one at `index` (a reopened tab; it must be called on a page that
   * has not navigated yet). Web addresses only. Resolves once that page has loaded; rejects when it cannot be restored or does not load.
   */
  restoreClosedHistory(entries: ReadonlyArray<{ url: string; title: string }>, index: number): Promise<void>
  /** Reloads bypassing the HTTP cache. */
  reloadIgnoringCache(): void
  stop(): void
  /**
   * When the page is shown by an embedded viewer that has a zoom of its own (the PDF viewer), steps that zoom (-1, +1) or puts it back
   * to 100 % (0) and answers true. Any other page answers false and nothing happens: its zoom is `setZoom`.
   */
  viewerZoom(step: -1 | 0 | 1): Promise<boolean>
  /** Whether a frame of the PDF viewer is in this page now: the document is a PDF, whatever its address. Optional: only the forced dark mode asks. */
  showsPdfViewer?(): boolean
  /** Text zoom of the page, 1 = 100 %. */
  setZoom(factor: number): void
  /**
   * How the last load of the page ended badly: the network error of a load that failed (no address found, connection refused, timed out…), the
   * certificate refused, or the error status of its main document. Null for a page that loaded (shared/dead-tabs.ts decides which make a dead tab).
   */
  loadFailure(): LoadFailure | null
  /** Whether one of our error pages is on screen or on its way (the site does not answer, a certificate is refused, the page crashed): what the page now shows is not a page of the site. */
  showsError(): boolean
  find(text: string, options: FindOptions): void
  stopFind(): void
  /** The search engines the loaded document declares about itself (`<link rel="search">`), as the page reports them; rejects when the page is gone. Reads the document, asks the network for nothing. */
  declaredSearches(): Promise<unknown>
}

/** What is made of the document: printed, saved, read on its own, exported as Markdown, its images kept, its pictures taken. */
export interface PageDocument {
  /** Opens the print dialog of the system. */
  print(): void
  /** The page as a PDF, laid out for paper with the options given (header and footer templates, margins in inches). */
  printToPdf(options: { displayHeaderFooter: boolean; headerTemplate: string; footerTemplate: string; printBackground: boolean; margins: { top: number; bottom: number; left: number; right: number } }): Promise<Uint8Array>
  /** Saves the page with its resources to `path` (a complete HTML page and a folder of files). */
  savePage(path: string): Promise<void>
  /**
   * Reader mode: shows the article of the page on its own, laid over the page, or takes it away again. 'unavailable' when the page
   * has no article (or is not a web page). The page underneath is not touched, and its address and history stay as they were.
   */
  toggleReader(): Promise<'opened' | 'closed' | 'unavailable'>
  /** Markdown export: the text selected in the page, as the JSON text of a snapshot (shared/markdown-export.ts); null when nothing is selected. */
  markdownSelection(): Promise<string | null>
  /**
   * Markdown export: shows the picker over the page (the selection if there is one, else blocks to keep or leave out) and waits for the
   * user. Resolves with the JSON text of what they chose (`parsePick`), or null when they left. A second call ends the first.
   */
  pickMarkdown(): Promise<string | null>
  /** Ends the picker of `pickMarkdown` from outside. */
  endMarkdownPick(): void
  /**
   * Downloads images the page lists, with the session of this tab (its cookies, the page as referrer). Never throws for one image:
   * what could not be kept is in `failures`. See engine/resource-fetch.ts for the limits.
   */
  downloadImages(images: ReadonlyArray<{ reference: string; url: string }>, options?: DownloadOptions): Promise<ImageDownload>
  /** PNG of the visible area (or of `region`, in page coordinates), or of the whole document (capped in height) when `full`. */
  capture(full: boolean, region?: Bounds, onCut?: (maxHeight: number) => void): Promise<Buffer>
  /**
   * A small JPEG of the visible area, `width` wide at most: the picture is scaled and encoded straight from the capture, without the PNG of the
   * whole screen that `capture` encodes (and that a picture made from it decodes again). Empty when the page drew nothing.
   */
  thumbnail?(width: number, quality: number): Promise<Buffer>
  /**
   * What the page's viewport shows, as the browser itself renders it: unlike `capture`, it does not depend on the window being on
   * screen (chrome.tabs.captureVisibleTab). `quality` (0-100) is for jpeg.
   */
  captureViewport(format: 'png' | 'jpeg', quality: number): Promise<Buffer>
}

/** What runs in the page: its style sheets, scripts in its own world and in isolated ones, its forms, the in-page tools. */
export interface PageScripts {
  /** Pastes the clipboard into the element the page has focused, as a Cmd+V would (an extension's `document.execCommand('paste')`, see shared/chrome-compat.ts). */
  pasteIntoFocus(): void
  /** Replaces the CSS of one slot on this page; a new document starts clean. */
  applyCss(css: string, slot?: CssSlot): void
  /**
   * Chromium's WebRTC policy for this page: which network interfaces its candidates may show. `null` puts Chromium's default back. It stays across
   * navigations (it belongs to the page's web contents).
   */
  setWebRtcPolicy(policy: WebRtcPolicy | null): void
  /** Runs a script in the page and returns its result (undefined when the page is gone). */
  evaluate(js: string): Promise<unknown>
  runScript(js: string): void
  /** The visible text of the page (what the summary reads), at most maxChars; empty when the page is gone. */
  readText?(maxChars: number): Promise<string>
  /** The fields of the form around a point of the page (the form of the field under it, else the page): what the fake data may fill. */
  readFormFields?(x: number, y: number): Promise<FormFieldHint[]>
  /** Writes the values of the fields the plan names; returns how many were written. */
  fillFormFields?(values: Array<{ index: number; value: string }>): Promise<number>
  /**
   * What the page reads of `prefers-color-scheme` (the setting « Apparence demandée aux sites »): `light` or `dark`, or `null` for its own. Only the page: nothing of
   * the interface changes, and `nativeTheme` is not touched. Where the engine cannot give one page its own scheme, it is absent.
   */
  setColorScheme?(scheme: 'light' | 'dark' | null): void
  /**
   * The in-page tools this page carries (autoscroll, gestures, synchronized scrolling): installed in the document on screen now and in every
   * document after it, taken out when switched off. The same tools twice change nothing.
   */
  setPageTools(tools: PageTools): void
  /**
   * Writes a login into the sign-in form of the page: in the main frame only, in an isolated world, and only while the page is still on the
   * origin the plan names (checked here and again in the page). Resolves with the page's own answer, to be read with `parseFillOutcome`.
   * The plan holds a password: it goes to the page's script and is never logged.
   */
  fillLogin(plan: FillPlan): Promise<unknown>
  /** Hands a command to a tool of the page (the position of the pane beside it, for synchronized scrolling). Does nothing if the page lacks the tool. */
  toolCommand(command: ToolCommand): void
  /**
   * Lets the user point at an element of the page (hover highlight, click to choose, Escape to cancel).
   * Resolves with a CSS selector for it, or null when cancelled or when the page navigated away.
   */
  pickElement(): Promise<string | null>
  /** Runs a script of the local page translation (shared/translate-page-script.ts) in its own isolated world of this page; answers what it returned. */
  translateScript?(code: string): Promise<unknown>
  /**
   * Runs a script of the readable mode (its probe and its engine, shared/readable-engine.ts) in the mode's own isolated world of this page
   * (`READABLE_WORLD`): the page can neither see it nor change what it reads. Answers what it returned; rejects for a page that is gone.
   */
  runReadable?(code: string): Promise<unknown>
  /**
   * Runs a script of the animation of « Effacer les données du site » (shared/site-data-overlay.ts) in its own isolated world of this page
   * (`SITE_DATA_OVERLAY_WORLD`): the page can neither see it nor reach the drawing. Answers what it returned; rejects for a page that is gone.
   */
  runClearOverlay?(code: string): Promise<unknown>
  /**
   * Runs a call of the layer of the page annotation (shared/page-annotate-layer.ts) in the layer's own isolated world of this page
   * (`PAGE_ANNOTATE_WORLD`): the page can read neither the layer's state nor what is drawn and typed in it. Answers what the call returned;
   * rejects for a page that is gone.
   */
  runAnnotateLayer?(code: string): Promise<unknown>
  /**
   * Runs the script that reads the text of the page for the full-text index (shared/page-index.ts) in its own isolated world (`PAGE_INDEX_WORLD`):
   * the page cannot change what is read. Answers the text, or null for a page that must not be indexed; rejects for a page that is gone.
   */
  runPageIndex?(code: string): Promise<unknown>
}

/** The developer tools of the page, and the DevTools protocol the chrome.debugger shim drives. */
export interface PageDevTools {
  /**
   * Opens the developer tools in their own window and brings them to what was asked: `tools` just shows them (on the panel they were last on), a panel,
   * or `inspect` that starts picking an element of the page. Says how it went and never rejects: the shell tells the user when it did not.
   */
  openDevTools(request: DevToolsRequest): Promise<DevToolsOutcome>
  /**
   * DevTools protocol access, for the chrome.debugger shim. `allowUrl` says which addresses the page may be on while attached: attaching
   * to another one throws, and a page that goes to another one is detached (an error page of the application counts as another one).
   */
  debugAttach(version: string, onEvent: (method: string, params: unknown) => void, onDetach: (reason: string) => void, allowUrl: (url: string) => boolean): void
  debugSend(method: string, params: unknown): Promise<unknown>
  debugDetach(): void
  isDebugAttached(): boolean
  /** Sends a message to the document of the page (the preload of an application page hears it); false when the page is gone, nothing is sent then. */
  sendToDocument(channel: string, payload: unknown): boolean
}

/** The keyboard: whether the page has it, and the keys pressed in it. */
export interface PageInput {
  focus(): void
  /**
   * Whether the keyboard is in this page now: in any frame of it (one of another site included, which a click gives the keyboard without `PageEvents.focused`
   * being told), or in a cover of ours laid over it (the reader, the page of a crash). False for a page that is gone. What the commands of a split view act on.
   */
  hasFocus(): boolean
  /**
   * Hands every key press of this page to `listener` first (true: it took the key, and neither the page nor the menu bar sees it), or stops
   * doing so (null). Nothing is listened to until it is asked for: the page costs nothing when no feature reads its keys.
   */
  watchKeys(listener: ((key: PageKey) => boolean) | null): void
  /**
   * Tells `listener` of every key press of this page, without taking any: it cannot stop the key (the answer comes after the key). A listener of
   * its own, apart from `watchKeys`. Returns the way to stop listening. Optional: only the page annotation reads the keys this way.
   */
  watchInput?(listener: (key: PageKey) => void): () => void
}

/** The processes of the page, its sleep and its end. */
export interface PageLifecycle {
  /** The operating-system process that renders this page. */
  processId(): number
  /**
   * The operating-system processes of the frames of other sites inside this page (an advertisement, an embedded player, a sign-in), its own
   * excepted: the task manager names them after the tab. Optional: only the task manager asks.
   */
  frameProcessIds?(): number[]
  /**
   * Freezes the page: its memory and state stay, but nothing runs (timers, workers, network events) until `thaw()`. A frozen page
   * does not answer scripts, and showing it thaws it. Resolves false when it could not be frozen.
   */
  freeze(): Promise<boolean>
  /** Lets a frozen page run again, with the state it had. Does nothing for a page that is not frozen. */
  thaw(): Promise<void>
  /** What the page holds that a sleep would lose. Null when it cannot answer: gone, frozen, or no reply within a few seconds. */
  probeForSleep(): Promise<PageProbe | null>
  /**
   * Whether the page was given the camera, the microphone or the screen since its last navigation: a call or a recording may be under way, and
   * the sweep neither freezes nor frees it. Electron does not say when a capture ends, so the mark lasts until the page goes elsewhere.
   */
  usesCapture?(): boolean
  /**
   * Closes the page for a sleep, unless it asks to confirm leaving (its `beforeunload` cancels): then it stays as it is and the answer is false. True
   * once it is closed. Without it, the caller destroys the page.
   */
  release?(): Promise<boolean>
  destroy(): void
}

/** A web page the engine made (`Engine.createPage`): every capability of it. */
export interface Page extends PageNavigation, PageDocument, PageScripts, PageDevTools, PageInput, PageMedia, PageView, PageLifecycle {
  readonly id: string
}
