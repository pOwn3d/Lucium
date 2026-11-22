// The state of the sidebar as it is created, read from a file, repaired and kept consistent: the defaults, the loading of a saved state, the
// cleaning of the settings and of the Tweaks, and the pruning that keeps references from dangling. Pure; re-exported by `@shared/sidebar`.

import { cleanOllamaConfig } from './ollama'
import { NEUTRAL_TINT, BOOST_JS_MAX, BOOST_ZAP_MAX, BOOST_ZOOM_MAX, BOOST_ZOOM_MIN, COMMAND_BAR_SHAPES, COMMAND_BAR_SIZES, SIDEBAR_WIDTH_LEGACY, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, SIDE_PANEL_WIDTH_MAX, SIDE_PANEL_WIDTH_MIN, STATE_REVISION, STATE_VERSION, WEB_STORE_UPDATES, defaultSettings, type Boost, type BoostInput, type Settings, type SplitView, type SidebarState, type Space, type SiteSearch } from './model'
import { PROTECTION_BASELINE_OF_EARLIER_PROFILES, PROTECTION_OF_EARLIER_PROFILES, type ProtectionDefaults } from './model-defaults'
import { cleanBoostExtras } from './boost'
import { cleanContainerRules, cleanContainers, pruneContainers } from './containers'
import { withoutWindowKeys } from './window-tabs'
import { cleanSessions } from './sessions'
import { cleanWorkViews, pruneWorkViews } from './work-views'
import { cleanOpenWithApps } from './open-with'
import { cleanBookmarks } from './bookmarks'
import { cleanBindings } from './keybindings'
import { defaultTheme } from './theme'
import { keepPanes } from './split-grid'
import { normalizeAppIcon } from './icons'
import { favoriteProfile, pruneFavoriteProfiles, scopeFavorites } from './favorite-scope'
import { cleanProfileOverrides, isProfileId } from './profiles'
import { isSearchTemplate } from './url'
import { normalizeSiteDataPrefs } from './site-data'
import { cleanSiteDataAnimation } from './site-data-overlay'
import { cleanSleepSettings } from './sleep'
import { cleanBlockingSettings } from './blocker'
import { cleanFingerprintSettings } from './fingerprint'
import { cleanPrivacySettings } from './privacy'
import { cleanDohSettings } from './dns'
import { cleanProxySetting } from './proxy'
import { cleanKeepHosts } from './cookies'
import { cleanBackupSettings } from './backup-settings'
import { cleanLockedSpaces } from './lock'
import { cleanExtensionBarSettings } from './extension-overflow'
import { cleanWebToolsSettings } from './web-tools'
import { cleanKeyExtSettings } from './key-ext-settings'
import { cleanFocusSettings } from './focus-mode'
import { withoutGroupFolders } from './group-folders'
import { cleanUiScale } from './ui-scale'
import { cleanPanelSizes } from './panel-scale'
import { cleanSiteZoom } from './site-zoom'
import { cleanAutoplayPolicy, cleanSiteAutoplay } from './autoplay'
import { cleanSpellCheck } from './spell-check'
import { cleanClearOnClose } from './site-clear'
import { cleanSiteJavascriptOff } from './site-javascript'
import { cleanCustomFilterLists } from './custom-filter-lists'
import { cleanDeveloperHosts } from './developer-mode'
import { cleanReadableSettings, readableFromForcedDark, type ForcedDarkSettings } from './readable-mode'
import { cleanLanguageSetting } from './i18n'
import { cleanTranslateSettings } from './translate-local'
import { cleanQuickTranslateSettings } from './translate-quick'
import { cleanVersion } from './whats-new'
import { cleanUpdateNotices } from './auto-update'
import { cleanWindowLook } from './window-look'
import { cleanUsedProfiles } from './profile-recovery'
import { cleanRetiredProfiles } from './profile-retire'
import { settleTree } from './tab-tree'
import { normalizeFolders } from './folders'
import { cleanTabReminders, cleanArchive, cleanCommandBarUsage, cleanDelay, cleanExtensionPaths, cleanFavorites, cleanFolders, cleanLinkRoutes, cleanReadLater, cleanReadLaterFolders, cleanSearchDiscoverySeen, cleanSidePanelBehavior, cleanSiteDataRecents, cleanSiteSearches, cleanSitePermissions, cleanSpaces, cleanSplits, SITE_SEARCHES_MAX, cleanTabs, coerceSettings, isRecord, printable } from './state-clean'
import { clampOr } from './clamp'
import { cleanBarPosition } from './annotate-bar-position'
import { cleanAutoClearSeconds } from './annotate-auto-clear'
import type { Ctx } from './sidebar-actions'
import { USAGE_LIMIT, pruneUsageProfiles } from './command-bar-usage'


