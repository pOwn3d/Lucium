// The fingerprint protection inside a page: the frames it contains (those of another site, `about:blank` and `srcdoc` included) and the workers it
// starts. The preload of the page guard runs in the main frame only, so these get the same function (src/preload/guard-world.ts) another way: as
// text, through a protocol session the engine keeps on the page (src/main/engine/inner-guard.ts). Pure: what the text is made of.
//
// A frame is given its script by the renderer, from a list the session registered earlier; the main process cannot answer a frame the way it
// answers the preload of a page. The text therefore carries a small table: the page the tab shows now and what it gets, and what a frame gets
// when its page is another one (a navigation the table has not caught up with). That second case never leaves a frame unprotected.

import type { FingerprintConfig } from './fingerprint-levels'

export interface InnerTable {
  /** The page the tab shows: its origin, and what its documents get (null: a site left out, or a page that is not a web page). Null before the first page. */
  current: { origin: string; config: FingerprintConfig | null } | null
  /** The strength of the moment, for a frame whose page is not `current`. Its seed is mixed with the origin of that page, so two sites never share a noise. */
  fallback: FingerprintConfig
}

type Guard = (plan: { scriptlets: never[]; fingerprint: FingerprintConfig }) => void

/**
 * Runs in a document before its scripts, as text (it must stay self-contained, like the guard itself). A frame reads the origin of its page from
 * `location.ancestorOrigins`, which no script of the frame has touched yet; the page itself has no ancestor and is left to the preload, so the
 * guard is never run twice on one window.
 */
export function frameBootstrap(guard: Guard, table: InnerTable): void {
  const w = globalThis as any
  try {
    const origins = w.location.ancestorOrigins
    const top = origins && origins.length > 0 ? String(origins[origins.length - 1]) : ''
    let config: FingerprintConfig | null = null
    if (/^https?:\/\//i.test(top)) {
      if (table.current && table.current.origin === top) config = table.current.config
      else {
        // FNV-1a over the origin: a seed for this page that the main process did not have the time to give.
        let hash = 2166136261
        for (let i = 0; i < top.length; i++) hash = Math.imul(hash ^ top.charCodeAt(i), 16777619)
        config = { ...table.fallback, seed: (table.fallback.seed ^ hash) >>> 0 }
      }
    } else if (top === 'null' && table.current) {
      // A page with an opaque origin (a sandboxed one) names itself "null": only the page the tab shows can be meant.
      config = table.current.config
    }
    if (config) guard({ scriptlets: [], fingerprint: config })
  } catch (error) {
    try {
      w.console.warn('[guard] the protection of a frame could not be installed:', error instanceof Error ? error.message : String(error))
    } catch {
      // The console itself failed: the frame goes on, as it must.
    }
  }
}

/**
 * A build that keeps function names (the engine test's) wraps inner functions in a helper of the bundle, which a text run elsewhere does not
 * have: it is given one that does nothing.
 */
const standalone = (functionText: string): string => `(()=>{var __name=(f)=>f;return ${functionText}})()`

/** The script every document of a page runs first; it does nothing in the page itself. `guardText` is the text of `guardWorld`. */
export const frameGuardSource = (guardText: string, table: InnerTable): string => `${standalone(String(frameBootstrap))}(${standalone(guardText)},${JSON.stringify(table)})`

/** What a worker evaluates before its own script. */
export const workerGuardSource = (guardText: string, config: FingerprintConfig): string => `${standalone(guardText)}(${JSON.stringify({ scriptlets: [], fingerprint: config })})`

/** What a worker of the page gets: what the page gets, or the strength of the moment when no page is known yet. */
export const workerConfig = (table: InnerTable): FingerprintConfig | null => (table.current ? table.current.config : table.fallback)

/** The origin a frame reads of the page at `pageUrl`, or '' for an address that has none. */
export function pageOrigin(pageUrl: string): string {
  return URL.canParse(pageUrl) ? new URL(pageUrl).origin : ''
}
