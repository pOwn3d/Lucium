// The schedule of the live folders (rules in shared/live-folders.ts). One timer, armed for the moment the next folder falls due and for nothing
// else; one look at a time, with a pause between two; and nothing at all, not even a timer, while the function is off or no folder is live.
// The service is made when the setting `liveFolders` is on and dropped when it goes off (see Browser: a gate), and only by the main window,
// never by a private one. A look is a GET without cookie (live-fetch.ts); its answer goes to the reducer as `livefolder/result`.

import type { Folder } from '@shared/model'
import { LIVE_GAP_MS, nextDueFolder, nextWakeAt, type LiveSource } from '@shared/live-folders'
import type { Action } from '@shared/sidebar'
import type { LookResult } from './live-fetch'
import { t } from '@shared/i18n'

/** `setTimeout` takes 32 bits of milliseconds. */
const MAX_DELAY_MS = 2_000_000_000
const MIN_DELAY_MS = 1000

export interface LiveHost {
  /** Whether the function is on, and the folders now. */
  state(): { enabled: boolean; folders: readonly Folder[] }
  /** Whether looking is allowed now (the battery saver says no). */
  paused(): boolean
  /** One look; never rejects (it answers `{ ok: false }` with a sentence). */
  look(source: LiveSource, signal: AbortSignal): Promise<LookResult>
  /** Hands an action to the reducer. */
  dispatch(action: Action): void
  now(): number
  /** The wait before the first look after the service starts (the application is just launching). */
  startDelayMs(): number
  gapMs?(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log(level: 'warn' | 'error', message: string): void
}

export class LiveFolderService {
  private timer: unknown = null
  private running = false
  private lastLookAt = -Infinity
  private stopped = false
  private startedAt = 0
  private seen: { enabled: boolean; folders: readonly Folder[] } | null = null
  private controller: AbortController | null = null
  /** Looks made since the service started (the engine test counts them). */
  looks = 0

  constructor(private readonly host: LiveHost) {}

  start(): void {
    this.startedAt = this.host.now()
    this.schedule()
  }

  /** The state may have changed: the timer is set again only if the folders did. Cheap when they did not. */
  refresh(): void {
    if (this.stopped) return
    const state = this.host.state()
    if (this.seen && this.seen.enabled === state.enabled && this.seen.folders === state.folders) return
    this.seen = state
    this.schedule()
  }

  /** Ends everything: no timer, and the look under way is cut (its answer is not recorded). */
  stop(): void {
    this.stopped = true
    this.clear()
    this.controller?.abort()
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
    const { enabled, folders } = this.host.state()
    if (!enabled || this.host.paused()) return
    const wake = nextWakeAt(folders)
    if (wake === null) return
    const now = this.host.now()
    const gap = this.host.gapMs?.() ?? LIVE_GAP_MS
    const delay = Math.min(MAX_DELAY_MS, Math.max(wake - now, this.lastLookAt + gap - now, this.startedAt + this.host.startDelayMs() - now, MIN_DELAY_MS))
    this.timer = this.host.setTimer(() => {
      this.timer = null
      void this.look().catch((error: unknown) => this.host.log('error', `[live-folders] a look failed: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
  }

  /** Looks at the folder that is due, if one is and no look is going on. Resolves true when a source was looked at. */
  async look(): Promise<boolean> {
    if (this.stopped || this.running) return false
    const { enabled, folders } = this.host.state()
    const due = enabled && !this.host.paused() ? nextDueFolder(folders, this.host.now()) : null
    if (!due) {
      this.schedule()
      return false
    }
    this.running = true
    this.controller = new AbortController()
    const source = due.live.source
    let result: LookResult
    try {
      this.looks++
      result = await this.host.look(source, this.controller.signal)
    } catch (error) {
      // `look` should not reject; if it does, the folder says so and the log keeps the cause.
      this.host.log('error', `[live-folders] ${source.kind === 'feed' ? source.url : source.repo} could not be read: ${error instanceof Error ? error.message : String(error)}`)
      result = { ok: false, error: t('live-folders.lecture-impossible') }
    } finally {
      this.running = false
      this.lastLookAt = this.host.now()
    }
    if (this.stopped) return true
    if (!result.ok) this.host.log('warn', `[live-folders] ${source.kind === 'feed' ? source.url : source.repo}: ${result.error}`)
    // The reducer ignores the answer when the folder was deleted or its source changed while the request was under way.
    this.host.dispatch(result.ok ? { type: 'livefolder/result', id: due.id, source, items: result.items } : { type: 'livefolder/result', id: due.id, source, failure: result.error })
    this.seen = null
    this.refresh()
    return true
  }
}
