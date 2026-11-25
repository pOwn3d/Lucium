// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The sleep of the tabs: freeze, discard, the
// sweep. Reloading every tab and the tabs that reload themselves stand on it (browser-reload.ts).

import type { SidebarState, SleepMode } from '@shared/model'
import { iconSent, iconShown, unmarked, type IconMark } from '@shared/icon-mark'
import { planReleaseLevels, planSweep, sleepToastAction, sleepToastMessage, sleepVerdict, sweepLimits, type MemoryPressure, type PageProbe, type ReleaseLevel, type SleepBlocker, type SleepFacts, type SleepRules, type SleepVerdict, type SleepVerdictMode, type SweepEntry, type SweepPlan } from '@shared/sleep'
import type { ReleaseOutcome } from '@shared/resources'
import { saverSleepMinutes } from '@shared/battery-saver'
import type { Page } from '../engine/types'
import { batterySaver } from './battery-saver'
import { t } from '@shared/i18n'
import { hostOf } from '@shared/url'
import { SLEEP_KEPT_MS } from './browser-base'
import { BrowserContexts } from './browser-contexts'
import { memoryPressure } from './sleep-pressure'

/** What the sweep adds to the facts of a tab: whether it keeps its site awake, and whether the cap wants it asleep (see `planSweep`). */
type SweepMarks = Pick<SleepFacts, 'siteKeeper' | 'overCap'>

/** A frozen page was asked before it was frozen, and has run nothing since: what it said then still holds. */
const ASKED_BEFORE_FREEZING: PageProbe = { pictureInPicture: false, unsentInput: false }

export abstract class BrowserSleep extends BrowserContexts {
  // ---- sleep: freeing the memory (or the CPU) of tabs nobody is looking at ----

  /** What the rules of `sleepVerdict` need to know of a tab. The page itself is asked separately (`probe`), and only when it comes to that. */
  private sleepFacts(id: string): SleepFacts {
    const info = this.runtime.tabs[id]
    const group = [...this.group]
    return {
      awake: this.pages.has(id),
      selected: group.some((b) => b.shownTabId === id),
      visiblePane: group.some((b) => b.visible.has(id)),
      loading: info?.loading === true,
      audible: info?.audible === true,
      downloading: [...this.leader.downloadSources.values()].includes(id),
      capturing: this.pages.get(id)?.usesCapture?.() === true,
      // Its page is in Lucium's floating window: on screen there, which the page itself cannot say (it is not a Picture in Picture of the system).
      floating: this.leader.floatingVideo?.floatingTab() === id,
      idleMs: Date.now() - (this.idleSince.get(id) ?? Date.now())
    }
  }

  /** Whether the tab is on screen in any window (the selected tab, or a pane of a split view): such a tab cannot be put to sleep. */
  isShown(tabId: string): boolean {
    const facts = this.sleepFacts(tabId)
    return facts.selected || facts.visiblePane
  }

  /** Awake, frozen, or without a page (asleep). */
  sleepStateOf(tabId: string): 'awake' | 'frozen' | 'asleep' {
    if (this.frozen.has(tabId)) return 'frozen'
    return this.pages.has(tabId) ? 'awake' : 'asleep'
  }

  /** A frozen page is not awake either: the flag tells the row it is not asleep. Waking a page clears it. */
  /** Where a tab's icon mark stands after its page sent an icon address (see shared/icon-mark.ts): true when the tab is marked. */
  protected markIcon(id: string, url: string, loading: boolean, wasMarked: boolean): boolean {
    const next = iconSent({ base: this.iconBase.get(id), marked: wasMarked }, url, loading || id === this.shownTabId)
    if (next.base !== undefined) this.iconBase.set(id, next.base)
    return next.marked
  }

