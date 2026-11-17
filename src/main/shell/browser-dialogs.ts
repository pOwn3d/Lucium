// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The questions a page or an extension asks: find in
// page, permissions, sign-in, the boxes of alert(), confirm() and prompt(), leaving a page, the review of an extension, the passphrase.

import { net } from 'electron'
import type { FindOptions, PassphraseRequest } from '@shared/ipc'
import type { PermissionRequest } from '@shared/model'
import { authRequestOf, sameChallenge, type AuthChallenge, type AuthRequest, type Credentials } from '@shared/http-auth'
import { PROMPT_CANCELLED, type DialogRequest, type PromptAnswer, type PromptRequest } from '@shared/page-dialog'
import { profileLabel } from '@shared/profiles'
import type { ExtensionReviewRequest } from '@shared/extension-review'
import { ExtensionActions } from './extension-actions'
import { ExtensionFolderSync } from './extension-folders'
import { STORE_URL } from '@shared/web-store'
import { buildReplaceScript, replaceMessage, type ReplaceOutcome, type ReplaceRequest } from '@shared/find-replace'
import { PERMISSION_ARM_MS, appLinkSchemeOf, hasQuestionPanel, mayRemember } from '@shared/permissions'
import { hostOf } from '@shared/url'
import { regexSearchAllowed } from '@shared/regex-find'
import { discoveryApplies } from '@shared/opensearch'
import { SearchDiscovery, fetchDescription } from './search-discovery'
import type { Engine, ExtensionReviewAsk } from '../engine/types'
import { t } from '@shared/i18n'
import { leaveRequestOf, type LeaveRequest } from '@shared/leave-sheet'
import { BrowserBase } from './browser-base'
import { settingsPath } from '@shared/settings-path'

export abstract class BrowserDialogs extends BrowserBase {
  /**
   * A page of the window finished loading: when the setting is on, look at what it declares and offer its search once. Nothing is made, read
   * or kept while the setting is off, in a private window (it has no list of its own to add to) or for a tab that is not on screen.
   */
  protected discoverSearch(id: string, url: string): void {
    // The tabs are only looked through while the function is on.
    const privateTab = this.store.get().settings.searchDiscovery && this.store.get().tabs.some((t) => t.id === id && t.private === true)
    if (!discoveryApplies(this.store.get().settings, { isPrivate: this.isPrivate(), privateTab, shown: id === this.shownTabId })) return
    this.searchDiscovery ??= new SearchDiscovery({
      state: () => this.store.get(),
      remember: (seen) => this.dispatch({ type: 'settings/update', patch: { searchDiscoverySeen: seen } }),
      addSearch: (site) => this.dispatch({ type: 'settings/update', patch: { siteSearches: [...this.store.get().settings.siteSearches, site] } }),
      notice: (message, action, durationMs) => this.showToast(message, action, durationMs),
      fetchDescription: (address) => fetchDescription(address, (target, init) => net.fetch(target, init))
    })
    const page = this.pages.get(id)
    if (page) void this.searchDiscovery.check(url, () => page.declaredSearches())
  }

  // ---- find in page ----

  findInPage(text: string, options: FindOptions): void {
    const page = this.activePage()
    if (!page) return
    // The regular-expression search is a setting: with it off the option is not honoured, whatever the interface sent.
    const regex = regexSearchAllowed(options, this.store.get().settings)
    this.find = text ? { text, matches: 0, ordinal: 0, ...(regex ? { regex: true } : {}) } : null
    page.find(text, { ...options, regex })
    this.publish()
  }

  /** Find and Replace: rewrites the matches that sit in text fields and editable regions of the page, and says how many. */
  async replaceInPage(request: ReplaceRequest): Promise<string> {
    if (!this.activePage()) return t('browser.aucune-page-ouverte')
    const outcome = (await this.evaluateInPage(buildReplaceScript(request))) as ReplaceOutcome | undefined
    const message = replaceMessage(outcome ?? { replaced: 0, editable: 0 }, this.find?.matches ?? 0)
    this.showToast(message)
    return message
  }

  endFind(): void {
    this.activePage()?.stopFind()
    this.find = null
    this.publish()
  }

  // ---- the questions of a tab that is not on screen ----

