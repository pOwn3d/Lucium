// The live side of one window of the browser. The class is cut into layers by responsibility: its fields and its constructor are in
// browser-base.ts, each browser-*.ts adds the methods of one domain on top of the layer below, and this file is the top of the chain (the order:
// docs/architecture.md).

import { totalmem } from 'node:os'
import { dialog, session } from 'electron'
import type { UiSnapshot } from '@shared/ipc'
import type { DownloadInfo, PeekState, SidebarState } from '@shared/model'
import { PROMPT_CANCELLED } from '@shared/page-dialog'
import { activeTab } from '@shared/sidebar'
import { blockingService } from '../blocking'
import { knownProfiles, profileDownloadDir, spaceOfProfile } from '@shared/profiles'
import { ExtensionActions } from './extension-actions'
import { followWindowFocus } from './window-focus'
import { parseDropTarget } from '@shared/dnd'
import { DRAG_TTL_MS, tabsToDrag } from '@shared/tab-drag'
import { MAIN_WINDOW_KEY, tabsOfEverySpace } from '@shared/window-tabs'
import { redactForLock, redactSnapshotForLock, runtimeOfTabs } from '@shared/lock'
import { isBlockingExempt } from '@shared/blocker'
import { extensionTabPage } from '@shared/chrome-pages'
import { rememberedDecision } from '@shared/permissions'
import type { ExtensionTabHooks } from '../engine/types'
import { ExtensionShims } from './extension-shims'
import { gateAutoArchive } from './auto-archive'
import { AutoReloader } from './auto-reload'
import { showSystemNotice } from './system-notice'
import { batterySaver } from './battery-saver'
import { scrollBarsOfSnapshot, systemScrollBars } from './system-scroll-bars'
import { runTransfer, type TransferResult, type TransferSide } from './tab-transfer'
import { tabIsLive } from '@shared/tab-transfer'
import { NEW_WINDOW, windowMoveRefusal, type WindowChoice } from '@shared/window-move'
import { sendToWindow } from './window-move'
import { PageWatcher } from './page-watch'
import { unmarkedNotice, withDownload } from '@shared/downloads-view'
import { gateDownloadResume } from './download-resume-gate'
import { FaviconService, requestFetch } from './favicon-service'
import { siteIconOwner } from '@shared/site-icon'
import { LiveFolderService } from './live-folders'
import { ResourceWatch } from './resource-watch'
import { memoryPressure } from './sleep-pressure'
import { processMeter } from './process-meter'
import { lookAt } from './live-fetch'
import { webAppRequest, type WebAppRequest } from '@shared/web-apps'
import { addBounded } from '@shared/bounded'
import { gateWebHardware } from './hardware-gate'
import { getLockService } from '../lock-service'
import { getPasswordService } from './password-service'
import { annotateToolbarFlag } from '@shared/page-annotate'
import { testChannelOfSnapshot } from './update-source'
import { t } from '@shared/i18n'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { MAX_DOWNLOADS_KEPT, MEMORY_MAX, SLEEP_SWEEP_MS, type WindowMoves } from './browser-base'
import { BrowserLayout } from './browser-layout'

export { NO_HISTORY, type BrowserOptions, type HistoryLog, type ProfileHistoryLog, type WindowMoves } from './browser-base'

/**
 * Owns the live side of the browser: which tabs have a web view, what is visible, and how
 * the persisted state (StateStore) and the engine stay in sync. Talks to Chromium only
 * through the Engine port.
 */
export class Browser extends BrowserLayout {
  /** How an application window is opened: one for the whole application (every normal window opens them), set while the function is on and absent while it is off. */
  private static webAppOpener: ((request: WebAppRequest) => void) | null = null

  /** The state as each window of the group shows it, this window first: a favourite, a bookmark and the space shown are read from the first. */
  protected viewsFromThisWindow(): SidebarState[] {
    return [this, ...[...this.group].filter((b) => b !== this)].map((b) => b.store.get())
  }

