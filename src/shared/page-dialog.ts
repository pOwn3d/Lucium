// The dialogs a web page asks for with `window.alert()`, `window.confirm()` and `window.prompt()`. Electron answers `prompt()` with null without
// showing anything, and shows `alert()` and `confirm()` as a native sheet that does not say which site asks and that a tab behind the one on screen
// can put over it. So the main frame of each tab gets replacements (src/preload/dialog-bridge.ts) that ask the main process, which puts a panel of
// ours on the window and answers once the user has. Pure rules here: what a page may send, what the panel shows, what the page's call returns, and
// when a page that keeps asking is stopped. Nothing here touches Electron; the engine (engine/electron-engine-preloads.ts) and the shell
// (shell/browser-dialogs.ts) carry the messages.

import { t } from './i18n'

/** The three functions of a page that open a box. */
export type PageDialogKind = 'alert' | 'confirm' | 'prompt'
export const PAGE_DIALOG_KINDS: readonly PageDialogKind[] = Object.freeze(['alert', 'confirm', 'prompt'])
export const isPageDialogKind = (value: unknown): value is PageDialogKind => value === 'alert' || value === 'confirm' || value === 'prompt'

/** The channel of each function, from the main frame of a page. A synchronous message: the page waits, as it does for the box of any browser. */
export const PAGE_DIALOG = { alert: 'lucium-page-alert', confirm: 'lucium-page-confirm', prompt: 'lucium-page-prompt' } as const satisfies Record<PageDialogKind, string>

/** The message of a box is text of the page: only this much is shown (then an ellipsis). */
export const PROMPT_MESSAGE_MAX = 1000
/** The value in the field, and what is typed there, never goes beyond this (the field has the same limit). */
export const PROMPT_VALUE_MAX = 4000
/** The most a string may weigh on the way from a page: a longer one was not made by the bridge, which cuts what the page gives it. */
export const PROMPT_WIRE_MAX = 65_536

/** A page that opens the next box within this long of closing the previous one is hurrying (the user did not have time to read). */
export const DIALOG_HURRY_MS = 5000
/** From the third box of a hurried series, the user is offered to stop the page. */
export const DIALOG_OFFER_AFTER = 2

/**
 * The reply to a page whose boxes the user stopped: the call returns at once (nothing, false or null), and its bridge stops asking for the rest of
 * the document (a page that calls `alert()` in a loop then costs the main process nothing). An object, so that no answer the user types can be taken for it.
 */
export interface PromptStopped {
  stopped: true
}
export const PROMPT_STOPPED: PromptStopped = Object.freeze({ stopped: true })

export const isPromptStopped = (reply: unknown): reply is PromptStopped =>
  typeof reply === 'object' && reply !== null && !Array.isArray(reply) && (reply as { stopped?: unknown }).stopped === true

/**
 * The reply that sends a call of `alert()` or `confirm()` back to the page's own function, Electron's native sheet: what the page had before the
 * bridge, for a page that has no box of ours (a popup, a preview, a page that is not of the web). Never for `prompt()`, which Electron shows nothing for.
 */
export interface DialogNative {
  native: true
}
export const DIALOG_NATIVE: DialogNative = Object.freeze({ native: true })

export const isDialogNative = (reply: unknown): reply is DialogNative =>
  typeof reply === 'object' && reply !== null && !Array.isArray(reply) && (reply as { native?: unknown }).native === true

/**
 * What the main process sends back on a channel: the text typed or null for `prompt()`, true (OK) or false for `confirm()`, null for `alert()`;
 * or `PROMPT_STOPPED`, or `DIALOG_NATIVE`.
 */
export type DialogReply = string | boolean | null | PromptStopped | DialogNative

/** What the bridge of a page sends: the strings of the call, already converted to text (`defaultValue` is only sent by `prompt()`). */
export interface PromptPayload {
  message: string
  defaultValue: string
}

/** What the panel shows. `host` is the page's own address as the main process knows it, never text the page sent. */
export interface PromptRequest {
  /** The function that asks: a field for `prompt()` only, and « Annuler » for `confirm()` and `prompt()`. */
  kind: PageDialogKind
  host: string
  message: string
  /** The value in the field of `prompt()`; empty for the two others, which have no field. */
  defaultValue: string
  /** The box for "stop this page from opening other boxes" is shown. */
  offerSuppress: boolean
}

/** The panel's request, with the id that ties its answer to the question. */
export interface DialogRequest extends PromptRequest {
  id: string
}

/**
 * What the panel answers. `value` is null when the user cancelled, and a string for OK (the text typed for `prompt()`, empty for the two others);
 * `suppress` is the state of the box.
 */
export interface PromptAnswer {
  value: string | null
  suppress: boolean
}

export const PROMPT_CANCELLED: PromptAnswer = Object.freeze({ value: null, suppress: false })

