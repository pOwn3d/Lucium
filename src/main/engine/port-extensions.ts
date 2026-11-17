// The engine port (types.ts), the runtime of the extensions: the chrome.* APIs the engine does not implement (shims), their events, the tabs and
// windows they see, their workers. Installing, listing and updating them is port-extension-tools.ts. Re-exported by types.ts, which the rest of
// Lucium imports.

import type { TabCaptureEvent } from './tab-capture'

export type { TabCaptureEvent }

/** Callbacks the extension runtime uses to drive tabs and windows (chrome.tabs.create/update/remove, chrome.windows.create/remove). */
export interface ExtensionTabHooks {
  /**
   * `windowId` is the window the extension asked for (the id it knows: Electron's), when it asked for one. `profileId` is the profile of
   * the extension that asks: the tab opens in a space of that profile, never in another one.
   */
  createTab(url: string | undefined, active: boolean, windowId?: number, profileId?: string): Promise<string>
  selectTab(pageId: string): void
  removeTab(pageId: string): void
  /**
   * chrome.windows.create: opens a window showing `url` (a blank page when there is none) and resolves with its window id (Electron's).
   * A `popup` is a small window of a single page.
   */
  createWindow(details: { url?: string; type: 'normal' | 'popup'; focused: boolean; width?: number; height?: number; left?: number; top?: number; profileId?: string }): Promise<number>
  /** chrome.windows.remove. */
  removeWindow(windowId: number): void
  /** The number of the tab on screen in this window (Electron's id), when it is a tab of this profile with a live page: what a click on an extension's icon in that window means. */
  activeTabOf?(windowId: number, profileId: string): number | undefined
  /**
   * Whether this window (Electron's id) is one of the windows of the application that show tabs. The extension runtime follows the focus of those only: the popup of an icon,
   * Settings or a mini window taking the focus does not make it "the window the user is in".
   */
  hasWindow?(windowId: number): boolean
  /**
   * chrome.tabs.create / update of an extension with an address of the browser's own pages (`chrome://extensions`, `chrome://settings`…): opens the
   * page of Lucium that stands for it and returns true, or returns false for an address that is none of them (shared/chrome-pages.ts).
   */
  openChromePage?(address: string): boolean
  /** Whether the tab (Electron's id) is one the lock hides: its space is locked, or the application is. An extension may not capture the sound of it. */
  tabLocked?(tabNumber: number): boolean
}

/**
 * A call from an extension to a chrome.* API that Electron lacks (sidePanel, tabGroups, debugger, identity, downloads, native messaging).
 * `profileId` is the profile the calling extension context runs in: an extension never reaches the tabs of another profile.
 */
export interface ShimCall {
  extensionId: string
  profileId: string
  api: string
  method: string
  args: unknown[]
  /** Which page or worker of the extension made the call, as `Engine.onContextGone` names it: what it opened ends with it. */
  context: string
}

/** What extensions see of a tab beyond what the engine knows: its group and whether it is pinned. */
export interface TabFacts {
  groupId: number
  pinned: boolean
}

/** chrome.identity.launchWebAuthFlow. */
export interface WebAuthRequest {
  /** The authorization page (http or https). */
  url: string
  extensionId: string
  /** Show a window the user can act in; otherwise the flow only succeeds if the server redirects at once. */
  interactive: boolean
  /** Without interaction: give up on a page that does not redirect after this long. */
  timeoutMs: number
  /** Without interaction: fail as soon as the page has loaded without redirecting (the API's default). */
  abortOnLoad: boolean
}
export type ShimHandler = (call: ShimCall) => Promise<unknown>

