// When a tab's web view may be freed to save memory ("sleep"). Pure rules: the main process gathers the facts (what is on
// screen, what plays, what downloads, what the page holds) and applies the verdict; nothing here touches Electron.

import { defaultSettings, type RuntimeState, type Settings, type SidebarState, type SleepMode, type TabItem, type TabRuntime } from './model'
import { isAutoReloadable } from './auto-reload'
import { noWakeTabIds } from './folders'
import { sidebarOrder } from './sidebar-selectors'
import { matchesHost } from './url'
import { cleanHostEntries, normalizeHostEntry } from './host-entry'
import { t } from './i18n'

/** Why a tab is left awake. */
export type SleepBlocker =
  /** The delay is set to "never". */
  | 'disabled'
  /** The tab has no live page, so there is nothing to put to sleep. */
  | 'no-page'
  | 'selected'
  /** A pane of the split view on screen. */
  | 'split-pane'
  /** The user marked this tab "never put to sleep". */
  | 'keep-awake'
  /** The tab reloads itself at an interval: putting it to sleep would silently end that. */
  | 'auto-reload'
  | 'excluded-site'
  | 'pinned'
  | 'loading'
  | 'audible'
  /** A download this tab started is still running. */
  | 'downloading'
  /** The page was given the camera, the microphone or the screen since its last navigation: a call or a recording would end. */
  | 'capturing'
  /** Left less than the delay ago. */
  | 'recent'
  /** Its page is in Lucium's floating video window: it is on screen there. */
  | 'floating'
  /** Every other rule let it through, but the page itself was not asked yet (see `SleepFacts.probe`). */
  | 'unchecked'
  | 'picture-in-picture'
  | 'unsent-input'
  /** "Actualiser tous les onglets" woke it, and the user showed it before its page was put back to sleep: it is theirs again. */
  | 'shown-meanwhile'

export type SleepVerdict = { sleep: true } | { sleep: false; reason: SleepBlocker }

/** What only the page can tell. Asking costs a round trip to its renderer, so it is done last and only for a tab about to sleep. */
export interface PageProbe {
  /** A video of the page floats in a Picture in Picture window, which would close with the page. */
  pictureInPicture: boolean
  /** The user typed in a field and the page kept the text without it being sent. */
  unsentInput: boolean
}

export interface SleepFacts {
  /** The tab has a live web view. */
  awake: boolean
  /** The selected tab. */
  selected: boolean
  /** Shown as a pane of the split view on screen. */
  visiblePane: boolean
  loading: boolean
  audible: boolean
  /** A download started by this tab is still running. */
  downloading: boolean
  /** Milliseconds since the tab left the screen (or was loaded in the background). */
  idleMs: number
  /** Absent until the page was asked: the verdict is then `unchecked` rather than a guess. */
  probe?: PageProbe
  /** Read by the `reload` verdict only: the tab came on screen (and perhaps left it) after "Actualiser tous les onglets" woke it. */
  shownMeanwhile?: boolean
  /** The page was given the camera, the microphone or the screen since its last navigation (see `Page.usesCapture`). */
  capturing?: boolean
  /** The page is in Lucium's floating video window (shell/floating-video.ts): on screen there, as the selected tab is. Known by the main process. */
  floating?: boolean
  /**
   * Whether this tab is the one that stays awake for its site of the list of sites never put to sleep (`planSweep`). Absent, every tab of such a
   * site is spared, as a caller that does not plan (the `reload` verdict) always did.
   */
  siteKeeper?: boolean
  /** The cap of the tabs awake in the background, or the memory pressure, wants this tab asleep before its delay (`planSweep`). */
  overCap?: boolean
}

export type SleepRules = Pick<Settings, 'sleepAfterMinutes' | 'sleepExcludedHosts' | 'sleepSkipAudible' | 'sleepSkipPinned'> & Partial<Pick<Settings, 'sleepExcludedKeepAll' | 'sleepFreezeAfterMinutes'>>

