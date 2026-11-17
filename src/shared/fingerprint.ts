// Protection against browser fingerprinting: which pages get it, and with what strength. Pure rules; the work itself is done in the page
// (src/preload/guard-world.ts, patching the main world before the page's scripts run) and by Chromium (the WebRTC policy of the page).
//
// What it can do without patching Chromium, and what it leaves alone, is told in docs/fonctions.md (`fingerprint`). Short version: it adds a
// stable, per-site, per-session noise to what a script reads back from a canvas, WebGL or the audio engine; it narrows the figures
// `navigator` and `screen` announce; it keeps the addresses of the machine out of WebRTC. It does not touch plug-ins (Chromium announces a
// fixed list to everyone, hiding it would make the browser easier to recognise) nor the measure of text (fonts), which a script can do
// with ordinary layout.

import { cleanBlockExceptions, isBlockingExempt } from './blocker'
import { FINGERPRINT_LEVELS, type FingerprintConfig } from './fingerprint-levels'
import type { Settings } from './model'

export { FINGERPRINT_LEVELS, cleanFingerprintConfig, type FingerprintConfig, type FingerprintLevel } from './fingerprint-levels'

/** Sites in the list: more than anyone writes by hand, and a bound for a hand-edited file. */
export const FINGERPRINT_EXCEPTIONS_MAX = 200

/** The sites left out, as a saved file or a message may carry them: valid hosts, each once. */
export const cleanFingerprintExceptions = (raw: unknown): string[] => cleanBlockExceptions(raw).slice(0, FINGERPRINT_EXCEPTIONS_MAX)

/** `blockExceptions` is the list of "Blocage pour ce site" (the switch of the site panel): a site switched off there is left alone by this protection too. */
type Wanted = Pick<Settings, 'reduceFingerprint' | 'fingerprintStrict' | 'fingerprintExceptions'> & Partial<Pick<Settings, 'blockExceptions'>>

/**
 * Whether a document of this address is protected: web pages only (the interface and the pages of extensions are not pages to hide from), and not on a listed
 * site, nor on one the switch of the site panel turned off (a site the protection breaks must be recoverable from the panel, like one a list breaks).
 */
export function isFingerprintProtected(settings: Wanted, pageUrl: string | null | undefined): boolean {
  if (!settings.reduceFingerprint || !pageUrl || !URL.canParse(pageUrl)) return false
  const protocol = new URL(pageUrl).protocol
  if (protocol !== 'http:' && protocol !== 'https:') return false
  return !isBlockingExempt(pageUrl, settings.fingerprintExceptions) && !isBlockingExempt(pageUrl, settings.blockExceptions ?? [])
}

/** The configuration for a document, or null when it gets none. `seedFor` gives the 32-bit seed of a site (the main process derives it from a key it keeps in memory). */
export function fingerprintConfigFor(settings: Wanted, pageUrl: string | null | undefined, seedFor: (url: string) => number): FingerprintConfig | null {
  if (!isFingerprintProtected(settings, pageUrl)) return null
  const seed = seedFor(pageUrl!)
  return { ...FINGERPRINT_LEVELS[settings.fingerprintStrict ? 'strict' : 'standard'], seed: Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : 0 }
}

/**
 * The strength of the moment whatever the site, or null while the protection is off: what a frame is given when its page is not known yet
 * (src/shared/inner-guard.ts). `salt` stands where the seed of a site would; the frame mixes it with the origin of its page.
 */
export function fingerprintFallback(settings: Pick<Settings, 'reduceFingerprint' | 'fingerprintStrict'>, salt: number): FingerprintConfig | null {
  if (!settings.reduceFingerprint) return null
  return { ...FINGERPRINT_LEVELS[settings.fingerprintStrict ? 'strict' : 'standard'], seed: Number.isInteger(salt) && salt >= 0 && salt <= 0xffffffff ? salt : 0 }
}

/**
 * Chromium's WebRTC policy for a page: `default_public_interface_only` keeps the addresses of the machine's other interfaces out of the
 * candidates a page can read (calls still work on the default route). `null` leaves Chromium's own policy. (`disable_non_proxied_udp` would
 * stop calls without a proxy: not offered.)
 */
export type WebRtcPolicy = 'default_public_interface_only'
export function webRtcPolicyFor(settings: Wanted, pageUrl: string | null | undefined): WebRtcPolicy | null {
  return isFingerprintProtected(settings, pageUrl) ? 'default_public_interface_only' : null
}

/** The settings of this file's features as a saved file may hold them: flags are true only when they are `true`, and the site list is cleaned. */
export function cleanFingerprintSettings(settings: Settings): Pick<Settings, 'blockScriptlets' | 'reduceFingerprint' | 'fingerprintStrict' | 'fingerprintExceptions'> {
  return {
    blockScriptlets: settings.blockScriptlets === true,
    reduceFingerprint: settings.reduceFingerprint === true,
    fingerprintStrict: settings.fingerprintStrict === true,
    fingerprintExceptions: cleanFingerprintExceptions(settings.fingerprintExceptions)
  }
}
