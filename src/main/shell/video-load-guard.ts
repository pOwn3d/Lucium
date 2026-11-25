// The reader of the facts that stop the video behind a space by itself (the function `video-load-pause`, shared/video-load-pause.ts): every
// LOAD_READING_MS it looks at whether a page holds the camera, the microphone or the screen, at the processors of the browser together, and at the
// memory pressure of macOS, and says what the video should do. It runs only while the setting is on (gate): off, it owns no timer and measures nothing.

import { cpuOf } from '@shared/resources'
import type { RawProcess } from '@shared/processes'
import { INITIAL_VIDEO_PAUSE, LOAD_READING_MS, nextVideoPause, type VideoPauseReason, type VideoPauseState } from '@shared/video-load-pause'
import type { FeatureGates } from './feature-gate'

export interface VideoLoadGuardDeps {
  /** Every process of the application, with a processor meter of this guard's own (shell/process-meter.ts). */
  measure(): RawProcess[]
  /** Some page of the browser was given the camera, the microphone or the screen. */
  capturing(): boolean
  /** macOS says memory is short (shell/sleep-pressure.ts, its reading shared with the sleep sweep). */
  pressure(): Promise<boolean>
  /** The reason the video is held still changed (null: it plays again). */
  onChange(reason: VideoPauseReason | null): void
  /** While this says true (the application is locked) nothing is read. */
  paused?: () => boolean
}

export class VideoLoadGuard {
  private state: VideoPauseState = INITIAL_VIDEO_PAUSE
  /** The first reading of a meter has no interval to average over: it only starts the meter. */
  private primed = false
  private stopped = false

  constructor(private readonly deps: VideoLoadGuardDeps) {}

  /** What holds the video still now, or null. */
  reason(): VideoPauseReason | null {
    return this.state.reason
  }

  /** One reading. Never rejects: a reading that fails is said in the log and the state stays as it was. */
  async tick(): Promise<void> {
    if (this.stopped || this.deps.paused?.() === true) return
    try {
      const raw = this.deps.measure()
      const cpu = this.primed ? cpuOf(raw) : null
      this.primed = true
      const pressure = await this.deps.pressure()
      if (this.stopped) return
      const next = nextVideoPause(this.state, { capturing: this.deps.capturing(), cpu, pressure })
      const changed = next.reason !== this.state.reason
      this.state = next
      if (changed) this.deps.onChange(next.reason)
    } catch (error) {
      console.warn('[video] the load could not be read, the video stays as it is:', error instanceof Error ? error.message : String(error))
    }
  }

  stop(): void {
    this.stopped = true
  }
}

/**
 * Ties the guard to its setting: a first reading as it starts (it only starts the meter), then one every LOAD_READING_MS. Off, no timer and no
 * reading, and a video held still is let go (`onChange(null)` by the function it returns).
 */
export function gateVideoLoad(gates: FeatureGates, deps: VideoLoadGuardDeps, everyMs = LOAD_READING_MS): void {
  gates.gate('video-load-pause', {
    start() {
      const guard = new VideoLoadGuard(deps)
      const timer = setInterval(function videoLoadTick() {
        void guard.tick()
      }, everyMs)
      void guard.tick()
      return () => {
        clearInterval(timer)
        const held = guard.reason() !== null
        guard.stop()
        if (held) deps.onChange(null)
      }
    }
  })
}