const no = (reason: SleepBlocker): SleepVerdict => ({ sleep: false, reason })

/**
 * Whether a tab may be put to sleep, and if not, the first rule that says so. `auto` is the periodic sweep: every rule
 * applies. `manual` is the user asking for this very tab: only what cannot be done applies (nothing to free, or the page is
 * on screen), whatever they chose to protect. `reload` is a tab that slept, that "Actualiser tous les onglets" woke and whose
 * page has loaded (or was given up on): it goes back to sleep under the rules of the sweep, but the delay, the time since it was
 * loaded and a load that never ends do not count (it was asleep a moment ago), a tab that plays sound is always spared, and so is a
 * tab the user showed meanwhile. `freeze` is the first step of the sweep (`sleepFreezeAfterMinutes`): the page is stopped and kept, so
 * its delay is the freeze delay, and it spares more than a sleep does: a tab that plays sound whatever the setting, and every tab of a
 * site never put to sleep (a stopped page notifies no more than a freed one). The rules that need the page itself are checked last: a
 * verdict without `facts.probe` is `unchecked`, so a caller that forgets to ask the page keeps the tab awake instead of losing text.
 * In `auto`, a tab of a site never put to sleep is spared when it is the one that keeps its site awake (`facts.siteKeeper`; absent: every
 * one is) or when the user keeps them all, and a tab over the cap (`facts.overCap`) does not wait for its delay.
 */
export function sleepVerdict(tab: Pick<TabItem, 'url' | 'pinned' | 'keepAwake' | 'autoReload'>, rules: SleepRules, facts: SleepFacts, mode: 'auto' | 'manual' | 'reload' | 'freeze' = 'auto'): SleepVerdict {
  if (!facts.awake) return no('no-page')
  if (facts.selected) return no('selected')
  if (facts.visiblePane) return no('split-pane')
  if (facts.floating === true) return no('floating')
  if (mode === 'manual') return { sleep: true }
  const freeze = mode === 'freeze'
  const sweep = mode === 'auto' || freeze
  if (sweep && !(rules.sleepAfterMinutes > 0)) return no('disabled')
  const delayMinutes = freeze ? (rules.sleepFreezeAfterMinutes ?? 0) : rules.sleepAfterMinutes
  if (freeze && !(delayMinutes > 0)) return no('disabled')
  if (!sweep && facts.shownMeanwhile === true) return no('shown-meanwhile')
  if (tab.keepAwake) return no('keep-awake')
  if (tab.autoReload) return no('auto-reload')
  if (isSiteExcluded(tab.url, rules.sleepExcludedHosts) && (freeze || rules.sleepExcludedKeepAll === true || facts.siteKeeper !== false)) return no('excluded-site')
  if (rules.sleepSkipPinned && tab.pinned) return no('pinned')
  if (sweep && facts.loading) return no('loading')
  if ((!sweep || freeze || rules.sleepSkipAudible) && facts.audible) return no('audible')
  if (facts.downloading) return no('downloading')
  if (facts.capturing === true) return no('capturing')
  const early = mode === 'auto' && facts.overCap === true
  if (sweep && !early && facts.idleMs < delayMinutes * 60_000) return no('recent')
  if (!facts.probe) return no('unchecked')
  if (facts.probe.pictureInPicture) return no('picture-in-picture')
  if (facts.probe.unsentInput) return no('unsent-input')
  return { sleep: true }
}

// ---------- the cap, the memory pressure and the levels ----------

/** The memory pressure of the system, as macOS tells it (`kern.memorystatus_vm_pressure_level`). */
export type MemoryPressure = 'normal' | 'warning' | 'critical'

/** Under warning pressure, a tab left this many minutes ago sleeps at the latest, and at most this many tabs stay awake in the background. */
export const PRESSURE_SLEEP_MINUTES = 5
export const PRESSURE_AWAKE_MAX = 4
/** Where the system does not tell the pressure: the share of free memory below which it is a warning, and below which it is critical. */
export const FREE_MEMORY_WARNING = 0.1
export const FREE_MEMORY_CRITICAL = 0.05

