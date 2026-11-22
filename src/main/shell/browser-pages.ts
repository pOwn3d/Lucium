// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The pages of the tabs: their creation, their
// events, their adoption by another window, their end, and what follows a change of a page.


import { shell } from 'electron'
import type { ClosedHistory, SidebarState, TabItem } from '@shared/model'
import { failedAfter } from '@shared/tab-state'
import { sameData } from '@shared/row-equality'
import type { UnreadReading } from '@shared/tab-messages'
import { LEAVE_FULLSCREEN, fullscreenReported, type FullscreenStep } from '@shared/html-fullscreen'
import { parseCssColor } from '@shared/theme'
import { profileOfSpace } from '@shared/profiles'
import { linkWindowDestination } from '@shared/little-modifier'
import { isOwnSite } from '@shared/party'
import { httpsFallbackNotice } from '@shared/privacy'
import { SCREEN_RECORDING_SETTINGS_URL, screenSettingsLabel } from '@shared/display-media'
import { READ_THEME_COLORS_SCRIPT, pickThemeColor, type ThemeColorMeta } from '@shared/toolbar'
import { markUsed } from '@shared/profile-recovery'
import { activeTab, splitFor } from '@shared/sidebar'
import { paneTakesFocus } from '@shared/split'
import { hostOf, isNavigableUrl, resolveInput } from '@shared/url'
import { isInternalPageUrl } from '@shared/internal-page'
import { SAVER_CSS } from '@shared/battery-saver'
import { CERTIFICATE_NOTICE_MS, clientCertificateNotice } from './certificates'
import { isDeveloperUrl } from '@shared/developer-mode'
import type { Page, PageEvents, PageUpdate } from '../engine/types'
import { autoplayModeFor, mustRebuildForAutoplay } from '@shared/autoplay'
import { batterySaver } from './battery-saver'
import { relayEvents } from './tab-transfer'
import { setBounded } from '@shared/bounded'
import { getPasswordService } from './password-service'
import { notifyPageDocument } from './page-annotate'
import { getLanguage, t } from '@shared/i18n'
import { targetLanguage } from '@shared/translate-local'
import { FULLSCREEN_LEAVE_TIMEOUT_MS, MEMORY_MAX, pageRelays, type ProfileHistoryLog } from './browser-base'
import { BrowserTools } from './browser-tools'

export abstract class BrowserPages extends BrowserTools {
  protected ensurePage(tab: TabItem): Page {
    const existing = this.pages.get(tab.id)
    if (existing) return existing
    const space = this.store.get().spaces.find((s) => s.id === tab.spaceId)
    // A private tab (not in a private window, where every tab is) has its page in the private context, whatever space it sits in.
    const isolated = tab.private === true && !this.isPrivate()
    // A tab in a container has its page in the container's session, whatever space it sits in (the space's profile is left alone, as for a private tab).
    const container = this.containerKeyOf(tab)
    this.creating.add(tab.id)
    let page: Page
    let made: Page | undefined
    try {
      const autoplay = autoplayModeFor(this.store.get().settings, tab.url)
      const engine = isolated ? this.privateContext() : container !== '' ? this.containerContext(container) : this.engine
      // The events of a page that was destroyed (and perhaps made again under the same id) come late: they say nothing about the tab any more (see `pageEvents`).
      const current = (): boolean => made === undefined || this.pages.get(tab.id) === made
      // Relayed: the page may go to another window as it is, and its events with it (see `adoptPage`).
      const relay = relayEvents(this.pageEvents(tab, current))
      page = engine.createPage({ id: tab.id, profileId: space?.profileId ?? 'default', windowId: this.options.windowId, autoplay }, relay.events)
      made = page
      pageRelays.set(page, relay.retarget)
      this.pages.set(tab.id, page)
      this.pageSession.set(tab.id, this.sessionKeyOf(tab))
      this.pageAutoplay.set(tab.id, autoplay)
      if (isolated) this.privatePages.add(tab.id)
      if (container !== '') this.pageContainer.set(tab.id, container)
      this.guardPage(tab.id)
      if (this.cycleWatching) page.watchKeys(this.cycleKey)
    } finally {
      this.creating.delete(tab.id)
    }
    // The page of a private tab leaves its space's profile alone: nothing is marked as used, no storage is expected on disk for it.
    if (!isolated && container === '') this.noteProfileUsed(space?.profileId)
    this.idleSince.set(tab.id, Date.now())
    this.runtime = {
      ...this.runtime,
      tabs: { ...this.runtime.tabs, [tab.id]: { loading: true, audible: false, muted: false, awake: true } }
    }
    const carried = this.carriedHistory.get(tab.id)
    this.carriedHistory.delete(tab.id)
    const history = this.reopened.take(tab)
    // Taken whatever follows: a list is offered once, to the first page the tab gets after its sleep.
    const slept = this.leader.slept.take(tab, this.sessionKeyOf(tab))
    // A page rebuilt for the autoplay rule goes back to where it was; a reopened tab goes back through the pages it had, and so does a tab that
    // wakes from a sleep that freed its page; otherwise the address.
    if (carried && page.restoreHistory(carried)) {
      // the rebuilt page keeps its own pages
    } else if (history ?? slept) this.restoreHistory(tab, page, (history ?? slept)!)
    else page.loadURL(tab.url)
    this.internalPages.reconcile()
    return page
  }

