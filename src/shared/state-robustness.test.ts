// A saved state can come from an older build, be edited by hand or be damaged: loading it must never throw, never lose what is
// valid, and never keep what is not. These tests feed `normalize` / `parseSavedState` (the whole path of `loadState`) with old
// files, wrong types in every setting, inconsistent structures, hostile keys, and check the result against the model's invariants.

import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { cleanBlockExceptions, normalizeBlockHost } from './blocker'
import { keepHostOf } from './cookies'
import { DOH_PROVIDERS, parseDohTemplate } from './dns'
import { cleanProxySetting } from './proxy'
import { isProfileId } from './profiles'
import { BACKUP_KEEP_CHOICES, BACKUP_MINUTES_CHOICES } from './backup-settings'
import { AUTO_CLEAR_SECONDS } from './annotate-auto-clear'
import { BOOST_FONTS } from './boost'
import { SITE_READABLE_MAX } from './readable-mode'
import { FOLDER_MAX_DEPTH, folderDepth } from './folders'
import { APP_ICONS, isAppIconId } from './icons'
import { containerRuleHost, isContainerColor, isContainerId } from './containers'
import { isWindowKey } from './window-tabs'
import { COMMANDS, isValidAccelerator } from './keybindings'
import { OPEN_WITH_MAX, isApplicationPath, isRememberableType } from './open-with'
import {
  COMMAND_BAR_SHAPES,
  COMMAND_BAR_SIZES,
  SIDEBAR_OPACITY_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN,
  SEARCH_DISCOVERY_SEEN_MAX,
  STATE_REVISION,
  STATE_VERSION,
  WINDOW_BORDER_MAX,
  WINDOW_VIBRANCIES,
  defaultSettings,
  type ArchivedTab,
  type AsideSpace,
  type ReadLaterItem,
  type Boost,
  type Favorite,
  type Folder,
  type Settings,
  type SidebarState,
  type Space,
  type SplitView,
  type WorkView,
  type TabItem
} from './model'
import { SITE_DATA_RECENTS_MAX, SITE_DATA_TYPES, parseSiteHost } from './site-data'
import { SITE_DATA_ANIMATIONS } from './site-data-overlay'
import { NewerStateError, PROFILE_NAME_MAX, createInitialState, normalize, parseSavedState, reduce, restoredState } from './sidebar'
import { SPLIT_MAX_PANES } from './split'
import { NAME_MAX, TITLE_MAX, cleanHistory } from './state-clean'
import { PROTECTION_BASELINE_OF_EARLIER_PROFILES, PROTECTION_OF_EARLIER_PROFILES } from './model-defaults'
import { cleanTheme, defaultTheme, themeFromHue } from './theme'
import { zoomHostOf } from './site-zoom'
import { PANEL_PERCENT_MAX, PANEL_PERCENT_MIN, PANEL_SCREENS_MAX, screenKey } from './panel-scale'
import { isSpaceImageName } from './space-image'
import { cleanIconColor, cleanIconLetter, isSpaceIconKind } from './space-icon'
import { WEB_PANELS_MAX, WEB_PANEL_TITLE_MAX, webPanelUrl } from './web-panels'

// ---------- helpers ----------