/** What `sysctl -n kern.memorystatus_vm_pressure_level` printed: 1 normal, 2 warning, 4 critical. Null for anything else (the caller falls back). */
export function pressureOfLevel(printed: string): MemoryPressure | null {
  const level = /^\s*(\d+)\s*$/.exec(printed)?.[1]
  return level === '1' ? 'normal' : level === '2' ? 'warning' : level === '4' ? 'critical' : null
}

/** The pressure read from the free memory (`os.freemem()`, `os.totalmem()`), where the system does not tell it. */
export function pressureOfFreeMemory(free: number, total: number): MemoryPressure {
  if (!(total > 0) || !Number.isFinite(free) || free < 0) return 'normal'
  const share = free / total
  return share < FREE_MEMORY_CRITICAL ? 'critical' : share < FREE_MEMORY_WARNING ? 'warning' : 'normal'
}

/**
 * The rules a sweep judges by under a memory pressure, and its cap of tabs awake in the background (Infinity: none). Under a warning the
 * delay is five minutes at the most and the cap four; under critical pressure the cap is 0, so that every tab nothing protects sleeps.
 * A delay of "Jamais" stays off: the user turned the sleep off, and the pressure does not turn it back on.
 */
export function sweepLimits<T extends SleepRules & Pick<Settings, 'sleepAwakeMax'>>(settings: T, pressure: MemoryPressure): { rules: T; cap: number } {
  const cap = Number.isFinite(settings.sleepAwakeMax) && settings.sleepAwakeMax > 0 ? settings.sleepAwakeMax : Number.POSITIVE_INFINITY
  if (!(settings.sleepAfterMinutes > 0)) return { rules: settings, cap }
  if (pressure === 'critical') return { rules: settings, cap: 0 }
  if (pressure === 'warning') return { rules: { ...settings, sleepAfterMinutes: Math.min(settings.sleepAfterMinutes, PRESSURE_SLEEP_MINUTES) }, cap: Math.min(cap, PRESSURE_AWAKE_MAX) }
  return { rules: settings, cap }
}

/** A page a window of the group holds, as the sweep sees it. */
export interface SweepEntry {
  id: string
  tab: Pick<TabItem, 'url' | 'pinned' | 'keepAwake' | 'autoReload'>
  /** Without `probe`: the page is asked later, and only when it comes to that. */
  facts: SleepFacts
  /** Running, frozen by the first step of the sweep (`auto`: freed at the delay), or frozen another way (by hand, or by the mode "Garder en mémoire"). */
  frozen: 'no' | 'auto' | 'other'
  /** The page said at a recent sweep that it holds what a sleep would lose (Picture in Picture, text not sent): it is protected meanwhile. */
  kept?: boolean
}

export interface SweepPlan {
  /** The tab that stays awake for each site of the list of sites never put to sleep, when no tab on screen, marked or reloading itself does. */
  keepers: ReadonlySet<string>
  /** The tabs the cap puts to sleep before their delay: the ones left the longest ago, as many as there are tabs beyond the cap. */
  overCap: ReadonlySet<string>
}

/**
 * What a sweep does beyond the delay, over every page of the window group: the cap is the group's, whichever window holds the page. The
 * tabs counted are the ones only the delay keeps awake: not on screen, not protected (sound, download, camera or microphone, "never put
 * to sleep", reloading itself, Picture in Picture or text not sent when the page said so lately) and not the one tab kept for its site. A
 * frozen page counts only when the sweep froze it on its way to being freed (`mode` "discard"). Beyond `cap`, the oldest are over the cap.
 */
