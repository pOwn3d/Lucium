// The countdowns of the tabs that reload themselves (rules: shared/auto-reload.ts). One timer serves all of a window's tabs: it is
// armed for the soonest countdown, and the sweep it starts looks at every tab whose countdown has ended, one after the other, so
// a tab is never reloaded twice at once. A tab whose page is asleep or frozen has no countdown: waking is not the timer's to do.

import { AUTO_RELOAD_PROBE_TIMEOUT_MS, autoReloadVerdict, countdownFor, recheckAt, restartedCountdown, wakeDelay, type Countdown } from '@shared/auto-reload'
import type { TabItem } from '@shared/model'

/** A tab with a setting and a live page that is not frozen: what the countdowns are kept for. */
export interface AutoReloadTarget {
  tab: TabItem
  /** The live page; a different object later means the tab was woken again in between. */
  page: object
  loading: boolean
  reload(): void
  /** Whether the user is in the middle of a field of the page. */
  isEditing(): Promise<boolean>
}

export interface AutoReloadHost {
  targets(): AutoReloadTarget[]
}

export interface Clock {
  now(): number
  setTimeout(run: () => void, ms: number): NodeJS.Timeout
  clearTimeout(timer: NodeJS.Timeout): void
}

const realClock: Clock = { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer) }

export class AutoReloader {
  private readonly countdowns = new Map<string, Countdown>()
  private timer: NodeJS.Timeout | null = null
  private running: Promise<string[]> | null = null
  private stopped = false

  constructor(
    private readonly host: AutoReloadHost,
    private readonly clock: Clock = realClock
  ) {}

  /**
   * Brings the countdowns in line with the tabs: a tab that has a setting and a live page gets one (a whole interval from now, or
   * the one it had while its interval is unchanged), a tab that has not loses its own. Called whenever the state or the pages change.
   */
  refresh(): void {
    if (this.stopped) return
    const now = this.clock.now()
    const targets = new Map(this.host.targets().map((target) => [target.tab.id, target]))
    for (const id of [...this.countdowns.keys()]) if (!targets.has(id)) this.countdowns.delete(id)
    for (const [id, target] of targets) {
      const seconds = target.tab.autoReload?.seconds
      if (seconds !== undefined) this.countdowns.set(id, countdownFor(this.countdowns.get(id), seconds, now))
    }
    this.arm()
  }

  /** A page finished loading (a reload of ours, the user's, a link followed): its countdown starts again, a whole interval from now. */
  loaded(tabId: string): void {
    this.refresh()
    const current = this.countdowns.get(tabId)
    if (!current) return
    this.countdowns.set(tabId, restartedCountdown(current.seconds, this.clock.now()))
    this.arm()
  }

  /** The tab has no live page any more (slept, frozen, closed): its countdown goes, and a new one starts when it wakes. */
  forget(tabId: string): void {
    this.countdowns.delete(tabId)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.countdowns.clear()
  }

  /** The tabs that have a countdown now (the engine test reads it). */
  countdownOf(tabId: string): Countdown | undefined {
    return this.countdowns.get(tabId)
  }

  /** Whether the single timer is armed (the engine test reads it). */
  armed(): boolean {
    return this.timer !== null
  }

  private arm(): void {
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    // A sweep under way re-arms the timer when it ends.
    if (this.stopped || this.running) return
    const delay = wakeDelay(this.countdowns.values(), this.clock.now())
    if (delay === null) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.sweep().catch((error: unknown) => console.error('[auto-reload] the sweep failed:', error))
    }, delay)
  }

  /** Reloads every tab whose countdown has ended and that may be reloaded now. Resolves the ids reloaded. Public for the tests. */
  sweep(): Promise<string[]> {
    this.running ??= this.sweepOnce().finally(() => {
      this.running = null
      this.arm()
    })
    return this.running
  }

  private async sweepOnce(): Promise<string[]> {
    const reloaded: string[] = []
    for (const id of [...this.countdowns.keys()]) {
      const countdown = this.countdowns.get(id)
      if (!countdown) continue
      const target = this.host.targets().find((t) => t.tab.id === id)
      // No live page or no setting any more: nothing to do, and no countdown to keep.
      if (!target?.tab.autoReload) {
        this.countdowns.delete(id)
        continue
      }
      if (await this.reloadIfDue(id, countdown, target)) reloaded.push(id)
    }
    return reloaded
  }

  /** The answer of a page, or a rejection when it has not come after `ms`: a page that never answers must not hold the sweep, and so every other tab, for ever. */
  private within(question: Promise<boolean>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
      question.then(
        (answer) => {
          this.clock.clearTimeout(timer)
          resolve(answer)
        },
        (error: unknown) => {
          this.clock.clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private async reloadIfDue(id: string, countdown: Countdown, target: AutoReloadTarget): Promise<boolean> {
    const seconds = countdown.seconds
    // A countdown that has not ended is none of the sweep's business, whatever the page is doing.
    if (this.clock.now() < countdown.at) return false
    let verdict = autoReloadVerdict(target.tab, { awake: true, loading: target.loading, now: this.clock.now(), dueAt: countdown.at })
    if (!verdict.reload && verdict.reason === 'unchecked') {
      let editing: boolean
      try {
        editing = await this.within(target.isEditing(), AUTO_RELOAD_PROBE_TIMEOUT_MS)
      } catch (error) {
        // A page that cannot answer is not one being typed in: it is reloaded (a hung page is what a reload cures), and the failure is logged.
        console.warn(`[auto-reload] page ${id} could not be asked whether a field is being typed in:`, (error as Error).message)
        editing = false
      }
      // Whatever happened while the page answered (closed, slept, loaded again, interval changed) is looked at again by the next sweep.
      const again = this.host.targets().find((t) => t.tab.id === id)
      const moved = this.countdowns.get(id)
      if (!again || again.page !== target.page || !moved || moved.at !== countdown.at) return false
      target = again
      verdict = autoReloadVerdict(target.tab, { awake: true, loading: target.loading, now: this.clock.now(), dueAt: countdown.at, editing })
    }
    if (verdict.reload) {
      try {
        target.reload()
      } catch (error) {
        // The page refused (it is being destroyed): the tab is tried again a whole interval later, and the failure is logged.
        console.error(`[auto-reload] cannot reload page ${id}:`, error)
        this.countdowns.set(id, restartedCountdown(seconds, this.clock.now()))
        return false
      }
      this.countdowns.set(id, restartedCountdown(seconds, this.clock.now()))
      return true
    }
    if (verdict.reason === 'not-due') return false
    const next = recheckAt(verdict.reason, seconds, this.clock.now())
    if (next === null) this.countdowns.delete(id)
    else this.countdowns.set(id, { seconds, at: next })
    return false
  }
}
