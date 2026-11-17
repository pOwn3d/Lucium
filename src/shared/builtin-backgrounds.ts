// The videos Lucium comes with for the background of a space (« Vidéos de Lucium » in the Fond panel). They are made for Lucium
// (resources/backgrounds/README.md) and shipped in the application's resources. A space names one in its background as it names a user's file
// (`value`), and main/media-storage.ts reads it from the resources, never writes it and never deletes it.

import { TEXT_COLORS, VEIL_COLORS, type SpaceBackground } from './space-media'

/** The videos, in the order the panel shows them. */
export const BUILTIN_BACKGROUND_IDS = ['aurores-boreales', 'temple-brume', 'serre-lucioles', 'village', 'foret', 'montagnes', 'ville-cyberpunk', 'fonds-marins', 'hublot-spatial'] as const

export type BuiltinBackgroundId = (typeof BUILTIN_BACKGROUND_IDS)[number]

/** The file of a video, as a space's background names it. Its form cannot be the one of a user's file (`<timestamp>-<8 hex>.<ext>`, media-storage.ts). */
export function builtinVideoFile(id: BuiltinBackgroundId): string {
  return `lucium-${id}.mp4`
}

/** The small picture of a video, for the panel. */
export function builtinPosterFile(id: BuiltinBackgroundId): string {
  return `lucium-${id}.jpg`
}

const BUILTIN_FILES: ReadonlySet<string> = new Set(BUILTIN_BACKGROUND_IDS.flatMap((id) => [builtinVideoFile(id), builtinPosterFile(id)]))

/** Whether a name is one of the files Lucium comes with (a video or its picture): only those exact names, so no other file of the resources can be reached. */
export function isBuiltinBackgroundFile(name: string): boolean {
  return BUILTIN_FILES.has(name)
}

// The look each video comes with, so that choosing one gives a sidebar that reads at once, not only a picture: the darkest veil on the text side, white
// text with its shadow, and a veil whose strength follows how bright the left of the picture is, where the tabs are drawn.
//
// The brightness is the mean luminance (0 to 255) of the left 60 % of the picture of the video (resources/backgrounds/lucium-<id>.jpg), measured with
//   ffmpeg -i lucium-<id>.jpg -vf "crop=iw*0.6:ih:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null -
// and the strength is 35 % at a luminance of 10 or less, 65 % at 60 or more, in a straight line between, rounded to 5 (the step of the slider).
// To redo it after a video changed: make its picture again (resources/backgrounds/README.md), measure it, write the figure in LEFT_LUMA, and update the
// strengths pinned by builtin-backgrounds.test.ts.
// Measured on 2026-11-07:
//   aurores-boreales 58.6 → 65   temple-brume 49.8 → 60 (the value the maintainer validated)   village 52.1 → 60
//   foret 42.7 → 55   montagnes 41.2 → 55   ville-cyberpunk 46.8 → 55
//   fonds-marins 28.6 → 45   serre-lucioles 21.5 → 40   hublot-spatial 13.8 → 35
const LEFT_LUMA: Record<BuiltinBackgroundId, number> = {
  'aurores-boreales': 58.6,
  'temple-brume': 49.8,
  'serre-lucioles': 21.5,
  village: 52.1,
  foret: 42.7,
  montagnes: 41.2,
  'ville-cyberpunk': 46.8,
  'fonds-marins': 28.6,
  'hublot-spatial': 13.8
}

const VEIL_MIN = 35
const VEIL_MAX = 65
const LUMA_FOR_MIN = 10
const LUMA_FOR_MAX = 60
const SLIDER_STEP = 5

/** The strength of the veil (percent) for a left side of this mean luminance: brighter, stronger. */
export function veilStrength(luma: number): number {
  const share = Math.min(1, Math.max(0, (luma - LUMA_FOR_MIN) / (LUMA_FOR_MAX - LUMA_FOR_MIN)))
  return Math.round((VEIL_MIN + share * (VEIL_MAX - VEIL_MIN)) / SLIDER_STEP) * SLIDER_STEP
}

/**
 * The background a space gets when it is given a video of Lucium: the video, played in a loop without sound, with the look of the video (above). Nothing
 * for any other file (a user's own), which keeps the background it always had.
 */
export function builtinBackground(file: string): SpaceBackground | undefined {
  const id = BUILTIN_BACKGROUND_IDS.find((candidate) => builtinVideoFile(candidate) === file)
  if (!id) return undefined
  return { type: 'video', value: file, muted: true, loop: true, veilColor: VEIL_COLORS[0], veilShape: 'text', veil: veilStrength(LEFT_LUMA[id]), textColor: TEXT_COLORS[0], textHalo: true }
}
