// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The engine set up for the window: downloads, the
// blocker and its stylesheets, autoplay, the media bridge, the network and privacy options, the filter lists.

import { blockingService } from '../blocking'
import { tidyFilename } from '@shared/tidy'
import { adsBlockingOn, blockerIsOn } from '@shared/blocker'
import { pingBlockedFor } from '@shared/ping-block'
import { focusBlock, focusIsConfigured, pauseFocusPatch } from '@shared/focus-mode'
import { focusGate } from '../engine/focus-gate'
import { anyPrivacy, privacyOptionsOf } from '@shared/privacy'
import { planHostResolver } from '@shared/dns'
import { planProxies } from '@shared/proxy'
import type { Page, RequestBlocker } from '../engine/types'
import { addCustomListFromFile, addCustomListFromText, removeCustomListById, type CustomListsEnvironment } from './custom-lists'
import type { AddFilterListResult } from '@shared/custom-filter-lists'
import { t } from '@shared/i18n'
import { BrowserPublish } from './browser-publish'

export abstract class BrowserNetwork extends BrowserPublish {
  /** Hosts that count as ad networks on top of the built-in list. Only the engine test uses it, to block a local host. */
  setExtraBlockedHosts(hosts: string[]): void {
    this.extraBlockedHosts = hosts
    this.blockerKey = ''
    this.configureBlocker()
  }

  /** Gives the engine the optional behaviours of downloads the settings call for: asking where a file goes, links that open without keeping. */
  private configureDownloads(): void {
    const { downloadPause } = this.store.get().settings
    this.engine.setDownloadPolicy(this.downloadPolicyOfSettings())
    // A pause outlives nothing: with the setting off there is no button to end it, so the downloads it holds go on.
    if (!downloadPause) for (const download of this.downloads) if (download.paused === true) this.engine.resumeDownload(download.id)
  }

  /** Gives the engine the request filter and download namer the settings call for, and updates the stylesheets that hide ads and banners. */
  protected configureBlocker(): void {
    const { blockCookieBanners, blockCosmetic, disabledFilterLists, filterUpdateDays, blockExceptions, tidyDownloads } = this.store.get().settings
    // The ads and trackers switch is `blockAds` or its alias: one gate (shared/blocker.ts), the same as the request filter's.
    const adsOn = adsBlockingOn(this.store.get().settings)
    // Switched off, the custom lists are not compiled at all (their rules stay on disk).
    const customFilterLists = this.store.get().settings.customFilterListsEnabled ? this.store.get().settings.customFilterLists : []
    // The filter and the download namer are engine-wide: the main window sets them. A second window hands a settings change it received to the main one
    // (an option turned on from a command or a panel of that window would otherwise wait for the main window's next change), then keeps its own pages up to date.
    if (this.isSecondary()) {
      if (this.leader !== this) this.leader.configureBlocker()
      this.guard.refreshPages()
      return this.refreshBlockerCss()
    }
    this.engine.setDownloadNamer(tidyDownloads ? (name) => tidyFilename(name) : null)
    this.configureFocus()
    this.configureDownloads()
    this.configurePrivacy()
    this.guard.configure()
    this.configureNetwork()
    if (this.privateScope) this.configurePrivateContext(this.privateScope)
    for (const scope of this.containerScopes.values()) this.configurePrivateContext(scope)
    const key = [adsOn, blockCookieBanners, blockCosmetic, disabledFilterLists.join(','), filterUpdateDays, blockExceptions.join(','), this.extraBlockedHosts.join(','), customFilterLists.map((l) => `${l.id}:${l.enabled}`).join(','), focusIsConfigured(this.store.get().settings), this.store.get().settings.blockPings].join('|')
    if (key === this.blockerKey) return
    this.blockerKey = key
    // The lists belong to the application, not to a window: the main window drives them, a private window only gets its own request filter.
    if (!this.isPrivate()) {
      blockingService().configure({ ads: adsOn, cookieBanners: blockCookieBanners, cosmetic: blockCosmetic, disabledLists: disabledFilterLists, updateDays: filterUpdateDays, customLists: customFilterLists })
    }
    // The exceptions are read at each request, from this window's own settings.
    this.engine.setRequestBlocker(this.requestFilter())
    // A page that already loaded its trackers keeps them: the request filter applies from its next load.
    this.refreshBlockerCss()
  }

