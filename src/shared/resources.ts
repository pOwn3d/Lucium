// The resources of the browser as the foot of the sidebar shows them (the function `resource-gauge`): a ring that fills with the share of the
// Mac's memory the browser holds, amber past half of it or when macOS says memory is short, and the panel of glass that slides up from it with
// the awake tabs that weigh the most, to put to sleep or close in one click. Pure: the main process measures (shell/resource-watch.ts,
// Browser.resourceTabs), the sidebar draws (renderer/ResourcePanel.tsx).

import { getLanguage, t, tp, type MessageKey } from './i18n'
import type { RawProcess } from './processes'
import { RELEASE_LEVELS, sleepToastMessage, type ReleaseLevel, type ReleasePlan } from './sleep'

/** How often the figures of the panel are measured again: only while a panel is open, in any window (shell/resource-watch.ts). */
export const RESOURCE_REFRESH_MS = 2000
/** The most tabs the panel lists. */
export const RESOURCE_TABS_MAX = 5
/** The most tabs the panel lists once the person asked for more (« Voir plus »): the processor of the tabs below the first five stops hiding in « Autres processus ». */
export const RESOURCE_TABS_MORE_MAX = 10
/** From this share of the Mac's memory (in %) the ring turns amber. */
export const GAUGE_WARN_PERCENT = 50
/** `kern.memorystatus_vm_pressure_level` says 1 (normal), 2 (warning) or 4 (critical): from 2 the ring turns amber. */
export const PRESSURE_WARN_LEVEL = 2
/** How long « Annuler » stays after a run of « Libérer maintenant »: fifteen seconds. */
export const RELEASE_UNDO_MS = 15_000
/**
 * The longest « Libérer maintenant » waits for one step of one tab (the page's answer about what it holds, then, in a second pass, its close): after it the
 * tab is counted among the ones that were too slow, and the run goes on. Above what the engine itself gives a page (3 s to answer, 5 s to answer a close),
 * so that only a machine too busy to get to the page at all trips it: a busy Mac answers in seconds, not in three.
 */
export const RELEASE_TAB_MS = 9000
/** How many tabs « Libérer maintenant » asks (then closes) at once: the waits overlap, but a Mac that is already short of processor is not asked for dozens of pages together. */
export const RELEASE_PARALLEL = 4
/** How long after a run the panel measures what was really freed: the processes need a moment to go. */
export const RELEASE_MEASURE_MS = 3000
/** The meter of a row is hot from this memory (MB) or this processor (% of one core). */
export const HOT_TAB_MB = 1024
export const HOT_TAB_CPU = 30

/** What the ring at the foot of the sidebar shows. Rounded to what it says, so that a smaller change publishes nothing. */
export interface MemoryGauge {
  /** The memory every process of the browser holds, in MB, to the nearest 100 MB. */
  memoryMb: number
  /** The memory of the Mac (os.totalmem), in MB. */
  totalMb: number
  /** The share of the Mac's memory the browser holds, in whole percent (0 to 100). */
  percent: number
  /** macOS says memory is short (`kern.memorystatus_vm_pressure_level` at 2 or more). */
  pressure: boolean
  /** The ring is amber: past the threshold, or under pressure. */
  warn: boolean
}

/** One awake tab of the panel, with the figures of the process of its page. */
export interface ResourceTab {
  tabId: string
  name: string
  url: string
  faviconUrl?: string
  /** The emoji the user gave the tab, shown in place of its favicon as in its row. */
  icon?: string
  pinned?: true
  /** Resident memory of the process, in MB. */
  memoryMb: number
  /** In % of one core, as the task manager counts it. */
  cpu: number
  /** Where the tab is, said only when it is not in the space this window shows: the name of its window, or its space. */
  where?: string
  /** Another tab renders in the same process: the figures are the process's. */
  shared?: true
}

