// Scroll memory: where a tab's page was scrolled to, kept so that the tab comes back to that spot after a relaunch (or after its page was let go for a
// sleep). Only a number per tab and the address it belongs to are kept: never the content of a page. A script in the page reports the position once the
// scrolling has stopped; the application keeps it in a small file (main/scroll-memory-store.ts) and, when the tab's page is made again at the same
// address, tells the script to go there (page-tools.ts carries both messages).

import { toolPreamble, type ToolScripts } from './page-tools'

/** How many tabs keep a position; past it the ones that were scrolled the longest ago go. */
export const SCROLL_MEMORY_MAX = 300

/** Under this many pixels the page is "at the top": nothing is worth remembering, and a position that was kept is forgotten. */
export const SCROLL_MIN_PX = 120

/** The greatest position accepted: far beyond any real page, it only stops a number that makes no sense. */
export const SCROLL_MAX_PX = 50_000_000

/** How long (ms) the page waits after the last scroll before it reports, so that a flick is one message and not hundreds. */
export const SCROLL_REPORT_DELAY_MS = 1500

/** How long (ms) a page that is not tall enough yet (it is still loading its content) is given to reach the position before the script gives up. */
export const SCROLL_RESTORE_WINDOW_MS = 4000

export interface ScrollPosition {
  /** The address of the page the position was read on: a position is only given back to that same address. */
  url: string
  /** Pixels from the top of the document. */
  y: number
  /** When it was kept (ms since the epoch): the oldest go first when the memory is full. */
  at: number
}

export type ScrollMemory = ReadonlyMap<string, ScrollPosition>

/** A position the page may report: a whole number of pixels, in range. */
export const isScrollPx = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SCROLL_MAX_PX

/** The memory after the tab was scrolled to `y` on `url`: a position near the top forgets the tab's entry, a new one replaces it, and the oldest give way past the limit. */
export function scrollRemembered(memory: ScrollMemory, tabId: string, url: string, y: number, now: number): ScrollMemory {
  const next = new Map(memory)
  next.delete(tabId)
  if (y >= SCROLL_MIN_PX && isScrollPx(y)) next.set(tabId, { url, y, at: now })
  if (next.size <= SCROLL_MEMORY_MAX) return next
  const oldest = [...next.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [id] of oldest.slice(0, next.size - SCROLL_MEMORY_MAX)) next.delete(id)
  return next
}

/** The position to go back to: only for the tab, and only when it is still on the address the position was read on. */
export function scrollToRestore(memory: ScrollMemory, tabId: string, url: string): number | undefined {
  const kept = memory.get(tabId)
  return kept !== undefined && kept.url === url && kept.y >= SCROLL_MIN_PX ? kept.y : undefined
}

/** The memory without the tabs that are gone (a closed tab leaves nothing behind). */
export function scrollKeptFor(memory: ScrollMemory, live: ReadonlySet<string>): ScrollMemory {
  if ([...memory.keys()].every((id) => live.has(id))) return memory
  return new Map([...memory].filter(([id]) => live.has(id)))
}

/** The text of the file: one line of JSON, the tab, its address, its position and its time. */
export function scrollFileText(memory: ScrollMemory): string {
  return JSON.stringify({ version: 1, tabs: Object.fromEntries(memory) })
}

/** Reads the file's text; an entry that is not valid is left out, and a file that is not JSON throws (the store logs it and starts again from none). */
export function parseScrollFile(text: string): ScrollMemory {
  const raw: unknown = JSON.parse(text)
  const tabs = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { tabs?: unknown }).tabs : undefined
  if (typeof tabs !== 'object' || tabs === null || Array.isArray(tabs)) return new Map()
  const out = new Map<string, ScrollPosition>()
  for (const [id, value] of Object.entries(tabs)) {
    if (typeof value !== 'object' || value === null) continue
    const { url, y, at } = value as Record<string, unknown>
    if (id === '' || id.length > 100 || typeof url !== 'string' || url.length > 4096 || !isScrollPx(y) || y < SCROLL_MIN_PX || typeof at !== 'number' || !Number.isFinite(at)) continue
    out.set(id, { url, y, at })
    if (out.size >= SCROLL_MEMORY_MAX) break
  }
  return out
}

function installScript(nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  if (tools.scrollMemory) return;
  const root = () => document.scrollingElement || document.documentElement;
  let timer = 0;
  let last = -1;
  const send = () => {
    timer = 0;
    const y = Math.round(root().scrollTop);
    if (y === last) return;
    last = y;
    report({ tool: 'scrollpos', y });
  };
  const onScroll = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, ${SCROLL_REPORT_DELAY_MS});
  };
  // The tab is hidden (another tab shown, the window closed or put away): the position is reported now, the delay would be too late. Not on pagehide:
  // a page that is left for another address would report its old position under the address the tab has just got.
  const onHide = () => { if (document.visibilityState === 'hidden') { if (timer) clearTimeout(timer); send(); } };
  addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onHide);
  // The user's own scrolling cancels a restore that is still waiting for the page to grow: the page is never pulled away from where they went.
  let restore = null;
  const cancel = () => { if (restore) { clearInterval(restore); restore = null; } };
  addEventListener('wheel', cancel, { passive: true });
  addEventListener('keydown', cancel, true);
  addEventListener('touchstart', cancel, { passive: true });
  addEventListener('pointerdown', cancel, true);
  tools.scrollMemory = {
    apply(y) {
      cancel();
      const until = performance.now() + ${SCROLL_RESTORE_WINDOW_MS};
      const step = () => {
        const element = root();
        const reachable = element.scrollHeight - element.clientHeight;
        if (reachable >= y || performance.now() >= until) {
          element.scrollTo({ top: Math.min(y, Math.max(0, reachable)), behavior: 'instant' });
          cancel();
          return true;
        }
        return false;
      };
      // A page that fills in after it loads is waited for a few seconds; a page that is tall enough at once is moved straight away.
      if (!step()) restore = setInterval(step, 150);
    },
    off() {
      cancel();
      if (timer) clearTimeout(timer);
      removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onHide);
      removeEventListener('wheel', cancel);
      removeEventListener('keydown', cancel, true);
      removeEventListener('touchstart', cancel);
      removeEventListener('pointerdown', cancel, true);
    }
  };
})()`
}

/** Moves the page to `y` pixels. Does nothing in a page that does not carry the tool (it was not installed, or taken out). */
export const scrollMemoryApplyScript = (y: number): string =>
  `(function () { const tools = self.__lucium_tools; if (tools && tools.scrollMemory) tools.scrollMemory.apply(${isScrollPx(y) ? y : 0}) })()`

export const SCROLL_MEMORY_SCRIPTS: ToolScripts = {
  install: installScript,
  uninstall: `(function () { const tools = self.__lucium_tools; if (!tools || !tools.scrollMemory) return; try { tools.scrollMemory.off() } finally { delete tools.scrollMemory } })()`
}
