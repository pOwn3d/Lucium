// Synchronized scrolling of the panes of a split view: when one pane scrolls, the others follow, to the
// same share of their length, so that two versions of a page or two translations stay side by side. A script in each pane reports how
// far the page has scrolled and takes the position the other pane reports (page-tools.ts); the application carries one to the other.

import { toolPreamble, type ToolScripts } from './page-tools'

/** The panes to move when `from` scrolled: the other panes of its split view, if that view scrolls together. */
export function syncTargets(paneIds: readonly string[], from: string, synced: boolean): string[] {
  return synced && paneIds.includes(from) ? paneIds.filter((id) => id !== from) : []
}

/** Whether a pane carries the script: it is a pane of a split view that scrolls together, and the tool is switched on. */
export function carriesScrollSync(enabled: boolean, syncedSplits: ReadonlySet<string>, splitId: string | undefined): boolean {
  return enabled && splitId !== undefined && syncedSplits.has(splitId)
}

/** The share (0 to 1) of what can be scrolled that `position` is, 0 when nothing can be scrolled. Self-contained: the page script is built from it. */
export function scrollShare(position: number, content: number, view: number): number {
  const room = content - view
  return room > 0 ? Math.min(1, Math.max(0, position / room)) : 0
}

function installScript(nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  if (tools.scrollSync) return;
  const share = ${scrollShare.toString()};
  const root = () => document.scrollingElement || document.documentElement;
  // The position we moved the page to ourselves (at the request of the other pane) must not be reported back: it would bounce between the two
  // panes for ever. Only a scroll that ends at that position, soon after, is ours; a scroll of the user's to anywhere else is reported at once.
  let moved = null;
  let queued = false;
  const onScroll = () => {
    const element = root();
    if (moved && performance.now() < moved.until && Math.abs(element.scrollTop - moved.top) <= 2 && Math.abs(element.scrollLeft - moved.left) <= 2) return;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const now = root();
      report({ tool: 'scroll', x: share(now.scrollLeft, now.scrollWidth, now.clientWidth), y: share(now.scrollTop, now.scrollHeight, now.clientHeight) });
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  tools.scrollSync = {
    apply(x, y) {
      const element = root();
      const left = x * Math.max(0, element.scrollWidth - element.clientWidth);
      const top = y * Math.max(0, element.scrollHeight - element.clientHeight);
      moved = { left, top, until: performance.now() + 400 };
      element.scrollTo({ left, top, behavior: 'instant' });
    },
    off() {
      removeEventListener('scroll', onScroll);
    }
  };
})()`
}

/** Moves the page to a share of its length. Does nothing in a page that does not carry the tool (it was not installed, or taken out). */
export const scrollSyncApplyScript = (x: number, y: number): string => {
  const share = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)
  return `(function () { const tools = self.__lucium_tools; if (tools && tools.scrollSync) tools.scrollSync.apply(${share(x)}, ${share(y)}) })()`
}

export const SCROLL_SYNC_SCRIPTS: ToolScripts = {
  install: installScript,
  uninstall: `(function () { const tools = self.__lucium_tools; if (!tools || !tools.scrollSync) return; try { tools.scrollSync.off() } finally { delete tools.scrollSync } })()`
}
