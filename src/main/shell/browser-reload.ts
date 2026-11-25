// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Reloading every tab (« Actualiser tous les
// onglets », the sleeping ones woken one after the other), the tabs that do not answer any more, the tabs that reload themselves, and the
// tabs woken at launch. Cut out of browser-sleep.ts as it was: it stands on the sleep of the tabs.

import { net } from 'electron'
import type { RuntimeState, TabItem } from '@shared/model'
import { activeTab } from '@shared/sidebar'
import { tabsToWakeAtLaunch } from '@shared/sleep'
import { AUTO_RELOAD_EDITING_SCRIPT, isAutoReloadable, withReloadAt } from '@shared/auto-reload'
import { noWakeTabIds } from '@shared/folders'
import { RELOAD_ALL_RESULT_NOTICE_MS, RELOAD_ALL_ASK_MAX, RELOAD_ALL_DONE_MARK_MS, RELOAD_ALL_PRESSURE_EVERY_MS, RELOAD_ALL_PROGRESS_MS, RELOAD_ALL_TOTAL_LIMIT_MS, deadTabsNotice, deadTabsOfferLabel, reloadAllNotice, reloadBusyNotice, reloadDetailWithDead, reloadEndNotice, reloadMarks, reloadPhaseDetail, reloadProgressNotice, reloadRemainingMs, reloadWakeLimit, runLimited, scopedReloadNotice, tabsInScope, reloadAllTargets, sleepingTargets, wakeOfferLabel, type ReloadRunView } from '@shared/reload-all'
import { deadReasonOf, deadTabsToOffer, stillOffered, type DeadTabEntry, type LoadFailure } from '@shared/dead-tabs'
import type { UiSnapshot } from '@shared/ipc'
import type { Page } from '../engine/types'
import type { AutoReloadTarget } from './auto-reload'
import { batterySaver } from './battery-saver'
import { within } from '@shared/within'
import { t } from '@shared/i18n'
import { LAUNCH_WAKE_BATCH, LAUNCH_WAKE_GAP_MS, DEAD_TABS_FIRST_LOOK_MS, DEAD_TABS_LAUNCH_SETTLE_MS, DEAD_TABS_OFFER_MS, DEAD_TABS_SETTLE_MS, PAGE_ASK_TIMEOUT_MS, RELOAD_ALL_LOAD_LIMIT_MS, RELOAD_ALL_STAGGER_MS, RELOAD_ALL_TAB_LIMIT_MS, type ReloadRun, type ToastMore } from './browser-base'
import { memoryPressure } from './sleep-pressure'
import { BrowserSleep } from './browser-sleep'

export abstract class BrowserReload extends BrowserSleep {
  // ---- automatic reload: tabs that reload themselves at an interval (rules: shared/auto-reload.ts, countdowns: auto-reload.ts) ----

  /** The tabs with an interval whose page is live and not frozen. A tab asleep or frozen is not in the list: the countdown never wakes it. */
  protected autoReloadTargets(): AutoReloadTarget[] {
    // The battery saver stops the tabs that reload themselves; their intervals are kept, and the countdowns start again when it ends.
    if (batterySaver().active()) return []
    return this.store.get().tabs.flatMap((tab): AutoReloadTarget[] => {
      const page = this.pages.get(tab.id)
      if (!tab.autoReload || !page || this.frozen.has(tab.id)) return []
      return [{ tab, page, loading: this.runtime.tabs[tab.id]?.loading === true, reload: () => page.reload(), isEditing: () => this.pageIsBeingEdited(page) }]
    })
  }

  /** Whether the user is in the middle of a field of the page: a focused field with text, or text typed in a field and not sent. */
  private async pageIsBeingEdited(page: Page): Promise<boolean> {
    const asked = Promise.all([page.evaluate(AUTO_RELOAD_EDITING_SCRIPT), page.probeForSleep()]).then(([focused, probe]) => focused === true || probe?.unsentInput === true)
    // A page that never answers (busy, hung, or on its way to an error page) must not hold "Actualiser tous les onglets" for ever: it is reloaded.
    return within(asked, PAGE_ASK_TIMEOUT_MS, false, () => console.warn(`[page] a page did not say within ${PAGE_ASK_TIMEOUT_MS} ms whether a field is being edited: it is treated as not being edited`))
  }

