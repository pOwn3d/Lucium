// What the engine does with the message of the form guard (src/preload/form-guard.ts), as a pure decision: who may send it, what shape it has, and
// whether the address it names is one to ask about. The engine reads the sender from the message itself (Electron's `event.senderFrame`) and judges the
// address again, against the address the browser holds for the frame: the page's word is never taken for where its form goes.

import { parseFormAsk } from '@shared/form-guard-wire'
import { insecureTarget } from '@shared/insecure-form'

export interface FormAskSender {
  /** The frame that sent it is the main frame of the web contents. */
  mainFrame: boolean
  /** The address the browser holds for that frame (empty when it could not be read). */
  frameUrl: string
}

export type FormAskVerdict = { kind: 'ask'; host: string } | { kind: 'allow' } | { kind: 'refuse'; why: 'not-main-frame' | 'shape' }

/** `allow`: nothing to ask (an address that is no longer insecure once read against the frame). `refuse`: a message that cannot be one of the preload's. */
export function judgeFormAsk(sender: FormAskSender, raw: unknown): FormAskVerdict {
  if (!sender.mainFrame) return { kind: 'refuse', why: 'not-main-frame' }
  const ask = parseFormAsk(raw)
  if (ask === null) return { kind: 'refuse', why: 'shape' }
  const target = insecureTarget(ask.action, sender.frameUrl)
  return target === null ? { kind: 'allow' } : { kind: 'ask', host: target.host }
}
