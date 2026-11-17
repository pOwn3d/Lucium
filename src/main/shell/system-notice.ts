// System notices (the notification centre) for what the user started and did not watch: a shortcut, a menu entry, a panel that
// closed at once. The sink can be replaced, so a test records the notices instead of showing them on the machine it runs on.

import { Notification } from 'electron'
import { assertTestRun } from '../test-seam'

export interface SystemNotice {
  title: string
  body: string
}

/** Hands a notice to the system; false when it could not (the caller then says it another way). */
export type NoticeSink = (notice: SystemNotice) => boolean

const systemSink: NoticeSink = (notice) => {
  if (!Notification.isSupported()) return false
  // Silent, like the notices of the extension this comes from: the information is the text, not the sound.
  new Notification({ title: notice.title, body: notice.body, silent: true }).show()
  return true
}

let sink: NoticeSink = systemSink

/** Sends notices to `next` instead of the system. Returns the call that puts the previous destination back. */
export function setNoticeSink(next: NoticeSink): () => void {
  assertTestRun('setNoticeSink')
  const previous = sink
  sink = next
  return () => {
    sink = previous
  }
}

/** True when the notice reached the system. A sink that throws counts as a refusal and is logged. */
export function showSystemNotice(notice: SystemNotice): boolean {
  try {
    return sink(notice)
  } catch (error) {
    console.error('[notice] cannot show a system notice:', error)
    return false
  }
}
