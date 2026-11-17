// What the Extensions page, a tab, may ask of the application. Six channels of their own that it answers (`InternalChannel`; the seventh, the snapshot, is sent to it), registered for each window group with the group's
// own scoped IPC, and answered only for a web contents that is the page of a tab of THIS window right now. Every message goes through `guard`, which asks
// shared/internal-gate.ts the one question: is the sender the top frame of a document at exactly `lucium-ui://extensions`, in a tab the state still has on the page, in
// an ordinary window, in the session of a profile, and is the application unlocked. Anything else gets nothing and a line in the log with the channel and the reason.
//
// The page is not trusted with what it sends either: the request, the target of Settings, the profile and the extension of an update and the paths of dropped
// files are read again here, with the rules the interface's own channels apply.

import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { isExtensionId } from '@shared/extension-review'
import type { ExtensionsReply } from '@shared/extension-page'
import { internalSenderRefusal, type InternalSenderFacts } from '@shared/internal-gate'
import { internalSnapshot } from '@shared/internal-snapshot'
import { InternalChannel, type SettingsAnchor, type SettingsPane, type UiSnapshot } from '@shared/ipc'
import { t } from '@shared/i18n'
import { localFileUrls } from '@shared/local-documents'
import { isProfileId } from '@shared/profiles'
import { resolveSettingsTarget } from '@shared/settings-catalog'
import { answerExtensionsRequest } from './extensions-ipc'
import type { ExtensionsService } from './extensions-service'
import type { ScopedIpc } from './ipc-scope'

/** What the window knows of a web contents that may be the page: its tab in the state, and the session it is in. Null for any web contents that is no tab of this window. */
export interface InternalTabFacts {
  url: string
  private: boolean
  container: boolean
  /** In the session of a profile (not a private context or a container). */
  profileSession: boolean
}

/** What the page asks of the window it is in (the Browser of the window, and what only the system knows). */
export interface InternalPageHost {
  tabOf(contentsId: number): InternalTabFacts | null
  /** A private or guest window. */
  isPrivate(): boolean
  snapshot(): UiSnapshot
  appLocked(): boolean
  openSettings(pane: SettingsPane, anchor?: SettingsAnchor): void
  openWebStore(): void
  /** « Rechercher les mises à jour » (no target), or the sheet of one update (`profileId` and `extensionId` are checked ids). */
  updates(target?: { profileId: string; extensionId: string }): void
  openFiles(urls: string[], refused: number): void
  /** The boxes of the service open over the window of the page that asked. */
  asking(sender: WebContents | null): void
}

type Frame = { origin?: unknown; url?: unknown; parent?: unknown } | null | undefined

/** The facts of a message, read when it arrives: from the frame as Chromium reports it, never from what the page says. */
export function senderFacts(event: { sender: Pick<WebContents, 'id' | 'mainFrame'>; senderFrame?: Frame }, host: InternalPageHost): InternalSenderFacts {
  let frame: Frame
  try {
    frame = event.senderFrame
  } catch (error) {
    // The frame is gone (the page was closed under the message): the message has no sender, and the gate refuses it with that reason.
    console.warn('[internal-page] the frame of a message is gone:', error instanceof Error ? error.message : String(error))
    frame = undefined
  }
  const tab = host.tabOf(event.sender.id) ?? null
  return {
    frameOrigin: frame?.origin,
    frameUrl: frame?.url,
    // The top frame is the main frame of its web contents, and has no parent.
    topFrame: frame !== null && frame !== undefined && frame.parent === null && (frame as unknown) === event.sender.mainFrame,
    tab: tab === null ? null : { url: tab.url, private: tab.private, container: tab.container },
    privateWindow: host.isPrivate(),
    profileSession: tab?.profileSession === true,
    appLocked: host.appLocked()
  }
}

/**
 * Registers the page's channels for a window group. `ipcMain` answers only the web contents `host.tabOf` knows (the scope of this window): another window's page
 * is answered by the registration of its own window.
 */
export function registerInternalPageIpc(ipcMain: ScopedIpc, host: InternalPageHost, service: Pick<ExtensionsService, 'handle'>): void {
  /** Whether the sender is the page, as the main process sees it. The refusal is logged with its channel and its reason, and never says more to the sender. */
  const guard = (event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean => {
    const why = internalSenderRefusal(senderFacts(event, host))
    if (why === null) return true
    console.warn(`[internal-page] ${channel} refused: ${why}`)
    return false
  }

  // The gate has refused a locked application by now: the list of the extensions is told as it is.
  ipcMain.handle(InternalChannel.getSnapshot, (event) => (guard(event, InternalChannel.getSnapshot) ? internalSnapshot(host.snapshot(), false) : null))

  ipcMain.handle(InternalChannel.extensionsPage, async (event, raw: unknown): Promise<ExtensionsReply> => {
    if (!guard(event, InternalChannel.extensionsPage)) return { ok: false, message: t('feature.demande-refusee') }
    host.asking(event.sender)
    return answerExtensionsRequest(service, raw)
  })

  ipcMain.on(InternalChannel.extensionUpdates, (event, target: unknown) => {
    if (!guard(event, InternalChannel.extensionUpdates)) return
    if (target === undefined || target === null) return host.updates()
    const { profileId, extensionId } = (typeof target === 'object' ? target : {}) as { profileId?: unknown; extensionId?: unknown }
    if (isProfileId(profileId) && isExtensionId(extensionId)) host.updates({ profileId, extensionId })
    else console.warn('[internal-page] a request for the update of an extension that names no profile or extension was ignored')
  })

  ipcMain.on(InternalChannel.openWebStore, (event) => {
    if (guard(event, InternalChannel.openWebStore)) host.openWebStore()
  })

  // Settings, at a place that exists: the target is resolved as an address of Settings is, and anything else is not opened.
  ipcMain.on(InternalChannel.openSettings, (event, raw: unknown) => {
    if (!guard(event, InternalChannel.openSettings)) return
    const { pane, anchor } = (typeof raw === 'object' && raw !== null ? raw : {}) as { pane?: unknown; anchor?: unknown }
    const target = resolveSettingsTarget(pane, anchor)
    if (target === null) return console.warn('[internal-page] a request to open Settings at a place that does not exist was ignored')
    host.openSettings(target.pane as SettingsPane, 'anchor' in target ? (target.anchor as SettingsAnchor | undefined) : undefined)
  })

  // Files dropped on the page open in tabs, as on any window: paths the interface sends are read again, and a type a tab would download is refused.
  ipcMain.on(InternalChannel.openLocalFiles, (event, paths: unknown) => {
    if (!guard(event, InternalChannel.openLocalFiles)) return
    const { urls, refused } = localFileUrls(paths)
    host.openFiles(urls, refused)
  })
}