  /**
   * "Actualiser tous les onglets": reloads the live pages of every space, one after the other so that dozens of tabs do not hit the network
   * at once (rules: shared/reload-all.ts). A page the user is typing in is left alone, and the toast says how many. The tabs that sleep are
   * woken, loaded afresh and put back to sleep when `wakeSleeping` says so: the buttons of the sidebar always do (ipc.ts), the menu and the
   * command bar when the setting `reloadAllWakes` does; otherwise the toast offers to. The run has two phases: the awake tabs first, a few
   * seconds, then the sleeping ones (`wakeAndReload`). A notice says at the click how many tabs the run covers, then how far it is (« 12 sur
   * 135 », a bar, the phase, the time left once it can be told), with « Arrêter », and the sites found not to answer as they are found; the
   * button of the run turns and each row says whether its turn is to come, under way or done (`reloadOfSnapshot`). A second request while one
   * is running starts nothing and says how far that one is. A run never lasts more than `RELOAD_ALL_TOTAL_LIMIT_MS`. `staggerMs` is for the
   * engine smoke test.
   */
  async reloadAllTabs(staggerMs = RELOAD_ALL_STAGGER_MS, wakeSleeping = this.store.get().settings.reloadAllWakes, onlySpace = false): Promise<{ reloaded: number; kept: number; woken: number }> {
    if (this.reloadRun) {
      this.tellReloadBusy(this.reloadRun)
      return { reloaded: 0, kept: 0, woken: 0 }
    }
    // The button of the space reloads the tabs of the space on screen only; the other one, the tabs of every space.
    const spaceId = onlySpace ? this.store.get().activeSpaceId : undefined
    // The pages of every window of the group, not only of this one: a tab shown by another window has its page there, and is reloaded there (the
    // sleeping ones are looked for across the group the same way, `sleepingTabIds`). A tab of a locked space has no page to reload.
    const scoped = tabsInScope(this.store.get().tabs, spaceId).filter((tab) => !this.isTabLocked(tab))
    const awake = reloadAllTargets(scoped, new Set(scoped.filter((tab) => this.ownerOf(tab.id)).map((tab) => tab.id)), new Set([...this.group].flatMap((browser) => [...browser.frozen])))
    const sleeping = wakeSleeping ? this.sleepingTabIds(spaceId) : []
    const counts = { reloaded: 0, kept: 0, woken: 0 }
    const reloadedIds: string[] = []
    // The awake pages just reloaded are looked at while the sleeping ones are woken: a site that no longer answers is known before a long run ends.
    let looked: Promise<void> = Promise.resolve()
    const run = await this.runReload({ awake, sleeping }, spaceId, async (current) => {
      // A few pages are asked at once whether a field is being edited (one that does not answer holds its place 3 s, not the list behind it); the
      // reloads still start `staggerMs` apart.
      await runLimited(awake, RELOAD_ALL_ASK_MAX, staggerMs, (id) => {
        if (current.end) return null
        const owner = this.ownerOf(id)
        const page = owner?.pages.get(id)
        if (!owner || !page || owner.frozen.has(id)) {
          this.stepReload(current, id, false)
          return null
        }
        this.startTurn(current, id)
        // A page that cannot answer (hung, or gone meanwhile) cannot be in the middle of a field: it is reloaded, which is what the user asked.
        const asked = this.pageIsBeingEdited(page).catch((error: unknown) => {
          console.warn(`[reload-all] tab ${id} could not tell whether it is being edited, it is reloaded:`, (error as Error).message)
          return false
        })
        let reloadedIt = false
        return asked
          .then((editing) => {
            if (editing) counts.kept++
            else if (owner.pages.get(id) === page && !owner.frozen.has(id)) {
              page.reload()
              counts.reloaded++
              reloadedIds.push(id)
              reloadedIt = true
            }
          })
          .finally(() => this.stepReload(current, id, reloadedIt))
      }, { onError: (id, error) => console.warn(`[reload-all] tab ${id} could not be reloaded:`, (error as Error).message) })
      if (reloadedIds.length > 0) {
        looked = this.lookAtReloaded(reloadedIds, current.outcomes)
          .then(() => this.tellDeadTabs(current))
          .catch((error: unknown) => console.warn('[reload-all] the pages just reloaded could not be looked at:', (error as Error).message))
      }
      if (sleeping.length > 0 && !current.end) {
        this.enterSleepingPhase(current)
        await this.wakeAndReload(sleeping, staggerMs, current, counts, current.outcomes)
      }
    })
    const asleep = wakeSleeping ? 0 : this.sleepingTabIds(spaceId).length
    const notice = reloadEndNotice(reloadAllNotice(counts.reloaded, counts.kept, counts.woken), run.end ?? 'done', run.total - run.done, run.done > 0)
    this.showToast(this.scopedNotice(run, notice), asleep > 0 && run.end === null ? { label: wakeOfferLabel(asleep), run: () => void this.reloadSleepingTabs(staggerMs, spaceId) } : undefined, RELOAD_ALL_RESULT_NOTICE_MS)
    if (reloadedIds.length > 0 || run.outcomes.size > 0) void looked.then(() => this.offerFound(run))
    return { ...counts }
  }