  /** What the engine gives the popups it makes: the user's general autoplay choice. The main window sets it; the engine of a private window follows. */
  protected configureAutoplay(): void {
    if (this.isSecondary() && this.leader !== this) return this.leader.configureAutoplay()
    if (!this.isPrivate()) this.engine.setDefaultAutoplay(this.store.get().settings.autoplayPolicy)
  }

  /** The media player's script is in the pages only while the player is on (Settings › Fonctions); the main window's setting holds for every session. */
  protected configureMediaBridge(): void {
    if (this.isSecondary() && this.leader !== this) return this.leader.configureMediaBridge()
    if (!this.isPrivate()) this.engine.setMediaBridge(this.store.get().settings.mediaPlayer)
  }

  /**
   * The request filter: the focus mode first (it closes the main frame of a listed site while it is active, shared/focus-mode.ts), then the tracking
   * pings (shared/ping-block.ts: cancelled and counted with the blocker's counter of the page), then the blocker settings. Null while neither the focus
   * mode (switched on, with a site) nor the pings nor ad and tracker blocking nor banner blocking is on: a request is then not even heard.
   */
  protected requestFilter(): RequestBlocker | null {
    const filtering = blockerIsOn(this.store.get().settings)
    const focusing = focusIsConfigured(this.store.get().settings)
    const pinging = this.store.get().settings.blockPings === true
    if (!filtering && !focusing && !pinging) return null
    return (request) => {
      if (focusing && request.resourceType === 'mainFrame' && focusBlock(this.store.get().settings, request.url, Date.now()) !== null) return true
      if (pinging) {
        // The lists reset the counter of a page at its navigation; with them off nobody else would.
        if (!filtering && request.resourceType === 'mainFrame' && request.pageId) blockingService().resetPageCount(request.pageId)
        if (pingBlockedFor({ url: request.url, resourceType: request.resourceType, pageUrl: request.pageUrl }, this.store.get().settings)) {
          blockingService().noteStopped(request.pageId)
          return true
        }
      }
      return filtering ? blockingService().verdict(request, this.store.get().settings, this.extraBlockedHosts) : false
    }
  }

  /** What the block page of the engine asks of the focus mode: whether an address is closed now, and the pause. Present while the feature is on. */
  private configureFocus(): void {
    if (!focusIsConfigured(this.store.get().settings)) return focusGate.set(null)
    focusGate.set({
      block: (url) => {
        const hit = focusBlock(this.store.get().settings, url, Date.now())
        if (hit === null) return null
        return { until: hit.state.until, slotEnd: hit.state.until === null ? this.store.get().settings.focusTo : null }
      },
      pause: () => this.dispatch({ type: 'settings/update', patch: pauseFocusPatch(Date.now()) })
    })
  }

  /**
   * Gives the engine the encrypted DNS and the proxies the settings ask for, when they change. Both start as "nothing configured" and stay
   * so while their switch is off: with the options off this does nothing at all, at the start or later.
   */
  private configureNetwork(): void {
    if (this.isPrivate()) return
    const settings = this.store.get().settings
    const dns = planHostResolver(settings)
    const dnsKey = JSON.stringify(dns)
    if (dnsKey !== this.dnsKey) {
      if (dns.kind === 'refused') {
        // Nothing changes: a "secure" mode without a server would stop every site from opening. The settings window says why.
        console.warn('[network] encrypted DNS not applied:', dns.reason)
      } else {
        const failure = this.engine.setHostResolver(dns.kind === 'configure' ? dns.config : null)
        if (failure === null) this.dnsKey = dnsKey
        else this.showToast(t('browser.le-dns-chiffre-n-a-pas-pu-etre-regle-failure', { failure }))
      }
    }
    const plan = planProxies(settings)
    const proxyKey = JSON.stringify(plan)
    if (proxyKey !== this.proxyKey) {
      this.proxyKey = proxyKey
      void this.engine.setProxies(plan).then(
        (failures) => {
          if (failures.length > 0) this.showToast(t('browser.proxy-non-applique', { failures: failures.join(' ; ') }))
        },
        (error: unknown) => console.error('[network] cannot set the proxies:', error)
      )
    }
  }