  /** A tab is shown: its icon becomes the base, and the dot of its row goes. */
  protected showIcon(id: string, url: string | undefined): void {
    const next: IconMark = iconShown(url)
    if (next.base === undefined) this.iconBase.delete(id)
    else this.iconBase.set(id, next.base)
    const current = this.runtime.tabs[id]
    if (current?.changedIcon === undefined) return
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [id]: unmarked(current) } }
  }

  protected setAwake(id: string, awake: boolean, frozen = false): void {
    const current = this.runtime.tabs[id]
    if (!current || (current.awake === awake && (current.frozen === true) === frozen)) return
    const { frozen: _was, ...rest } = current
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [id]: { ...rest, awake, ...(frozen ? { frozen: true as const } : {}) } } }
  }

  /** A frozen page runs again; the tab shows as awake at once and the page follows as soon as the protocol answers. */
  protected thawPage(id: string): Promise<void> {
    this.frozen.delete(id)
    this.autoFrozen.delete(id)
    this.autoReloader?.forget(id)
    this.setAwake(id, true)
    return this.pages.get(id)?.thaw().catch((error: unknown) => console.error(`[sleep] cannot thaw page ${id}:`, error)) ?? Promise.resolve()
  }

  /**
   * « Dégeler l'onglet » (the button on its row, its menu): the frozen page runs again where it was, in the window of the group that holds it,
   * without being shown or reloaded. Its delays start again from now, as for a tab just left: the sweep neither freezes it again (the freeze delay)
   * nor frees it (the delay, and the cap counts it as the newest) before they have passed again. Resolves true when a frozen page was thawed;
   * false for a tab that is gone, not frozen, or of a locked space.
   */
  async thawTab(tabId: string): Promise<boolean> {
    const owner = this.ownerOf(tabId)
    const tab = owner?.store.get().tabs.find((t) => t.id === tabId)
    if (!owner || !tab || owner.isTabLocked(tab) || !owner.frozen.has(tabId)) return false
    owner.idleSince.set(tabId, Date.now())
    const thawed = owner.thawPage(tabId)
    // The row shows the tab awake at once; the page follows as soon as the protocol answers.
    owner.autoReloader?.refresh()
    owner.publish()
    await thawed
    return true
  }

  protected async freezePage(id: string, page: Page): Promise<boolean> {
    if (!(await page.freeze())) return false
    // Shown (or gone) while the protocol was answering: a visible page must not stay frozen.
    if (this.pages.get(id) !== page || this.isShown(id)) {
      await page.thaw()
      return false
    }
    this.frozen.add(id)
    this.autoReloader?.forget(id)
    this.setAwake(id, false, true)
    this.publish()
    return true
  }

  /**
   * Puts a tab to sleep now, whatever the delay and the exclusions say (the user asked, or an extension did): only a page on
   * screen, or a tab with nothing to free, is refused. `discard` drops the web view; `freeze` keeps it in memory and stops it.
   * Resolves true when the tab was put to sleep.
   */
  sleepNow(tabId: string, mode: SleepMode = 'discard'): Promise<boolean> {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    const page = this.pages.get(tabId)
    if (!tab || !page || !sleepVerdict(tab, state.settings, this.sleepFacts(tabId), 'manual').sleep) return Promise.resolve(false)
    if (mode === 'freeze') return this.freezePage(tabId, page)
    return this.releasePage(tabId).then((gone) => {
      // Asked by the user: a page that keeps itself awake says why.
      if (!gone && this.pages.get(tabId)) this.showToast(t('sleep.site-demande-une-confirmation-reste-eveille', { site: hostOf(tab.url) || tab.url }))
      this.publish()
      return gone
    })
  }

  /**
   * Frees the page of a tab for a sleep (the mode that frees the memory). A page that asks to confirm leaving (its `beforeunload` cancels: a draft,
   * a form the site guards, in any of its frames) is not taken without a question, since nobody is there to answer it: it stays awake as it is, and
   * the sweep leaves it out of the cap a while (`sleepKept`). A frozen page runs again first, to be asked. Resolves whether the page went.
   */
  protected async releasePage(id: string): Promise<boolean> {
    const page = this.pages.get(id)
    if (!page) return false
    // A page in full screen is let go the way `destroyPage` knows; an engine without the question destroys as before.
    if (!page.release || this.fullscreenTab === id) {
      this.destroyPage(id, true)
      return true
    }
    if (this.frozen.has(id)) {
      await this.thawPage(id)
      if (this.pages.get(id) !== page) return false
    }
    const gone = await page.release()
    if (this.pages.get(id) !== page) return gone
    if (!gone) {
      this.leader.sleepKept.set(id, Date.now())
      return false
    }
    this.destroyPage(id, true)
    // Shown again while it was asked: it gets a page again.
    if (this.isShown(id)) this.sync()
    return true
  }

  /**
   * « Libérer maintenant » (the resource panel of the sidebar): the tabs a strength of the action takes (`planReleaseLevels`; the rules are those of
   * `sleepVerdict` with `{ level }`) go to sleep now, in every window of the group, whatever the delay and the setting « Jamais » say. The page is
   * freed (the mode `discard`, whatever the setting says, as the point is the memory): « Annuler » then loads it again from its address. Each
   * page is asked last, as for the sweep (Picture in Picture, text not sent, a confirmation on leaving) and stays awake when it holds something;
   * the outcome counts the tabs left by reason. One run at a time for the group (another request is answered `busy`). A run that frees a tab
   * becomes the batch « Annuler » wakes (`undoRelease`).
   */
  releaseLevel(level: ReleaseLevel): Promise<ReleaseOutcome> {
    const leader = this.leader
    if (leader.releasing) return Promise.resolve({ level, slept: 0, refused: { unsent: 0, confirm: 0, other: 0 }, busy: true })
    leader.releasing = this.releaseOnce(level).finally(() => {
      leader.releasing = null
    })
    return leader.releasing
  }

  private async releaseOnce(level: ReleaseLevel): Promise<ReleaseOutcome> {
    const wanted = new Set(planReleaseLevels(this.sweepEntries(), this.store.get().settings)[level].ids)
    const outcome: ReleaseOutcome = { level, slept: 0, refused: { unsent: 0, confirm: 0, other: 0 } }
    const batch: Array<{ id: string; window: BrowserSleep }> = []
    for (const browser of [...this.group]) {
      for (const id of [...browser.pages.keys()]) {
        const page = browser.pages.get(id)
        if (!wanted.has(id) || !page || browser.frozen.has(id)) continue
        const verdict = await browser.autoVerdict(id, page, { level })
        if (!verdict || browser.pages.get(id) !== page) {
          outcome.refused.other++
          continue
        }
        if (!verdict.sleep) {
          if (verdict.reason === 'unsent-input') outcome.refused.unsent++
          else outcome.refused.other++
          if (verdict.reason === 'picture-in-picture' || verdict.reason === 'unsent-input') this.leader.sleepKept.set(id, Date.now())
          continue
        }
        if (await browser.releasePage(id)) {
          outcome.slept++
          batch.push({ id, window: browser })
        } else outcome.refused[browser.pages.has(id) ? 'confirm' : 'other']++
      }
    }
    if (outcome.slept > 0) {
      this.leader.releaseBatch = batch
      this.publish()
    }
    return outcome
  }

  /**
   * Puts to sleep every tab that `sleepVerdict` allows: left for the delay, not on screen, not excluded, nothing playing,
   * downloading or typed into. The page is asked last (Picture in Picture, text not sent). Resolves the ids put to sleep.
   * Public for the engine smoke test.
   */
  sleepSweep(): Promise<string[]> {
    // The timer may come round while the previous sweep still waits for a page.
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  /**
   * The verdict of the delay for a tab (or of the `reload` rules, see `sleepVerdict`), asking its page when every other rule lets the tab through.
   * Null when the page could not answer. `shownMeanwhile` is asked each time the facts are, for the `reload` verdict.
   */
  protected async autoVerdict(id: string, page: Page, mode: Exclude<SleepVerdictMode, 'manual'> = 'auto', shownMeanwhile: () => boolean = () => false, pressure: MemoryPressure = 'normal', marks: SweepMarks = {}): Promise<SleepVerdict | null> {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return null
    const verdict = sleepVerdict(tab, this.sleepRules(state.settings, pressure).rules, { ...this.sleepFacts(id), shownMeanwhile: shownMeanwhile(), ...marks }, mode)
    if (verdict.sleep || verdict.reason !== 'unchecked') return verdict
    const probe = await page.probeForSleep()
    // Whatever happened while the page answered is looked at again.
    const now = this.store.get()
    const again = now.tabs.find((t) => t.id === id)
    if (!probe || !again || this.pages.get(id) !== page) return null
    return sleepVerdict(again, this.sleepRules(now.settings, pressure).rules, { ...this.sleepFacts(id), shownMeanwhile: shownMeanwhile(), ...marks, probe }, mode)
  }

  /**
   * The settings the delay is judged by, and the cap of tabs awake in the background: the battery saver shortens the delay (a tab idle for five
   * minutes sleeps), and only while it is on; a memory pressure shortens it too and lowers the cap (shared/sleep.ts, `sweepLimits`).
   */
  private sleepRules(settings: SidebarState['settings'], pressure: MemoryPressure): { rules: SidebarState['settings']; cap: number } {
    return sweepLimits(batterySaver().active() ? { ...settings, sleepAfterMinutes: saverSleepMinutes(settings.sleepAfterMinutes) } : settings, pressure)
  }

  /** Every page of the window group as the cap sees it. The marks of pages that said they hold something are forgotten once old. */
  protected sweepEntries(): SweepEntry[] {
    const now = Date.now()
    const kept = this.leader.sleepKept
    for (const [id, at] of kept) if (now - at >= SLEEP_KEPT_MS) kept.delete(id)
    return [...this.group].flatMap((browser) => {
      const tabs = new Map(browser.store.get().tabs.map((tab) => [tab.id, tab]))
      return [...browser.pages.keys()].flatMap((id): SweepEntry[] => {
        const tab = tabs.get(id)
        if (!tab) return []
        const frozen = !browser.frozen.has(id) ? 'no' : browser.autoFrozen.has(id) ? 'auto' : 'other'
        return [{ id, tab, facts: browser.sleepFacts(id), frozen, kept: kept.has(id) }]
      })
    })
  }

  /** The plan of a sweep under this pressure, over the whole group: the tabs beyond the cap, and the tab kept awake for each site never put to sleep. */
  private sweepPlan(pressure: MemoryPressure): { plan: SweepPlan; rules: SleepRules } {
    const settings = this.store.get().settings
    const { rules, cap } = this.sleepRules(settings, pressure)
    return { plan: planSweep(this.sweepEntries(), rules, cap, settings.sleepMode), rules }
  }

  /** Why the sweep would leave this tab awake right now (`unchecked` when its page could not answer), or null when it would put it to sleep. */
  async sleepBlockerOf(tabId: string): Promise<SleepBlocker | null> {
    const page = this.pages.get(tabId)
    if (!page || this.frozen.has(tabId)) return 'no-page'
    const pressure = await memoryPressure()
    const { plan } = this.sweepPlan(pressure)
    const verdict = await this.autoVerdict(tabId, page, 'auto', () => false, pressure, { siteKeeper: plan.keepers.has(tabId), overCap: plan.overCap.has(tabId) })
    if (!verdict) return 'unchecked'
    return verdict.sleep ? null : verdict.reason
  }

  /**
   * One pass over the pages of this window. The plan is the group's: the cap of tabs awake in the background counts every window, and the
   * memory pressure, read once here, shortens the delay and lowers the cap. A page left for the delay, or beyond the cap, is put to sleep in
   * the mode of the settings; one left for the freeze delay is frozen first (`sleepFreezeAfterMinutes`) and freed at the delay. A page frozen
   * another way (by hand, or by the mode "Garder en mémoire") cannot answer: it stays as it is until the user wakes it or frees it.
   */
  private async sweepOnce(): Promise<string[]> {
    const slept: string[] = []
    // The pages this sweep froze (they stay in memory): the notice does not call them asleep.
    const froze = new Set<string>()
    const pressure = await memoryPressure()
    const { plan, rules } = this.sweepPlan(pressure)
    for (const id of [...this.pages.keys()]) {
      const page = this.pages.get(id)
      if (!page) continue
      const marks: SweepMarks = { siteKeeper: plan.keepers.has(id), overCap: plan.overCap.has(id) }
      const mode = this.store.get().settings.sleepMode
      if (this.frozen.has(id)) {
        if (mode === 'discard' && this.autoFrozen.has(id) && this.frozenMayGo(id, rules, marks) && (await this.releasePage(id))) slept.push(id)
        continue
      }
      const verdict = await this.autoVerdict(id, page, 'auto', () => false, pressure, marks)
      if (verdict?.sleep) {
        const asleep = mode === 'freeze' ? await this.freezePage(id, page) : await this.releasePage(id)
        if (asleep) slept.push(id)
        if (asleep && mode === 'freeze') froze.add(id)
        continue
      }
      if (verdict?.reason === 'picture-in-picture' || verdict?.reason === 'unsent-input') this.leader.sleepKept.set(id, Date.now())
      else if (verdict?.reason === 'recent') await this.freezeFirst(id, page, pressure, marks)
    }
    if (slept.length > 0) {
      this.publish()
      if (this.store.get().settings.sleepNotify) this.showSleepToast(slept, slept.every((id) => froze.has(id)))
    }
    return slept
  }

  /** A page the sweep froze goes once the rules of the delay (or the cap) let it: it was asked before it was frozen, and has run nothing since. */
  private frozenMayGo(id: string, rules: SleepRules, marks: SweepMarks): boolean {
    const tab = this.store.get().tabs.find((t) => t.id === id)
    return tab !== undefined && sleepVerdict(tab, rules, { ...this.sleepFacts(id), ...marks, probe: ASKED_BEFORE_FREEZING }, 'auto').sleep
  }

  /**
   * The first step of the sweep: a page left for the freeze delay (and not yet for the delay) is frozen, unless it plays sound, uses the camera,
   * the microphone or the screen, downloads, is of a site never put to sleep, floats a video or holds text not sent (the `freeze` verdict).
   */
  private async freezeFirst(id: string, page: Page, pressure: MemoryPressure, marks: SweepMarks): Promise<void> {
    if (!(this.store.get().settings.sleepFreezeAfterMinutes > 0)) return
    const verdict = await this.autoVerdict(id, page, 'freeze', () => false, pressure, marks)
    if (verdict?.sleep && (await this.freezePage(id, page))) this.autoFrozen.add(id)
  }

  /**
   * "Onglet mis en veille — Réveiller": the button selects the tab, which wakes it. With several tabs there is nothing single to wake. When the sweep
   * froze them all (`frozen`) the words are "gelé" and "Dégeler": a frozen page is not asleep, it stays in memory.
   */
  private showSleepToast(ids: string[], frozen: boolean): void {
    const [only] = ids
    this.showToast(sleepToastMessage(ids.length, frozen), ids.length === 1 && only ? { label: sleepToastAction(frozen), run: () => this.dispatch({ type: 'tab/select', id: only }) } : undefined)
  }
}
