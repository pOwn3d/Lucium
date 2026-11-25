// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). What the task manager and the resource panel
// list (the pages, their processes, what each tab uses), and their commands on a tab of any window (sleep, close, show). Cut out of
// browser-commands.ts as it was.

import type { TabResources } from '@shared/ipc'
import { tabResourcesOf, type RawProcess, type RendererHost } from '@shared/processes'
import { releasePreviews, type ReleasePreview, type ResourceTab } from '@shared/resources'
import { planReleaseLevels, type SweepEntry } from '@shared/sleep'
import { reloadWakeLimit } from '@shared/reload-all'
import { tabCloseAction } from '@shared/tab-close'
import { tabName } from '@shared/model'
import { t } from '@shared/i18n'
import { BrowserCommands } from './browser-commands'
import { LAUNCH_WAKE_GAP_MS } from './browser-base'
import { memoryPressure } from './sleep-pressure'

export abstract class BrowserResources extends BrowserCommands {
  /** Process id → title of the page it renders, for the task manager. */
  /** The tab and the space of each tab's page process, by pid (the task manager shows the space and acts on the tab). */
  pageTabs(): Map<number, { tabId: string; space: string }> {
    const tabs = new Map<number, { tabId: string; space: string }>()
    for (const browser of this.group) {
      for (const [id, page] of browser.pages) {
        const tab = this.store.get().tabs.find((t) => t.id === id)
        const pid = page.processId()
        const space = tab ? this.store.get().spaces.find((s) => s.id === tab.spaceId) : undefined
        if (tab && space && pid > 0) tabs.set(pid, { tabId: tab.id, space: space.name })
      }
    }
    return tabs
  }

  /** The tabs with no process of their own (asleep): the task manager lists them with their space and their name. */
  sleepingTabs(): Array<{ tabId: string; name: string; space: string }> {
    const live = new Set<string>()
    for (const browser of this.group) for (const [id, page] of browser.pages) if (page.processId() > 0) live.add(id)
    const { tabs, spaces } = this.store.get()
    return tabs
      .filter((tab) => !live.has(tab.id) && tab.private !== true)
      .map((tab) => ({ tabId: tab.id, name: tabName(tab), space: spaces.find((s) => s.id === tab.spaceId)?.name ?? '' }))
  }

  pageProcesses(): Map<number, string> {
    const named = new Map<number, string>()
    for (const browser of this.group) {
      for (const [id, page] of browser.pages) {
        const tab = this.store.get().tabs.find((t) => t.id === id)
        const pid = page.processId()
        if (tab && pid > 0) named.set(pid, tabName(tab))
      }
    }
    // The popup windows of pages are not tabs, but they are processes of the browser the user may want to see and end.
    for (const { pid, title } of this.engine.popupProcesses()) if (!named.has(pid)) named.set(pid, title)
    return named
  }

  /**
   * What each renderer process of this group draws besides the pages of its tabs (`pageProcesses`), by pid, for the task manager to name it:
   * the interface of each window (its sidebar, its layer of panels, its floating sidebar, its tooltip), Glance, the web panel, the side panel of
   * an extension, and the frames of other sites inside the tabs, with their tab ("Mettre en veille" puts it to sleep). No address: the name of
   * the window, of the extension, of the tab.
   */
  rendererHosts(): Map<number, RendererHost[]> {
    const hosts = new Map<number, RendererHost[]>()
    const add = (pid: number, host: RendererHost): void => {
      if (pid > 0) hosts.set(pid, [...(hosts.get(pid) ?? []), host])
    }
    const pidOf = (contents: { isDestroyed(): boolean; getOSProcessId(): number } | undefined): number => (contents && !contents.isDestroyed() ? contents.getOSProcessId() : 0)
    const state = this.store.get()
    ;[...this.group].forEach((browser, index) => {
      if (browser.win.isDestroyed()) return
      const named = state.settings.nameWindows ? browser.windowNames?.own() : undefined
      const window = named ?? (browser === this.leader ? t('processes.fenetre-principale') : t('processes.fenetre-n', { n: index + 1 }))
      add(pidOf(browser.win.webContents), { kind: 'surface', surface: 'window', window })
      add(pidOf(browser.overlay.webContents), { kind: 'surface', surface: 'overlay', window })
      add(pidOf(browser.floating.current()?.webContents), { kind: 'surface', surface: 'floating', window })
      add(pidOf(browser.tooltipWindow.current()?.webContents), { kind: 'surface', surface: 'tooltip', window })
      if (browser.peek) add(browser.peek.page.processId(), { kind: 'page', page: 'peek', window })
      if (browser.webPanel) add(browser.webPanel.page.processId(), { kind: 'page', page: 'panel', window, title: browser.webPanel.title })
      if (browser.sidePanel) add(browser.sidePanel.page.processId(), { kind: 'extension', name: browser.sidePanel.name })
      for (const [id, page] of browser.pages) {
        const tab = state.tabs.find((t) => t.id === id)
        if (tab) for (const pid of page.frameProcessIds?.() ?? []) add(pid, { kind: 'subframe', tabId: tab.id, tabName: tabName(tab) })
      }
    })
    return hosts
  }

