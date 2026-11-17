import { PRIVATE_QUERY, type ProcessRow, type TabResources } from './ipc'
import { getLanguage, t, type MessageKey } from './i18n'
import { foldMarks } from './fold'

/** What Electron reports about a process, reduced to what the task manager needs. */
export interface RawProcess {
  pid: number
  type: string
  /** In % of one core (see CpuMeter). */
  cpu: number
  /** Working set, in kilobytes. */
  memoryKb: number
}

/** One process as Electron measured it, for its processor figure. */
export interface CpuSample {
  pid: number
  /** When the process started (ms since the epoch): with the pid, what tells a process from a later one that was given the same pid. */
  creationTime: number
  /** `cpu.cumulativeCPUUsage`: the processor time of the process since it started, in seconds, when this Electron gives it. */
  cumulativeSeconds?: number | undefined
  /** `cpu.percentCPUUsage`: divided by the number of cores, and averaged since anyone's last call of `app.getAppMetrics()`. */
  percentAllCores: number
}

/** A measure older than this is not the previous one of the same reader (the window was closed in between): the process is measured afresh. */
export const CPU_INTERVAL_MAX_MS = 15_000

/**
 * The processor of each process in % of ONE core, as Activity Monitor and `ps` count it: a process that keeps two cores busy is at 200 %, and
 * the total of the application may pass 100 %. Electron 45 divides `percentCPUUsage` by the number of cores (App::GetAppMetrics) and averages
 * it since the last call of `app.getAppMetrics()` by anyone (the card of a tab, the About window): the figure is here the difference of the
 * processor time of each process (`cumulativeCPUUsage`, by pid and creation time) over this meter's own interval. A process seen for the first
 * time, or an Electron that does not give that time, falls back on `percentCPUUsage` multiplied back by the number of cores.
 * One meter per reader: the task manager and the card of a tab each keep their own interval.
 */
export class CpuMeter {
  private last = new Map<string, { seconds: number; at: number }>()

  constructor(private readonly cores: number) {}

  /** The share of one core of each process (by pid) since this meter's previous measure, `now` being the time of this one (ms). */
  measure(samples: readonly CpuSample[], now: number): Map<number, number> {
    const next = new Map<string, { seconds: number; at: number }>()
    const shares = new Map<number, number>()
    for (const sample of samples) {
      const key = `${sample.pid}:${sample.creationTime}`
      const seconds = typeof sample.cumulativeSeconds === 'number' && Number.isFinite(sample.cumulativeSeconds) ? sample.cumulativeSeconds : null
      const before = this.last.get(key)
      const elapsedMs = before ? now - before.at : 0
      const share =
        seconds !== null && before && elapsedMs > 0 && elapsedMs <= CPU_INTERVAL_MAX_MS ? ((seconds - before.seconds) * 100_000) / elapsedMs : sample.percentAllCores * this.cores
      shares.set(sample.pid, Number.isFinite(share) ? Math.max(0, share) : 0)
      if (seconds !== null) next.set(key, { seconds, at: now })
    }
    // A process that is gone is forgotten: its pid may come back with another process.
    this.last = next
    return shares
  }
}

/**
 * What a renderer process draws besides the page of a tab, as the main process found it, for the name of its row. Never an address: only
 * what names a process (the name of a window, of an extension, of a tab).
 */
export type RendererHost =
  /** A surface of the interface of a window: its sidebar and toolbar, its layer of panels, its floating sidebar, its tooltip. */
  | { kind: 'surface'; surface: 'window' | 'overlay' | 'floating' | 'tooltip'; window: string }
  /** Another page of the interface: a window of its own (Réglages, the task manager…), a view of ours (a tooltip, the reader, an error page), the developer tools. */
  | { kind: 'app'; page: AppPage }
  | { kind: 'extension'; name: string }
  /** A page that is not a tab: Glance, a web panel, or one no window of the group accounts for (a private window's, a mini window's…). */
  | { kind: 'page'; page: 'peek' | 'panel' | 'private' | 'other'; window?: string; title?: string }
  /** A frame of another site inside the page of a tab: "Mettre en veille" puts that tab to sleep. */
  | { kind: 'subframe'; tabId: string; tabName: string }
  /** The service worker of a site: `owner` is the name of a tab on that site, if one is open. */
  | { kind: 'worker'; owner?: string; private?: boolean }

