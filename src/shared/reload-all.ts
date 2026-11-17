// "Actualiser tous les onglets": which tabs of all the spaces are reloaded, how the sleeping ones are woken, and what is said about it. The reload
// itself is in main/shell/browser-sleep.ts.

import { isAutoReloadable } from './auto-reload'
import { t, tp } from './i18n'
import type { MemoryPressure } from './sleep'

export interface ReloadAllTab {
  id: string
  url: string
}

/**
 * The tabs to reload, in the order of the sidebar. Only a tab that has a page in memory: one that was never opened here or that sleeps
 * loads afresh when it is selected, so reloading it would only wake it up (a long list of tabs would all start at once). A frozen page
 * is kept as it is. A tab that shows nothing a reload can fetch (a blank page, an internal address) has nothing to do.
 */
export function reloadAllTargets(tabs: readonly ReloadAllTab[], live: ReadonlySet<string>, frozen: ReadonlySet<string>): string[] {
  return tabs.filter((tab) => live.has(tab.id) && !frozen.has(tab.id) && isAutoReloadable(tab.url)).map((tab) => tab.id)
}

/**
 * The tabs that sleep: a page that was put to sleep, never opened in this run or frozen. `live` holds the tabs that have a page in any
 * window (a tab shown by another window is not asleep). Reloading one wakes it and loads its address afresh.
 */
export function sleepingTargets(tabs: readonly ReloadAllTab[], live: ReadonlySet<string>, frozen: ReadonlySet<string>): string[] {
  return tabs.filter((tab) => (frozen.has(tab.id) || !live.has(tab.id)) && isAutoReloadable(tab.url)).map((tab) => tab.id)
}

/**
 * How many sleeping tabs "Actualiser tous les onglets" has woken and not yet put back to sleep, at most, while macOS says the memory is fine: 8.
 * Each is a page that loads (often a renderer process of its own, 100 to 300 MB for a heavy site) for a few seconds before it is freed again, so
 * 8 at once is about 1 to 2 GB for the time of the run: two more than the 6 of 0.2.1, which a Mac with 15 GB in use and 150 processes takes,
 * a third faster. When macOS says the memory is short (`reloadWakeLimit`), the run slows down instead of making it worse.
 */
/** How long the notice that says how a run ended stays: fifteen seconds, not five (it says what was left alone, and what to do about it). The history keeps it after that. */
export const RELOAD_ALL_RESULT_NOTICE_MS = 15_000

export const RELOAD_ALL_AWAKE_MAX = 8

/** The same bound under a memory warning (3), and under critical pressure (1): the run goes on, one tab at a time if it must. */
export const RELOAD_ALL_AWAKE_WARNING = 3
export const RELOAD_ALL_AWAKE_CRITICAL = 1

/** How many sleeping tabs are woken at once under this memory pressure (read again as the run goes, shell/sleep-pressure.ts). */
export function reloadWakeLimit(pressure: MemoryPressure): number {
  return pressure === 'critical' ? RELOAD_ALL_AWAKE_CRITICAL : pressure === 'warning' ? RELOAD_ALL_AWAKE_WARNING : RELOAD_ALL_AWAKE_MAX
}

/** How often the run asks the pressure again while it wakes tabs (the reading itself is kept 30 s by shell/sleep-pressure.ts). */
export const RELOAD_ALL_PRESSURE_EVERY_MS = 10_000

/**
 * How many awake pages are asked at once whether a field is being edited before their reload (the reloads themselves still start one at a time,
 * a gap apart): a page that does not answer holds its place for the few seconds it is given, not the whole list behind it.
 */
export const RELOAD_ALL_ASK_MAX = 4

/**
 * The longest a run may last before it is ended, whatever it still waits for: 10 minutes. Each tab has its own bound (an awake page is asked for 3 s
 * at most, a woken one is given 10 s to load and its whole turn ends within 30 s), so a run always ends; this one is the last guard, against a wait
 * nothing else bounds, so that the button is never left without an answer. 135 sleeping tabs, 8 at a time, all at their own bound, would take
 * 135 / 8 × 10 s ≈ 3 min (and 135 / 3 × 10 s ≈ 7.5 min under a memory warning): an honest run ends before it, and the notice says how many tabs
 * were left when one does not.
 */
export const RELOAD_ALL_TOTAL_LIMIT_MS = 10 * 60_000

/** How often the notice of a run says how far it is: every 2 s at most, so that a screen reader is not told of every tab. */
export const RELOAD_ALL_PROGRESS_MS = 2000

