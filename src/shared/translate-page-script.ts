// The scripts that run in an isolated world of the page being translated: read its text, put the translation in its place, put the original back. They
// see the page's DOM but not its scripts, and the page cannot see them (the same arrangement as the other page tools, see main/engine/electron-engine.ts).
// What they hold between two calls is kept in the world's own global (`__luciumTranslate`), which the page cannot reach.
//
// The rules of what is translated are those of translate-local.ts (`isTranslatable`, `splitPadding`, SKIP_TAGS, TRANSLATE_LIMITS); the scripts repeat them
// because a script cannot import, and translate-page-script.test.ts runs both over the same texts so that they cannot drift apart.
// A translation goes into the page as the value of a text node: never as markup. A node the page changed since it was read is left alone.

import { SKIP_TAGS, TRANSLATE_LIMITS } from './translate-local'

/** The number of the isolated world (any number outside the ones Chromium gives extension content scripts). */
export const TRANSLATE_WORLD = 4_200_091

export interface ExtractReply {
  lang: string
  /** The words of each text node to translate, without the spacing around them, in the page's order. */
  nodes: string[]
  /**
   * Where each node is from the viewport when it was read, in CSS pixels: 0 on screen, how far below (positive) or above (negative), null when it
   * has no box (hidden). The controller translates what is on screen first (shared/translate-local.ts `readingOrder`).
   */
  offsets?: Array<number | null>
  /** The page had more than the limits allow: only the part nearest the viewport is listed. */
  more: boolean
}

export interface SampleReply {
  lang: string
  text: string
}

// ---------- what the main process takes of a reply ----------
// A reply crossed a process: it is a value of any shape until it is read here. The scripts above keep to the limits; the main process holds
// them again, so that a renderer that answers something else neither throws in the middle of a translation nor sends an engine more text
// than a page may. A reply that is not what a script of this file answers is no reply (null), never a part of one: the positions the
// translations go back to are those of the list the page keeps, and a list cut here would no longer match it.

/** How long the sample of a page is at most (`sampleScript`). */
export const SAMPLE_CHARS = 4000

const isObject = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw)

/** The reply of `sampleScript`: a text, cut to the length of a sample, and the language the page declares (empty when it is not a text). */
export function readSampleReply(raw: unknown): SampleReply | null {
  if (!isObject(raw) || typeof raw['text'] !== 'string') return null
  return { lang: typeof raw['lang'] === 'string' ? raw['lang'].slice(0, 64) : '', text: raw['text'].slice(0, SAMPLE_CHARS) }
}

/** The reply of `extractScript`: the texts within the limits of a page, or the refusal of a page that is translated already. */
export function readExtractReply(raw: unknown): ExtractReply | { error: string } | null {
  if (!isObject(raw)) return null
  if ('error' in raw) return typeof raw['error'] === 'string' ? { error: raw['error'].slice(0, 64) } : null
  const nodes = raw['nodes']
  if (!Array.isArray(nodes) || nodes.length > TRANSLATE_LIMITS.nodes) return null
  let chars = 0
  for (const node of nodes) {
    if (typeof node !== 'string' || node.length > TRANSLATE_LIMITS.nodeChars) return null
    chars += node.length
    if (chars > TRANSLATE_LIMITS.totalChars) return null
  }
  const offsets = raw['offsets']
  return { lang: typeof raw['lang'] === 'string' ? raw['lang'].slice(0, 64) : '', nodes: nodes as string[], ...(Array.isArray(offsets) ? { offsets: offsets as Array<number | null> } : {}), more: raw['more'] === true }
}

/** The reply of `applyScript` when the texts were put in the page: two counts. Null for a refusal and for anything else. */
export function readApplyReply(raw: unknown): { applied: number; skipped: number } | null {
  if (!isObject(raw) || 'error' in raw) return null
  const { applied, skipped } = raw
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TRANSLATE_LIMITS.nodes
  return isCount(applied) && isCount(skipped) ? { applied, skipped } : null
}

/** A sample of the visible text of the page and its declared language, for detecting the language. Changes nothing. */
export function sampleScript(): string {
  return `(() => {
  const root = document.body || document.documentElement
  return { lang: String(document.documentElement.getAttribute('lang') || ''), text: String((root && root.innerText) || '').slice(0, ${SAMPLE_CHARS}) }
})()`
}

/**
 * Lists the text nodes to translate, in reading order, with where each one is from the viewport, and remembers them. Refuses a page that is translated
 * already (it is restored first). A page beyond the limits keeps the nodes nearest the viewport (it reads twice the limits to choose them): a long page
 * read from its middle is translated where it is read.
 */
