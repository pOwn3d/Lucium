// The resources of the browser as the foot of the sidebar shows them (the function `resource-gauge`): a ring that fills with the share of the
// Mac's memory the browser holds, amber past half of it or when macOS says memory is short, and the panel of glass that slides up from it with
// the awake tabs that weigh the most, to put to sleep or close in one click. Pure: the main process measures (shell/resource-watch.ts,
// Browser.resourceTabs), the sidebar draws (renderer/ResourcePanel.tsx).

import { getLanguage, t } from './i18n'
import type { RawProcess } from './processes'

/** How often the figures of the panel are measured again: only while a panel is open, in any window (shell/resource-watch.ts). */
export const RESOURCE_REFRESH_MS = 2000
/** The most tabs the panel lists. */
export const RESOURCE_TABS_MAX = 5
/** From this share of the Mac's memory (in %) the ring turns amber. */
export const GAUGE_WARN_PERCENT = 50
/** `kern.memorystatus_vm_pressure_level` says 1 (normal), 2 (warning) or 4 (critical): from 2 the ring turns amber. */
export const PRESSURE_WARN_LEVEL = 2
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

/** What the panel draws, sent every 2 s while it is open. */
export interface ResourceReport {
  /** The memory and the processor of every process of the browser (the summary of the task manager). */
  memoryMb: number
  cpu: number
  gauge: MemoryGauge
  /** The heaviest awake tabs, at most `RESOURCE_TABS_MAX`. */
  tabs: ResourceTab[]
  /** How many awake tabs no window shows: what « Tout mettre en veille sauf l’onglet affiché » may put to sleep (the protected ones among them stay). */
  hidden: number
}

/**
 * The figures that have just come, drawn while the pointer is on the rows: every row stays where it is. The list is sorted by weight and comes again every
 * 2 s, so two tabs can swap places between the moment a person aims at ☾ or ✕ and the moment they press: the button would then act on another tab. A row
 * that is still measured takes its new figures in place; one that left the list keeps its last figures until the pointer goes (it may only have
 * slipped under the heaviest), unless the person just put it to sleep or closed it here (`acted`); a tab that enters the list is added at the end.
 */
export function heldReport(previous: ResourceReport | null, next: ResourceReport, acted: ReadonlySet<string> = new Set()): ResourceReport {
  if (!previous) return next
  const measured = new Map(next.tabs.map((tab) => [tab.tabId, tab]))
  const shown = new Set(previous.tabs.map((tab) => tab.tabId))
  const kept = previous.tabs.filter((tab) => !acted.has(tab.tabId)).map((tab) => measured.get(tab.tabId) ?? tab)
  return { ...next, tabs: [...kept, ...next.tabs.filter((tab) => !shown.has(tab.tabId) && !acted.has(tab.tabId))] }
}

/** A button of the panel, as the sidebar asks for it. */
export type ResourceAction = { kind: 'sleep' | 'close' | 'show'; tabId: string } | { kind: 'sleep-hidden' } | { kind: 'task-manager' }

/**
 * The answer to an action: how many tabs « Tout endormir » put to sleep; whether ☾ or ✕ of a row did what it asks (a tab a lock hides, or one
 * that is gone meanwhile, is refused: the panel must not say it was done); null for the others and for a request that is refused whole.
 */
export type ResourceActionReply = { slept: number } | { done: boolean } | null

/** Whether the answer says that the tab was put to sleep or closed. Anything else (a refusal, no answer, a request that failed) is a tab left as it was. */
export function resourceActionDone(reply: ResourceActionReply): boolean {
  return reply !== null && 'done' in reply && reply.done === true
}

const TAB_ID_MAX = 256

/** The action the sidebar asked for, or null for anything else (the interface is not trusted: the main process reads it again here). */
export function parseResourceAction(raw: unknown): ResourceAction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, tabId } = raw as { kind?: unknown; tabId?: unknown }
  if (kind === 'sleep-hidden' || kind === 'task-manager') return { kind }
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

/** The heaviest tabs first: memory, then the processor to break a tie, then the name; at most `max`. */
export function heaviestTabs(tabs: readonly ResourceTab[], max = RESOURCE_TABS_MAX): ResourceTab[] {
  return [...tabs].sort((a, b) => b.memoryMb - a.memoryMb || b.cpu - a.cpu || a.name.localeCompare(b.name, getLanguage(), { sensitivity: 'base' })).slice(0, max)
}

/** What the panel is sent: the figures of every process, the ring, and the heaviest of these awake tabs. */
export function resourceReport(raw: readonly RawProcess[], tabs: readonly ResourceTab[], hidden: number, gauge: MemoryGauge): ResourceReport {
  return { memoryMb: Math.round(memoryOf(raw)), cpu: cpuOf(raw), gauge, tabs: heaviestTabs(tabs), hidden }
}

/** How full the meter of a row is, from 0 to 1: its memory against the heaviest tab of the list. */
export function meterShare(tab: Pick<ResourceTab, 'memoryMb'>, tabs: readonly Pick<ResourceTab, 'memoryMb'>[]): number {
  const heaviest = tabs.reduce((max, other) => Math.max(max, other.memoryMb), 0)
  return heaviest > 0 ? Math.min(1, Math.max(0, tab.memoryMb / heaviest)) : 0
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
