// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Cookies and web hardware grants, the private
// context of a window group and the containers.

import type { TabItem } from '@shared/model'
import { tidyFilename } from '@shared/tidy'
import { activeProfileId, profileDownloadDir, profileOfSpace } from '@shared/profiles'
import { containerById, containerOfTab, containersKeptTooLong, containersToSweep, type Container } from '@shared/containers'
import { anyPrivacy, privacyOptionsOf } from '@shared/privacy'
import { cookieNamesOf, cookiesToClean, groupCookieSites, siteOfCookie, type CookieName, type CookieRemoval, type CookieSite } from '@shared/cookies'
import type { DownloadPolicy, EphemeralEngine, Engine, Page } from '../engine/types'
import { downloadUi } from './download-ui'
import type { HardwareGrantRow } from '@shared/web-hardware'
import { t, tp } from '@shared/i18n'
import { BrowserDialogs } from './browser-dialogs'

export abstract class BrowserContexts extends BrowserDialogs {
  // ---- devices the pages were let use (Settings › Vie privée et sécurité › Plus de réglages) ----

  /** The grants of WebHID, WebUSB and Web Serial, for the list in Settings. A private window lists none: it has none, and shows nothing of the normal ones. */
  webHardwareGrants(): HardwareGrantRow[] {
    return this.isPrivate() ? [] : this.engine.webHardwareGrants()
  }

  /** Takes one grant back (`id`) or all of them; returns how many tabs may still hold a connection they opened. */
  revokeWebHardware(id?: string): number {
    return this.isPrivate() ? 0 : this.engine.revokeWebHardware(id)
  }

  // ---- cookies by site (the "Cookies par site" view) ----

  /** The profile whose cookies the view lists: the one of the space on screen. */
  private cookieProfile(): string {
    return activeProfileId(this.store.get())
  }

  /** The cookies of the profile grouped by site, without their values. */
  async cookieSites(): Promise<CookieSite[]> {
    return groupCookieSites(await this.engine.listCookies(this.cookieProfile()))
  }

  /** What one site set, by name and size. */
  async cookieNames(host: string): Promise<CookieName[]> {
    return cookieNamesOf(await this.engine.listCookies(this.cookieProfile()), host)
  }

  /** Removes the cookies of one site (exactly the domain the list shows). */
  async removeCookieSite(host: string): Promise<CookieRemoval> {
    const profile = this.cookieProfile()
    const all = await this.engine.listCookies(profile)
    return this.engine.removeCookies(profile, all.filter((cookie) => siteOfCookie(cookie.domain) === host))
  }

  /** Removes every cookie of the profile but those of the sites to keep (the list is read here, at the moment of the clean-up). */
  async cleanCookies(): Promise<CookieRemoval> {
    const profile = this.cookieProfile()
    const all = await this.engine.listCookies(profile)
    return this.engine.removeCookies(profile, cookiesToClean(all, this.store.get().settings.cookieKeepHosts))
  }

  // ---- private tabs ----

  /** File › Nouvel onglet privé: a blank private tab, and the command bar over it to type where it goes. Refused in a private window and when the setting is off. */
  openPrivateTab(): void {
    if (this.isPrivate() || !this.store.get().settings.privateTabs) return
    this.openedBy('private window', () => this.dispatch({ type: 'tab/open', url: 'about:blank', private: true }))
    this.openOverlay({ panel: 'commandbar', mode: 'current', initial: '' })
  }

  /**
   * The context every private tab of the normal windows lives in: a session kept in memory only, no extension, no remembered permission,
   * the blocker and privacy options of the window. Opened with the first private tab, held by the leader, erased with the last one.
   */
  protected privateContext(): EphemeralEngine {
    const leader = this.leader
    if (leader.privateScope) return leader.privateScope
    const scope = leader.engine.openEphemeral('main')
    leader.privateScope = scope
    // Nothing is remembered: every question is asked, and the answer is not kept (see `askPermission`). The page ids come without the context's prefix (`scopedPermissionPolicy`).
    scope.setPermissionPolicy({ lookup: () => undefined, ask: (origin, permission, pageId, detail) => leader.askPermission(origin, permission, pageId, detail, true), hasPanel: (pageId) => leader.hasPermissionPanel(pageId), screenShareAllowed: () => leader.store.get().settings.allowScreenShare })
    scope.onDownload((download, sourcePageId) => leader.noteDownload(download, sourcePageId))
    leader.configurePrivateContext(scope)
    return scope
  }

  /** The context a tab's page lives in: the private one for a private tab of a normal window, its container's, else the engine of this window. */
  protected engineOf(tab: Pick<TabItem, 'private' | 'container'> | undefined): Engine {
    if (!tab || this.isPrivate()) return this.engine
    if (tab.private === true) return this.privateContext()
    const container = containerOfTab(this.store.get().settings, tab)
    return container ? this.containerContext(container.id) : this.engine
  }