/** What one strength of « Libérer maintenant » would do right now, as the panel previews it (« jusqu'à »: a page may still refuse when it is asked). */
export interface ReleasePreview {
  level: ReleaseLevel
  /** The tabs it would put to sleep. */
  count: number
  /** The memory it would free, in MB: the processes whose tabs all go to sleep, counted once (a process another tab still renders stays). */
  memoryMb: number
  /** The processor those processes use, in % of one core. */
  cpu: number
  /** How many of the tabs are on a site kept awake: they stop notifying until they wake. Only the strongest strength takes any. */
  siteTabs: number
}

/** How the panel ranks its tabs: by memory (the default) or by processor. */
export type ResourceSort = 'memory' | 'cpu'

/**
 * Every process the listed tabs do not account for: the graphic process, the interface of each window, the extensions, the network, the tabs that
 * did not make the list. With the rows it adds up to the totals of the head. A process shared by a listed tab is that tab's, so it is not counted here.
 */
export interface OtherProcesses {
  /** How many processes. */
  count: number
  memoryMb: number
  /** In % of one core. */
  cpu: number
  /** The graphic process alone, which is part of the above: it is the one that decodes and composes the videos behind the spaces. */
  gpuMemoryMb: number
  gpuCpu: number
}

/** The rows of the panel for one ranking, and what the rows leave out. */
export interface ResourceView {
  tabs: ResourceTab[]
  others: OtherProcesses
}

/** What the panel draws, sent every 2 s while it is open. */
export interface ResourceReport extends ResourceView {
  /** The memory and the processor of every process of the browser (the summary of the task manager). */
  memoryMb: number
  cpu: number
  gauge: MemoryGauge
  /** `tabs` (the heaviest awake tabs by memory, at most `RESOURCE_TABS_MAX`) and `others` are the ranking by memory; this is the ranking by processor. */
  byCpu: ResourceView
  /** The same two rankings with `RESOURCE_TABS_MORE_MAX` rows (« Voir plus »), each with the remainder of its own list. */
  more: ResourceView
  byCpuMore: ResourceView
  /** The three strengths of « Libérer maintenant », weakest first. */
  levels: ReleasePreview[]
}

/** The rows and the remainder of the ranking the person chose, with five rows or (`more`) up to ten. */
export function viewOf(report: ResourceReport, sort: ResourceSort, more = false): ResourceView {
  if (more) return sort === 'cpu' ? report.byCpuMore : report.more
  return sort === 'cpu' ? report.byCpu : { tabs: report.tabs, others: report.others }
}

/** Whether « Voir plus » has anything to add: the longer list holds rows the short one does not. */
export function hasMoreTabs(report: Pick<ResourceReport, 'tabs' | 'more'>): boolean {
  return report.more.tabs.length > report.tabs.length
}

/**
 * The figures that have just come, drawn while the pointer is on the rows: every row stays where it is. The list is sorted by weight and comes again every
 * 2 s, so two tabs can swap places between the moment a person aims at ☾ or ✕ and the moment they press: the button would then act on another tab. A row
 * that is still measured takes its new figures in place; one that left the list keeps its last figures until the pointer goes (it may only have
 * slipped under the heaviest), unless the person just put it to sleep or closed it here (`acted`); a tab that enters the list is added at the end.
 */
export function heldReport(previous: ResourceReport | null, next: ResourceReport, acted: ReadonlySet<string> = new Set()): ResourceReport {
  if (!previous) return next
  return {
    ...next,
    tabs: heldTabs(previous.tabs, next.tabs, acted),
    byCpu: { ...next.byCpu, tabs: heldTabs(previous.byCpu.tabs, next.byCpu.tabs, acted) },
    more: { ...next.more, tabs: heldTabs(previous.more.tabs, next.more.tabs, acted) },
    byCpuMore: { ...next.byCpuMore, tabs: heldTabs(previous.byCpuMore.tabs, next.byCpuMore.tabs, acted) }
  }
}

