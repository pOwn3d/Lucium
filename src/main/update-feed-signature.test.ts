// The signature of the update feed: what a copy believes, and what the publication signs. Every key here is a throw-away pair made by the test;
// the maintainer's private key is in no test and in no file of the repository.
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UPDATE_FEED_PUBLIC_KEYS } from './update-feed-keys'
import {
  FEED_KEY_FILE,
  MAX_SIGNATURES,
  NEXT_FEED_KEY_FILE,
  PREVIOUS_FEED_KEY_FILE,
  feedKeysIn,
  newFeedKeyPair,
  publicKeyOfPrivate,
  publicKeyProblems,
  signFeedText,
  splitSignedFeed,
  unsignedFeedText,
  verifyFeed
} from './update-feed-signature'

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')
const FEED = `${JSON.stringify({ currentRelease: '0.3.1', releases: [{ version: '0.3.1', updateTo: { version: '0.3.1', url: 'https://lucium.app/updates/darwin-arm64/Lucium-0.3.1-arm64.zip', notes: 'Été « sûr ».' } }], withdrawn: ['0.3.0'] }, null, 2)}\n`
const pair = newFeedKeyPair()
const other = newFeedKeyPair()

describe('a signed feed', () => {
  const signed = signFeedText(FEED, [pair.privatePem])

  it('is still one JSON object, the feed with its signatures as the last key', () => {
    expect(JSON.parse(signed)).toEqual({ ...JSON.parse(FEED), signatures: [expect.stringMatching(/^[A-Za-z0-9+/]{86}==$/)] })
    expect(signed.startsWith(FEED.slice(0, -3))).toBe(true)
  })

  it('is believed by a copy that carries the key, which then reads exactly the bytes that were signed', () => {
    const verified = verifyFeed(bytes(signed), [pair.publicKey])
    expect(verified.ok && Buffer.from(verified.signed).toString('utf8')).toBe(FEED)
  })

  it('is refused by a copy that carries another key', () => {
    expect(verifyFeed(bytes(signed), [other.publicKey])).toEqual({ ok: false, problem: 'none of its 1 signature(s) is by a key of this build' })
  })

  it('is refused once a byte of it changed: the version, the address, the list of withdrawn versions', () => {
    for (const [from, to] of [['0.3.1', '9.9.9'], ['https://lucium.app/', 'https://lucium.example/'], ['"0.3.0"', '"0.3.1"'], ['Été', 'Ete']] as const) {
      const changed = signed.replace(from, to)
      expect(changed).not.toBe(signed)
      expect(verifyFeed(bytes(changed), [pair.publicKey]).ok, `${from} → ${to}`).toBe(false)
    }
  })

  it('is refused when something follows the signatures or comes between them and the end', () => {
    expect(verifyFeed(bytes(`${signed} `), [pair.publicKey])).toEqual({ ok: false, problem: 'it carries no signature' })
    expect(verifyFeed(bytes(signed.replace(/\n\}\n$/, ',\n  "withdrawn": ["0.3.1"]\n}\n')), [pair.publicKey])).toEqual({ ok: false, problem: 'it carries no signature' })
  })

  it('never lets a key written before the signatures change what is read: only the signed bytes are', () => {
    // A second "signatures" key, or any key, slipped into the body changes the signed bytes: the signature no longer holds.
    const slipped = signed.replace('{\n', '{\n  "signatures": [],\n')
    expect(verifyFeed(bytes(slipped), [pair.publicKey]).ok).toBe(false)
  })

  it('gives back the feed as it was before it was signed', () => {
    expect(unsignedFeedText(signed)).toBe(FEED)
    expect(unsignedFeedText(FEED)).toBe(FEED)
  })
})

describe('a feed without a signature a copy can use', () => {
  it('is refused when it carries none', () => {
    expect(verifyFeed(bytes(FEED), [pair.publicKey])).toEqual({ ok: false, problem: 'it carries no signature' })
    expect(verifyFeed(bytes(''), [pair.publicKey]).ok).toBe(false)
  })

  it('is refused when its signature is not one: too short, or of another shape', () => {
    const fake = FEED.replace(/\n\}\n$/, ',\n  "signatures": ["AAAA"]\n}\n')
    expect(verifyFeed(bytes(fake), [pair.publicKey])).toEqual({ ok: false, problem: 'it carries no signature' })
    const zeros = FEED.replace(/\n\}\n$/, `,\n  "signatures": ["${Buffer.alloc(64).toString('base64')}"]\n}\n`)
    expect(verifyFeed(bytes(zeros), [pair.publicKey])).toEqual({ ok: false, problem: 'none of its 1 signature(s) is by a key of this build' })
  })

  it('is refused by a build that carries no key, signed as it may be', () => {
    const signed = signFeedText(FEED, [pair.privatePem])
    expect(verifyFeed(bytes(signed), [])).toEqual({ ok: false, problem: 'this build carries no public key for the update feed, so it believes none' })
    expect(verifyFeed(bytes(signed), ['not a key']).ok).toBe(false)
  })
})

