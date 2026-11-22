// The settings of the user: every key of `Settings`, with the types and the bounds of their values. The default of each one is in
// model-defaults.ts. Moved out of model.ts as it was; model.ts still exports all of it.

import type { AutoplayMode } from './autoplay'
import type { ReadableDefault, ReadableMode } from './readable-mode'
import type { SpellCheckChoice } from './spell-check'
import type { Container, ContainerRule } from './containers'
import type { CustomFilterList } from './custom-filter-lists'
import type { LanguageSetting } from './i18n'
import type { KeyBindings } from './keybindings'
import type { ProfileOverrides } from './profiles'
import type { SiteDataType } from './site-data'
import type { SiteDataAnimation } from './site-data-overlay'
import type { DohMode } from './dns'
import type { ProxySetting } from './proxy'
import type { OllamaConfig } from './ollama'
import type { BarPosition } from './annotate-bar-position'
import type { PanelSizes } from './panel-scale'

/** Search *inside* a site from the command bar: `yt lofi` or `yt` + Tab. `%s` is the URL-encoded query. */
export interface SiteSearch {
  keyword: string
  name: string
  url: string
}

export type PermissionDecision = 'allow' | 'deny'

/** How a tab is put to sleep: its web view is dropped, or kept in memory but frozen. */
export type SleepMode = 'discard' | 'freeze'

/** Which of the two feeds built into a build the updates come from: the stable one, or the one that carries the test versions first (main/shell/update-source.ts). */
export type UpdateChannel = 'stable' | 'test'

/**
 * What the ad and tracker blocker does with a request that goes to the site of the document making it. Standard
 * leaves it alone unless a list rule names the first party; Strict applies the lists to it too.
 */
export type BlockMode = 'standard' | 'strict'

/** When the extensions installed from the Chrome Web Store look for a newer version: only when asked, once a day, or once a week. */
export type WebStoreUpdates = 'manual' | 'daily' | 'weekly'
export const WEB_STORE_UPDATES: readonly WebStoreUpdates[] = ['manual', 'daily', 'weekly']

/** Links opened from other apps whose host matches go to this space. */
export interface LinkRoute {
  host: string
  spaceId: string
}

/** What the import of a Tweak does with its script (see `Settings.boostScriptImport`). */
export type BoostScriptImport = 'ask' | 'never'

/** The protection a profile began with: see `Settings.protectionBaseline`. */
export type ProtectionBaseline = 'standard' | 'renforcee'

