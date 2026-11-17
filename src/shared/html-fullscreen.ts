// HTML full screen (a video's own button, `requestFullscreen()`). Electron puts the whole window in full screen but leaves the page's view where it was, so the
// page would stay in its card with the sidebar beside it. The shell gives the page the whole window while it is in full screen; these are the rules of which
// tab that is, kept pure (the window and the pages are the shell's).

/** What a page's report changes: the tab that holds the window in full screen (null: none) and the tab, if any, that must be told to leave it. */
export interface FullscreenStep {
  tab: string | null
  leave: string | null
}

/**
 * A page of `tabId` went in (`on`) or out of full screen. Only a tab on show may hold the window: a page that is hidden (another tab, another space) is told
 * to leave at once, and the one that held the window before is told to leave when another takes it.
 */
export function fullscreenReported(current: string | null, tabId: string, on: boolean, shown: ReadonlySet<string>): FullscreenStep {
  if (!on) return { tab: current === tabId ? null : current, leave: null }
  if (!shown.has(tabId)) return { tab: current, leave: tabId }
  return { tab: tabId, leave: current !== null && current !== tabId ? current : null }
}

/** The tabs on show changed (a tab was selected, closed, or its space left): a page in full screen that is no longer on show gives the window back. */
export function fullscreenAfterSync(current: string | null, shown: ReadonlySet<string>): FullscreenStep {
  return current !== null && !shown.has(current) ? { tab: null, leave: current } : { tab: current, leave: null }
}

/** What a page runs to leave full screen: the page's own `exitFullscreen`, which needs no gesture. */
export const LEAVE_FULLSCREEN = `document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false`
