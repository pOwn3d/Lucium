import { app, BrowserWindow } from 'electron'
import { AUTH_ERRORS, isAuthPageUrl, isRelayedEvent, safeDownloadName, searchDownloads, toChromeDownload, type ChromeDownloadItem, type DownloadQuery } from '@shared/chrome-compat'
import { DebuggerGuard, debuggerTargetAllowed } from '@shared/debugger-policy'
import type { DownloadInfo } from '@shared/model'
import { chromeAddressOf, isInternalScheme } from '@shared/internal-page'
import { PRIVATE_PANEL_REFUSAL, type PanelOptions } from '@shared/sidepanel'
import { managementGetAll } from '@shared/extension-management'
import { closedSessions, parseMaxResults, sessionToRestore } from '@shared/extension-sessions'
import { nativeHostDirs } from '@shared/native-messaging'
import { emptyGroups, forgetTab, getGroup, groupOf, groupTabs, membersOf, queryGroups, ungroupTabs, updateGroup, type GroupQuery, type GroupResult, type GroupState, type TabGroup } from '@shared/tab-groups'
import { GroupFolders, clearGroupMirror, setGroupMirror } from '@shared/group-folders'
import { BROWSING_DATA_METHODS, DATA_APIS, bare, bookmarkIds, bookmarkIndex, bookmarkTree, browsingDataSettings, historyUrl, parseBrowsingData, parseHistoryQuery, readOnlyError, recentBookmarks, searchBookmarks, searchHistory, visitsOf } from '@shared/extension-data'
import type { Engine, ShimCall } from '../engine/types'
import { currentPlatform } from '../platform'
import type { StateStore } from '../store'
import type { Browser, HistoryLog } from './browser'
import { NativeHosts, type PortEvent } from './native-messaging'
import { registeredManifests } from './native-messaging-registry'
import { shownState } from './lock-state'
import { getLockService } from '../lock-service'
import { t } from '@shared/i18n'

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

/** How many finished downloads are remembered for chrome.downloads.search. */
const MAX_DOWNLOADS_KEPT = 200
/** Without a timeout of its own, a flow that needs no interaction gives up after this. */
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const MAX_AUTH_TIMEOUT_MS = 60_000

/**
 * Behavior behind the chrome.* APIs that Electron lacks and that real extensions need: chrome.sidePanel (a docked panel),
 * chrome.tabGroups and chrome.tabs.group (groups that exist for extensions), chrome.debugger (DevTools protocol), chrome.identity,
 * chrome.downloads, chrome.runtime native messaging, chrome.tabs.captureVisibleTab. Every call carries the profile of the extension
 * context that made it: an extension reaches the tabs, groups and downloads of its own profile only.
 */
/** The most text, and the most HTML, an extension may put on the clipboard in one go (characters). */
export const CLIPBOARD_WRITE_MAX = 10_000_000

export class ExtensionShims {
  /** `${extensionId}:${tabNumber}` of every attached debugger session, and what each may do. */
  private readonly attached = new Set<string>()
  private readonly guards = new Map<string, DebuggerGuard>()

  private groups: GroupState = emptyGroups()
  /** The folders that stand for the groups in the sidebar, while that feature is on (see `mirrorGroups`). */
  private folders: GroupFolders | null = null
  private folderSyncQueued = false
  /** The profile each group belongs to (all its tabs are in it). Kept after the group's last tab left, for the event that says it is gone. */
  private readonly groupProfile = new Map<number, string>()

  private readonly hosts: NativeHosts
  /** The profile of every open native port, by port id, and the page or worker that opened it. */
  private readonly portProfile = new Map<string, { profileId: string; extensionId: string; context: string }>()
  /** Workers kept awake for the ports they have open, by `${extensionId}:${profileId}`. */
  private readonly holds = new Map<string, { release: () => void; ports: number }>()

  /** `endedAt`: when the download was first seen ended (its `endTime`), kept until it starts again. */
  private readonly downloads = new Map<string, { info: DownloadInfo; profileId: string; byExtensionId?: string; endedAt?: number }>()
  /** Downloads that an extension started, so that its id is on them. */
  private readonly downloadOwners = new Map<string, string>()

  constructor(
    private readonly browser: Browser,
    private readonly engine: Engine,
    private readonly store: StateStore,
    private readonly history?: HistoryLog
  ) {
    engine.setTabFactsProvider((tabNumber) => {
      const pageId = engine.pageIdOfTabNumber(tabNumber)
      return { groupId: groupOf(this.groups, tabNumber), pinned: this.store.get().tabs.find((t) => t.id === pageId)?.pinned === true }
    })
    engine.onTabClosed((tabNumber) => this.apply(forgetTab(this.groups, tabNumber), undefined))
    engine.onDownload((info, _source, profileId) => this.onDownload(info, profileId))
    this.hosts = new NativeHosts({
      // The hosts registered for another browser are not Lucium's to start unless the user chose so (Réglages › Extensions et outils › Plus de réglages): by default only its own data folder counts.
      dirs: () => nativeHostDirs(app.getPath('userData'), app.getPath('home'), this.store.get().settings.chromeNativeHosts, currentPlatform().id),
      // Windows: the registry keys where Chrome's hosts are written, under the same switch as the folders.
      registryManifests: (hostName) => registeredManifests(hostName, this.store.get().settings.chromeNativeHosts, currentPlatform().id),
      platform: currentPlatform().id,
      deliver: (extensionId, portId, event) => this.deliverPortEvent(extensionId, portId, event)
    })
    app.once('will-quit', () => this.hosts.closeAll())
    // A native port lives as long as the page or worker that opened it, and the extension: when they go, the host's pipe closes and the worker is let go.
    engine.onContextGone((gone) => this.closePortsOf(gone))
  }

