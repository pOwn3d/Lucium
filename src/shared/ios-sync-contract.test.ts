// The synchronisation between the Mac and the iPhone (docs/synchronisation.md) is written twice, in TypeScript and in Swift, and neither exists yet.
// What holds the two together is shared vectors (ios/Contracts/sync-pairing-vectors.json and sync-message-vectors.json). This suite does two things:
//   1. it checks the *form* of every vector (a vector nobody can read is worth nothing);
//   2. it plays them against a small *reference reader* written in this file, so that an expectation that contradicts the text of the specification
//      fails here and not on the day the real code is written. The cards that write src/main/sync/ (Mac) and LuciumKit (iPhone) replace the
//      reference reader by the real code and play the same vectors against it; LuciumKit reads the same files in SyncVectorTests.swift.
// The three-way merge has its own suite (ios-sync-merge-contract.test.ts).
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto'
import { isIPv4, isIPv6, BlockList } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { LOCK_SETTING_KEYS } from './lock'

const contracts = join(__dirname, '../../ios/Contracts')
const read = <T>(name: string): T => JSON.parse(readFileSync(join(contracts, name), 'utf8')) as T

type Verdict = { ok: true } | { ok: false; code: string; at?: number }
const HEX = (bytes: number): RegExp => new RegExp(`^[0-9a-f]{${bytes * 2}}$`)
const B64U = (chars: number): RegExp => new RegExp(`^[A-Za-z0-9_-]{${chars}}$`)
const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest()
const fromHex = (hex: string): Buffer => Buffer.from(hex, 'hex')

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface ProofInputs { secret: string; fpMac: string; fpPhone: string; nonceMac: string; noncePhone: string; idMac: string; idPhone: string; requestTag: string; acceptTag: string }
interface PairingVectors {
  constants: { secretBytes: number; nonceBytes: number; fingerprintBytes: number; windowMs: number; maxInvalidProofs: number; qrMaxChars: number; qrMaxHosts: number; comparisonCodeChars: number; commitBytes: number; codeNonceBytes: number }
  proof: (ProofInputs & { name: string })[]
  mutations: { of: string; cases: (Partial<ProofInputs> & { field: keyof ProofInputs; value?: string; valueHex?: string; requestTag: string; acceptTag: string; changesRequestTag: boolean; changesAcceptTag: boolean })[] }
  qr: { valid: { name: string; text: string; expect: { fingerprintHex: string; secretHex: string; port: number; hosts: string[] } }[]; invalid: { name: string; text: string; expect: { code: string } }[] }
  manualCode: { valid: { name: string; input: string; expect: { secretHex: string } }[]; invalid: { name: string; input: string; expect: { code: string } }[] }
  commitments: { name: string; fpPhone: string; nonceCodePhone: string; commit: string }[]
  comparisonCode: { name: string; fpMac: string; fpPhone: string; nonceCodeMac: string; nonceCodePhone: string; code: string }[]
  secretLifecycle: { name: string; events: { atMs: number; event: 'request' | 'confirm' | 'close'; proof?: 'valid' | 'invalid'; decision?: 'refuse' | 'allow' }[]; expect: string[] }[]
  clientChecks: { name: string; mode: 'qr' | 'manualCode'; expectedFingerprintHex: string | null; presentedFingerprintHex: string; expect: string }[]
  addressPolicy: { host: string; allowed: boolean }[]
  certificate: { spkiHex: string; serialHex: string; tbsHex: string; certificateDerHex: string; fingerprintHex: string }
}
const pairing = read<PairingVectors>('sync-pairing-vectors.json')

/** docs/synchronisation.md §4.4: every field is written after its length on two bytes, big-endian. */
const lp = (field: Buffer): Buffer => Buffer.concat([Buffer.from([field.length >> 8, field.length & 255]), field])
const transcription = (label: string, fields: Buffer[]): Buffer => Buffer.concat([lp(Buffer.from(label, 'utf8')), ...fields.map(lp)])
const hmac = (secret: Buffer, data: Buffer): string => createHmac('sha256', secret).update(data).digest('base64url')
function proofsOf(i: { secret: Buffer; fpMac: Buffer; fpPhone: Buffer; nonceMac: Buffer; noncePhone: Buffer; idMac: string; idPhone: string }): { requestTag: string; acceptTag: string } {
  return {
    requestTag: hmac(i.secret, transcription('lucium-sync/1 pair-request', [i.fpMac, i.fpPhone, i.nonceMac, i.noncePhone, Buffer.from(i.idPhone)])),
    acceptTag: hmac(i.secret, transcription('lucium-sync/1 pair-accept', [i.fpMac, i.fpPhone, i.nonceMac, i.noncePhone, Buffer.from(i.idMac), Buffer.from(i.idPhone)]))
  }
}
const inputsOf = (c: ProofInputs): Parameters<typeof proofsOf>[0] => ({ secret: fromHex(c.secret), fpMac: fromHex(c.fpMac), fpPhone: fromHex(c.fpPhone), nonceMac: fromHex(c.nonceMac), noncePhone: fromHex(c.noncePhone), idMac: c.idMac, idPhone: c.idPhone })