export function createInitialState(ctx: Ctx): SidebarState {
  const space: Space = { id: ctx.newId(), name: 'Perso', emoji: '🏠', theme: defaultTheme(), profileId: 'default' }
  return {
    version: STATE_VERSION,
    revision: STATE_REVISION,
    spaces: [space],
    tabs: [],
    folders: [],
    favorites: [],
    archive: [],
    readLater: [],
    readLaterFolders: [],
    tabReminders: [],
    bookmarks: [],
    activeSpaceId: space.id,
    activeTabBySpace: { [space.id]: null },
    sitePermissions: {},
    commandBarUsage: {},
    sidePanelBehavior: {},
    splits: [],
    boosts: [],
    sessions: [],
    workViews: [],
    settings: defaultSettings()
  }
}

/**
 * A saved state that can replace the current one: this version of the format, with at least one space and a list of tabs. Anything
 * else (another format, a truncated file, a value that is not a state) is null, so that the caller can say why nothing was restored.
 */
export function restoredState(raw: unknown): SidebarState | null {
  const read = readRestoredState(raw)
  if (read.ok) return read.state
  // The repair itself failed: that is not "a file that is none", and whoever looks for why a restore was refused finds it here.
  if ('error' in read) console.error('[state] a state to restore could not be repaired:', read.error)
  return null
}

/** `restoredState` with its reason: `error` is there when the state had the shape of one and its repair threw (the caller logs it or passes it on). */
export type RestoredState = { ok: true; state: SidebarState } | { ok: false; error?: unknown }

export function readRestoredState(raw: unknown): RestoredState {
  if (!isRecord(raw)) return { ok: false }
  const { version, spaces, tabs } = raw
  // Entries that are not even objects mean a damaged file: refused, not silently thinned out (the file chosen is the one to restore).
  if (version !== STATE_VERSION || !Array.isArray(spaces) || !Array.isArray(tabs) || !spaces.every(isRecord) || !tabs.every(isRecord) || cleanSpaces(spaces).length === 0) return { ok: false }
  try {
    return { ok: true, state: withoutWindowKeys(withoutPrivateTabs(normalize(raw as unknown as SidebarState))) }
  } catch (error) {
    // A state whose parts have the wrong shape: refused like any other unusable file, with what went wrong.
    return { ok: false, error }
  }
}

/** The file was written by a more recent version of the application: not damaged, only not readable here. The caller keeps it as it is. */
export class NewerStateError extends Error {
  constructor(readonly version: number) {
    super(`state version ${version} is newer than the ${STATE_VERSION} this application reads`)
  }
}

/**
 * The state a state file holds, repaired. Throws when the text is not JSON, not a state of this version, or has no space left once
 * repaired: the caller then keeps the file aside rather than starting over it. A file of a more recent version throws `NewerStateError`.
 */
export function parseSavedState(text: string): SidebarState {
  return savedStateOf(parseStateText(text))
}