  /**
   * A page keeps the autoplay mode it was made with, so a tab that goes on to a site with another mode gets a new page: it is built again
   * on the address it reached, with the history of the old one carried over (the cost is one more load of that page). Only the tab on screen:
   * a background tab gets the right mode when its page is made next. Two rebuilds of one tab are `AUTOPLAY_REBUILD_GAP_MS` apart at least.
   */
  private autoplayRebuildWanted(id: string): boolean {
    const tab = this.store.get().tabs.find((t) => t.id === id)
    if (!tab || !this.pages.has(id) || !this.visible.has(id) || this.creating.has(id)) return false
    return mustRebuildForAutoplay({ applied: this.pageAutoplay.get(id), wanted: autoplayModeFor(this.store.get().settings, tab.url), lastRebuildAt: this.autoplayRebuiltAt.get(id), now: Date.now() })
  }

  private rebuildForAutoplay(id: string): void {
    const page = this.pages.get(id)
    const tab = this.store.get().tabs.find((t) => t.id === id)
    if (!page || !tab || !this.autoplayRebuildWanted(id)) return
    const now = Date.now()
    setBounded(this.autoplayRebuiltAt, id, now, MEMORY_MAX)
    this.carriedHistory.set(id, page.navigationEntries())
    this.destroyPage(id)
    this.sync()
    // A page that was not made by the sync above (a window being closed…) must not carry the history of a page that is gone into a later one.
    this.carriedHistory.delete(id)
  }

  /** A reopened tab goes back through its pages; when the engine cannot replay them the tab opens at its address, as before. */
  private restoreHistory(tab: TabItem, page: Page, history: ClosedHistory): void {
    void page.restoreClosedHistory(history.entries, history.index).catch((error: unknown) => {
      console.warn(`[archive] the pages of tab ${tab.id} could not be restored:`, (error as Error).message)
      try {
        // A page that failed to load still has its entries: only an empty list needs the address.
        if (page.navigationEntries().entries.length === 0) page.loadURL(tab.url)
      } catch (gone) {
        console.warn(`[archive] tab ${tab.id} was closed before its address could be loaded:`, (gone as Error).message)
      }
    })
  }

  /** The first page of a profile marks it as used: its storage is expected on disk from now on (see profile-recovery.ts). */
  protected noteProfileUsed(profileId: string | undefined): void {
    if (!profileId || this.isPrivate() || markUsed(this.store.get().settings.usedProfiles, profileId) === this.store.get().settings.usedProfiles) return
    // Not now: a page is created while the state is being applied to the windows.
    queueMicrotask(() => this.dispatch({ type: 'profile/used', id: profileId }))
  }

