// The sealed export: round trip, a new salt and nonce every time, a tag that is checked, a cost a file cannot inflate, a passphrase that is
// never in the output. The cheapest cost a file may ask for is used throughout (N = 2^14), except in the one test of the default.

import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  ExportCryptoError,
  PASSPHRASE_MIN,
  SCRYPT_DEFAULT,
  SCRYPT_LIMITS,
  checkEnvelope,
  decryptExport,
  encryptExport,
  exportErrorMessage,
  isEncryptedExport,
  paddedLength,
  paramsAllowed,
  type ExportEnvelope,
  type ScryptParams
} from './export-crypto'

const CHEAP: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }
const PHRASE = 'correct horse battery staple'
const seal = (plain: string, phrase = PHRASE, random?: (n: number) => Buffer) => encryptExport(plain, phrase, { params: CHEAP, ...(random ? { random } : {}) })
const envelopeOf = (text: string): ExportEnvelope => JSON.parse(text) as ExportEnvelope
const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return error instanceof ExportCryptoError ? error.kind : `other: ${String(error)}`
  }
  return 'no error'
}
/** Flips one bit of the base64 field `get` reads, as a damaged file would. */
const withFlippedByte = (envelope: ExportEnvelope, field: 'data' | 'check', at: number): ExportEnvelope => {
  const bytes = Buffer.from(envelope[field], 'base64')
  bytes[at] = bytes[at]! ^ 1
  return { ...envelope, [field]: bytes.toString('base64') }
}

describe('sealed export: round trip', () => {
  it('gives back exactly what was sealed, accents and large content included', async () => {
    const plain = JSON.stringify({ spaces: ['Perso é ü ç', '日本語 🚀'], pad: 'x'.repeat(200_000) })
    const text = await seal(plain)
    expect(await decryptExport(JSON.parse(text), PHRASE)).toBe(plain)
  })

  it('writes a versioned envelope that says what it is, and one line of JSON', async () => {
    const text = await seal('{}')
    const envelope = envelopeOf(text)
    expect(envelope).toMatchObject({ format: EXPORT_FORMAT, version: EXPORT_VERSION, kdf: { name: 'scrypt', ...CHEAP }, cipher: { name: 'aes-256-gcm' } })
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(isEncryptedExport(envelope)).toBe(true)
    expect(isEncryptedExport({ version: 1, spaces: [] })).toBe(false)
    expect(isEncryptedExport(null)).toBe(false)
    expect(isEncryptedExport([envelope])).toBe(false)
  })

  it('seals with the default cost, which is within what a file may ask for (the one test that pays for it)', async () => {
    expect(paramsAllowed(SCRYPT_DEFAULT)).toBe(true)
    const text = await encryptExport('{"a":1}', PHRASE)
    expect(envelopeOf(text).kdf).toMatchObject({ N: 2 ** 17, r: 8, p: 1 })
    expect(await decryptExport(JSON.parse(text), PHRASE)).toBe('{"a":1}')
  })

  it('takes the same letters typed in another form (NFKC) for the same passphrase', async () => {
    const composed = 'café au lait chaud'
    const decomposed = 'café au lait chaud'
    const text = await seal('secret', composed)
    expect(await decryptExport(JSON.parse(text), decomposed)).toBe('secret')
  })
})