/** The rows of one ranking, kept in their places (see `heldReport`). */
function heldTabs(previous: readonly ResourceTab[], next: readonly ResourceTab[], acted: ReadonlySet<string>): ResourceTab[] {
  const measured = new Map(next.map((tab) => [tab.tabId, tab]))
  const shown = new Set(previous.map((tab) => tab.tabId))
  const kept = previous.filter((tab) => !acted.has(tab.tabId)).map((tab) => measured.get(tab.tabId) ?? tab)
  return [...kept, ...next.filter((tab) => !shown.has(tab.tabId) && !acted.has(tab.tabId))]
}

/** A button of the panel, as the sidebar asks for it. */
export type ResourceAction = { kind: 'sleep' | 'close' | 'show'; tabId: string } | { kind: 'sleep-level'; level: ReleaseLevel } | { kind: 'undo-level' } | { kind: 'task-manager' }

/** How a run of « Libérer maintenant » ended: how many tabs went to sleep, and why the others stayed awake (by reason, never by title or address). */
export interface ReleaseOutcome {
  level: ReleaseLevel
  slept: number
  refused: {
    /** A field of the page holds text not sent. */
    unsent: number
    /** The page asked to confirm leaving. */
    confirm: number
    /** Anything else: a video in Picture in Picture, a page that did not answer, a tab shown or protected since the preview. */
    other: number
    /** The page (or its close) did not answer within `RELEASE_TAB_MS`: the tab was left as it was, and a close already asked may still go through (« Annuler » takes it too). */
    slow: number
  }
  /** Another run is going on: this request did nothing. */
  busy?: true
}

/**
 * The answer to an action: how a run of « Libérer maintenant » ended; how many tabs « Annuler » is waking; whether ☾ or ✕ of a row did what it asks
 * (a tab a lock hides, or one that is gone meanwhile, is refused: the panel must not say it was done); null for the others and for a request that
 * is refused whole.
 */
export type ResourceActionReply = { released: ReleaseOutcome } | { woken: number } | { done: boolean } | null

/** Whether the answer says that the tab was put to sleep or closed. Anything else (a refusal, no answer, a request that failed) is a tab left as it was. */
export function resourceActionDone(reply: ResourceActionReply): boolean {
  return reply !== null && 'done' in reply && reply.done === true
}

const TAB_ID_MAX = 256

/** The action the sidebar asked for, or null for anything else (the interface is not trusted: the main process reads it again here). */
export function parseResourceAction(raw: unknown): ResourceAction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, tabId } = raw as { kind?: unknown; tabId?: unknown }
  if (kind === 'undo-level' || kind === 'task-manager') return { kind }
  const { level } = raw as { level?: unknown }
  if (kind === 'sleep-level') return typeof level === 'string' && (RELEASE_LEVELS as readonly string[]).includes(level) ? { kind, level: level as ReleaseLevel } : null
  if ((kind === 'sleep' || kind === 'close' || kind === 'show') && typeof tabId === 'string' && tabId.length > 0 && tabId.length <= TAB_ID_MAX) return { kind, tabId }
  return null
}

/** The memory every process holds, in MB. */
export function memoryOf(raw: readonly Pick<RawProcess, 'memoryKb'>[]): number {
  return raw.reduce((sum, p) => sum + (Number.isFinite(p.memoryKb) && p.memoryKb > 0 ? p.memoryKb : 0), 0) / 1024
}

/** The processor every process uses together, in % of one core, to a tenth. */
export function cpuOf(raw: readonly Pick<RawProcess, 'cpu'>[]): number {
  return Math.round(raw.reduce((sum, p) => sum + (Number.isFinite(p.cpu) && p.cpu > 0 ? p.cpu : 0), 0) * 10) / 10
}

