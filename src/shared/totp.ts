// One-time codes (TOTP, RFC 6238) for the password vault (docs/gestionnaire-mots-de-passe.md, « Codes à usage unique »). Pure rules shared by the
// main process and the panel: what a secret is, how a typed key or an `otpauth://` address is read, and the shape a stored one must have.
// The HMAC itself is in src/main/totp.ts (it needs node:crypto, which the interface never imports). Nothing here reads a file, and nothing
// here repeats what it was given: a refusal is a kind, never the text that was refused (the text is a secret).

export const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number]

export const TOTP_LIMITS = {
  /** 80 bits: the shortest key the common services give (16 base32 characters). Shorter is not a secret. */
  secretBytesMin: 10,
  secretBytesMax: 128,
  digitsMin: 6,
  digitsMax: 8,
  periodMin: 10,
  periodMax: 300,
  /** An `otpauth://` address, or a key with its spaces, as typed or pasted. */
  inputMax: 2048
} as const

export const TOTP_DEFAULTS = { algorithm: 'SHA1', digits: 6, period: 30 } as const

/** A stored secret and the way to turn it into codes. Only the main process ever holds one: the interface is told that an entry has one, never what it is. */
export interface TotpConfig {
  /** The key in base32 (RFC 4648), upper case, without padding. */
  secret: string
  algorithm: TotpAlgorithm
  digits: number
  /** Seconds a code lasts. */
  period: number
}

/** The code the panel was asked for: the digits, and the seconds that are left before they stop being the code. */
export interface TotpCode {
  id: string
  code: string
  secondsLeft: number
  /** The same time in milliseconds: the panel counts down by this one, so that a code is not shown up to a second after its end. */
  msLeft: number
  period: number
}

export type TotpProblem = 'invalid' | 'unsupported'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The bytes of a base32 text (spaces, hyphens, `=` padding and the case are not significant); null for anything else. */
export function decodeBase32(text: string): Uint8Array | null {
  // Checked before the case is changed: toUpperCase() turns « ß » into « SS » and « ﬁ » into « FI », which would be taken for base32.
  if (!/^[A-Za-z2-7=\s-]*$/u.test(text)) return null
  const clean = text.replace(/[\s-]/gu, '').replace(/=+$/u, '').toUpperCase()
  // Lengths of 1, 3 and 6 characters (mod 8) cannot come out of an encoding.
  if (clean === '' || [1, 3, 6].includes(clean.length % 8)) return null
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
      value &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(bytes)
}

/** Base32 without padding, upper case. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >> bits) & 31]
      value &= (1 << bits) - 1
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Only plain digits are a number here: Number('0x8') is 8, Number(' 6 ') is 6 and Number('') is 0. NaN (refused by the range) for the rest. */
const plainInteger = (text: string | null): number => (text !== null && /^\d{1,4}$/u.test(text) ? Number(text) : Number.NaN)

const inRange = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max

/** The key as the vault stores it, or null when it is not a base32 key of a length that can be one. */
function normalizedSecret(text: string): string | null {
  const bytes = decodeBase32(text)
  if (bytes === null || bytes.length < TOTP_LIMITS.secretBytesMin || bytes.length > TOTP_LIMITS.secretBytesMax) return null
  return encodeBase32(bytes)
}

/** A config of a stored entry: exactly these four fields, each one valid. Null for anything else (the file may be a hand-made one that someone sealed with the right phrase). */
export function storedTotp(raw: unknown): TotpConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 4 || !['secret', 'algorithm', 'digits', 'period'].every((key) => keys.includes(key))) return null
  const { secret, algorithm, digits, period } = raw as Record<string, unknown>
  if (typeof secret !== 'string' || typeof algorithm !== 'string' || typeof digits !== 'number' || typeof period !== 'number') return null
  const normalized = normalizedSecret(secret)
  if (normalized === null || normalized !== secret) return null
  if (!(TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) return null
  if (!inRange(digits, TOTP_LIMITS.digitsMin, TOTP_LIMITS.digitsMax) || !inRange(period, TOTP_LIMITS.periodMin, TOTP_LIMITS.periodMax)) return null
  return { secret, algorithm: algorithm as TotpAlgorithm, digits, period }
}

/**
 * What a person gives to add a code to a login: the key alone (base32, as a site shows it under its QR code) or the `otpauth://totp/…` address
 * that the QR code holds (`secret`, and optionally `algorithm`, `digits`, `period`; the label and the issuer are not kept). A counter-based
 * key (`otpauth://hotp/…`) is not a TOTP and is refused as `unsupported`. A refusal never carries the text.
 */
export function parseTotpInput(input: unknown): { ok: true; config: TotpConfig } | { ok: false; problem: TotpProblem } {
  if (typeof input !== 'string') return { ok: false, problem: 'invalid' }
  const text = input.trim()
  if (text === '' || text.length > TOTP_LIMITS.inputMax) return { ok: false, problem: 'invalid' }
  let secretText = text
  let algorithm: string = TOTP_DEFAULTS.algorithm
  let digits: number = TOTP_DEFAULTS.digits
  let period: number = TOTP_DEFAULTS.period
  if (/^otpauth:/iu.test(text)) {
    if (!URL.canParse(text)) return { ok: false, problem: 'invalid' }
    const url = new URL(text)
    if (url.protocol !== 'otpauth:') return { ok: false, problem: 'invalid' }
    if (url.hostname.toLowerCase() !== 'totp') return { ok: false, problem: url.hostname.toLowerCase() === 'hotp' ? 'unsupported' : 'invalid' }
    const params = url.searchParams
    secretText = params.get('secret') ?? ''
    if (params.has('algorithm')) algorithm = (params.get('algorithm') ?? '').toUpperCase()
    if (params.has('digits')) digits = plainInteger(params.get('digits'))
    if (params.has('period')) period = plainInteger(params.get('period'))
  }
  const secret = normalizedSecret(secretText)
  if (secret === null) return { ok: false, problem: 'invalid' }
  const config = storedTotp({ secret, algorithm, digits, period })
  return config === null ? { ok: false, problem: 'invalid' } : { ok: true, config }
}
