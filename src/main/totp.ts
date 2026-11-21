// The one-time code of RFC 6238 (TOTP over the HOTP of RFC 4226): HMAC of the number of periods since the epoch, then the dynamic truncation. The
// secret is a key in base32 (shared/totp.ts) and goes no further than this function: what comes out is the digits and the seconds they last.
// Nothing here logs or throws a value; an unusable clock is a plain Error without the key in it.

import { createHmac } from 'node:crypto'
import { decodeBase32, type TotpAlgorithm, type TotpConfig } from '@shared/totp'

const HASHES: Record<TotpAlgorithm, string> = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' }

/** The code of `config` at the time `atMs` (milliseconds since the epoch), and the whole seconds left before it changes (1 to `period`). */
export function totpAt(config: TotpConfig, atMs: number): { code: string; secondsLeft: number } {
  if (!Number.isFinite(atMs) || atMs < 0) throw new Error('the time is not a time')
  const key = decodeBase32(config.secret)
  if (key === null) throw new Error('the key is not base32')
  const seconds = Math.floor(atMs / 1000)
  const counter = Math.floor(seconds / config.period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(HASHES[config.algorithm], key).update(message).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  const code = String(binary % 10 ** config.digits).padStart(config.digits, '0')
  return { code, secondsLeft: config.period - (seconds % config.period) }
}