  start(): void {
    // Extensions do not run in a private window, and the hooks of a session are the main window's.
    if (!this.isPrivate() && !this.isSecondary()) {
      const shims = new ExtensionShims(this, this.engine, this.store, this.history)
      this.engine.setShimHandler((call) => shims.handle(call))
      // Settings › Fonctions: the groups that extensions make are shown as folders; off, nothing of it exists.
      this.gates.gate('tab-groups-ext', { start: () => shims.mirrorGroups() })
      this.engine.setActionMenuItems((_profileId, extensionId) => this.actionMenuEntries(extensionId))
      this.engine.setExtensionTabHooks({
        // The tab opens in the window the extension named (Electron's window id), or in this one.
        createTab: (url, active, windowId, profileId) => {
          const target = (windowId === undefined ? undefined : [...this.group].find((b) => b.win.id === windowId)) ?? this
          return target.openTabForExtension(url, active, profileId)
        },
        createWindow: (details) => {
          if (!this.extensionWindows) return Promise.reject(new Error('chrome.windows.create is not available'))
          return this.extensionWindows.create(details)
        },
        removeWindow: (windowId) => this.extensionWindows?.remove(windowId),
        // `chrome.tabs.create({ url: 'chrome://extensions' })`: no tab, the page of Lucium that stands for the address (extensions do not run in a private window).
        openChromePage: (address) => {
          const page = extensionTabPage(address, { private: false, settings: this.store.get().settings })
          if (!page) return false
          if (page.request) this.openOverlay(page.request)
          if (page.notice) this.showToast(page.notice, undefined, ACTION_NOTICE_MS)
          return true
        },
        // The extension runtime reports a tab as active when a window gets its first page: that is the window of the page, not necessarily this one.
        selectTab: (id) => {
          const owner = this.ownerOf(id) ?? this
          if (!owner.quietPages) owner.dispatch({ type: 'tab/select', id })
        },
        removeTab: (id) => (this.ownerOf(id) ?? this).dispatch({ type: 'tab/close', id }),
        // The tab shown in a window: the library only knows the window that last had the focus among those that had a page, which is not always the one clicked.
        activeTabOf: (windowId, profileId) => {
          const shown = [...this.group].find((b) => b.win.id === windowId)?.activeTabFor(profileId)
          return shown ? this.engine.tabNumberOf(shown.id) : undefined
        },
        hasWindow: (windowId) => [...this.group].some((b) => !b.win.isDestroyed() && b.win.id === windowId),
        // The lock hides a tab: its space is locked, or the application is. An extension may not capture the sound of it (shared/tab-capture.ts: `targetRefusal`).
        tabLocked: (tabNumber) => {
          const pageId = this.engine.pageIdOfTabNumber(tabNumber)
          const owner = pageId === undefined ? undefined : this.ownerOf(pageId)
          const tab = owner?.store.get().tabs.find((item) => item.id === pageId)
          return owner !== undefined && tab !== undefined ? owner.isTabLocked(tab) : getLockService()?.isAppLocked() === true
        }
      })
    }
    if (!this.isPrivate() && !this.isSecondary()) {
      this.extensionActions = new ExtensionActions({
        engine: this.engine,
        state: () => this.store.get(),
        dispatch: (action) => this.dispatch(action),
        toast: (message, action) => this.noticeWindow().showToast(message, action),
        confirm: async ({ message, detail, ok }) => {
          const options = { type: 'warning' as const, message, detail, buttons: [ok, t('confirm-box.annuler')], defaultId: 1, cancelId: 1 }
          return (await dialog.showMessageBox(this.noticeWindow().win, options)).response === 0
        },
        // The tab opens in the window the user is working in, not necessarily the main one that holds the actions.
        openExtensions: (profileId, extensionId) => this.noticeWindow().openExtensionsTab(extensionId !== undefined ? { view: 'detail', extensionId, ...(profileId !== undefined ? { profileId } : {}) } : { view: 'list' })
      })
      this.engine.onExtensionReview((ask) => this.askExtensionReview(ask))
      this.engine.onExtensionNotice((message) => this.noticeWindow().showToast(message))
      this.engine.onTabCapture((event) => this.onTabCapture(event))
      this.engine.onExtensionForgotten((profileId, extensionId) => this.forgetTabCaptureConsent(profileId, extensionId))
      this.engine.onExtensionsChanged(() => this.publish())
      this.engine.onExtensionMenu((action, profileId, extensionId) => this.extensionActions?.menu(action, profileId, extensionId))
      this.configureExtensions()
    }
    if (!this.isSecondary()) {
      // The sites the user let open windows without a click (the notice's « Toujours autoriser sur ce site »); the same host rule as the blocker's exceptions.
      this.engine.setPopupPolicy((url) => isBlockingExempt(url, this.store.get().settings.popupExceptions))
      this.engine.setPermissionPolicy({
        lookup: (origin, permission) => rememberedDecision(this.store.get().sitePermissions, origin, permission),
        ask: (origin, permission, pageId, detail) => this.askPermission(origin, permission, pageId, detail),
        hasPanel: (pageId) => this.hasPermissionPanel(pageId),
        screenShareAllowed: () => this.store.get().settings.allowScreenShare
      })
      // One listener: a second one doing the same work published the whole state twice per progress report.
      this.engine.onDownload((download, sourcePageId) => {
        this.noteDownload(download, sourcePageId)
        // A file asked for with "Ouvrir sans l’enregistrer" is opened once it is there.
        if (download.temporary === true && download.state === 'completed' && !this.openedTemporary.has(download.id)) {
          addBounded(this.openedTemporary, download.id, MEMORY_MAX)
          void this.openTemporary(download)
        }
      })
      this.engine.setDownloadDirResolver((profileId) => profileDownloadDir(this.store.get().settings, profileId))
    }
    this.configureBlocker()
    this.configureAutoplay()
    this.configureMediaBridge()
    // A window saved with a material or a translucent background gets it now; with the default look this does nothing.
    this.applyWindowLookHere()
    // A window that is a second view of the main one has its pages refreshed by the main window's browser.
    if (!this.isSecondary()) {
      this.unsubscribeBlocking = blockingService().subscribe((event) => {
        if (event === 'engine') this.refreshBlockerCss()
        else if (!this.isPrivate()) this.publish()
      })
    }
    this.autoReloader = new AutoReloader({ targets: () => this.autoReloadTargets() })
    this.unsubscribe = this.store.subscribe(() => this.sync())
    this.unsubscribeLock = getLockService()?.subscribe(() => this.onLockChange()) ?? null
    this.unsubscribeSaver = batterySaver().subscribe(() => this.applySaver())
    this.unsubscribeScrollBars = systemScrollBars().onChange(() => this.publish())
    if (!this.isPrivate() && !this.isSecondary()) {
      // The interface draws the icon of a site from the copy the engine keeps of it (engine/site-icons.ts). For an icon no page of this run declared (a tab
      // restored and not loaded yet, a favourite, a bookmark), the engine asks here which profile shows it: this window first, then the others of the group.
      this.engine.setSiteIconOwners((iconUrl) => siteIconOwner(iconUrl, this.viewsFromThisWindow()))
      this.pageWatcher = new PageWatcher({
        state: () => ({ enabled: this.store.get().settings.pageWatch, watches: this.store.get().settings.pageWatches }),
        paused: () => batterySaver().active(),
        save: (watches) => this.dispatch({ type: 'settings/update', patch: { pageWatches: watches } }),
        profileLive: (id) => this.store.get().spaces.some((space) => space.profileId === id),
        read: (profileId, url, options) => this.engine.readPageText(profileId, url, options),
        notify: (notice) => showSystemNotice(notice),
        now: () => Date.now(),
        gapMs: () => this.pageWatchGapMs,
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
        log: (level, message) => console[level](message)
      })
    }
    if (!this.isPrivate() && !this.isSecondary()) {
      // Made when the setting is on and dropped when it goes off: a switched-off lookup keeps no subscription, timer, request or cache.
      this.gates.gate('favicons', {
        start: () => {
          const service = new FaviconService({
            store: this.store,
            // Every window of the group, each with the space it shows: a tab of a space nobody looks at can wait.
            views: () => [...this.group].map((b) => b.store.get()),
            hasPage: (id) => [...this.group].some((b) => b.ownsPage(id)),
            dispatch: (action) => this.dispatch(action),
            // The home page is a navigation, which the blocker never cancels; the icon is a picture a page would load, judged as it would be there.
            blocked: (url, pageUrl) => blockingService().filter({ url, resourceType: 'image', pageUrl, pageId: null, documentUrl: pageUrl }, this.store.get().settings, this.extraBlockedHosts),
            followProxy: (ses, what) => this.engine.followProxy(ses, what),
            // The bytes the lookup read to check the icon are its copy: the interface draws them, and the site is not asked again.
            keepIcon: (iconUrl, bytes, contentType) => void this.engine.keepSiteIcon(iconUrl, bytes, contentType)
          })
          this.faviconService = service
          service.start()
          return () => {
            service.stop()
            if (this.faviconService === service) this.faviconService = null
          }
        }
      })
    }
    // WebHID, WebUSB and Web Serial: installed on the profiles' sessions only while the setting is on, and everything granted is taken back when it goes off.
    if (!this.isPrivate() && !this.isSecondary()) gateWebHardware(this.gates, this.engine, () => this.store.get().settings, (message) => this.showToast(message))
    // Document Picture-in-Picture (the floating window of a call): the engine takes the window Electron would destroy only while the feature is on, for every
    // window; switched off, the windows that are open close. The lock closes them with their pages (`onLockChange`).
    if (!this.isPrivate() && !this.isSecondary()) {
      this.gates.gate('document-pip', {
        start: () => {
          this.engine.setDocumentPictureInPicture(true)
          return () => this.engine.setDocumentPictureInPicture(false)
        }
      })
    }
    // Resuming downloads after a restart: the engine reads its file of records only while the setting is on (see download-resume-gate.ts).
    if (!this.isPrivate() && !this.isSecondary()) {
      gateDownloadResume(this.gates, {
        engine: this.engine,
        store: this.store,
        options: { profileLive: (profileId) => knownProfiles(this.store.get()).includes(profileId), notify: (message) => this.showToast(message) },
        adopt: (rows) => this.adoptSavedDownloads(rows),
        drop: () => this.dropSavedDownloads()
      })
    }
    if (!this.isPrivate() && !this.isSecondary()) {
      // Live folders (docs/fonctions.md): made when the setting is on, dropped when it goes off. The service arms no timer until a folder is live, and a
      // private window never has one. Its requests carry no cookie: they go through a session of their own that lives in memory and keeps nothing.
      this.gates.gate('live-folders', {
        start: () => {
          const ses = session.fromPartition('lucium-live-folders')
          // The session is on the user's proxy like every other one (see ElectronEngine.setProxies), and a request waits for the change under way.
          const proxy = this.engine.followProxy(ses, 'the live folders')
          const fetchLike = requestFetch(ses, () => proxy.settled())
          const service = new LiveFolderService({
            state: () => ({ enabled: this.store.get().settings.liveFolders, folders: this.store.get().folders }),
            paused: () => batterySaver().active(),
            look: (source, signal) => lookAt(fetchLike, source, { signal, ...(this.liveAllowHost ? { allowHost: this.liveAllowHost } : {}) }),
            dispatch: (action) => this.dispatch(action),
            now: () => Date.now(),
            startDelayMs: () => this.liveStartDelayMs(),
            gapMs: () => this.liveGapMs,
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
            log: (level, message) => console[level](message)
          })
          this.liveFolderService = service
          const unsubscribe = this.store.subscribe(() => service.refresh())
          service.start()
          return () => {
            unsubscribe()
            service.stop()
            proxy.release()
            if (this.liveFolderService === service) this.liveFolderService = null
          }
        }
      })
    }
    this.win.on('resize', () => this.layout())
    this.watchScreen()
    // The focus of the window, for the video behind a space: the sidebar's own document loses it to the pages of the window (window-focus.ts).
    const tellFocus = followWindowFocus(this.win, () => [this.win.webContents, this.floating.current()?.webContents])
    tellFocus(this.win.webContents)
    this.floating.onMade((view) => tellFocus(view.webContents))
    // A zoom the interface pages were last left at (Chromium remembers it for the file) is put right once they have loaded.
    for (const wc of [this.win.webContents, this.overlay.webContents]) wc.once('did-finish-load', () => this.syncUiZoom(true))
    this.floating.onMade((view) => view.webContents.once('did-finish-load', () => this.syncUiZoom(true)))
    // No timer at all while tabs are never put to sleep (the delay is "Jamais").
    this.gates.gate('sleep', {
      start: () => {
        const timer = setInterval(() => {
          void this.sleepSweep().catch((error: unknown) => console.error('[sleep] the sweep failed:', error))
          // The ring of the resources at the foot of the sidebar is read at this beat (the main window only has a watch): no timer of its own while its panel is closed.
          this.resourceWatch?.sweep()
        }, SLEEP_SWEEP_MS)
        return () => clearInterval(timer)
      }
    })
    // The ring of the resources at the foot of the sidebar and its panel (docs/fonctions.md, `resource-gauge`), for the whole group: the main window's only.
    if (!this.isPrivate() && !this.isSecondary()) this.gates.gate('resource-gauge', { start: () => this.startResourceWatch() })
    // A private window has no archive to sweep into; the main window sweeps the shared one. No timer and no pass while archiving is off everywhere.
    if (!this.isPrivate() && !this.isSecondary()) gateAutoArchive(this.gates, () => this.dispatch({ type: 'archive/sweep' }))
    // The launch loads what the windows show (this sync, and the sync of each window restored) and the tabs the user keeps alive, not every tab
    // at once: index.ts calls `wakeAtLaunch` of the main window once the windows are restored, so that what they show is known.
    this.sync()
  }