export function planSweep(entries: readonly SweepEntry[], rules: SleepRules, cap: number, mode: SleepMode): SweepPlan {
  const keepers = siteKeepers(entries, rules)
  const counted = entries.filter((entry) => countsTowardCap(entry, rules, keepers, mode))
  const excess = counted.length - cap
  if (!(excess > 0)) return { keepers, overCap: new Set() }
  const oldest = [...counted].sort((a, b) => b.facts.idleMs - a.facts.idleMs)
  return { keepers, overCap: new Set(oldest.slice(0, excess).map((entry) => entry.id)) }
}

function countsTowardCap(entry: SweepEntry, rules: SleepRules, keepers: ReadonlySet<string>, mode: SleepMode): boolean {
  if (entry.kept === true || entry.frozen === 'other' || (entry.frozen === 'auto' && mode === 'freeze')) return false
  // What protects the tab whatever its age: the verdict of the same tab left long ago and done loading. `unchecked` leaves only the page to ask.
  const verdict = sleepVerdict(entry.tab, rules, { ...entry.facts, loading: false, idleMs: Number.POSITIVE_INFINITY, siteKeeper: keepers.has(entry.id), overCap: false, probe: undefined }, 'auto')
  return !verdict.sleep && verdict.reason === 'unchecked'
}

/**
 * One tab awake for each site of the list, as at the launch: none when a tab on screen, a tab marked "never put to sleep" or a tab that
 * reloads itself is on the site already, otherwise the running one left last. With "Garder tous les onglets de ces sites", none is needed.
 */
function siteKeepers(entries: readonly SweepEntry[], rules: SleepRules): Set<string> {
  const keepers = new Set<string>()
  if (rules.sleepExcludedKeepAll === true) return keepers
  for (const site of rules.sleepExcludedHosts) {
    const ofSite = entries.filter((entry) => entry.frozen === 'no' && isSiteExcluded(entry.tab.url, [site]))
    if (ofSite.some((entry) => entry.facts.selected || entry.facts.visiblePane || entry.tab.keepAwake === true || Boolean(entry.tab.autoReload))) continue
    const latest = ofSite.reduce<SweepEntry | undefined>((best, entry) => (best === undefined || entry.facts.idleMs < best.facts.idleMs ? entry : best), undefined)
    if (latest) keepers.add(latest.id)
  }
  return keepers
}

/**
 * The three levels of the sleep (Modéré, Équilibré, Maximal), with short delays: here nothing else frees memory when it runs short. The guide's
 * answers write them, and the preset of the sleep reads which one the settings are (settings-presets.ts).
 */
export type SleepLevel = 'moderate' | 'balanced' | 'maximum'

export const SLEEP_LEVELS: Readonly<Record<SleepLevel, Pick<Settings, 'sleepAfterMinutes' | 'sleepAwakeMax' | 'sleepFreezeAfterMinutes'>>> = {
  moderate: { sleepAfterMinutes: 120, sleepAwakeMax: 30, sleepFreezeAfterMinutes: 0 },
  balanced: { sleepAfterMinutes: 30, sleepAwakeMax: 12, sleepFreezeAfterMinutes: 0 },
  maximum: { sleepAfterMinutes: 10, sleepAwakeMax: 6, sleepFreezeAfterMinutes: 5 }
}

// ---------- the launch ----------

/** Why a tab that no window shows gets its page at the launch anyway: the user asked for every tab, or wants this one alive. */
export type LaunchWake = 'all-tabs' | 'keep-awake' | 'auto-reload' | 'excluded-site'

/**
 * Whether a tab that no window shows may get its page when the application starts (the state and the windows of the last session come back), and why.
 * Null: it sleeps, exactly as a tab the delay put to sleep (its title, icon and place are the state's), until it is shown. The tab each window
 * shows is not asked about: showing a tab always gives it its page. What stays awake is what the user wants alive, whatever the delay says: the
 * tab marked "never put to sleep", the tab that reloads itself (its countdown needs a page), and a tab of a site of the list of sites never put to
 * sleep (a messaging site that notifies only while its page runs), of which `tabsToWakeAtLaunch` wakes one per site. A private tab is never kept
 * in the state, so never woken here either.
 */
