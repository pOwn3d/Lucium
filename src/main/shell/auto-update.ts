import { app, net } from 'electron'
import {
  AUTO_UPDATE_FIRST_DELAY_MS,
  AUTO_UPDATE_PERIOD_MS,
  afterNoticeAccepted,
  afterNoticeShown,
  cleanUpdateNotices,
  noticeGivenUp,
  noticeKind,
  noticePaused,
  withoutDrop,
  type DroppedNotice,
  type DroppedUpdate,
  type InstallerState,
  type UpdateNotice,
  type UpdateNoticeMemory
} from '@shared/auto-update'
import type { Settings } from '@shared/model'
import type { FeatureGates } from './feature-gate'
import { feedAnswer, feedFetchInit, updateOutcome, withdrawnVersions, type FeedAnswer, type UpdateOffer, type UpdateOutcome } from '@shared/update-check'
import { currentBackgroundFeed } from './update-source'
import { feedSignatureCheck } from './update-signature'
import { showUpdateNotice, updateInstaller, type InstallContext, type ToastHost } from './app-update'

const FEED_TIMEOUT_MS = 10_000

export interface AutoUpdateDeps {
  settings: () => Settings
  /** The running version. */
  version: string
  /** The feed to read for these settings, or null: the setting is off, or there is no address to read (update-source.ts, `backgroundFeed`). */
  feed: (settings: Settings) => string | null
  fetchFeed: (url: string) => Promise<FeedAnswer>
  /** Shows the notice where it may show now; false when no window may (only a normal window in front, no share, no lock: main/index.ts). */
  notify: (notice: UpdateNotice) => boolean
  /** The same, for a dropped update told alone (the feed offers nothing else to install); absent, it is not told. */
  notifyDropped?: (notice: DroppedNotice) => boolean
  /** Keeps the memory of the notices in the profile (`Settings.updateNotices`). */
  remember: (memory: UpdateNoticeMemory) => void
  /** The installer of this run (app-update.ts), or null: this run installs nothing, and the notice opens the download page. */
  installer?: () => InstallerState | null
  /** Calls `listener` each time a window of Lucium takes the focus (a notice that waits for a window shows then); answers what stops it. */
  watchFocus?: (listener: () => void) => () => void
  now?: () => number
  /** The wait before the first look and the time between two (the engine test shortens them). */
  delays?: { firstMs: number; periodMs: number }
}

/**
 * Settings › General › "Rechercher les mises à jour automatiquement": looks for a newer version in the background (AUTO_UPDATE_FIRST_DELAY_MS after
 * launch, then every AUTO_UPDATE_PERIOD_MS) and offers it in a notice of the sidebar (shared/auto-update.ts says when); a running version the feed
 * lists as withdrawn is told so in the same notice. Quiet otherwise: up to date,
 * no feed, or a failed look (written to the log, tried again at the next look); the menu's check is the one that reports those. It downloads nothing:
 * « Installer » in the notice does (app-update.ts).
 */
export class AutoUpdater {
  /**
   * The offer the last look found, waiting for a window that may show it, or for the end of its pause. `withdrawn`: the running version was
   * withdrawn, and `installable` says whether the offer is above it. `dropped`: the update downloaded in this run (or the last) was withdrawn
   * and dropped, to be told first; with no offer (the feed has nothing newer than the running version), it is all the notice says.
   */
  private waiting: { offer: UpdateOffer | null; withdrawn: boolean; installable: boolean; dropped?: DroppedUpdate } | null = null
  /** The last notice shown in this run: the same version waits UPDATE_NOTICE_PAUSE_MS before it is shown again. */
  private lastShown: { version: string; at: number } | null = null
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = []
  private unwatch: (() => void) | null = null

  constructor(private readonly deps: AutoUpdateDeps) {}

  /** One look, now. Returns what it found, or null when the setting or the feed says there is nothing to read (nothing is asked then). */
  async check(): Promise<UpdateOutcome | null> {
    const feed = this.deps.feed(this.deps.settings())
    if (!feed) return null
    const answer = await this.deps.fetchFeed(feed)
    const dropped = await this.dropWithdrawn(answer)
    const told = dropped ? { dropped } : {}
    const outcome = updateOutcome(this.deps.version, feed, answer)
    if (outcome.kind === 'available') {
      this.waiting = { offer: outcome.offer, withdrawn: false, installable: true, ...told }
      this.offer()
    } else if (outcome.kind === 'withdrawn') {
      this.waiting = { offer: outcome.offer, withdrawn: true, installable: outcome.newer, ...told }
      this.offer()
    } else if (dropped) {
      this.waiting = { offer: null, withdrawn: false, installable: false, dropped }
      this.offer()
    } else if (outcome.kind === 'up-to-date') this.waiting = null
    // A failed look shows nothing: an offer found before still waits, and the next look tries again.
    return outcome
  }

  /**
   * The update downloaded in this run, dropped when the feed just read lists it as withdrawn (app-update.ts, `dropWithdrawn`); or the one the last
   * run dropped at its quit, still to be told (`Settings.updateNotices.dropped`).
   */
  private async dropWithdrawn(answer: FeedAnswer): Promise<DroppedUpdate | undefined> {
    const installer = this.deps.installer?.() ?? null
    if (answer.ok && installer?.dropWithdrawn) {
      const outcome = await installer.dropWithdrawn(withdrawnVersions(answer.json))
      if (outcome.kind !== 'kept') return { version: outcome.version, failed: outcome.kind === 'failed' }
    }
    const remembered = cleanUpdateNotices(this.deps.settings().updateNotices).dropped
    return remembered ? { version: remembered, failed: false } : undefined
  }

