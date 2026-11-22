// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Captures of the page, the history of a profile,
// and the openers of the surfaces of their own (settings, the tooltip window), and the Extensions page, which is a tab.

import { type WebContents } from 'electron'
import type { SettingsAnchor, SettingsPane, TooltipRequest } from '@shared/ipc'
import { activeProfileId, isProfileId, knownProfiles, profileOfSpace } from '@shared/profiles'
import { activeTab, splitFor } from '@shared/sidebar'
import type { TabItem } from '@shared/model'
import { internalPageUrl, type ExtensionsTarget } from '@shared/extension-page'
import { isInternalPageUrl } from '@shared/internal-page'
import { t } from '@shared/i18n'
import type { InternalTabFacts } from './internal-page-ipc'
import type { PictureSize } from '@shared/annotate'
import type { HeldCapture } from './capture-shelf'
import type { Bounds } from '../engine/types'
import { TooltipWindow } from './tooltip'
import type { ClosedPagesScope } from '@shared/closed-history'
import { eraseBrowsingHistory } from './profile-erase'
import { getSessionBackups } from './backups'
import { type ProfileHistoryLog } from './browser-base'
import { usageCountOf } from '@shared/command-bar-usage'
import { forgottenRanking } from './forgotten-ranking'
import { BrowserReload } from './browser-reload'
import { getPageIndex } from '../page-index'
import type { PageMatch } from '@shared/page-index'
import { historyRangeBounds, purgeCutoff, type HistoryRange } from '@shared/history-range'

/** The pages of a profile last visited from `from` to `to` forgotten, with their trace in the page index and in the ranking of the command bar. */
function forgetSpan(browser: BrowserCapture, from: number, to: number, profileId: string, what: string): number {
  if (!knownProfiles(browser['store'].get()).includes(profileId)) {
    console.warn(`[history] ${what} was to be forgotten in the profile ${JSON.stringify(profileId.slice(0, 64))}, which does not exist: nothing is forgotten`)
    return 0
  }
  const log = browser['history'].of(profileId)
  // The pages leave the ranking of the command bar with the history: read before they go, the same ones (those the lock lets be read).
  const urls = log.between(from, to).map((page) => page.url)
  const gone = log.removeBetween(from, to)
  for (const url of urls) getPageIndex()?.of(profileId).remove(url)
  if (urls.length > 0) browser['dispatch']({ type: 'commandbar/forget', profileId, urls })
  return gone
}

export abstract class BrowserCapture extends BrowserReload {
  /**
   * PNG of the part of the screen the user selected (window coordinates). The pane under the selection's centre is
   * captured, so it also works in a split view. Null when the selection is not over a page.
   */
  async captureRegion(drawn: Bounds): Promise<Buffer | null> {
    const state = this.store.get()
    const active = activeTab(state)
    if (!active) return null
    const stage = this.stageRect()
    const split = splitFor(state, active.id)
    // The rectangle was drawn on the zoomed layer of the interface, in its CSS pixels: the pages are placed in points.
    const rect = this.fromCss(drawn)
    const panes: Array<{ id: string; bounds: Bounds }> = split
      ? this.splitPanes(stage, split).map((r, i) => ({ id: split.tabIds[i]!, bounds: { x: stage.x + r.x, y: stage.y + r.y, width: r.width, height: r.height } }))
      : [{ id: active.id, bounds: stage }]
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const pane = panes.find((p) => cx >= p.bounds.x && cx <= p.bounds.x + p.bounds.width && cy >= p.bounds.y && cy <= p.bounds.y + p.bounds.height)
    const page = pane && this.pages.get(pane.id)
    if (!pane || !page) return null
    // Window coordinates → page coordinates, kept inside the page.
    const x = Math.max(0, Math.round(rect.x - pane.bounds.x))
    const y = Math.max(0, Math.round(rect.y - pane.bounds.y))
    const width = Math.min(Math.round(rect.width), Math.round(pane.bounds.width) - x)
    const height = Math.min(Math.round(rect.height), Math.round(pane.bounds.height) - y)
    return width > 0 && height > 0 ? page.capture(false, { x, y, width, height }) : null
  }

  /**
   * The selected tab of this window when an extension of `profileId` may see it: a tab of that profile, in no container (its cookies are the
   * container's, it is of no profile), and not a private one. A private tab is in a space, so it has a profile: it is refused by name here, as is
   * every tab of a private window, and not because its page happens to be unknown to the extension runtime.
   */
  private tabShownTo(profileId: string): TabItem | null {
    if (this.isPrivate()) return null
    const state = this.store.get()
    const tab = activeTab(state)
    return tab && tab.private !== true && profileOfSpace(state, tab.spaceId) === profileId && this.containerKeyOf(tab) === '' ? tab : null
  }