  /** A download changed (any context): kept in the list the downloads panel shows. */
  protected noteDownload(download: DownloadInfo, sourcePageId: string | undefined): void {
    const isNew = !this.downloads.some((d) => d.id === download.id)
    // A download started by a tab that never showed a page is just a link: the tab goes, in the window it lives in.
    const owner = (sourcePageId ? this.ownerOf(sourcePageId) : undefined) ?? this
    if (isNew && sourcePageId && !owner.committed.has(sourcePageId)) owner.dispatch({ type: 'tab/close', id: sourcePageId })
    this.downloads = withDownload(this.downloads, download, this.dismissedDownloads, MAX_DOWNLOADS_KEPT)
    if (sourcePageId && download.state === 'progressing') this.downloadSources.set(download.id, sourcePageId)
    else this.downloadSources.delete(download.id)
    // The file arrived, and the system could not be told that it comes from the Internet: the user is told it will not be checked at its first opening.
    if (download.unmarked === true && download.state === 'completed') this.showToast(unmarkedNotice(download.filename))
    this.publish()
  }

  /** Opens a tab for an extension in this window (a blank page without an address) and gives it a page at once. */
  async openTabForExtension(url: string | undefined, active: boolean, profileId?: string): Promise<string> {
    // The page of an extension that is loaded here (an options page, a panel opened in a tab) may be opened by an extension.
    const extensionPage = url !== undefined && this.engine.listExtensions().some((e) => url.startsWith(`chrome-extension://${e.id}/`))
    // The tab opens in a space of the profile of the extension that asked: its page would otherwise be given the cookies of another profile.
    const spaceId = profileId === undefined ? undefined : spaceOfProfile(this.store.get(), profileId)
    if (profileId !== undefined && spaceId === undefined) throw new Error('There is no space for the profile of this extension.')
    // `container: null`: the tab is the extension's profile's, whatever the user's rules say about the address (an extension's tab is one for the extension runtime).
    const before = new Set(this.store.get().tabs.map((t) => t.id))
    this.openedBy('extension', () => this.dispatch({ type: 'tab/open', url: url ?? 'about:blank', background: !active, container: null, ...(spaceId !== undefined ? { spaceId } : {}), ...(extensionPage ? { allowExtensionPages: true } : {}) }))
    // Only a tab that was not there before is the extension's. The state opens nothing for an address a tab cannot hold (`data:`, `blob:`, one too
    // long, a locked space): the last tab of the state is then the user's, perhaps of another profile, and the extension is told of the refusal instead.
    const tab = this.store.get().tabs.find((t) => !before.has(t.id))
    if (!tab) throw new Error('This address cannot be opened in a tab.')
    // The page of a tab in a locked space is made when the space is unlocked.
    if (this.isTabLocked(tab)) return tab.id
    if (active) {
      this.ensurePage(tab)
      return tab.id
    }
    // A tab asked for in the background (`chrome.tabs.create({ active: false })`) stays there. The extension runtime calls each new page "active",
    // which selected the tab in spite of what the extension asked; closing it then showed its neighbour, not the tab that was on screen.
    this.quietPages = true
    try {
      this.ensurePage(tab)
    } finally {
      this.quietPages = false
    }
    // The extension runtime took the page just made for the one that is active: it is told which tab really is.
    const shown = activeTab(this.store.get())
    if (shown && this.pages.has(shown.id)) this.engine.activatePage(shown.id)
    return tab.id
  }

