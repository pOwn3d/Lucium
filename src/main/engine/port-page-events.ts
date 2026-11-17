// The engine port (types.ts), what a page tells the shell (`PageEvents`, given to `Engine.createPage`) and what it asks of it. Re-exported by
// types.ts, which the rest of Lucium imports.

import type { SummaryLength } from '@shared/summary-prompt'
import type { FindState } from '@shared/model'
import type { AuthChallenge, Credentials } from '@shared/http-auth'
import type { PromptAnswer, PromptRequest } from '@shared/page-dialog'
import type { KeyInput } from '@shared/little-bar'
import type { PageTools, ToolMessage } from '@shared/page-tools'
import type { Submission } from '@shared/passwords'

export interface PageUpdate {
  url?: string
  title?: string
  /** The icon the page declares, as the interface may load it. '': the page has none it may load (the one it declares is refused), and the one of the page before goes. */
  faviconUrl?: string
  loading?: boolean
  /** With `loading: false`: the load came to a page that was navigated to (not only to a frame that loaded inside the page); the history counts a visit then. Absent is a visit. */
  visit?: boolean
  audible?: boolean
  muted?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  /** Which track actions the site registered with the MediaSession API (the media player greys out the buttons of the others). */
  trackActions?: { previous: boolean; next: boolean }
  /** The page may have come over a certificate that was not valid (one was let through for its host in this session): « Non sécurisé », never a padlock. */
  untrustedCertificate?: boolean
  /**
   * The language of the document when it is another one than the target of the translation (`translateTarget`): a language code, or '' once it is not (or
   * no longer) one. Sent only when it changes, and only while the language is read ('translate-local' on): a page in the target language sends nothing.
   */
  pageLanguage?: string
  /** With `url`: a new document of the page (a navigation, not one within the page): what belonged to the document before it (its translation) is over. */
  newDocument?: true
}

/** The entries the page's own menu may add to the usual ones: each is a web tool the settings switched on, asked for every time the menu opens. */
export interface PageMenuOptions {
  /** "Code QR de ce lien" on a link. */
  qrCode: boolean
  /** "Lire la sélection à voix haute" on selected text. */
  readAloud: boolean
  /** "Résumer la page" on the page itself, when the page summary of Settings › Outils web is on. */
  summary?: boolean
  /** « Traduire en <langue> » on the page itself, for a page in another language, while the translation is on (its language is read only then). */
  translate?: boolean
  /** The language pages are translated into (the settings' choice, else the interface's): the entry names it, and is offered for a page in another one. */
  translateTarget?: string
  /** The page is translated, or being translated: the entry is « Afficher l'original ». */
  translated?: boolean
  /** The mouse gestures are on for this site (the menu offers to leave it out), or left out of it (to bring it back); absent while the gestures are off. */
  gestures?: 'on' | 'off'
}

export const NO_MENU_OPTIONS: Readonly<PageMenuOptions> = Object.freeze({ qrCode: false, readAloud: false })