/**
 * Runs `start` for each item in order, with at most `limit` runs going on at once and the starts `gapMs` apart at least: "Actualiser tous les
 * onglets" wakes the sleeping tabs this way, each run holding its place until its tab is back to sleep (or kept awake). `limit` may be a function:
 * it is asked again before each start (the memory pressure lowers it as the run goes). `start` answers null for an item with nothing to do: it
 * takes no place and no gap. A run that fails (or a `start` that throws) ends like the others, and `onError` hears of it. Resolves once every
 * run has ended.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number | (() => number),
  gapMs: number,
  start: (item: T) => Promise<unknown> | null,
  options: { wait?: (ms: number) => Promise<void>; onError?: (item: T, error: unknown) => void } = {}
): Promise<void> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const most = (): number => {
    const asked = typeof limit === 'function' ? limit() : limit
    return Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1
  }
  const running = new Set<Promise<void>>()
  for (const item of items) {
    while (running.size >= most()) await Promise.race(running)
    let run: Promise<unknown> | null
    try {
      run = start(item)
    } catch (error) {
      options.onError?.(item, error)
      continue
    }
    if (run === null) continue
    const tracked: Promise<void> = run.then(
      () => undefined,
      (error: unknown) => options.onError?.(item, error)
    ).finally(() => running.delete(tracked))
    running.add(tracked)
    if (gapMs > 0) await wait(gapMs)
  }
  await Promise.all(running)
}

/** The tabs a reload covers: those of the space named, or all of them when none is (the button of every space). */
export function tabsInScope<T extends { spaceId: string }>(tabs: readonly T[], spaceId?: string): T[] {
  return spaceId === undefined ? [...tabs] : tabs.filter((tab) => tab.spaceId === spaceId)
}

/** The notice of the button of one space: it says which, so that it is not taken for the reload of every space. */
export function scopedReloadNotice(spaceName: string, notice: string): string {
  return t('reload-all.espace-name-notice', { name: spaceName, notice })
}

/** The toast after the run: how many tabs came back (`woken` of them were asleep), and how many were left alone because the user is typing in them. */
export function reloadAllNotice(reloaded: number, kept: number, woken = 0): string {
  const total = reloaded + woken
  const done = total === 0 ? t('reload-all.aucun-onglet-a-actualiser') : total === 1 ? t('reload-all.1-onglet-actualise') : t('reload-all.total-onglets-actualises', { total })
  const withSleepers = woken > 0 && reloaded > 0 ? (woken > 1 ? t('reload-all.done-dont-woken-reveilles', { done, woken }) : t('reload-all.done-dont-woken-reveille', { done, woken })) : done
  if (kept === 0) return withSleepers
  const left = kept === 1 ? t('reload-all.1-laisse-tel-quel-saisie-en-cours') : t('reload-all.kept-laisses-tels-quels-saisie-en-cours', { kept })
  return total === 0 ? `${left.charAt(0).toUpperCase()}${left.slice(1)}` : `${withSleepers}, ${left}`
}

/** The offer that comes with the toast when sleeping tabs were left alone. */
export function wakeOfferLabel(asleep: number): string {
  return asleep === 1 ? t('reload-all.actualiser-aussi-l-onglet-en-veille') : t('reload-all.actualiser-aussi-les-asleep-onglets-en-veille', { asleep })
}

/** The offer that comes with the toast when tabs, once reloaded, show that their site does not answer: it opens the list (renderer/DeadTabsSheet.tsx). */
export function deadTabsOfferLabel(dead: number): string {
  return dead === 1 ? t('reload-all.voir-l-onglet') : t('reload-all.voir-les-dead-onglets', { dead })
}

/** What the toast says about them, after the notice of the run. */
export function deadTabsNotice(dead: number): string {
  return dead === 1 ? t('reload-all.1-site-ne-repond-plus') : t('reload-all.dead-sites-ne-repondent-plus', { dead })
}

/** The notice of a run that goes on: at once at the click ("Actualisation de 135 onglets…"), then how far it is. */
export function reloadProgressNotice(done: number, total: number): string {
  return done <= 0 ? tp('reload-all.actualisation-de-onglets', total) : t('reload-all.actualisation-done-sur-total', { done, total })
}

/** What a click says while a run goes on (it does not start another): how far that run is. */
export function reloadBusyNotice(done: number, total: number): string {
  return t('reload-all.deja-en-cours-done-sur-total', { done, total })
}

/**
 * The two phases of a run. The awake tabs first: a reload asked of a page in memory, a few seconds for the lot. Then the sleeping ones, which are woken,
 * loaded afresh and put back to sleep: the long part, a page at a time per place (`RELOAD_ALL_AWAKE_MAX`).
 */
export type ReloadPhase = 'awake' | 'sleeping'

/** What the row of a tab shows while a run covers it: its turn is to come, it is under way, or it was reloaded a moment ago. */
export type ReloadMark = 'pending' | 'running' | 'reloaded'

/** How long a row keeps its mark « Actualisé » once its tab is done: a sleeping tab goes back to sleep at once, and the mark is what says it was reloaded. */
export const RELOAD_ALL_DONE_MARK_MS = 4000

/** What the interface is told of the run under way in its window (UiSnapshot.reloadRun): its button turns, and says how far it is. */
export interface ReloadRunView {
  done: number
  total: number
  phase: ReloadPhase
  /** The space of the button of one space; absent for the run of every space. */
  spaceId?: string
  /** « Arrêter » was pressed: the tabs under way end their turn, no other starts. */
  stopping?: true
}