  /** Shows the notice of the offer that waits, when its rules and a window allow it; true when it was shown. Asks nothing of the network. */
  offer(): boolean {
    const waiting = this.waiting
    if (!waiting) return false
    const settings = this.deps.settings()
    const memory = cleanUpdateNotices(settings.updateNotices)
    if (!settings.autoUpdate) {
      this.waiting = null
      return false
    }
    const { offer, dropped } = waiting
    if (offer === null) {
      // Nothing else to install: the drop alone is told, once.
      if (!dropped || this.deps.notifyDropped?.({ kind: 'dropped', dropped }) !== true) return false
      this.waiting = null
      this.deps.remember(withoutDrop(memory))
      return true
    }
    // A drop is news, told whatever the count and the pause of the version offered with it.
    if (!dropped && noticeGivenUp(offer.version, memory)) {
      this.waiting = null
      return false
    }
    const now = this.deps.now?.() ?? Date.now()
    if (!dropped && noticePaused(offer.version, this.lastShown, now)) return false
    const installer = this.deps.installer?.() ?? null
    const kind = noticeKind(offer, installer, waiting.installable)
    if (kind === null) {
      // A download the user started is under way: its own boxes say how it ends.
      this.waiting = null
      return false
    }
    const version = kind === 'restart' ? installer?.readyVersion() || offer.version : offer.version
    const shown = this.deps.notify({ kind, version, offer, current: this.deps.version, ...(waiting.withdrawn ? { withdrawn: true } : {}), ...(dropped ? { dropped } : {}), accepted: () => this.accepted(offer.version) })
    if (!shown) return false
    this.waiting = null
    this.lastShown = { version: offer.version, at: now }
    this.deps.remember(afterNoticeShown(memory, offer.version))
    return true
  }

  private accepted(version: string): void {
    this.deps.remember(afterNoticeAccepted(cleanUpdateNotices(this.deps.settings().updateNotices), version))
  }

  start(): void {
    const look = () =>
      void this.check()
        .then((outcome) => outcome?.kind === 'failed' && console.warn('[update] background check failed:', outcome.reason))
        .catch((error: unknown) => console.warn('[update] background check crashed:', error))
    const { firstMs, periodMs } = this.deps.delays ?? { firstMs: AUTO_UPDATE_FIRST_DELAY_MS, periodMs: AUTO_UPDATE_PERIOD_MS }
    this.timers.push(setTimeout(look, firstMs), setInterval(look, periodMs))
    this.unwatch = this.deps.watchFocus?.(() => void this.offer()) ?? null
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.unwatch?.()
    this.unwatch = null
    this.waiting = null
  }
}

/** The looks (a timer at launch and one a day) run only while "Rechercher les mises à jour automatiquement" is on: the setting off owns no timer. */
export function gateAutoUpdate(gates: FeatureGates, updater: AutoUpdater): void {
  gates.gate('auto-update', {
    start: () => {
      updater.start()
      return () => updater.stop()
    }
  })
}

export interface AutoUpdateHost {
  settings: () => Settings
  /** Writes a patch of the settings of the profile (the memory of the notices). */
  update: (patch: Partial<Settings>) => void
  /** The window the notice may show in now, or null (main/index.ts: the normal window in front, no share, no lock). */
  noticeWindow: () => (InstallContext & { browser: ToastHost }) | null
}

/** The feed over the network: no cookie, no credential, and only what a key of the application signed. */
async function readUpdateFeed(url: string): Promise<FeedAnswer> {
  try {
    const response = await net.fetch(url, feedFetchInit(AbortSignal.timeout(FEED_TIMEOUT_MS)))
    return await feedAnswer(url, response, feedSignatureCheck(url))
  } catch (error) {
    return { ok: false, reason: String((error as Error).message ?? error) }
  }
}

/**
 * The versions a feed lists as withdrawn, read now (update-quit-check.ts, before the quit installs a downloaded update); null when there is no feed
 * or it gave no valid answer, which is logged with its reason.
 */
export async function withdrawnInFeed(feed: string | null, read: (url: string) => Promise<FeedAnswer> = readUpdateFeed): Promise<string[] | null> {
  if (!feed) return null
  const answer = await read(feed)
  if (answer.ok) return withdrawnVersions(answer.json)
  console.warn(`[update] the feed ${feed} could not be read: ${answer.reason}`)
  return null
}

/** The real thing: the feed over the network (no cookie, no credential), the notice in the sidebar of the window in front. */
export function createAutoUpdater(host: AutoUpdateHost): AutoUpdater {
  return new AutoUpdater({
    settings: host.settings,
    version: app.getVersion(),
    feed: (settings) => currentBackgroundFeed(settings),
    fetchFeed: readUpdateFeed,
    installer: () => updateInstaller(),
    notify: (notice) => {
      const target = host.noticeWindow()
      if (!target) return false
      showUpdateNotice(target, notice, updateInstaller())
      return true
    },
    notifyDropped: (notice) => {
      const target = host.noticeWindow()
      if (!target) return false
      showUpdateNotice(target, notice, updateInstaller())
      return true
    },
    remember: (updateNotices) => host.update({ updateNotices }),
    watchFocus: (listener) => {
      app.on('browser-window-focus', listener)
      return () => void app.off('browser-window-focus', listener)
    }
  })
}
