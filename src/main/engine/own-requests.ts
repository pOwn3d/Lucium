// Puts the header of Global Privacy Control on the requests the application makes for itself (shared/own-requests.ts), in the sessions it
// makes them with: its own session (the feed of the versions, the filter lists, the translation catalogue, the Chrome Web Store, the search
// suggestions) and the sessions the shell keeps for its lookups (the icon of a site, a live folder). The sessions of the pages have their own
// hook, which signs whatever leaves them, the application's requests included (electron-engine-network.ts, `installPrivacyHeaders`).
//
// A session has one `onBeforeSendHeaders` listener. A session that needs another rule on some of its requests whatever the option says (the
// pictures of the interface) gives it here as its `base`, and the two share the listener. With the option off a session without a base has
// no listener at all: nothing is paid for a header that is not sent.

import { ownRequestHeaders } from '@shared/own-requests'

type Callback = (answer: { requestHeaders: Record<string, string> }) => void
type Listener = (details: { requestHeaders: Record<string, string>; resourceType?: string }, callback: Callback) => void

/** The part of an Electron `Session` the header needs. */
export interface SignedSession {
  webRequest: { onBeforeSendHeaders(filter: { urls: string[]; types?: string[] }, listener: Listener): void; onBeforeSendHeaders(listener: null): void }
}

/** A rule a session applies to some kinds of its requests whatever the option says. */
export interface BaseRule {
  /** The resource types it covers (`image`). */
  types: readonly string[]
  headers(headers: Record<string, string>): Record<string, string>
}

const WEB = ['http://*/*', 'https://*/*']

export class OwnRequestSigning {
  private readonly sessions = new Map<SignedSession, BaseRule | null>()
  private on = false

  /** A session the application asks the network with: it carries the header from now on, while the option is on. */
  add(ses: SignedSession, base: BaseRule | null = null): void {
    this.sessions.set(ses, base)
    this.sync(ses, base)
  }

  /** The session is no longer the application's to sign (its service stopped): its listener goes. */
  remove(ses: SignedSession): void {
    if (!this.sessions.delete(ses)) return
    ses.webRequest.onBeforeSendHeaders(null)
  }

  /** The option changed: every session is given its listener again, or loses it. */
  set(globalPrivacyControl: boolean): void {
    if (this.on === globalPrivacyControl) return
    this.on = globalPrivacyControl
    for (const [ses, base] of this.sessions) this.sync(ses, base)
  }

  private sync(ses: SignedSession, base: BaseRule | null): void {
    const based = (details: Parameters<Listener>[0]): Record<string, string> => (base && details.resourceType !== undefined && base.types.includes(details.resourceType) ? base.headers(details.requestHeaders) : details.requestHeaders)
    if (this.on) {
      // The base rule first, the signal last: the rule cannot take it away.
      ses.webRequest.onBeforeSendHeaders({ urls: WEB }, (details, callback) => callback({ requestHeaders: ownRequestHeaders(based(details), true) }))
    } else if (base) {
      ses.webRequest.onBeforeSendHeaders({ urls: WEB, types: [...base.types] }, (details, callback) => callback({ requestHeaders: based(details) }))
    } else {
      ses.webRequest.onBeforeSendHeaders(null)
    }
  }
}
