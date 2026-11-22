// A layer of ElectronPage (electron-page.ts): what Lucium reads from the document and runs in it (scripts and their isolated worlds, forms,
// captures, the WebRTC policy, the colour scheme, an extension's debugger session, the page's `prompt()`, the passwords). Cut out of
// electron-page.ts as it was.

import { FILL_MARK, fakeFillScript, readFormFieldHints, type FormFieldHint } from '@shared/fake-fill'
import type { IpcMainEvent } from 'electron'
import { answerReplyOf, judgeDialog, refusalReplyOf, withoutBoxReplyOf, type DialogReply, type PageDialogKind } from '@shared/page-dialog'
import type { WebRtcPolicy } from '@shared/fingerprint'
import { eligibleOriginOf } from '@shared/passwords'
import { fillScript, type FillPlan } from '@shared/login-form'
import { PASSWORD_WORLD, judgeSubmission } from './password-bridge'
import { isMainFrameSender } from '@shared/surface-guard'
import { isInternalScheme } from '@shared/internal-page'
import { TRANSLATE_WORLD } from '@shared/translate-page-script'
import { READABLE_WORLD } from '@shared/readable-engine'
import { SITE_DATA_OVERLAY_WORLD } from '@shared/site-data-overlay'
import { PAGE_INDEX_WORLD } from '@shared/page-index'
import { PAGE_ANNOTATE_WORLD } from '@shared/page-annotate-layer'
import type { PageColorScheme } from './color-scheme'
import { innerGuardOf } from './inner-guard'
import type { Bounds } from './types'
import { CAPTURE_MAX_HEIGHT, PICK_ELEMENT, fullPageClip, prepareFullCaptureScript, readCaptureSize } from './electron-page-scripts'
import { ElectronPageNavigation } from './electron-page-navigation'

export abstract class ElectronPageContent extends ElectronPageNavigation {
  async evaluate(js: string): Promise<unknown> {
    if (this.gone) return undefined
    try {
      return await this.webContents.executeJavaScript(js)
    } catch (error) {
      if (this.gone || /disposed|destroyed/i.test(String(error))) return undefined
      throw error
    }
  }
  async readText(maxChars: number): Promise<string> {
    if (this.gone) return ''
    const text: unknown = await this.webContents.executeJavaScript(`(document.body ? document.body.innerText : '').slice(0, ${Math.floor(maxChars)})`)
    return typeof text === 'string' ? text : ''
  }

  /** The fields of the form under (x, y), marked with an attribute the fill step reads back. Read-only: nothing is written here. */
  async readFormFields(x: number, y: number): Promise<FormFieldHint[]> {
    if (this.gone) return []
    const script = `(() => {
      const at = document.elementFromPoint(${Math.floor(x)}, ${Math.floor(y)});
      const scope = (at && at.closest && at.closest('form')) || document.body;
      const fields = Array.from(scope.querySelectorAll('input, textarea'));
      return fields.map((el, index) => {
        el.setAttribute('${FILL_MARK}', String(index));
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        const label = el.labels && el.labels[0] ? el.labels[0].textContent : (el.getAttribute('aria-label') || '');
        return {
          index,
          tag: el.tagName === 'TEXTAREA' ? 'textarea' : 'input',
          type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          placeholder: el.getAttribute('placeholder') || '',
          label: label || '',
          usable: visible && !el.disabled && !el.readOnly && el.value === ''
        };
      });
    })()`
    // The script ran among the page's own: its answer is read field by field, never taken as the type it should have.
    return readFormFieldHints(await this.webContents.executeJavaScript(script))
  }

  /** Writes the planned values, through the native setter so that the page's own scripts (React, Vue...) see the change. */
  async fillFormFields(values: Array<{ index: number; value: string }>): Promise<number> {
    if (this.gone) return 0
    const written: unknown = await this.webContents.executeJavaScript(fakeFillScript(values))
    return typeof written === 'number' ? written : 0
  }

