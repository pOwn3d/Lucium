// "Check for updates automatically" (Settings › General, on by default): AUTO_UPDATE_FIRST_DELAY_MS after launch, then once a day, Lucium reads
// the release file of its feed, with no cookie and no credential, and says what it found in a notice at the foot of the sidebar
// (main/shell/auto-update.ts). The feed is the address built into the built application (main/shell/update-source.ts, `backgroundFeed`); a build
// without one, or a run from the sources, reads only a feed given by hand (the `updateFeedUrl` setting, or LUCIUM_UPDATE_FEED from the sources).
// The setting off, nothing is read at all. Nothing is downloaded before the user clicks « Installer » in the notice; a look that fails shows
// nothing, and the next one tries again.
//
// The rules of the notice, pure here so that they are tested without a window:
// - one notice of a version at a time, and none again in the same run before UPDATE_NOTICE_PAUSE_MS: « Plus tard » (or a notice left to fade)
//   brings it back at the next look a day later, or at the next launch;
// - a version shown UPDATE_NOTICE_MAX_TIMES times without « Installer » never comes back by itself (`Settings.updateNotices`, kept in the profile):
//   Lucium › Rechercher les mises à jour… still finds it;
// - an update already downloaded is offered as « Installer et relancer »;
// - a running version the feed lists as withdrawn gets the same notice with other words (« Cette version a été retirée »), under the same rules; when
//   the version to install is below the running one, the notice opens the download page (Squirrel.Mac installs no older version);
// - an update downloaded in this run that the feed then lists as withdrawn is dropped (main/shell/app-update.ts, `dropWithdrawn`): the notice says
//   so once, with the version to install when there is one, whatever the count of that version; dropped at the quit, it is said at the next launch;
// - only in a normal window that has the focus: never in a private window, never while a window is being shared, never behind the lock.

import type { UpdateOffer } from './update-check'
import { formatSize } from './translate-local'
import { t } from './i18n'

/** Wait this long after launch before the first look: the window is up and the pages are loading first. */
export const AUTO_UPDATE_FIRST_DELAY_MS = 20_000
/** Then look again this often while the application stays open. */
export const AUTO_UPDATE_PERIOD_MS = 24 * 60 * 60 * 1000
/** A notice of a version does not come back in the same run before this (the next launch may show it at once). */
export const UPDATE_NOTICE_PAUSE_MS = AUTO_UPDATE_PERIOD_MS
/** A version shown this many times without « Installer » is not shown again by itself. */
export const UPDATE_NOTICE_MAX_TIMES = 3
/** How long the notice stays at the foot of the sidebar (its time stops while the pointer or the focus is on it, shared/toast.ts). */
export const UPDATE_NOTICE_MS = 15_000

/**
 * What the profile remembers of the notices (`Settings.updateNotices`): the last version shown, and how many times it was shown without « Installer »;
 * `dropped`, a downloaded update dropped at the quit because the feed had withdrawn it, still to be told.
 */
export interface UpdateNoticeMemory {
  version: string
  shown: number
  dropped?: string
}

export const NO_UPDATE_NOTICE: UpdateNoticeMemory = { version: '', shown: 0 }

/** The memory as a state file may hold it: a plain version and a small count, else none. */
export function cleanUpdateNotices(raw: unknown): UpdateNoticeMemory {
  if (typeof raw !== 'object' || raw === null) return NO_UPDATE_NOTICE
  const { version, shown } = raw as Record<string, unknown>
  const { dropped } = raw as Record<string, unknown>
  const keptDrop = typeof dropped === 'string' && VERSION.test(dropped) ? { dropped } : {}
  if (typeof version !== 'string' || !VERSION.test(version)) return { ...NO_UPDATE_NOTICE, ...keptDrop }
  return { version, shown: typeof shown === 'number' && Number.isSafeInteger(shown) && shown > 0 ? Math.min(shown, 99) : 0, ...keptDrop }
}

