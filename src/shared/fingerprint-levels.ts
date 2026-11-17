// The strengths of the fingerprint protection and the shape of what the page-side code is told. A leaf module (no import but types): the page guard
// preload (src/preload/page-guard.ts) reads it, and a preload is bundled with everything it imports, so it must not drag the settings code along.

export type FingerprintLevel = 'standard' | 'strict'

/** What the page-side code is told to do. All of it is numbers and flags: no code, no pattern. */
export interface FingerprintConfig {
  level: FingerprintLevel
  /** Unsigned 32-bit: the same for one site during one session, different for another site and for the next session. */
  seed: number
  /** `navigator.hardwareConcurrency` and `deviceMemory` are announced as at most this. */
  maxCores: number
  maxMemory: number
  /** `screen` announces a common size that fits the real one. */
  roundScreen: boolean
  /** `queryLocalFonts()` answers an empty list instead of asking for the installed fonts. */
  hideLocalFonts: boolean
  /** The graphics card WebGL names (`WEBGL_debug_renderer_info`) is replaced by a generic one. */
  genericGpu: boolean
  /** Canvases and audio buffers are noised up to this size (pixels, samples); a larger one is read as it is. */
  canvasMaxPixels: number
  audioMaxSamples: number
  /** About one pixel in this many is altered (by 1, in one channel), at least four. */
  pixelsPerAlteration: number
  /**
   * `SharedWorker` is taken away from the document. Nothing can run in a shared worker before its script, so it reads the machine as it is:
   * the strict strength removes it, the standard one leaves it to the sites that need it and says it is not covered.
   */
  removeSharedWorker: boolean
}

const STANDARD: Omit<FingerprintConfig, 'seed'> = {
  level: 'standard',
  maxCores: 8,
  maxMemory: 8,
  roundScreen: false,
  hideLocalFonts: false,
  genericGpu: false,
  canvasMaxPixels: 1_048_576,
  audioMaxSamples: 1_048_576,
  pixelsPerAlteration: 256,
  removeSharedWorker: false
}

const STRICT: Omit<FingerprintConfig, 'seed'> = {
  level: 'strict',
  maxCores: 4,
  maxMemory: 4,
  roundScreen: true,
  hideLocalFonts: true,
  genericGpu: true,
  canvasMaxPixels: 8_388_608,
  audioMaxSamples: 4_194_304,
  pixelsPerAlteration: 64,
  removeSharedWorker: true
}

export const FINGERPRINT_LEVELS: Readonly<Record<FingerprintLevel, Omit<FingerprintConfig, 'seed'>>> = { standard: STANDARD, strict: STRICT }


/** What a configuration received from outside is made of, or null: a message from another process is read like a file. */
export function cleanFingerprintConfig(raw: unknown): FingerprintConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const level = r['level'] === 'strict' ? 'strict' : r['level'] === 'standard' ? 'standard' : null
  const seed = r['seed']
  if (level === null || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null
  // Only the level decides the strength: the other fields of the message are the table's, not the sender's.
  return { ...FINGERPRINT_LEVELS[level], seed }
}