  async handle(call: ShimCall): Promise<unknown> {
    // One switch gives or takes away what extensions may read of the history and favourites and erase of sites (Réglages › Outils et extensions).
    // The error is the extension's, in English like every error of the chrome.* APIs; the place of the switch is named as the interface shows it,
    // so that whoever reads it finds the switch.
    if (DATA_APIS.includes(call.api) && !this.store.get().settings.extensionDataApis) throw new Error(`chrome.${call.api} is switched off in Lucium (${t('settings.reglages')} › ${t('settings.cat-tools')}).`)
    switch (call.api) {
      case 'history':
        return this.historyApi(call)
      case 'bookmarks':
        return this.bookmarksApi(call)
      case 'browsingData':
        return this.browsingDataApi(call)
      case 'sidePanel':
        return this.sidePanel(call)
      case 'tabGroups':
        return this.tabGroups(call)
      case 'tabs':
        return this.tabs(call)
      case 'contextMenus':
        return this.contextMenus(call)
      case 'clipboard':
        return this.clipboard(call)
      case 'debugger':
        return this.debugger(call)
      case 'nativeMessaging':
        return this.nativeMessaging(call)
      case 'identity':
        return this.identity(call)
      case 'downloads':
        return this.downloadsApi(call)
      case 'runtime':
        return this.runtime(call)
      case 'events':
        return this.events(call)
      case 'management':
        return this.management(call)
      case 'sessions':
        return this.sessions(call)
      default:
        throw new Error(`Unknown shimmed API: ${call.api}`)
    }
  }

  /** chrome.management: the list of the extensions of the caller's own profile, in a sober shape (shared/extension-management.ts). */
  private management({ profileId, method }: ShimCall): unknown {
    if (method === 'getAll') return managementGetAll(this.engine.listAllExtensions(), profileId)
    throw new Error(`chrome.management.${method} is not provided.`)
  }

  /**
   * chrome.sessions: the tabs the person closed (the archive) in the caller's own profile, and their reopening. Read from the state the interface is given, so that a locked
   * space is out; a private tab is never in the archive. Another device is none here.
   */
  private sessions({ profileId, method, args }: ShimCall): unknown {
    const shown = () => shownState(this.store.get(), getLockService()?.view())
    switch (method) {
      case 'getRecentlyClosed': {
        const max = parseMaxResults(args[0])
        if (max === null) throw new Error("Invalid value for argument 1. Property 'maxResults': Value must be a whole number from 1 to 25.")
        const state = shown()
        return closedSessions(state.archive, state.spaces, profileId, max)
      }
      case 'restore': {
        const state = shown()
        const entry = sessionToRestore(state.archive, state.spaces, profileId, typeof args[0] === 'string' ? args[0] : undefined)
        if (!entry) throw new Error(typeof args[0] === 'string' ? 'Invalid session id.' : 'There are no recently closed sessions to restore.')
        const before = new Set(this.store.get().tabs.map((tab) => tab.id))
        this.browser.dispatch({ type: 'archive/restore', id: entry.id })
        const opened = this.store.get().tabs.find((tab) => !before.has(tab.id))
        if (!opened) throw new Error('The session could not be restored.')
        const [session] = closedSessions([entry], state.spaces, profileId, 1)
        const id = this.engine.tabNumberOf(opened.id)
        // The tab's number exists once its page does: a tab that opens in the background has none yet, and the answer says no more than it knows.
        return { lastModified: Math.floor(Date.now() / 1000), tab: { ...session!.tab, ...(id !== undefined ? { id } : {}) } }
      }
      case 'getDevices':
        return []
      default:
        throw new Error(`chrome.sessions.${method} is not provided.`)
    }
  }

  /** The tab number an extension named, if it is a live tab of the extension's own profile. */
  private requireTab(call: ShimCall, tabNumber: unknown): number {
    if (typeof tabNumber !== 'number' || this.engine.profileOfTab(tabNumber) !== call.profileId) throw new Error(`No tab with id: ${String(tabNumber)}.`)
    return tabNumber
  }

  private pageForTab(call: ShimCall, tabNumber: unknown): string {
    const pageId = this.engine.pageIdOfTabNumber(this.requireTab(call, tabNumber))
    if (!pageId) throw new Error(`No tab with id: ${String(tabNumber)}.`)
    return pageId
  }

  /** Tells the extensions of a profile (every one that has a context running there) about an extension event. */
  private broadcast(profileId: string, api: string, event: string, args: unknown[]): void {
    for (const id of new Set(this.engine.listExtensions().map((e) => e.id))) this.engine.emitShimEvent(id, api, event, args, profileId)
  }

