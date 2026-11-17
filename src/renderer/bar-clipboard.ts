// What the "Copier" and "Coller" buttons of the command bar do, apart from the picture: the two actions (each ends in a notice, never in silence), and the clock
// that takes the notice away. The bridge is a parameter, so that the tests stand a fake in for it (a clipboard that refuses, an answer that is not one).

import { isClipboardTextReply, type ClipboardTextReply } from '@shared/clipboard-text'
import { pasteIntoBar, textToCopy } from '@shared/command-bar'
import { t } from '@shared/i18n'

/** The part of the bridge (`window.lucium`) the two buttons use. */
export interface BarClipboardBridge {
  readClipboardText(): Promise<ClipboardTextReply>
  writeClipboardText(text: string): Promise<boolean>
}

/** What the bar says for a moment. `told` is a sentence that something was done elsewhere than with the two buttons (a page forgotten from the history): said to a screen reader, as a confirmation is. After a button was used: the copy went through (the button reads "Copié"), the paste did, or why nothing was done (the field stays as it was). */
export type BarClipNotice = { kind: 'copied' } | { kind: 'pasted' } | { kind: 'problem'; message: string } | { kind: 'told'; message: string }

/** How long a notice stays: a word on a button is short, a sentence that says what went wrong is read. */
export const BAR_NOTICE_MS = { copied: 1500, pasted: 1500, told: 1500, problem: 4000 } as const

const problem = (message: string): BarClipNotice => ({ kind: 'problem', message })

/** "Copier": the field's text, or the address of the tab when the field is empty. `tabUrl` is the address as "Copier l'URL" gives it. */
export async function copyFromBar(bridge: BarClipboardBridge, field: string, tabUrl: string | null): Promise<BarClipNotice> {
  const text = textToCopy(field, tabUrl)
  if (text === null) return problem(t('cmd.rien-a-copier'))
  try {
    if (await bridge.writeClipboardText(text)) return { kind: 'copied' }
  } catch (error) {
    console.error('[command bar] the copy failed:', error instanceof Error ? error.name : typeof error)
  }
  return problem(t('cmd.copie-impossible'))
}

/** What "Coller" gives: the text that replaces the field's, or the notice that says why the field stays as it is. */
export type BarPaste = { text: string } | { notice: BarClipNotice }

/** "Coller": the clipboard's text as one line (see `pasteIntoBar`), or the reason it cannot be put in the field. */
export async function pasteToBar(bridge: BarClipboardBridge): Promise<BarPaste> {
  const unreadable: BarPaste = { notice: problem(t('cmd.lecture-du-presse-papiers-impossible')) }
  const tooLong: BarPaste = { notice: problem(t('cmd.texte-trop-long-a-coller')) }
  let reply: unknown
  try {
    reply = await bridge.readClipboardText()
  } catch (error) {
    console.error('[command bar] the paste failed:', error instanceof Error ? error.name : typeof error)
    return unreadable
  }
  // The answer of a channel is data: one that is not of the shape promised is a clipboard that could not be read.
  if (!isClipboardTextReply(reply)) return unreadable
  if (!reply.ok) return reply.reason === 'too-long' ? tooLong : unreadable
  const pasted = pasteIntoBar(reply.text)
  if (pasted.ok) return { text: pasted.text }
  return pasted.reason === 'too-long' ? tooLong : { notice: problem(t('cmd.aucun-texte-a-coller')) }
}

/** What the bar does with the field when "Coller" answers (`applyPaste`). */
export interface BarPasteField {
  say(notice: BarClipNotice): void
  setTyping(typing: boolean): void
  setQuery(text: string): void
  setSelected(index: number): void
  /** Puts the caret at the end of the field, once the pasted text is in it. */
  caretToEnd(): void
}

/**
 * The answer of "Coller" applied to the bar: a notice is only said and the field is left as it is; a text replaces the whole query, is not completed (a
 * browser's field does not complete a paste), the list starts again at its first line, and the caret goes to the end of the field.
 */
export function applyPaste(pasted: BarPaste, field: BarPasteField): void {
  if ('notice' in pasted) return field.say(pasted.notice)
  field.setTyping(false)
  field.setQuery(pasted.text)
  field.setSelected(0)
  field.say({ kind: 'pasted' })
  field.caretToEnd()
}

/** The notice on screen and the clock that takes it away: a new notice starts a new clock, and `stop` (when the bar goes) leaves none running. */
export function noticeClock(show: (notice: BarClipNotice | null) => void, schedule: typeof setTimeout = setTimeout, cancel: typeof clearTimeout = clearTimeout) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    say(notice: BarClipNotice): void {
      cancel(timer)
      show(notice)
      timer = schedule(() => show(null), BAR_NOTICE_MS[notice.kind])
    },
    stop(): void {
      cancel(timer)
      timer = undefined
    }
  }
}