  /** The selected tab of this window when it is one of `profileId`'s: what chrome.tabs.captureVisibleTab would capture for an extension of that profile. Never a private tab. */
  activeTabFor(profileId: string): { id: string; url: string } | null {
    const tab = this.tabShownTo(profileId)
    return tab ? { id: tab.id, url: tab.url } : null
  }

  /** The viewport of the active tab, when that tab is one of `profileId` (chrome.tabs.captureVisibleTab never shows another profile's tab, nor a private one). */
  async captureActiveFor(profileId: string, format: 'png' | 'jpeg', quality: number): Promise<Buffer | null> {
    if (!this.tabShownTo(profileId)) return null
    return (await this.activePage()?.captureViewport(format, quality)) ?? null
  }

  async capture(full: boolean): Promise<Buffer | null> {
    return (await this.activePage()?.capture(full, undefined, (max) => this.showToast(t('capture.page-coupee', { max })))) ?? null
  }

  /** A small JPEG of what the active tab shows, for its hover card (thumbnails.ts); null without a page, or when it drew nothing. */
  async captureThumbnail(width: number, quality: number): Promise<Buffer | null> {
    const jpeg = await this.activePage()?.thumbnail?.(width, quality)
    return jpeg && jpeg.length > 0 ? jpeg : null
  }

  /**
   * Keeps a fresh capture for the annotation sheet and says how big it is; null when the sheet is not for it (the setting is off, or the
   * picture is not one the sheet can take), in which case the capture goes the way it always went. The capture lives in memory until the
   * sheet is closed or another panel replaces it; nothing is written before the user chooses.
   */
  holdCapture(png: Buffer, suffix: string): ({ id: string } & PictureSize) | null {
    return this.shelf.hold(png, suffix)
  }

  /** The held capture, only while the sheet that was opened for it is the panel on screen and `id` is its id. */
  heldCapture(id: unknown): HeldCapture | null {
    return this.shelf.get(id)
  }

  /** Lets go of the held capture (all of it when `id` is not given); an id that is not the held one's leaves it alone. */
  dropCapture(id?: string): void {
    this.shelf.drop(id)
  }

  /** The history of the profile of the space this window is in: the panel, the command bar and the completion see no other. */
  private activeHistory(): ProfileHistoryLog {
    return this.history.of(activeProfileId(this.store.get()))
  }

  /**
   * `profileId`: the profile the panel that asks listed (it is fixed when the panel opens). A panel that still shows another profile than the one
   * of the space on screen (the space changed under it) gets no page: the list on screen is never one profile's with another's pages.
   */
  searchHistory(query: string, limit?: number, profileId?: string) {
    if (profileId !== undefined && profileId !== activeProfileId(this.store.get())) return []
    return this.activeHistory().search(query, limit)
  }

  /**
   * The pages whose text holds the words of `query`, from the full-text index of the profile on screen (see page-index.ts). Nothing while the setting is
   * off, in a private window, or for a panel that lists another profile than the one on screen. A page is only given when the history still holds it
   * and the lock lets it be read: a page forgotten, or visited in a locked space, is not found by its text either.
   */
  searchPageContent(query: string, profileId?: string): PageMatch[] {
    const book = getPageIndex()
    const state = this.store.get()
    if (book === null || this.isPrivate() || !state.settings.pageContentIndex) return []
    if (profileId !== undefined && profileId !== activeProfileId(state)) return []
    const history = this.activeHistory()
    return book.of(activeProfileId(state)).search(query).filter((match) => history.get(match.url) !== undefined)
  }

  /** « Effacer l’index du contenu des pages »: every index of every profile, in memory and on the disk. Answers whether nothing is left. */
  clearPageIndex(): boolean {
    return getPageIndex()?.eraseAll() ?? true
  }