describe('iOS contract: sync pairing vectors, form', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(pairing.proof.length).toBeGreaterThanOrEqual(2)
    expect(pairing.mutations.cases.length).toBe(7)
    expect(pairing.qr.valid.length).toBeGreaterThanOrEqual(5)
    expect(pairing.qr.invalid.length).toBeGreaterThanOrEqual(20)
    expect(pairing.manualCode.valid.length).toBeGreaterThanOrEqual(4)
    expect(pairing.manualCode.invalid.length).toBeGreaterThanOrEqual(6)
    expect(pairing.secretLifecycle.length).toBeGreaterThanOrEqual(12)
    expect(pairing.clientChecks.length).toBe(3)
    expect(pairing.addressPolicy.length).toBeGreaterThan(40)
  })

  it('states the constants of the specification', () => {
    expect(pairing.constants).toEqual({ secretBytes: 16, nonceBytes: 16, fingerprintBytes: 32, windowMs: 120000, maxInvalidProofs: 5, qrMaxChars: 300, qrMaxHosts: 4, comparisonCodeChars: 6, commitBytes: 32, codeNonceBytes: 16 })
  })

  it('writes every proof input with the size the specification gives it', () => {
    for (const c of pairing.proof) {
      expect(c.secret, c.name).toMatch(HEX(16))
      expect(c.fpMac, c.name).toMatch(HEX(32))
      expect(c.fpPhone, c.name).toMatch(HEX(32))
      expect(c.nonceMac, c.name).toMatch(HEX(16))
      expect(c.noncePhone, c.name).toMatch(HEX(16))
      expect(c.idMac, c.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(c.idPhone, c.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(c.requestTag, c.name).toMatch(B64U(43))
      expect(c.acceptTag, c.name).toMatch(B64U(43))
    }
  })

  it('gives each vector a name, once', () => {
    const names = [...pairing.proof, ...pairing.qr.valid, ...pairing.qr.invalid, ...pairing.secretLifecycle, ...pairing.clientChecks].map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.length).toBeGreaterThan(5)
  })
})

describe('iOS contract: sync pairing proofs (docs/synchronisation.md §4.4)', () => {
  it.each(pairing.proof)('recomputes the proofs of: $name', (c) => {
    expect(proofsOf(inputsOf(c))).toEqual({ requestTag: c.requestTag, acceptTag: c.acceptTag })
  })

  it('the two proofs of one exchange differ: a request cannot stand for an accept', () => {
    for (const c of pairing.proof) expect(c.requestTag).not.toBe(c.acceptTag)
  })

  it.each(pairing.mutations.cases)('changing $field changes the proofs it takes part in', (m) => {
    const reference = pairing.proof.find((c) => c.name === pairing.mutations.of)
    expect(reference).toBeDefined()
    const changed = { ...(reference as ProofInputs), [m.field]: m.value ?? m.valueHex }
    const recomputed = proofsOf(inputsOf(changed))
    expect(recomputed).toEqual({ requestTag: m.requestTag, acceptTag: m.acceptTag })
    expect(m.requestTag !== (reference as ProofInputs).requestTag).toBe(m.changesRequestTag)
    expect(m.acceptTag !== (reference as ProofInputs).acceptTag).toBe(m.changesAcceptTag)
    // Both fingerprints, both nonces and the secret are in both proofs; each device id only in the proof that names it (the phone's id in both, the Mac's in the accept only).
    if (m.field === 'idMac') expect(m.changesRequestTag).toBe(false)
    else expect(m.changesRequestTag).toBe(true)
    expect(m.changesAcceptTag).toBe(true)
  })
})

// The local-address filter (§6.2), the QR text (§4.2) and the typed code (§4.3).
const LOCAL = new BlockList()
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]] as const) LOCAL.addSubnet(net, bits, 'ipv4')
LOCAL.addSubnet('fc00::', 7, 'ipv6')
LOCAL.addSubnet('fe80::', 10, 'ipv6')
const LOCAL_NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+local$/

function isLocalAddress(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false
  if (isIPv4(host)) return LOCAL.check(host, 'ipv4')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)
  if (mapped?.[1] !== undefined) return isIPv4(mapped[1]) && LOCAL.check(mapped[1], 'ipv4')
  if (isIPv6(host) && !host.includes('%')) return LOCAL.check(host, 'ipv6')
  return LOCAL_NAME.test(host)
}

type QrResult = { ok: true; fingerprintHex: string; secretHex: string; port: number; hosts: string[] } | { ok: false; code: string }
function parseQr(text: string): QrResult {
  const invalid: QrResult = { ok: false, code: 'invalid-code' }
  if (text.length > pairing.constants.qrMaxChars) return invalid
  const head = /^lucium-sync:(\d+)\/([^]*)$/.exec(text)
  if (head?.[1] === undefined || head[2] === undefined) return invalid
  if (Number(head[1]) !== 1) return { ok: false, code: 'unsupported-version' }
  const parts = head[2].split('/')
  if (parts.length !== 4) return invalid
  const [fp, secret, port, hosts] = parts as [string, string, string, string]
  const canonical = (value: string, chars: number): Buffer | null => {
    if (!B64U(chars).test(value)) return null
    const bytes = Buffer.from(value, 'base64url')
    return bytes.toString('base64url') === value ? bytes : null
  }
  const fingerprint = canonical(fp, 43)
  const secretBytes = canonical(secret, 22)
  if (fingerprint === null || secretBytes === null) return invalid
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return invalid
  const list = hosts.split(',')
  if (list.length < 1 || list.length > pairing.constants.qrMaxHosts) return invalid
  if (!list.every((host) => host === host.toLowerCase() && isLocalAddress(host))) return invalid
  return { ok: true, fingerprintHex: fingerprint.toString('hex'), secretHex: secretBytes.toString('hex'), port: Number(port), hosts: list }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function parseManualCode(input: string): { ok: true; secretHex: string } | { ok: false; code: string } {
  const text = input.replace(/[\s-]+/g, '').toUpperCase()
  if (!/^[A-Z2-7]{26}$/.test(text)) return { ok: false, code: 'invalid-code' }
  const bits = [...text].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('')
  if (!/^0+$/.test(bits.slice(128))) return { ok: false, code: 'invalid-code' }
  const bytes = bits.slice(0, 128).match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []
  return { ok: true, secretHex: Buffer.from(bytes).toString('hex') }
}

describe('iOS contract: the commitment and the code to compare at a pairing (docs/synchronisation.md §4.6, §4.7)', () => {
  // The reference readers, written here from the text of the specification (the label, each field after its length, SHA-256): the real code of the Mac and LuciumKit play
  // the same vectors. The commitment is the whole digest in base64url; the code is the first 30 bits as six characters of the alphabet of the typed code.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const comparisonOf = (fpMac: Buffer, fpPhone: Buffer, nonceMac: Buffer, noncePhone: Buffer): string => {
    const digest = sha256(transcription('lucium-sync/1 pair-code', [fpMac, fpPhone, nonceMac, noncePhone]))
    const bits = [...digest.subarray(0, 4)].map((byte) => byte.toString(2).padStart(8, '0')).join('')
    return Array.from({ length: 6 }, (_, at) => ALPHABET[Number.parseInt(bits.slice(at * 5, at * 5 + 5), 2)]).join('')
  }
  const commitmentOf = (fpPhone: Buffer, noncePhone: Buffer): string => sha256(transcription('lucium-sync/1 pair-commit', [fpPhone, noncePhone])).toString('base64url')

  it.each(pairing.commitments)('commitment: $name', ({ fpPhone, nonceCodePhone, commit }) => {
    expect(fpPhone).toMatch(HEX(32))
    expect(nonceCodePhone).toMatch(HEX(16))
    expect(commit).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(commitmentOf(fromHex(fpPhone), fromHex(nonceCodePhone))).toBe(commit)
  })

  it('has a different commitment for every one of its inputs: one bit of the fingerprint or of the nonce changes it', () => {
    const [reference, ...others] = pairing.commitments
    expect(others.length).toBeGreaterThanOrEqual(3)
    for (const other of others) expect(other.commit, other.name).not.toBe(reference?.commit)
  })

  it.each(pairing.comparisonCode)('code: $name', ({ fpMac, fpPhone, nonceCodeMac, nonceCodePhone, code }) => {
    expect(fpMac).toMatch(HEX(32))
    expect(fpPhone).toMatch(HEX(32))
    expect(nonceCodeMac).toMatch(HEX(16))
    expect(nonceCodePhone).toMatch(HEX(16))
    expect(code).toMatch(/^[A-Z2-7]{6}$/)
    expect(comparisonOf(fromHex(fpMac), fromHex(fpPhone), fromHex(nonceCodeMac), fromHex(nonceCodePhone))).toBe(code)
  })

  it('depends on each of the four inputs and on which side each one belongs to: the vectors that change one input give another code', () => {
    const [reference, ...others] = pairing.comparisonCode
    expect(others.length).toBeGreaterThanOrEqual(6)
    for (const other of others) expect(other.code, other.name).not.toBe(reference?.code)
  })
})

