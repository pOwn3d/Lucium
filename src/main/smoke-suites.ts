// The table of the engine suites: every suite `--smoke` can run is declared here once, with its place in the chain of `pnpm test:engine`. The run
// (smoke-run.ts) reads nothing else: a suite that is not in this table cannot be started, and a suite file that this table does not load is refused
// by smoke-suites.test.ts (a suite of 34 checks stayed out of every command for weeks because two lists had to be kept in step by hand).
// Each suite is loaded by import() when it runs, so this file imports no Electron and the unit tests can read it.

import type { SmokeContext } from './smoke'

export interface SuiteEntry {
  /** The name LUCIUM_SMOKE_ONLY takes, and the one the log and the summary of a run give. */
  name: string
  /** Whether `pnpm test:engine` runs it. The suites of the chain run in the order of this table. */
  chain: boolean
  /** What the suite checks. */
  what?: string
  /** Why it has this place in the chain, or why it is not part of it. */
  order?: string
  /** The longest it may take before the run counts it as failed and goes on (smoke-kit.ts gives the default). */
  timeoutMs?: number
  /** A driver that waits to be stopped or only measures: no time limit, and no check is expected of it. */
  driver?: true
  /** `fromEnv` is the list of the extensions loaded from LUCIUM_EXTENSIONS (main/index.ts). */
  run: (context: SmokeContext, fromEnv: string[]) => Promise<number>
}

