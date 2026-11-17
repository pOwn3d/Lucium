import { globalShortcut } from 'electron'
import type { GateStore, FeatureGates } from './feature-gate'

/** The part of Electron's `globalShortcut` this uses (a stand-in can be given in tests). */
export interface ShortcutHost {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/**
 * Settings › Links › "Raccourci de la mini-fenêtre dans toutes les apps": the shortcut of the mini window command is
 * also a system-wide one while the setting is on. It follows the shortcut the user gave the command, and stops when the setting goes off.
 */
export class LittleShortcut {
  private active: string | null = null

  constructor(
    private readonly press: () => void,
    private readonly host: ShortcutHost = globalShortcut
  ) {}

  /** The accelerator now held system-wide, or null. */
  held(): string | null {
    return this.active
  }

  /** Brings the registration in line with the setting and the command's accelerator. Cheap to call on every change. Returns whether a shortcut is held. */
  sync(enabled: boolean, accelerator: string | undefined): boolean {
    const wanted = enabled && accelerator ? accelerator : null
    if (wanted === this.active) return this.active !== null
    if (this.active) this.host.unregister(this.active)
    this.active = null
    if (!wanted) return false
    // Another application may already own the combination: then it stays theirs, and the row says nothing is held.
    if (this.host.register(wanted, this.press)) this.active = wanted
    else console.warn(`[little] the shortcut ${wanted} is taken by another application`)
    return this.active !== null
  }

  stop(): void {
    this.sync(false, undefined)
  }
}

/**
 * Ties the system-wide shortcut to its setting: while "Raccourci de la mini-fenêtre dans toutes les apps" is on, the shortcut is held and the state is
 * followed for a change of the command's accelerator; off, the shortcut is released and nothing listens to the state any more.
 */
export function gateLittleShortcut(gates: FeatureGates, shortcut: LittleShortcut, store: GateStore, accelerator: () => string | undefined): void {
  gates.gate('little-shortcut', {
    start() {
      // A notification already under way when the setting goes off may still reach `follow`: it must not take the shortcut back.
      let live = true
      const follow = (): void => {
        if (live) shortcut.sync(true, accelerator())
      }
      follow()
      const unsubscribe = store.subscribe(follow)
      return () => {
        live = false
        unsubscribe()
        shortcut.stop()
      }
    }
  })
}
