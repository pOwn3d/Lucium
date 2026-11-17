// The last real click or key of the user, anywhere in the application (the pages of extensions and the interface included): what lets an
// extension put a window in front of the user (chrome.identity, an install). Typed against the part of Electron's WebContents it uses.

import { countsAsGesture } from '@shared/web-auth'
import { holdsEmulation } from './color-scheme'
import { holdsOwnSession } from './own-session'

/** The part of a web contents whose input events are listened to. */
export interface InputSource {
  on(event: 'input-event', listener: (event: unknown, input: { type: string }) => void): unknown
  readonly debugger: { isAttached(): boolean }
}

/**
 * Calls `noted` for each click or key of the user in `wc`, never for the input a debugger sends to the page (see countsAsGesture). The session that gives the
 * page its colour scheme (engine/color-scheme.ts) and protects its frames and workers (engine/inner-guard.ts) is Lucium's own and sends no input: it is not a debugger here.
 */
export function watchUserInput(wc: InputSource, noted: () => void): void {
  wc.on('input-event', (_event, input) => {
    if (countsAsGesture(input.type, () => wc.debugger.isAttached() && !holdsEmulation(wc) && !holdsOwnSession(wc))) noted()
  })
}