  /** The offer of the notice: wakes the tabs that still sleep and loads them afresh, as a run of its own. Resolves how many were woken. */
  async reloadSleepingTabs(staggerMs = RELOAD_ALL_STAGGER_MS, spaceId?: string): Promise<number> {
    if (this.reloadRun) {
      this.tellReloadBusy(this.reloadRun)
      return 0
    }
    const ids = this.sleepingTabIds(spaceId)
    const counts = { woken: 0 }
    const run = await this.runReload({ awake: [], sleeping: ids }, spaceId, (current) => this.wakeAndReload(ids, staggerMs, current, counts, current.outcomes))
    this.showToast(this.scopedNotice(run, reloadEndNotice(reloadAllNotice(0, 0, counts.woken), run.end ?? 'done', run.total - run.done, run.done > 0)), undefined, RELOAD_ALL_RESULT_NOTICE_MS)
    if (run.outcomes.size > 0) this.offerFound(run)
    return counts.woken
  }

  /**
   * Runs `work` as the run of "Actualiser tous les onglets" over these tabs: a second request meanwhile does not start another one. The notice
   * comes at once (a run of a hundred sleeping tabs lasts minutes), every row of the run is marked as to come, and the run is ended after
   * `RELOAD_ALL_TOTAL_LIMIT_MS` whatever it still waits for: what was not reached is left as it is, and the next request starts afresh. Resolves
   * the run, which says how far it went and how it ended.
   */
  private async runReload(targets: { awake: readonly string[]; sleeping: readonly string[] }, spaceId: string | undefined, work: (run: ReloadRun) => Promise<unknown>): Promise<ReloadRun> {
    const total = targets.awake.length + targets.sleeping.length
    const spaceName = this.spaceNameOf(spaceId)
    const run: ReloadRun = {
      total,
      done: 0,
      end: null,
      toastId: null,
      toldAt: 0,
      soon: null,
      ...(spaceName === undefined ? {} : { spaceName }),
      ...(spaceId === undefined ? {} : { spaceId }),
      phase: targets.awake.length > 0 || targets.sleeping.length === 0 ? 'awake' : 'sleeping',
      afterAwake: targets.awake.length > 0,
      pace: { startedAt: Date.now(), done: 0, total: targets.sleeping.length },
      pending: new Set([...targets.awake, ...targets.sleeping]),
      running: new Set(),
      reloadedAt: new Map(),
      outcomes: new Map()
    }
    this.reloadRun = run
    this.reloadEnded = null
    this.deadFound = []
    // The button turns and the rows are marked at once, before the first page is asked anything.
    this.publish()
    try {
      if (total > 0) this.tellReloadProgress(run, 'show')
      await within(
        work(run).then(() => undefined),
        RELOAD_ALL_TOTAL_LIMIT_MS,
        undefined,
        () => {
          run.end ??= 'timeout'
          console.warn(`[reload-all] the run did not end within ${RELOAD_ALL_TOTAL_LIMIT_MS / 60_000} min: ended with ${run.done} of ${run.total} tabs done`)
        }
      )
    } finally {
      // A run that was ended by its bound and finishes later must not end the one that came after it.
      if (this.reloadRun === run) {
        this.reloadRun = null
        this.keepLastMarks(run)
      }
    }
    return run
  }

  /** The awake tabs are done: the run turns to the sleeping ones, and its notice says so at once. */
  private enterSleepingPhase(run: ReloadRun): void {
    if (run.phase === 'sleeping') return
    run.phase = 'sleeping'
    run.pace = { ...run.pace, startedAt: Date.now(), done: 0 }
    this.tellReloadProgress(run, 'now')
    this.publish()
  }

  /** The turn of a tab of the run begins: its row turns from « to come » to under way. */
  private startTurn(run: ReloadRun, id: string): void {
    run.pending.delete(id)
    run.running.add(id)
    this.publishMarks()
  }

  /**
   * One more tab of the run dealt with (reloaded, left alone, woken and put back, or found gone): its row loses its mark, or shows « Actualisé » a
   * moment when it was reloaded (`reloaded`), and the notice says so, every `RELOAD_ALL_PROGRESS_MS` at most.
   */
  private stepReload(run: ReloadRun, id?: string, reloaded = false): void {
    run.done++
    if (run.phase === 'sleeping') run.pace.done++
    if (id !== undefined) {
      run.pending.delete(id)
      run.running.delete(id)
      if (reloaded) run.reloadedAt.set(id, Date.now())
    }
    this.publishMarks()
    this.tellReloadProgress(run)
  }