export interface Settings {
  /** `%s` is replaced by the URL-encoded query. */
  searchUrlTemplate: string
  siteSearches: SiteSearch[]
  linkRoutes: LinkRoute[]
  sidebarVisible: boolean
  sidebarWidth: number
  /** Width of the panel docked beside the page: an extension's side panel, or a web panel. */
  sidePanelWidth: number
  /**
   * The appearance of Lucium itself (the sidebar, the panels, the Settings, every window of the interface): the Mac's, or forced light or dark. The only setting that
   * moves `nativeTheme.themeSource` (shell/appearance.ts). A space whose theme is set to Light or Dark keeps its own in the sidebar.
   */
  interfaceAppearance: 'auto' | 'light' | 'dark'
  /**
   * The appearance asked of the websites: what a page reads of `prefers-color-scheme`, light or dark; automatic leaves the pages with the appearance of Lucium.
   * Only the pages: it never changes the interface (engine/color-scheme.ts). Before this setting had a name of its own it was both appearances at once.
   */
  websiteAppearance: 'auto' | 'light' | 'dark'
  /** Shift-click on a link opens a preview (Glance) rather than a new tab. */
  peekWithShift: boolean
  /** Hours after which an open mini window is closed and archived. 0 never. */
  littleArcArchiveHours: number
  /** The toolbar shows the whole address instead of the site name. */
  fullUrlInToolbar: boolean
  /** The toolbar has a button after Reload that reloads the tabs of every space (also in the View menu and the command bar). Off by default. */
  showReloadAllButton: boolean
  /** "Actualiser tous les onglets" also wakes the tabs that sleep and loads them afresh (off: it offers to, in the notice). */
  reloadAllWakes: boolean
  /** The window can be dragged by the toolbar. */
  dragWindowFromToolbar: boolean
  /** The note under the command bar about suggestions being asked of the search engine was read and closed. */
  suggestionsNoticeSeen: boolean
  /**
   * The welcome sheet was shown on first launch; true marks it as shown so it doesn't reappear. False by default, which a file written before the flag
   * existed also reads as: the sheet opens only on a new profile (no state file at the launch, main/shell/launch-sheets.ts), never on such a file.
   */
  welcomeDone: boolean
  /**
   * The first-launch guide was opened by itself once (main/shell/launch-sheets.ts). It opens only on a new profile, one whose state file did not
   * exist at the launch (store.ts `fresh`): a file that lacks this flag is an existing profile and never sees the guide by itself.
   */
  firstLaunchDone: boolean
  /**
   * The guide « Vous venez d’Arc ? » (shared/arc-guide.ts) was shown once: it opens by itself when the sheet of an import from Arc is left, until it has been
   * seen (by itself or from Aide › Vous venez d’Arc ?). A memory, not a function: it gates nothing.
   */
  arcGuideSeen: boolean
  /** After an update, a sheet lists what changed, read from the changelog shipped with the application, once per version. Off: nothing is compared or read. */
  whatsNewSheet: boolean
  /** The version of the application the last launch ran; '' for a state that has not recorded one yet. */
  lastSeenVersion: string
  /** "Increase contrast" always, whatever the system asks: sets `data-contrast="more"` on every document of the interface. Off: the system decides. */
  forceHighContrast: boolean
  /** "Reduce motion" always: the animations and transitions of the interface stop. Off: the system decides. */
  forceReduceMotion: boolean
  /** "Reduce transparency" always: the floating surfaces are opaque. Off: the system decides. */
  forceReduceTransparency: boolean
  /** A card with the full title and address appears when the pointer rests on a tab. */
  hoverCards: boolean
  /** Sites may ask to share the screen or a window in a call (getDisplayMedia); off, every such request is refused with no question. */
  allowScreenShare: boolean
  /** The card of a tab also gives the memory and processor its page uses (off by default). */
  showTabMemory: boolean
  /** A tab row says what its page is doing: a ring while it loads, "zz" asleep, a snowflake frozen, a speaker button, a red dot on a failed load. Off, the rows keep their plain look. */
  tabStateBadges: boolean
  /** The foot of the sidebar shows a downloading file: a ring with the count, a bubble at the end, "Reprendre / Ignorer" on a failure. Off, the footer holds the plain count. */
  downloadStatusChip: boolean
  /** A favourite shows its name under its icon (tiles 70 x 58). Off by default: the tile holds the icon only and the name is a bubble. */
  favoriteNames: boolean
  /** The foot of the sidebar has a ring of the memory the browser holds; a click opens the heaviest tabs, to put to sleep or close (shared/resources.ts). */
  resourceGauge: boolean
  /** The bar above the page with back, forward, reload, the address and the extension icons. */
  showToolbar: boolean
  /** The sidebar is at the right of the window and the whole window is mirrored. Off (left) by default. */
  sidebarRight: boolean
  /**
   * No longer asked by anything: the picker offers the picture of a space whatever this says. Kept so that a saved state and the Settings lists that still
   * name it read as before; it gates nothing.
   * @deprecated
   */
  spaceImages: boolean
  /** Sites kept per space and opened beside the page ("Volets web"). Off by default, and nothing about it shows anywhere. */
  webPanels: boolean
  /** Which application icon the Dock shows (see icons.ts). */
  appIcon: string
  /** Ask before ⌘Q. */
  warnBeforeQuitting: boolean
  /** Look for a newer version at launch and once a day when an update feed is configured. */
  autoUpdate: boolean
  /**
   * The channel the updates come from: `stable` (the default) or `test`, which gets the versions before the stable one does. It only chooses between the two
   * addresses sealed into a build, and means something only for a build that carries a test one: it can never name an address.
   */
  updateChannel: UpdateChannel
  /** Also look for native messaging hosts in the folders Chrome uses (off: only Lucium's own folder). A host found there is started by Lucium. */
  chromeNativeHosts: boolean
  /** The shortcut of the new mini window also works while another application is in front. */
  littleArcShortcut: boolean
  /** Off pauses every Tweak on every site without deleting any (the global switch of the Tweaks). */
  boostsEnabled: boolean
  /**
   * What happens to the script of a Tweak imported from a file or a link: `ask` keeps it, switched off, after a preview that shows it;
   * `never` drops it at import. Either way an imported script does not run until its owner switches it on.
   */
  boostScriptImport: BoostScriptImport
  /**
   * Sharing Tweaks and themes as files and links (Tweak editor menu, command bar, space menu, Settings › Extensions et outils › Plus de réglages). Off hides every entry, makes the shell
   * and the reducer refuse the requests, and leaves nothing running: the feature only acts when a person asks.
   */
  boostSharing: boolean
  /** Pinned tabs show a short title (the site's name) instead of the page title. */
  tidyPinnedTitles: boolean
  /** Where the folders that "Ranger les onglets…" makes stand: above the loose Today tabs (the default) or under them. Remembered from the panel's choice. */
  tidyFoldersPosition: 'top' | 'bottom'
  /** Downloaded files get a cleaner name. */
  tidyDownloads: boolean
  /** Cancel requests to known advertising and tracking networks (third parties only). */
  blockAds: boolean
  /** Alias of `blockAds` that the blocker also reads (an older state file may carry it alone). No row of its own: the switch of `blockAds` writes both. */
  blockTrackers?: boolean
  /** Remove cookie-consent banners: block the consent platforms and hide the banners left in the page. */
  blockCookieBanners: boolean
  /** Hide the elements the filter lists name (ad slots, banners), on top of cancelling their requests. */
  blockCosmetic: boolean
  /** Filter lists the user switched off (ids from filter-lists.ts); the others of a switched-on category are in use. */
  disabledFilterLists: string[]
  /** Days between two checks for newer filter lists. */
  filterUpdateDays: number
  /** Sites (host and subdomains) where nothing is blocked. */
  blockExceptions: string[]
  /** Sites (host and subdomains) whose windows open without a click of the user: the blocked-window notice's « Toujours autoriser sur ce site ». */
  popupExceptions: string[]
  /** How the ad blocker treats the requests a site makes to itself (see BlockMode). */
  blockMode: BlockMode
  /** The mode of some sites (host and subdomains), which replaces `blockMode` for their pages: set from the site panel, kept per site. */
  blockModeSites: Record<string, BlockMode>
  /**
   * The extended rules of the filter lists are applied (needs the ad or cookie blocking on): scriptlets of Lucium's own library, stand-in resources
   * for `$redirect`, `$removeparam` and `$csp`. Off: those rules do nothing, and no script is put into a page for the blocker.
   */
  blockScriptlets: boolean
  /** Fingerprinting protection: noise on what a page reads back from a canvas, WebGL or audio, narrowed `navigator` and WebRTC figures (see fingerprint.ts). */
  reduceFingerprint: boolean
  /** …with the stricter figures (rounded screen, generic graphics card, no list of local fonts). Means nothing while `reduceFingerprint` is off. */
  fingerprintStrict: boolean
  /** Sites (host and subdomains) where the fingerprint protection is left off, because it broke them. */
  fingerprintExceptions: string[]
  /** Names shown for profiles, by profile id. The id stays the storage key, so renaming never loses data. */
  profileNames: Record<string, string>
  /** Expose the space theme to web pages as `--arc-palette-*` CSS variables (a page can read it, so it is opt-in). */
  allowThemeToSites: boolean
  /** Shortcut overrides by command id (see keybindings.ts). */
  keyBindings: KeyBindings
  /** Links opened from other apps open in a mini window unless a routing rule picks a space. */
  externalLinksInLittleArc: boolean
  /** Shift-click (or a link to another site, when enabled) opens a preview panel instead of a tab. */
  /** Ask the search engine for suggestions while typing in the command bar. */
  searchSuggestions: boolean
  peekOnExternalLinks: boolean
  /** Leaving a tab that plays a video moves the video to a floating Picture in Picture window. */
  autoPictureInPicture: boolean
  /**
   * The Picture in Picture button of a site (Twitch, YouTube…) opens Lucium's floating window instead of the system's, whose design is not ours:
   * a live stream there has its own « EN DIRECT », no progress line, no ±10 s. Off: the system's window, as the site asks. On by default.
   */
  sitePictureInPictureInLucium: boolean
  /**
   * The player at the foot of the sidebar for a tab that makes sound while it is not on screen (buttons, track, volume). It needs a script in
   * the main frame of every page; off, no page gets it, no player opens and the tab's volume is the page's own. On by default.
   */
  mediaPlayer: boolean
  /** Hours of inactivity before a Today tab is archived. 0 disables auto-archive. */
  autoArchiveHours: number
  /** Per-profile overrides of the search engine, suggestions, auto-archive delay and download folder (see profiles.ts). */
  profiles: ProfileOverrides
  /** Minutes before a background tab's web view is destroyed to free memory. 0 disables sleeping. */
  sleepAfterMinutes: number
  /**
   * At most this many tabs awake in the background, over every window: beyond it, the sweep puts to sleep the tab left the longest ago before its
   * delay. Protected tabs (sound, download, text not sent, Picture in Picture, "never put to sleep") and one tab per site never put to sleep do not count. 0: no cap.
   */
  sleepAwakeMax: number
  /** Minutes after which a background tab's page is frozen (it runs nothing), before it is freed at the delay. 0: no freezing first. */
  sleepFreezeAfterMinutes: number
  /** What the delay does to a tab: drop its web view (memory freed, the page reloads) or freeze it (memory kept, no CPU, back at once). */
  sleepMode: SleepMode
  /** Sites (host and subdomains) whose tabs the delay never puts to sleep. */
  sleepExcludedHosts: string[]
  /** Every tab of those sites stays awake; off (the default), only the one shown last of each site does, and the others follow the delay. */
  sleepExcludedKeepAll: boolean
  /** A tab that plays sound is left awake. */
  sleepSkipAudible: boolean
  /** A pinned tab is left awake (off: pinned tabs sleep like the others). */
  sleepSkipPinned: boolean
  /** A notice with a "Réveiller" button each time the delay puts a tab to sleep. */
  sleepNotify: boolean
  /**
   * The launch gives a page to every tab of every space at once (one page, and its memory, per tab). Off (the default), a launch loads
   * the tab each window shows and the tabs the user keeps awake (see `wakesAtLaunch`); every other tab sleeps, with its title and icon, until it is shown.
   */
  loadAllTabsAtLaunch: boolean
  /** Unpacked extensions (folders containing manifest.json), loaded at every launch. */
  extensionPaths: string[]
  /** A page of the Chrome Web Store may install an extension (the install button of the page), after a sheet that lists what it asks for. Nothing reaches Google until the user acts. */
  webStoreInstall: boolean
  /** When the extensions of the store look for newer versions. `manual` (the default) never asks Google by itself. */
  webStoreUpdates: WebStoreUpdates
  /** "Clear this site's data": the types ticked last time (see site-data.ts). */
  siteDataTypes: SiteDataType[]
  /** …whether the subdomains were included. */
  siteDataSubdomains: boolean
  /** …and whether the tab went back to the root of the site afterwards. */
  siteDataReload: boolean
  /** …whether « Inclure HTTP » was ticked by hand: the http origins go too, whatever the page (a page served over http includes them anyway). */
  siteDataHttp: boolean
  /** Réglages › Vie privée et sécurité: whether the panel asks again before it erases (the extension's "ask for confirmation"). */
  siteDataConfirm: boolean
  /** …whether the panel closes at once and the run ends in the background (« Fermeture auto », on by default as in the extension). */
  siteDataAutoClose: boolean
  /** Réglages › Vie privée et sécurité: whether a system notice tells how a run nobody watched went (shortcut, menu, panel closed at once). */
  siteDataNotify: boolean
  /** Réglages › Vie privée et sécurité: the animation drawn on the page while its data is erased (site-data-overlay.ts); none while motion is reduced. */
  siteDataAnimation: SiteDataAnimation
  /** The sites erased last, newest first, offered for one-click reuse. Never written from a private window (see site-data.ts). */
  siteDataRecents: string[]
  /** Sites (host and subdomains) in Developer Mode (⌃D): their pages reload without the HTTP cache (see developer-mode.ts). */
  developerHosts: string[]
  /** Open again at launch the extra windows that were open when the application quit. */
  restoreWindows: boolean
  /** Profiles that have had a page: their storage is expected on disk, so one that is gone is a missing profile (see profile-recovery.ts). */
  usedProfiles: string[]
  /** Ids of deleted profiles whose folders may still be on disk: no new profile takes them, and the next launch removes the folders (profile-retire.ts). */
  retiredProfileIds: string[]
  /** The visited pages are not recorded (what is already in the history stays). A profile can say otherwise: see profiles.ts. */
  historyOff: boolean
  /** Encrypted DNS is set by the user (off: nothing is configured, Chromium's own behaviour stands). */
  dohCustom: boolean
  /** With `dohCustom`: Automatic (encrypted when the provider supports it), Secure (encrypted only; needs a server), or Off. */
  dohMode: DohMode
  /** With `dohCustom`: a provider of the fixed list of dns.ts, `custom` (see `dohCustomUrl`), or `system` (the network's own). */
  dohProvider: string
  /** With the `custom` provider: an `https://` address of a DNS-over-HTTPS server (RFC 8484 template). */
  dohCustomUrl: string
  /** The proxy is set by the user (off: the system's proxy is used and nothing is configured). */
  proxyEnabled: boolean
  /** With `proxyEnabled`: the proxy of every profile that has none of its own. Never holds a login: a proxy that asks for one gets a prompt. */
  proxy: ProxySetting
  /** The "Cookies par site" view and its list of sites to keep (off: no entry in the menus). */
  cookieManager: boolean
  /** Sites (host and subdomains) whose cookies the clean-up of that view never removes. */
  cookieKeepHosts: string[]
  /** Private tabs in a normal window (File › Nouvel onglet privé) are available (off: the action is refused and the entries are not shown). */
  privateTabs: boolean
  /**
   * Tab containers: a tab can be opened in an identity of its own (cookies, storage and permissions apart from the profile's). Off by default,
   * and nothing about it shows anywhere. Turning it off keeps the containers and the tabs in them; it only stops new ones.
   */
  tabContainers: boolean
  /** The containers (see containers.ts). Changed only through the `container/*` actions: the interface may not patch them (ipc-policy.ts). */
  containers: Container[]
  /** The sites that always open in a container. */
  containerRules: ContainerRule[]
  /**
   * Windows with tabs of their own: a window opened after the first shows the pinned tabs and the tabs it opens itself, not the Today tabs of
   * the others (see window-tabs.ts). Off by default, and every window shows the same tabs.
   */
  independentWindows: boolean
  /** Address of the feed "Check for Updates…" reads (a GitHub "latest release" answer); empty until a release page exists. */
  updateFeedUrl: string
  /**
   * A memory of the notice of an update (shared/auto-update.ts): the last version it offered, and how many times it was shown without « Installer ».
   * At UPDATE_NOTICE_MAX_TIMES that version is no longer offered by itself; the menu still finds it. `dropped`: a downloaded update dropped at the
   * quit because the feed had withdrawn it, told at the next launch.
   */
  updateNotices: { version: string; shown: number; dropped?: string }
  /** HTTPS first: a main-frame `http://` navigation is tried over `https://` first, and falls back with a notice (see privacy.ts). On for a new profile; a saved file keeps its own value. */
  httpsUpgrade: boolean
  /** Send `Sec-GPC: 1` with every request (Global Privacy Control). */
  sendGpc: boolean
  /** Remove the known tracking parameters (`utm_*`, `fbclid`, `gclid`…) from the addresses a navigation goes to. */
  stripTrackingParams: boolean
  /** Remove those same parameters (the fixed list of privacy.ts) from the addresses copied to the clipboard: Copy URL, the menus, "Copier le lien". Off: the address is copied as it is. */
  stripCopiedLinks: boolean
  /**
   * The protection the profile began with, which the Settings compare the four settings of « Renforcée » with (the « modified » mark, « Rétablir », « Tout
   * rétablir »): « standard » for a profile that existed before « Renforcée » became the default (it keeps the default it had, so nothing marks its
   * protection as changed), « renforcee » for a profile made since. A file that does not name it is an earlier profile's. It is set when the profile is made or
   * its file first read, and never changes after that: not by the interface (ipc-policy.ts), nor by a reset (settings-catalog.ts `KEPT_ON_RESET`).
   */
  protectionBaseline: ProtectionBaseline
  /** Fetch the icon of the favourites and tabs that have none, from the site itself, once, with no cookie (see favicon.ts). On by default. */
  resolveFavicons: boolean
  /** Page zoom kept per site: host name (without "www.") → factor (1.1 = 110 %). A site at 100 % has no entry (see site-zoom.ts). */
  siteZoom: Record<string, number>
  /** Autoplay for the whole browser: `block` is Chromium's policy (sound only after a gesture), `allow` is Electron's own default. Applies to pages made afterwards (see autoplay.ts). */
  autoplayPolicy: AutoplayMode
  /** Edit › Spelling and Grammar › Check Spelling While Typing: `auto` follows the system (on for macOS, off elsewhere), `on` and `off` are the user's choice and last across launches (see spell-check.ts). */
  spellCheck: SpellCheckChoice
  /** Autoplay for one site (host without "www.", its subdomains too): a site not listed follows `autoplayPolicy`. */
  siteAutoplay: Record<string, AutoplayMode>
  /**
   * Deprecated, read by nothing: it was « Un réglage pour chaque site », a switch that turned off the per-site choices of autoplay and their row in the
   * site panel. The choices of the sites always apply now; the key stays so that an older state file loads and keeps it.
   */
  autoplayPerSite: boolean
  /** "Effacer à la fermeture" is on: the data of the listed sites is erased when their last tab closes (and at quit, with `siteDataClearOnQuit`). Off by default; the tab menu and the site panel switch it on with the first site. */
  siteDataClearOnCloseEnabled: boolean
  /** Sites (exact host) whose data is erased when the last tab on them closes (see site-clear.ts). Never written from a private window. */
  siteDataClearOnClose: string[]
  /** …and when the application quits. */
  siteDataClearOnQuit: boolean
  /** The user's own filter lists can be added and are compiled with the blocker's. Off, none is compiled (their rules stay on disk). */
  customFilterListsEnabled: boolean
  /** The user's own filter lists (a file, or pasted rules); their rules live in the filters folder (see custom-filter-lists.ts). */
  customFilterLists: CustomFilterList[]
  /** Keep a few dated copies of the spaces and tabs in the data folder, to go back to one (see session-backups.ts). Never from a private window. */
  autoBackup: boolean
  /** How many copies are kept; the oldest goes when a new one is made. */
  autoBackupKeep: number
  /** Minutes between two copies (a copy is only made when something changed since the last one). */
  autoBackupMinutes: number
  /** The lock is on (Réglages › Vie privée et sécurité › Verrouillage): the next three settings mean something, and only while a phrase exists (see lock.ts). Off: it costs nothing. */
  lockEnabled: boolean
  /** The whole application asks to be unlocked when it starts and when the Mac wakes up or locks its screen. */
  lockApp: boolean
  /** Ids of the spaces that ask to be unlocked: their tabs are hidden and their pages asleep until then. */
  lockedSpaces: string[]
  /** Touch ID is offered to unlock, where this Mac has it; the phrase stays the way in when it fails. */
  lockTouchId: boolean
  /** A tab that is archived keeps its last pages (up to 20 web addresses) so that reopening it brings its Back list back (see closed-history.ts). Costs memory in the archive: off. */
  reopenHistory: boolean
  // ---- Interface language (see i18n.ts). Off: the interface is French, whatever the system says. ----
  /** The interface is translated: menus, sidebar, toolbar, command bar and settings are shown in `language`. Off by default: the French texts are the originals. */
  interfaceTranslated: boolean
  /** "auto" follows the system's language (French for French, English otherwise); effective only while `interfaceTranslated` is on. */
  language: LanguageSetting
  // ---- Local page translation (see translate-local.ts). Off by default; nothing is fetched except on a click. ----
  /** File › Traduire cette page…: the text of a page is translated on this computer, with models the user placed or chose to download. */
  translateLocal: boolean
  /** The system's own translation is tried first (macOS); off, the panel goes straight to Bergamot then the glossary. */
  translateSystemEngine: boolean
  /** The language pages are translated into: "auto" is the language of the interface. Otherwise a language code ("fr", "de"). */
  translateTarget: string
  /** The folder the translation models are kept in; empty is Lucium's own folder. Set only through the system's folder box. */
  translateModelsDir: string
  /**
   * « Toujours traduire <langue> » (the toolbar button's popover): the languages whose pages are translated by themselves when they load, into the target
   * language. Language codes, each once (shared/translate-quick.ts `cleanTranslateLanguages`). Never written from a private window or a private tab.
   */
  translateAlways: string[]
  /** « Ne jamais traduire ce site »: the sites never translated by themselves, which wins over `translateAlways`. Host names, as the other lists of sites keep them. */
  translateNeverSites: string[]
  /** A memory: the one-time notice of macOS's translation (Apple may count its use, never the text) was given, the first time macOS translated a page. */
  translateSystemNoticeSeen: boolean
  /** The extension icons that do not fit the toolbar, and the ones unpinned, go to a « menu (see extension-overflow.ts). Off: every icon stays in the bar. */
  extensionOverflow: boolean
  /** Ids of the extensions the user took out of the toolbar (shown in the « menu only). Every other extension is pinned. */
  unpinnedExtensions: string[]
  /** Extensions that declared the permission may read the history and the favourites and erase the data of sites (chrome.history, bookmarks, browsingData). */
  extensionDataApis: boolean
  /**
   * Extensions that declared tabCapture may capture the sound of a tab (never its picture) when the person allowed each one in its details (shared/tab-capture.ts).
   * On by default: an extension is off until the person allows it, so this switch only takes the whole function away.
   */
  extensionTabCapture: boolean
  /** The user-script manager (Settings › Fonctions en option, its scripts on « Scripts importés ») runs the scripts the user turned on, in the pages they match. Off by default: it runs code in pages. */
  userScripts: boolean
  // ---- Keyboard and extensions (see key-ext-settings.ts) ----
  /** Vim-style keys in the pages: scroll, link hints, back and forward, tab changes (see vim-keys.ts). Off by default. */
  vimKeys: boolean
  /** Sites (host and subdomains) where the Vim-style keys are off. */
  vimKeysExcludedHosts: string[]
  /** The tab groups that extensions make (chrome.tabGroups) are shown as folders in the sidebar while they live (see group-folders.ts). Off by default. */
  tabGroupFolders: boolean
  /** The keyword of an extension (chrome.omnibox) typed in the command bar, then a space and some text, runs that extension on Enter (see omnibox.ts). Off by default. */
  omniboxKeywords: boolean
  /** The password manager (see passwords.ts): a local vault, filled on request, offered on a submitted sign-in form. Off by default: it puts a script in the pages and keeps secrets. The vault is a file of its own, never part of this state. */
  passwordManager: boolean
  // ---- Web tools (see web-tools.ts): every one is off by default and costs nothing while off ----
  /** File › Code QR de cette page, and "Code QR de ce lien" in the menu of a link. The code is drawn here, never by a service. */
  qrCode: boolean
  /** A click of the middle button on a page (not on a link or a field) starts autoscroll. */
  autoScroll: boolean
  /** The split view's menu offers to scroll its panes together. */
  scrollSync: boolean
  /**
   * Work views (work-views.ts): their tiles after the favourites, their entries in the menus and the command bar, the actions `view/*`. Off, all of
   * that is gone and every `view/*` action changes nothing; the views saved stay in the file.
   */
  workViewsEnabled: boolean
  /** Hold the right button and move to go back, forward, open or reload (see gestures.ts). */
  mouseGestures: boolean
  /** Sites (host and subdomains) where the gestures are off. */
  mouseGestureExcludedHosts: string[]
  /** File › Surveiller cette page: the pages are fetched again now and then, and a system notice tells of a change (see page-watch.ts). */
  pageWatch: boolean
  /** The pages being watched, at most `PAGE_WATCH_MAX`. Never written from a private window. */
  pageWatches: PageWatch[]
  /** The reader's "Lire à voix haute" buttons and the "Lire la sélection" entry of the page menu (the system's voices). */
  readAloud: boolean
  /** Less activity in the background when the battery is low, or when asked (see battery-saver.ts). */
  batterySaver: boolean
  /** The downloads popover gets a pause / resume button, and an interrupted download that can go on has a resume one. */
  downloadPause: boolean
  /**
   * A download in progress can go on after Lucium is restarted: its address (often with a token) and the path of its partial file are
   * written to a private file of the data folder (see download-resume.ts). Never for a private window or tab.
   */
  downloadResume: boolean
  /** Ask where each file is saved (the system's save box), instead of putting it in the downloads folder at once. */
  downloadAskWhere: boolean
  /** "Ouvrir avec…" on a downloaded file: the application chosen is remembered for that type of file and used by "Ouvrir" (see open-with.ts). */
  openWithMemory: boolean
  /** The applications remembered by type of file (extension → path of an `.app`). Only the main process adds to it; the interface can take from it. */
  openWithApps: Record<string, string>
  /** Links get "Ouvrir sans l’enregistrer": the file goes to a temporary folder of the application, is opened, and is removed when the application quits. */
  openUnsaved: boolean
  /** File › "Enregistrer en PDF avec l’adresse…": a PDF of the page with its address and the date in the footer of every page. */
  pdfWithSource: boolean
  /** The read-later list can be arranged in named folders. Off: the list is flat as before (pages keep their folder, which is just not shown). */
  useReadLaterFolders: boolean
  /** The readable mode of every site that has no choice of its own: Original (nothing happens, the default), Dark, Light, or Auto (Dark while the interface is dark, Original otherwise). See readable-mode.ts. */
  readableMode: ReadableDefault
  /** The readable mode of a site (host and subdomains), over the default; the nearest domain wins. A file from before holds the forced dark mode's switch, option and exceptions instead: `migrateSettings` (sidebar-state.ts) carries them over. */
  siteReadableMode: Record<string, ReadableMode>
  /** The toolbar's button « Contraste de la page », before the site control center: the mode of the site on screen, and a menu to change it. On by default. Only for a web page that is not a PDF, never in a private tab or window. */
  readableToolbarButton: boolean
  /** Material of the window behind the interface (macOS vibrancy). 'none' is an opaque window. */
  windowVibrancy: WindowVibrancy
  /** How opaque the window background (the space colours) is, in percent; below 100 only shows with a vibrancy material behind it. */
  sidebarOpacity: number
  /** Thickness in px of the border of the window around the page (10 by default). 0 puts the page against the window's edge. */
  windowBorder: number
  /** A hairline around the page card, in the border of the window. Off by default. */
  cardOutline: boolean
  /** Back on the first page of a tab opened from a link closes it and returns to the tab it came from. Off: no origin is remembered. */
  backClosesOpenedTab: boolean
  /** ⌃Tab goes through the tabs in the order they were used, with a panel of pictures while ⌃ is held. Off: ⌃Tab is left to the page. */
  tabCycleRecent: boolean
  /** Two fingers across the list of tabs (a horizontal swipe of the trackpad) go to the space before or after, one per gesture (see space-swipe.ts). Off: the wheel only scrolls the list. */
  spaceSwipe: boolean
  /** A tab dragged from the sidebar onto the page shows where the split view would put it. Off: dragging over the page does nothing. */
  dragToSplit: boolean
  /** Ask before closing a window that shows several tabs (never the last window: closing it already is quitting). Off by default. */
  warnBeforeClosingWindow: boolean
  /** ⌘-click and middle-click on a link open its tab in the background. Off: the new tab comes to the front. */
  modifiedClickBackground: boolean
  /** A link that opens a tab by itself (`target="_blank"`) opens it in the background. Off by default: the tab comes to the front. */
  blankLinkBackground: boolean
  /**
   * Mode compact: one command (View menu, command bar, a shortcut to choose) hides the sidebar and the toolbar together; the sidebar comes back
   * when the pointer touches the window's edge, and then shows the page's address in place of the tab on screen. Off: none of that exists and
   * the sidebar and the toolbar keep their usual place. This is the switch of the function; whether the window is compact is read from the two settings it hides (see compact.ts).
   */
  compactMode: boolean
  /**
   * Tab tree: a tab opened from a link hangs under the tab it came from, indented, and a branch folds away. Off by default: the sidebar is flat.
   * Turning it off flattens the tree (the order of the rows stays as it is).
   */
  tabTree: boolean
  /** A small "125 %" mark in the toolbar while the page is not at 100 %; a click puts it back. Nothing is drawn at 100 %. */
  showZoomIndicator: boolean
  /** Windows can be given a name (Window menu, command bar). Off by default: no entry, no name shown, the Window menu is the system's own. */
  nameWindows: boolean
  /** Size of the interface (sidebar, toolbar, panels) in percent, 100 to 200; the page keeps its own zoom. 100 is the default size and does nothing. */
  uiScale: number
  /**
   * The size of the panels that open over a window and of the windows of their own (Settings › Apparence › Taille des fenêtres et des panneaux), by screen
   * (shared/panel-scale.ts: a screen is known by its name, size and density, not by the id the system gives it). A screen with no entry is « Automatique »:
   * its size is worked out from the size of the screen. `{}` by default; the choices of the screens that are not connected stay until they are removed.
   */
  panelSizes: PanelSizes
  /**
   * Deprecated: the level of the Settings window (« Essentiel » / « Tous les réglages »), which is gone: every page shows its main rows and folds the
   * rest in one « Plus de réglages » that names what it holds (shared/settings-placement.ts). Nothing reads it any more; the key stays so that a state
   * file that holds it loads, and keeps what it says.
   */
  showAdvancedSettings: boolean
  // ---- Search (the command bar and the find bar): see suggestions in shared/command-bar.ts, bangs.ts, opensearch.ts, regex-find.ts, calc.ts ----
  /** The sources of the command bar's proposals (all on by default): pages of the history, open tabs, the archive, pages kept to be read later. The engine's own suggestions are `searchSuggestions`. */
  suggestHistory: boolean
  suggestTabs: boolean
  suggestArchive: boolean
  suggestReadLater: boolean
  /**
   * The command bar opened for a new tab (⌘T) goes to the open tab that answers what was typed, instead of opening a new
   * tab with it. Off: Enter opens a new tab with what was typed, and the open tabs stay in the list below (arrows or click). The bar that edits the
   * current tab's address (⌘L) always offers the switch first.
   */
  goToOpenTab: boolean
  /** "!w foo" (or "foo !w") searches the site of a keyword: the user's site searches first, then the fixed list of shared/bangs.ts. */
  searchBangs: boolean
  /** A page that declares an OpenSearch engine in its own document is offered once, as a notice with a button; nothing is added without that click. Off by default. */
  searchDiscovery: boolean
  /** The sites that were offered their search already (host names, newest last, at most `SEARCH_DISCOVERY_SEEN_MAX`): one notice per site. */
  searchDiscoverySeen: string[]
  /** A typed calculation gives its answer at the top of the command bar (Enter copies it). */
  commandBarCalc: boolean
  /** How large the command bar's card is: its width, the height of its list and the column of the preview all follow (`s` smaller, `m` as it always was, `l` and `xl` larger; never beyond the window). */
  commandBarSize: CommandBarSize
  /** The shape of that card at that size: `balanced` as it always was, `wide` (wider, a shorter list) or `tall` (a little narrower, a longer list). */
  commandBarShape: CommandBarShape
  /** ⌘⇧A: the command bar in "Onglets" mode, over the tabs of every space, with filters and the closing of duplicates. */
  tabSearch: boolean
  /** ⌘/: the sheet that lists the shortcuts by context, with a search and the ones the user changed marked. */
  shortcutHelp: boolean
  /** The find bar gets a ".*" button that reads the text as a regular expression. Off by default. */
  findRegex: boolean
  /** ⌥⌘-clic on a link opens it in a mini window (Settings › Navigation › Plus de réglages; shared/little-modifier.ts). Off by default. */
  littleArcModifier: boolean
  /**
   * A plain click on a link that would open a new tab on another site (`target="_blank"`) opens it in a mini window instead
   * (shared/little-modifier.ts `newTabLinkOpensLittle`). On by default; off brings back the tab, with ⌥⌘-clic (`littleArcModifier`) for a mini window.
   */
  littleArcNewTabLinks: boolean
  /** A finished download of a mini window raises a bubble with its actions above the tray for a few seconds. Off by default. */
  littleDownloadBubble: boolean
  /** File › Nouvelle fenêtre invité: a window with a session in memory, no history, no extension and none of the other profiles' content. Off by default. */
  guestProfile: boolean
  // ---- Web hardware (shared/web-hardware.ts, main/engine/web-hardware.ts) ----
  /** WebHID, WebUSB and Web Serial: a site may ask, after a click, to use a device the user picks in a list that names the site. Off: every request is refused and nothing is installed. */
  webHardware: boolean
  // ---- Capture and automation: see shared/annotate.ts, shared/automation-url.ts ----
  /** A capture opens a sheet to draw on (line, arrow, rectangle, text, mosaic) before it is copied, saved or shared. Off by default: a capture is saved and copied at once, as before. */
  annotateCapture: boolean
  /**
   * ⌥⌘M starts and stops the annotation of the page from any application, as a system-wide shortcut (main/shell/page-annotate.ts). Off by
   * default: ⌥⌘M is then the shortcut of File › Annoter cette page, heard only while Lucium is in front, and no other
   * application loses it.
   */
  annotateGlobalShortcut: boolean
  /**
   * Where the command bar of the page annotation stands: against an edge of the window (the left one by default), or floating where it was dropped, its
   * coordinates counted from the corner of the window. The grip of the bar drags it and its menu « Position de la barre » sets it; it is remembered across
   * uses and restarts. Not a feature: the annotation is on whatever this says. Cleaned on load (shared/annotate-bar-position.ts).
   */
  annotateBar: BarPosition
  /**
   * The first-use hint of the annotation bar (« Astuce : glissez la poignée pour placer la barre où vous voulez ») was dismissed: it is shown the first time the bar
   * opens, once. A memory, not a function: it gates nothing.
   */
  annotateBarHintSeen: boolean
  /**
   * The marks of an annotated page fade out and are cleared after `annotateAutoClearSeconds` without activity on it (a mark drawn, a press on the
   * layer, a tool, a colour, an undo…), as « Page » clears them: ⌘Z brings them back. Off by default; the timer button of the annotation bar and the
   * Settings change it (shared/annotate-auto-clear.ts). The clock runs in the layer of each page, only while it has marks.
   */
  annotateAutoClear: boolean
  /** The delay of the automatic clearing, in seconds: one of 3, 5, 10, 20, 30 (cleaned on load). Kept while the clearing is off. */
  annotateAutoClearSeconds: number
  /**
   * The keys of one letter of the page annotation (a tool: P, H, R, D, O, A, L, K, Q; E clears the page, X clears every page) act while the annotation is in
   * draw mode. On by default, as they always did; off, the bar names none and the page keeps the letters (⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ and Escape stay, and every button).
   */
  annotateLetterKeys: boolean
  /** The system may hand the application `lucium://` (or `lucium://`) `open`, `new-tab` and `search` addresses (AppleScript, Shortcuts, Terminal). Off by default: any application or script could send them. */
  urlAutomation: boolean
  // ---- The library (shared/bookmarks.ts, live-folders.ts, web-apps.ts): each is off by default and costs nothing while off ----
  /** The bookmark library: a panel with search and tags, "Ajouter aux signets", import and export of a bookmarks file. The favourites and the pinned tabs are not touched. */
  bookmarkManager: boolean
  /** Live folders: a folder of the sidebar that fills itself with the latest items of a feed (RSS, Atom) or of a public GitHub repository. Reaches the network only for the folders the user made. */
  liveFolders: boolean
  /** "Ouvrir comme application": a site in a window of its own, without the sidebar, with the icon and the name of the site and the session of the space it came from. */
  webAppWindows: boolean
  /**
   * The window of document Picture-in-Picture (`documentPictureInPicture.requestWindow()`, the floating window of a call), which the engine does not
   * show by itself: the engine takes it over (main/engine/document-pip-windows.ts). Off by default.
   */
  documentPictureInPicture: boolean
  /** Quick notes: short texts kept on this Mac in notes.json (main/notes-store.ts), tied to a space or a page, never in a private window. On by default; off, the file is not read. */
  notes: boolean
  /** The toolbar's button « Toutes les notes », the one button of the notes there (a new note is made from the panel, File › Nouvelle note, ⌥⌘E): the panel on « Toutes », in one click (File › Notes, ⇧⌘E, opens it on the page's notes when it has some). An option of `notes` (no button while they are off, nor in a private window). On by default. */
  notesListButton: boolean
  /** The local model of the page summary: Ollama, at an address of this Mac only (shared/ollama.ts). */
  ollamaConfig: OllamaConfig
  /**
   * The page summary is offered at all: a switch of its own. Off by default, and even on, the menus offer it only once
   * Ollama is on at an address of this Mac (shared/ollama.ts `summaryAvailable`).
   */
  aiSummary: boolean
}