export interface PageEvents {
  update(patch: PageUpdate): void
  /** The page asked for the screen and the user chose a window (`picked`, its media source id). The window may be another window of Lucium than the one of the page. Only wired by the page annotation. */
  ownWindowShared?(picked: string): void
  /**
   * The page asked for a new window, or the user chose a link action: `peek` is a Shift+click. `byPage` says the page asked (a click on a
   * link, a script after a click) rather than the user choosing in a menu: only then do the settings of Liens decide front or behind.
   * `chromium` is the disposition Chromium itself gave the window (Electron's `details.disposition`): ⌥⌘-clic is the only keys
   * combination Electron lets the shell tell apart (shared/little-modifier.ts). `features` is the feature list the page gave `window.open`
   * (`details.features`): a sign-in window that asks for a size stays out of the mini window a plain `target="_blank"` link opens.
   */
  openWindow(url: string, disposition: 'foreground' | 'background' | 'peek' | 'little', byPage?: boolean, chromium?: string, features?: string): void
  /**
   * The user pressed the mouse or a key inside this page, or in a cover of ours laid over it (the reader, the page of a crash): it becomes the focused pane of a
   * split view. A click in a frame of another site is not told (its process draws it); a key is, whichever frame has the keyboard (see `Page.hasFocus`).
   */
  focused(): void
  /** A new document is ready: time to apply per-site customizations. */
  domReady(): void
  /** Some media of the page started or stopped playing (the player of the sidebar asks the page what it is doing now). */
  mediaChanged?(): void
  /** The page went full screen (a video's own button, `requestFullscreen()`) or left it. Electron puts the window in full screen but leaves the page where it was: the shell gives the page the window. Only wired for the pages of tabs. */
  fullscreen?(on: boolean): void
  /** Whether the page menu of a link offers "Ouvrir sans l’enregistrer" now (the setting is on). Asked each time the menu opens. */
  canOpenUnsaved?(): boolean
  /** Escape was pressed inside this page. Only wired when provided (the Glance preview closes on it). */
  escape?(): void
  /** The page closed itself (`window.close()`): Electron has already destroyed it, so whatever shows it must let it go. */
  closed?(): void
  /** HTTPS first: the site did not answer over https, and the page was opened over http instead. */
  httpsFallback?(host: string): void
  /** Result of an in-page search. `error` and `more` only come from the regular-expression search (see regex-find.ts). */
  found(result: { matches: number; ordinal: number; error?: FindState['error']; more?: boolean }): void
  /** "Search the web for the selection" chosen in the page context menu. */
  searchSelection(text: string): void
  /** "Copier l'adresse du lien" chosen in the page context menu: answers the text to put on the clipboard for this address (the setting may clean it). Only wired for a tab of a normal or private window. */
  copyLink?(url: string): string
  /** "Copy as Markdown" chosen in the page context menu, on a text selection. Only wired where the page has such a menu entry to show. */
  copyAsMarkdown?(): void
  /** "Effacer les données du site" chosen in the page context menu (the extension's right-click entry). Only wired for a tab of a normal or private window. */
  clearSiteData?(): void
  /** "Résumer la page": opens the summary panel of the page on screen. */
  summarize?(length: SummaryLength): void
  /** "Remplir avec de fausses données" on an editable field at (x, y) of the page. */
  fakeFill?(x: number, y: number): void
  /** « Traduire en <langue> » (or « Afficher l'original » on a translated page) on the page itself: done at once, without the panel. */
  translatePage?(): void
  /** The language the page's own language is compared to (the target of the translation): only a page in another one publishes its language. */
  translateTarget?(): string
  /** "Créer un raccourci pour ce site": opens the sheet that makes a direct shortcut for the page's site. */
  createShortcut?(): void
  /**
   * A server (401) or a proxy (407) asks for a login: resolves with the credentials, or null when the user gave up. Without it the
   * request is refused, as Electron does by default. Never called with a credential: the answer is the only place they pass.
   */
  authenticate?(challenge: AuthChallenge): Promise<Credentials | null>
  /**
   * The main frame of the page called `alert()`, `confirm()` or `prompt()` (`request.kind`): shows the box and resolves with what the user answered.
   * `signal` aborts when the page can no longer be answered (it is closing, going elsewhere, or its renderer died): the box must go. Only wired for
   * the pages of tabs; any other page (a preview, a panel of an extension, a mini window) leaves it out: its prompt() answers null, and its alert()
   * and confirm() show Electron's own sheet.
   */
  promptDialog?(request: PromptRequest, signal: AbortSignal): Promise<PromptAnswer>
  /**
   * The page on screen refused to be left (its `beforeunload` handler) while the shell was starting a navigation: resolves true when the user chose to
   * leave, false when they chose to stay. The sheet blocks nothing; `site` is the page's own host. Only wired for the pages of tabs: without it the
   * system box asks (engine/unload-guard.ts).
   */
  askLeave?(site: string): Promise<boolean>
  /**
   * The user submitted a form with a password in the main frame of this page (the page bridge, only loaded while the password manager is on).
   * `frameUrl` is the address the browser holds for the frame: the page does not name its origin. Only wired for the pages of tabs.
   */
  passwordSubmitted?(frameUrl: string, submission: Submission): void
  /** The page tried to open a window that no click of the user explains (a script on its own, a click used up already): nothing was opened. `site` is the page's host, as the interface names it. Called once per document. */
  popupBlocked?(site: string, url: string): void
  /** A `mailto:` or `tel:` link the user clicked, or a link to another application the user said yes to, could not be handed to the system. Only the scheme is reported, never the address. */
  externalLinkFailed?(scheme: string): void
  /** A server asked this page for a client certificate, and none was presented: `site` is the host of that server, for the notice in the window of the page. */
  clientCertificateRefused?(site: string): void
  /** The page asked to share the screen and the system does not let the application see it (macOS: Enregistrement de l'écran): `notice` tells the user where to change that. */
  screenShareBlocked?(notice: string, openSettings?: boolean): void
  /** A tool running in the page reported something (a gesture drawn, the page scrolled): already checked against the page's secret and the allowed shapes. */
  toolMessage?(message: ToolMessage): void
  /** Which web tools the page carries, asked when a new document is ready (the site of the page may be one the gestures are left out of). */
  pageTools?(): PageTools
  /** Which entries the page's menu adds (see `PageMenuOptions`); absent: none. */
  menuOptions?(): PageMenuOptions
  /** Whether the language of each document is read for the translation entry (the translation is on); absent: never read. */
  readsLanguage?(): boolean
  /** Whether an address is on a site in Developer Mode (`developerHosts`): its invalid certificate is let through without a question. Absent: none is. */
  developerSite?(url: string): boolean
  /** "Code QR de ce lien" chosen in the page's menu. */
  qrCode?(url: string): void
  /** "Désactiver / Activer les gestes de souris sur ce site" chosen in the page's menu. */
  toggleGestureSite?(): void
  /** "Inspecter l'élément" chosen in the page's menu could not open the tools: the sentence to show the user. Wired by everything that shows a page. */
  /** The developer tools did not open. `retry` opens them again, when the failure can be tried again (the element inspector can). */
  devToolsFailed?(message: string, retry?: () => void): void
  /**
   * A key was pressed while this page has the focus (keys with ⌘ or ⌃ only matter to the shell): answers true when the shell took
   * it, and then neither the page nor the menu bar sees it. Only wired when provided (mini windows have their own shortcuts).
   */
  shortcut?(input: KeyInput): boolean
}