export type AppPage = 'settings' | 'taskmanager' | 'about' | 'extensions' | 'little' | 'video' | 'share' | 'view' | 'devtools'

/** The pages of our interface that are windows of their own, by the name of their file (src/renderer/<name>.html). */
const APP_PAGE_OF_FILE: Record<string, AppPage> = {
  settings: 'settings',
  taskmanager: 'taskmanager',
  about: 'about',
  extensions: 'extensions',
  littlearc: 'little',
  'floating-video': 'video',
  'window-share-view': 'share',
  'window-share-command': 'share',
  'page-annotate-command': 'share'
}

/**
 * What a web contents no window of the group accounts for is, from what it shows. `surface`: it is a page of our interface (locked by
 * surface-guard.ts, whether it comes from the files or from the dev server); `extension`: the name of the extension of a `chrome-extension:`
 * page; `persistent`: its session keeps what it stores (a private window's does not). Only the scheme, the file of the interface and its
 * private flag are read from the address.
 */
export function contentsHost(facts: { url: string; surface: boolean; extension?: string | null | undefined; persistent: boolean }): RendererHost {
  const parsed = URL.canParse(facts.url) ? new URL(facts.url) : null
  const scheme = parsed?.protocol.replace(/:$/, '') ?? ''
  if (facts.surface && parsed) {
    const file = (parsed.pathname.split('/').pop() ?? '').replace(/\.html$/, '')
    const window = parsed.searchParams.get(PRIVATE_QUERY) === '1' ? t('processes.fenetre-privee') : t('processes.autre-fenetre')
    if (file === 'index') return { kind: 'surface', surface: parsed.hash === '#float' ? 'floating' : 'window', window }
    if (file === 'overlay') return { kind: 'surface', surface: 'overlay', window }
    return { kind: 'app', page: APP_PAGE_OF_FILE[file] ?? 'view' }
  }
  if (scheme === 'chrome-extension') return { kind: 'extension', name: facts.extension || t('processes.extension-inconnue') }
  if (scheme === 'devtools') return { kind: 'app', page: 'devtools' }
  // Our tooltips and the covers laid over a page (the reader, the page of a crash) are documents of ours in a `data:` address.
  if (scheme === 'data') return { kind: 'app', page: 'view' }
  if (!facts.persistent) return { kind: 'page', page: 'private' }
  return { kind: 'page', page: 'other' }
}

const SURFACE_LABEL: Record<'window' | 'overlay' | 'floating' | 'tooltip', MessageKey> = {
  window: 'processes.interface-barre-laterale',
  overlay: 'processes.interface-calque',
  floating: 'processes.interface-barre-flottante',
  tooltip: 'processes.interface-infobulle'
}
const APP_LABEL: Record<AppPage, MessageKey> = {
  settings: 'processes.interface-reglages',
  taskmanager: 'processes.interface-gestionnaire',
  about: 'processes.interface-a-propos',
  extensions: 'processes.interface-extensions',
  little: 'processes.interface-mini-fenetre',
  video: 'processes.interface-image-dans-l-image',
  share: 'processes.interface-partage',
  view: 'processes.interface-vue',
  devtools: 'processes.outils-de-developpement'
}
/** How strongly a host names its process: the first one of a process gives the row its kind. */
const HOST_ORDER: Record<RendererHost['kind'], number> = { surface: 0, app: 1, extension: 2, page: 3, subframe: 4, worker: 5 }
const KIND_OF_HOST: Record<RendererHost['kind'], ProcessRow['kind']> = { surface: 'interface', app: 'interface', extension: 'extension', page: 'page', subframe: 'subframe', worker: 'worker' }
/** The most names a row lists (of tabs for frames of other sites, of hosts for a process that hosts several things). */
const NAMES_MAX = 3

const atMost = (names: readonly string[]): string => (names.length > NAMES_MAX ? `${names.slice(0, NAMES_MAX).join(', ')}, …` : names.join(', '))