  /**
   * The rows and the button follow the run with a publication that may wait a moment (shell/publish-queue.ts): the steps of a hundred tabs make a
   * few publications a second, not one each.
   */
  private publishMarks(): void {
    this.publishQueue.soon()
  }

  /** The rows of a run that ended keep their mark « Actualisé » a moment: the run is kept for that, then the window is told once more. */
  private keepLastMarks(run: ReloadRun): void {
    run.pending.clear()
    run.running.clear()
    this.reloadEnded = run
    this.publish()
    setTimeout(() => {
      if (this.reloadEnded !== run) return
      this.reloadEnded = null
      this.publish()
    }, RELOAD_ALL_DONE_MARK_MS)
  }

  /** What the interface is told of the run of this window: how far it is (its button turns), and the tabs found so far whose site no longer answers. */
  protected reloadOfSnapshot(): Pick<UiSnapshot, 'reloadRun' | 'deadTabs'> {
    const run = this.reloadRun
    const view: ReloadRunView | undefined = run
      ? { done: run.done, total: run.total, phase: run.phase, ...(run.spaceId === undefined ? {} : { spaceId: run.spaceId }), ...(run.end !== null ? { stopping: true as const } : {}) }
      : undefined
    return { ...(view ? { reloadRun: view } : {}), ...(this.deadFound.length > 0 ? { deadTabs: [...this.deadFound] } : {}) }
  }

  /** The marks of the rows the run covers (or the one that just ended), in the runtime the rows read. */
  protected withReloadMarks(runtime: RuntimeState): RuntimeState {
    const run = this.reloadRun ?? this.reloadEnded
    const marks = run ? reloadMarks(run, Date.now()) : undefined
    return marks ? { ...runtime, reloadMarks: marks } : runtime
  }

  /**
   * The notice of a run: at once (`show`), at a turn of the run (`now`: the phase changed), at a step, every `RELOAD_ALL_PROGRESS_MS` at most, or
   * `soon`: what must not wait for the next step (a site found not to answer), once those two seconds have passed. A notice the person closed, or
   * that another one replaced, is not brought back for a progress: a click on the button brings it back (`tellReloadBusy`), and the end of the run
   * says how it went in any case.
   */
  private tellReloadProgress(run: ReloadRun, when: 'step' | 'soon' | 'now' | 'show' = 'step'): void {
    const since = Date.now() - run.toldAt
    if ((when === 'step' || when === 'soon') && since < RELOAD_ALL_PROGRESS_MS) {
      if (when === 'soon') {
        run.soon ??= setTimeout(() => {
          run.soon = null
          if (this.reloadRun === run && run.end === null) this.tellReloadProgress(run, 'now')
        }, RELOAD_ALL_PROGRESS_MS - since)
      }
      return
    }
    run.toldAt = Date.now()
    const notice = this.runNotice(run)
    if (run.toastId !== null && this.reviseToast(run.toastId, notice.message, notice.more)) return
    run.toastId = null
    if (when === 'show') run.toastId = this.showStopNotice(run, notice)
  }

  /**
   * What the notice of a run says now: « 12 sur 135 » (or that a run is already under way, for a second request), the phase and the time left on
   * the line under it, the bar, and the sites found not to answer with the button that shows them.
   */
  private runNotice(run: ReloadRun, busy = false): { message: string; more: ToastMore & { second?: { label: string; run: () => void } } } {
    const message = this.scopedNotice(run, busy ? reloadBusyNotice(run.done, run.total) : reloadProgressNotice(run.done, run.total))
    const remainingMs = run.phase === 'sleeping' ? reloadRemainingMs(run.pace, Date.now()) : null
    const dead = this.deadFound.length
    const detail = reloadDetailWithDead(reloadPhaseDetail(run.phase, { afterAwake: run.afterAwake, remainingMs }), dead)
    return {
      message,
      more: { detail, progress: { done: run.done, total: run.total }, ...(dead > 0 ? { second: { label: deadTabsOfferLabel(dead), run: () => this.showDeadTabs(this.deadFound) } } : {}) }
    }
  }

  /** A notice of the run with « Arrêter », that stays as long as a run may last; resolves its id, for the progress to change its words. */
  private showStopNotice(run: ReloadRun, notice: ReturnType<BrowserReload['runNotice']>): number | null {
    const { second, ...more } = notice.more
    this.showToast(notice.message, { label: t('reload-all.arreter'), run: () => this.stopReload(run), ...(second ? { second } : {}) }, RELOAD_ALL_TOTAL_LIMIT_MS, more)
    return this.toast?.id ?? null
  }