  /** How extension windows are opened and closed: set by the application, which owns the window managers. */
  setExtensionWindows(windows: { create: (details: Parameters<ExtensionTabHooks['createWindow']>[0]) => Promise<number>; remove: (windowId: number) => void }): void {
    this.extensionWindows = windows
  }

  /**
   * The window is put away (macOS: the main window closed while the application goes on, see WindowManager) or comes back. Away, it is as a
   * closed window: what is open over it goes, the pages it holds are dropped (their tabs sleep and load again when shown), and no sync makes one
   * again until it comes back. Its state, its hooks of the session and its gates go on.
   */
  putAway(away: boolean): void {
    if (this.away === away) return
    this.away = away
    if (away) {
      this.closeOverlay()
      this.destroyPeek()
      this.destroySidePanel()
      this.destroyWebPanel()
      if (this.find) this.endFind()
      for (const id of [...this.pages.keys()]) this.destroyPage(id, true)
    }
    this.sync()
  }

  /** Whether the window is put away (see `putAway`). */
  isAway(): boolean {
    return this.away
  }

  stop(): void {
    this.publishQueue.cancel()
    // A closed window must not come back to life when the shared state changes.
    this.unsubscribe?.()
    this.unsubscribeLock?.()
    this.unsubscribeSaver?.()
    this.unsubscribeScrollBars?.()
    this.pageWatcher?.stop()
    this.stopWatchingScreen()
    this.unsubscribeBlocking?.()
    this.guard.stop()
    for (const guard of this.scopeGuards.values()) guard.stop()
    this.autoReloader?.stop()
    // A login this window was offered to save goes with the window, not three minutes later.
    if (this.passwordView) getPasswordService()?.forgetWindow(this.passwordView)
    // Stops the lookup of site icons, the sleep sweep and the archive sweep.
    this.gates.disposeAll()
    if (this.floatTimer) clearTimeout(this.floatTimer)
    this.endSlide()
    if (this.splitDrag?.endTimer) clearTimeout(this.splitDrag.endTimer)
    if (this.tabDragExpiry) clearTimeout(this.tabDragExpiry)
    this.dropCycle()
    this.peek?.page.destroy()
    this.sidePanel?.page.destroy()
    this.webPanel?.page.destroy()
    // The console of the extensions is no longer listened to for the pages this window held.
    this.internalPages.dispose()
    for (const page of this.pages.values()) page.destroy()
    this.pages.clear()
    this.privatePages.clear()
    this.pageContainer.clear()
    this.forgetTabDrag()
    this.group.delete(this)
    this.releasePrivateContext(true)
    // A prompt nobody can answer any more is a refusal; the page waiting for it must not hang.
    for (const answer of this.permissionAnswers.values()) answer(false)
    this.permissionAnswers.clear()
    this.permissionPages.clear()
    for (const { resolve } of this.authAnswers.values()) resolve(null)
    this.authAnswers.clear()
    for (const answer of this.reviewAnswers.values()) answer(false)
    this.reviewAnswers.clear()
    for (const { resolve } of this.dialogAnswers.values()) resolve(PROMPT_CANCELLED)
    this.dialogAnswers.clear()
    // Closing the window never waits for "Quitter ce site ?": nobody is left to answer it.
    for (const { resolve } of this.leaveAnswers.values()) resolve(false)
    this.leaveAnswers.clear()
    this.dialogQueue.length = 0
    for (const answer of this.passphraseAnswers.values()) answer(null)
    this.passphraseAnswers.clear()
  }