  /** `current` tells whether the page these events belong to is still the tab's page: a page that was destroyed keeps reporting for a while (`close()` is asynchronous). */
  private pageEvents(tab: TabItem, current: () => boolean = () => true): PageEvents {
    return {
      update: (patch) => {
        if (current()) this.onPageUpdate(tab.id, patch)
        // A new address is a new document for the annotation of the page (its layer starts again): see shell/page-annotate.ts.
        const page = this.pages.get(tab.id)
        if (current() && patch.url !== undefined && page) notifyPageDocument(tab.id, page)
      },
      mediaChanged: () => {
        if (current()) this.mediaChanged(tab.id)
      },
      fullscreen: (on) => {
        if (current()) this.htmlFullscreen(tab.id, on)
      },
      // The page closed itself: the tab goes with it, as a window closes when its page calls window.close().
      closed: () => this.dispatch({ type: 'tab/close', id: tab.id }),
      httpsFallback: (host) => this.showToast(httpsFallbackNotice(host)),
      authenticate: (challenge) => this.authenticate(tab.id, challenge),
      promptDialog: (request, signal) => this.askPrompt(tab.id, request, signal),
      askLeave: (site) => this.askLeave(tab.id, site),
      // A form with a password was submitted (the page bridge exists only while the password manager is on, and never in a private context).
      passwordSubmitted: (frameUrl, submission) => getPasswordService()?.submitted(this.passwordWindow(), { privateTab: tab.private === true, frameUrl, untrustedCertificate: this.runtime.tabs[tab.id]?.untrustedCertificate === true }, submission),
      externalLinkFailed: (scheme) => this.showToast(t('browser.aucune-application-n-a-pu-ouvrir-ce-lien-scheme', { scheme })),
      // Said in the window of the tab, with the site: the page may show nothing but a failure, and the reason is not the site's to give.
      clientCertificateRefused: (site) => this.showToast(clientCertificateNotice(site), undefined, CERTIFICATE_NOTICE_MS),
      // The permission is the user's to give: the notice opens the very pane, where Lucium is already listed by the request that just failed.
      screenShareBlocked: (notice, openSettings) =>
        openSettings && process.platform === 'darwin'
          ? this.showToast(notice, { label: screenSettingsLabel(), run: () => void shell.openExternal(SCREEN_RECORDING_SETTINGS_URL).catch((error: unknown) => console.warn('[display-media] cannot open System Settings:', error)) }, 15_000)
          : this.showToast(notice),
      devToolsFailed: (message, retry) => this.devToolsNotice(message, retry),
      // Only for the page the user is looking at: what a tab behind tries has nobody to tell.
      // The notice offers the one window it refused: opened in a tab, on the user's word only (the address was checked by the engine).
      popupBlocked: (site, url) => {
        if (!this.visible.has(tab.id)) return
        const open = () => this.openTabFromPage(tab, url, 'foreground', true)
        // « Toujours autoriser » is for the site on screen (the page that tried), and asks nothing more afterwards.
        const allow = () => {
          const pageUrl = this.store.get().tabs.find((item) => item.id === tab.id)?.url ?? ''
          const host = hostOf(pageUrl)
          const list = this.store.get().settings.popupExceptions
          if (host && !list.includes(host)) this.dispatch({ type: 'settings/update', patch: { popupExceptions: [...list, host] } })
          open()
        }
        // « Toujours autoriser » writes the site in the settings, which are saved: not offered for a private tab, whose site must leave nothing.
        const privateTab = (this.store.get().tabs.find((item) => item.id === tab.id) ?? tab).private === true
        this.showToast(t('browser.fenetre-bloquee-sur-site-la-page-l-a-ouverte-sans-clic', { site }), { label: t('browser.ouvrir-quand-meme'), run: open, ...(privateTab ? {} : { second: { label: t('browser.toujours-autoriser-sur-ce-site'), run: allow } }) })
      },
      openWindow: (url, disposition, byPage = false, chromium?: string, features?: string) => {
        const current = this.store.get().tabs.find((t) => t.id === tab.id)
        // A mini window only where one can open (a private or guest window has no opener) and never from a private tab: ⌥⌘-clic, and a link that would open a
        // new tab on another site. The choice is shared/little-modifier.ts `linkWindowDestination`.
        const where = linkWindowDestination(
          { disposition, byPage, chromium, features, url, pageUrl: current?.url, privateTab: (current ?? tab).private === true, littleAvailable: this.littleOpener !== null && !this.isPrivate() },
          this.store.get().settings,
          isOwnSite
        )
        // The window is made with the profile of this tab's space, and archived there: not the space another window happens to show.
        if (where === 'little') this.littleOpener?.(url, { spaceId: (current ?? tab).spaceId, from: this.windowBounds() })
        else if (where === 'peek') this.openPeek(url, tab.id)
        else this.openTabFromPage(tab, url, disposition, byPage)
      },
      // "Copier l'adresse du lien" in the page's menu: the same cleaning as the other ways to copy an address.
      copyLink: (url) => this.copyable(url),
      focused: () => {
        // A click or a key in another pane of a split view moves the focus there (the ring, the strip and the selected tab follow).
        const state = this.store.get()
        const active = activeTab(state)
        if (paneTakesFocus(active?.id, active ? splitFor(state, active.id)?.tabIds : undefined, tab.id)) this.dispatch({ type: 'tab/select', id: tab.id })
      },
      // The page's sharing took a window: if it is a window of Lucium, that window is the shared one (see annotateSharedWindow).
      ownWindowShared: (picked: string) => this.annotateSharedWindow(picked),
      domReady: () => {
        const page = this.pages.get(tab.id)
        if (current() && page) notifyPageDocument(tab.id, page)
        // The page has finished loading: the empty tabs it opened go now, if they are still empty and unused (not before: a popup is still coming).
        this.blankTabs.closeOpenedBy(tab.id)
        // A new document starts at the zoom the tab has: its site's, or the tab's own for a page that has no host (kept until the page goes, `dropPageState`).
        this.applyBoost(tab.id, true)
        this.restoreScrollOnce(tab.id)
        this.applyUserScripts(tab.id)
        this.applyThemeToPage(tab.id, true)
        this.appliedDark.delete(tab.id)
        this.applyDarkToPage(tab.id)
        this.blockerCss.fresh(tab.id)
        this.applyBlockerCss(tab.id)
        this.guardPage(tab.id)
        // A new document starts without the battery saver's stylesheet.
        if (batterySaver().active()) this.pages.get(tab.id)?.applyCss(SAVER_CSS, 'saver')
      },
      found: (result) => {
        if (tab.id !== this.shownTabId || !this.find) return
        // A new result replaces the last one whole: an error or a "more" of the search before must not outlive it.
        const { text, regex } = this.find
        this.find = { text, ...(regex ? { regex } : {}), matches: result.matches, ordinal: result.ordinal, ...(result.error ? { error: result.error } : {}), ...(result.more ? { more: true } : {}) }
        this.publish()
      },
      copyAsMarkdown: () => void this.copySelectionAsMarkdown(tab.id).catch((error: unknown) => console.error('[markdown] cannot copy the selection:', error)),
      searchSelection: (text) => {
        // In the space the tab is in now, with the search engine of that space's profile.
        const now = this.tabNow(tab)
        const resolved = resolveInput(text, this.searchTemplateFor(profileOfSpace(this.store.get(), now.spaceId)))
        if (resolved && !isNavigableUrl(resolved.url)) return this.showToast(t('browser.adresse-invalide'))
        if (resolved) this.dispatch({ type: 'tab/open', url: resolved.url, spaceId: now.spaceId, ...(now.private === true ? { private: true } : this.inheritedContainer(now, resolved.url)), ...this.treeParent(tab.id) })
      },
      clearSiteData: () => void this.quickClearSite(tab.id),
      summarize: (length) => this.openSummaryTab(length),
      // « Traduire en <langue> » / « Afficher l'original »: done at once, without the panel.
      translatePage: () => this.translateTabNow(tab.id),
      translateTarget: () => targetLanguage(this.store.get().settings, getLanguage()),
      fakeFill: (x, y) => void this.fillFakeForm(tab.id, x, y).catch((error: unknown) => console.warn('[fake-fill] the form could not be filled:', error)),
      // The shortcut is for the site the tab shows now, not the one its page was created on.
      ...(tab.private === true ? {} : { createShortcut: () => this.openOverlay({ panel: 'shortcut', url: this.tabNow(tab).url, title: this.tabNow(tab).title }) }),
      canOpenUnsaved: () => this.store.get().settings.openUnsaved,
      toolMessage: (message) => this.onToolMessage(tab.id, message),
      sitePictureInPicture: () => void this.takeSitePictureInPicture(tab.id).catch((error: unknown) => console.error('[pip] the site\'s Picture in Picture could not be taken into Lucium\'s window:', error instanceof Error ? error.message : String(error))),
      pageTools: () => this.toolsFor(tab.id),
      menuOptions: () => this.menuOptionsFor(tab.id),
      // The language of a page is read only while the translation is on: switched off, nothing runs in the pages for it.
      readsLanguage: () => this.store.get().settings.translateLocal,
      // The sites the user put in Developer Mode (⌃D): their invalid certificate goes through without a question, and the tab says « Non sécurisé ».
      developerSite: (url) => isDeveloperUrl(url, this.store.get().settings.developerHosts),
      qrCode: (url) => this.openOverlay({ panel: 'qr', text: url }),
      toggleGestureSite: () => this.toggleGestureSite(tab.id)
    }
  }