export function wakesAtLaunch(tab: Pick<TabItem, 'url' | 'keepAwake' | 'autoReload' | 'private'>, settings: Pick<Settings, 'loadAllTabsAtLaunch' | 'sleepExcludedHosts'>): LaunchWake | null {
  if (tab.private === true) return null
  if (settings.loadAllTabsAtLaunch === true) return 'all-tabs'
  if (tab.keepAwake === true) return 'keep-awake'
  if (tab.autoReload !== undefined && isAutoReloadable(tab.url)) return 'auto-reload'
  if (isSiteExcluded(tab.url, settings.sleepExcludedHosts)) return 'excluded-site'
  return null
}

/** What the launch knows of the windows once each shows its tab (their sync made the pages of what they show). */
export interface LaunchScreen {
  /** The tabs on screen in any window: the selected tab of each, the panes of a split view on screen. They have their page already. */
  shown: ReadonlySet<string>
  /** The spaces the windows show, the main window's first: a site never put to sleep is looked for there before the other spaces. */
  spaces: readonly string[]
  /** A tab that cannot have a page now (its space, or the application, is locked): it is not woken, and does not stand for its site. */
  locked?: (tab: TabItem) => boolean
}

/**
 * The tabs that get a page at the launch besides those on screen, in the order they are woken. With "Charger tous les onglets au lancement",
 * every one. Otherwise the tabs marked "never put to sleep" and the tabs that reload themselves, all of them, and one tab for each site of the
 * list of sites never put to sleep (the list's entry, its subdomains included, as everywhere): the first in the order of the sidebar (the
 * favourites, then the rows), looked for in the spaces the windows show first and then in the others. A site that a tab on screen or a tab woken
 * anyway (marked, reloading itself) is on already gets no other: one page that runs is what a messaging site needs to notify. A tab of a locked
 * space is skipped, and the next one of its site stands for it. A private tab is never kept in the state, so never woken either.
 */
export function tabsToWakeAtLaunch(state: Pick<SidebarState, 'tabs' | 'folders' | 'favorites' | 'spaces' | 'settings'>, screen: LaunchScreen): TabItem[] {
  const hosts = state.settings.sleepExcludedHosts
  // The tabs of a folder marked « à ne pas réveiller » stay asleep, whatever else would wake them (shared/folders.ts, `noWakeTabIds`).
  const never = noWakeTabIds(state)
  const candidates = launchOrder(state, screen.spaces).filter((tab) => !screen.shown.has(tab.id) && screen.locked?.(tab) !== true && !never.has(tab.id))
  const why = new Map(candidates.map((tab) => [tab.id, wakesAtLaunch(tab, state.settings)]))
  const woken = new Set(candidates.filter((tab) => why.get(tab.id) === 'all-tabs' || why.get(tab.id) === 'keep-awake' || why.get(tab.id) === 'auto-reload').map((tab) => tab.id))
  const onScreen = state.tabs.filter((tab) => screen.shown.has(tab.id) && tab.private !== true)
  const covered = new Set([...onScreen, ...candidates.filter((tab) => woken.has(tab.id))].flatMap((tab) => excludedSitesOf(tab.url, hosts)))
  for (const tab of candidates) {
    if (why.get(tab.id) !== 'excluded-site') continue
    const sites = excludedSitesOf(tab.url, hosts)
    if (sites.every((site) => covered.has(site))) continue
    woken.add(tab.id)
    for (const site of sites) covered.add(site)
  }
  return candidates.filter((tab) => woken.has(tab.id))
}

/**
 * Every tab, in the order the sidebar shows them space by space (the favourites' tabs, then the rows: `sidebarOrder`), the spaces named first and
 * then the others in their order. A tab of no space (a file edited by hand) comes last rather than not at all.
 */
