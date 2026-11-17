// The engine port (types.ts), the network of the sessions: what is blocked, rewritten or given to a page before its scripts run, the privacy
// options, DNS, the proxies, strict transport security and the icons of sites. Re-exported by types.ts, which the rest of Lucium imports.

import type { RequestVerdict } from '@shared/blocker'
import type { FingerprintConfig } from '@shared/fingerprint'
import type { GuardPlan } from '@shared/page-guard'
import type { PrivacyOptions } from '@shared/privacy'
import type { HostResolverConfig } from '@shared/dns'
import type { ProxyPlan } from '@shared/proxy'
import type { ProxyFollow, ProxySession } from './network'
import type { SiteIconOwner } from '@shared/site-icon'

/** What the engine does to the requests and the answers of its sessions. */
export interface EngineNetwork {
  /** Writes the hosts held to strict transport security (HSTS) whose write still waited; the application is about to quit. */
  flushStrictTransport(): void
  /** Cancels the requests it answers true for (third-party ad and tracker blocking) and sends those it answers an address for elsewhere. `null` stops filtering. */
  setRequestBlocker(blocker: RequestBlocker | null): void
  /**
   * Adds a Content-Security-Policy to the main documents it answers a policy for (the `$csp` rules of the lists). `null` takes the hook away:
   * nothing is listened to while it is off.
   */
  setResponsePolicy(policy: ResponsePolicy | null): void
  /**
   * What a page is given before its scripts run (scriptlets of the blocker, fingerprint protection): the provider answers from the settings of
   * the moment, for the address of the document being loaded. A preload is added to the pages of this context while there is a provider, and
   * taken away when there is none; it runs in the main frame of a page only. `null` stops it.
   */
  setPageGuard(provider: PageGuardProvider | null): void
  /**
   * The fingerprint protection of what is inside a page (its frames, its dedicated workers) and of the service workers of this context, which the
   * preload of the page does not reach: each gets what `setPageGuard` gives the page it belongs to. While there is a provider the engine keeps a
   * protocol session on each page (engine/inner-guard.ts) and a preload in the service workers; `null` takes both away.
   */
  setInnerGuard(provider: InnerGuardProvider | null): void
  /**
   * What the engine does to the requests of this context beyond blocking: send Global Privacy Control, remove tracking parameters
   * from navigations, try http addresses over https first. `null` does none of it.
   */
  setPrivacy(options: PrivacyOptions | null): void
  /**
   * Encrypted DNS for the whole application (`app.configureHostResolver`); `null` puts Chromium's defaults back. Answers null, or the reason
   * Chromium refused (already logged). Only the main window's browser calls it: a private context has no DNS of its own.
   */
  setHostResolver(config: HostResolverConfig | null): string | null
  /**
   * The proxy of each profile's session, of the private contexts, and of the application's own requests (`plan.global`); `null` puts the
   * system's proxy back. A page created while a change is under way waits for it before it navigates. Resolves with the places where it
   * could not be set (already logged); empty when everything went through.
   */
  setProxies(plan: ProxyPlan | null): Promise<string[]>
  /**
   * Puts a session the shell makes requests with on its own (favicon lookups, live folders) on the global proxy, now and at every change of
   * the plan. Nothing is called while the proxy option is off. The answer tells when the session is settled and lets the caller stop following.
   */
  followProxy(ses: ProxySession, what: string): ProxyFollow
  /**
   * Who the state says shows an icon: asked when the interface wants the copy of an icon no page of this run declared (a tab restored and not
   * loaded yet, a favourite, a bookmark). The engine downloads the icon once, through the session of the profile named, and serves the
   * interface its copy (engine/site-icons.ts); it downloads nothing for an icon nobody shows. A private context has no such copies.
   */
  setSiteIconOwners(find: ((iconUrl: string) => SiteIconOwner | null) | null): void
  /**
   * Hands the engine the bytes a lookup of the application already downloaded for an icon (shell/favicon-resolver.ts): they become its copy, and
   * the icon is not asked a second time. False when they are not a picture an icon may be.
   */
  keepSiteIcon(iconUrl: string, bytes: Uint8Array, contentType: string | null): boolean
}

/**
 * `pageId` is the page (tab) that makes the request, null for a request that belongs to none (a service worker, an extension).
 * `documentUrl` is the document that makes it (a frame's address, a worker's origin), null when the session does not say.
 */
export type RequestBlocker = (request: { url: string; resourceType: string; pageUrl: string | null; pageId: string | null; documentUrl: string | null; method: string }) => RequestVerdict

/** The policy to add to the main document at `url` (a Content-Security-Policy value), or null for none. */
export type ResponsePolicy = (request: { url: string }) => string | null

/** What the document at `pageUrl`, whose scripts have not run yet, is given. Called once per document, synchronously for the page: it must be quick and never throw. */
export type PageGuardProvider = (request: { pageUrl: string }) => GuardPlan

/**
 * The strength of the fingerprint protection at this moment, whatever the site, with a seed that belongs to no site: what a frame is given when
 * the engine has not heard of its page yet. `null` while the protection is off.
 */
export type InnerGuardProvider = () => FingerprintConfig | null
