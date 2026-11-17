// The engine port (types.ts), the extensions as the user manages them: loading, listing, switching off, installing and updating from the Web
// Store, the menu of their toolbar icon, the developer's tools of the Extensions page and the diagnostics. Their runtime is port-extensions.ts.
// Re-exported by types.ts, which the rest of Lucium imports.

import type { ExtensionInfo } from '@shared/ipc'
import type { ExtensionDetail } from '@shared/extension-page'
import type { JournalEntry, JournalFilter } from '@shared/extension-journal'
import type { WebStoreUpdates } from '@shared/model'
import type { ExtensionReview } from '@shared/extension-review'
import type { UpdateReport } from '@shared/web-store'

/** What the extension runtime needs from the settings: the Web Store switches, and the extensions switched off in each profile. */
export interface ExtensionConfig {
  webStoreInstall: boolean
  webStoreUpdates: WebStoreUpdates
  /** Extension ids switched off, by profile id. */
  disabled: Readonly<Record<string, readonly string[]>>
  /** Extension ids the person let capture the sound of a tab, by profile id (shared/tab-capture.ts): none is the default. */
  tabCapture: Readonly<Record<string, readonly string[]>>
  /** The whole capture of the sound of a tab is on (Réglages › Extensions et outils): off, no extension captures anything, whatever the person allowed it. */
  tabCaptureOn: boolean
}

/** The sheet the engine asks the shell to show before it installs an extension of the Web Store, applies an update that asks for more, or grants a permission an extension asks for. */
export interface ExtensionReviewAsk {
  profileId: string
  /** The tab of the store page that asked, when known: its window shows the sheet. */
  pageId?: string
  /** `optional`: an installed extension asks for a permission its manifest lists as facultative. */
  mode: 'install' | 'update' | 'optional'
  extensionId: string
  review: ExtensionReview
  /** A small `data:image/png` URL of the extension's own icon. */
  icon?: string
}

/** What the user chose in the menu of an extension's toolbar icon. */
export type ExtensionMenuAction = 'disable' | 'uninstall' | 'manage'

/** One entry Lucium adds to the menu of an extension's toolbar icon. */
export interface ActionMenuEntry {
  label: string
  click(): void
}

/** The extensions the engine loads, installs, updates and lists, and what it tells of them. */
export interface EngineExtensionTools {
  /** The entries Lucium adds to the menu of an extension's toolbar icon (right click), for the profile the icon is in: pin it to the bar, unpin it. */
  setActionMenuItems(provider: ((profileId: string, extensionId: string) => ActionMenuEntry[]) | null): void
  /** Loads an unpacked extension into a profile (and every profile created later). Rejects with the engine's own error. */
  loadExtension(profileId: string, path: string): Promise<ExtensionInfo>
  /** The extensions that are loaded, in each profile they run in. */
  listExtensions(): ExtensionInfo[]
  /** The same, plus those switched off in a profile (`enabled: false`) and the updates that wait for the user. */
  listAllExtensions(): ExtensionInfo[]
  /**
   * The settings the extension runtime follows: Web Store installation and update mode, and the extensions switched off per profile.
   * An extension switched off in a profile is taken out of that profile's session (and not loaded there at launch); one switched on is loaded.
   */
  configureExtensions(config: ExtensionConfig): void
  /** The shell's answer to the sheet. Resolving false (or never resolving until the sheet is closed) refuses. */
  onExtensionReview(handler: (ask: ExtensionReviewAsk) => Promise<boolean>): void
  /** The set of extensions changed (one was installed, updated, uninstalled, switched on or off): the menu and Settings list them again. */
  onExtensionsChanged(listener: () => void): void
  /** A sentence for the user about something the extension runtime did or refused (an install that failed, an update that waits). */
  onExtensionNotice(listener: (message: string) => void): void
  /** The user chose an entry the engine added to the menu of an extension's toolbar icon. */
  onExtensionMenu(listener: (action: ExtensionMenuAction, profileId: string, extensionId: string) => void): void
  /** Removes an extension installed from the Web Store from one profile: its files, its data and its toolbar icon. Rejects for any other extension. */
  uninstallExtension(profileId: string, extensionId: string): Promise<void>
  /** Looks for newer versions of the Web Store extensions of every profile and applies those that ask for nothing more. Never run by itself unless the setting says so. */
  checkExtensionUpdates(): Promise<UpdateReport>
  /** Shows the sheet of an update that waits for the user's agreement; applies it when accepted. */
  reviewExtensionUpdate(profileId: string, extensionId: string): Promise<'updated' | 'declined' | 'none'>
  /** Diagnostics: how many extension popups were opened (clicking an action icon). */
  extensionPopupCount(): number
  /** Diagnostics: scopes of the extension service workers currently running. */
  runningExtensionWorkers(): string[]
  /** Diagnostics: how many times an extension worker was held awake and not yet released. */
  heldWorkerCount(): number
  /** Diagnostics: console output of extension service workers (warnings and errors only). */
  onExtensionConsole(listener: (entry: ExtensionLogEntry) => void): void
  /** The developer's tools of the Extensions page: reload, journal, details. */
  readonly extensionTools: ExtensionDevTools
}

