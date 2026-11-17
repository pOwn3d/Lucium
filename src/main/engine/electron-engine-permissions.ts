// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The permissions of the pages and the questions
// they lead to: the system boxes, the share of a screen, the choice of a device, the web hardware.

import { BrowserWindow, desktopCapturer, dialog, Menu, systemPreferences, type IpcMainEvent, type MenuItemConstructorOptions, type Session, type WebContents, webContents as allWebContents, type WebFrameMain } from 'electron'
import { isAuthContents } from './web-auth'
import { appLinkPermission, externalSchemeOf, fileSystemDetail, mayRemember, permissionSheet, questionPlace, routePermission } from '@shared/permissions'
import { queriedPermission } from '@shared/permission-state'
import type { LinkAsker } from '@shared/external-links'
import { isMainFrameSender } from '@shared/surface-guard'
import { closeOnPageClick, type ClosablePopup } from './action-popup'
import { OpenQuestions, questionKey } from './open-questions'
import { createDisplayMediaHandler, type DisplayMediaRequest } from './display-media'
import { extensionOfUrl } from './tab-capture'
import type { HardwareChoice } from './web-hardware'
import { pickerMenu, type HardwareGrantRow } from '@shared/web-hardware'
import type { PermissionPolicy } from './types'
import { t } from '@shared/i18n'
import { ElectronPage } from './electron-page'
import { ElectronEngineProfile } from './electron-engine-profile'

export abstract class ElectronEnginePermissions extends ElectronEngineProfile {
  /** The sheets that wait for their answer: a page that asks again meanwhile gets the answer of the sheet already shown. */
  private readonly sheets = new OpenQuestions()

  setWebHardware(enabled: boolean): number {
    if (enabled) {
      this.hardware.enable()
      return 0
    }
    return this.hardware.disable()
  }

  webHardwareGrants(): HardwareGrantRow[] {
    return this.hardware.list()
  }

  revokeWebHardware(id?: string): number {
    return this.hardware.revoke(id)
  }