/** The JSON of a state file. An editor may have saved the file with a byte-order mark. */
export function parseStateText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** `parseSavedState` of a file already parsed (`parseStateText`): the store reads the file once and also keeps what this version does not know. */
export function savedStateOf(parsed: unknown): SidebarState {
  if (!isRecord(parsed)) throw new Error('not a state')
  const version = parsed['version']
  if (typeof version === 'number' && Number.isInteger(version) && version > STATE_VERSION) throw new NewerStateError(version)
  if (version !== STATE_VERSION) throw new Error(`unsupported state version ${String(version)}`)
  if (cleanSpaces(parsed['spaces']).length === 0) throw new Error('no usable space')
  // A private tab is not something a file keeps: one found there is not a tab of this run. Nor is the window a tab belonged to.
  return withoutWindowKeys(withoutPrivateTabs(normalize(parsed as unknown as SidebarState)))
}

/** The state without the private tabs of the normal windows (and what pointed at them: a selection, a split view). Same object when there are none. */
export function withoutPrivateTabs(state: SidebarState): SidebarState {
  return state.tabs.some((t) => t.private === true) ? normalize({ ...state, tabs: state.tabs.filter((t) => t.private !== true) }) : state
}

/**
 * What may leave memory: the state file, an export, a copy of the session, a session saved under a name. Private tabs are only ever in
 * the state a window shows, so that the sidebar can list them; this is the one function everything that writes goes through. The same
 * goes for the folders that stand for the tab groups of extensions (see group-folders.ts): a file never holds them.
 */
export const persistableState = (state: SidebarState): SidebarState => withoutGroupFolders(withoutWindowKeys(withoutPrivateTabs(state)))

/**
 * Repairs a state read from a file, a backup or an import so that it cannot crash the UI: every part is checked and rebuilt (nothing
 * the model does not know survives), what is unusable is dropped without costing its neighbours, and references that dangle are cut.
 * Whatever it is given, it hands back a state with at least one space; given its own output, it hands back the same state.
 */
export function normalize(state: SidebarState): SidebarState {
  const raw: Record<string, unknown> = isRecord(state) ? state : {}
  const spaces = cleanSpaces(raw['spaces'])
  if (spaces.length === 0) spaces.push({ id: 'espace', name: 'Perso', emoji: '🏠', theme: defaultTheme(), profileId: 'default' })
  const spaceIds = new Set(spaces.map((s) => s.id))
  const folders = normalizeFolders(cleanFolders(raw['folders']), spaceIds)
  const tabs = cleanTabs(raw['tabs'], spaceIds, new Map(folders.map((f) => [f.id, f.spaceId])))
  const spaceOfTab = new Map(tabs.map((t) => [t.id, t.spaceId]))
  const selected = isRecord(raw['activeTabBySpace']) ? raw['activeTabBySpace'] : {}
  const activeTabBySpace = Object.fromEntries(
    spaces.map((s): [string, string | null] => {
      const id = selected[s.id]
      // A space shows one of its own tabs, or none.
      return [s.id, typeof id === 'string' && spaceOfTab.get(id) === s.id ? id : null]
    })
  )
  const active = raw['activeSpaceId']
  const revision = revisionOf(raw['revision'])
  const settings = clampSettings(migrateSettings(mergeSettings(raw['settings']), revision))
  const readLaterFolders = cleanReadLaterFolders(raw['readLaterFolders'])
  // The favourites of a file from before they were kept per profile are given to each profile in use (and the pages they have in spaces follow).
  const scoped = scopeFavorites(cleanFavorites(raw['favorites']), tabs, spaces)
  const cleaned = pruneContainers(pruneOrigins(pruneWorkViews(pruneFavoriteTabs(pruneUsageProfiles(pruneFavoriteProfiles(pruneSplits({
    version: STATE_VERSION,
    // The migrations below this revision have now been applied. A file of a later revision keeps its own: it went through migrations this build does not know.
    revision: Math.max(revision, STATE_REVISION),
    spaces,
    tabs: scoped.tabs,
    folders,
    favorites: scoped.favorites,
    archive: cleanArchive(raw['archive'], spaceIds),
    readLaterFolders,
    readLater: cleanReadLater(raw['readLater'], new Set(readLaterFolders.map((f) => f.id))),
    tabReminders: cleanTabReminders(raw['tabReminders'], spaceIds),
    bookmarks: cleanBookmarks(raw['bookmarks']),
    // Files written by an older build lack the newer fields: they get their defaults.
    // A space that is gone is no longer locked.
    settings: settings.lockedSpaces.every((id) => spaceIds.has(id)) ? settings : { ...settings, lockedSpaces: cleanLockedSpaces(settings.lockedSpaces, spaceIds) },
    activeSpaceId: typeof active === 'string' && spaceIds.has(active) ? active : spaces[0]!.id,
    activeTabBySpace,
    sitePermissions: cleanSitePermissions(raw['sitePermissions']),
    sidePanelBehavior: cleanSidePanelBehavior(raw['sidePanelBehavior']),
    // One ranking per profile; the single list of an older file is left out, and so is the ranking of a profile that is gone (`pruneUsageProfiles`).
    commandBarUsage: cleanCommandBarUsage(raw['commandBarUsage'], USAGE_LIMIT),
    splits: cleanSplits(raw['splits']),
    boosts: cleanBoosts(raw['boosts']),
    sessions: cleanSessions(raw['sessions']),
    // A file of a build before the work views has none: the list starts empty (no migration, see `STATE_REVISION`).
    workViews: cleanWorkViews(raw['workViews'])
  })))))))
  // A file's tree is read like the rest: what cannot hold is repaired, and it is flat when the setting is off.
  return settleTree(cleaned, cleaned)
}