/** What the Extensions page needs from the engine beyond the list (see engine/extension-dev.ts). Nothing of it listens or runs until the page asks. */
export interface ExtensionDevTools {
  /** The manifest facts, the folder, the picture and the state of the worker of every extension of every profile. */
  details(): Promise<ExtensionDetail[]>
  /** The folder an extension was loaded from in a profile, with its name, version and where it came from. Null for one that is not known there. */
  folderOf(profileId: string, extensionId: string): { path: string; name: string; version: string; source: ExtensionInfo['source'] } | null
  /** Why the extension is not loaded in the profile although it is not switched off: the sentence of its last failed load. Undefined when it is loaded, switched off, or unknown. */
  failureOf(profileId: string, extensionId: string): string | undefined
  /** Unloads the extension from the profile (when it is loaded) and loads its folder again; an extension whose last load failed is only loaded. Rejects with a sentence for the person (an `ExtensionDevError`) or the engine's own error. */
  reload(profileId: string, extensionId: string): Promise<ExtensionInfo>
  /** Takes an extension loaded from a folder out of every profile and forgets the folder; null (nothing done) for one that is not one. */
  removeFolder(extensionId: string): { path: string; name: string } | null
  /** The same, named by the folder it was loaded from; null (nothing done) when no extension known in any profile comes from that folder. */
  removeFolderAt(path: string): { path: string; name: string } | null
  /** Starts recording the consoles of the extensions' workers and pages; the function it returns stops it. Counted: the last one to stop ends the listening. */
  watchConsoles(): () => void
  isWatching(): boolean
  readJournal(filter?: JournalFilter & { since?: number }): JournalEntry[]
  lastJournalId(): number
  clearJournal(filter?: JournalFilter): number
  /** Forgets the entries of the journal with these numbers, and no other. */
  removeJournalEntries(ids: readonly number[]): void
  /** Writes a failed load of a folder in the journal and keeps it as the state of that folder in that profile; answers the sentence. `reason` is a sentence already, or what Chromium rejected with. */
  failed(profileId: string, path: string, extensionId: string | undefined, reason: unknown): string
  /** Takes back one permission or one site the person granted the extension in the profile on its request. False when it was not held. */
  revokeGranted(profileId: string, extensionId: string, name: string): boolean
}

/** The tools of a context that has no extensions (a private window): nothing to list, reload or record. */
export const NO_EXTENSION_TOOLS: ExtensionDevTools = {
  details: () => Promise.resolve([]),
  folderOf: () => null,
  failureOf: () => undefined,
  reload: () => Promise.reject(new Error('Extensions do not run in a private window')),
  removeFolder: () => null,
  removeFolderAt: () => null,
  watchConsoles: () => () => undefined,
  isWatching: () => false,
  readJournal: () => [],
  lastJournalId: () => 0,
  clearJournal: () => 0,
  removeJournalEntries: () => undefined,
  failed: () => '',
  revokeGranted: () => false
}

export interface ExtensionLogEntry {
  level: 'warning' | 'error'
  message: string
  sourceUrl: string
}
