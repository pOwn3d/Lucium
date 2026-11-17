// The automatic clearing of the page annotation (docs/design/annotation-partage-fenetre.md, « Effacement automatique »): after a few seconds without
// activity on an annotated page, its marks fade out and are cleared as « Page » clears them, and ⌘Z brings them back. One setting, read and written by
// the Settings (Outils et extensions) and by the timer button of the annotation bar. This file is pure: the delays offered, how a saved value is
// cleaned, and the cycle of the button. The clock runs in the layer of each annotated page (shared/page-annotate-layer.ts), never in the page's world.

/** The delays offered, in seconds: the menu of the Settings, and the cycle of the bar's button after « off ». */
export const AUTO_CLEAR_SECONDS = [3, 5, 10, 20, 30] as const
export type AutoClearSeconds = (typeof AUTO_CLEAR_SECONDS)[number]
/** What the bar shows and sends: 0 while the clearing is off, else its delay in seconds. */
export type AutoClear = 0 | AutoClearSeconds

/** The delay of a setting never chosen: the one switching the clearing on in the Settings gives. */
export const DEFAULT_AUTO_CLEAR_SECONDS: AutoClearSeconds = 5

/** The settings of the clearing, as the state keeps them: the switch, and the delay it keeps while it is off. */
export interface AutoClearSettings {
  annotateAutoClear: boolean
  annotateAutoClearSeconds: AutoClearSeconds
}

/**
 * The delay of a saved file or of a message: one of the choices, the nearest one for a number in between (the shorter one when two are as near), and the
 * default for anything that is not a finite number. A damaged file can neither clear a drawing at once nor keep a timer for hours.
 */
export function cleanAutoClearSeconds(raw: unknown): AutoClearSeconds {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_AUTO_CLEAR_SECONDS
  return AUTO_CLEAR_SECONDS.reduce<AutoClearSeconds>((best, choice) => (Math.abs(choice - raw) < Math.abs(best - raw) ? choice : best), AUTO_CLEAR_SECONDS[0])
}

/** The clearing as the bar shows it: 0 when the switch is off (or is not a flag), else the delay, cleaned. */
export function autoClearOf(settings: { annotateAutoClear: unknown; annotateAutoClearSeconds: unknown }): AutoClear {
  return settings.annotateAutoClear === true ? cleanAutoClearSeconds(settings.annotateAutoClearSeconds) : 0
}

/** Whether a value is one the bar may send: 0 (off), or one of the delays exactly. */
export function isAutoClear(raw: unknown): raw is AutoClear {
  return raw === 0 || (AUTO_CLEAR_SECONDS as readonly unknown[]).includes(raw)
}

/** The next value of the bar's button: off, 3, 5, 10, 20, 30 s, and off again. A value that is not in the cycle goes back to off. */
export function nextAutoClear(current: number): AutoClear {
  if (current === 0) return AUTO_CLEAR_SECONDS[0]
  const at = (AUTO_CLEAR_SECONDS as readonly number[]).indexOf(current)
  return at < 0 || at === AUTO_CLEAR_SECONDS.length - 1 ? 0 : AUTO_CLEAR_SECONDS[at + 1]!
}

/**
 * What a value of the bar writes in the settings. Off switches the clearing off and keeps the delay (switched on again in the Settings, it has the delay
 * it had); a delay switches it on with that delay.
 */
export function autoClearPatch(value: AutoClear): Partial<AutoClearSettings> {
  return value === 0 ? { annotateAutoClear: false } : { annotateAutoClear: true, annotateAutoClearSeconds: value }
}
