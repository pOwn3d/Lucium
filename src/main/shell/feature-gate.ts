// The gate of a feature: ties a piece of the main process (a timer, a service, a listener) to the setting that switches it on.
//
//   gates.gate('favicons', { start() { const service = begin(); return () => service.stop() } })
//
// `start` runs when the setting is on, at the time of the call and each time it comes back on; the function it returns undoes everything it
// did (timers cleared, listeners removed, services dropped) and runs when the setting goes off, when the gate is disposed, and at exit.
// A feature that is off therefore owns nothing. The rules of the registry (shared/features.ts) decide what "on" means: the switch, or, for a
// feature that follows more than one setting (a delay that profiles may set too), the rule it carries (`runsWhen`).

import { featureById, featureRuns, type FeatureId } from '@shared/features'
import type { SidebarState } from '@shared/model'

/** The part of a state store the gates need: the settings, and a way to hear that they may have changed. */
export interface GateStore {
  get(): SidebarState
  subscribe(listener: (state: SidebarState) => void): () => void
}

export type Stop = () => void

export interface Gated {
  /** Starts the feature; the function returned (if any) stops it again, whatever `start` set up. */
  start(): Stop | void
}

export interface Gate {
  readonly id: FeatureId
  /** Whether the feature is started now. */
  running(): boolean
  /** Looks at the setting again. Called by the store's subscription; calling it more is harmless. */
  sync(): void
  /** Stops the feature if it runs and stops following the setting. */
  dispose(): void
}

type Report = (message: string, error: unknown) => void

const reportToConsole: Report = (message, error) => console.error(message, error)

/** How many gates run for each feature, across every store: the engine test reads it to see that a switched-off feature is not running anywhere. */
const live = new Map<FeatureId, number>()

export function runningGates(): FeatureId[] {
  return [...live.entries()].filter(([, count]) => count > 0).map(([id]) => id)
}

class BoundGate implements Gate {
  private stopFeature: Stop | null = null
  private started = false
  /** What the setting said when the gate last acted: only a change of it starts or stops anything. */
  private wanted = false
  private syncing = false
  private again = false
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(
    readonly id: FeatureId,
    private readonly feature: Gated,
    private readonly store: GateStore,
    private readonly report: Report
  ) {
    this.unsubscribe = store.subscribe(() => this.sync())
    this.sync()
  }

  private get name(): string {
    return `${featureById(this.id).label} (${this.id})`
  }

  running(): boolean {
    return this.started
  }

  sync(): void {
    if (this.disposed) return
    // A start or a stop may change the state itself (and so call this again): the outer call looks once more when it is done.
    if (this.syncing) {
      this.again = true
      return
    }
    this.syncing = true
    try {
      do {
        this.again = false
        this.follow(featureRuns(this.store.get().settings, this.id))
      } while (this.again && !this.disposed)
    } finally {
      this.syncing = false
    }
  }

  private follow(on: boolean): void {
    if (on === this.wanted) return
    this.wanted = on
    if (on) this.begin()
    else this.end()
  }

  private begin(): void {
    try {
      const stop = this.feature.start()
      this.stopFeature = typeof stop === 'function' ? stop : null
      this.started = true
      live.set(this.id, (live.get(this.id) ?? 0) + 1)
    } catch (error) {
      // It stays off until the setting is switched off and on again: a failing start is not retried at every change of the state.
      this.report(`[features] ${this.name} cannot start; it stays off until the setting is switched off and on again:`, error)
    }
  }

  private end(): void {
    if (!this.started) return
    const stop = this.stopFeature
    this.stopFeature = null
    this.started = false
    live.set(this.id, (live.get(this.id) ?? 1) - 1)
    try {
      stop?.()
    } catch (error) {
      this.report(`[features] ${this.name} did not stop cleanly; it is treated as stopped:`, error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.end()
  }
}

/** The gates bound to one store: a window's, or the application's. */
export class FeatureGates {
  private readonly gates = new Map<FeatureId, BoundGate>()

  constructor(
    private readonly store: GateStore,
    private readonly report: Report = reportToConsole
  ) {}

  /** Ties a feature to its setting (see the top of this file). One gate per feature and store: a second one would start it twice. */
  gate(id: FeatureId, feature: Gated): Gate {
    if (!featureById(id)) throw new Error(`Unknown feature: ${String(id)} (see shared/features.ts)`)
    if (this.gates.has(id)) throw new Error(`The feature ${id} is already gated on this store`)
    const bound = new BoundGate(id, feature, this.store, this.report)
    this.gates.set(id, bound)
    return bound
  }

  /** The features started through these gates now. */
  running(): FeatureId[] {
    return [...this.gates.values()].filter((gate) => gate.running()).map((gate) => gate.id)
  }

  /** Stops every feature and ends the gates (a closed window, the exit of the application). */
  disposeAll(): void {
    for (const gate of this.gates.values()) gate.dispose()
    this.gates.clear()
  }
}
