// The catalogue of the errors of the synchronisation, the same on both sides (docs/synchronisation.md §7.6). Each code says whether it ends the connection.
// The words the person reads are catalogue keys (`sync.error.<code>`), never these codes; `detail` of an `error` message is for the log and is never shown.

export const ERROR_CODES = [
  'bad-frame', 'too-large', 'bad-message', 'unknown-type', 'bad-sequence', 'unsupported-version', 'invalid-code', 'not-paired', 'fingerprint-mismatch', 'bad-proof',
  'pairing-expired', 'pairing-used', 'pairing-locked', 'pairing-closed', 'pairing-refused', 'rate-limited', 'timeout', 'busy', 'locked', 'state-too-new', 'truncated',
  'divergence', 'clock-skew', 'internal'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** A warning, not an end: the clocks differ by more than five minutes (§9.3). Every other code closes the connection. */
export const isFatal = (code: ErrorCode): boolean => code !== 'clock-skew'

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)

/** The verdict of a check that may refuse with a code of the catalogue. */
export type Verdict = { ok: true } | { ok: false; code: ErrorCode }
