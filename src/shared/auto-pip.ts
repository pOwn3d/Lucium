// Automatic Picture in Picture (setting `autoPictureInPicture`, feature `auto-pip`): which video floats by itself when its tab is left, and
// the sites where the user has had enough of it. Only a video being watched floats: it plays, with sound, for a few seconds already, it is not
// a speck on the page. What the page says (`disablePictureInPicture`, which Netflix and Disney+ set) does not count, as for the picture
// asked for by hand: the other tests already keep ads and backgrounds out. A muted background loop, an ad that plays muted, a preview, a hidden video that only carries
// a sound stay where they are (docs/fonctions.md says the rule to the user).
// The picture asked for by hand (the menu, the button of the media player) is not this rule's business: it floats whatever can, the page's wish
// set aside (media-scripts.ts, PIP_ENTER).
// The verdict is a pure function that the page script carries as its own source (media-scripts.ts, PIP_AUTO_ENTER), so the test and the page run
// the same code.

/** What the page script reads of a video for the rule. */
export interface WatchedVideoFacts {
  /** It plays now (neither paused nor ended) and has its frames. */
  playing: boolean
  muted: boolean
  /** 0 to 1. */
  volume: number
  /** Whether it carries sound: false when the page can tell it has none (a feed without an audio track, no audio decoded after it played), null when it cannot tell. */
  audio: boolean | null
  /** Its box on the page, in CSS pixels. */
  width: number
  height: number
  /** How long it has played, in seconds (the ranges it played, added up). */
  playedSeconds: number
  /** A live feed (a MediaStream), as the videos of a video call are. A call mutes its video elements and plays the sound through others, so the
   *  feed is not judged by its sound. Absent: false. */
  live?: boolean
}

/** Why a video does not float by itself, or `float`. */
export type AutoFloatVerdict = 'float' | 'paused' | 'silent' | 'small' | 'just-started'

/** The smallest box that floats by itself, in CSS pixels, either way up (a vertical video counts too): the size of a small player. */
export const AUTO_PIP_MIN_BOX = { long: 320, short: 180 } as const
/** The smallest tile of a video call that floats by itself: half of AUTO_PIP_MIN_BOX. */
export const AUTO_PIP_MIN_CALL_TILE = { long: 160, short: 90 } as const
/** A video floats by itself once it has played this long, in seconds: a page just opened and left again is not a video being watched. */
export const AUTO_PIP_MIN_PLAYED_SECONDS = 2

/**
 * Whether a video is one being watched, the only kind that floats by itself when its tab is left, and if not, why. The tests come in the
 * order a reader checks them: it plays, it has sound (not muted, not at volume 0, an audio track when the page can tell; a live feed, the
 * video of a call whose sound comes from other elements of the page, is spared this test),
 * it is at least 320 × 180, it has played 2 s.
 * Self-contained on purpose: the page script is built from this function's source, so the numbers are written here (AUTO_PIP_MIN_BOX and
 * AUTO_PIP_MIN_PLAYED_SECONDS say them to the rest of the code, and the test holds the two together).
 */
export function autoFloatVerdict(video: WatchedVideoFacts): AutoFloatVerdict {
  if (!video.playing) return 'paused'
  if (video.live !== true && (video.muted || !(video.volume > 0) || video.audio === false)) return 'silent'
  // A call shows its people in tiles: a tile of half the size of a small player still counts (the largest one floats).
  const long = video.live === true ? 160 : 320
  const short = video.live === true ? 90 : 180
  if (Math.max(video.width, video.height) < long || Math.min(video.width, video.height) < short) return 'small'
  if (!(video.playedSeconds >= 2)) return 'just-started'
  return 'float'
}

/** Closed this many times on one site, the floating window no longer opens by itself there until the application quits. */
export const AUTO_PIP_CLOSES_PER_SITE = 2

/**
 * What the session remembers of the floating windows the rule opened: the one open now (there is one floating window at most, for the whole
 * application), and, by site, how many of them the user closed. A window the rule opened is "closed" when its tab comes back and its video no
 * longer floats: it was closed while the tab was away (by its own button, as a rule; a page that removes its video counts the same). Nothing is
 * written down: quitting forgets it all.
 */
export class AutoPipMemory {
  private open: { readonly tabId: string; readonly site: string } | null = null
  private readonly closes = new Map<string, number>()

  /** Whether a video of this site may still float by itself. */
  allows(site: string): boolean {
    return (this.closes.get(site) ?? 0) < AUTO_PIP_CLOSES_PER_SITE
  }

  /** A video of this tab floated by itself. */
  floated(tabId: string, site: string): void {
    this.open = { tabId, site }
  }

  /** A picture asked for by hand takes the one floating window there is: whatever the rule opened before is no longer on screen because of the user. */
  floatedByHand(): void {
    this.open = null
  }

  /** The tab comes back on screen: the site of the window the rule opened for it, if one was open, which is forgotten from now on. */
  returning(tabId: string): string | null {
    if (this.open?.tabId !== tabId) return null
    const { site } = this.open
    this.open = null
    return site
  }

  /** The window the rule opened for this site was gone when its tab came back: the user closed it. */
  closed(site: string): void {
    this.closes.set(site, (this.closes.get(site) ?? 0) + 1)
  }
}
