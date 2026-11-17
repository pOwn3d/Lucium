// What the readable mode gives a page (readable-mode.ts holds the choice): how a page is looked at, and what a page that is the opposite of what
// was asked is given (a light page for Dark, a dark page for Light). A page that already is what was asked is left alone. Nothing here runs for a
// site left on Original: the browser asks `readableModeFor` first.
//
// Since phase 2 a page is recoloured by the engine of readable-engine.ts, run in an isolated world of the page: hues kept, lightness moved by role,
// the contrast of WCAG reached for text and controls. The inversion of phase 1 (the Tweak "inverser", softened) is its way back: a page on which
// the engine fails (an exception, more time than its budget) is inverted instead, and the reason is logged.
//
// The seam is `readablePlan` (what a mode and a look give a page) and `applyReadable` (giving it): the shell knows nothing else of what a mode does.

import { composeBoostCss } from './boost'
import { NEUTRAL_TINT } from './model'
import type { ReadableMode } from './readable-mode'
import { READABLE_STOP_SCRIPT, readableEngineCall, type ReadableScheme } from './readable-engine'

export { DARK_PROBE_SCRIPT } from './readable-engine'

// ---------- the way back: the inversion ----------

/**
 * Pure inversion turns a white page into pure black and black text into pure white, which is harsh. A contrast of 90 % after the inversion
 * gives #0d0d0d under #f2f2f2 text. It is the tint mechanism of the Tweaks, so the filter composes like a Tweak's.
 */
export const DARK_TINT = { ...NEUTRAL_TINT, contrast: 0.9 } as const

// Video players embedded in a frame cannot be reached from the page, so the frame itself is turned back.
const EMBEDS = ['youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv'].map((host) => `iframe[src*="${host}"]`).join(', ')

/** The colour the browser paints a page that declares no background of its own: white, or (with a dark colour scheme) the one of a dark canvas. */
const CANVAS = { light: '#fff', dark: '#121212' } as const

/**
 * The stylesheet that turns a page the other way round: the Tweak inversion, softened, with the frames of video players turned back. A page that
 * declares no background at all shows the browser's canvas, which a filter on the root does not reach: `canvas` says which colour that is, and
 * the root is given it first. It is the same sheet for a light page made dark and for a dark page made light: inverting is its own opposite.
 */
export function invertCss(options: { canvas?: keyof typeof CANVAS } = {}): string {
  const boost = composeBoostCss({ css: '', zap: [], invert: true, tint: { ...DARK_TINT } })
  return `${options.canvas ? `html { background-color: ${CANVAS[options.canvas]}; }\n` : ''}${boost}\n${EMBEDS} { filter: invert(1) hue-rotate(180deg); }`
}

// ---------- looking at the page ----------

/** The luminance at which white text keeps a 4.5 : 1 contrast (the WCAG minimum for body text): darker than this, a page is dark. */
export const DARK_PAGE_LUMINANCE = 0.18

/** Whether the five samples describe a page that is dark already: the median is under the threshold. Anything unreadable is "not dark". */
export function pageLooksDark(samples: unknown): boolean {
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 20) return false
  const values = samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
  if (values.length !== samples.length) return false
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]! < DARK_PAGE_LUMINANCE
}

/** `pdf`: the document is a PDF, drawn by the viewer; like a page that is what was asked, it gets no filter. */
export type DarkVerdict = 'light' | 'dark' | 'unknown' | 'pdf'

/** What a page looks like, as `probePage` read it: its verdict, and whether the browser's own canvas shows (white: `bare`, dark: `bareDark`). */
export interface PageLook {
  verdict: DarkVerdict
  bare: boolean
  bareDark: boolean
}

/**
 * Asks the page for its colours. A page that cannot answer (it is navigating, it blocked the script) is "unknown", logged with its
 * context, and left as it is: a filter given blindly could turn a page the wrong way. `bare` and `bareDark` are only ever true for what the
 * page said is the absence of any background, and `pdf` only for a real true (anything else it answers is not trusted).
 */
