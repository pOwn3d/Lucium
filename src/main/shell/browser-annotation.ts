// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The annotation of the page (its target, its
// source and where its bar goes) and the lock of tabs.

import { screen } from 'electron'
import type { TabItem } from '@shared/model'
import { activeTab, splitFor } from '@shared/sidebar'
import { commandPane } from '@shared/split'
import { themeHue } from '@shared/theme'
import { canOpenWhileLocked } from '@shared/lock'
import type { PrivateWindowLock } from './private-lock'
import type { Bounds, Page } from '../engine/types'
import { getLockService } from '../lock-service'
import { notifyOwnWindowShare } from './page-annotate'
import { paneOnScreen, sharesOwnWindow } from '@shared/page-annotate'
import { BrowserDownloads } from './browser-downloads'

export abstract class BrowserAnnotation extends BrowserDownloads {
  protected activePage(): Page | undefined {
    const tab = activeTab(this.store.get())
    return tab ? this.pages.get(tab.id) : undefined
  }

  /**
   * In a split view, the commands of the page (the zoom, the find, print, the reader, a capture…) are for the pane the user is in: the one whose page has the
   * keyboard (shared/split.ts `commandPane`). A click in a frame of another site gives a pane the keyboard without telling the shell (`PageEvents.focused`), so
   * the engine is asked here, and that pane becomes the selected tab as the click would have made it: its ring and its strip follow, and the command then acts
   * on the selected tab as everywhere else. With the keyboard in the sidebar, a toolbar or a panel, the selected tab stays. Outside a split view nothing is asked.
   */
  followPaneFocus(): void {
    const active = activeTab(this.store.get())
    const target = commandPane(active?.id, this.visibleIds(), (id) => this.pages.get(id)?.hasFocus() === true)
    if (target !== undefined && target !== active?.id) this.dispatch({ type: 'tab/select', id: target })
  }

  /** The page on screen, for the annotation of a page (shell/page-annotate.ts): its tab, the page, and its address. Null when the window shows none. */
  annotationTarget(): { tabId: string; page: Page; url: string; source: string } | null {
    const tab = activeTab(this.store.get())
    const page = tab && !this.isTabLocked(tab) ? this.pages.get(tab.id) : undefined
    return tab && page ? { tabId: tab.id, page, url: tab.url, source: this.annotationSource() } : null
  }

  /**
   * The sharing picked the window `picked`. When it is a window of Lucium (this one, or another window of its group: the page that asked may be
   * in a third window), that window is the shared one: its page on screen gets the annotation, and its toolbar shows the button. The number of
   * the window names it (`windowNumber`), whatever the format of the id. Another application's window: nothing.
   */
  protected annotateSharedWindow(picked: string): void {
    const owner = [...this.group].find((browser) => sharesOwnWindow(picked, browser.annotationSource()))
    if (!owner) {
      console.info(`[annotate-share] verdict: autre fenetre (${picked} n'est pas une fenetre de Lucium)`)
      return
    }
    const target = owner.annotationTarget()
    if (!target) {
      console.info(`[annotate-share] verdict: propre fenetre (${owner.annotationSource()}), mais aucune page affichee : rien a annoter`)
      return
    }
    console.info(`[annotate-share] verdict: propre fenetre (${owner.annotationSource()}, onglet ${target.tabId}${owner === this ? ', fenetre de la page demandeuse' : ', autre fenetre de Lucium'})`)
    owner.blankTabs.markShared(target.tabId)
    notifyOwnWindowShare(target.tabId, target.page, owner.annotationSource())
  }

  /** The media source id of this window (what the sharing lists for it, `BrowserWindow.getMediaSourceId()`): it names the window in the annotation. */
  annotationSource(): string {
    return this.win.getMediaSourceId()
  }

  /** The hue of the space on screen in this window: the bar of the annotation and the preview of its drop zones take the accent of that space. */
  annotationHue(): number | null {
    const state = this.store.get()
    const space = state.spaces.find((item) => item.id === state.activeSpaceId)
    return space ? themeHue(space.theme) : null
  }

  /** Says a short message to the user, in this window (a refused annotation). */
  annotationNotice(message: string): void {
    this.showToast(message)
  }

