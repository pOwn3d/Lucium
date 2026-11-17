// A view of the interface made only while a window may show it. The floating sidebar (the sidebar again, slid over the page when the sidebar
// is hidden and the pointer touches the edge) is a whole renderer process, about 73 MB, that a window whose sidebar stays shown never draws.
// The window wants it while its sidebar is hidden, so that it is loaded before the pointer
// reaches the edge, and lets it go a few minutes after the sidebar is shown again. No Electron here: the window gives how to make the view.

/** How long the view is kept once the window no longer wants it: a sidebar hidden and shown again in a row keeps the same view. */
export const ON_DEMAND_RELEASE_MS = 3 * 60_000

export interface SurfaceView {
  readonly webContents: { readonly id: number; isDestroyed(): boolean; close(): void }
}

export class OnDemandView<V extends SurfaceView> {
  private view: V | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  /** The sets of senders the IPC trusts (one per window group): the page of the view may speak only while it lives. */
  private readonly trustedSets = new Set<Set<number>>()
  private readonly madeListeners = new Set<(view: V) => void>()

  constructor(
    private readonly make: () => V,
    private readonly releaseAfterMs = ON_DEMAND_RELEASE_MS
  ) {}

  /** The view, while it lives. */
  current(): V | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view : null
  }

  /** The id of the page of the view goes in `trusted` while the view lives, and leaves it when the view goes. */
  trust(trusted: Set<number>): void {
    this.trustedSets.add(trusted)
    const live = this.current()
    if (live) trusted.add(live.webContents.id)
  }

  /** Called with each view as it is made (the window sets its zoom once its page has loaded). */
  onMade(listener: (view: V) => void): void {
    this.madeListeners.add(listener)
  }

  /** The view, made now if it is not there; a release under way is called off. */
  ensure(): V {
    this.stopTimer()
    const live = this.current()
    if (live) return live
    const view = this.make()
    this.view = view
    for (const trusted of this.trustedSets) trusted.add(view.webContents.id)
    for (const listener of this.madeListeners) listener(view)
    return view
  }

  /** Whether the window may show the view soon. Yes makes it and keeps it; no lets it go `releaseAfterMs` later, unless it is wanted again before. */
  want(wanted: boolean): void {
    if (wanted) {
      this.ensure()
      return
    }
    if (!this.current() || this.releaseTimer) return
    this.releaseTimer = setTimeout(() => this.release(), this.releaseAfterMs)
    this.releaseTimer.unref?.()
  }

  /** Closes the view now (its window closes, or nobody wanted it for a while); the next `ensure` makes another one. */
  release(): void {
    this.stopTimer()
    const view = this.view
    this.view = null
    if (!view) return
    for (const trusted of this.trustedSets) trusted.delete(view.webContents.id)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private stopTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
  }
}