/** The ring for this memory (MB), this Mac (MB) and the pressure macOS gives (null: not read, or not macOS). */
export function memoryGauge(memoryMb: number, totalMb: number, pressureLevel: number | null): MemoryGauge {
  const held = Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : 0
  const total = Number.isFinite(totalMb) && totalMb > 0 ? Math.round(totalMb) : 0
  const percent = total > 0 ? Math.min(100, Math.round((held / total) * 100)) : 0
  const pressure = pressureLevel !== null && Number.isFinite(pressureLevel) && pressureLevel >= PRESSURE_WARN_LEVEL
  return { memoryMb: Math.round(held / 100) * 100, totalMb: total, percent, pressure, warn: pressure || percent >= GAUGE_WARN_PERCENT }
}

/** Whether two rings show the same thing: only a change publishes the snapshot again. */
export function sameGauge(a: MemoryGauge | null, b: MemoryGauge | null): boolean {
  if (a === null || b === null) return a === b
  return a.memoryMb === b.memoryMb && a.totalMb === b.totalMb && a.percent === b.percent && a.pressure === b.pressure && a.warn === b.warn
}

/** The heaviest tabs first: by memory then the processor to break a tie, or by processor then memory; the name last; at most `max`. */
export function heaviestTabs(tabs: readonly ResourceTab[], max = RESOURCE_TABS_MAX, by: ResourceSort = 'memory'): ResourceTab[] {
  const first = (a: ResourceTab, b: ResourceTab): number => (by === 'cpu' ? b.cpu - a.cpu || b.memoryMb - a.memoryMb : b.memoryMb - a.memoryMb || b.cpu - a.cpu)
  return [...tabs].sort((a, b) => first(a, b) || a.name.localeCompare(b.name, getLanguage(), { sensitivity: 'base' })).slice(0, max)
}

/**
 * What the rows leave out: every process but those of the listed tabs (`listed`: their pids). Without it the head says 5,4 Go and the five rows
 * add up to 1,5 Go, and the graphic process, the first load of a window with a video behind it, is nowhere to be seen.
 */
export function otherProcesses(raw: readonly RawProcess[], listed: ReadonlySet<number>): OtherProcesses {
  const rest = raw.filter((process) => !listed.has(process.pid))
  const gpu = rest.filter((process) => process.type === 'GPU')
  return { count: rest.length, memoryMb: Math.round(memoryOf(rest)), cpu: cpuOf(rest), gpuMemoryMb: Math.round(memoryOf(gpu)), gpuCpu: cpuOf(gpu) }
}

/**
 * What each strength of « Libérer maintenant » would free: the memory and the processor of the processes whose tabs all go to sleep, each counted
 * once. `pages` is every live page of the group (a tab that stays awake, frozen or shown keeps its process alive, so it is listed too).
 */
export function releasePreviews(plans: Record<ReleaseLevel, ReleasePlan>, pages: ReadonlyArray<{ id: string; pid: number }>, raw: readonly RawProcess[]): ReleasePreview[] {
  const byPid = new Map(raw.filter((p) => p.type === 'Tab').map((p) => [p.pid, p]))
  const tabsOf = new Map<number, string[]>()
  for (const { id, pid } of pages) if (pid > 0) tabsOf.set(pid, [...(tabsOf.get(pid) ?? []), id])
  return RELEASE_LEVELS.map((level) => {
    const going = new Set(plans[level].ids)
    let memoryKb = 0
    let cpu = 0
    for (const [pid, ids] of tabsOf) {
      const process = byPid.get(pid)
      if (!process || !ids.every((id) => going.has(id))) continue
      memoryKb += Number.isFinite(process.memoryKb) && process.memoryKb > 0 ? process.memoryKb : 0
      cpu += Number.isFinite(process.cpu) && process.cpu > 0 ? process.cpu : 0
    }
    return { level, count: plans[level].ids.length, memoryMb: Math.round(memoryKb / 1024), cpu: Math.round(cpu * 10) / 10, siteTabs: plans[level].siteTabs }
  })
}

