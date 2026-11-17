// Edit › Transformations and Edit › Format: what the menu does to the text selected in a field of the page.

export type CaseTransform = 'upper' | 'lower' | 'capitalize'
export type FormatCommand = 'bold' | 'italic' | 'underline'

/**
 * Upper case, lower case, or the first letter of each word in capitals and the rest in lower case (as macOS does). Kept as text
 * because the page runs it too: the tests run the very same function.
 */
export const TRANSFORM_CASE_SOURCE = `function transformCase(text, kind) {
  if (kind === 'upper') return text.toUpperCase()
  if (kind === 'lower') return text.toLowerCase()
  return text.toLowerCase().replace(/(^|[^\\p{L}\\p{N}'’])(\\p{L})/gu, function (all, before, letter) { return before + letter.toUpperCase() })
}`

export const transformCase = new Function(`return (${TRANSFORM_CASE_SOURCE})`)() as (text: string, kind: CaseTransform) => string

/**
 * The script the page runs to change its selection. It rewrites a selection inside a text field or an editable region and answers
 * whether it did: in text nobody can edit there is nothing to change.
 */
export function transformScript(kind: CaseTransform): string {
  return `(() => {
  const transform = ${TRANSFORM_CASE_SOURCE}
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
    const start = el.selectionStart, end = el.selectionEnd
    el.setRangeText(transform(el.value.slice(start, end), ${JSON.stringify(kind)}), start, end, 'select')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const selection = getSelection()
  if (selection && !selection.isCollapsed && el && el.isContentEditable) return document.execCommand('insertText', false, transform(selection.toString(), ${JSON.stringify(kind)}))
  return false
})()`
}

/** Bold, italic or underline on the selection of an editable region (a text field has no styled text). */
export function formatScript(command: FormatCommand): string {
  return `(() => { const el = document.activeElement; return !!(el && el.isContentEditable) && document.execCommand(${JSON.stringify(command)}) })()`
}

/** Scrolls the page to its selection (or to the search match, which Chromium selects). Answers whether there was something to show. */
export const JUMP_TO_SELECTION_SCRIPT = `(() => {
  const selection = getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  window.scrollBy({ top: rect.top + rect.height / 2 - innerHeight / 2, left: 0, behavior: 'instant' })
  return true
})()`

export const SELECTION_TEXT_SCRIPT = 'String(getSelection())'

/** Whether the user is typing in a text field or an editable region: Edit › Undo then undoes the text, not the last archived tab. */
export const EDITING_SCRIPT = `(() => {
  const el = document.activeElement
  return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|file|image|range|color)$/i.test(el.type)))
})()`
