// Tells, each time a page stops loading, whether it stopped on a page the user went to. Chromium reports "loading" for the whole view: the
// load of a frame inside the page (an advertisement that refreshes, an embedded player, a chat widget) starts and stops it just as a navigation
// does, so counting every stop as a visit made the history count the same page again and again, and rewrite its file each time. Only what a
// navigation of the page itself committed is a visit. No Electron here: the engine hands over the events, so that the rule can be tested.

export class VisitTracker {
  private committed = false

  /** `did-start-loading`: a new load. Nothing has been committed by it yet. */
  loadStarted(): void {
    this.committed = false
  }

  /** `did-navigate`, or `did-navigate-in-page` of the main frame: the page itself went somewhere (a new document, or a route of a single-page site). */
  navigationCommitted(): void {
    this.committed = true
  }

  /** `did-stop-loading`: whether this load came to a page that was navigated to (and not only to a frame that loaded inside the page). */
  loadStopped(): boolean {
    return this.committed
  }
}
