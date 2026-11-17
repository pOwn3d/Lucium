// The scriptlet rules of a filter list (`site.com##+js(name, arg, …)`), for the iOS application (docs/ios.md, section 6.4).
//
// WebKit's content blocker has no such thing: a scriptlet is a call to a small piece of code that runs in the page. So the converter keeps them
// apart from the rules WebKit reads, in a table the application looks up when a page starts: site → calls. What this file never does is carry
// code: a list only NAMES a scriptlet of the library we ship (src/shared/scriptlets.ts, the Mac's own, run by src/preload/guard-world.ts), with
// arguments that the Mac's grammar accepts. The check is the Mac's (`parseScriptletCall`, handed in by the caller so this file imports nothing),
// and the page-side code checks again. Anything else is left out and counted under the reason.
//
// Pure: text in, table out. Loaded by Node with type stripping: no enum, no parameter property.

/** One call of the table: the name of the scriptlet, its arguments, and the sites it does not apply to even though it covers their parent. */
export type ScriptletEntry = [id: string, args: string[]] | [id: string, args: string[], unless: string[]]

/** What the Mac's `parseScriptletCall` answers (src/shared/scriptlets.ts): the call, or the key of the message that says why not. */
export type ScriptletVerdict = { ok: true; call: { id: string; args: string[] } } | { ok: false; reason: { key: string; vars?: Record<string, unknown> } }
export type ScriptletParser = (name: unknown, args: unknown) => ScriptletVerdict

/** The table of one list: a site (written as the list writes it, ASCII, lower case) → its calls, in the order of the list. */
export interface ScriptletTable {
  domains: Record<string, ScriptletEntry[]>
  /** Calls in the table. */
  calls: number
}

export const EMPTY_SCRIPTLET_TABLE: ScriptletTable = { domains: {}, calls: 0 }

/** The most arguments a call takes (the Mac's `parseScriptletCall` refuses more). */
const ARGS_MAX = 4

/** The text between the parentheses of `+js(…)` split at the commas that are not escaped (`\,`); null when the text is not a call. */
export function splitScriptletArguments(selectorText: string): string[] | null {
  if (!selectorText.startsWith('+js(') || !selectorText.endsWith(')')) return null
  const inner = selectorText.slice(4, -1)
  const parts: string[] = []
  let current = ''
  for (let at = 0; at < inner.length; at++) {
    const character = inner[at]!
    if (character === '\\' && inner[at + 1] === ',') {
      current += ','
      at++
    } else if (character === ',') {
      parts.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  parts.push(current.trim())
  return parts
}

interface Pending {
  id: string
  args: string[]
  /** Sites an exception took out of this call. */
  unless: Set<string>
}

/** Reads the scriptlet lines of one list, then writes the table. Exceptions can come before the rule they cancel, so they are applied at the end. */
export class ScriptletCollector {
  private readonly rules = new Map<string, Map<string, Pending>>()
  private readonly exceptions: Array<{ domain: string; key: string | null }> = []

  private readonly parse: ScriptletParser
  private readonly toAscii: (name: string) => string | null

  // Plain fields, not parameter properties: Node strips types and does not know that syntax.
  constructor(parse: ScriptletParser, toAscii: (name: string) => string | null) {
    this.parse = parse
    this.toAscii = toAscii
  }

  /**
   * One filter. `domainText` is what precedes `##` (comma-separated sites), `exception` is true for `#@#`, `selectorText` starts with `+js(`.
   * Returns the reason the filter was left out, or null when it is kept (or is an exception, applied at the end).
   */
  read(domainText: string, exception: boolean, selectorText: string): string | null {
    const parts = splitScriptletArguments(selectorText)
    if (parts === null) return 'scriptlet:malformed'
    const domains: string[] = []
    for (const raw of domainText.split(',')) {
      if (raw === '') continue
      if (raw.startsWith('~')) return 'scriptlet:negated-domain'
      const name = raw.toLowerCase()
      if (name.includes('*')) return 'scriptlet:entity'
      const ascii = this.toAscii(name)
      if (ascii === null) return 'scriptlet:domain-invalid'
      domains.push(ascii)
    }
    // A scriptlet for every page is not something a list of sites says; the Mac's engine does not run one either.
    if (domains.length === 0) return 'scriptlet:generic'
    if (exception) {
      // `#@#+js()` cancels every scriptlet of the site; with a call, that call only.
      if (parts.length === 1 && parts[0] === '') {
        for (const domain of domains) this.exceptions.push({ domain, key: null })
        return null
      }
      const verdict = this.parseParts(parts)
      if ('reason' in verdict) return verdict.reason
      for (const domain of domains) this.exceptions.push({ domain, key: verdict.key })
      return null
    }
    const verdict = this.parseParts(parts)
    if ('reason' in verdict) return verdict.reason
    for (const domain of domains) {
      const own = this.rules.get(domain) ?? new Map<string, Pending>()
      // The same call twice for a site is one call.
      if (!own.has(verdict.key)) own.set(verdict.key, { id: verdict.id, args: verdict.args, unless: new Set() })
      this.rules.set(domain, own)
    }
    return null
  }

  private parseParts(parts: string[]): { id: string; args: string[]; key: string } | { reason: string } {
    if (parts.length - 1 > ARGS_MAX) return { reason: 'scriptlet:arguments' }
    const verdict = this.parse(parts[0], parts.slice(1))
    if (!verdict.ok) {
      // Not a scriptlet of the library: the name is the reason that says most (`rmnt`, `trusted-click-element`…), the grammar's refusal says the rest.
      const key = verdict.reason.key
      if (key === 'scriptlets.scriptlet-name-inconnu') return { reason: `scriptlet:unknown-name:${String(parts[0]).slice(0, 40)}` }
      if (key === 'scriptlets.arguments-refuses-pour-id') return { reason: `scriptlet:arguments:${String(verdict.reason.vars?.['id'] ?? '')}` }
      return { reason: 'scriptlet:arguments' }
    }
    const { id, args } = verdict.call
    return { id, args, key: JSON.stringify([id, args]) }
  }

  /** The table, with the exceptions applied: an exception for a site takes the call out of that site and its subdomains; for a subdomain of the site a rule names, the call stays and says where it does not apply. */
  table(): ScriptletTable {
    for (const { domain, key } of this.exceptions) {
      for (const [site, own] of this.rules) {
        const covered = site === domain || site.endsWith(`.${domain}`)
        const narrower = domain.endsWith(`.${site}`)
        if (!covered && !narrower) continue
        for (const [callKey, pending] of own) {
          if (key !== null && callKey !== key) continue
          if (covered) own.delete(callKey)
          else pending.unless.add(domain)
        }
      }
    }
    const domains: Record<string, ScriptletEntry[]> = {}
    let calls = 0
    for (const site of [...this.rules.keys()].sort()) {
      const own = this.rules.get(site)!
      if (own.size === 0) continue
      domains[site] = [...own.values()].map((pending): ScriptletEntry => (pending.unless.size === 0 ? [pending.id, pending.args] : [pending.id, pending.args, [...pending.unless].sort()]))
      calls += own.size
    }
    return { domains, calls }
  }
}
