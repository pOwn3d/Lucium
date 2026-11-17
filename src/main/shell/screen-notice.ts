// The notice « Les panneaux vous semblent trop petits ? Régler… » (or « trop grands »): offered the first time a very wide or a very small screen is used,
// once per screen (shared/panel-scale.ts, `screenNotice`). A window looks at its screen a moment after it is shown, when it takes the focus and when it is
// moved; nothing is listened to or timed otherwise, and nothing is looked at while the window is busy (a panel open, the application locked, the window
// hidden): it is looked at again at the next event, the notice is not lost. Without Electron: everything comes in through `ScreenWatchDeps`.

import { screenNotice, type PanelSizes, type ScreenInfo, type ScreenKind } from '@shared/panel-scale'

export interface ScreenWatchDeps {
  /** The screen the window is on, or null when it cannot be told. */
  screen: () => ScreenInfo | null
  sizes: () => PanelSizes
  /** Whether something is in the way now: a panel open over the window, the application locked, the window hidden or minimised. */
  busy: () => boolean
  /** Remembers that the notice was shown for this screen, then shows it. Called once per screen, ever. */
  show: (kind: ScreenKind, screen: ScreenInfo) => void
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

/** The wait after a window is shown before its screen is looked at (the window is drawn, and the first sheets have had their turn), and after a move or a focus. */
export const SHOWN_DELAY_MS = 2500
export const SETTLE_DELAY_MS = 600

export class ScreenWatch {
  private timer: unknown = null

  constructor(private readonly deps: ScreenWatchDeps) {}

  /** Looks at the screen once the delay has gone by; a second call before that starts the wait again, so that a drag is looked at where it ends. */
  soon(delayMs: number = SETTLE_DELAY_MS): void {
    this.stop()
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.look()
    }, delayMs)
  }

  /** The notice this screen is owed, shown at once; null when it is owed none, or when the window is busy (it is looked at again later). */
  look(): ScreenKind | null {
    if (this.deps.busy()) return null
    const screen = this.deps.screen()
    if (screen === null) return null
    const kind = screenNotice(screen, this.deps.sizes())
    if (kind === null) return null
    this.deps.show(kind, screen)
    return kind
  }

  /** The window is closed: no look is left waiting. */
  stop(): void {
    if (this.timer === null) return
    this.deps.clearTimer(this.timer)
    this.timer = null
  }
}