/** The sentence of the box that stops a page from opening more boxes: the panel of a page's box shows it, and Electron's own sheet does. */
export const safeDialogsMessage = (): string => t('page-dialog.empecher-cette-page-de-creer-d-autres-boites')

/**
 * Given to every web page we make, tab or popup. Electron shows `alert()` and `confirm()` as a native sheet on the window wherever our panel does
 * not take them (the frames of a page, a popup, a preview: see `withoutBoxReplyOf`); with this, a page that opens them in a row is offered a way to
 * be stopped, as in any browser. Built when the page is: the sentence is in the language of the interface at that moment.
 */
export const pageDialogPreferences = (): { safeDialogs: true; safeDialogsMessage: string } => ({ safeDialogs: true, safeDialogsMessage: safeDialogsMessage() })

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  // Never leave half of a surrogate pair at the end.
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** What the bridge sends for a call of the page: both strings bounded, so that a page cannot make a message of any size. */
export function promptPayloadOf(message: string, defaultValue: string): PromptPayload {
  return { message: clip(message, PROMPT_WIRE_MAX), defaultValue: clip(defaultValue, PROMPT_WIRE_MAX) }
}

/** Reads what a page sent: exactly the two strings, none longer than the bridge would send. Anything else is not from the bridge (null). */
export function parsePromptPayload(raw: unknown): PromptPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 2 || !keys.includes('message') || !keys.includes('defaultValue')) return null
  const { message, defaultValue } = raw as Record<string, unknown>
  if (typeof message !== 'string' || typeof defaultValue !== 'string') return null
  if (message.length > PROMPT_WIRE_MAX || defaultValue.length > PROMPT_WIRE_MAX) return null
  return { message, defaultValue }
}

/** What the bridge sends for a call of the page: the message, bounded, and for `prompt()` the default value too. */
export function dialogPayloadOf(kind: PageDialogKind, message: string, defaultValue: string): PromptPayload | { message: string } {
  return kind === 'prompt' ? promptPayloadOf(message, defaultValue) : { message: clip(message, PROMPT_WIRE_MAX) }
}

/** Reads what a page sent on the channel of `kind`: for `alert()` and `confirm()` exactly the message, for `prompt()` the two strings. Anything else is null. */
export function parseDialogPayload(kind: PageDialogKind, raw: unknown): PromptPayload | null {
  if (kind === 'prompt') return parsePromptPayload(raw)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'message') return null
  const { message } = raw as Record<string, unknown>
  if (typeof message !== 'string' || message.length > PROMPT_WIRE_MAX) return null
  return { message, defaultValue: '' }
}

/**
 * The functions the bridge replaces in a document, read before any script of the page runs. A document of the web whose origin is opaque is
 * sandboxed (a page its server serves with `Content-Security-Policy: sandbox`, the popup of a sandboxed frame): Chromium itself decides whether its
 * `alert()` and `confirm()` may show anything (only with `allow-modals`), so they keep the page's own function. `prompt()` shows nothing in Electron:
 * the panel of the bridge is the only box it can have. A local file has an opaque origin too, and is not sandboxed for that.
 */
export function bridgedDialogsOf(origin: string, protocol: string): readonly PageDialogKind[] {
  const sandboxed = origin === 'null' && (protocol === 'http:' || protocol === 'https:')
  return sandboxed ? ['prompt'] : PAGE_DIALOG_KINDS
}

/** What the page's call returns for a reply of the main process: nothing for `alert()`, true for `confirm()` only on OK, the text or null for `prompt()`. */
export function pageResultOf(kind: PageDialogKind, reply: unknown): string | boolean | null | undefined {
  if (kind === 'alert') return undefined
  if (kind === 'confirm') return reply === true
  return typeof reply === 'string' ? reply : null
}

/** The reply for the user's answer (`value` null for a cancel, a string for OK). */
export function answerReplyOf(kind: PageDialogKind, value: string | null): DialogReply {
  if (kind === 'prompt') return value
  if (kind === 'confirm') return value !== null
  return null
}

/** The reply to a call that has no panel of ours to go to (not a tab, a page that is going): the page's own function answers, as before the bridge. */
export const withoutBoxReplyOf = (kind: PageDialogKind): DialogReply => (kind === 'prompt' ? null : DIALOG_NATIVE)

/**
 * The reply to a call that is not put before the user. A page the user stopped is told so (its bridge then answers by itself); a page that is not
 * of the web keeps its own function; a message that is not what the bridge sends gets the answer of a cancel.
 */
export function refusalReplyOf(kind: PageDialogKind, why: 'payload' | 'origin' | 'suppressed'): DialogReply {
  if (why === 'suppressed') return PROMPT_STOPPED
  if (why === 'origin') return withoutBoxReplyOf(kind)
  return answerReplyOf(kind, null)
}

