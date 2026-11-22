// `window.lucium`: everything the interface can ask of the main process, as the preload exposes it. Moved out of ipc.ts as it was;
// ipc.ts still exports it.

import type { OllamaModelList } from './ollama'
import type { TranslateRequest, TranslateView } from './translate-local'
import type { HistoryEntry } from './model'
import type { PageMatch } from './page-index'
import type { HistoryRange } from './history-range'
import type { Action } from './sidebar'
import type { AddFilterListResult } from './custom-filter-lists'
import type { SiteDataBatchRequest, SiteDataSiteResult } from './site-data'
import type { ReplaceRequest } from './find-replace'
import type { BookmarksExportOptions, BookmarksExportOutcome } from './bookmarks-html'
import type { BookmarksTransferReply, BookmarksTransferRequest } from './bookmarks'
import type { ImportReport, ImportRequest, ImportSourceInfo } from './import-sources'
import type { PromptAnswer } from './page-dialog'
import type { ProblemReportSave } from './problem-report'
import type { MediaRequest } from './media-player'
import type { FloatingVideoCommand, FloatingVideoState } from './floating-video'
import type { AboutEngine, AboutTarget } from './about'
import type { EngineHost } from './engine-status'
import type { ThemeReply, ThemeRequest } from './theme-code'
import type { BoostShareRequest, ShareReply } from './boost-share'
import type { ScriptPreviewReply } from './boost'
import type { WindowSidebarChange } from './window-sidebar'
import type { AppIconIssue } from './icons'
import type { DefaultBrowserOutcome } from './default-browser'
import type { OmniboxRequest } from './omnibox'
import type { BackupListing, BackupRestoreResult } from './session-backups'
import type { LockConfig, LockReply, UnlockRequest } from './lock'
import type { CookieName, CookieRemoval, CookieSite } from './cookies'
import type { ProxyTestResult } from './proxy'
import type { UserScriptReply, UserScriptRequest } from './userscript'
import type { HardwareReply, HardwareRequest } from './web-hardware'
import type { SpaceImageReply, SpaceImageRequest } from './space-image'
import type { SpaceBackgroundMediaReply, SpaceBackgroundMediaRequest } from './space-background-media'
import type { WebPanelRequest } from './web-panels'
import type { SplitDropZone } from './split-drop'
import type { ScreenView } from './panel-scale'
import type { ClipboardTextReply } from './clipboard-text'
import type { DropTarget } from './dnd'
import type { CycleKey } from './tab-cycle'
import type { AnnotateDoneRequest, AnnotateReply } from './annotate'
import type { PasswordReply, PasswordRequest } from './passwords'
import type { ExtensionsReply, ExtensionsRequest } from './extension-page'
import type { NotesReply, NotesRequest } from './notes'
import type { SyncReply, SyncRequest } from './sync-ipc'
import type { NoteFileReply, NoteFileRequest } from './note-files'
import type { ResourceAction, ResourceActionReply, ResourceReport } from './resources'
import type { UiSnapshot, NavCommand, OverlayRequest, CommandBarMode, FindOptions, MenuTarget, DownloadCommand, LittleCommand, LittleState, ProcessRow, ExportRequest, ExportReply, TabResources, TooltipRequest, PeekAction } from './ipc'