  snapshot(): UiSnapshot {
    const lock = getLockService()?.view()
    const raw = this.store.get()
    // What the lock hides is not in the state the interface is given (see redactForLock); the state itself is untouched.
    const state = lock ? redactForLock(raw, lock) : raw
    const runtime = this.withReloadMarks(this.withReloadAt(this.withBackCloses(this.mediaPlayers.length > 0 ? { ...this.runtimeOfGroup(), media: [...this.mediaPlayers] } : this.runtimeOfGroup())))
    // Nor is what the snapshot carries beside the state: the lock screen of the application is told nothing of the downloads, extensions or panels.
    return redactSnapshotForLock({
      state,
      // Nor is the life of those tabs: their ids would be in it.
      runtime: state === raw ? runtime : runtimeOfTabs(runtime, state),
      engine: this.engine.info(),
      extensions: this.engine.listAllExtensions(),
      downloads: this.leader.downloads,
      find: this.find,
      peek: this.peek
        ? ({ url: this.peek.url, title: this.peek.title, canGoBack: this.peek.canGoBack ?? false, canGoForward: this.peek.canGoForward ?? false, loading: this.peek.loading ?? false, ...(this.peek.faviconUrl ? { faviconUrl: this.peek.faviconUrl } : {}) } satisfies PeekState)
        : null,
      ...this.scrollSyncedOfSnapshot(raw),
      // The page annotation (on by default; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run only): the toolbar shows its button only then.
      ...annotateToolbarFlag(process.env),
      ...this.saverOfSnapshot(),
      // The system always shows the scroll bars: the lists that hide theirs draw them (shared/scroll-bars.ts).
      ...scrollBarsOfSnapshot(),
      // The build carries a test update channel (a second sealed address): the Settings offer the choice only then.
      ...testChannelOfSnapshot(),
      sidePanel: this.sidePanel ? { extensionId: this.sidePanel.extensionId, name: this.sidePanel.name } : null,
      ...this.webPanelOfSnapshot(),
      toast: this.toast
        ? {
            id: this.toast.id,
            message: this.toast.message,
            durationMs: this.toast.durationMs,
            ...(this.toast.action ? { action: this.toast.action } : {}),
            ...(this.toast.secondAction ? { secondAction: this.toast.secondAction } : {}),
            ...(this.toast.detail !== undefined ? { detail: this.toast.detail } : {}),
            ...(this.toast.progress ? { progress: { ...this.toast.progress } } : {})
          }
        : null,
      platform: process.platform,
      ...(this.floatVisible && this.floatPhase ? { floating: this.floatPhase } : {}),
      ...(this.overlayRequest?.panel === 'plus' ? { plusOpen: true } : {}),
      ...(this.isPrivate() ? { private: true, ...(this.options.guest === true ? { guest: true } : {}) } : { blocking: blockingService().status() }),
      ...(lock ? { lock } : {}),
      ...this.foreignDragOfSnapshot(),
      // With windows of their own, the tabs of every window in each space (« Gérer les espaces »).
      ...this.spaceTabsOfSnapshot(raw, state),
      ...this.windowNamesOfSnapshot(),
      // The sidebar this window chose for itself (its side, docked): the interface places it; absent while it follows the new windows.
      ...(this.sidebarChoice.side !== undefined || this.sidebarChoice.docked === true ? { windowSidebar: this.sidebarChoice } : {}),
      ...this.memoryGaugeOfSnapshot(lock?.appLocked === true),
      ...this.reloadOfSnapshot()
    } satisfies UiSnapshot, lock)
  }