export const BOOST_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The name, or the name and " (2)", " (3)"… the first one the site's other Tweaks do not use (compared without case). */
export function uniqueBoostName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${name.slice(0, 60 - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * The name the user typed for a space, a folder or a tab, as a file would hold it (state-clean.ts `label`): one line, cut at `max`, trimmed, `fallback`
 * when nothing is left. A name the reducer keeps longer or with a line break in it would not be the one a save and a reload give back.
 */
export const typedName = (value: unknown, max: number, fallback: string): string => printable(value, max)?.trim() || fallback

/**
 * The host a Tweak is for, lower case and without "www.". A bare name (`com`) would style every site under that top-level domain, and a Tweak matches its
 * host's subdomains: it is no host. `localhost` and an IPv6 literal have no dot and stay.
 */
const boostHost = (host: unknown): string => {
  const clean = typeof host === 'string' ? host.trim().toLowerCase().replace(/^www\./, '') : ''
  return /^[^.\s]+(?:\.[^.\s]+)+$/.test(clean) || clean === 'localhost' || /^\[[0-9a-f:.]+\]$/.test(clean) ? clean : ''
}

/** Fills what older saves lack and keeps zoom, colours and Eraser selectors inside safe bounds. */
export function cleanBoost(boost: BoostInput, newId: () => string): Boost {
  const host = boostHost(boost.host)
  const tint: Record<string, unknown> = isRecord(boost.tint) ? boost.tint : {}
  const js = typeof boost.js === 'string' && boost.js.length <= BOOST_JS_MAX ? boost.js : ''
  return {
    // A Tweak saved before ids existed keeps a stable one derived from its host.
    id: typeof boost.id === 'string' && BOOST_ID.test(boost.id) ? boost.id : newId(),
    name: printable(boost.name, 60)?.trim() || host,
    host,
    enabled: boost.enabled !== false,
    css: typeof boost.css === 'string' ? boost.css : '',
    js,
    // A draft that says what the script already says is no draft; an empty one is kept, it is a script being removed.
    ...(typeof boost.jsDraft === 'string' && boost.jsDraft.length <= BOOST_JS_MAX && boost.jsDraft !== js ? { jsDraft: boost.jsDraft } : {}),
    zoom: typeof boost.zoom === 'number' && boost.zoom > 0 ? clampOr(boost.zoom, BOOST_ZOOM_MIN, BOOST_ZOOM_MAX, 1) : 1,
    // A selector is spliced into a stylesheet: refuse anything that could close the rule.
    zap: (Array.isArray(boost.zap) ? boost.zap : []).filter((sel) => typeof sel === 'string' && sel.length > 0 && sel.length <= 300 && !/[{};]/.test(sel)).slice(0, BOOST_ZAP_MAX),
    ...cleanBoostExtras(boost),
    tint: {
      hue: clampOr(tint['hue'], -180, 180, NEUTRAL_TINT.hue),
      saturation: clampOr(tint['saturation'], 0, 2, NEUTRAL_TINT.saturation),
      brightness: clampOr(tint['brightness'], 0.5, 1.5, NEUTRAL_TINT.brightness),
      contrast: clampOr(tint['contrast'], 0.5, 1.5, NEUTRAL_TINT.contrast)
    }
  }
}

/** The Tweaks of a file: one that has no host is dropped, and two sharing an id are told apart (a Tweak is the user's own work, never discarded for that). */
function cleanBoosts(raw: unknown): Boost[] {
  const taken = new Set<string>()
  const out: Boost[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry) || boostHost(entry['host']) === '') continue
    const legacyId = `legacy-${boostHost(entry['host'])}`
    const boost = cleanBoost({ ...entry, id: entry['id'] ?? legacyId } as BoostInput, () => legacyId)
    let id = boost.id
    for (let n = 2; taken.has(id); n++) id = `${boost.id.slice(0, 60)}-${n}`
    taken.add(id)
    out.push(id === boost.id ? boost : { ...boost, id })
  }
  return out
}

