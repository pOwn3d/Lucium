// The forced end of loading of a page. Single-page applications (WhatsApp) can leave Chromium without a `did-stop-loading`, so the page would show as
// loading for ever: after a delay, loading is announced as over. Pure apart from the timer; the engine hands in what it announces.

/** How long a page may load before the end is forced. 20 s, not 10: a slow resource of a single-page application must not cut a load that is going on. */
export const FORCED_LOADING_END_MS = 20_000

export class LoadingTimer {
  private timer: NodeJS.Timeout | null = null

  /**
   * Starts the count (a load that starts again replaces the one before). When it runs out, `announce` runs unless `isGone` says the page was closed or
   * destroyed in the meantime: the timer outlives a destroyed page otherwise, and a page that is gone announces nothing.
   */
  start(isGone: () => boolean, announce: () => void): void {
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      if (isGone()) return
      announce()
    }, FORCED_LOADING_END_MS)
  }

  /** The load ended by itself, or the page is going: nothing is announced for it any more. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
