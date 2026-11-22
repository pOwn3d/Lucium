// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The actions applied to the state (from the
// interface or from the shell), the notices they lead to, and the profiles.

import type { ClosedHistory, SidebarState } from '@shared/model'
import { newlyArchived } from '@shared/archive'
import { javascriptHostOf } from '@shared/site-javascript'
import { parseSiteHost } from '@shared/site-data'
import { referencedImages } from '@shared/space-image'
import { profilesInUse } from '@shared/profiles'
import { changedSettings, inheritedSettings, privateAction } from '@shared/private-window'
import { guestInherited } from '@shared/guest-window'
import { containerById } from '@shared/containers'
import { readLaterNotice, readLaterOffersList, readLaterOutcome } from '@shared/read-later'
import { paneClosedUndo } from '@shared/split-bar'
import { tidyNotice, tidyOutcome } from '@shared/tab-grouping'
import { hiddenIds, lockRefusalMessage, lockRefuses, namesHiddenId, sparingLockedSpaces } from '@shared/lock'
import { closedHistoryOf } from '@shared/closed-history'
import { confirmedPurge, unusedProfileIds } from '@shared/profile-purge'
import { profileDeletionRefusal, retiredSettings, retiredToSweep } from '@shared/profile-retire'
import type { Action } from '@shared/sidebar'
import { applyWithDeveloperTools } from './devtools-command'
import { eraseProfile, eraseProfiles } from './profile-erase'
import { WHOLE_STATE_ACTIONS } from '@shared/site-clear'
import { changesSession } from '@shared/tab-transfer'
import { windowsAreIndependent } from '@shared/window-tabs'
import { bookmarkNotice, bookmarkOutcome } from '@shared/bookmarks'
import { opensInNewWindow, workViewRemovedUndo, workViewSaved, workViewShown } from '@shared/work-views'
import { liveCtx } from '../store'
import { getLockService } from '../lock-service'
import { sweepSpaceImages } from './space-images-electron'
import { t } from '@shared/i18n'
import { IMAGE_SWEEP_ACTIONS, PROFILE_ID } from './browser-base'
import { BrowserNetwork } from './browser-network'
import { sidebarCauseOf } from './sidebar-trace'

export abstract class BrowserActions extends BrowserNetwork {
  /**
   * An action the interface asks for. The interface was never shown the tabs and folders a lock hides, so an action that names one (an id it
   * could only have forged or kept from before) is refused; the main process' own actions on them go through `dispatch`.
   */
  dispatchFromInterface(action: Action): void {
    if (this.namesLockedTarget(action)) {
      console.warn(`[lock] refused ${String((action as { type?: unknown }).type).slice(0, 64)} from the interface: it names a tab or a folder a lock hides`)
      return
    }
    // An empty tab the user asked for (⌘T, the command bar): it is closed once left unused (shell/blank-tab-watch.ts).
    this.blankTabs.applyFromInterface(action, () =>
      // The Developer Mode row of the site panel, switched on, shows the page's developer tools too.
      applyWithDeveloperTools(action, { developerHosts: () => this.store.get().settings.developerHosts, apply: (each) => this.dispatch(each), showTools: () => this.devTools('tools') })
    )
  }

  /**
   * A work view in a window of its own (« Ouvrir dans une nouvelle fenêtre », or a view whose place is « Dans une nouvelle fenêtre »): the window of the group
   * that has it on screen comes to the front; else a new window opens, on the space of the window in front, and the view opens there (its split view comes
   * back when that space has one). Nothing from a private window, which shows no view, nor with the function off.
   */
  openWorkViewInNewWindow(id: string): void {
    const state = this.store.get()
    if (this.isPrivate() || !state.settings.workViewsEnabled || !state.workViews.some((view) => view.id === id)) return
    for (const browser of this.group) {
      const shown = browser.store.get()
      if (workViewShown(shown, id, shown.activeSpaceId)) return void browser.win.focus()
    }
    // The space is the one the new window shows (the reducer reads it from that window's state).
    const opened = this.windowMoves?.open() ?? this
    opened.dispatch({ type: 'view/open', id, here: true })
  }