  /**
   * Destroys the page of a tab. `forSleep`: the tab stays and will get a page again (a sleep, the window put away), so its Back / Forward list is
   * kept in memory for that page; every other end of a page (the tab closed, another session, a pinned tab back at its address) keeps nothing.
   */
  protected destroyPage(id: string, forSleep = false): void {
    const page = this.pages.get(id)
    if (!page) return
    if (forSleep) {
      const tab = this.store.get().tabs.find((t) => t.id === id)
      if (tab) this.leader.slept.keep(tab, this.pageSession.get(id) ?? this.sessionKeyOf(tab), () => page.navigationEntries())
    }
    // A page that holds the window in full screen leaves it before it is destroyed: Electron does not give the window back when the page goes in full screen.
    if (this.fullscreenTab === id) {
      this.fullscreenTab = null
      page.hide()
      void this.leaveHtmlFullscreen(id).finally(() => page.destroy())
    } else page.destroy()
    this.dropPageState(id)
  }

  /** Forgets all this window knew of the page of a tab: the page was destroyed, or went to another window as it is. */
  private dropPageState(id: string): void {
    this.pages.delete(id)
    this.privatePages.delete(id)
    this.pageContainer.delete(id)
    this.pageSession.delete(id)
    this.scrollRestored.delete(id)
    this.cancelAuthOf(id)
    this.cancelDialogsOf(id)
    this.cancelLeaveOf(id)
    this.cancelPermissionsOf(id)
    this.volatileZoom.delete(id)
    this.idleSince.delete(id)
    this.unread.forget(id)
    this.forgetTranslation(id)
    this.committed.delete(id)
    this.pageAutoplay.delete(id)
    if (!this.store.get().tabs.some((t) => t.id === id)) this.autoplayRebuiltAt.delete(id)
    this.appliedTheme.delete(id)
    this.appliedDark.delete(id)
    this.darkScans.delete(id)
    this.blockerCss.forget(id)
    this.guardOfPage(id)?.forget(id)
    this.visible.delete(id)
    this.colorUnread.delete(id)
    this.frozen.delete(id)
    this.autoFrozen.delete(id)
    // The reason of an empty tab that was unmarked is traced only while the tab exists.
    this.blankTabs.dropTraceIfGone(id)
    this.autoReloader?.forget(id)
    // "Actualiser tous les onglets" stops waiting for a page that is gone from here (its place goes to the next sleeping tab).
    this.loadEnds.get(id)?.()
    clearTimeout(this.mediaDue.get(id))
    this.mediaDue.delete(id)
    const { [id]: _gone, ...rest } = this.runtime.tabs
    const tab = this.store.get().tabs.find((t) => t.id === id)
    // A pinned or sleeping tab stays in the sidebar, flagged as not awake.
    this.runtime = {
      ...this.runtime,
      tabs: tab ? { ...rest, [id]: { loading: false, audible: false, muted: false, awake: false } } : rest
    }
    // A page that is gone has no media left to drive.
    this.pruneMediaPlayers()
    this.leader.releasePrivateContext()
    // The console of the extensions is listened to for the pages that exist, and this one no longer does.
    this.internalPages.reconcile()
  }