  /** A request while a run goes on (a click on its button): the notice says it is under way and how far, with « Arrêter », instead of nothing at all. */
  private tellReloadBusy(run: ReloadRun): void {
    if (run.end !== null) {
      this.showToast(t('reload-all.arret-en-cours'))
      return
    }
    run.toldAt = Date.now()
    run.toastId = this.showStopNotice(run, this.runNotice(run, true))
  }

  /** « Arrêter »: no tab is started after this; the ones under way end their turn, then the notice of the end says how many were left. */
  private stopReload(run: ReloadRun): void {
    if (this.reloadRun !== run || run.end !== null) return
    run.end = 'stopped'
    run.toastId = null
    this.showToast(t('reload-all.arret-en-cours'))
  }

  /** The notices of the button of one space name it, so that they are not taken for the reload of every space. */
  private scopedNotice(run: ReloadRun, notice: string): string {
    return run.spaceName === undefined ? notice : scopedReloadNotice(run.spaceName, notice)
  }

  private spaceNameOf(spaceId: string | undefined): string | undefined {
    return spaceId === undefined ? undefined : this.store.get().spaces.find((space) => space.id === spaceId)?.name
  }

  /**
   * Once the pages of `ids` have settled (the first look waits `DEAD_TABS_FIRST_LOOK_MS`, then for the loads under way, `settleMs` at most), how each
   * load ended goes into `outcomes`. A page still loading at the end of the wait says nothing yet: it is left out.
   */
  private async lookAtReloaded(ids: readonly string[], outcomes: Map<string, LoadFailure | null>, settleMs = DEAD_TABS_SETTLE_MS): Promise<void> {
    if (ids.length === 0) return
    const deadline = Date.now() + settleMs
    await new Promise((resolve) => setTimeout(resolve, DEAD_TABS_FIRST_LOOK_MS))
    // The tabs may live in other windows of the group: each is read where its page is.
    const loading = (id: string): boolean => this.ownerOf(id)?.runtime.tabs[id]?.loading === true
    while (Date.now() < deadline && ids.some(loading)) await new Promise((resolve) => setTimeout(resolve, 300))
    for (const id of ids) {
      const page = this.ownerOf(id)?.pages.get(id)
      if (page && !loading(id)) outcomes.set(id, page.loadFailure())
    }
  }

  /**
   * The tabs to offer as no longer answering, from these outcomes (shared/dead-tabs.ts: no such address, connection refused or reset, timed out,
   * unreachable, a page removed). Nothing while the network is down, nor in a private window (it keeps no archive). The pages of favourites and the
   * tabs the user kept are never offered; pinned tabs are, in a group of their own.
   */
  private deadEntriesOf(outcomes: ReadonlyMap<string, LoadFailure | null>): DeadTabEntry[] {
    if (this.isPrivate()) return []
    return deadTabsToOffer(outcomes, this.store.get().tabs, { online: this.networkOnline(), now: Date.now(), hidden: (tab) => this.isTabLocked(tab) })
  }

  /**
   * Sites found not to answer while the run goes on (the awake pages once settled, each woken tab once loaded): the list open meanwhile adds them
   * (`deadTabs` of the snapshot), and the notice of the run says how many with a button that shows them, within two seconds (`soon`).
   */
  private tellDeadTabs(run: ReloadRun): void {
    if (this.reloadRun !== run || run.end !== null) return
    const entries = this.deadEntriesOf(run.outcomes)
    if (sameEntries(entries, this.deadFound)) return
    this.deadFound = entries
    this.publish()
    this.tellReloadProgress(run, 'soon')
  }

  /**
   * Once a run has ended and its awake pages were looked at: the tabs whose site no longer answers, in a notice that replaces the one of the end,
   * whose button opens the list, where each can be shown, kept or closed (renderer/DeadTabsSheet.tsx). The list already open has them (it grows by
   * itself): no notice then. A later run has its own.
   */
  private offerFound(run: ReloadRun): void {
    if (this.reloadRun !== null && this.reloadRun !== run) return
    const entries = this.deadEntriesOf(run.outcomes)
    if (!sameEntries(entries, this.deadFound)) {
      this.deadFound = entries
      this.publish()
    }
    this.offerDead(entries)
  }