export async function probePage(run: () => Promise<unknown>, warn: (message: string) => void, context: string): Promise<PageLook> {
  try {
    const answer = await run()
    const record = typeof answer === 'object' && answer !== null ? (answer as { samples?: unknown; bare?: unknown; bareDark?: unknown; pdf?: unknown }) : {}
    if (record.pdf === true) return { verdict: 'pdf', bare: false, bareDark: false }
    return { verdict: pageLooksDark(record.samples) ? 'dark' : 'light', bare: record.bare === true, bareDark: record.bareDark === true }
  } catch (error) {
    warn(`[dark-sites] cannot read the colours of ${context}: ${error instanceof Error ? error.message : String(error)}`)
    return { verdict: 'unknown', bare: false, bareDark: false }
  }
}

// ---------- what a mode gives a page ----------

/** What a page is given: the recolouring engine for a scheme, and the inversion it falls back to. */
export interface ReadablePlan {
  scheme: ReadableScheme
  /** The inversion of phase 1, with the canvas the page shows: what the page is given instead when the engine fails on it. */
  fallbackCss: string
}

/**
 * The seam of the readable mode: what a page is given for the mode it is in (readable-mode.ts, `readableModeFor`) and what it looks like
 * (`probePage`). Null is "leave it as it is": Original, a page that already is what the mode asks (a dark page in Dark, a light page in Light), a
 * PDF, and a page that could not be read. Dark recolours a light page dark; Light recolours a dark page light.
 */
export function readablePlan(mode: ReadableMode, look: PageLook): ReadablePlan | null {
  if (mode === 'dark' && look.verdict === 'light') return { scheme: 'dark', fallbackCss: invertCss(look.bare ? { canvas: 'light' } : {}) }
  if (mode === 'light' && look.verdict === 'dark') return { scheme: 'light', fallbackCss: invertCss(look.bareDark ? { canvas: 'dark' } : {}) }
  return null
}

/** What the shell remembers a page was given, so that a page is only touched when that changes ('' for nothing). */
export const readableKey = (plan: ReadablePlan | null): string => (plan ? `${plan.scheme}\n${plan.fallbackCss}` : '')

/** What giving a plan needs of a page: its `dark` stylesheet slot, and its readable world (`READABLE_WORLD`). */
export interface ReadableTarget {
  applyCss(css: string): void
  run(code: string): Promise<unknown>
}

/** How giving a plan ended: nothing to give, the engine running, the inversion instead, or a newer call came first (nothing done). */
export type ReadableOutcome = 'none' | 'engine' | 'inverted' | 'stale'

/** Whether the engine answered that it started (`ReadableStart`): only a real `ok: true` counts, anything else is a failure. */
export function readableStarted(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true
}

const reasonOf = (answer: unknown): string => {
  const reason = typeof answer === 'object' && answer !== null ? (answer as { reason?: unknown }).reason : undefined
  return typeof reason === 'string' && reason !== '' ? reason.slice(0, 200) : 'no answer'
}

/**
 * Gives a page a plan, or takes back what it had (`plan` null): the one place that knows what a mode does to a page. The engine starts in the page's
 * readable world; when it fails there (it threw, it ran out of its time budget, it gave no answer), the page is given the inversion instead, with
 * a line in the log. `had` says the page was given something before (the engine is then stopped). `current` says whether this call is still the
 * newest for the page: an answer that comes after a newer call changes nothing.
 */
export async function applyReadable(target: ReadableTarget, plan: ReadablePlan | null, options: { had: boolean; current: () => boolean; warn: (message: string) => void; context: string }): Promise<ReadableOutcome> {
  // The inversion a previous plan fell back to goes in every case: a new plan starts from the page's own colours.
  target.applyCss('')
  if (!plan) {
    if (options.had) {
      try {
        await target.run(READABLE_STOP_SCRIPT)
      } catch (error) {
        options.warn(`[dark-sites] cannot take the recolouring off ${options.context}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return 'none'
  }
  let answer: unknown
  try {
    answer = await target.run(readableEngineCall('start', { scheme: plan.scheme, fallbackCss: plan.fallbackCss }))
  } catch (error) {
    answer = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!options.current()) return 'stale'
  if (readableStarted(answer)) return 'engine'
  options.warn(`[dark-sites] the recolouring failed on ${options.context} (${reasonOf(answer)}): the page is inverted instead`)
  target.applyCss(plan.fallbackCss)
  return 'inverted'
}
