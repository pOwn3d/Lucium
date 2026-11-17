// The engine port (types.ts), the engine itself: the pages it makes and what they may do (permissions, popups, autoplay, hardware), joined into
// `Engine` with the other capabilities (the extensions, the network, the downloads, the storage) and the private contexts it opens. Re-exported
// by types.ts, which the rest of Lucium imports.

import type { PermissionDecision } from '@shared/model'
import type { EngineInfo } from '@shared/ipc'
import type { AutoplayMode } from '@shared/autoplay'
import type { HardwareGrantRow } from '@shared/web-hardware'
import type { Page } from './port-page'
import type { PageEvents } from './port-page-events'
import type { EngineExtensionRuntime } from './port-extensions'
import type { EngineExtensionTools } from './port-extension-tools'
import type { EngineNetwork } from './port-network'
import type { EngineDownloads } from './port-downloads'
import type { EngineStorage } from './port-storage'

/** How web permission requests (camera, location, notifications…) are answered. */
export interface PermissionPolicy {
  /** A remembered decision for this origin, or undefined when the user was never asked. */
  lookup(origin: string, permission: string): PermissionDecision | undefined
  /**
   * Asks the user. Resolves once they answered. `pageId` is the page that asked, when known: its window shows the prompt. `detail` is
   * what the prompt must add to the permission's name (the scheme of an `openExternal` request).
   */
  ask(origin: string, permission: string, pageId?: string, detail?: string): Promise<boolean>
  /**
   * Whether a window of the browser has a panel to put the question of this page in (a tab does; the page of a mini window or of a web app does not). Absent: every
   * page has one.
   */
  hasPanel?(pageId: string): boolean
  /** Whether sites may ask to share the screen at all (the setting): read at each request, so a change applies at once. */
  screenShareAllowed(): boolean
}

/** The pages the engine makes, and what they may do. */
export interface EnginePages {
  info(): EngineInfo
  /**
   * `extensionPanel` hosts an extension page (side panel): it is not a tab, so extensions must not see it in chrome.tabs. `autoplay` is the
   * mode the page is made with and keeps for its life (Electron cannot change it later); absent, the general choice of `setDefaultAutoplay`.
   */
  createPage(opts: { id: string; profileId: string; extensionPanel?: boolean; windowId?: string; autoplay?: AutoplayMode }, events: PageEvents): Page
  /**
   * The password manager's page bridge: loads the script that reports submitted sign-in forms into the main frame of the pages of every profile,
   * or takes it away (a page keeps what it has until it is loaded again). Off, nothing is registered and no message is heard. A private context
   * never has it.
   */
  setPasswordBridge(on: boolean): void
  /** The autoplay mode of what the engine makes without being asked page by page (popups); Chromium's own until the shell says otherwise. */
  setDefaultAutoplay(mode: AutoplayMode): void
  /**
   * Whether the pages get the script of the media player (the volume of a tab, the previous and next track of a site). On until the shell says
   * otherwise. Off, no session carries it: pages that load a new document afterwards have none.
   */
  setMediaBridge(on: boolean): void
  setPermissionPolicy(policy: PermissionPolicy): void
  /** Which pages may open windows without a click (the user's « Toujours autoriser sur ce site »). */
  setPopupPolicy(allowed: (url: string) => boolean): void
  /**
   * Document Picture-in-Picture (`documentPictureInPicture.requestWindow()`, the floating window of a call), which Electron does not show (feature
   * `document-pip`). On, a page a click explains gets its window: the one Chromium made, in a small window of the application above the others, which
   * keeps the page's process, session and permissions and closes with the page. Off (the default), the request is refused as it always was, without a
   * tab, and the windows that are open close. One switch for every page, private ones included: a private context leaves it to the engine it is in.
   * The lock needs nothing of its own: it destroys the pages of what it locks, and a window closes with its page.
   */
  setDocumentPictureInPicture(on: boolean): void
  /**
   * WebHID, WebUSB and Web Serial (shared/web-hardware.ts). Off: nothing is installed on any session and every request is refused. On: a menu that names
   * the site lets the user pick the device, and only what was picked is let through. A private context never takes part. Switching off takes every grant
   * back and returns how many tabs held one (a connection they already opened stays until they reload).
   */
  setWebHardware(enabled: boolean): number
  /** The devices pages were let use, for the list in Settings. */
  webHardwareGrants(): HardwareGrantRow[]
  /** Takes one grant back (`id`) or all of them; returns how many tabs may still hold a connection they opened. */
  revokeWebHardware(id?: string): number
  /**
   * The colour scheme the web pages of the application read (every window, the private ones included, and every page made from now on): `light` or `dark`, or
   * `null` for the one of the interface. The interface does not follow it (see `Page.setColorScheme`). Nothing is attached to any page while it is `null`.
   */
  setPageColorScheme(scheme: 'light' | 'dark' | null): void
  /**
   * Loads a web page in a view nobody sees, with the session of the profile (its cookies), and answers the text it shows: the whole page, or
   * the zone a CSS selector names. One at a time; never throws. A private window has no such view: it answers that it cannot.
   */
  readPageText(profileId: string, url: string, options: { selector?: string; timeoutMs?: number; settleMs: number }): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** The popup windows of pages that are open (window.open with features), by process, for the task manager: this window's own. */
  popupProcesses(): Array<{ pid: number; title: string }>
}

/** The engine: every capability of it, and the browsing contexts it opens apart from the profiles. */
export interface Engine extends EnginePages, EngineExtensionRuntime, EngineExtensionTools, EngineNetwork, EngineDownloads, EngineStorage {
  /**
   * A private browsing context for one window: its own session kept in memory only (never on disk), no extensions,
   * and hooks (permissions, downloads, request blocking) that belong to it instead of replacing the shell's.
   * Every page created through it lives in that session, whatever profile it asks for.
   */
  openEphemeral(windowId: string): EphemeralEngine
  /**
   * The browsing context of a tab container: its own session kept on disk (`persist:container-<id>`), so cookies and storage outlive the run, with
   * no extensions and hooks (permissions, downloads, request blocking) that belong to it. Every page created through it lives in that session. The
   * same context is handed back while it is open, whatever window asks.
   */
  openContainer(containerId: string, windowId: string): EphemeralEngine
}

/** The engine as one private window sees it. */
export interface EphemeralEngine extends Engine {
  /** Erases everything the context stored (cookies, storage, cache, logins) and stops serving it. Destroy its pages first. */
  dispose(): Promise<void>
}
