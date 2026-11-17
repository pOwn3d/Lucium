// The battery saver's switch (rules in shared/battery-saver.ts): reads whether the computer runs on battery and how full it is, and tells the
// windows when the mode comes on or goes off. Nothing runs while the setting is off: no listener on the power events, no timer, no process.
// On mains power there is no timer either: the charge is read only while on battery, every two minutes (`pmset` on macOS, the files of
// /sys/class/power_supply on Linux, nothing known on Windows: see main/platform).

import { powerMonitor } from 'electron'
import { SAVER_POLL_MS, saverActive } from '@shared/battery-saver'
import { currentPlatform } from '../platform'

export interface PowerSource {
  onBattery(): boolean
  /** The charge (0 to 100), or null when it cannot be read. */
  percent(): Promise<number | null>
  /** Calls the listener when the computer goes onto battery or back onto mains power. Returns the call that stops listening. */
  watch(listener: () => void): () => void
}

const systemPower: PowerSource = {
  onBattery: () => powerMonitor.isOnBatteryPower(),
  percent: () => currentPlatform().batteryPercent(),
  watch: (listener) => {
    powerMonitor.on('on-battery', listener)
    powerMonitor.on('on-ac', listener)
    return () => {
      powerMonitor.off('on-battery', listener)
      powerMonitor.off('on-ac', listener)
    }
  }
}

export class BatterySaver {
  private enabled = false
  private asked = false
  private low = false
  private on = false
  private shownAsked = false
  private timer: NodeJS.Timeout | null = null
  private unwatch: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  /** A reading that returns after the setting was switched off (or another began) must not change anything. */
  private generation = 0

  constructor(private power: PowerSource = systemPower) {}

  /** Whether the mode is on now. */
  active(): boolean {
    return this.on
  }

  /** Whether the user asked for it by hand (the menu entry is checked). */
  askedByHand(): boolean {
    return this.enabled && this.asked
  }

  /** Called when the mode comes on or goes off. Returns the call that stops listening. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Reads the power from another source from now on (the engine test: the machine it runs on may be on battery and low, which would
   * switch the mode on by itself). Returns the call that puts the previous source back.
   */
  useSource(next: PowerSource): () => void {
    const previous = this.power
    this.swap(next)
    return () => this.swap(previous)
  }

  private swap(next: PowerSource): void {
    if (next === this.power) return
    this.generation++
    this.unwatch?.()
    this.unwatch = null
    this.stopPolling()
    this.power = next
    if (!this.enabled) return
    this.unwatch = this.power.watch(() => this.evaluate())
    this.evaluate()
  }

  /** The setting: on starts watching the power source, off stops all of it (and forgets the user's request). */
  configure(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.generation++
    if (enabled) {
      this.unwatch = this.power.watch(() => this.evaluate())
      this.evaluate()
      return
    }
    this.unwatch?.()
    this.unwatch = null
    this.stopPolling()
    this.asked = false
    this.low = false
    this.update()
  }

  /** "Mode économie de batterie" in the View menu: on whatever the charge. Only counts while the setting is on. */
  setAsked(asked: boolean): void {
    if (!this.enabled || asked === this.asked) return
    this.asked = asked
    this.update()
  }

  /** Reads the power source and sets the timer: only on battery is anything watched. */
  private evaluate(): void {
    if (!this.enabled) return
    if (!this.power.onBattery()) {
      this.stopPolling()
      this.low = false
      this.update()
      return
    }
    void this.read()
    if (!this.timer) this.timer = setInterval(() => void this.read(), SAVER_POLL_MS)
  }

  private async read(): Promise<void> {
    const generation = this.generation
    const percent = await this.power.percent()
    if (generation !== this.generation || !this.enabled) return
    this.low = saverActive(true, false, { onBattery: this.power.onBattery(), percent })
    this.update()
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private update(): void {
    const next = this.enabled && (this.asked || this.low)
    const asked = this.askedByHand()
    if (next === this.on && asked === this.shownAsked) return
    this.on = next
    this.shownAsked = asked
    for (const listener of [...this.listeners]) listener()
  }

  /** Whether the poll timer is armed (the tests check that nothing is while the setting is off or the computer is on mains power). */
  polling(): boolean {
    return this.timer !== null
  }

  /** Whether the power events are listened to. */
  watching(): boolean {
    return this.unwatch !== null
  }
}

let service: BatterySaver | null = null

/** The application's battery saver (one for all windows). */
export function batterySaver(): BatterySaver {
  service ??= new BatterySaver()
  return service
}