/** The memory a run really freed, in MB, from the total before and some seconds after: null when nothing measurable went (another tab may have grown meanwhile). */
export function measuredGain(beforeMb: number, afterMb: number): number | null {
  const freed = Math.round(beforeMb - afterMb)
  return Number.isFinite(freed) && freed >= MEASURED_GAIN_MIN_MB ? freed : null
}

/** Under this a difference of totals is noise, not a gain. */
export const MEASURED_GAIN_MIN_MB = 50

/**
 * What the panel is sent: the figures of every process, the ring, the heaviest of these awake tabs by memory and by processor (each with what its rows
 * leave out), and what each strength would free. `pids`: the process of each tab (a tab it does not name leaves its process among the others).
 */
export function resourceReport(raw: readonly RawProcess[], tabs: readonly ResourceTab[], levels: ReleasePreview[], gauge: MemoryGauge, pids: ReadonlyMap<string, number> = new Map()): ResourceReport {
  const view = (by: ResourceSort, max: number): ResourceView => {
    const listed = heaviestTabs(tabs, max, by)
    return { tabs: listed, others: otherProcesses(raw, new Set(listed.flatMap((tab) => pids.get(tab.tabId) ?? []))) }
  }
  return { memoryMb: Math.round(memoryOf(raw)), cpu: cpuOf(raw), gauge, ...view('memory', RESOURCE_TABS_MAX), byCpu: view('cpu', RESOURCE_TABS_MAX), more: view('memory', RESOURCE_TABS_MORE_MAX), byCpuMore: view('cpu', RESOURCE_TABS_MORE_MAX), levels }
}

/** How full the meter of a row is, from 0 to 1: its memory (or its processor) against the heaviest tab of the list. */
export function meterShare(tab: Pick<ResourceTab, 'memoryMb' | 'cpu'>, tabs: readonly Pick<ResourceTab, 'memoryMb' | 'cpu'>[], by: ResourceSort = 'memory'): number {
  const value = (one: Pick<ResourceTab, 'memoryMb' | 'cpu'>): number => (by === 'cpu' ? one.cpu : one.memoryMb)
  const heaviest = tabs.reduce((max, other) => Math.max(max, value(other)), 0)
  return heaviest > 0 ? Math.min(1, Math.max(0, value(tab) / heaviest)) : 0
}

/** Whether the meter of a row is drawn hot: a tab that holds a lot of memory, or keeps a core busy. */
export function isHot(tab: Pick<ResourceTab, 'memoryMb' | 'cpu'>): boolean {
  return tab.memoryMb >= HOT_TAB_MB || tab.cpu >= HOT_TAB_CPU
}

/** A number with the decimal mark of the language of the interface; `whole` drops a decimal that is nought ("16" rather than "16,0"). */
function decimal(value: number, digits: number, whole = false): string {
  const fixed = value.toFixed(digits)
  const text = whole ? fixed.replace(/\.0+$/, '') : fixed
  return getLanguage() === 'fr' ? text.replace('.', ',') : text
}

/** "584 Mo", "8,3 Go", "16 Go" (in English "584 MB", "8.3 GB", "16 GB"). */
export function formatMemory(memoryMb: number): string {
  const mb = Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : 0
  return mb >= 1024 ? t('resources.go', { n: decimal(mb / 1024, 1, true) }) : t('taskmanager.mb-mo', { mb: Math.round(mb) })
}

/** "7,4 %" under 10, "33 %" from 10, "0 %" for nothing (in English "7.4%", "33%", "0%"). */
export function formatPercent(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0
  return t('resources.pourcent', { n: n > 0 && n < 10 ? decimal(n, 1) : String(Math.round(n)) })
}

/** The tooltip (and the accessible name) of the ring: the figures, and what macOS says when memory is short. */
export function gaugeTip(gauge: MemoryGauge | null | undefined): string {
  if (!gauge) return t('resources.ressources-du-navigateur')
  const figures = t('resources.jauge', { memory: formatMemory(gauge.memoryMb), total: formatMemory(gauge.totalMb), percent: gauge.percent })
  return gauge.pressure ? `${figures} · ${t('resources.pression')}` : figures
}

