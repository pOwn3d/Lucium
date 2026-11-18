// The text of a pairing (docs/synchronisation.md §4.2, §4.3): the line the QR carries, and the code a person types when the iPhone has no camera. The Mac writes
// both (`qrText`, `manualCode`); the reading functions are the ones the iPhone's own reader must agree with, played against the same vectors
// (ios/Contracts/sync-pairing-vectors.json: `qr`, `manualCode`), and the Mac uses them on what it wrote to be sure it can be read back.
//
// The QR is a line of text, not a URL: a URL parser does not read the same in Swift and in JavaScript. The reading is strict: a space, a segment more or less,
// a character out of the alphabet, a wrong length, a port of zero or too large, or a host that is not local, refuses the code.

import { FINGERPRINT_BYTES, MAX_HOSTS, QR_MAX_CHARS, QR_PREFIX, QR_VERSION, SECRET_BYTES } from './limits'
import { isLocalAddress } from './address-policy'

export type PairingCodeProblem = 'invalid-code' | 'unsupported-version'

export interface QrContent {
  fingerprint: Buffer
  secret: Buffer
  port: number
  hosts: string[]
}

export type QrReading = ({ ok: true } & QrContent) | { ok: false; code: PairingCodeProblem }

const B64U_FINGERPRINT = /^[A-Za-z0-9_-]{43}$/
const B64U_SECRET = /^[A-Za-z0-9_-]{22}$/
const PORT = /^[1-9][0-9]{0,4}$/

/** The bytes of a base64url text of the exact length, only when writing them back gives the same text (the last character carries bits that must be zero). */
function canonicalBase64Url(value: string, pattern: RegExp, bytes: number): Buffer | null {
  if (!pattern.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null
}

/** What the Mac writes in the QR: `lucium-sync:1/<fp>/<secret>/<port>/<hosts>`. Throws on a content the reading would refuse: the Mac never shows a code nobody can read. */
export function qrText(content: QrContent): string {
  const text = `${QR_PREFIX}${QR_VERSION}/${content.fingerprint.toString('base64url')}/${content.secret.toString('base64url')}/${content.port}/${content.hosts.join(',')}`
  const reading = readQr(text)
  if (!reading.ok) throw new Error(`qrText: the content cannot be read back (${reading.code})`)
  return text
}

/** The content of a QR text, or why it is refused. */
export function readQr(text: string): QrReading {
  const invalid = { ok: false, code: 'invalid-code' } as const
  if (text.length > QR_MAX_CHARS) return invalid
  const head = /^lucium-sync:(\d+)\/([^]*)$/.exec(text)
  if (head?.[1] === undefined || head[2] === undefined) return invalid
  if (Number(head[1]) !== QR_VERSION) return { ok: false, code: 'unsupported-version' }
  const parts = head[2].split('/')
  if (parts.length !== 4) return invalid
  const [fingerprintText, secretText, portText, hostsText] = parts as [string, string, string, string]
  const fingerprint = canonicalBase64Url(fingerprintText, B64U_FINGERPRINT, FINGERPRINT_BYTES)
  const secret = canonicalBase64Url(secretText, B64U_SECRET, SECRET_BYTES)
  if (fingerprint === null || secret === null) return invalid
  if (!PORT.test(portText) || Number(portText) > 65_535) return invalid
  const hosts = hostsText.split(',')
  if (hosts.length < 1 || hosts.length > MAX_HOSTS) return invalid
  // Lower case only: two devices must write a host the same way, and a name is compared as written.
  if (!hosts.every((host) => host === host.toLowerCase() && isLocalAddress(host))) return invalid
  return { ok: true, fingerprint, secret, port: Number(portText), hosts }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 128 bits in groups of five bits: 26 characters, the last one carrying 3 padding bits that are zero. */
const MANUAL_CODE_CHARS = 26

/** The secret as the person types it: the alphabet of RFC 4648 (A–Z, 2–7), 26 characters in groups of five joined by dashes (`ABCDE-FGHIJ-…-Z`). */
export function manualCode(secret: Buffer): string {
  if (secret.length !== SECRET_BYTES) throw new Error('manualCode: a secret is 16 bytes')
  let bits = ''
  for (const byte of secret) bits += byte.toString(2).padStart(8, '0')
  bits = bits.padEnd(MANUAL_CODE_CHARS * 5, '0')
  let text = ''
  for (let index = 0; index < MANUAL_CODE_CHARS; index++) text += BASE32[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)]
  return text.match(/.{1,5}/g)?.join('-') ?? text
}

/** The secret of a typed code: case, spaces and dashes are ignored; any other character, a wrong length or padding bits that are not zero refuse it. */
export function readManualCode(input: string): { ok: true; secret: Buffer } | { ok: false; code: 'invalid-code' } {
  const text = input.replace(/[\s-]+/g, '').toUpperCase()
  if (text.length !== MANUAL_CODE_CHARS || ![...text].every((char) => BASE32.includes(char))) return { ok: false, code: 'invalid-code' }
  let bits = ''
  for (const char of text) bits += BASE32.indexOf(char).toString(2).padStart(5, '0')
  if (!/^0*$/.test(bits.slice(SECRET_BYTES * 8))) return { ok: false, code: 'invalid-code' }
  const bytes = bits.slice(0, SECRET_BYTES * 8).match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []
  return { ok: true, secret: Buffer.from(bytes) }
}

/** The address a person types next to the code (`Mac-de-….local:49213`): the first host and the port, in the form the iPhone's « Saisir un code » reads. IPv6 goes between brackets. */
export function manualAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}