/** What the engine does for the extensions while they run: their shims and events, the tabs and windows they act on, their workers. */
export interface EngineExtensionRuntime {
  /** Receives calls to the chrome.* APIs the engine does not implement. */
  setShimHandler(handler: ShimHandler): void
  /** Delivers an event of a shimmed chrome.* API to an extension (its service worker and the pages it hosts), in one profile when given. */
  emitShimEvent(extensionId: string, api: string, event: string, args: unknown[], profileId?: string): void
  /**
   * Delivers a standard extension event (chrome.commands.onCommand…) to the listeners an extension registered, waking its worker.
   * Used for events the extension library never sends.
   */
  sendExtensionEvent(extensionId: string, profileId: string, name: string, args: unknown[]): void
  /** Whether an extension may act on a tab of its profile (paste into it): it holds a host permission that covers the tab's address. */
  mayActOnTab(extensionId: string, tabNumber: number): boolean
  /** Puts text and/or HTML on the clipboard of the system (an extension's `document.execCommand('copy')`). Resolves once it is there. */
  writeClipboard(items: { text: string; html: string }): Promise<void>
  /** Resolves once the writes to the clipboard asked for so far are done: a paste must not read what a copy just before it has not finished putting there. */
  clipboardSettled(): Promise<void>
  /** `chrome.contextMenus.update`: changes an item the extension made in a profile (the library only creates and removes). Throws when it has no such item. */
  updateContextMenuItem(extensionId: string, profileId: string, menuItemId: unknown, properties: unknown): void
  /**
   * Starts the extension's service worker if it is not running and hands it an extension event, to the worker alone: pages get the real
   * one. Used for the events Electron never delivers to workers (see `relayNativeEvent`) and for the lifecycle of the extension.
   */
  deliverToWorker(extensionId: string, profileId: string, api: string, event: string, args: unknown[]): Promise<void>
  /**
   * Makes a native event reach the extension's worker (`storage.onChanged`, `alarms.onAlarm`): a hidden page of the extension listens
   * to it, which Electron does deliver, and reports it through `deliverToWorker`. Idempotent.
   */
  relayNativeEvent(extensionId: string, profileId: string, name: string): void
  /** Tells extensions what the engine cannot know about a tab (see `TabFacts`). */
  setTabFactsProvider(provider: ((tabNumber: number) => TabFacts) | null): void
  /** A fact about a tab changed (its group): extensions get chrome.tabs.onUpdated with the new value. */
  notifyTabChanged(tabNumber: number): void
  /** Called when the page of a tab is destroyed. */
  onTabClosed(listener: (tabNumber: number) => void): void
  /** The profile and the window (the id extensions see) of a tab; undefined for a number that is not a live tab. */
  profileOfTab(tabNumber: number): string | undefined
  windowOfTab(tabNumber: number): number | undefined
  /**
   * Called when a page or a worker of an extension is gone (closed, reloaded, stopped), with the `context` its calls carried; or, with
   * only an extension id, when the extension itself was unloaded.
   */
  onContextGone(listener: (gone: { context?: string; extensionId?: string; profileId?: string }) => void): void
  /**
   * Whether the extension may capture this tab (chrome.tabs.captureVisibleTab): it has a host permission for the page, or it declared
   * "activeTab" and the user handed it this tab (a click on its icon, its keyboard shortcut) and it has not left that origin since.
   */
  mayCaptureTab(extensionId: string, tabNumber: number): boolean
  /** Whether the extension may be told the address and the title of this tab ("tabs", a host permission for it, or a hand-over): what `chrome.tabs` shows of it. */
  mayReadTab(extensionId: string, tabNumber: number): boolean
  /** The address of a tab by its number. */
  tabUrl(tabNumber: number): string | undefined
  /** Keeps the service worker of an extension from being stopped for being idle, until the returned function is called. */
  holdWorker(extensionId: string, profileId: string): () => void
  /**
   * chrome.identity.launchWebAuthFlow in a window of the profile's session (the user's logins there carry over). Resolves with the
   * redirect URL on `https://<extension id>.chromiumapp.org/`; rejects with the API's error texts.
   */
  webAuthFlow(profileId: string, request: WebAuthRequest): Promise<string>
  /** chrome.downloads.download: starts a download in the profile and resolves with its id once it exists. `filename` is relative to the downloads folder. */
  startDownload(profileId: string, url: string, options: { filename?: string; extensionId: string }): Promise<string>
  /** Called when a capture of the sound of a tab begins or ends, and when an extension that is not allowed to capture asks to (shared/tab-capture.ts). */
  onTabCapture(listener: (event: TabCaptureEvent) => void): void
  /** An extension is gone from a profile (uninstalled, its folder forgotten) or no longer the one the person chose (its folder asks for other permissions, or has another identifier). */
  onExtensionForgotten(listener: (profileId: string, extensionId: string) => void): void
  /** What lets an extension capture the sound of a tab changed outside the engine's own settings (a lock): the captures that are no longer allowed end, and the sound comes back. */
  reconsiderTabCaptures(): void
  /** The person stops the capture of a tab's sound: the extension is asked to end its stream, the sound comes back, and the tab has to be handed over to it again. True when one ran. */
  stopTabCapture(tabNumber: number): boolean
  /** The numeric tab id extensions use for a page, and the reverse. */
  tabNumberOf(pageId: string): number | undefined
  pageIdOfTabNumber(tabNumber: number): string | undefined
  /** Marks a page as the focused tab for the extension runtime (chrome.tabs.onActivated). */
  activatePage(pageId: string): void
  /** Starts the background worker of an extension in every profile that has it, before its toolbar button is clicked: an idle worker drops the click. */
  wakeExtension?(extensionId: string): Promise<void>
  setExtensionTabHooks(hooks: ExtensionTabHooks): void
}