export const SUITES: readonly SuiteEntry[] = [
  {
    name: 'main',
    chain: true,
    timeoutMs: 25 * 60_000,
    what: 'The principal suite (it ends with the sidebar, settings and toolbar checks): the loop for what depends on its state.',
    run: async (context, fromEnv) => (await import('./smoke')).runEngineSmoke(context, fromEnv)
  },
  {
    name: 'windows',
    chain: true,
    what: 'The checks of the several windows (the second window, the private window, the ephemeral sessions).',
    run: async (context) => (await import('./smoke-windows')).runWindowsSmoke(context)
  },
  {
    name: 'blocker',
    chain: true,
    what: 'The blocker checks (lists, modes, settings, site control center, private window), in a fresh application.',
    order: 'After the window checks: the blocker smoke opens a private window of its own, which the windows checks must not see.',
    run: async (context) => (await import('./smoke-blocker')).runBlockerSmoke(context)
  },
  {
    name: 'sitedata',
    chain: true,
    what: 'The checks of « Effacer les données du site » (the data of one site, by type, with its panel).',
    order: 'Last: it opens a private window too, and smoke-windows expects to find the first ephemeral session.',
    run: async (context) => (await import('./smoke-sitedata')).runSiteDataSmoke(context)
  },
  {
    name: 'cleardata2',
    chain: true,
    what: 'The checks of clearing several sites at once (recent sites, confirmation, notices).',
    order: 'Right after: same server pages, and a private window of its own.',
    run: async (context) => (await import('./smoke-cleardata2')).runClearData2Smoke(context)
  },
  {
    name: 'market',
    chain: true,
    what: 'The checks of the features borrowed from other browsers (error pages, privacy, PDF, zoom, reader).',
    order: 'It opens a private window too, and a tab killed on purpose: after the checks that count windows and processes.',
    run: async (context) => (await import('./smoke-market')).runMarketSmoke(context)
  },
  {
    name: 'surface',
    chain: true,
    what: 'The checks of the agent-style extension probe (compat/surface-probe in LUCIUM_EXTENSIONS).',
    order: 'After the others: the probe opens tabs, a panel and a window of its own.',
    run: async (context) => (await import('./smoke-extensions')).runSurfaceSmoke(context)
  },
  {
    name: 'iso-panels',
    chain: true,
    timeoutMs: 20 * 60_000,
    what: 'The overlay panel checks (command bar, site control center, sign-in, mailto links...).',
    order: 'Last: it takes minutes (the extension suite must not wait for it: a worker left idle that long starts again empty), and its checks open private windows, which smoke-windows would miscount (it expects to find the first ephemeral session).',
    run: async (context) => (await import('./smoke-iso-panels')).runIsoPanelsSmoke(context)
  },
  {
    name: 'sessions',
    chain: true,
    what: 'The checks of the sessions of tabs (save, restore, rename, delete, limits, private window).',
    order: 'The Toolkit modules built in, each with a private window or a space of its own to remove afterwards: after the panels suite (which is sensitive to what an earlier suite leaves open) and the suites that count windows.',
    run: async (context) => (await import('./smoke-sessions')).runSessionsSmoke(context)
  },
  {
    name: 'readlater',
    chain: true,
    what: 'The checks of "Lire plus tard" (the read-later list: save, list, open, delete, limit, private window).',
    run: async (context) => (await import('./smoke-readlater')).runReadLaterSmoke(context)
  },
  {
    name: 'autoreload',
    chain: true,
    what: 'The checks of the tabs that reload themselves (timer, typing, sleep, restart, menus, panel, private window).',
    run: async (context) => (await import('./smoke-autoreload')).runAutoReloadSmoke(context)
  },
  {
    name: 'reloadall',
    chain: true,
    what: 'The checks of "Actualiser tous les onglets" (every space, sleeping/frozen/typed-in pages, menu, interface route).',
    run: async (context) => (await import('./smoke-reloadall')).runReloadAllSmoke(context)
  },
  {
    name: 'boostfonts',
    chain: true,
    what: 'The checks of the bundled fonts of the Tweaks (strict-policy page, live change, reload, system font, disabled Tweak).',
    run: async (context) => (await import('./smoke-boostfonts')).runBoostFontsSmoke(context)
  },
  {
    name: 'markdown',
    chain: true,
    what: 'The checks of the Markdown export (selection, blocks picker, copy, files, archive with images, hostile page).',
    run: async (context) => (await import('./smoke-markdown')).runMarkdownSmoke(context)
  },
  {
    name: 'annotate',
    chain: true,
    what: 'The checks of the layer of the page annotation in its own world: a page that watches itself reads neither the strokes nor the text; pen, eraser, text and capture.',
    run: async (context) => (await import('./smoke-annotate')).runAnnotateSmoke(context)
  },
  {
    name: 'themes',
    chain: true,
    what: 'The checks of theme codes, ready themes and "apply to every space" (space menu and theme editor).',
    run: async (context) => (await import('./smoke-themes')).runThemesSmoke(context)
  },
  {
    name: 'favicons',
    chain: true,
    what: 'The checks of the site icons of favourites and pinned tabs (lookup, rules, setting, private window).',
    order: 'The site icons of favourites and pinned tabs: its own space and private window, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-favicons')).runFaviconsSmoke(context)
  },
  {
    name: 'popups',
    chain: true,
    what: 'The checks of the popup windows of pages (window.open with a feature list) and the user agent. LUCIUM_POPUPS_REAL=1 adds the end-to-end measurement on the real sign-in pages (Internet needed, never part of the full chain).',
    order: 'The popup windows of pages and the user agent: real windows and clicks on a server of its own (the real sign-in pages are never part of the chain).',
    run: async (context) => (await import('./smoke-popups')).runPopupsSmoke(context)
  },
  {
    name: 'docpip',
    chain: true,
    what: 'The checks of the floating window of a call (document Picture-in-Picture, feature document-pip: off, without a click, the window, its button, what ends it) and the probe of what Electron hands over for it: run it again at each upgrade of Electron.',
    order: 'Right after the popups: the other kind of window a page opens, on a server of its own; it switches its feature on and puts it back, and closes the tabs and windows it opened.',
    run: async (context) => (await import('./smoke-docpip')).runDocPipSmoke(context)
  },
  {
    name: 'sessionsplus',
    chain: true,
    what: 'The checks of the spaces put aside and of the automatic copies of the session (copy, rotation, restore, undo, damaged copy, restart, private window).',
    order: 'The spaces put aside and the automatic copies: they restore spaces and tabs as a whole, so they come after the suites that leave theirs behind.',
    run: async (context) => (await import('./smoke-sessionsplus')).runSessionsPlusSmoke(context)
  },
  {
    name: 'history',
    chain: true,
    what: 'The checks of the history of each profile (recording, panel, command bar, erasing a profile, private window).',
    order: 'The history of each profile: two profiles, three spaces and a private window of its own, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-history')).runHistorySmoke(context)
  },
  {
    name: 'dialogs',
    chain: true,
    what: "The checks of the box of a page's prompt(), alert() and confirm() (default value, answers, tabs, spaces, private window, abuse, forged messages, frames and windows left to Electron's sheet).",
    order: "The box of a page's prompt(), alert() and confirm(): real clicks and keys on a server of its own, a space and a private window removed afterwards; before the About group.",
    run: async (context) => (await import('./smoke-dialogs')).runDialogsSmoke(context)
  },
  {
    name: 'import',
    chain: true,
    what: 'The checks of the import from Arc (sidebar, split views, history, Tweaks, a second run) and of the export of the bookmarks (HTML).',
    order: 'The import from Arc and the export of the bookmarks: a made-up home folder, spaces and Tweaks of its own, removed afterwards; just before the About group.',
    run: async (context) => (await import('./smoke-import')).runImportSmoke(context)
  },
  {
    name: 'share',
    chain: true,
    what: 'The checks of sharing Tweaks and themes (file, link, hostile files, scripts that wait, private window, entry points).',
    order: 'Sharing Tweaks and themes: its own Tweaks, a local server and the Settings window, closed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-share')).runShareSmoke(context)
  },
  {
    name: 'runtime',
    chain: true,
    what: 'The checks of sharing the screen in a call and of the memory and processor on the card of a tab (nothing is captured).',
    order: 'Sharing the screen and the figures of a tab on its card: a space, a private window and a throw-away session of their own, removed afterwards.',
    run: async (context) => (await import('./smoke-runtime')).runRuntimeSmoke(context)
  },
  {
    name: 'privacy2',
    chain: true,
    what: 'The checks of autoplay, the user\'s own filter lists and "Effacer à la fermeture" (pages, cookies, private window, quit).',
    order: "Autoplay, the user's own filter lists and the erasure of a site's data when its last tab closes: tabs on a server of its own, private windows that it closes again, and the settings it changes put back. Before the About group.",
    run: async (context) => (await import('./smoke-privacy2')).runPrivacy2Smoke(context)
  },
  {
    name: 'webstore',
    chain: true,
    what: 'The checks of the Chrome Web Store (a local fake store: sheet, gate, guard, profiles, updates, uninstall).',
    order: 'The Chrome Web Store against a local fake store: two spaces of its own, a tab per page, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-webstore')).runWebStoreSmoke(context)
  },
  {
    name: 'security2',
    chain: true,
    what: 'The checks of the encrypted export, the lock (application and spaces) and the pages of a reopened tab.',
    order: 'The encrypted export, the lock and the pages of a reopened tab: their own space and tabs, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-security2')).runSecurity2Smoke(context)
  },
  {
    name: 'privacy3',
    chain: true,
    what: 'The privacy checks of smoke-privacy3.ts (copied links, history off, encrypted DNS, proxy, cookies by site, private tabs).',
    order: 'The copied links, the history that is not recorded, encrypted DNS, the proxy, the cookies by site and the private tabs: a space and a profile of their own, a private window opened and closed; before the About group is checked.',
    run: async (context) => (await import('./smoke-privacy3')).runPrivacy3Smoke(context)
  },
  {
    name: 'extensions2',
    chain: true,
    what: 'The checks of the data APIs, the « menu of the toolbar and the user scripts (LUCIUM_EXTENSIONS=$PWD/compat/data-api-probe:$PWD/compat/data-api-denied-probe).',
    order: 'The data APIs for extensions, the « menu of the toolbar and the user scripts (probes of compat/ in LUCIUM_EXTENSIONS): it adds a group to Settings, so before About.',
    run: async (context) => (await import('./smoke-extensions2')).runExtensions2Smoke(context)
  },
  {
    name: 'spaces2',
    chain: true,
    what: 'The checks of the picture of a space, the sidebar at the right and the web panels (all off by default).',
    order: 'The picture of a space, the sidebar at the right and the web panels: a space and settings of their own, put back afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-spaces2')).runSpaces2Smoke(context)
  },
  {
    name: 'auto-veil',
    chain: true,
    what: 'The checks of the veil measured from a file of the user\'s (a bright and a dark picture, a real video, one that cannot decode; the slider that sets it by hand, « Revenir au réglage automatique » from the keyboard and with a click).',
    order: 'Personnaliser l\'espace on a space of its own, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-auto-veil')).runAutoVeilSmoke(context)
  },
  {
    name: 'webtools',
    chain: true,
    what: 'The checks of the extra web tools (QR code, autoscroll, synchronized scrolling, mouse gestures, page watching, reading aloud, battery saver).',
    order: 'The extra web tools: real clicks and strokes in pages of a server of its own, a split view and tabs it closes afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-webtools')).runWebToolsSmoke(context)
  },
  {
    name: 'downloads2',
    chain: true,
    what: 'The checks of pause and resume, asking where to save, "Ouvrir avec…" by type, opening without keeping, PDF with the address.',
    order: "The downloads' own folder and the downloads settings of Téléchargements et fichiers: a server of its own and a space of its own, removed afterwards; before the About group is checked.",
    run: async (context) => (await import('./smoke-downloads2')).runDownloads2Smoke(context)
  },
  {
    name: 'download-mark',
    chain: true,
    what: 'The check of the quarantine mark of macOS on a download that is still being written (a server that announces more than it sends and holds the connection).',
    order: 'Right after the other download checks: a server and a downloads folder of its own, given back afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-download-mark')).runDownloadMarkSmoke(context)
  },
  {
    name: 'a11y',
    chain: true,
    what: 'The accessibility checks (tree of every surface, Tab order, contrast), the forced dark mode and the look of the window.',
    order: 'The accessibility audit, the forced dark mode and the look of the window: they open every panel and the Settings window, then put the settings back.',
    run: async (context) => (await import('./smoke-a11y')).runA11ySmoke(context)
  },
  {
    name: 'navigation',
    chain: true,
    what: "The checks of Back that closes a tab opened from a link, ⌃Tab in the order of use, the tab dragged onto the page and the private window's bar.",
    order: 'Real windows, keys and drags on a server of its own, in a space of its own: before the About group is checked.',
    run: async (context) => (await import('./smoke-navigation')).runNavigationSmoke(context)
  },
  {
    name: 'extensions-page',
    chain: false,
    what: 'The Extensions page in a tab: it opens by a panel request at lucium-ui://extensions/, shown as chrome://extensions, with the eight calls of its preload and the reduced snapshot, and no window; a page of the web cannot open it (link, script, frame, window, redirect) nor read it (fetch), and has no window.lucium.',
    order: 'Not in the chain: written for the change that made the page a tab, and not run yet. LUCIUM_SMOKE_ONLY=extensions-page electron . --smoke --user-data-dir="$(mktemp -d)", after pnpm build; it opens windows, so the maintainer starts it.',
    run: async (context) => (await import('./smoke-extensions-page')).runExtensionsPageSmoke(context)
  },
  {
    name: 'long-address',
    chain: true,
    what: 'The check of a tab that a redirect sends to another site at an address longer than the state keeps: the tab names the new site, its address cut.',
    order: 'A server of its own and one tab, closed afterwards: before the About group is checked.',
    run: async (context) => (await import('./smoke-long-address')).runLongAddressSmoke(context)
  },
  {
    name: 'usage',
    chain: true,
    what: 'The checks of the small usage features (missing shortcuts, link tabs, zoom mark, window names, close question, interface size).',
    order: 'The small usage features: windows opened and closed, menus rebuilt, the interface zoomed and put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-usage')).runUsageSmoke(context)
  },
  {
    name: 'search2',
    chain: true,
    what: 'The checks of the search features (calculator, "!" keywords, the search a site declares, sources of the proposals, find by regular expression).',
    order: 'The search features: real keys in the command bar and the find bar, a page of its own that declares a search, a private window; before the About group is checked.',
    run: async (context) => (await import('./smoke-search2')).runSearch2Smoke(context)
  },
  {
    name: 'keyext',
    chain: true,
    what: 'The checks of the Vim-style keys, the tab groups of extensions as folders and the keyword of an extension in the command bar (needs the probes of compat/ in LUCIUM_EXTENSIONS: sec-driver-probe, no-permission-probe, keyext-probe).',
    order: 'Vim-style keys, the tab groups of extensions as folders and the keyword of an extension in the command bar: real keys, a local server, tabs and settings it puts back; before the About group is checked.',
    run: async (context) => (await import('./smoke-keyext')).runKeyExtSmoke(context)
  },
  {
    name: 'translate',
    chain: true,
    what: 'The checks of the translated interface and of the local page translation.',
    order: 'The translated interface and the local page translation: they change settings, open a page of their own and restore everything; before the About group is checked.',
    run: async (context) => (await import('./smoke-translate')).runTranslateSmoke(context)
  },
  {
    name: 'features',
    chain: true,
    what: 'The checks of the switches of the optional features (what a feature that is off still owns, the Fonctions pane).',
    order: 'The switches of the optional features and their pane: it changes settings and restores them; before the About group is checked.',
    run: async (context) => (await import('./smoke-features')).runFeaturesSmoke(context)
  },
  {
    name: 'tabsui',
    chain: true,
    what: 'The checks of the tab tree and the compact mode (real clicks on links, the chevron, the menu entries, the floating sidebar).',
    order: 'The tab tree and the compact mode: a space of its own with tabs opened by real clicks, the layout settings put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-tabsui')).runTabsUiSmoke(context)
  },
  {
    name: 'littlearc',
    chain: true,
    what: 'The checks of the mini window leftovers (the key that opens a link in it, the delay before archiving, the action bubble of the tray) and of the guest window.',
    order: 'The key that opens a link in a mini window, the delay before archiving, the action bubble of the tray and the guest window: real clicks and downloads on a server of its own, windows it closes again, settings put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-littlearc')).runLittleArcSmoke(context)
  },
  {
    name: 'webhardware',
    chain: true,
    what: 'The checks of the web hardware APIs (WebHID, WebUSB, Web Serial: pickers, register, Settings list, sub-frame, private tab; no device is touched).',
    order: 'The web hardware APIs: a tab and a private tab on a server of its own, the Settings window and the settings it changes put back; it adds a group to Settings, so before About.',
    run: async (context) => (await import('./smoke-webhardware')).runWebHardwareSmoke(context)
  },
  {
    name: 'capture',
    chain: true,
    what: 'The checks of the annotation sheet after a capture and of the commands by address (lucium://), both off by default.',
    order: 'The annotation sheet after a capture and the commands by address: they change settings and restore them; before the About group is checked.',
    run: async (context) => (await import('./smoke-capture')).runCaptureSmoke(context)
  },
  {
    name: 'fullscreen',
    chain: true,
    what: 'The checks of the notice over a page in HTML full screen (above the page, the site and Escape named, the keyboard left to the page, gone after its time or with the full screen) and of Escape that leaves it.',
    order: 'It puts the window in full screen and waits until it has left it: before the About group is checked, after the suites that measure the window.',
    run: async (context) => (await import('./smoke-fullscreen')).runFullscreenSmoke(context)
  },
  {
    name: 'platforms',
    chain: true,
    what: 'The checks of the platform layer (the options of the windows, the menu and the shortcuts of the system).',
    order: 'The platform layer: read-only checks of the options of the windows, the menu and the shortcuts; before the About group is checked.',
    run: async (context) => (await import('./smoke-platforms')).runPlatformsSmoke(context)
  },
  {
    name: 'import2',
    chain: true,
    what: 'The checks of the import from the other browsers (preview, confirmation, undo, sources, SQLite files, private window).',
    order: 'The import from the other browsers (preview, confirmation, undo): a made-up home folder, spaces of its own, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-import2')).runImport2Smoke(context)
  },
  {
    name: 'containers',
    chain: true,
    what: 'The checks of the tab containers (sessions of their own, storage, permissions, rules, erasure on delete) and of the windows with tabs of their own.',
    order: 'The tab containers and the windows with tabs of their own: containers and windows of their own, removed afterwards; before the About group is checked.',
    run: async (context) => (await import('./smoke-containers')).runContainersSmoke(context)
  },
  {
    name: 'downloadresume',
    chain: true,
    what: 'The checks of the resumption of downloads after a restart (records, checks of the file and of the server, single stream, private window, switched off).',
    order: 'The resumption of downloads after a restart: a server of its own and a folder of its own, a private window opened and closed, the setting put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-downloadresume')).runDownloadResumeSmoke(context)
  },
  {
    name: 'guard',
    chain: true,
    what: "The checks of the blocker's extended rules (scriptlets, stand-in resources, $removeparam, $csp) and of the fingerprint protection.",
    order: 'The extended rules of the blocker and the fingerprint protection: local lists and pages, a private window; the settings are put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-guard')).runGuardSmoke(context)
  },
  {
    name: 'passwords',
    chain: true,
    what: 'The checks of the password manager (a local site, the vault, the fill, the page bridge, the private window, the guards).',
    order: 'The password manager: a local site, a vault in the throw-away data folder, a private window it closes again; it adds a group to Settings, so before About.',
    run: async (context) => (await import('./smoke-passwords')).runPasswordsSmoke(context)
  },
  {
    name: 'perf-prepare',
    chain: true,
    what: 'The preparation of the scenarios of `pnpm perf`, without the measurement.',
    order: 'The preparation of the scenarios of `pnpm perf` (tabs of local pages, every feature on or off): it puts the settings back; before the About group is checked.',
    run: async (context) => (await import('./smoke-perf')).runPerfSmoke(context)
  },
  {
    name: 'library',
    chain: true,
    what: 'The checks of the bookmark library, the live folders and the sites opened as applications (off: nothing; on: it works).',
    order: 'The library functions (bookmarks, live folders, applications): they switch their settings on and back off; before the About group is checked.',
    run: async (context) => (await import('./smoke-library')).runLibrarySmoke(context)
  },
  {
    name: 'notes',
    chain: true,
    what: 'What the notes panel shows: « Cette page », « Cet espace » or « Toutes », the choice it opens on, the arrows and the count of the header, a note of another page opened without leaving the tab, « Nouvelle note » making way for the list.',
    order: 'Next to the other library functions: three notes of its own in the file of the profile, a server and tabs of its own, all taken away at the end; the notes switch put back as it was; before the About group is checked.',
    run: async (context) => (await import('./smoke-notes')).runNotesSmoke(context)
  },
  {
    name: 'work-views',
    chain: true,
    what: 'The checks of the work views: a split view of two local pages saved as a view from its menu and its sheet, the tile after the favourites, a real click that opens the view and a second one that opens nothing more, the removal and its « Annuler », the menu of the Dock, the row of the + and the switch.',
    order: 'A space, a server and a view of its own, all taken away at the end, the switch put back; before the About group is checked.',
    run: async (context) => (await import('./smoke-work-views')).runWorkViewsSmoke(context)
  },
  {
    name: 'probes-web',
    chain: true,
    what: 'The answers to three open questions about pages: what a page of a local file reads of a web site and of the disk, and whether a web page reaches a local file; what a page reads of the notifications after « Autoriser » without « Se souvenir »; window.open after a click in a frame of another site.',
    order: 'A server of its own with two sites, a folder of files it removes, tabs it closes, the answers it was given taken back; before the About group is checked.',
    run: async (context) => (await import('./smoke-probes-web')).runProbesWebSmoke(context)
  },
  {
    name: 'probes-ext',
    chain: true,
    what: 'The answers to two open questions about extensions: whether every request rule of extensions (each declarativeNetRequest action, the static ruleset, each chrome.webRequest event) is applied, which the application does itself in the request hooks of the session: each one is recorded in the report and fails the run when it is not applied; whether a click on an icon, and only that click, lets an extension with activeTab run a script in the tab; and whether a permission an extension lists as optional is granted only by the person, on the sheet, after a click or a key, then counted by chrome.permissions and by the access rules, and taken back. With corrections no engine had seen: a filter with several `*` on a long address, a loan of activeTab that must not come back with the tab, a worker that names another extension in its listeners, a folder one site past the bound of a manifest.',
    order: 'It loads three probes of compat/ itself (net-rules-probe, active-tab-scripting-probe, optional-permission-probe; no LUCIUM_EXTENSIONS needed), and writes and loads a few of its own in a throw-away folder, and takes them all out again, so that the suites that count the extensions do not see them; before the About group is checked.',
    run: async (context) => (await import('./smoke-probes-ext')).runProbesExtSmoke(context)
  },
  {
    name: 'activetab-origin',
    chain: true,
    what: 'Whether what a click on an icon lends an extension with activeTab stays on the origin that was lent: the extension sends the tab to another origin or another site (itself, through a redirect of the server, or by the page) and at once asks for a script (a function or a file, in the isolated world or in the world of the page) or a style sheet (of the author or of the user); no statement may run, no style sheet apply and nothing be read in the page the tab ends on, and the same origin (a pushState, a new document) and an extension that holds the host permission must keep working.',
    order: 'It loads compat/active-tab-origin-probe itself (no LUCIUM_EXTENSIONS needed), writes a copy of it with a host permission in a throw-away folder, and takes both out again, so that the suites that count the extensions do not see them; a server of its own and a tab it closes; right after probes-ext, which checks that the loan ends with the site.',
    run: async (context) => (await import('./smoke-activetab-origin')).runActiveTabOriginSmoke(context)
  },
  {
    name: 'mv2-blocking',
    chain: true,
    what: 'Whether the application applies what the blocking chrome.webRequest listeners of a Manifest V2 extension answer (a cancel, a redirect, a request header added and one removed, an answer header added and one removed), and refuses what it must: a redirect to a local file, an answer that comes after the time a request waits; and whether the Extensions page takes that Manifest V2 folder and warns of its old format.',
    order: 'It loads compat/mv2-blocking-probe itself (no LUCIUM_EXTENSIONS needed) and takes it out again, so that the suites that count the extensions do not see it; a server of its own and a tab it closes; right after the other extension probes, before the About group is checked.',
    run: async (context) => (await import('./smoke-mv2-blocking')).runMv2BlockingSmoke(context)
  },
  {
    name: 'tabcapture',
    chain: true,
    what: 'The capture of the sound of a tab by an extension (compat/tab-capture-probe: the identifier of chrome.tabCapture.getMediaStreamId, the stream of its offscreen document with one track of sound and none of picture and a peak above 0.05, the refusals, the mark of the tab, the sound put back as it was). Written before it was ever run: its first run is what checks that getDisplayMedia of an offscreen document gives a stream without a click.',
    order: 'It loads compat/tab-capture-probe itself (no LUCIUM_EXTENSIONS needed) and takes it out again, so that the suites that count the extensions do not see it; a server of its own and two tabs it closes (the tab it captures is silent for the person before the tone starts); right after mv2-blocking, with the other extension probes, before the About group is checked.',
    run: async (context) => (await import('./smoke-tabcapture')).runTabCaptureSmoke(context)
  },
  {
    name: 'extconsole',
    chain: true,
    what: 'The console of the pages of an extension as the journal of the Extensions page shows it: a probe with an offscreen document (no context isolation), an options page and a popup (isolated) says one line per page; the journal and the pages hold no line of Lucium\'s preloads (the bridges that reach the main world through contextBridge) nor the "context isolation" lines, and the isolated pages keep their bridges.',
    order: 'It writes its probe in a throw-away folder, loads it and takes it out again, so that the suites that count the extensions do not see it; a server of its own, a tab and a popup it closes; right after tabcapture, with the other extension probes, before the About group is checked.',
    run: async (context) => (await import('./smoke-extconsole')).runExtConsoleSmoke(context)
  },
  {
    name: 'about',
    chain: true,
    what: 'The checks of the About group (Settings › À propos et mises à jour) and of the About panel of the menu.',
    order: 'The About group (Settings › À propos et mises à jour, between the icon of the application and the state of Lucium): checked near the end, after the suites that open the Settings window and leave settings behind.',
    run: async (context) => (await import('./smoke-about')).runAboutSmoke(context)
  },
  {
    name: 'sec1-late',
    chain: true,
    what: 'The security checks that open a private window (the rest of `sec1` runs inside the principal suite).',
    order: 'The security checks that open a private window (the main part runs inside the principal suite): after the suites that look for "ephemeral-1".',
    run: async (context) => (await import('./smoke-sec1')).runSec1Smoke(context, 'late')
  },
  {
    name: 'surface-real',
    chain: false,
    what: 'The checks of the agent-style extension probe, on a copy of the real extension (loaded through LUCIUM_EXTENSIONS).',
    order: 'Not in the chain: the real extension is not part of the repository.',
    run: async (context) => (await import('./smoke-extensions')).runSurfaceRealSmoke(context)
  },
  {
    name: 'extwindows',
    chain: false,
    what: 'The checks of extensions with three profiles in three windows (probes generated from compat/window-probe; no LUCIUM_EXTENSIONS needed).',
    order: 'Not in the chain: it generates and loads probes of its own in three profiles and counts the extensions of each window, which the ten probes of the chain would change. `pnpm test:engine:extwindows` runs it in an application of its own, and the macOS workflow runs that command.',
    run: async (context) => (await import('./smoke-extwindows')).runExtWindowsSmoke(context)
  },
  {
    name: 'sec2',
    chain: false,
    what: 'The checks of what extensions may do (three probes of compat/ in LUCIUM_EXTENSIONS).',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-sec2')).runSec2Smoke(context)
  },
  {
    name: 'iso-toolbar',
    chain: false,
    what: 'The window, toolbar, split view and context menu checks.',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-iso-toolbar')).runIsoToolbarSmoke(context)
  },
  {
    name: 'iso-media',
    chain: false,
    what: 'The checks of the media player at the foot of the sidebar.',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-iso-media')).runIsoMediaSmoke(context)
  },
  {
    name: 'iso-plus',
    chain: false,
    what: 'The checks of the popover behind the + of the sidebar.',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-iso-plus')).runIsoPlusSmoke(context)
  },
  {
    name: 'iso-sidebar',
    chain: false,
    what: 'The sidebar checks (layout relations, folders, footer, cards, drag and drop).',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-iso-sidebar')).runIsoSidebarOnly(context)
  },
  {
    name: 'iso-settings',
    chain: false,
    what: 'The Settings window, theme editor, space sheets, dialog and task manager checks.',
    order: 'Not in the chain as a suite of its own: the principal suite runs these checks as one of its parts.',
    run: async (context) => (await import('./smoke-iso-settings')).runIsoSettingsSmoke(context)
  },
  {
    name: 'parts',
    chain: false,
    what: 'The parts of the principal suite named in LUCIUM_SMOKE_PARTS (comma-separated, see runMainParts in smoke.ts): a quick loop.',
    order: 'Not in the chain: a quick loop on parts of the principal suite.',
    run: async (context) => (await import('./smoke')).runMainParts(context, (process.env['LUCIUM_SMOKE_PARTS'] ?? '').split(',').map((part) => part.trim()).filter(Boolean))
  },
  {
    name: 'sec1',
    chain: false,
    what: 'The security checks (the surfaces of the interface, window.open, permissions, downloads, the private window), all of them.',
    order: 'Not in the chain under this name: the principal suite runs the main part, and `sec1-late` the part that opens a private window.',
    run: async (context) => (await import('./smoke-sec1')).runSec1Smoke(context, 'all')
  },
  {
    name: 'ollama',
    chain: false,
    what: 'The checks of the page summary by an Ollama of the local network named by a .local name: the name of this Mac resolved by macOS, the request sent to the private address it led to and naming it, no redirect followed (a stand-in model of the suite; nothing leaves this Mac).',
    order: 'Not in the chain: the requests go to an address of this Mac on the local network, which macOS may first ask the person to allow (Réseau local), and a Mac with no private address has nothing to resolve the name to. Run it alone, with LUCIUM_SMOKE_ONLY=ollama.',
    run: async (context) => (await import('./smoke-ollama')).runOllamaSmoke(context)
  },
  {
    name: 'client-hints',
    chain: false,
    what: 'Checks the Client Hints that the pages send against what they read: Sec-CH-UA, -Mobile and -Platform on every request, the navigations included, with the values Chromium gives the image, the script and the image of the other site, the brands, the system and the mobile flag of navigator.userAgentData, none of the four a page asks for with Accept-CH, no brand of a product. In a tab of the normal profile under Standard and under Renforcée, in a private window and in a window of a second profile. It writes one line, LUCIUM_SMOKE_CLIENT_HINTS, with everything it saw (a local server, nothing leaves this Mac).',
    order: 'Not in the chain yet: the checks of the decision of 13 November (the navigations carry the three hints Chromium puts on the rest) ran once, 41 of 44, the very first navigation of the launch leaving before the hints were read; the wait that fixes it has not run yet. It changes the protection level and opens a private window and a window of a second profile, all put back. Run it alone, with LUCIUM_SMOKE_ONLY=client-hints and no extension loaded.',
    run: async (context) => (await import('./smoke-client-hints')).runClientHintsSmoke(context)
  },
  {
    name: 'webstore-live',
    chain: false,
    driver: true,
    what: 'Loads the page of a real extension of the Chrome Web Store, read only, to see whether the store accepts the browser (nothing installed). A measurement: it prints what it saw and makes no check.',
    order: 'Never part of the chain: it needs the Internet.',
    run: async (context) => (await import('./smoke-webstore')).runWebStoreLiveSmoke(context)
  },
  {
    name: 'perf',
    chain: false,
    driver: true,
    what: 'The target of `pnpm perf`: it prepares the scenario of LUCIUM_PERF_SCENARIO, says so, and waits to be stopped (smoke-perf.ts).',
    order: 'Never part of the chain: it measures for minutes on the screen and the settings it finds.',
    run: async (context) => (await import('./smoke-perf')).runPerfDriver(context)
  },
  {
    name: 'favicons-measure',
    chain: false,
    driver: true,
    what: 'Looks every site of the state it was started with up on the real network and prints counts only.',
    order: 'Never part of the chain: it needs the Internet.',
    run: async (context) => (await import('./smoke-favicons')).runFaviconsMeasure(context)
  }
]

/** The suites of `pnpm test:engine`, in the order they run. */
export const CHAIN: readonly SuiteEntry[] = SUITES.filter((suite) => suite.chain)