  /** The tabs the windows of the group have selected, in each of their spaces (a window put away included: its selection is kept for its return). */
  protected tabsShownInGroup(): string[] {
    return [...this.group].flatMap((browser) => Object.values(browser.store.get().activeTabBySpace).filter((id): id is string => typeof id === 'string'))
  }

  /** Whether a request from the interface (an action, `{ id }`, `{ ids }`) names a tab, folder, archive entry or split view that a lock hides. */
  namesLockedTarget(request: unknown): boolean {
    const view = getLockService()?.view()
    return view !== undefined && namesHiddenId(request, hiddenIds(this.store.get(), view))
  }

  dispatch(action: Action): void {
    if (this.isPrivate()) {
      const allowed = privateAction(action)
      if (!allowed) return
      action = allowed
    }
    // A work view whose place is a window of its own: that window is opened for it, and asks for the view itself (`here`).
    if (action.type === 'view/open' && action.here !== true && opensInNewWindow(this.store.get(), action.id)) return this.openWorkViewInNewWindow(action.id)
    const lock = getLockService()
    if (lock && lockRefuses(action, lock.lockedSpaces(), this.store.get().activeSpaceId, this.store.get())) {
      console.warn(`[lock] refused ${action.type}: it concerns a locked space`)
      // A native menu or a shortcut reaches here whatever the window shows: the refusal is said, or the click would seem to do nothing.
      this.showToast(lockRefusalMessage(action))
      return
    }
    // The interface never decides which spaces « Vider l'archive » spares, nor gives a theme to a locked space: that is set from the lock, or removed.
    action = sparingLockedSpaces(action, lock?.lockedSpaces() ?? [])
    // The archive sweep and « Vider Aujourd'hui » spare what every window of the group shows, not only this one (each window's view has its own
    // selection): the tabs selected in their spaces, whatever the interface sent.
    if (action.type === 'archive/sweep' || action.type === 'today/clear') action = { ...action, shownElsewhere: this.tabsShownInGroup() }
    // With windows of their own (independentWindows), this window's view lists its own tabs only: the sweep is made on the state every window shares,
    // or the tabs of the other windows would never be swept.
    const target = action.type === 'archive/sweep' && windowsAreIndependent(this.store.root().get()) ? this.store.root() : this.store
    const state = this.store.get()
    // Every tab of every window, before the action: what the erasure at close compares with (with windows of their own, `state` lists this window's tabs only).
    const everyTab = this.store.root().get()
    if (action.type === 'tab/close') {
      const tab = state.tabs.find((t) => t.id === action.id)
      // A pinned tab is only put to sleep: drop its view so it reloads from the anchor URL.
      if (tab?.pinned) this.destroyPage(tab.id)
    }
    // The pinned tab goes back to its anchor: drop its page so it reloads from there when selected.
    if (action.type === 'tab/separate') this.destroyPage(action.id)
    // Pinned tabs sent back to their anchors reload from there.
    if (action.type === 'tabs/reset-pinned') {
      const spaceId = action.spaceId ?? state.activeSpaceId
      for (const tab of state.tabs.filter((t) => t.spaceId === spaceId && t.pinned && t.anchorUrl && t.url !== t.anchorUrl)) this.destroyPage(tab.id)
    }
    // A page is bound to the session (profile) it was created in: a tab that changes profile reloads; in the same profile it keeps its page as it is.
    if (action.type === 'tab/move-to-space') {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab || changesSession(state, tab, action.spaceId)) this.destroyPage(action.id)
    }
    if (action.type === 'space/update' && action.patch.profileId !== undefined) {
      for (const tab of state.tabs.filter((t) => t.spaceId === action.id)) this.destroyPage(tab.id)
    }
    // A page is bound to the session (profile) it was created in, and shows the address it is at: a tab the copy holds elsewhere or at another address reloads from there.
    if (action.type === 'backup/restore') {
      const incoming = new Map(action.copy.tabs.map((t) => [t.id, t]))
      for (const tab of state.tabs) {
        const wanted = incoming.get(tab.id)
        if (wanted && (wanted.url !== tab.url || wanted.spaceId !== tab.spaceId)) this.destroyPage(tab.id)
      }
    }
    // The page of the tab a reopening brings back is made while the state is applied: the pages it goes back through must be known by then.
    const reopening = this.reopened.begin(state.tabs.map((t) => t.id), this.reopenedWithHistory(action, state) ?? [])
    try {
      // An action that can move the sidebar of this window says so to the journal (sidebar-trace.ts); the others do not touch it.
      const cause = sidebarCauseOf(action)
      if (cause === null) target.dispatch(action, this.closedHistoryCtx(state))
      else this.sidebarTrace.during(cause, () => target.dispatch(action, this.closedHistoryCtx(state)))
    } finally {
      // What no page took (the tabs that open in the background) waits for its tab's page. A dispatch the shell makes from inside this one ends nothing of ours.
      this.reopened.end(reopening, () => this.store.get().tabs.filter((t) => !this.pages.has(t.id)))
    }
    // A container deleted takes its data with it: the state has dropped it (a refused action leaves it in place), the engine erases the session.
    if (action.type === 'container/delete') {
      const gone = containerById(state.settings, action.id)
      if (gone && !containerById(this.store.get().settings, action.id)) this.eraseDeletedContainer(gone)
    }
    if (!this.isPrivate() && IMAGE_SWEEP_ACTIONS.has(action.type)) this.sweepPictures(state)
    // Closing the last tab of a listed site erases its data (a restore or an import replaces tabs wholesale: nobody closed them).
    if (!WHOLE_STATE_ACTIONS.has(action.type)) this.clearOnClose(everyTab)
    if (action.type === 'tab/back-to-anchor') {
      const tab = this.store.get().tabs.find((t) => t.id === action.id)
      if (tab) this.pages.get(tab.id)?.loadURL(tab.url)
    }
    if ((action.type === 'tab/archive' || action.type === 'tab/remove-pinned' || action.type === 'tab/back-to-origin') && this.store.get().archive.length > state.archive.length) {
      this.showToast(t('browser.onglet-archive'), { label: t('menu.annuler'), run: () => this.dispatch({ type: 'archive/restore-last' }) })
    }
    // Several tabs at once (Vider Aujourd'hui, the tabs above, below or around one, a selection or a branch): the notice says how many, and "Annuler" brings exactly those back.
    if (action.type === 'today/clear' || action.type === 'tab/archive-group' || action.type === 'tabs/archive-many') {
      const n = newlyArchived(state.archive, this.store.get().archive)
      if (n > 0) this.showToast(n === 1 ? t('ctx.onglet-archive') : t('ctx.n-onglets-archives', { n }), { label: t('menu.annuler'), run: () => this.dispatch({ type: 'archive/restore-last', count: n }) })
    }
    // "Ranger les onglets…": one notice for the whole job ("3 dossiers créés"), and one "Annuler" that takes every tab out of the folders and removes the ones that were made.
    if (action.type === 'tabs/tidy') {
      const tidied = tidyOutcome(state, this.store.get())
      if (tidied) this.showToast(tidyNotice(tidied), { label: t('menu.annuler'), run: () => this.dispatch(tidied.undo) })
    }
    // A work view saved says so (its tile appears after the favourites); one removed says so too, and "Annuler" puts it back with the split views it had open.
    const saved = action.type === 'view/save' ? workViewSaved(state, this.store.get()) : undefined
    if (saved) this.showToast(t('work-view.vue-enregistree', { name: saved.name }))
    const removedView = workViewRemovedUndo(state, this.store.get(), action)
    if (removedView) this.showToast(removedView.notice, { label: t('menu.annuler'), run: () => this.dispatch(removedView.undo) })
    // « Revenir aux adresses enregistrées »: the panes whose address the state put back load it (a pane with no page yet loads it when it is shown).
    if (action.type === 'view/reset') {
      for (const tab of this.store.get().tabs) {
        const was = state.tabs.find((t) => t.id === tab.id)
        if (was && was.url !== tab.url) this.pages.get(tab.id)?.loadURL(tab.url)
      }
    }
    // A pane that left its split view: the notice names it, and "Annuler" puts the split view back as it was (same panes, same shares).
    const closedPane = paneClosedUndo(state, this.store.get(), action)
    if (closedPane) this.showToast(closedPane.notice, { label: t('menu.annuler'), run: () => this.dispatch(closedPane.undo) })
    if (action.type === 'readlater/add') this.announceReadLater(action.tabId, state)
    if (action.type === 'bookmark/add') this.announceBookmark(action.tabId, state)
    if (action.type === 'boost/save' || action.type === 'boost/delete' || action.type === 'boost/import') this.boostsChanged(action, state)
    // The row of the site panel and ⌃D both end here: the notice says what the mode does, since the only marks are a small badge and the reload.
    if (action.type === 'developer/site' && this.store.get().settings.developerHosts !== state.settings.developerHosts) {
      this.showToast(action.enabled ? t('browser.mode-developpeur-active-pour-site-l', { site: action.site }) : t('browser.mode-developpeur-desactive-pour-site', { site: action.site }))
    }
    // JavaScript was switched for a site: the response hook follows the list, and the pages of that site (every tab on it, here) load again, since
    // the policy comes with the answer of the server and a page already loaded keeps the scripts it runs.
    if (action.type === 'javascript/site' && this.store.get().settings.siteJavascriptOff !== state.settings.siteJavascriptOff) this.javascriptChanged(action)
    // A site's readable mode changed (from its panel, the menu or the command bar): the pages of that site, in every window, are looked at again.
    if (action.type === 'readable/site' && this.store.get().settings.siteReadableMode !== state.settings.siteReadableMode) this.refreshDark()
    // A restored session opens its pages in the background: the notice says how many came back (the command bar has no other feedback).
    if (action.type === 'session/restore') {
      const restored = this.store.get().tabs.length - state.tabs.length
      if (restored > 0) this.showToast(restored === 1 ? t('browser.session-restauree-1-onglet') : t('browser.session-restauree-restored-onglets', { restored }))
    }
    // A space put aside is gone from the sidebar with its pages: the notice says where it went and brings it back in one click.
    if (action.type === 'space/aside') {
      const session = this.store.get().sessions.find((s) => s.space?.space.id === action.id)
      if (session && !state.sessions.some((s) => s.id === session.id)) {
        this.showToast(t('browser.espace-name-mis-de-cote', { name: session.space!.space.name }), { label: t('browser.rouvrir'), run: () => this.dispatch({ type: 'space/reopen', id: session.id }) })
      }
    }
    if (action.type === 'space/reopen') {
      const reopened = state.sessions.find((s) => s.id === action.id)
      if (reopened?.space && !this.store.get().sessions.some((s) => s.id === action.id)) this.showToast(t('browser.espace-name-rouvert', { name: reopened.space.space.name }))
    }
    // Settings that change what pages receive are applied to the open pages right away.
    if (action.type === 'settings/update') {
      // Back stops closing tabs: what was remembered goes, so that turning the setting on later does not revive a stale origin.
      if (action.patch.backClosesOpenedTab === false) {
        for (const tab of this.store.get().tabs) if (tab.openerId !== undefined) this.store.dispatch({ type: 'tab/forget-origin', id: tab.id })
      }
      if ('boostsEnabled' in action.patch) this.refreshBoosts()
      if ('readableMode' in action.patch || 'siteReadableMode' in action.patch) this.refreshDark()
      if ('windowVibrancy' in action.patch || 'sidebarOpacity' in action.patch) this.applyWindowLook()
      this.configureBlocker()
      this.configureAutoplay()
      this.configureMinimumFontSize()
      this.configureMediaBridge()
    }
    // The user's own filter lists change what the blocker compiles.
    if (action.type === 'filterlist/add' || action.type === 'filterlist/remove' || action.type === 'filterlist/enable') this.configureBlocker()
  }

  /** Applies a change of the JavaScript list: configures the response hook, then reloads every tab on the site (the page of a sleeping tab loads it later, by itself). */
  private javascriptChanged(action: { site: string; off: boolean }): void {
    this.configureBlocker()
    const host = javascriptHostOf(action.site) ?? parseSiteHost(action.site)?.host
    if (host === undefined) return
    // The page is not rebuilt with a mark of its own, so the notice says it, and one click brings the scripts back.
    if (action.off === true) this.showToast(t('browser.javascript-desactive-pour-site', { site: host }), { label: t('browser.reactiver'), run: () => this.dispatch({ type: 'javascript/site', site: host, off: false }) })
    // Every window of the group: each holds the pages it shows, and they share one state.
    for (const tab of this.store.get().tabs) if (javascriptHostOf(tab.url) === host) for (const browser of this.group) browser.pages.get(tab.id)?.reload()
  }

  /** Deletes the pictures of spaces that nothing refers to any more. The disk is only looked at when the state that was just replaced had a picture to lose. */
  private sweepPictures(before: SidebarState): void {
    if (referencedImages(before).size === 0) return
    // The store logs what it cannot delete; nothing here throws.
    sweepSpaceImages(this.store.get())
  }

  /** "Lire plus tard" closes the tab it ran on: the toast says what became of the page, and "Annuler" takes the page out of the list and brings the tab back. */
  private announceReadLater(tabId: string, before: SidebarState): void {
    const tab = before.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const outcome = readLaterOutcome(before.readLater, tab)
    const saved = outcome === 'saved' ? this.store.get().readLater[0] : undefined
    const undo = saved
      ? {
          label: t('menu.annuler'),
          run: () => {
            this.dispatch({ type: 'readlater/remove', id: saved.id })
            if (!tab.pinned) this.dispatch({ type: 'tab/open', url: tab.url, spaceId: tab.spaceId })
          }
        }
      : undefined
    // Whatever became of the page, the notice offers the list it went to (or is in); "Annuler" stays the first button when there is one.
    const list = readLaterOffersList(outcome) ? { label: t('read-later.ouvrir-la-liste'), run: () => this.openOverlay({ panel: 'readlater' }) } : undefined
    this.showToast(readLaterNotice(outcome), undo && list ? { ...undo, second: list } : (undo ?? list))
  }

  /** "Ajouter aux signets" keeps the tab open: the toast says what became of the page, and "Annuler" takes it out of the library again. */
  private announceBookmark(tabId: string, before: SidebarState): void {
    const tab = before.tabs.find((t) => t.id === tabId)
    if (!tab || tab.private === true || !before.settings.bookmarkManager) return
    const outcome = bookmarkOutcome(before.bookmarks, tab)
    const saved = outcome === 'saved' ? this.store.get().bookmarks[0] : undefined
    this.showToast(bookmarkNotice(outcome), saved ? { label: t('menu.annuler'), run: () => this.dispatch({ type: 'bookmark/remove', id: saved.id }) } : undefined)
  }

  // ---- the pages of a closed tab (rules: shared/closed-history.ts) ----

  /** The context an archiving action is reduced with: with the setting on, the pages each tab that leaves went through (read before its page is dropped). Undefined otherwise. */
  private closedHistoryCtx(state: SidebarState): ReturnType<typeof liveCtx> | undefined {
    if (!state.settings.reopenHistory) return undefined
    return {
      ...liveCtx(),
      closedHistory: (tabId) => {
        const tab = state.tabs.find((t) => t.id === tabId)
        const page = this.ownerOf(tabId)?.pages.get(tabId)
        if (!tab || !page) return undefined
        try {
          const { entries, index } = page.navigationEntries()
          return closedHistoryOf(entries, index, tab.url)
        } catch (error) {
          // A page that is gone or cannot answer: the entry keeps its address alone.
          console.warn(`[archive] the pages of tab ${tabId} could not be read, only its address is kept:`, (error as Error).message)
          return undefined
        }
      }
    }
  }

  /** The archive entries a reopening action brings back that have a list of pages (with the setting on): the oldest first, as their tabs are made. */
  private reopenedWithHistory(action: Action, state: SidebarState): Array<{ url: string; history: ClosedHistory }> | null {
    if (!state.settings.reopenHistory) return null
    const entries =
      action.type === 'archive/restore'
        ? state.archive.filter((entry) => entry.id === action.id)
        : action.type === 'archive/restore-last'
          ? state.archive.slice(0, Math.min(Math.max(1, Math.floor(Number(action.count)) || 1), state.archive.length)).reverse()
          : []
    const withHistory = entries.filter((entry) => entry.history)
    return withHistory.length > 0 ? withHistory.map((entry) => ({ url: entry.url, history: entry.history! })) : null
  }

  /** A private window follows the main window's settings (search engine, blocking, shortcuts…), a guest window only the few that carry nothing of the owner: applied here, past the filter of `dispatch`. */
  inheritSettings(mainSettings: SidebarState['settings']): void {
    const patch = changedSettings(this.store.get().settings, this.options.guest === true ? guestInherited(mainSettings) : inheritedSettings(mainSettings))
    if (Object.keys(patch).length === 0) return
    this.store.dispatch({ type: 'settings/update', patch })
    if ('readableMode' in patch || 'siteReadableMode' in patch) this.refreshDarkHere()
    if ('windowVibrancy' in patch || 'sidebarOpacity' in patch) this.applyWindowLookHere()
    this.configureBlocker()
  }

  /** Erases a profile's cookies, storage, cache and visit history; its open tabs reload so they do not keep showing a signed-in page (see `eraseProfile`). */
  async clearProfile(profileId: string): Promise<void> {
    if (!PROFILE_ID.test(profileId)) throw new Error(`Invalid profile id: ${profileId}`)
    await eraseProfile(
      {
        clearEngine: (id) => this.engine.clearProfileData(id),
        eraseHistory: (id) => this.eraseProfileHistory(id),
        // In every window of the group: a window that shows a space of the profile would keep a signed-in page on screen.
        reloadTabs: (id) => {
          // The windows of a group share one state; each holds the pages it shows, so a tab of the profile may have its page in another window.
          const spaceIds = new Set(this.store.get().spaces.filter((s) => s.profileId === id).map((s) => s.id))
          for (const tab of this.store.get().tabs.filter((t) => spaceIds.has(t.spaceId))) for (const browser of this.group) browser.pages.get(tab.id)?.reload()
        }
      },
      profileId
    )
  }

  /**
   * "Supprimer le profil et ses données": everything the profile holds is erased (its Chrome Web Store extensions and the storage of every extension
   * too), then its name and settings go and its id is retired, so that a profile made again under the same name starts empty in a folder of its own
   * (shared/profile-retire.ts). Refused for the default profile and for a profile a space uses. When something could not be erased, the profile
   * stays listed and the error says what (as `clearProfile`).
   */
  async deleteProfile(profileId: string): Promise<void> {
    const refusal = profileDeletionRefusal(this.store.get(), profileId)
    if (refusal !== null) throw new Error(`Refused to delete the profile ${JSON.stringify(profileId).slice(0, 40)}: ${refusal}`)
    await eraseProfile({ clearEngine: (id) => this.engine.deleteProfileData(id), eraseHistory: (id) => this.eraseProfileHistory(id), reloadTabs: () => {} }, profileId)
    this.store.dispatch({ type: 'settings/update', patch: retiredSettings(this.store.get().settings, profileId) })
  }

  /**
   * At launch, before any page: the folders of the profiles deleted earlier go, and their ids are free again. Nothing when the state was not read at
   * this launch (`stateTrusted`), and never for a profile that exists again. Answers the ids whose folders were removed.
   */
  sweepRetiredProfiles(stateTrusted: boolean): string[] {
    if (this.isPrivate() || this.isSecondary()) return []
    const ids = retiredToSweep(this.store.get(), stateTrusted)
    if (ids.length === 0) return []
    const failed = this.engine.removeRetiredProfiles(ids)
    const removed = ids.filter((id) => !failed.includes(id))
    if (removed.length > 0) this.store.dispatch({ type: 'settings/update', patch: { retiredProfileIds: this.store.get().settings.retiredProfileIds.filter((id) => !removed.includes(id)) } })
    return removed
  }

  /** The profiles that hold data (a session, a history) and that no space uses (a deleted space, an old import): what "Nettoyer" lists before it erases. */
  unusedProfileIds(): string[] {
    // A space put aside is waiting for its profile's cookies and logins: it uses them still (profilesInUse counts it).
    return unusedProfileIds({ stored: this.engine.storedProfileIds(), withHistory: this.history.profiles(), used: profilesInUse(this.store.get()) })
  }

  /** Erases the data of the profiles the user confirmed, history included, if no space uses them still. Returns how many were cleaned. */
  async purgeUnusedProfiles(confirmed: readonly string[]): Promise<number> {
    return eraseProfiles((id) => this.clearProfile(id), confirmedPurge(confirmed, this.unusedProfileIds()))
  }
}