  /** Whether a page is a tab of this window that the window does not show now (a pane of the split view on screen is shown). */
  private waitsOffScreen(pageId: string): boolean {
    return this.store.get().tabs.some((tab) => tab.id === pageId) && !this.visibleIds().includes(pageId)
  }

  /**
   * Puts a question of a page before the user (`show`) only while the tab of the page is on screen. A tab behind another one that asks for a login
   * or a permission, or calls `alert()`, `confirm()` or `prompt()`, used to get its panel over the tab on screen: the box of a login whose realm
   * reads « Session expirée, mabanque.fr » over the page of the bank, or a field that takes the keys the user was typing into another page. The
   * question now waits for its tab, and a notice says which site waits, with a button that goes there. A page that is not a tab (a preview, a side
   * panel) is asked at once, as before.
   */
  protected whenOnScreen(pageId: string | undefined, show: () => void): void {
    if (pageId === undefined || !this.waitsOffScreen(pageId)) return show()
    const waiting = this.offScreenQuestions.get(pageId)
    if (waiting) return void waiting.push(show)
    this.offScreenQuestions.set(pageId, [show])
    const tab = this.store.get().tabs.find((t) => t.id === pageId)
    const site = (tab ? hostOf(tab.url) : '') || tab?.title || ''
    this.showToast(t('browser.site-attend-une-reponse-dans-son-onglet', { site }), { label: t('browser.afficher'), run: () => this.dispatch({ type: 'tab/select', id: pageId }) })
  }

  /** The tabs on screen changed: the questions that waited for one of them are put now, and those of a tab that is gone are dropped (they were cancelled with its page). */
  protected showWaitingQuestions(): void {
    if (this.offScreenQuestions.size === 0) return
    const tabs = new Set(this.store.get().tabs.map((tab) => tab.id))
    const visible = new Set(this.visibleIds())
    for (const [pageId, waiting] of [...this.offScreenQuestions]) {
      if (tabs.has(pageId) && !visible.has(pageId)) continue
      this.offScreenQuestions.delete(pageId)
      // Not in this call: the window is being laid out, and a question opens a panel over it.
      if (tabs.has(pageId)) queueMicrotask(() => waiting.forEach((show) => show()))
    }
  }

  /** A panel closed and the next question in line is about to be shown: those whose tab left the screen while they waited go back to wait for it. */
  protected parkOffScreenQuestions(): void {
    for (const request of this.permissionQueue.splice(0)) {
      const pageId = this.permissionPages.get(request.id)
      if (pageId !== undefined && this.waitsOffScreen(pageId)) this.whenOnScreen(pageId, () => this.putPermission(request))
      else this.permissionQueue.push(request)
    }
    for (const request of this.authQueue.splice(0)) {
      const pageId = this.authAnswers.get(request.id)?.pageId
      if (pageId !== undefined && this.waitsOffScreen(pageId)) this.whenOnScreen(pageId, () => this.putAuth(request))
      else this.authQueue.push(request)
    }
    for (const request of this.dialogQueue.splice(0)) {
      const pageId = this.dialogAnswers.get(request.id)?.pageId
      if (pageId !== undefined && this.waitsOffScreen(pageId)) this.whenOnScreen(pageId, () => this.putDialog(request))
      else this.dialogQueue.push(request)
    }
  }

  /** A question that is still waited for goes on screen, or in line behind the panel that is there (the user may be typing in it). */
  private putPermission(request: PermissionRequest): void {
    if (!this.permissionAnswers.has(request.id)) return
    if (this.overlayRequest) this.permissionQueue.push(request)
    else this.openOverlay({ panel: 'permission', request })
  }

  private putAuth(request: AuthRequest): void {
    if (!this.authAnswers.has(request.id)) return
    if (this.overlayRequest) this.authQueue.push(request)
    else this.openOverlay({ panel: 'auth', request })
  }

  private putDialog(request: DialogRequest): void {
    if (!this.dialogAnswers.has(request.id)) return
    if (this.overlayRequest) this.dialogQueue.push(request)
    else this.showDialog(request)
  }

  // ---- permissions ----

  /** Whether a window of the browser has a panel to put the question of this page in: false for the page of a mini window, of a web app or of a preview (the engine asks there itself). */
  hasPermissionPanel(pageId: string): boolean {
    const owner = this.ownerOf(pageId)
    return hasQuestionPanel(owner !== undefined, owner?.peek?.page.id === pageId)
  }

