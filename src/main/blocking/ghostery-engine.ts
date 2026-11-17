// Filter engine backed by @ghostery/adblocker (MPL-2.0, pure JavaScript). The only file that imports it.

import type { FiltersEngine, NetworkFilter, Request as RequestClass } from '@ghostery/adblocker'
import { addressForFilters, FILTER_ADDRESS_MAX, filterRuleHazard } from '@shared/filter-lists'
import type { DomHints, EngineRequest, FilterEngine, FilterEngineBackend, NetworkVerdict, ScriptletRule } from './filter-engine'

// Loaded on first use: the library costs startup time and memory that a user who never turns blocking on should not pay.
type Library = typeof import('@ghostery/adblocker')
const library = (): Promise<Library> => import('@ghostery/adblocker')

// Extended selectors (":has-text") need a script to be evaluated: not supported, so their rules are skipped. Scriptlet rules are parsed (the
// engine keeps their name and arguments) but the engine has no scriptlet library here: it never produces code, and the service only ever
// maps their names to Lucium's own (see shared/scriptlets.ts).
const OPTIONS = { loadPreprocessors: true, loadExtendedSelectors: false } as const

// What "!#if" conditions in the lists see: a desktop Chromium that accepts user stylesheets and filters no HTML.
const ENV = new Map<string, boolean>([
  ['env_chromium', true],
  ['cap_user_stylesheet', true]
])

/**
 * Whether a rule that matched is written for first parties only (`$first-party`, `$1p`, `$~third-party`). A rule that says nothing
 * about the party applies to third parties as well, and so does `$third-party`: either way `thirdParty()` is set.
 */
function namesFirstParty(filter: NetworkFilter | undefined): boolean {
  return filter !== undefined && !filter.thirdParty()
}

/**
 * The network rules that are safe to run on an address a page chooses. A rule with a wildcard, and one written as a regular expression,
 * is matched by a regular expression in the main process: the ones whose cost can grow without a bound are left out here, whatever list
 * they come from, and the journal says how many.
 */
export function withoutCostlyRules<Rule extends Pick<NetworkFilter, 'isRegex' | 'getRegex' | 'toString'>>(rules: readonly Rule[]): Rule[] {
  const kept: Rule[] = []
  const left: string[] = []
  let count = 0
  for (const rule of rules) {
    const hazard = rule.isRegex() ? filterRuleHazard(rule.getRegex().source) : null
    if (hazard === null) {
      kept.push(rule)
      continue
    }
    count++
    if (left.length < 3) left.push(`${rule.toString().slice(0, 120)} (${hazard})`)
  }
  if (count > 0) console.warn(`[blocking] ${count} rule(s) of the lists left out, matching them could hold the browser on a long address. The first: ${left.join(' ; ')}`)
  return kept
}

function ready(engine: FiltersEngine, Request: typeof RequestClass): GhosteryEngine {
  engine.updateEnv(ENV)
  return new GhosteryEngine(engine, Request)
}

class GhosteryEngine implements FilterEngine {
  constructor(
    private readonly engine: FiltersEngine,
    private readonly Request: typeof RequestClass
  ) {}

  /**
   * The request as the library reads it. It is given the start of a long address only: its rules are run on what it gets, and the time
   * that takes is bounded for an address of a bounded length (shared/filter-lists.ts).
   */
  private request(details: { url: string; sourceUrl?: string; kind?: EngineRequest['kind'] }): RequestClass {
    return this.Request.fromRawDetails({
      url: addressForFilters(details.url),
      ...(details.sourceUrl !== undefined ? { sourceUrl: addressForFilters(details.sourceUrl) } : {}),
      ...(details.kind !== undefined ? { type: details.kind } : {})
    })
  }

  shouldBlock(details: EngineRequest): boolean {
    const request = this.request(details)
    // A redirect rule (a neutered script in place of the real one) also matches: without its resource it is a plain block.
    return this.blocks(request, this.engine.match(request), details.ownSite)
  }

  /** Whether a request the engine matched is to be acted on, once the first-party rule of the Standard mode is applied. */
  private blocks(request: RequestClass, result: ReturnType<FiltersEngine['match']>, ownSite: boolean | undefined): boolean {
    if (!result.match) return false
    if (!ownSite || namesFirstParty(result.filter)) return true
    // The rule that won may not be the one that names the first party: look at every rule the request meets.
    for (const filter of this.engine.matchAll(request)) if (namesFirstParty(filter)) return true
    return false
  }

