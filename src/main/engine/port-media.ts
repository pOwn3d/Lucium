// The engine port (types.ts), the media of a page: its sound, reading aloud, Picture in Picture and Lucium's floating video window. Re-exported by
// types.ts, which the rest of Lucium imports.

import type { MediaProbe } from '@shared/media-player'
import type { FloatingVideoFacts, VideoCommand } from '@shared/floating-video'

/** Who asks for Picture in Picture: the user (the menu, the media player), or the tab switch of the automatic picture (setting `autoPictureInPicture`). */
export type PictureInPictureAsker = 'user' | 'tab-switch'
/** Why a video did not float (the reasons of the page script, and the failures around it). */
export type PictureInPictureOutcome = { ok: true } | { ok: false; reason: 'already' | 'no-video' | 'refused' | 'gone' | 'error'; detail?: string }

/** What `Page.stageFloatingVideo` answers: the video is brought to fill the page (with the size of its frames), or why not. */
export type FloatingStage = { staged: true; width: number; height: number; live: boolean; protected: boolean } | { staged: false; reason: 'no-video' | 'gone' | 'error'; detail?: string }

/** The media of a page. */
export interface PageMedia {
  setMuted(muted: boolean): void
  /** Reads `text` aloud with the system's voice, in `lang` when it is one; a text read already is replaced. Nothing is said if the system has no voice. */
  speak(text: string, lang: string | null): void
  /** Stops what `speak` is saying. */
  stopSpeaking(): void
  /**
   * Starts (on) or stops (off) Picture in Picture for the playing video. Resolves true when something changed. Asked by the user (the default),
   * whatever can float does; on a tab switch, only a video being watched (shared/auto-pip.ts).
   */
  setPictureInPicture(on: boolean, by?: PictureInPictureAsker): Promise<boolean>
  /** Whether a video being watched (shared/auto-pip.ts) is on the page: what leaving the tab would float. Asked without a gesture. */
  watchedVideoCanFloat?(): Promise<boolean>
  /** "Image dans l'image" of the page's main video, asked by the user; says why nothing floated. */
  floatMainVideo(): Promise<PictureInPictureOutcome>
  /**
   * Where the video Lucium's floating window would float is: in the page itself (its document and open shadow trees), only in one of its frames (an
   * embedded player: that one floats in the system's own Picture in Picture window, see `floatFrameVideo`), or nowhere. Asked without a user gesture.
   */
  findFloatingVideo?(): Promise<'page' | 'frame' | 'none'>
  /** Picture in Picture of the video of one of the page's frames (an embedded player), asked by the user: the floating window of the system. */
  floatFrameVideo?(): Promise<PictureInPictureOutcome>
  /**
   * Brings the page's video to fill the page where it is, above the rest of the page (engine/floating-video-scripts.ts, FLOAT_STAGE): what the
   * floating window shows. Answers the size of its frames (the proportions of the window), whether it is a live stream and a protected one.
   */
  stageFloatingVideo?(): Promise<FloatingStage>
  /** Gives the page back as it was before `stageFloatingVideo`. */
  unstageFloatingVideo?(): Promise<void>
  /** What the floating window's bar shows of the staged video (shared/floating-video.ts), or null when there is none to read. */
  floatingVideoFacts?(): Promise<FloatingVideoFacts | null>
  /** Plays, pauses, sets the volume of, or moves the staged video, as the user asked (with a user gesture): true when it was done. */
  floatingVideoCommand?(command: VideoCommand): Promise<boolean>
  /**
   * The level of the whole tab, 0 to 1. In the main frame it scales what the page asks for (a page that sets its own volume keeps its
   * relative level, and the media that start later, the next track, are brought to it); the media of an embedded frame are turned down
   * once, now. Sound that does not come from a media element (the Web Audio API) is not reached.
   */
  setVolume(volume: number): void
  /**
   * Plays or pauses the media of the page, or runs the previous / next track action its site registered. Resolves true when the page
   * had something to act on, false when nothing answered (no media, no handler).
   */
  controlMedia(command: 'play' | 'pause' | 'previous' | 'next'): Promise<boolean>
  /** What the page's media is doing, all frames together. Null when the page cannot answer (gone, frozen, or no reply). */
  probeMedia(): Promise<MediaProbe | null>
}