  runScript(js: string): void {
    if (!js.trim()) return
    void this.webContents.executeJavaScript(js).catch((error: unknown) => console.error(`[engine] a script failed on page ${this.id}:`, error))
  }
  async thumbnail(width: number, quality: number): Promise<Buffer> {
    const image = await this.webContents.capturePage()
    if (image.isEmpty()) return Buffer.alloc(0)
    const small = image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image
    return small.toJPEG(quality)
  }
  async capture(full: boolean, region?: Bounds, onCut?: (maxHeight: number) => void): Promise<Buffer> {
    const wc = this.webContents
    if (!full) return (await (region ? wc.capturePage(region) : wc.capturePage())).toPNG()
    // Beyond the viewport needs the DevTools protocol; attach only for the time of the shot.
    const dbg = wc.debugger
    const attachedByUs = !dbg.isAttached()
    if (attachedByUs) dbg.attach('1.3')
    let resized = false
    try {
      // The page may scroll in a container of its own, which the size of the document does not tell: walk it (it loads the lazy images), then make the
      // window as tall as the page needs, so that it draws whole and a fixed header shows once. The window is given back at the end.
      let walked: { width: number; height: number; inner: boolean } | null = null
      try {
        walked = readCaptureSize(await wc.executeJavaScript(prepareFullCaptureScript(CAPTURE_MAX_HEIGHT)))
      } catch (error) {
        console.warn(`[capture] page ${this.id} could not be walked before the full-page capture:`, error instanceof Error ? error.message : error)
      }
      // Only a container of its own needs it: the document of an ordinary page already says its height, and a taller window would change how 100vh blocks draw.
      if (walked?.inner) {
        const height = Math.min(Math.ceil(walked.height), CAPTURE_MAX_HEIGHT)
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: Math.ceil(walked.width), height, deviceScaleFactor: 0, mobile: false })
        resized = true
        // The page lays itself out again in the taller window.
        await new Promise((done) => setTimeout(done, 250))
      }
      const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }
      const size = metrics.cssContentSize ?? metrics.contentSize
      const clip = fullPageClip(size)
      if (walked && walked.height > CAPTURE_MAX_HEIGHT) onCut?.(CAPTURE_MAX_HEIGHT)
      else if (size.height > CAPTURE_MAX_HEIGHT) onCut?.(CAPTURE_MAX_HEIGHT)
      const shot = (await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })) as { data: string }
      return Buffer.from(shot.data, 'base64')
    } finally {
      if (resized && dbg.isAttached()) await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch((error: unknown) => console.warn(`[capture] page ${this.id} kept the window of the capture:`, error instanceof Error ? error.message : error))
      if (attachedByUs && dbg.isAttached()) dbg.detach()
    }
  }
  async captureViewport(format: 'png' | 'jpeg', quality: number): Promise<Buffer> {
    const dbg = this.webContents.debugger
    const attachedByUs = !dbg.isAttached()
    if (attachedByUs) dbg.attach('1.3')
    try {
      const shot = (await dbg.sendCommand('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}) })) as { data: string }
      return Buffer.from(shot.data, 'base64')
    } finally {
      if (attachedByUs && dbg.isAttached()) dbg.detach()
    }
  }
  setWebRtcPolicy(policy: WebRtcPolicy | null): void {
    if (this.gone) return
    try {
      this.webContents.setWebRTCIPHandlingPolicy(policy ?? 'default')
    } catch (error) {
      // A page that went away between the setting and now has nothing left to protect.
      console.warn(`[guard] cannot set the WebRTC policy of page ${this.id}:`, error instanceof Error ? error.message : error)
    }
  }
  async pickElement(): Promise<string | null> {
    try {
      const selector: unknown = await this.webContents.executeJavaScript(PICK_ELEMENT, true)
      return typeof selector === 'string' && selector !== '' ? selector : null
    } catch (error) {
      // Navigating away while picking rejects the script: that is a cancellation, not a failure.
      if (this.gone || /disposed|navigat|destroyed/i.test(String(error))) return null
      throw error
    }
  }
  translateScript(code: string): Promise<unknown> {
    return this.webContents.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code }])
  }
  runReadable(code: string): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error('the page is gone'))
    return this.webContents.executeJavaScriptInIsolatedWorld(READABLE_WORLD, [{ code }])
  }
  runClearOverlay(code: string): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error('the page is gone'))
    return this.webContents.executeJavaScriptInIsolatedWorld(SITE_DATA_OVERLAY_WORLD, [{ code }])
  }
  runPageIndex(code: string): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error('the page is gone'))
    return this.webContents.executeJavaScriptInIsolatedWorld(PAGE_INDEX_WORLD, [{ code }])
  }
  runAnnotateLayer(code: string): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error('the page is gone'))
    return this.webContents.executeJavaScriptInIsolatedWorld(PAGE_ANNOTATE_WORLD, [{ code }])
  }
  /**
   * Where the DevTools protocol may be used on this page right now: an address the caller allows, and not one of our error pages. Never the Extensions
   * page, whatever the caller says, nor a page on its way to it: a script registered for the next document (`Page.addScriptToEvaluateOnNewDocument`)
   * would run in that document, where the channels of the page are, and the address of a page that is still loading is the previous one.
   */
  private debugTargetAllowed(allowUrl: (url: string) => boolean): boolean {
    const url = this.webContents.getURL()
    return !isInternalScheme(url) && !this.heading.internal() && allowUrl(url) && !this.errors.showsErrorPage()
  }
  /** The colour scheme the page reads (null: its own). Nothing is attached to the page while it is null. */
  setColorScheme(scheme: PageColorScheme | null): void {
    if (this.gone) return
    this.colorScheme.set(scheme)
  }
  debugAttach(version: string, onEvent: (method: string, params: unknown) => void, onDetach: (reason: string) => void, allowUrl: (url: string) => boolean): void {
    const wc = this.webContents
    if (!this.debugTargetAllowed(allowUrl)) throw new Error('Cannot attach to this target.')
    const dbg = wc.debugger
    // The session that gives the page its colour scheme leaves the page to the extension, and comes back when the extension's session ends.
    this.colorScheme.stepAside()
    // So does the one that protects the frames and the workers of the page: while the extension debugs the page, only the page itself is protected.
    innerGuardOf(wc)?.stepAside()
    try {
      dbg.attach(version || '1.3')
    } catch (error) {
      this.colorScheme.refresh()
      innerGuardOf(wc)?.refresh()
      throw error
    }
    this.extensionDebug = true
    const message = (_e: unknown, method: string, params: unknown) => onEvent(method, params)
    dbg.on('message', message)
    // A page that goes where the extension may not follow, or whose load failed (the page of the error carries the key to let a
    // certificate through), is let go: the extension is told it was detached, as when the user opens DevTools.
    const leaveIfForbidden = (): void => {
      if (!wc.isDestroyed() && dbg.isAttached() && !this.debugTargetAllowed(allowUrl)) dbg.detach()
    }
    const onStart = (details: { isMainFrame: boolean; url: string }): void => {
      if (details.isMainFrame && (isInternalScheme(details.url) || !allowUrl(details.url)) && !wc.isDestroyed() && dbg.isAttached()) dbg.detach()
    }
    wc.on('did-start-navigation', onStart)
    // A redirect too, before it is followed: a navigation that starts at an address the extension may debug can be sent by a 302 (one the
    // extension itself answers through the protocol) to one it may not, and the protocol must be gone before that page arrives.
    wc.on('will-redirect', onStart)
    wc.on('did-navigate', leaveIfForbidden)
    wc.on('did-fail-load', leaveIfForbidden)
    dbg.once('detach', (_e: unknown, reason: string) => {
      this.extensionDebug = false
      dbg.removeListener('message', message)
      if (!wc.isDestroyed()) {
        wc.removeListener('did-start-navigation', onStart)
        wc.removeListener('will-redirect', onStart)
        wc.removeListener('did-navigate', leaveIfForbidden)
        wc.removeListener('did-fail-load', leaveIfForbidden)
      }
      onDetach(reason)
      this.colorScheme.refresh()
      innerGuardOf(wc)?.refresh()
    })
    this.debugAllowUrl = allowUrl
  }
  debugSend(method: string, params: unknown): Promise<unknown> {
    // Only the extension's own session: the one that gives the page its colour scheme is not for an extension to speak through.
    if (!this.extensionDebug) return Promise.reject(new Error('Debugger is not attached to this page.'))
    const allowUrl = this.debugAllowUrl
    if (allowUrl && !this.debugTargetAllowed(allowUrl)) {
      if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach()
      return Promise.reject(new Error('Cannot access a page the extension may not debug.'))
    }
    return this.webContents.debugger.sendCommand(method, params as object | undefined)
  }
  debugDetach(): void {
    if (this.extensionDebug && !this.gone && this.webContents.debugger.isAttached()) this.webContents.debugger.detach()
  }
  isDebugAttached(): boolean {
    return this.extensionDebug && !this.gone && this.webContents.debugger.isAttached()
  }
  sendToDocument(channel: string, payload: unknown): boolean {
    if (this.gone) return false
    this.webContents.send(channel, payload)
    return true
  }
  /**
   * `alert()`, `confirm()` or `prompt()` of the main frame (src/preload/dialog-bridge.ts): the user answers in a box of the shell, and `reply` gives the
   * page what its call returns (`answerReplyOf`). The page is blocked until then, so every way out answers: the user, a page that goes elsewhere or
   * dies, a tab that closes (the answer of a cancel). Never more than the page's own text and the address the browser holds for its frame; the page
   * cannot name the host. A page that is not a tab has no box of ours: its call goes back to its own function (`withoutBoxReplyOf`).
   */
  askDialog(kind: PageDialogKind, raw: unknown, frameUrl: string, reply: (value: DialogReply) => boolean): void {
    const verdict = judgeDialog(kind, raw, frameUrl, this.dialogGuard, Date.now())
    if (verdict.kind === 'refuse') {
      if (verdict.why !== 'suppressed') console.warn(`[dialog] refused a call of ${kind}() of page ${this.id}: ${verdict.why === 'payload' ? 'it is not what the bridge sends' : 'the page is not a page of the web'}`)
      // A page the user stopped is told so: its bridge answers the rest of its calls itself, and they never reach this process again.
      reply(refusalReplyOf(kind, verdict.why))
      return
    }
    const ask = this.events.promptDialog
    if (!ask || this.gone) {
      console.warn(`[dialog] page ${this.id} cannot show a box: it is not a tab`)
      reply(withoutBoxReplyOf(kind))
      return
    }
    const wc = this.webContents
    const ended = new AbortController()
    const leave = (): void => ended.abort()
    const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) leave()
    }
    wc.on('did-start-navigation', navigated)
    wc.once('destroyed', leave)
    wc.on('render-process-gone', leave)
    // The page is told at once when it is the one that went away; the shell takes the box away on the same signal.
    ended.signal.addEventListener('abort', () => reply(answerReplyOf(kind, null)), { once: true })
    void ask(verdict.request, ended.signal)
      .then(
        (answer) => {
          if (answer.suppress) this.dialogGuard.suppress()
          reply(answerReplyOf(kind, answer.value))
        },
        (error: unknown) => {
          // The box could not be shown: the page gets what it got before there were boxes of ours.
          console.error(`[dialog] cannot show the box of page ${this.id}:`, error instanceof Error ? error.message : String(error))
          reply(withoutBoxReplyOf(kind))
        }
      )
      .finally(() => {
        this.dialogGuard.closed(Date.now())
        wc.removeListener('did-start-navigation', navigated)
        wc.removeListener('destroyed', leave)
        wc.removeListener('render-process-gone', leave)
      })
  }
  /**
   * A message of the page bridge: a form with a password was submitted in the main frame (src/preload/password-bridge.ts). Who sent it, and what it
   * says, is judged by `judgeSubmission`; the origin the shell is told is the one of the frame, as the browser holds it, never one the page names.
   */
  passwordSubmitted(event: IpcMainEvent, raw: unknown): void {
    let frameUrl = ''
    try {
      frameUrl = event.senderFrame?.url ?? ''
    } catch (error) {
      // The frame went away between the message and now: its address is unknown and the message is refused (the empty address cannot hold a password).
      console.warn('[passwords] the frame of a submission is gone:', error instanceof Error ? error.name : typeof error)
    }
    const verdict = judgeSubmission({ mainFrame: isMainFrameSender(event), frameUrl, isTab: this.events.passwordSubmitted !== undefined }, raw)
    if (!verdict.ok) return console.warn(`[passwords] refused a submission of page ${this.id}: ${verdict.why}`)
    try {
      this.events.passwordSubmitted?.(verdict.frameUrl, verdict.submission)
    } catch (error) {
      // A fault on our side must not take the main process down for a form the user submitted; the offer to save is simply not made.
      console.error(`[passwords] the submission of page ${this.id} could not be handled:`, error instanceof Error ? error.name : typeof error)
    }
  }
  async fillLogin(plan: FillPlan): Promise<unknown> {
    if (this.gone) return { ok: false, reason: 'origin' }
    const wc = this.webContents
    // The last look from this side, before the secret leaves the main process: the main frame is still on the origin of the entry.
    if (eligibleOriginOf(wc.mainFrame.url) !== plan.origin) return { ok: false, reason: 'origin' }
    // Never a user gesture: the page is not made to think the user clicked.
    return wc.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: fillScript(plan) }])
  }
}