/** A page watched for changes: which page, how often, and what was seen last. */
export interface PageWatch {
  id: string
  /** The address, http or https. */
  url: string
  title: string
  /** The profile whose session loads the page (its logins carry over). */
  profileId: string
  /** CSS selector of the zone to watch; absent = the visible text of the whole page. */
  selector?: string
  /** Minutes between two looks, 5 or more. */
  minutes: number
  /** Fingerprint of the text seen at the last look. */
  hash?: string
  checkedAt?: number
  changedAt?: number
  /** What went wrong at the last look (the list says so); absent when it went well. */
  failure?: string
}

/** Materials of the window's background (a subset of Electron's `vibrancy` values that make sense behind a sidebar). */
export type WindowVibrancy = 'none' | 'sidebar' | 'under-window' | 'hud'
export const WINDOW_VIBRANCIES: readonly WindowVibrancy[] = ['none', 'sidebar', 'under-window', 'hud']
export const SIDEBAR_OPACITY_MIN = 40
export const SIDEBAR_OPACITY_DEFAULT = 100
export const WINDOW_BORDER_MAX = 20
/** The border around the page card: the page is inset 10 px from the window's edges. */
export const WINDOW_BORDER_DEFAULT = 10

/** The sizes of the command bar's card, from the smallest (`m` is the size the card always had) and the shapes it can take at a size (see `barBox`, shared/command-bar.ts). */
export type CommandBarSize = 's' | 'm' | 'l' | 'xl'
export const COMMAND_BAR_SIZES: readonly CommandBarSize[] = ['s', 'm', 'l', 'xl']
export type CommandBarShape = 'balanced' | 'wide' | 'tall'
export const COMMAND_BAR_SHAPES: readonly CommandBarShape[] = ['balanced', 'wide', 'tall']
/** What a profile that never chose gets, and what a damaged value gives back: the card the bar always had. */
export const COMMAND_BAR_SIZE_DEFAULT: CommandBarSize = 'm'
export const COMMAND_BAR_SHAPE_DEFAULT: CommandBarShape = 'balanced'

/** Sites remembered as already offered their search; the oldest are forgotten first. */
export const SEARCH_DISCOVERY_SEEN_MAX = 200