/** Surface exposed to the UI by the preload script as `window.lucium`. */
export interface LuciumApi {
  getSnapshot(): Promise<UiSnapshot>
  dispatch(action: Action): Promise<void>
  nav(command: NavCommand): void
  openOverlay(request: OverlayRequest): void
  closeOverlay(): void
  /** `instant` opens the first result of each comma-separated search instead of the results page (⇧↩). */
  submitUrl(url: string, mode: CommandBarMode, instant?: boolean): void
  loadExtension(): Promise<void>
  find(text: string, options?: FindOptions): void
  /** The history of the profile of the space on screen. `profileId` (the history panel): the profile the caller lists; no page when it is no longer the one on screen. */
  searchHistory(query: string, limit?: number, profileId?: string): Promise<HistoryEntry[]>
  /**
   * Removes one page from the history: of `profileId` when given (the profile the page was listed from), otherwise of the space on screen.
   * `undoable`: the page is kept aside for a few seconds, the time for `putBackHistory` to put it back.
   */
  forgetHistory(url: string, profileId?: string, undoable?: boolean): Promise<void>
  /**
   * Puts back in the history of `profileId` the page at `url` that `forgetHistory` just removed with `undoable`, as it was. The caller sends an address,
   * never a page: nothing but what was just forgotten there can come back. Answers whether the page is back.
   */
  putBackHistory(url: string, profileId: string): Promise<boolean>
  /** Removes from the history of `profileId` every page last visited from `from` (included) to `to` (excluded), the bounds of one day. Answers how many went. */
  forgetHistoryDay(from: number, to: number, profileId: string): Promise<number>
  /** « Effacer l'historique » over a span named by a word (the last hour, today, 7 days, 4 weeks, all): the main process works the bounds out. Answers how many pages went. */
  forgetHistoryRange(range: HistoryRange, profileId: string): Promise<number>
  /** The pages whose text holds the words (the full-text index of the profile on screen; nothing while the setting is off or in a private window). */
  searchPageContent(query: string, profileId?: string): Promise<PageMatch[]>
  /** Erases the full-text index of every profile; answers whether nothing is left. */
  clearPageIndex(): Promise<boolean>
  showMenu(target: MenuTarget): void
  /**
   * The button ☰ of the toolbar (Windows, where the window has no menu bar): opens the menu of the application, at `anchor` (the lower left corner of the button,
   * in CSS pixels of the window). The main process reads the point again and opens nothing for one outside the window.
   */
  showAppMenu(anchor: { x: number; y: number }): void
  /** A click on the toolbar's button « Contraste de la page »: the page of tab `id` goes dark or light, or back to Original (the main process looks at the page and decides). */
  toggleReadable(id: string): void
  downloadAction(id: string, command: DownloadCommand): void
  answerPermission(id: string, allow: boolean, remember: boolean): void
  /** The sign-in panel's answer: the credentials, or null to cancel. They go to the engine and nowhere else. */
  answerAuth(id: string, credentials: { username: string; password: string } | null): void
  /** The extension sheet's answer: install (or update), or refuse. The renderer is not trusted: only the pending request of that id is answered. */
  answerExtensionReview(id: string, allow: boolean): void
  /** Opens the Chrome Web Store in a tab of the main window (when installing from it is allowed). */
  openWebStore(): void
  /** The path on disk of a file dropped on the window: the page is no longer given it by Electron. An empty text when there is none. */
  pathOfDroppedFile(file: File): string
  /** Opens files of the disk (the paths of a drop) in tabs of the main window. The main process checks every path again, and tells what it left out. */
  openLocalFiles(paths: string[]): void
  /** The text of a link another application dropped on the window (`text/uri-list` or `text/plain`), sent as it came. The main process reads it again and opens the web addresses in it in new tabs, whatever the window sent. */
  openDroppedLinks(text: string): void
  /** Uninstalls an extension of the Web Store from one profile, after the main process has asked the user to confirm. */
  extensionUninstall(profileId: string, extensionId: string): void
  /**
   * Looks for newer versions of the Web Store extensions now (Settings › Extensions), or, with a profile and an extension id, opens the
   * sheet of the update that waits for the user's agreement. The notice at the foot of the sidebar tells how it went.
   */
  extensionUpdates(target?: { profileId: string; extensionId: string }): void
  /** The box of a page's `prompt()`: the value typed (null for Cancel) and the state of the box that stops the page. They go to the page and nowhere else. */
  answerDialog(id: string, answer: PromptAnswer): void
  /** The answer of "Quitter ce site ?": true leaves the page, false stays. Only the question of the window is answered, once. */
  answerLeave(id: string, leave: boolean): void
  /** The pointer entered (true) or left (false) the floating sidebar zone. */
  hotEdge(inside: boolean): void
  /** Mini window controls (the header is its own UI surface). */
  littleAction(id: string, command: LittleCommand): void
  onLittleState(listener: (state: LittleState) => void): () => void
  /** The colour the current page declares (its theme-color), as hex, or null when it has none. */
  siteColor(): Promise<string | null>
  /** Captures the part of the page under a rectangle drawn by the user (window coordinates). */
  captureRegion(rect: { x: number; y: number; width: number; height: number }): void
  /** The whole page from top to bottom (the button of the selection layer), as the menu's "Capturer la page entière" does. */
  captureFullPage(): void
  /** The toolbar's « Annoter » button: starts or ends the annotation of the page, in this window (on by default; LUCIUM_ANNOTATE=0 turns it off). */
  annotatePage(): void
  /** The part of the page that is on screen now (the picture of the capture bar's « Fenêtre visible »). */
  captureVisible(): void
  /** The picture the annotation sheet is for (a `data:` URL of the capture), or null when that sheet is not the one open or the id is not its. */
  annotateImage(id: string): Promise<string | null>
  /** The sheet's choice: copy, save or share the picture drawn on. The reply says how it went; the sheet closes itself on success. */
  annotateDone(request: AnnotateDoneRequest): Promise<AnnotateReply>
  /** Closes the extension side panel. */
  closeSidePanel(): void
  /** An extension icon of the toolbar was clicked: open its side panel when it asked for that (`openPanelOnActionClick`). */
  openSidePanel(extensionId: string): void
  /** Clicks the toolbar icon of a loaded extension for the user (command bar: "use an extension's action"); closes the overlay first. */
  activateExtension(extensionId: string): void
  /** Lets the user click an element of the current page to hide it for the host's Tweak. */
  zapStart(host: string, id: string): void
  /** Removes the cookies and storage of the current site, then reloads it. */
  clearSiteData(): void
  /** How many cookies a site has in the profile of the window (the panel "Effacer les données du site" shows it). */
  siteCookieCount(host: string, subdomains: boolean): Promise<number>
  /**
   * The same for several sites at once (the panel's tags); one entry per site, one result per type. Rejects when a site or the types
   * are not valid (nothing is erased then). With `detached` the answer is empty at once: the run ends in the background.
   */
  clearSites(request: SiteDataBatchRequest): Promise<SiteDataSiteResult[]>
  /** Clears the site of the current page with the choices the panel remembers, and tells how it went (the shortcut without the panel). */
  clearSiteNow(): void
  /** « Tout effacer » (`everything`) or « Nouvelle identité » (`identity`) from the command bar: the main process asks for confirmation, then erases. */
  clearEverything(kind: 'everything' | 'identity'): void
  /**
   * Reloads the tabs of every space ("Actualiser tous les onglets"); the toast tells how many. `everything`: the button of the sidebar, which wakes
   * the sleeping tabs too whatever the setting `reloadAllWakes` says; without it (the command bar), the setting decides.
   */
  reloadAllTabs(everything?: boolean): void
  /** Reloads the tabs of the space on screen only (the button next to the one that reloads the tabs of every space). */
  reloadSpaceTabs(): void
  /** Whether Lucium is the system's default web browser. */
  defaultBrowser(): Promise<boolean>
  /** Asks the system to make Lucium the default web browser: `done`, `system-settings` (Windows: Settings was opened, the choice is the user's) or `failed`. */
  setDefaultBrowser(): Promise<DefaultBrowserOutcome>
  /** Why the Dock does not show the icon chosen in Settings › Icône (its picture is missing from the application); null when it does. */
  appIconIssue(): Promise<AppIconIssue | null>
  /** Erases cookies, storage and cache of a profile and reloads its open tabs. */
  clearProfile(profileId: string): Promise<void>
  /** Deletes a profile no space uses: erases all it holds (its Chrome Web Store extensions included), then forgets its name and retires its id. */
  deleteProfile(profileId: string): Promise<void>
  /** The profiles that still hold data and that no space uses: what "Nettoyer" would erase. Erases nothing. */
  unusedProfiles(): Promise<string[]>
  /** Erases the data of these profiles, those of the list `unusedProfiles` gave that no space uses still; resolves to how many were cleaned. */
  purgeProfiles(profileIds: string[]): Promise<number>
  /** Runs the action of the toast that is showing (the id guards against a toast that has just been replaced). */
  toastAction(id: number, second?: boolean): void
  /** Closes the notice that is showing (its ✕, Escape); a stale id does nothing. */
  toastDismiss(id: number): void
  /** The pointer or the focus entered (true) or left (false) the notice: its time stops and goes on. */
  toastHold(id: number, held: boolean): void
  /** "Ne plus montrer" of the sheet of the news: the setting `whatsNewSheet` goes off, and a notice offers to undo it. */
  whatsNewDismiss(): void
  /** The processes of the application, for the task manager. */
  listProcesses(): Promise<ProcessRow[]>
  /** Ends the process of a tab (it reloads when selected again). */
  killProcess(pid: number): Promise<void>
  /** Opens the system share menu for the current page. */
  shareSite(): void
  /** Opens the developer tools of the current page. */
  openDevTools(): void
  /** Asks the user for a folder; resolves to its path, or null when they cancel. */
  chooseFolder(): Promise<string | null>
  /** Settings › Téléchargements et fichiers › Plus de réglages › Changer… : opens the box that chooses the application remembered for a type of file (an extension without its dot). */
  chooseOpenWith(type: string): void
  /**
   * Saves a copy of the sidebar data (spaces, tabs, folders, favourites, archive, settings) as a file the user names: plain JSON, or sealed
   * with the passphrase of the request (AES-256-GCM, see main/export-crypto.ts). The passphrase goes to the file's encryption and nowhere else.
   */
  exportData(request?: ExportRequest): Promise<ExportReply>
  /**
   * Writes the favourites, pinned tabs and folders of every space as a bookmarks file (HTML, the format every browser imports) at the path the user
   * picks in a save dialog; the Today tabs only when asked. Refused in a private window. Resolves to the path (null when nothing was written) and a sentence.
   */
  exportBookmarks(options: BookmarksExportOptions): Promise<BookmarksExportOutcome>
  /** The passphrase panel's answer (the encrypted export being restored): the passphrase, or null to give up. It is not kept or logged. */
  answerPassphrase(id: string, passphrase: string | null): void
  /** Unlocks the application or a space, with the phrase or (without one) Touch ID. */
  lockUnlock(request: UnlockRequest): Promise<LockReply>
  /** Changes the lock: its phrase, switching it off, the application lock, Touch ID, the locked spaces, locking now. */
  lockConfigure(request: LockConfig): Promise<LockReply>
  /** The page « Synchronisation » of the Settings: the switch, the window, the pairing sheet, the devices (see sync-ipc.ts). The reply is the state to draw; it holds no key. */
  sync(request: SyncRequest): Promise<SyncReply>
  /** The password manager: every request of its panel and of the command bar (see passwords.ts). The reply holds rows and counts, never a password (the generator's text aside). */
  passwords(request: PasswordRequest): Promise<PasswordReply>
  /** Moves tabs to another space (a tab dropped on a space of the footer). Crossing profiles asks the user first. */
  moveTabsToSpace(ids: string[], spaceId: string): void
  /** Tab rows of this sidebar start (`start`, with the dragged tabs) or end (`end`) a drag: the other windows are told, to take a drop of them. */
  tabDrag(phase: 'start' | 'end', ids?: string[]): void
  /** Tabs another window is dragging were dropped here, at this place of the list: the main process moves them (and their pages) to the space this window shows. */
  dropWindowTabs(target: DropTarget): void
  /** A small picture (a `data:` URL) of the last time a tab was on screen, for its hover card; null when there is none. */
  tabThumbnail(tabId: string): Promise<string | null>
  /** The memory and processor the page of a tab uses now; null for a tab with no process (asleep, frozen) or that is not one of the window's. */
  tabResources(tabId: string): Promise<TabResources | null>
  /** The resource panel of the sidebar opens (true) or closes (false): while one is open in any window, its figures come every 2 s (`onResources`). Opening is refused while the function is off. */
  resourcePanel(open: boolean): void
  /** The figures of the resource panel, while it is open. */
  onResources(listener: (report: ResourceReport) => void): () => void
  /** A button of the resource panel: put a tab to sleep, close it, show it (its window and its space), put every hidden tab to sleep, or open the task manager. */
  resourceAction(action: ResourceAction): Promise<ResourceActionReply>
  /** Completions from the search engine for what is typed in the command bar. */
  suggest(query: string): Promise<string[]>
  /** A button of a media player: play or pause, previous or next track, picture in picture, close, back to the tab, or the volume. */
  media(request: MediaRequest): void
  /** Mutes a tab, or gives its sound back (the speaker on its row). */
  toggleMute(tabId: string): void
  /** The bar of the floating video window: a button or a key (shared/floating-video.ts). Only that window's own surface is listened to. */
  floatingVideoAction(command: FloatingVideoCommand): void
  /** What the bar of the floating video window shows, as the main process sends it. */
  onFloatingVideoState(listener: (state: FloatingVideoState) => void): () => void
  /** The mark of a floating tab in the sidebar (`show`: its window comes to the front) or the place of its page (`back`: the video comes back to the tab). */
  floatingVideoTab(tabId: string, command: 'show' | 'back'): void
  /** The mark of a tab an extension captures the sound of (the row, the bar): stops the capture. The main process checks the tab and what runs. */
  stopTabCapture(tabId: string): void
  /** Puts a tab to sleep now (the hover card's « Mettre en veille »): its page is dropped, as the delay of the settings would do. */
  sleepTab(tabId: string): void
  /** « Dégeler l'onglet » (the button on the row of a frozen tab): its page runs again where it was, without being shown or reloaded. */
  thawTab(tabId: string): void
  /** The tab editor's « Adresse »: what is typed (an address or a search) loads in the tab's page; anything else is refused (the main process checks it again). */
  setTabAddress(tabId: string, input: string): void
  /** How many requests the blocker cancelled on a tab since it last navigated. */
  blockedCount(tabId: string): Promise<number>
  /** How many requests the blocker cancelled on every page since the application started (or since the last reset). */
  sessionBlockedCount(): Promise<number>
  /** Tests the connection to Ollama at `url`, an address of this Mac (any other is refused); the request is made by the main process. */
  ollamaTest(url: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }>
  /** The models installed on the Ollama server at `url`, full names (tag included); the request is made by the main process. */
  ollamaModels(url: string): Promise<OllamaModelList>
  /** The session's blocks split by what stopped them: ad lists, cookie-banner lists. */
  sessionBlockedByKind(): Promise<{ ads: number; banners: number }>
  /** Puts the session total of the privacy dashboard back to zero. */
  resetSessionBlockedCount(): Promise<void>
  /** Fetches the active filter lists again now; resolves when done (the outcome of each list is in the snapshot). */
  updateFilterLists(): Promise<void>
  /** Settings › Listes de filtres › "Ajouter un fichier…": the main process shows the file dialog, reads the file and keeps its safe rules. Nothing is downloaded. */
  addFilterListFile(): Promise<AddFilterListResult>
  /** Adds rules pasted into the settings (at most 1,000,000 characters); `title` may be empty. */
  addFilterListText(title: string, text: string): Promise<AddFilterListResult>
  /** Takes a custom list out and deletes its rules. */
  removeFilterList(id: string): Promise<void>
  /** The browsers whose data can be imported, with the profiles found on this Mac. */
  importSources(): Promise<ImportSourceInfo[]>
  /** Imports what the user ticked from one browser at once; the report says what came in, or why nothing did. */
  importRun(request: ImportRequest): Promise<ImportReport>
  /** Reads what the import would bring and writes nothing: the report is the preview, with a `token` when there is something to confirm. */
  importPreview(request: ImportRequest): Promise<ImportReport>
  /** Carries out the preview that has this token; the report says what came in, and gives an `undoToken`. */
  importCommit(token: string): Promise<ImportReport>
  /** Takes back the latest import, the one that has this token. */
  importUndo(token: string): Promise<ImportReport>
  /** Opens the "Full Disk Access" pane of System Settings (Safari's data is protected by macOS). */
  openDiskAccessSettings(): void
  /** First-launch guide: preview what would be imported from selected browser and profile. */
  firstLaunchPreview(request: ImportRequest): Promise<ImportReport>
  /** First-launch guide: confirm and complete the import from the preview token. */
  firstLaunchConfirm(token: string): Promise<ImportReport>
  /** Replaces text in the editable parts of the current page; resolves to the sentence that says how many were replaced. */
  findReplace(request: ReplaceRequest): Promise<string>
  /** The panel "Traduire cette page": asks the main process for a view of it, or to do one thing (translate, restore, look up or download a model). Null when refused. */
  translate(request: TranslateRequest): Promise<TranslateView | null>
  /** The application's version for Settings › À propos et mises à jour › À propos, read by the main process; '' when it is not one. */
  aboutVersion(): Promise<string>
  /** A link of the About group: one of four words, resolved by the main process into a tab of the browser (or the folder of the licences). */
  openAbout(target: AboutTarget): void
  /** The engine under the browser for the About window (major versions of Chromium and Electron, the system), read by the main process. */
  aboutEngine(): Promise<AboutEngine>
  /** "Rechercher les mises à jour" of the About window: the same look as the menu's, its answer a box of the system on that window; resolves when the box is closed. */
  aboutCheckUpdates(): Promise<void>
  /**
   * The screens that are connected, for the size of the windows and panels (Settings › Apparence): each with its size, its density and its name, whether it is the
   * one the asking window is on, and where the main window of the application stands on it. Read-only; an empty list when refused.
   */
  panelScreens(): Promise<ScreenView[]>
  /** What only the main process knows of the engine, for Settings › Général › État de Lucium (versions, platform, memory, the error log); null when refused. Read-only. */
  engineStatus(): Promise<EngineHost | null>
  /** Empties the error log of the main process (the pane shows it again after). */
  clearErrorLog(): Promise<void>
  /** Aide › Signaler un problème…: the report the main process builds (shell/problem-report.ts), kept for `saveProblemReport`; null when refused. Nothing is sent. */
  problemReport(): Promise<string | null>
  /** « Enregistrer… » of that sheet: the save dialog of the main process, then the report last given by `problemReport` written where the user chose. */
  saveProblemReport(): Promise<ProblemReportSave>
  /** The link of that sheet: the community page of the site in a tab of the window. The interface never sends an address. */
  openProblemSite(): void
  /** Shows (or, with null, hides) the tooltip capsule at the pointer. */
  tooltip(request: TooltipRequest | null): void
  /** Puts the address of the selected tab on the clipboard (toolbar's link glyph; ⇧⌘C) and says so in a toast. */
  copyUrl(): void
  /** The command bar's calculator: puts the answer (a number as shared/calc.ts writes it) on the clipboard and says so in a toast. */
  copyCalcResult(text: string): void
  /** The command bar's "Coller": the text on the clipboard, read by the main process (plain text only, never HTML). The reply says when it could not be given (`unreadable`, `too-long`). */
  readClipboardText(): Promise<ClipboardTextReply>
  /** The command bar's "Copier": puts a text of 1 to 65,536 characters on the clipboard, without a notice (the button says it). False when the text was refused or could not be written. */
  writeClipboardText(text: string): Promise<boolean>
  /** The command bar's "Exporter la page en Markdown" (`'pick'`: the picker) or "Enregistrer la page en Markdown" (`'save'`: the whole page, saved): the bar closes first (see shell/markdown-export.ts). */
  markdownExport(mode: 'pick' | 'save'): void
  /** The theme editor's code fields and the theme files: copy a code or a colour, paste one into the space, apply a theme to every space, save the theme as a file or take one from a file. */
  themeCode(request: ThemeRequest): Promise<ThemeReply>
  /** Sharing a Tweak: bring one in from a file or the clipboard, send one out as a file or a link. The shell shows the dialogs and says how it went. */
  boostShare(request: BoostShareRequest): Promise<ShareReply>
  /** The preview of the Tweak editor: runs once, in the page shown, the script as the editor stored it (typed or saved). The answer is the sentence to show. */
  boostPreview(boostId: string): Promise<ScriptPreviewReply>
  /** The automatic copies of the session, newest first. Empty in a private window, which keeps none. */
  sessionBackups(): Promise<BackupListing>
  /** Puts a copy back (after a copy of the session it replaces); the answer says what came of it. */
  restoreBackup(id: string): Promise<BackupRestoreResult>
  /** Makes a copy of the session now; resolves to the sentence that says how it went. */
  backUpNow(): Promise<{ ok: boolean; message: string }>
  /** Espaces › Mettre l’espace de côté… for the space on screen (the command bar's route): the shell asks before it closes the pages. */
  asideSpace(): void
  /** The cookies of the profile of the space on screen grouped by site (no value). Rejects in a private window, and while the view is off. */
  cookieSites(): Promise<CookieSite[]>
  /** The cookies one site set, by name, with their sizes. */
  cookieNames(host: string): Promise<CookieName[]>
  /** Removes the cookies of one site (the exact domain of the list). */
  removeCookieSite(host: string): Promise<CookieRemoval>
  /** Removes every cookie but those of the sites the list keeps (read from the settings by the main process). */
  cleanCookies(): Promise<CookieRemoval>
  /** The facultative test of a proxy: does its server accept a connection? Reaches the proxy only. */
  testProxy(address: string): Promise<ProxyTestResult>
  /** The devices pages were let use (WebHID, WebUSB, Web Serial), and taking one or all back. Empty and refused in a private window. */
  webHardware(request: HardwareRequest): Promise<HardwareReply>
  /** File › Nouvel onglet privé: a blank private tab with the command bar over it. */
  newPrivateTab(): void
  /** The user-script manager of Settings › Fonctions en option: the list, a script's code, a file to pick, adding, switching on, removing. The answer carries the list as it is now. */
  userScripts(request: UserScriptRequest): Promise<UserScriptReply>
  /** The Extensions page's one request (extension-page.ts); the answer says what was done, or why not. */
  extensionsPage(request: ExtensionsRequest): Promise<ExtensionsReply>
  /**
   * The picture of a space: the user picks a file in a dialog of the main process (`pick`), takes the picture away (`clear`) or the interface
   * asks for a stored one by its name (`read`, the answer is a `data:` URL). No request carries a path.
   */
  spaceImage(request: SpaceImageRequest): Promise<SpaceImageReply>
  /** Background media for spaces: upload, delete, or read image/GIF/video backgrounds for space sidebar pill backgrounds. */
  spaceBackgroundMedia(request: SpaceBackgroundMediaRequest): Promise<SpaceBackgroundMediaReply>
  /** Web panels: opens (or closes, if it is the open one) a site of the space on screen beside the page, or adds the page on screen to the list. */
  webPanel(request: WebPanelRequest): void
  /** A tab row of the sidebar starts (`start`, with the tab) or ends (`end`) a drag: the page shows where a split view would put it. */
  splitDrag(phase: 'start' | 'end', tabId?: string): void
  /** The tab being dragged was dropped on this zone of the page (the veil's answer); the browser makes the split view. */
  splitDrop(zone: SplitDropZone): void
  /** A key press seen by the ⌃Tab panel, which has the keyboard while it is up (the page would not be told when ⌃ goes up). */
  cycleKey(key: CycleKey): void
  /** The keyboard layout the window has read (the character of each key by its `code`): the shell needs it to recognise a shortcut held with Option. */
  keyboardLayout(characters: Record<string, string>): void
  /** The selection of the ⌃Tab panel moved to another entry. */
  onCycleIndex(listener: (index: number) => void): () => void
  /** Whether the window has the focus (another window or application in front, or not): told at once with the last word of the main process, then at each change.
   *  The focus of the interface's own document says less: a page of the window takes it while the window keeps the focus. */
  onWindowFocus(listener: (focused: boolean) => void): () => void
  /** Gives the window the interface is in a name (empty: takes it away). Refused as a whole when windows cannot be named. */
  setWindowName(name: string): void
  /** The sidebar of the window the interface is in (« Barre de cette fenêtre »): dock it to a column of icons or give the full one back, or choose its side (window-sidebar.ts). */
  windowSidebar(change: WindowSidebarChange): void
  /** Brings a named window to the front (the command bar's "Aller à la fenêtre…"). */
  goToWindow(id: string): void
  /** The command bar hands the text typed after an extension's keyword to that extension (see omnibox.ts). Refused as a whole when the function is off. */
  omniboxEnter(request: OmniboxRequest): void
  /** Puts the page on screen back to 100 % (the mark in the toolbar while it is zoomed): the same as ⌘0. */
  resetZoom(): void
  /**
   * The bookmark library's file of bookmarks: `import` shows a file dialog of the main process and adds what the file holds, `export` asks where to
   * save the library. The interface names no path. Refused with the setting off and in a private window; the reply says how it went.
   */
  bookmarksTransfer(request: BookmarksTransferRequest): Promise<BookmarksTransferReply>
  /** "Ouvrir comme application" for the tab on screen (the command bar's route): the site opens in a window of its own. */
  openAsApp(): void
  /** The quick notes (setting `notes`): the list, a new note, a change, a deletion, or opening the panel. Refused as a whole in a private window and while the function is off. */
  notes(request: NotesRequest): Promise<NotesReply>
  /** A note out of the panel and in (setting `notes`, never in a private window): saved as a .md file, copied, shared, a .md file imported as a note, a mail link opened. */
  noteFiles(request: NoteFileRequest): Promise<NoteFileReply>
  /** Glance header actions. `back`, `forward`, `reload` and `stop` drive the previewed page. */
  peekAction(action: PeekAction): void
  /** "Défilement synchronisé" of the bar of a split view: its panes scroll together, or stop doing so (refused while the setting that offers it is off). */
  setScrollSynced(splitId: string, on: boolean): void
  onSnapshot(listener: (snapshot: UiSnapshot) => void): () => void
  /** The panel the layer must draw; `null` when the panel was closed: the layer then draws nothing and lets go of what the panel held. */
  onShowOverlay(listener: (request: OverlayRequest | null) => void): () => void
}

/** The answer to a request for the summary of the page: the text, or why there is none. */
export type PageSummaryReply = { ok: true; summary: string; model: string; duration: number } | { ok: false; error: string }

/**
 * What the Extensions page is given as `window.lucium` when it is a tab (preload/internal-extensions.ts): eight of the calls above and nothing else, so that the
 * page is the same component as before. `openOverlay` opens Settings only, and every call goes over a channel of its own (`InternalChannel`).
 */
export type InternalPageApi = Pick<LuciumApi, 'getSnapshot' | 'onSnapshot' | 'extensionsPage' | 'extensionUpdates' | 'openWebStore' | 'openOverlay' | 'pathOfDroppedFile' | 'openLocalFiles'>
