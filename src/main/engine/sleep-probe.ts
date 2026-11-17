// What a page is asked before it is put to sleep or frozen (`Page.probeForSleep`): whether a video of it floats in a Picture in Picture window, which
// would close with the page, and whether it holds text typed and not sent. A video floats in two ways: the Picture in Picture of a <video>
// (`document.pictureInPictureElement`) and a whole document floated by the page (`documentPictureInPicture.window`); and it may float from a frame
// (an embedded player), not only from the page itself. Kept apart from electron-page.ts so that it can be tested without Electron.

import type { PageProbe } from '@shared/sleep'

/** Whether something of this document floats in a Picture in Picture window: a video, or a document the page opened there. */
export const FLOATS = `(!!document.pictureInPictureElement || !!(self.documentPictureInPicture && self.documentPictureInPicture.window))`

/** The question to the page itself, in its sleep world (`unsentInput` reads the watcher of TRACK_INPUT, set in the same world). */
export const SLEEP_PROBE = `({ pictureInPicture: ${FLOATS}, unsentInput: typeof self.__luciumUnsent === 'function' && self.__luciumUnsent() === true })`

/** The frames of a page asked whether they float a video: at most this many, the first ones (a page with more is rare, and the question must stay short). */
export const FLOAT_FRAMES_MAX = 32

/** A frame that can be asked a question (Electron's WebFrameMain). */
export interface ProbeFrame {
  executeJavaScript(code: string): Promise<unknown>
}

/**
 * The answer of a page and of its frames together: the page's own answer, with Picture in Picture also when one of its frames floats a video. Null when
 * the page could not answer (nothing is known, so nothing is put to sleep). A frame that cannot answer (gone, crashed) counts as not floating.
 */
export async function probeWithFrames(own: Partial<PageProbe> | null, frames: readonly ProbeFrame[]): Promise<PageProbe | null> {
  if (!own || typeof own.pictureInPicture !== 'boolean' || typeof own.unsentInput !== 'boolean') return null
  if (own.pictureInPicture) return { pictureInPicture: true, unsentInput: own.unsentInput }
  const answers = await Promise.all(frames.slice(0, FLOAT_FRAMES_MAX).map((frame) => frame.executeJavaScript(FLOATS).then((floats) => floats === true, () => false)))
  return { pictureInPicture: answers.some(Boolean), unsentInput: own.unsentInput }
}