  protected askPermission(origin: string, permission: string, pageId?: string, detail?: string, ephemeral = false, container?: string): Promise<boolean> {
    // The prompt belongs to the window of the page that asked.
    const owner = pageId ? this.ownerOf(pageId) : undefined
    if (owner && owner !== this) return owner.askPermission(origin, permission, pageId, detail, ephemeral, container)
    const request: PermissionRequest = { id: `perm-${++this.permissionCounter}`, origin, permission, ...(detail ? { detail } : {}), ...(ephemeral ? { ephemeral: true } : {}), ...(container ? { container } : {}) }
    return new Promise((resolve) => {
      this.permissionAnswers.set(request.id, resolve)
      if (pageId) this.permissionPages.set(request.id, pageId)
      // Only while the tab that asks is on screen, and never in the place of a panel the user is typing in (it shows when that one closes).
      this.whenOnScreen(pageId, () => this.putPermission(request))
    })
  }

  /**
   * A server or a proxy asked the page for a login. One question at a time per page: a second one waits for the first, and goes
   * unasked when one before it was refused for the same server and realm (the user said no once). `null` is a refusal.
   */
  authenticate(pageId: string, challenge: AuthChallenge): Promise<Credentials | null> {
    // The prompt belongs to the window of the page that asked.
    const owner = this.ownerOf(pageId)
    if (owner && owner !== this) return owner.authenticate(pageId, challenge)
    const request = authRequestOf(`auth-${++this.authCounter}`, challenge)
    const slot = this.authPages.get(pageId) ?? { tail: Promise.resolve(), pending: 0, refused: [] }
    this.authPages.set(pageId, slot)
    const waiting = slot.pending++ > 0
    const answer = slot.tail.then(async () => {
      try {
        // The page went (`cancelAuthOf` took its slot away) while this question waited behind another one: nobody is left to log in.
        if (this.authPages.get(pageId) !== slot) return null
        if (waiting && slot.refused.some((r) => sameChallenge(r, request))) return null
        const credentials = await this.askAuth(request, pageId)
        slot.refused = credentials ? slot.refused.filter((r) => !sameChallenge(r, request)) : [...slot.refused, request]
        return credentials
      } finally {
        // Nobody left in line: a later request is a new question.
        if (--slot.pending === 0) slot.refused = []
      }
    })
    slot.tail = answer.then(() => undefined, () => undefined)
    return answer
  }

  private askAuth(request: AuthRequest, pageId: string): Promise<Credentials | null> {
    return new Promise((resolve) => {
      this.authAnswers.set(request.id, { pageId, resolve })
      // Only while the tab that asks is on screen, and never in the place of a panel the user is typing in (it shows when that one closes).
      this.whenOnScreen(pageId, () => this.putAuth(request))
    })
  }

  /** The sign-in panel's answer: the credentials, or null to cancel. They go to the page's request and are kept nowhere. */
  answerAuth(id: string, credentials: Credentials | null, fromClose = false): void {
    const pending = this.authAnswers.get(id)
    if (!pending) return
    this.authAnswers.delete(id)
    const queued = this.authQueue.findIndex((r) => r.id === id)
    if (queued >= 0) this.authQueue.splice(queued, 1)
    const current = this.overlayRequest
    if (!fromClose && current?.panel === 'auth' && current.request.id === id) this.closeOverlay()
    pending.resolve(credentials)
  }

  // ---- extensions: the sheet, the switches, the Web Store ----

  /**
   * Gives the engine what the settings say about extensions (Web Store switches, extensions switched off per profile, the folders loaded by hand)
   * when it changes.
   */
  protected configureExtensions(): void {
    if (this.isPrivate() || this.isSecondary()) return
    const { webStoreInstall, webStoreUpdates, profiles, extensionPaths, extensionTabCapture } = this.store.get().settings
    // A folder that leaves the list, by whichever way, is unloaded from every profile at once, not at the next launch; one that comes back is loaded.
    this.extensionFolders ??= new ExtensionFolderSync({
      engine: this.engine,
      loadFolder: (folder) => this.loadExtensionFolder(folder),
      notice: (message) => this.noticeWindow().showToast(message)
    })
    this.extensionFolders.follow(extensionPaths)
    const disabled = Object.fromEntries(Object.entries(profiles).flatMap(([id, own]) => (own.disabledExtensions?.length ? [[id, own.disabledExtensions] as const] : [])))
    const tabCapture = Object.fromEntries(Object.entries(profiles).flatMap(([id, own]) => (own.tabCaptureExtensions?.length ? [[id, own.tabCaptureExtensions] as const] : [])))
    const key = JSON.stringify([webStoreInstall, webStoreUpdates, disabled, tabCapture, extensionTabCapture])
    if (key === this.extensionsKey) return
    this.extensionsKey = key
    this.engine.configureExtensions({ webStoreInstall, webStoreUpdates, disabled, tabCapture, tabCaptureOn: extensionTabCapture })
  }

