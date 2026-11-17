// Shared by the preloads that patch the main world of a page through `contextBridge` (the dialog bridge, the media bridge, `window.chrome.app` and the state of the permissions).

/**
 * Whether `contextBridge` can reach the main world of this document. Electron refuses it in a document without context isolation ("contextBridge API can only be used when
 * contextIsolation is enabled"): an offscreen document of an extension, the background page of a Manifest V2 extension, a page of the DevTools. The session registers these
 * preloads for every page, so each of them tried, failed, and said so on the console of the page: four lines per such document, which the journal of the Extensions page then
 * showed as the extension's own. None of them has anything to do there: such a page is not a tab of ours, and the bridges serve tabs (the main process answers no one else), so
 * they stay out of it, without a line, and without anything being taken from the pages that do have isolation.
 * A renderer that does not say (`undefined`: only a main process, or a test, has no such field) counts as able to, so the attempt is made as it always was.
 */
export function canReachMainWorld(): boolean {
  return process.contextIsolated !== false
}
