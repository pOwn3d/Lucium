// What a page is given when its document starts, by the preload that runs before its scripts (src/preload/page-guard.ts): the scriptlets of
// the site (`blocker_scriptlets`) and the fingerprint protection (`fingerprint`). One message, one answer: the preload asks synchronously
// (the page must not run a line before it is protected) and the main process answers from the settings of that moment.
// Pure: the shape of the answer, and its reading on the other side.

import { cleanFingerprintConfig, type FingerprintConfig } from './fingerprint-levels'
import { cleanScriptletCalls, type ScriptletCall } from './scriptlets'

export const PAGE_GUARD = { plan: 'lucium:page-guard:plan' } as const

export interface GuardPlan {
  scriptlets: ScriptletCall[]
  fingerprint: FingerprintConfig | null
}

export const NO_PLAN: GuardPlan = { scriptlets: [], fingerprint: null }

/** The plan as it arrives from the main process: well-formed parts only. Anything else is "nothing to do". */
export function cleanGuardPlan(raw: unknown): GuardPlan {
  if (typeof raw !== 'object' || raw === null) return NO_PLAN
  const r = raw as Record<string, unknown>
  return { scriptlets: cleanScriptletCalls(r['scriptlets']), fingerprint: cleanFingerprintConfig(r['fingerprint']) }
}

const WEB_ADDRESS = /^https?:\/\//i
/** The longest address the preload may claim: a page address is bounded by what Chromium accepts, and nothing here needs more. */
export const GUARD_ADDRESS_MAX = 4096

/**
 * The address of the document being started. The preload reads it from the document it runs in (`location.href`, which no page script could have
 * touched yet); the frame's last committed address, as the main process knows it, may still be the previous page's while a navigation commits.
 * The preload's wins when it is a web address; the frame's is the fallback; anything else is "no address", and a page without one gets nothing.
 *
 * One document has no address and still runs the scripts of a site: the blank window a page opens to write into (`window.open('')`, then
 * `document.write`). It lives under the origin of its opener, so it is given what the opener's address gets (`openerUrl`): without it, a page
 * would read the canvas, the audio and the rest unprotected through a window of its own making.
 */
export function guardPageUrl(claimed: unknown, frameUrl: unknown, openerUrl?: unknown): string {
  const web = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate.length <= GUARD_ADDRESS_MAX && WEB_ADDRESS.test(candidate) && URL.canParse(candidate)
  for (const candidate of [claimed, frameUrl]) if (web(candidate)) return candidate
  return typeof claimed === 'string' && BLANK.test(claimed) && web(openerUrl) ? openerUrl : ''
}

/** The blank document, with or without a fragment or a query. */
const BLANK = /^about:blank(?:[?#]|$)/i

export const isEmptyPlan = (plan: GuardPlan): boolean => plan.scriptlets.length === 0 && plan.fingerprint === null
