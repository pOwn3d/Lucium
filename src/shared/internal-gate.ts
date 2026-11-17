// Who may speak for the Extensions page. The page is a tab: a web page can be shown in the same tab, a frame of the page can send a message, and the tab can be
// sent elsewhere, so what the preload gives (preload/internal-extensions.ts) is not what the main process trusts. For every message it asks the question here
// (the Web Store does the same for its own channels: engine/web-store.ts, `refusal`), and the answer is no unless every fact says yes. Pure: the facts come from
// Electron's frame and from the state of the window (main/shell/internal-page-ipc.ts).

import { isInternalOrigin, isInternalPageUrl } from './internal-page'
import { logOrigin } from './url'

/** What the main process knows of the sender of a message, read when it arrives. */
export interface InternalSenderFacts {
  /** `senderFrame.origin`: what Chromium says the document is, not what the page says. Undefined when there is no sender frame. */
  frameOrigin: unknown
  /** `senderFrame.url`: the address of the document of the frame. */
  frameUrl: unknown
  /** The frame is the top frame of its page (no parent, and the main frame of the web contents). */
  topFrame: boolean
  /** The tab of this web contents in the state of a window of the application, or null when it is none (a panel, a popup, a page of another window or of a private window). */
  tab: { url: string; private: boolean; container: boolean } | null
  /** The window the tab is in is a private or guest window. */
  privateWindow: boolean
  /** The web contents is in the session of a profile, not in a private context or a container. */
  profileSession: boolean
  /** The application is locked. */
  appLocked: boolean
}

/** Why a message is refused, or null when it may go on. The first fact that is not the page's gives the reason (it goes in the log with the channel, never to the page; an origin is said by its scheme and host alone). */
export function internalSenderRefusal(facts: InternalSenderFacts): string | null {
  if (facts.frameOrigin === undefined || facts.frameOrigin === null) return 'no sender frame'
  if (!isInternalOrigin(facts.frameOrigin)) return `origin ${logOrigin(String(facts.frameOrigin))} is not the Extensions page`
  if (!facts.topFrame) return 'not the top frame of the page'
  if (!isInternalPageUrl(facts.frameUrl)) return 'the document is not an address of the Extensions page'
  if (facts.tab === null) return 'not a tab of a window'
  // The tab the state holds is where the shell sent it: a tab that was sent elsewhere is no longer the page's, whatever its frame says.
  if (!isInternalPageUrl(facts.tab.url)) return 'the tab is no longer on the Extensions page'
  if (facts.tab.private || facts.tab.container) return 'a private tab or a tab in a container'
  if (facts.privateWindow) return 'a private or guest window has no extensions'
  if (!facts.profileSession) return 'not in the session of a profile'
  if (facts.appLocked) return 'the application is locked'
  return null
}