describe('iOS contract: sync local addresses (docs/synchronisation.md §6.2)', () => {
  it.each(pairing.addressPolicy.map((v) => [JSON.stringify(v.host), v] as const))('isLocalAddress(%s)', (_label, v) => {
    expect(isLocalAddress(v.host)).toBe(v.allowed)
  })

  it('has both answers for each family, so that a filter that says always yes (or always no) fails', () => {
    for (const family of [(h: string) => isIPv4(h), (h: string) => isIPv6(h), (h: string) => h.endsWith('.local')]) {
      const group = pairing.addressPolicy.filter((v) => family(v.host))
      expect(group.some((v) => v.allowed)).toBe(true)
      expect(group.some((v) => !v.allowed)).toBe(true)
    }
  })
})

describe('iOS contract: sync QR text and typed code (docs/synchronisation.md §4.2, §4.3)', () => {
  it.each(pairing.qr.valid)('reads: $name', ({ text, expect: expected }) => {
    expect(parseQr(text)).toEqual({ ok: true, ...expected })
  })

  it.each(pairing.qr.invalid)('refuses: $name', ({ text, expect: expected }) => {
    expect(parseQr(text)).toEqual({ ok: false, code: expected.code })
  })

  it('every valid text stays within the length the specification gives', () => {
    for (const v of pairing.qr.valid) expect(v.text.length).toBeLessThanOrEqual(pairing.constants.qrMaxChars)
  })

  it.each(pairing.manualCode.valid)('reads the typed code: $name', ({ input, expect: expected }) => {
    expect(parseManualCode(input)).toEqual({ ok: true, ...expected })
  })

  it.each(pairing.manualCode.invalid)('refuses the typed code: $name', ({ input, expect: expected }) => {
    expect(parseManualCode(input)).toEqual({ ok: false, code: expected.code })
  })

  it('the QR and the typed code carry the same secret', () => {
    const secret = pairing.qr.valid[0]?.expect.secretHex
    expect(pairing.manualCode.valid.every((v) => v.expect.secretHex === secret)).toBe(true)
  })
})

/** docs/synchronisation.md §4.5: the order of the checks is closed, locked, expired, used, then the proof. */
function playSecret(events: PairingVectors['secretLifecycle'][number]['events']): string[] {
  let state: 'open' | 'used' | 'locked' | 'closed' = 'open'
  let invalid = 0
  const answers: string[] = []
  for (const e of events) {
    if (e.event === 'close') { state = 'closed'; continue }
    if (e.event === 'confirm') continue
    if (state === 'closed') answers.push('pairing-closed')
    else if (state === 'locked') answers.push('pairing-locked')
    else if (e.atMs >= pairing.constants.windowMs) answers.push('pairing-expired')
    else if (state === 'used') answers.push('pairing-used')
    else if (e.proof === 'valid') { state = 'used'; answers.push('accepted') }
    else {
      invalid++
      answers.push('bad-proof')
      if (invalid >= pairing.constants.maxInvalidProofs) state = 'locked'
    }
  }
  return answers
}

describe('iOS contract: life of the pairing secret (docs/synchronisation.md §4.5)', () => {
  it.each(pairing.secretLifecycle)('$name', ({ events, expect: expected }) => {
    expect(playSecret(events)).toEqual(expected)
    // Time only goes forward inside one vector.
    expect(events.map((e) => e.atMs)).toEqual([...events.map((e) => e.atMs)].sort((a, b) => a - b))
  })

  it('covers every answer the Mac can give', () => {
    const answers = new Set(pairing.secretLifecycle.flatMap((c) => c.expect))
    for (const answer of ['accepted', 'bad-proof', 'pairing-expired', 'pairing-used', 'pairing-locked', 'pairing-closed']) expect(answers.has(answer), answer).toBe(true)
  })

  it.each(pairing.clientChecks)('what the phone checks before it sends anything: $name', (c) => {
    const decision = c.expectedFingerprintHex === null ? 'continue-unpinned' : c.expectedFingerprintHex === c.presentedFingerprintHex ? 'continue' : 'fingerprint-mismatch'
    expect(decision).toBe(c.expect)
    expect(c.presentedFingerprintHex).toMatch(HEX(32))
  })
})

