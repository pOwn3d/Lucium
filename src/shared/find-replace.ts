// Find and Replace (Edit › Find › Find and Replace). A web page can only be rewritten where the user could type: text fields and
// editable regions. The replacement itself runs inside the page, so its code is kept as text: the tests run the very same function.

/**
 * `replaceInText(text, query, replacement, matchCase, limit)` replaces the first `limit` occurrences of `query` in `text` and answers
 * `{ text, count, total }` (`total` counts every occurrence, replaced or not). Plain text, not a pattern.
 */
import { t, tp } from './i18n'

export const REPLACE_IN_TEXT_SOURCE = `function replaceInText(text, query, replacement, matchCase, limit) {
  if (!query) return { text: text, count: 0, total: 0 }
  var pattern = new RegExp(query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), matchCase ? 'g' : 'gi')
  var count = 0
  var total = 0
  var out = text.replace(pattern, function (found) {
    total++
    if (count >= limit) return found
    count++
    return replacement
  })
  return { text: out, count: count, total: total }
}`

export interface ReplaceResult {
  text: string
  count: number
  total: number
}

/** The function of `REPLACE_IN_TEXT_SOURCE`, for the main process and the tests. */
export const replaceInText = new Function(`return (${REPLACE_IN_TEXT_SOURCE})`)() as (
  text: string,
  query: string,
  replacement: string,
  matchCase: boolean,
  limit: number
) => ReplaceResult

export interface ReplaceRequest {
  query: string
  replacement: string
  /** Every occurrence, or only the first one. */
  all: boolean
  matchCase: boolean
}

/** What the page reports: occurrences replaced, and occurrences found in editable places (the rest are in read-only text). */
export interface ReplaceOutcome {
  replaced: number
  editable: number
}

const EDITABLE =
  'input:not([type]), input[type=text], input[type=search], input[type=url], input[type=email], input[type=tel], textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'

/** The script a page runs to replace text in its editable places. It answers a `ReplaceOutcome`. */
export function buildReplaceScript(request: ReplaceRequest): string {
  const { query, replacement, all, matchCase } = request
  return `(() => {
  const replaceInText = ${REPLACE_IN_TEXT_SOURCE}
  const query = ${JSON.stringify(query)}, replacement = ${JSON.stringify(replacement)}, matchCase = ${matchCase === true}, all = ${all === true}
  let replaced = 0, editable = 0
  const room = () => (all ? Infinity : 1 - replaced)
  const announce = (el) => el.dispatchEvent(new Event('input', { bubbles: true }))
  for (const el of document.querySelectorAll(${JSON.stringify(EDITABLE)})) {
    if (el.disabled || el.readOnly) continue
    if ('value' in el) {
      const result = replaceInText(el.value, query, replacement, matchCase, room())
      editable += result.total
      if (result.count === 0) continue
      // The page's framework listens to the native setter: assigning .value directly would not reach its state.
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, result.text)
      replaced += result.count
      announce(el)
    } else {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let changed = false
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const result = replaceInText(node.nodeValue, query, replacement, matchCase, room())
        editable += result.total
        if (result.count === 0) continue
        node.nodeValue = result.text
        replaced += result.count
        changed = true
      }
      if (changed) announce(el)
    }
  }
  return { replaced, editable }
})()`
}

/** The sentence the toast shows after a replacement. */
export function replaceMessage(outcome: ReplaceOutcome, foundAnywhere: number): string {
  if (outcome.replaced > 0) return tp('find-replace.count-occurrences-remplacees', outcome.replaced)
  // Found in the page but nowhere the user could type: say why nothing changed.
  return foundAnywhere > 0 ? t('find-replace.le-texte-trouve-se-trouve-dans-une-zone-en') : t('find-replace.aucune-occurrence')
}

export const REPLACE_TEXT_MAX = 2000

/** What the panel sent, checked. Null when the query is empty or anything has the wrong type. */
export function parseReplaceRequest(raw: unknown): ReplaceRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['query'] !== 'string' || r['query'] === '' || r['query'].length > REPLACE_TEXT_MAX) return null
  if (typeof r['replacement'] !== 'string' || r['replacement'].length > REPLACE_TEXT_MAX) return null
  return { query: r['query'], replacement: r['replacement'], all: r['all'] === true, matchCase: r['matchCase'] === true }
}
