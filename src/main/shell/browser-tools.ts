// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). What runs beside the pages of the tabs: the
// battery saver, the live folders, the watch of a page, and the in-page tools (mouse gestures, Vim keys, synchronized scrolling) with what
// they ask of the window. Cut out of browser-pages.ts as it was: the pages (browser-pages.ts) stand on it.

import { randomUUID } from 'node:crypto'
import type { TabItem } from '@shared/model'
import type { UiSnapshot } from '@shared/ipc'
import { tabName } from '@shared/model'
import { profileOfSpace } from '@shared/profiles'
import { containerForUrl, containerOfTab } from '@shared/containers'
import { openTabMode } from '@shared/link-open'
import { activeTab, splitFor } from '@shared/sidebar'
import { hostnameOf } from '@shared/url'
import { SAVER_CSS, saverNotice } from '@shared/battery-saver'
import { gestureAction, type GestureAction } from '@shared/gestures'
import { NO_PAGE_TOOLS, type PageTools, type ToolMessage } from '@shared/page-tools'
import { anyToolWanted, pageToolsFor } from '@shared/page-tools-for'
import { scrollMemory } from '../scroll-memory-store'
import { carriesScrollSync, syncTargets } from '@shared/scroll-sync'
import { isSiteExcluded, setSiteExcluded } from '@shared/sleep'
import { summaryAvailable } from '@shared/ollama'
import type { PageMenuOptions } from '../engine/types'
import { batterySaver } from './battery-saver'
import { PAGE_WATCH_DEFAULT_MINUTES, addWatch, isWatchableUrl } from '@shared/page-watch'
import { getLanguage, t } from '@shared/i18n'
import { targetLanguage } from '@shared/translate-local'
import { BrowserMedia } from './browser-media'

export abstract class BrowserTools extends BrowserMedia {
  /**
   * What a tab opens from a page stays in the container of that page, unless the user's rule sends the address elsewhere:
   * the rule is then left to the reducer. Nothing at all for a tab outside any container.
   */
  protected inheritedContainer(tab: Pick<TabItem, 'private' | 'container'>, url: string): { container?: string } {
    const container = containerOfTab(this.store.get().settings, tab)
    return container && containerForUrl(this.store.get().settings, url) === undefined ? { container: container.id } : {}
  }

  /**
   * A tab as the state has it now. The events of a page are made once, with the tab as it was when the page was created: since then the tab may have
   * gone to another site or been moved to another space, and what the page asks for is about where it is, not where it started.
   */
  protected tabNow<T extends Pick<TabItem, 'id'>>(tab: T): T | TabItem {
    return this.store.get().tabs.find((item) => item.id === tab.id) ?? tab
  }

  // ---- battery saver ----

  /** The mode came on or went off (the charge, the power source, the menu): the pages, the reload countdowns and the menu follow. */
  protected applySaver(): void {
    const on = batterySaver().active()
    for (const page of this.pages.values()) page.applyCss(on ? SAVER_CSS : '', 'saver')
    this.autoReloader?.refresh()
    // The looks at the watched pages wait while the mode is on, and start again when it ends.
    this.pageWatcher?.schedule()
    this.publish()
  }

  /** Whether the battery saver is on (the hover cards take no more pictures meanwhile). */
  powerSaving(): boolean {
    return batterySaver().active()
  }

  /** What the snapshot says of the mode: the sidebar pauses the video behind a space while it is on (`applySaver` publishes each change). */
  protected saverOfSnapshot(): Pick<UiSnapshot, 'batterySaverOn'> {
    return batterySaver().active() ? { batterySaverOn: true } : {}
  }

  /** Why the video behind a space is held still by itself (a call, a load: shell/video-load-guard.ts), for every window of the group; nothing while it plays. */
  protected videoPauseOfSnapshot(): Pick<UiSnapshot, 'videoLoadPause'> {
    const reason = this.leader.videoPause
    return reason ? { videoLoadPause: reason } : {}
  }

  /** View › Mode économie de batterie: on whatever the charge, or off again. A notice says so. */
  setBatterySaverAsked(on: boolean): void {
    if (!this.store.get().settings.batterySaver) return
    batterySaver().setAsked(on)
    this.showToast(saverNotice(on))
  }