  /**
   * The gate of 'resource-gauge' starts the watch of the group (shell/resource-watch.ts): the ring is read once here, then at the beat of the sleep
   * sweep, and refreshed every 2 s only while a panel is open in some window. What it returns stops it: the windows lose the ring.
   */
  private startResourceWatch(): () => void {
    const watch = new ResourceWatch({
      measure: processMeter(),
      totalMb: totalmem() / 1024 / 1024,
      // One reader of the pressure for the sweep and the gauge (shell/sleep-pressure.ts, its last reading kept 30 s), as the level macOS prints.
      pressure: () => memoryPressure().then((level) => (level === 'critical' ? 4 : level === 'warning' ? 2 : 1)),
      onGauge: () => this.publish(),
      paused: () => getLockService()?.isAppLocked() === true
    })
    this.resourceWatch = watch
    watch.prime()
    return () => {
      watch.dispose()
      if (this.resourceWatch === watch) this.resourceWatch = null
      // A window that is closing (the application quits) is told nothing.
      if (!this.win.isDestroyed()) this.publish()
    }
  }

  /** The watch of the resource panel for this window's group: the main window's, while 'resource-gauge' is on; null in a private window. */
  resources(): ResourceWatch | null {
    return this.isPrivate() ? null : this.leader.resourceWatch
  }

  /**
   * The tabs each space holds in every window, when this window lists only its own (windows of their own); nothing otherwise, and nothing while a
   * lock hides part of the state (`shown` is not the window's view `view`): the numbers would tell what the lock hides.
   */
  private spaceTabsOfSnapshot(view: SidebarState, shown: SidebarState): Pick<UiSnapshot, 'spaceTabs'> {
    if (shown !== view) return {}
    const counts = tabsOfEverySpace(this.store.root().get(), view)
    return counts ? { spaceTabs: counts } : {}
  }