export function extractScript(): string {
  return `(() => {
  const skip = new Set(${JSON.stringify(SKIP_TAGS)})
  const limits = ${JSON.stringify(TRANSLATE_LIMITS)}
  if (self.__luciumTranslate && self.__luciumTranslate.shown.some((s) => s !== undefined)) return { error: 'translated' }
  const found = []
  let scanned = 0, more = false
  const stack = [document.body || document.documentElement]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.nodeType === 3) {
      const text = String(node.nodeValue || '')
      const lead = /^\\s*/.exec(text)[0]
      const rest = text.slice(lead.length)
      const core = rest.replace(/\\s+$/, '')
      const letters = (core.match(/\\p{L}/gu) || []).length
      if (core.length === 0 || core.length > limits.nodeChars || letters < 2) continue
      if (/^(https?:\\/\\/|www\\.)\\S+$/i.test(core) || /^\\S+@\\S+\\.\\S+$/.test(core)) continue
      if (found.length >= limits.scanNodes || scanned + core.length > limits.scanChars) { more = true; break }
      scanned += core.length
      found.push({ node, core, text, pad: { lead, trail: rest.slice(core.length) } })
    } else if (node.nodeType === 1) {
      if (skip.has(String(node.tagName).toUpperCase())) continue
      if (node.getAttribute('translate') === 'no' || (node.classList && node.classList.contains('notranslate')) || node.isContentEditable) continue
      // Children are pushed last first, so that they come out in the order of the page. An open shadow root is part of the element.
      const kids = [...(node.shadowRoot ? node.shadowRoot.childNodes : []), ...node.childNodes]
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
  }
  // Where each node is from the viewport (CSS pixels): 0 on screen, how far below (positive) or above (negative); null without a box (hidden).
  const range = typeof document.createRange === 'function' ? document.createRange() : null
  const height = Number(self.innerHeight) || 0
  const width = Number(self.innerWidth) || 0
  const offsetOf = (node) => {
    if (!range || height <= 0) return null
    try {
      range.selectNodeContents(node)
      const box = range.getBoundingClientRect()
      if (!(box.width > 0 && box.height > 0)) return null
      if (box.bottom <= 0) return Math.min(-1, Math.round(box.bottom))
      if (box.top >= height) return Math.max(1, Math.round(box.top - height))
      if (box.right <= 0) return Math.max(1, Math.round(-box.right))
      if (width > 0 && box.left >= width) return Math.max(1, Math.round(box.left - width))
      return 0
    } catch (error) {
      return null
    }
  }
  const offsets = found.map((entry) => offsetOf(entry.node))
  // Within the limits, the nodes nearest the viewport (those without a box last), then back in the page's order.
  const far = (offset) => (offset === null ? Infinity : Math.abs(offset))
  const nearest = found.map((_, i) => i).sort((a, b) => far(offsets[a]) - far(offsets[b]) || a - b)
  const kept = []
  let chars = 0
  for (const i of nearest) {
    if (kept.length >= limits.nodes || chars + found[i].core.length > limits.totalChars) { more = true; break }
    chars += found[i].core.length
    kept.push(i)
  }
  kept.sort((a, b) => a - b)
  self.__luciumTranslate = { nodes: kept.map((i) => found[i].node), originals: kept.map((i) => found[i].text), pads: kept.map((i) => found[i].pad), shown: new Array(kept.length) }
  return { lang: String(document.documentElement.getAttribute('lang') || ''), nodes: kept.map((i) => found[i].core), offsets: kept.map((i) => offsets[i]), more }
})()`
}

/**
 * Puts the translations of the nodes at `positions` (positions in the list the extract script made) in their place, `replies[k]` at `positions[k]`.
 * A node that is gone, or that the page changed since it was read, is skipped. Positions that are not those of the list refuse the whole answer.
 */
export function applyScript(positions: readonly number[], replies: readonly string[]): string {
  return `(() => {
  const state = self.__luciumTranslate
  const positions = ${JSON.stringify(positions)}
  const replies = ${JSON.stringify(replies)}
  if (!state || !Array.isArray(positions) || positions.length !== replies.length) return { error: 'state' }
  if (!positions.every((at) => Number.isInteger(at) && at >= 0 && at < state.nodes.length)) return { error: 'state' }
  let applied = 0, skipped = 0
  for (let i = 0; i < replies.length; i++) {
    const at = positions[i]
    const node = state.nodes[at]
    if (!node.isConnected || node.nodeValue !== state.originals[at]) { skipped++; continue }
    const next = state.pads[at].lead + replies[i] + state.pads[at].trail
    node.nodeValue = next
    state.shown[at] = next
    applied++
  }
  return { applied, skipped }
})()`
}

/** Puts the original text back in every node still showing what this script wrote (one the page rewrote since is the page's), and forgets them all. */
export function restoreScript(): string {
  return `(() => {
  const state = self.__luciumTranslate
  let restored = 0
  if (state) {
    for (let i = 0; i < state.nodes.length; i++) {
      const node = state.nodes[i]
      if (state.shown[i] !== undefined && node.nodeValue === state.shown[i]) { node.nodeValue = state.originals[i]; restored++ }
    }
  }
  delete self.__luciumTranslate
  return { restored }
})()`
}