  /** The session the page of a tab is made in: the private context (a private tab of a normal window), its container's, or the profile of its space. */
  private sessionKeyOf(tab: TabItem): string {
    if (tab.private === true && !this.isPrivate()) return 'private'
    const container = this.containerKeyOf(tab)
    return container !== '' ? `container:${container}` : `profile:${this.store.get().spaces.find((s) => s.id === tab.spaceId)?.profileId ?? 'default'}`
  }

  /**
   * Takes the live page of a tab from another window of the group as it is: a call, a video, a form go on, nothing loads again. Only a page made in
   * the session the tab has here, that the engine can carry, and that does not hold its window in full screen. False when it cannot (nothing
   * changed): the caller lets the page go, and the tab loads again here as before. What belongs to the screen of the other window (a box it asked
   * for the page, its timers) ends there; what the page is (zoom, autoplay mode, frozen) comes along.
   */
  protected adoptPage(owner: this, id: string): boolean {
    const page = owner.pages.get(id)
    // From the state every window shares: with windows that have tabs of their own, a tab dropped here is listed here only once the page has come.
    const tab = this.store.root().get().tabs.find((t) => t.id === id)
    const retarget = page ? pageRelays.get(page) : undefined
    if (!page || !tab || !retarget || owner === this || this.pages.has(id) || this.creating.has(id) || owner.creating.has(id) || owner.fullscreenTab === id) return false
    if (owner.engine !== this.engine || owner.isPrivate() || this.isPrivate() || owner.pageSession.get(id) !== this.sessionKeyOf(tab)) return false
    // A page lent to the floating video window comes back to its tab first: it goes from there, not from the floating window.
    this.leader.floatingVideo?.release(id)
    if (page.moveToWindow?.(this.options.windowId) !== true) return false
    this.pages.set(id, page)
    this.pageSession.set(id, this.sessionKeyOf(tab))
    if (owner.privatePages.has(id)) this.privatePages.add(id)
    const container = owner.pageContainer.get(id)
    if (container !== undefined) this.pageContainer.set(id, container)
    const autoplay = owner.pageAutoplay.get(id)
    if (autoplay !== undefined) this.pageAutoplay.set(id, autoplay)
    const rebuiltAt = owner.autoplayRebuiltAt.get(id)
    if (rebuiltAt !== undefined) setBounded(this.autoplayRebuiltAt, id, rebuiltAt, MEMORY_MAX)
    const zoom = owner.volatileZoom.get(id)
    if (zoom !== undefined) this.volatileZoom.set(id, zoom)
    if (owner.committed.has(id)) this.committed.add(id)
    if (owner.frozen.has(id)) this.frozen.add(id)
    if (owner.autoFrozen.has(id)) this.autoFrozen.add(id)
    if (owner.colorUnread.has(id)) this.colorUnread.add(id)
    this.idleSince.set(id, Date.now())
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [id]: owner.runtime.tabs[id] ?? { loading: false, audible: false, muted: false, awake: true } } }
    // The player the other window opened for it as it left its screen has nothing to show there: the page is on screen here.
    if (owner.mediaPlayers.includes(id)) {
      owner.mediaPlayers = owner.mediaPlayers.filter((player) => player !== id)
      owner.releaseMedia(id)
    }
    // The other window forgets it first: its guard may be this window's too (a private tab, a container), and must not forget what is applied below.
    owner.dropPageState(id)
    retarget(this.pageEvents(tab, () => this.pages.get(id) === page))
    page.watchKeys(this.cycleWatching ? this.cycleKey : null)
    this.guardPage(id)
    this.internalPages.reconcile()
    return true
  }

  /**
   * The history a visit of this tab goes to: the one of the profile of its space, whichever space is shown, and which records the space (a locked space
   * keeps its pages to itself, see history.ts). Null for a private tab, and for a tab in a container (the profile's history would tell what was browsed in another identity).
   */
  private historyOf(tab: TabItem): ProfileHistoryLog | null {
    return tab.private !== true && this.containerKeyOf(tab) === '' ? this.history.of(profileOfSpace(this.store.get(), tab.spaceId), tab.spaceId) : null
  }

  /** What the row of a tab shows of its unread messages changed with no title to say it (a held badge ran out, or the tab came on screen): the windows are told. */
  protected refreshUnread(id: string): void {
    const entry = this.runtime.tabs[id]
    if (!entry) return
    const { unread: _count, unreadMark: _mark, ...rest } = entry
    const shown = this.unread.current(id)
    const next = { ...rest, ...(shown?.count !== undefined ? { unread: shown.count } : {}), ...(shown?.mark !== undefined ? { unreadMark: shown.mark } : {}) }
    if (sameData(entry, next)) return
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [id]: next } }
    this.publish()
  }

  private onPageUpdate(id: string, patch: PageUpdate): void {
    // What a page off screen changes (its title, its icon, its loading) reaches the windows grouped over a moment, the store's own publication
    // included (it runs inside the dispatch below); the page on screen, at once.
    const background = !this.visible.has(id)
    const leader = this.leader
    if (background) leader.backgroundEvents++
    try {
      this.handlePageUpdate(id, patch)
    } finally {
      if (background) leader.backgroundEvents--
    }
  }

  private handlePageUpdate(id: string, patch: PageUpdate): void {
    const { title, faviconUrl, loading, audible, canGoBack, canGoForward, trackActions } = patch
    // What the interface is shown of this tab before the event: an event that changes none of it publishes nothing (see the end).
    const before = { entry: this.runtime.tabs[id], canGoBack: this.runtime.canGoBack, canGoForward: this.runtime.canGoForward }
    // Chromium reports its error page as a navigation; keep the URL the user actually asked for.
    const url = patch.url?.startsWith('chrome-error://') ? undefined : patch.url
    if (url !== undefined) this.committed.add(id)
    // An address the page committed (not the blank one) makes the tab a used one: it is never closed as an empty tab.
    if (url !== undefined) this.blankTabs.addressCommitted(id, url)
    // A page with something behind it has been navigated: the tab is a tab like any other from now on, Back goes back in it.
    if (canGoBack === true && this.store.get().tabs.some((t) => t.id === id && t.openerId !== undefined)) this.store.dispatch({ type: 'tab/forget-origin', id })
    if (url !== undefined || title !== undefined || faviconUrl !== undefined) {
      // The engine reports the address its page committed: when that is the Extensions page (a Back or a Forward onto it, or a tab that was sent away and came back), the state
      // follows the page, so that the tab is the page again for its gate. Only in a window that has extensions; the reducer refuses it for a private tab or a container's.
      const onPage = url !== undefined && isInternalPageUrl(url) && !this.isPrivate()
      this.store.dispatch({ type: 'tab/update', id, patch: { url, title, faviconUrl }, ...(onPage ? { allowInternalPages: true } : {}) })
    }
    // Only a page whose mode is not the one its address wants costs anything (a timer, outside the page's own event: the page is destroyed and made again).
    if (url !== undefined && this.autoplayRebuildWanted(id)) setTimeout(() => this.rebuildForAutoplay(id), 0).unref()
    if (loading === false) {
      const tab = this.store.get().tabs.find((t) => t.id === id)
      // The page belongs to the history of the profile of its space, whichever space is shown. A private tab leaves no trace in it.
      // A tab in a container leaves none either: the profile's history would tell what was browsed in another identity.
      // Neither does a load that came to no page: a frame that loaded inside the page (`visit` false), a download, or one of our error pages (the site does not answer).
      if (tab && patch.visit !== false && this.pages.get(id)?.showsError() !== true) this.historyOf(tab)?.record(tab.url, tab.title)
      // The colour is read by a script in the page, which only the bar above a page on screen shows: a page that loaded off screen has it
      // read when it comes on screen (sync), not at each load of a tab in the background.
      if (this.visible.has(id)) void this.refreshPageColor(id)
      else this.colorUnread.add(id)
      if (tab) this.discoverSearch(id, tab.url)
    }
    // A page names itself once it has loaded: the history keeps the title it ended with (see `HistoryStore.retitle`), not the one of the page before.
    if (title !== undefined && loading !== false) {
      const tab = this.store.get().tabs.find((t) => t.id === id)
      if (tab && this.pages.get(id)?.showsError() !== true) this.historyOf(tab)?.retitle(tab.url, tab.title)
    }
    // A frozen page cannot start loading by itself: someone navigated it, which gives it a live document again.
    if (loading === true && this.frozen.delete(id)) this.setAwake(id, true)
    const { failed: wasFailed, unread: _wasUnread, unreadMark: _wasMark, changedIcon: wasIcon, untrustedCertificate: wasUntrusted, pageLanguage: wasLanguage, translation: wasTranslation, ...current } =
      this.runtime.tabs[id] ?? { loading: false, audible: false, muted: false, awake: true }
    // A new document: the language and the translation of the one before are over. The language a page tells is another one than the target (or '').
    const fresh = patch.newDocument === true
    const pageLanguage = patch.pageLanguage ?? (fresh ? '' : (wasLanguage ?? ''))
    const translation = fresh ? undefined : wasTranslation
    // The icon's address is only compared (the image is never read, nothing is sent): a change while the tab is in the background gets its dot, if the switch is on.
    const iconMarked =
      faviconUrl !== undefined && this.store.get().settings.tabStateBadges
        ? this.markIcon(id, faviconUrl, (loading ?? this.runtime.tabs[id]?.loading) === true, wasIcon === true)
        : false
    // A load that ended on one of our error pages marks the tab as failed (the row's red dot); the next load clears it.
    const failed = failedAfter(wasFailed === true, loading, loading === false && this.pages.get(id)?.showsError() === true)
    // The unread messages are read from the title the page sent, not from the tab's title: a pinned tab keeps a tidied title that has no count (tidy.ts). A page
    // that blinks its title does not make the badge blink: what a title said is held for a moment (shell/unread-watch.ts).
    const known = this.runtime.tabs[id]
    const unread: UnreadReading | undefined =
      title === undefined ? (known?.unread !== undefined ? { count: known.unread } : known?.unreadMark !== undefined ? { mark: known.unreadMark } : undefined) : this.unread.title(id, title, this.store.get().tabs.find((t) => t.id === id)?.url ?? '')
    // A certificate let through for the page's site (« Non sécurisé »): the page tells it with each address it commits, and when something it loads came over one.
    const untrusted = patch.untrustedCertificate ?? wasUntrusted === true
    this.runtime = {
      canGoBack: id === this.shownTabId && canGoBack !== undefined ? canGoBack : this.runtime.canGoBack,
      canGoForward: id === this.shownTabId && canGoForward !== undefined ? canGoForward : this.runtime.canGoForward,
      tabs: {
        ...this.runtime.tabs,
        [id]: {
          ...current,
          ...(failed ? { failed: true as const } : {}),
          ...(untrusted ? { untrustedCertificate: true as const } : {}),
          ...(unread?.count !== undefined ? { unread: unread.count } : {}),
          ...(unread?.mark !== undefined ? { unreadMark: unread.mark } : {}),
          ...(iconMarked ? { changedIcon: true as const } : {}),
          ...(pageLanguage !== '' ? { pageLanguage } : {}),
          ...(translation ? { translation } : {}),
          loading: loading ?? current.loading,
          audible: audible ?? current.audible,
          ...(trackActions ? { previous: trackActions.previous, next: trackActions.next } : {}),
          ...(canGoBack !== undefined ? { canGoBack } : {}),
          ...(canGoForward !== undefined ? { canGoForward } : {})
        }
      }
    }
    // The translation of the document before is over (after the runtime above, which no longer shows it: nothing more is published for it). A page that
    // tells another language than the target is translated by itself when « Toujours traduire » says so.
    if (fresh) this.forgetTranslation(id)
    if (patch.pageLanguage) this.translateIfAlways(id, patch.pageLanguage)
    // A page that finished loading starts its automatic reload's countdown again, and one that "Actualiser tous les onglets" woke may go back to sleep.
    const countdownBefore = loading === false ? this.autoReloader?.countdownOf(id)?.at : undefined
    if (loading === false) this.autoReloader?.loaded(id)
    if (loading === false) this.loadEnds.get(id)?.()
    // Sound that starts or stops, and a page that finished loading, are the other signs (besides the media events) that a player's tab changed what it does.
    if (audible !== undefined || loading === false) this.mediaChanged(id)
    // Only a change is published: a title, an icon or an address go through the store, which publishes its own change; what is left is the
    // life of the tab (loading, sound, unread count, history…) and its countdown. A frame that ends its loading in a page that already shows
    // as loaded, the same title sent again, publish nothing to the windows.
    const changed =
      !sameData(before.entry, this.runtime.tabs[id]) ||
      before.canGoBack !== this.runtime.canGoBack ||
      before.canGoForward !== this.runtime.canGoForward ||
      (loading === false && this.autoReloader?.countdownOf(id)?.at !== countdownBefore)
    if (changed) this.publish()
  }

  /** A page went in or out of HTML full screen: while one holds the window it fills it (shared/html-fullscreen.ts). */
  private htmlFullscreen(tabId: string, on: boolean): void {
    const step: FullscreenStep = fullscreenReported(this.fullscreenTab, tabId, on, this.visible)
    const changed = step.tab !== this.fullscreenTab
    this.fullscreenTab = step.tab
    if (step.leave !== null) void this.leaveHtmlFullscreen(step.leave)
    if (changed) {
      this.layout()
      this.publish()
    }
  }

  /**
   * Asks a page to leave full screen, and resolves when it did (or gave up: a page that does not answer in a second). If the page cannot be asked (it is gone, it
   * does not answer), the window it held in full screen is given back so that it does not stay stuck there.
   */
  protected async leaveHtmlFullscreen(tabId: string): Promise<void> {
    const page = this.pages.get(tabId)
    const giveBack = (reason: string): void => {
      console.warn(`[fullscreen] page ${tabId} could not be asked to leave full screen (${reason}): the window leaves it`)
      if (!this.win.isDestroyed() && this.win.isFullScreen()) this.win.setFullScreen(false)
    }
    if (!page) return giveBack('no page')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answered = await Promise.race([page.evaluate(LEAVE_FULLSCREEN).then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), FULLSCREEN_LEAVE_TIMEOUT_MS)))])
      if (!answered) giveBack('no answer')
    } catch (error) {
      giveBack(error instanceof Error ? error.message : String(error))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Reads the colour a page declares (its `theme-color`) once it has loaded: the toolbar above it takes that colour; a page that declares none keeps the default bar. */
  protected async refreshPageColor(id: string): Promise<void> {
    const page = this.pages.get(id)
    if (!page) return
    let color: string | null = null
    try {
      const metas = await page.evaluate(READ_THEME_COLORS_SCRIPT)
      color = Array.isArray(metas) ? parseCssColor(pickThemeColor(metas as ThemeColorMeta[])) : null
    } catch (error) {
      console.warn(`[toolbar] cannot read the colour of page ${id}:`, (error as Error).message)
    }
    const current = this.runtime.tabs[id]
    if (!current || current.color === (color ?? undefined)) return
    const before = this.toolbarLine()
    const { color: _old, ...rest } = current
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [id]: color ? { ...rest, color } : rest } }
    // A light bar has a line that takes a row of the page's place: the page moves when the colour (and so the line) changes.
    if (this.toolbarLine() !== before) this.layout()
    this.publish()
  }

  /**
   * A page lives in the session it was made in (`sessionKeyOf`): a tab that went into a container, left one, whose container is gone, or whose space
   * now belongs to another profile gets a new page (it loads its address again, with the cookies of the new one). Each window looks at its own pages
   * at its sync: the window that changed the profile of a space dropped its pages at once (`dispatch`), the others held theirs in the old session.
   */
  protected rebuildPagesOfChangedSession(state: SidebarState): void {
    if (this.pages.size === 0) return
    const tabs = new Map(state.tabs.map((t) => [t.id, t]))
    for (const id of [...this.pages.keys()]) {
      const tab = tabs.get(id)
      const made = this.pageSession.get(id)
      if (tab && made !== undefined && made !== this.sessionKeyOf(tab)) this.destroyPage(id)
    }
  }
}