  /** The load of every tab at launch: once the pages have settled, the tabs whose site no longer answers are offered as after a run. */
  private async offerDeadTabs(ids: readonly string[], outcomes: Map<string, LoadFailure | null>, settleMs = DEAD_TABS_SETTLE_MS): Promise<void> {
    if (this.isPrivate()) return
    await this.lookAtReloaded(ids, outcomes, settleMs)
    const entries = this.deadEntriesOf(outcomes)
    this.deadFound = entries
    this.publish()
    this.offerDead(entries)
  }

  /** The notice « N sites ne répondent plus », with « Voir les N onglets… ». One list at a time: an open one grows by itself instead. */
  private offerDead(entries: readonly DeadTabEntry[]): void {
    if (entries.length === 0 || this.overlayRequest?.panel === 'deadtabs') return
    this.showToast(deadTabsNotice(entries.length), { label: deadTabsOfferLabel(entries.length), run: () => this.showDeadTabs(entries) }, DEAD_TABS_OFFER_MS)
  }

  /** The button of the notice: the list of the tabs whose site no longer answers, with those still open (closed since, or the page of a favourite, a tab is not shown). */
  showDeadTabs(entries: readonly DeadTabEntry[]): void {
    const still = stillOffered(entries, this.store.get().tabs)
    if (still.length > 0) this.openOverlay({ panel: 'deadtabs', entries: still })
  }

  /** Whether this Mac has a network at all: without one, a load that failed says nothing of its site. */
  protected networkOnline(): boolean {
    return net.isOnline()
  }

  /**
   * The tabs that sleep, now: no page in any window of the group (put to sleep, or not opened in this run), or a frozen page of this one. A tab of a
   * locked space (or of a locked application) is none of them: its page is made when the space is unlocked and the tab shown, never by a reload.
   */
  private sleepingTabIds(spaceId?: string): string[] {
    // A tab of a folder marked « à ne pas réveiller » is woken by no reload either (shared/folders.ts).
    const never = noWakeTabIds(this.store.get())
    const tabs = tabsInScope(this.store.get().tabs, spaceId).filter((tab) => !this.isTabLocked(tab) && !never.has(tab.id))
    return sleepingTargets(tabs, new Set(tabs.filter((tab) => this.ownerOf(tab.id)).map((tab) => tab.id)), this.frozen)
  }