// Controls other than the line break and the tab, and the characters that reverse or isolate the direction of the text after them: a page
// must not make its message read as something else (text that runs backwards, or looks like it ends before it does).
const UNSHOWN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The message as the panel shows it: plain text, line breaks kept, nothing that hides or reverses text, and cut at `PROMPT_MESSAGE_MAX`. */
export function promptMessageOf(message: string): string {
  const text = message.replace(/\r\n?|\u2028|\u2029/g, '\n').replace(UNSHOWN, '')
  return text.length > PROMPT_MESSAGE_MAX ? `${clip(text, PROMPT_MESSAGE_MAX).trimEnd()}…` : text
}

/**
 * Who is asking, in full: the host of the page's own address (and the port when it is not the usual one), or null when the page is not
 * one that may open a box. A local file has no host: it is named as what it is. The name never comes from the page's text.
 */
export function promptHostOf(frameUrl: string): string | null {
  if (!URL.canParse(frameUrl)) return null
  const url = new URL(frameUrl)
  if (url.protocol === 'file:') return t('page-dialog.ce-fichier-local')
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '') return url.host
  return null
}

/** The line above the message: « <hôte> demande : » for `prompt()`, « <hôte> indique : » for the two others. The host is on its own, so that a long one wraps instead of being cut. */
export function promptTitle(host: string, kind: PageDialogKind = 'prompt'): string {
  return kind === 'prompt' ? t('page-dialog.host-demande', { host }) : t('page-dialog.host-indique', { host })
}

/**
 * The boxes of one document. A user who is being pestered gets a box to tick; once it is ticked, the page's next boxes are not shown.
 * The state is the document's: a new document starts again (`reset`).
 */
export class DialogGuard {
  private suppressed = false
  private closedAt: number | null = null
  private hurried = 0

  /** Whether the next box may be shown now, and whether it carries the box that stops the page. */
  admit(now: number): { show: false } | { show: true; offerSuppress: boolean } {
    if (this.suppressed) return { show: false }
    this.hurried = this.closedAt !== null && now >= this.closedAt && now - this.closedAt <= DIALOG_HURRY_MS ? this.hurried + 1 : 0
    return { show: true, offerSuppress: this.hurried >= DIALOG_OFFER_AFTER }
  }

  /** A box was closed (answered, or taken away). */
  closed(now: number): void {
    this.closedAt = now
  }

  /** The user ticked "stop this page": its next boxes are refused without a word. */
  suppress(): void {
    this.suppressed = true
  }

  isSuppressed(): boolean {
    return this.suppressed
  }

  /** A new document. */
  reset(): void {
    this.suppressed = false
    this.closedAt = null
    this.hurried = 0
  }
}

export type PromptVerdict =
  | { kind: 'ask'; request: PromptRequest }
  /** Nothing is shown (`refusalReplyOf` says what the page gets): `payload` and `origin` are refusals (logged), `suppressed` is what the user asked for. */
  | { kind: 'refuse'; why: 'payload' | 'origin' | 'suppressed' }

/**
 * What to do with a call of `kind` that reached the main process. `frameUrl` is the address the browser itself holds for the frame that sent
 * it. The page's text is only ever the message and the default value: the host, and whether a box to stop the page is shown, are ours. The three
 * functions share the guard of the document: a page the user stopped opens none of them any more.
 */
export function judgeDialog(kind: PageDialogKind, raw: unknown, frameUrl: string, guard: DialogGuard, now: number): PromptVerdict {
  const payload = parseDialogPayload(kind, raw)
  if (!payload) return { kind: 'refuse', why: 'payload' }
  const host = promptHostOf(frameUrl)
  if (host === null) return { kind: 'refuse', why: 'origin' }
  const admission = guard.admit(now)
  if (!admission.show) return { kind: 'refuse', why: 'suppressed' }
  return {
    kind: 'ask',
    request: { kind, host, message: promptMessageOf(payload.message), defaultValue: clip(payload.defaultValue, PROMPT_VALUE_MAX), offerSuppress: admission.offerSuppress }
  }
}

/** The answer of the panel: a string (at most what the field takes) or null, and the state of the box. Anything else is read as "cancel". */
export function parsePromptAnswer(raw: unknown): PromptAnswer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { value, suppress } = raw as Record<string, unknown>
  if (typeof suppress !== 'boolean') return null
  if (value !== null && (typeof value !== 'string' || value.length > PROMPT_VALUE_MAX)) return null
  return { value, suppress }
}

/**
 * A reply that is sent once and never throws: the page may be gone by the time the user answers (the message then has nowhere to go),
 * and a second reply to the same message must not reach a page that moved on. Returns whether this call was the one that sent.
 */
export function replyOnce<T>(send: (value: T) => void, onError: (error: unknown) => void): (value: T) => boolean {
  let sent = false
  return (value) => {
    if (sent) return false
    sent = true
    try {
      send(value)
    } catch (error) {
      onError(error)
    }
    return true
  }
}