  /** The menu entry: asked for if it was not, off again if it was. It reads the mode itself, not the menu, which may not have been rebuilt yet. */
  toggleBatterySaverAsked(): void {
    this.setBatterySaverAsked(!batterySaver().askedByHand())
  }

  // ---- watching a page for changes ----

  /** The single timer of the live folders is armed (the engine test reads it: no folder, no timer). */
  liveFoldersArmed(): boolean {
    return this.liveFolderService?.armed() === true
  }

  /** Whether the live folders are being read at all in this window, and how many looks were made (the engine test). */
  liveFoldersRunning(): { running: boolean; looks: number } {
    return { running: this.liveFolderService !== null, looks: this.liveFolderService?.looks ?? 0 }
  }

  /** The engine test shortens the pause between two looks, lets the local test server be asked, and starts without the launch delay. */
  setLiveFoldersTest(options: { gapMs: number; allowHost: (host: string) => boolean }): void {
    this.liveGapMs = options.gapMs
    this.liveAllowHost = options.allowHost
    this.liveStartDelay = 0
  }

  /** Diagnostics for the engine test: whether the schedule's single timer is armed, and the pause between two looks (shortened by the test). */
  pageWatchArmed(): boolean {
    return this.pageWatcher?.armed() === true
  }

  /** Whether a watched page is being read now (the engine test waits for a look to end before it changes the page). */
  pageWatchBusy(): boolean {
    return this.pageWatcher?.busy() === true
  }

  setPageWatchGap(ms: number): void {
    this.pageWatchGapMs = ms
  }

  /**
   * File › Surveiller cette page: the page on screen joins the list of watched pages (every hour at first; the list in Réglages changes
   * that). With `zone`, the user first points at the part of the page to watch. The notice says what happened, a refusal included.
   */
  async watchPage(zone: boolean): Promise<void> {
    this.followPaneFocus()
    const state = this.store.get()
    if (this.isPrivate() || !state.settings.pageWatch) return
    const tab = activeTab(state)
    if (!tab || !isWatchableUrl(tab.url)) return void this.showToast(t('browser.seules-les-pages-web-http-ou-https-peuvent-etre'))
    // A private tab keeps nothing: its address would go into the settings (state.json, the copies, an export), and the looks would load it with the
    // cookies of the profile, tying the private visit to the profile's identity.
    if (tab.private === true) return void this.showToast(t('browser.page-privee-non-surveillable'))
    // The looks at a watched page use the session of the profile, which is not the container's: they would read another identity's page.
    if (this.containerKeyOf(tab) !== '') return void this.showToast(t('browser.page-de-conteneur-non-surveillable'))
    let selector: string | undefined
    if (zone) {
      const picked = await this.pages.get(tab.id)?.pickElement()
      // Escape, or the page changed meanwhile: nothing was chosen.
      if (!picked) return
      selector = picked
    }
    const next = this.store.get()
    const result = addWatch(next.settings.pageWatches, { url: tab.url, title: tabName(tab), profileId: profileOfSpace(next, tab.spaceId), minutes: PAGE_WATCH_DEFAULT_MINUTES, ...(selector ? { selector } : {}) }, randomUUID())
    if ('error' in result) return void this.showToast(result.error)
    this.dispatch({ type: 'settings/update', patch: { pageWatches: result.watches } })
    this.showToast(zone ? t('browser.zone-surveillee-notification') : t('browser.page-surveillee-notification'), { label: t('settings.reglages'), run: () => this.settingsOpener?.('tools') })
  }

  // ---- web tools that run in the pages: autoscroll, mouse gestures, synchronized scrolling ----

  /** The tools a tab's page carries: what the settings switched on, minus the gestures on a site that is left out. All off costs one comparison. */
  protected toolsFor(tabId: string): PageTools {
    const state = this.store.get()
    if (!anyToolWanted(state.settings)) return NO_PAGE_TOOLS
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return NO_PAGE_TOOLS
    // Where a private tab or a private window scrolled is never kept: the tool is not even put in the page.
    return pageToolsFor(state.settings, tab.url, carriesScrollSync(state.settings.scrollSync, this.syncedSplits, splitFor(state, tabId)?.id), tab.private !== true && !this.isPrivate())
  }

