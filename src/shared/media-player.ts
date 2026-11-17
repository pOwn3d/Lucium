// The media player of the sidebar foot (the "mini player"): a navy bar that shows up when a tab that makes
// sound is left for another one, with the controls of that tab. The pure parts live here: which tabs have a player, the numbers of its
// layout, the texts, the volume slider, and the messages the shell and the pages exchange. Electron and React only draw and carry them.

import type { TabRuntime } from './model'
import { t } from './i18n'

/** The measures of the media player. Lengths in px, durations in ms. */
export const MEDIA_PLAYER = {
  /** One row of the bar: the header (title), the controls, the volume slider. A folded bar is the controls alone. */
  row: 33,
  /** Between the list of tabs and the bar, and between two bars. */
  gap: 8,
  /** The bar is inset by this much from both edges of the sidebar. */
  inset: 8,
  radius: 12,
  /** The buttons are squares in the middle of the row's height; their hover fill has rounded corners of `buttonRadius`. */
  button: 24,
  buttonRadius: 6,
  /** The slider: a 6 px track, a 20 x 16 thumb, 8 px from the edges of the bar. */
  track: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  sliderInset: 8,
  /** Players that can be stacked at once. */
  maxPlayers: 3,
  /** The bar unfolds (title row) and folds back in this long, decelerating; from the slider row it takes a little longer. */
  unfoldMs: 200,
  foldFromSliderMs: 240,
  /** With the slider open, the bar waits this long after the pointer left before it folds (measured once: 1.8 s). */
  sliderGraceMs: 1800,
  /** The info-bubbles of the bar show after this long on a button (the toolbar's are quicker). */
  tooltipDelayMs: 1500
} as const

/** The bubble of a button of the bar: its top left corner is the pointer + (5, 6), and it has 9 px of margin on each side of its label (the toolbar's: 9 and 10). */
export const MEDIA_BUBBLE = { offsetX: 5, padding: 9 } as const

/** What the bar says, in the voice of the rest of the application. */
export const MEDIA_TEXT = {
  get back() { return t('media-player.retour-a-l-onglet') },
  get previous() { return t('media-player.piste-precedente') },
  get next() { return t('media-player.piste-suivante') },
  get volume() { return t('media-player.regler-le-volume-de-l-onglet') },
  get pip() { return t('media-player.ouvrir-l-image-dans-l-image') },
  get close() { return t('media-player.fermer-le-mini-lecteur') },
  get play() { return t('media-player.lecture') },
  get pause() { return t('media-player.pause') },
  /** What a button that cannot act says, instead of doing nothing. */
  get noPrevious() { return t('media-player.ce-site-ne-propose-pas-de-piste-precedente') },
  get noNext() { return t('media-player.ce-site-ne-propose-pas-de-piste-suivante') },
  get noVideo() { return t('media-player.aucune-video-a-afficher-en-image-dans-l-image') }
} as const

export interface MediaFacts {
  /** The page is making sound now. */
  audible: boolean
  muted: boolean
  playing: boolean
  /** What the page offers: a MediaSession handler for the previous / next track, a video that can float. */
  previous: boolean
  next: boolean
  video: boolean
}

export interface MediaLabels {
  back: string
  previous: string
  next: string
  toggle: string
  volume: string
  pip: string
  close: string
}

/**
 * The tooltips and the accessible names of the buttons. They are the same text, and say what the button does *now*: the previous
 * button is named as going back and the next one as going forward, never the other way round.
 */
export function mediaLabels(facts: Pick<MediaFacts, 'playing' | 'previous' | 'next' | 'video'>): MediaLabels {
  return {
    back: MEDIA_TEXT.back,
    previous: facts.previous ? MEDIA_TEXT.previous : MEDIA_TEXT.noPrevious,
    next: facts.next ? MEDIA_TEXT.next : MEDIA_TEXT.noNext,
    toggle: facts.playing ? MEDIA_TEXT.pause : MEDIA_TEXT.play,
    volume: MEDIA_TEXT.volume,
    pip: facts.video ? MEDIA_TEXT.pip : MEDIA_TEXT.noVideo,
    close: MEDIA_TEXT.close
  }
}

/** Playing is what the page's media says; before the first answer, a tab that makes sound is taken to be playing. */
export function isPlaying(info: Pick<TabRuntime, 'audible' | 'playing'> | undefined): boolean {
  return info?.playing ?? info?.audible ?? false
}

/** The volume of the tab, 1 (the page's own level) until the user moves the slider. */
export function tabVolume(info: Pick<TabRuntime, 'volume'> | undefined): number {
  return info?.volume ?? 1
}

// ---- which tabs have a player ----

/**
 * Whether leaving this tab opens a player for it: it makes sound the user can hear. A tab already muted when it is left has none (the
 * row of the tab keeps its crossed speaker); one muted afterwards keeps its player.
 */
export function opensPlayer(info: Pick<TabRuntime, 'audible' | 'muted'> | undefined): boolean {
  return !!info && info.audible && !info.muted
}

