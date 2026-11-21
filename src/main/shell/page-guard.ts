// The page guard of a window: what the blocker's scriptlets and the fingerprint protection need from the shell. It keeps the engine in line with
// the settings (a preload and a response hook while a feature is on, nothing at all while both are off) and gives each page its WebRTC policy.
// Electron-free: the engine, the blocker and the pages come in as small ports, so it is tested without a window.

import { createHmac, randomBytes } from 'node:crypto'
import { adsBlockingOn, blockerIsOn } from '@shared/blocker'
import type { Settings } from '@shared/model'
import { fingerprintConfigFor, fingerprintFallback, webRtcPolicyFor, type WebRtcPolicy } from '@shared/fingerprint'
import type { GuardPlan } from '@shared/page-guard'
import { siteOf } from '@shared/party'
import { javascriptPolicyFor } from '@shared/site-javascript'
import type { ScriptletCall } from '@shared/scriptlets'
import type { InnerGuardProvider, PageGuardProvider, ResponsePolicy } from '../engine/types'

/**
 * Per-site seeds for the noise of the fingerprint protection. The key is drawn at random the first time a seed is asked for, kept in memory only,
 * and gone when the window is: a site sees the same noise on all its pages during a session, another site another noise, and the next session
 * a new one. Nothing is written anywhere, so nothing links two sessions.
 */
export class SiteSeeds {
  private key: Buffer | null = null

  constructor(private readonly random: (size: number) => Buffer = randomBytes) {}

  /** The seed of the site an address belongs to (its registrable domain; the host itself when it has none), as an unsigned 32-bit number. */
  seedFor(url: string): number {
    const site = siteOf(url) ?? (URL.canParse(url) ? new URL(url).hostname : '')
    this.key ??= this.random(16)
    return createHmac('sha256', this.key).update(site).digest().readUInt32BE(0)
  }

  /** A number of this session that is the seed of no site: what the seed of a page the engine has not heard of yet is drawn from. */
  salt(): number {
    this.key ??= this.random(16)
    // A site is never the empty text followed by this label: the two cannot meet.
    return createHmac('sha256', this.key).update('\0inner').digest().readUInt32BE(0)
  }
}

export interface GuardEngine {
  setPageGuard(provider: PageGuardProvider | null): void
  setInnerGuard(provider: InnerGuardProvider | null): void
  setResponsePolicy(policy: ResponsePolicy | null): void
}

export interface GuardBlocker {
  scriptletCalls(pageUrl: string, settings: Settings): ScriptletCall[]
  cspFor(pageUrl: string, settings: Settings): string | null
}

export interface GuardPage {
  setWebRtcPolicy(policy: WebRtcPolicy | null): void
}

export interface GuardDeps {
  settings(): Settings
  engine: GuardEngine
  /** The application's blocker; asked only while the extended rules are on. */
  blocker(): GuardBlocker
  seeds: SiteSeeds
  /** The pages of the window with the address each one shows. */
  pages(): Iterable<{ id: string; page: GuardPage; url: string | undefined }>
}

export class PageGuard {
  /** What the engine was last given. Both start "off": a window whose features are off never calls the engine for them. */
  private guardOn = false
  private innerOn = false
  private cspOn = false
  /** The WebRTC policy each page was last given; absent means Chromium's default. */
  private readonly webRtc = new Map<string, WebRtcPolicy>()

  constructor(private readonly deps: GuardDeps) {}

  /** Brings the engine in line with the settings. Cheap and idempotent: the settings window calls it at each change. */
  configure(): void {
    const settings = this.deps.settings()
    const scriptlets = settings.blockScriptlets && blockerIsOn(settings)
    // The YouTube player rules need the guard on, with the ads switch alone (see blocker.scriptletCalls).
    const guardOn = scriptlets || settings.reduceFingerprint || adsBlockingOn(settings)
    if (guardOn !== this.guardOn) {
      this.guardOn = guardOn
      this.deps.engine.setPageGuard(guardOn ? (request) => this.planFor(request.pageUrl) : null)
    }
    // The frames, the workers and the service workers follow the fingerprint protection alone: the scriptlets are for the page.
    const innerOn = settings.reduceFingerprint
    if (innerOn !== this.innerOn) {
      this.innerOn = innerOn
      this.deps.engine.setInnerGuard(innerOn ? () => fingerprintFallback(this.deps.settings(), this.deps.seeds.salt()) : null)
    }
    // The hook is on while the blocker has a policy to add or a site has its JavaScript off; with neither, no answer is looked at for it.
    const policyOn = scriptlets || settings.siteJavascriptOff.length > 0
    if (policyOn !== this.cspOn) {
      this.cspOn = policyOn
      this.deps.engine.setResponsePolicy(policyOn ? (request) => this.policyFor(request.url) : null)
    }
    this.refreshPages()
  }

  /**
   * The Content-Security-Policy a main document is given: the blocker's (only while the scriptlets are on) and the one that stops the scripts of a
   * site whose JavaScript is off, joined into one value, the JavaScript one FIRST: in one policy a repeated directive is ignored after the first, so the user's switch must win over a list rule such as `script-src 'self'`. Read from the settings of this moment, so a site added later needs no new hook.
   */
  private policyFor(url: string): string | null {
    const settings = this.deps.settings()
    const blocker = settings.blockScriptlets && blockerIsOn(settings) ? this.deps.blocker().cspFor(url, settings) : null
    const parts = [javascriptPolicyFor(settings.siteJavascriptOff, url), blocker].filter((part): part is string => part !== null && part !== '')
    return parts.length > 0 ? parts.join('; ') : null
  }

  /** What a document gets, from the settings of this moment. Never throws: a failure is a page that gets nothing (the engine reports it). */
  private planFor(pageUrl: string): GuardPlan {
    const settings = this.deps.settings()
    // scriptletCalls keeps the lists' scriptlets behind blockScriptlets, and gives the YouTube player rules on their own (ads switch, YouTube page).
    const scriptlets = this.deps.blocker().scriptletCalls(pageUrl, settings)
    return { scriptlets, fingerprint: fingerprintConfigFor(settings, pageUrl, (url) => this.deps.seeds.seedFor(url)) }
  }

  /** Gives one page the WebRTC policy its address calls for. A page never touched while the protection is off is never touched at all. */
  applyToPage(id: string, page: GuardPage, url: string | undefined): void {
    const wanted = webRtcPolicyFor(this.deps.settings(), url)
    const has = this.webRtc.get(id) ?? null
    if (wanted === has) return
    if (wanted === null) this.webRtc.delete(id)
    else this.webRtc.set(id, wanted)
    page.setWebRtcPolicy(wanted)
  }

  /** The settings changed: the pages that carry a policy (or should) are looked at again. Nothing at all while the protection is off and no page carries one. */
  refreshPages(): void {
    if (!this.deps.settings().reduceFingerprint && this.webRtc.size === 0) return
    for (const { id, page, url } of this.deps.pages()) this.applyToPage(id, page, url)
  }

  forget(id: string): void {
    this.webRtc.delete(id)
  }

  /**
   * The window is closing. The engine is left as it is, as for the request filter: the engine of a private window is closed with its window (which
   * takes the guard away from its session), and the application's engine is the next window's to configure.
   */
  stop(): void {
    this.webRtc.clear()
  }
}