  /**
   * Forgets a page in the history of `profileId`: the profile whose list showed it. The panel sends this up to six seconds after the click
   * (the time to undo), or as it closes; the space on screen may be of another profile by then, whose history must not lose the same address
   * while the page stays in the one it was listed from. Without a profile: the one on screen. `undoable` (the command bar, which forgets at once and
   * then offers « Annuler »): the history keeps the page aside for a few seconds, the time for `putBackHistory` to put it back.
   */
  forgetHistory(url: string, profileId?: string, undoable = false): void {
    let log: ProfileHistoryLog
    if (profileId === undefined) log = this.activeHistory()
    else if (knownProfiles(this.store.get()).includes(profileId)) log = this.history.of(profileId)
    else {
      console.warn(`[history] a page was to be forgotten in the profile ${JSON.stringify(profileId.slice(0, 64))}, which does not exist: nothing is forgotten`)
      return
    }
    const id = profileId ?? activeProfileId(this.store.get())
    // The ranking of the command bar holds the address too: the page leaves it with the history. With a way back, and only when the history keeps
    // the page aside (it alone decides whether the page comes back), its count waits in memory for `putBackHistory`.
    const count = usageCountOf(this.store.get().commandBarUsage, id, url)
    getPageIndex()?.of(id).remove(url)
    let aside = false
    if (undoable) aside = log.removeKept(url)
    else log.remove(url)
    if (aside) forgottenRanking.keep(id, url, count)
    else forgottenRanking.drop(id, url)
    if (count > 0) this.dispatch({ type: 'commandbar/forget', profileId: id, urls: [url] })
  }

  /**
   * Puts back in the history of `profileId` the page that `forgetHistory` just forgot there with `undoable`, as it was. The profile is named, as for
   * the forgetting: the page never lands in the history of another profile because the space on screen changed. Answers whether the page is back;
   * nothing for a profile that does not exist, nor for a page that was not just forgotten (the time is up, or a wider erasure took it for good).
   */
  putBackHistory(url: string, profileId: string): boolean {
    if (!knownProfiles(this.store.get()).includes(profileId)) {
      console.warn(`[history] a page was to be put back in the profile ${JSON.stringify(profileId.slice(0, 64))}, which does not exist: nothing is put back`)
      return false
    }
    const back = this.history.of(profileId).putBack(url)
    // Taken in every case: a page the history no longer gives back (the time is up, a wider erasure took it) does not come back in the ranking.
    const count = forgottenRanking.take(profileId, url)
    if (back && count > 0) this.dispatch({ type: 'commandbar/put-back', profileId, url, count })
    return back
  }

  /**
   * Forgets a whole day of the history of `profileId` (the profile the panel lists): every page last visited from `from` to `to`, the ones the
   * panel had not loaded included. Answers how many pages went; nothing for a profile that does not exist.
   */
  forgetHistoryDay(from: number, to: number, profileId: string): number {
    return forgetSpan(this, from, to, profileId, 'a day')
  }

  /**
   * « Effacer l'historique » over a span (the last hour, today, 7 days, 4 weeks, everything) in `profileId`. The interface names the span by a
   * word; its bounds are worked out here, so that a message cannot ask for another span. Answers how many pages went.
   */
  forgetHistoryRange(range: HistoryRange, profileId: string): number {
    const { from, to } = historyRangeBounds(range, Date.now())
    return forgetSpan(this, from, to, profileId, 'a span')
  }

  /**
   * The automatic purge (« Garder l'historique : N jours »): every page last visited before the delay goes, in every profile. Nothing runs while the
   * delay is 0 (the default). Answers how many pages went.
   */
  purgeHistory(now: number): number {
    const state = this.store.get()
    const cutoff = purgeCutoff(state.settings.historyKeepDays, now)
    if (cutoff === null) return 0
    let gone = 0
    for (const profileId of knownProfiles(state)) gone += forgetSpan(this, 0, cutoff, profileId, 'old pages')
    return gone
  }

  /** What "Effacer l'historique de navigation" is about: the profile of the space this window is in, and how many pages its history holds. */
  historyScope(): { profileId: string; pages: number } {
    const profileId = activeProfileId(this.store.get())
    return { profileId, pages: this.history.of(profileId).size() }
  }

  /**
   * "Effacer l'historique de navigation…": forgets the whole history of a profile (not only the one of the space shown), and the “Récents” list of
   * "Effacer les données du site…" with it (see `eraseBrowsingHistory`). Answers whether nothing of the history is left on disk.
   */
  eraseHistory(profileId: string): boolean {
    return eraseBrowsingHistory(
      {
        eraseHistory: (id) => this.eraseProfileHistory(id),
        recentSites: () => this.store.get().settings.siteDataRecents,
        forgetRecentSites: () => this.dispatch({ type: 'settings/update', patch: { siteDataRecents: [] } }),
        offeredSearchSites: () => this.store.get().settings.searchDiscoverySeen,
        forgetOfferedSearchSites: () => this.dispatch({ type: 'settings/update', patch: { searchDiscoverySeen: [] } }),
        forgetSiteVisits: () => this.dispatch({ type: 'permission/forget-visits' })
      },
      profileId
    )
  }

