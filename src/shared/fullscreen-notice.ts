// The notice a page gets when it takes the window in HTML full screen (shared/html-fullscreen.ts): for a few seconds, over the page, the site that
// went full screen and the key that leaves it. A page in full screen covers the sidebar and the address: without a word over it, it could draw a
// sidebar and an address bar of its own and pass for another site. Pure rules here: when the notice shows, for how long, and what it says. The
// shell draws it (shell/fullscreen-notice.ts).

import { t } from './i18n'
import { toolbarAddress } from './toolbar'

/**
 * How long the notice stays from the moment the page took the window. It covers the animation of macOS into full screen and leaves the time to
 * read two short lines; it goes by itself, so that it does not stay over a video.
 */
export const FULLSCREEN_NOTICE_MS = 5000

/** The tab the notice was last started for (null: no page holds the window) and the time it goes. */
export interface FullscreenNoticeState {
  tab: string | null
  until: number
}

export const NO_FULLSCREEN_NOTICE: FullscreenNoticeState = Object.freeze({ tab: null, until: 0 })

/**
 * Whether the notice shows now, given the tab that holds the window in full screen (null: none). A tab that takes the window starts it, whichever
 * tab held the window before; it then shows until `until`, and not again while the same tab keeps the window. Once no page holds the window the
 * notice is forgotten: a page that leaves full screen and takes it again is announced again, so that a page cannot leave and come back unannounced.
 */
export function fullscreenNoticeAt(
  state: FullscreenNoticeState,
  fullscreenTab: string | null,
  now: number,
  duration: number = FULLSCREEN_NOTICE_MS
): { state: FullscreenNoticeState; shown: boolean } {
  if (fullscreenTab === null) return { state: NO_FULLSCREEN_NOTICE, shown: false }
  if (fullscreenTab !== state.tab) return { state: { tab: fullscreenTab, until: now + duration }, shown: true }
  return { state, shown: now < state.until }
}

/** A host longer than this is cut by its start: its end, the domain that says whose site it is, is never the part that goes. */
export const NOTICE_HOST_MAX = 80

/** The host the notice names, as the toolbar writes it (without `www.`, in the form the address bar shows), or '' for a page that has none. */
export function noticeHost(url: string): string {
  const { host } = toolbarAddress(url, false)
  return host.length <= NOTICE_HOST_MAX ? host : `…${host.slice(host.length - (NOTICE_HOST_MAX - 1))}`
}

/** The two lines of the notice: which page took the window, and how to leave it. */
export function fullscreenNoticeLines(url: string): { site: string; exit: string } {
  const host = noticeHost(url)
  return {
    site: host ? t('fullscreen-notice.site-en-plein-ecran', { host }) : t('fullscreen-notice.page-en-plein-ecran'),
    exit: t('fullscreen-notice.echap-pour-quitter')
  }
}