describe('sealed export: a new salt and a new nonce for every file', () => {
  it('never writes the same salt, nonce or content twice for the same passphrase and content', async () => {
    const a = envelopeOf(await seal('same content'))
    const b = envelopeOf(await seal('same content'))
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.cipher.nonce).not.toBe(b.cipher.nonce)
    expect(a.data).not.toBe(b.data)
  })

  it('uses a 12-byte nonce and a 16-byte salt, both from the random source (this fails if the nonce is a constant or reused)', async () => {
    const asked: number[] = []
    const random = vi.fn((n: number) => {
      asked.push(n)
      return randomBytes(n)
    })
    const first = envelopeOf(await seal('x', PHRASE, random))
    const second = envelopeOf(await seal('x', PHRASE, random))
    expect(asked).toEqual([16, 12, 16, 12])
    expect(Buffer.from(first.cipher.nonce, 'base64')).toHaveLength(12)
    expect(Buffer.from(first.kdf.salt, 'base64')).toHaveLength(16)
    expect(first.cipher.nonce).not.toBe(second.cipher.nonce)
  })

  it('shows what a reused nonce would cost: the same key stream, so two contents XOR to the XOR of the files (the test the nonce guard exists for)', async () => {
    const fixed = (n: number) => Buffer.alloc(n, 7)
    const one = Buffer.from(envelopeOf(await seal('AAAAAAAAAAAAAAAAAAAA', PHRASE, fixed)).data, 'base64')
    const two = Buffer.from(envelopeOf(await seal('BBBBBBBBBBBBBBBBBBBB', PHRASE, fixed)).data, 'base64')
    // Same salt and nonce: byte 4 + 0 of the frame is the first content byte, and the two ciphertexts differ there by exactly 'A' ^ 'B'.
    expect(one[4]! ^ two[4]!).toBe('A'.charCodeAt(0) ^ 'B'.charCodeAt(0))
  })
})

describe('sealed export: the file does not show the size or the content', () => {
  it('pads the content: contents of different lengths give files of the same size, and the padding is bounded', async () => {
    const sizes = await Promise.all(['{}', '{"a":1}', '{"a":"' + 'x'.repeat(3000) + '"}'].map(async (plain) => envelopeOf(await seal(plain)).data.length))
    expect(new Set(sizes).size).toBe(1)
    for (const n of [0, 1, 100, 4092, 4093, 5000, 100_000, 1_000_000, 70_000_000]) {
      const padded = paddedLength(n)
      expect(padded).toBeGreaterThanOrEqual(n)
      expect(padded).toBeLessThanOrEqual(Math.max(4096, n + Math.ceil(n / 8) + 4096))
      expect(padded % 4096).toBe(0)
    }
  })

  it('does not contain the passphrase, nor any word of the content, in clear', async () => {
    const text = await seal(JSON.stringify({ url: 'https://tres-secret.example/mon-compte', title: 'Banque privée' }))
    for (const word of [PHRASE, 'tres-secret', 'Banque', 'compte']) expect(text).not.toContain(word)
  })
})

