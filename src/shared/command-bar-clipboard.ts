// The clipboard and the command bar: what a paste puts in the field, and what a row gives to copy. Moved out of command-bar.ts as it was.



// ---------- "Copier" and "Coller" on the row of the genres ----------

/**
 * The longest text the bar takes from the clipboard, once it is on one line: the longest address the history keeps (`HISTORY_URL_MAX`, state-clean.ts).
 * What is in the field is looked up in the history, ranked, and sent to the search engine for suggestions; a page of text is none of these.
 */
export const BAR_PASTE_MAX = 4096

export type PasteResult = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too-long' }

/**
 * What the field holds after "Coller": the text of the clipboard on one line, as plain text. Every run of white space and of line breaks (\n, \r\n, \r,
 * U+0085, U+2028, U+2029, tabs…) becomes one space, the other control characters go, and the ends are trimmed. Nothing to put (not a text, or nothing
 * but white space) or too much of it (more than `BAR_PASTE_MAX` characters) is said as such, and the field is left as it is.
 */
export function pasteIntoBar(clipboard: unknown): PasteResult {
  if (typeof clipboard !== 'string') return { ok: false, reason: 'empty' }
  const text = clipboard
    .replace(/[\s\u0085]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    // Characters that draw nothing, or draw right to left, so that a pasted address cannot read as another one; the joiner U+200D stays (emoji).
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (text === '') return { ok: false, reason: 'empty' }
  return text.length > BAR_PASTE_MAX ? { ok: false, reason: 'too-long' } : { ok: true, text }
}

/**
 * What "Copier" puts on the clipboard: what the field holds, as it is; with nothing in it (or white space only), the address of the tab on screen
 * (`tabUrl`, already as "Copier l'URL" gives it); null when there is neither.
 */
export function textToCopy(field: string, tabUrl: string | null | undefined): string | null {
  if (field.trim() !== '') return field
  return typeof tabUrl === 'string' && tabUrl !== '' ? tabUrl : null
}