// ---------- « Libérer maintenant »: the words ----------

const LEVEL_NAMES = { low: 'resources.niveau-faible', medium: 'resources.niveau-moyen', high: 'resources.niveau-fort' } as const satisfies Record<ReleaseLevel, MessageKey>
const LEVEL_HINTS = { low: 'resources.niveau-faible-hint', medium: 'resources.niveau-moyen-hint', high: 'resources.niveau-fort-hint' } as const satisfies Record<ReleaseLevel, MessageKey>

/** « Faible », « Moyen », « Fort ». */
export function releaseLevelName(level: ReleaseLevel): string {
  return t(LEVEL_NAMES[level])
}

/** What a strength takes, in a few words. */
export function releaseLevelHint(level: ReleaseLevel): string {
  return t(LEVEL_HINTS[level])
}

/** « 4 onglets · ≈ 0,6 Go » (the memory only when some would really go), or « Aucun onglet ». */
export function releaseFigures(preview: Pick<ReleasePreview, 'count' | 'memoryMb'>): string {
  if (preview.count === 0) return t('resources.niveau-aucun')
  return preview.memoryMb > 0 ? tp('resources.niveau-chiffres', preview.count, { memory: formatMemory(preview.memoryMb) }) : tp('resources.niveau-onglets', preview.count)
}

/** What the strongest strength costs besides memory: the notifications of the sites kept awake stop until their tab wakes. Null when it takes none of these. */
export function releaseSitesWarning(preview: Pick<ReleasePreview, 'siteTabs'>): string | null {
  return preview.siteTabs > 0 ? tp('resources.niveau-fort-sites', preview.siteTabs) : null
}

/** The sentence after a run: all done (with what was measured when it is known), nothing to do, or how many and why the others stayed awake. */
export function releaseNotice(outcome: ReleaseOutcome, freedMb: number | null): string {
  if (outcome.busy === true) return t('resources.liberer-deja-en-cours')
  const { unsent, confirm, other, slow } = outcome.refused
  const refused = unsent + confirm + other + slow
  if (refused === 0) {
    if (outcome.slept === 0) return t('resources.rien-a-endormir')
    return freedMb === null ? sleepToastMessage(outcome.slept) : tp('resources.liberer-fait-gain', outcome.slept, { memory: formatMemory(freedMb) })
  }
  const reasons = [
    ...(unsent > 0 ? [tp('resources.refus-texte', unsent)] : []),
    ...(confirm > 0 ? [tp('resources.refus-confirmation', confirm)] : []),
    ...(slow > 0 ? [tp('resources.refus-lent', slow)] : []),
    ...(other > 0 ? [tp('resources.refus-autre', other)] : [])
  ].join(', ')
  return t('resources.liberer-partiel', { slept: outcome.slept, total: outcome.slept + refused, reasons })
}

/** The sentence after « Annuler »: how many tabs load again (none when the user opened them meanwhile). */
export function undoNotice(woken: number): string {
  return woken > 0 ? tp('resources.annulation', woken) : t('resources.annulation-rien')
}

/** « Autres processus » and what it holds, in a few words. */
export function othersHint(others: Pick<OtherProcesses, 'count'>): string {
  return tp('resources.autres-processus-detail', others.count)
}

/** The graphic process on its own line under « Autres processus », or null when it is not among the others (or uses nothing worth a line). */
export function othersGpuLine(others: Pick<OtherProcesses, 'gpuMemoryMb' | 'gpuCpu'>): string | null {
  return others.gpuMemoryMb > 0 || others.gpuCpu > 0 ? t('resources.dont-graphique', { memory: formatMemory(others.gpuMemoryMb), cpu: formatPercent(others.gpuCpu) }) : null
}
