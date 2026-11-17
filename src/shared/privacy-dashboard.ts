// The privacy dashboard: a read-only look at what the blocker did and which protections are on, from what Lucium
// already keeps. The blocker counts the requests it stops for each open page (service.ts, `blockedCount`), in memory, from the page's last load; nothing
// else is counted, and nothing is added for this view: no total since the launch, no split between trackers, ads and banners, no history. The view says so.

import { adsBlockingOn, isBlockingExempt } from './blocker'
import { t } from './i18n'
import type { Settings, TabItem } from './model'
import { hostnameOf } from './url'

/** The settings the dashboard reads. */
export type ProtectionSettings = Pick<Settings, 'blockAds' | 'blockTrackers' | 'blockCookieBanners' | 'blockExceptions' | 'reduceFingerprint' | 'httpsUpgrade' | 'sendGpc' | 'stripTrackingParams' | 'dohCustom'>

export type ProtectionId = 'ads' | 'banners' | 'fingerprint' | 'https' | 'gpc' | 'tracking-params' | 'dns'

export interface Protection {
  id: ProtectionId
  /** The name of the setting, as the setting itself is named further down the same pane. */
  label: string
  on: boolean
}

// The gate of the blocker (which switch filters what) is defined once, in blocker.ts; the dashboard and the Settings import it from here.
export { adsBlockingOn, adsBlockingPatch, blockerIsOn } from './blocker'

/** The protections in their order on screen, each named as its own setting is, and whether it is on. */
export function protections(settings: ProtectionSettings): Protection[] {
  const adsOn = adsBlockingOn(settings)
  return [
    { id: 'ads', label: t('settings.bloquer-les-publicites-et-les-traqueurs'), on: adsOn },
    { id: 'banners', label: t('settings.bloquer-les-bannieres-de-cookies'), on: settings.blockCookieBanners },
    { id: 'fingerprint', label: t('guard-settings.protection-contre-l-empreinte-numerique'), on: settings.reduceFingerprint },
    { id: 'https', label: t('privacy-settings.toujours-essayer-https-d-abord'), on: settings.httpsUpgrade },
    { id: 'gpc', label: t('privacy-settings.envoyer-le-signal-global-privacy-control'), on: settings.sendGpc },
    { id: 'tracking-params', label: t('privacy-settings.retirer-les-parametres-de-suivi-des-adresses'), on: settings.stripTrackingParams },
    { id: 'dns', label: t('privacy-extra-settings.regler-le-dns-chiffre-moi-meme'), on: settings.dohCustom }
  ]
}

/**
 * The tabs whose counter is read: the pages of the web, and none of the private tabs (a window of settings that listed the sites of a private tab would
 * leave a trace of them that the tab itself never leaves).
 */
export function countedTabs(tabs: readonly Pick<TabItem, 'id' | 'url' | 'private'>[]): Array<{ id: string; url: string }> {
  return tabs.filter((tab) => tab.private !== true && /^https?:\/\//i.test(tab.url)).map(({ id, url }) => ({ id, url }))
}

export interface SiteBlocked {
  host: string
  blocked: number
  /** The site is on the list of those where nothing is blocked ("Sans blocage"). */
  exempt: boolean
}

export interface BlockedSummary {
  /** Requests stopped on the pages counted. */
  total: number
  /** The sites that blocked something or are left alone, the most blocked first. */
  sites: SiteBlocked[]
}

/** The counters of the pages (by tab id) gathered by site: one line for a site open in several tabs. */
export function summarizeBlocked(tabs: readonly { id: string; url: string }[], counts: Readonly<Record<string, number>>, exceptions: readonly string[]): BlockedSummary {
  const bySite = new Map<string, SiteBlocked>()
  let total = 0
  for (const tab of tabs) {
    const host = hostnameOf(tab.url)
    if (host === '') continue
    const blocked = counts[tab.id] ?? 0
    total += blocked
    const site = bySite.get(host) ?? { host, blocked: 0, exempt: isBlockingExempt(tab.url, exceptions) }
    site.blocked += blocked
    bySite.set(host, site)
  }
  const sites = [...bySite.values()].filter((site) => site.blocked > 0 || site.exempt).sort((a, b) => b.blocked - a.blocked || a.host.localeCompare(b.host))
  return { total, sites }
}