export const PROFILE_NAME_MAX = 40

/** Profile ids are storage keys (partition names): keep the safe ones, with a trimmed non-empty display name. */
function cleanProfileNames(names: unknown): Record<string, string> {
  if (typeof names !== 'object' || names === null) return {}
  const clean: Array<[string, string]> = []
  for (const [id, name] of Object.entries(names)) {
    const label = isProfileId(id) ? printable(name, Infinity)?.trim().slice(0, PROFILE_NAME_MAX).trim() : undefined
    if (label) clean.push([id, label])
  }
  return Object.fromEntries(clean)
}

/**
 * The settings of a file laid over the defaults: what an older build did not know is filled in. The protection a file does not name is the one profiles
 * had when it was written (`PROTECTION_OF_EARLIER_PROFILES`), not the « Renforcée » of a new profile: a new default never changes an existing profile.
 */
function mergeSettings(savedOrNot: unknown): Settings {
  // A file with a state but no readable settings is an existing profile whose settings were lost, not a new one: it gets the protection of an existing
  // profile like `settings: {}` does. Only a first launch, which reads no file (`freshState`), starts at « Renforcée ».
  const saved = isRecord(savedOrNot) ? savedOrNot : {}
  // The same goes for the baseline the Settings compare the protection with: a file that does not name it is an existing profile's, whose own default was Standard.
  const merged = { ...defaultSettings(), ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: PROTECTION_BASELINE_OF_EARLIER_PROFILES, ...saved }
  // The configuration of Ollama, field by field: wrong kinds and numbers out of bounds get their default, an address that is not one of this Mac is dropped.
  merged.ollamaConfig = cleanOllamaConfig(merged.ollamaConfig)
  // The summary once could be made by an online provider. A file that named one gets the summary switched off: the local model is never
  // turned on in its place. The settings of those providers are not ones of this build, and are dropped with any other unknown key (coerceSettings).
  const online = saved['aiProvider'] !== undefined && saved['aiProvider'] !== 'ollama'
  merged.aiSummary = typeof merged.aiSummary === 'boolean' && !online ? merged.aiSummary : defaultSettings().aiSummary
  return merged as Settings
}

/** The revision of the format a file says it went through (`STATE_REVISION`): 0 for a file written before revisions existed, or one that says nothing usable. */
function revisionOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0
}

/**
 * The migrations of the settings of a file. The archive delay per profile of a file written before per-profile settings is folded into the overrides
 * (the key itself says it is old). The width of the sidebar is migrated only in a file of revision 0: in a later one, 264 px is a width the user chose.
 * The forced dark mode (revision 2) became the readable mode: its three settings are read once, in a file of an earlier revision, and then dropped.
 */