  // ---- chrome.sidePanel ----

  private sidePanel({ extensionId, profileId, method, args }: ShimCall): unknown {
    const options = asObject(args[0])
    if (typeof options.tabId === 'number' && this.engine.profileOfTab(options.tabId) !== profileId) throw new Error(`No tab with id: ${options.tabId}.`)
    const tabKey = typeof options.tabId === 'number' ? this.engine.pageIdOfTabNumber(options.tabId) : undefined
    switch (method) {
      case 'setOptions': {
        const patch: PanelOptions = { path: options.path as string | undefined, enabled: options.enabled as boolean | undefined }
        this.browser.setSidePanelOptions(extensionId, tabKey, patch)
        return undefined
      }
      case 'getOptions': {
        const resolved = this.browser.resolveSidePanel(extensionId, tabKey)
        return { enabled: resolved.enabled, ...(resolved.path ? { path: resolved.path } : {}) }
      }
      case 'open': {
        // In the window the user is in, or the one that shows the tab (not always the main window, now that there can be several).
        const target = this.panelWindow(options.windowId, tabKey)
        this.requireSidePanelProfile(profileId, tabKey, target)
        target.openSidePanel(extensionId, tabKey)
        return undefined
      }
      case 'setPanelBehavior':
        this.browser.dispatch({ type: 'sidepanel/behavior', extensionId, openOnActionClick: options.openPanelOnActionClick === true })
        return undefined
      case 'getPanelBehavior':
        return { openPanelOnActionClick: this.store.get().sidePanelBehavior[extensionId] === true }
      case '_actionClicked':
        // The extension asked for its panel to open on icon click: that replaces its onClicked handling.
        if (this.store.get().sidePanelBehavior[extensionId]) this.panelWindow(undefined, undefined).openSidePanel(extensionId, undefined)
        return undefined
      default:
        throw new Error(`chrome.sidePanel.${method} is not supported`)
    }
  }

  /**
   * A panel with no tab named opens for the tab the user is on: that tab has to be in the extension's own profile, not in whichever one is open.
   * And never a private tab: the extension is told so, and learns nothing else of the tab.
   */
  private requireSidePanelProfile(profileId: string, tabKey: string | undefined, target: Browser): void {
    const profile = target.profileForPanel(tabKey)
    if (profile === null) throw new Error(PRIVATE_PANEL_REFUSAL)
    if (profile !== profileId) throw new Error('There is no active tab in the profile of this extension.')
  }

  /**
   * The window a panel opens in: the one asked for (`windowId`), else the one that shows the tab named, else the one the user is in. With several windows
   * the main one is none of these by default: a panel opened there while the user works in another window shows for the wrong tab.
   */
  private panelWindow(windowId: unknown, tabKey: string | undefined): Browser {
    if (typeof windowId === 'number' && windowId !== -2) {
      const asked = this.browser.browserOfWindow(windowId)
      if (asked) return asked
    }
    const shower = tabKey ? this.browser.windows().find((window) => window.ownsPage(tabKey)) : undefined
    return shower ?? this.browser.browserOfWindow(this.currentWindowId()) ?? this.browser
  }

  // ---- chrome.runtime.getContexts: the panel docked in a window is a side panel context ----

  private runtime({ extensionId, profileId, method }: ShimCall): unknown {
    if (method !== 'sidePanelContexts') throw new Error(`chrome.runtime.${method} is not supported`)
    return this.browser.sidePanelContexts(extensionId, profileId).map(({ documentUrl, windowId }) => ({
      contextType: 'SIDE_PANEL',
      contextId: `side-panel-${windowId}`,
      tabId: -1,
      windowId,
      frameId: 0,
      documentUrl,
      documentOrigin: `chrome-extension://${extensionId}`,
      incognito: false
    }))
  }

  // ---- events Electron does not deliver to workers ----

  private events({ extensionId, profileId, method, args }: ShimCall): unknown {
    const name = args[0]
    if (!isRelayedEvent(name)) throw new Error(`The event ${String(name)} is not relayed.`)
    if (method === 'subscribe') {
      this.engine.relayNativeEvent(extensionId, profileId, name)
      return undefined
    }
    // 'relay': the hidden page of the extension heard the event.
    const [api, event] = name.split('.') as [string, string]
    return this.engine.deliverToWorker(extensionId, profileId, api, event, Array.isArray(args[1]) ? args[1] : [])
  }

  // ---- chrome.tabGroups / chrome.tabs.group ----

  private groupsOf(profileId: string): GroupState {
    const visible = emptyGroups()
    for (const group of Object.values(this.groups.groups)) {
      if (this.groupProfile.get(group.id) !== profileId) continue
      visible.groups[group.id] = group
    }
    for (const [tab, id] of Object.entries(this.groups.members)) if (visible.groups[id]) visible.members[Number(tab)] = id
    return visible
  }