  decide(details: EngineRequest): NetworkVerdict {
    const request = this.request(details)
    const result = this.engine.match(request)
    if (this.blocks(request, result, details.ownSite)) {
      const filter = result.filter
      const resource = filter?.isRedirect() ? filter.getRedirectResource() : ''
      return resource !== '' && resource !== 'none' ? { action: 'redirect', resource } : { action: 'block' }
    }
    // An allowed request may still lose parameters (`$removeparam`); one that is blocked has no address left to clean.
    // An address the library saw the start of is not cleaned: what it would answer is that start alone, and the request would lose its end.
    const cleaned = details.url.length <= FILTER_ADDRESS_MAX ? result.rewrite?.url : undefined
    return !result.match && typeof cleaned === 'string' && cleaned !== details.url ? { action: 'rewrite', url: cleaned } : { action: 'pass' }
  }

  scriptlets(pageUrl: string): ScriptletRule[] {
    const page = this.request({ url: pageUrl })
    if (!page.isSupported) return []
    const { matches } = this.engine.matchCosmeticFilters({
      url: page.url,
      hostname: page.hostname,
      domain: page.domain,
      getRulesFromHostname: true,
      getRulesFromDOM: false,
      getInjectionRules: true,
      getExtendedRules: false
    })
    const rules: ScriptletRule[] = []
    for (const { filter, exception } of matches) {
      // An exception (`#@#+js(...)`) cancels the rule it names for this site.
      if (!filter || exception !== undefined || !filter.isScriptInject()) continue
      const parsed = filter.parseScript()
      if (parsed) rules.push({ name: parsed.name, args: parsed.args })
    }
    return rules
  }

  cspFor(pageUrl: string): string | undefined {
    return this.engine.getCSPDirectives(this.request({ url: pageUrl, sourceUrl: '', kind: 'main_frame' }))
  }

  cosmeticCss(pageUrl: string, dom?: DomHints): string {
    const page = this.request({ url: pageUrl })
    if (!page.isSupported) return ''
    const { styles } = this.engine.getCosmeticsFilters({
      url: page.url,
      hostname: page.hostname,
      domain: page.domain,
      classes: dom?.classes ?? [],
      ids: dom?.ids ?? [],
      hrefs: dom?.hrefs ?? [],
      getBaseRules: true,
      getRulesFromHostname: true,
      getRulesFromDOM: dom !== undefined,
      getInjectionRules: false,
      getExtendedRules: false
    })
    return styles
  }

  serialize(): Uint8Array {
    return this.engine.serialize()
  }
}

/**
 * The count of the changes made to what `build` keeps of the lists. It is part of the id of the backend: an engine compiled before the
 * costly rules were left out still holds them, and must not come back from the cache.
 */
const RULES_REVISION = 2

/** The backend, once the library is loaded. Its id carries the library's serialization version, so a cache from another one is not reused. */
export async function loadGhosteryBackend(): Promise<FilterEngineBackend> {
  const lib = await library()
  return {
    id: `ghostery-${lib.ENGINE_VERSION}-r${RULES_REVISION}`,
    build: async (listTexts) => {
      const config = new lib.Config(OPTIONS)
      const parsed = lib.parseFilters(listTexts.join('\n'), config)
      return ready(new lib.FiltersEngine({ ...parsed, networkFilters: withoutCostlyRules(parsed.networkFilters), config }), lib.Request)
    },
    load: async (bytes) => ready(lib.FiltersEngine.deserialize(bytes), lib.Request),
    parses: (line) => {
      try {
        const rule = lib.parseFilter(line)
        // A rule `build` would leave out is not one the engine applies: the user is told when the list is read, not by a line of the journal.
        return rule !== null && !(rule.isNetworkFilter() && rule.isRegex() && filterRuleHazard(rule.getRegex().source) !== null)
      } catch (error) {
        // A line that makes the parser throw is a line the engine must never be given.
        console.warn('[blocking] the filter parser failed on a rule:', error instanceof Error ? error.message : error)
        return false
      }
    }
  }
}