const VERSION = /^\d+(?:\.\d+){0,3}$/

/** The memory once the drop it kept was told. */
export const withoutDrop = (memory: UpdateNoticeMemory): UpdateNoticeMemory => ({ version: memory.version, shown: memory.shown })

/** Whether the notice of `version` was given up: shown UPDATE_NOTICE_MAX_TIMES times without « Installer ». The menu still finds it. */
export const noticeGivenUp = (version: string, memory: UpdateNoticeMemory): boolean => memory.version === version && memory.shown >= UPDATE_NOTICE_MAX_TIMES

/** Whether the notice of `version` was shown in this run less than UPDATE_NOTICE_PAUSE_MS ago (« Plus tard », or a notice left to fade). */
export const noticePaused = (version: string, lastShown: { version: string; at: number } | null, now: number): boolean =>
  lastShown !== null && lastShown.version === version && now - lastShown.at < UPDATE_NOTICE_PAUSE_MS

/** The memory once the notice of `version` was shown: one more showing for that version, or the first of a new one. */
export const afterNoticeShown = (memory: UpdateNoticeMemory, version: string): UpdateNoticeMemory => ({ version, shown: memory.version === version ? memory.shown + 1 : 1 })

/** The memory once « Installer » (or the download page) was chosen: that showing was not a refusal. */
export const afterNoticeAccepted = (memory: UpdateNoticeMemory, version: string): UpdateNoticeMemory =>
  memory.version === version ? { version, shown: Math.max(0, memory.shown - 1) } : memory

/**
 * What the notice offers:
 * - `install`: this run can install the archive the feed names (a built application with a built-in feed): « Installer »;
 * - `restart`: an update was downloaded in this run and waits: « Installer et relancer »;
 * - `page`: this run installs nothing: the download page, in the browser.
 */
export type UpdateNoticeKind = 'install' | 'restart' | 'page'

/**
 * What became of the update downloaded in this run once the feed was read again: kept (none waits, or the feed does not list it as withdrawn),
 * dropped (Squirrel no longer installs it), or listed as withdrawn but not dropped (what Squirrel keeps of it could not be removed).
 */
export type DropOutcome = { kind: 'kept' } | { kind: 'dropped'; version: string } | { kind: 'failed'; version: string }

/** A downloaded update the feed withdrew, as a notice tells it: `failed` when Lucium could not drop it. */
export interface DroppedUpdate {
  version: string
  failed: boolean
}

/** What the notice reads of the installer of the run (main/shell/app-update.ts). */
export interface InstallerState {
  canInstall(): boolean
  isDownloading(): boolean
  isReady(): boolean
  /** The version that was downloaded and waits, when the download named one ('' otherwise). */
  readyVersion(): string
  /** Drops the update that waits when its version is among `withdrawn` (a run that installs nothing has none). */
  dropWithdrawn?(withdrawn: readonly string[]): Promise<DropOutcome>
}

/**
 * The kind of notice for an offer; null when there is nothing to offer: a download the user started is under way, and its own boxes follow.
 * `installable` is false for an offer below the running version (the way back from a withdrawn version): Squirrel.Mac refuses an older bundle, so
 * only the download page can bring it.
 */
export function noticeKind(offer: UpdateOffer, installer: InstallerState | null, installable = true): UpdateNoticeKind | null {
  if (installer?.isDownloading()) return null
  if (installer?.isReady()) return 'restart'
  return offer.archive && installable && installer?.canInstall() ? 'install' : 'page'
}

/** A notice to show: what it offers, for which version, and what « Installer » tells the memory. */
export interface UpdateNotice {
  kind: UpdateNoticeKind
  /** The version the notice names: the offer's, or for `restart` the one that was downloaded (a newer one may have been published since). */
  version: string
  offer: UpdateOffer
  /** The running version. */
  current: string
  /** The running version was withdrawn: the notice says so, and names the offer as the version to install. */
  withdrawn?: boolean
  /** The update downloaded in this run was withdrawn and dropped (or could not be): the notice says so first, and names the offer as the version to install. */
  dropped?: DroppedUpdate
  /** Called on « Installer », « Installer et relancer » or the download page: that showing is not counted as a refusal. */
  accepted: () => void
}

