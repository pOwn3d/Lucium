// The engine port (types.ts), the part of a page that is its place in the windows of the application: shown, hidden, moved to another window,
// lent to one. Re-exported by types.ts, which the rest of Lucium imports.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The live view of a page, lent to another window of the application (`Page.lendView`). */
export interface ViewLoan {
  /** Where the view goes in the other window (its content, in points). */
  place(bounds: Bounds): void
  /** Puts the view above the other views of that window (then the views the window puts over it are added after). */
  raise(): void
  /** Takes the view out of the other window: the tab's window shows it again at its next layout. Nothing happens for a loan that is over. */
  giveBack(): void
}

/** Where a page is in the windows of the application. */
export interface PageView {
  /** Attach the page to the window at `bounds`, its corners rounded by `radius` (PAGE_RADIUS when absent). Calling it again only resizes. */
  show(bounds: Bounds, radius?: number): void
  /** The corner radius the page was last shown with (the engine test reads it: Electron has no getter). */
  borderRadius(): number
  /** Brings an attached page above every other view of the window. */
  raise(): void
  hide(): void
  /**
   * Takes the page, alive, to another window of the application (`windowId` as `createPage` takes it): it leaves the window it is in and the next
   * `show` puts it in the other one; nothing in the page stops or loads again. False, and nothing changed, when it cannot go (the page is gone, the
   * window is not known, one of our covers is over it: an error page, reader mode).
   */
  moveToWindow?(windowId: string | undefined): boolean
  /**
   * Lends the live view of the page to the window `windowId` of the application (the floating video window): nothing in the page stops or loads
   * again, and nothing of what the page is changes (its window for the extensions, its popups and boxes stay its tab's). While it is lent, `show`,
   * `hide`, `raise` and `moveToWindow` do nothing: the layout of the tab's window cannot take it back. `ended` is told when the page can no longer be
   * shown there (it closed, its renderer died, or it went to another document): the loan is over then, and the view is out of the other window.
   * Null when it cannot be lent (the page is gone, the window is not known, one of our covers is over it, it is lent already).
   */
  lendView?(windowId: string, ended: (why: 'gone' | 'crashed' | 'navigated') => void): ViewLoan | null
}