  /** Tells every live page which tools it carries now (a setting changed, a split view was told to scroll together). Nothing at all while the tools are off and were off. */
  protected refreshPageTools(): void {
    const { settings } = this.store.get()
    const wanted = anyToolWanted(settings)
    if (!wanted && !this.pageToolsOn && this.syncedSplits.size === 0) return
    this.pageToolsOn = wanted
    if (!settings.scrollSync) this.syncedSplits.clear()
    else for (const id of [...this.syncedSplits]) if (!this.store.get().splits.some((split) => split.id === id)) this.syncedSplits.delete(id)
    for (const [id, page] of this.pages) page.setPageTools(this.toolsFor(id))
  }

  /** A link of a page opens in a tab of the page's space. What the page asked for (front or behind) gives way to the user's settings; a choice made in a menu is kept as it is. */
  protected openTabFromPage(from: TabItem, url: string, disposition: 'foreground' | 'background' | 'peek' | 'little', byPage: boolean): void {
    // The space and the container the opener is in now: the caller may hold the tab as it was when its page was created.
    const tab = this.tabNow(from)
    const mode = openTabMode(disposition, byPage, this.store.get().settings)
    // The new tab remembers where it came from, for Back (only while the setting asks for it: otherwise nothing is kept). What a private tab opens is private too.
    const openerId = this.store.get().settings.backClosesOpenedTab ? tab.id : undefined
    // An empty tab a page opened (about:blank) is an empty tab that remembers this tab, and goes if it stays empty and unused (shell/blank-tab-watch.ts).
    this.blankTabs.applyFromTab(tab.id, url, byPage, () =>
      this.openedBy(byPage ? 'page' : 'shell', () => this.dispatch({ type: 'tab/open', url, spaceId: tab.spaceId, background: mode === 'background', ...(tab.private === true ? { private: true } : this.inheritedContainer(tab, url)), ...(openerId !== undefined ? { openerId } : {}), ...this.treeParent(tab.id) }))
    )
  }