const PROTECTION_KEYS = ['blockCookieBanners', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks'] as const
const asState = (value: unknown): SidebarState => value as SidebarState
const norm = (value: unknown): SidebarState => normalize(asState(value))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const REMOVE = Symbol('remove')

/** What a JSON file can hold of the hostile kind, as `JSON.parse` really builds it (`__proto__` becomes an own key there). */
const HOSTILE_OBJECT = (): unknown => JSON.parse('{"__proto__":{"polluted":"POLLUTED"},"constructor":{"prototype":{"polluted":"POLLUTED"}},"prototype":"POLLUTED","toString":"POLLUTED"}')

/** A state exercising every field of every part of the model, each with a value that is not the default. */
function rich(): SidebarState {
  const home: Required<Space> = {
    id: 'sp-home',
    name: 'Perso',
    emoji: '🏠',
    theme: defaultTheme(),
    profileId: 'default',
    hideHeader: true,
    image: '0123456789abcdef01234567.png',
    iconKind: 'letter',
    iconLetter: 'PE',
    iconColor: '#2f9e63',
    iconRound: true,
    webPanels: [{ id: 'wp-1', url: 'https://web.whatsapp.com/', title: 'WhatsApp' }, { id: 'wp-2', url: 'https://calendar.example/', title: 'Agenda' }],
    background: { type: 'color', value: '#2f9e63' }
  }
  const work: Required<Space> = { id: 'sp-work', name: 'Travail', emoji: '💼', theme: themeFromHue(200), profileId: 'work', hideHeader: false, image: 'fedcba9876543210fedcba98.png', iconKind: 'image', iconLetter: 'T', iconColor: '#4b6bd6', iconRound: false, webPanels: [{ id: 'wp-3', url: 'https://chat.example/room', title: 'Discussion' }], background: { type: 'image', value: 'space-work.webp' } }
  const tab = (id: string, spaceId: string, over: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: `Titre ${id}`, pinned: false, createdAt: 10, lastActiveAt: 20, ...over })
  // A private tab is the one tab that is never in a file: private-tab.test.ts covers it.
  const full: Required<Omit<TabItem, 'private' | 'openerId' | 'parentId' | 'treeCollapsed' | 'favoriteId' | 'windowKey'>> = {
    id: 't-full',
    spaceId: home.id,
    url: 'https://full.example/page',
    title: 'Complet',
    faviconUrl: 'https://full.example/favicon.ico',
    customTitle: 'Mon nom',
    icon: '🚀',
    image: '0123456789abcdef01234567.png',
    pinned: true,
    anchorUrl: 'https://full.example/',
    keepAwake: true,
    deadKept: { url: 'https://full.example/page', at: 30 },
    autoReload: { seconds: 45 },
    folderId: 'f-sub',
    container: 'travail-3fa9c',
    createdAt: 1,
    lastActiveAt: 2
  }
  // A root folder under the Today tabs (and, below, one at the start of Today); the folder inside it has no side (only a root folder has one), so the full fixture
  // leaves `atBottom` and `atTodayStart` out.
  const root: Folder = { id: 'f-root', spaceId: home.id, name: 'Racine', collapsed: true, atBottom: true, noWake: true }
  const sub: Required<Omit<Folder, 'atBottom' | 'atTodayStart' | 'noWake'>> = {
    id: 'f-sub',
    spaceId: home.id,
    name: 'Dedans',
    collapsed: false,
    parentId: 'f-root',
    icon: '📚',
    live: { source: { kind: 'github', repo: 'owner/repo', what: 'releases' }, items: [{ title: 'v1.0', url: 'https://github.com/owner/repo/releases/tag/v1.0', at: 5 }], checkedAt: 9, failure: 'HTTP 500' }
  }
  const favorite: Required<Favorite> = { id: 'fav-1', url: 'https://fav.example/', title: 'Favori', faviconUrl: 'https://fav.example/i.png', profileId: 'default' }
  const archived: Required<ArchivedTab> = {
    id: 'ar-1',
    spaceId: home.id,
    url: 'https://old.example/',
    title: 'Ancien',
    archivedAt: 5,
    source: 'manual',
    history: { entries: [{ url: 'https://old.example/avant', title: 'Avant' }, { url: 'https://old.example/', title: 'Ancien' }], index: 1 },
    container: 'perso-aa111',
    pinned: true,
    anchorUrl: 'https://old.example/accueil',
    folderId: 'f-root'
  }
  const later: Required<ReadLaterItem> = { id: 'rl-1', url: 'https://lire.example/article', title: 'À lire', faviconUrl: 'data:image/png;base64,iVBORw0KGgo=', savedAt: 6, folderId: 'rlf-1' }
  const split: SplitView = { id: 'sv-1', spaceId: home.id, tabIds: ['t-a', 't-b'], orientation: 'vertical', ratios: [0.4, 0.6], viewId: 'wv-1' }
  // Two work views: one of the home profile, always opened in its space, whose split view is open there; one of the work profile, opened in a window.
  const morning: Required<WorkView> = {
    id: 'wv-1',
    name: 'Matin',
    emoji: '☀️',
    profileId: 'default',
    panes: [{ url: 'https://mail.example/', title: 'Mail', faviconUrl: 'https://mail.example/i.png' }, { url: 'https://agenda.example/', title: 'Agenda' }, { url: 'file:///Users/moi/notes.html', title: 'Notes' }],
    orientation: 'horizontal',
    ratios: [0.5, 0.25, 0.25],
    grid: { column: 0.55, row: 0.6, span: 'bottom' },
    target: { kind: 'space', spaceId: home.id }
  }
  const client: WorkView = { id: 'wv-2', name: 'Client', emoji: '🪚', profileId: 'work', panes: [{ url: 'https://client.example/', title: 'Client' }, { url: 'https://admin.client.example/', title: 'Admin' }], orientation: 'vertical', ratios: [0.3, 0.7], target: { kind: 'window' } }
  const boost: Required<Boost> = {
    id: 'bo-1',
    name: 'Mon boost',
    host: 'example.com',
    enabled: false,
    css: 'a { color: red }',
    js: 'void 0',
    jsEnabled: false,
    jsDraft: 'void 1',
    zoom: 1.5,
    zap: ['.pub'],
    tint: { hue: 10, saturation: 1.2, brightness: 0.9, contrast: 1.1 },
    fontFamily: BOOST_FONTS[3]!.id,
    textCase: 'upper',
    invert: true
  }
  const asideSpace: Required<Space> = { id: 'sp-veille', name: 'Veille', emoji: '📰', theme: themeFromHue(120), profileId: 'work', hideHeader: true, image: 'aaaaaaaaaaaaaaaaaaaaaaaa.png', iconKind: 'emoji', iconLetter: 'V', iconColor: '#8a5bd1', iconRound: true, webPanels: [{ id: 'wp-4', url: 'https://feeds.example/', title: 'Flux' }], background: { type: 'video', value: 'veille.mp4', muted: true, loop: true } }
  const asideTab = (id: string, over: Partial<TabItem> = {}): TabItem => tab(id, asideSpace.id, over)
  const aside: AsideSpace = {
    space: asideSpace,
    index: 1,
    folders: [{ id: 'af-1', spaceId: asideSpace.id, name: 'Sources', collapsed: true }],
    tabs: [asideTab('at-1', { pinned: true, folderId: 'af-1', anchorUrl: 'https://at-1.example/', customTitle: 'Nom', icon: '📰', keepAwake: true }), asideTab('at-2'), asideTab('at-3', { autoReload: { seconds: 30 } })],
    splits: [{ id: 'asv-1', spaceId: asideSpace.id, tabIds: ['at-2', 'at-3'], orientation: 'horizontal', ratios: [0.5, 0.5] }],
    selected: 'at-2',
    archive: [{ id: 'aar-1', spaceId: asideSpace.id, url: 'https://vieux.example/', title: 'Vieux', archivedAt: 3 }]
  }
  const base = createInitialState({ now: 1, newId: () => 'unused' })
  const settings: Settings = {
    ...defaultSettings(),
    searchUrlTemplate: 'https://www.google.com/search?q=%s',
    siteSearches: [{ keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' }],
    linkRoutes: [{ host: 'github.com', spaceId: work.id }],
    sidebarVisible: false,
    sidebarWidth: 300,
    sidePanelWidth: 500,
    interfaceAppearance: 'light',
    websiteAppearance: 'dark',
    peekWithShift: false,
    littleArcArchiveHours: 3,
    littleArcModifier: true,
    littleArcNewTabLinks: false,
    littleDownloadBubble: true,
    guestProfile: true,
    fullUrlInToolbar: true,
    showReloadAllButton: true,
    reloadAllWakes: true,
    dragWindowFromToolbar: false,
    suggestionsNoticeSeen: true,
    welcomeDone: false,
    firstLaunchDone: false,
    arcGuideSeen: true,
    annotateBarHintSeen: true,
    whatsNewSheet: false,
    lastSeenVersion: '0.0.9',
    forceHighContrast: true,
    forceReduceMotion: true,
    forceReduceTransparency: true,
    hoverCards: false,
    allowScreenShare: false,
    showTabMemory: true,
    tabStateBadges: false,
    downloadStatusChip: false,
    favoriteNames: true,
    resourceGauge: false,
    showToolbar: false,
    sidebarRight: true,
    spaceImages: true,
    webPanels: true,
    appIcon: APP_ICONS[1]!.id,
    warnBeforeQuitting: false,
    autoUpdate: false,
    chromeNativeHosts: true,
    littleArcShortcut: false,
    boostsEnabled: false,
    boostScriptImport: 'never',
    boostSharing: false,
    tidyPinnedTitles: true,
    tidyFoldersPosition: 'bottom',
    tidyDownloads: true,
    blockAds: true,
    blockCookieBanners: true,
    blockCosmetic: false,
    disabledFilterLists: ['easylist'],
    filterUpdateDays: 7,
    blockExceptions: ['exemple.org'],
    blockMode: 'strict',
    blockScriptlets: true,
    reduceFingerprint: true,
    fingerprintStrict: true,
    fingerprintExceptions: ['exemple.org'],
    blockThirdPartyCookies: true,
    thirdPartyCookieExceptions: ['exemple.org'],
    unwrapRedirects: true,
    unwrapExceptions: ['exemple.org'],
    safeBrowsing: true,
    safeBrowsingExceptions: ['exemple.org'],
    profileNames: { work: 'Travail' },
    allowThemeToSites: true,
    keyBindings: { [COMMANDS[0]!.id]: '' },
    externalLinksInLittleArc: false,
    searchSuggestions: false,
    peekOnExternalLinks: true,
    autoPictureInPicture: false,
    sitePictureInPictureInLucium: false,
    mediaPlayer: false,
    autoArchiveHours: 5,
    historyKeepDays: 90,
    profiles: { work: { searchUrlTemplate: 'https://s.example/?q=%s', searchSuggestions: false, autoArchiveHours: 2, downloadDir: '/tmp/telechargements', disabledExtensions: ['a'.repeat(32), 'p'.repeat(32)] } },
    sleepAfterMinutes: 15,
    sleepAwakeMax: 20,
    sleepFreezeAfterMinutes: 2,
    sleepMode: 'freeze',
    sleepExcludedHosts: ['mail.example.org'],
    sleepExcludedKeepAll: true,
    focusMode: true,
    focusSites: ['news.example.com'],
    focusScheduleOn: true,
    focusDays: [1, 3],
    focusFrom: 600,
    focusTo: 700,
    focusMinutes: 45,
    focusUntil: 1_800_000_000_000,
    focusSnoozeUntil: 1_800_000_000_001,
    sleepSkipAudible: false,
    sleepSkipPinned: true,
    sleepNotify: true,
    loadAllTabsAtLaunch: true,
    extensionPaths: ['/Users/moi/extensions/une'],
    webStoreInstall: false,
    webStoreUpdates: 'weekly',
    siteDataTypes: ['cookies', 'history'],
    siteDataSubdomains: true,
    siteDataReload: false,
    siteDataHttp: true,
    siteDataConfirm: true,
    siteDataAutoClose: false,
    siteDataNotify: false,
    siteDataAnimation: 'matrix',
    siteDataRecents: ['example.org', 'localhost:3000', '192.168.1.20:8080'],
    developerHosts: ['dev.example.org'],
    restoreWindows: false,
    usedProfiles: ['work'],
    suggestHistory: false,
    suggestTabs: false,
    suggestArchive: false,
    suggestReadLater: false,
    goToOpenTab: true,
    searchBangs: false,
    searchDiscovery: true,
    searchDiscoverySeen: ['example.org', 'search.example.net'],
    commandBarCalc: false,
    commandBarSize: 'xl',
    commandBarShape: 'wide',
    tabSearch: false,
    tabGrid: true,
    shortcutHelp: false,
    findRegex: true,
    compactMode: true,
    tabTree: true,
    webHardware: true,
    annotateCapture: true,
    urlAutomation: true,
    tabReminders: false,
    bookmarkManager: true,
    liveFolders: true,
    webAppWindows: true,
    documentPictureInPicture: true,
    notes: false,
    notesListButton: false,
    updateFeedUrl: 'https://updates.example.org/latest',
    updateChannel: 'test',
    updateNotices: { version: '0.2.2', shown: 2 },
    httpsUpgrade: true,
    sendGpc: true,
    stripTrackingParams: true,
    stripCopiedLinks: true,
    protectionBaseline: 'standard',
    historyOff: true,
    dohCustom: true,
    dohMode: 'secure',
    dohProvider: 'quad9',
    dohCustomUrl: 'https://dns.example.org/dns-query',
    proxyEnabled: true,
    proxy: { mode: 'manual', address: 'socks5://127.0.0.1:1080', bypass: '*.example.org' },
    cookieManager: false,
    cookieKeepHosts: ['example.org'],
    privateTabs: false,
    tabContainers: true,
    containers: [
      { id: 'travail-3fa9c', name: 'Travail', color: 'orange', permissions: { 'https://meet.example': { media: 'allow', geolocation: 'deny' } } },
      { id: 'perso-aa111', name: 'Perso', color: 'purple' }
    ],
    containerRules: [{ host: 'intranet.example.org', containerId: 'travail-3fa9c' }],
    independentWindows: true,
    resolveFavicons: false,
    siteZoom: { 'example.com': 1.25 },
    autoplayPolicy: 'allow',
    spellCheck: 'off',
    siteAutoplay: { 'example.com': 'block', 'music.example.org': 'allow' },
    autoplayPerSite: false,
    siteDataClearOnCloseEnabled: true,
    siteDataClearOnClose: ['example.org', 'localhost:3000'],
    siteDataClearOnQuit: true,
    customFilterListsEnabled: false,
    customFilterLists: [{ id: 'custom-0123abcd', title: 'Mes règles', source: 'paste', sourceName: 'Règles collées', enabled: false, addedAt: 5 }],
    autoBackup: false,
    autoBackupKeep: 10,
    autoBackupMinutes: 60,
    lockEnabled: true,
    lockApp: true,
    lockedSpaces: ['sp-work'],
    lockTouchId: false,
    reopenHistory: true,
    interfaceTranslated: true,
    language: 'en',
    translateLocal: true,
    translateSystemEngine: false,
    translateTarget: 'de',
    translateModelsDir: '/Users/moi/Modeles de traduction',
    translateAlways: ['en', 'de'],
    translateNeverSites: ['news.example.org'],
    translateSystemNoticeSeen: true,
    extensionOverflow: false,
    unpinnedExtensions: ['abcdefghijklmnopabcdefghijklmnop'],
    extensionDataApis: false,
    extensionTabCapture: false,
    userScripts: true,
    vimKeys: true,
    vimKeysExcludedHosts: ['mail.example.org'],
    tabGroupFolders: true,
    omniboxKeywords: true,
    passwordManager: true,
    qrCode: true,
    autoScroll: true,
    scrollSync: true,
    rememberScroll: true,
    mouseGestures: true,
    mouseGestureExcludedHosts: ['maps.example.org'],
    pageContentIndex: true,
    pageWatch: true,
    pageWatches: [{ id: 'w-1', url: 'https://example.org/prix', title: 'Prix', profileId: 'work', selector: '#price', minutes: 30, hash: '0123456789abcdef', checkedAt: 5, changedAt: 4, failure: 'La page n’a pas répondu.' }],
    readAloud: true,
    batterySaver: true,
    downloadPause: true,
    downloadResume: true,
    downloadAskWhere: true,
    openWithMemory: true,
    openWithApps: { pdf: '/Applications/Preview.app' },
    openUnsaved: true,
    pdfWithSource: true,
    useReadLaterFolders: true,
    readableMode: 'auto',
    siteReadableMode: { 'banque.example': 'original', 'nuit.example': 'light' },
    readableToolbarButton: false,
    windowVibrancy: 'sidebar',
    sidebarOpacity: 70,
    windowBorder: 4,
    cardOutline: true,
    backClosesOpenedTab: false,
    tabCycleRecent: false,
    spaceSwipe: false,
    dragToSplit: false,
    warnBeforeClosingWindow: true,
    modifiedClickBackground: false,
    blankLinkBackground: true,
    showZoomIndicator: false,
    nameWindows: false,
    uiScale: 125,
    minimumFontSize: 14
  }
  return {
    ...base,
    spaces: [home, work],
    // t-d is a folded branch with a child, in the order of the tree.
    tabs: [full, tab('t-fav', home.id, { favoriteId: 'fav-1' }), tab('t-a', home.id, { openerId: 't-full' }), tab('t-d', home.id, { treeCollapsed: true }), tab('t-e', home.id, { parentId: 't-d' }), tab('t-b', home.id, { pinned: true }), tab('t-c', work.id)],
    folders: [root, sub, { id: 'f-work', spaceId: work.id, name: 'Dossier travail', collapsed: false, atTodayStart: true }],
    favorites: [favorite],
    archive: [archived],
    readLater: [later],
    readLaterFolders: [{ id: 'rlf-1', name: 'À classer', collapsed: true }],
    tabReminders: [{ id: 'tr-1', url: 'https://rappel.example/page', title: 'À relire', spaceId: work.id, dueAt: 9_000_000, createdAt: 3 }],
    bookmarks: [{ id: 'bm-1', url: 'https://marque.example/page', title: 'Une page', tags: ['lecture', 'à voir'], note: 'Une note', faviconUrl: 'https://marque.example/i.png', addedAt: 4 }],
    activeSpaceId: work.id,
    activeTabBySpace: { [home.id]: 't-a', [work.id]: 't-c' },
    sitePermissions: { 'https://cam.example': { camera: 'allow', microphone: 'deny' } },
    sidePanelBehavior: { abcdefghijklmnopabcdefghijklmnop: true },
    commandBarUsage: { default: { 'https://a.example/': 3 } },
    splits: [split],
    boosts: [boost],
    workViews: [morning, client],
    sessions: [
      { id: 'se-1', name: 'Projet X', createdAt: 7, tabs: [{ url: 'https://s.example/a', title: 'A' }, { url: 'https://s.example/b', title: 'B', pinned: true, folder: 'Docs' }] },
      { id: 'se-2', name: 'Veille', createdAt: 8, tabs: [{ url: 'https://v.example/a', title: 'A' }], space: aside },
      // A space with nothing in it, put aside for its theme and settings.
      { id: 'se-3', name: 'Vide', createdAt: 9, tabs: [], space: { space: { id: 'sp-vide', name: 'Vide', emoji: '⬜', theme: themeFromHue(30), profileId: 'default' }, index: 0, folders: [], tabs: [], splits: [], selected: null, archive: [] } }
    ],
    settings
  }
}

// ---------- the invariants of a loaded state ----------

const bool = (v: unknown): boolean => typeof v === 'boolean'
const num = (min = -Infinity, max = Infinity) => (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown): v is string => typeof v === 'string' && !/\p{Cc}/u.test(v)
const unique = (list: readonly unknown[]): boolean => new Set(list).size === list.length
const hostList = (max: number) => (v: unknown): boolean => Array.isArray(v) && v.length <= max && unique(v) && v.every((h) => typeof h === 'string' && normalizeBlockHost(h) === h)
const template = (v: unknown): boolean => text(v) && v.length <= 2048 && /^https?:\/\/\S+$/.test(v) && v.includes('%s')
const PROFILE = /^(?!__proto__$)[A-Za-z0-9_-]{1,32}$/
const keysOf = (v: unknown): string[] => (isRecord(v) ? Object.keys(v) : [])
/** A value for a message, whatever it is (a hostile object can have a `toString` that is not a function). */
const show = (v: unknown): string => {
  try {
    return (JSON.stringify(v) ?? String(v)).slice(0, 60)
  } catch {
    return typeof v
  }
}

/** What each setting must be after loading. Typed on `Settings` so a new setting cannot be added without saying what it may hold. */
const VALID: { [K in keyof Settings]: (value: unknown) => boolean } = {
  searchUrlTemplate: template,
  siteSearches: (v) =>
    Array.isArray(v) && v.length <= 50 && unique(v.map((s) => (isRecord(s) ? s['keyword'] : s))) &&
    v.every((s) => isRecord(s) && keysOf(s).sort().join() === 'keyword,name,url' && typeof s['keyword'] === 'string' && /^[^\s\p{Cc}]{1,30}$/u.test(s['keyword']) && text(s['name']) && s['name'].trim() !== '' && s['name'].length <= 60 && template(s['url'])),
  linkRoutes: (v) => Array.isArray(v) && v.length <= 200 && v.every((r) => isRecord(r) && keysOf(r).sort().join() === 'host,spaceId' && typeof r['host'] === 'string' && /^\S{1,253}$/u.test(r['host']) && text(r['host']) && typeof r['spaceId'] === 'string' && r['spaceId'] !== ''),
  sidebarVisible: bool,
  sidebarWidth: num(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
  sidePanelWidth: num(SIDE_PANEL_WIDTH_MIN, SIDE_PANEL_WIDTH_MAX),
  interfaceAppearance: (v) => v === 'auto' || v === 'light' || v === 'dark',
  websiteAppearance: (v) => v === 'auto' || v === 'light' || v === 'dark',
  peekWithShift: bool,
  littleArcArchiveHours: num(0),
  littleArcModifier: bool,
  littleArcNewTabLinks: bool,
  littleDownloadBubble: bool,
  guestProfile: bool,
  fullUrlInToolbar: bool,
  showReloadAllButton: bool,
  reloadAllWakes: bool,
  interfaceTranslated: bool,
  language: (v) => v === 'auto' || v === 'fr' || v === 'en',
  translateLocal: bool,
  translateSystemEngine: bool,
  translateTarget: (v) => v === 'auto' || (typeof v === 'string' && /^[a-z]{2,3}$/.test(v)),
  translateModelsDir: (v) => v === '' || (text(v) && v.length <= 1024 && /^(\/|[A-Za-z]:[\\/])/.test(v)),
  translateAlways: (v) => Array.isArray(v) && v.length <= 64 && unique(v) && v.every((code) => typeof code === 'string' && /^[a-z]{2,3}$/.test(code)),
  translateNeverSites: hostList(200),
  translateSystemNoticeSeen: bool,
  sidebarRight: bool,
  spaceImages: bool,
  webPanels: bool,
  dragWindowFromToolbar: bool,
  suggestionsNoticeSeen: bool,
  welcomeDone: bool,
  firstLaunchDone: bool,
  arcGuideSeen: bool,
  annotateBarHintSeen: bool,
  whatsNewSheet: bool,
  lastSeenVersion: (v) => v === '' || (text(v) && v.length <= 64 && /^[0-9A-Za-z]/.test(v)),
  forceHighContrast: bool,
  forceReduceMotion: bool,
  forceReduceTransparency: bool,
  hoverCards: bool,
  allowScreenShare: bool,
  showTabMemory: bool,
  tabStateBadges: bool,
  downloadStatusChip: bool,
  favoriteNames: bool,
  resourceGauge: bool,
  showToolbar: bool,
  appIcon: isAppIconId,
  warnBeforeQuitting: bool,
  autoUpdate: bool,
  chromeNativeHosts: bool,
  littleArcShortcut: bool,
  boostsEnabled: bool,
  boostScriptImport: (v) => v === 'ask' || v === 'never',
  boostSharing: bool,
  tidyPinnedTitles: bool,
  tidyFoldersPosition: (v) => v === 'top' || v === 'bottom',
  tidyDownloads: bool,
  blockAds: bool,
  blockTrackers: bool,
  blockCookieBanners: bool,
  blockCosmetic: bool,
  disabledFilterLists: (v) => Array.isArray(v) && v.length <= 50 && unique(v) && v.every((id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)),
  filterUpdateDays: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 90,
  blockExceptions: hostList(200),
  popupExceptions: hostList(200),
  aiSummary: (v) => typeof v === 'boolean',
  blockMode: (v) => v === 'standard' || v === 'strict',
  blockModeSites: (v) => isRecord(v) && Object.getPrototypeOf(v) === Object.prototype && keysOf(v).length <= 200 && Object.entries(v).every(([host, mode]) => normalizeBlockHost(host) === host && (mode === 'standard' || mode === 'strict')),
  blockScriptlets: bool,
  reduceFingerprint: bool,
  fingerprintStrict: bool,
  fingerprintExceptions: hostList(200),
  blockThirdPartyCookies: bool,
  thirdPartyCookieExceptions: hostList(200),
  unwrapRedirects: bool,
  unwrapExceptions: hostList(200),
  safeBrowsing: bool,
  safeBrowsingExceptions: hostList(200),
  profileNames: (v) => isRecord(v) && Object.entries(v).every(([id, name]) => PROFILE.test(id) && typeof name === 'string' && name === name.trim() && name !== '' && name.length <= 40),
  allowThemeToSites: bool,
  keyBindings: (v) => isRecord(v) && Object.entries(v).every(([id, key]) => COMMANDS.some((c) => c.id === id) && typeof key === 'string' && (key === '' || isValidAccelerator(key))),
  externalLinksInLittleArc: bool,
  searchSuggestions: bool,
  peekOnExternalLinks: bool,
  autoPictureInPicture: bool,
  sitePictureInPictureInLucium: bool,
  mediaPlayer: bool,
  autoArchiveHours: num(0),
  historyKeepDays: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650,
  profiles: (v) =>
    isRecord(v) &&
    Object.getPrototypeOf(v) === Object.prototype &&
    Object.entries(v).every(
      ([id, own]) =>
        PROFILE.test(id) &&
        isRecord(own) &&
        keysOf(own).length > 0 &&
        Object.entries(own).every(([key, value]) =>
          key === 'searchUrlTemplate' ? template(value) : key === 'searchSuggestions' ? bool(value) : key === 'autoArchiveHours' ? num(0)(value) : key === 'downloadDir' ? text(value) && value.startsWith('/') : key === 'disabledExtensions' ? Array.isArray(value) && value.length > 0 && value.length <= 200 && unique(value) && value.every((id) => typeof id === 'string' && /^[a-p]{32}$/.test(id)) : key === 'historyOff' ? bool(value) : key === 'proxy' ? isRecord(value) && JSON.stringify(cleanProxySetting(value)) === JSON.stringify(value) : false
        )
    ),
  sleepAfterMinutes: num(0),
  sleepAwakeMax: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 500,
  sleepFreezeAfterMinutes: num(0),
  sleepMode: (v) => v === 'discard' || v === 'freeze',
  sleepExcludedHosts: hostList(200),
  sleepExcludedKeepAll: bool,
  focusMode: bool,
  focusSites: hostList(200),
  focusScheduleOn: bool,
  focusDays: (v) => Array.isArray(v) && unique(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  focusFrom: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440,
  focusTo: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440,
  focusMinutes: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1440,
  focusUntil: num(0),
  focusSnoozeUntil: num(0),
  sleepSkipAudible: bool,
  sleepSkipPinned: bool,
  sleepNotify: bool,
  loadAllTabsAtLaunch: bool,
  extensionPaths: (v) => Array.isArray(v) && v.length <= 100 && unique(v) && v.every((p) => text(p) && p.length <= 1024 && /^(\/|[A-Za-z]:[\\/])/.test(p)),
  webStoreInstall: bool,
  webStoreUpdates: (v) => v === 'manual' || v === 'daily' || v === 'weekly',
  siteDataTypes: (v) => Array.isArray(v) && v.length > 0 && unique(v) && v.every((t) => (SITE_DATA_TYPES as readonly unknown[]).includes(t)),
  siteDataSubdomains: bool,
  siteDataReload: bool,
  siteDataHttp: bool,
  siteDataConfirm: bool,
  siteDataAutoClose: bool,
  siteDataNotify: bool,
  siteDataAnimation: (v) => (SITE_DATA_ANIMATIONS as readonly unknown[]).includes(v),
  siteDataRecents: (v) => Array.isArray(v) && v.length <= SITE_DATA_RECENTS_MAX && unique(v) && v.every((host) => typeof host === 'string' && parseSiteHost(host)?.host === host),
  developerHosts: hostList(100),
  restoreWindows: bool,
  usedProfiles: (v) => Array.isArray(v) && v.length <= 100 && unique(v) && v.every((id) => typeof id === 'string' && id !== 'default' && PROFILE.test(id)),
  retiredProfileIds: (v) => Array.isArray(v) && v.length <= 256 && unique(v) && v.every((id) => typeof id === 'string' && id !== 'default' && PROFILE.test(id)),
  updateFeedUrl: (v) => v === '' || (text(v) && v.length <= 500 && /^https:\/\/\S+$/i.test(v)),
  updateChannel: (v) => v === 'stable' || v === 'test',
  updateNotices: (v) => {
    if (typeof v !== 'object' || v === null || Object.keys(v).sort().join() !== 'shown,version') return false
    const { version, shown } = v as { version: unknown; shown: unknown }
    return typeof version === 'string' && (version === '' || /^\d+(?:\.\d+){0,3}$/.test(version)) && Number.isSafeInteger(shown) && (shown as number) >= 0 && (shown as number) <= 99
  },
  httpsUpgrade: bool,
  sendGpc: bool,
  stripTrackingParams: bool,
  stripCopiedLinks: bool,
  protectionBaseline: (v) => v === 'standard' || v === 'renforcee',
  historyOff: bool,
  dohCustom: bool,
  dohMode: (v) => v === 'automatic' || v === 'secure' || v === 'off',
  dohProvider: (v) => v === 'system' || v === 'custom' || DOH_PROVIDERS.some((p) => p.id === v),
  dohCustomUrl: (v) => v === '' || parseDohTemplate(v) === v,
  proxyEnabled: bool,
  proxy: (v) => isRecord(v) && keysOf(v).sort().join() === 'address,bypass,mode' && JSON.stringify(cleanProxySetting(v)) === JSON.stringify(v),
  cookieManager: bool,
  cookieKeepHosts: (v) => Array.isArray(v) && v.length <= 200 && unique(v) && v.every((host) => typeof host === 'string' && keepHostOf(host) === host),
  privateTabs: bool,
  tabContainers: bool,
  containers: (v) =>
    Array.isArray(v) && v.length <= 24 && unique(v.map((c) => (isRecord(c) ? c['id'] : c))) && unique(v.map((c) => (isRecord(c) ? String(c['name']).toLowerCase() : c))) &&
    v.every(
      (c) =>
        isRecord(c) && keysOf(c).every((k) => ['id', 'name', 'color', 'permissions'].includes(k)) && isContainerId(c['id']) && text(c['name']) && c['name'].trim() === c['name'] && c['name'] !== '' && c['name'].length <= 30 &&
        isContainerColor(c['color']) && (c['permissions'] === undefined || (isRecord(c['permissions']) && Object.keys(c['permissions']).length > 0 && Object.entries(c['permissions']).every(([origin, perms]) => /^https?:\/\/[^/\s]+$/.test(origin) && isRecord(perms) && Object.keys(perms).length > 0 && Object.values(perms).every((d) => d === 'allow' || d === 'deny'))))
    ),
  containerRules: (v) =>
    Array.isArray(v) && v.length <= 200 && unique(v.map((r) => (isRecord(r) ? r['host'] : r))) &&
    v.every((r) => isRecord(r) && keysOf(r).sort().join() === 'containerId,host' && containerRuleHost(r['host']) === r['host'] && isContainerId(r['containerId'])),
  independentWindows: bool,
  resolveFavicons: bool,
  siteZoom: (v) => isRecord(v) && Object.getPrototypeOf(v) === Object.prototype && Object.entries(v).every(([host, factor]) => zoomHostOf(`https://${host}/`) === host && num(0.25, 5)(factor) && factor !== 1),
  autoplayPolicy: (v) => v === 'block' || v === 'allow',
  spellCheck: (v) => v === 'auto' || v === 'on' || v === 'off',
  siteAutoplay: (v) => isRecord(v) && Object.getPrototypeOf(v) === Object.prototype && keysOf(v).length <= 500 && Object.entries(v).every(([host, mode]) => zoomHostOf(`https://${host}/`) === host && (mode === 'block' || mode === 'allow')),
  autoplayPerSite: bool,
  siteDataClearOnCloseEnabled: bool,
  customFilterListsEnabled: bool,
  siteJavascriptOff: (v) => Array.isArray(v) && v.length <= 500 && unique(v) && v.every((host) => typeof host === 'string' && parseSiteHost(host)?.host === host),
  siteDataClearOnClose: (v) => Array.isArray(v) && v.length <= 100 && unique(v) && v.every((host) => typeof host === 'string' && parseSiteHost(host)?.host === host),
  siteDataClearOnQuit: bool,
  customFilterLists: (v) =>
    Array.isArray(v) && v.length <= 20 && unique(v.map((l) => (isRecord(l) ? l['id'] : l))) &&
    v.every((l) => isRecord(l) && keysOf(l).sort().join() === 'addedAt,enabled,id,source,sourceName,title' && typeof l['id'] === 'string' && /^custom-[0-9a-f]{8}$/.test(l['id']) && text(l['title']) && l['title'].trim() !== '' && l['title'].length <= 80 && text(l['sourceName']) && l['sourceName'].trim() !== '' && (l['source'] === 'file' || l['source'] === 'paste') && bool(l['enabled']) && num(0)(l['addedAt'])),
  autoBackup: bool,
  autoBackupKeep: (v) => (BACKUP_KEEP_CHOICES as readonly unknown[]).includes(v),
  autoBackupMinutes: (v) => (BACKUP_MINUTES_CHOICES as readonly unknown[]).includes(v),
  lockEnabled: bool,
  lockApp: bool,
  lockedSpaces: (v) => Array.isArray(v) && v.length <= 200 && unique(v) && v.every((id) => typeof id === 'string' && id !== '' && id !== '__proto__'),
  lockTouchId: bool,
  reopenHistory: bool,
  extensionOverflow: bool,
  unpinnedExtensions: (v) => Array.isArray(v) && v.length <= 200 && unique(v) && v.every((id) => typeof id === 'string' && /^[a-p]{32}$/.test(id)),
  extensionDataApis: bool,
  extensionTabCapture: bool,
  userScripts: bool,
  vimKeys: bool,
  vimKeysExcludedHosts: hostList(200),
  tabGroupFolders: bool,
  omniboxKeywords: bool,
  passwordManager: bool,
  qrCode: bool,
  autoScroll: bool,
  scrollSync: bool,
  rememberScroll: bool,
  workViewsEnabled: bool,
  mouseGestures: bool,
  mouseGestureExcludedHosts: hostList(200),
  pageContentIndex: bool,
  pageWatch: bool,
  pageWatches: (v) =>
    Array.isArray(v) && v.length <= 10 && unique(v.map((w) => (isRecord(w) ? w['id'] : w))) &&
    v.every(
      (w) =>
        isRecord(w) && typeof w['url'] === 'string' && /^https?:\/\/\S+$/.test(w['url']) && typeof w['id'] === 'string' && w['id'] !== '' && text(w['title']) && PROFILE.test(String(w['profileId'])) &&
        num(5, 10080)(w['minutes']) && Number.isInteger(w['minutes']) && (w['hash'] === undefined || /^[0-9a-f]{16}$/.test(String(w['hash']))) && (w['selector'] === undefined || (text(w['selector']) && w['selector'] !== ''))
    ),
  readAloud: bool,
  batterySaver: bool,
  downloadPause: bool,
  downloadResume: bool,
  downloadAskWhere: bool,
  openWithMemory: bool,
  openWithApps: (v) => isRecord(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length <= OPEN_WITH_MAX && Object.entries(v).every(([type, app]) => isRememberableType(type) && isApplicationPath(app)),
  openUnsaved: bool,
  pdfWithSource: bool,
  useReadLaterFolders: bool,
  readableMode: (v) => v === 'original' || v === 'dark' || v === 'light' || v === 'auto',
  siteReadableMode: (v) => isRecord(v) && Object.getPrototypeOf(v) === Object.prototype && keysOf(v).length <= SITE_READABLE_MAX && Object.entries(v).every(([host, mode]) => normalizeBlockHost(host) === host && (mode === 'original' || mode === 'dark' || mode === 'light')),
  readableToolbarButton: bool,
  windowVibrancy: (v) => (WINDOW_VIBRANCIES as readonly unknown[]).includes(v),
  sidebarOpacity: (v) => Number.isInteger(v) && (v as number) >= SIDEBAR_OPACITY_MIN && (v as number) <= 100,
  windowBorder: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= WINDOW_BORDER_MAX,
  cardOutline: bool,
  backClosesOpenedTab: bool,
  tabCycleRecent: bool,
  spaceSwipe: bool,
  dragToSplit: bool,
  warnBeforeClosingWindow: bool,
  modifiedClickBackground: bool,
  blankLinkBackground: bool,
  showZoomIndicator: bool,
  showAdvancedSettings: bool,
  nameWindows: bool,
  uiScale: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 200,
  minimumFontSize: (v) => Number.isInteger(v) && ((v as number) === 0 || ((v as number) >= 9 && (v as number) <= 32)),
  panelSizes: (v) =>
    isRecord(v) &&
    Object.getPrototypeOf(v) === Object.prototype &&
    keysOf(v).length <= PANEL_SCREENS_MAX &&
    Object.entries(v).every(
      ([key, e]) =>
        isRecord(e) &&
        keysOf(e).sort().join() === 'height,internal,label,noticed,percent,scaleFactor,used,width' &&
        text(e['label']) && e['label'].length <= 80 && e['label'].trim() === e['label'] &&
        bool(e['internal']) && (e['internal'] !== true || e['label'] === '') &&
        Number.isInteger(e['width']) && Number.isInteger(e['height']) && num(1, 20000)(e['width']) && num(1, 20000)(e['height']) && num(0.5, 8)(e['scaleFactor']) &&
        key === screenKey({ label: e['label'], internal: e['internal'] as boolean, width: e['width'] as number, height: e['height'] as number, scaleFactor: e['scaleFactor'] as number }) &&
        bool(e['noticed']) && (e['percent'] === null ? e['noticed'] === true : Number.isInteger(e['percent']) && num(PANEL_PERCENT_MIN, PANEL_PERCENT_MAX)(e['percent'])) &&
        Number.isInteger(e['used']) && num(0)(e['used'])
    ),
  suggestHistory: bool,
  suggestTabs: bool,
  suggestArchive: bool,
  suggestReadLater: bool,
  goToOpenTab: bool,
  searchBangs: bool,
  searchDiscovery: bool,
  searchDiscoverySeen: (v) => Array.isArray(v) && v.length <= SEARCH_DISCOVERY_SEEN_MAX && unique(v) && v.every((host) => typeof host === 'string' && /^[a-z0-9.-]{1,253}$/.test(host) && new URL(`https://${host}/`).hostname === host),
  commandBarCalc: bool,
  commandBarSize: (v) => (COMMAND_BAR_SIZES as readonly unknown[]).includes(v),
  commandBarShape: (v) => (COMMAND_BAR_SHAPES as readonly unknown[]).includes(v),
  tabSearch: bool,
  tabGrid: bool,
  shortcutHelp: bool,
  findRegex: bool,
  compactMode: bool,
  tabTree: bool,
  webHardware: bool,
  annotateCapture: bool,
  annotateGlobalShortcut: bool,
  annotateAutoClear: bool,
  annotateLetterKeys: bool,
  annotateAutoClearSeconds: (v) => (AUTO_CLEAR_SECONDS as readonly unknown[]).includes(v),
  // An edge of the four, or a floating place: whole coordinates from the corner of the window (no farther than 20 000) and a layout of the two.
  annotateBar: (v) =>
    isRecord(v) &&
    ((keysOf(v).sort().join() === 'edge,kind' && v['kind'] === 'edge' && ['right', 'left', 'top', 'bottom'].includes(v['edge'] as string)) ||
      (keysOf(v).sort().join() === 'kind,layout,x,y' &&
        v['kind'] === 'floating' &&
        ['column', 'row'].includes(v['layout'] as string) &&
        [v['x'], v['y']].every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 20_000))),
  urlAutomation: bool,
  tabReminders: bool,
  bookmarkManager: bool,
  liveFolders: bool,
  webAppWindows: bool,
  documentPictureInPicture: bool,
  notes: bool,
  notesListButton: bool,
  ollamaConfig: (v) =>
    isRecord(v) &&
    keysOf(v).sort().join() === 'enabled,maxTokens,model,temperature,url' &&
    bool(v['enabled']) &&
    text(v['url']) &&
    v['url'].length > 0 &&
    v['url'].length <= 500 &&
    text(v['model']) &&
    v['model'].length > 0 &&
    v['model'].length <= 100 &&
    Number.isInteger(v['maxTokens']) &&
    (v['maxTokens'] as number) >= 100 &&
    (v['maxTokens'] as number) <= 2048 &&
    typeof v['temperature'] === 'number' &&
    (v['temperature'] as number) >= 0 &&
    (v['temperature'] as number) <= 2 &&
    // The address is one of this Mac, whatever the file said.
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(v['url']).hostname)
}

const LOADABLE_URL = /^(https?|file|about|chrome-extension|devtools|view-source):/i
const TOP_LEVEL = ['version', 'revision', 'spaces', 'tabs', 'folders', 'favorites', 'archive', 'readLater', 'readLaterFolders', 'tabReminders', 'bookmarks', 'activeSpaceId', 'activeTabBySpace', 'sitePermissions', 'sidePanelBehavior', 'commandBarUsage', 'splits', 'boosts', 'sessions', 'workViews', 'settings']

/** Every way a state that went through `normalize` may still be unfit to use. Empty means well formed. */
function problems(state: SidebarState): string[] {
  const out: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) out.push(message)
  }
  /** The picture is the name of one of our own files, and the web panels are web pages, each once, at most WEB_PANELS_MAX of them. */
  const checkSpaceExtras = (space: Space, at: string) => {
    check(space.image === undefined || isSpaceImageName(space.image), `${at}: image ${show(space.image)}`)
    // The icon: letters are one or two letters or digits in capitals, the colour a #rrggbb, and a kind is only there when the space has what it shows.
    check(space.iconLetter === undefined || (cleanIconLetter(space.iconLetter) === space.iconLetter && space.iconLetter !== ''), `${at}: icon letter ${show(space.iconLetter)}`)
    check(space.iconColor === undefined || cleanIconColor(space.iconColor) === space.iconColor, `${at}: icon colour ${show(space.iconColor)}`)
    check(space.iconRound === undefined || typeof space.iconRound === 'boolean', `${at}: icon shape ${show(space.iconRound)}`)
    check(space.iconKind === undefined || (isSpaceIconKind(space.iconKind) && (space.iconKind !== 'letter' || space.iconLetter !== undefined) && (space.iconKind !== 'image' || space.image !== undefined)), `${at}: icon kind ${show(space.iconKind)}`)
    if (space.webPanels === undefined) return
    check(Array.isArray(space.webPanels) && space.webPanels.length >= 1 && space.webPanels.length <= WEB_PANELS_MAX, `${at}: web panels ${show(space.webPanels)}`)
    const ids = space.webPanels.map((p) => p.id)
    const urls = space.webPanels.map((p) => p.url)
    check(unique(ids) && unique(urls), `${at}: web panels not unique`)
    for (const p of space.webPanels) {
      check(keysOf(p).sort().join() === 'id,title,url' && webPanelUrl(p.url) === p.url && text(p.title) && p.title.trim() !== '' && p.title.length <= WEB_PANEL_TITLE_MAX, `${at}: web panel ${show(p)}`)
    }
  }
  /** A space put aside holds a whole space of its own: the invariants of the live parts of the state apply to it, with itself as the only space. */
  const checkAside = (a: AsideSpace, id: string) => {
    const at = `space put aside by session ${id}`
    if (!isRecord(a) || !isRecord(a.space)) return check(false, `${at}: not a record`)
    check(keysOf(a).sort().join() === 'archive,folders,index,selected,space,splits,tabs', `${at}: keys ${keysOf(a).join()}`)
    const space = a.space
    check(typeof space.id === 'string' && space.id !== '' && space.id !== '__proto__', `${at}: space id`)
    check(text(space.name) && space.name.trim() !== '' && space.name.length <= 200 && text(space.emoji) && space.emoji.trim() !== '' && space.emoji.length <= 64, `${at}: space name or icon`)
    check(typeof space.profileId === 'string' && (space.profileId === 'default' || PROFILE.test(space.profileId)), `${at}: profile`)
    check(JSON.stringify(cleanTheme(space.theme)) === JSON.stringify(space.theme), `${at}: theme not clean`)
    check(keysOf(space).every((k) => ['id', 'name', 'emoji', 'theme', 'profileId', 'hideHeader', 'image', 'iconKind', 'iconLetter', 'iconColor', 'iconRound', 'webPanels', 'background'].includes(k)), `${at}: space keys`)
    checkSpaceExtras(space, at)
    check(Number.isInteger(a.index) && a.index >= 0, `${at}: index ${show(a.index)}`)
    const folders = new Map(a.folders.map((f) => [f.id, f]))
    check(folders.size === a.folders.length, `${at}: duplicate folder ids`)
    for (const f of a.folders) {
      check(f.spaceId === space.id && text(f.name) && f.name.trim() !== '' && bool(f.collapsed), `${at}: folder`)
      check(f.parentId === undefined || folders.get(f.parentId) !== undefined, `${at}: folder parent missing`)
      const depth = folderDepth(a.folders, f.id)
      check(depth >= 1 && depth <= FOLDER_MAX_DEPTH, `${at}: folder depth ${depth}`)
    }
    check(a.tabs.length <= 1000 && unique(a.tabs.map((t) => t.id)), `${at}: tabs size or duplicate ids`)
    const tabIds = new Set(a.tabs.map((t) => t.id))
    for (const t of a.tabs) {
      check(t.spaceId === space.id && typeof t.url === 'string' && LOADABLE_URL.test(t.url) && bool(t.pinned) && num()(t.createdAt) && num()(t.lastActiveAt), `${at}: tab ${show(t.id)}`)
      check(t.folderId === undefined || folders.get(t.folderId)?.spaceId === space.id, `${at}: tab folder missing`)
      check(t.faviconUrl === undefined || (/^https?:\/\//i.test(t.faviconUrl) && t.faviconUrl.length <= 2048), `${at}: a tab keeps a heavy icon`)
      check(!Object.values(t).includes(undefined) && keysOf(t).every((k) => ['id', 'spaceId', 'url', 'title', 'faviconUrl', 'customTitle', 'icon', 'image', 'pinned', 'anchorUrl', 'keepAwake', 'deadKept', 'autoReload', 'folderId', 'openerId', 'parentId', 'treeCollapsed', 'favoriteId', 'container', 'windowKey', 'createdAt', 'lastActiveAt'].includes(k)), `${at}: tab keys ${keysOf(t).join()}`)
    }
    const inSplit = new Set<string>()
    for (const sp of a.splits) {
      check(sp.spaceId === space.id && sp.tabIds.length >= 2 && sp.tabIds.length <= SPLIT_MAX_PANES && sp.ratios.length === sp.tabIds.length, `${at}: split`)
      for (const tabId of sp.tabIds) {
        check(tabIds.has(tabId) && !inSplit.has(tabId), `${at}: split tab missing or in two splits`)
        inSplit.add(tabId)
      }
    }
    check(a.selected === null || tabIds.has(a.selected), `${at}: selected tab missing`)
    check(a.archive.length <= 500 && a.archive.every((x) => x.spaceId === space.id && typeof x.url === 'string' && LOADABLE_URL.test(x.url) && num()(x.archivedAt)), `${at}: archive`)
  }

  const arrays: unknown[] = [state.spaces, state.tabs, state.folders, state.favorites, state.archive, state.readLater, state.splits, state.boosts, state.sessions, state.workViews]
  if (!arrays.every(Array.isArray) || !isRecord(state.activeTabBySpace) || !isRecord(state.settings)) return ['a collection is not of its kind']
  check(unique(keysOf(state)) && keysOf(state).sort().join() === [...TOP_LEVEL].sort().join(), `top-level keys: ${keysOf(state).join()}`)
  check(state.version === STATE_VERSION, 'version')
  check(typeof state.revision === 'number' && Number.isSafeInteger(state.revision) && state.revision >= STATE_REVISION, 'revision')
  check(state.spaces.length >= 1, 'no space')
  const spaceIds = new Set(state.spaces.map((s) => s.id))
  check(spaceIds.size === state.spaces.length, 'duplicate space ids')
  for (const s of state.spaces) {
    check(typeof s.id === 'string' && s.id !== '' && s.id !== '__proto__', `space id ${show(s.id)}`)
    check(text(s.name) && s.name.trim() !== '' && s.name.length <= 200, `space name ${show(s.name)}`)
    check(text(s.emoji) && s.emoji.trim() !== '' && s.emoji.length <= 64, `space emoji ${show(s.emoji)}`)
    check(typeof s.profileId === 'string' && (s.profileId === 'default' || PROFILE.test(s.profileId)), `space profile ${show(s.profileId)}`)
    check(JSON.stringify(cleanTheme(s.theme)) === JSON.stringify(s.theme), 'space theme not clean')
    check(s.hideHeader === undefined || bool(s.hideHeader), 'hideHeader')
    check(keysOf(s).every((k) => ['id', 'name', 'emoji', 'theme', 'profileId', 'hideHeader', 'image', 'iconKind', 'iconLetter', 'iconColor', 'iconRound', 'webPanels', 'background'].includes(k)), `space keys ${keysOf(s).join()}`)
    checkSpaceExtras(s, `space ${s.id}`)
  }
  check(spaceIds.has(state.activeSpaceId), 'activeSpaceId unknown')

  const folderById = new Map(state.folders.map((f) => [f.id, f]))
  check(folderById.size === state.folders.length, 'duplicate folder ids')
  for (const f of state.folders) {
    check(spaceIds.has(f.spaceId), 'folder in unknown space')
    check(text(f.name) && f.name.trim() !== '', 'folder name')
    check(bool(f.collapsed), 'folder collapsed')
    if (f.parentId !== undefined) {
      const parent = folderById.get(f.parentId)
      check(parent !== undefined && parent.spaceId === f.spaceId, 'folder parent missing or in another space')
    }
    const depth = folderDepth(state.folders, f.id)
    check(depth >= 1 && depth <= FOLDER_MAX_DEPTH, `folder depth ${depth}`)
    // A loop would make the chain end on a folder already seen: walking one step more than the limit must reach the root.
    let current: Folder | undefined = f
    for (let i = 0; i <= FOLDER_MAX_DEPTH && current?.parentId !== undefined; i++) current = folderById.get(current.parentId)
    check(current?.parentId === undefined, 'folder loop')
  }

  const tabById = new Map(state.tabs.map((t) => [t.id, t]))
  check(tabById.size === state.tabs.length, 'duplicate tab ids')
  for (const t of state.tabs) {
    check(spaceIds.has(t.spaceId), 'tab in unknown space')
    check(typeof t.url === 'string' && LOADABLE_URL.test(t.url), `tab url ${show(t.url)}`)
    check(typeof t.title === 'string' && !/\p{Cc}/u.test(t.title), 'tab title')
    check(bool(t.pinned), 'tab pinned')
    check(num()(t.createdAt) && num()(t.lastActiveAt), 'tab dates')
    check(t.folderId === undefined || folderById.get(t.folderId)?.spaceId === t.spaceId, 'tab folder missing or in another space')
    check(!Object.values(t).includes(undefined), `tab holds an undefined value: ${keysOf(t).join()}`)
    check(t.keepAwake === undefined || t.keepAwake === true, 'keepAwake')
    check(t.deadKept === undefined || (isRecord(t.deadKept) && keysOf(t.deadKept).join() === 'url,at' && typeof t.deadKept.url === 'string' && LOADABLE_URL.test(t.deadKept.url) && Number.isFinite(t.deadKept.at) && t.deadKept.at >= 0), `deadKept ${show(t.deadKept)}`)
    check(t.autoReload === undefined || (isRecord(t.autoReload) && keysOf(t.autoReload).join() === 'seconds' && Number.isInteger(t.autoReload.seconds) && t.autoReload.seconds >= 5 && t.autoReload.seconds <= 86_400), `autoReload ${show(t.autoReload)}`)
    check(t.anchorUrl === undefined || (typeof t.anchorUrl === 'string' && LOADABLE_URL.test(t.anchorUrl)), 'anchorUrl')
    check(t.customTitle === undefined || (typeof t.customTitle === 'string' && t.customTitle.trim() !== '' && t.customTitle.length <= 120), 'customTitle')
    check(t.private === undefined || t.private === true, 'private flag')
    check(t.container === undefined || state.settings.containers.some((c) => c.id === t.container), `tab container ${show(t.container)} does not exist`)
    check(t.windowKey === undefined || isWindowKey(t.windowKey), `tab window ${show(t.windowKey)}`)
    check(t.openerId === undefined || (t.openerId !== t.id && !t.pinned && tabById.has(t.openerId)), `tab origin ${show(t.openerId)}: itself, missing or the tab is pinned`)
    check(t.favoriteId === undefined || (!t.pinned && state.favorites.some((f) => f.id === t.favoriteId && f.profileId === state.spaces.find((s) => s.id === t.spaceId)?.profileId)), `tab favourite ${show(t.favoriteId)}: missing, of another profile than the tab's space, or the tab is pinned`)
    check(keysOf(t).every((k) => ['id', 'spaceId', 'url', 'title', 'faviconUrl', 'customTitle', 'icon', 'image', 'pinned', 'anchorUrl', 'keepAwake', 'deadKept', 'autoReload', 'folderId', 'private', 'openerId', 'parentId', 'treeCollapsed', 'favoriteId', 'container', 'windowKey', 'createdAt', 'lastActiveAt'].includes(k)), `tab keys ${keysOf(t).join()}`)
    // The tab tree: a parent is another Today tab of the same space, nothing is kept with the setting off, and a branch is folded only while it has children.
    const parent = t.parentId === undefined ? undefined : tabById.get(t.parentId)
    check(t.parentId === undefined || (state.settings.tabTree && parent !== undefined && parent.id !== t.id && parent.spaceId === t.spaceId && !parent.pinned && !t.pinned), `tab parent ${show(t.parentId)}: setting off, missing, itself, another space or pinned`)
    check(t.treeCollapsed === undefined || (t.treeCollapsed === true && state.settings.tabTree && state.tabs.some((c) => c.parentId === t.id)), `tab folded ${show(t.treeCollapsed)}: setting off or no children`)
  }
  // A branch comes right after its parent: walking the Today tabs of a space, a tab's parent is always on the path of the tab before it.
  for (const spaceId of spaceIds) {
    const open: string[] = []
    for (const t of state.tabs.filter((x) => x.spaceId === spaceId && !x.pinned)) {
      while (open.length > 0 && open[open.length - 1] !== t.parentId) open.pop()
      check(t.parentId === undefined || open.length > 0, `tab ${show(t.id)} is not right after the branch of its parent`)
      open.push(t.id)
    }
  }

  check(keysOf(state.activeTabBySpace).sort().join() === [...spaceIds].sort().join(), 'activeTabBySpace keys')
  for (const [spaceId, tabId] of Object.entries(state.activeTabBySpace)) check(tabId === null || tabById.get(tabId)?.spaceId === spaceId, `selected tab of ${spaceId} is not one of its tabs`)

  check(unique(state.favorites.map((f) => f.id)), 'duplicate favorite ids')
  for (const f of state.favorites) check(typeof f.url === 'string' && LOADABLE_URL.test(f.url) && typeof f.title === 'string' && isProfileId(f.profileId), 'favorite')
  // One address once per profile (each profile has its own favourites, the same address may be in several).
  check(unique(state.favorites.map((f) => `${f.profileId} ${f.url}`)), 'duplicate favorite addresses in a profile')
  check(state.archive.length <= 500 && unique(state.archive.map((a) => a.id)), 'archive size or duplicate ids')
  for (const a of state.archive) check(spaceIds.has(a.spaceId) && typeof a.url === 'string' && LOADABLE_URL.test(a.url) && typeof a.title === 'string' && num()(a.archivedAt), 'archived tab')
  for (const a of state.archive) check(a.container === undefined || state.settings.containers.some((c) => c.id === a.container), `archived tab ${a.id}: container ${show(a.container)} does not exist`)
  // The pages a closed tab kept: web addresses only, at most 20, ending on the address of the entry.
  for (const a of state.archive) {
    if (a.history === undefined) continue
    const { entries, index } = a.history
    check(entries.length >= 2 && entries.length <= 20 && Number.isInteger(index) && index >= 0 && index < entries.length && entries[index]!.url === a.url, `archived tab ${a.id}: history shape`)
    check(entries.every((e) => /^https?:\/\//i.test(e.url) && e.url.length <= 2048 && text(e.title) && e.title.length <= 200), `archived tab ${a.id}: history entries`)
  }
  // A space that is gone is no longer locked.
  check(state.settings.lockedSpaces.every((id) => spaceIds.has(id)), 'locked space that does not exist')
  check(Array.isArray(state.readLater) && state.readLater.length <= 500 && unique(state.readLater.map((r) => r.id)) && unique(state.readLater.map((r) => r.url)), 'read-later size, duplicate ids or addresses')
  for (const r of state.readLater) {
    check(typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && r.url.length <= 4096, `read-later url ${show(r.url)}`)
    check(text(r.title) && r.title.trim() === r.title && r.title !== '' && r.title.length <= 300, `read-later title ${show(r.title)}`)
    check(r.faviconUrl === undefined || (typeof r.faviconUrl === 'string' && ((/^data:image\/[a-z+.-]+;base64,/.test(r.faviconUrl) && r.faviconUrl.length <= 16_384) || (/^https?:\/\//i.test(r.faviconUrl) && r.faviconUrl.length <= 2048))), 'read-later favicon')
    check(num()(r.savedAt), 'read-later date')
    check(keysOf(r).every((k) => ['id', 'url', 'title', 'faviconUrl', 'savedAt', 'folderId'].includes(k)) && !Object.values(r).includes(undefined), `read-later keys ${keysOf(r).join()}`)
    check(r.folderId === undefined || state.readLaterFolders.some((f) => f.id === r.folderId), `read-later page in a folder that does not exist: ${show(r.folderId)}`)
  }
  check(Array.isArray(state.readLaterFolders) && state.readLaterFolders.length <= 50 && unique(state.readLaterFolders.map((f) => f.id)), 'read-later folders: size or duplicate ids')
  for (const f of state.readLaterFolders) {
    check(text(f.name) && f.name.trim() === f.name && f.name !== '' && f.name.length <= 100, `read-later folder name ${show(f.name)}`)
    check(keysOf(f).every((k) => ['id', 'name', 'collapsed'].includes(k)) && (f.collapsed === undefined || f.collapsed === true), `read-later folder keys ${keysOf(f).join()}`)
  }

  // The reminders: bounded, a web page and a finite time each, soonest first, in a space that exists or none.
  check(Array.isArray(state.tabReminders) && state.tabReminders.length <= 200 && unique(state.tabReminders.map((r) => r.id)), 'tabReminders: size or duplicate ids')
  for (const [i, r] of state.tabReminders.entries()) {
    check(typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && r.url.length <= 4096, `reminder url ${show(r.url)}`)
    check(Number.isFinite(r.dueAt) && Number.isFinite(r.createdAt) && (i === 0 || state.tabReminders[i - 1]!.dueAt <= r.dueAt), `reminder time ${show(r.dueAt)}`)
    check(r.spaceId === '' || state.spaces.some((s) => s.id === r.spaceId), `reminder space ${show(r.spaceId)}`)
  }

  // The bookmark library: bounded, each page once, printable text, tags that are clean and each once.
  check(Array.isArray(state.bookmarks) && state.bookmarks.length <= 5000 && unique(state.bookmarks.map((b) => b.id)) && unique(state.bookmarks.map((b) => (URL.canParse(b.url) ? new URL(b.url).href : b.url))), 'bookmarks: size, duplicate ids or addresses')
  for (const b of state.bookmarks) {
    check(typeof b.url === 'string' && /^https?:\/\//i.test(b.url) && b.url.length <= 4096, `bookmark url ${show(b.url)}`)
    check(text(b.title) && b.title.trim() === b.title && b.title !== '' && b.title.length <= 300, `bookmark title ${show(b.title)}`)
    check(Array.isArray(b.tags) && b.tags.length <= 12 && b.tags.every((t) => text(t) && t.trim() === t && t !== '' && t.length <= 40 && !t.includes(',') && !t.startsWith('#')) && unique(b.tags.map((t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())), `bookmark tags ${show(b.tags)}`)
    check(b.note === undefined || (text(b.note) && b.note.trim() === b.note && b.note !== '' && b.note.length <= 1000), 'bookmark note')
    check(b.faviconUrl === undefined || (typeof b.faviconUrl === 'string' && ((/^data:image\/[a-z+.-]+;base64,/.test(b.faviconUrl) && b.faviconUrl.length <= 16_384) || (/^https?:\/\//i.test(b.faviconUrl) && b.faviconUrl.length <= 2048))), 'bookmark favicon')
    check(num()(b.addedAt), 'bookmark date')
    check(keysOf(b).every((k) => ['id', 'url', 'title', 'tags', 'note', 'faviconUrl', 'addedAt'].includes(k)) && !Object.values(b).includes(undefined), `bookmark keys ${keysOf(b).join()}`)
  }
  // The live part of a folder: a source that is a web feed or a repository, at most 15 items on web addresses, at most 20 live folders.
  check(state.folders.filter((f) => f.live !== undefined).length <= 20, 'more than 20 live folders')
  for (const f of state.folders) {
    if (f.live === undefined) continue
    const { source, items } = f.live
    check(isRecord(source) && (source.kind === 'feed' ? /^https?:\/\//i.test(source.url) && source.url.length <= 2048 : source.kind === 'github' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(source.repo)), `live folder source ${show(source)}`)
    check(Array.isArray(items) && items.length <= 15 && unique(items.map((i) => i.url)) && items.every((i) => /^https?:\/\//i.test(i.url) && i.url.length <= 2048 && text(i.title) && i.title !== '' && i.title.length <= 200 && (i.at === undefined || num()(i.at))), `live folder items ${show(items)}`)
    check((f.live.checkedAt === undefined || num()(f.live.checkedAt)) && (f.live.failure === undefined || (text(f.live.failure) && f.live.failure !== '' && f.live.failure.length <= 200)), 'live folder look')
    check(keysOf(f.live).every((k) => ['source', 'items', 'checkedAt', 'failure'].includes(k)) && !Object.values(f.live).includes(undefined), `live folder keys ${keysOf(f.live).join()}`)
  }

  check(unique(state.splits.map((s) => s.id)), 'duplicate split ids')
  const inSplit = new Set<string>()
  for (const sp of state.splits) {
    check(Array.isArray(sp.tabIds) && sp.tabIds.length >= 2 && sp.tabIds.length <= SPLIT_MAX_PANES, `split of ${show(sp.tabIds)} tabs`)
    for (const id of sp.tabIds) {
      check(tabById.get(id)?.spaceId === sp.spaceId, 'split tab missing or in another space')
      check(!inSplit.has(id), 'tab in two splits')
      inSplit.add(id)
    }
    check(sp.orientation === 'horizontal' || sp.orientation === 'vertical', 'split orientation')
    check(Array.isArray(sp.ratios) && sp.ratios.length === sp.tabIds.length && sp.ratios.every(num(0.1, 1)) && Math.abs(sp.ratios.reduce((a, b) => a + b, 0) - 1) < 1e-6, 'split ratios')
    // The mark of a work view: a view that exists, of the profile of the split view's space, on one split view of that space at most.
    const space = state.spaces.find((each) => each.id === sp.spaceId)
    check(sp.viewId === undefined || state.workViews.some((view) => view.id === sp.viewId && view.profileId === space?.profileId), `split marked by work view ${show(sp.viewId)}`)
    check(sp.viewId === undefined || state.splits.filter((other) => other.spaceId === sp.spaceId && other.viewId === sp.viewId).length === 1, 'two split views of one space marked by one work view')
  }

  check(state.workViews.length <= 50 && unique(state.workViews.map((v) => v.id)), 'work views: size or duplicate ids')
  // The profiles that exist: the default one, those of the spaces (put aside too), those named or set without a space (profiles.ts `knownProfiles`).
  const knownProfiles = new Set(['default', ...state.spaces.map((s) => s.profileId), ...state.sessions.flatMap((s) => (s.space ? [s.space.space.profileId] : [])), ...Object.keys(state.settings.profileNames), ...Object.keys(state.settings.profiles)])
  for (const v of state.workViews) {
    check(typeof v.id === 'string' && v.id !== '' && v.id !== '__proto__', `work view id ${show(v.id)}`)
    check(text(v.name) && v.name === v.name.trim() && v.name !== '' && v.name.length <= 60, `work view name ${show(v.name)}`)
    check(text(v.emoji) && v.emoji.trim() !== '' && v.emoji.length <= 64, `work view emoji ${show(v.emoji)}`)
    check(knownProfiles.has(v.profileId), `work view of an unknown profile ${show(v.profileId)}`)
    check(Array.isArray(v.panes) && v.panes.length >= 2 && v.panes.length <= SPLIT_MAX_PANES, `work view of ${show(v.panes?.length)} sites`)
    for (const p of Array.isArray(v.panes) ? v.panes : []) {
      check(typeof p.url === 'string' && /^(https?|file):/i.test(p.url) && p.url.length <= 8192 && !/\p{Cc}/u.test(p.url), `work view site ${show(p.url)}`)
      check(text(p.title) && p.title !== '' && p.title.length <= TITLE_MAX, `work view site title ${show(p.title)}`)
      check(p.faviconUrl === undefined || (/^https?:\/\//i.test(p.faviconUrl) && p.faviconUrl.length <= 2048), `work view site icon ${show(p.faviconUrl)}`)
      check(keysOf(p).every((k) => ['url', 'title', 'faviconUrl'].includes(k)) && !Object.values(p).includes(undefined), `work view site keys ${keysOf(p).join()}`)
    }
    check(v.orientation === 'horizontal' || v.orientation === 'vertical', 'work view orientation')
    check(Array.isArray(v.ratios) && v.ratios.length === v.panes.length && v.ratios.every(num(0.1, 1)) && Math.abs(v.ratios.reduce((a, b) => a + b, 0) - 1) < 1e-6, `work view ratios ${show(v.ratios)}`)
    check(v.grid === undefined || (v.panes.length >= 3 && num(0.1, 0.9)(v.grid.column) && num(0.1, 0.9)(v.grid.row) && (v.panes.length === 3) === (v.grid.span !== undefined)), `work view grid ${show(v.grid)}`)
    const target = v.target
    check(target === undefined || target.kind === 'window' || target.kind === 'new-space' || (target.kind === 'space' && state.spaces.some((s) => s.id === target.spaceId && s.profileId === v.profileId)), `work view place ${show(target)}`)
    check(keysOf(v).every((k) => ['id', 'name', 'emoji', 'profileId', 'panes', 'orientation', 'ratios', 'grid', 'target'].includes(k)) && !Object.values(v).includes(undefined), `work view keys ${keysOf(v).join()}`)
  }

  check(unique(state.boosts.map((b) => b.id)), 'duplicate boost ids')
  for (const b of state.boosts) {
    check(typeof b.id === 'string' && b.id !== '', 'boost id')
    check(typeof b.host === 'string' && b.host !== '' && b.host === b.host.trim().toLowerCase() && !b.host.startsWith('www.'), 'boost host')
    check(typeof b.name === 'string' && b.name.trim() !== '' && b.name.length <= 60, 'boost name')
    check(bool(b.enabled) && typeof b.css === 'string' && typeof b.js === 'string', 'boost fields')
    // The one value that means something: a script kept switched off. A Tweak whose script runs has no such key.
    check(b.jsEnabled === undefined || b.jsEnabled === false, 'boost jsEnabled')
    check(num(0.5, 3)(b.zoom), 'boost zoom')
    check(Array.isArray(b.zap) && b.zap.length <= 100 && b.zap.every((z) => typeof z === 'string' && !/[{};]/.test(z)), 'boost zap')
    check(isRecord(b.tint) && num(-180, 180)(b.tint.hue) && num(0, 2)(b.tint.saturation) && num(0.5, 1.5)(b.tint.brightness) && num(0.5, 1.5)(b.tint.contrast), 'boost tint')
    check(!Object.values(b).includes(undefined), 'boost holds an undefined value')
  }

  check(state.sessions.length <= 100 && unique(state.sessions.map((s) => s.id)), 'sessions size or duplicate ids')
  for (const s of state.sessions) {
    check(typeof s.id === 'string' && s.id !== '' && s.id !== '__proto__', 'session id')
    check(text(s.name) && s.name === s.name.trim() && s.name !== '' && s.name.length <= 100, `session name ${show(s.name)}`)
    check(num()(s.createdAt), 'session date')
    check(Array.isArray(s.tabs) && (s.tabs.length >= 1 || s.space !== undefined) && s.tabs.length <= 500, `session of ${show(s.tabs?.length)} tabs`)
    for (const t of Array.isArray(s.tabs) ? s.tabs : []) {
      check(typeof t.url === 'string' && /^(https?|file):/i.test(t.url) && t.url.length <= 8192 && !/\p{Cc}/u.test(t.url), `session tab url ${show(t.url)}`)
      check(text(t.title) && t.title === t.title.trim() && t.title !== '' && t.title.length <= 1000, `session tab title ${show(t.title)}`)
      check(t.pinned === undefined || t.pinned === true, 'session tab pinned')
      check(t.folder === undefined || (t.pinned === true && text(t.folder) && t.folder !== '' && t.folder === t.folder.trim()), 'session tab folder')
      check(keysOf(t).every((k) => ['url', 'title', 'pinned', 'folder', 'container'].includes(k)) && !Object.values(t).includes(undefined), `session tab keys ${keysOf(t).join()}`)
    }
    check(keysOf(s).every((k) => ['createdAt', 'id', 'name', 'tabs', 'space'].includes(k)) && keysOf(s).length >= 4 && !Object.values(s).includes(undefined), `session keys ${keysOf(s).join()}`)
    if (s.space !== undefined) checkAside(s.space, s.id)
  }

  for (const [origin, perms] of Object.entries(state.sitePermissions)) check(isRecord(perms) && Object.values(perms).every((d) => d === 'allow' || d === 'deny'), `permissions of ${origin}`)
  check(Object.values(state.sidePanelBehavior).every(bool), 'sidePanelBehavior')
  check(Object.entries(state.commandBarUsage).every(([profileId, usage]) => isProfileId(profileId) && isRecord(usage) && Object.keys(usage).length > 0 && Object.keys(usage).length <= 300 && Object.values(usage).every(num(0))), 'commandBarUsage')

  check(keysOf(state.settings).sort().join() === Object.keys(defaultSettings()).sort().join(), `settings keys: ${keysOf(state.settings).filter((k) => !(k in defaultSettings())).join()}`)
  for (const key of Object.keys(defaultSettings()) as Array<keyof Settings>) check((VALID[key] as (value: unknown) => boolean)(state.settings[key]), `setting ${key} = ${show(state.settings[key])}`)
  return out
}

/** Everything a loaded state must satisfy: well formed, JSON-stable, and unchanged by a second normalisation. */
function loadedProblems(raw: unknown): string[] {
  let state: SidebarState
  try {
    state = norm(raw)
  } catch (error) {
    return [`normalize threw: ${String(error)}`]
  }
  const out = problems(state)
  try {
    // Node's own comparison answers for the thousands of states that are equal; the assertion is only asked for its message when they differ.
    const same = (got: unknown): void => {
      if (!isDeepStrictEqual(got, state)) expect(got).toStrictEqual(state)
    }
    same(norm(state))
    const copy: unknown = JSON.parse(JSON.stringify(state))
    same(copy)
    same(norm(copy))
  } catch (error) {
    out.push(`not idempotent / not JSON-stable: ${String(error).split('\n').slice(0, 12).join(' | ').slice(0, 400)}`)
  }
  return out
}

// ---------- (a) a file written by an older build ----------

describe('a state written by an older build', () => {
  // The first shape of the file: spaces coloured by a hue only, no profiles, no folders inside folders, no archive source,
  // no splits / boosts / permissions / usage, and a handful of settings.
  const OLD_FILE = `{
    "version": 1,
    "spaces": [
      { "id": "s1", "name": "Perso", "emoji": "🏠", "hue": 210, "saturation": 42, "grain": 10 },
      { "id": "s2", "name": "Travail", "emoji": "💼", "hue": 20 }
    ],
    "tabs": [
      { "id": "t1", "spaceId": "s1", "url": "https://a.example/", "title": "A", "pinned": true, "createdAt": 1, "lastActiveAt": 2 },
      { "id": "t2", "spaceId": "s1", "url": "https://b.example/", "title": "B", "pinned": true, "folderId": "f1", "faviconUrl": "https://b.example/f.ico", "createdAt": 3, "lastActiveAt": 4 },
      { "id": "t3", "spaceId": "s1", "url": "https://c.example/", "title": "C", "pinned": false, "createdAt": 5, "lastActiveAt": 6 },
      { "id": "t4", "spaceId": "s2", "url": "https://d.example/", "title": "D", "pinned": false, "createdAt": 7, "lastActiveAt": 8 }
    ],
    "folders": [{ "id": "f1", "spaceId": "s1", "name": "Outils", "collapsed": false }],
    "favorites": [{ "id": "fav1", "url": "https://f.example/", "title": "F" }],
    "archive": [{ "id": "a1", "spaceId": "s1", "url": "https://old.example/", "title": "Old", "archivedAt": 9 }],
    "activeSpaceId": "s2",
    "activeTabBySpace": { "s1": "t3", "s2": "t4" },
    "settings": {
      "searchUrlTemplate": "https://www.google.com/search?q=%s",
      "siteSearches": [{ "keyword": "yt", "name": "YouTube", "url": "https://www.youtube.com/results?search_query=%s" }],
      "sidebarVisible": false,
      "sidebarWidth": 264,
      "sidePanelWidth": 450,
      "autoArchiveHours": 6,
      "autoArchiveHoursByProfile": { "work": 3 },
      "sleepAfterMinutes": 10,
      "extensionPaths": ["/Users/moi/extensions/une"]
    }
  }`

  it('reads a file that still has the switch of the first-launch guide, a setting that is gone, and writes the settings back without it', () => {
    for (const stale of [true, false, 'oui', null]) {
      const file = JSON.parse(OLD_FILE) as { settings: Record<string, unknown> }
      file.settings['firstLaunchGuide'] = stale
      const state = parseSavedState(JSON.stringify(file))
      expect(problems(state), String(stale)).toEqual([])
      expect(Object.keys(state.settings), String(stale)).not.toContain('firstLaunchGuide')
      expect(JSON.stringify(state), String(stale)).not.toContain('firstLaunchGuide')
      // The rest of the file is read as if the key had never been there.
      expect(state, String(stale)).toEqual(parseSavedState(OLD_FILE))
    }
    expect(Object.keys(defaultSettings())).not.toContain('firstLaunchGuide')
  })

  it('loads, keeps every space, tab, folder, favorite, archived tab and selection, and gives the documented defaults to the new fields', () => {
    const state = parseSavedState(OLD_FILE)
    expect(problems(state)).toEqual([])
    expect(state.spaces.map((s) => [s.id, s.name, s.emoji])).toEqual([['s1', 'Perso', '🏠'], ['s2', 'Travail', '💼']])
    expect(state.tabs.map((t) => [t.id, t.spaceId, t.url, t.title, t.pinned, t.folderId])).toEqual([
      ['t1', 's1', 'https://a.example/', 'A', true, undefined],
      ['t2', 's1', 'https://b.example/', 'B', true, 'f1'],
      ['t3', 's1', 'https://c.example/', 'C', false, undefined],
      ['t4', 's2', 'https://d.example/', 'D', false, undefined]
    ])
    expect(state.tabs[1]).toMatchObject({ faviconUrl: 'https://b.example/f.ico', createdAt: 3, lastActiveAt: 4 })
    expect(state.folders).toEqual([{ id: 'f1', spaceId: 's1', name: 'Outils', collapsed: false }])
    // A file from before the favourites were kept per profile: they are the default profile's (the only one in use here).
    expect(state.favorites).toEqual([{ id: 'fav1', url: 'https://f.example/', title: 'F', profileId: 'default' }])
    expect(state.archive).toEqual([{ id: 'a1', spaceId: 's1', url: 'https://old.example/', title: 'Old', archivedAt: 9 }])
    expect(state.activeSpaceId).toBe('s2')
    expect(state.activeTabBySpace).toEqual({ s1: 't3', s2: 't4' })
    expect([state.splits, state.boosts, state.sitePermissions, state.commandBarUsage, state.sidePanelBehavior]).toEqual([[], [], {}, {}, {}])
  })

  it('turns the hue of an old space into a theme, and puts a space with no profile on the default one', () => {
    const state = parseSavedState(OLD_FILE)
    expect(state.spaces[0]!.theme).toEqual({ ...themeFromHue(210, 0.42 + 0.13), noise: 0.1 })
    expect(state.spaces[1]!.theme).toEqual(themeFromHue(20, 0.42 + 0.13))
    expect(state.spaces.map((s) => s.profileId)).toEqual(['default', 'default'])
    expect(state.spaces.every((s) => !('hue' in s) && !('saturation' in s) && !('grain' in s))).toBe(true)
  })

  it('keeps the settings it had, migrates the old width and delay, and defaults every setting added since', () => {
    const { settings } = parseSavedState(OLD_FILE)
    const defaults = defaultSettings()
    expect(settings).toEqual({
      ...defaults,
      // The protection a file of its time had: a new default (« Renforcée ») never changes an existing profile.
      ...PROTECTION_OF_EARLIER_PROFILES,
      protectionBaseline: PROTECTION_BASELINE_OF_EARLIER_PROFILES,
      searchUrlTemplate: 'https://www.google.com/search?q=%s',
      siteSearches: [{ keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' }],
      sidebarVisible: false,
      sidebarWidth: defaults.sidebarWidth,
      sidePanelWidth: 450,
      autoArchiveHours: 6,
      profiles: { work: { autoArchiveHours: 3 } },
      sleepAfterMinutes: 10,
      extensionPaths: ['/Users/moi/extensions/une']
    })
    // The recent fields, one by one, so that a default that is silently missing is named.
    for (const key of ['webStoreInstall', 'webStoreUpdates', 'sleepMode', 'sleepExcludedHosts', 'sleepSkipAudible', 'siteDataTypes', 'siteDataHttp', 'siteDataAnimation', 'siteZoom', 'blockExceptions', 'blockMode', 'blockModeSites', 'disabledFilterLists', 'developerHosts', 'usedProfiles', 'restoreWindows', 'chromeNativeHosts', 'profileNames', 'keyBindings', 'appIcon', 'updateFeedUrl', 'updateChannel', 'updateNotices', 'resolveFavicons', 'autoplayPolicy', 'spellCheck', 'siteAutoplay', 'autoplayPerSite', 'siteDataClearOnCloseEnabled', 'siteDataClearOnClose', 'siteDataClearOnQuit', 'customFilterListsEnabled', 'customFilterLists', 'qrCode', 'autoScroll', 'scrollSync', 'rememberScroll', 'blockThirdPartyCookies', 'thirdPartyCookieExceptions', 'unwrapRedirects', 'unwrapExceptions', 'safeBrowsing', 'safeBrowsingExceptions', 'mouseGestures', 'mouseGestureExcludedHosts', 'pageWatch', 'pageWatches', 'readAloud', 'batterySaver', 'downloadPause', 'downloadAskWhere', 'openWithMemory', 'openWithApps', 'openUnsaved', 'pdfWithSource', 'useReadLaterFolders', 'vimKeys', 'vimKeysExcludedHosts', 'tabGroupFolders', 'omniboxKeywords', 'blockScriptlets', 'reduceFingerprint', 'fingerprintStrict', 'fingerprintExceptions'] as const) {
      expect(settings[key], key).toEqual(defaults[key])
    }
    expect(settings.siteDataTypes).toEqual(SITE_DATA_TYPES.filter((type) => type !== 'history'))
    expect(settings.restoreWindows).toBe(true)
    // A file from before the site-icon lookup gets it on, as a new profile does.
    expect(settings.resolveFavicons).toBe(true)
    // A file from before the Chrome Web Store: installation allowed (it needs a click on the store's page), updates only on request.
    expect([settings.webStoreInstall, settings.webStoreUpdates]).toEqual([true, 'manual'])
    // …and Chromium's own autoplay policy, with nothing erased at close, no custom list and no site choice: Electron's looser default is never inherited.
    expect(settings.autoplayPolicy).toBe('block')
    // …and the system's own choice of spelling check, until the user makes one.
    expect(settings.spellCheck).toBe('auto')
    expect([settings.siteAutoplay, settings.siteDataClearOnClose, settings.siteDataClearOnQuit, settings.customFilterLists]).toEqual([{}, [], false, []])
    // The extended blocking and the fingerprint protection ask for a page to be changed: a file from before them has both off.
    expect([settings.blockScriptlets, settings.reduceFingerprint, settings.fingerprintStrict, settings.fingerprintExceptions]).toEqual([false, false, false, []])
    // Third-party cookies are cut only when asked: a file from before the option lets them through.
    expect([settings.blockThirdPartyCookies, settings.thirdPartyCookieExceptions]).toEqual([false, []])
    // Links are unwrapped only when asked, for every site.
    expect([settings.unwrapRedirects, settings.unwrapExceptions]).toEqual([false, []])
    // Safe browsing closes a page only when asked: a file from before it has it off.
    expect([settings.safeBrowsing, settings.safeBrowsingExceptions]).toEqual([false, []])
    // The three switches: the clearing at close is off, the per-site autoplay and the custom lists are on.
    expect([settings.siteDataClearOnCloseEnabled, settings.autoplayPerSite, settings.customFilterListsEnabled]).toEqual([false, true, true])
  })

  it('does the same through the reducer-side entry points (restore, import) as through the loader', () => {
    const fromFile = parseSavedState(OLD_FILE)
    expect(restoredState(JSON.parse(OLD_FILE))).toStrictEqual(fromFile)
    const current = createInitialState({ now: 1, newId: () => 'x' })
    const restored = reduce(current, { type: 'state/restore', state: JSON.parse(OLD_FILE) as SidebarState }, { now: 1, newId: () => 'y' })
    // Only the extensions stay those of this installation (see the restore test below).
    expect(restored).toStrictEqual({ ...fromFile, settings: { ...fromFile.settings, extensionPaths: current.settings.extensionPaths, webStoreInstall: current.settings.webStoreInstall, webStoreUpdates: current.settings.webStoreUpdates } })
  })

  it('gives a profile restored from a file of before « Renforcée » the baseline of an earlier profile, whatever the installation that restores it is', () => {
    const current = createInitialState({ now: 1, newId: () => 'x' })
    expect(current.settings.protectionBaseline).toBe('renforcee')
    const restored = reduce(current, { type: 'state/restore', state: JSON.parse(OLD_FILE) as SidebarState }, { now: 1, newId: () => 'y' })
    expect(restored.settings.protectionBaseline).toBe('standard')
    expect(PROTECTION_KEYS.map((key) => restored.settings[key])).toEqual([false, false, false, false])
  })

  it('keeps a state of today unchanged: nothing the model holds is dropped by loading', () => {
    const state = rich()
    expect(problems(state)).toEqual([])
    expect(norm(state)).toStrictEqual(state)
    expect(parseSavedState(JSON.stringify(state))).toStrictEqual(state)
  })

  it('keeps the themes of the spaces, saved by hue or by colours', () => {
    const state = rich()
    const loaded = parseSavedState(JSON.stringify(state))
    expect(loaded.spaces.map((s) => s.theme)).toEqual(state.spaces.map((s) => s.theme))
  })

  it('refuses a file that is not of this version or not a state, so that the caller can keep it aside', () => {
    for (const text of ['', '{ not json', 'null', '3', '"text"', '[]', '{}', JSON.stringify({ version: 2, spaces: [] }), JSON.stringify({ ...rich(), version: 0 })]) {
      expect(() => parseSavedState(text), text.slice(0, 40)).toThrow()
    }
  })

  it('tells a file of a more recent version from a damaged one, so that the caller keeps it intact', () => {
    expect(() => parseSavedState(JSON.stringify({ ...rich(), version: 2 }))).toThrow(NewerStateError)
    expect(() => parseSavedState(JSON.stringify({ version: 99, spaces: [] }))).toThrow(NewerStateError)
    for (const version of [0, -1, 1.5, '2', null]) {
      expect(() => parseSavedState(JSON.stringify({ ...rich(), version })), String(version)).toThrow(/unsupported state version/)
    }
  })

  it('reads a file that an editor saved with a byte-order mark', () => {
    expect(parseSavedState(`\uFEFF${JSON.stringify(rich())}`)).toStrictEqual(rich())
  })

  it('bounds the archive of a file to what the reducer itself keeps (the newest first)', () => {
    const archive = Array.from({ length: 100_000 }, (_, i) => ({ id: `a${i}`, spaceId: 'sp-home', url: `https://a${i}.example/`, title: 'x', archivedAt: 100_000 - i }))
    const state = parseSavedState(JSON.stringify({ ...rich(), archive }))
    expect(state.archive).toHaveLength(500)
    expect(state.archive[0]!.id).toBe('a0')
  })

  it('refuses to restore a file whose spaces or tabs are not all objects, instead of thinning it out silently', () => {
    const state = rich()
    for (const damaged of [{ tabs: [null] }, { tabs: [5, ...state.tabs] }, { spaces: [null, ...state.spaces] }, { spaces: ['sp-home', ...state.spaces] }]) {
      expect(restoredState({ ...state, ...damaged }), JSON.stringify(Object.keys(damaged))).toBeNull()
    }
    // …while a file that merely has a bad entry among good ones still loads at start-up.
    expect(parseSavedState(JSON.stringify({ ...state, tabs: [null, ...state.tabs] })).tabs).toHaveLength(state.tabs.length)
  })

  it('refuses a file none of whose spaces can be recovered, rather than loading an empty browser over it', () => {
    for (const spaces of [[], 'text', null, [null], [{}], [{ name: 'sans id' }], [{ id: '' }], [{ id: '__proto__' }]]) {
      expect(() => parseSavedState(JSON.stringify({ ...rich(), spaces })), JSON.stringify(spaces)).toThrow()
      expect(restoredState({ ...rich(), spaces }), JSON.stringify(spaces)).toBeNull()
    }
  })
})

// ---------- (b) every setting, one wrong value at a time ----------

type Bad = [string, unknown]
const BAD_VALUES: Bad[] = [
  ['null', null],
  ['chaîne', 'texte'],
  ['chaîne vide', ''],
  ['zéro', 0],
  ['nombre', 42],
  ['négatif', -7],
  ['décimal', 0.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['très grand', 1e308],
  ['entier maximal', Number.MAX_SAFE_INTEGER],
  ['true', true],
  ['false', false],
  ['tableau vide', []],
  ['tableau mélangé', [1, null, 'a', {}, [], true]],
  ['tableau de chaînes', ['a', 'b']],
  ['objet vide', {}],
  ['objet', { a: 1 }],
  ['très long', 'x'.repeat(200_000)],
  ['caractères de contrôle', '\u0000\u0007\n\r\t\u001b[31m‮ https://x.example/%s'],
  ['tableau énorme', Array.from({ length: 20_000 }, (_, i) => `h${i}.example.org`)],
  ['clés hostiles', HOSTILE_OBJECT()],
  ['tableau hostile', ['__proto__', 'constructor', 'prototype', 'toString']]
]

const kindOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isFinite(value) ? 'number' : 'non-finite') : typeof value)

describe('every setting, given a value that does not fit', () => {
  const defaults = defaultSettings()
  const base = rich()

  for (const key of Object.keys(defaults) as Array<keyof Settings>) {
    it(`${key}: never throws, ends valid, and a value of the wrong kind gives the default`, () => {
      for (const [name, bad] of BAD_VALUES) {
        const state = { ...clone(base), settings: { ...defaults, [key]: bad } }
        let out: Settings
        try {
          out = norm(state).settings
        } catch (error) {
          throw new Error(`${key} = ${name}: normalize threw ${String(error)}`)
        }
        expect((VALID[key] as (value: unknown) => boolean)(out[key]), `${key} = ${name} gave ${show(out[key])}`).toBe(true)
        // A protection of « Renforcée » of the wrong kind is off, as it was before that default: a damaged value never switches one on. The baseline
        // they are compared with is the earlier profile's then, never the one of a new profile.
        if (kindOf(bad) !== kindOf(defaults[key])) {
          const earlier = { ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: PROTECTION_BASELINE_OF_EARLIER_PROFILES } as Partial<Settings>
          expect(out[key], `${key} = ${name}`).toEqual(Object.hasOwn(earlier, key) ? earlier[key] : defaults[key])
        }
        // The other settings are not touched by the bad one.
        for (const other of Object.keys(defaults) as Array<keyof Settings>) if (other !== key) expect(out[other], `${other} next to ${key} = ${name}`).toEqual(defaults[other])
      }
    })
  }

  it('settings that are not a record at all give the defaults, not the characters of a string or the cells of an array', () => {
    for (const [name, bad] of BAD_VALUES) {
      const out = norm({ ...clone(base), settings: bad }).settings
      // Whatever the file holds under `settings`, it is the file of an existing profile: the protection it does not name is the one of an existing
      // profile, never the « Renforcée » of a new one (a first launch reads no file).
      expect(out, name).toStrictEqual({ ...defaults, ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: PROTECTION_BASELINE_OF_EARLIER_PROFILES })
    }
    const { settings: _gone, ...withoutSettings } = clone(base)
    expect(norm(withoutSettings).settings).toStrictEqual({ ...defaults, ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: PROTECTION_BASELINE_OF_EARLIER_PROFILES })
    expect(keysOf(norm({ ...clone(base), settings: 'abc' }).settings)).not.toContain('0')
  })

  it('keeps a valid value next to bad ones, and cuts a number to its bounds', () => {
    const out = norm({ ...clone(base), settings: { ...rich().settings, sidebarWidth: 1e9, sidePanelWidth: -5, filterUpdateDays: 'mille', sleepAfterMinutes: 20 } }).settings
    expect(out).toMatchObject({ sidebarWidth: SIDEBAR_WIDTH_MAX, sidePanelWidth: SIDE_PANEL_WIDTH_MIN, filterUpdateDays: defaults.filterUpdateDays, sleepAfterMinutes: 20, blockAds: true, appIcon: APP_ICONS[1]!.id })
  })

  it('treats the NaN a width written as JSON becomes (null) as "no value", not as zero', () => {
    const out = parseSavedState(JSON.stringify({ ...rich(), settings: { ...rich().settings, sidebarWidth: NaN, sidePanelWidth: Infinity } })).settings
    expect(out.sidebarWidth).toBe(defaults.sidebarWidth)
    expect(out.sidePanelWidth).toBe(defaults.sidePanelWidth)
  })

  it('cleans the items of a list setting one by one instead of losing or keeping the whole list', () => {
    const out = norm({
      ...clone(base),
      settings: {
        ...defaults,
        siteSearches: [null, 'yt', { keyword: 'ok', name: 'Bon', url: 'https://ok.example/?q=%s' }, { keyword: 'bad key', name: 'x', url: 'https://x.example/?q=%s' }, { keyword: 'nourl', name: 'x', url: 'javascript:alert(1)%s' }, { keyword: 'ok', name: 'Doublon', url: 'https://d.example/?q=%s' }],
        extensionPaths: ['/bon/chemin', 'relatif/chemin', 42, '/avec\u0000nul', '/bon/chemin', ''],
        linkRoutes: [{ host: 'github.com', spaceId: 'sp-work' }, { host: 5, spaceId: 'sp-work' }, { host: 'x.org' }, null]
      }
    }).settings
    // The one usable shortcut is kept, and only it: the list is the user's, the defaults are not added to it.
    expect(out.siteSearches).toEqual([{ keyword: 'ok', name: 'Bon', url: 'https://ok.example/?q=%s' }])
    expect(out.extensionPaths).toEqual(['/bon/chemin'])
    expect(out.linkRoutes).toEqual([{ host: 'github.com', spaceId: 'sp-work' }])
  })

  it('cleans the extensions switched off in a profile one by one, and a Web Store update mode that is not one of the three keeps updates manual', () => {
    const good = 'a'.repeat(32)
    const out = norm({
      ...clone(base),
      settings: {
        ...defaults,
        webStoreUpdates: 'toutes-les-minutes',
        profiles: {
          work: { disabledExtensions: [good, good, 'trop-court', 7, null, 'A'.repeat(32), `${good}/`, 'q'.repeat(32), 'b'.repeat(32)] },
          vide: { disabledExtensions: ['nope'] },
          autre: { disabledExtensions: 'pas une liste' }
        }
      }
    }).settings
    expect(out.webStoreUpdates).toBe('manual')
    expect(out.profiles).toEqual({ work: { disabledExtensions: [good, 'b'.repeat(32)] } })
    for (const bad of ['toutes-les-minutes', 3, null, true, { daily: 1 }]) {
      expect(norm({ ...clone(base), settings: { ...defaults, webStoreUpdates: bad } }).settings.webStoreUpdates, String(bad)).toBe('manual')
    }
    for (const mode of ['manual', 'daily', 'weekly']) expect(norm({ ...clone(base), settings: { ...defaults, webStoreUpdates: mode } }).settings.webStoreUpdates).toBe(mode)
    // A damaged value of the install switch falls back to the default (on): installing still needs a click on the store's own page.
    expect(norm({ ...clone(base), settings: { ...defaults, webStoreInstall: 'oui' } }).settings.webStoreInstall).toBe(true)
  })

  it('does not read a list as a dictionary: its indexes are not profile ids, host names or commands', () => {
    const out = norm({
      ...clone(base),
      settings: { ...defaults, profiles: [{ searchSuggestions: false }], profileNames: ['Travail'], keyBindings: [''], siteZoom: [1.5], sidePanelWidth: [400] }
    }).settings
    expect(out).toStrictEqual(defaults)
  })

  it('cuts a profile name at its limit without leaving a space at the end, so that loading it again changes nothing', () => {
    const long = `${'a'.repeat(PROFILE_NAME_MAX - 1)} suite du nom`
    const first = norm({ ...clone(base), settings: { ...defaults, profileNames: { work: long } } }).settings.profileNames
    expect(first).toEqual({ work: 'a'.repeat(PROFILE_NAME_MAX - 1) })
  })

  it('cleans the privacy settings of this wave one by one: an unknown autoplay word is Chromium\'s policy, hosts are canonical, lists are well formed', () => {
    const out = norm({
      ...clone(base),
      settings: {
        ...defaults,
        autoplayPolicy: 'user-gesture-required',
        spellCheck: 'maybe',
        siteAutoplay: { 'Example.com': 'allow', 'www.news.example': 'block', 'ok.example': 'always', 'a b': 'allow', 'sans-point-de-vue.example': 5 },
        siteDataClearOnClose: ['Example.ORG', 'https://pas-un-hote.example/chemin', 42, null, 'example.org', 'localhost:3000', 'a b', 'example.com:99999'],
        siteDataClearOnQuit: 'yes',
        siteDataClearOnCloseEnabled: 'yes',
        autoplayPerSite: 0,
        customFilterListsEnabled: null,
        customFilterLists: [
          { id: 'custom-0123abcd', title: '  Bonne\u0000liste ', source: 'file', sourceName: 'x.txt', enabled: 'peut-être', addedAt: 'hier' },
          { id: 'custom-0123abcd', title: 'Doublon', source: 'file', sourceName: 'y.txt', enabled: true, addedAt: 1 },
          { id: '../../etc/passwd', title: 'Chemin', source: 'file', sourceName: 'z.txt', enabled: true, addedAt: 1 },
          { id: 'custom-ffffffff', title: '', source: 'file', sourceName: 'w.txt', enabled: true, addedAt: 1 },
          { id: 'custom-eeeeeeee', title: 'Source inconnue', source: 'url', sourceName: 'https://x.example/l.txt', enabled: true, addedAt: 1 },
          'custom-dddddddd',
          null
        ]
      }
    }).settings
    expect(out.autoplayPolicy).toBe('block')
    expect(out.spellCheck).toBe('auto')
    expect(out.siteAutoplay).toEqual({ 'example.com': 'allow', 'news.example': 'block' })
    expect(out.siteDataClearOnClose).toEqual(['example.org', 'localhost:3000'])
    expect(out.siteDataClearOnQuit).toBe(false)
    // A switch that is not a flag falls back to its default: the erasure stays off, the other two stay on.
    expect([out.siteDataClearOnCloseEnabled, out.autoplayPerSite, out.customFilterListsEnabled]).toEqual([false, true, true])
    expect(out.customFilterLists).toEqual([{ id: 'custom-0123abcd', title: 'Bonne liste', source: 'file', sourceName: 'x.txt', enabled: true, addedAt: 0 }])
  })

  it('cleans the recent sites of the site data panel one by one: valid hosts only, spelled once, newest first, no more than the list keeps', () => {
    const many = Array.from({ length: SITE_DATA_RECENTS_MAX + 5 }, (_, i) => `site${i}.example.org`)
    const out = norm({
      ...clone(base),
      settings: { ...defaults, siteDataRecents: ['Exemple.ORG', 'https://pas-un-hote.example/chemin', 42, null, 'exemple.org', 'localhost:3000', 'a b', 'example.com:99999', '__proto__', ...many] }
    }).settings.siteDataRecents
    expect(out.slice(0, 2)).toEqual(['exemple.org', 'localhost:3000'])
    expect(out).toHaveLength(SITE_DATA_RECENTS_MAX)
    expect(out).not.toContain('__proto__')
    expect(out.every((host) => parseSiteHost(host)?.host === host)).toBe(true)
  })

  it('keeps the search switches as the flags they are, with their defaults when they are missing or wrong', () => {
    expect(defaults).toMatchObject({ suggestHistory: true, suggestTabs: true, suggestArchive: true, suggestReadLater: true, searchBangs: true, searchDiscovery: false, commandBarCalc: true, findRegex: false })
    for (const bad of ['oui', 1, null, [], {}]) {
      const out = norm({ ...clone(base), settings: { ...defaults, suggestHistory: bad, suggestTabs: bad, suggestArchive: bad, suggestReadLater: bad, searchBangs: bad, searchDiscovery: bad, commandBarCalc: bad, findRegex: bad } }).settings
      expect([out.suggestHistory, out.suggestTabs, out.suggestArchive, out.suggestReadLater, out.searchBangs, out.searchDiscovery, out.commandBarCalc, out.findRegex], JSON.stringify(bad)).toEqual([true, true, true, true, true, false, true, false])
    }
  })

  it('keeps the size and the shape of the command bar to their words, and gives back the card it always had for anything else', () => {
    expect(defaults).toMatchObject({ commandBarSize: 'm', commandBarShape: 'balanced' })
    // The words themselves go through whole.
    for (const size of COMMAND_BAR_SIZES) for (const shape of COMMAND_BAR_SHAPES) {
      const out = norm({ ...clone(base), settings: { ...defaults, commandBarSize: size, commandBarShape: shape } }).settings
      expect([out.commandBarSize, out.commandBarShape]).toEqual([size, shape])
    }
    // A word of the other menu, a wrong case, a number, a list, nothing: the default.
    for (const bad of ['wide', 'XL', 'xxl', '', 1, null, [], {}, undefined]) {
      const out = norm({ ...clone(base), settings: { ...defaults, commandBarSize: bad } }).settings
      expect(out.commandBarSize, JSON.stringify(bad)).toBe('m')
    }
    for (const bad of ['xl', 'Wide', 'round', '', 1, null, [], {}, undefined]) {
      const out = norm({ ...clone(base), settings: { ...defaults, commandBarShape: bad } }).settings
      expect(out.commandBarShape, JSON.stringify(bad)).toBe('balanced')
    }
    // A file written before these settings existed has neither: the card is the one it always was.
    const { commandBarSize: _size, commandBarShape: _shape, ...older } = defaults
    expect(norm({ ...clone(base), settings: older }).settings).toMatchObject({ commandBarSize: 'm', commandBarShape: 'balanced' })
    // And an update from the interface goes through the same cleaning.
    const changed = reduce(norm(clone(base)), { type: 'settings/update', patch: { commandBarSize: 'huge' as never, commandBarShape: 'tall' } }, { now: 1, newId: () => 'x' })
    expect([changed.settings.commandBarSize, changed.settings.commandBarShape]).toEqual(['m', 'tall'])
  })

  it('keeps the switch of the web hardware APIs off unless the file says true: a wrong value never turns it on', () => {
    expect(defaults.webHardware).toBe(false)
    for (const bad of ['oui', 'true', 1, null, [], {}, undefined]) {
      expect(norm({ ...clone(base), settings: { ...defaults, webHardware: bad } }).settings.webHardware, JSON.stringify(bad)).toBe(false)
    }
    expect(norm({ ...clone(base), settings: { ...defaults, webHardware: true } }).settings.webHardware).toBe(true)
  })

  it('keeps the capture and automation switches as the flags they are, off when they are missing or wrong', () => {
    expect(defaults).toMatchObject({ annotateCapture: false, urlAutomation: false })
    for (const bad of ['oui', 1, null, [], {}]) {
      const out = norm({ ...clone(base), settings: { ...defaults, annotateCapture: bad, urlAutomation: bad } }).settings
      expect([out.annotateCapture, out.urlAutomation], JSON.stringify(bad)).toEqual([false, false])
    }
    // Each setting is read for itself: one at true does not drag the other along.
    const only = norm({ ...clone(base), settings: { ...defaults, annotateCapture: true, urlAutomation: false } }).settings
    expect([only.annotateCapture, only.urlAutomation]).toEqual([true, false])
  })

  it('cleans the sites already offered their search one by one: valid host names only, each once, the newest kept when the list is too long', () => {
    const many = Array.from({ length: SEARCH_DISCOVERY_SEEN_MAX + 5 }, (_, i) => `site${i}.example.org`)
    const out = norm({
      ...clone(base),
      settings: { ...defaults, searchDiscoverySeen: ['Exemple.ORG', 'https://pas-un-hote.example/chemin', 42, null, 'a b', 'example.com:99999', '__proto__', 'ok.example.org', 'ok.example.org', '', 'x'.repeat(300), ...many] }
    }).settings.searchDiscoverySeen
    expect(out).toHaveLength(SEARCH_DISCOVERY_SEEN_MAX)
    expect(out.at(-1)).toBe(many.at(-1))
    expect(out).not.toContain('__proto__')
    expect(out.every((host) => /^[a-z0-9.-]+$/.test(host))).toBe(true)
    expect(norm({ ...clone(base), settings: { ...defaults, searchDiscoverySeen: ['ok.example.org', 'b.example.org', 'ok.example.org'] } }).settings.searchDiscoverySeen).toEqual(['b.example.org', 'ok.example.org'])
    for (const bad of ['texte', 7, null, {}, [[]]]) expect(norm({ ...clone(base), settings: { ...defaults, searchDiscoverySeen: bad } }).settings.searchDiscoverySeen).toEqual([])
  })

  it('keeps the confirmation, the panel closing and the notices as the flags they are, with the extension’s defaults when they are missing or wrong', () => {
    expect(defaults).toMatchObject({ siteDataConfirm: false, siteDataAutoClose: true, siteDataNotify: true, siteDataHttp: false, siteDataAnimation: 'spinner' })
    for (const bad of ['oui', 1, null, [], {}]) {
      const out = norm({ ...clone(base), settings: { ...defaults, siteDataConfirm: bad, siteDataAutoClose: bad, siteDataNotify: bad, siteDataHttp: bad, siteDataAnimation: bad } }).settings
      expect([out.siteDataConfirm, out.siteDataAutoClose, out.siteDataNotify, out.siteDataHttp, out.siteDataAnimation], JSON.stringify(bad)).toEqual([false, true, true, false, 'spinner'])
    }
  })

  it('blockExceptions and the other host lists stay what their own cleaners say', () => {
    expect(norm({ ...clone(base), settings: { ...defaults, blockExceptions: ['https://www.Exemple.org/x', 'pas un hôte', 4] } }).settings.blockExceptions).toEqual(cleanBlockExceptions(['https://www.Exemple.org/x']))
  })
})

// ---------- (b) bis: any value at any place of a valid state ----------

describe('any part of a valid state replaced by something else', () => {
  const FUZZ: Array<[string, unknown]> = [
    ['supprimé', REMOVE],
    ['null', null],
    ['texte', 'texte'],
    ['vide', ''],
    ['zéro', 0],
    ['négatif', -1],
    ['très grand', 1e308],
    ['NaN', NaN],
    ['true', true],
    ['tableau', []],
    ['tableau mélangé', [null, 1, 'a', {}]],
    ['objet', {}],
    ['objet hostile', HOSTILE_OBJECT()],
    ['très long', 'x'.repeat(5_000)],
    ['contrôle', 'a\u0000b\nc\u001b']
  ]

  type Path = Array<string | number>
  function pathsOf(value: unknown, prefix: Path = [], depth = 0, out: Path[] = []): Path[] {
    out.push(prefix)
    if (depth >= 5) return out
    if (Array.isArray(value)) value.slice(0, 3).forEach((v, i) => pathsOf(v, [...prefix, i], depth + 1, out))
    else if (isRecord(value)) for (const k of Object.keys(value)) pathsOf(value[k], [...prefix, k], depth + 1, out)
    return out
  }
  function replaced(root: unknown, path: Path, value: unknown): unknown {
    if (path.length === 0) return value
    const [head, ...rest] = path as [string | number, ...Path]
    const copy: unknown = Array.isArray(root) ? [...root] : { ...(root as Record<string, unknown>) }
    const holder = copy as Record<string | number, unknown>
    if (rest.length === 0 && value === REMOVE) delete holder[head]
    else holder[head] = replaced(holder[head], rest, value)
    return copy
  }

  const base = rich()
  // The settings are covered one by one above; here only the settings object itself (as a whole) is replaced.
  const paths = pathsOf(base).filter((p) => p[0] !== 'settings' || p.length <= 1)

  it('walks every part of the state: more than a hundred places', () => {
    expect(paths.length).toBeGreaterThan(100)
  })

  // One test for each value: the whole walk is twenty seconds of processor, a value alone a little more than one, and a failure names its value.
  // Every field of the model adds places to walk, and a machine with every core taken stretches each walk several times: hence the 60 s.
  it.each(FUZZ)('never throws and always ends well formed, idempotent and JSON-stable: %s', { timeout: 60_000 }, (name, value) => {
    const failures: string[] = []
    for (const path of paths) {
      const found = loadedProblems(replaced(base, path, value))
      if (found.length > 0) failures.push(`${path.join('.') || '(racine)'} = ${name}: ${found.slice(0, 3).join(' ; ')}`)
    }
    expect(failures.slice(0, 25)).toEqual([])
  })
})

// ---------- (c) inconsistent structures ----------

describe('structures that contradict each other', () => {
  const tab = (id: string, spaceId: string, over: Record<string, unknown> = {}) => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2, ...over })
  const folder = (id: string, spaceId: string, over: Record<string, unknown> = {}) => ({ id, spaceId, name: id, collapsed: false, ...over })
  const withParts = (parts: Record<string, unknown>) => ({ ...clone(rich()), ...parts })

  it('drops the tab of a space that does not exist and keeps the others', () => {
    const state = norm(withParts({ tabs: [tab('ok', 'sp-home'), tab('lost', 'ghost'), tab('also-ok', 'sp-work')] }))
    expect(state.tabs.map((t) => t.id)).toEqual(['ok', 'also-ok'])
  })

  it('forgets the folder of a tab when it does not exist or belongs to another space, and keeps the tab', () => {
    const state = norm(
      withParts({
        folders: [folder('f-home', 'sp-home'), folder('f-work', 'sp-work')],
        tabs: [tab('a', 'sp-home', { pinned: true, folderId: 'ghost' }), tab('b', 'sp-home', { pinned: true, folderId: 'f-work' }), tab('c', 'sp-home', { pinned: true, folderId: 'f-home' })]
      })
    )
    expect(state.tabs.map((t) => [t.id, t.folderId])).toEqual([['a', undefined], ['b', undefined], ['c', 'f-home']])
    expect(state.tabs.every((t) => !('folderId' in t) || t.folderId !== undefined)).toBe(true)
  })

  it('cuts a folder loop, a folder in itself, a parent in another space and a tree deeper than the limit, losing no folder', () => {
    const chain = Array.from({ length: FOLDER_MAX_DEPTH + 3 }, (_, i) => folder(`c${i}`, 'sp-home', i === 0 ? {} : { parentId: `c${i - 1}` }))
    const folders = [
      folder('a', 'sp-home', { parentId: 'b' }),
      folder('b', 'sp-home', { parentId: 'a' }),
      folder('self', 'sp-home', { parentId: 'self' }),
      folder('abroad', 'sp-home', { parentId: 'elsewhere' }),
      folder('elsewhere', 'sp-work'),
      folder('orphan', 'sp-home', { parentId: 'nobody' }),
      ...chain
    ]
    const state = norm(withParts({ folders, tabs: [tab('in-deep', 'sp-home', { pinned: true, folderId: `c${chain.length - 1}` })] }))
    expect(problems(state)).toEqual([])
    expect(state.folders.map((f) => f.id).sort()).toEqual(folders.map((f) => f.id).sort())
    expect(state.tabs.map((t) => t.id)).toEqual(['in-deep'])
    expect(state.tabs[0]!.folderId).toBe(`c${chain.length - 1}`)
    expect(Math.max(...state.folders.map((f) => folderDepth(state.folders, f.id)))).toBe(FOLDER_MAX_DEPTH)
  })

  it('leaves no space without a valid selection: missing, unknown, or a tab of another space all mean none', () => {
    const state = norm(
      withParts({
        spaces: [...rich().spaces, { id: 'sp-third', name: 'Troisième', emoji: '3', theme: defaultTheme(), profileId: 'default' }],
        tabs: [tab('home-tab', 'sp-home'), tab('work-tab', 'sp-work')],
        activeTabBySpace: { 'sp-home': 'work-tab', 'sp-work': 'ghost', stale: 'home-tab' }
      })
    )
    expect(state.activeTabBySpace).toEqual({ 'sp-home': null, 'sp-work': null, 'sp-third': null })
  })

  it('keeps a valid selection, even in a space whose id is a name every object inherits', () => {
    const state = norm({
      ...clone(rich()),
      spaces: ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((id) => ({ id, name: id, emoji: 'e', theme: defaultTheme(), profileId: 'default' })),
      tabs: [tab('t1', 'constructor'), tab('t2', 'toString'), tab('t3', '__proto__'), tab('t4', 'hasOwnProperty')],
      folders: [],
      splits: [],
      archive: [],
      activeSpaceId: 'toString',
      activeTabBySpace: JSON.parse('{"constructor":"t1","toString":"t2","__proto__":"t3","hasOwnProperty":"t4"}')
    })
    expect(problems(state)).toEqual([])
    expect(state.spaces.map((s) => s.id)).toEqual(['constructor', 'toString', 'hasOwnProperty'])
    expect(state.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't4'])
    expect(state.activeTabBySpace).toStrictEqual({ constructor: 't1', toString: 't2', hasOwnProperty: 't4' })
    expect(state.activeSpaceId).toBe('toString')
  })

  it('shrinks or dissolves a split view that points at tabs that are gone, mixed spaces or already used', () => {
    const split = (id: string, tabIds: unknown, over: Record<string, unknown> = {}) => ({ id, spaceId: 'sp-home', tabIds, orientation: 'horizontal', ratios: [0.5, 0.5], ...over })
    const state = norm(
      withParts({
        tabs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => tab(id, 'sp-home')).concat(tab('w', 'sp-work')),
        splits: [
          split('gone', ['a', 'nope']), // one live tab left: dissolves
          split('shrinks', ['b', 'c', 'nope'], { ratios: [0.3, 0.3, 0.4] }), // two left: equal halves
          split('mixed', ['d', 'w']), // a tab of another space: dissolves
          split('reuses', ['b', 'e']), // `b` is taken by the split above: dissolves
          split('not-a-list', 'de'),
          split('numbers', 42),
          split('too-many', ['d', 'e', 'f', 'g', 'a'], { ratios: [0.2, 0.2, 0.2, 0.2, 0.2] }),
          null,
          'split'
        ]
      })
    )
    expect(problems(state)).toEqual([])
    expect(state.splits.map((s) => [s.id, s.tabIds])).toEqual([['shrinks', ['b', 'c']], ['too-many', ['d', 'e', 'f', 'g']]])
    expect(state.splits[0]!.ratios).toEqual([0.5, 0.5])
  })

  it('repairs the ratios and the orientation of a split view instead of laying the panes out with garbage', () => {
    const base = { id: 'sv', spaceId: 'sp-home', tabIds: ['x', 'y', 'z'] }
    const bad: unknown[] = [[0.5, 0.5], [NaN, 0.5, 0.5], [null, null, null], [-1, 1, 1], [0, 0.5, 0.5], [0.9, 0.9, 0.9], [0.01, 0.01, 0.98], 'texte', {}, undefined, [Infinity, 0, 0]]
    for (const ratios of bad) {
      for (const orientation of ['diagonal', null, 3, 'vertical']) {
        const state = norm(withParts({ tabs: ['x', 'y', 'z'].map((id) => tab(id, 'sp-home')), splits: [{ ...base, ratios, orientation }] }))
        expect(problems(state), JSON.stringify([ratios, orientation])).toEqual([])
        expect(state.splits[0]!.ratios).toHaveLength(3)
        expect(state.splits[0]!.orientation).toBe(orientation === 'vertical' ? 'vertical' : 'horizontal')
      }
    }
    expect(norm(withParts({ tabs: ['x', 'y', 'z'].map((id) => tab(id, 'sp-home')), splits: [{ ...base, ratios: [0.2, 0.3, 0.5] }] })).splits[0]!.ratios).toEqual([0.2, 0.3, 0.5])
  })

  it('falls back to the first space when the active one is unknown, missing or not a text', () => {
    for (const activeSpaceId of ['ghost', null, 42, {}, [], '', undefined]) {
      expect(norm(withParts({ activeSpaceId })).activeSpaceId, String(activeSpaceId)).toBe('sp-home')
    }
    expect(norm(withParts({ activeSpaceId: 'sp-work' })).activeSpaceId).toBe('sp-work')
  })

  it('keeps the first of several entries sharing an id, for every kind of entry', () => {
    const state = norm(
      withParts({
        spaces: [...rich().spaces, { ...rich().spaces[0]!, name: 'Copie' }],
        tabs: [tab('dup', 'sp-home', { title: 'premier' }), tab('dup', 'sp-work', { title: 'second' })],
        folders: [folder('fd', 'sp-home', { name: 'premier' }), folder('fd', 'sp-work', { name: 'second' })],
        favorites: [{ id: 'fv', url: 'https://one.example/', title: 'premier' }, { id: 'fv', url: 'https://two.example/', title: 'second' }],
        archive: [{ id: 'ar', spaceId: 'sp-home', url: 'https://one.example/', title: 'premier', archivedAt: 1 }, { id: 'ar', spaceId: 'sp-home', url: 'https://two.example/', title: 'second', archivedAt: 2 }],
        splits: [],
        boosts: [{ id: 'bo', host: 'one.example' }, { id: 'bo', host: 'two.example' }]
      })
    )
    expect(problems(state)).toEqual([])
    expect(state.spaces.map((s) => s.name)).toEqual(['Perso', 'Travail'])
    expect(state.tabs.map((t) => t.title)).toEqual(['premier'])
    expect(state.folders.map((f) => f.name)).toEqual(['premier'])
    // The two spaces use two profiles: the favourite is copied to each (favorite-scope.ts), still once in each.
    expect(state.favorites.filter((f) => f.profileId === 'default').map((f) => f.title)).toEqual(['premier'])
    expect(state.archive.map((a) => a.title)).toEqual(['premier'])
    // A Tweak is a user's work: a second one with the same id is renamed apart rather than dropped.
    expect(state.boosts.map((b) => b.host)).toEqual(['one.example', 'two.example'])
    expect(new Set(state.boosts.map((b) => b.id)).size).toBe(2)
  })

  it('keeps the valid entries of a list that holds garbage', () => {
    const state = norm(
      withParts({
        tabs: [null, 5, 'tab', [], tab('ok1', 'sp-home'), { id: 'no-space', url: 'https://x.example/' }, tab('ok2', 'sp-home', { url: 'javascript:alert(1)' }), tab('ok3', 'sp-home', { url: 7 }), tab('ok4', 'sp-home'), { ...tab('ok5', 'sp-home'), id: 5 }],
        folders: [undefined, folder('f1', 'sp-home'), { id: 'f2' }, 'x'],
        favorites: [null, { id: 'fav', url: 'https://f.example/', title: 'F' }, { id: 'bad', url: 'data:text/html,x', title: 'x' }],
        archive: [3, { id: 'ar', spaceId: 'sp-home', url: 'https://a.example/', title: 'A', archivedAt: 1 }, { id: 'orphan', spaceId: 'ghost', url: 'https://a.example/', title: 'A', archivedAt: 1 }],
        boosts: [null, { id: 'b1', host: 'ok.example' }, { id: 'b2' }, { id: 'b3', host: 5 }, { id: 'b4', host: '   ' }, 'boost']
      })
    )
    expect(problems(state)).toEqual([])
    expect(state.tabs.map((t) => t.id)).toEqual(['ok1', 'ok4'])
    expect(state.folders.map((f) => f.id)).toEqual(['f1'])
    expect(state.favorites.filter((f) => f.profileId === 'default').map((f) => f.id)).toEqual(['fav'])
    expect(state.archive.map((a) => a.id)).toEqual(['ar'])
    expect(state.boosts.map((b) => b.host)).toEqual(['ok.example'])
  })

  it('refuses addresses the engine would throw on, in tabs, pinned anchors, favorites and the archive', () => {
    const state = norm(
      withParts({
        tabs: [tab('js', 'sp-home', { url: 'javascript:alert(1)' }), tab('data', 'sp-home', { url: 'data:text/html,<b>x</b>' }), tab('blank', 'sp-home', { url: 'about:blank' }), tab('src', 'sp-home', { url: 'view-source:https://a.example/' }), tab('anchor', 'sp-home', { pinned: true, anchorUrl: 'javascript:alert(1)' }), tab('chrome', 'sp-home', { url: 'chrome://settings' }), tab('space', 'sp-home', { url: 'http://mon site/' }), tab('bare', 'sp-home', { url: 'https://' }), tab('empty', 'sp-home', { url: '' })],
        favorites: [{ id: 'f', url: 'javascript:alert(1)', title: 'x' }, { id: 'g', url: 'https://', title: 'x' }],
        archive: [{ id: 'a', spaceId: 'sp-home', url: 'vbscript:x', title: 'x', archivedAt: 1 }]
      })
    )
    expect(state.tabs.map((t) => t.id)).toEqual(['blank', 'src', 'anchor'])
    expect(state.tabs[2]).not.toHaveProperty('anchorUrl')
    expect(state.favorites).toEqual([])
    expect(state.archive).toEqual([])
  })

  it('always ends with a space, and an active tab list that follows the spaces, whatever the collections are', () => {
    for (const spaces of [undefined, null, [], 'text', {}, [null], [{ id: 3 }]]) {
      const state = norm({ ...clone(rich()), spaces })
      expect(problems(state), show(spaces)).toEqual([])
    }
    for (const part of ['tabs', 'folders', 'favorites', 'archive', 'splits', 'boosts', 'activeTabBySpace', 'sitePermissions', 'sidePanelBehavior', 'commandBarUsage']) {
      for (const bad of [undefined, null, 'text', 7, true, [], {}]) {
        expect(problems(norm({ ...clone(rich()), [part]: bad })), `${part} = ${JSON.stringify(bad)}`).toEqual([])
      }
    }
  })

  it('survives a state that is not an object at all', () => {
    for (const value of [null, undefined, 'text', 7, [], true]) expect(problems(norm(value)), String(value)).toEqual([])
  })

  it('repairs the fields of every entry: wrong kinds, controls, huge texts', () => {
    const state = norm(
      withParts({
        spaces: [{ id: 'sp', name: 5, emoji: null, theme: 'dark', profileId: '../../etc', hideHeader: 'yes' }, { id: 'sp2', name: '\u0000\n', emoji: 'e'.repeat(1000), theme: null, profileId: 7 }, { id: 'sp3', name: 'n'.repeat(10_000), emoji: '🏠', profileId: 'x'.repeat(100) }, { id: 'sp4', name: 'Vieux', emoji: 'v', hue: 100, saturation: 'x', grain: 1000 }],
        tabs: [tab('t', 'sp', { title: 'Ligne 1\nLigne 2\u0000', pinned: 'yes', createdAt: 'hier', lastActiveAt: NaN, customTitle: 'c'.repeat(1000), icon: 42, keepAwake: 'oui', faviconUrl: 7, deadKept: { url: 'javascript:alert(1)', at: 5 } }), tab('big', 'sp', { title: 'T'.repeat(100_000), deadKept: { url: 'https://big.example/', at: -5 } })],
        folders: [folder('f', 'sp', { name: ['x'], collapsed: 'peut-être', parentId: 5 })],
        activeSpaceId: 'sp',
        activeTabBySpace: { sp: 't' }
      })
    )
    expect(problems(state)).toEqual([])
    expect(state.spaces[0]).toMatchObject({ id: 'sp', profileId: 'default' })
    // A name that is no text or blank gets the default one; a huge one is cut to its limit; an emoji that is a line of text is the default glyph.
    expect(state.spaces.map((s) => [s.name, s.emoji])).toEqual([['Espace', '✨'], ['Espace', '✨'], ['n'.repeat(NAME_MAX), '🏠'], ['Vieux', 'v']])
    expect(state.tabs[0]).toMatchObject({ id: 't', title: 'Ligne 1 Ligne 2 ', pinned: false, createdAt: 0, lastActiveAt: 0 })
    // A huge title is cut to its limit, not dropped for the name of the site.
    expect(state.tabs[1]!.title).toBe('T'.repeat(TITLE_MAX))
    // The mark of a tab kept while its site did not answer: an address the engine can load and a time, or nothing.
    expect(state.tabs.map((t) => t.deadKept)).toEqual([undefined, undefined])
    expect(state.folders[0]).toMatchObject({ id: 'f', collapsed: false })
    expect(state.activeTabBySpace['sp']).toBe('t')
  })

  it('keeps the coloured-letter icon of a space only when it is made of letters, a #rrggbb colour and a kind the space can show', () => {
    const base = { id: 'sp', name: 'S', emoji: 'e', profileId: 'default' }
    const kept = (extra: Record<string, unknown>) => norm(withParts({ spaces: [{ ...base, ...extra }] })).spaces[0]!
    // Letters: two letters or digits in capitals; everything else a file could put there is dropped.
    expect(kept({ iconLetter: 'ac' }).iconLetter).toBe('AC')
    expect(kept({ iconLetter: 'abcdef' }).iconLetter).toBe('AB')
    expect(kept({ iconLetter: ' \u202e<b> ' }).iconLetter).toBe('B')
    for (const hostile of ['', '   ', '😀', '\u0000\n', '<>"\'', 7, null, ['A'], {}, true]) expect(kept({ iconLetter: hostile }).iconLetter, show(hostile)).toBeUndefined()
    // The colour ends up in a style: only #rrggbb gets through.
    expect(kept({ iconColor: '#2F9E63' }).iconColor).toBe('#2f9e63')
    for (const hostile of ['red', '#fff', '#12345g', 'url(https://evil.example/x)', '#123456; background: url(x)', '#1234567', 7, null, {}]) expect(kept({ iconColor: hostile }).iconColor, show(hostile)).toBeUndefined()
    expect(kept({ iconRound: true }).iconRound).toBe(true)
    for (const hostile of ['yes', 1, null]) expect(kept({ iconRound: hostile }).iconRound, show(hostile)).toBeUndefined()
    // A kind needs what it shows: a letter kind without letters and a picture kind without a picture fall back to the emoji.
    expect(kept({ iconKind: 'letter', iconLetter: 'AC' }).iconKind).toBe('letter')
    expect(kept({ iconKind: 'letter' }).iconKind).toBeUndefined()
    expect(kept({ iconKind: 'letter', iconLetter: '😀' }).iconKind).toBeUndefined()
    expect(kept({ iconKind: 'image' }).iconKind).toBeUndefined()
    expect(kept({ iconKind: 'image', image: '0123456789abcdef01234567.png' }).iconKind).toBe('image')
    expect(kept({ iconKind: 'emoji' }).iconKind).toBe('emoji')
    for (const hostile of ['video', 7, null, ['emoji'], {}, '__proto__']) expect(kept({ iconKind: hostile, iconLetter: 'A' }).iconKind, show(hostile)).toBeUndefined()
    for (const extra of [{ iconLetter: 'ac', iconColor: 'red', iconKind: 'letter' }, { iconKind: 'image', iconLetter: 5 }]) expect(problems(norm(withParts({ spaces: [{ ...base, ...extra }] }))), show(extra)).toEqual([])
  })

  it('keeps a space\'s picture only when it is the name of a file of ours, and its web panels only when they are web pages', () => {
    const hostile = ['../../etc/passwd', '/Users/me/photo.png', 'photo.png', '0123456789abcdef01234567.png/../x', '0123456789ABCDEF01234567.png', 7, null, ['0123456789abcdef01234567.png'], {}, 'javascript:alert(1)', 'file:///etc/passwd', 'https://evil.example/pic.png']
    for (const image of hostile) {
      const state = norm(withParts({ spaces: [{ id: 'sp', name: 'S', emoji: 'e', profileId: 'default', image }] }))
      expect(state.spaces[0]!.image, show(image)).toBeUndefined()
      expect(problems(state), show(image)).toEqual([])
    }
    const good = norm(withParts({ spaces: [{ id: 'sp', name: 'S', emoji: 'e', profileId: 'default', image: '0123456789abcdef01234567.png' }] }))
    expect(good.spaces[0]!.image).toBe('0123456789abcdef01234567.png')

    const panels = [
      { id: 'a', url: 'https://a.example/', title: 'A' },
      { id: 'b', url: 'javascript:alert(1)', title: 'B' },
      { id: 'c', url: 'file:///etc/passwd', title: 'C' },
      { id: 'd', url: 'https://user:pw@d.example/', title: 'D' },
      { id: 'a', url: 'https://dup.example/', title: 'Same id' },
      { id: 'e', url: 'https://a.example/', title: 'Same address' },
      { id: 'f', url: 'https://f.example/', title: 'F\nline' },
      { id: '__proto__', url: 'https://g.example/' },
      { url: 'https://h.example/' },
      'https://i.example/',
      null
    ]
    const state = norm(withParts({ spaces: [{ id: 'sp', name: 'S', emoji: 'e', profileId: 'default', webPanels: panels }] }))
    expect(state.spaces[0]!.webPanels).toEqual([
      { id: 'a', url: 'https://a.example/', title: 'A' },
      { id: 'f', url: 'https://f.example/', title: 'F line' }
    ])
    expect(problems(state)).toEqual([])
    for (const odd of ['x', 5, {}, [], null, [null]]) {
      const bare = norm(withParts({ spaces: [{ id: 'sp', name: 'S', emoji: 'e', profileId: 'default', webPanels: odd }] }))
      expect('webPanels' in bare.spaces[0]!, show(odd)).toBe(false)
    }
    const flood = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, url: `https://site${i}.example/` }))
    expect(norm(withParts({ spaces: [{ id: 'sp', name: 'S', emoji: 'e', profileId: 'default', webPanels: flood }] })).spaces[0]!.webPanels).toHaveLength(WEB_PANELS_MAX)
  })

  it('keeps the interval of a tab that reloads itself when it can be used, and drops it (never turns it into another interval) when it cannot', () => {
    const cases: Array<[unknown, number | undefined]> = [
      [{ seconds: 30 }, 30],
      [{ seconds: 5 }, 5],
      [{ seconds: 86_400 }, 86_400],
      [{ seconds: 29.6 }, 30],
      [{ seconds: 30, extra: 'x' }, 30],
      [{ seconds: 4 }, undefined],
      [{ seconds: 4.4 }, undefined],
      [{ seconds: 86_401 }, undefined],
      [{ seconds: 0 }, undefined],
      [{ seconds: -30 }, undefined],
      [{ seconds: '30' }, undefined],
      [{ seconds: null }, undefined],
      [{ seconds: NaN }, undefined],
      [{ seconds: Infinity }, undefined],
      [{}, undefined],
      [30, undefined],
      ['30', undefined],
      [true, undefined],
      [[30], undefined],
      [null, undefined]
    ]
    const state = norm(withParts({ tabs: cases.map(([autoReload], i) => tab(`t${i}`, 'sp-home', { autoReload })) }))
    expect(problems(state)).toEqual([])
    expect(state.tabs.map((t) => t.autoReload?.seconds)).toEqual(cases.map(([, expected]) => expected))
    // A dropped interval leaves no key at all (JSON would write a null, and the file would not load back the same).
    expect(state.tabs.filter((t) => 'autoReload' in t).length).toBe(cases.filter(([, expected]) => expected !== undefined).length)
  })

  it('loads a very large state in a reasonable time and keeps all of it (the archive stays within its bound)', () => {
    const spaces = rich().spaces
    const tabs = Array.from({ length: 10_000 }, (_, i) => tab(`t${i}`, i % 2 ? 'sp-home' : 'sp-work', { pinned: i % 7 === 0, folderId: i % 11 === 0 ? `f${i % 50}` : 'ghost' }))
    const folders = Array.from({ length: 2_000 }, (_, i) => folder(`f${i}`, i % 2 ? 'sp-home' : 'sp-work', i % 50 === 0 ? {} : { parentId: `f${i - 1}` }))
    const archive = Array.from({ length: 10_000 }, (_, i) => ({ id: `a${i}`, spaceId: 'sp-home', url: `https://a${i}.example/`, title: 'x', archivedAt: i }))
    const favorites = Array.from({ length: 5_000 }, (_, i) => ({ id: `fv${i}`, url: `https://fv${i}.example/`, title: 'x' }))
    const boosts = Array.from({ length: 2_000 }, (_, i) => ({ id: `b${i}`, host: `h${i}.example` }))
    const splits = Array.from({ length: 2_000 }, (_, i) => ({ id: `sv${i}`, spaceId: 'sp-home', tabIds: [`t${2 * i + 1}`, `t${2 * i + 3}`], orientation: 'horizontal', ratios: [0.5, 0.5] }))
    const text = JSON.stringify({ ...rich(), spaces, tabs, folders, archive, favorites, boosts, splits })
    const started = performance.now()
    const state = parseSavedState(text)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(4_000)
    expect(state.tabs).toHaveLength(10_000)
    expect(state.folders).toHaveLength(2_000)
    expect(state.archive).toHaveLength(500)
    // Each of the two profiles in use gets its own copy of them.
    expect(state.favorites).toHaveLength(10_000)
    expect(state.favorites.filter((f) => f.profileId === 'default')).toHaveLength(5_000)
    expect(state.boosts).toHaveLength(2_000)
    expect(problems(state)).toEqual([])
  })

  it('does not blow up on a hundred thousand useless entries', () => {
    const junk = Array.from({ length: 100_000 }, (_, i) => (i % 3 === 0 ? null : i % 3 === 1 ? i : { id: `x${i}` }))
    const started = performance.now()
    const state = norm({ ...clone(rich()), tabs: junk, folders: junk, favorites: junk, archive: junk, splits: junk, boosts: junk })
    expect(performance.now() - started).toBeLessThan(4_000)
    expect(state.tabs).toEqual([])
    expect(problems(state)).toEqual([])
  })
})

describe('what reaches the state by other doors than the file', () => {
  const ctx = { now: 1, newId: () => 'fresh' }

  it('an import cannot bring an address the engine would refuse to load', () => {
    const current = createInitialState({ now: 1, newId: () => 'sp0' })
    const space = current.spaces[0]!
    const tab = (id: string, url: string): TabItem => ({ id, spaceId: space.id, url, title: id, pinned: true, createdAt: 1, lastActiveAt: 1 })
    const merged = reduce(
      current,
      {
        type: 'import/merge',
        spaces: [],
        tabs: [tab('ok', 'https://ok.example/'), tab('space', 'http://mon site/'), tab('bare', 'https://'), tab('js', 'javascript:alert(1)')],
        folders: [],
        favorites: [{ id: 'f1', url: 'https://', title: 'x' }, { id: 'f2', url: 'https://fav.example/', title: 'ok' }]
      },
      ctx
    )
    expect(merged.tabs.map((t) => t.id)).toEqual(['ok'])
    expect(merged.favorites.map((f) => f.id)).toEqual(['f2'])
  })

  it('a restore keeps this installation\'s extensions, native hosts, update feed and channel, Web Store switches and remembered applications, and takes the rest of the file', () => {
    const current = norm({ ...clone(rich()), settings: { ...rich().settings, extensionPaths: ['/ici/ext'], chromeNativeHosts: false, updateFeedUrl: 'https://ici.example/feed', updateChannel: 'stable', blockAds: false, openWithApps: { pdf: '/Applications/Preview.app' }, webStoreInstall: true, webStoreUpdates: 'manual' } })
    const fromElsewhere = clone(rich())
    fromElsewhere.settings = { ...fromElsewhere.settings, extensionPaths: ['/ailleurs/malveillante'], chromeNativeHosts: true, updateFeedUrl: 'https://ailleurs.example/feed', updateChannel: 'test', blockAds: true, openWithApps: { pdf: '/Users/autre/Downloads/malveillante.app' }, webStoreInstall: false, webStoreUpdates: 'daily' }
    const restored = reduce(current, { type: 'state/restore', state: fromElsewhere }, ctx)
    expect(restored.settings).toMatchObject({ extensionPaths: ['/ici/ext'], chromeNativeHosts: false, updateFeedUrl: 'https://ici.example/feed', updateChannel: 'stable', blockAds: true, webStoreInstall: true, webStoreUpdates: 'manual', openWithApps: { pdf: '/Applications/Preview.app' } })
    expect(restored.tabs.map((t) => t.id)).toEqual(rich().tabs.map((t) => t.id))
  })

  it('an update channel that is not exactly « test » is the stable one, and a file from before the channels follows the stable channel', () => {
    // A damaged or hand-edited file never puts a person on the channel that may carry defects.
    expect(norm(clone(rich())).settings.updateChannel).toBe('test')
    for (const odd of ['Test', 'beta', ' test', 'test ', '', 'x'.repeat(100), 1, null, true, {}, ['test']]) {
      expect(norm({ ...clone(rich()), settings: { ...rich().settings, updateChannel: odd as never } }).settings.updateChannel, JSON.stringify(odd)).toBe('stable')
    }
    const { updateChannel: _gone, ...older } = rich().settings
    expect(norm({ ...clone(rich()), settings: older as never }).settings.updateChannel).toBe('stable')
    expect(defaultSettings().updateChannel).toBe('stable')
  })

  it('a damaged list of remembered applications is rebuilt entry by entry, and nothing named by a file can be an executable type or a program', () => {
    const doc = clone(rich())
    doc.settings = { ...doc.settings, openWithApps: { pdf: '/Applications/Preview.app', sh: '/Applications/Terminal.app', txt: '/bin/sh', png: ['/Applications/X.app'], 'a b': '/Applications/Y.app' } as never }
    expect(norm(doc).settings.openWithApps).toEqual({ pdf: '/Applications/Preview.app' })
    for (const odd of [null, 'x', 5, [], true]) expect(norm({ ...clone(rich()), settings: { ...rich().settings, openWithApps: odd } }).settings.openWithApps).toEqual({})
  })

  it('a file read as a history keeps its good pages and drops the bad ones', () => {
    const history = cleanHistory([
      null,
      'x',
      { url: 'https://ok.example/', title: 'Ok', visitCount: 3, lastVisitAt: 10 },
      { url: 'https://notitle.example/', lastVisitAt: 11 },
      { url: 'https://nodate.example/', title: 'x' },
      { url: 'https://nan.example/', title: 'x', visitCount: NaN, lastVisitAt: NaN },
      { url: 'javascript:alert(1)', title: 'x', lastVisitAt: 1 },
      { url: 5, title: 'x', lastVisitAt: 1 },
      { url: 'https://odd.example/', title: { toString: 'x' }, visitCount: -4, lastVisitAt: 12 }
    ])
    expect(history).toEqual([
      { url: 'https://ok.example/', title: 'Ok', visitCount: 3, lastVisitAt: 10 },
      { url: 'https://notitle.example/', title: 'https://notitle.example/', visitCount: 1, lastVisitAt: 11 },
      { url: 'https://odd.example/', title: 'https://odd.example/', visitCount: 1, lastVisitAt: 12 }
    ])
    expect(cleanHistory('text')).toEqual([])
    expect(cleanHistory(null)).toEqual([])
  })
})

// ---------- (d) normalising twice ----------

describe('normalising twice', () => {
  const HOSTILE_FILE = (): unknown =>
    JSON.parse(`{
      "version": 1, "__proto__": { "polluted": "POLLUTED" }, "extra": "POLLUTED",
      "spaces": [
        { "id": "s1", "name": "  A  ", "emoji": "x", "hue": "rouge", "profileId": "../x", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" },
        { "id": "s2", "name": "B", "emoji": "y", "theme": { "baseColors": ["#zzzzzz", "#112233"], "harmony": "analogous", "angle": 1e9, "intensity": -3 }, "profileId": "work" }
      ],
      "tabs": [
        { "id": "t1", "spaceId": "s1", "url": "https://a.example/", "title": "A", "pinned": true, "folderId": "f2", "constructor": { "prototype": { "polluted": "POLLUTED" } } },
        { "id": "t2", "spaceId": "s2", "url": "https://b.example/", "title": "B", "pinned": false, "createdAt": "x" }
      ],
      "folders": [
        { "id": "f1", "spaceId": "s1", "name": "1", "collapsed": false, "parentId": "f2" },
        { "id": "f2", "spaceId": "s1", "name": "2", "collapsed": true, "parentId": "f1" }
      ],
      "splits": [{ "id": "sv", "spaceId": "s1", "tabIds": ["t1", "t1"], "ratios": [2, -1] }],
      "boosts": [
        { "host": "Example.COM ", "name": "Un", "tint": { "hue": null, "saturation": "x" } },
        { "host": "Example.COM ", "name": "Deux", "zoom": "grand" },
        { "id": "b é", "host": "x.org", "zap": "a", "css": 3 }
      ],
      "sitePermissions": { "https://a.example": { "camera": "maybe", "mic": "allow", "__proto__": "deny" }, "__proto__": { "x": { "y": "allow" } } },
      "commandBarUsage": { "https://a.example/": "3", "https://b.example/": 2, "__proto__": 1, "default": { "https://a.example/": "3", "https://b.example/": 2, "__proto__": 1 } },
      "sidePanelBehavior": { "ext": "yes", "ext2": true },
      "settings": { "sidebarWidth": 264, "profiles": { "__proto__": { "autoArchiveHours": 5 }, "w": { "autoArchiveHours": 4 } }, "unknownSetting": "POLLUTED", "autoArchiveHoursByProfile": "x" },
      "activeSpaceId": "s9",
      "activeTabBySpace": { "s1": "t2", "s2": "t1" }
    }`)

  const fixtures: Array<[string, () => unknown]> = [
    ['current state', () => rich()],
    ['fresh state', () => createInitialState({ now: 1, newId: () => 'only' })],
    ['hostile file', HOSTILE_FILE],
    ['boosts without id on the same host', () => ({ ...clone(rich()), boosts: [{ host: 'Example.COM' }, { host: 'example.com' }, { host: ' www.Example.com ' }] })],
    ['sidebar width of the old default', () => ({ ...clone(rich()), settings: { ...rich().settings, sidebarWidth: 264 } })],
    ['legacy delays per profile', () => ({ ...clone(rich()), settings: { ...rich().settings, autoArchiveHoursByProfile: { work: 6, '../x': 2, ok: 'x' } } })]
  ]

  for (const [name, make] of fixtures) {
    it(`gives the same state the second time: ${name}`, () => {
      const first = norm(make())
      expect(problems(first)).toEqual([])
      expect(norm(first)).toStrictEqual(first)
      expect(norm(clone(first))).toStrictEqual(first)
    })
  }

  it('gives the same boosts when a file has several for one host without an id', () => {
    const first = norm({ ...clone(rich()), boosts: [{ host: 'Example.COM ' }, { host: 'example.com' }] })
    expect(first.boosts).toHaveLength(2)
    expect(new Set(first.boosts.map((b) => b.id)).size).toBe(2)
    expect(norm(first).boosts.map((b) => b.id)).toEqual(first.boosts.map((b) => b.id))
  })
})

// ---------- (e) hostile keys ----------

describe('hostile keys in a file', () => {
  const POLLUTION = `{
    "version": 1,
    "__proto__": { "polluted": "POLLUTED" },
    "constructor": { "prototype": { "polluted": "POLLUTED" } },
    "unknownTopLevel": "POLLUTED",
    "spaces": [{ "id": "s1", "name": "A", "emoji": "x", "profileId": "default", "theme": { "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }, "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "tabs": [{ "id": "t1", "spaceId": "s1", "url": "https://a.example/", "title": "A", "pinned": false, "createdAt": 1, "lastActiveAt": 1, "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "folders": [{ "id": "f1", "spaceId": "s1", "name": "F", "collapsed": false, "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "favorites": [{ "id": "v1", "url": "https://f.example/", "title": "F", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "archive": [{ "id": "a1", "spaceId": "s1", "url": "https://f.example/", "title": "F", "archivedAt": 1, "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "splits": [{ "id": "sv", "spaceId": "s1", "tabIds": ["t1"], "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
    "boosts": [{ "id": "b1", "host": "a.example", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED", "tint": { "__proto__": { "polluted": "POLLUTED" } } }],
    "sessions": [
      { "id": "se1", "name": "S", "createdAt": 1, "tabs": [{ "url": "https://s.example/", "title": "T", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }], "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" },
      { "id": "__proto__", "name": "Piégée", "createdAt": 1, "tabs": [{ "url": "https://s.example/", "title": "T" }] }
    ],
    "activeSpaceId": "s1",
    "activeTabBySpace": { "s1": "t1", "__proto__": "t1", "constructor": "t1", "unknown": "t1" },
    "sitePermissions": { "__proto__": { "camera": "allow" }, "constructor": { "camera": "allow" }, "https://a.example": { "__proto__": "allow", "camera": "allow" } },
    "sidePanelBehavior": { "__proto__": true, "ext": true },
    "commandBarUsage": { "__proto__": { "https://p.example/": 5 }, "https://a.example/": 5, "default": { "__proto__": 5, "https://a.example/": 5 } },
    "settings": {
      "__proto__": { "polluted": "POLLUTED" }, "unknownSetting": "POLLUTED", "constructor": "POLLUTED",
      "keyBindings": { "__proto__": "CmdOrCtrl+K", "newTab": "CmdOrCtrl+Alt+K" },
      "profileNames": { "__proto__": "Pirate", "constructor": "Pirate", "work": "Travail" },
      "profiles": { "__proto__": { "autoArchiveHours": 5 }, "constructor": { "autoArchiveHours": 5 }, "work": { "autoArchiveHours": 4, "__proto__": { "polluted": "POLLUTED" } } },
      "siteZoom": { "__proto__": 2, "constructor": 2, "example.com": 1.5 },
      "siteAutoplay": { "__proto__": "allow", "constructor": "allow", "example.com": "block" },
      "customFilterLists": [{ "id": "custom-0123abcd", "title": "Mes règles", "source": "paste", "sourceName": "Règles collées", "enabled": true, "addedAt": 1, "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
      "blockExceptions": ["__proto__", "constructor"],
      "siteSearches": [{ "keyword": "k", "name": "n", "url": "https://x.example/?q=%s", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }],
      "linkRoutes": [{ "host": "x.org", "spaceId": "s1", "__proto__": { "polluted": "POLLUTED" }, "unknown": "POLLUTED" }]
    }
  }`

  /** Every object reachable from the state, with the path to it. */
  function walk(value: unknown, path = 'état', out: Array<[string, object]> = []): Array<[string, object]> {
    if (typeof value !== 'object' || value === null) return out
    out.push([path, value])
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, out)
    return out
  }

  const outcomes: Array<[string, () => SidebarState]> = [
    ['through the loader', () => parseSavedState(POLLUTION)],
    ['through normalize alone, on an object as JSON.parse builds it', () => norm(JSON.parse(POLLUTION))],
    ['through the restore of a backup', () => restoredState(JSON.parse(POLLUTION))!]
  ]

  for (const [name, load] of outcomes) {
    it(`pollutes nothing and keeps nothing it does not know: ${name}`, () => {
      const state = load()
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
      expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined()
      expect(JSON.stringify(state)).not.toContain('POLLUTED')
      expect(problems(state)).toEqual([])
      for (const [path, object] of walk(state)) {
        expect(Object.getPrototypeOf(object), path).toBe(Array.isArray(object) ? Array.prototype : Object.prototype)
        expect(Object.hasOwn(object, '__proto__'), `${path} has an own __proto__`).toBe(false)
        expect(Object.hasOwn(object, 'polluted'), path).toBe(false)
      }
    })
  }

  it('keeps what is valid next to the hostile keys', () => {
    const state = parseSavedState(POLLUTION)
    expect(state.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(state.activeTabBySpace).toStrictEqual({ s1: 't1' })
    expect(state.sitePermissions).toEqual({ 'https://a.example': { camera: 'allow' }, constructor: { camera: 'allow' } })
    expect(state.sidePanelBehavior).toStrictEqual({ ext: true })
    expect(state.commandBarUsage).toStrictEqual({ default: { 'https://a.example/': 5 } })
    expect(state.settings.keyBindings).toStrictEqual({ newTab: 'CmdOrCtrl+Alt+K' })
    expect(state.settings.profileNames).toEqual({ work: 'Travail', constructor: 'Pirate' })
    expect(state.settings.profiles).toEqual({ work: { autoArchiveHours: 4 }, constructor: { autoArchiveHours: 5 } })
    expect(state.settings.siteZoom).toStrictEqual({ 'example.com': 1.5, constructor: 2 })
    expect(state.settings.siteAutoplay).toStrictEqual({ 'example.com': 'block', constructor: 'allow' })
    expect(state.settings.customFilterLists).toStrictEqual([{ id: 'custom-0123abcd', title: 'Mes règles', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 1 }])
    expect(state.settings.blockExceptions).toEqual(['constructor'])
    // The 'k' shortcut is kept without its hostile keys, and the defaults are not added to the user's list.
    expect(state.settings.siteSearches).toEqual([{ keyword: 'k', name: 'n', url: 'https://x.example/?q=%s' }])
    expect(state.settings.linkRoutes).toEqual([{ host: 'x.org', spaceId: 's1' }])
    expect(state.sessions).toEqual([{ id: 'se1', name: 'S', createdAt: 1, tabs: [{ url: 'https://s.example/', title: 'T' }] }])
  })

  it('does not let a key of the file change the prototype of a dictionary', () => {
    const state = parseSavedState(POLLUTION)
    // `profiles.__proto__` must not have become the prototype of the record: a profile called "autoArchiveHours" would inherit 5.
    expect(state.settings.profiles['autoArchiveHours']).toBeUndefined()
    expect(Object.keys(state.settings.profiles).sort()).toEqual(['constructor', 'work'])
    expect(Object.getPrototypeOf(state.settings.profiles)).toBe(Object.prototype)
  })
})

// The checkers every case above leans on: if one of their conditions were always true, the cases would pass without proving anything. Each
// broken state below is one defect, and the checker names it.
describe('the checkers of a loaded state', () => {
  const good = (): SidebarState => norm(reduce(createInitialState({ now: 1, newId: () => 'g1' }), { type: 'tab/open', url: 'https://a.example/' }, { now: 1, newId: () => 'g2' }))

  it('find nothing in a state that went through normalize', () => {
    expect(problems(good())).toEqual([])
    expect(loadedProblems(good())).toEqual([])
  })

  it('name each defect they are shown', () => {
    const state = good()
    const cases: Array<[SidebarState, RegExp]> = [
      [{ ...state, version: 0 } as unknown as SidebarState, /^version$/],
      [{ ...state, extra: true } as unknown as SidebarState, /^top-level keys: /],
      [{ ...state, settings: { ...state.settings, autoArchiveHours: -3 } }, /^setting autoArchiveHours = -3/],
      [{ ...state, tabs: [...state.tabs, { ...state.tabs[0]!, id: 'ghost', spaceId: 'gone' }] }, /^tab in unknown space$/],
      [{ ...state, tabs: 'not a list' } as unknown as SidebarState, /^a collection is not of its kind$/]
    ]
    for (const [broken, message] of cases) expect(problems(broken), String(message)).toContainEqual(expect.stringMatching(message))
  })
})