function hostLabel(host: Exclude<RendererHost, { kind: 'subframe' }>): string {
  switch (host.kind) {
    case 'surface':
      return t(SURFACE_LABEL[host.surface], { window: host.window })
    case 'app':
      return t(APP_LABEL[host.page])
    case 'extension':
      return t('processes.extension-nom', { name: host.name })
    case 'page':
      if (host.page === 'peek') return t('processes.apercu', { window: host.window ?? '' })
      if (host.page === 'panel') return t('processes.volet-web', { title: host.title ?? '' })
      return t(host.page === 'private' ? 'processes.page-privee' : 'processes.page-hors-onglet')
    case 'worker':
      if (host.private) return t('processes.service-worker-prive')
      return host.owner ? t('processes.service-worker-de', { owner: host.owner }) : t('processes.service-worker-site')
  }
}

/**
 * The kind, the name and the tab of the row of a renderer process that is not the page of a tab, from what it hosts. A process that hosts
 * several things lists them (the strongest first, which gives the kind); the frames of other sites of several tabs make one entry that names
 * each tab. Only a process of frames of a single tab carries that tab ("Mettre en veille" puts it to sleep). A process nothing accounts for
 * is a "Processus de rendu", not an "Onglet".
 */
export function rendererRow(hosts: readonly RendererHost[]): Pick<ProcessRow, 'kind' | 'name' | 'tabId'> {
  const sorted = [...hosts].sort((a, b) => HOST_ORDER[a.kind] - HOST_ORDER[b.kind])
  const first = sorted[0]
  if (!first) return { kind: 'other', name: t('processes.processus-de-rendu') }
  const subframes = sorted.filter((host): host is Extract<RendererHost, { kind: 'subframe' }> => host.kind === 'subframe')
  const tabNames = [...new Set(subframes.map((host) => host.tabName))]
  const labels = sorted.map((host) => (host.kind === 'subframe' ? t('processes.sous-cadre-de', { tab: atMost(tabNames) }) : hostLabel(host)))
  const distinct = [...new Set(labels)]
  const name = distinct.length > NAMES_MAX ? `${distinct.slice(0, NAMES_MAX).join(' · ')} · …` : distinct.join(' · ')
  const tabIds = new Set(subframes.map((host) => host.tabId))
  return { kind: KIND_OF_HOST[first.kind], name, ...(first.kind === 'subframe' && tabIds.size === 1 ? { tabId: first.tabId } : {}) }
}

const KIND: Record<string, 'browser' | 'tab' | 'gpu' | 'utility'> = { Browser: 'browser', Tab: 'tab', GPU: 'gpu', Utility: 'utility' }
const LABEL: Record<'browser' | 'gpu' | 'utility' | 'other', string> = {
  browser: 'Lucium',
  get gpu() { return t('processes.processeur-graphique') },
  get utility() { return t('processes.type-service') },
  get other() { return t('processes.type-autre') }
}

/**
 * Names the processes for the task manager: a tab is called after its page, another renderer after what it hosts (`hosts`: the interface,
 * an extension, the frames of other sites of a tab…, see `rendererRow`), the others after what they do; the heaviest first. `pages` maps a
 * process id to the title of the page it renders.
 */
export function processRows(raw: readonly RawProcess[], pages: ReadonlyMap<number, string>, hosts: ReadonlyMap<number, readonly RendererHost[]> = new Map()): ProcessRow[] {
  return raw
    .map((p): ProcessRow => {
      const kind = KIND[p.type] ?? 'other'
      const named: Pick<ProcessRow, 'kind' | 'name' | 'tabId'> =
        kind !== 'tab' ? { kind, name: LABEL[kind] } : pages.has(p.pid) ? { kind, name: pages.get(p.pid)! } : rendererRow(hosts.get(p.pid) ?? [])
      return {
        pid: p.pid,
        ...named,
        cpu: Math.round(p.cpu * 10) / 10,
        memoryMb: Math.round(p.memoryKb / 1024)
      }
    })
    .sort((a, b) => b.memoryMb - a.memoryMb || a.pid - b.pid)
}

