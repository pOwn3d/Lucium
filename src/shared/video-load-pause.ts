// When the video behind a space stops by itself (the function `video-load-pause`): a call is on (a page was given the camera, the microphone or the
// screen) or the Mac is struggling (the processors of the browser together keep a core busy, or macOS says memory is short). A video that is decoded
// and composed all the time costs the graphic process a good share of a core: a call or a loaded machine has better use of it. Pure: the main process
// reads the facts at its own beat (shell/video-load-guard.ts), the sidebar holds the video still while the snapshot carries a reason.

/** Why the video is held still: a call, or a loaded machine. A call comes first when both hold. */
export type VideoPauseReason = 'capture' | 'load'

/** Whether the video behind the spaces is held still by itself: the battery saver is on, or a call or a load stops it (what the snapshot says). */
export function videoHeldStill(flags: { batterySaverOn?: true; videoLoadPause?: VideoPauseReason }): boolean {
  return flags.batterySaverOn === true || flags.videoLoadPause !== undefined
}

/** From this processor (in % of one core, every process of the browser together) the machine counts as loaded… */
export const LOAD_PAUSE_CPU = 100
/** …and counts as relieved again below this: a gap, so that the video does not start and stop at each reading. */
export const LOAD_RESUME_CPU = 50
/** The load must be seen on this many readings in a row before the video stops: a burst (a page that loads) does not stop it. */
export const LOAD_PAUSE_READINGS = 4
/** How often the guard reads the facts, in ms. */
export const LOAD_READING_MS = 15_000

/** What the guard remembers between two readings. */
export interface VideoPauseState {
  reason: VideoPauseReason | null
  /** The readings in a row that showed a load, while the video still plays. */
  loaded: number
}

export const INITIAL_VIDEO_PAUSE: VideoPauseState = { reason: null, loaded: 0 }

/** What one reading saw. `cpu` is null when it cannot be told (the first reading of a meter has no interval to average over). */
export interface VideoPauseReading {
  /** Some page of the browser was given the camera, the microphone or the screen. */
  capturing: boolean
  cpu: number | null
  /** macOS says memory is short. */
  pressure: boolean
}

/** The state after a reading. A call stops the video at once and lets it go as soon as it ends; the load stops it after several readings and lets it go once it eased. */
export function nextVideoPause(state: VideoPauseState, reading: VideoPauseReading): VideoPauseState {
  if (reading.capturing) return { reason: 'capture', loaded: 0 }
  const cpu = reading.cpu !== null && Number.isFinite(reading.cpu) ? reading.cpu : null
  // Held for the load: it lets go only when the processor is below the lower mark and memory is no longer short. A reading without a figure keeps what was.
  if (state.reason === 'load') return cpu === null ? state : reading.pressure || cpu >= LOAD_RESUME_CPU ? state : { reason: null, loaded: 0 }
  const loaded = reading.pressure || (cpu !== null && cpu >= LOAD_PAUSE_CPU) ? state.loaded + 1 : cpu === null ? state.loaded : 0
  return loaded >= LOAD_PAUSE_READINGS ? { reason: 'load', loaded: 0 } : { reason: null, loaded }
}