function migrateSettings(settings: Settings, revision: number): Settings {
  const { autoArchiveHoursByProfile, forceDarkSites, forceDarkOnlyWhenSystemDark, forceDarkExceptions, ...older } = settings as Settings & { autoArchiveHoursByProfile?: unknown } & ForcedDarkSettings
  // A file with none of the three has nothing to carry over: its readable mode is the default, or what the file says.
  const readable = revision < 2 && [forceDarkSites, forceDarkOnlyWhenSystemDark, forceDarkExceptions].some((value) => value !== undefined) ? readableFromForcedDark({ forceDarkSites, forceDarkOnlyWhenSystemDark, forceDarkExceptions }) : {}
  // The old default width gives way to 323 px; any other width was the user's own, and so is any width saved since the files have a revision.
  const rest = { ...(revision < 1 && older.sidebarWidth === SIDEBAR_WIDTH_LEGACY ? { ...older, sidebarWidth: defaultSettings().sidebarWidth } : older), ...readable }
  if (!isRecord(autoArchiveHoursByProfile)) return rest as Settings
  const profiles: Record<string, unknown> = isRecord(rest.profiles) ? { ...rest.profiles } : {}
  for (const [id, hours] of Object.entries(autoArchiveHoursByProfile)) {
    const current = profiles[id]
    profiles[id] = { ...(isRecord(current) ? current : {}), autoArchiveHours: hours }
  }
  return { ...rest, profiles } as Settings
}

/**
 * The site searches in the order they were saved or sent, and only those: a list the user emptied stays empty, and one without any of the
 * defaults gets none of them back. The defaults come only when there is no list at all (coerceSettings also gives them for a list none
 * of whose entries can be read: that is a repair, not a choice).
 */
function cleanSavedSiteSearches(saved: SiteSearch[] | undefined): SiteSearch[] {
  return Array.isArray(saved) ? cleanSiteSearches(saved).slice(0, SITE_SEARCHES_MAX) : defaultSettings().siteSearches
}

/**
 * One of the four settings of « Renforcée » that is not a flag (a damaged or hand-edited file, a bad patch) is off, as it was before « Renforcée »
 * became the default: a damaged value never switches a protection on (privacy.ts), nor puts the default of a new profile in place of the user's.
 * The baseline of the protection is « renforcee » only when it says so: any other word, or none, is the earlier profile's.
 */
function withProtectionRepaired(input: Settings): Settings {
  const raw = input as unknown as Record<string, unknown>
  const damaged = (Object.keys(PROTECTION_OF_EARLIER_PROFILES) as Array<keyof ProtectionDefaults>).filter((key) => typeof raw[key] !== 'boolean')
  const baseline = raw['protectionBaseline'] === 'renforcee' ? 'renforcee' : PROTECTION_BASELINE_OF_EARLIER_PROFILES
  return damaged.length === 0 && raw['protectionBaseline'] === baseline ? input : { ...input, ...Object.fromEntries(damaged.map((key) => [key, PROTECTION_OF_EARLIER_PROFILES[key]])), protectionBaseline: baseline }
}