  /**
   * `hardwareProfile`: the profile of a persistent session, which may be given devices; a private context passes none and is never given one.
   * `tabAnswers`: whether an answer given without « Se souvenir » holds for the tab that asked, until its page goes (tab-answers.ts). A private
   * context passes false: nothing of what is answered there is kept, not even for the life of the tab.
   */
  protected installPermissions(ses: Session, policyOf: () => PermissionPolicy | null = () => this.policy, hardwareProfile?: string, tabAnswers = true): void {
    this.permissionSessions.set(ses, { policyOf, tabAnswers })
    // Decided on the protocol of the URL that asks (see routePermission): the `origin` of a file:, about:blank or extension page is "null".
    // A page of an extension is granted what the manifest of the extension, as loaded in this session, declares.
    const manifestPermissionsOf = (extensionId: string): readonly unknown[] | undefined => {
      const declared: unknown = ses.extensions?.getExtension(extensionId)?.manifest?.permissions
      return Array.isArray(declared) ? declared : undefined
    }
    ses.setPermissionRequestHandler((wc, permission, answer, details) => {
      // A tab given the camera, the microphone or the screen may be in a call: the sleep sweep leaves it running (Page.usesCapture).
      const callback = (granted: boolean): void => {
        if (granted && wc && (permission === 'media' || permission === 'display-capture')) this.pageOfContents(wc)?.noteCapture()
        answer(granted)
      }
      // The page of a sign-in flow has no address bar to say who is asking: it may ask for nothing.
      if (isAuthContents(wc)) return callback(false)
      // A page of an extension is never given the screen (routePermission refuses it): the one page that holds this permission is the helper page of a capture of the
      // sound of a tab, while the claim it was made for has not begun (tab-capture.ts). The stream is answered by the display handler below, with the sound of that tab.
      if (permission === 'display-capture' && this.helperMayShare(ses, wc)) return callback(true)
      // An about:blank window (a call window a site writes into) asks under the origin it inherits: the request's security origin, else its opener's.
      const inherited = ('securityOrigin' in details && typeof details.securityOrigin === 'string' ? details.securityOrigin : undefined) ?? wc?.opener?.origin
      const route = routePermission(permission, details.requestingUrl, manifestPermissionsOf, inherited)
      if (route.kind === 'grant') return callback(true)
      // Refused without a question, and not without a trace: a site that waits for an answer it never gets is found in the log.
      if (route.kind === 'deny' && route.notOffered) console.warn(`[engine] refused "${permission}" without a question: no page is offered it`)
      // A device is chosen in the list of the hardware service (the select-* events), never granted by a generic question.
      if (route.kind === 'deny' || route.kind === 'hardware') return callback(false)
      const policy = policyOf()
      if (!policy) return callback(false)
      const { origin } = route
      if (permission === 'display-capture' && !policy.screenShareAllowed()) {
        console.warn(`[engine] refused to share the screen to ${origin}: sharing the screen is turned off in the settings`)
        return callback(false)
      }
      // Electron asks for the screen whenever a script calls getDisplayMedia, with no click behind it (Chromium's rule that a user gesture is
      // needed is not applied). So the browser checks that the user just did something in this tab, before any remembered answer is read.
      if (permission === 'display-capture' && !this.mayShareScreen(wc)) {
        console.warn(`[engine] refused to share the screen to ${origin}: no click or key in the tab explains the request`)
        return callback(false)
      }
      // What was remembered is only read for a permission that may be remembered: openExternal is asked each time, whatever an older version kept.
      if (mayRemember(origin, permission)) {
        const remembered = policy.lookup(origin, permission)
        if (remembered) return callback(remembered === 'allow')
        // A yes this tab was given for the site holds while its page lives: the site is not asked about twice. A no is asked again when the
        // page asks again (the user has no other place to take it back).
        if (tabAnswers && wc && this.tabAnswers.of(wc.id, origin, permission) === 'allow') return callback(true)
      }
      /** The answer of the user, kept for the tab unless the user had it remembered (the state then answers, and can be changed in the settings). */
      const answered = (granted: boolean): void => {
        if (tabAnswers && wc && !wc.isDestroyed() && mayRemember(origin, permission) && policy.lookup(origin, permission) === undefined) {
          const tab = wc.id
          if (this.tabAnswers.note(tab, ses, origin, permission, granted ? 'allow' : 'deny')) wc.once('destroyed', () => this.tabAnswers.forget(tab))
        }
        callback(granted)
      }
      // What the question must name besides the site: the scheme another application would be opened with, the file or the folder a page wants to read or modify.
      const scheme = permission === 'openExternal' && 'externalURL' in details ? externalSchemeOf(details.externalURL) : permission === 'fileSystem' ? fileSystemDetail(details) : ''
      // A popup, and the page of a window that is not a tab (a mini window, a web app), have no panel to put the question in: the panel of a tab is in the window of the
      // tab, behind. The question is put on the window of the page itself, as a sheet of the system, and what is answered is not remembered. (A popup used to be
      // refused without a word, which is how Meet in a window of its own could not be given the camera.)
      const question = this.putQuestion(policy, wc, origin, permission, scheme || undefined)
      if (!question) return callback(false)
      question.answer.then(answered, (error: unknown) => {
        console.error(`[engine] permission ${question.place === 'sheet' ? 'sheet' : 'prompt'} failed for ${origin}/${permission}:`, error)
        callback(false)
      })
    })
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      if (isAuthContents(wc)) return false
      const route = routePermission(permission, details.requestingUrl ?? requestingOrigin, manifestPermissionsOf, details.securityOrigin ?? requestingOrigin)
      if (route.kind === 'hardware') {
        return hardwareProfile !== undefined && this.hardware.mayRequest({ permission, origin: details.securityOrigin ?? requestingOrigin, ...(details.embeddingOrigin !== undefined ? { embeddingOrigin: details.embeddingOrigin } : {}), contentsKnown: wc !== null, isMainFrame: details.isMainFrame })
      }
      if (route.kind !== 'policy') return route.kind === 'grant'
      return this.permissionStanding(ses, wc ? wc.id : null, route.origin, permission) === 'allow'
    })
  }

  /**
   * Puts the question of a permission where the user will see it: the panel of the tab, or a sheet of the system on the window of a page that
   * has no panel. Null when there is no window to put it on.
   */
  private putQuestion(policy: PermissionPolicy, wc: WebContents | null, origin: string, permission: string, detail: string | undefined): { place: 'panel' | 'sheet'; answer: Promise<boolean> } | null {
    const pageId = wc ? this.pageIdOf(wc) : undefined
    const popupWindow = this.popups.windowOf(wc)
    if (questionPlace(popupWindow !== undefined, pageId === undefined ? undefined : policy.hasPanel?.(pageId)) === 'sheet') {
      const window = popupWindow ?? (wc ? BrowserWindow.fromWebContents(wc) : null)
      if (!window || window.isDestroyed()) return null
      return { place: 'sheet', answer: this.askOnWindow(window, origin, permission, detail) }
    }
    return { place: 'panel', answer: policy.ask(origin, permission, pageId, detail) }
  }

  /**
   * The question behind a link of a page to another application (`zoommtg:`, `slack:`…), which Chromium does not ask for itself when the engine
   * stops the navigation: the question of `openExternal`, in the same place and in the same words as for a redirect, with the scheme. False,
   * without a question, for a page that may ask for nothing (a sign-in flow, a page without an origin) or while no window answers.
   *
   * What the user had kept for this site and this scheme (« Toujours ouvrir les liens de ce type depuis ce site », or a refusal chosen in the
   * site panel) answers without a question. The box is offered only for a link a click explains (`clicked`): a page that sends to its
   * application as it loads gets the plain question, whose answer nobody keeps. A private context keeps nothing and reads nothing.
   *
   * `asker`, when the page itself is not the one that asks: a frame of another site (an advertisement, a widget) gets the plain question under
   * its own site, so that the user knows who asks and the yes given to the page does not open anything for it; when nobody can be named, the
   * plain question under the page's site. Neither reads nor keeps an answer.
   */
  protected askAppLink(wc: WebContents, scheme: string, clicked = false, asker?: LinkAsker): Promise<boolean> {
    if (wc.isDestroyed() || isAuthContents(wc)) return Promise.resolve(false)
    const route = routePermission('openExternal', wc.getURL())
    const known = this.permissionSessions.get(wc.session)
    const policy = known?.policyOf() ?? null
    if (route.kind !== 'policy' || !known || !policy) return Promise.resolve(false)
    if (asker !== undefined && asker.kind !== 'page') {
      const named = asker.kind === 'frame' ? routePermission('openExternal', asker.origin) : route
      if (named.kind !== 'policy') return Promise.resolve(false)
      return this.putQuestion(policy, wc, named.origin, 'openExternal', externalSchemeOf(scheme) || undefined)?.answer ?? Promise.resolve(false)
    }
    const kept = appLinkPermission(scheme)
    const keepable = kept !== null && known.tabAnswers && mayRemember(route.origin, kept)
    if (keepable) {
      const remembered = policy.lookup(route.origin, kept)
      if (remembered === 'allow') return Promise.resolve(true)
      if (remembered === 'deny') {
        console.info(`[engine] a ${scheme} link was refused without a question: the user blocked the links of this type for the site`)
        return Promise.resolve(false)
      }
    }
    return this.putQuestion(policy, wc, route.origin, keepable && clicked ? kept : 'openExternal', externalSchemeOf(scheme) || undefined)?.answer ?? Promise.resolve(false)
  }

  /**
   * A server asked the page of `contents` for a client certificate and was given none (shell/certificates.ts). True when the shell was told, to
   * say it in the window of that page; false for contents that are not a page of a tab (a popup, a request of the application itself).
   */
  clientCertificateRefused(contents: unknown, site: string): boolean {
    const page = contents !== null && typeof contents === 'object' && typeof (contents as { id?: unknown }).id === 'number' ? this.pageOfContents(contents as WebContents) : undefined
    return page !== undefined && page.clientCertificateRefused(site)
  }

  /**
   * Where a site stands for a permission, without asking anybody: what the user had remembered, else what the tab was answered (`tab` null: a
   * check that names no tab, answered yes when a tab of the session was). Undefined: nobody answered yet.
   */
  private permissionStanding(ses: Session, tab: number | null, origin: string, permission: string): 'allow' | 'deny' | undefined {
    const known = this.permissionSessions.get(ses)
    // A permission that is asked each time has no standing; nor has anything while no window answers.
    if (!known || !mayRemember(origin, permission)) return 'deny'
    const policy = known.policyOf()
    if (!policy) return 'deny'
    const remembered = policy.lookup(origin, permission)
    if (remembered) return remembered
    if (!known.tabAnswers) return undefined
    if (tab !== null) return this.tabAnswers.of(tab, origin, permission)
    return this.tabAnswers.allowedIn(ses, origin, permission) ? 'allow' : undefined
  }

  /**
   * The page of a tab asks whether a permission was ever answered for its site (src/preload/permission-state.ts, a synchronous message: the page
   * is waiting). True only for the main frame of a web page of a session of ours, about a permission the user is asked for, that nobody answered:
   * the page then reads "default" and "prompt" where Electron alone says "denied". Everything else is false, and the page reads what Chromium says.
   */
  protected permissionUndecided(event: IpcMainEvent, raw: unknown): void {
    let undecided = false
    try {
      const permission = queriedPermission(raw)
      const sender = event.sender
      if (permission !== null && isMainFrameSender(event) && !isAuthContents(sender)) {
        const route = routePermission(permission, event.senderFrame?.url ?? '')
        if (route.kind === 'policy') undecided = this.permissionStanding(sender.session, sender.id, route.origin, permission) === undefined
      }
    } catch (error) {
      // The page keeps what Chromium says ("denied"), and the log says why.
      console.error('[engine] cannot tell a page whether a permission was answered:', error instanceof Error ? error.message : String(error))
    }
    event.returnValue = undecided
  }

  /**
   * The question of a permission as a sheet of the system on a window that has no panel of its own. Resolves with the answer; closing the sheet
   * refuses. The same question is on the window once: a page that asks in a loop does not stack sheets (open-questions.ts).
   */
  private askOnWindow(window: BrowserWindow, origin: string, permission: string, detail?: string): Promise<boolean> {
    return this.sheets.ask(questionKey(window.id, origin, permission, detail), () => this.showSheet(window, origin, permission, detail))
  }

  private async showSheet(window: BrowserWindow, origin: string, permission: string, detail?: string): Promise<boolean> {
    const sheet = permissionSheet(origin, permission, detail)
    if (window.isMinimized()) window.restore()
    window.show()
    const answer = await dialog.showMessageBox(window, { type: 'question', message: sheet.message, detail: sheet.detail, buttons: [sheet.deny, sheet.allow], defaultId: 0, cancelId: 0, noLink: true })
    return answer.response === 1
  }

  /**
   * A click anywhere else closes the popup of an extension's button. The library closes it when its window loses the focus, which a click in the
   * page of a tab (a view of the same window) does not always take from it: the pages that are on show then close it themselves. The interface is left out on
   * purpose: the same click on the icon that opened the popup must close it, and the library does that.
   */
  protected closePopupOnPageClick(popup: ClosablePopup & { parent?: BrowserWindow }): void {
    const parent = popup.parent
    if (!parent || parent.isDestroyed()) return
    const pages: WebContents[] = []
    for (const child of parent.contentView.children) {
      const wc = (child as unknown as { webContents?: WebContents }).webContents
      if (wc && !wc.isDestroyed() && this.pageByContents.has(wc.id)) pages.push(wc)
    }
    closeOnPageClick(popup, pages)
  }

  /** A tab page, with a click or a key in it just now (not a popup, a panel or a page of an extension): the only asker of `display-capture`.
   *  The click is used up by the share it allows: one click shares the screen once, not every call of the next five seconds. */
  private mayShareScreen(wc: WebContents | null): boolean {
    const page = wc ? this.pageOfContents(wc) : undefined
    return page !== undefined && page.takeShareGesture(Date.now())
  }

  /**
   * getDisplayMedia, once the permission above was given: the handler lists the screens and windows and the user picks what leaves in a menu of
   * ours, on every system. The system's own picker (`useSystemPicker`) is never asked for: in Electron 45 it crashes the application. The engine
   * checks put a stub with the same rules in its place (smoke-runtime.ts): a test must never list or capture the screen.
   */
  protected installDisplayMedia(ses: Session): void {
    const handler = createDisplayMediaHandler({
      platform: process.platform,
      screenAccess: () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'),
      // No thumbnails and no icons: the menu only needs the names, and a picture of every window is what the system asks for the right to take.
      listSources: async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })).map(({ id, name }) => ({ id, name })),
      choose: async (request, choices) => {
        const picked = await this.chooseShare(request, choices.map((c) => ({ id: c.id, label: c.label })))
        // The window the page is in, shared by its own page: the page annotation starts on that page (shared/page-annotate.ts).
        const page = this.pageOfFrame(request)
        const own = page && !page.window.isDestroyed() ? page.window.getMediaSourceId() : null
        // A trace of every request, for the annotation of a window. The verdict (which window of Lucium it is, if any) is traced by the browser
        // that owns the window. The name is not traced: a window name is often the title of its page.
        console.info(`[annotate-share] choix: id=${picked ?? 'aucun'} fenetre-demandeuse=${own ?? 'inconnue'} page=${page ? 'oui' : 'non'}`)
        if (picked !== null) page?.ownWindowShared(picked)
        return picked
      },
      blocked: (request, notice, openSettings) => this.pageOfFrame(request)?.screenShareBlocked(notice, openSettings),
      warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail))
    })
    // Lucium's own list, not macOS's picker: the system picker crashes the app (NSGenericException, ScreenCaptureKit). Who asks decides what is answered: the helper page of
    // a capture gets the sound of the tab it was made for, a page of an extension gets nothing (never the list, never a screen or a window), any other page the list.
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        const asker = this.askerOfDisplayRequest(request.frame)
        if (asker.kind === 'helper') return this.answerCaptureHelper(ses, request, asker.contentsId, callback)
        // A frame that cannot be read is gone: nobody is left to answer.
        if (asker.kind === 'refused') return callback(null)
        handler(request, callback)
      },
      { useSystemPicker: false }
    )
  }

  /**
   * Whose frame asks for a stream: the main frame of the helper page of a capture, a frame that gets nothing (a page of an extension, another frame of a helper page, a frame that
   * was disposed as the question came and cannot be read), or any other (the ordinary rules judge it).
   */
  private askerOfDisplayRequest(frame: WebFrameMain | null): { kind: 'helper'; contentsId: number } | { kind: 'refused' } | { kind: 'other' } {
    if (!frame) return { kind: 'other' }
    try {
      if (extensionOfUrl(frame.url) !== null) return { kind: 'refused' }
      const contents = allWebContents.fromFrame(frame)
      if (!contents || !this.tabCaptures.isHelper(contents.id)) return { kind: 'other' }
      return frame.parent === null ? { kind: 'helper', contentsId: contents.id } : { kind: 'refused' }
    } catch (error) {
      console.warn('[tab-capture] the frame that asked for a stream could not be read, so it is refused:', error instanceof Error ? error.message : String(error))
      return { kind: 'refused' }
    }
  }

  /** The permission to ask for a screen (`display-capture`) is held by the helper page of a capture that has not begun: and by no other page. */
  private helperMayShare(ses: Session, wc: WebContents | null): boolean {
    if (wc === null) return false
    const profileId = this.profileOfSession(ses)
    return profileId !== undefined && this.tabCaptures.mayShare(wc.id, profileId)
  }

  /**
   * The stream the helper page asked for: the sound of the tab its claim names, and the picture of the helper page itself (which the page takes off the stream before it
   * has it: nothing of the tab is ever in a picture). A stream that cannot be handed to the page ends the capture it began.
   */
  private answerCaptureHelper(ses: Session, request: { frame: WebFrameMain | null }, contentsId: number, callback: (streams: { audio: WebFrameMain; video: WebFrameMain } | null) => void): void {
    const profileId = this.profileOfSession(ses)
    const answered = profileId === undefined ? null : this.tabCaptures.answerHelper(request, contentsId, profileId)
    if (!answered) return callback(null)
    try {
      callback({ audio: answered.audio as WebFrameMain, video: answered.video })
    } catch (error) {
      // The helper page went away between the question and the answer (Electron throws for a frame that is gone): what was begun is ended, and the sound comes back.
      console.warn('[tab-capture] the stream could not be handed to the helper page, the capture ends:', error instanceof Error ? error.message : String(error))
      this.tabCaptures.abort(answered.claim.id)
    }
  }

  private pageOfFrame(request: DisplayMediaRequest): ElectronPage | undefined {
    // Electron hands the frame itself; the type keeps only what the rules read.
    const frame = request.frame as WebFrameMain | null
    const contents = frame ? allWebContents.fromFrame(frame) : undefined
    return contents ? this.pageOfContents(contents) : undefined
  }

  /** The menu of what can be shared, over the window of the page that asked. Resolves with the id picked, or null when the menu closes with none. */
  private chooseShare(request: DisplayMediaRequest, choices: Array<{ id: string; label: string }>): Promise<string | null> {
    const win = this.pageOfFrame(request)?.window
    return new Promise((resolve) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate([
        { label: t('menu.partager'), enabled: false },
        { type: 'separator' },
        ...choices.map((choice): MenuItemConstructorOptions => ({ label: choice.label, click: () => (picked = choice.id) }))
      ])
      // The click of an item can be delivered just after the menu reports that it closed: the answer waits for it.
      menu.popup({ ...(win && !win.isDestroyed() ? { window: win } : {}), callback: () => setTimeout(() => resolve(picked), 100) })
    })
  }

  /**
   * The list of devices, as a menu over the window of the tab that asked. Its first two lines are text that names the site, so a pointer that
   * lands where the menu opened selects nothing. Resolves with the id of the device picked, or null when the menu closes with none.
   */
  protected chooseHardware(request: HardwareChoice): Promise<string | null> {
    const page = this.pageOfContents(request.contents as unknown as WebContents)
    const win = page?.window
    return new Promise((resolve) => {
      let picked: string | null = null
      const template = pickerMenu(request).map((item): MenuItemConstructorOptions => {
        if (item.separator) return { type: 'separator' }
        const choice = item.choice
        return { label: item.label ?? '', enabled: item.enabled, ...(choice !== undefined ? { click: () => (picked = choice) } : {}) }
      })
      // The click of an item can be delivered just after the menu reports that it closed: the answer waits for it.
      Menu.buildFromTemplate(template).popup({ ...(win && !win.isDestroyed() ? { window: win } : {}), callback: () => setTimeout(() => resolve(picked), 100) })
    })
  }
}