  /** A Vim-style key (shared/vim-keys.ts) asked for what only the application can do. Only the page the user is on obeys: a pane or a tab behind it does nothing. */
  private runVimKey(tabId: string, message: Extract<ToolMessage, { tool: 'vim' }>): void {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab || !state.settings.vimKeys || activeTab(state)?.id !== tabId || !this.visible.has(tabId)) return
    switch (message.action) {
      case 'back':
        return this.nav('back')
      case 'forward':
        return this.nav('forward')
      case 'reload':
        return this.nav('reload')
      case 'tab-previous':
        return this.stepTab(-1)
      case 'tab-next':
        return this.stepTab(1)
      case 'find':
        return this.openOverlay({ panel: 'find' })
      case 'open-tab':
        // Like a ⌘-click on the link: behind or in front as the settings of Liens say. The address was checked when the line was read.
        return this.openTabFromPage(tab, message.url, 'background', true)
    }
  }

  protected onToolMessage(tabId: string, message: ToolMessage): void {
    if (message.tool === 'vim') return this.runVimKey(tabId, message)
    if (message.tool === 'gesture') {
      const action = gestureAction(message.path)
      if (action) this.runGesture(tabId, action)
      return
    }
    if (message.tool === 'scrollpos') return this.keepScrollPosition(tabId, message.y)
    if (message.tool !== 'scroll') return
    const split = splitFor(this.store.get(), tabId)
    if (!split || !this.syncedSplits.has(split.id)) return
    for (const id of syncTargets(split.tabIds, tabId, true)) this.pages.get(id)?.toolCommand({ tool: 'scrollSync', x: message.x, y: message.y })
  }

  /** The page of a tab stopped scrolling: its position is kept for the next time the tab's page is made (shared/scroll-memory.ts). */
  private keepScrollPosition(tabId: string, y: number): void {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab || !state.settings.rememberScroll || tab.private === true || this.isPrivate()) return
    scrollMemory().remember(tabId, tab.url, y)
  }

  /** A new document of the tab's page is ready: the first one a page gets goes back to where the tab was left, once, at the same address. */
  protected restoreScrollOnce(tabId: string): void {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab || !state.settings.rememberScroll || tab.private === true || this.isPrivate() || this.scrollRestored.has(tabId)) return
    this.scrollRestored.add(tabId)
    const y = scrollMemory().positionFor(tabId, tab.url)
    if (y !== undefined) this.pages.get(tabId)?.toolCommand({ tool: 'scrollMemory', y })
  }

  private runGesture(tabId: string, action: GestureAction): void {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === tabId)
    // A gesture drawn in a page that is not the one on screen (a pane of a split view, fine; a tab behind, never) does nothing.
    if (!tab || !this.visible.has(tabId)) return
    const page = this.pages.get(tabId)
    switch (action) {
      case 'back':
        return page?.goBack()
      case 'forward':
        return page?.goForward()
      case 'reload':
        return page?.reload()
      case 'new-tab':
        return this.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      case 'close-tab':
        return this.dispatch(tab.pinned ? { type: 'tab/close', id: tabId } : { type: 'tab/archive', id: tabId })
      case 'reopen-tab':
        if (state.archive.length > 0) this.dispatch({ type: 'archive/restore-last' })
    }
  }

  /** What the page's menu adds: asked each time it opens, so that a setting takes effect without reloading the page. */
  protected menuOptionsFor(tabId: string): PageMenuOptions {
    const { settings, tabs } = this.store.get()
    const tab = tabs.find((t) => t.id === tabId)
    const url = tab?.url
    return {
      qrCode: settings.qrCode,
      readAloud: settings.readAloud,
      // The same rule as the File menu: the entry shows only while the model is switched on, at an accepted address. With Ollama on this Mac
      // the page text stays here, so a private page gets the entry too; with Ollama on another computer it does not.
      summary: summaryAvailable(settings, tab?.private === true || this.isPrivate()),
      // The page menu offers the translation of a page in another language only while it is on: off, no page has its language read.
      translate: settings.translateLocal,
      translateTarget: targetLanguage(settings, getLanguage()),
      translated: this.runtime.tabs[tabId]?.translation !== undefined,
      // The list of sites is a setting of the main window, which a private window cannot change; and it is saved, so the site of a private tab is not put in it.
      ...(settings.mouseGestures && url !== undefined && !this.isPrivate() && tab?.private !== true ? { gestures: isSiteExcluded(url, settings.mouseGestureExcludedHosts) ? ('off' as const) : ('on' as const) } : {})
    }
  }

  /** "Désactiver / Activer les gestes de souris sur ce site": the site of the tab goes in or out of the list of those left out. */
  protected toggleGestureSite(tabId: string): void {
    const { settings, tabs } = this.store.get()
    const tab = tabs.find((t) => t.id === tabId)
    const url = tab?.url
    const host = url !== undefined ? hostnameOf(url) : ''
    // The list is saved with the settings: the site of a private tab is never written there (its menu does not offer the entry either).
    if (host === '' || this.isPrivate() || tab?.private === true) return
    const excluded = isSiteExcluded(url!, settings.mouseGestureExcludedHosts)
    this.dispatch({ type: 'settings/update', patch: { mouseGestureExcludedHosts: setSiteExcluded(settings.mouseGestureExcludedHosts, host, !excluded) } })
    this.showToast(excluded ? t('browser.gestes-de-souris-actives-sur-host', { host }) : t('browser.gestes-de-souris-desactives-sur-host', { host }))
  }

  /** Whether the panes of a split view scroll together. */
  isScrollSynced(splitId: string): boolean {
    return this.syncedSplits.has(splitId)
  }

  /** Makes the panes of a split view scroll together, or stop doing so (the switch of the setting must be on). */
  setScrollSynced(splitId: string, on: boolean): void {
    if (on && (!this.store.get().settings.scrollSync || !this.store.get().splits.some((split) => split.id === splitId))) return
    if (on) this.syncedSplits.add(splitId)
    else this.syncedSplits.delete(splitId)
    this.refreshPageTools()
    this.publish()
  }
}