export function clampSettings(input: Settings): Settings {
  const settings = coerceSettings(withProtectionRepaired(input) as unknown as Record<string, unknown>)
  const defaults = defaultSettings()
  const containers = cleanContainers(settings.containers)
  return {
    ...settings,
    containers,
    containerRules: cleanContainerRules(settings.containerRules, containers),
    searchUrlTemplate: isSearchTemplate(settings.searchUrlTemplate) ? settings.searchUrlTemplate : defaults.searchUrlTemplate,
    siteSearches: cleanSavedSiteSearches(settings.siteSearches),
    linkRoutes: cleanLinkRoutes(settings.linkRoutes),
    keyBindings: cleanBindings(settings.keyBindings),
    profileNames: cleanProfileNames(settings.profileNames),
    profiles: cleanProfileOverrides(settings.profiles),
    appIcon: normalizeAppIcon(settings.appIcon),
    ...normalizeSiteDataPrefs(settings),
    siteDataAnimation: cleanSiteDataAnimation(settings.siteDataAnimation),
    siteDataRecents: cleanSiteDataRecents(settings.siteDataRecents),
    searchDiscoverySeen: cleanSearchDiscoverySeen(settings.searchDiscoverySeen),
    ...cleanSleepSettings(settings),
    ...cleanBlockingSettings(settings),
    ...cleanFingerprintSettings(settings),
    ...cleanPrivacySettings(settings),
    ...cleanDohSettings(settings),
    proxy: cleanProxySetting(settings.proxy),
    cookieKeepHosts: cleanKeepHosts(settings.cookieKeepHosts),
    tidyFoldersPosition: settings.tidyFoldersPosition === 'bottom' ? 'bottom' : 'top',
    siteZoom: cleanSiteZoom(settings.siteZoom),
    autoplayPolicy: cleanAutoplayPolicy(settings.autoplayPolicy),
    spellCheck: cleanSpellCheck(settings.spellCheck),
    siteAutoplay: cleanSiteAutoplay(settings.siteAutoplay),
    autoplayPerSite: settings.autoplayPerSite !== false,
    siteDataClearOnCloseEnabled: settings.siteDataClearOnCloseEnabled === true,
    siteDataClearOnClose: cleanClearOnClose(settings.siteDataClearOnClose),
    siteJavascriptOff: cleanSiteJavascriptOff(settings.siteJavascriptOff),
    siteDataClearOnQuit: settings.siteDataClearOnQuit === true,
    customFilterListsEnabled: settings.customFilterListsEnabled !== false,
    customFilterLists: cleanCustomFilterLists(settings.customFilterLists),
    ...cleanBackupSettings(settings),
    lockedSpaces: cleanLockedSpaces(settings.lockedSpaces),
    interfaceTranslated: settings.interfaceTranslated === true,
    language: cleanLanguageSetting(settings.language),
    ...cleanTranslateSettings(settings),
    ...cleanQuickTranslateSettings(settings),
    lastSeenVersion: cleanVersion(settings.lastSeenVersion),
    ...cleanExtensionBarSettings(settings),
    ...cleanWebToolsSettings(settings),
    ...cleanKeyExtSettings(settings),
    ...cleanFocusSettings(settings),
    openWithApps: cleanOpenWithApps(settings.openWithApps),
    annotateBar: cleanBarPosition(settings.annotateBar),
    annotateAutoClearSeconds: cleanAutoClearSeconds(settings.annotateAutoClearSeconds),
    ...cleanReadableSettings(settings),
    ...cleanWindowLook(settings),
    uiScale: cleanUiScale(settings.uiScale),
    panelSizes: cleanPanelSizes(settings.panelSizes),
    // The old level of the Settings window, which nothing reads any more: kept as the file says it (a damaged value is false), never rewritten otherwise.
    showAdvancedSettings: settings.showAdvancedSettings === true,
    developerHosts: cleanDeveloperHosts(settings.developerHosts),
    usedProfiles: cleanUsedProfiles(settings.usedProfiles),
    retiredProfileIds: cleanRetiredProfiles(settings.retiredProfileIds),
    restoreWindows: settings.restoreWindows !== false,
    boostScriptImport: settings.boostScriptImport === 'never' ? 'never' : 'ask',
    chromeNativeHosts: settings.chromeNativeHosts === true,
    extensionPaths: cleanExtensionPaths(settings.extensionPaths),
    // A value that is not one of the three keeps the updates manual: a damaged file never makes the browser ask Google by itself.
    webStoreUpdates: WEB_STORE_UPDATES.includes(settings.webStoreUpdates) ? settings.webStoreUpdates : 'manual',
    updateFeedUrl: /^https:\/\/\S+$/i.test(settings.updateFeedUrl.trim()) && !/\p{Cc}/u.test(settings.updateFeedUrl) ? settings.updateFeedUrl.trim().slice(0, 500) : '',
    // A word that is not « test » is the stable channel: a damaged file never puts a person on the channel that may carry defects.
    updateChannel: settings.updateChannel === 'test' ? 'test' : 'stable',
    updateNotices: cleanUpdateNotices(settings.updateNotices),
    autoArchiveHours: cleanDelay(settings.autoArchiveHours, defaults.autoArchiveHours),
    littleArcArchiveHours: cleanDelay(settings.littleArcArchiveHours, defaults.littleArcArchiveHours),
    interfaceAppearance: settings.interfaceAppearance === 'light' || settings.interfaceAppearance === 'dark' ? settings.interfaceAppearance : 'auto',
    websiteAppearance: settings.websiteAppearance === 'light' || settings.websiteAppearance === 'dark' ? settings.websiteAppearance : 'auto',
    // A word that is not one of the sizes or shapes of the command bar's card gives back the card it always had.
    commandBarSize: COMMAND_BAR_SIZES.find((size) => size === settings.commandBarSize) ?? defaults.commandBarSize,
    commandBarShape: COMMAND_BAR_SHAPES.find((shape) => shape === settings.commandBarShape) ?? defaults.commandBarShape,
    sidebarWidth: Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(settings.sidebarWidth))),
    sidePanelWidth: Math.min(SIDE_PANEL_WIDTH_MAX, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(settings.sidePanelWidth)))
  }
}