  /**
   * Gives each of these tabs a live page that loads its address afresh, then puts it back to sleep once the page has loaded (`sleepAgain`): the
   * pages are fresh and the memory goes back to what it was. The starts are `staggerMs` apart, and at most `reloadWakeLimit` of these tabs are
   * awake at once (8, fewer when macOS says the memory is short, asked again every `RELOAD_ALL_PRESSURE_EVERY_MS`; `runLimited`), a tab kept awake
   * leaving its place to the next. A frozen page runs again first. A tab that is closed, or that woke up meanwhile (the user selected it, another
   * window took it), is not touched. The turn of a tab ends within `RELOAD_ALL_TAB_LIMIT_MS`; none starts once the run has ended (`run.end`). How
   * each load ended goes into `outcomes` (the sites that no longer answer are told as they are found), `counts.woken` counts them.
   */
  private async wakeAndReload(ids: readonly string[], staggerMs: number, run: ReloadRun, counts: { woken: number; kept?: number }, outcomes: Map<string, LoadFailure | null>): Promise<void> {
    const before = counts.woken
    let limit = reloadWakeLimit(await memoryPressure())
    let pressureAt = Date.now()
    const reloaded = async (id: string, page: Page, idleMark: number | undefined, wasFrozen: boolean): Promise<void> => {
      const deadline = Date.now() + RELOAD_ALL_LOAD_LIMIT_MS
      await this.untilLoaded(id, RELOAD_ALL_LOAD_LIMIT_MS)
      // A load that ended on another one already under way (HTTPS first falling back to http, a page that sends itself elsewhere) is waited for too.
      while (this.pages.get(id) === page && this.runtime.tabs[id]?.loading === true && Date.now() < deadline) await this.untilLoaded(id, deadline - Date.now())
      // Read now: the page goes back to sleep below, and what it shows goes with it.
      if (this.pages.get(id) === page && this.runtime.tabs[id]?.loading !== true) {
        outcomes.set(id, page.loadFailure())
        this.tellDeadTabs(run)
      }
      await this.sleepAgain(id, page, idleMark, wasFrozen)
    }
    const wake = (id: string): Promise<void> | null => {
      const tab = this.store.get().tabs.find((t) => t.id === id)
      // A space locked while the run goes on: its tabs are left as they are (the lock dropped their pages).
      if (!tab || this.isTabLocked(tab)) return null
      if (this.frozen.has(id)) {
        counts.woken++
        return this.thawPage(id).then(async () => {
          const page = this.pages.get(id)
          if (!page) return
          // A page frozen by hand was never asked whether a field holds text not sent (the sweep asks before it freezes): it is asked now, and a page
          // the user is typing in is frozen again as it was instead of losing the text to a reload.
          if (await this.pageIsBeingEdited(page)) {
            if (counts.kept !== undefined) counts.kept++
            if (this.pages.get(id) === page && !this.frozen.has(id)) await this.freezePage(id, page)
            return
          }
          if (this.pages.get(id) !== page) return
          // Waited for before the reload starts: the next end of loading is the reload's.
          const done = reloaded(id, page, this.idleSince.get(id), true)
          page.reload()
          return done
        })
      }
      if (this.ownerOf(id)) return null
      // The extension runtime reports the page it just saw as the active one: that is not a selection by the user.
      this.quietPages = true
      let page: Page
      try {
        page = this.ensurePage(tab)
      } finally {
        this.quietPages = false
      }
      counts.woken++
      this.publish()
      return reloaded(id, page, this.idleSince.get(id), false)
    }
    await runLimited(
      ids,
      () => limit,
      staggerMs,
      (id) => {
        if (run.end) return null
        // The pressure is asked again as the run goes (the reading is kept 30 s): a run that makes the memory short slows down before it gets worse.
        if (Date.now() - pressureAt >= RELOAD_ALL_PRESSURE_EVERY_MS) {
          pressureAt = Date.now()
          void memoryPressure().then(
            (pressure) => (limit = reloadWakeLimit(pressure)),
            (error: unknown) => console.warn('[reload-all] the memory pressure could not be read, the run keeps its pace:', (error as Error).message)
          )
        }
        const turn = wake(id)
        if (turn === null) {
          this.stepReload(run, id, false)
          return null
        }
        this.startTurn(run, id)
        // A turn that never ends (a protocol that does not answer the thaw or the freeze) gives its place back after its bound; the page stays as it is.
        const bounded = within(turn, RELOAD_ALL_TAB_LIMIT_MS, undefined, () => console.warn(`[reload-all] tab ${id} did not come back within ${RELOAD_ALL_TAB_LIMIT_MS / 1000} s: its place goes to the next one`))
        // A tab whose site no longer answers is not marked « Actualisé »: the list of those says it.
        return bounded.finally(() => this.stepReload(run, id, deadReasonOf(outcomes.get(id)) === null))
      },
      { onError: (id, error) => console.warn(`[reload-all] tab ${id} could not be woken and put back to sleep:`, (error as Error).message) }
    )
    if (counts.woken > before) {
      const active = activeTab(this.store.get())
      if (active && this.pages.has(active.id)) this.engine.activatePage(active.id)
      this.publish()
    }
  }