  // ---- containers ----

  /**
   * The context every page of a container lives in, for all the windows: a session of its own kept on disk, no extension, the permissions the
   * container remembers, the blocker and privacy options of the window. Opened with the first page of the container and held by the leader.
   */
  protected containerContext(id: string): EphemeralEngine {
    const leader = this.leader
    const open = leader.containerScopes.get(id)
    if (open) return open
    const scope = leader.engine.openContainer(id, 'main')
    leader.containerScopes.set(id, scope)
    // The answers of this container only: neither the profile's nor another container's are looked at, and a question is asked in the window of its page
    // (whose id comes without the context's prefix: `scopedPermissionPolicy`).
    scope.setPermissionPolicy({
      lookup: (origin, permission) => containerById(leader.store.get().settings, id)?.permissions?.[origin]?.[permission],
      ask: (origin, permission, pageId, detail) => leader.askPermission(origin, permission, pageId, detail, false, id),
      hasPanel: (pageId) => leader.hasPermissionPanel(pageId),
      screenShareAllowed: () => leader.store.get().settings.allowScreenShare
    })
    scope.onDownload((download, sourcePageId) => leader.noteDownload(download, sourcePageId))
    leader.configurePrivateContext(scope)
    return scope
  }

  /** The container a page of this tab must live in, as an id ('' for the profile's session or a private one): what a page is compared with to see if it must be made again. */
  protected containerKeyOf(tab: Pick<TabItem, 'private' | 'container'> | undefined): string {
    return this.isPrivate() ? '' : (containerOfTab(this.store.get().settings, tab)?.id ?? '')
  }

  /**
   * File › Nouvel onglet dans un conteneur: a blank tab in the container, and the command bar over it to type where it goes. Refused in a private
   * window, while the function is off and for a container that does not exist.
   */
  openContainerTab(id: string): void {
    const settings = this.store.get().settings
    if (this.isPrivate() || !settings.tabContainers || !containerById(settings, id)) return
    this.openedBy('container', () => this.dispatch({ type: 'tab/open', url: 'about:blank', container: id }))
    this.openOverlay({ panel: 'commandbar', mode: 'current', initial: '' })
  }

  /**
   * A deleted container's data goes, whatever it takes: its pages are destroyed in every window, its context is let go, and its session is
   * erased. What could not be erased is said to the user and logged (the folder is swept at the next launch).
   */
  protected eraseDeletedContainer(container: Container): void {
    const leader = this.leader
    for (const browser of leader.group) {
      for (const [pageId, made] of [...browser.pageContainer]) if (made === container.id) browser.destroyPage(pageId)
      if (browser.peek?.container === container.id) browser.destroyPeek()
    }
    const closing = leader.containerScopes.get(container.id)
    if (closing) leader.scopeGuards.delete(closing)
    leader.containerScopes.delete(container.id)
    const erasing = leader.engine.eraseContainer(container.id, container.name).then(
      () => leader.showToast(t('browser.conteneur-name-supprime-ses-donnees-sont', { name: container.name })),
      (error: unknown) => {
        console.error(`[containers] the data of container ${container.id} could not be fully erased:`, error)
        leader.showToast(error instanceof Error ? error.message : t('browser.impossible-d-effacer-les-donnees-du-conteneur', { name: container.name }))
      }
    )
    leader.containerErasures.add(erasing)
    void erasing.finally(() => leader.containerErasures.delete(erasing))
  }

  /** Resolves once every erasure of a deleted container has ended (quitting does not cut one short). */
  async containersSettled(): Promise<void> {
    await Promise.allSettled([...this.leader.containerErasures])
  }

  /**
   * At launch, with the function on: the folders of containers that were deleted but whose data a crash or a failure left on disk are removed,
   * before any page can open their session. Nothing runs at all while the function is off, and nothing is removed when `stateTrusted` is false:
   * the state was not read at this launch, or a set-aside copy of it is kept (`containersToSweep`). `namedByCopies`: the containers the copies of the
   * state made before a restoration name (null when they cannot be read); their folders stay, since such a copy can be put back, until nothing
   * was written in them for thirty days (`containersKeptTooLong`): each one removed for its age has its line in the log.
   */
  sweepStoredContainers(stateTrusted: boolean, namedByCopies?: () => ReadonlySet<string> | null): string[] {
    const settings = this.store.get().settings
    if (!settings.tabContainers || this.isPrivate() || this.isSecondary()) return []
    const stored = this.engine.storedContainerIds()
    const orphans = containersToSweep(stored, settings.containers, stateTrusted, namedByCopies)
    // A folder the sweep spares for a copy of the state does not stay for ever: thirty days after the last write in it, it goes too.
    const expired = containersKeptTooLong(stored, settings.containers, stateTrusted, orphans, (id) => this.engine.storedContainerIdleMs(id))
    const going = [...orphans, ...expired.map((kept) => kept.id)]
    if (going.length === 0) return []
    const failed = this.engine.removeStoredContainers(going)
    if (failed.length > 0) this.showToast(tp('browser.donnees-de-conteneurs-supprimes-non-effacees', failed.length))
    for (const { id, days } of expired) {
      if (!failed.includes(id)) console.log(`[containers] the folder of container ${id} was removed: no container of the list names it and nothing was written in it for ${days} days`)
    }
    return going.filter((id) => !failed.includes(id))
  }