describe('the change of key', () => {
  const next = newFeedKeyPair()
  const both = signFeedText(FEED, [pair.privatePem, next.privatePem])

  it('a feed signed by the two keys is believed by the copies of before, of the change and of after', () => {
    expect(splitSignedFeed(bytes(both))?.signatures).toHaveLength(2)
    for (const keys of [[pair.publicKey], [pair.publicKey, next.publicKey], [next.publicKey]]) expect(verifyFeed(bytes(both), keys).ok).toBe(true)
  })

  it('a copy that carries the two keys believes a feed signed by either', () => {
    for (const pem of [pair.privatePem, next.privatePem]) expect(verifyFeed(bytes(signFeedText(FEED, [pem])), [pair.publicKey, next.publicKey]).ok).toBe(true)
  })

  it(`a feed carries ${MAX_SIGNATURES} signatures at most, and one at least`, () => {
    const many = Array.from({ length: MAX_SIGNATURES + 1 }, () => newFeedKeyPair().privatePem)
    expect(() => signFeedText(FEED, many)).toThrow(/1 to 4 signatures/)
    expect(() => signFeedText(FEED, [])).toThrow(/1 to 4 signatures/)
    expect(verifyFeed(bytes(signFeedText(FEED, many.slice(0, MAX_SIGNATURES))), [publicKeyOfPrivate(many[MAX_SIGNATURES - 1] as string)]).ok).toBe(true)
  })
})

describe('what is signed', () => {
  it('is an unsigned JSON object that ends as the publication writes it', () => {
    expect(() => signFeedText(JSON.stringify({ currentRelease: '0.3.1' }), [pair.privatePem])).toThrow(/closing brace/)
    expect(() => signFeedText(signFeedText(FEED, [pair.privatePem]), [pair.privatePem])).toThrow(/unsigned/)
    expect(() => signFeedText('[\n  1\n}\n', [pair.privatePem])).toThrow()
    expect(() => signFeedText(`${JSON.stringify({ signatures: [] }, null, 2)}\n`, [pair.privatePem])).toThrow(/without "signatures"/)
  })

  it('is signed by an Ed25519 key only, and a refusal never shows the text of the key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => signFeedText(FEED, [rsa])).toThrow(/a key of the type rsa, not ed25519/)
    const broken = pair.privatePem.replace(/[A-Za-z]/g, 'x')
    let message = ''
    try {
      signFeedText(FEED, [broken])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/^not a private key in PEM/)
    expect(message).not.toContain('xxxx')
  })
})

describe('the list of public keys of a build', () => {
  it('is one key, or two during a change', () => {
    expect(publicKeyProblems([pair.publicKey])).toEqual([])
    expect(publicKeyProblems([pair.publicKey, other.publicKey])).toEqual([])
  })

  it('is refused empty: such a build would believe no feed', () => {
    expect(publicKeyProblems([])).toEqual([expect.stringMatching(/holds no public key.*node scripts\/feed-key\.mjs/)])
  })

  it('is refused with three keys, a key twice, or something that is not a public key', () => {
    expect(publicKeyProblems([pair.publicKey, other.publicKey, newFeedKeyPair().publicKey])).toEqual([expect.stringMatching(/holds 3 public keys: 2 at most/)])
    expect(publicKeyProblems([pair.publicKey, pair.publicKey])).toEqual([expect.stringMatching(/key 2 .* is there twice/)])
    expect(publicKeyProblems(['', pair.publicKey.slice(2), 12])).toHaveLength(4)
    // A private key pasted by mistake is not taken for a public one.
    expect(publicKeyProblems([pair.privatePem])).toEqual([expect.stringMatching(/key 1 .* is not an Ed25519 public key/)])
  })

  it('of the repository is empty or valid: never half filled in', () => {
    expect(UPDATE_FEED_PUBLIC_KEYS.length === 0 ? [] : publicKeyProblems(UPDATE_FEED_PUBLIC_KEYS)).toEqual([])
  })
})

