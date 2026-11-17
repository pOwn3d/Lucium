// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The snapshot of the window sent to its interface,
// and the facts of the menus.

import { Channel } from '@shared/ipc'
import type { RuntimeState, TabItem } from '@shared/model'
import { getLanguage } from '@shared/i18n'
import { targetLanguage } from '@shared/translate-local'
import { translateOffer } from '@shared/translate-quick'
import { floatingNeedsSnapshot, overlayNeedsSnapshot } from '@shared/snapshot-delivery'
import { soundFact, type MenuFacts } from '@shared/menu-state'
import { activeTab, splitFor } from '@shared/sidebar'
import { batterySaver } from './battery-saver'
import { BrowserAnnotation } from './browser-annotation'

export abstract class BrowserPublish extends BrowserAnnotation {
  /**
   * Tells every window that shows these tabs: the runtime state of a tab (loading, sound) and the downloads are not the same in each. While an
   * event of a page that is not on screen is handled (`onPageUpdate`), the windows are told a moment later, with what follows it (publish-queue.ts).
   */
  protected publish(): void {
    const soon = this.leader.backgroundEvents > 0
    for (const browser of this.group) {
      if (soon) browser.publishQueue.soon()
      else browser.publishQueue.request()
    }
  }

  /** What the UI shows of each tab's life: its own, plus that of the tabs that live in the other windows. */
  protected runtimeOfGroup(): RuntimeState {
    if (this.group.size <= 1) return this.runtime
    const tabs: RuntimeState['tabs'] = {}
    for (const browser of [this, ...[...this.group].filter((b) => b !== this)]) {
      for (const [id, info] of Object.entries(browser.runtime.tabs)) {
        const known = tabs[id]
        // This window's own entry first; a tab it holds asleep may be awake in another window, and then it is shown awake.
        if (!known || (info.awake && !known.awake)) tabs[id] = info
      }
    }
    return { ...this.runtime, tabs }
  }

  /** The application menu rebuilds when what it shows of this window's page changes (back, forward, loading, a search in progress). */
  onPublish(listener: () => void): void {
    this.publishListeners.add(listener)
  }

  /** What the application menu greys out depending on the page: see `menuKey`. */
  menuFacts(): MenuFacts {
    const tab = activeTab(this.store.get())
    return {
      canGoBack: this.runtime.canGoBack || (tab !== undefined && this.backCloses(tab.id)),
      canGoForward: this.runtime.canGoForward,
      loading: tab ? this.runtime.tabs[tab.id]?.loading === true : false,
      finding: this.find !== null,
      scrollSynced: tab ? this.syncedSplits.has(splitFor(this.store.get(), tab.id)?.id ?? '') : false,
      saverAsked: batterySaver().askedByHand(),
      sound: soundFact(tab ? this.runtime.tabs[tab.id] : undefined),
      ...this.sidebarFact(),
      ...this.translateFact(tab)
    }
  }

  /** What File offers to translate on the page on screen: nothing for a page in the target language (the common case leaves the key as it was). */
  private translateFact(tab: TabItem | undefined): Pick<MenuFacts, 'translate'> {
    const settings = this.store.get().settings
    const offer = tab ? translateOffer(settings.translateLocal, tab.url, this.runtime.tabs[tab.id], targetLanguage(settings, getLanguage())) : null
    return offer ? { translate: { state: offer.state, to: offer.to } } : {}
  }

  /** The sidebar of this window for the menu's key: nothing for the full sidebar at the left, the case of every window that changed nothing. */
  private sidebarFact(): Pick<MenuFacts, 'sidebar'> {
    const { right, docked } = this.placement()
    if (!right && !docked) return {}
    return { sidebar: right ? (docked ? 'right-docked' : 'right') : 'left-docked' }
  }

  protected publishHere(): void {
    for (const listener of this.publishListeners) listener()
    const snapshot = this.snapshot()
    // The floating sidebar draws nothing while it is hidden: it is sent the snapshot only while it shows, and once more when it stops.
    const showingNow = snapshot.floating !== undefined
    const targets = [this.win.webContents, ...this.surfaces.values()]
    // A view made while it already shows asks for the snapshot itself once its page has loaded (Channel.getSnapshot).
    const floatingView = this.floating.current()
    if (floatingView && floatingNeedsSnapshot(showingNow, this.floatingShown)) targets.push(floatingView.webContents)
    this.floatingShown = showingNow
    // The layer of panels draws nothing while it is closed, and each snapshot cost it a whole read of the state: it is sent the snapshot only
    // while a panel is open, and the one it missed when the next panel opens (`sendMissedSnapshot`, from openOverlay).
    const overlayOpen = overlayNeedsSnapshot(this.overlayRequest !== null)
    if (overlayOpen) targets.push(this.overlay.webContents)
    this.overlayMissed = !overlayOpen
    for (const wc of targets) {
      if (!wc.isDestroyed()) wc.send(Channel.snapshot, snapshot)
    }
    // The Extensions page, in the tabs of this window that have it: the reduced snapshot, and only when it changed.
    this.internalPages.publish(snapshot, snapshot.lock?.appLocked === true)
  }

  /** Sends the layer of panels the state it was not sent while it was closed (see `publishHere`): before the panel that opens is shown over it. */
  protected sendMissedSnapshot(): void {
    if (!this.overlayMissed) return
    this.overlayMissed = false
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send(Channel.snapshot, this.snapshot())
  }
}
