// Advertising on YouTube: a few rules of our own, applied only to pages of youtube.com (and its subdomains). Nothing here is a copy of a
// filter list: the paths, the JSON keys and the selectors are written from what the site serves, and the scriptlet calls use the library of
// shared/scriptlets.ts (Lucium's own code). The rules are switched by the blocker's settings, never on a page of another site.

import { hostIn } from './blocker'
import type { ScriptletCall } from './scriptlets'

const YOUTUBE = 'youtube.com'

/** A page of youtube.com or one of its subdomains (http or https). */
export function isYouTubePage(pageUrl: string | null): boolean {
  if (!pageUrl || !URL.canParse(pageUrl)) return false
  const url = new URL(pageUrl)
  return (url.protocol === 'https:' || url.protocol === 'http:') && hostIn(url.hostname, [YOUTUBE])
}

/** Paths of youtube.com that serve advertising: the ad requests of the player, and the ad statistics. */
const AD_PATHS = ['/pagead/', '/api/stats/ads']

/**
 * An advertising request of youtube.com itself. The hosts of the ad networks are already in the built-in list; this covers the paths that
 * YouTube serves from its own host, which the host lists must not block (the site loads its own files).
 */
export function isYouTubeAdRequest(url: string): boolean {
  if (!URL.canParse(url)) return false
  const address = new URL(url)
  return hostIn(address.hostname, [YOUTUBE]) && AD_PATHS.some((path) => address.pathname.startsWith(path))
}

/**
 * The address of the answers that carry the player's data on youtube.com: the player request, the "next" request (the list beside the video)
 * and the watch page's own request, which answers JSON when the page asks for it (`pbj=1`, an array of responses). An HTML answer is not JSON:
 * the scriptlet leaves it as it is.
 */
const YOUTUBE_PLAYER_ANSWERS = '/^https:\\/\\/(www\\.youtube\\.com|m\\.youtube\\.com|youtube\\.com)\\/(youtubei\\/v1\\/(player|next)|watch)(\\?|$)/'

/**
 * The scriptlets of a YouTube page. `json-prune` removes the ad entries from the JSON the page reads (`JSON.parse`, `Response.json()`), and only
 * from a player response (the one with `videoDetails`). `set-constant` empties the same entries of the first player response, which the page
 * writes inline: when the page declares it as a plain variable the constant is not applied and nothing else changes. `prune-response` removes
 * the same ad entries from the answers the page reads through `fetch` (`text()`, `json()`) and `XMLHttpRequest` (`response`, `responseText`),
 * and only from the answers whose address is one of the player's above: the address is the whole rule, it names youtube.com.
 */
export const YOUTUBE_SCRIPTLETS: readonly ScriptletCall[] = [
  { id: 'json-prune', args: ['playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots', 'videoDetails'] },
  { id: 'set-constant', args: ['ytInitialPlayerResponse.adPlacements', 'emptyArr'] },
  { id: 'set-constant', args: ['ytInitialPlayerResponse.playerAds', 'emptyArr'] },
  { id: 'set-constant', args: ['ytInitialPlayerResponse.adSlots', 'emptyArr'] },
  {
    id: 'prune-response',
    args: [YOUTUBE_PLAYER_ANSWERS, 'adPlacements playerAds adSlots adBreakHeartbeatParams [].playerResponse.adPlacements [].playerResponse.playerAds [].playerResponse.adSlots']
  }
]

/** Blocks that carry advertising on the home page, in the results and in the player. Hidden only with the cosmetic switch. */
const YOUTUBE_AD_SELECTORS = [
  'ytd-ad-slot-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-display-ad-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-video-renderer',
  'ytd-banner-promo-renderer',
  'ytd-statement-banner-renderer',
  'ytd-video-masthead-ad-v3-renderer',
  '#player-ads',
  '#masthead-ad',
  '.ytp-ad-module',
  '.ytp-ad-overlay-container'
]

/** The stylesheet that hides them (`display: none`). Only for youtube.com pages. */
export const YOUTUBE_COSMETIC_CSS = `${YOUTUBE_AD_SELECTORS.join(',\n')} { display: none !important; }`