/** What the rows need to know of a run: the tabs whose turn is to come, those under way, and when each of the others was reloaded. */
export interface ReloadMarkSource {
  pending: ReadonlySet<string>
  running: ReadonlySet<string>
  reloadedAt: ReadonlyMap<string, number>
}

/**
 * The mark of each row a run covers, now: under way first, then to come, then « Actualisé » for `RELOAD_ALL_DONE_MARK_MS` after its reload. A tab
 * left alone (a field being edited) or gone has no mark. Undefined when no row has one, so that the snapshot carries nothing.
 */
export function reloadMarks(source: ReloadMarkSource, now: number): Record<string, ReloadMark> | undefined {
  const marks: Record<string, ReloadMark> = {}
  for (const [id, at] of source.reloadedAt) if (now - at < RELOAD_ALL_DONE_MARK_MS && now >= at) marks[id] = 'reloaded'
  for (const id of source.pending) marks[id] = 'pending'
  for (const id of source.running) marks[id] = 'running'
  return Object.keys(marks).length > 0 ? marks : undefined
}

/** The estimate of the time left waits for this many tabs of the phase and this long: before, a few fast or slow pages would make it say anything. */
export const RELOAD_ALL_ESTIMATE_AFTER_TABS = 8
export const RELOAD_ALL_ESTIMATE_AFTER_MS = 10_000

/** How far the phase of the sleeping tabs is: when it started, how many of its tabs are done, of how many. */
export interface ReloadPace {
  startedAt: number
  done: number
  total: number
}

/**
 * The time the sleeping tabs still need, at the pace of those done so far (ms), or null while that pace says nothing reliable yet: fewer than
 * `RELOAD_ALL_ESTIMATE_AFTER_TABS` tabs done, or less than `RELOAD_ALL_ESTIMATE_AFTER_MS` since the phase began. The pace includes the slow start
 * (the first tabs all load at once), so the estimate errs on the long side.
 */
export function reloadRemainingMs(pace: ReloadPace, now: number): number | null {
  const elapsed = now - pace.startedAt
  const left = Math.max(0, pace.total - pace.done)
  if (left === 0) return 0
  if (pace.done < RELOAD_ALL_ESTIMATE_AFTER_TABS || elapsed < RELOAD_ALL_ESTIMATE_AFTER_MS) return null
  return Math.round((left * elapsed) / pace.done)
}

/**
 * The line under the count in the notice of a run: which tabs it is on and, for the sleeping ones, the time left once it is reliable. `afterAwake`:
 * the awake tabs were done just before (the notice says so as the run turns to the sleeping ones).
 */
export function reloadPhaseDetail(phase: ReloadPhase, options: { afterAwake?: boolean; remainingMs?: number | null } = {}): string {
  if (phase === 'awake') return t('reload-all.phase-eveilles')
  const remaining = options.remainingMs ?? null
  if (remaining === null) return options.afterAwake ? t('reload-all.phase-veille-apres-eveilles') : t('reload-all.phase-veille')
  if (remaining < 60_000) return t('reload-all.phase-veille-moins-d-une-minute')
  return tp('reload-all.phase-veille-minutes', Math.max(1, Math.round(remaining / 60_000)))
}

/** The line of the notice once sites that no longer answer are known, before the end of the run. */
export function reloadDetailWithDead(detail: string, dead: number): string {
  return dead > 0 ? t('reload-all.detail-puis-morts', { detail, dead: deadTabsNotice(dead) }) : detail
}

/** The name of the button while its run goes on: how far it is, and that a click offers to stop it. */
export function reloadButtonBusyLabel(view: Pick<ReloadRunView, 'done' | 'total' | 'stopping'>): string {
  return view.stopping ? t('reload-all.arret-en-cours') : t('reload-all.bouton-en-cours', { done: view.done, total: view.total })
}

/** Whether the button of every space (`space` undefined) or of the space `space` is the one whose run goes on. */
export function reloadButtonBusy(view: Pick<ReloadRunView, 'spaceId'> | undefined, space?: string): boolean {
  if (!view) return false
  return space === undefined ? view.spaceId === undefined : view.spaceId === space
}

/** How a run ended: done, stopped by the user (« Arrêter »), or ended by `RELOAD_ALL_TOTAL_LIMIT_MS`. */
export type ReloadEnd = 'done' | 'stopped' | 'timeout'

/**
 * The notice at the end of a run (`notice`, from `reloadAllNotice`): a run that did not go to its end says so, and how many tabs it left as they were
 * (`left`). `anything` is false when no tab was reached before the end: the notice of the counts would only say « Aucun onglet à actualiser ».
 */
export function reloadEndNotice(notice: string, end: ReloadEnd, left: number, anything = true): string {
  if (end === 'done' || left <= 0) return notice
  const ended = end === 'stopped' ? tp('reload-all.actualisation-arretee', left) : tp('reload-all.actualisation-interrompue', left, { minutes: RELOAD_ALL_TOTAL_LIMIT_MS / 60_000 })
  return anything ? t('reload-all.notice-puis-fin', { notice, ended }) : ended
}