describe('the keys of a publication, in their folder', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  const folderWith = (files: Record<string, string>, mode = 0o600): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lucium-feed-keys-'))
    folders.push(dir)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode })
    return dir
  }

  it('sign a feed that the copies believe', () => {
    const keys = feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem }), [pair.publicKey])
    const signed = keys.sign(FEED)
    expect(signed).toMatchObject({ ok: true, keys: 1 })
    expect(signed.ok && verifyFeed(bytes(signed.text), [pair.publicKey]).ok).toBe(true)
    expect(signed.ok && keys.signedPart(signed.text)).toBe(FEED)
  })

  it('sign with the next and the previous key too when they are there', () => {
    const next = newFeedKeyPair()
    const previous = newFeedKeyPair()
    const keys = feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem, [NEXT_FEED_KEY_FILE]: next.privatePem, [PREVIOUS_FEED_KEY_FILE]: previous.privatePem }), [pair.publicKey, next.publicKey])
    const signed = keys.sign(FEED)
    expect(signed).toMatchObject({ ok: true, keys: 3 })
    // The copies that only know the key of before still take the feed.
    for (const known of [pair, next, previous]) expect(signed.ok && verifyFeed(bytes(signed.text), [known.publicKey]).ok).toBe(true)
  })

  it('take as ours a feed of the server signed by the previous key, and no other', () => {
    const previous = newFeedKeyPair()
    const keys = feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem, [PREVIOUS_FEED_KEY_FILE]: previous.privatePem }), [pair.publicKey])
    expect(keys.signedPart(signFeedText(FEED, [previous.privatePem]))).toBe(FEED)
    expect(keys.signedPart(signFeedText(FEED, [other.privatePem]))).toBeNull()
    expect(keys.signedPart(FEED)).toBeNull()
  })

  it('refuse to sign without the private key, and say how it is made', () => {
    expect(feedKeysIn(folderWith({}), [pair.publicKey]).sign(FEED)).toEqual({ ok: false, problem: expect.stringMatching(/feed-key\.pem does not exist.*node scripts\/feed-key\.mjs/) })
  })

  it('refuse to sign while the builds carry no public key', () => {
    expect(feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem }), []).sign(FEED)).toEqual({ ok: false, problem: expect.stringMatching(/holds no public key/) })
  })

  it('refuse a private key the builds do not carry the public half of: every copy would refuse the feed', () => {
    const answer = feedKeysIn(folderWith({ [FEED_KEY_FILE]: other.privatePem }), [pair.publicKey]).sign(FEED)
    expect(answer).toEqual({ ok: false, problem: expect.stringMatching(/is not in src\/main\/update-feed-keys\.ts/) })
    const next = feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem, [NEXT_FEED_KEY_FILE]: other.privatePem }), [pair.publicKey]).sign(FEED)
    expect(next).toEqual({ ok: false, problem: expect.stringMatching(/feed-key-next\.pem .* is not in src\/main\/update-feed-keys\.ts/) })
  })

  it('refuse a private key other accounts can read, or one that is a link', () => {
    const open = folderWith({ [FEED_KEY_FILE]: pair.privatePem })
    chmodSync(join(open, FEED_KEY_FILE), 0o644)
    expect(feedKeysIn(open, [pair.publicKey]).sign(FEED)).toEqual({ ok: false, problem: expect.stringMatching(/can be read by other accounts \(mode 644\)/) })
    const linked = folderWith({ 'elsewhere.pem': pair.privatePem })
    symlinkSync(join(linked, 'elsewhere.pem'), join(linked, FEED_KEY_FILE))
    expect(feedKeysIn(linked, [pair.publicKey]).sign(FEED)).toEqual({ ok: false, problem: expect.stringMatching(/is not a plain file/) })
  })

  it('say that a file is not a key without showing what it holds', () => {
    const answer = feedKeysIn(folderWith({ [FEED_KEY_FILE]: 'SECRET-LOOKING-TEXT' }), [pair.publicKey]).sign(FEED)
    expect(answer).toEqual({ ok: false, problem: expect.stringMatching(/cannot be used: not a private key in PEM/) })
    expect(JSON.stringify(answer)).not.toContain('SECRET-LOOKING-TEXT')
  })

  it('never return or print a private key', () => {
    const keys = feedKeysIn(folderWith({ [FEED_KEY_FILE]: pair.privatePem }), [pair.publicKey])
    const secret = pair.privatePem.split('\n')[1] as string
    expect(JSON.stringify([keys.sign(FEED), keys.sign('not a feed'), keys.signedPart(FEED)])).not.toContain(secret)
  })
})