  /** The ring at the foot of the sidebar, read by the main window for the group: absent while its function is off, in a private window, before its first reading and while the application is locked. */
  private memoryGaugeOfSnapshot(appLocked: boolean): Pick<UiSnapshot, 'memoryGauge'> {
    const gauge = appLocked ? null : this.resources()?.gauge()
    return gauge ? { memoryGauge: gauge } : {}
  }

  // ---- tabs dragged from one window to another ----

  /** The key the window manager gives this window: `main` for the first one, `window-2`… for the others. */
  private windowKey(): string {
    return this.options.windowId ?? MAIN_WINDOW_KEY
  }

  /** The split views whose panes scroll together (the pressed "Défilement synchronisé" of their bar, the badge on their divider): only those that exist, and only while the setting that offers it is on. */
  private scrollSyncedOfSnapshot(state: SidebarState): Pick<UiSnapshot, 'scrollSyncedSplits'> {
    if (!state.settings.scrollSync || this.syncedSplits.size === 0) return {}
    const ids = state.splits.filter((split) => this.syncedSplits.has(split.id)).map((split) => split.id)
    return ids.length > 0 ? { scrollSyncedSplits: ids } : {}
  }

  /** The drag of tabs going on in another window of the group, for this window's list to take a drop of it. Nothing without another window, in a private window, or for this window's own drag. */
  private foreignDragOfSnapshot(): Pick<UiSnapshot, 'foreignDrag'> {
    if (this.isPrivate() || this.group.size < 2) return {}
    const drag = this.leader.tabDrags.live()
    return drag && drag.sourceKey !== this.windowKey() ? { foreignDrag: { token: drag.token, tabs: drag.tabs } } : {}
  }

  /**
   * Tab rows of this window's sidebar start to be dragged: the other windows are told (they show where a drop would go) and the drag is remembered here,
   * not trusted from the drag itself. Only a normal window with a sibling does anything; the tabs a lock hides are never the interface's to drag.
   */
  beginTabDrag(ids: unknown): void {
    if (this.isPrivate() || this.group.size < 2 || this.namesLockedTarget({ ids })) return
    const tabs = tabsToDrag(this.store.get(), ids)
    if (tabs.length === 0) return
    const leader = this.leader
    leader.tabDrags.begin(this.windowKey(), tabs)
    // A drag nobody ended must not leave the marks on the other windows for ever.
    if (leader.tabDragExpiry) clearTimeout(leader.tabDragExpiry)
    leader.tabDragExpiry = setTimeout(() => this.publishToOthers(), DRAG_TTL_MS + 100)
    leader.tabDragExpiry.unref()
    this.publishToOthers()
  }

  /** The drag of this window is over, dropped or not. A drop that comes just after is still taken (see `TabDragLedger`). */
  endTabDrag(): void {
    if (this.leader.tabDrags.end(this.windowKey())) this.publishToOthers()
  }

  /** This window closes in the middle of a drag: the other windows stop showing it. */
  private forgetTabDrag(): void {
    if (this.leader.tabDrags.forget(this.windowKey())) this.publishToOthers()
  }

  /** Tells the other windows of the group, not this one: the drag it starts or ends is not shown to the window it comes from (a new snapshot in the middle of its own drag has no use). */
  private publishToOthers(): void {
    for (const browser of this.group) if (browser !== this) browser.publishQueue.request()
  }

  /**
   * Tabs another window was dragging are dropped at `rawTarget` of this window's list: they move to the space this window shows, and their pages are made
   * again here (see shell/tab-transfer.ts). What is dragged comes from the drag the other window announced, never from the message.
   */
  dropForeignTabs(rawTarget: unknown): void {
    const target = parseDropTarget(rawTarget)
    if (this.isPrivate() || !target) return
    const drag = this.leader.tabDrags.claim()
    if (!drag) return
    const source = [...this.group].find((b) => b !== this && b.windowKey() === drag.sourceKey && !b.win.isDestroyed())
    const lock = getLockService()
    if (source) {
      const ids = drag.tabs.map((tab) => tab.id)
      const result = runTransfer(
        this.store.root(),
        { appLocked: () => lock?.isAppLocked() === true, spaceLocked: (spaceId) => lock?.isSpaceLocked(spaceId) === true },
        source.transferSide(),
        this.transferSide(),
        ids,
        target
      )
      // A history carried for a page that was never made here would stay for ever.
      for (const id of ids) this.carriedHistory.delete(id)
      // A drop does not bring a window to the front: the tabs that landed here are the ones the user works with now (the keys go to the window in front).
      if (result === 'moved' && !this.win.isDestroyed()) this.win.focus()
    }
    this.publish()
  }