  /**
   * The visit history of a profile erased, and with it the pages its closed tabs went through (`forgetClosedPages`), whatever became of the erasure:
   * the user asked to forget, and a Back list kept in the archive is history too.
   */
  protected eraseProfileHistory(profileId: string): boolean {
    try {
      return this.history.erase(profileId)
    } finally {
      if (isProfileId(profileId)) getPageIndex()?.erase(profileId)
      this.forgetClosedPages(profileId)
    }
  }

  /**
   * Forgets the pages the archived tabs of a profile went through (their Back lists, kept while « Rouvrir un onglet avec ses pages précédentes » is on),
   * or only those of one site: in the archive of the state and in the copies of the session on disk. The tabs stay in the archive. A private window has
   * neither an archive nor copies. Never throws: a copy that cannot be edited is logged by the service.
   */
  forgetClosedPages(profileId: string, site?: ClosedPagesScope['site']): void {
    if (this.isPrivate()) return
    const scope: ClosedPagesScope = { profileId, ...(site ? { site } : {}) }
    // The lists kept in memory for the sleeping tabs of the profile are history too.
    this.leader.slept.forgetPages(scope)
    this.dispatch({ type: 'archive/forget-pages', ...scope })
    try {
      getSessionBackups()?.forgetPages(scope)
    } catch (error) {
      console.error('[backups] the copies of the session could not be cleaned of the pages of the closed tabs:', error)
    }
  }

  // ---- overlay panels ----

  /** Registers how to open the Settings window (a window of its own, not an overlay panel). */
  setSettingsOpener(opener: (pane?: SettingsPane, anchor?: SettingsAnchor) => void): void {
    this.settingsOpener = opener
  }

  /**
   * The Extensions page (chrome://extensions): a tab of this window, at `lucium-ui://extensions/` (shared/internal-page.ts), which every way to it opens (the
   * menus, the command bar, Settings, the buttons of the extensions, an address typed or asked for by an extension). A tab that already has the page is selected
   * (in any space) and goes to the view asked for; otherwise one opens in the active space. A private or guest window has no extensions: it says so.
   */
  openExtensionsTab(target: ExtensionsTarget = { view: 'list' }): void {
    if (this.isPrivate()) return this.showToast(t('browser.les-extensions-ne-fonctionnent-pas-dans-une'))
    const url = internalPageUrl(target)
    const existing = this.store.get().tabs.find((tab) => isInternalPageUrl(tab.url) && tab.private !== true)
    if (!existing) return this.dispatch({ type: 'tab/open', url, allowInternalPages: true })
    // The state first, so that a tab with no page yet (asleep) loads the view asked for when it wakes; a live page is sent there too.
    if (existing.url !== url) {
      this.dispatch({ type: 'tab/update', id: existing.id, patch: { url } })
      this.pages.get(existing.id)?.loadURL(url)
    }
    this.dispatch({ type: 'tab/select', id: existing.id })
  }

  /** What the gate of the Extensions page is told of a web contents of this window (shell/internal-pages.ts). */
  internalPageTab(contentsId: number): InternalTabFacts | null {
    return this.internalPages.tabOf(contentsId)
  }

  /** A window that renders the app state: it receives every snapshot until it is removed. */
  addSurface(webContents: WebContents): void {
    this.surfaces.set(webContents.id, webContents)
  }

  removeSurface(id: number): void {
    this.surfaces.delete(id)
  }

  /** Shows the tooltip capsule at the pointer, or (null) puts it away. Any panel that opens puts it away too. */
  showTooltip(request: TooltipRequest | null): void {
    // The pointer was read on the zoomed interface, in CSS pixels; the capsule is placed in points on the screen.
    const k = this.k()
    if (request) void this.tooltipWindow.show(k === 1 ? request : { ...request, x: request.x * k, y: request.y * k }).catch((error: unknown) => console.error('[tooltip] cannot show it:', error))
    else this.tooltipWindow.hide()
  }

  /** The window of the tooltip, once it has been made (the engine test looks at it). */
  tooltipWindowForTest(): ReturnType<TooltipWindow['current']> {
    return this.tooltipWindow.current()
  }

  /** How to open the first state of a mini window (the command bar alone, in a window of its own). */
  setLittleBarOpener(opener: (from?: Bounds) => void): void {
    this.littleBarOpener = opener
  }
}