  /** Gives the engine the privacy options (HTTPS first, Global Privacy Control, tracking parameters) when they change. A private window follows the main one's. */
  private configurePrivacy(): void {
    const options = privacyOptionsOf(this.store.get().settings)
    const key = JSON.stringify(options)
    if (key === this.privacyKey) return
    this.privacyKey = key
    this.engine.setPrivacy(anyPrivacy(options) ? options : null)
  }

  /** Gives every page of the windows that show these tabs the stylesheet that hides what the lists and the options name. */
  protected refreshBlockerCss(): void {
    for (const browser of this.group) {
      for (const id of browser.pages.keys()) {
        browser.blockerCss.fresh(id)
        browser.applyBlockerCss(id)
      }
    }
  }

  /**
   * Hides ads and banners on one page: first with the rules of its site, then (a page's markup is not there yet at the
   * start, and some of it arrives late) with the generic rules its classes, ids and links call for.
   */
  protected applyBlockerCss(tabId: string): void {
    const page = this.pages.get(tabId)
    if (!page) return
    this.blockerCss.apply(tabId, page, () => this.store.get().tabs.find((t) => t.id === tabId)?.url, () => this.pages.get(tabId) === page)
  }

  /** Hides ads and banners on a page that is not a tab (a mini window): the stylesheet of a tab's page, for the address `urlOf` gives. */
  hideAdsOn(key: string, page: Page, urlOf: () => string | undefined, isCurrent: () => boolean): void {
    this.blockerCss.fresh(key)
    this.blockerCss.apply(key, page, urlOf, isCurrent)
  }

  /** The page `hideAdsOn` was used for is gone. */
  forgetBlockerCss(key: string): void {
    this.blockerCss.forget(key)
  }

  /** Requests blocked on a tab of this window since it last navigated. */
  blockedCount(tabId: string): number {
    return this.store.get().tabs.some((t) => t.id === tabId) ? blockingService().blockedCount(tabId) : 0
  }

  sessionBlockedByKind(): { ads: number; banners: number } {
    return blockingService().sessionBlockedByKind()
  }

  sessionBlockedCount(): number {
    return blockingService().sessionBlockedCount()
  }

  resetSessionBlockedCount(): void {
    blockingService().resetSessionBlockedCount()
  }

  /** "Mettre à jour maintenant" in the settings. */
  async updateFilterLists(): Promise<void> {
    await blockingService().updateNow()
  }

  // ---- the user's own filter lists (see custom-lists.ts) ----

  private customListsEnvironment(): CustomListsEnvironment {
    return { service: blockingService(), lists: () => this.store.get().settings.customFilterLists, enabled: () => this.store.get().settings.customFilterListsEnabled, dispatch: (action) => this.dispatch(action), now: Date.now, private: this.isPrivate() }
  }

  addFilterListFile(path: string): Promise<AddFilterListResult> {
    return addCustomListFromFile(this.customListsEnvironment(), path)
  }

  addFilterListText(title: unknown, text: unknown): Promise<AddFilterListResult> {
    return addCustomListFromText(this.customListsEnvironment(), title, text)
  }

  removeFilterList(id: unknown): Promise<void> {
    return removeCustomListById(this.customListsEnvironment(), id)
  }
}