/** The tabs the task manager lists without their title: those a lock hides from the interface, and the private ones. */
export interface UntitledTabs {
  locked: ReadonlySet<string>
  private: ReadonlySet<string>
}

/** What the task manager reads of the tabs of a window group: the pages by process, their tab and space, the other hosts, and the sleeping tabs. */
export interface TaskManagerTabs {
  pages: ReadonlyMap<number, string>
  pageTabs: ReadonlyMap<number, { tabId: string; space: string }>
  group: ReadonlyMap<number, readonly RendererHost[]>
  sleeping: ReadonlyArray<{ tabId: string; name: string; space: string }>
}

/**
 * The same sources without the titles the task manager must not show. The tab of a locked space is behind the lock like the rest of the space:
 * asleep it is not listed at all, and a process still alive for it is called a locked tab, with no tab to act on. A private tab keeps its row
 * and its actions (the person sees it in their sidebar), under a name that says nothing of its page.
 */
export function withoutHiddenTitles(sources: TaskManagerTabs, untitled: UntitledTabs): TaskManagerTabs {
  if (untitled.locked.size === 0 && untitled.private.size === 0) return sources
  const pages = new Map(sources.pages)
  const pageTabs = new Map(sources.pageTabs)
  for (const [pid, { tabId }] of sources.pageTabs) {
    if (untitled.locked.has(tabId)) {
      pages.set(pid, t('processes.onglet-verrouille'))
      pageTabs.delete(pid)
    } else if (untitled.private.has(tabId)) pages.set(pid, t('processes.onglet-prive'))
  }
  const group = new Map<number, readonly RendererHost[]>()
  for (const [pid, hosts] of sources.group) {
    group.set(
      pid,
      hosts
        .filter((host) => host.kind !== 'subframe' || !untitled.locked.has(host.tabId))
        .map((host) => (host.kind === 'subframe' && untitled.private.has(host.tabId) ? { ...host, tabName: t('processes.onglet-prive') } : host))
    )
  }
  return { pages, pageTabs, group, sleeping: sources.sleeping.filter((tab) => !untitled.locked.has(tab.tabId) && !untitled.private.has(tab.tabId)) }
}

/**
 * The tab "Mettre en veille" puts to sleep from a row: the tab of a page, or the tab the frames of another site of the row are in. None for
 * a tab already asleep, or for any other process.
 */
export function sleepTargetOf(row: ProcessRow | undefined): string | null {
  if (!row || row.asleep === true || row.tabId === undefined) return null
  return row.kind === 'tab' || row.kind === 'subframe' ? row.tabId : null
}

/** How the task manager names the kinds of process in its "Type" column. */
export const PROCESS_KIND_LABEL: Record<ProcessRow['kind'], string> = {
  get tab() { return t('processes.type-onglet') },
  get interface() { return t('processes.type-interface') },
  get extension() { return t('processes.type-extension') },
  get subframe() { return t('processes.type-sous-cadre') },
  get worker() { return t('processes.type-service-worker') },
  get page() { return t('processes.type-page') },
  get browser() { return t('processes.type-application') },
  get gpu() { return t('processes.type-graphique') },
  get utility() { return t('processes.type-service') },
  get other() { return t('processes.type-autre') }
}

export type ProcessSortKey = 'name' | 'kind' | 'memoryMb' | 'cpu' | 'pid'

/** The summary at the top of the task manager: the memory of every process, how many of them are tabs, and the processor they use together. */
export function processSummary(rows: readonly ProcessRow[]): { memoryMb: number; tabs: number; cpu: number } {
  return { memoryMb: rows.reduce((sum, r) => sum + r.memoryMb, 0), tabs: rows.filter((r) => r.kind === 'tab').length, cpu: Math.round(rows.reduce((sum, r) => sum + r.cpu, 0) * 10) / 10 }
}

/** The rows whose name, type or process id contains `query` (accents and case aside); all of them for an empty query. */
export function filterProcessRows(rows: readonly ProcessRow[], query: string): ProcessRow[] {
  const fold = foldMarks
  const wanted = fold(query.trim())
  if (wanted === '') return [...rows]
  return rows.filter((r) => fold(`${r.name} ${PROCESS_KIND_LABEL[r.kind]} ${r.pid}`).includes(wanted))
}

