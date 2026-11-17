// The text the interface asks the main process to read from, or put on, the clipboard: the "Copier" and "Coller" buttons of the command bar. The
// main process reads and writes it (Electron's clipboard is not reachable from a page-less surface), so the interface never receives HTML or an
// image from the clipboard, and what it asks to write is checked again there.

/**
 * The longest text that crosses in either direction: as long as an address a tab can hold (`TAB_URL_MAX`, state-clean.ts), since "Copier" on an empty
 * field puts the address of the tab on the clipboard. A clipboard holding more is not read (the reply says so) rather than cut: a cut address is
 * another address.
 */
export const CLIPBOARD_TEXT_MAX = 65_536

/** What the main process answers when the interface asks for the text on the clipboard. */
export type ClipboardTextReply = { ok: true; text: string } | { ok: false; reason: 'unreadable' | 'too-long' }

/** What may be put on the clipboard on the interface's word: a text of 1 to `CLIPBOARD_TEXT_MAX` characters (an empty one would only clear it). */
export const isClipboardWrite = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && text.length <= CLIPBOARD_TEXT_MAX

/** Whether a reply of the main process is one of the two shapes above (the answer of a channel is data, not a promise of its form). */
export function isClipboardTextReply(raw: unknown): raw is ClipboardTextReply {
  if (typeof raw !== 'object' || raw === null) return false
  const reply = raw as Record<string, unknown>
  if (reply['ok'] === true) return typeof reply['text'] === 'string'
  return reply['ok'] === false && (reply['reason'] === 'unreadable' || reply['reason'] === 'too-long')
}