  /** The sheet that lists what an extension asks for. It belongs to the window of the store page that asked; closing it without answering refuses. */
  protected askExtensionReview(ask: ExtensionReviewAsk): Promise<boolean> {
    const owner = ask.pageId ? this.ownerOf(ask.pageId) : undefined
    if (owner && owner !== this) return owner.askExtensionReview({ profileId: ask.profileId, mode: ask.mode, extensionId: ask.extensionId, review: ask.review, ...(ask.icon ? { icon: ask.icon } : {}) })
    const request: ExtensionReviewRequest = {
      id: `extrev-${++this.reviewCounter}`,
      mode: ask.mode,
      extensionId: ask.extensionId,
      review: ask.review,
      profile: profileLabel(this.store.get().settings, ask.profileId),
      ...(ask.icon ? { icon: ask.icon } : {})
    }
    return new Promise((resolve) => {
      this.reviewAnswers.set(request.id, resolve)
      // Never replace a panel the user is typing in; show the sheet when it closes.
      if (this.overlayRequest) this.reviewQueue.push(request)
      else this.openOverlay({ panel: 'extreview', request })
    })
  }

  /** The sheet's answer. The interface is not trusted: only a sheet this window is waiting for is answered, once. */
  answerExtensionReview(id: string, allow: boolean, fromClose = false): void {
    const resolve = this.reviewAnswers.get(id)
    if (!resolve) return
    this.reviewAnswers.delete(id)
    const queued = this.reviewQueue.findIndex((r) => r.id === id)
    if (queued >= 0) this.reviewQueue.splice(queued, 1)
    const current = this.overlayRequest
    if (!fromClose && current?.panel === 'extreview' && current.request.id === id) this.closeOverlay()
    resolve(allow)
  }

  /** "Ouvrir le Chrome Web Store": the store's own page in a tab, when installing from it is allowed. Nothing else is fetched. */
  openWebStore(): void {
    if (this.isPrivate()) return this.showToast(t('browser.les-extensions-ne-fonctionnent-pas-dans-une'))
    if (!this.store.get().settings.webStoreInstall) return this.showToast(t('browser.l-installation-depuis-le-chrome-web-store-est', { settingsPath: settingsPath('webStoreInstall') }))
    this.dispatch({ type: 'tab/open', url: STORE_URL })
  }

  /** The extension side of the engine, for the Extensions page (the page asks the browser of its own window group). */
  get extensionEngine(): Pick<Engine, 'listAllExtensions' | 'uninstallExtension' | 'extensionTools'> {
    return this.engine
  }

  /** What the main window's browser does with extensions: the other windows ask it. */
  get extensionControl(): ExtensionActions | null {
    return this.leader.extensionActions
  }

  /** A page that is gone (closed, put to sleep) cannot use a login any more: its questions are refused. */
  protected cancelAuthOf(pageId: string): void {
    for (const [id, pending] of [...this.authAnswers]) if (pending.pageId === pageId) this.answerAuth(id, null)
    this.authPages.delete(pageId)
  }

  // ---- the boxes of window.alert(), confirm() and prompt() ----

