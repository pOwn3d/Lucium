// What the blocker accepts of the "extended" rules of a filter list (`$csp`, `$removeparam`, `+js(...)` scriptlets, `$redirect=`): each one is
// reduced to a small set of shapes it can apply safely, and everything else is refused with a sentence. Pure; used twice: when the user adds a
// list (custom-filter-lists.ts), and again on every use of a rule (src/main/blocking/), since a downloaded list or a cached engine is not
// something to trust either.

import { parseScriptletCall, type ScriptletVerdict } from './scriptlets'

// ---------- $csp ----------

/** The directives a list may add. A policy can only restrict a page; `report-uri` and `report-to` are left out because they would make the browser write to a third party. */
const CSP_DIRECTIVES = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'child-src',
  'object-src', 'worker-src', 'base-uri', 'form-action', 'sandbox'
])
const CSP_SOURCE = /^(?:'(?:none|self|unsafe-inline|unsafe-eval|strict-dynamic|wasm-unsafe-eval)'|\*|(?:https?|data|blob|wss?):|(?:https?:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?)$/i
/** A policy longer than this is not one a list needs. */
export const CSP_MAX_CHARS = 300

/** One directive (`script-src 'none'`), or null when it is not one the blocker adds. */
function cleanCspDirective(text: string): string | null {
  const [name, ...sources] = text.trim().split(/\s+/)
  if (name === undefined || !CSP_DIRECTIVES.has(name.toLowerCase())) return null
  if (name.toLowerCase() === 'sandbox') return sources.every((s) => /^allow-[a-z-]+$/.test(s)) ? [name.toLowerCase(), ...sources].join(' ') : null
  if (sources.length === 0 || sources.length > 12 || !sources.every((s) => CSP_SOURCE.test(s))) return null
  return [name.toLowerCase(), ...sources].join(' ')
}

/** A `$csp=` value (or the policy the engine joined from several rules): the directives that are acceptable, joined with "; ". Null when none is. */
export function cleanCspPolicy(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > CSP_MAX_CHARS || /\p{Cc}/u.test(text)) return null
  const pieces = text.split(';')
  // A closing ";" is allowed.
  if (pieces.length > 1 && pieces[pieces.length - 1]!.trim() === '') pieces.pop()
  const kept = pieces.map(cleanCspDirective)
  // One bad directive makes the whole rule suspect: a policy is applied entirely or not at all.
  if (kept.some((d) => d === null)) return null
  return kept.filter((d): d is string => d !== null).join('; ')
}

// ---------- $removeparam ----------

/** The name of one query parameter a rule may remove; a leading "~" (all the others) is not accepted from the user's lists. */
export const isRemoveParamName = (text: string): boolean => /^[\w.%~-]{1,64}$/.test(text) && !text.startsWith('~')

// ---------- scriptlets: reading `+js(name, arg, ...)` ----------

/** The pieces of `+js(name, a, "b c", /re/)`: split on commas that are outside quotes and slashes, quotes removed. Null when it is not a call. */
export function splitScriptletCall(selector: string): { name: string; args: string[] } | null {
  const match = /^\+js\((.*)\)$/s.exec(selector.trim())
  if (!match) return null
  const inner = match[1]!
  if (inner.trim() === '') return { name: '', args: [] }
  const parts: string[] = []
  let current = ''
  let quote = ''
  let regex = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '\\' && i + 1 < inner.length) {
      current += c + inner[++i]!
    } else if (quote !== '') {
      if (c === quote) quote = ''
      else current += c
    } else if (regex) {
      current += c
      if (c === '/') regex = false
    } else if ((c === '"' || c === "'") && current.trim() === '') {
      quote = c
    } else if (c === '/' && current.trim() === '') {
      regex = true
      current += c
    } else if (c === ',') {
      parts.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  if (quote !== '') return null
  parts.push(current.trim())
  const [name, ...args] = parts
  return { name: name ?? '', args }
}

/** The verdict for a `+js(...)` selector as the user's list wrote it: a scriptlet of the library with acceptable arguments, or the reason it is refused. */
export function judgeScriptletSelector(selector: string): ScriptletVerdict {
  const call = splitScriptletCall(selector)
  if (!call) return { ok: false, reason: { key: 'extended-rules.scriptlet-mal-forme' } }
  return parseScriptletCall(call.name, call.args)
}