/** A split needs at least two live tabs of its own space; anything else dissolves or shrinks (a grid as when its panes are closed: `withoutPane`). */
export function pruneSplits(state: SidebarState): SidebarState {
  if (state.splits.length === 0) return state
  const spaceOf = new Map(state.tabs.map((t) => [t.id, t.spaceId]))
  const seen = new Set<string>()
  let changed = false
  const splits: SplitView[] = []
  for (const sp of state.splits) {
    const ids = sp.tabIds.filter((id) => spaceOf.get(id) === sp.spaceId && !seen.has(id))
    // A split that dissolves frees its tabs: a later one may still hold them.
    if (ids.length >= 2) ids.forEach((id) => seen.add(id))
    if (ids.length === sp.tabIds.length && ids.length >= 2) splits.push(sp)
    else {
      changed = true
      if (ids.length >= 2) splits.push(keepPanes(sp, ids))
    }
  }
  return changed ? { ...state, splits } : state
}

/**
 * A tab keeps the memory of where it was opened from only while that tab exists, is another tab, and this one is not pinned (a pin is
 * a place of its own, not a stop on the way). Same object when nothing changes.
 */
export function pruneOrigins(state: SidebarState): SidebarState {
  if (!state.tabs.some((t) => t.openerId !== undefined)) return state
  const ids = new Set(state.tabs.map((t) => t.id))
  let changed = false
  const tabs = state.tabs.map((t) => {
    if (t.openerId === undefined || (ids.has(t.openerId) && t.openerId !== t.id && !t.pinned)) return t
    changed = true
    const { openerId: _gone, ...rest } = t
    return rest
  })
  return changed ? { ...state, tabs } : state
}

/**
 * A tab is the page of a favourite only while that favourite exists, is of the profile of the tab's space, and the tab is not pinned (a pinned tab is a
 * row of the list, a place of its own). A space that changed profile keeps its pages as ordinary tabs rather than as pages of favourites it no longer shows.
 * Same object when nothing changes.
 */
export function pruneFavoriteTabs(state: SidebarState): SidebarState {
  if (!state.tabs.some((t) => t.favoriteId !== undefined)) return state
  const profileOfFavorite = new Map(state.favorites.map((f) => [f.id, favoriteProfile(f)]))
  const profileOf = new Map(state.spaces.map((s) => [s.id, s.profileId]))
  let changed = false
  const tabs = state.tabs.map((t) => {
    if (t.favoriteId === undefined || (profileOfFavorite.get(t.favoriteId) === profileOf.get(t.spaceId) && !t.pinned)) return t
    changed = true
    const { favoriteId: _gone, ...rest } = t
    return rest
  })
  return changed ? { ...state, tabs } : state
}