  /**
   * The memory and processor the page of a tab uses, for its card. Null for a tab with no process: one put to sleep (no page), or frozen
   * (the page is kept, but the card says "—" for it as it does for a sleeping tab). `measure` is what Electron measures; it is only asked
   * when there is a process to look at, because every measure restarts the interval the processor figures are averaged over.
   */
  tabResources(tabId: string, measure: () => readonly RawProcess[]): TabResources | null {
    const pids: number[] = []
    let own: number | undefined
    for (const browser of this.group) {
      for (const [id, page] of browser.pages) {
        if (browser.frozen.has(id)) {
          if (id === tabId) return null
          continue
        }
        const pid = page.processId()
        if (pid > 0) pids.push(pid)
        if (id === tabId) own = pid
      }
    }
    if (own === undefined || own <= 0) return null
    return tabResourcesOf(measure(), own, process.pid, this.pageProcesses(), pids.filter((pid) => pid === own).length)
  }

  // ---- the resource panel of the sidebar (shared/resources.ts): its tabs live in every window of the group ----

  /**
   * The awake tabs of every window of the group with the figures of the process of their page, for the resource panel (shared/resources.ts ranks
   * them). A frozen page counts as asleep, as its row says; a tab of a locked space is never named, nor a page without a process. `where` is said
   * from this window: the name of the window a tab lives in when it is another one, its space when it is not the one this window shows. `levels`
   * previews the three strengths of « Libérer maintenant » over every window of the group, without asking any page; `pids` gives the process of each tab.
   */
  resourceTabs(raw: readonly RawProcess[]): { tabs: ResourceTab[]; levels: ReleasePreview[]; pids: Map<string, number> } {
    const byPid = new Map(raw.filter((p) => p.type === 'Tab').map((p) => [p.pid, p]))
    const here = this.store.get()
    const found: Array<ResourceTab & { pid: number }> = []
    ;[...this.group].forEach((browser, index) => {
      if (browser.win.isDestroyed()) return
      const state = browser.store.get()
      const named = state.settings.nameWindows ? browser.windowNames?.own() : undefined
      const window = browser === this ? undefined : (named ?? (browser === this.leader ? t('resources.fenetre-principale') : t('resources.fenetre-n', { n: index + 1 })))
      for (const [id, page] of browser.pages) {
        if (browser.frozen.has(id)) continue
        const tab = state.tabs.find((t) => t.id === id)
        const process = byPid.get(page.processId())
        if (!tab || !process || browser.isTabLocked(tab)) continue
        const space = window === undefined && tab.spaceId !== here.activeSpaceId ? state.spaces.find((s) => s.id === tab.spaceId)?.name : undefined
        const where = window ?? space
        found.push({
          pid: process.pid,
          tabId: id,
          name: tabName(tab),
          url: tab.url,
          ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
          ...(tab.icon ? { icon: tab.icon } : {}),
          ...(tab.pinned ? { pinned: true as const } : {}),
          memoryMb: Math.round(process.memoryKb / 1024),
          cpu: Math.round(process.cpu * 10) / 10,
          ...(where ? { where } : {})
        })
      }
    })
    const sharing = new Map<number, number>()
    for (const tab of found) sharing.set(tab.pid, (sharing.get(tab.pid) ?? 0) + 1)
    return {
      tabs: found.map(({ pid, ...tab }) => ((sharing.get(pid) ?? 0) > 1 ? { ...tab, shared: true as const } : tab)),
      levels: this.releaseLevels(raw),
      // The process of each tab: what the rows leave out of the total is every process that is not one of theirs (shared/resources.ts, `otherProcesses`).
      pids: new Map(found.map(({ tabId, pid }) => [tabId, pid]))
    }
  }