// The certificate (§6.3): the bytes to sign are the same on both sides, and Node reads the result.
const derLength = (n: number): Buffer => {
  if (n < 128) return Buffer.from([n])
  const bytes: number[] = []
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 255)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}
const oid = (hex: string): Buffer => der(0x06, fromHex(hex))
const ALGORITHM = der(0x30, oid('2a8648ce3d040302')) // ecdsa-with-SHA256, no parameters
const NAME = der(0x30, der(0x31, der(0x30, oid('550403'), der(0x0c, Buffer.from('lucium-sync')))))
const VALIDITY = der(0x30, der(0x17, Buffer.from('700101000000Z')), der(0x18, Buffer.from('99991231235959Z')))
const toBeSigned = (spki: Buffer, serial: Buffer): Buffer => der(0x30, fromHex('a003020102'), der(0x02, serial), ALGORITHM, NAME, VALIDITY, NAME, spki)

describe('iOS contract: sync certificate profile (docs/synchronisation.md §6.3)', () => {
  const c = pairing.certificate

  it('builds the bytes to sign the vector gives, from the key and the serial alone', () => {
    expect(toBeSigned(fromHex(c.spkiHex), fromHex(c.serialHex)).toString('hex')).toBe(c.tbsHex)
  })

  it('has a serial that is a positive, minimal DER integer of 16 bytes', () => {
    const serial = fromHex(c.serialHex)
    expect(serial.length).toBe(16)
    expect(serial[0]).toBeGreaterThanOrEqual(0x01)
    expect(serial[0]).toBeLessThan(0x80)
  })

  it('has a sample that Node reads: the name, the dates, the key and its own signature', () => {
    const certificate = new X509Certificate(fromHex(c.certificateDerHex))
    expect(certificate.subject).toBe('CN=lucium-sync')
    expect(certificate.issuer).toBe('CN=lucium-sync')
    expect(certificate.validFrom).toMatch(/1970/)
    expect(certificate.validTo).toMatch(/9999/)
    expect(certificate.publicKey.export({ type: 'spki', format: 'der' }).toString('hex')).toBe(c.spkiHex)
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.ca).toBe(false)
    expect(fromHex(c.certificateDerHex).includes(fromHex(c.tbsHex))).toBe(true)
  })

  it('the fingerprint is the SHA-256 of the DER, the same figure Node calls fingerprint256', () => {
    const der = fromHex(c.certificateDerHex)
    expect(sha256(der).toString('hex')).toBe(c.fingerprintHex)
    expect(new X509Certificate(der).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(c.fingerprintHex)
  })

  it('a certificate built on this profile for a new key is read by Node too', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const serial = Buffer.from('017f3a5c8e1d2b4f6a90c3d5e7f10243', 'hex')
    const tbs = toBeSigned(publicKey.export({ type: 'spki', format: 'der' }), serial)
    const certificate = der(0x30, tbs, ALGORITHM, der(0x03, Buffer.from([0]), sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })))
    const parsed = new X509Certificate(certificate)
    expect(parsed.verify(createPublicKey(createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })))) ).toBe(true)
    expect(parsed.subject).toBe('CN=lucium-sync')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface MessageVector { name: string; message?: Record<string, unknown>; raw?: string; fill?: { path: (string | number)[]; repeat?: string; copy?: unknown; times: number }; expect: Verdict }
interface MessageVectors {
  limits: Record<string, number>
  frames: { length: number; expect: Verdict }[]
  snapshotBytes: { total: number; expect: Verdict }[]
  sequences: { name: string; ns: number[]; expect: Verdict }[]
  messages: MessageVector[]
  transitions: { name: string; receiver: 'mac' | 'ios'; phase: 'session' | 'pairing'; history: string[]; type: string; expect: Verdict }[]
  stamps: { a: string; b: string; expect: -1 | 0 | 1 }[]
  canonical: { name: string; value: unknown; canonical: string; sha256Hex: string }[]
  fieldClasses: Record<string, { synced: string[]; seed: string[]; local: string[] }>
  searchEngines: string[]
  settingsAllowed: string[]
  settingsNever: string[]
  neverKinds: string[]
  inboundTombstones: { name: string; tombstones: Record<string, Record<string, string>>; expect: { kept: Record<string, Record<string, string>>; refused: string[] } }[]
  inbound: { name: string; entity?: { kind: string; id: string; fields: Record<string, unknown>; stamps: Record<string, string> }; entityRaw?: string; expect: { accepted: boolean; reason?: string; fields?: Record<string, unknown> } }[]
}
const messageVectors = read<MessageVectors>('sync-message-vectors.json')
const L = messageVectors.limits

const ERROR_CODES = ['bad-frame', 'too-large', 'bad-message', 'unknown-type', 'bad-sequence', 'unsupported-version', 'invalid-code', 'not-paired', 'fingerprint-mismatch', 'bad-proof', 'pairing-expired', 'pairing-used', 'pairing-locked', 'pairing-closed', 'pairing-refused', 'rate-limited', 'timeout', 'busy', 'locked', 'state-too-new', 'truncated', 'divergence', 'clock-skew', 'internal']
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min
const isText = (v: unknown, maxBytes = L['maxStringBytes'] as number): v is string => typeof v === 'string' && Buffer.byteLength(v) <= maxBytes
const textList = (v: unknown, max: number, maxChars = 64): boolean => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= maxChars)