describe('sealed export: a wrong passphrase, a damaged file', () => {
  it('says "wrong passphrase" for a wrong one, and for an empty one', async () => {
    const sealed = JSON.parse(await seal('content')) as unknown
    expect(await kindOf(() => decryptExport(sealed, 'another passphrase'))).toBe('wrong-passphrase')
    expect(await kindOf(() => decryptExport(sealed, ''))).toBe('wrong-passphrase')
    expect(exportErrorMessage(new ExportCryptoError('wrong-passphrase', ''))).toMatch(/phrase secrète est incorrecte/)
  })

  it('says "tampered" when one bit of the content changed, and never hands back a byte of it (this fails if the tag is not verified)', async () => {
    const envelope = envelopeOf(await seal('the content of the file'))
    for (const at of [0, 5, Buffer.from(envelope.data, 'base64').length - 1]) {
      expect(await kindOf(() => decryptExport(withFlippedByte(envelope, 'data', at), PHRASE))).toBe('tampered')
    }
    expect(exportErrorMessage(new ExportCryptoError('tampered', ''))).toMatch(/altéré/)
  })

  it('says "tampered" when the file is cut short', async () => {
    const envelope = envelopeOf(await seal('content'))
    const bytes = Buffer.from(envelope.data, 'base64')
    expect(await kindOf(() => decryptExport({ ...envelope, data: bytes.subarray(0, bytes.length - 3).toString('base64') }, PHRASE))).toBe('tampered')
  })

  it('refuses a header that was edited, whatever the passphrase: the salt, the nonce and the parameters are authenticated', async () => {
    const envelope = envelopeOf(await seal('content'))
    const salt = Buffer.from(envelope.kdf.salt, 'base64')
    salt[0] = salt[0]! ^ 1
    expect(await kindOf(() => decryptExport({ ...envelope, kdf: { ...envelope.kdf, salt: salt.toString('base64') } }, PHRASE))).toBe('wrong-passphrase')
    const nonce = Buffer.from(envelope.cipher.nonce, 'base64')
    nonce[0] = nonce[0]! ^ 1
    expect(await kindOf(() => decryptExport({ ...envelope, cipher: { ...envelope.cipher, nonce: nonce.toString('base64') } }, PHRASE))).toBe('wrong-passphrase')
    expect(await kindOf(() => decryptExport({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 15 } }, PHRASE))).toBe('wrong-passphrase')
    expect(await kindOf(() => decryptExport(withFlippedByte(envelope, 'check', 3), PHRASE))).toBe('wrong-passphrase')
  })

  it('refuses what is not a sealed export, a version it does not know, other algorithms', async () => {
    const envelope = envelopeOf(await seal('content'))
    expect(await kindOf(() => decryptExport({ version: 1, spaces: [] }, PHRASE))).toBe('not-an-export')
    expect(await kindOf(() => decryptExport('text', PHRASE))).toBe('not-an-export')
    expect(await kindOf(() => decryptExport({ ...envelope, version: 2 }, PHRASE))).toBe('unsupported')
    expect(await kindOf(() => decryptExport({ ...envelope, kdf: { ...envelope.kdf, name: 'pbkdf2' } }, PHRASE))).toBe('unsupported')
    expect(await kindOf(() => decryptExport({ ...envelope, cipher: { ...envelope.cipher, name: 'aes-128-cbc' } }, PHRASE))).toBe('unsupported')
  })

  it('refuses fields that are not exactly what they should be (lengths, characters, a base64 that Buffer would forgive)', async () => {
    const envelope = envelopeOf(await seal('content'))
    const bad: Array<[string, unknown]> = [
      ['salt too short', { ...envelope, kdf: { ...envelope.kdf, salt: Buffer.alloc(15).toString('base64') } }],
      ['nonce too long', { ...envelope, cipher: { ...envelope.cipher, nonce: Buffer.alloc(13).toString('base64') } }],
      ['check not base64', { ...envelope, check: '***' }],
      ['data with a stray character', { ...envelope, data: `${envelope.data.slice(0, 8)}!${envelope.data.slice(9)}` }],
      ['data with newlines Buffer would skip', { ...envelope, data: `${envelope.data.slice(0, 8)}\n${envelope.data.slice(8)}` }],
      ['data not a string', { ...envelope, data: 42 }],
      ['data too small to hold a tag', { ...envelope, data: Buffer.alloc(10).toString('base64') }]
    ]
    for (const [what, value] of bad) expect(await kindOf(() => decryptExport(value, PHRASE)), what).toBe('not-an-export')
    expect(await kindOf(() => decryptExport({ ...envelope, kdf: undefined }, PHRASE))).toBe('unsupported')
  })
})

describe('sealed export: a file cannot make the reader pay what it likes', () => {
  const asking = (envelope: ExportEnvelope, kdf: Partial<ExportEnvelope['kdf']>): ExportEnvelope => ({ ...envelope, kdf: { ...envelope.kdf, ...kdf } })

  it('refuses a cost above the limits before it derives anything (this fails if the bounds are removed: the derivation would run for seconds or fail with another error)', async () => {
    const envelope = envelopeOf(await seal('content'))
    const hostile: ExportEnvelope[] = [
      asking(envelope, { N: 2 ** 19 }),
      asking(envelope, { N: 2 ** 20 }),
      asking(envelope, { N: 2 ** 30 }),
      asking(envelope, { N: 2 ** 17, r: 16, p: 4 }),
      asking(envelope, { N: 2 ** 18, r: 16 }),
      asking(envelope, { N: 2 ** 17, r: 8, p: 8 }),
      asking(envelope, { N: 2 ** 14, r: 16, p: 16 }),
      asking(envelope, { r: 1_000_000 }),
      asking(envelope, { p: 1_000_000 })
    ]
    for (const file of hostile) {
      const started = Date.now()
      expect(await kindOf(() => decryptExport(file, PHRASE)), JSON.stringify(file.kdf)).toBe('too-costly')
      expect(Date.now() - started).toBeLessThan(500)
      expect(() => checkEnvelope(file)).toThrow(ExportCryptoError)
    }
  })

  it('refuses parameters that are not whole powers of two, or are weaker than a file of this application', async () => {
    const envelope = envelopeOf(await seal('content'))
    for (const kdf of [{ N: 3 }, { N: 2 ** 13 }, { N: 20_000 }, { N: 2 ** 14 + 1 }, { N: 1.5 }, { r: 0 }, { p: 0 }, { r: -8 }, { N: Number.NaN }, { N: '16384' as unknown as number }]) {
      expect(await kindOf(() => decryptExport(asking(envelope, kdf), PHRASE)), JSON.stringify(kdf)).toBe('too-costly')
    }
  })

  it('accepts the default and the largest cost that stays within the limits', () => {
    expect(paramsAllowed(SCRYPT_DEFAULT)).toBe(true)
    expect(paramsAllowed({ N: SCRYPT_LIMITS.maxN, r: 8, p: 1 })).toBe(true)
    expect(paramsAllowed({ N: 2 ** 14, r: 16, p: 4 })).toBe(true)
    expect(paramsAllowed({ N: SCRYPT_LIMITS.maxN, r: 8, p: 2 })).toBe(true)
    expect(paramsAllowed({ N: SCRYPT_LIMITS.maxN, r: 8, p: 3 })).toBe(false)
    expect(paramsAllowed({ N: 2 ** 17, r: 16, p: 3 })).toBe(false)
  })

  it('refuses to write a file with a cost a reader would refuse', async () => {
    expect(await kindOf(() => encryptExport('x', PHRASE, { params: { N: 2 ** 20, r: 8, p: 1 } }))).toBe('too-costly')
  })
})