/** How much of the heaviest process's memory a row holds, from 0 to 1: the length of the bar behind its figure. */
export function memoryShare(row: ProcessRow, rows: readonly ProcessRow[]): number {
  const heaviest = rows.reduce((max, r) => Math.max(max, r.memoryMb), 0)
  return heaviest > 0 ? Math.min(1, Math.max(0, row.memoryMb / heaviest)) : 0
}

/**
 * The rows in the order a click on a column header asks for: numbers as numbers, words as words (accents and case aside), the process id
 * breaking ties. With no column picked the rows stay as the main process sent them (the heaviest first).
 */
export function sortProcessRows(rows: readonly ProcessRow[], key: ProcessSortKey | null, direction: 'asc' | 'desc'): ProcessRow[] {
  if (!key) return [...rows]
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = key === 'kind' ? PROCESS_KIND_LABEL[a.kind] : a[key]
    const right = key === 'kind' ? PROCESS_KIND_LABEL[b.kind] : b[key]
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), getLanguage(), { sensitivity: 'base' })
    return order * sign || a.pid - b.pid
  })
}

/**
 * The rows grouped by space, the spaces in the alphabetical order of the language of the interface. The sort is stable, so the order of the
 * column stays inside each space; the rows without a space (browser, GPU…) come last.
 */
export function rowsBySpace(rows: readonly ProcessRow[]): ProcessRow[] {
  const last = '￿'
  return [...rows].sort((a, b) => (a.space ?? last).localeCompare(b.space ?? last, getLanguage()))
}

/**
 * The row a key moves to in the list of processes, as shown (`pids` in display order): arrows step, Home and End go to the ends, and from no
 * row yet the first key lands on the first one. `null` for any other key, or for an empty list.
 */
export function stepProcessRow(pids: readonly number[], from: number | null, key: string): number | null {
  if (pids.length === 0) return null
  const at = from === null ? -1 : pids.indexOf(from)
  if (key === 'Home') return pids[0]!
  if (key === 'End') return pids[pids.length - 1]!
  if (key === 'ArrowDown') return pids[Math.min(at + 1, pids.length - 1)]!
  if (key === 'ArrowUp') return pids[Math.max(at - 1, 0)]!
  return null
}

/**
 * Whether a process id may be sent a signal by a test. `process.kill(0, …)` signals the whole process group (the test runner
 * and its shell with it) and `kill(-1, …)` every process the user owns, so a missing id (Electron reports 0 for a page
 * without a process) must never reach it; nor may the main process kill itself.
 */
export function isKillablePid(pid: unknown, ownPid: number): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== ownPid
}

/**
 * Whether the task manager may end this process: one that renders a page of a tab of the browser (`pages` is what `processRows` takes),
 * and nothing else. A renderer of an extension or of a panel is a 'Tab' process for Electron too, but it is not the user's to end here.
 */
export function mayKillProcess(pid: unknown, ownPid: number, pages: ReadonlyMap<number, string>): pid is number {
  return isKillablePid(pid, ownPid) && pages.has(pid)
}

/**
 * What the card of a tab shows of the process that renders its page, or null when there is nothing honest to show: the tab has no process
 * (`pid` is 0 for a page that was put to sleep), or the process is not a page of the user's tabs. `pages` is what `processRows` takes, and the
 * rule is the one that decides which process the task manager may end: a service, the browser itself or the renderer of an extension never
 * shows up as a tab's. `sharing` is how many tabs render in this process.
 */
export function tabResourcesOf(raw: readonly RawProcess[], pid: unknown, ownPid: number, pages: ReadonlyMap<number, string>, sharing: number): TabResources | null {
  if (!mayKillProcess(pid, ownPid, pages)) return null
  const found = raw.find((p) => p.pid === pid && p.type === 'Tab')
  if (!found) return null
  return { memoryMb: Math.round(found.memoryKb / 1024), cpu: Math.round(found.cpu * 10) / 10, shared: sharing > 1 }
}