  /**
   * Resolves once the page of this tab has finished loading, once it is gone from this window (put to sleep, closed, taken by another window:
   * see `dropPageState`), or once `limitMs` has passed. Called before the load starts: the next end of loading is the one waited for.
   */
  private untilLoaded(id: string, limitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const end = (): void => {
        clearTimeout(limit)
        if (this.loadEnds.get(id) === end) this.loadEnds.delete(id)
        resolve()
      }
      const limit = setTimeout(end, limitMs)
      this.loadEnds.set(id, end)
    })
  }

  /**
   * A tab "Actualiser tous les onglets" woke has loaded (or was given up on): it goes back to sleep unless the `reload` verdict (shared/sleep.ts)
   * keeps it awake: on screen, shown since it was woken, marked "never put to sleep", reloading itself, of a site never put to sleep, pinned while
   * pinned tabs are spared, playing sound, downloading, in Picture in Picture or holding text typed and not sent (the page is asked last).
   * `idleMark` is when the tab was loaded behind as it was woken: a later one means the user showed it and left it. A page that was frozen is
   * frozen again in the mode « Garder en mémoire » and freed otherwise, as the sweep would; a tab that had no page loses it again whatever the mode:
   * a run that wakes every tab must not leave a page in memory for each of them.
   */
  private async sleepAgain(id: string, page: Page, idleMark: number | undefined, wasFrozen = false): Promise<void> {
    const verdict = await this.autoVerdict(id, page, 'reload', () => this.idleSince.get(id) !== idleMark)
    if (!verdict?.sleep || this.pages.get(id) !== page || this.frozen.has(id)) return
    if (wasFrozen && this.store.get().settings.sleepMode === 'freeze') {
      await this.freezePage(id, page)
      return
    }
    this.destroyPage(id, true)
    this.publish()
  }

  /**
   * The launch (the state and the windows of the last session come back), once every window is open: the tab each window shows already has its
   * page (their sync made it), and only the tabs that wake with the application get one here (shared/sleep.ts, `tabsToWakeAtLaunch`): every tab
   * with "Charger tous les onglets au lancement", otherwise the tabs kept awake, the tabs that reload themselves and one tab for each site never
   * put to sleep that no tab on screen is on. Every other tab sleeps, as a tab the delay put to sleep, and gets its page when it is shown. Called
   * by index.ts once the windows are restored, so that what they show is known. Returns the ids woken.
   */
  wakeAtLaunch(): string[] {
    const group = [...this.group]
    const screen = { shown: new Set(group.flatMap((browser) => [...browser.visible])), spaces: group.map((browser) => browser.store.get().activeSpaceId), locked: (tab: TabItem) => this.isTabLocked(tab) }
    const toWake = tabsToWakeAtLaunch(this.store.get(), screen)
    // By small batches, a few seconds apart: dozens of pages made in the same instant came on screen as black rectangles until they were reloaded.
    const rest = toWake.slice(LAUNCH_WAKE_BATCH)
    const woken = this.wakeInBackground(toWake.slice(0, LAUNCH_WAKE_BATCH))
    // "Charger tous les onglets au lancement" loads every tab: the ones whose site no longer answers are offered as after "Actualiser tous les onglets",
    // once the last batch has had its time to settle.
    const finish = (): void => {
      if (this.store.get().settings.loadAllTabsAtLaunch && woken.length > 0) void this.offerDeadTabs(woken, new Map(), DEAD_TABS_LAUNCH_SETTLE_MS)
    }
    if (rest.length === 0) finish()
    else {
      const next = (): void => {
        // The window may be gone by now (the application is quitting): nothing is made then.
        if (this.win.isDestroyed()) return
        woken.push(...this.wakeInBackground(rest.splice(0, LAUNCH_WAKE_BATCH)))
        if (rest.length > 0) setTimeout(next, LAUNCH_WAKE_GAP_MS)
        else finish()
      }
      setTimeout(next, LAUNCH_WAKE_GAP_MS)
    }
    return woken
  }

  /** Gives a page to every tab of the state that reloads itself and has none, then starts their countdowns. Public for the engine smoke test. */
  resumeAutoReload(): void {
    this.wakeInBackground(this.store.get().tabs.filter((tab) => tab.autoReload !== undefined && isAutoReloadable(tab.url)))
  }

  /** Gives these tabs a page without showing them (none of a locked space), then starts the countdowns of those that reload themselves. Returns the ids woken. */
  protected wakeInBackground(tabs: readonly TabItem[]): string[] {
    const woken: string[] = []
    // The extension runtime calls each new page "active": that is not a selection by the user.
    this.quietPages = true
    try {
      for (const tab of tabs) {
        // A tab whose page this window or another one holds (it shows it) is awake already.
        if (this.ownerOf(tab.id) || this.isTabLocked(tab)) continue
        this.ensurePage(tab)
        woken.push(tab.id)
      }
    } finally {
      this.quietPages = false
    }
    // The extension runtime took the last page made for the one that is active: it is told which tab really is.
    const active = activeTab(this.store.get())
    if (woken.length > 0 && active && this.pages.has(active.id)) this.engine.activatePage(active.id)
    this.autoReloader?.refresh()
    if (woken.length > 0) this.publish()
    return woken
  }

  /** Reloads the tabs whose countdown has ended and that may be reloaded now; resolves their ids. Public for the engine smoke test. */
  autoReloadSweep(): Promise<string[]> {
    return this.autoReloader?.sweep() ?? Promise.resolve([])
  }

  /** The end of each countdown goes into the snapshot (the row counts down by itself); a tab's page may live in another window of the group. */
  protected withReloadAt(runtime: RuntimeState): RuntimeState {
    const armed = this.store.get().tabs.filter((tab) => tab.autoReload)
    if (armed.length === 0) return runtime
    return withReloadAt(runtime, armed, (id) => [...this.group].map((browser) => browser.autoReloader?.countdownOf(id)?.at).find((at) => at !== undefined))
  }

  /** The countdown of a tab (when it ends), and whether the window's single timer is armed. Public for the engine smoke test. */
  autoReloadState(tabId: string): { at: number | null; armed: boolean } {
    return { at: this.autoReloader?.countdownOf(tabId)?.at ?? null, armed: this.autoReloader?.armed() === true }
  }
}

/** Whether two lists of tabs that no longer answer name the same tabs, in the same order. */
function sameEntries(a: readonly DeadTabEntry[], b: readonly DeadTabEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.id === b[i]?.id && entry.reason === b[i]?.reason)
}