describe('sealed export: the passphrase', () => {
  it('refuses an empty or too short passphrase when sealing (this fails if the check is removed)', async () => {
    for (const phrase of ['', ' ', 'a', 'x'.repeat(PASSPHRASE_MIN - 1)]) {
      expect(await kindOf(() => encryptExport('content', phrase, { params: CHEAP })), JSON.stringify(phrase)).toBe('weak-passphrase')
    }
    expect(await kindOf(() => encryptExport('content', 'x'.repeat(PASSPHRASE_MIN), { params: CHEAP }))).toBe('no error')
    expect(await kindOf(() => encryptExport('content', 42 as unknown as string, { params: CHEAP }))).toBe('weak-passphrase')
    expect(await kindOf(() => encryptExport('content', 'x'.repeat(5000), { params: CHEAP }))).toBe('weak-passphrase')
    expect(exportErrorMessage(new ExportCryptoError('weak-passphrase', ''))).toContain(String(PASSPHRASE_MIN))
  })

  it('counts characters, not bytes, and keeps spaces', async () => {
    expect(await kindOf(() => encryptExport('c', '日本語日本語日本', { params: CHEAP }))).toBe('no error')
    expect(await kindOf(() => encryptExport('c', '        ', { params: CHEAP }))).toBe('no error')
  })

  it('never puts the passphrase in an error message or a log line', async () => {
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    const secret = 'my very private pass phrase'
    const sealed = JSON.parse(await seal('content', secret)) as ExportEnvelope
    const failures: string[] = []
    for (const run of [() => decryptExport(sealed, secret + '!'), () => decryptExport(withFlippedByte(sealed, 'data', 2), secret), () => encryptExport('x', 'short', { params: CHEAP })]) {
      try {
        await run()
      } catch (error) {
        failures.push(`${(error as Error).name} ${(error as Error).message} ${exportErrorMessage(error)}`)
      }
    }
    expect(failures).toHaveLength(3)
    expect([...failures, ...logged].join('\n')).not.toContain(secret)
    vi.restoreAllMocks()
  })

  it('has a sentence for every kind of failure, and a general one for anything else', () => {
    const kinds = ['weak-passphrase', 'not-an-export', 'unsupported', 'too-costly', 'wrong-passphrase', 'tampered', 'too-large'] as const
    for (const kind of kinds) expect(exportErrorMessage(new ExportCryptoError(kind, 'x'))).toMatch(/\S{3,}/)
    expect(new Set(kinds.map((kind) => exportErrorMessage(new ExportCryptoError(kind, 'x')))).size).toBe(kinds.length)
    expect(exportErrorMessage(new Error('boom'))).toMatch(/pas pu être lu/)
  })
})