/** A UTF-16 unit that is half of a pair and has no other half: not text, and Swift cannot read it (review n° 15). */
const hasLoneSurrogate = (text: string): boolean => {
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      at++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

/**
 * Whether an object of a JSON text (valid: it parses) names a key twice, however each is written: the first wins in Swift and the last in JavaScript (review n° 20). A small
 * recursive reader of the grammar written for this test, so that the rule is the text's and not the Mac's scanner's.
 */
function namesAKeyTwice(text: string): boolean {
  let at = 0
  let duplicate = false
  const skip = (): void => { while (' \t\n\r'.includes(text[at] ?? 'x')) at++ }
  const string = (): string => {
    const start = at
    at++
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    at++
    return JSON.parse(text.slice(start, at)) as string
  }
  const value = (): void => {
    skip()
    const c = text[at]
    if (c === '"') string()
    else if (c === '{') {
      at++
      const seen = new Set<string>()
      skip()
      if (text[at] === '}') { at++; return }
      for (;;) {
        skip()
        const key = string()
        if (seen.has(key)) duplicate = true
        seen.add(key)
        skip()
        at++ // the colon
        value()
        skip()
        if (text[at++] === '}') return
      }
    } else if (c === '[') {
      at++
      skip()
      if (text[at] === ']') { at++; return }
      for (;;) {
        value()
        skip()
        if (text[at++] === ']') return
      }
    } else while (at < text.length && !',]} \t\n\r'.includes(text[at] as string)) at++
  }
  value()
  return duplicate
}

/** docs/synchronisation.md §7.1: what a hostile message may not be, wherever it is. */
function valueProblem(value: unknown, depth: number): boolean {
  if (typeof value === 'string') return Buffer.byteLength(value) > (L['maxStringBytes'] as number) || hasLoneSurrogate(value)
  if (typeof value === 'number') return !Number.isFinite(value) || Math.abs(value) >= 1e21 || (value !== 0 && Math.abs(value) < 1e-6)
  if (typeof value !== 'object' || value === null) return false
  if (depth > (L['maxJsonDepth'] as number)) return true
  if (Array.isArray(value)) return value.some((item) => valueProblem(item, depth + 1))
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return true
  return Object.entries(value).some(([key, item]) => hasLoneSurrogate(key) || valueProblem(item, depth + 1))
}

const device = (d: unknown): boolean =>
  isObject(d) && typeof d['id'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d['id']) && typeof d['name'] === 'string' && d['name'].length > 0 && [...d['name']].length <= (L['maxDeviceNameChars'] as number) && (d['platform'] === 'mac' || d['platform'] === 'ios')
const entity = (e: unknown): boolean =>
  isObject(e) && typeof e['kind'] === 'string' && e['kind'].length > 0 && e['kind'].length <= 64 && typeof e['id'] === 'string' && e['id'].length > 0 && e['id'].length <= 128 && isObject(e['fields']) && isObject(e['stamps']) && Object.values(e['stamps']).every((s) => typeof s === 'string')
const optionalList = (v: unknown, max: number): boolean => v === undefined || textList(v, max, 128)
/** A TCP port: a whole number from 1 to 65535 (docs/synchronisation.md §7.3, review n° 38). */
const isPort = (v: unknown): boolean => isInt(v, 1) && (v as number) <= 65535

const SHAPES: Record<string, (m: Record<string, unknown>) => boolean> = {
  hello: (m) => device(m['device']) && typeof m['nonce'] === 'string' && B64U(22).test(m['nonce']) && textList(m['categories'], L['maxCategories'] as number, 32) && (m['baseHash'] === null || (typeof m['baseHash'] === 'string' && HEX(32).test(m['baseHash']))) && isInt(m['stateVersion'], 1) && isText(m['appVersion'], 32) && isInt(m['now']) && (m['hosts'] === undefined || textList(m['hosts'], L['maxHosts'] as number, 253)) && (m['port'] === undefined || isPort(m['port'])),
  'pair.challenge': (m) => typeof m['nonce'] === 'string' && B64U(22).test(m['nonce']),
  'pair.request': (m) => device(m['device']) && typeof m['nonce'] === 'string' && B64U(22).test(m['nonce']) && typeof m['proof'] === 'string' && B64U(43).test(m['proof']) && typeof m['commit'] === 'string' && B64U(43).test(m['commit']),
  'pair.nonce': (m) => typeof m['nonce'] === 'string' && B64U(22).test(m['nonce']),
  'pair.reveal': (m) => typeof m['nonce'] === 'string' && B64U(22).test(m['nonce']),
  'pair.accept': (m) => device(m['device']) && typeof m['proof'] === 'string' && B64U(43).test(m['proof']) && textList(m['hosts'], L['maxHosts'] as number, 253) && isPort(m['port']),
  'snapshot.part': (m) => isInt(m['part']) && isInt(m['parts'], 1) && (m['parts'] as number) <= (L['maxParts'] as number) && (m['part'] as number) < (m['parts'] as number) && Array.isArray(m['entities']) && m['entities'].length <= (L['maxEntitiesPerPart'] as number) && m['entities'].every(entity) && (m['tombstones'] === undefined || (Array.isArray(m['tombstones']) && m['tombstones'].every((t) => isObject(t) && typeof t['kind'] === 'string' && typeof t['id'] === 'string' && typeof t['stamp'] === 'string'))) && (m['order'] === undefined || (isObject(m['order']) && Object.values(m['order']).every((l) => textList(l, 100000, 128)))) && (m['orderStamps'] === undefined || (isObject(m['orderStamps']) && Object.values(m['orderStamps']).every((s) => typeof s === 'string'))) && optionalList(m['withheld'], 10000),
  'snapshot.end': (m) => isInt(m['entityCount']) && typeof m['digest'] === 'string' && HEX(32).test(m['digest']),
  'open-tabs': (m) => Array.isArray(m['items']) && m['items'].length <= (L['maxOpenTabs'] as number) && m['items'].every((t) => isObject(t) && typeof t['id'] === 'string' && typeof t['spaceId'] === 'string' && isText(t['url'], L['maxOpenTabUrlBytes'] as number) && isText(t['title'], L['maxOpenTabTitleBytes'] as number) && isInt(t['lastActiveAt'])),
  result: (m) => typeof m['digest'] === 'string' && HEX(32).test(m['digest']),
  commit: (m) => typeof m['digest'] === 'string' && HEX(32).test(m['digest']),
  unpair: () => true,
  bye: () => true,
  error: (m) => typeof m['code'] === 'string' && ERROR_CODES.includes(m['code']) && typeof m['fatal'] === 'boolean' && (m['supported'] === undefined || (Array.isArray(m['supported']) && m['supported'].every((v) => isInt(v)))) && (m['detail'] === undefined || isText(m['detail'], 200))
}

function validateMessage(raw: string): Verdict {
  const bad: Verdict = { ok: false, code: 'bad-message' }
  let message: unknown
  try { message = JSON.parse(raw) } catch { return bad }
  if (!isObject(message) || namesAKeyTwice(raw) || valueProblem(message, 1)) return bad
  if (!isInt(message['n'], 1) || typeof message['t'] !== 'string' || !Number.isInteger(message['v'])) return bad
  if (message['v'] !== 1) return { ok: false, code: 'unsupported-version' }
  const shape = SHAPES[message['t']]
  if (shape === undefined) return { ok: false, code: 'unknown-type' }
  return shape(message) ? { ok: true } : bad
}

/** The sequence rule of §7.1: from 1, one more each time. */
function validateSequence(ns: number[]): Verdict {
  for (const [i, n] of ns.entries()) if (n !== i + 1) return { ok: false, code: 'bad-sequence', at: i }
  return { ok: true }
}

/** §7.4: which type may come after the ones already received. */
function validateTransition(receiver: 'mac' | 'ios', phase: 'session' | 'pairing', history: string[], type: string): Verdict {
  const bad: Verdict = { ok: false, code: 'bad-message' }
  if (type === 'error' || type === 'bye') return { ok: true }
  const seen = (t: string): boolean => history.includes(t)
  if (phase === 'pairing') {
    if (receiver === 'mac') return (type === 'pair.request' && !seen('pair.request')) || (type === 'pair.reveal' && seen('pair.request') && !seen('pair.reveal')) ? { ok: true } : bad
    if (history.length === 0) return type === 'pair.challenge' ? { ok: true } : bad
    if (history.length === 1) return history[0] === 'pair.challenge' && type === 'pair.nonce' ? { ok: true } : bad
    return history.length === 2 && history[1] === 'pair.nonce' && type === 'pair.accept' ? { ok: true } : bad
  }
  const allowed = ((): boolean => {
    switch (type) {
      case 'hello': return !seen('hello')
      case 'snapshot.part': return seen('hello') && !seen('snapshot.end')
      case 'open-tabs': return seen('hello') && !seen('snapshot.end')
      case 'snapshot.end': return seen('snapshot.part') && !seen('snapshot.end')
      case 'result': return seen('snapshot.end') && !seen('result')
      case 'commit': return seen('result') && !seen('commit')
      case 'unpair': return seen('hello')
      default: return false
    }
  })()
  return allowed ? { ok: true } : bad
}

function validateFrameLength(length: number): Verdict {
  if (length === 0) return { ok: false, code: 'bad-frame' }
  return length > (L['maxFrameBytes'] as number) ? { ok: false, code: 'too-large' } : { ok: true }
}

function applyFill(message: Record<string, unknown>, fill: NonNullable<MessageVector['fill']>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(message)) as Record<string, unknown>
  let holder: unknown = copy
  for (const key of fill.path.slice(0, -1)) holder = (holder as Record<string | number, unknown>)[key]
  const last = fill.path[fill.path.length - 1] as string | number
  ;(holder as Record<string | number, unknown>)[last] = fill.repeat !== undefined ? fill.repeat.repeat(fill.times) : Array.from({ length: fill.times }, () => JSON.parse(JSON.stringify(fill.copy)) as unknown)
  return copy
}
const textOf = (v: MessageVector): string => (v.raw !== undefined ? v.raw : JSON.stringify(v.fill !== undefined ? applyFill(v.message as Record<string, unknown>, v.fill) : v.message))

