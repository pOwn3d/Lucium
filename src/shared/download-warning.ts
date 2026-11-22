// When a download is stopped to ask « this file can run, keep it? »: a pure decision, so that it can be tested without an engine. The
// classifier is `isExecutableDownload` (open-with.ts), the one that already keeps such a file from being opened by itself.

import { isExecutableDownload } from './open-with'

export interface WarnInput {
  /** The setting « warn before saving a file that can run ». */
  enabled: boolean
  /** A download Chromium recreated after a restart: the user already saw it start, and the question is not asked twice. */
  resumed: boolean
  /** A file opened without keeping: it waits in the temporary folder and is never opened when it can run (see the engine). */
  temporary: boolean
  /** The name the file will be saved under. */
  filename: string
  mimeType?: string
}

/** Whether the user is asked before the file is saved: only a new, kept download whose type can run, and only when the setting is on. */
export function warnsBeforeSaving(input: WarnInput): boolean {
  if (!input.enabled || input.resumed || input.temporary) return false
  return isExecutableDownload(input.filename, input.mimeType)
}
