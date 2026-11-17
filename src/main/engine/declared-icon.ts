// The icon a page declares (`<link rel="icon">`, told by `page-favicon-updated`) is drawn by the interface as a picture: the interface loads its
// address itself. So the address is judged here, before the interface hears of it, as the picture would be judged if the page loaded it: by the
// blocker of the page's context, and by the rule of what an icon may be (`iconAllowedFor`: a web address without a login, never http for an https
// page). Without this, a page could have a third party the blocker refuses contacted by declaring it as its icon.
//
// An icon that is refused is told as '' (the page has no icon the interface may load): the row falls back on its letter, and the icon of the
// page before does not stay over the new one.

import { iconAllowedFor } from '@shared/favicon'
import type { PageEvents, RequestBlocker } from './types'

/** The declared icon as the interface may load it: the address itself, or '' when it is refused. An image already inlined (`data:`) is no request. */
export function declaredIcon(icon: string, pageUrl: string, pageId: string, blocker: RequestBlocker | null): string {
  if (/^data:image\//i.test(icon)) return icon
  if (!iconAllowedFor(icon, pageUrl)) return ''
  if (blocker === null) return icon
  try {
    // Cancelled, or sent to a stand-in: either way the address the page gave is not to be contacted.
    return blocker({ url: icon, resourceType: 'image', pageUrl, pageId, documentUrl: pageUrl, method: 'GET' }) === false ? icon : ''
  } catch (error) {
    // No icon costs a letter in a row; an unjudged one would cost a request the blocker may have refused.
    console.error('[engine] the request filter failed on the icon of a page, so the page shows none:', error instanceof Error ? error.message : error)
    return ''
  }
}

/**
 * The events of a page, with `note` told of every web address that reaches them as the icon of the page (after the judgement above, so never one
 * that was refused): the interface will ask the main process for a copy of it, and the main process must know which page shows it.
 */
export function withDeclaredIcon(events: PageEvents, note: (iconUrl: string) => void): PageEvents {
  return {
    ...events,
    update: (patch) => {
      if (typeof patch.faviconUrl === 'string' && /^https?:\/\//i.test(patch.faviconUrl)) note(patch.faviconUrl)
      events.update(patch)
    }
  }
}

/** The events of a page, with the icon it declares judged first. `pageUrl` and `blocker` are read when the icon arrives. */
export function withJudgedIcon(events: PageEvents, pageId: string, pageUrl: () => string, blocker: () => RequestBlocker | null): PageEvents {
  return {
    ...events,
    update: (patch) => events.update(patch.faviconUrl === undefined || patch.faviconUrl === '' ? patch : { ...patch, faviconUrl: declaredIcon(patch.faviconUrl, pageUrl(), pageId, blocker()) })
  }
}