  /**
   * What each strength of « Libérer maintenant » would do now (`planReleaseLevels`), with the memory of the processes that would go: every live page
   * of the group counts for its process (a tab that stays awake, frozen, shown or of a locked space keeps it alive; shared/resources.ts, `releasePreviews`).
   */
  private releaseLevels(raw: readonly RawProcess[]): ReleasePreview[] {
    const entries: SweepEntry[] = this.sweepEntries()
    const plans = planReleaseLevels(entries, this.store.get().settings)
    const pages = [...this.group].flatMap((browser) => [...browser.pages].map(([id, page]) => ({ id, pid: page.processId() })))
    return releasePreviews(plans, pages, raw)
  }

  /**
   * « Annuler » after « Libérer maintenant »: the tabs of the last run that are still asleep get a page again, which loads their address afresh (the
   * mode `discard` keeps no page to put back). A few at a time, a gap apart (`wakeAtLaunch` does the same: dozens of pages made at once came on
   * screen as black rectangles), fewer when macOS says the memory is short; a tab the user showed meanwhile, or of a locked space, is left alone.
   * Resolves how many tabs are woken (the last ones come a moment later), and forgets the batch.
   */
  async undoRelease(): Promise<number> {
    const batch = this.leader.releaseBatch
    this.leader.releaseBatch = []
    const size = reloadWakeLimit(await memoryPressure())
    // The window that held a page, as long as it is still in the group.
    const windows = [...this.group]
    const pending = batch.flatMap(({ id, window }) => {
      const owner = windows.find((browser) => browser === window)
      return owner && !this.ownerOf(id) ? [{ id, owner }] : []
    })
    const wakeSome = (): void => {
      for (const { id, owner } of pending.splice(0, size)) {
        // The window may be gone by now (the application is quitting), or the tab closed or shown meanwhile.
        const tab = owner.win.isDestroyed() ? undefined : owner.store.get().tabs.find((t) => t.id === id)
        if (tab) owner.wakeInBackground([tab])
      }
      if (pending.length > 0) setTimeout(wakeSome, LAUNCH_WAKE_GAP_MS)
    }
    const total = pending.length
    wakeSome()
    return total
  }

  /** The browser of the group that holds this tab's live page, for a button of the resource panel: none for a tab that is gone, or hidden by the lock. */
  private resourceOwner(tabId: string): this | undefined {
    const owner = this.ownerOf(tabId)
    const tab = owner?.store.get().tabs.find((t) => t.id === tabId)
    return owner && tab && !owner.isTabLocked(tab) ? owner : undefined
  }

  /** ☾ of a row of the resource panel: the tab goes to sleep in the window that holds it, as « Mettre en veille » of its card (only a tab on screen is refused). */
  sleepTabAnywhere(tabId: string): Promise<boolean> {
    return this.resourceOwner(tabId)?.sleepNow(tabId) ?? Promise.resolve(false)
  }

  /**
   * ✕ of a row of the resource panel: the rule of the sidebar's cross (shared/tab-close.ts; the tab is awake: a pinned one is put back on its
   * anchor, a Today tab is archived with its « Annuler »). Done in this window when it shows the tab's list, so that the notice comes where the
   * click was; else in the window that holds it (windows of their own do not see each other's tabs).
   */
  closeTabAnywhere(tabId: string): boolean {
    const owner = this.resourceOwner(tabId)
    const tab = owner?.store.get().tabs.find((t) => t.id === tabId)
    if (!owner || !tab) return false
    const target = this.store.get().tabs.some((t) => t.id === tabId) ? this : owner
    target.dispatch({ type: tabCloseAction(tab, false), id: tabId })
    return true
  }

  /** A click on a row of the resource panel: the window that holds the tab comes to the front and shows it, in its space. */
  showTabAnywhere(tabId: string): boolean {
    const owner = this.resourceOwner(tabId)
    if (!owner) return false
    if (owner !== this && !owner.win.isDestroyed()) {
      if (owner.win.isMinimized()) owner.win.restore()
      owner.win.show()
      owner.win.focus()
    }
    owner.dispatch({ type: 'tab/select', id: tabId })
    return true
  }
}
