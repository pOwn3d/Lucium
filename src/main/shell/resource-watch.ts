// The figures of the resource gauge at the foot of the sidebar and of the panel that slides up from it (shared/resources.ts), for every window of
// the group: one measure serves every open panel. Nothing of its own runs while no panel is open: the ring is read at the beat of the sleep sweep
// (Browser.start), and the 2 s refresh exists only from the first panel that opens to the last one that closes, in whichever windows.
// Made by the gate of 'resource-gauge' in the main window, dropped with it.

import type { RawProcess } from '@shared/processes'
import { RESOURCE_REFRESH_MS, memoryGauge, memoryOf, sameGauge, type MemoryGauge } from '@shared/resources'

/** An open panel: it draws one measure, and says false once it cannot any more (its window is gone), which closes it. */
export interface ResourceViewer {
  show(raw: readonly RawProcess[], gauge: MemoryGauge): boolean
}

export interface ResourceWatchDeps {
  /** Every process of the application, with a processor meter of this watch's own (shell/process-meter.ts). */
  measure(): RawProcess[]
  /** The memory of the Mac, in MB (os.totalmem). */
  totalMb: number
  /** The memory pressure (shell/sleep-pressure.ts, shared with the sleep sweep): read at the sweep and when a first panel opens, never at each refresh. */
  pressure(): Promise<number | null>
  /** The ring shows something else: the windows are told (the snapshot carries it). */
  onGauge(gauge: MemoryGauge | null): void
  /** While this says true (the application is locked) nothing is measured or shown, and the open panels are let go. */
  paused?: () => boolean
  /** The refresh of an open panel; `RESOURCE_REFRESH_MS` unless a test says otherwise. */
  everyMs?: number
}

export class ResourceWatch {
  private readonly viewers = new Map<number, ResourceViewer>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** The last measure, shown again to a panel that opens while the others refresh, and after an action (`refresh`). */
  private last: RawProcess[] | null = null
  private level: number | null = null
  private current: MemoryGauge | null = null
  private disposed = false

  constructor(private readonly deps: ResourceWatchDeps) {}

  /** What the ring shows now; null before the first reading. */
  gauge(): MemoryGauge | null {
    return this.current
  }

  /** Whether the 2 s refresh is armed: a panel is open in some window. */
  running(): boolean {
    return this.timer !== null
  }

  /** How many panels are open, in every window. */
  openCount(): number {
    return this.viewers.size
  }

  /** The first reading of the ring, when the function starts: the memory only (no program is run for the pressure before the first sweep). */
  prime(): void {
    if (this.disposed || this.paused()) return
    const raw = this.measure()
    if (raw) this.setGauge(raw)
  }

  /** At the beat of the sleep sweep: the pressure is read again, and the ring with it unless an open panel already refreshes it. */
  sweep(): void {
    if (this.disposed || this.paused()) return
    void this.readPressure().then(() => {
      if (this.disposed) return
      const raw = this.running() ? this.last : this.measure()
      if (raw) this.setGauge(raw)
    })
  }

  /** A panel opens (`id`: its web contents): it is shown the figures at once, and the refresh starts with the first one. */
  open(id: number, viewer: ResourceViewer): void {
    if (this.disposed || this.paused()) return
    const first = this.viewers.size === 0
    this.viewers.set(id, viewer)
    if (!first && this.last) return this.showTo(id, viewer)
    // The pressure may have changed since the last sweep: read once for this opening, then at the sweeps only.
    void this.readPressure().then((changed) => {
      if (changed && !this.disposed && this.last) {
        this.setGauge(this.last)
        this.showAll()
      }
    })
    this.tick()
    if (this.viewers.size > 0 && this.timer === null) this.timer = setInterval(() => this.tick(), this.deps.everyMs ?? RESOURCE_REFRESH_MS)
  }

  /** A panel closes: with the last one the refresh stops. Closing one that is not open does nothing. */
  close(id: number): void {
    this.viewers.delete(id)
    if (this.viewers.size === 0) this.stopTimer()
  }

  /** After a tab was put to sleep or closed: the open panels are drawn again at once from the last measure (its row goes without waiting 2 s). */
  refresh(): void {
    if (this.disposed || this.viewers.size === 0) return
    if (!this.last) return this.tick()
    this.showAll()
  }

  /** The function is switched off: no refresh, no panel, no ring. */
  dispose(): void {
    this.disposed = true
    this.viewers.clear()
    this.stopTimer()
    this.last = null
    this.current = null
  }

  private paused(): boolean {
    return this.deps.paused?.() === true
  }

  private measure(): RawProcess[] | null {
    try {
      return this.deps.measure()
    } catch (error) {
      console.warn('[resources] the processes could not be measured:', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /** Reads the pressure; resolves whether the level changed. A reading that fails keeps the last level, and never rejects. */
  private async readPressure(): Promise<boolean> {
    let level: number | null
    try {
      level = await this.deps.pressure()
    } catch (error) {
      console.warn('[resources] the memory pressure could not be read, the last level stays:', error instanceof Error ? error.message : String(error))
      return false
    }
    if (this.disposed || level === this.level) return false
    this.level = level
    return true
  }

  private tick(): void {
    if (this.paused()) return this.letGo()
    const raw = this.measure()
    if (!raw) return
    this.last = raw
    this.setGauge(raw)
    this.showAll()
  }

  private setGauge(raw: readonly RawProcess[]): void {
    const next = memoryGauge(memoryOf(raw), this.deps.totalMb, this.level)
    if (sameGauge(next, this.current)) return
    this.current = next
    this.deps.onGauge(next)
  }

  private showAll(): void {
    for (const [id, viewer] of [...this.viewers]) this.showTo(id, viewer)
  }

  private showTo(id: number, viewer: ResourceViewer): void {
    if (!this.last || !this.current) return
    let kept = false
    try {
      kept = viewer.show(this.last, this.current)
    } catch (error) {
      console.warn('[resources] a panel could not be drawn, it is closed:', error instanceof Error ? error.message : String(error))
    }
    if (!kept) this.close(id)
  }

  /** The application was locked under an open panel: the panels are let go (the lock screen draws none) and the refresh stops. */
  private letGo(): void {
    this.viewers.clear()
    this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}
