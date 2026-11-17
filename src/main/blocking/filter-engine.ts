// The port to the filter engine: the one surface the blocker uses to match requests and cosmetic rules. The engine
// behind it (ghostery-engine.ts today) can be replaced, for instance by a native engine (adblock-rs), without
// touching the service, the settings or the interface.

import type { RequestKind } from '@shared/blocker'

export interface EngineRequest {
  url: string
  /** The page that makes the request (its top-level address); empty when unknown, which counts as first party. */
  sourceUrl: string
  kind: RequestKind
  /**
   * The request goes to the site of its source. Then only a rule that names the first party (`$first-party`, `$1p`, `$~third-party`)
   * may block it: a rule that does not say whose requests it targets is meant for third parties.
   */
  ownSite?: boolean
}

/** What the page's own markup contains, so generic rules ("hide every .ad-slot") can be looked up without shipping all of them. */
export interface DomHints {
  classes: string[]
  ids: string[]
  hrefs: string[]
}

/** What the lists say to do with a request, once the extended rules are on. */
export type NetworkVerdict =
  | { action: 'pass' }
  | { action: 'block' }
  /** A `$redirect` / `$redirect-rule` rule: the NAME of the stand-in resource it asks for (the service decides whether it has one). */
  | { action: 'redirect'; resource: string }
  /** A `$removeparam` rule: the same address without the parameters it names. */
  | { action: 'rewrite'; url: string }

/** A scriptlet rule as the lists wrote it: a name and its arguments, nothing yet checked. */
export interface ScriptletRule {
  name: string
  args: string[]
}

export interface FilterEngine {
  /** Whether the request must be cancelled. Never asked about the page the user opened. */
  shouldBlock(request: EngineRequest): boolean
  /**
   * The same question with the extended rules of the lists answered: a stand-in resource for a blocked request, a cleaned address for
   * `$removeparam`. A backend that does not know those rules leaves it out, and the service falls back to `shouldBlock`.
   */
  decide?(request: EngineRequest): NetworkVerdict
  /** The scriptlet rules that apply to a page (its site's, minus the exceptions), as written. Never code: see shared/scriptlets.ts. */
  scriptlets?(pageUrl: string): ScriptletRule[]
  /** The `$csp` policy the lists add to a page's main document, or undefined. */
  cspFor?(pageUrl: string): string | undefined
  /**
   * A stylesheet that hides what the lists name on a page: the rules of its site and the generic rules that need no look
   * at the markup, plus those the `dom` hints call for. Empty when there is nothing to hide.
   */
  cosmeticCss(pageUrl: string, dom?: DomHints): string
  /** The compiled engine, for the cache: loading it is much faster than building it from the lists. */
  serialize(): Uint8Array
}

export interface FilterEngineBackend {
  /** Names the engine and its serialization format: a cached engine made by another id is not reused. */
  readonly id: string
  /** Compiles the text of filter lists (loaded on first use, not at startup). */
  build(listTexts: readonly string[]): Promise<FilterEngine>
  /** Restores an engine from `serialize()`. Rejects when the bytes are not one this backend can read. */
  load(bytes: Uint8Array): Promise<FilterEngine>
  /**
   * Whether the engine understands one rule and will apply it (`build` leaves out a rule whose matching could hold the main process on a
   * long address). A backend that cannot say (a test double) leaves it out: every rule counts as understood.
   * It is the last check a rule of the user's goes through before it is kept (see custom-filter-lists.ts).
   */
  parses?(line: string): boolean
}