  private groupIdArg(call: ShimCall, value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || this.groupProfile.get(value) !== call.profileId || !this.groups.groups[value]) throw new Error(`No group with id: ${String(value)}.`)
    return value
  }

  /** Records a change of the groups and tells the world: the tabs that moved, and the groups that appeared, changed or went. */
  private apply(result: GroupResult<unknown>, profileId: string | undefined): void {
    this.groups = result.state
    const { change } = result
    for (const group of change.created) if (profileId) this.groupProfile.set(group.id, profileId)
    for (const tab of change.tabs) this.engine.notifyTabChanged(tab)
    const emit = (event: string, groupsOf: TabGroup[]) => {
      for (const group of groupsOf) {
        const owner = this.groupProfile.get(group.id)
        if (owner) this.broadcast(owner, 'tabGroups', event, [group])
      }
    }
    emit('onCreated', change.created)
    emit('onUpdated', change.updated)
    emit('onRemoved', change.removed)
    for (const group of change.removed) this.groupProfile.delete(group.id)
    this.scheduleFolderSync()
  }

  /**
   * Shows the groups as folders in the sidebar (Réglages › Fonctions › tab-groups-ext) until the function it returns is called: then the
   * tabs go back where they were and the folders go. Both happen a moment later, not inside the change of state that switched the setting.
   */
  mirrorGroups(): () => void {
    const mirror = new GroupFolders({ state: () => this.store.get(), dispatch: (action) => this.browser.dispatch(action), report: (message) => console.warn(message) })
    const placements = () => mirror.placements()
    this.folders = mirror
    setGroupMirror(placements)
    this.scheduleFolderSync()
    return () => {
      if (this.folders === mirror) this.folders = null
      queueMicrotask(() => {
        try {
          mirror.release()
          clearGroupMirror(placements)
        } catch (error) {
          // The folders are still there: the files go on being written without them (the registry stays until the next start).
          console.error('[tab-groups] cannot put the tabs back after the folders were switched off:', error)
        }
      })
    }
  }

  /** The tabs are reported closed while the windows are applying a state, and the folders change that state: so this waits for the next turn. */
  private scheduleFolderSync(): void {
    if (!this.folders || this.folderSyncQueued) return
    this.folderSyncQueued = true
    queueMicrotask(() => {
      this.folderSyncQueued = false
      const mirror = this.folders
      if (!mirror) return
      const groups = Object.values(this.groups.groups).map((group) => ({
        id: group.id,
        title: group.title,
        collapsed: group.collapsed,
        tabs: membersOf(this.groups, group.id).flatMap((tabNumber) => this.engine.pageIdOfTabNumber(tabNumber) ?? [])
      }))
      try {
        mirror.sync(groups)
      } catch (error) {
        console.error('[tab-groups] cannot show the groups as folders:', error)
      }
    })
  }

  private currentWindowId(): number {
    const focused = BrowserWindow.getFocusedWindow()
    // The popup of an extension's icon is a child of the window it hangs from, and it has the focus while the extension works: the window the user is in is its parent
    // (a call made by the popup without a window, a screenshot, a panel, was taken for the first window).
    const inside = focused?.getParentWindow?.() ?? focused
    return inside && this.browser.browserOfWindow(inside.id) ? inside.id : this.browser.windowId()
  }

  private tabGroups(call: ShimCall): unknown {
    const { method, args } = call
    switch (method) {
      case 'query': {
        const info = asObject(args[0])
        const query: GroupQuery = {
          ...(typeof info.collapsed === 'boolean' ? { collapsed: info.collapsed } : {}),
          ...(typeof info.color === 'string' ? { color: info.color } : {}),
          ...(typeof info.title === 'string' ? { title: info.title } : {}),
          ...(typeof info.windowId === 'number' ? { windowId: info.windowId } : {})
        }
        return queryGroups(this.groupsOf(call.profileId), query, this.currentWindowId())
      }
      case 'get':
        return getGroup(this.groupsOf(call.profileId), this.groupIdArg(call, args[0]))
      case 'update': {
        const id = this.groupIdArg(call, args[0])
        const props = asObject(args[1])
        const result = updateGroup(this.groups, id, {
          ...(typeof props.title === 'string' ? { title: props.title } : {}),
          ...(typeof props.color === 'string' ? { color: props.color } : {}),
          ...(typeof props.collapsed === 'boolean' ? { collapsed: props.collapsed } : {})
        })
        this.apply(result, call.profileId)
        return result.value
      }
      default:
        // Groups have no place in the sidebar, so there is nothing to move them to.
        throw new Error(`chrome.tabGroups.${method} is not supported in Lucium.`)
    }
  }

  /**
   * The paste of a content script (`document.execCommand('paste')`, which Electron does not allow it, although an extension that holds "clipboardRead" expects it):
   * the clipboard is pasted into what the page has focused, in a tab of the extension's profile that a host permission of the extension covers.
   */
  private async clipboard(call: ShimCall): Promise<undefined> {
    if (call.method === 'write') {
      // What `document.execCommand('copy')` of an extension page put on the clipboard (the permission is "clipboardWrite", see shimAllowed).
      const items = asObject(call.args[0])
      const text = typeof items.text === 'string' ? items.text : ''
      const html = typeof items.html === 'string' ? items.html : ''
      if (text.length > CLIPBOARD_WRITE_MAX || html.length > CLIPBOARD_WRITE_MAX) throw new Error('This is too much to put on the clipboard.')
      await this.engine.writeClipboard({ text, html })
      return undefined
    }
    if (call.method !== 'paste') throw new Error(`chrome.clipboard.${call.method} is not supported`)
    const tabNumber = call.args[0]
    const page = this.browser.pageFor(this.pageForTab(call, tabNumber))
    if (!page || typeof tabNumber !== 'number' || !this.engine.mayActOnTab(call.extensionId, tabNumber)) throw new Error('Cannot paste into this tab: the extension needs a host permission for its address.')
    // A copy asked for just before has to be on the clipboard before it is read.
    await this.engine.clipboardSettled()
    page.pasteIntoFocus()
    return undefined
  }

  /** chrome.contextMenus.update: the library creates and removes the items of an extension and leaves the rest to us. */
  private contextMenus({ extensionId, profileId, method, args }: ShimCall): undefined {
    if (method !== 'update') throw new Error(`chrome.contextMenus.${method} is not supported`)
    this.engine.updateContextMenuItem(extensionId, profileId, args[0], args[1])
    return undefined
  }

  private tabs(call: ShimCall): unknown {
    const { method, args } = call
    switch (method) {
      case 'discard':
        // "Discarding" a tab frees its web view; the tab stays in the sidebar and reloads when selected.
        this.browser.sleepPage(this.pageForTab(call, args[0]))
        return undefined
      case 'group': {
        const options = asObject(args[0])
        const tabIds = (Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]).map((tab) => this.requireTab(call, tab))
        const windowId = asObject(options.createProperties).windowId
        const result = groupTabs(
          this.groups,
          tabIds,
          {
            ...(options.groupId !== undefined ? { groupId: this.groupIdArg(call, options.groupId) } : {}),
            ...(typeof windowId === 'number' && windowId !== -2 ? { windowId } : {})
          },
          (tab) => this.engine.windowOfTab(tab)
        )
        this.apply(result, call.profileId)
        return result.value
      }
      case 'ungroup': {
        const tabIds = (Array.isArray(args[0]) ? args[0] : [args[0]]).map((tab) => this.requireTab(call, tab))
        this.apply(ungroupTabs(this.groups, tabIds), call.profileId)
        return undefined
      }
      case 'captureVisibleTab':
        return this.captureVisibleTab(call)
      default:
        throw new Error(`chrome.tabs.${method} is not supported`)
    }
  }

  /** chrome.tabs.captureVisibleTab([windowId], [{ format, quality }]): the visible area of the window's active tab, as a data URL. */
  private async captureVisibleTab({ extensionId, profileId, args }: ShimCall): Promise<string> {
    const windowId = typeof args[0] === 'number' ? args[0] : undefined
    const options = asObject(typeof args[0] === 'object' ? args[0] : args[1])
    const target = windowId === undefined || windowId === -2 ? this.browser.browserOfWindow(this.currentWindowId()) : this.browser.browserOfWindow(windowId)
    if (!target) throw new Error(`No window with id: ${String(windowId)}.`)
    // "activeTab" alone is not an access: the user has to have handed this tab to the extension (a host permission for it needs no hand-over).
    const visible = target.activeTabFor(profileId)
    const tabNumber = visible ? this.engine.tabNumberOf(visible.id) : undefined
    if (visible && (tabNumber === undefined || !this.engine.mayCaptureTab(extensionId, tabNumber))) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.")
    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const quality = typeof options.quality === 'number' ? Math.min(100, Math.max(0, Math.round(options.quality))) : 90
    const image = await target.captureActiveFor(profileId, format, quality)
    if (!image) throw new Error('Cannot capture this tab: no tab of this profile is visible in the window.')
    return `data:image/${format};base64,${Buffer.from(image).toString('base64')}`
  }

  // ---- chrome.debugger ----

  private async debugger(call: ShimCall): Promise<unknown> {
    const { extensionId, method, args } = call
    if (method === 'getTargets') {
      return this.browser
        .listTabTargets()
        .filter((t) => this.engine.profileOfTab(t.tabNumber) === call.profileId)
        .map((t) => {
          // The Extensions page is told at Chrome's address to an extension that may read tabs, and without its address and its title to any other (as `chrome.tabs` does).
          const own = isInternalScheme(t.url)
          const told = !own ? { title: t.title, url: t.url } : this.engine.mayReadTab(extensionId, t.tabNumber) ? { title: t.title, url: chromeAddressOf(t.url) } : {}
          return { type: 'page', id: String(t.tabNumber), tabId: t.tabNumber, ...told, attached: this.attached.has(`${extensionId}:${t.tabNumber}`) }
        })
    }
    const target = asObject(args[0])
    const tabNumber = target.tabId
    const pageId = this.pageForTab(call, tabNumber)
    const key = `${extensionId}:${tabNumber as number}`
    const page = this.browser.pageFor(pageId)
    if (!page) throw new Error(`No tab with id: ${String(tabNumber)}.`)

    switch (method) {
      case 'attach': {
        if (this.attached.has(key) || page.isDebugAttached()) throw new Error(`Another debugger is already attached to the tab with id: ${String(tabNumber)}.`)
        const guard = new DebuggerGuard(extensionId)
        // Only a web page, the blank page and its own pages: the protocol would read a file given a `file:` tab, and run as another extension in its page.
        page.debugAttach(
          typeof args[1] === 'string' ? args[1] : '1.3',
          (name, params) => {
            if (guard.event(name, params)) this.engine.emitShimEvent(extensionId, 'debugger', 'onEvent', [{ tabId: tabNumber }, name, params], call.profileId)
          },
          (reason) => {
            this.attached.delete(key)
            this.guards.delete(key)
            this.engine.emitShimEvent(extensionId, 'debugger', 'onDetach', [{ tabId: tabNumber }, reason], call.profileId)
          },
          (url) => debuggerTargetAllowed(url, extensionId)
        )
        // Remembered once the session exists: an attach that was refused must not leave the tab "already attached".
        this.attached.add(key)
        this.guards.set(key, guard)
        return undefined
      }
      case 'detach':
        if (!this.attached.has(key)) throw new Error(`Debugger is not attached to the tab with id: ${String(tabNumber)}.`)
        page.debugDetach()
        return undefined
      case 'sendCommand': {
        const guard = this.guards.get(key)
        if (!this.attached.has(key) || !guard) throw new Error(`Debugger is not attached to the tab with id: ${String(tabNumber)}.`)
        const refused = guard.command(args[1], args[2], this.engine.tabUrl(tabNumber as number) ?? '')
        if (refused) throw new Error(refused)
        const answer = await page.debugSend(String(args[1]), args[2])
        guard.result(String(args[1]), answer)
        return answer
      }
      default:
        throw new Error(`chrome.debugger.${method} is not supported`)
    }
  }

  // ---- chrome.runtime.connectNative / sendNativeMessage ----

  private nativeMessaging(call: ShimCall): unknown {
    const { extensionId, profileId, method, args, context } = call
    switch (method) {
      case 'connect': {
        const [hostName, portId] = args
        if (typeof hostName !== 'string' || typeof portId !== 'string' || portId === '' || this.portProfile.has(portId)) throw new Error('Invalid native port')
        this.portProfile.set(portId, { profileId, extensionId, context })
        this.holdFor(extensionId, profileId, 1)
        this.hosts.connect(extensionId, hostName, portId)
        return undefined
      }
      case 'post': {
        // Only the extension that opened a port can write to it.
        if (this.ownsPort(call, args[0])) this.hosts.post(extensionId, String(args[0]), args[1])
        return undefined
      }
      case 'disconnect': {
        const portId = String(args[0])
        if (!this.ownsPort(call, portId)) return undefined
        this.hosts.disconnect(extensionId, portId)
        this.forgetPort(portId)
        return undefined
      }
      case 'sendMessage': {
        const [hostName, message] = args
        if (typeof hostName !== 'string') throw new Error('Invalid native messaging host name specified.')
        return this.hosts.sendOnce(extensionId, hostName, message)
      }
      default:
        throw new Error(`chrome.runtime.${method} is not supported`)
    }
  }

  private ownsPort(call: ShimCall, portId: unknown): boolean {
    const owner = typeof portId === 'string' ? this.portProfile.get(portId) : undefined
    return owner?.extensionId === call.extensionId && owner.profileId === call.profileId
  }

  private deliverPortEvent(extensionId: string, portId: string, event: PortEvent): void {
    const owner = this.portProfile.get(portId)
    if (!owner) return
    this.engine.emitShimEvent(extensionId, 'nativeMessaging', 'port', [portId, event.type, event.type === 'message' ? event.message : event.error], owner.profileId)
    if (event.type === 'disconnect') this.forgetPort(portId)
  }

  /** A page or worker is gone, or an extension was unloaded: the ports it opened close, and the workers they held awake are let go. */
  private closePortsOf(gone: { context?: string; extensionId?: string; profileId?: string }): void {
    for (const [portId, owner] of [...this.portProfile]) {
      const byContext = gone.context !== undefined && owner.context === gone.context
      const byExtension = gone.context === undefined && gone.extensionId !== undefined && owner.extensionId === gone.extensionId && (gone.profileId === undefined || owner.profileId === gone.profileId)
      if (!byContext && !byExtension) continue
      this.hosts.disconnect(owner.extensionId, portId)
      this.forgetPort(portId)
    }
  }

  private forgetPort(portId: string): void {
    const owner = this.portProfile.get(portId)
    if (!owner) return
    this.portProfile.delete(portId)
    this.holdFor(owner.extensionId, owner.profileId, -1)
  }

  /** While a native port is open the extension's worker is kept awake: the port would die with the worker. */
  private holdFor(extensionId: string, profileId: string, delta: 1 | -1): void {
    const key = `${extensionId}:${profileId}`
    const held = this.holds.get(key)
    if (delta === 1) {
      if (held) held.ports++
      else this.holds.set(key, { release: this.engine.holdWorker(extensionId, profileId), ports: 1 })
      return
    }
    if (!held) return
    held.ports--
    if (held.ports <= 0) {
      held.release()
      this.holds.delete(key)
    }
  }

  // ---- chrome.identity ----

  private async identity({ extensionId, profileId, method, args }: ShimCall): Promise<unknown> {
    if (method !== 'launchWebAuthFlow') throw new Error(`chrome.identity.${method} is not supported in Lucium.`)
    const details = asObject(args[0])
    if (!isAuthPageUrl(details.url)) throw new Error(AUTH_ERRORS.invalidUrl)
    const interactive = details.interactive === true
    const requested = typeof details.timeoutMsForNonInteractive === 'number' && details.timeoutMsForNonInteractive > 0 ? details.timeoutMsForNonInteractive : DEFAULT_AUTH_TIMEOUT_MS
    return this.engine.webAuthFlow(profileId, {
      url: details.url,
      extensionId,
      interactive,
      timeoutMs: Math.min(requested, MAX_AUTH_TIMEOUT_MS),
      abortOnLoad: details.abortOnLoadForNonInteractive !== false
    })
  }

  // ---- chrome.history, chrome.bookmarks, chrome.browsingData ----

  /** The pages of the extension's own profile: another profile's history is not its to read. */
  private profileHistory(profileId: string) {
    if (!this.history) throw new Error('The history is not available here.')
    return this.history.of(profileId)
  }

  private historyApi({ profileId, method, args }: ShimCall): unknown {
    switch (method) {
      case 'search': {
        const query = parseHistoryQuery(args[0], Date.now())
        if (!query) throw new Error("Error in invocation of history.search(object query, function callback): No matching signature.")
        // Only the pages of the asked time range are looked at, not a sorted copy of the whole history.
        return searchHistory(this.profileHistory(profileId).between(query.startTime, query.endTime), query)
      }
      case 'getVisits': {
        const url = historyUrl(args[0])
        if (url === null) throw new Error('Url must be a valid web address.')
        return visitsOf(this.profileHistory(profileId).get(url))
      }
      case 'addUrl':
      case 'deleteUrl':
      case 'deleteRange':
      case 'deleteAll':
        throw new Error(readOnlyError(`history.${method}`))
      default:
        throw new Error(`chrome.history.${method} is not supported`)
    }
  }

  private bookmarksApi({ profileId, method, args }: ShimCall): unknown {
    // The tree is made from the state the interface is given: nothing of a locked space, and nothing at all while the application is locked.
    const state = shownState(this.store.get(), getLockService()?.view())
    const root = bookmarkTree({ favorites: state.favorites, spaces: state.spaces, folders: state.folders, tabs: state.tabs }, profileId)
    const index = bookmarkIndex(root)
    const missing = new Error("Can't find bookmark for id.")
    switch (method) {
      case 'getTree':
        return [root]
      case 'getSubTree': {
        const node = typeof args[0] === 'string' ? index.get(args[0]) : undefined
        if (!node) throw missing
        return [node]
      }
      case 'get': {
        const ids = bookmarkIds(args[0])
        if (!ids) throw new Error('Invalid bookmark id.')
        const found = ids.map((id) => index.get(id))
        if (found.some((node) => node === undefined)) throw missing
        return found.map((node) => bare(node!))
      }
      case 'getChildren': {
        const node = typeof args[0] === 'string' ? index.get(args[0]) : undefined
        if (!node) throw missing
        return (node.children ?? []).map(bare)
      }
      case 'getRecent': {
        const recent = recentBookmarks(root, args[0])
        if (!recent) throw new Error('numberOfItems must be a positive integer.')
        return recent
      }
      case 'search': {
        const found = searchBookmarks(root, args[0])
        if (!found) throw new Error("Error in invocation of bookmarks.search(...): No matching signature.")
        return found
      }
      case 'create':
      case 'update':
      case 'move':
      case 'remove':
      case 'removeTree':
        throw new Error(readOnlyError(`bookmarks.${method}`))
      default:
        throw new Error(`chrome.bookmarks.${method} is not supported`)
    }
  }

  private async browsingDataApi({ profileId, method, args }: ShimCall): Promise<unknown> {
    if (method === 'settings') return browsingDataSettings()
    const shortcut = BROWSING_DATA_METHODS[method]
    if (method !== 'remove' && shortcut === undefined) throw new Error(`chrome.browsingData.${method} is not supported in Lucium.`)
    const parsed = parseBrowsingData(args[0], method === 'remove' ? args[1] : { [shortcut!]: true })
    if (!parsed.ok) throw new Error(parsed.error)
    const { sites, types } = parsed.request
    const engineTypes = types.filter((type): type is Exclude<typeof type, 'history'> => type !== 'history')
    const failures: string[] = []
    for (const site of sites) {
      if (engineTypes.length > 0) {
        for (const result of await this.engine.clearSiteData(profileId, { host: site.host, origins: site.origins, subdomains: false, types: engineTypes })) {
          if (!result.ok) failures.push(`${site.host} (${result.type}): ${result.error ?? 'failed'}`)
        }
      }
      if (types.includes('history')) {
        this.profileHistory(profileId).removeSite(site.host, false)
        // The pages of the site in the Back lists of the archived tabs are history too (see Browser.forgetClosedPages).
        this.browser.forgetClosedPages(profileId, { host: site.host, subdomains: false })
      }
    }
    // The extension is told what did not go, and the log keeps it: a partial erasure must not look complete.
    if (failures.length > 0) {
      console.error('[extensions] chrome.browsingData could not erase everything:', failures.join('; '))
      throw new Error(`Could not erase: ${failures.join('; ')}`)
    }
    return undefined
  }

  // ---- chrome.downloads ----

  private onDownload(info: DownloadInfo, profileId: string): void {
    const before = this.downloads.get(info.id)
    const byExtensionId = this.downloadOwners.get(info.id)
    // The end is the moment the download was first seen ended, not the moment an extension asks: a later update of an ended download keeps it.
    const endedAt = info.state === 'progressing' ? undefined : before?.endedAt !== undefined && before.info.state !== 'progressing' ? before.endedAt : Date.now()
    this.downloads.set(info.id, { info, profileId, ...(byExtensionId ? { byExtensionId } : {}), ...(endedAt !== undefined ? { endedAt } : {}) })
    // The owner is kept on the download itself: once it has ended, the table of owners has nothing more to say about it.
    if (info.state !== 'progressing') this.downloadOwners.delete(info.id)
    if (this.downloads.size > MAX_DOWNLOADS_KEPT) {
      for (const [id, entry] of this.downloads) {
        if (entry.info.state !== 'progressing') this.downloads.delete(id)
        if (this.downloads.size <= MAX_DOWNLOADS_KEPT) break
      }
    }
    const item = toChromeDownload(downloadNumber(info.id), info, byExtensionId, endedAt)
    if (!before) this.broadcast(profileId, 'downloads', 'onCreated', [item])
    const previous = before ? toChromeDownload(downloadNumber(info.id), before.info, byExtensionId, before.endedAt) : undefined
    // chrome.downloads.onChanged reports what changed, not progress: the state, the error and the end of the download.
    const delta: Record<string, unknown> = { id: item.id }
    if (previous && previous.state !== item.state) delta.state = { previous: previous.state, current: item.state }
    if (previous && previous.error !== item.error && item.error) delta.error = { current: item.error }
    if (previous && !previous.endTime && item.endTime) delta.endTime = { current: item.endTime }
    if (Object.keys(delta).length > 1) this.broadcast(profileId, 'downloads', 'onChanged', [delta])
  }

  private visibleDownloads(profileId: string): ChromeDownloadItem[] {
    return [...this.downloads.values()].filter((d) => d.profileId === profileId).map((d) => toChromeDownload(downloadNumber(d.info.id), d.info, d.byExtensionId, d.endedAt)).sort((a, b) => a.id - b.id)
  }

  private async downloadsApi({ extensionId, profileId, method, args }: ShimCall): Promise<unknown> {
    switch (method) {
      case 'download': {
        const options = asObject(args[0])
        if (typeof options.url !== 'string') throw new Error('Invalid URL')
        // A request with a method, headers or a body cannot be handed to the browser's own download: say so instead of doing another one.
        if ((options.method !== undefined && options.method !== 'GET') || options.headers !== undefined || options.body !== undefined) throw new Error('Only plain GET downloads are supported in Lucium.')
        if (options.filename !== undefined && (typeof options.filename !== 'string' || safeDownloadName(options.filename) === null)) throw new Error('Invalid filename')
        const filename = typeof options.filename === 'string' ? options.filename : undefined
        const engineId = await this.engine.startDownload(profileId, options.url, { extensionId, ...(filename !== undefined ? { filename } : {}) })
        const known = this.downloads.get(engineId)
        if (known) known.byExtensionId = extensionId
        // A download that is already over has nothing to wait for: its owner is on the entry above.
        if (!known || known.info.state === 'progressing') this.downloadOwners.set(engineId, extensionId)
        return downloadNumber(engineId)
      }
      case 'search': {
        const query = asObject(args[0])
        const search: DownloadQuery = {
          ...(typeof query.id === 'number' ? { id: query.id } : {}),
          ...(typeof query.url === 'string' ? { url: query.url } : {}),
          ...(typeof query.filename === 'string' ? { filename: query.filename } : {}),
          ...(typeof query.state === 'string' ? { state: query.state } : {}),
          ...(Array.isArray(query.query) ? { query: query.query.filter((t): t is string => typeof t === 'string') } : {}),
          ...(typeof query.limit === 'number' ? { limit: query.limit } : {})
        }
        return searchDownloads(this.visibleDownloads(profileId), search)
      }
      case 'cancel': {
        const id = typeof args[0] === 'number' ? args[0] : -1
        for (const [engineId, entry] of this.downloads) if (entry.profileId === profileId && downloadNumber(engineId) === id) this.engine.cancelDownload(engineId)
        return undefined
      }
      case 'erase': {
        const matches = searchDownloads(this.visibleDownloads(profileId), (() => {
          const query = asObject(args[0])
          return { ...(typeof query.id === 'number' ? { id: query.id } : {}), ...(typeof query.state === 'string' ? { state: query.state } : {}) }
        })())
        for (const item of matches) {
          for (const [engineId] of this.downloads) if (downloadNumber(engineId) === item.id) this.downloads.delete(engineId)
          this.broadcast(profileId, 'downloads', 'onErased', [item.id])
        }
        return matches.map((m) => m.id)
      }
      default:
        throw new Error(`chrome.downloads.${method} is not supported`)
    }
  }
}

/** `dl-12` is the download number 12 for extensions. */
function downloadNumber(engineId: string): number {
  return Number(engineId.slice(engineId.indexOf('-') + 1))
}