  /** This window as one side of a move of tabs between windows. */
  private transferSide(): TransferSide {
    return {
      key: this.windowKey(),
      isPrivate: this.isPrivate(),
      state: () => this.store.get(),
      dispatch: (action) => this.dispatch(action),
      toast: (message) => this.showToast(message),
      history: (id) => this.ownerOf(id)?.pages.get(id)?.navigationEntries(),
      release: (id) => this.ownerOf(id)?.destroyPage(id),
      carry: (id, history) => void this.carriedHistory.set(id, history),
      adopt: (id) => {
        const owner = this.ownerOf(id)
        return owner === this ? this.pages.has(id) : owner !== undefined && this.adoptPage(owner, id)
      },
      confirmReload: (ids) =>
        !this.hasLivePage(ids) ||
        dialog.showMessageBoxSync(this.win, { type: 'warning', buttons: [t('ctx.deplacer'), t('confirm-box.annuler')], defaultId: 1, cancelId: 1, message: t('tabtransfer.page-rechargee-appel-coupe') }) === 0
    }
  }

  /** Whether the page of one of these tabs is in a call or playing, in whichever window it lives: making it again would cut that. */
  hasLivePage(ids: readonly string[]): boolean {
    const tabs = this.runtimeOfGroup().tabs
    return ids.some((id) => tabIsLive(tabs[id]))
  }

  // ---- a tab sent to another window from its menu (Déplacer vers la fenêtre) ----

  /** The window manager tells a normal window where its tabs can be sent; a private window is told nothing. */
  setWindowMoves(moves: WindowMoves | null): void {
    this.windowMoves = moves
  }

  /** The other normal windows a tab of this window can go to, as the menu lists them. None from a private window. */
  windowMoveChoices(): WindowChoice[] {
    return this.isPrivate() || !this.windowMoves ? [] : this.windowMoves.targets()
  }

  /**
   * Sends a tab, with the other panes of its split view, to another window of the group, or to a new one (`NEW_WINDOW`): the move a drag onto that window's
   * sidebar makes (shell/tab-transfer.ts), to the space it shows (shared/window-move.ts says where). The live page goes as it is when its session stays the
   * same (a call, a video, a form go on); one that would be made again in another profile while it plays is asked about first. Nothing moves between a
   * private window and a normal one. The window the tab leaves stays open, on the tab next to it or on nothing. A new window opened for a move that is
   * then refused is closed again.
   */
  sendTabToWindow(tabId: string, targetId: string): TransferResult {
    const moves = this.windowMoves
    const known = targetId === NEW_WINDOW ? undefined : moves?.browserOf(targetId)
    const to = targetId === NEW_WINDOW ? NEW_WINDOW : known ? { key: known.windowKey(), private: known.isPrivate() } : null
    // Asked before a window is opened for it: a refused move opens none.
    if (!moves || windowMoveRefusal(this.store.get(), tabId, { key: this.windowKey(), private: this.isPrivate() }, to) !== null) return 'refused'
    const target = known ?? moves.open()
    const lock = getLockService()
    const { result, ids } = sendToWindow(
      this.store.root(),
      { appLocked: () => lock?.isAppLocked() === true, spaceLocked: (spaceId) => lock?.isSpaceLocked(spaceId) === true },
      this.transferSide(),
      target.transferSide(),
      tabId
    )
    // A history carried for a page that was never made there would stay for ever (as after a drop).
    for (const id of ids) target.carriedHistory.delete(id)
    if (result !== 'moved' && known === undefined && !target.win.isDestroyed()) target.win.close()
    // The tab is the one the user works with now: its window comes to the front (a new one does as it shows itself).
    else if (result === 'moved' && known !== undefined && !known.win.isDestroyed()) known.win.focus()
    return result
  }

  /** The names the command bar and the naming panel need: nothing at all while windows cannot be named. */
  private windowNamesOfSnapshot(): Pick<UiSnapshot, 'windows' | 'windowName'> {
    if (!this.windowNames || !this.store.get().settings.nameWindows) return {}
    const own = this.windowNames.own()
    return { windows: this.windowNames.others(), ...(own !== undefined ? { windowName: own } : {}) }
  }

  // ---- state ----

  /** With the tab tree, a tab opened from a page hangs under the tab of that page (the reducer decides whether it can); without it, nothing is added to the action. */
  protected treeParent(openerId: string | undefined): { parentId?: string } {
    return openerId !== undefined && this.store.get().settings.tabTree ? { parentId: openerId } : {}
  }

  /** Registers how to open a site as an application (set while the function is on: see index.ts). */
  static setWebAppOpener(opener: ((request: WebAppRequest) => void) | null): void {
    Browser.webAppOpener = opener
  }

  /** "Ouvrir comme application": the tab (the one on screen without `tabId`) in a window of its own. Does nothing while the function is off, in a private window, or for a page that is not a web page. */
  openAsApp(tabId?: string): void {
    if (this.isPrivate()) return
    const request = webAppRequest(this.store.get(), tabId)
    // A tab the lock hides is not opened in a window of its own: that window would show the live page.
    if (request && !this.isTabLocked(request)) Browser.webAppOpener?.(request)
  }
}
