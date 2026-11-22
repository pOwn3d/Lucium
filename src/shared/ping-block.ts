// Tracking pings: the beacon a page sends to another site without anyone asking for it, the `ping=` of a link (hyperlink auditing) and
// `navigator.sendBeacon()`. Chromium gives both the resource type `ping`, so one rule covers them. Pure; the shell's request filter applies it
// (shell/browser-network.ts) and counts what it stops with the blocker's counter of the page.

import { isBlockingExempt } from './blocker'
import { siteOf } from './party'
import type { Settings } from './model'

export type PingSettings = Pick<Settings, 'blockPings' | 'blockExceptions'>

/** What `pingBlockedFor` needs to know of a request. */
export interface PingRequest {
  url: string
  resourceType: string
  /** The address of the page in the tab the request belongs to: null when the session does not say. */
  pageUrl: string | null
}

/**
 * Whether the request is a ping to another site than the page's, on a page that is not one of the sites where protections are let off (the same
 * list as the blocker's). A request whose page is unknown is left alone: nothing is cancelled on the strength of an unknown.
 */
export function pingBlockedFor(request: PingRequest, settings: PingSettings): boolean {
  if (!settings.blockPings || request.resourceType !== 'ping') return false
  const mine = siteOf(request.pageUrl)
  const theirs = siteOf(request.url)
  if (mine === null || theirs === null || mine === theirs) return false
  return !isBlockingExempt(request.pageUrl, settings.blockExceptions)
}