/** The players after one more: the newest last, and no more than the ceiling (the oldest go first). */
export function addPlayer(players: readonly string[], tabId: string, max: number = MEDIA_PLAYER.maxPlayers): string[] {
  return [...players.filter((id) => id !== tabId), tabId].slice(-max)
}

export interface PlayerFacts {
  exists(tabId: string): boolean
  /** On screen now (the active tab, or a pane of its split view): its own controls are there, so no player. */
  visible(tabId: string): boolean
  info(tabId: string): Pick<TabRuntime, 'awake' | 'media'> | undefined
}

/** The players that still make sense: the tab exists, is not on screen, has a live page, and that page still has media. The same array when nothing changes. */
export function prunePlayers(players: readonly string[], facts: PlayerFacts): readonly string[] {
  const kept = players.filter((id) => {
    if (!facts.exists(id) || facts.visible(id)) return false
    const info = facts.info(id)
    return !!info && info.awake && info.media !== false
  })
  return kept.length === players.length ? players : kept
}

// ---- the volume slider ----

/** A volume is a number from 0 to 1 in hundredths; anything else is refused (null). */
export function parseVolume(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) return null
  return Math.round(raw * 100) / 100
}

/** The volume under the pointer: the centre of the thumb follows it, so the thumb travels `trackWidth - thumbWidth`. */
export function volumeAt(offsetX: number, trackWidth: number, thumbWidth: number = MEDIA_PLAYER.thumbWidth): number {
  const travel = trackWidth - thumbWidth
  if (!(travel > 0) || !Number.isFinite(offsetX)) return 1
  return Math.round(Math.min(1, Math.max(0, (offsetX - thumbWidth / 2) / travel)) * 100) / 100
}

/** The left edge of the thumb for a volume. */
export function thumbLeft(volume: number, trackWidth: number, thumbWidth: number = MEDIA_PLAYER.thumbWidth): number {
  return Math.min(1, Math.max(0, volume)) * Math.max(0, trackWidth - thumbWidth)
}

// ---- what the UI asks of the shell ----

export const MEDIA_COMMANDS = ['toggle', 'previous', 'next', 'pip', 'close', 'back'] as const
export type MediaCommand = (typeof MEDIA_COMMANDS)[number]

export type MediaRequest = { tabId: string; command: MediaCommand } | { tabId: string; command: 'volume'; volume: number }

/** Reads a request from the sidebar; the shell does not trust it, so anything but a known command on a tab id (or a volume from 0 to 1) is refused. */
export function parseMediaRequest(raw: unknown): MediaRequest | null {
  const r = raw as { tabId?: unknown; command?: unknown; volume?: unknown } | null
  if (!r || typeof r.tabId !== 'string' || r.tabId.length === 0 || r.tabId.length > 200) return null
  if (r.command === 'volume') {
    const volume = parseVolume(r.volume)
    return volume === null ? null : { tabId: r.tabId, command: 'volume', volume }
  }
  return (MEDIA_COMMANDS as readonly unknown[]).includes(r.command) ? { tabId: r.tabId, command: r.command as MediaCommand } : null
}

// ---- what the shell and the pages exchange (the bridge loaded into every page: src/preload/media-bridge.ts) ----

export const MEDIA_BRIDGE = {
  /** A page that has just started asks for the volume of its tab (invoke). */
  hello: 'lucium-media-hello',
  /** The main frame tells which MediaSession actions the site registered (send). */
  actions: 'lucium-media-actions',
  /** The shell asks the frames of a page to set the volume or to run a MediaSession action (send). */
  command: 'lucium-media-command'
} as const

/** The MediaSession actions the shell can run in a page. */
export const SESSION_ACTIONS = ['previoustrack', 'nexttrack'] as const

/** Which of the previous / next track actions a site registered, from the list of handler names its page reported. Null when it is not a list of names. */
export function parseSessionActions(raw: unknown): { previous: boolean; next: boolean } | null {
  if (!Array.isArray(raw) || raw.length > 40 || raw.some((name) => typeof name !== 'string' || name.length > 40)) return null
  return { previous: raw.includes('previoustrack'), next: raw.includes('nexttrack') }
}

/** What the shell reads from the media of a page, all frames together. */
export interface MediaProbe {
  /** A media element is playing (not paused, not ended). */
  playing: boolean
  /** The page has a media element at all. */
  media: boolean
  /** A video that can float (not audio only, not forbidden to). */
  video: boolean
}

/** The probes of the frames of one page, as one: any frame that plays, has media, or has a video makes it so. */
export function mergeProbes(probes: readonly (Partial<MediaProbe> | null | undefined)[]): MediaProbe {
  const merged: MediaProbe = { playing: false, media: false, video: false }
  for (const probe of probes) {
    if (!probe) continue
    merged.playing ||= probe.playing === true
    merged.media ||= probe.media === true
    merged.video ||= probe.video === true
  }
  return merged
}