describe('iOS contract: sync message vectors, form', () => {
  it('has vectors to run', () => {
    expect(messageVectors.frames.length).toBeGreaterThanOrEqual(5)
    expect(messageVectors.sequences.length).toBeGreaterThanOrEqual(5)
    expect(messageVectors.messages.length).toBeGreaterThanOrEqual(60)
    expect(messageVectors.transitions.length).toBeGreaterThanOrEqual(20)
    expect(messageVectors.stamps.length).toBeGreaterThanOrEqual(10)
    expect(messageVectors.canonical.length).toBeGreaterThanOrEqual(10)
    expect(messageVectors.inbound.length).toBeGreaterThanOrEqual(20)
  })

  it('writes the limits of the specification (§7.5)', () => {
    expect(L).toMatchObject({ maxFrameBytes: 1048576, maxSnapshotBytes: 33554432, maxEntities: 100000, maxEntitiesPerPart: 500, maxParts: 4096, maxJsonDepth: 32, maxStringBytes: 65536, maxDeviceNameChars: 80, maxDeviceIdChars: 64, maxOpenTabs: 200, handshakeTimeoutMs: 10000, idleTimeoutMs: 60000, sessionMaxMs: 600000, maxConnections: 4, minAutoIntervalMs: 15000, tombstoneDays: 30, archivePerSpace: 500 })
    for (const [name, value] of Object.entries(L)) expect(Number.isInteger(value) && value > 0, name).toBe(true)
  })

  it('gives each message a body: an object, or a text, never both nor neither', () => {
    for (const v of messageVectors.messages) expect((v.message === undefined) !== (v.raw === undefined), v.name).toBe(true)
  })

  it('names each vector once', () => {
    const names = [...messageVectors.messages, ...messageVectors.sequences, ...messageVectors.transitions, ...messageVectors.canonical, ...messageVectors.inbound].map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('only refuses with a code of the catalogue (§7.6)', () => {
    const codes = [...messageVectors.frames, ...messageVectors.snapshotBytes, ...messageVectors.sequences, ...messageVectors.messages, ...messageVectors.transitions].flatMap((v) => (v.expect.ok ? [] : [v.expect.code]))
    for (const code of codes) expect(ERROR_CODES.includes(code), code).toBe(true)
  })

  it('covers every type the specification lists, valid at least once (§7.3)', () => {
    const valid = new Set(messageVectors.messages.filter((v) => v.expect.ok).map((v) => (v.message?.['t'] as string | undefined) ?? ''))
    for (const type of Object.keys(SHAPES)) expect(valid.has(type), type).toBe(true)
  })
})

describe('iOS contract: sync frames, messages and order (docs/synchronisation.md §7)', () => {
  it.each(messageVectors.frames.map((v) => [v.length, v] as const))('a frame announced at %d bytes', (_label, v) => {
    expect(validateFrameLength(v.length)).toEqual(v.expect)
  })

  it.each(messageVectors.snapshotBytes.map((v) => [v.total, v] as const))('a snapshot of %d bytes in all', (_label, v) => {
    expect(v.total > (L['maxSnapshotBytes'] as number) ? { ok: false, code: 'too-large' } : { ok: true }).toEqual(v.expect)
  })

  it.each(messageVectors.sequences)('numbers: $name', (v) => {
    expect(validateSequence(v.ns)).toEqual(v.expect)
  })

  it.each(messageVectors.messages)('$name', (v) => {
    expect(validateMessage(textOf(v))).toEqual(v.expect)
  })

  it.each(messageVectors.transitions)('order: $name', (v) => {
    expect(validateTransition(v.receiver, v.phase, v.history, v.type)).toEqual(v.expect)
  })

  it('a refused text stays refused for the reason the vector gives, not for a side effect of its size', () => {
    // A vector that is refused only because it is too long for a frame would hide a missing guard: every refused message fits in a frame.
    for (const v of messageVectors.messages) expect(Buffer.byteLength(textOf(v)), v.name).toBeLessThanOrEqual(L['maxFrameBytes'] as number)
  })
})

// The marks (§9.2) and the canonical form (§8.4).
const STAMP = /^(0|[0-9]{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64})$/
const compareStamps = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)
/** RFC 8785 for the values the specification allows: JSON.stringify for strings and numbers, keys sorted by UTF-16 code unit (the default sort). */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

describe('iOS contract: sync marks and canonical form (docs/synchronisation.md §8.4, §9.2)', () => {
  it.each(messageVectors.stamps.map((v) => [`${v.a} ? ${v.b}`, v] as const))('compares %s', (_label, v) => {
    expect(v.a).toMatch(STAMP)
    expect(v.b).toMatch(STAMP)
    expect(compareStamps(v.a, v.b)).toBe(v.expect)
    expect(compareStamps(v.b, v.a)).toBe(-v.expect === 0 ? 0 : (-v.expect as -1 | 1))
  })

  it.each(messageVectors.canonical)('canonical form: $name', (v) => {
    expect(canonicalize(v.value)).toBe(v.canonical)
    expect(sha256(v.canonical).toString('hex')).toBe(v.sha256Hex)
  })

  it('keeps the case that tells UTF-16 order from UTF-8 order: the non-BMP key sorts first', () => {
    const c = messageVectors.canonical.find((v) => v.name.includes('UTF-16'))
    expect(c?.canonical.startsWith('{"😀"')).toBe(true)
  })
})

// The classes of the fields (§10.2) are read against the model of the Mac: a field the Mac renames or adds without a decision makes this fail.
const modelSource = readFileSync(join(__dirname, 'model.ts'), 'utf8')
function membersOf(name: string): string[] {
  const start = modelSource.indexOf(`export interface ${name} {`)
  expect(start, `interface ${name}`).toBeGreaterThan(-1)
  const end = modelSource.indexOf('\n}', start)
  return [...modelSource.slice(start, end).matchAll(/^ {2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1] as string)
}
const MODEL_OF: Record<string, string> = { space: 'Space', folder: 'Folder', tab: 'TabItem', favorite: 'Favorite', archived: 'ArchivedTab' }

describe('iOS contract: classes of the fields (docs/synchronisation.md §10.2)', () => {
  it.each(Object.entries(MODEL_OF))('every field of %s in model.ts has one class, and only one', (kind, modelName) => {
    const classes = messageVectors.fieldClasses[kind]
    expect(classes, kind).toBeDefined()
    const classified = [...(classes?.synced ?? []), ...(classes?.seed ?? []), ...(classes?.local ?? [])]
    expect(new Set(classified).size, 'a field in two classes').toBe(classified.length)
    expect([...classified].sort()).toEqual([...membersOf(modelName)].sort())
  })

  it('names no kind without a model', () => {
    expect(Object.keys(messageVectors.fieldClasses).sort()).toEqual(Object.keys(MODEL_OF).sort())
  })

  it('keeps the identity, the container and the address of what it synchronises in the synchronised class', () => {
    for (const kind of Object.keys(MODEL_OF)) expect(messageVectors.fieldClasses[kind]?.synced).toContain('id')
    expect(messageVectors.fieldClasses['tab']?.synced).toEqual(expect.arrayContaining(['spaceId', 'anchorUrl', 'folderId']))
    expect(messageVectors.fieldClasses['tab']?.local).toEqual(expect.arrayContaining(['private', 'lastActiveAt', 'faviconUrl']))
    expect(messageVectors.fieldClasses['space']?.local).toEqual(expect.arrayContaining(['image', 'background', 'webPanels']))
  })
})

describe('iOS contract: the closed list of settings (docs/synchronisation.md §10.3)', () => {
  const keys = new Set(Object.keys(defaultSettings()))

  it('lists only settings that exist, each once', () => {
    expect(new Set(messageVectors.settingsAllowed).size).toBe(messageVectors.settingsAllowed.length)
    for (const key of messageVectors.settingsAllowed) expect(keys.has(key), key).toBe(true)
  })

  it('never lists a setting of the other list', () => {
    for (const key of messageVectors.settingsNever) expect(keys.has(key), key).toBe(true)
    for (const key of messageVectors.settingsAllowed) expect(messageVectors.settingsNever.includes(key), key).toBe(false)
  })

  it('keeps every lock setting out (a file must never switch a lock on or off)', () => {
    for (const key of LOCK_SETTING_KEYS) expect(messageVectors.settingsNever, key).toContain(key)
    for (const key of LOCK_SETTING_KEYS) expect(messageVectors.settingsAllowed.includes(key), key).toBe(false)
  })

  it('keeps out what sets where the traffic and the updates go', () => {
    for (const key of ['updateFeedUrl', 'proxy', 'dohCustomUrl', 'customFilterLists', 'extensionPaths']) expect(messageVectors.settingsNever, key).toContain(key)
  })
})

/** §8.5 and §10: what a received entity may carry before it reaches the state. */
type Filtered = { accepted: true; fields: Record<string, unknown> } | { accepted: false; reason: string }
const isWebAddress = (v: unknown): boolean => typeof v === 'string' && /^https?:\/\//i.test(v) && URL.canParse(v)
const URL_FIELDS: Record<string, string[]> = { tab: ['url', 'anchorUrl'], favorite: ['url'], archived: ['url', 'anchorUrl'] }
function settingValueProblem(key: string, value: unknown): boolean {
  switch (key) {
    case 'httpsUpgrade': case 'sendGpc': case 'stripTrackingParams': case 'stripCopiedLinks': return typeof value !== 'boolean'
    case 'protectionBaseline': return value !== 'standard' && value !== 'renforcee'
    case 'autoArchiveHours': return typeof value !== 'number' || !Number.isFinite(value) || value < 0
    case 'searchUrlTemplate': return typeof value !== 'string' || !messageVectors.searchEngines.includes(value)
    case 'profileNames': return !isObject(value) || !Object.values(value).every((v) => typeof v === 'string')
    default: return true
  }
}
const holdsLoneSurrogate = (v: unknown): boolean => (typeof v === 'string' ? hasLoneSurrogate(v) : Array.isArray(v) ? v.some(holdsLoneSurrogate) : isObject(v) ? Object.entries(v).some(([k, m]) => hasLoneSurrogate(k) || holdsLoneSurrogate(m)) : false)
function filterEntity(e: NonNullable<MessageVectors['inbound'][number]['entity']>): Filtered {
  if (messageVectors.neverKinds.includes(e.kind)) return { accepted: false, reason: 'never-synced' }
  // Review n° 15 and 16: a text Swift cannot read, and a profile that is not an identifier of the Mac (the key of a list is made of it).
  if (holdsLoneSurrogate(e.fields)) return { accepted: false, reason: 'invalid-value' }
  if ((e.kind === 'space' || e.kind === 'favorite') && e.fields['profileId'] !== undefined && !(typeof e.fields['profileId'] === 'string' && /^(?!__proto__$)[A-Za-z0-9_-]{1,32}$/.test(e.fields['profileId']))) return { accepted: false, reason: 'invalid-value' }
  if (e.kind === 'setting') {
    if (!messageVectors.settingsAllowed.includes(e.id)) return { accepted: false, reason: 'not-synced' }
    return settingValueProblem(e.id, e.fields['value']) ? { accepted: false, reason: 'invalid-value' } : { accepted: true, fields: { value: e.fields['value'] } }
  }
  const classes = messageVectors.fieldClasses[e.kind]
  if (classes === undefined) return { accepted: true, fields: e.fields }
  if (e.kind === 'tab') {
    if (e.fields['private'] === true) return { accepted: false, reason: 'private' }
    if (e.fields['pinned'] !== true) return { accepted: false, reason: 'not-pinned' }
  }
  const fields = Object.fromEntries(Object.entries(e.fields).filter(([name]) => !classes.local.includes(name)))
  for (const name of URL_FIELDS[e.kind] ?? []) if (fields[name] !== undefined && !isWebAddress(fields[name])) return { accepted: false, reason: 'invalid-url' }
  return { accepted: true, fields }
}

describe('iOS contract: the tombstones that come in (docs/synchronisation.md §11.5, review n° 14)', () => {
  it.each(messageVectors.inboundTombstones)('$name', ({ tombstones, expect: expected }) => {
    const kept: Record<string, Record<string, string>> = {}
    const refused: string[] = []
    for (const [kind, byId] of Object.entries(tombstones)) {
      for (const [id, stamp] of Object.entries(byId)) {
        if (messageVectors.neverKinds.includes(kind)) refused.push(`${kind}/${id}`)
        else (kept[kind] ??= {})[id] = stamp
      }
    }
    expect(kept).toEqual(expected.kept)
    expect(refused.sort()).toEqual(expected.refused)
  })

  it('states the bound of a side: half of what a snapshot may hold, so that the union of two sides is readable', () => {
    expect((L['maxTombstonesPerSnapshot'] as number) * 2).toBeLessThanOrEqual(L['maxEntities'] as number)
  })
})

describe('iOS contract: what a received entity may carry (docs/synchronisation.md §8.5, §10)', () => {
  it.each(messageVectors.inbound)('$name', ({ entity: given, entityRaw, expect: expected }) => {
    const entity = given ?? (JSON.parse(entityRaw as string) as NonNullable<typeof given>)
    const result = filterEntity(entity)
    expect(result.accepted).toBe(expected.accepted)
    if (!result.accepted) expect(result.reason).toBe(expected.reason)
    if (result.accepted && expected.fields !== undefined) expect(result.fields).toEqual(expected.fields)
  })

  it('refuses every kind of code and every secret, by name', () => {
    for (const kind of ['boost', 'userScript', 'extension', 'password', 'vault', 'lock']) expect(messageVectors.neverKinds, kind).toContain(kind)
  })

  it('tries each refusal reason at least once, so that a missing guard has a vector to fail', () => {
    const reasons = new Set(messageVectors.inbound.flatMap((v) => (v.expect.accepted ? [] : [v.expect.reason])))
    for (const reason of ['never-synced', 'not-synced', 'invalid-value', 'not-pinned', 'private', 'invalid-url']) expect(reasons.has(reason as string), reason).toBe(true)
  })
})