  /** What the settings ask of downloads beyond the default: asking where a file goes, warning before a file that can run, links that open without keeping. The same for every context. */
  protected downloadPolicyOfSettings(): DownloadPolicy {
    const { downloadAskWhere, openUnsaved, warnExecutableDownload } = this.store.get().settings
    return {
      ask: downloadAskWhere ? (request) => downloadUi().chooseSave(this.win, request) : null,
      openUnsaved,
      confirmExecutable: warnExecutableDownload ? (request) => downloadUi().confirmExecutable(this.win, request) : null
    }
  }

  /** The downloads folder of the profile whose space holds this tab, in whichever window of the group it is; undefined (the system folder) for a page that is no tab. */
  private downloadDirOfTab(pageId: string | undefined): string | undefined {
    if (pageId === undefined) return undefined
    for (const browser of this.group) {
      const state = browser.store.get()
      const tab = state.tabs.find((item) => item.id === pageId)
      if (tab) return profileDownloadDir(state.settings, profileOfSpace(state, tab.spaceId))
    }
    return undefined
  }

  /**
   * Gives the private context and the containers' the request filter, privacy options and download naming the settings call for, and what the
   * settings say of downloads: without it « Ouvrir sans conserver » kept the file for good there, the place was never asked, and the file went to
   * the system folder whatever folder the profile of the space had been given.
   */
  protected configurePrivateContext(scope: EphemeralEngine): void {
    const { tidyDownloads } = this.store.get().settings
    const options = privacyOptionsOf(this.store.get().settings)
    scope.setDownloadNamer(tidyDownloads ? (name) => tidyFilename(name) : null)
    scope.setDownloadPolicy(this.downloadPolicyOfSettings())
    scope.setDownloadDirResolver((_context, pageId) => this.downloadDirOfTab(pageId))
    scope.setRequestBlocker(this.requestFilter())
    scope.setPrivacy(anyPrivacy(options) ? options : null)
    let guard = this.scopeGuards.get(scope)
    if (!guard) {
      guard = this.makeGuard(scope, () => this.pagesOfScope(scope))
      this.scopeGuards.set(scope, guard)
    }
    guard.configure()
  }

  /** The pages of every window of the group that live in a context of the leader: the private one, or a container. */
  private pagesOfScope(scope: EphemeralEngine): Array<{ id: string; page: Page; url: string | undefined }> {
    const container = [...this.containerScopes].find(([, context]) => context === scope)?.[0]
    return [...this.group].flatMap((browser) => {
      const ids = scope === this.privateScope ? [...browser.privatePages] : container === undefined ? [] : [...browser.pageContainer].filter(([, made]) => made === container).map(([id]) => id)
      return ids.flatMap((id) => {
        const page = browser.pages.get(id)
        return page ? [{ id, page, url: browser.store.get().tabs.find((t) => t.id === id)?.url }] : []
      })
    })
  }

  /**
   * Erases the private context once no private tab, page or preview is left in any window. A microtask later: a tab opened in the same
   * breath (a preview promoted to a tab) keeps the context, and what it had signed in to. `force`: the window is closing, now.
   */
  releasePrivateContext(force = false): void {
    if (this !== this.leader || !this.privateScope) return
    if (force) return this.eraseUnusedPrivateContext(true)
    queueMicrotask(() => this.eraseUnusedPrivateContext(false))
  }

  private eraseUnusedPrivateContext(force: boolean): void {
    const scope = this.privateScope
    if (!scope) return
    const used = [...this.group].some((b) => b.privatePages.size > 0 || b.peek?.private === true) || this.store.get().tabs.some((t) => t.private === true)
    if (used && !force) return
    this.privateScope = null
    this.scopeGuards.delete(scope)
    scope.dispose().catch((error: unknown) => console.error('[private] cannot erase the private tabs’ session:', error))
  }

  /** Whether the private context exists (the engine test looks at it). */
  hasPrivateContext(): boolean {
    return this.leader.privateScope !== null
  }
}
