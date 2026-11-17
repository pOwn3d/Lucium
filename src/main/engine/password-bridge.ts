// What the engine does with a message of the page bridge (src/preload/password-bridge.ts), as a pure decision: who may send it, and what shape
// it has. The engine reads the sender from the message itself (Electron's `event.senderFrame`), never from the text of the page.

import { eligibleOriginOf, parseSubmission, type Submission } from '@shared/passwords'

/** The isolated world the fill script runs in: its own, so that nothing of the page's world (or of another tool's) is shared with it. */
export const PASSWORD_WORLD = 4_200_083

export interface BridgeSender {
  /** The frame that sent it is the main frame of the web contents. */
  mainFrame: boolean
  /** The address the browser holds for that frame (empty when it could not be read). */
  frameUrl: string
  /** The page is a tab of a normal window (the shell asked to hear submissions of it). */
  isTab: boolean
}

export type SubmissionVerdict = { ok: true; frameUrl: string; submission: Submission } | { ok: false; why: 'not-main-frame' | 'not-a-tab' | 'not-eligible' | 'shape' }

export function judgeSubmission(sender: BridgeSender, raw: unknown): SubmissionVerdict {
  if (!sender.mainFrame) return { ok: false, why: 'not-main-frame' }
  if (!sender.isTab) return { ok: false, why: 'not-a-tab' }
  if (eligibleOriginOf(sender.frameUrl) === null) return { ok: false, why: 'not-eligible' }
  const submission = parseSubmission(raw)
  return submission === null ? { ok: false, why: 'shape' } : { ok: true, frameUrl: sender.frameUrl, submission }
}
