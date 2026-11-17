// Letting go of the hooks a session was given. The session of a private window stays alive after the window is gone (Electron keeps a
// session by its partition name for the rest of the run), and every hook below is a closure over the private window's browser: left
// in place, they keep that browser, its pages' state and its tabs in memory for as long as the application runs.

/** The part of an Electron `Session` that holds the hooks the engine installs. */
export interface HookedSession {
  webRequest: {
    onBeforeRequest(listener: typeof refuseLocalFiles): void
    onBeforeSendHeaders(listener: null): void
    onHeadersReceived(listener: null): void
  }
  removeAllListeners(event: 'will-download'): unknown
  setPermissionRequestHandler(handler: typeof refuseRequest): void
  setPermissionCheckHandler(handler: typeof refuseCheck): void
  setDisplayMediaRequestHandler(handler: null): void
}

// What takes the place of the hooks that decide something. A session without a permission handler grants what a page asks for (Electron's
// default), and one without a request filter lets a local page read any file: the pages of a window that closes are still closing, one by one,
// when its hooks are released. So these three are replaced, not removed, by functions of this module that hold on to nothing and refuse.

/** No permission is granted on a session whose window is gone. */
export const refuseRequest = (_contents: unknown, _permission: string, callback: (granted: boolean) => void): void => callback(false)

/** No permission is said to be held on a session whose window is gone. */
export const refuseCheck = (): boolean => false

/** No local file is read on a session whose window is gone; what goes to the network is left to end by itself. */
export const refuseLocalFiles = (details: { url: string }, callback: (response: { cancel: boolean }) => void): void => callback({ cancel: /^file:/i.test(details.url) })

/**
 * Removes the response filters, the download listener and the screen-sharing handler of a session, and puts refusals in the place of its
 * request filter and of its permission handlers.
 */
export function releaseSessionHooks(ses: HookedSession): void {
  ses.webRequest.onBeforeRequest(refuseLocalFiles)
  ses.webRequest.onBeforeSendHeaders(null)
  ses.webRequest.onHeadersReceived(null)
  ses.removeAllListeners('will-download')
  ses.setPermissionRequestHandler(refuseRequest)
  ses.setPermissionCheckHandler(refuseCheck)
  ses.setDisplayMediaRequestHandler(null)
}