  /**
   * The main frame of a tab's page called `alert()`, `confirm()` or `prompt()` (`body.kind`) and is blocked until this resolves. The box belongs to
   * the window that holds the page;
   * it is shown when nothing else is on screen and the tab is: a page in another tab or space waits for the user to go to it (`whenOnScreen`),
   * it is never brought forward by its own call, which would take the keys the user is typing elsewhere.
   * `signal` ends the question when the page can no longer be answered: the box goes and the page (if it still exists) gets a cancel.
   */
  askPrompt(pageId: string, body: PromptRequest, signal: AbortSignal): Promise<PromptAnswer> {
    const owner = this.ownerOf(pageId)
    if (owner && owner !== this) return owner.askPrompt(pageId, body, signal)
    const request: DialogRequest = { id: `dialog-${++this.dialogCounter}`, ...body }
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(PROMPT_CANCELLED)
      this.dialogAnswers.set(request.id, { pageId, resolve })
      signal.addEventListener('abort', () => this.answerDialog(request.id, PROMPT_CANCELLED), { once: true })
      // Only while the tab that asks is on screen, and never in the place of a panel the user is typing in (it shows when that one closes).
      this.whenOnScreen(pageId, () => this.putDialog(request))
    })
  }

  protected showDialog(request: DialogRequest): void {
    const pending = this.dialogAnswers.get(request.id)
    if (!pending) return
    // Something else took the screen since it was this box's turn: it goes back to the head of the line.
    if (this.overlayRequest) {
      this.dialogQueue.unshift(request)
      return
    }
    // Its tab left the screen while the box waited its turn: it waits for the tab now.
    if (this.waitsOffScreen(pending.pageId)) return this.whenOnScreen(pending.pageId, () => this.putDialog(request))
    this.openOverlay({ panel: 'dialog', request })
  }

  /** The panel's answer: the value typed for OK (empty for alert() and confirm()), null for Cancel. It goes to the page's call and is kept nowhere. */
  answerDialog(id: string, answer: PromptAnswer, fromClose = false): void {
    const pending = this.dialogAnswers.get(id)
    if (!pending) return
    this.dialogAnswers.delete(id)
    const queued = this.dialogQueue.findIndex((r) => r.id === id)
    if (queued >= 0) this.dialogQueue.splice(queued, 1)
    const current = this.overlayRequest
    if (!fromClose && current?.panel === 'dialog' && current.request.id === id) this.closeOverlay()
    pending.resolve(answer)
  }

  /** "Ne plus montrer" of the sheet of the news: the function goes off, and the notice that says so offers to undo it. Only while that sheet is the one open. */
  dismissWhatsNew(): void {
    if (this.overlayRequest?.panel !== 'whatsnew') return
    this.closeOverlay()
    this.dispatch({ type: 'settings/update', patch: { whatsNewSheet: false } })
    this.showToast(t('browser.les-nouveautes-ne-s-ouvriront-plus-apres-une-mise'), { label: t('menu.annuler'), run: () => this.dispatch({ type: 'settings/update', patch: { whatsNewSheet: true } }) })
  }

  // ---- "Quitter ce site ?": a page on screen holds the navigation the shell started ----

  /**
   * The page on screen refused to be left and the shell was navigating it: asks the user, with a sheet that blocks nothing. Resolves true to leave,
   * false to stay. The sheet belongs to the window of the page. While another panel is open it is not stacked on it (the user may be typing): the
   * page stays, and the navigation can be asked again once the panel is closed.
   */
  askLeave(pageId: string, site: string): Promise<boolean> {
    const owner = this.ownerOf(pageId)
    if (owner && owner !== this) return owner.askLeave(pageId, site)
    if (this.overlayRequest) return Promise.resolve(false)
    const request: LeaveRequest = leaveRequestOf(`leave-${++this.leaveCounter}`, site)
    return new Promise((resolve) => {
      this.leaveAnswers.set(request.id, { pageId, resolve })
      this.openOverlay({ panel: 'leave', request })
      // A panel that was refused (the window is locked, say) has nobody to answer it: the page stays, and the engine is not left waiting for good.
      if (this.overlayRequest?.panel !== 'leave') {
        this.leaveAnswers.delete(request.id)
        resolve(false)
      }
    })
  }

  /** The sheet's answer: true to leave the page. The interface is not trusted: only a question this window waits for is answered, once. */
  answerLeave(id: string, leave: boolean, fromClose = false): void {
    const pending = this.leaveAnswers.get(id)
    if (!pending) return
    this.leaveAnswers.delete(id)
    const current = this.overlayRequest
    if (!fromClose && current?.panel === 'leave' && current.request.id === id) this.closeOverlay()
    pending.resolve(leave)
  }

  /** A page that is gone (closed, put to sleep) cannot be asked about any more: its question goes, as a "Rester". */
  protected cancelLeaveOf(pageId: string): void {
    for (const [id, pending] of [...this.leaveAnswers]) if (pending.pageId === pageId) this.answerLeave(id, false)
  }

  /** A page that is gone (closed, put to sleep) cannot use an answer any more: its boxes are cancelled. */
  protected cancelDialogsOf(pageId: string): void {
    for (const [id, pending] of [...this.dialogAnswers]) if (pending.pageId === pageId) this.answerDialog(id, PROMPT_CANCELLED)
  }

  /** A page that is gone (closed, put to sleep, made again) cannot use a permission any more: its questions are withdrawn, shown or waiting, and refused. */
  protected cancelPermissionsOf(pageId: string): void {
    for (const [id, asker] of [...this.permissionPages]) {
      if (asker !== pageId) continue
      const queued = this.permissionQueue.findIndex((r) => r.id === id)
      if (queued >= 0) this.permissionQueue.splice(queued, 1)
      // Never remembered: the user did not answer.
      this.answerPermission(id, false, false)
    }
  }

  /**
   * The answer the interface sends for the question on screen (a click or ↩ in the bubble). A page knows when its question will appear and where
   * the bubble is drawn: it can have the user click there for something else (a game, a fake button) and ask just before the click lands. A
   * « Autoriser » that arrives less than `PERMISSION_ARM_MS` after the bubble was shown is such a click: it is ignored and the bubble stays, to be
   * answered once it has been seen. A refusal is taken at once.
   */
  answerPermissionFromPanel(id: string, allow: boolean, remember: boolean): void {
    const shown = this.permissionShown
    if (allow && shown?.id === id && Date.now() - shown.at < PERMISSION_ARM_MS) return
    this.answerPermission(id, allow, remember)
  }

  answerPermission(id: string, allow: boolean, remember: boolean, fromClose = false): void {
    const resolve = this.permissionAnswers.get(id)
    if (!resolve) return
    this.permissionAnswers.delete(id)
    this.permissionPages.delete(id)
    const current = this.overlayRequest
    if (current?.panel === 'permission' && current.request.id === id) {
      // The prompt offers to remember, but the renderer is not trusted: an answer is kept for a real web origin only, and never for openExternal.
      // A question from a private tab is never remembered: the answer would outlive the tab in the saved state.
      // A question from a page of a container is remembered in the container, and nowhere else.
      // « Toujours ouvrir les liens de ce type depuis ce site » keeps a yes only: the box ticked with « Refuser » keeps nothing.
      const kept = allow || appLinkSchemeOf(current.request.permission) === null
      if (remember && kept && current.request.ephemeral !== true && mayRemember(current.request.origin, current.request.permission)) {
        const decision = allow ? 'allow' : 'deny'
        if (current.request.container) this.dispatch({ type: 'container/permission', id: current.request.container, origin: current.request.origin, permission: current.request.permission, decision })
        else this.dispatch({ type: 'permission/set', origin: current.request.origin, permission: current.request.permission, decision })
      }
      if (!fromClose) this.closeOverlay()
    }
    resolve(allow)
  }

  // ---- passphrase (the encrypted export being restored) ----

  /**
   * Asks the user for a passphrase in a panel and resolves with it, or null when they give up. One question at a time, after what is on
   * screen. The passphrase passes through here and is kept, logged and stored nowhere. A private window cannot ask: it answers null.
   */
  askPassphrase(title: string, message: string, problem?: string | null): Promise<string | null> {
    if (this.isPrivate()) return Promise.resolve(null)
    const request: PassphraseRequest = { id: `pass-${++this.passphraseCounter}`, title, message, ...(problem ? { problem } : {}) }
    return new Promise((resolve) => {
      this.passphraseAnswers.set(request.id, resolve)
      if (this.overlayRequest) this.passphraseQueue.push(request)
      else this.openOverlay({ panel: 'passphrase', request })
    })
  }

  /** The panel's answer: the passphrase, or null to give up. */
  answerPassphrase(id: string, passphrase: string | null, fromClose = false): void {
    const resolve = this.passphraseAnswers.get(id)
    if (!resolve) return
    this.passphraseAnswers.delete(id)
    const queued = this.passphraseQueue.findIndex((r) => r.id === id)
    if (queued >= 0) this.passphraseQueue.splice(queued, 1)
    const current = this.overlayRequest
    if (!fromClose && current?.panel === 'passphrase' && current.request.id === id) this.closeOverlay()
    resolve(passphrase)
  }
}