function launchOrder(state: Pick<SidebarState, 'tabs' | 'folders' | 'favorites' | 'spaces'>, first: readonly string[]): TabItem[] {
  const spaceIds = [...new Set([...first, ...state.spaces.map((space) => space.id)])]
  // The pages of the favourites, by space and by favourite, in the order of the tabs: one pass over the tabs, where a pass for each favourite of each
  // space took most of the launch's work (fifty spaces, twenty favourites and two thousand tabs: two million steps).
  const favoritePages = new Map<string, Map<string, TabItem[]>>()
  for (const tab of state.tabs) {
    if (tab.favoriteId === undefined) continue
    const ofSpace = favoritePages.get(tab.spaceId) ?? new Map<string, TabItem[]>()
    favoritePages.set(tab.spaceId, ofSpace)
    const pages = ofSpace.get(tab.favoriteId)
    if (pages) pages.push(tab)
    else ofSpace.set(tab.favoriteId, [tab])
  }
  const ordered = spaceIds.flatMap((spaceId) => {
    const ofSpace = favoritePages.get(spaceId)
    return [...(ofSpace ? state.favorites.flatMap((favorite) => ofSpace.get(favorite.id) ?? []) : []), ...sidebarOrder(state, spaceId)]
  })
  const seen = new Set<string>()
  return [...ordered, ...state.tabs].filter((tab) => {
    if (seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
}

/** What the window knows of a tab that has no page: the entry a tab put to sleep keeps (see `destroyPage`). */
const sleeping = (): TabRuntime => ({ loading: false, audible: false, muted: false, awake: false })

/**
 * Gives every tab without an entry the entry of a sleeping tab. A tab that never had a page since the launch (or that opened behind) is then
 * asleep to every reader alike (the row, the hover card, the search of tabs, the panes of a split view), as a tab the delay put to sleep is.
 * The same object when every tab has one.
 */
export function withSleepingEntries(runtime: RuntimeState, tabs: ReadonlyArray<Pick<TabItem, 'id'>>): RuntimeState {
  const missing = tabs.filter((tab) => runtime.tabs[tab.id] === undefined)
  if (missing.length === 0) return runtime
  return { ...runtime, tabs: { ...runtime.tabs, ...Object.fromEntries(missing.map((tab) => [tab.id, sleeping()])) } }
}

// ---------- reading a saved state ----------

/** The largest cap of tabs awake in the background a file may hold (0 is no cap). */
export const SLEEP_AWAKE_MAX_LIMIT = 500

/** The sleep settings of a saved file: a value of the wrong kind falls back to the default instead of reaching the sweep. */
export function cleanSleepSettings(settings: Settings): Pick<Settings, 'sleepAfterMinutes' | 'sleepAwakeMax' | 'sleepFreezeAfterMinutes' | 'sleepMode' | 'sleepExcludedHosts' | 'sleepExcludedKeepAll' | 'sleepSkipAudible' | 'sleepSkipPinned' | 'sleepNotify' | 'loadAllTabsAtLaunch'> {
  const defaults = defaultSettings()
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
  const minutes = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)
  const awakeMax: unknown = settings.sleepAwakeMax
  return {
    sleepAfterMinutes: minutes(settings.sleepAfterMinutes, defaults.sleepAfterMinutes),
    sleepAwakeMax: typeof awakeMax === 'number' && Number.isInteger(awakeMax) && awakeMax >= 0 && awakeMax <= SLEEP_AWAKE_MAX_LIMIT ? awakeMax : defaults.sleepAwakeMax,
    sleepFreezeAfterMinutes: minutes(settings.sleepFreezeAfterMinutes, defaults.sleepFreezeAfterMinutes),
    sleepMode: settings.sleepMode === 'freeze' ? 'freeze' : 'discard',
    sleepExcludedHosts: cleanSleepHosts(settings.sleepExcludedHosts),
    sleepExcludedKeepAll: flag(settings.sleepExcludedKeepAll, defaults.sleepExcludedKeepAll),
    sleepSkipAudible: flag(settings.sleepSkipAudible, defaults.sleepSkipAudible),
    sleepSkipPinned: flag(settings.sleepSkipPinned, defaults.sleepSkipPinned),
    sleepNotify: flag(settings.sleepNotify, defaults.sleepNotify),
    loadAllTabsAtLaunch: flag(settings.loadAllTabsAtLaunch, defaults.loadAllTabsAtLaunch)
  }
}

// ---------- excluded sites ----------

/** Sites in the list: more than anyone writes by hand, and a bound for a hand-edited file. */
export const SLEEP_HOSTS_MAX = 200

/** A pasted address can be long (a query string); beyond this it is not an address worth reading. */
const ADDRESS_MAX = 2048

/**
 * The host a typed address stands for, as the list keeps it: lower case, no scheme, port, path or leading "www." (a tab's
 * address is compared the same way). Null when it is not a host name. A pasted address works, so does "*.example.com".
 */
export function normalizeSleepHost(input: unknown): string | null {
  return normalizeHostEntry(input, ADDRESS_MAX)
}

/** What a saved list may hold: valid hosts only, each once, in order. Anything else is dropped. */
export function cleanSleepHosts(value: unknown): string[] {
  return cleanHostEntries(value, normalizeSleepHost, SLEEP_HOSTS_MAX)
}

/** Whether the address is on a listed host or one of its subdomains. */
export function isSiteExcluded(url: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => matchesHost(host, url))
}

/** The entries of the list the address is on (the host itself or a parent domain): usually one, more only in a list edited by hand. */
export function excludedSitesOf(url: string, hosts: readonly string[]): string[] {
  return hosts.filter((host) => matchesHost(host, url))
}

const covers = (entry: string, host: string) => host === entry || host.endsWith(`.${entry}`)

/**
 * The list with a site added or taken out. Adding a site a listed domain already covers changes nothing. Taking a site out
 * removes every entry that covers it, itself or a parent domain: the site is then no longer excluded, which is what was asked.
 */
export function setSiteExcluded(hosts: readonly string[], site: string, excluded: boolean): string[] {
  const host = normalizeSleepHost(site)
  if (!host) return [...hosts]
  if (!excluded) return hosts.filter((entry) => !covers(entry, host))
  return hosts.some((entry) => covers(entry, host)) ? [...hosts] : cleanSleepHosts([...hosts, host])
}

/** What the settings list does with a typed site: the host to add, or the sentence that says why not. */
export function checkSleepHost(input: string, hosts: readonly string[]): { host: string } | { error: string } {
  const host = normalizeSleepHost(input)
  if (!host) return { error: t('site-privacy-settings.cette-adresse-de-site-n-est-pas-valide') }
  const parent = hosts.find((entry) => covers(entry, host))
  if (parent === host) return { error: t('site-privacy-settings.ce-site-est-deja-dans-la-liste') }
  if (parent) return { error: t('sleep.ce-site-est-deja-couvert-par-parent', { parent }) }
  if (hosts.length >= SLEEP_HOSTS_MAX) return { error: t('site-privacy-settings.la-liste-est-pleine') }
  return { host }
}

// ---------- the toast of an automatic sleep ----------

/** The button of the notice of a single tab put to sleep (`frozen`: of a single tab frozen, which is thawed, not woken). */
export function sleepToastAction(frozen = false): string {
  return frozen ? t('sleep.degeler') : t('sleep.reveiller')
}

/** The notice after a sweep put tabs to sleep, or (`frozen`) froze them: a frozen page stays in memory, so it is not said to be asleep. */
export function sleepToastMessage(count: number, frozen = false): string {
  if (frozen) return count === 1 ? t('sleep.onglet-gele') : t('sleep.count-onglets-geles', { count })
  return count === 1 ? t('sleep.onglet-mis-en-veille') : t('sleep.count-onglets-mis-en-veille', { count })
}
