// The schedule of the watched pages (rules in shared/page-watch.ts). One timer, armed for the moment the next look is due and for nothing
// else; one look at a time, with a pause between two; and nothing at all, not even a timer, while the tool is off or no page is watched.
// A look loads the page in a view nobody sees (engine.readPageText), compares what it shows with the last look, and tells the system
// when it differs. A page that cannot be read is marked in the list and tried again a whole interval later.

import type { PageWatch } from '@shared/model'
import { PAGE_WATCH_SETTLE_MS, afterFailure, afterLook, changeNotice, judgeLook, nextDue, nextWakeAt } from '@shared/page-watch'
import { t } from '@shared/i18n'

/** After a look, the next one waits at least this long, whatever is due: a computer waking up with ten watches due does not load ten pages at once. */
export const PAGE_WATCH_GAP_MS = 15_000
/** `setTimeout` takes 32 bits of milliseconds. */
const MAX_DELAY_MS = 2_000_000_000

export interface WatchHost {
  /** Whether the tool is on, and the pages watched now. */
  state(): { enabled: boolean; watches: readonly PageWatch[] }
  /** Whether looking is allowed now (the battery saver says no). */
  paused(): boolean
  /** Saves the watches. */
  save(watches: PageWatch[]): void
  /** Whether a profile has a session to look with (a profile whose spaces are gone has none). */
  profileLive(profileId: string): boolean
  read(profileId: string, url: string, options: { selector?: string; settleMs: number }): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** The system notice of a change; false when it could not be shown. */
  notify(notice: { title: string; body: string }): boolean
  now(): number
  /** The pause between two looks (the engine test shortens it). */
  gapMs?(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log(level: 'warn' | 'error', message: string): void
}

export class PageWatcher {
  private timer: unknown = null
  private running = false
  private lastLookAt = 0
  private stopped = false
  private seen: { enabled: boolean; watches: readonly PageWatch[] } | null = null

  constructor(private readonly host: WatchHost) {}

  /** The settings may have changed: the timer is set again only if what is watched did. Cheap when it did not. */
  refresh(): void {
    if (this.stopped) return
    const state = this.host.state()
    if (this.seen && this.seen.enabled === state.enabled && this.seen.watches === state.watches) return
    this.seen = state
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  /** Whether a page is being looked at now. */
  busy(): boolean {
    return this.running
  }

  /** Whether the single timer is armed. */
  armed(): boolean {
    return this.timer !== null
  }

  private clear(): void {
    if (this.timer !== null) this.host.clearTimer(this.timer)
    this.timer = null
  }

  /** Sets the one timer for the next look, or none. */
  schedule(): void {
    this.clear()
    if (this.stopped || this.running) return
    const { enabled, watches } = this.host.state()
    if (!enabled || watches.length === 0 || this.host.paused()) return
    const wake = nextWakeAt(watches)
    if (wake === null) return
    const now = this.host.now()
    const delay = Math.min(MAX_DELAY_MS, Math.max(wake - now, this.lastLookAt + (this.host.gapMs?.() ?? PAGE_WATCH_GAP_MS) - now, 1000))
    this.timer = this.host.setTimer(() => {
      this.timer = null
      void this.look().catch((error: unknown) => this.host.log('error', `[page-watch] a look failed: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
  }

  /** Looks at the watch that is due, if one is and no look is going on. Resolves true when a page was looked at. */
  async look(): Promise<boolean> {
    if (this.stopped || this.running) return false
    const { enabled, watches } = this.host.state()
    const due = enabled && !this.host.paused() ? nextDue(watches, this.host.now()) : null
    if (!due) {
      this.schedule()
      return false
    }
    this.running = true
    let updated: PageWatch
    try {
      updated = await this.lookAt(due)
    } finally {
      this.running = false
      this.lastLookAt = this.host.now()
    }
    // The watches may have changed while the page loaded (one removed, the interval changed): only this one is replaced, if it is still there.
    const current = this.host.state().watches
    if (current.some((w) => w.id === due.id)) {
      const next = current.map((w) => (w.id === due.id ? { ...w, hash: updated.hash, checkedAt: updated.checkedAt, changedAt: updated.changedAt, failure: updated.failure } : w))
      this.host.save(next.map((w) => (w.id === due.id ? stripUndefined(w) : w)))
    }
    this.seen = null
    this.refresh()
    return true
  }

  private async lookAt(watch: PageWatch): Promise<PageWatch> {
    const now = this.host.now()
    if (!this.host.profileLive(watch.profileId)) return afterFailure(watch, t('page-watch.le-profil-de-cette-page-n-existe-plus'), now)
    const outcome = await this.host.read(watch.profileId, watch.url, { ...(watch.selector ? { selector: watch.selector } : {}), settleMs: PAGE_WATCH_SETTLE_MS })
    if (!outcome.ok) {
      this.host.log('warn', `[page-watch] ${watch.url} could not be read: ${outcome.error}`)
      return afterFailure(watch, outcome.error, this.host.now())
    }
    const look = judgeLook(watch, outcome.text)
    if (look.outcome === 'changed' && !this.host.notify(changeNotice(watch))) this.host.log('warn', `[page-watch] ${watch.url} changed, and the system did not show the notice`)
    return afterLook(watch, look, this.host.now())
  }
}

/** A watch with the fields that are undefined taken out (the saved file does not keep them). */
function stripUndefined(watch: PageWatch): PageWatch {
  return Object.fromEntries(Object.entries(watch).filter(([, value]) => value !== undefined)) as unknown as PageWatch
}