  /** The page on screen as the screen shows it, in the coordinates of the screen (for the bar of the page annotation); null when none is shown. */
  annotationPlacement(): { window: Bounds; area: Bounds } | null {
    const state = this.store.get()
    const tab = activeTab(state)
    if (!tab || this.isTabLocked(tab) || !this.pages.has(tab.id)) return null
    // The reference of the bar is the window, or the pane of the page that has the focus when that page is in a split view (the bar then goes on the
    // left edge of the page it annotates, and not of the whole stage). The work area is the one of the screen the window is on.
    const windowBounds = this.win.getBounds()
    let reference = windowBounds
    const split = splitFor(state, tab.id)
    if (split) {
      const content = this.win.getContentBounds()
      const stage = this.stageRect()
      const pane = paneOnScreen(content, stage, this.splitPanes(stage, split), split.tabIds.indexOf(tab.id))
      if (pane) reference = pane
    }
    return { window: reference, area: screen.getDisplayMatching(windowBounds).workArea }
  }

  /** The active tab, or all panes of the split view it belongs to. */
  protected visibleIds(): string[] {
    const state = this.store.get()
    const active = activeTab(state)
    // Nothing of a locked space (or of a locked application) is on screen, and its pages are not made; nor of a window put away.
    if (!active || this.away || this.isTabLocked(active)) return []
    return splitFor(state, active.id)?.tabIds ?? [active.id]
  }

  /** The lock of this window alone (a private window left alone, shell/private-lock.ts); none for a window that has no such lock. */
  private privateLock: PrivateWindowLock | null = null

  setPrivateLock(lock: PrivateWindowLock | null): void {
    this.privateLock = lock
  }

  /** Whether this window is covered by its own lock (a private window left alone for the delay of the setting), whatever the lock of the application says. */
  isWindowLocked(): boolean {
    return this.privateLock?.isLocked() === true
  }

  /** The phrase (or Touch ID) was right for this window: it opens, and the delay starts again. */
  unlockWindow(): void {
    this.privateLock?.unlock()
  }

  /** The lock of this window changed (it locked, or opened): the pages go (or come back) as they do for the application's lock, and the window shows the lock screen. */
  windowLockChanged(): void {
    this.onLockChange()
  }

  /** Whether the lock keeps this tab's page from existing: its space is locked, or the whole application is, or this window is. */
  isTabLocked(tab: Pick<TabItem, 'spaceId'>): boolean {
    const lock = getLockService()
    return this.isWindowLocked() || (lock !== null && (lock.isAppLocked() || lock.isSpaceLocked(tab.spaceId)))
  }

  /** The lock changed: the pages of what is locked are dropped (the tabs reload when they are unlocked and shown), and what the window shows follows. */
  protected onLockChange(): void {
    // The delay of this window follows the lock and the setting (it lets go of its timer, and a window whose lock was removed opens).
    this.privateLock?.follow()
    // A capture of the sound of a tab the lock now hides ends, and the sound comes back (the page itself goes below).
    this.engine.reconsiderTabCaptures()
    const state = this.store.get()
    for (const id of [...this.pages.keys()]) {
      const tab = state.tabs.find((t) => t.id === id)
      if (tab && this.isTabLocked(tab)) this.destroyPage(id)
    }
    // The site docked beside the page is a live page of its space, and the pictures of the tabs are what they showed: both go with the lock.
    if (this.webPanel && this.isTabLocked({ spaceId: this.webPanel.spaceId })) this.destroyWebPanel()
    this.thumbnailSource?.forgetLocked()
    const lock = getLockService()
    if (lock?.isAppLocked() || this.isWindowLocked()) {
      // Whatever is open over the window goes with the pages: a preview, a side panel, a panel with a page's name in it.
      this.closeOverlay()
      this.destroyPeek()
      this.destroySidePanel()
      if (this.find) this.endFind()
    } else if (lock?.isSpaceLocked(state.activeSpaceId)) {
      // The space on screen alone is locked (its own lock, or the sleep of the Mac while the application is not locked as a whole): what is open
      // over the window belongs to that space as much as its pages, and would stay alive and usable over its lock screen. A question that has to
      // be answered stays (the same ones as over a locked application): the phrase of the space may be the one being asked.
      const panel = this.overlayRequest?.panel
      if (panel !== undefined && !canOpenWhileLocked(panel, true)) this.closeOverlay()
      this.destroyPeek()
      this.destroySidePanel()
      if (this.find) this.endFind()
    }
    this.sync()
  }
}