/** The notice of a dropped update when the feed offers nothing else to install: the sentence alone. */
export interface DroppedNotice {
  kind: 'dropped'
  dropped: DroppedUpdate
}

/** The sentence that tells a dropped update; `version`, the version to install instead, when the feed offers one. */
export function droppedUpdateText(dropped: DroppedUpdate, version?: string): string {
  if (version === undefined) return dropped.failed ? t('auto-update.la-version-version-a-ete-retiree-lucium-n-a-pas-pu-l-ecarter', { version: dropped.version }) : t('auto-update.la-version-version-a-ete-retiree-elle-n-est-pas-installee', { version: dropped.version })
  return dropped.failed
    ? t('auto-update.la-version-dropped-a-ete-retiree-lucium-n-a-pas-pu-l-ecarter-installez-version', { dropped: dropped.version, version })
    : t('auto-update.la-version-dropped-a-ete-retiree-elle-n-est-pas-installee-installez-version', { dropped: dropped.version, version })
}

/** The words of the notice: one sentence, the button that acts, and « Plus tard ». */
export interface UpdateNoticeText {
  message: string
  action: string
  later: string
}

/**
 * « Lucium 0.2.2 est disponible (122,2 Mo). » with « Installer », or « Lucium 0.2.2 est prêt à être installé. » with « Installer et relancer »;
 * for a withdrawn running version, « Cette version a été retirée. Installez Lucium 0.2.2. ».
 */
export function updateNoticeText(kind: UpdateNoticeKind, version: string, size?: number, withdrawn = false, dropped?: DroppedUpdate): UpdateNoticeText {
  const later = t('menu-actions.plus-tard')
  // A dropped update is said first, with the version that takes its place (nothing waits any more, so the notice never offers the restart).
  if (dropped && kind !== 'restart') return { message: droppedUpdateText(dropped, version), action: kind === 'install' ? t('auto-update.installer') : t('auto-update.page-de-telechargement'), later }
  // An update that waits is what replaces the withdrawn version: its own words say what to do.
  if (withdrawn && kind !== 'restart') {
    return { message: t('auto-update.cette-version-a-ete-retiree-installez-version', { version }), action: kind === 'install' ? t('auto-update.installer') : t('auto-update.page-de-telechargement'), later }
  }
  if (kind === 'restart') return { message: t('auto-update.lucium-version-est-pret-a-etre-installe', { version }), action: t('app-update.installer-et-relancer'), later }
  const message = size ? t('auto-update.lucium-version-est-disponible-size', { version, size: formatSize(size) }) : t('auto-update.lucium-version-est-disponible', { version })
  return { message, action: kind === 'install' ? t('auto-update.installer') : t('auto-update.page-de-telechargement'), later }
}

/** What decides whether the notice may show now, in the window the user works in. */
export interface NoticeWindowFacts {
  /** The lock screen of the application is up. */
  locked: boolean
  /** A window is being shared, as far as the code knows (the annotated share of Lucium, a page of Lucium that shares one of its windows). */
  sharing: boolean
  /** The browser window that has the focus, or null: Lucium is in the background, or the window in front is not a browser window (Réglages, À propos). */
  front: { kind: 'main' | 'window' | 'private'; alive: boolean; focused: boolean } | null
}

/**
 * Whether the notice may show in the window the user works in: a normal window, alive, and in front (it has the focus, so the person sees the notice
 * come). Never in a private window, during a share, or behind the lock: the notice waits for the next time a window takes the focus.
 */
export function noticeWindowAllowed(facts: NoticeWindowFacts): boolean {
  if (facts.locked || facts.sharing || !facts.front) return false
  return facts.front.kind !== 'private' && facts.front.alive && facts.front.focused
}
