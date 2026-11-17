// What the system says of its scroll bars, for the interface: « Toujours afficher les barres de défilement » (Réglages Système › Apparence, macOS). One
// service for all the windows (as the battery saver is): it reads the setting once at launch, follows its changes, and the window tells its interface
// through the snapshot (`UiSnapshot.scrollBarsAlways`), where `useSnapshot` turns it into an attribute of the document (shared/scroll-bars.ts).
//
// The change is followed two ways, so that a missed one costs only the time to come back: macOS posts `AppleShowScrollBarsSettingChanged` (Electron relays it
// through `systemPreferences.subscribeNotification`), and the setting is read again each time the application becomes active (`did-become-active`, main/index.ts).
// Both only do something on macOS, and cost nothing but the notification when the setting is changed.

import type { UiSnapshot } from '@shared/ipc'
import { scrollBarsAlwaysShown } from '@shared/scroll-bars'

export interface ScrollBarsSource {
  /** The value of `AppleShowScrollBars`. May throw. */
  read(): unknown
  /** Calls `refresh` when the system says the setting changed; answers the way to stop listening. */
  watch(refresh: () => void): () => void
}

/** The name of the notification macOS posts (on the distributed center) when the setting is changed. */
export const SCROLL_BARS_NOTIFICATION = 'AppleShowScrollBarsSettingChanged'

/** The part of Electron's `systemPreferences` the source uses (a test gives it a stand-in). */
export interface ScrollBarsPreferences {
  getUserDefault(key: string, type: 'string'): string
  subscribeNotification(event: string, callback: () => void): number
  unsubscribeNotification(id: number): void
}

/** The source of the real system: the default and its notification. */
export function systemScrollBarsSource(preferences: ScrollBarsPreferences): ScrollBarsSource {
  return {
    read: () => preferences.getUserDefault('AppleShowScrollBars', 'string'),
    watch: (refresh) => {
      const id = preferences.subscribeNotification(SCROLL_BARS_NOTIFICATION, () => refresh())
      return () => preferences.unsubscribeNotification(id)
    }
  }
}

export class SystemScrollBars {
  private always = false
  private source: ScrollBarsSource | null = null
  private stopWatching: (() => void) | null = null
  private readonly listeners = new Set<() => void>()

  /**
   * Reads the setting and follows it. Started twice, it follows the second source only, and its listeners hear of it when the answer changes: the
   * answer of the first source is kept until the second is read (`stop` would forget it without a word, and a window would keep the bars of the first).
   */
  start(source: ScrollBarsSource): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.source = source
    this.refresh()
    this.stopWatching = source.watch(() => this.refresh())
  }

  /** Reads the setting again; the listeners hear of a change. A setting that cannot be read is said, and the bars stay as they were. */
  refresh(): void {
    if (!this.source) return
    let next: boolean
    try {
      next = scrollBarsAlwaysShown(this.source.read())
    } catch (error) {
      console.warn('[scroll bars] the system setting could not be read; the bars stay as they were:', error)
      return
    }
    if (next === this.always) return
    this.always = next
    for (const listener of [...this.listeners]) listener()
  }

  /** Whether the system always shows the scroll bars. False until started (another platform, a test). */
  isAlways(): boolean {
    return this.always
  }

  /** Calls `listener` when the answer of `isAlways` changes. Answers the way to stop. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  stop(): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.source = null
    this.always = false
  }
}

let service: SystemScrollBars | null = null

/** The application's scroll bars setting (one for all windows). */
export function systemScrollBars(): SystemScrollBars {
  service ??= new SystemScrollBars()
  return service
}

/** What the snapshot says of the setting: present while the system always shows the bars (a change is published by each window, `Browser.start`). */
export function scrollBarsOfSnapshot(): Pick<UiSnapshot, 'scrollBarsAlways'> {
  return systemScrollBars().isAlways() ? { scrollBarsAlways: true } : {}
}
